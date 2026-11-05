import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import { GitLabSession } from '../../src/connection/session';
import { accountTokenKey } from '../../src/connection/accountStore';
import type { IssueNavigation } from '../../src/workspace/workspaceProtocol';

const loader = require('node:module') as { _load: (name: string, parent: unknown, main: boolean) => unknown };
const original = loader._load;
const vscode = {
  Uri: { joinPath: (base: { fsPath: string }, ...parts: string[]) => ({ fsPath: path.join(base.fsPath, ...parts) }) },
  ViewColumn: { Active: 1 },
  commands: { executeCommand: async (..._args: unknown[]) => undefined },
  window: { showInputBox: async (_options: unknown): Promise<string | undefined> => undefined,
    showQuickPick: async (_items: any[], _options?: unknown): Promise<any> => undefined,
    showInformationMessage: async (_message: string, ..._actions: string[]): Promise<string | undefined> => undefined,
    createWebviewPanel: (..._args: unknown[]): any => { throw new Error('Unexpected panel creation'); } }
};
loader._load = (name, parent, main) => name === 'vscode' ? vscode : original(name, parent, main);
let WorkspacePanel: typeof import('../../src/workspace/workspacePanel').WorkspacePanel;
try { ({ WorkspacePanel } = require('../../src/workspace/workspacePanel')); }
finally { loader._load = original; }

function memory() {
  const values = new Map<string, any>();
  return { values, get: (key: string, fallback?: unknown) => values.has(key) ? values.get(key) : fallback,
    keys: () => [...values.keys()], update: async (key: string, value: unknown) => { values.set(key, value); } };
}

function fixture() {
  const globalState = memory(), workspaceState = memory();
  const secrets = { values: new Map<string, string>(), get: async (key: string) => secrets.values.get(key),
    store: async (key: string, value: string) => { secrets.values.set(key, value); }, delete: async (key: string) => { secrets.values.delete(key); } };
  const logMetadata: unknown[] = [], registeredSecrets: string[] = [];
  const log: any = { addSecret: (secret: string) => registeredSecrets.push(secret), wrapFetch: (fetcher: unknown) => fetcher,
    run: async (feature: string, action: string, context: unknown, task: () => Promise<unknown>) => {
      logMetadata.push({ feature, action, context }); return task();
    } };
  const session = new GitLabSession(secrets as any, globalState as any, true, workspaceState as any, log);
  session.ensureMetadataChecked = async () => undefined;
  let probes = 0;
  session.setFetchForTesting(async (_url, init) => {
    probes++;
    const token = new Headers(init?.headers).get('PRIVATE-TOKEN');
    if (token === 'invalid') return new Response('{}', { status: 401 });
    if (token === 'forbidden') return new Response('{}', { status: 403 });
    if (token === 'network') throw new TypeError('fetch failed');
    const id = token?.startsWith('two') ? 2 : 1;
    return new Response(JSON.stringify({ id, username: `user-${id}`, name: `User ${id}` }), { headers: { 'Content-Type': 'application/json' } });
  });
  const messages: any[] = [], snapshots: unknown[] = [], intents: unknown[] = [];
  const host: any = Object.assign(Object.create(WorkspacePanel!.prototype), {
    session, disposed: false, viewGeneration: 0, accountTransitionBusy: false, accountLoginReceipts: new Map(),
    webviewMessagesReceived: 0, webviewMessagesSent: 0, writesInFlight: 0, repositoryOperationInProgress: false,
    mrWritesInFlight: new Set(), issueRelationWritesInFlight: new Set(), timer: { list: () => [], setScope: async () => undefined }, activeMode: 'developer',
    context: { globalState, workspaceState }, post: (message: unknown) => messages.push(message),
    sendSnapshot: () => snapshots.push({ accountOperation: host.accountOperation, accounts: session.accounts }),
    connectedUserChanged: async (user: unknown) => { host.currentUser = user; },
    syncSidebarState: async () => undefined,
    show: async () => { host.webviewReady = true; },
    pendingViewNotices: [],
    workspaceSections: {}, workspaceSectionGenerations: new Map(), workspaceSectionAborts: new Map(),
    requestGeneration: 0, previewGeneration: 0, issueOpenGeneration: 0, workflowKitRefreshGeneration: 0,
    cancelMergeRequestSectionReads: () => undefined, issuePanels: { close: () => undefined }
  });
  return { host, session, secrets, globalState, messages, snapshots, logMetadata, registeredSecrets, intents, probes: () => probes };
}

