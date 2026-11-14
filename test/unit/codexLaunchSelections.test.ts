import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { CodexLaunchCoordinator, launchRepositoryId, type CodexLaunchOptions } from '../../src/codex/launchCoordinator';
import { codexLaunchManualText } from '../../src/codex/launchProtocol';
import type { CodexTaskSource, CodexTaskSpec } from '../../src/codex/protocol';
import { restoreCodexUi } from '../../src/webview/codexUiState';
import { sanitizeCodexUiDraftValue } from '../../src/codex/uiDraftProtocol';
import { isCodexCommand } from '../../src/codex/commands';

async function fixture(t: test.TestContext) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'glw-launch-selections-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const repositories = ['front', 'service'].map(name => ({ id: launchRepositoryId(path.join(directory, name)), name, path: path.join(directory, name) }));
  const queued: CodexTaskSpec[] = [], prepared: CodexTaskSource[] = [];
  const options: CodexLaunchOptions = { directory, scope: () => 'local-group', publish: () => {}, inspect: async () => ({ repositories }),
    prepare: async source => { prepared.push(structuredClone(source)); return { source, title: 'Change', root: directory, writableRoots: [directory],
      workspaceKey: 'group', environmentKey: 'env', prompt: 'Perform the scoped work' }; }, environment: async () => {},
    skills: async () => [{ id: 'workflow', name: 'workflow', description: 'Required', required: true }, { id: 'testing', name: 'testing', description: 'Extra' }],
    models: async () => [{ id: 'model', label: 'Model', efforts: ['high'] }],
    enqueue: async (spec, id) => { queued.push(spec); return id; }, taskExists: async id => queued.some(spec => spec.title === id) };
  const launch = new CodexLaunchCoordinator(options); t.after(() => launch.dispose());
  return { launch, options, repositories, prepared, queued };
}

test('group selections and skills reach preparation and survive recreation without remote delivery', async t => {
  const f = await fixture(t), opened = await f.launch.create({ kind: 'group-analysis', requirement: 'Change the shared login flow' });
  assert.equal(opened.hasPreferences, undefined);
  const checked = await f.launch.check(opened.id, opened.revision);
  assert.equal(checked.automaticDelivery, false);
  assert.deepEqual(checked.repositoryIds, f.repositories.map(repo => repo.id));
  const selected = await f.launch.check(opened.id, checked.revision, { repositoryIds: [f.repositories[1].id], additionalSkillIds: ['testing'], testCommands: ['npm test'] });
  assert.equal(selected.state, 'ready'); await f.launch.submit(opened.id, selected.revision);
  const source = f.queued[0].source;
  assert.equal(source.kind, 'group-analysis');
  assert.deepEqual(source.kind === 'group-analysis' && source.repositoryIds, [f.repositories[1].id]);
  assert.deepEqual(source.additionalSkillIds, ['testing']); assert.deepEqual(source.testCommands, ['npm test']); assert.equal(source.automaticDelivery, false);
  const reopened = await f.launch.create({ kind: 'group-analysis', requirement: 'Another requirement' });
  assert.equal(reopened.hasPreferences, true);
  assert.deepEqual(reopened.additionalSkillIds, ['testing']); assert.deepEqual(reopened.repositoryIds, [f.repositories[1].id]);
});

test('a changed HEAD in any selected Group repository requires explicit source acknowledgement', async t => {
  const f = await fixture(t); let secondSha = 'b'.repeat(40);
  f.options.prepare = async source => ({ source, title: 'Group analysis', root: f.repositories[0].path, workspaceKey: 'group',
    prompt: 'Analyse', environmentKey: 'fixed', writableRoots: [], groupAnalysis: { id: 'a'.repeat(32), groupRoot: f.repositories[0].path,
      runtimeRoot: '/runtime', outputRoot: '/output', repositories: f.repositories.map((repo, index) => ({ ...repo, sha: index ? secondSha : 'a'.repeat(40), snapshotPath: '/snapshot/' + index })) } });
  const draft = await f.launch.create({ kind: 'group-analysis', requirement: 'Add shared notifications' });
  const initial = await f.launch.check(draft.id, draft.revision); assert.equal(initial.sourceSnapshot?.repositories?.length, 2);
  secondSha = 'c'.repeat(40); const changed = await f.launch.check(draft.id, initial.revision);
  assert.equal(changed.sourceSnapshot!.repositories!.find(repo => repo.id === f.repositories[0].id)!.sha, 'a'.repeat(40), 'the first repository remains unchanged');
  assert.ok(changed.sourceChange); assert.equal(changed.sourceChange.acknowledged, false);
  await assert.rejects(f.launch.submit(changed.id, changed.revision), /確認更新/);
});

