import assert from 'node:assert/strict';
import test from 'node:test';
import type * as VSCode from 'vscode';
import type { Model } from '../../src/codex/generated/v2/Model';
import type { CodexTaskSource, CodexTaskSpec } from '../../src/codex/protocol';
import { applyExecutionSelection, pickExecutionSelection, validateExecutionSelection } from '../../src/codex/executionSelection';
import { selectRoutingEffort } from '../../src/codex/modelRoutingProtocol';
import { CodexHostActions } from '../../src/codex/hostActions';
import { describeAction } from '../../src/workspace/actionPolicy';

const model = (name: string, efforts = ['low', 'high', 'xhigh'], preferred = 'high') => ({ id: name, model: name, displayName: name,
  defaultReasoningEffort: preferred, supportedReasoningEfforts: efforts.map(reasoningEffort => ({ reasoningEffort, description: reasoningEffort })) }) as Model;
function spec(review = false): CodexTaskSpec {
  return { root: 'repo', title: 'Task', prompt: 'Work', source: { kind: 'bmad', request: { command: 'task', revision: 'r' } },
    writableRoots: ['repo'], workspaceKey: 'repo', environmentKey: 'base', ...(review ? { review: {
      tool: 'merge-reviewer' as const, requestId: 'a'.repeat(32), revision: 'r' } } : {}) };
}
function picker(select: (items: any[], step: number, options: any) => any) {
  let step = 0;
  return { window: { showQuickPick: async (items: any[], options: any) => select(items, step++, options) } } as unknown as typeof VSCode;
}
test('ordinary default inherits local settings; explicit models use catalog default effort', async () => {
  const models = [model('fixture-one', ['low', 'high'], 'low'), model('fixture-two')];
  assert.deepEqual(await pickExecutionSelection(picker(items => items[0]), models, spec()), {});
  const selected = await pickExecutionSelection(picker((items, step) => step ? items[0] : items.find(item => item.model?.model === 'fixture-one')), models, spec());
  assert.deepEqual(selected, { model: 'fixture-one', effort: 'low' });
  const previous = { ...spec(), model: 'fixture-two', effort: 'xhigh' };
  assert.deepEqual(await pickExecutionSelection(picker((items, step) => step ? items[0] : items.find(item => item.model?.model === 'fixture-one')), models, previous), selected);
});
test('review defaults to a fixed catalog effort and offers no Auto', async () => {
  const selection = await pickExecutionSelection(picker(items => items[0]), [model('fixture-other'), model('gpt-6-luna')], spec(true));
  assert.deepEqual(selection, { model: 'gpt-6-luna', effort: 'high' });
  const manual = { ...spec(true), model: 'gpt-6-luna', effort: 'xhigh' };
  assert.equal((await pickExecutionSelection(picker(items => items[0]), [model('gpt-6-luna')], manual))?.effort, 'xhigh');
});
test('cancelling either selection step cancels creation and empty catalogs fail', async () => {
  assert.equal(await pickExecutionSelection(picker(() => undefined), [model('one')], spec()), undefined);
  assert.equal(await pickExecutionSelection(picker((items, step) => step ? undefined : items[1]), [model('one')], spec()), undefined);
  await assert.rejects(pickExecutionSelection(picker(items => items[0]), [], spec()), /未提供/);
});
test('unknown effort labels remain manually selectable with Auto unavailable', async () => {
  const selected = await pickExecutionSelection(picker((items, step, options) => {
    if (step) { assert.equal(items.some(item => item.label === 'auto'), false); assert.equal(typeof options.placeHolder, 'string'); }
    return items[0];
  }), [model('custom-model', ['custom'], 'custom')], spec(true));
  assert.equal(selected?.effort, 'custom');
});
test('manual reviewer models do not depend on WorkflowKit routing capability', async () => {
  assert.equal((await pickExecutionSelection(picker(items => items[0]), [model('other')], spec(true)))?.model, 'other');
});
test('all task sources preserve selection identity on preparation and reject unsupported routing settings', () => {
  const sources: CodexTaskSource[] = [
    { kind: 'free', repository: 'repo', prompt: 'Work' }, { kind: 'skill', featureId: 'query', inputs: {}, revision: 'r' },
    { kind: 'bmad', request: { command: 'task', revision: 'r' } }, { kind: 'issue', projectId: 1, issueIid: 2 },
    { kind: 'project-wiki', projectId: 1 }, { kind: 'merge-request', projectId: 1, iid: 2, intent: 'fix-comments' },
    { kind: 'review', tool: 'merge-reviewer', action: 'refresh', revision: 'r', requestId: 'a'.repeat(32) }
  ];
  for (const source of sources) {
    const selected = { ...source, model: 'one', effort: 'high' };
    const first = applyExecutionSelection(spec(), selected), again = applyExecutionSelection(spec(), structuredClone(first.source));
    assert.equal(first.environmentKey, again.environmentKey); assert.equal(again.model, 'one'); assert.equal(again.effort, 'high');
    const another = applyExecutionSelection(spec(), { ...source, model: 'two', effort: 'low' });
    if (source.kind !== 'free') assert.notEqual(first.environmentKey, another.environmentKey);
    assert.equal(first.model, 'one');
  }
  assert.throws(() => applyExecutionSelection(spec(), { ...sources[0], model: 'one', effort: 'auto' }), /Auto/);
  assert.throws(() => validateExecutionSelection({ effort: 'high' }), /設定無效/);
  const review = applyExecutionSelection(spec(true), { ...sources[1], model: 'one', effort: 'high', modelEfforts: ['high', 'xhigh'] });
  assert.equal(review.model, 'one'); assert.equal(review.effort, 'high'); assert.equal(review.routing, undefined);
});
test('Auto maps sparse model efforts upward and records a cap only above its maximum', () => {
  assert.deepEqual(selectRoutingEffort('medium', ['low', 'high', 'xhigh']), { effort: 'high', capped: false });
  assert.deepEqual(selectRoutingEffort('max', ['low', 'xhigh']), { effort: 'xhigh', capped: true });
  assert.deepEqual(selectRoutingEffort('high', ['ultra']), { effort: 'ultra', capped: false });
  assert.throws(() => selectRoutingEffort('high', ['custom']), /無法排序/);
});

