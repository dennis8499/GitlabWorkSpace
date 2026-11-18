import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { GitLabProject } from '../../src/api/types';
import { ensureManagedRepositoryCache } from '../../src/codex/managedRepository';

const git = (root: string, ...args: string[]) => execFileSync('git',
  ['-C', root, '-c', 'core.hooksPath=', '-c', 'user.name=Cache Test', '-c', 'user.email=cache@test.invalid', '-c', 'commit.gpgsign=false', ...args],
  { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }).trim();

async function fixture(t: test.TestContext, longPaths = false) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'codex-review-cache-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const local = path.join(directory, 'source');
  const storageName = longPaths ? 'storage-' + 's'.repeat(Math.max(0, 120 - path.join(directory, 'storage-').length)) : 'storage';
  const storage = path.join(directory, storageName);
  await mkdir(local); await mkdir(storage);
  git(local, 'init', '-q', '--initial-branch=main');
  await writeFile(path.join(local, 'source.txt'), 'initial\n');
  git(local, 'add', '.'); git(local, 'commit', '-qm', 'initial');
  git(local, 'remote', 'add', 'origin', 'https://gitlab.test/team/repository.git');
  const sha = git(local, 'rev-parse', 'HEAD');
  const project = { id: 1, path_with_namespace: 'team/repository', http_url_to_repo: 'https://gitlab.test/team/repository.git' } as GitLabProject;
  const options = { storage, accountKey: 'account', baseUrl: 'https://gitlab.test', project, sourceSha: sha, localRepository: local };
  return { local, options, sha };
}

test('review cache retains an independent fixed source and leaves a dirty source Repo untouched', async t => {
  const f = await fixture(t), before = git(f.local, 'show-ref');
  await writeFile(path.join(f.local, 'source.txt'), 'uncommitted\n');
  const cache = await ensureManagedRepositoryCache(f.options);
  assert.equal((await ensureManagedRepositoryCache(f.options)).root, cache.root);
  assert.equal(git(f.local, 'show-ref'), before);
  assert.equal(await readFile(path.join(f.local, 'source.txt'), 'utf8'), 'uncommitted\n');
  assert.equal(git(cache.root, 'show', `${f.sha}:source.txt`), 'initial');
  assert.equal(git(cache.root, 'show-ref', '--verify', '--hash', `refs/gitlab-workspace/cache/${f.sha}`), f.sha);
  await assert.rejects(access(path.join(cache.root, 'source.txt')), { code: 'ENOENT' });
  await assert.rejects(access(path.join(cache.root, '.git', 'objects', 'info', 'alternates')), { code: 'ENOENT' });
  for (const root of [f.local, cache.root]) {
    const object = path.join(root, '.git', 'objects', f.sha.slice(0, 2), f.sha.slice(2));
    assert.equal((await stat(object)).nlink, 1, 'the cache must not borrow the source object');
  }
});

test('review caches separate accounts and reject a changed remote before reuse', async t => {
  const f = await fixture(t), first = await ensureManagedRepositoryCache(f.options);
  const other = await ensureManagedRepositoryCache({ ...f.options, accountKey: 'other-account' });
  assert.notEqual(other.root, first.root);
  git(first.root, 'remote', 'set-url', 'origin', 'https://gitlab.test/other/project.git');
  await assert.rejects(ensureManagedRepositoryCache(f.options), /remote/);
  assert.equal(git(other.root, 'remote', 'get-url', 'origin'), f.options.project.http_url_to_repo);
});

test('Windows review caches keep fixed refs with paths longer than MAX_PATH', { skip: process.platform !== 'win32' }, async t => {
  const f = await fixture(t, true), before = await readFile(path.join(f.local, '.git', 'config'));
  const cache = await ensureManagedRepositoryCache(f.options), retained = `refs/gitlab-workspace/cache/${f.sha}`;
  assert.ok(path.join(cache.root, '.git', retained + '.lock').length > 260);
  assert.equal(git(cache.root, 'show-ref', '--verify', '--hash', retained), f.sha);
  assert.equal(git(cache.root, 'config', '--local', '--get', 'core.longpaths'), 'true');
  assert.deepEqual(await readFile(path.join(f.local, '.git', 'config')), before);
});
