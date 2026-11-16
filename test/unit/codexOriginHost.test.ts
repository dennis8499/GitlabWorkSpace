import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createTaskWorkspace, readTaskWorkspace } from '../../src/codex/taskWorkspace';
import type { CodexTaskSpec } from '../../src/codex/protocol';

const loader = require('node:module'), original = loader._load;
const opened: string[] = [];
const uri = (fsPath: string) => ({ fsPath, toString: () => fsPath });
const vscodeApi = { workspace: { isTrusted: true, workspaceFolders: [] as Array<{ uri: ReturnType<typeof uri> }>,
  workspaceFile: undefined as ReturnType<typeof uri> | undefined },
  window: { showQuickPick: async (items: unknown[]) => items[0] }, Uri: { file: uri },
  commands: { executeCommand: async (name: string, target?: ReturnType<typeof uri>) => { if (name === 'vscode.openFolder' && target) opened.push(target.fsPath); } } };
loader._load = (name: string, ...args: unknown[]) => name === 'vscode' ? vscodeApi : original(name, ...args);
let WorkspacePanel: any;
try { ({ WorkspacePanel } = require('../../src/workspace/workspacePanel')); } finally { loader._load = original; }

async function fixture(t: test.TestContext) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'glw-origin-host-'))), storage = path.join(root, 'storage');
  await mkdir(storage); opened.length = 0; vscodeApi.workspace.workspaceFile = undefined; vscodeApi.workspace.workspaceFolders = [];
  t.after(() => rm(root, { recursive: true, force: true }));
  const spec: CodexTaskSpec = { source: { kind: 'free', repository: root, prompt: 'Inspect this repository' }, root,
    executionRoot: root, title: 'Origin task', prompt: 'Inspect this repository', writableRoots: [root], workspaceKey: root, environmentKey: 'fixture' };
  const tasks: any[] = [], calls: string[] = [], messages: any[] = [], queued: Array<{ spec: CodexTaskSpec; id: string }> = [];
  const history = new Map<string, 'pending' | 'deleted'>();
  const bridge = { list: () => tasks, historyDeletion: (id: string) => history.get(id), initialize: async () => { calls.push('initialize'); }, publish: async () => { calls.push('publish'); },
    claimTaskWorkspace: async (binding: { taskId: string; workspaceFile: string }) => {
      calls.push('claim:' + binding.taskId); return readTaskWorkspace(storage, binding.workspaceFile);
    },
    enqueue: async (value: CodexTaskSpec, id: string) => { calls.push('enqueue:' + id); queued.push({ spec: value, id }); tasks.push({ id, root: value.root, status: 'queued' }); return id; },
    pause: async (id: string) => { calls.push('pause:' + id); } };
  const groups = [{ id: 1, full_path: 'team/first', name: 'First' }, { id: 2, full_path: 'team/second', name: 'Second' }];
  const panel = Object.create(WorkspacePanel.prototype);
  panel.context = { globalStorageUri: { fsPath: storage } }; panel.projectContext = { root };
  panel.session = { activeAccountId: 'account-a', baseUrl: 'https://gitlab.test', connectionEpoch: 1, selectedGroup: groups[0],
    accounts: [{ id: 'account-a' }, { id: 'account-b' }],
    switchAccount: async (id: string) => { calls.push('switch:' + id); panel.session.activeAccountId = id; return { id: 5 }; },
    cachedRead: async () => { calls.push('read-groups'); return groups; },
    setSelectedGroup: async (group: typeof groups[number]) => { calls.push('group:' + group.id); panel.session.selectedGroup = group; } };
  panel.currentUser = { id: 5 }; panel.codex = bridge; panel.getCodexBridge = () => bridge;
  panel.resolveProjectContext = async () => ({ root }); panel.show = async () => { calls.push('show'); };
  panel.sendSnapshot = () => {}; panel.post = (message: unknown) => messages.push(message); panel.syncSidebarState = async () => {};
  panel.workflowKit = { initializeCleanup: async () => { calls.push('kit-cleanup'); } };
  panel.mrWritesInFlight = new Map(); panel.issueRelationWritesInFlight = new Map(); panel.timer = { list: () => [] };
  panel.connectedUserChanged = async () => { calls.push('connected-user'); };
  panel.issuePanels = { close: () => {} }; panel.cancelMergeRequestSectionReads = () => {};
  panel.clearRemoteGroupData = () => {}; panel.noteOutcome = () => {}; panel.isRemotePage = () => false;
  panel.reconcileAfterWrite = async (action: () => Promise<void>) => action();
  panel.issueOpenGeneration = 0; panel.previewGeneration = 0;
  Object.defineProperty(panel, 'notifications', { value: { publish: (message: unknown) => messages.push(message) }, configurable: true });
  return { root, storage, spec, tasks, calls, messages, queued, panel, bridge, history };
}

