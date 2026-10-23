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
  window: { createWebviewPanel: (..._args: unknown[]): any => { throw new Error('Unexpected panel creation'); } }
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
      onDidChangeViewState: (listener: () => void) => { changed = listener; },
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

const login = (requestId: string, token = 'one-secret', accountId?: string) => ({ type: 'submitAccountLogin', requestId, baseUrl: 'https://gitlab.test/', token, accountId });
const accountResult = (messages: any[], requestId: string) => {
  const result = [...messages].reverse().find(message => message.type === 'accountLoginResult' && message.requestId === requestId);
  assert.ok(result, `login ${requestId} has a domain result`);
  return result;
};

test('login uses the existing validated account store and replays receipts without authenticating twice', async () => {
  const { host, session, messages, secrets, globalState, snapshots, logMetadata, registeredSecrets, probes } = fixture();
  await host.handleMessage(login('first'));
  assert.equal(session.accounts.length, 1);
  assert.equal(secrets.values.get(accountTokenKey(session.activeAccountId!)), 'one-secret');
  assert.equal(accountResult(messages, 'first').name, 'User 1');
  assert.equal(host.accountTransitionBusy, false);
  assert.ok(snapshots.some((value: any) => value.accountOperation === 'login'));
  assert.ok(registeredSecrets.includes('one-secret'));
  for (const value of [messages, snapshots, logMetadata, [...globalState.values], [...host.accountLoginReceipts.values()]]) assert.ok(!JSON.stringify(value).includes('one-secret'));
  await host.handleMessage(login('first', 'two-secret'));
  assert.equal(probes(), 1);
  assert.equal(session.accounts.length, 1);
  assert.equal(accountResult(messages, 'first').name, 'User 1');
  assert.ok(messages.some(message => message.type === 'operationChanged' && message.operation.finishedAt !== undefined));
});

test('invalid credentials, a different identity and network failure keep the previous account and credentials', async () => {
  const { host, session, messages, secrets } = fixture();
  await host.handleMessage(login('first'));
  const active = session.activeAccountId!;
  for (const [id, token, pattern] of [['invalid', 'invalid', /Token 無效/], ['forbidden', 'forbidden', /拒絕存取/], ['mismatch', 'two-secret', /身分.*不同/], ['network', 'network', /無法連線/]] as const) {
    await host.handleMessage(login(id, token, active));
    assert.match(accountResult(messages, id).error, pattern);
    assert.equal(session.activeAccountId, active);
    assert.equal(secrets.values.get(accountTokenKey(active)), 'one-secret');
    assert.equal(host.accountTransitionBusy, false);
  }
});

test('malformed inputs and a changed relogin site never reach GitLab', async () => {
  const { host, session, messages, probes } = fixture();
  await host.handleMessage({ ...login('url'), baseUrl: 'https://user:password@gitlab.test' });
  assert.match(accountResult(messages, 'url').error, /網址無效/);
  await host.handleMessage(login('missing', ''));
  assert.match(accountResult(messages, 'missing').error, /有效/);
  assert.equal(probes(), 0);
  await host.handleMessage(login('first'));
  await host.handleMessage({ ...login('other', 'two-secret', session.activeAccountId), baseUrl: 'https://other.test' });
  assert.match(accountResult(messages, 'other').error, /原有.*站台/);
  assert.equal(probes(), 1);
});

test('a pending login deduplicates its request and blocks another login, switching and Group changes', async () => {
  const { host, session, messages } = fixture();
  let finish!: (response: Response) => void, start!: () => void, probes = 0;
  const started = new Promise<void>(resolve => { start = resolve; });
  session.setFetchForTesting(async () => { probes++; start(); return new Promise(resolve => { finish = resolve; }); });
  const pending = { ...login('pending'), operationId: 'pending-login' };
  const operation = host.handleMessage(pending);
  await started;
  const duplicate = host.handleMessage(pending);
  await host.handleMessage({ ...login('other'), operationId: 'competing-login' });
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

test('sidebar and command entry points open the same panel and retain intent until the webview is ready', async () => {
  const { host, messages } = fixture();
  await host.connectFromSidebar();
  assert.equal([...messages].reverse().find(message => message.type === 'openAccountManager').intent.startLogin, true);
  await host.accountFromSidebar('switchAccount');
  assert.equal([...messages].reverse().find(message => message.type === 'openAccountManager').intent.startLogin, false);
  host.show = async () => { host.webviewReady = false; };
  const count = messages.length;
  await host.connectFromSidebar();
  assert.equal(messages.length, count);
  assert.equal(host.pendingAccountPanel.startLogin, true);
  host.webviewReady = true; host.publishAccountPanel();
  assert.equal([...messages].reverse().find(message => message.type === 'openAccountManager').intent.startLogin, true);
  assert.equal(host.pendingAccountPanel, undefined);
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
  await host.handleMessage(login('first'));
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
  await host.handleMessage(login('hidden'));
  const result = host.pendingViewNotices.find((message: any) => message.type === 'accountLoginResult');
  assert.equal(result.name, 'User 1');
  assert.ok(!JSON.stringify(host.pendingViewNotices).includes('one-secret'));
});
