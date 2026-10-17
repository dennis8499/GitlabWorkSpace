import assert from 'node:assert/strict';
import test from 'node:test';
import type { IssueDetailData, IssuePanelResponse } from '../../src/issues/protocol';
import { NotificationCenter } from '../../src/notifications/notificationCenter';
import type { NotificationOrigin } from '../../src/notifications/notificationProtocol';
import { collectWorkspaceFeedback } from '../../src/notifications/workspaceFeedback';
import { OperationTracker } from '../../src/workspace/operations';
import type { WorkspaceResponse, WorkspaceSnapshot } from '../../src/workspace/workspaceProtocol';

const origin: NotificationOrigin = { accountId: 'account-one', baseUrl: 'https://gitlab.example', groupId: 7, root: 'C:/workspace-one' };
const issueResponse = (response: IssuePanelResponse): WorkspaceResponse => ({ type: 'issueResponse', response });
const snapshotResponse = (snapshot: Partial<WorkspaceSnapshot>): WorkspaceResponse => ({ type: 'snapshot', snapshot: snapshot as WorkspaceSnapshot });
const issueDetail = (extra: Partial<IssueDetailData>): IssueDetailData => ({ issue: { id: 101 }, ...extra } as IssueDetailData);

test('ordinary Issue reply errors reach the center and correlate with a single tracker result', async () => {
  const center = new NotificationCenter();
  const tracker = new OperationTracker(operation => center.recordOperation(operation));
  const response = issueResponse({ type: 'reply', requestId: 'issue-request', error: 'Issue update failed', notificationOnly: false });
  const correlate = (id: string) => tracker.get(id)?.requestId;
  await tracker.run({ requestId: 'host-operation', correlationId: 'issue-request', scopeRevision: 'scope', resourceKey: 'issue:1:2',
    action: 'issueRequest', label: '更新 Issue', status: 'queued', phase: '準備中', startedAt: 1 }, async () => {
    assert.equal(collectWorkspaceFeedback(center, response, origin, undefined, correlate), false);
    tracker.noteOutcome('host-operation', { status: 'failed', error: 'Issue update failed', effect: 'none' });
  });
  collectWorkspaceFeedback(center, response, origin, undefined, correlate);
  const snapshot = center.snapshot();
  assert.equal(snapshot.items.length, 1); assert.equal(snapshot.items[0].operationId, 'host-operation');
  assert.equal(snapshot.items[0].level, 'error'); assert.deepEqual(snapshot.items[0].messages, ['Issue update failed']);
  assert.deepEqual(snapshot.items[0].origin, origin);
  tracker.dispose();
});

test('Issue detail patches and full detail snapshots share load-error transitions without replaying notices', () => {
  const center = new NotificationCenter();
  const loadErrors = { activity: 'Discussion unavailable', timelogs: 'Time report unavailable' };
  const patch = issueResponse({ type: 'detailPatch', issueId: 101, patch: { loadErrors } });
  const full = issueResponse({ type: 'detailData', data: issueDetail({ loadErrors, warnings: [], notices: [] }) });
  collectWorkspaceFeedback(center, patch, origin);
  const initial = center.snapshot(); assert.equal(initial.items.length, 2);
  for (let index = 0; index < 3; index++) {
    collectWorkspaceFeedback(center, full, origin); collectWorkspaceFeedback(center, patch, origin);
  }
  assert.equal(center.snapshot().revision, initial.revision);
  assert.ok(center.snapshot().items.every(item => item.level === 'error' && item.title === 'Issue 區段'));
  collectWorkspaceFeedback(center, issueResponse({ type: 'detailPatch', issueId: 101, patch: { loadErrors: {} } }), origin);
  center.markAllRead(center.snapshot().revision);
  collectWorkspaceFeedback(center, patch, origin);
  assert.equal(center.snapshot().unreadCount, 2, 'errors that return after recovery are reported again');
  assert.equal(center.snapshot().items.length, 4);
});

test('Issue load errors, option warnings and permission notices retain independent deduplication identities', () => {
  const center = new NotificationCenter();
  const full = issueResponse({ type: 'detailData', data: issueDetail({
    loadErrors: { options: 'Members unavailable', permissions: 'Permissions unavailable' },
    options: { members: [], labels: [], milestones: [], templates: [], warnings: ['Some labels are unavailable'] },
    permissionNotice: 'Some permissions are not confirmed',
    warnings: []
  }) });
  collectWorkspaceFeedback(center, full, origin);
  const initial = center.snapshot(); assert.equal(initial.items.length, 4);
  collectWorkspaceFeedback(center, full, origin); collectWorkspaceFeedback(center, full, origin);
  assert.equal(center.snapshot().revision, initial.revision);
  assert.equal(center.snapshot().items.length, 4);
});

test('Git writes retain actual refresh warnings and deduplicate their tracker receipts', () => {
  const center = new NotificationCenter();
  const actualDetail = '無法重新讀取遠端分支：connection reset';
  const response: WorkspaceResponse = { type: 'gitActionResult', requestId: 'git-request', write: true, effect: 'applied', refreshError: actualDetail };
  collectWorkspaceFeedback(center, response, origin, undefined, id => id === 'git-request' ? 'git-operation' : undefined);
  center.recordOperation({ requestId: 'git-operation', scopeRevision: 'scope', resourceKey: 'git:repo', action: 'gitAction',
    label: 'Push', status: 'succeeded', effect: 'applied', refreshError: actualDetail, phase: '已更新，重新載入失敗', startedAt: 1 });
  const snapshot = center.snapshot();
  assert.equal(snapshot.items.length, 1); assert.equal(snapshot.items[0].level, 'warn');
  assert.equal(snapshot.items[0].operationId, 'git-operation');
  assert.deepEqual(snapshot.items[0].messages, [`操作已完成，但重新載入失敗：${actualDetail}`]);
});

