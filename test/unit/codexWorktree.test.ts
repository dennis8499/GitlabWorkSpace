import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, rm, realpath, symlink, lstat } from 'node:fs/promises';
import { startIssueWorkflow, startWikiWorkflow, verifyManagedWorktree, removeManagedWorktree, implementationDigest, collectIssueResult } from '../../src/codex/projectWorkflows';
import { resolvePythonRuntime } from '../../src/workspace/pythonRuntime';
import { CodexTaskScheduler, codexResourcePaths, codexResourcesOverlap } from '../../src/codex/scheduler';
import { CodexWorkspaceLease } from '../../src/codex/workspaceLease';
import { codexRootKey } from '../../src/codex/taskStore';
import { networkRuntimeRoot } from '../../src/api/localNetworkLease';
import type { CodexTaskSpec } from '../../src/codex/protocol';

const git = (root: string, ...args: string[]) => execFileSync('git', ['-C', root, '-c', 'core.hooksPath=', '-c', 'user.name=Worktree Test', '-c', 'user.email=worktree@test.invalid', ...args], { encoding: 'utf8', windowsHide: true });
async function fixture(t: test.TestContext) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'codex-managed-worktree-')); assert.ok(directory.startsWith(os.tmpdir() + path.sep));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const repo = path.join(directory, 'repository'), remote = path.join(directory, 'remote.git'), runtime = path.join(directory, 'runtime'); await mkdir(repo);
  git(repo, 'init', '-q', '--initial-branch=main'); await writeFile(path.join(repo, 'main.py'), 'print(1)\n'); git(repo, 'add', '.'); git(repo, 'commit', '-qm', 'baseline');
  git(directory, 'clone', '--bare', repo, remote); git(repo, 'remote', 'add', 'origin', remote);
  const sourceSha = git(repo, 'rev-parse', 'HEAD').trim(), branch = 'issue/1-fix', target = path.join(runtime, 'worktree');
  const spec: CodexTaskSpec = { source: { kind: 'issue', projectId: 1, issueIid: 1, isolated: true }, title: 'Test', root: directory,
    workspaceKey: directory, prompt: 'Test', environmentKey: 'test', skill: { name: 'test', path: path.join(directory, 'SKILL.md') }, executionRoot: target, writableRoots: [target],
    origin: { kind: 'issue', accountKey: 'test', baseUrl: 'https://gitlab.test', projectId: 1, projectPath: 'team/project', webUrl: 'https://gitlab.test/team/project/-/issues/1', repositoryRoot: repo,
      iid: 1, sourceBranch: 'main', sourceSha, branch },
    workflow: { id: 'a'.repeat(32), runtimeRoot: runtime, remote: 'origin', worktree: { path: target, branch, sourceSha, repository: repo } } };
  return { directory, repo, remote, runtime, target, spec };
}
test('managed Issue worktree preserves the original dirty tree, resumes in place and only removes saved work', async t => {
  const f = await fixture(t); await writeFile(path.join(f.repo, 'keep.txt'), 'User work');
  await startIssueWorkflow(f.spec); assert.equal(git(f.repo, 'branch', '--show-current').trim(), 'main');
  assert.equal(await readFile(path.join(f.repo, 'keep.txt'), 'utf8'), 'User work');
  assert.equal(await verifyManagedWorktree(f.spec), await realpath(f.target));
  await writeFile(path.join(f.target, 'main.py'), 'print(2)\n'); await startIssueWorkflow(f.spec);
  assert.equal(await readFile(path.join(f.target, 'main.py'), 'utf8'), 'print(2)\n');
  await assert.rejects(removeManagedWorktree(f.spec), /未保存/);
  const result = await collectIssueResult(f.spec, [{ id: 'test', kind: 'command', command: 'python -m unittest', text: '', exitCode: 0 }]);
  assert.equal(result.state, 'ready'); assert.ok(result.evidence?.digest);
  await writeFile(path.join(f.target, 'main.py'), 'print(3)\n');
  assert.notEqual(await implementationDigest(f.spec, result.files!), result.evidence?.digest);
  await writeFile(path.join(f.target, '.gitignore'), 'private.env\n');
  git(f.target, 'add', '.'); git(f.target, 'commit', '-qm', 'saved fix');
  const ignored = path.join(f.target, 'private.env'); await writeFile(ignored, 'Disposable ignored user data');
  assert.equal(git(f.target, 'status', '--porcelain').trim(), '');
  await assert.rejects(removeManagedWorktree(f.spec), /忽略的檔案/);
  assert.equal(await readFile(ignored, 'utf8'), 'Disposable ignored user data'); await rm(ignored);
  await removeManagedWorktree(f.spec); await assert.rejects(lstat(f.target), { code: 'ENOENT' });
  assert.ok(git(f.repo, 'rev-parse', 'refs/heads/issue/1-fix').trim()); assert.equal(await readFile(path.join(f.repo, 'keep.txt'), 'utf8'), 'User work');
});
test('worktrees share their Git common-directory resource and redirected output directories are rejected', async t => {
  const f = await fixture(t); await startIssueWorkflow(f.spec);
  const free = (root: string): CodexTaskSpec => ({ source: { kind: 'free', repository: root, prompt: 'test' }, root, title: 'Test', prompt: 'test', workspaceKey: root, environmentKey: 'test', writableRoots: [root] });
  const original = await codexResourcePaths(free(f.repo)), isolated = await codexResourcePaths(free(f.target));
  assert.equal(codexResourcesOverlap(original, isolated), true);
  await removeManagedWorktree(f.spec); await symlink(f.repo, f.target, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(verifyManagedWorktree(f.spec), /重新導向/);
});
test('Wiki source archives are removed after extraction and after a failed extractor, while snapshots remain', async t => {
  const f = await fixture(t), python = await resolvePythonRuntime('python');
  f.spec.source = { kind: 'project-wiki', projectId: 1 }; f.spec.origin!.kind = 'project-wiki';
  f.spec.workflow!.worktree = undefined; f.spec.workflow!.sourceRoot = path.join(f.runtime, 'source');
  f.spec.executionRoot = path.join(f.runtime, 'source', 'wiki');
  await startWikiWorkflow(f.spec, python);
  await assert.rejects(lstat(path.join(f.runtime, 'source.zip')), { code: 'ENOENT' });
  assert.equal((await readFile(path.join(f.runtime, 'source', 'main.py'), 'utf8')).replace(/\r\n/g, '\n'), git(f.repo, 'show', f.spec.origin!.sourceSha + ':main.py').replace(/\r\n/g, '\n'));
  await rm(path.join(f.runtime, 'source.json'));
  await assert.rejects(startWikiWorkflow(f.spec, { ...python, executable: process.execPath, args: ['-e', 'process.exit(3)', '--'] }));
  await assert.rejects(lstat(path.join(f.runtime, 'source.zip')), { code: 'ENOENT' });
  assert.ok(await lstat(path.join(f.runtime, 'source')));
});

test('directory aliases use the physical legacy workspace lock as well as the shared scheduler resource', async t => {
  const f = await fixture(t), alias = path.join(f.directory, 'alias');
  await symlink(f.repo, alias, process.platform === 'win32' ? 'junction' : 'dir');
  const scheduler = new CodexTaskScheduler('alias-test', path.join(f.directory, 'machine'));
  const spec: CodexTaskSpec = { source: { kind: 'free', repository: alias, prompt: 'test' }, root: alias, title: 'Test',
    prompt: 'test', workspaceKey: alias, environmentKey: 'test', writableRoots: [alias] };
  const admission = await scheduler.tryAcquire('alias-owner', spec, 2); assert.ok(admission.reservation);
  const reservation = admission.reservation;
  try {
    const expected = path.join(networkRuntimeRoot(), 'codex-workspaces', codexRootKey(await realpath(f.repo)) + '.lock');
    assert.equal(reservation.directory, expected);
    await assert.rejects(CodexWorkspaceLease.acquire(expected, { timeoutMs: 20 }));
    assert.equal((await scheduler.tryAcquire('physical-contender', { ...spec, root: await realpath(f.repo), writableRoots: [f.repo] }, 2)).reason, 'resource');
  } finally {
    await reservation.primary.release(); for (const extra of reservation.extras) await extra.release();
    await reservation.release(false);
  }
});
