import assert from 'node:assert/strict';
import test from 'node:test';
import { OperationTracker, type WorkspaceOperationState } from '../../src/workspace/operations';
import { NotificationCenter } from '../../src/notifications/notificationCenter';
import { describeAction } from '../../src/workspace/actionPolicy';
import { GitLabClient } from '../../src/api/gitLabClient';

const vscode = { window: {
  showWarningMessage: async () => undefined as string | undefined,
  createTerminal: (_options: unknown) => ({ show: () => undefined, sendText: (_text: string) => undefined })
} };
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
    webviewReady: true, webviewMessagesSent: 0, webviewMessagesReceived: 0, viewGeneration: 0, viewReadAbort: new AbortController(),
    writesInFlight: 0, accountTransitionBusy: false, disposed: false,
    runLogged: async (_action: string, task: () => Promise<unknown>) => task(),
    sendSnapshot: () => undefined, dispatchMessage: async () => undefined,
    pendingViewNotices: [], gitWriteReceipts: new Map(),
    repositoryScan: { status: 'idle', errors: [] }
  });
  return { host, operations, events, messages };
}

const terminal = (events: WorkspaceOperationState[], id: string) => events.filter(item => item.requestId === id && item.finishedAt !== undefined);

test('retired Codex launch requests are rejected without opening a terminal', async t => {
  const f = fixture();
  const createTerminal = t.mock.method(vscode.window, 'createTerminal');
  f.host.dispatchMessage = (WorkspacePanel.prototype as any).dispatchMessage;
  for (const metadata of [{}, { operationId: 'retired-codex' }]) {
    await assert.rejects(f.host.handleMessage({ type: 'openCodexTerminal', revision: 'old-root', ...metadata }), /此操作已移除/);
  }
  assert.equal(createTerminal.mock.callCount(), 0);
  assert.equal(f.events.length, 0);
});