test('origin start claims and enqueues in the current Group without opening another VS Code window', async t => {
  const f = await fixture(t);
  assert.equal(await f.panel.openIsolatedCodexWorkspace(f.spec, 'origin-start'), 'origin-start');
  assert.deepEqual(f.calls, ['initialize', 'claim:origin-start', 'enqueue:origin-start']);
  assert.deepEqual(opened, []); assert.equal(f.queued.length, 1);
  const binding = f.queued[0].spec.taskWorkspace!;
  assert.equal(binding.originRoot, f.root); assert.equal(binding.taskId, 'origin-start');
  assert.equal((await readTaskWorkspace(f.storage, binding.workspaceFile)).windowMode, 'origin');
  await f.panel.openIsolatedCodexWorkspace(f.spec, 'origin-start');
  assert.equal(f.queued.length, 1, 'replaying a launch cannot enqueue it twice');
});

test('activation recovers only matching origin claims without replaying queued tasks', async t => {
  const f = await fixture(t);
  for (const entry of [
    { id: 'matching', mode: 'origin', account: 'account-a' },
    { id: 'live-owner', mode: 'origin', account: 'account-a' },
    { id: 'legacy', mode: 'task', account: 'account-a' },
    { id: 'other-account', mode: 'origin', account: 'account-b' }
  ] as const) {
    await createTaskWorkspace(f.storage, { source: f.spec.source, originRoot: f.root, preparedSpec: f.spec, accountId: entry.account, windowMode: entry.mode }, entry.id);
    f.tasks.push({ id: entry.id, root: f.root, status: 'queued', controls: { external: true } });
  }
  f.tasks.push({ id: 'other-root', root: path.join(f.root, 'other'), status: 'paused' },
    { id: 'retained-result', root: f.root, retention: 'results-only' });
  const claim = f.bridge.claimTaskWorkspace;
  f.bridge.claimTaskWorkspace = async binding => {
    if (binding.taskId === 'live-owner') { f.calls.push('claim:live-owner'); throw new Error('Existing owner is alive'); }
    return claim(binding);
  };
  await f.panel.initializeStorageCleanup();
  assert.deepEqual(f.calls, ['publish', 'claim:matching', 'claim:live-owner', 'kit-cleanup']);
  assert.equal(f.queued.length, 0); assert.deepEqual(opened, []);
});

test('opening an origin task viewport observes its state without claiming ownership or replaying work', async t => {
  const f = await fixture(t), launch = await createTaskWorkspace(f.storage,
    { source: f.spec.source, originRoot: f.root, preparedSpec: f.spec, windowMode: 'origin' }, 'origin-observer');
  f.tasks.push({ id: 'origin-observer', root: f.root, status: 'paused', controls: { external: true } });
  await f.panel.openTaskWorkspace(launch);
  assert.deepEqual(f.calls, ['publish', 'show']); assert.equal(f.queued.length, 0); assert.deepEqual(opened, []);
  assert.equal(f.panel.managedTaskFocus.taskId, 'origin-observer');
  assert.equal(f.tasks[0].controls.external, true);
});

