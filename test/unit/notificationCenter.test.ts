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
