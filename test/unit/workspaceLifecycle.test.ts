import assert from 'node:assert/strict';
import test from 'node:test';
import { GitLabClient } from '../../src/api/gitLabClient';
import { GitLabReadCache } from '../../src/api/gitLabReadCache';
import type { GitLabMergeRequest } from '../../src/api/types';

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
    groups: [], projects: [], issues: [], mergeRequests: [], groupIssueBoards: [], groupMilestones: [], projectSource: 'gitlab', developerView: 'list',
    webviewMessagesSent: 0, webviewMessagesReceived: 0,
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
  assert.equal(host.webviewReady, false); assert.equal(host.gitPanelReady, false);
  assert.equal(host.workspaceSections.mergeRequests.status, 'idle');
  assert.equal(host.selectedMergeRequest.sections.diffs.status, 'idle');
  assert.deepEqual(host.selectedMergeRequest.diffs, ['cached']);
  assert.equal(host.timer, timer); assert.equal(timer.phase, 'running'); assert.equal(host.issueSuspended, true);
  host.post({ type: 'message', message: 'Write completed' });
  assert.equal(messages.length, 0); assert.equal(host.pendingViewNotices.length, 0);
  assert.equal(host.notifications.snapshot().items[0].messages[0], 'Write completed');
});

test('MR invalidation marks visible and hidden lists stale without sending requests', async () => {
  const { host } = fixture();
  let requests = 0;
  host.session.cachedRead = async () => { requests++; throw new Error('Invalidation must not load data'); };
  const rows = [{ title: 'Cached' }]; host.mergeRequests = rows;
  host.workspaceSections = { mergeRequests: { status: 'ready' }, boards: { status: 'ready' } };
  host.connectedScopeKey = () => 'scope';
  host.invalidateWorkspaceReads({ groupIds: [42], projectId: 101, resource: 'mergeRequests' });
  for (let i = 0; i < 10; i++) await Promise.resolve();
  assert.equal(host.workspaceSections.mergeRequests.status, 'idle');
  assert.equal(host.mergeRequests, rows); assert.equal(host.workspaceSections.boards.status, 'ready');
  host.panel.visible = false;
  host.invalidateWorkspaceReads({ groupIds: [42], projectId: 101, resource: 'mergeRequests' });
  assert.equal(host.workspaceSections.mergeRequests.status, 'idle');
  assert.equal(requests, 0);
});

test('hiding a background refresh keeps data and permits revalidation after restore', async () => {
  const { host } = fixture();
  const rows = [{ title: 'Cached' }]; host.mergeRequests = rows;
  host.workspaceSections.mergeRequests = { status: 'ready', updatedAt: Date.now() - 61_000, refreshing: true };
  host.panel.visible = false; host.suspendViewReads();
  assert.equal(host.mergeRequests, rows);
  assert.equal(host.workspaceSections.mergeRequests.status, 'ready');
  assert.equal(host.workspaceSections.mergeRequests.refreshing, false);
  host.panel.visible = true; host.webviewReady = true;
  await host.loadWorkspaceSection('mergeRequests');
  assert.equal(host.mergeRequests[0].title, 'Updated');
});

