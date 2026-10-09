import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, realpath, rm, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import test, { type TestContext } from 'node:test';
import { scanWorkspaceRepositories, localPathKey } from '../../src/git/repositoryScanner';

const exec = promisify(execFile);
async function directory(t: TestContext): Promise<string> {
  const prefix = path.resolve(await realpath(os.tmpdir()), 'workspace-scan-');
  const root = await mkdtemp(prefix);
  assert.ok(path.resolve(root).startsWith(prefix));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}
async function git(root: string, ...args: string[]): Promise<void> {
  await exec('git', ['-C', root, ...args], { windowsHide: true });
}
async function repository(root: string, commit = false): Promise<void> {
  await mkdir(root, { recursive: true }); await git(root, 'init');
  if (commit) await git(root, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '--allow-empty', '-m', 'fixture');
}

test('discovers deep repositories and workspace ancestors, deduplicates overlapping roots and honors configurable exclusions', async t => {
  const root = await directory(t), repo = path.join(root, 'source'), nested = path.join(repo, 'deep', 'nested');
  await repository(repo); await repository(nested); await mkdir(path.join(repo, 'subfolder'));
  await repository(path.join(root, 'node_modules', 'ignored'));
  const first = await scanWorkspaceRepositories([root, repo, path.join(repo, 'subfolder')]);
  assert.equal(first.status, 'completed');
  assert.equal(first.repositories.length, 2);
  assert.equal(new Set(first.repositories.map(item => localPathKey(item.path))).size, 2);
  const all = await scanWorkspaceRepositories([root], { excludes: [] });
  assert.equal(all.repositories.length, 3);
  const ancestor = await scanWorkspaceRepositories([path.join(repo, 'subfolder')]);
  assert.equal(ancestor.repositories[0].path, await realpath(repo));
});

test('recognizes linked worktrees and submodules through .git files and strips credentials from remote URLs', async t => {
  const root = await directory(t), main = path.join(root, 'main'), source = path.join(root, 'source'), linked = path.join(root, 'linked');
  await repository(main, true); await repository(source, true);
  await git(main, 'worktree', 'add', '-b', 'linked-fixture', linked);
  await git(main, '-c', 'protocol.file.allow=always', 'submodule', 'add', source, 'modules/sub');
  await git(main, 'remote', 'add', 'origin', 'https://user:password@gitlab.example.test/team/repo.git?access_token=secret');
  const result = await scanWorkspaceRepositories([root]);
  assert.equal(result.repositories.length, 4);
  const found = result.repositories.find(item => item.path === awaitPath(main));
  assert.ok(found);
  assert.ok(!JSON.stringify(result.repositories).includes('password'));
  assert.ok(!JSON.stringify(result.repositories).includes('access_token'));
  assert.equal(result.repositories.filter(item => item.name === 'linked').length, 1);
});

function awaitPath(value: string): string { return path.resolve(value); }

test('does not recurse through junctions or symbolic links', async t => {
  const root = await directory(t), outside = await directory(t);
  await repository(path.join(outside, 'outside-repo'));
  await symlink(outside, path.join(root, 'link'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal((await scanWorkspaceRepositories([root])).repositories.length, 0);
});

test('reports unavailable roots and missing Git, supports cancellation and retains partial results', async t => {
  const root = await directory(t);
  await repository(root); await repository(path.join(root, 'nested'));
  const controller = new AbortController();
  const cancelled = await scanWorkspaceRepositories([root], { signal: controller.signal, onProgress: () => controller.abort() });
  assert.equal(cancelled.status, 'cancelled');
  assert.ok(cancelled.repositories.length > 0);
  const unavailable = await scanWorkspaceRepositories([path.join(root, 'missing'), root]);
  assert.ok(unavailable.errors.some(error => error.path.endsWith('missing')));
  assert.equal(unavailable.repositories.length, 2);
  assert.equal((await scanWorkspaceRepositories([root], { gitPath: path.join(root, 'missing-git') })).status, 'error');
  assert.equal((await scanWorkspaceRepositories([])).status, 'error');
});
