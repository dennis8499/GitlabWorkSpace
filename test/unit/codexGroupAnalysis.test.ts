import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { collectGroupAnalysis, groupSpecsDirectory, prepareGroupAnalysis, startGroupAnalysis } from '../../src/codex/groupAnalysis';
import { resolvePythonRuntime } from '../../src/workspace/pythonRuntime';

const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'core.hooksPath=', '-c', 'user.name=Group Test', '-c', 'user.email=group@test.invalid', ...args], { cwd, windowsHide: true, encoding: 'utf8' }).trim();
async function fixture(t: test.TestContext, groupName = 'group') {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'codex-group-'))), storage = path.join(root, 'storage');
  t.after(() => rm(root, { recursive: true, force: true }));
  const group = path.join(root, groupName), repo = path.join(group, 'service'), skill = path.join(group, '.agents', 'skills', 'bmad-spec', 'SKILL.md');
  await mkdir(repo, { recursive: true }); await mkdir(storage); await mkdir(path.dirname(skill), { recursive: true }); await writeFile(skill, 'Group specification skill');
  const wikiSkill = path.join(group, '.agents', 'skills', 'codebase-wiki', 'SKILL.md');
  await mkdir(path.dirname(wikiSkill), { recursive: true }); await writeFile(wikiSkill, 'Source-first functional exploration');
  git(repo, 'init', '-q', '--initial-branch=main'); git(repo, 'config', 'core.autocrlf', 'false'); await writeFile(path.join(repo, 'source.ts'), 'export const committed = true;\n');
  git(repo, 'add', '.'); git(repo, 'commit', '-qm', 'baseline');
  const sha = git(repo, 'rev-parse', 'HEAD');
  const spec = await prepareGroupAnalysis({ root: group, storage, source: { kind: 'group-analysis', requirement: '增加跨專案通知' }, repositories: [{ id: 'service-id', name: 'service', path: repo }] });
  return { root, group, repo, storage, sha, spec };
}

test('Group Spec keeps original BMAD configuration roots separate from its artifact working directory', async t => {
  const f = await fixture(t, '原 Group with spaces'), binding = f.spec.groupAnalysis!;
  const quote = (value: string) => JSON.stringify(value.replaceAll('\\', '/'));
  const runner = quote(path.join(f.group, '.agents', 'gitlab-workspace-kit', 'run.py'));
  const skillRoot = path.join(f.group, '.agents', 'skills', 'bmad-spec');
  const helper = (name: string) => quote(path.join(f.group, '_bmad', 'scripts', name));
  assert.equal(f.spec.executionRoot, binding.outputRoot);
  assert.deepEqual(f.spec.writableRoots, [binding.outputRoot]);
  assert.ok(f.spec.prompt.includes(`{project-root} = ${quote(f.group)}`));
  assert.ok(f.spec.prompt.includes(`{spec-folder} = ${quote(binding.outputRoot)}`));
  assert.ok(f.spec.prompt.includes(`python -X utf8 -B ${runner} -- uv run ${helper('resolve_customization.py')} --skill ${quote(skillRoot)} --project-root ${quote(f.group)} --key workflow`));
  assert.ok(f.spec.prompt.includes(`python -X utf8 -B ${runner} -- uv run ${helper('resolve_config.py')} --project-root ${quote(f.group)}`));
  assert.ok(f.spec.prompt.includes(`python -X utf8 -B ${runner} -- uv run ${helper('memlog.py')} init --workspace ${quote(binding.outputRoot)}`));
  assert.ok(f.spec.prompt.includes(`init 與 append 都必須傳 --workspace ${quote(binding.outputRoot)}`));
  assert.ok(!f.spec.prompt.includes(`--project-root ${quote(binding.outputRoot)}`));
  assert.match(f.spec.prompt, /不得由 cwd 重新推導 \{project-root\}/);
  assert.match(f.spec.prompt, /設定解析失敗須明列缺口並停止 Spec 階段/);
  assert.match(f.spec.prompt, /不搬移、複製或改寫原 Group 的 _bmad 設定/);
  assert.match(f.spec.prompt, /保留原生 activation_steps_prepend\/append、persistent_facts 與後續階段依賴/);
  assert.equal(f.spec.skill?.name, 'codebase-wiki');
  assert.ok(f.spec.prompt.indexOf('source-first functional-exploration') < f.spec.prompt.indexOf('功能與證據探索完成後，才讀取'));
  assert.ok(!f.spec.prompt.includes('$bmad-spec'));
});

test('Group analysis stays on the selected committed HEAD while the user continues editing', async t => {
  const f = await fixture(t), binding = f.spec.groupAnalysis!;
  await writeFile(path.join(f.repo, 'source.ts'), 'uncommitted secret'); await writeFile(path.join(f.repo, 'private.txt'), 'untracked secret');
  await startGroupAnalysis(f.spec, f.storage, await resolvePythonRuntime('python'));
  assert.equal(binding.repositories[0].sha, f.sha);
  assert.equal(await readFile(path.join(binding.repositories[0].snapshotPath, 'source.ts'), 'utf8'), 'export const committed = true;\n');
  await assert.rejects(readFile(path.join(binding.repositories[0].snapshotPath, 'private.txt')), { code: 'ENOENT' });
  assert.deepEqual(f.spec.writableRoots, [binding.outputRoot]);
  assert.equal(f.spec.origin, undefined); assert.equal(f.spec.delivery?.mode, 'manual');
  assert.equal(f.spec.skill?.name, 'codebase-wiki');
  assert.equal(binding.outputRoot, path.join(binding.runtimeRoot, 'artifacts'));
  assert.equal((await prepareGroupAnalysis({ root: f.group, storage: f.storage, source: f.spec.source as any, repositories: [], previous: f.spec })).groupAnalysis?.repositories[0].sha, f.sha);
  await assert.rejects(startGroupAnalysis(f.spec, f.storage, await resolvePythonRuntime('python'), AbortSignal.abort()));
});

test('Group completion rejects incomplete specifications and stale or escaped source evidence', async t => {
  const f = await fixture(t), binding = f.spec.groupAnalysis!;
  await startGroupAnalysis(f.spec, f.storage, await resolvePythonRuntime('python'));
  await writeFile(path.join(binding.outputRoot, 'SPEC.md'), '# 需求\n專案模組\n程式證據\n介面\n依賴\n實作順序\n驗收\n測試計畫\n');
  await writeFile(path.join(binding.outputRoot, 'cards.md'), '# 通知牌卡\n可複製的需求及驗收條件。');
  await writeFile(path.join(binding.outputRoot, 'issues.json'), JSON.stringify({ schema: 'IssueDraftBundle/v1', analysisId: binding.id,
    drafts: [{ id: 'notification', projectPath: 'service', title: '增加通知', description: '新增通知介面', acceptanceCriteria: ['通知可供查詢'],
      sourceEvidence: [{ path: 'source.ts', claim: '增加通知介面' }] }] }));
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