test('manual Workspace refresh reloads a ready empty MR list through the read cache', async () => {
  const { host } = fixture();
  const user = { id: 7, name: 'Me', username: 'me' };
  const group = { id: 42, name: 'Team', full_path: 'team', web_url: '' };
  const cache = new GitLabReadCache();
  let remoteRows: GitLabMergeRequest[] = [];
  let mrReads = 0;
  const client = new GitLabClient('https://gitlab.test', 'test-only-token', async input => {
    const pathname = new URL(String(input)).pathname;
    let body: unknown;
    if (pathname === '/api/v4/user') body = user;
    else if (pathname === '/api/v4/groups') body = [group];
    else if (pathname === '/api/v4/groups/42/projects') body = [];
    else if (pathname === '/api/v4/groups/42/merge_requests') { mrReads++; body = remoteRows; }
    else throw new Error(`Unexpected request: ${pathname}`);
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  });
  Object.assign(host, {
    currentUser: user, loadedScopeKey: 'https://gitlab.test|7|42',
    workspaceFoldersGeneration: 0, skillsEnvironmentGeneration: 0,
    projects: [], issues: [], mergeRequests: [], groupIssueBoards: [],
    context: { globalState: { get: () => undefined } }, timer: { setScope: async () => undefined },
    syncTimerPolling: () => undefined, schedulePendingWorkspaceRefresh: () => undefined,
    refreshWorkflowKit: async () => undefined, refreshProjectRoot: async () => undefined,
    resolveWorkspaceRoot: async () => ({ match: { status: 'unverified', repositories: [] } }),
    repositoryStateKey: () => undefined,
    session: {
      baseUrl: 'https://gitlab.test', selectedGroup: group,
      ensureMetadataChecked: async () => undefined, updateCurrentUser: async () => undefined,
      cachedRead: (key: string, load: (readClient: GitLabClient) => Promise<unknown>, options: { force?: boolean; signal?: AbortSignal }) =>
        cache.get(key, signal => load(client.withReadSignal(signal)), options)
    }
  });
  const sectionTasks: Promise<unknown>[] = [];
  const loadSection = host.loadWorkspaceSection.bind(host);
  host.loadWorkspaceSection = (...args: unknown[]) => {
    const task = loadSection(...args); sectionTasks.push(task); return task;
  };
  await host.loadWorkspaceSection('mergeRequests');
  assert.equal(host.workspaceSections.mergeRequests.status, 'ready');
  assert.deepEqual(host.mergeRequests, []);
  assert.equal(mrReads, 1);

  remoteRows = [{ id: 11, project_id: 101, iid: 1, state: 'opened', title: 'New MR',
    web_url: 'https://gitlab.test/team/project/-/merge_requests/1', source_branch: 'feature', target_branch: 'main' }];
  await host.refresh();
  await Promise.all(sectionTasks.splice(0));
  assert.equal(mrReads, 1, 'a fresh page entry reuses the current list');
  assert.deepEqual(host.mergeRequests, [], 'the cached empty list remains valid until refresh');
  await host.dispatchMessage({ type: 'refresh' });
  await Promise.all(sectionTasks.splice(0));
  assert.equal(mrReads, 2, 'manual refresh sends another MR request despite the cached result');
  assert.equal(host.workspaceSections.mergeRequests.status, 'ready');
  assert.deepEqual(host.mergeRequests, remoteRows);
});

test('cancelled MR reads cannot publish after an account or Group switch', async t => {
  for (const scope of ['account', 'group']) await t.test(scope, async () => {
    const { host } = fixture();
    let finish!: (rows: unknown[]) => void;
    let signal!: AbortSignal;
    host.mergeRequests = [];
    host.session.cachedRead = (_key: string, _load: unknown, options: { signal: AbortSignal }) => {
      signal = options.signal;
      return new Promise(resolve => { finish = resolve; });
    };
    const read = host.loadWorkspaceSection('mergeRequests');
    if (scope === 'account') host.currentUser = { id: 8 };
    else host.session.selectedGroup = { id: 43 };
    host.resetWorkspaceSections();
    assert.equal(signal.aborted, true);
    finish([{ project_id: 101, iid: 1, title: 'Previous scope' }]);
    await read;
    assert.deepEqual(host.mergeRequests, []);
    assert.equal(host.workspaceSections.mergeRequests, undefined);
  });
});

