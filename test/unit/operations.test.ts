import assert from 'node:assert/strict';
import test from 'node:test';
import { OperationTracker, type WorkspaceOperationState } from '../../src/workspace/operations';

const state = (requestId: string, resourceKey = 'skills'): WorkspaceOperationState => ({ requestId, resourceKey,
  scopeRevision: 'root-a', action: 'copySkillGuidePrompt', label: '複製提示詞', status: 'queued', phase: '驗證中', startedAt: Date.now() });

test('a thrown unknown write retains its resource lock and the original effect', async () => {
  const tracker = new OperationTracker(); let writes = 0;
  await assert.rejects(tracker.run({ ...state('uncertain'), kind: 'write' }, async () => {
    writes++; throw Object.assign(new Error('write timed out after dispatch'), { effect: 'unknown' });
  }), /timed out/);
  assert.equal(tracker.get('uncertain')?.effect, 'unknown');
  await tracker.run({ ...state('second'), kind: 'write' }, async () => { writes++; });
  assert.equal(writes, 1);
});

test('human result confirmation cannot release a resource while its original adapter is running', async () => {
  for (const confirmation of ['resolve', 'recover'] as const) {
    const tracker = new OperationTracker(); let release!: () => void, writes = 0;
    const pending = tracker.run({ ...state('active'), kind: 'write' }, async () => {
      writes++; await new Promise<void>(resolve => { release = resolve; }); return { status: 'failed', effect: 'unknown' };
    });
    try {
      tracker.noteOutcome('active', { effect: 'unknown' });
      if (confirmation === 'resolve') tracker.resolveUnknown('active', { effect: 'applied' });
      else tracker.recoverConfirmed(tracker.get('active')!, { effect: 'applied' });
      assert.equal(tracker.get('active')?.status, 'running');
      await tracker.run({ ...state('conflict'), kind: 'write' }, async () => { writes++; });
      assert.equal(writes, 1, 'the original running write must still own the lock');
    } finally { release(); await pending; }
    assert.equal(tracker.get('active')?.effect, 'unknown');
    await tracker.run({ ...state('after'), kind: 'write' }, async () => { writes++; });
    assert.equal(writes, 1, 'a terminal unknown result remains locked until a new explicit confirmation');
  }
});

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