test('MR review and fix preferences are isolated and unavailable skills fail before dispatch', async t => {
  const f = await fixture(t), review = await f.launch.create({ kind: 'merge-request', projectId: 1, iid: 2 });
  assert.equal(review.automaticDelivery, false, 'unverified rollout keeps new remote writes opt-in');
  const selected = await f.launch.check(review.id, review.revision, { repositoryId: f.repositories[0].id, additionalSkillIds: ['testing'], testCommands: ['npm test'], automaticDelivery: true });
  assert.equal(selected.state, 'ready'); await f.launch.submit(review.id, selected.revision);
  assert.equal(f.queued[0].source.automaticDelivery, false, 'saved launch flags cannot authorize remote publication');
  assert.equal((await f.launch.create({ kind: 'merge-request', projectId: 1, iid: 4 })).automaticDelivery, false, 'each result requires a new human confirmation');
  const fix = await f.launch.create({ kind: 'merge-request', projectId: 1, iid: 3, intent: 'fix-comments' });
  assert.equal(fix.automaticDelivery, false);
  assert.deepEqual(fix.additionalSkillIds, []); assert.deepEqual(fix.testCommands, []);
  const blocked = await f.launch.check(fix.id, fix.revision, { repositoryId: f.repositories[0].id, additionalSkillIds: ['removed'] });
  assert.equal(blocked.state, 'blocked'); assert.match(blocked.error!, /Skill/); assert.equal(f.queued.length, 1);
  await assert.rejects(f.launch.update(fix.id, blocked.revision, { testCommands: ['npm test\nsecret-command'] }), /單行/);
});

test('manual launch copy is available after Codex failure and uses unsaved input', async t => {
  const f = await fixture(t); f.options.environment = async () => { throw new Error('Codex 尚未登入'); };
  const opened = await f.launch.create({ kind: 'group-analysis', requirement: 'Saved request' });
  const blocked = await f.launch.check(opened.id, opened.revision);
  assert.equal(blocked.state, 'blocked'); assert.equal(f.queued.length, 0);
  const manual = codexLaunchManualText(blocked, { requirement: 'Latest local request', testCommands: ['npm test'] });
  assert.match(manual, /Latest local request/); assert.match(manual, /npm test/); assert.match(manual, /自行|使用者處理/);
  assert.match(manual, /不會接續原 thread/);
});

test('Issue development and Wiki generation do not become manual copy fallbacks after a Codex failure', async t => {
  const f = await fixture(t);
  for (const source of [{ kind: 'issue', projectId: 1, issueIid: 2 }, { kind: 'project-wiki', projectId: 1 }] as const) {
    const draft = await f.launch.create(source);
    assert.throws(() => codexLaunchManualText(draft, { requirement: 'Attempt manual fallback' }), /App Server/);
  }
  assert.equal(f.queued.length, 0);
});

test('selection drafts retain new controls and reject malformed persisted command lists', () => {
  const patch = { additionalSkillIds: ['testing'], repositoryIds: ['repo'], testCommands: ['npm test'], automaticDelivery: false };
  const restored = restoreCodexUi({ launchDrafts: { draft: patch } });
  assert.deepEqual(restored.launchDrafts?.draft, patch);
  assert.deepEqual(sanitizeCodexUiDraftValue(JSON.stringify(['launch', 'draft']), { patch }), { patch });
  assert.throws(() => sanitizeCodexUiDraftValue(JSON.stringify(['launch', 'draft']), { patch: { testCommands: ['npm test\nrm'] } }));
  assert.equal(restoreCodexUi({ launchDrafts: { draft: { testCommands: ['bad\ncommand'] } } }).launchDrafts?.draft, undefined);
  assert.equal(isCodexCommand({ action: 'open-artifact', taskId: 'task-one', artifactId: 'saved-report' }), true);
  assert.equal(isCodexCommand({ action: 'open-artifact', taskId: 'task-one', artifactId: 'saved-report', path: '../secret' }), false);
});
