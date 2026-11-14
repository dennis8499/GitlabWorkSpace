import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { BMAD_ENTRY_REGISTRY, bmadRequestSkill } from '../../src/workspace/bmadEntrypoints';
import { buildBmadCommand } from '../../src/workspace/bmadCommand';
import type { BmadWorkflowSnapshot } from '../../src/workspace/bmadProtocol';

function snapshot(): BmadWorkflowSnapshot {
  return { root: path.resolve('bmad-entry-fixture'), revision: 'ready', guidanceVersion: '6.12.4', compatibility: 'verified',
    installation: { state: 'ready', reason: '' }, codex: { state: 'ready', skills: ['wk-goal', 'wk-plan', 'wk-build', 'wk-verify', 'wk-project',
      'bmad-help', 'bmad-spec', 'bmad-build', 'bmad-build-auto', 'bmad-review'], reason: '' }, observation: { state: 'watching' },
    catalogSource: 'installed', nodes: [], phases: [], edges: [], steps: [], stories: [], currentCandidates: [], recommendations: [], watchDirectories: [], diagnostics: [] };
}
test('the UI, clipboard and shipped WorkflowKit use the same five-entry registry', async () => {
  const checked = JSON.parse(await readFile(path.resolve('resources/bmad/entrypoints.json'), 'utf8'));
  assert.deepEqual(BMAD_ENTRY_REGISTRY, checked);
  assert.deepEqual(BMAD_ENTRY_REGISTRY.entries.map(entry => entry.id), ['goal', 'plan', 'build', 'verify', 'project']);
  assert.equal(BMAD_ENTRY_REGISTRY.operations.length, 3);
});
test('an entry dispatch selects one router without adding all native candidate Skills', () => {
  const current = snapshot(), request = { revision: current.revision, command: 'entry' as const, entry: 'plan' as const, requirement: '整理現有資料成可執行需求' };
  assert.equal(bmadRequestSkill(current, request), 'wk-plan');
  const command = buildBmadCommand(current, request);
  assert.match(command, /^\$wk-plan/);
  assert.ok(!command.includes('$bmad-prd'));
  assert.ok(!command.includes('$bmad-architecture'));
  assert.match(command, /只選目前需要/);
});
test('external BMAD enables only entries with actual native capabilities', () => {
  const current = snapshot(); current.codex.skills = ['wk-verify', 'bmad-spec'];
  assert.throws(() => bmadRequestSkill(current, { revision: 'ready', command: 'entry', entry: 'verify' }), /外部 BMAD/);
  current.codex.skills.push('bmad-review');
  assert.equal(bmadRequestSkill(current, { revision: 'ready', command: 'entry', entry: 'verify' }), 'wk-verify');
});
test('Build Auto is blocked until both Host checks pass; writable files alone do not enable it', () => {
  const current = snapshot(), request = { revision: 'ready', command: 'entry' as const, entry: 'build' as const, nativeSkill: 'bmad-build-auto', requirement: '修復問題' };
  assert.throws(() => buildBmadCommand(current, request), /同步子代理|sandbox/);
  current.autoBuild = { state: 'ready', synchronousSubagents: true, gitSandbox: 'unverified', reason: '尚未測試 Git' };
  assert.throws(() => buildBmadCommand(current, request), /尚未測試/);
  current.autoBuild.gitSandbox = 'verified';
  assert.match(buildBmadCommand(current, request), /本次明確選擇能力：\$bmad-build-auto/);
  current.autoBuild.synchronousSubagents = false; current.autoBuild.reason = '';
  assert.throws(() => buildBmadCommand(current, request), /同步子代理/);
});
test('status does not require a new goal and forged entry parameters are rejected', () => {
  const current = snapshot();
  assert.match(buildBmadCommand(current, { revision: 'ready', command: 'entry', entry: 'project', operation: 'status' }), /只讀取進度/);
  assert.throws(() => buildBmadCommand(current, { revision: 'ready', command: 'entry', entry: 'plan', nativeSkill: 'bmad-build', requirement: 'x' }), /不屬於/);
  assert.throws(() => buildBmadCommand(current, { revision: 'ready', command: 'entry', entry: 'project', operation: 'resume', artifactId: 'forged' }), /不存在/);
});
test('blocked Auto records retain their exact identity for diagnosis instead of being blindly resumed', () => {
  const current = snapshot();
  current.nodes.push({ id: 'auto', skill: 'bmad-build-auto', module: 'BMad Method', displayName: 'Auto', menuCode: 'BA', description: '', action: '', args: '', phase: 'ship', required: false,
    precededBy: [], followedBy: [], outputLocation: '', outputs: [] });
  current.steps.push({ id: 'auto', status: 'blocked', summary: '', artifacts: [{ id: 'blocked-auto', path: path.join(current.root!, 'spec-auto.md'), relativePath: 'spec-auto.md',
    fingerprint: 'hash', status: 'blocked', nativeStatus: 'blocked', reason: 'no subagents' }] });
  current.autoBuild = { state: 'ready', synchronousSubagents: true, gitSandbox: 'verified', reason: '' };
  const diagnosis = buildBmadCommand(current, { revision: 'ready', command: 'entry', entry: 'goal', operation: 'resume', artifactId: 'blocked-auto' });
  assert.ok(diagnosis.includes(JSON.stringify(current.steps[0].artifacts[0].path)));
  assert.match(diagnosis, /先核對阻擋原因/);
  assert.throws(() => buildBmadCommand(current, { revision: 'ready', command: 'entry', entry: 'build', operation: 'resume', nativeSkill: 'bmad-build-auto', artifactId: 'blocked-auto' }), /已受阻/);
});
