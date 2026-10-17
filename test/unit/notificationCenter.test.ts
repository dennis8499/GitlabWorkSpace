import assert from 'node:assert/strict';
import test from 'node:test';
import { NotificationCenter } from '../../src/notifications/notificationCenter';

test('replaying a removed terminal receipt does not recreate its notification', () => {
  const center = new NotificationCenter();
  const state = { requestId: 'receipt', scopeRevision: 'a', resourceKey: 'repo', action: 'write', label: 'Write', status: 'succeeded' as const, phase: 'Done', startedAt: 1 };
  center.recordOperation(state); center.remove('operation:receipt');
  center.recordOperation({ ...state, revision: 99 }); assert.equal(center.snapshot().items.length, 0);
});

test('a session retains 500 sanitized notices and a new activation starts empty', () => {
  const center = new NotificationCenter();
  for (let index = 0; index < 501; index++) center.publish({ message: `Notice ${index}` });
  const snapshot = center.snapshot();
  assert.equal(snapshot.items.length, 500); assert.equal(snapshot.unreadCount, 500);
  assert.equal(snapshot.items[0].messages[0], 'Notice 500');
  assert.equal(snapshot.items.at(-1)?.messages[0], 'Notice 1');
  center.publish({ level: 'error', message: 'Authorization: Bearer secret glpat-abcdefgh https://user:pass@gitlab.test' });
  assert.doesNotMatch(center.snapshot().items[0].messages[0], /secret|abcdefgh|user:pass/);
  const restarted = new NotificationCenter();
  assert.notEqual(restarted.sessionId, snapshot.sessionId); assert.equal(restarted.snapshot().items.length, 0);
});

test('concurrent operations retain their starting origin and merge duplicate result receipts', async () => {
  const center = new NotificationCenter(), origin = { accountId: 'one', groupId: 1, root: 'C:/one' };
  let resume!: () => void;
  const waiting = center.run({ operationId: 'first', title: 'Push', origin }, async () => {
    await new Promise<void>(resolve => { resume = resolve; });
    center.publish({ message: 'Pushed' });
    center.recordOperation({ requestId: 'first', scopeRevision: 'old', resourceKey: 'repo', action: 'push', label: 'Push',
      status: 'succeeded', phase: '已完成', startedAt: 1 });
  });
  origin.accountId = 'two'; origin.root = 'C:/two';
  await center.run({ operationId: 'second', title: 'Copy', origin }, async () => center.publish({ message: 'Copied' }));
  resume(); await waiting;
  assert.equal(center.snapshot().items.length, 2);
  const first = center.snapshot().items.find(item => item.operationId === 'first')!;
  assert.equal(first.origin?.accountId, 'one'); assert.equal(first.origin?.root, 'C:/one');
  const revision = center.snapshot().revision;
  center.publish({ operationId: 'first', message: 'Pushed' });
  assert.equal(center.snapshot().revision, revision);
  center.markRead([first.id]);
  center.publish({ operationId: 'first', message: 'Pushed' });
  assert.equal(center.snapshot().items.find(item => item.id === first.id)?.read, true);
  center.publish({ operationId: 'first', level: 'error', message: 'Remote verification failed' });
  center.publish({ operationId: 'first', message: 'Saved local receipt' });
  const updated = center.snapshot().items[0];
  assert.equal(updated.level, 'error'); assert.equal(updated.read, false); assert.equal(updated.messages.length, 3);
});

test('read and clear requests preserve messages that arrived after their snapshot', () => {
  const center = new NotificationCenter();
  center.publish({ message: 'First' }); const before = center.snapshot();
  center.publish({ message: 'Second' });
  center.markAllRead(before.revision);
  assert.equal(center.snapshot().unreadCount, 1);
  center.clear(before.revision);
  assert.equal(center.snapshot().items.length, 1); assert.equal(center.snapshot().items[0].messages[0], 'Second');
  const item = center.snapshot().items[0]; center.remove(item.id);
  assert.equal(center.snapshot().unreadCount, 0);
  center.publish({ operationId: 'ongoing', message: 'First phase' });
  const opened = center.snapshot();
  center.publish({ operationId: 'ongoing', message: 'New result after opening details' });
  center.markRead([opened.items[0].id], opened.revision);
  assert.equal(center.snapshot().unreadCount, 1, 'opening older details cannot mark a newly appended message as read');
});