function panelLifecycleFixture() {
  const value = fixture(), panels: any[] = [];
  vscode.window.createWebviewPanel = () => {
    let disposed!: () => void, changed!: () => void;
    const panel = {
      visible: true,
      webview: { html: '', cspSource: 'test:', asWebviewUri: () => ({ toString: () => 'https://fixture.test/assets' }),
        onDidReceiveMessage: () => ({ dispose() {} }) },
      onDidDispose: (listener: () => void) => { disposed = listener; },
      onDidChangeViewState: (listener: () => void) => { changed = listener; return { dispose() {} }; },
      reveal: () => { panel.visible = true; },
      dispose: () => disposed(),
      hide: () => { panel.visible = false; changed(); }
    };
    panels.push(panel);
    return panel;
  };
  Object.assign(value.host, {
    show: WorkspacePanel!.prototype.show,
    context: { ...value.host.context, extensionUri: { fsPath: path.resolve(__dirname, '../../..') } },
    viewReadAbort: new AbortController(), refresh: async () => undefined,
    suspendViewReads: () => { value.host.webviewReady = false; value.host.viewGeneration++; }
  });
  return { ...value, panels };
}

const login = (requestId: string, token = 'one-secret', accountId?: string) => ({ requestId, baseUrl: 'https://gitlab.test/', token, accountId });
const authenticate = (host: any, input: ReturnType<typeof login> & { operationId?: string }) =>
  host.runAction({ type: 'connect', requestId: input.requestId, operationId: input.operationId }, () => host.loginAccount(input));
const accountResult = (messages: any[], requestId: string) => {
  const result = [...messages].reverse().find(message => message.type === 'accountLoginResult' && message.requestId === requestId);
  assert.ok(result, `login ${requestId} has a domain result`);
  return result;
};

test('login uses the existing validated account store and replays receipts without authenticating twice', async () => {
  const { host, session, messages, secrets, globalState, snapshots, logMetadata, registeredSecrets, probes } = fixture();
  await authenticate(host, login('first'));
  assert.equal(session.accounts.length, 1);
  assert.equal(secrets.values.get(accountTokenKey(session.activeAccountId!)), 'one-secret');
  assert.equal(accountResult(messages, 'first').name, 'User 1');
  assert.equal(host.accountTransitionBusy, false);
  assert.ok(snapshots.some((value: any) => value.accountOperation === 'login'));
  assert.ok(registeredSecrets.includes('one-secret'));
  for (const value of [messages, snapshots, logMetadata, [...globalState.values], [...host.accountLoginReceipts.values()]]) assert.ok(!JSON.stringify(value).includes('one-secret'));
  await authenticate(host, login('first', 'two-secret'));
  assert.equal(probes(), 1);
  assert.equal(session.accounts.length, 1);
  assert.equal(accountResult(messages, 'first').name, 'User 1');
  assert.ok(messages.some(message => message.type === 'operationChanged' && message.operation.finishedAt !== undefined));
});

test('invalid credentials, a different identity and network failure keep the previous account and credentials', async () => {
  const { host, session, messages, secrets } = fixture();
  await authenticate(host, login('first'));
  const active = session.activeAccountId!;
  for (const [id, token, pattern] of [['invalid', 'invalid', /Token 無效/], ['forbidden', 'forbidden', /拒絕存取/], ['mismatch', 'two-secret', /身分.*不同/], ['network', 'network', /無法連線/]] as const) {
    await authenticate(host, login(id, token, active));
    assert.match(accountResult(messages, id).error, pattern);
    assert.equal(session.activeAccountId, active);
    assert.equal(secrets.values.get(accountTokenKey(active)), 'one-secret');
    assert.equal(host.accountTransitionBusy, false);
  }
});

test('malformed inputs and a changed relogin site never reach GitLab', async () => {
  const { host, session, messages, probes } = fixture();
  await authenticate(host, { ...login('url'), baseUrl: 'https://user:password@gitlab.test' });
  assert.match(accountResult(messages, 'url').error, /網址無效/);
  await authenticate(host, login('missing', ''));
  assert.match(accountResult(messages, 'missing').error, /有效/);
  assert.equal(probes(), 0);
  await authenticate(host, login('first'));
  await authenticate(host, { ...login('other', 'two-secret', session.activeAccountId), baseUrl: 'https://other.test' });
  assert.match(accountResult(messages, 'other').error, /原有.*站台/);
  assert.equal(probes(), 1);
});

