import assert from 'node:assert/strict';
import test from 'node:test';
import type * as VSCode from 'vscode';
import type { Model } from '../../src/codex/generated/v2/Model';
import type { CodexTaskSource, CodexTaskSpec } from '../../src/codex/protocol';
import { applyExecutionSelection, pickExecutionSelection, validateExecutionSelection } from '../../src/codex/executionSelection';
import { selectRoutingEffort } from '../../src/codex/modelRoutingProtocol';
import { CodexHostActions } from '../../src/codex/hostActions';

const model = (name: string, efforts = ['low', 'high', 'xhigh'], preferred = 'high') => ({ id: name, model: name, displayName: name,
  defaultReasoningEffort: preferred, supportedReasoningEfforts: efforts.map(reasoningEffort => ({ reasoningEffort, description: reasoningEffort })) }) as Model;
function spec(routed = false): CodexTaskSpec {
  return { root: 'repo', title: 'Task', prompt: 'Work', source: { kind: 'bmad', request: { command: 'task', revision: 'r' } },
    writableRoots: ['repo'], workspaceKey: 'repo', environmentKey: 'base', ...(routed ? { routing: {
      tool: 'merge-reviewer' as const, requestId: 'a'.repeat(32), runtimeRoot: 'runtime', requestedEffort: 'auto',
      skillPath: 'skill', payloadHash: 'b'.repeat(64), supportsModelSelection: true } } : {}) };
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
test('review defaults to Luna and Auto and freezes selected model capabilities', async () => {
  const selection = await pickExecutionSelection(picker(items => items[0]), [model('fixture-other'), model('gpt-6-luna')], spec(true));
  assert.deepEqual(selection, { model: 'gpt-6-luna', effort: 'auto', modelEfforts: ['low', 'high', 'xhigh'] });
  const manual = spec(true); manual.routing!.requestedEffort = 'xhigh';
  assert.equal((await pickExecutionSelection(picker(items => items[0]), [model('gpt-6-luna')], manual))?.effort, 'xhigh');
});
test('cancelling either selection step cancels creation and empty catalogs fail', async () => {
  assert.equal(await pickExecutionSelection(picker(() => undefined), [model('one')], spec()), undefined);
  assert.equal(await pickExecutionSelection(picker((items, step) => step ? undefined : items[1]), [model('one')], spec()), undefined);
  await assert.rejects(pickExecutionSelection(picker(items => items[0]), [], spec()), /未提供/);
});
test('unknown effort labels remain manually selectable with Auto unavailable', async () => {
  const selected = await pickExecutionSelection(picker((items, step, options) => {
    if (step) { assert.equal(items.some(item => item.label === 'auto'), false); assert.match(options.placeHolder, /Auto 不可用/); }
    return items[0];
  }), [model('custom-model', ['custom'], 'custom')], spec(true));
  assert.equal(selected?.effort, 'custom');
});
test('old kit accepts Luna but rejects a different reviewer model before enqueue', async () => {
  const old = spec(true); delete old.routing!.supportsModelSelection;
  await assert.rejects(pickExecutionSelection(picker(items => items[0]), [model('other')], old), /更新 WorkflowKit/);
  assert.equal((await pickExecutionSelection(picker(items => items[0]), [model('gpt-6-luna')], old))?.modelEfforts, undefined);
  const withoutRouting = spec(); withoutRouting.review = { tool: 'merge-reviewer', requestId: 'a'.repeat(32), revision: 'r' };
  await assert.rejects(pickExecutionSelection(picker(items => items[0]), [model('other')], withoutRouting), /更新 WorkflowKit/);
  assert.deepEqual(await pickExecutionSelection(picker(items => items[0]), [model('other'), model('gpt-6-luna')], withoutRouting), { model: 'gpt-6-luna', effort: 'high' });
  assert.throws(() => applyExecutionSelection(withoutRouting, { ...withoutRouting.source, model: 'other', effort: 'high' }), /更新 WorkflowKit/);
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
  assert.throws(() => applyExecutionSelection(spec(), { ...sources[0], model: 'one', effort: 'auto' }), /僅適用/);
  assert.throws(() => validateExecutionSelection({ effort: 'high' }), /設定無效/);
  const review = applyExecutionSelection(spec(true), { ...sources[1], model: 'one', effort: 'auto', modelEfforts: ['high', 'xhigh'] });
  assert.equal(review.routing?.model, 'one'); assert.deepEqual(review.routing?.supportedEfforts, ['high', 'xhigh']);
});
test('Auto maps sparse model efforts upward and records a cap only above its maximum', () => {
  assert.deepEqual(selectRoutingEffort('medium', ['low', 'high', 'xhigh']), { effort: 'high', capped: false });
  assert.deepEqual(selectRoutingEffort('max', ['low', 'xhigh']), { effort: 'xhigh', capped: true });
  assert.deepEqual(selectRoutingEffort('high', ['ultra']), { effort: 'ultra', capped: false });
  assert.throws(() => selectRoutingEffort('high', ['custom']), /無法排序/);
});

test('Host creation uses shared pickers for every new source and bypasses them only for native recovery', async () => {
  const fakeVscode: any = { window: { showQuickPick: async (items: any[]) => items[0] } };
  const loader = require('node:module'), original = loader._load;
  loader._load = (name: string, ...args: unknown[]) => name === 'vscode' ? fakeVscode : original(name, ...args);
  let WorkspacePanel: any;
  try { ({ WorkspacePanel } = require('../../src/workspace/workspacePanel')); } finally { loader._load = original; }
  const panel = Object.create(WorkspacePanel.prototype), queued: CodexTaskSpec[] = [], outcomes: any[] = [];
  let reads = 0, failCatalog = false;
  panel.noteOutcome = (outcome: unknown) => outcomes.push(outcome);
  panel.prepareCodexTask = async (source: CodexTaskSource) => applyExecutionSelection({ ...spec(source.kind === 'review' || source.kind === 'merge-request' && source.intent !== 'fix-comments'), source }, source);
  panel.getCodexBridge = () => ({ models: async () => { reads++; if (failCatalog) throw new Error('catalog failed'); return [model('gpt-6-luna')]; },
    enqueue: async (prepared: CodexTaskSpec) => { queued.push(prepared); return 'created'; } });
  const sources: CodexTaskSource[] = [
    { kind: 'free', repository: 'repo', prompt: 'Work' }, { kind: 'skill', featureId: 'query', inputs: {}, revision: 'r' },
    { kind: 'bmad', request: { command: 'task', revision: 'r' } }, { kind: 'issue', projectId: 1, issueIid: 2 },
    { kind: 'project-wiki', projectId: 1 }, { kind: 'project-wiki', projectId: 1, incrementalFrom: 'old-task' },
    { kind: 'merge-request', projectId: 1, iid: 2 }, { kind: 'merge-request', projectId: 1, iid: 2, intent: 'fix-comments' },
    { kind: 'review', tool: 'merge-reviewer', action: 'refresh', revision: 'r', requestId: 'a'.repeat(32) }
  ];
  for (const source of sources) assert.equal(await panel.createSelectedCodexTask(source), 'created');
  assert.equal(reads, sources.length); assert.equal(queued.length, sources.length);
  assert.equal(queued.at(-1)!.routing?.model, 'gpt-6-luna');
  await panel.createSelectedCodexTask({ kind: 'review', tool: 'merge-reviewer', action: 'resume', revision: 'r', requestId: 'a'.repeat(32) });
  assert.equal(reads, sources.length);
  fakeVscode.window.showQuickPick = async (items: any[]) => items.find(item => !item.model);
  await panel.createSelectedCodexTask({ ...sources[2], model: 'gpt-6-luna', effort: 'high' });
  assert.equal(queued.at(-1)!.model, undefined); assert.equal(queued.at(-1)!.source.effort, undefined);
  const before = queued.length;
  fakeVscode.window.showQuickPick = async () => undefined;
  assert.equal(await panel.createSelectedCodexTask(sources[0]), undefined); assert.equal(queued.length, before);
  assert.deepEqual(outcomes.at(-1), { status: 'cancelled', effect: 'none' });
  failCatalog = true;
  await assert.rejects(panel.createSelectedCodexTask(sources[0]), /catalog failed/); assert.equal(queued.length, before);
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
