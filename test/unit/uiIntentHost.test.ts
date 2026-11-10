import assert from 'node:assert/strict';
import test from 'node:test';
import { HostUiIntents } from '../../src/workspace/hostUiIntents';
import { isWorkspaceRequest } from '../../src/workspace/workspaceRequestValidation';
import { WorkflowKitService } from '../../src/workspace/workflowKitService';

const id = (sequence: number) => ({ viewId: 'view-a', sequence });
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

test('only the latest choice commits, and fields serialize independently', async () => {
  const host = new HostUiIntents(), gate = deferred(), events: string[] = [];
  const first = host.register('workflowKitSource', { uiIntentId: id(1) });
  const a = host.apply(first, async current => {
    events.push('first-start'); await gate.promise;
    if (current()) events.push('first-commit');
  });
  await tick();
  const second = host.register('workflowKitSource', { uiIntentId: id(2) });
  const b = host.apply(second, async () => { events.push('second-commit'); });
  const mode = host.register('mode', { uiIntentId: id(3) });
  assert.equal(await host.apply(mode, async () => { events.push('mode-commit'); }), true);
  assert.deepEqual(events, ['first-start', 'mode-commit']);
  gate.resolve();
  assert.equal(await a, false); assert.equal(await b, true);
  assert.deepEqual(events, ['first-start', 'mode-commit', 'second-commit']);
});

test('native navigation fences old requests only for the affected fields', async () => {
  const host = new HostUiIntents();
  const oldMode = host.register('mode', { uiIntentId: id(1), hostNavigationGeneration: 0 });
  const event = host.navigate({ mode: 'codex' });
  assert.equal(event.generation, 1);
  assert.equal(await host.apply(oldMode, async () => assert.fail('old mode applied')), false);
  const late = host.register('mode', { uiIntentId: id(9), hostNavigationGeneration: 0 });
  assert.equal(await host.apply(late, async () => assert.fail('late old navigation applied')), false);
  const source = host.register('projectSource', { uiIntentId: id(2), hostNavigationGeneration: 0 });
  assert.equal(await host.apply(source, async () => undefined), true);
  const current = host.register('mode', { uiIntentId: id(3), hostNavigationGeneration: 1 });
  assert.equal(await host.apply(current, async () => undefined), true);
  assert.equal(host.register('mode', { uiIntentId: id(3), hostNavigationGeneration: 1 }), current, 'duplicates share the existing choice');
  assert.equal(await host.apply(host.register('mode', {}), async () => undefined), true, 'legacy requests still work');
});

test('a failed persistence does not block the next mutation', async () => {
  const host = new HostUiIntents();
  const first = host.register('mode', { uiIntentId: id(1) });
  await assert.rejects(host.apply(first, async () => { throw new Error('save failed'); }), /save failed/);
  const second = host.register('mode', { uiIntentId: id(2) });
  assert.equal(await host.apply(second, async () => undefined), true);
});

test('UI intent metadata is validated without breaking legacy messages', () => {
  assert.equal(isWorkspaceRequest({ type: 'setMode', mode: 'sa' }), true);
  assert.equal(isWorkspaceRequest({ type: 'setMode', mode: 'sa', uiIntentId: id(1), hostNavigationGeneration: 0 }), true);
  for (const uiIntentId of [{ viewId: '', sequence: 1 }, { viewId: 'view-a', sequence: -1 },
    { viewId: 'view-a', sequence: 1.5 }, { viewId: 'view-a', sequence: 1, extra: true }]) {
    assert.equal(isWorkspaceRequest({ type: 'setMode', mode: 'sa', uiIntentId }), false);
  }
  assert.equal(isWorkspaceRequest({ type: 'setProjectSource', source: 'local', hostNavigationGeneration: -1 }), false);
});

const moduleLoader = require('node:module') as { _load: (name: string, parent: unknown, main: boolean) => unknown };
const originalLoad = moduleLoader._load;
moduleLoader._load = (name, parent, main) => name === 'vscode' ? {} : originalLoad(name, parent, main);
let WorkspacePanel: typeof import('../../src/workspace/workspacePanel').WorkspacePanel;
try { ({ WorkspacePanel } = require('../../src/workspace/workspacePanel')); }
finally { moduleLoader._load = originalLoad; }

function fixture() {
  const messages: any[] = [], host: any = Object.create(WorkspacePanel!.prototype);
  const source = { source: 'github' };
  Object.assign(host, {
    activeMode: 'dashboard', projectSource: 'gitlab', mergeRequestFilter: 'all', viewGeneration: 1,
    disposed: false, session: { connectionEpoch: 1, beginReadHandoff: () => ({ dispose() {} }) },
    context: { globalState: { update: async () => undefined } },
    workflowKit: { snapshot: source, setSource: async (value: string) => { source.source = value; } },
    post: (message: unknown) => { messages.push(message); }, sendSnapshot: () => undefined,
    cancelPageReads: () => undefined, syncBmadVisibility: () => undefined, hideIssueGraph: () => undefined,
    refresh: async () => undefined, refreshWorkflowKitInstallState: async () => undefined,
    connectedScopeKey: () => 'group-a', changeMergeRequestFilter: (value: string) => { host.mergeRequestFilter = value; }
  });
  return { host, messages };
}

