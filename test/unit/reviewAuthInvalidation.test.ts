import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, realpath } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { Memento } from 'vscode';
import { invalidateReviewAuth, reviewerAuthScope } from '../../src/workspace/reviewSessions';
import { GitLabSession } from '../../src/connection/session';

test('review auth scopes separate host restarts, accounts and token-transition epochs', () => {
  const scope = (nonce: string, account = 'one', epoch = 0) => reviewerAuthScope(nonce, 'https://gitlab.test', account, 7, epoch);
  assert.equal(scope('host-a'), scope('host-a'));
  assert.notEqual(scope('host-a'), scope('host-b'));
  assert.notEqual(scope('host-a'), scope('host-a', 'two'));
  assert.notEqual(scope('host-a'), scope('host-a', 'one', 1));
});

test('auth changes invalidate one shared cache without modifying frozen jobs or creating absent caches', async t => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'review-auth-'));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const base = await realpath(temporary), merge = path.join(base, '.review-runtime');
  const release = path.join(base, '.release-review-runtime'), shared = path.join(base, '.review-shared-cache');
  const previous = process.env.REVIEW_SHARED_CACHE_DIR;
  delete process.env.REVIEW_SHARED_CACHE_DIR;
  t.after(() => { if (previous === undefined) delete process.env.REVIEW_SHARED_CACHE_DIR; else process.env.REVIEW_SHARED_CACHE_DIR = previous; });
  for (const [root, marker, schema] of [[merge, '.merge-reviewer-runtime.json', 'MergeReviewRuntime/v1'],
    [release, '.release-reviewer-runtime.json', 'ReleaseReviewRuntime/v1']]) {
    await mkdir(root);
    await writeFile(path.join(root, marker), JSON.stringify({ schema, directory: root }));
  }
  const job = path.join(merge, 'frozen-job.json');
  await writeFile(job, '{"head_sha":"fixed"}');
  assert.equal(await invalidateReviewAuth([merge, release]), 0);
  await assert.rejects(readFile(path.join(shared, '.review-shared-cache.json')));
  await mkdir(shared);
  await writeFile(path.join(shared, '.review-shared-cache.json'), JSON.stringify({ schema: 'ReviewerSharedCache/v1', directory: shared }));
  assert.equal(await invalidateReviewAuth([merge, release]), 1);
  const filename = path.join(shared, 'invalidations/auth.json'), first = await readFile(filename, 'utf8');
  assert.equal(JSON.parse(first).schema, 'ReviewerAuthInvalidation/v1');
  assert.equal(await invalidateReviewAuth([release]), 1);
  assert.notEqual(await readFile(filename, 'utf8'), first);
  assert.equal(await readFile(job, 'utf8'), '{"head_sha":"fixed"}');
});

class MemoryStore implements Memento {
  private readonly values = new Map<string, unknown>();
  get<T>(key: string, defaultValue?: T): T | undefined { return (this.values.get(key) as T | undefined) ?? defaultValue; }
  async update(key: string, value: unknown): Promise<void> { if (value === undefined) this.values.delete(key); else this.values.set(key, value); }
  keys(): readonly string[] { return [...this.values.keys()]; }
  setKeysForSync(): void {}
}

test('known credential transition invokes local invalidation after success and after storage failure', async () => {
  const values = new Map<string, string>();
  const secrets = { get: async (key: string) => values.get(key),
    store: async (key: string, value: string) => { if (value === 'new-token-fails-storage') throw new Error('storage failed'); values.set(key, value); },
    delete: async (key: string) => { values.delete(key); }, onDidChange: () => ({ dispose() {} }) };
  const session = new GitLabSession(secrets, new MemoryStore(), true);
  session.setFetchForTesting(async input => new Response(JSON.stringify(String(input).endsWith('/user')
    ? { id: 7, username: 'reviewer', name: 'Reviewer' } : {}), { status: String(input).endsWith('/user') ? 200 : 404 }));
  const calls: string[] = [];
  session.setBeforeTransition(async () => { calls.push('before'); });
  session.setAfterTransition(async () => { calls.push('after'); });
  await session.connect('https://gitlab.test', 'initial-token');
  const epoch = session.connectionEpoch;
  assert.deepEqual(calls, ['before', 'after']);
  await assert.rejects(session.connect('https://gitlab.test', 'new-token-fails-storage'), /storage failed/);
  assert.equal(session.connectionEpoch, epoch);
  assert.deepEqual(calls, ['before', 'after', 'before', 'after']);
});
