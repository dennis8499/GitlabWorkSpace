import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm, readFile, lstat, readdir } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { CodexSourceSnapshotService } from '../../src/codex/sourceSnapshot';
import { ensureLocalCommit, exportCommitSnapshot, startWikiWorkflow } from '../../src/codex/projectWorkflows';
import type { CodexTaskSpec } from '../../src/codex/protocol';
import { resolvePythonRuntime } from '../../src/workspace/pythonRuntime';

const git = (root: string, ...args: string[]) => execFileSync('git', ['-C', root, '-c', 'core.hooksPath=', '-c', 'user.name=Snapshot Test', '-c', 'user.email=snapshot@test.invalid', ...args], { encoding: 'utf8', windowsHide: true });
async function fixture(t: test.TestContext) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'codex-source-snapshot-')); t.after(() => rm(root, { recursive: true, force: true }));
  const repo = path.join(root, 'repo'); await mkdir(repo); git(repo, 'init', '-q', '--initial-branch=main');
  await writeFile(path.join(repo, 'source.txt'), 'committed source'); git(repo, 'add', '.'); git(repo, 'commit', '-qm', 'initial');
  return { root, repo, sha: git(repo, 'rev-parse', 'HEAD').trim() };
}
test('snapshot identity is stable across dirty edits, persisted, and immutable after HEAD advances', async t => {
  const f = await fixture(t), directory = path.join(f.root, 'snapshots');
  const service = new CodexSourceSnapshotService(directory), input = { repositories: [{ root: f.repo, projectId: 1 }], metadataVersion: 'metadata-v1' };
  const first = await service.capture(input); await writeFile(path.join(f.repo, 'source.txt'), 'dirty');
  assert.equal((await service.capture(input)).id, first.id);
  git(f.repo, 'add', '.'); git(f.repo, 'commit', '-qm', 'next');
  assert.notEqual((await service.capture(input)).id, first.id);
  const reloaded = await new CodexSourceSnapshotService(directory).read(first.id);
  assert.equal(reloaded?.repositories[0].sha, f.sha);
});
test('a present commit does not contact an invalid remote and missing commits require explicit synchronization', async t => {
  const f = await fixture(t);
  await ensureLocalCommit(f.repo, f.sha, { remote: 'remote-that-does-not-exist', ref: 'refs/heads/main' });
  await assert.rejects(ensureLocalCommit(f.repo, 'f'.repeat(40)), /本機缺少/);
});
test('Group archive materializes fixed HEAD and excludes all dirty and untracked files', async t => {
  const f = await fixture(t), destination = path.join(f.root, 'snapshot');
  await writeFile(path.join(f.repo, 'source.txt'), 'dirty source'); await writeFile(path.join(f.repo, 'private.txt'), 'untracked');
  await exportCommitSnapshot(f.repo, f.sha, destination, await resolvePythonRuntime('python'));
  assert.equal(await readFile(path.join(destination, 'source.txt'), 'utf8'), 'committed source');
  await assert.rejects(readFile(path.join(destination, 'private.txt')), { code: 'ENOENT' });
});

test('fixed snapshots reject gitlinks without fetching or pretending submodule sources are complete', async t => {
  const f = await fixture(t);
  git(f.repo, 'update-index', '--add', '--cacheinfo', `160000,${f.sha},vendor/module`); git(f.repo, 'commit', '-qm', 'submodule pointer');
  const sha = git(f.repo, 'rev-parse', 'HEAD').trim();
  await assert.rejects(exportCommitSnapshot(f.repo, sha, path.join(f.root, 'snapshot'), await resolvePythonRuntime('python')), /submodule/);
});

test('an LFS pointer prevents a Wiki success receipt and its temporary archive is removed', async t => {
  const f = await fixture(t);
  await writeFile(path.join(f.repo, 'large.bin'), `version https://git-lfs.github.com/spec/v1\noid sha256:${'a'.repeat(64)}\nsize 12345\n`);
  git(f.repo, 'add', '.'); git(f.repo, 'commit', '-qm', 'LFS pointer'); const sha = git(f.repo, 'rev-parse', 'HEAD').trim();
  const runtimeRoot = path.join(f.root, 'runtime');
  const spec: CodexTaskSpec = { root: f.root, title: 'Wiki', prompt: '', workspaceKey: 'fixture', environmentKey: 'fixture', writableRoots: [],
    source: { kind: 'project-wiki', projectId: 1 }, executionRoot: path.join(runtimeRoot, 'source'),
    origin: { kind: 'project-wiki', accountKey: 'fixture', baseUrl: 'https://gitlab.test', projectId: 1, projectPath: 'team/repo', webUrl: 'https://gitlab.test/team/repo',
      repositoryRoot: f.repo, sourceBranch: 'main', sourceSha: sha }, workflow: { id: 'a'.repeat(32), remote: 'origin', runtimeRoot } };
  await assert.rejects(startWikiWorkflow(spec, await resolvePythonRuntime('python')), /Git LFS pointer/);
  await assert.rejects(lstat(path.join(runtimeRoot, 'source.json')), { code: 'ENOENT' });
  assert.ok(!(await readdir(runtimeRoot)).some(name => name.endsWith('.zip')));
});