test('snapshots are detached, listeners dispose, and caught failures share the operation entry', async () => {
  const center = new NotificationCenter(); let changes = 0;
  const listener = center.onDidChange(() => changes++);
  await assert.rejects(center.run({ operationId: 'failure', title: 'Clone' }, async () => {
    center.publish({ level: 'error', message: 'Network failed' }); throw new Error('Network failed');
  }), /Network/);
  assert.equal(changes, 1); assert.equal(center.snapshot().items.length, 1);
  const external = center.snapshot(); external.items[0].messages.push('changed'); external.items[0].read = true;
  assert.equal(center.snapshot().items[0].messages.length, 1); assert.equal(center.snapshot().unreadCount, 1);
  listener.dispose(); center.publish({ message: 'Another' }); assert.equal(changes, 1);
});

test('command failures resolve with a center receipt so VS Code does not receive a rejected command', async () => {
  const center = new NotificationCenter();
  const result = await center.runCommand({ operationId: 'command-failure', title: '切換 Group' }, async () => { throw new Error('Access denied'); });
  assert.equal(result, false); assert.equal(center.snapshot().items[0].messages[0], 'Access denied');
  assert.equal(center.snapshot().items[0].level, 'error');
  const successful = await center.runCommand({ operationId: 'command-success', title: '更新 Repo' }, async () => 42);
  assert.equal(successful, 42); assert.equal(center.snapshot().items[0].title, '更新 Repo');
  await center.runCommand({ operationId: 'open-center', title: '訊息中心' }, async () => undefined, false);
  assert.equal(center.snapshot().items.length, 2, 'opening the center does not generate another notification');
});

test('content revisions change only for new published content while read and delete actions advance the snapshot', () => {
  const center = new NotificationCenter();
  center.publish({ operationId: 'first-content', message: 'First result' });
  center.publish({ operationId: 'second-content', message: 'Second result' });
  const initial = center.snapshot();
  const first = initial.items.find(item => item.operationId === 'first-content')!;
  const second = initial.items.find(item => item.operationId === 'second-content')!;
  center.markRead([first.id]);
  assert.ok(center.snapshot().revision > initial.revision);
  assert.equal(center.snapshot().items.find(item => item.id === first.id)?.contentRevision, first.contentRevision);
  center.markAllRead(center.snapshot().revision);
  assert.equal(center.snapshot().unreadCount, 0);
  assert.equal(center.snapshot().items.find(item => item.id === second.id)?.contentRevision, second.contentRevision);
  center.remove(first.id);
  assert.equal(center.snapshot().items[0].contentRevision, second.contentRevision);
  const readRevision = center.snapshot().revision;
  center.publish({ operationId: 'second-content', message: 'Second result' });
  assert.equal(center.snapshot().revision, readRevision);
  assert.equal(center.snapshot().items[0].read, true);
  center.publish({ operationId: 'second-content', message: 'New verification warning', level: 'warn' });
  assert.ok(center.snapshot().items[0].contentRevision > second.contentRevision);
  assert.equal(center.snapshot().items[0].read, false);
});

test('successful quiet reads and cancelled reads stay quiet while failed reads reach the center', () => {
  const center = new NotificationCenter();
  const operation = { requestId: 'quiet-read', scopeRevision: 'scope', resourceKey: 'mr:1:2', action: 'loadMergeRequestSection',
    kind: 'read' as const, label: '載入 MR 差異', notify: false, phase: '已完成', startedAt: 1 };
  center.recordOperation({ ...operation, status: 'succeeded' });
  center.recordOperation({ ...operation, requestId: 'cancelled-read', status: 'cancelled', phase: '讀取已取消' });
  assert.equal(center.snapshot().items.length, 0);
  center.recordOperation({ ...operation, requestId: 'failed-read', status: 'failed', error: 'GitLab API request failed (HTTP 500).' });
  const failed = center.snapshot().items[0];
  assert.equal(center.snapshot().items.length, 1); assert.equal(failed.level, 'error');
  assert.equal(failed.title, '載入 MR 差異'); assert.deepEqual(failed.messages, ['GitLab API request failed (HTTP 500).']);
});

