import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, realpath, rm, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import test, { type TestContext } from 'node:test';
import { scanWorkspaceRepositories, localPathKey } from '../../src/git/repositoryScanner';
import { OperationLog } from '../../src/logging/operationLog';

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

test('directory budgets pause discovery and resume without rescanning completed directories or losing repositories', async t => {
  const root = await directory(t);
  await repository(root); await repository(path.join(root, 'deep', 'nested'));
  let state = await scanWorkspaceRepositories([root], { maxDirectories: 1 });
  assert.equal(state.status, 'partial'); assert.equal(state.canResume, true); assert.equal(state.checkedDirectories, 1);
  let batches = 1;
  while (state.canResume && batches++ < 20) {
    const checked: number = state.checkedDirectories;
    state = await scanWorkspaceRepositories([root], { maxDirectories: 1, resume: state });
    assert.equal(state.checkedDirectories, checked + 1);
  }
  assert.equal(state.status, 'completed'); assert.equal(state.canResume, false);
  assert.equal(state.repositories.length, 2); assert.equal(state.checkedDirectories, 3);
  assert.equal(new Set(state.repositories.map(repo => repo.path)).size, 2);
});

test('scanner emits one terminal per local Git execution and retains failing exit codes', async t => {
  const root = await directory(t); await repository(path.join(root, 'repo'));
  const lines: string[] = [], write = (line: string) => { lines.push(line); };
  const log = new OperationLog({ info: write, warn: write, error: write }); t.after(() => log.dispose());
  const result = await log.run('projects', 'scanWorkspace', {}, () => scanWorkspaceRepositories([root], { log }));
  assert.equal(result.repositories.length, 1);
  const entries = lines.filter(line => line.startsWith('[git] ')).map(line => {
    const match = /^\[git\] (\S+) (\S+) (\{.*\})$/.exec(line)!;
    return { ...JSON.parse(match[3]), action: match[1], result: match[2] };
  });
  assert.ok(entries.length >= 4); assert.ok(entries.every(entry => entry.commandId && entry.network === false));
  assert.equal(new Set(entries.map(entry => entry.operationId)).size, 1);
  for (const commandId of new Set(entries.map(entry => entry.commandId))) {
    const pair = entries.filter(entry => entry.commandId === commandId);
    assert.equal(pair.length, 2); assert.equal(pair[0].result, 'started'); assert.notEqual(pair[1].result, 'started');
    assert.equal(typeof pair[1].exitCode, 'number');
  }
  assert.ok(entries.some(entry => entry.result === 'error' && entry.exitCode === 128));
});
