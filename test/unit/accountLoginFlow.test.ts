import assert from 'node:assert/strict';
import test from 'node:test';
import { GitLabSession } from '../../src/connection/session';
import { accountTokenKey } from '../../src/connection/accountStore';

const loader = require('node:module') as { _load: (name: string, parent: unknown, main: boolean) => unknown };
const original = loader._load;
loader._load = (name, parent, main) => name === 'vscode' ? {} : original(name, parent, main);
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
  session.ensureInstanceChecked = async () => undefined;
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
    mrWritesInFlight: new Set(), issueRelationWritesInFlight: new Set(), timer: { list: () => [] }, activeMode: 'developer',
    context: { globalState, workspaceState }, post: (message: unknown) => messages.push(message),
    sendSnapshot: () => snapshots.push({ accountOperation: host.accountOperation, accounts: session.accounts }),
    connectedUserChanged: async (user: unknown) => { host.currentUser = user; },
    syncSidebarState: async () => undefined,
    show: async () => { host.webviewReady = true; },
    pendingViewNotices: [],
    requestGeneration: 0, previewGeneration: 0, issueOpenGeneration: 0, workflowKitRefreshGeneration: 0,
    cancelMergeRequestSectionReads: () => undefined, issuePanels: { close: () => undefined }
  });
  return { host, session, secrets, globalState, messages, snapshots, logMetadata, registeredSecrets, intents, probes: () => probes };
}

const login = (requestId: string, token = 'one-secret', accountId?: string) => ({ type: 'submitAccountLogin', requestId, baseUrl: 'https://gitlab.test/', token, accountId });

test('login uses the existing validated account store and replays receipts without authenticating twice', async () => {
  const { host, session, messages, secrets, globalState, snapshots, logMetadata, registeredSecrets, probes } = fixture();
  await host.handleMessage(login('first'));
  assert.equal(session.accounts.length, 1);
  assert.equal(secrets.values.get(accountTokenKey(session.activeAccountId!)), 'one-secret');
  assert.equal(messages.at(-1).name, 'User 1');
  assert.equal(host.accountTransitionBusy, false);
  assert.ok(snapshots.some((value: any) => value.accountOperation === 'login'));
  assert.ok(registeredSecrets.includes('one-secret'));
  for (const value of [messages, snapshots, logMetadata, [...globalState.values], [...host.accountLoginReceipts.values()]]) assert.ok(!JSON.stringify(value).includes('one-secret'));
  await host.handleMessage(login('first', 'two-secret'));
  assert.equal(probes(), 1);
  assert.equal(session.accounts.length, 1);
  assert.equal(messages.at(-1).name, 'User 1');
});

test('invalid credentials, a different identity and network failure keep the previous account and credentials', async () => {
  const { host, session, messages, secrets } = fixture();
  await host.handleMessage(login('first'));
  const active = session.activeAccountId!;
  for (const [id, token, pattern] of [['invalid', 'invalid', /Token 無效/], ['forbidden', 'forbidden', /拒絕存取/], ['mismatch', 'two-secret', /身分.*不同/], ['network', 'network', /無法連線/]] as const) {
    await host.handleMessage(login(id, token, active));
    assert.match(messages.at(-1).error, pattern);
    assert.equal(session.activeAccountId, active);
    assert.equal(secrets.values.get(accountTokenKey(active)), 'one-secret');
    assert.equal(host.accountTransitionBusy, false);
  }
});

test('malformed inputs and a changed relogin site never reach GitLab', async () => {
  const { host, session, messages, probes } = fixture();
  await host.handleMessage({ ...login('url'), baseUrl: 'https://user:password@gitlab.test' });
  assert.match(messages.at(-1).error, /網址無效/);
  await host.handleMessage(login('missing', ''));
  assert.match(messages.at(-1).error, /有效/);
  assert.equal(probes(), 0);
  await host.handleMessage(login('first'));
  await host.handleMessage({ ...login('other', 'two-secret', session.activeAccountId), baseUrl: 'https://other.test' });
  assert.match(messages.at(-1).error, /原有.*站台/);
  assert.equal(probes(), 1);
});

test('a pending login deduplicates its request and blocks another login, switching and Group changes', async () => {
  const { host, session, messages } = fixture();
  let finish!: (response: Response) => void, start!: () => void, probes = 0;
  const started = new Promise<void>(resolve => { start = resolve; });
  session.setFetchForTesting(async () => { probes++; start(); return new Promise(resolve => { finish = resolve; }); });
  const operation = host.handleMessage(login('pending'));
  await started;
  await host.handleMessage(login('pending'));
  await host.handleMessage(login('other'));
  assert.match(messages.at(-1).error, /正在驗證/);
  assert.equal(host.accountTransitionBusy, true);
  await assert.rejects(host.switchAccount('any'), /正在切換/);
  await assert.rejects(host.selectGroup(), /正在驗證/);
  finish(new Response(JSON.stringify({ id: 1, name: 'User 1', username: 'one' })));
  await operation;
  assert.equal(probes, 1);
  assert.equal(host.accountTransitionBusy, false);
  assert.equal(messages.at(-1).requestId, 'pending');
});

test('sidebar and command entry points open the same panel and retain intent until the webview is ready', async () => {
  const { host, messages } = fixture();
  await host.connectFromSidebar();
  assert.equal(messages.at(-1).type, 'openAccountManager');
  assert.equal(messages.at(-1).intent.startLogin, true);
  await host.accountFromSidebar('switchAccount');
  assert.equal(messages.at(-1).intent.startLogin, false);
  host.show = async () => { host.webviewReady = false; };
  const count = messages.length;
  await host.connectFromSidebar();
  assert.equal(messages.length, count);
  assert.equal(host.pendingAccountPanel.startLogin, true);
  host.webviewReady = true; host.publishAccountPanel();
  assert.equal(messages.at(-1).intent.startLogin, true);
  assert.equal(host.pendingAccountPanel, undefined);
});

test('login succeeds independently of Group selection and reports a workspace loading failure separately', async () => {
  const { host, session, messages } = fixture();
  host.connectedUserChanged = WorkspacePanel!.prototype['connectedUserChanged'];
  host.groupRoot = 'old-group';
  host.refresh = async () => { throw new Error('Workspace unavailable'); };
  await host.handleMessage(login('first'));
  assert.ok(session.activeAccountId);
  assert.equal(host.groupRoot, undefined);
  assert.equal(session.selectedGroup, undefined);
  assert.equal(messages.at(-1).name, 'User 1');
  assert.ok(messages.some(message => message.type === 'error' && message.message.includes('工作區資料載入失敗')));
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