test('account login errors enter the center with their correlated operation and origin', () => {
  const center = new NotificationCenter();
  const response: WorkspaceResponse = { type: 'accountLoginResult', requestId: 'login-request', error: 'GitLab rejected this account.' };
  collectWorkspaceFeedback(center, response, origin, undefined, id => id === 'login-request' ? 'login-operation' : undefined);
  collectWorkspaceFeedback(center, response, origin, undefined, () => 'login-operation');
  const snapshot = center.snapshot();
  assert.equal(snapshot.items.length, 1); assert.equal(snapshot.items[0].operationId, 'login-operation');
  assert.equal(snapshot.items[0].title, '登入 GitLab'); assert.equal(snapshot.items[0].level, 'error');
  assert.deepEqual(snapshot.items[0].origin, origin);
});

test('static instance, workspace and section snapshots publish only new warning transitions', () => {
  const center = new NotificationCenter();
  const snapshot = {
    instance: { warnings: ['Minimum version could not be confirmed'] }, workspaceRootError: 'Workspace root is unavailable',
    sections: { mergeRequests: { status: 'error' as const, error: 'MR list unavailable' } }
  };
  const response = snapshotResponse(snapshot);
  collectWorkspaceFeedback(center, response, origin);
  const initial = center.snapshot(); assert.equal(initial.items.length, 3);
  assert.equal(initial.items.filter(item => item.level === 'warn').length, 2);
  assert.equal(initial.items.filter(item => item.level === 'error').length, 1);
  for (let index = 0; index < 5; index++) collectWorkspaceFeedback(center, snapshotResponse({ ...snapshot }), origin);
  assert.equal(center.snapshot().revision, initial.revision);
  center.markAllRead(center.snapshot().revision);
  collectWorkspaceFeedback(center, snapshotResponse({ instance: { warnings: [] }, sections: { mergeRequests: { status: 'ready' } } }), origin);
  collectWorkspaceFeedback(center, response, origin);
  assert.equal(center.snapshot().unreadCount, 3, 'warnings returning after a resolved snapshot are shown again');
  assert.equal(center.snapshot().items.length, 6);
});

test('adapter feedback preserves the original asynchronous operation origin after the live account changes', async () => {
  const center = new NotificationCenter();
  const currentOrigin = { ...origin };
  let resume!: () => void;
  const pending = center.run({ operationId: 'original-operation', title: '原工作區操作', origin: currentOrigin }, async () => {
    await new Promise<void>(resolve => { resume = resolve; });
    collectWorkspaceFeedback(center, { type: 'error', message: 'Original read failed' }, currentOrigin);
    collectWorkspaceFeedback(center, { type: 'message', message: 'Original result retained' }, currentOrigin);
  });
  currentOrigin.accountId = 'account-two'; currentOrigin.groupId = 8; currentOrigin.root = 'C:/workspace-two';
  resume(); await pending;
  const snapshot = center.snapshot();
  assert.equal(snapshot.items.length, 1); assert.equal(snapshot.items[0].operationId, 'original-operation');
  assert.deepEqual(snapshot.items[0].origin, origin);
  assert.deepEqual(snapshot.items[0].messages, ['Original read failed', 'Original result retained']);
});

test('Board, Skills and unavailable Git states reach the center while root-identification progress stays quiet', () => {
  const center = new NotificationCenter();
  collectWorkspaceFeedback(center, snapshotResponse({ workspaceRootError: '正在辨識目前 VSCode 工作區…', cloneRootError: '正在辨識專案下載／更新位置…' }), origin);
  assert.equal(center.snapshot().items.length, 0);
  const response = snapshotResponse({
    issueBoardContent: { boardId: 1, connectedScope: 'scope', status: 'error', issueIds: [], error: 'Board unavailable' },
    workflowKit: { status: 'error', message: 'Skills status failed' },
    workflowKitInstallTarget: { manual: false, state: { status: 'error', message: 'Skills status failed' } }
  });
  collectWorkspaceFeedback(center, response, origin);
  collectWorkspaceFeedback(center, { type: 'gitRepositories', repositories: [], revision: 1, available: false, message: 'Git is disabled' }, origin);
  assert.equal(center.snapshot().items.length, 3);
  const revision = center.snapshot().revision;
  collectWorkspaceFeedback(center, response, origin);
  collectWorkspaceFeedback(center, { type: 'gitRepositories', repositories: [], revision: 1, available: false, message: 'Git is disabled' }, origin);
  assert.equal(center.snapshot().revision, revision);
  assert.ok(center.snapshot().items.every(item => item.level === 'error'));
});

test('Issue section refresh failures after a confirmed write remain warnings and merge with the terminal receipt', () => {
  const center = new NotificationCenter();
  collectWorkspaceFeedback(center, issueResponse({ type: 'detailPatch', issueId: 101, operationId: 'applied', effect: 'applied',
    patch: { loadErrors: { activity: 'Activity unavailable' } } }), origin, 'applied');
  center.recordOperation({ requestId: 'applied', scopeRevision: 'scope', resourceKey: 'issue:1:2', action: 'issueRequest', label: '更新 Issue',
    status: 'succeeded', phase: '已更新，重新載入失敗', startedAt: 1, effect: 'applied', refreshError: 'Activity unavailable' });
  const items = center.snapshot().items;
  assert.equal(items.length, 1); assert.equal(items[0].level, 'warn'); assert.equal(items[0].messages.length, 1);
});