test('deleted and pending origin task envelopes cannot claim ownership or replay work', async t => {
  for (const state of ['pending', 'deleted'] as const) await t.test(state, async t => {
    const f = await fixture(t), id = 'old-envelope-' + state;
    const launch = await createTaskWorkspace(f.storage, { source: f.spec.source, originRoot: f.root, preparedSpec: f.spec, windowMode: 'origin' }, id);
    f.history.set(id, state);
    await assert.rejects(f.panel.openTaskWorkspace(launch), /紀錄已刪除或正在刪除/);
    assert.deepEqual(f.calls, ['publish']); assert.deepEqual(f.queued, []); assert.deepEqual(opened, []);
    assert.equal(f.panel.managedTaskFocus, undefined);
  });
});

test('startup maintenance in an origin viewport never recovers its former owner before readonly activation', async t => {
  const f = await fixture(t), launch = await createTaskWorkspace(f.storage,
    { source: f.spec.source, originRoot: f.root, preparedSpec: f.spec, windowMode: 'origin' }, 'viewport-startup');
  vscodeApi.workspace.workspaceFile = uri(launch.binding.workspaceFile);
  vscodeApi.workspace.workspaceFolders = [{ uri: uri(path.join(launch.binding.directory, 'workspace')) }, { uri: uri(f.root) }];
  f.tasks.push({ id: 'viewport-startup', root: f.root, status: 'paused', controls: { external: true } });
  await f.panel.initializeStorageCleanup();
  await f.panel.openTaskWorkspace(launch);
  assert.equal(f.calls.some(call => call.startsWith('claim:')), false);
  assert.equal(f.queued.length, 0); assert.equal(f.tasks[0].controls.external, true);
  assert.deepEqual(f.calls, ['publish', 'kit-cleanup', 'publish', 'show']);
});

test('native account and Group commands reject owned queued running and delivering tasks before changing scope', async t => {
  for (const entry of [
    { id: 'queued', status: 'queued' }, { id: 'running', status: 'running' },
    { id: 'delivering', status: 'completed', delivery: { state: 'running' } }
  ]) await t.test(entry.id, async t => {
    const f = await fixture(t); f.tasks.push({ ...entry, root: f.root, controls: { external: false } });
    await assert.rejects(f.panel.accountFromSidebar('switchAccount', 'account-b'), /Codex.*暫停/);
    await assert.rejects(f.panel.selectGroupFromSidebar({ id: 2 }), /Codex.*暫停/);
    assert.deepEqual(f.calls, []); assert.equal(f.panel.session.activeAccountId, 'account-a'); assert.equal(f.panel.session.selectedGroup.id, 1);
  });
});

test('paused tasks and external observers allow native account and Group navigation', async t => {
  for (const entry of [
    { id: 'paused', status: 'paused', controls: { external: false } },
    { id: 'observer', status: 'running', controls: { external: true }, delivery: { state: 'running' } }
  ]) await t.test(entry.id, async t => {
    const f = await fixture(t); f.tasks.push({ ...entry, root: f.root });
    await f.panel.accountFromSidebar('switchAccount', 'account-b');
    await f.panel.selectGroupFromSidebar({ id: 2 });
    assert.equal(f.panel.session.activeAccountId, 'account-b'); assert.equal(f.panel.session.selectedGroup.id, 2);
    assert.deepEqual(f.calls, ['switch:account-b', 'connected-user', 'read-groups', 'group:2']);
  });
});

test('root drift pauses owned active tasks while leaving paused and external tasks untouched', async t => {
  const f = await fixture(t);
  f.tasks.push(...[
    { id: 'queued', status: 'queued' }, { id: 'running', status: 'running' }, { id: 'waiting', status: 'waiting' },
    { id: 'paused', status: 'paused' }, { id: 'observer', status: 'running', controls: { external: true } }
  ]);
  await f.panel.pauseCodexForEnvironmentDrift();
  assert.deepEqual(f.calls, ['pause:queued', 'pause:running', 'pause:waiting']);
  assert.equal(f.messages.length, 1); assert.match(f.messages[0].message, /核對停止結果/);
});