test('a restored view keeps notification history and delivers protocol receipts without replaying notices', async () => {
  const { host, messages } = fixture();
  host.restoredOnce = true; host.loadedScopeKey = 'https://gitlab.test|7|42';
  host.workspaceSections = { projects: { status: 'ready' }, issues: { status: 'ready' } };
  host.post({ type: 'message', message: 'Completed while hidden' });
  host.pendingViewNotices.push({ type: 'issueResponse', revision: 1, response: { type: 'reply', requestId: 'copy-one', result: true } });
  let entryRefreshes = 0;
  host.refresh = async () => { entryRefreshes++; };
  host.refreshInventory = () => { throw new Error('Unexpected inventory scan'); };
  host.loadActiveModeSections = () => undefined;
  await host.dispatchMessage({ type: 'ready' });
  assert.equal(entryRefreshes, 1, 'restoring the page performs one current-page refresh');
  assert.equal(host.snapshots, 1); assert.equal(host.pendingViewNotices.length, 0);
  assert.equal(messages.some(message => message.type === 'message'), false);
  assert.equal(host.notifications.snapshot().items.length, 1);
  assert.ok(messages.some(message => message.type === 'issueResponse' && message.response.requestId === 'copy-one'));
});

test('graph requests force network reads only when explicitly requested', async () => {
  const { host } = fixture();
  const calls: Array<{ scope: string; force: boolean }> = [];
  host.loadIssueGraph = async (scope: string, force: boolean) => { calls.push({ scope, force }); };
  await host.dispatchMessage({ type: 'loadIssueGraph', connectedScope: 'scope' });
  await host.dispatchMessage({ type: 'loadIssueGraph', connectedScope: 'scope', forceNetwork: true });
  await host.dispatchMessage({ type: 'loadIssueGraph', connectedScope: 'scope', forceNetwork: 'true' });
  assert.deepEqual(calls, [{ scope: 'scope', force: false }, { scope: 'scope', force: true }, { scope: 'scope', force: false }]);
});

test('notification protocol changes shared session state without operations, and replayed replies cannot restore cleared notices', async () => {
  const { host, messages } = fixture();
  host.panel.visible = false; host.webviewReady = false;
  host.post({ type: 'issueResponse', revision: 1, response: { type: 'reply', requestId: 'copy-failed', error: 'Clipboard failed', notificationOnly: true } });
  assert.equal(host.pendingViewNotices.length, 1); assert.equal(host.notifications.snapshot().items.length, 1);
  const before = host.notifications.snapshot();
  await host.handleMessage({ type: 'markAllNotificationsRead', revision: before.revision });
  assert.equal(host.notifications.snapshot().unreadCount, 0); assert.equal(host.operations.list().length, 0);
  await host.handleMessage({ type: 'clearNotifications', revision: host.notifications.snapshot().revision });
  assert.equal(host.notifications.snapshot().items.length, 0);
  host.panel.visible = true; host.webviewReady = true;
  for (const notice of host.pendingViewNotices.splice(0)) host.sendViewMessage(notice);
  assert.equal(host.notifications.snapshot().items.length, 0);
  assert.equal(messages.at(-1).response.requestId, 'copy-failed');
  await host.handleMessage({ type: 'publishNotification', message: 'Local draft recovered', level: 'info' });
  const item = host.notifications.snapshot().items[0];
  assert.equal(item.origin.groupId, 42);
  await host.handleMessage({ type: 'removeNotification', id: item.id });
  assert.equal(host.notifications.snapshot().items.length, 0); assert.equal(host.operations.list().length, 0);
});

test('operation notifications retain their origin after an account or Group transition', async () => {
  const { host } = fixture();
  host.session.activeAccountId = 'old-account'; host.projectContext = { root: 'C:/old' };
  let resume!: () => void;
  host.dispatchMessage = async () => {
    await new Promise<void>(resolve => { resume = resolve; });
    host.post({ type: 'message', message: 'Previous operation finished' });
  };
  const action = host.handleMessage({ type: 'copy', text: 'text', operationId: 'old-operation' });
  host.session.activeAccountId = 'new-account'; host.session.selectedGroup = { id: 43 }; host.projectContext = { root: 'C:/new' };
  resume(); await action;
  const item = host.notifications.snapshot().items[0];
  assert.equal(item.origin.accountId, 'old-account'); assert.equal(item.origin.groupId, 42); assert.equal(item.origin.root, 'C:/old');
  assert.equal(item.messages.length, 1); assert.equal(item.messages[0], 'Previous operation finished');
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
