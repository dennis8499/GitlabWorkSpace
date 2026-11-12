import assert from 'node:assert/strict';
import test from 'node:test';
import { NotificationCenter } from '../../src/notifications/notificationCenter';
import { withNativeCommandFeedback } from '../../src/notifications/nativeCommandFeedback';

test('a native failure opens the Host-owned destination once, without reopening messages', async () => {
  const center = new NotificationCenter(), opened: string[] = [];
  await withNativeCommandFeedback(() => center.runCommand({ operationId: 'task-error', title: 'Task', target: { kind: 'task', taskId: 'task-1' } }, async () => { throw new Error('Task failed'); }), {
    operationId: 'task-error', snapshot: () => center.snapshot(), workbenchVisible: () => false,
    show: async (_level, _message, action) => { assert.equal(action, '開啟任務'); return action; },
    openTarget: async id => { opened.push(id); }, openMessages: async () => assert.fail('Destination action is direct')
  });
  await Promise.resolve();
  assert.deepEqual(opened, ['operation:task-error']);
});

test('a failed native command remains visible without a Webview and only the explicit action opens messages', async () => {
  const center = new NotificationCenter(), shown: string[] = []; let opened = 0;
  center.setSanitizer(message => message.replaceAll('private-token', '[redacted]'));
  const result = await withNativeCommandFeedback(() => center.runCommand({ operationId: 'native-login', title: 'Login' }, async () => { throw new Error('Rejected private-token'); }), {
    operationId: 'native-login', snapshot: () => center.snapshot(), workbenchVisible: () => false,
    show: async (level, message) => { shown.push(level, message); return '開啟訊息中心'; }, openMessages: async () => { opened++; }
  });
  await Promise.resolve();
  assert.equal(result, false); assert.deepEqual(shown, ['error', 'Rejected [redacted]']); assert.equal(opened, 1);
});

test('visible Workbench errors, successful commands and unrelated errors never produce duplicate native notifications', async () => {
  for (const visible of [false, true]) {
    const center = new NotificationCenter(); center.publish({ operationId: 'other', level: 'error', message: 'Old failure' });
    const options = { operationId: 'current', snapshot: () => center.snapshot(), workbenchVisible: () => visible,
      show: async () => { assert.fail('No duplicate notification'); return undefined; }, openMessages: async () => assert.fail('No focus change') };
    assert.equal(await withNativeCommandFeedback(async () => 7, options), 7);
    if (visible) {
      center.publish({ operationId: 'current', level: 'error', message: 'Already visible' });
      assert.equal(await withNativeCommandFeedback(async () => false, options), false);
    }
  }
});

test('recorded domain failures surface even when the native command resolves, and dismissal keeps focus', async () => {
  const center = new NotificationCenter(), shown: string[] = [];
  center.publish({ operationId: 'current', level: 'warn', message: 'Verify the result before retrying' });
  assert.equal(await withNativeCommandFeedback(async () => true, {
    operationId: 'current', snapshot: () => center.snapshot(), workbenchVisible: () => false,
    show: async (level, message) => { shown.push(level, message); return undefined; }, openMessages: async () => assert.fail('Dismissal must not navigate')
  }), true);
  await Promise.resolve(); assert.deepEqual(shown, ['warn', 'Verify the result before retrying']);
});