test('a pending login deduplicates its request and blocks another login, switching and Group changes', async () => {
  const { host, session, messages } = fixture();
  let finish!: (response: Response) => void, start!: () => void, probes = 0;
  const started = new Promise<void>(resolve => { start = resolve; });
  session.setFetchForTesting(async () => { probes++; start(); return new Promise(resolve => { finish = resolve; }); });
  const pending = { ...login('pending'), operationId: 'pending-login' };
  const operation = authenticate(host, pending);
  await started;
  const duplicate = authenticate(host, pending);
  await authenticate(host, { ...login('other'), operationId: 'competing-login' });
  const rejected = [...messages].reverse().find(message => message.type === 'operationChanged' && message.operation.requestId === 'competing-login');
  assert.equal(rejected.operation.status, 'failed');
  assert.equal(rejected.operation.effect, 'none');
  assert.match(rejected.operation.error, /同一項資源/);
  assert.equal(messages.some(message => message.type === 'accountLoginResult' && message.requestId === 'other'), false, 'rejected work never enters the login handler');
  assert.equal(host.operations.get('pending-login').status, 'running');
  assert.equal(host.accountLoginRequestId, 'pending');
  assert.equal(probes, 1);
  assert.equal(host.accountTransitionBusy, true);
  await assert.rejects(host.switchAccount('any'), /正在切換/);
  await assert.rejects(host.selectGroup(), /正在驗證/);
  finish(new Response(JSON.stringify({ id: 1, name: 'User 1', username: 'one' })));
  await Promise.all([operation, duplicate]);
  assert.equal(probes, 1);
  assert.equal(host.accountTransitionBusy, false);
  assert.equal(accountResult(messages, 'pending').name, 'User 1');
  const completed = messages.filter(message => message.type === 'operationChanged' && message.operation.requestId === 'pending-login' && message.operation.finishedAt !== undefined);
  assert.equal(completed.length, 1); assert.equal(completed[0].operation.status, 'succeeded');
});

test('native login cancellation opens no webview and does not change credentials', async () => {
  const { host, session, messages, probes } = fixture();
  let shown = 0;
  vscode.window.showInputBox = async () => { shown++; return undefined; };
  await host.connectFromSidebar();
  assert.equal(shown, 1); assert.equal(session.accounts.length, 0); assert.equal(probes(), 0);
  assert.equal(messages.some(message => message.type === 'openAccountManager'), false);
  await host.accountFromSidebar('switchAccount');
  assert.equal(messages.at(-1).type, 'openAccountManager');
});

for (const panelState of ['visible', 'hidden'] as const) {
  test(`settings command reveals a ${panelState} ready panel once without changing the current workspace destination`, async () => {
    const { host, messages, globalState } = fixture();
    const calls: unknown[] = [];
    const issueNavigation: IssueNavigation = { mode: 'detail', projectId: 1, issueIid: 2, revision: 3 };
    const selectedGitRepositoryId = 'a'.repeat(32);
    host.activeMode = 'git'; host.issueNavigation = issueNavigation; host.webviewReady = true;
    host.selectedGitRepositoryId = selectedGitRepositoryId; host.panel = { visible: panelState === 'visible' };
    host.show = async (...args: unknown[]) => { calls.push(args); host.panel.visible = true; };
    await host.runCommandAction('openSettings', () => host.openSettings(), { operationId: 'open-settings' });
    assert.deepEqual(calls, [[undefined, { refresh: false }]]);
    assert.equal(messages.filter(message => message.type === 'openSettings').length, 1);
    host.publishSettings();
    assert.equal(messages.filter(message => message.type === 'openSettings').length, 1);
    assert.equal(host.pendingSettingsOpen, false);
    assert.equal(host.activeMode, 'git'); assert.equal(host.issueNavigation, issueNavigation);
    assert.equal(host.selectedGitRepositoryId, selectedGitRepositoryId); assert.equal(host.panel.visible, true);
    assert.equal(globalState.values.size, 0);
    const receipt = host.operations.get('open-settings');
    assert.equal(receipt.action, 'openSettings'); assert.equal(receipt.kind, 'read');
    assert.equal(receipt.label, '開啟設定'); assert.equal(receipt.status, 'succeeded');
  });
}