test('the Host acknowledges a choice before its data refresh and does not roll it back on refresh failure', async () => {
  const { host, messages } = fixture(), gate = deferred();
  host.refresh = async () => { await gate.promise; throw new Error('offline'); };
  const request = { type: 'setMode', mode: 'sa', uiIntentId: id(1), hostNavigationGeneration: 0 };
  const pending = host.dispatchMessage(request);
  await tick();
  assert.equal(host.activeMode, 'sa');
  assert.deepEqual(messages.find(message => message.type === 'uiIntentResult'), {
    type: 'uiIntentResult', uiIntentId: id(1), field: 'mode', applied: true, value: 'sa', hostNavigationGeneration: 0, error: undefined
  });
  gate.resolve(); await assert.rejects(pending, /offline/);
  assert.equal(host.activeMode, 'sa');
  assert.equal(messages.filter(message => message.type === 'uiIntentResult').length, 1);
});

test('no-op choices acknowledge, rejected choices report the actual value', async () => {
  const { host, messages } = fixture();
  await host.dispatchMessage({ type: 'setProjectSource', source: 'gitlab', uiIntentId: id(1), hostNavigationGeneration: 0 });
  assert.equal(messages.at(-1).applied, true);
  host.context.globalState.update = async () => { throw new Error('cannot save'); };
  await assert.rejects(host.dispatchMessage({ type: 'setMode', mode: 'sa', uiIntentId: id(2), hostNavigationGeneration: 0 }), /cannot save/);
  assert.equal(host.activeMode, 'dashboard');
  assert.equal(messages.at(-1).applied, false); assert.equal(messages.at(-1).value, 'dashboard');
});

test('queued choices from a retired view or account cannot commit', async () => {
  for (const invalidate of [(host: any) => { host.viewGeneration++; }, (host: any) => { host.session.connectionEpoch++; }]) {
    const { host, messages } = fixture();
    const gate = deferred();
    let saved = 'dashboard';
    host.context.globalState.update = async (_key: string, value: string) => { await gate.promise; saved = value; };
    const pending = host.dispatchMessage({ type: 'setMode', mode: 'sa', uiIntentId: id(1), hostNavigationGeneration: 0 });
    await tick(); invalidate(host); gate.resolve(); await pending;
    assert.equal(host.activeMode, 'dashboard'); assert.equal(saved, 'dashboard'); assert.equal(messages.at(-1).applied, false);
  }
});

test('legacy bundled mode choices cannot overwrite newer independent source or filter choices', async () => {
  const { host } = fixture(), gate = deferred();
  host.context.globalState.update = async () => gate.promise;
  const old = host.dispatchMessage({ type: 'setMode', mode: 'clone', projectSource: 'gitlab', mergeRequestFilter: 'all' });
  await tick();
  await host.dispatchMessage({ type: 'setProjectSource', source: 'local', uiIntentId: id(2) });
  await host.dispatchMessage({ type: 'setMergeRequestFilter', filter: 'reviewer', connectedScope: 'group-a', uiIntentId: id(3) });
  gate.resolve(); await old;
  assert.equal(host.activeMode, 'clone'); assert.equal(host.projectSource, 'local'); assert.equal(host.mergeRequestFilter, 'reviewer');
});

test('an invalidated WorkflowKit source write restores persisted and visible source before publishing', async () => {
  let source = 'github', current = true;
  const gate = deferred(), writes: string[] = [], observed: string[] = [];
  const service = new WorkflowKitService({
    storagePath: process.cwd(), extensionDirectory: process.cwd(), extensionVersion: 'test',
    readSource: () => source, writeSource: async value => { writes.push(value); source = value; if (value === 'gitea') await gate.promise; },
    pythonPath: () => process.execPath, reportPhase: () => undefined, runWithInstallProgress: (_version, task) => task()
  });
  service.subscribe(() => observed.push(service.snapshot.source));
  const pending = service.setSource('gitea', () => current);
  assert.equal(service.snapshot.source, 'github', 'pending persistence is not an authoritative selection');
  current = false; gate.resolve(); await pending;
  assert.deepEqual(writes, ['gitea', 'github']); assert.equal(source, 'github');
  assert.equal(service.snapshot.source, 'github'); assert.deepEqual(observed, ['github']);
  service.dispose();
});
