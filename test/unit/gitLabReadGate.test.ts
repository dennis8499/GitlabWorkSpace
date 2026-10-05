import assert from 'node:assert/strict';
import test from 'node:test';
import { GitLabReadGate } from '../../src/api/gitLabReadGate';

test('limits reads to six shared slots and releases each slot after completion', async () => {
  const gate = new GitLabReadGate(6, 1_000);
  let active = 0;
  let peak = 0;
  await Promise.all(Array.from({ length: 18 }, (_, index) => gate.run(undefined, async () => {
    active++;
    peak = Math.max(peak, active);
    await new Promise((resolve) => setTimeout(resolve, index % 3 + 2));
    active--;
  })));
  assert.equal(peak, 6);
  assert.equal(active, 0);
  await gate.run(undefined, async () => assert.equal(active, 0));
});

test('aborts an in-flight read on timeout and does not hold a slot afterward', async () => {
  const gate = new GitLabReadGate(1, 15);
  await assert.rejects(gate.run(undefined, (_signal) => new Promise<void>((_resolve, reject) => {
    _signal.addEventListener('abort', () => reject(_signal.reason), { once: true });
  })), (error: unknown) => error instanceof Error && error.name === 'TimeoutError');
  await gate.run(undefined, async () => undefined);
});

test('cancels queued reads when their connection signal changes', async () => {
  const gate = new GitLabReadGate(1, 1_000);
  const controller = new AbortController();
  let finishFirst: (() => void) | undefined;
  const first = gate.run(undefined, () => new Promise<void>((resolve) => { finishFirst = resolve; }));
  const queued = gate.run(controller.signal, async () => assert.fail('aborted queued read must never start'));
  controller.abort(new Error('connection changed'));
  await assert.rejects(queued, /connection changed/);
  finishFirst?.();
  await first;
  await gate.run(undefined, async () => undefined);
});
