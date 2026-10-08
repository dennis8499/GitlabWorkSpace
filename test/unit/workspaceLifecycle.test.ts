import assert from 'node:assert/strict';
import test from 'node:test';

function fixture() {
  const moduleLoader = require('node:module') as { _load: (name: string, parent: unknown, main: boolean) => unknown };
  const original = moduleLoader._load;
  moduleLoader._load = (name, parent, main) => name === 'vscode' ? {} : original(name, parent, main);
  let WorkspacePanel: typeof import('../../src/workspace/workspacePanel').WorkspacePanel;
  try { ({ WorkspacePanel } = require('../../src/workspace/workspacePanel')); }
  finally { moduleLoader._load = original; }
  const messages: any[] = [];
  const controller = () => new AbortController();
  const host: any = Object.create(WorkspacePanel!.prototype);
  Object.assign(host, {
    disposed: false, panel: { visible: true, webview: { postMessage: (message: unknown) => { messages.push(message); return Promise.resolve(true); } } },
    webviewReady: true, gitPanelReady: true, activeMode: 'reviewer', viewGeneration: 0, viewReadAbort: new AbortController(), requestGeneration: 0,
    inventoryGeneration: 0, previewGeneration: 0, issueOpenGeneration: 0, issueBoardGeneration: 0, mergeRequestGeneration: 0,
    issueGraphGeneration: 0, localRepositoryScanGeneration: 0, actualRepositoryScanGeneration: 0,
    workspaceSectionGenerations: new Map(), workspaceSectionAborts: new Map(), mergeRequestSectionAborts: {},
    mergeRequestSectionGenerations: { diffs: 0, discussions: 0 }, workspaceSections: {}, gitWriteReceipts: new Map(), pendingViewNotices: [],
    webviewMessagesSent: 0, webviewMessagesReceived: 0, logsVisible: true,
    refreshAbort: controller(), repositoryScanAbort: controller(), previewAbort: controller(), issueOpenAbort: controller(),
    issueBoardAbort: controller(), mergeRequestAbort: controller(), issueGraphAbort: controller(),
    session: { baseUrl: 'https://gitlab.test', selectedGroup: { id: 42 }, cachedRead: async (_key: string, load: any) => load({ listGroupMergeRequests: async () => [{ title: 'Updated' }] }) },
    currentUser: { id: 7 }, context: { globalState: { update: async () => undefined } },
    issuePanels: { suspendReads: () => { host.issueSuspended = true; } }, issueNavigation: null,
    gitRepositories: { setActivePanelRepository: () => undefined },
    sendSnapshot: () => { host.snapshots = (host.snapshots ?? 0) + 1; }
  });
  return { host, messages };
}

test('hidden panels abort reads, stop notifications and retain MR data and timer state', () => {
  const { host, messages } = fixture();
  const section = new AbortController(); host.workspaceSectionAborts.set('mergeRequests', section);
  host.workspaceSections.mergeRequests = { status: 'loading' };
  host.selectedMergeRequest = { request: { iid: 1 }, diffs: ['cached'], sections: { diffs: { status: 'loading' }, discussions: { status: 'ready' } } };
  const timer = { phase: 'running' }; host.timer = timer;
  const controllers = [section, host.refreshAbort, host.repositoryScanAbort, host.issueOpenAbort, host.issueGraphAbort];
  host.panel.visible = false; host.suspendViewReads();
  for (const controller of controllers) assert.equal(controller.signal.aborted, true);
  assert.equal(host.webviewReady, false); assert.equal(host.gitPanelReady, false); assert.equal(host.logsVisible, false);
  assert.equal(host.workspaceSections.mergeRequests.status, 'idle');
  assert.equal(host.selectedMergeRequest.sections.diffs.status, 'idle');
  assert.deepEqual(host.selectedMergeRequest.diffs, ['cached']);
  assert.equal(host.timer, timer); assert.equal(timer.phase, 'running'); assert.equal(host.issueSuspended, true);
  host.post({ type: 'message', message: 'Write completed' });
  assert.equal(messages.length, 0); assert.equal(host.pendingViewNotices.length, 1);
});

test('MR invalidation reloads a visible review list and leaves hidden sections lazy', async () => {
  const { host } = fixture();
  host.workspaceSections = { mergeRequests: { status: 'ready' }, boards: { status: 'ready' } };
  host.connectedScopeKey = () => 'scope';
  host.invalidateWorkspaceReads({ groupIds: [42], projectId: 101, resource: 'mergeRequests' });
  for (let i = 0; i < 10; i++) await Promise.resolve();
  assert.equal(host.workspaceSections.mergeRequests.status, 'ready');
  assert.equal(host.mergeRequests[0].title, 'Updated'); assert.equal(host.workspaceSections.boards.status, 'ready');
  host.panel.visible = false;
  host.invalidateWorkspaceReads({ groupIds: [42], projectId: 101, resource: 'mergeRequests' });
  assert.equal(host.workspaceSections.mergeRequests.status, 'idle');
});

test('a restored view uses the Host snapshot and delivers pending notices without a new scan', async () => {
  const { host, messages } = fixture();
  host.restoredOnce = true; host.loadedScopeKey = 'https://gitlab.test|7|42';
  host.workspaceSections = { projects: { status: 'ready' }, issues: { status: 'ready' } };
  host.pendingViewNotices.push({ type: 'message', message: 'Completed while hidden' });
  host.refresh = () => { throw new Error('Unexpected refresh'); };
  host.refreshInventory = () => { throw new Error('Unexpected inventory scan'); };
  host.loadActiveModeSections = () => undefined;
  await host.dispatchMessage({ type: 'ready' });
  assert.equal(host.snapshots, 1); assert.equal(host.pendingViewNotices.length, 0);
  assert.ok(messages.some(message => message.type === 'message' && message.message === 'Completed while hidden'));
});

test('an authorized Git write finishes once while hidden and its receipt survives until acknowledged', async () => {
  const { host, messages } = fixture(); host.activeMode = 'git'; host.selectedGitRepositoryId = 'repo';
  let finish!: (value: unknown) => void; let writes = 0;
  host.gitRepositories.handleAction = () => { writes++; return new Promise(resolve => { finish = resolve; }); };
  host.gitRepositories.getSummaryState = async () => ({ repositories: [], available: true, revision: 1 });
  const operation = host.handleGitPanelRequest({ type: 'gitAction', repoId: 'repo', requestId: 'write-1', action: { type: 'commit', message: 'Draft' } });
  host.panel.visible = false; host.suspendViewReads();
  finish({ id: 'repo', commitCompleted: true }); await operation;
  assert.equal(writes, 1); assert.equal(messages.length, 0);
  assert.equal(host.gitWriteReceipts.get('write-1').commitCompleted, true);
  host.panel.visible = true; host.webviewReady = true;
  await host.handleGitPanelRequest({ type: 'gitReady' });
  assert.ok(messages.some(message => message.type === 'gitActionResult' && message.requestId === 'write-1'));
  await host.handleGitPanelRequest({ type: 'gitAcknowledgeResult', requestId: 'write-1' });
  assert.equal(host.gitWriteReceipts.size, 0); assert.equal(writes, 1);
});
