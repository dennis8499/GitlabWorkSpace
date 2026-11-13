import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { collectGroupAnalysis, groupSpecsDirectory, prepareGroupAnalysis, startGroupAnalysis } from '../../src/codex/groupAnalysis';
import { resolvePythonRuntime } from '../../src/workspace/pythonRuntime';

const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'core.hooksPath=', '-c', 'user.name=Group Test', '-c', 'user.email=group@test.invalid', ...args], { cwd, windowsHide: true, encoding: 'utf8' }).trim();
async function fixture(t: test.TestContext) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'codex-group-'))), storage = path.join(root, 'storage');
  t.after(() => rm(root, { recursive: true, force: true }));
  const group = path.join(root, 'group'), repo = path.join(group, 'service'), skill = path.join(group, '.agents', 'skills', 'bmad-spec', 'SKILL.md');
  await mkdir(repo, { recursive: true }); await mkdir(storage); await mkdir(path.dirname(skill), { recursive: true }); await writeFile(skill, 'Group specification skill');
  git(repo, 'init', '-q', '--initial-branch=main'); git(repo, 'config', 'core.autocrlf', 'false'); await writeFile(path.join(repo, 'source.ts'), 'export const committed = true;\n');
  git(repo, 'add', '.'); git(repo, 'commit', '-qm', 'baseline');
  const sha = git(repo, 'rev-parse', 'HEAD');
  const spec = await prepareGroupAnalysis({ root: group, storage, source: { kind: 'group-analysis', requirement: '增加跨專案通知' }, repositories: [{ id: 'service-id', name: 'service', path: repo }] });
  return { root, group, repo, storage, sha, spec };
}

test('Group analysis stays on the selected committed HEAD while the user continues editing', async t => {
  const f = await fixture(t), binding = f.spec.groupAnalysis!;
  await writeFile(path.join(f.repo, 'source.ts'), 'uncommitted secret'); await writeFile(path.join(f.repo, 'private.txt'), 'untracked secret');
  await startGroupAnalysis(f.spec, f.storage, await resolvePythonRuntime('python'));
  assert.equal(binding.repositories[0].sha, f.sha);
  assert.equal(await readFile(path.join(binding.repositories[0].snapshotPath, 'source.ts'), 'utf8'), 'export const committed = true;\n');
  await assert.rejects(readFile(path.join(binding.repositories[0].snapshotPath, 'private.txt')), { code: 'ENOENT' });
  assert.deepEqual(f.spec.writableRoots, [binding.outputRoot]);
  assert.equal(f.spec.origin, undefined); assert.equal(f.spec.delivery?.mode, 'manual');
  assert.equal((await prepareGroupAnalysis({ root: f.group, storage: f.storage, source: f.spec.source as any, repositories: [], previous: f.spec })).groupAnalysis?.repositories[0].sha, f.sha);
  await assert.rejects(startGroupAnalysis(f.spec, f.storage, await resolvePythonRuntime('python'), AbortSignal.abort()));
});

test('Group completion rejects incomplete specifications and stale or escaped source evidence', async t => {
  const f = await fixture(t), binding = f.spec.groupAnalysis!;
  await startGroupAnalysis(f.spec, f.storage, await resolvePythonRuntime('python'));
  await writeFile(path.join(binding.outputRoot, 'SPEC.md'), '# 需求\n專案模組\n程式證據\n介面\n依賴\n實作順序\n驗收\n測試計畫\n');
  await writeFile(path.join(binding.outputRoot, 'cards.md'), '# 通知牌卡\n可複製的需求及驗收條件。');
  const evidence = { repositories: [{ id: 'service-id', sha: f.sha, evidence: [{ path: 'source.ts', claim: '增加通知介面' }] }] };
  const sourceFile = path.join(binding.outputRoot, 'sources.json'); await writeFile(sourceFile, JSON.stringify(evidence));
  assert.equal((await collectGroupAnalysis(f.spec)).state, 'ready');
  evidence.repositories[0].sha = 'f'.repeat(40); await writeFile(sourceFile, JSON.stringify(evidence));
  await assert.rejects(collectGroupAnalysis(f.spec), /固定 Repo\/SHA/);
  evidence.repositories[0].sha = f.sha; evidence.repositories[0].evidence[0].path = '../outside'; await writeFile(sourceFile, JSON.stringify(evidence));
  await assert.rejects(collectGroupAnalysis(f.spec), /證據路徑/);
  await writeFile(sourceFile, JSON.stringify({ repositories: [] })); await assert.rejects(collectGroupAnalysis(f.spec), /所有 Repo/);
  evidence.repositories[0].evidence[0].path = 'source.ts'; await writeFile(sourceFile, JSON.stringify(evidence));
  await writeFile(path.join(binding.outputRoot, 'SPEC.md'), '# Empty specification'); await assert.rejects(collectGroupAnalysis(f.spec), /必要/);
});

test('Group specifications follow layered BMAD output settings and reject paths outside the Group', async t => {
  const f = await fixture(t); await mkdir(path.join(f.group, '_bmad', 'custom'), { recursive: true });
  await writeFile(path.join(f.group, '_bmad', 'config.toml'), 'output_folder = "first"\n');
  await writeFile(path.join(f.group, '_bmad', 'custom', 'config.user.toml'), '[workflow]\noutput_folder = "{project-root}/project-docs"\n');
  assert.equal(await groupSpecsDirectory(f.group), path.join(f.group, 'project-docs', 'specs'));
  await writeFile(path.join(f.group, '_bmad', 'custom', 'config.user.toml'), 'output_folder = "../outside"\n');
  await assert.rejects(groupSpecsDirectory(f.group), /目前 Group/);
});

test('Group input cannot include another open workspace or a redirected source outside its root', async t => {
  const f = await fixture(t), outside = path.join(f.root, 'another-workspace'); await mkdir(outside);
  await assert.rejects(prepareGroupAnalysis({ root: f.group, storage: f.storage,
    source: { kind: 'group-analysis', requirement: 'Analyse the selected Group', repositoryIds: ['outside'] },
    repositories: [{ id: 'outside', name: 'Other workspace', path: outside }] }), /目前 Group/);
});
