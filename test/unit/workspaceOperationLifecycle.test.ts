import assert from 'node:assert/strict';
import test from 'node:test';
import { OperationTracker, type WorkspaceOperationState } from '../../src/workspace/operations';
import { NotificationCenter } from '../../src/notifications/notificationCenter';
import { describeAction } from '../../src/workspace/actionPolicy';

const vscode = { window: { showWarningMessage: async () => undefined as string | undefined } };
const loader = require('node:module') as { _load: (name: string, parent: unknown, main: boolean) => unknown };
const originalLoad = loader._load;
loader._load = (name, parent, main) => name === 'vscode' ? vscode : originalLoad(name, parent, main);
let WorkspacePanel: typeof import('../../src/workspace/workspacePanel').WorkspacePanel;
try { ({ WorkspacePanel } = require('../../src/workspace/workspacePanel')); }
finally { loader._load = originalLoad; }

function fixture() {
  const events: WorkspaceOperationState[] = [], messages: any[] = [];
  const operations = new OperationTracker(operation => events.push(operation));
  const host: any = Object.assign(Object.create(WorkspacePanel.prototype), {
    session: { connectionEpoch: 1, activeAccountId: 'account', baseUrl: 'https://gitlab.test', selectedGroup: { id: 1 } },
    currentUser: { id: 1 }, projectContext: { root: 'C:/workspace', revision: 'root' },
    operationTracker: operations, notificationCenter: new NotificationCenter(),
    panel: { visible: true, webview: { postMessage: async (message: unknown) => { messages.push(message); return true; } } },
    webviewReady: true, webviewMessagesSent: 0, webviewMessagesReceived: 0,
    writesInFlight: 0, accountTransitionBusy: false, disposed: false,
    runLogged: async (_action: string, task: () => Promise<unknown>) => task(),
    sendSnapshot: () => undefined, dispatchMessage: async () => undefined,
    pendingViewNotices: [], gitWriteReceipts: new Map(),
    repositoryScan: { status: 'idle', errors: [] }
  });
  return { host, operations, events, messages };
}

const terminal = (events: WorkspaceOperationState[], id: string) => events.filter(item => item.requestId === id && item.finishedAt !== undefined);

test('host publishes one terminal receipt for preflight rejection and permits a fresh explicit retry', async () => {
  const f = fixture(); let calls = 0;
  f.host.dispatchMessage = async () => { calls++; };
  f.host.accountTransitionBusy = true;
  await assert.rejects(f.host.handleMessage({ type: 'installWorkflowKit', packageId: 'bundled', operationId: 'blocked', operationScope: f.host.getOperationScope() }), /帳號正在切換/);
  assert.equal(calls, 0); assert.equal(terminal(f.events, 'blocked').length, 1);
  assert.equal(f.operations.get('blocked')?.status, 'failed');
  assert.equal(f.operations.get('blocked')?.effect, 'none');
  f.host.accountTransitionBusy = false;
  await f.host.handleMessage({ type: 'installWorkflowKit', packageId: 'bundled', operationId: 'retry', operationScope: f.host.getOperationScope() });
  assert.equal(calls, 1); assert.equal(f.operations.get('retry')?.status, 'succeeded');
});

test('stale scope and retired host requests fail inside the lifecycle; reconciliation never replays a task', async () => {
  const f = fixture(); let calls = 0;
  f.host.dispatchMessage = async () => { calls++; };
  await assert.rejects(f.host.handleMessage({ type: 'refresh', operationId: 'stale', operationScope: 'old-root' }), /已變更/);
  await assert.rejects(f.host.handleMessage({ type: 'refresh', operationId: 'retired', hostSessionId: 'old-host' }), /連線已更新/);
  assert.equal(calls, 0); assert.equal(terminal(f.events, 'stale').length, 1); assert.equal(terminal(f.events, 'retired').length, 1);
  assert.equal(f.operations.get('stale')?.effect, 'none');
  assert.equal(f.operations.get('retired')?.effect, 'none');
  const before = f.events.length;
  f.host.dispatchMessage = (WorkspacePanel.prototype as any).dispatchMessage;
  await f.host.handleMessage({ type: 'reconcileOperations' });
  assert.equal(f.events.length, before);
  assert.equal(f.messages.at(-1).type, 'operationsSnapshot');
  assert.equal(f.messages.at(-1).snapshot.sessionId, f.operations.sessionId);
  assert.equal(f.messages.at(-1).snapshot.operations.length, 2);
});