for (const panelState of ['cold', 'hidden'] as const) {
  test(`settings entry from a ${panelState} panel arrives once before its ready refresh completes`, async () => {
    const { host, messages } = fixture();
    host.panel = panelState === 'cold' ? undefined : { visible: false };
    host.webviewReady = false; host.viewReadAbort = new AbortController();
    host.show = async () => { host.panel = { visible: true }; };
    let finishRefresh!: () => void, refreshes = 0;
    host.refresh = async () => { refreshes++; await new Promise<void>(resolve => { finishRefresh = resolve; }); };
    await host.openSettings();
    assert.equal(messages.some(message => message.type === 'openSettings'), false);
    assert.equal(host.pendingSettingsOpen, true);
    const ready = host.dispatchMessage({ type: 'ready' });
    assert.equal(refreshes, 1);
    assert.equal(messages.filter(message => message.type === 'openSettings').length, 1, 'settings does not wait for page data');
    assert.equal(host.pendingSettingsOpen, false);
    await host.dispatchMessage({ type: 'ready' });
    assert.equal(refreshes, 1, 'a duplicate ready event does not restart entry');
    finishRefresh(); await ready;
    assert.equal(messages.filter(message => message.type === 'openSettings').length, 1);
    assert.equal(host.activeMode, 'developer');
  });
}

test('settings entry racing the webview ready event is not sent again after the panel opens', async () => {
  const { host, messages } = fixture();
  host.webviewReady = false; host.viewReadAbort = new AbortController();
  host.refresh = async () => undefined;
  host.show = async () => { await host.dispatchMessage({ type: 'ready' }); };
  await host.openSettings();
  assert.equal(messages.filter(message => message.type === 'openSettings').length, 1);
  assert.equal(host.pendingSettingsOpen, false);
});

test('hiding preserves a pending settings entry but closing it discards the entry before a normal reopen', async () => {
  const { host, messages, panels } = panelLifecycleFixture();
  await host.openSettings();
  assert.equal(host.pendingSettingsOpen, true);
  panels[0].hide();
  assert.equal(host.pendingSettingsOpen, true, 'temporarily hiding the same panel retains its pending destination');
  panels[0].dispose();
  assert.equal(host.pendingSettingsOpen, false);
  assert.equal(host.panel, undefined);
  await host.show();
  await host.dispatchMessage({ type: 'ready' });
  assert.equal(panels.length, 2);
  assert.equal(messages.some(message => message.type === 'openSettings'), false, 'normal reopen does not replay dismissed settings');
});

test('an obsolete panel disposal does not discard the current panel settings entry', async () => {
  const { host, messages, panels } = panelLifecycleFixture();
  await host.show();
  host.panel = undefined;
  await host.openSettings();
  panels[0].dispose();
  assert.equal(host.panel, panels[1]); assert.equal(host.pendingSettingsOpen, true);
  await host.dispatchMessage({ type: 'ready' });
  assert.equal(messages.filter(message => message.type === 'openSettings').length, 1);
});

test('a settings panel opening failure clears its pending entry and preserves the original error', async () => {
  const { host, messages } = fixture();
  const failure = new Error('Cannot open workspace panel');
  host.show = async () => { throw failure; };
  await assert.rejects(host.openSettings(), error => error === failure);
  assert.equal(host.pendingSettingsOpen, false);
  host.webviewReady = false; host.viewReadAbort = new AbortController();
  host.show = async () => undefined; host.refresh = async () => undefined;
  await host.show(); await host.dispatchMessage({ type: 'ready' });
  assert.equal(messages.some(message => message.type === 'openSettings'), false);
});

test('login succeeds independently of Group selection and reports a workspace loading failure separately', async () => {
  const { host, session, messages } = fixture();
  host.connectedUserChanged = WorkspacePanel!.prototype['connectedUserChanged'];
  host.groupRoot = 'old-group';
  host.refresh = async () => { throw new Error('Workspace unavailable'); };
  await authenticate(host, login('first'));
  assert.ok(session.activeAccountId);
  assert.equal(host.groupRoot, 'old-group', 'login must retain the independent local workspace');
  assert.equal(session.selectedGroup, undefined);
  assert.equal(accountResult(messages, 'first').name, 'User 1');
  const receipt = [...messages].reverse().find(message => message.type === 'operationChanged' && message.operation.correlationId === 'first' && message.operation.finishedAt !== undefined).operation;
  assert.equal(receipt.status, 'succeeded'); assert.equal(receipt.effect, 'applied');
  assert.match(receipt.refreshError, /工作區資料載入失敗/);
  assert.ok(messages.some(message => message.type === 'message' && message.message.includes('工作區資料載入失敗')));
});

test('a hidden webview retains the sanitized login result for its next ready event', async () => {
  const { host } = fixture();
  host.post = WorkspacePanel!.prototype['post'];
  host.panel = { visible: false }; host.webviewReady = false;
  await authenticate(host, login('hidden'));
  const result = host.pendingViewNotices.find((message: any) => message.type === 'accountLoginResult');
  assert.equal(result.name, 'User 1');
  assert.ok(!JSON.stringify(host.pendingViewNotices).includes('one-secret'));
});


