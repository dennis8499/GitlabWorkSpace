import assert from 'node:assert/strict';
import test from 'node:test';
import { appendFile, mkdtemp, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { OperationTracker, type WorkspaceOperationState } from '../../src/workspace/operations';
import { OperationReceiptFileStore } from '../../src/workspace/operationReceiptStore';

const state = (id: string): WorkspaceOperationState => ({ requestId: id, correlationId: `alias-${id}`, scopeRevision: 'scope', resourceKey: id,
  action: 'write', label: 'Write', phase: '', status: 'queued', startedAt: Date.now(), kind: 'write' });

test('an evicted terminal receipt replays from storage without executing its adapter', async () => {
  const saved = new Map<string, WorkspaceOperationState>();
  const store = { get: async (id: string) => saved.get(id), save: async (receipt: WorkspaceOperationState) => { saved.set(receipt.requestId, receipt); }, flush: async () => {} };
  const Tracker = OperationTracker as unknown as new (publish: undefined, options: unknown) => OperationTracker;
  const first = new Tracker(undefined, { store, historyLimit: 2 });
  let writes = 0;
  for (let index = 0; index < 5; index++) await first.run(state(String(index)), async () => { writes++; });
  const next = new Tracker(undefined, { store, historyLimit: 2 });
  await next.run(state('0'), async () => { writes++; });
  assert.equal(writes, 5, 'a new host must obtain the old terminal receipt from its store');
  assert.ok((first as unknown as { states: Map<string, unknown> }).states.size <= 2);
  const snapshot = await first.snapshotWithStored(undefined, ['0', 'missing']);
  assert.ok(snapshot.operations.some(receipt => receipt.requestId === '0'));
  assert.deepEqual(snapshot.missingIds, ['missing']);
  assert.ok((first as unknown as { states: Map<string, unknown> }).states.size <= 2, 'disk reconciliation must not import unbounded history');
});

test('disk receipts reload exact IDs and correlations while the cache remains bounded', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'workspace-receipts-'));
  try {
    const first = new OperationReceiptFileStore(root);
    for (let index = 0; index < 150; index++) await first.save({ ...state(String(index)), status: 'succeeded', effect: 'applied' });
    assert.ok((first as unknown as { cache: Map<string, unknown> }).cache.size <= 128);
    const next = new OperationReceiptFileStore(root);
    assert.equal((await next.get('0'))?.requestId, '0');
    assert.equal((await next.get('alias-0'))?.effect, 'applied');
    assert.equal(await next.get('not-present'), undefined);
    const files = await readdir(root); assert.ok(files.length <= 256);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('an unreadable receipt bucket blocks adapter execution instead of assuming the ID is new', async () => {
  let writes = 0;
  const tracker = new OperationTracker(undefined, { store: { get: async () => { throw new Error('disk offline'); }, save: async () => {} } });
  await tracker.run(state('unverified'), async () => { writes++; });
  assert.equal(writes, 0); assert.equal(tracker.get('unverified')?.effect, 'unknown');
  let reads = 0;
  await tracker.run({ ...state('readable'), kind: 'read' }, async () => { reads++; });
  assert.equal(reads, 1, 'receipt storage failures must not disable read-only features');
});

test('a truncated receipt bucket is rejected and failed persistence never evicts the in-memory receipt', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'workspace-receipt-corrupt-'));
  try {
    const store = new OperationReceiptFileStore(root); await store.initialize();
    const filename = (store as unknown as { filename(id: string): string }).filename('partial');
    await appendFile(filename, '{"id":"partial",');
    await assert.rejects(store.get('partial'), /不完整/);
    let warnings = 0;
    const tracker = new OperationTracker(undefined, { historyLimit: 1, store: { get: async () => undefined, save: async () => { throw new Error('disk full'); } }, onStoreError: () => { warnings++; } });
    for (let index = 0; index < 3; index++) await tracker.run(state(String(index)), async () => {});
    assert.equal(warnings, 1);
    assert.ok(tracker.get('0'), 'a receipt cannot be evicted until saving succeeds');
    let repeated = false; await tracker.run(state('0'), async () => { repeated = true; }); assert.equal(repeated, false);
    await tracker.flush();
  } finally { await rm(root, { recursive: true, force: true }); }
});