test('Git preflight rejection is explicitly no-effect even when its adapter never sends a domain result', async () => {
  for (const write of [false, true]) {
    const f = fixture(); let calls = 0;
    f.host.dispatchMessage = async () => { calls++; };
    f.host.accountTransitionBusy = write;
    const request = { type: 'gitAction', operationId: 'git-preflight', requestId: 'git-domain', repoId: 'repo',
      action: write ? { type: 'commit', message: 'Retain draft' } : { type: 'open' },
      ...(write ? {} : { hostSessionId: 'retired-host' }) };
    await assert.rejects(f.host.handleMessage(request), write ? /帳號正在切換/ : /連線已更新/);
    const receipt = f.operations.get('git-preflight');
    assert.equal(calls, 0, 'the Git adapter was never entered');
    assert.equal(receipt?.status, 'failed');
    assert.equal(receipt?.effect, 'none');
    assert.equal(receipt?.correlationId, 'git-domain');
    assert.equal(terminal(f.events, 'git-preflight').length, 1);
    assert.equal(f.messages.some(message => message.type === 'gitActionResult'), false,
      'the UI must settle from the correlated lifecycle receipt alone');
  }
});

test('local UI actions bypass async operation tracking and still expose failures', async () => {
  const f = fixture(); let calls = 0;
  f.host.dispatchMessage = async () => { calls++; };
  await f.host.handleMessage({ type: 'setMode', mode: 'git' });
  assert.equal(calls, 1); assert.equal(f.events.length, 0);
  f.host.dispatchMessage = async () => { throw new Error('Cannot open local file'); };
  await assert.rejects(f.host.handleMessage({ type: 'gitOpenFile', repositoryId: 'a'.repeat(32), path: 'README.md' }), /Cannot open local file/);
  assert.equal(f.events.length, 0); assert.equal(f.messages.at(-1).type, 'error');
  assert.match(f.messages.at(-1).message, /Cannot open local file/);
  assert.equal(f.host.notifications.snapshot().items.length, 1);
});

test('handled read failures and scanning errors remain failed operations', async () => {
  const f = fixture();
  f.host.dispatchMessage = async () => f.host.post({ type: 'gitActionResult', requestId: 'read', error: 'Git read failed' });
  await f.host.handleMessage({ type: 'gitAction', operationId: 'read-op', requestId: 'read', repoId: 'repo', action: { type: 'history' } });
  assert.equal(f.operations.get('read-op')?.status, 'failed');
  assert.equal(f.operations.get('read-op')?.error, 'Git read failed');
  f.host.dispatchMessage = async () => { f.host.repositoryScan = { status: 'error', errors: [{ message: 'Scan denied' }] }; };
  await f.host.handleMessage({ type: 'scanRepositories', operationId: 'scan' });
  assert.equal(f.operations.get('scan')?.status, 'failed'); assert.equal(f.operations.get('scan')?.error, 'Scan denied');
});

test('applied mutations preserve their outcome when refreshing fails', async () => {
  const f = fixture();
  f.host.dispatchMessage = async () => f.host.post({ type: 'issueRelations', requestId: 'relation', connectedScope: 'scope', projectId: 1, issueIid: 2,
    mutationApplied: true, error: '關係已更新，但重新載入失敗' });
  await f.host.handleMessage({ type: 'mutateIssueRelations', operationId: 'relation', requestId: 'relation', connectedScope: 'scope', projectId: 1, issueIid: 2, action: { type: 'unlink', linkId: 3 } });
  assert.equal(f.operations.get('relation')?.status, 'succeeded'); assert.equal(f.operations.get('relation')?.effect, 'applied');
  assert.match(f.operations.get('relation')?.refreshError ?? '', /重新載入失敗/);
  f.host.dispatchMessage = async () => { f.host.noteOutcome({ effect: 'applied' }); await f.host.reconcileAfterWrite(async () => { throw new Error('offline'); }); };
  await f.host.handleMessage({ type: 'installWorkflowKit', packageId: 'bundled', operationId: 'install' });
  assert.equal(f.operations.get('install')?.status, 'succeeded'); assert.equal(f.operations.get('install')?.effect, 'applied');
  assert.match(f.operations.get('install')?.refreshError ?? '', /offline/);
});

test('concurrent busy owners keep feedback active until the final owner finishes', () => {
  const f = fixture();
  f.host.setBusyOwner('refresh:1', '正在更新工作台'); f.host.setBusyOwner('mr:1', '正在讀取 MR');
  f.host.setBusyOwner('refresh:1');
  assert.equal(f.messages.at(-1).value, true); assert.equal(f.messages.at(-1).label, '正在讀取 MR');
  f.host.setBusyOwner('mr:1'); assert.equal(f.messages.at(-1).value, false);
});

