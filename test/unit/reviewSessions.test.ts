import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, realpath, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { readReviewSessions, readReviewJob, invalidateReviewSync, withReviewSyncInvalidation } from '../../src/workspace/reviewSessions';
import { workspaceActionKinds, describeAction } from '../../src/workspace/actionPolicy';

async function fixture(t: test.TestContext) {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'review-jobs-'));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const base = await realpath(temp), root = path.join(base, '.review-runtime'), repo = path.join(base, 'service');
  await mkdir(path.join(root, 'jobs'), { recursive: true });
  await mkdir(repo);
  await writeFile(path.join(root, '.merge-reviewer-runtime.json'), JSON.stringify({ schema: 'MergeReviewRuntime/v1', directory: root }));
  const id = 'a'.repeat(32);
  const job = { schema: 'MergeReviewSession/v1', request_id: id, runtime_root: root, state: 'reviewing', phase: 'review',
    updated_at: '2026-10-22T00:00:00Z', inputs: { workspace: base, project: repo, base: 'origin/main', head: 'origin/topic' },
    network_activity: { fetch_attempt_count: 0 }, pack_cache_hits: 2 };
  const save = async (value: unknown, identifier = id) => writeFile(path.join(root, 'jobs', identifier + '.json'), JSON.stringify(value));
  await save(job);
  return { base, root, repo, id, job, save };
}

test('local review status validates workspace ownership and filters foreign or malformed jobs', async t => {
  const f = await fixture(t), before = await readdir(f.root);
  await f.save({ ...f.job, request_id: 'b'.repeat(32), inputs: { ...f.job.inputs, workspace: path.dirname(f.base) } }, 'b'.repeat(32));
  await f.save({ ...f.job, request_id: 'c'.repeat(32), report_path: path.join(f.base, 'foreign.md') }, 'c'.repeat(32));
  await writeFile(path.join(f.root, 'jobs', 'd'.repeat(32) + '.json'), 'broken');
  const rows = await readReviewSessions(f.root, f.base, [f.repo]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].requestId, f.id);
  assert.equal(rows[0].fetchCount, 0);
  assert.equal(rows[0].packCacheHits, 2);
  assert.deepEqual(await readdir(f.root), before); // A read creates no runtime or lock.
  await assert.rejects(readReviewJob(f.root, '../elsewhere', f.base, [f.repo]));
  await assert.rejects(readReviewJob(f.root, f.id, f.base, [path.dirname(f.repo)]));
  assert.deepEqual(await readReviewSessions(path.join(f.base, 'absent'), f.base, [f.repo]), []);
});

test('known Git writes invalidate only the requested common directory; status stays unchanged', async t => {
  const f = await fixture(t), common = path.join(f.repo, '.git');
  await invalidateReviewSync(f.root, common);
  const key = createHash('sha256').update(JSON.stringify(path.resolve(common))).digest('hex');
  const marker = JSON.parse(await readFile(path.join(f.root, 'invalidations', key + '.json'), 'utf8'));
  assert.equal(marker.schema, 'MergeReviewInvalidation/v1');
  assert.equal((await readReviewJob(f.root, f.id, f.base, [f.repo])).state, 'reviewing');
  await invalidateReviewSync(path.join(f.base, 'absent'), common);
  await assert.rejects(readdir(path.join(f.base, 'absent')));
});

test('a receipt made while a Git write is waiting is invalidated again after completion or failure', async t => {
  const f = await fixture(t), common = path.join(f.repo, '.git');
  const key = createHash('sha256').update(JSON.stringify(path.resolve(common))).digest('hex');
  const marker = path.join(f.root, 'invalidations', key + '.json');
  let during = '';
  const value = await withReviewSyncInvalidation([f.root], common, async () => {
    during = await readFile(marker, 'utf8');
    return 'Git completed';
  });
  assert.equal(value, 'Git completed');
  assert.notEqual(await readFile(marker, 'utf8'), during);
  await assert.rejects(withReviewSyncInvalidation([f.root], common, async () => {
    during = await readFile(marker, 'utf8');
    throw new Error('uncertain transport result');
  }), /uncertain transport result/);
  assert.notEqual(await readFile(marker, 'utf8'), during);
});

test('status refuses linked runtime and linked jobs instead of traversing them', async t => {
  const f = await fixture(t), alias = path.join(f.base, 'alias');
  await symlink(f.root, alias, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(readReviewSessions(alias, f.base, [f.repo]), /Junction/);
});

test('review controls have local per-request resources and never require remote refresh', () => {
  assert.equal(workspaceActionKinds.loadReviewSessions, 'read');
  assert.equal(workspaceActionKinds.openReviewReport, 'local');
  const request = { type: 'cancelReviewSession', revision: 'r', requestId: 'a'.repeat(32) };
  const first = describeAction(request, { rootKey: 'local' });
  const otherRequest = { ...request, requestId: 'b'.repeat(32) };
  const second = describeAction(otherRequest, { rootKey: 'local' });
  assert.notEqual(first.lockKey, second.lockKey);
  assert.match(first.resourceKey, /review/);
});