test('an aborted run preserves cancellation and publishes no completion or error notice', async () => {
  const center = new NotificationCenter(); let changes = 0;
  center.onDidChange(() => changes++);
  const aborted = new Error('The view is no longer active.'); aborted.name = 'AbortError';
  await assert.rejects(center.run({ operationId: 'aborted-read', title: '載入差異' }, async () => { throw aborted; }, true), error => error === aborted);
  assert.equal(center.snapshot().items.length, 0); assert.equal(changes, 0);
});

test('a refresh warning augments an existing success and becomes unread even for a quiet operation', () => {
  const center = new NotificationCenter();
  center.publish({ operationId: 'applied-refresh', title: '更新 Issue', message: 'Issue 已更新。' });
  const original = center.snapshot().items[0]; center.markRead([original.id]);
  center.recordOperation({ requestId: 'applied-refresh', scopeRevision: 'scope', resourceKey: 'issue:1:2', action: 'updateIssue',
    label: '更新 Issue', status: 'succeeded', effect: 'applied', notify: false, refreshError: '重新載入逾時。', phase: '已完成', startedAt: 1 });
  const warning = center.snapshot().items[0];
  assert.equal(center.snapshot().items.length, 1); assert.equal(warning.level, 'warn'); assert.equal(warning.read, false);
  assert.equal(warning.messages.length, 2); assert.equal(warning.messages[0], 'Issue 已更新。');
  assert.match(warning.messages[1], /操作已完成.*重新載入逾時/);
  assert.ok(warning.contentRevision > original.contentRevision);
});

test('partially applied outcomes produce warnings with the actual failure text', () => {
  const center = new NotificationCenter();
  center.recordOperation({ requestId: 'partial-update', scopeRevision: 'scope', resourceKey: 'repositories', action: 'clone',
    label: '更新 Repo', status: 'failed', effect: 'partial', notify: false, error: '兩個 Repo 完成，一個 Repo 無法連線。', phase: '部分完成', startedAt: 1 });
  const warning = center.snapshot().items[0];
  assert.equal(warning.level, 'warn'); assert.deepEqual(warning.messages, ['兩個 Repo 完成，一個 Repo 無法連線。']);
});

test('removed and cleared results cannot be resurrected by replayed messages or terminal receipts', () => {
  const center = new NotificationCenter();
  const operation = { requestId: 'dismissed-result', scopeRevision: 'scope', resourceKey: 'repo', action: 'push', label: 'Push',
    status: 'succeeded' as const, effect: 'applied' as const, phase: 'Push completed', startedAt: 1 };
  center.publish({ operationId: operation.requestId, message: 'Pushed successfully' });
  center.recordOperation(operation); center.remove(`operation:${operation.requestId}`);
  const removedRevision = center.snapshot().revision;
  center.publish({ operationId: operation.requestId, message: 'Pushed successfully' });
  center.recordOperation({ ...operation, revision: 20 });
  assert.equal(center.snapshot().items.length, 0); assert.equal(center.snapshot().revision, removedRevision);
  center.publish({ operationId: 'cleared-result', message: 'Copied successfully' });
  center.clear(center.snapshot().revision);
  center.publish({ operationId: 'cleared-result', message: 'Copied successfully' });
  assert.equal(center.snapshot().items.length, 0);
});

test('state warning snapshots publish once per transition and return after resolution', () => {
  const center = new NotificationCenter(); let changes = 0;
  center.onDidChange(() => changes++);
  const warning = { level: 'warn' as const, title: 'MR 差異', message: '已改用相容差異 API。' };
  center.publishState('mr:1:2:diffs', warning);
  const original = center.snapshot();
  for (let index = 0; index < 5; index++) center.publishState('mr:1:2:diffs', { ...warning });
  assert.equal(center.snapshot().revision, original.revision); assert.equal(changes, 1);
  center.remove(original.items[0].id);
  center.publishState('mr:1:2:diffs', warning);
  assert.equal(center.snapshot().items.length, 0, 'an unchanged snapshot does not undo dismissal');
  center.publishState('mr:1:2:diffs');
  center.publishState('mr:1:2:diffs', warning);
  assert.equal(center.snapshot().items.length, 1); assert.equal(center.snapshot().unreadCount, 1);
  assert.notEqual(center.snapshot().items[0].id, original.items[0].id);
});
