import assert from 'node:assert/strict';
import test from 'node:test';
import { ActionController } from '../../src/workspace/actionController';
import { dispatchWithFeedback, reportLocalFeedback } from '../../src/webview/notificationFeedback';

test('blocked feedback is published once and preserves inline text without sending another action', () => {
  const requests: any[] = [], inline: string[] = [];
  const actions = new ActionController(request => requests.push(request));
  actions.setContext({ scopeRevision: 'accounts', scopeEpoch: 3 });
  dispatchWithFeedback(actions, { type: 'submitAccountLogin', requestId: 'first', baseUrl: 'https://gitlab.test', token: 'private-first' });
  const result = dispatchWithFeedback(actions, { type: 'submitAccountLogin', requestId: 'second', baseUrl: 'https://gitlab.test', token: 'private-second' },
    { title: '帳號與連線', onBlocked: message => inline.push(message), context: { operationScope: 'accounts', scopeEpoch: 3 } });
  assert.equal(result.status, 'blocked');
  assert.equal(requests.filter(request => request.type === 'submitAccountLogin').length, 1);
  const notices = requests.filter(request => request.type === 'publishNotification');
  assert.equal(notices.length, 1); assert.deepEqual(inline, [notices[0].message]);
  assert.equal(notices[0].title, '帳號與連線'); assert.equal(notices[0].operationScope, 'accounts');
  assert.doesNotMatch(JSON.stringify(notices), /private-first|private-second|token/);
  actions.dispose();
});

test('successful and joined dispatches do not generate local feedback or republish Host results', () => {
  const requests: any[] = [];
  const actions = new ActionController(request => requests.push(request));
  const request = { type: 'copy', text: 'content' };
  assert.equal(dispatchWithFeedback(actions, request).status, 'started');
  assert.equal(dispatchWithFeedback(actions, request).status, 'joined');
  actions.receive({ requestId: requests[0].operationId, action: 'copy', resourceKey: 'clipboard', label: '複製',
    scopeRevision: 'offline:none', status: 'failed', error: 'Host copy failed', phase: '處理失敗', startedAt: 1, revision: 1 });
  assert.equal(requests.filter(value => value.type === 'publishNotification').length, 0);
  actions.dispose();
});

test('local validation sends only the fixed message, and a failed notification bridge preserves inline feedback', () => {
  const requests: unknown[] = [], inline: string[] = [];
  reportLocalFeedback(request => requests.push(request), '請輸入 Personal Access Token。', { title: '帳號與連線', onInline: message => inline.push(message) });
  assert.deepEqual(requests, [{ type: 'publishNotification', level: 'warn', title: '帳號與連線', message: '請輸入 Personal Access Token。' }]);
  reportLocalFeedback(() => { throw new Error('bridge closed'); }, '無法安全產生部分暫存 patch；請改用整檔操作。', { onInline: message => inline.push(message) });
  assert.equal(inline.length, 2);
  reportLocalFeedback(() => assert.fail('blank feedback is ignored'), ' ');
  assert.equal(dispatchWithFeedback({ dispatch: () => ({ status: 'blocked', reason: 'closed' }) },
    { type: 'publishNotification', level: 'warn', message: 'original' }, { publish: () => assert.fail('no recursive feedback') }).status, 'blocked');
});