test('clone progress batches percentage updates while terminal states flush immediately', t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1000 });
  const f = fixture();
  const operation: any = { id: 'batch', label: 'Repo', phase: 'running', items: [{ projectId: 1, projectPath: 'group/repo', state: 'progress', percent: 0 }] };
  const publisher = f.host.cloneProgressPublisher(operation);
  publisher.publish();
  for (let percent = 1; percent < 80; percent++) { operation.items[0].percent = percent; publisher.publish(false); }
  assert.equal(f.messages.length, 1);
  t.mock.timers.tick(149); assert.equal(f.messages.length, 1);
  t.mock.timers.tick(1); assert.equal(f.messages.length, 2); assert.equal(f.messages.at(-1).items[0].percent, 79);
  operation.items[0].percent = 80; publisher.publish(false);
  operation.phase = 'failed'; operation.items[0].state = 'failed'; publisher.publish();
  assert.equal(f.messages.at(-1).phase, 'failed'); assert.equal(f.messages.at(-1).items[0].state, 'failed');
  const finalCount = f.messages.length; t.mock.timers.tick(150); assert.equal(f.messages.length, finalCount);
  publisher.dispose();
});

test('MR result reconciliation queries markers and releases an uncertain receipt without posting again', async () => {
  const f = fixture(); const scope = f.host.getOperationScope(); let published = 0, refreshed = 0;
  const uncertain: WorkspaceOperationState = { requestId: 'uncertain', action: 'postMergeRequestNote', label: 'Comment', resourceKey: 'mr:1:2',
    scopeRevision: scope, lockKey: 'mr:1:2', concurrency: 'exclusive', kind: 'write', phase: 'sending', status: 'queued', startedAt: Date.now() };
  await f.operations.run(uncertain, async () => ({ status: 'failed', effect: 'unknown' }));
  const pending = [{ key: 'pending', marker: '<!-- marker -->', projectId: 1, iid: 2, groupId: 1, userId: 1 }];
  f.host.pendingMrWrites = () => pending;
  f.host.requireGroupProject = () => ({ id: 1 });
  f.host.savePendingMrWrite = async () => { pending.splice(0); };
  f.host.loadMergeRequest = async () => { refreshed++; };
  f.host.session.getClient = async () => ({ listMergeRequestDiscussions: async () => [{ notes: [{ body: '<!-- marker -->' }] }], createMergeRequestNote: async () => { published++; } });
  await f.host.reconcileMergeRequestWrite(1, 2);
  assert.equal(f.operations.get('uncertain')?.effect, 'applied'); assert.equal(f.operations.get('uncertain')?.status, 'succeeded');
  assert.equal(refreshed, 1); assert.equal(published, 0); assert.equal(pending.length, 0);
});

test('a slower Repo navigation cannot replace the newer selected Repo', async () => {
  const f = fixture(); let release!: () => void, reads = 0;
  const gate = new Promise<void>(resolve => { release = resolve; });
  f.host.issuePanels = { close: () => undefined };
  f.host.context = { globalState: { update: async () => undefined } };
  f.host.gitRepositories = { getSummaryState: async () => { if (++reads === 1) await gate; return { repositories: [{ id: 'a' }, { id: 'b' }] }; },
    setActivePanelRepository: () => undefined };
  f.host.show = async () => undefined; f.host.scheduleGitRepositoryListSend = () => undefined; f.host.loadActiveModeSections = () => undefined;
  const first = f.host.runCommandAction('openRepository', () => f.host.navigateTo('git', 'a'), { operationId: 'first', repositoryId: 'a' });
  await f.host.runCommandAction('openRepository', () => f.host.navigateTo('git', 'b'), { operationId: 'second', repositoryId: 'b' });
  release(); await first;
  assert.equal(f.host.selectedGitRepositoryId, 'b');
  assert.equal(f.operations.get('first')?.status, 'cancelled'); assert.equal(f.operations.get('second')?.status, 'succeeded');
});

test('Git cancellation and applied writes with refresh errors produce distinct truthful receipts', async () => {
  const f = fixture();
  f.host.activeMode = 'git';
  f.host.dispatchMessage = (WorkspacePanel.prototype as any).dispatchMessage;
  f.host.gitRepositories = { handleAction: async () => ({ id: 'repo', actionEffect: 'none', actionCancelled: true, commitCompleted: false }) };
  await f.host.handleMessage({ type: 'gitAction', operationId: 'cancel', requestId: 'commit-cancel', repoId: 'repo', action: { type: 'commit', message: 'Keep draft' } });
  assert.equal(f.operations.get('cancel')?.status, 'cancelled'); assert.equal(f.operations.get('cancel')?.effect, 'none');
  f.host.gitRepositories.handleAction = async () => { throw Object.assign(new Error('status refresh failed'), { effect: 'applied', refreshError: 'status refresh failed', commitCompleted: true }); };
  await f.host.handleMessage({ type: 'gitAction', operationId: 'applied', requestId: 'commit-applied', repoId: 'repo', action: { type: 'commit', message: 'Saved commit' } });
  assert.equal(f.operations.get('applied')?.status, 'succeeded'); assert.equal(f.operations.get('applied')?.effect, 'applied');
  const receipt = f.messages.find(message => message.type === 'gitActionResult' && message.requestId === 'commit-applied');
  assert.equal(receipt.commitCompleted, true); assert.equal(receipt.error, undefined); assert.equal(receipt.refreshError, 'status refresh failed');
});