test('host publishes one terminal receipt for preflight rejection and permits a fresh explicit retry', async () => {
  const f = fixture(); let calls = 0;
  f.host.dispatchMessage = async () => { calls++; };
  f.host.accountTransitionBusy = true;
  await assert.rejects(f.host.handleMessage({ type: 'installWorkflowKit', releaseId: 'bundled', operationId: 'blocked', operationScope: f.host.getLocalOperationScope() }), /帳號正在切換/);
  assert.equal(calls, 0); assert.equal(terminal(f.events, 'blocked').length, 1);
  assert.equal(f.operations.get('blocked')?.status, 'failed');
  assert.equal(f.operations.get('blocked')?.effect, 'none');
  f.host.accountTransitionBusy = false;
  await f.host.handleMessage({ type: 'installWorkflowKit', releaseId: 'bundled', operationId: 'retry', operationScope: f.host.getLocalOperationScope() });
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

test('a local read survives a Group change while remote reads and changed local roots become obsolete', async t => {
  for (const transition of ['group-local', 'group-remote', 'root-local']) await t.test(transition, async () => {
    const f = fixture(); let release!: () => void, entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    let calls = 0;
    f.host.dispatchMessage = async () => { calls++; entered(); await gate; };
    const remote = transition === 'group-remote';
    const request = remote ? { type: 'refreshMergeRequest', projectId: 1, iid: 2 }
      : { type: 'loadSkillBranches', repo: 'C:/workspace', revision: 'environment', requestId: 'branches' };
    const scope = remote ? f.host.getOperationScope() : f.host.getLocalOperationScope();
    const pending = f.host.handleMessage({ ...request, operationId: 'read', operationScope: scope });
    await started;
    if (transition === 'root-local') f.host.projectContext = { root: 'C:/other', revision: 'other-root' };
    else f.host.session.selectedGroup = { id: 9 };
    release(); await pending;
    assert.equal(calls, 1, 'the transition never replays the read');
    assert.equal(terminal(f.events, 'read').length, 1);
    assert.equal(f.operations.get('read')?.status, transition === 'group-local' ? 'succeeded' : 'cancelled');
    assert.equal(f.operations.get('read')?.scopeRevision, scope);
  });
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
  assert.equal(f.host.notifications.snapshot().items.length, 2);
  assert.equal(f.host.notifications.snapshot().items.find((item: any) => item.operationId === 'read-op').messages.length, 1);
  assert.equal(f.host.notifications.snapshot().items.find((item: any) => item.operationId === 'scan').messages[0], 'Scan denied');
});

test('fixed-version MR Diff renders limited files with a truthful warning and failed retry retains its error', async () => {
  const f = fixture(); let fallbackFails = false;
  const summaries: any[] = [], endpoints: string[] = [];
  f.host.runLogged = (WorkspacePanel.prototype as any).runLogged;
  f.host.session.log = { run: async (_feature: string, _action: string, _context: unknown, task: () => Promise<unknown>, outcome: () => unknown) => {
    const value = await task(); summaries.push(outcome()); return value;
  } };
  f.host.dispatchMessage = (WorkspacePanel.prototype as any).dispatchMessage;
  f.host.mergeRequestSectionAborts = {}; f.host.mergeRequestSectionGenerations = { diffs: 0, discussions: 0 };
  f.host.mergeRequestGeneration = 0; f.host.requestGeneration = 0;
  f.host.selectedMergeRequest = { request: { project_id: 1, iid: 2, diff_refs: { base_sha: 'base', start_sha: 'start', head_sha: 'head' } }, diffs: [], warnings: [], sections: { diffs: { status: 'idle' }, discussions: { status: 'idle' } } };
  f.host.loadMergeRequest = async () => undefined;
  const version = { id: 8, base_commit_sha: 'base', start_commit_sha: 'start', head_commit_sha: 'head' };
  const client = new GitLabClient('https://gitlab.test', 'test-only', async input => {
    const endpoint = new URL(String(input)).pathname; endpoints.push(endpoint);
    return endpoint.endsWith('/versions') ? new Response(JSON.stringify([version])) : fallbackFails ? new Response('{}', { status: 503 })
      : new Response(JSON.stringify({ ...version, state: 'overflow', real_size: '1000+', diffs: [{ old_path: 'a.ts', new_path: 'a.ts', diff: '+restored' }] }));
  });
  f.host.session.getClient = async () => client;
  f.host.session.cachedRead = async (_key: string, load: (value: GitLabClient) => Promise<unknown>) => load(client);
  await f.host.handleMessage({ type: 'loadMergeRequestSection', section: 'diffs', projectId: 1, iid: 2, operationId: 'recovered' });
  assert.equal(f.host.selectedMergeRequest.sections.diffs.status, 'ready');
  assert.equal(f.host.selectedMergeRequest.diffs[0].diff, '+restored');
  assert.match(f.host.selectedMergeRequest.warnings[0], /不完整/);
  assert.equal(f.host.notifications.snapshot().items.length, 1);
  assert.equal(f.host.notifications.snapshot().items[0].level, 'warn');
  assert.equal(summaries[0].result, 'success');
  fallbackFails = true; f.host.selectedMergeRequest.sections.diffs = { status: 'error' };
  await f.host.handleMessage({ type: 'loadMergeRequestSection', section: 'diffs', projectId: 1, iid: 2, operationId: 'failed-retry' });
  assert.equal(f.host.selectedMergeRequest.sections.diffs.status, 'error');
  assert.match(f.host.selectedMergeRequest.sections.diffs.error, /HTTP 503/);
  assert.equal(f.operations.get('failed-retry')?.status, 'failed');
  const failed = f.host.notifications.snapshot().items.find((item: any) => item.operationId === 'failed-retry');
  assert.equal(failed.level, 'error'); assert.equal(failed.messages.length, 1);
  assert.equal(summaries[1].result, 'error'); assert.match(summaries[1].message, /HTTP 503/);
  assert.equal(endpoints.length, 6, 'the failed safe-read fallback has at most two transport retries');
});

test('quiet read failures keep their captured source and applied refresh warnings retain actual details', async () => {
  const f = fixture(); let release!: () => void;
  f.host.dispatchMessage = async () => { await new Promise<void>(resolve => { release = resolve; }); throw new Error('Preview unavailable'); };
  const pending = f.host.handleMessage({ type: 'loadMergeRequestSection', projectId: 1, iid: 2, section: 'diffs', operationId: 'old-read' });
  f.host.session.activeAccountId = 'new-account'; f.host.session.selectedGroup = { id: 9 }; f.host.projectContext = { root: 'C:/new', revision: 'new' };
  release(); await assert.rejects(pending, /Preview unavailable/);
  const item = f.host.notifications.snapshot().items[0];
  assert.equal(item.origin.accountId, 'account'); assert.equal(item.origin.groupId, 1); assert.equal(item.origin.root, 'C:/workspace');
  f.host.dispatchMessage = async () => {
    f.host.post({ type: 'message', message: 'Saved' });
    f.host.noteOutcome({ effect: 'applied', refreshError: 'Actual reload failure' });
  };
  await f.host.handleMessage({ type: 'installWorkflowKit', operationId: 'saved', releaseId: 'bundled' });
  const saved = f.host.notifications.snapshot().items.find((entry: any) => entry.operationId === 'saved');
  assert.equal(saved.level, 'warn'); assert.match(saved.messages.join('\n'), /Saved.*Actual reload failure/s);
  assert.equal(f.operations.get('saved')?.effect, 'applied');
});

test('Issue Board read failures settle as failed and stale local feedback is rejected', async () => {
  const f = fixture();
  f.host.dispatchMessage = (WorkspacePanel.prototype as any).dispatchMessage;
  f.host.session.selectedGroup = { id: 1, full_path: 'group' };
  f.host.currentUser = { id: 1, username: 'tester' };
  f.host.connectedScopeKey = () => 'connected'; f.host.groupIssueBoards = [{ id: 3 }]; f.host.issueBoardGeneration = 0;
  f.host.session.cachedRead = async () => { throw new Error('Board unavailable'); };
  await f.host.handleMessage({ type: 'selectIssueBoard', operationId: 'board', boardId: 3, connectedScope: 'connected' });
  assert.equal(f.operations.get('board')?.status, 'failed');
  assert.equal(f.host.issueBoardContent.status, 'error');
  assert.equal(f.host.notifications.snapshot().items[0].messages[0], 'Board unavailable');
  const revision = f.host.notifications.snapshot().revision;
  for (const context of [{ hostSessionId: 'retired-host' }, { scopeEpoch: 1.5 }, { scopeEpoch: -1 }]) {
    await f.host.handleMessage({ type: 'publishNotification', level: 'warn', message: 'Stale notice', ...context });
  }
  assert.equal(f.host.notifications.snapshot().revision, revision);
});

test('applied mutations preserve their outcome when refreshing fails', async () => {
  const f = fixture();
  f.host.dispatchMessage = async () => f.host.post({ type: 'issueRelations', requestId: 'relation', connectedScope: 'scope', projectId: 1, issueIid: 2,
    mutationApplied: true, error: '關係已更新，但重新載入失敗' });
  await f.host.handleMessage({ type: 'mutateIssueRelations', operationId: 'relation', requestId: 'relation', connectedScope: 'scope', projectId: 1, issueIid: 2, action: { type: 'unlink', linkId: 3 } });
  assert.equal(f.operations.get('relation')?.status, 'succeeded'); assert.equal(f.operations.get('relation')?.effect, 'applied');
  assert.match(f.operations.get('relation')?.refreshError ?? '', /重新載入失敗/);
  f.host.dispatchMessage = async () => { f.host.noteOutcome({ effect: 'applied' }); await f.host.reconcileAfterWrite(async () => { throw new Error('offline'); }); };
  await f.host.handleMessage({ type: 'installWorkflowKit', releaseId: 'bundled', operationId: 'install' });
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
  f.host.resolveGroupProject = async () => ({ id: 1 });
  f.host.savePendingMrWrite = async () => { pending.splice(0); };
  f.host.refreshMergeRequestData = async (projectId: number, iid: number, sections: string) => {
    assert.deepEqual([projectId, iid, sections], [1, 2, 'discussions']); refreshed++;
  };
  f.host.session.getClient = async () => ({ listMergeRequestDiscussions: async () => [{ notes: [{ body: '<!-- marker -->' }] }], createMergeRequestNote: async () => { published++; } });
  await f.host.reconcileMergeRequestWrite(1, 2);
  assert.equal(f.operations.get('uncertain')?.effect, 'applied'); assert.equal(f.operations.get('uncertain')?.status, 'succeeded');
  assert.equal(refreshed, 1); assert.equal(published, 0); assert.equal(pending.length, 0);
});

test('a slower Repo navigation cannot replace the newer selected Repo', async () => {
  const f = fixture(); let release!: () => void, entered!: () => void, reads = 0;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { entered = resolve; });
  const refreshed: string[] = [];
  f.host.issuePanels = { close: () => undefined };
  f.host.context = { globalState: { update: async (key: string, value: unknown) => {
    if (key === 'gitlabWorkspace.selectedGitRepositoryId' && value === 'a') { entered(); await gate; }
  } } };
  f.host.gitRepositories = { getCachedSummaryState: () => { reads++; return { repositories: [{ id: 'a' }, { id: 'b' }] }; },
    setActivePanelRepository: () => undefined };
  f.host.show = async () => undefined; f.host.cancelPageReads = () => undefined;
  f.host.refresh = async () => { refreshed.push(f.host.selectedGitRepositoryId); };
  const first = f.host.runCommandAction('openRepository', () => f.host.navigateTo('git', 'a'), { operationId: 'first', repositoryId: 'a' });
  await started;
  await f.host.runCommandAction('openRepository', () => f.host.navigateTo('git', 'b'), { operationId: 'second', repositoryId: 'b' });
  release(); await first;
  assert.equal(f.host.selectedGitRepositoryId, 'b');
  assert.equal(reads, 2, 'both navigations validate cached local inventory without issuing Git reads');
  assert.deepEqual(refreshed, ['b'], 'the delayed obsolete navigation never starts a page load');
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
    scopeRevision: f.host.getLocalOperationScope(), lockKey: 'git:repo', concurrency: 'exclusive', kind: 'write', phase: 'Push', status: 'queued', startedAt: Date.now() };
  await f.operations.run(state, async () => ({ status: 'failed', effect: 'unknown' }));
  vscode.window.showWarningMessage = async () => undefined;
  await f.host.confirmOperationResult('unknown-git'); assert.equal(f.operations.get('unknown-git')?.effect, 'unknown');
  f.host.session.selectedGroup = { id: 9 };
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
  assert.equal(receipt?.scopeRevision, f.host.getLocalOperationScope()); assert.equal(receipt?.hostSessionId, f.operations.sessionId);
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