test('native Settings opens an allowlisted ID without a Dashboard or network read', async () => {
  const { host, probes } = fixture(), calls: unknown[][] = [];
  vscode.commands.executeCommand = async (...args: unknown[]) => { calls.push(args); };
  await host.openConfiguration('gitlabWorkspace.projectRoot');
  assert.deepEqual(calls, [['workbench.action.openSettings', 'gitlabWorkspace.projectRoot']]);
  await assert.rejects(host.openConfiguration('other.setting'));
  assert.equal(calls.length, 1); assert.equal(probes(), 0);
});

test('no-argument Issue command uses a searchable current-Group picker and rejects stale choices', async () => {
  const { host } = fixture(), opened: unknown[] = [];
  let scope = 'group-one', loads = 0;
  Object.defineProperty(host.session, 'baseUrl', { get: () => 'https://gitlab.test' });
  Object.defineProperty(host.session, 'selectedGroup', { get: () => ({ id: 1 }) });
  host.connectedScopeKey = () => scope; host.getNavigationSnapshot = () => ({ scope });
  host.loadNavigationData = async () => { loads++; };
  host.issues = [{ project_id: 1, iid: 7, title: 'Selected issue' }]; host.projects = [{ id: 1, path_with_namespace: 'group/project' }];
  host.openIssue = async (...args: unknown[]) => { opened.push(args); };
  vscode.window.showQuickPick = async (items, options: any) => { assert.equal(options.matchOnDescription, true); assert.equal(items[0].description, 'group/project'); return items[0]; };
  await host.openIssueFromCommand(); assert.deepEqual(opened, [[1, 7]]); assert.equal(loads, 1);
  vscode.window.showQuickPick = async items => { scope = 'group-two'; return items[0]; };
  await host.openIssueFromCommand(); assert.equal(opened.length, 1);
  await assert.rejects(host.openIssueFromCommand(host.issues[0], 'group-one'));
});

test('empty Issue commands provide recovery actions and cancelled login never queries a Group', async () => {
  const { host } = fixture();
  let groupReads = 0;
  host.connect = async () => undefined; host.selectGroup = async () => { groupReads++; return false; };
  await host.openIssueFromCommand(); assert.equal(groupReads, 0);
  Object.defineProperty(host.session, 'baseUrl', { get: () => 'https://gitlab.test' });
  Object.defineProperty(host.session, 'selectedGroup', { get: () => ({ id: 1 }) });
  host.loadNavigationData = async () => undefined; host.connectedScopeKey = () => 'group'; host.issues = [];
  let choices: string[] = [];
  vscode.window.showInformationMessage = async (_message, ...actions) => { choices = actions; return undefined; };
  await host.openIssueFromCommand(); assert.equal(choices.length, 2);
});


test('native navigation snapshots update without a Webview and suppress data from the previous scope', async () => {
  const { host } = fixture(); await authenticate(host, login('navigation'));
  Object.defineProperty(host.session, 'selectedGroup', { configurable: true, get: () => ({ id: 2, full_path: 'team' }) });
  host.navigationListeners = new Set(); host.disposed = false;
  host.loadedScopeKey = 'https://gitlab.test|1|2'; host.projects = []; host.issues = [{ project_id: 1, iid: 7 }]; host.mergeRequests = [];
  let changes = 0; const subscription = host.onDidChangeNavigation(() => changes++);
  const publish = (WorkspacePanel!.prototype as any).sendSnapshot.bind(host);
  host.panel = undefined; host.webviewReady = false; publish(); publish(); assert.equal(changes, 1);
  assert.equal(host.getNavigationSnapshot().issues.length, 1);
  const oldScope = host.getNavigationSnapshot().scope;
  Object.defineProperty(host.session, 'selectedGroup', { configurable: true, get: () => ({ id: 3, full_path: 'other' }) });
  assert.notEqual(host.getNavigationSnapshot().scope, oldScope); assert.deepEqual(host.getNavigationSnapshot().issues, []);
  subscription.dispose(); publish(); assert.equal(changes, 1);
});

test('hiding the Dashboard preserves native navigation section leases and disposal cancels them', () => {
  const { host } = fixture(), controller = new AbortController();
  host.navigationReadCount = 1; host.viewReadAbort = new AbortController(); host.issuePanels.suspendReads = () => undefined;
  host.workspaceSections = { issues: { status: 'loading' } }; host.workspaceSectionAborts.set('issues', controller);
  host.suspendViewReads(); assert.equal(controller.signal.aborted, false); assert.equal(host.workspaceSections.issues.status, 'loading');
  host.disposed = true; host.suspendViewReads(); assert.equal(controller.signal.aborted, true);
});