test('manual result confirmation preserves correlation and refuses stale scopes or unconfirmed choices', async () => {
  const f = fixture();
  const state: WorkspaceOperationState = { requestId: 'unknown-git', correlationId: 'git-request', action: 'gitAction', resourceKey: 'git:repo', label: 'Push',
    scopeRevision: f.host.getOperationScope(), lockKey: 'git:repo', concurrency: 'exclusive', kind: 'write', phase: 'Push', status: 'queued', startedAt: Date.now() };
  await f.operations.run(state, async () => ({ status: 'failed', effect: 'unknown' }));
  vscode.window.showWarningMessage = async () => undefined;
  await f.host.confirmOperationResult('unknown-git'); assert.equal(f.operations.get('unknown-git')?.effect, 'unknown');
  f.host.session.connectionEpoch++;
  await assert.rejects(f.host.confirmOperationResult('unknown-git'), /其他帳號或工作區/);
  f.host.session.connectionEpoch--;
  vscode.window.showWarningMessage = async () => '已確認完成';
  try { await f.host.confirmOperationResult('unknown-git'); }
  finally { vscode.window.showWarningMessage = async () => undefined; }
  assert.equal(f.operations.get('unknown-git')?.effect, 'applied'); assert.equal(f.operations.get('unknown-git')?.correlationId, 'git-request');
});

test('a previous host receipt can be recovered only after explicit human confirmation without replaying a request', async () => {
  const f = fixture(); let calls = 0;
  f.host.dispatchMessage = async () => { calls++; };
  const recovery = { requestId: 'previous-host', resourceKey: 'git:repo', action: 'gitAction', label: 'Push', correlationId: 'old-git-request',
    lockKey: 'global:git:repo', kind: 'write', token: 'must-never-be-imported' };
  vscode.window.showWarningMessage = async () => undefined;
  await f.host.confirmOperationResult('previous-host', recovery);
  assert.equal(f.operations.get('previous-host'), undefined);
  vscode.window.showWarningMessage = async () => '已確認未執行';
  try { await f.host.confirmOperationResult('previous-host', recovery); }
  finally { vscode.window.showWarningMessage = async () => undefined; }
  const receipt = f.operations.get('previous-host');
  assert.equal(receipt?.status, 'succeeded'); assert.equal(receipt?.effect, 'none');
  assert.equal(receipt?.scopeRevision, f.host.getOperationScope()); assert.equal(receipt?.hostSessionId, f.operations.sessionId);
  assert.equal(receipt?.correlationId, 'old-git-request'); assert.equal(calls, 0);
  assert.doesNotMatch(JSON.stringify(receipt), /must-never-be-imported|token/);
  await assert.rejects(f.host.confirmOperationResult('other-id', recovery), /恢復資料無效/);
});

test('host-normalized Issue identity shares the relationship lock and validation failures still receive a terminal receipt', async () => {
  const f = fixture(); let calls = 0;
  const scopeRevision = f.host.getOperationScope();
  const relation = { type: 'mutateIssueRelations', projectId: 1, issueIid: 2 };
  const policy = describeAction(relation, { scopeRevision, accountKey: 'account' });
  await f.operations.run({ ...policy, requestId: 'unknown-relation', scopeRevision, phase: 'writing', status: 'queued', startedAt: Date.now() },
    async () => ({ status: 'failed', effect: 'unknown' }));
  f.host.issuePanels = { normalizeOperationRequest: (request: any) => ({ ...request, projectId: 1, issueIid: 2 }) };
  f.host.dispatchMessage = async () => { calls++; };
  await f.host.handleMessage({ type: 'issueRequest', operationId: 'same-issue', request: { type: 'update', issueId: 101, input: { title: 'Update' } } });
  assert.equal(calls, 0); assert.equal(f.operations.get('same-issue')?.status, 'failed');
  assert.equal(f.operations.get('same-issue')?.resourceKey, 'issue:1:2');
  f.host.issuePanels.normalizeOperationRequest = () => { throw new Error('Issue identity changed'); };
  await assert.rejects(f.host.handleMessage({ type: 'issueRequest', operationId: 'invalid-issue', request: { type: 'update', issueId: 101, input: { title: 'Update' } } }), /identity changed/);
  assert.equal(terminal(f.events, 'invalid-issue').length, 1); assert.equal(f.operations.get('invalid-issue')?.status, 'failed');
});