test('Host creation opens the shared launch draft without preparing or dispatching and preserves native recovery', async () => {
  const fakeVscode: any = { window: { showQuickPick: async () => { throw new Error('Native picker must not open'); } } };
  const loader = require('node:module'), original = loader._load;
  loader._load = (name: string, ...args: unknown[]) => name === 'vscode' ? fakeVscode : original(name, ...args);
  let WorkspacePanel: any;
  try { ({ WorkspacePanel } = require('../../src/workspace/workspacePanel')); } finally { loader._load = original; }
  const panel = Object.create(WorkspacePanel.prototype), drafts: CodexTaskSource[] = [], queued: CodexTaskSpec[] = [];
  let prepares = 0;
  panel.openCodexLaunch = async (source: CodexTaskSource) => { drafts.push(source); };
  panel.prepareCodexTask = async (source: CodexTaskSource) => { prepares++; return { ...spec(true), source }; };
  panel.getCodexBridge = () => ({ enqueue: async (prepared: CodexTaskSpec) => { queued.push(prepared); return 'recovered'; } });
  const sources: CodexTaskSource[] = [
    { kind: 'free', repository: 'repo', prompt: 'Work' }, { kind: 'skill', featureId: 'query', inputs: {}, revision: 'r' },
    { kind: 'bmad', request: { command: 'task', revision: 'r' } }, { kind: 'issue', projectId: 1, issueIid: 2 },
    { kind: 'project-wiki', projectId: 1 }, { kind: 'project-wiki', projectId: 1, incrementalFrom: 'old-task' },
    { kind: 'merge-request', projectId: 1, iid: 2 }, { kind: 'merge-request', projectId: 1, iid: 2, intent: 'fix-comments' },
    { kind: 'review', tool: 'merge-reviewer', action: 'refresh', revision: 'r', requestId: 'a'.repeat(32) }
  ];
  for (const source of sources) assert.equal(await panel.createSelectedCodexTask(source), undefined);
  assert.deepEqual(drafts, sources); assert.equal(prepares, 0); assert.equal(queued.length, 0);
  assert.equal(await panel.createSelectedCodexTask({ kind: 'review', tool: 'merge-reviewer', action: 'resume', revision: 'r', requestId: 'a'.repeat(32) }), 'recovered');
  assert.equal(prepares, 1); assert.equal(queued.length, 1); assert.equal(drafts.length, sources.length);
});
test('free creation preserves the requirement and context when model selection is cancelled', async () => {
  const attempts: CodexTaskSource[] = [], opened: string[] = [];
  const host = new CodexHostActions({
    repositories: async () => [{ name: 'repo', path: 'repo' }],
    createTask: async (source: CodexTaskSource) => { attempts.push(source); return attempts.length === 1 ? undefined : 'created'; },
    selected: async (id: string) => { opened.push(id); }
  } as any, { workspace: { isTrusted: true }, window: {
    showQuickPick: async (items: any[]) => items[0], showInputBox: async () => 'Keep this requirement'
  } } as any);
  await host.run({ action: 'create' });
  assert.equal(attempts.length, 1); assert.deepEqual(opened, []);
  await host.run({ action: 'create' });
  assert.equal(attempts.length, 2); assert.deepEqual(attempts[0], attempts[1]);
  assert.deepEqual(opened, ['created']);
});

