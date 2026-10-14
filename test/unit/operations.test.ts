import assert from 'node:assert/strict';
import test from 'node:test';
import { OperationTracker, type WorkspaceOperationState } from '../../src/workspace/operations';

const state = (requestId: string, resourceKey = 'skills'): WorkspaceOperationState => ({ requestId, resourceKey,
  scopeRevision: 'root-a', action: 'copySkillGuidePrompt', label: '複製提示詞', status: 'queued', phase: '驗證中', startedAt: Date.now() });

test('duplicate request IDs execute once and resource conflicts do not launch a second task', async () => {
  const messages: WorkspaceOperationState[] = [], tracker = new OperationTracker(value => messages.push(value));
  let release!: () => void, calls = 0;
  const first = tracker.run(state('one'), async () => { calls++; await new Promise<void>(resolve => { release = resolve; }); });
  const duplicate = tracker.run(state('one'), async () => { calls++; });
  await tracker.run(state('two'), async () => { calls++; });
  assert.equal(messages.find(item => item.requestId === 'two')?.status, 'failed');
  release(); await Promise.all([first, duplicate]);
  await tracker.run(state('one'), async () => { calls++; });
  assert.equal(calls, 1); assert.equal(messages.at(-1)?.status, 'succeeded');
});

test('failure permits an explicit retry, cancellation stays separate, and scopes isolate receipts', async () => {
  const messages: WorkspaceOperationState[] = [], tracker = new OperationTracker(value => messages.push(value));
  await assert.rejects(tracker.run(state('fail'), async () => { throw new Error('integrity changed'); }), /integrity/);
  await tracker.run(state('retry'), async () => {});
  await assert.rejects(tracker.run(state('cancel'), async () => { const error = new Error('cancelled'); error.name = 'AbortError'; throw error; }));
  assert.equal(messages.at(-1)?.status, 'cancelled');
  assert.equal(tracker.list('root-b').length, 0);
  assert.equal(tracker.list('root-a').length, 3);
});