test('reprepare preserves trusted source, releases resources before preflight and rejects unsettled tasks', async () => {
  const loader = require('node:module'), original = loader._load;
  loader._load = (name: string, ...args: unknown[]) => name === 'vscode' ? {} : original(name, ...args);
  let WorkspacePanel: any;
  try { ({ WorkspacePanel } = require('../../src/workspace/workspacePanel')); } finally { loader._load = original; }
  const panel = Object.create(WorkspacePanel.prototype);
  const trusted: CodexTaskSpec = { ...spec(), source: { kind: 'issue', projectId: 1, issueIid: 2, repository: 'repo', requirement: 'Keep requirement',
    model: 'model-one', effort: 'high', isolated: true, returnTo: { mode: 'developer', issueTab: 'time' } },
    origin: { kind: 'issue', accountKey: 'account', baseUrl: 'https://gitlab.test', projectId: 1, projectPath: 'team/repo', repositoryRoot: 'repo',
      webUrl: 'https://gitlab.test/team/repo/-/issues/2', iid: 2, sourceBranch: 'main', sourceSha: 'a'.repeat(40) } };
  const base = { id: 'task', status: 'failed', origin: trusted.origin, controls: { canResume: true, canDelete: true, external: false } };
  let current: any = base, leased = false, enqueues = 0, checks = 0;
  const drafts: Array<{ source: CodexTaskSource; baseline: CodexTaskSpec }> = [];
  panel.linkedCodexSpec = async () => trusted;
  panel.checkLinkedCodexAccess = () => () => { checks++; };
  panel.getCodexBridge = () => ({ publish: async () => {}, list: () => [current], specification: async () => trusted,
    enqueue: async () => { enqueues++; }, withResources: async (_id: string, work: () => Promise<void>) => {
      leased = true; try { return await work(); } finally { leased = false; }
    } });
  panel.openCodexLaunch = async (source: CodexTaskSource, baseline: CodexTaskSpec) => {
    assert.equal(leased, false, 'source preflight must run after old task resource lease is released'); drafts.push({ source, baseline });
  };
  await panel.codexWorkflowAction('reprepare', 'task');
  assert.equal(drafts.length, 1); assert.deepEqual(drafts[0].source, trusted.source); assert.notEqual(drafts[0].source, trusted.source);
  assert.equal(drafts[0].baseline, trusted); assert.equal(checks, 1); assert.equal(enqueues, 0); assert.equal(current, base);
  const blocked = [
    ...['queued', 'starting', 'running', 'waiting', 'pausing', 'uncertain'].map(status => ({ status })),
    { result: { state: 'uncertain' } }, { publication: { state: 'pending' } }, { publications: { discussion: { state: 'pending' } } },
    { recovery: { cleanup: 'unknown' } }, { recovery: { publication: 'unknown' } }, { recovery: { publication: 'pending' } },
    { uncertainMessages: 1 }, { messageQueue: [{ state: 'uncertain' }] }, { messageQueue: [{ state: 'sending' }] },
    { controls: { ...base.controls, canDelete: false } }, { controls: { ...base.controls, external: true } }
  ];
  for (const update of blocked) { current = { ...base, ...update }; await assert.rejects(panel.codexWorkflowAction('reprepare', 'task'), /請先停止/); }
  current = base;
  panel.getCodexBridge = () => ({ publish: async () => {}, list: () => [current], withResources: async (_id: string, work: () => Promise<void>) => {
    current = { ...base, status: 'running' }; return work();
  } });
  await assert.rejects(panel.codexWorkflowAction('reprepare', 'task'), /狀態已變更/);
  panel.linkedCodexSpec = async () => ({ ...trusted, source: { kind: 'review', action: 'resume' } });
  await assert.rejects(panel.codexWorkflowAction('reprepare', 'task'), /只有 GitLab/);
  assert.equal(drafts.length, 1); assert.equal(enqueues, 0);
  const policy = describeAction({ type: 'codexCommand', command: { action: 'reprepare', taskId: 'task' } } as any);
  assert.equal(policy.kind, 'write'); assert.equal(policy.resourceKey, 'codex:task'); assert.equal(policy.concurrency, 'exclusive');
});
