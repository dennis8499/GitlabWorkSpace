import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import { deleteCodexHistories, type CodexHistoryDeletionOptions } from '../../src/codex/historyHostActions';
import { isWorkspaceRequest } from '../../src/workspace/workspaceRequestValidation';
import { describeAction } from '../../src/workspace/actionPolicy';

function fixture() {
  const deleted: string[] = [], previews: string[] = [], confirmations: Array<{ message: string; detail: string }> = [];
  const failures = new Map<string, string>(), fences = new Map<string, 'pending' | 'deleted'>();
  let approved = true, scope = 'original', expected = scope;
  const options: CodexHistoryDeletionOptions = {
    bridge: { initialize: async () => {}, list: () => [{ id: 'one', title: 'First task' }, { id: 'two', title: 'Second task' }],
      results: { directory: path.resolve('fixture-results') }, historyDeletion: (id: string) => fences.get(id),
      deleteHistory: async (id: string) => { if (failures.has(id)) throw new Error(failures.get(id)); deleted.push(id); fences.set(id, 'deleted'); }
    } as unknown as CodexHistoryDeletionOptions['bridge'],
    confirm: async (message, detail) => { confirmations.push({ message, detail }); return approved; },
    check: () => { if (scope !== expected) throw new Error('scope changed'); }, beforeDelete: id => { previews.push(id); }
  };
  return { options, deleted, previews, confirmations, failures, fences, cancel: () => { approved = false; }, drift: () => { scope = 'changed'; },
    acceptScope: () => { expected = scope; } };
}

test('history batch asks once, deduplicates tasks and preserves the documented result location', async () => {
  const f = fixture(), result = await deleteCodexHistories(['one', 'two', 'one'], f.options);
  assert.deepEqual(result, { deletedTaskIds: ['one', 'two'], failures: [] });
  assert.deepEqual(f.deleted, ['one', 'two']); assert.deepEqual(f.previews, ['one', 'two']);
  assert.equal(f.confirmations.length, 1); assert.match(f.confirmations[0].message, /2 筆/);
  assert.match(f.confirmations[0].detail, /First task[\s\S]*Second task/);
  assert.ok(f.confirmations[0].detail.includes(path.resolve('fixture-results')));
  assert.match(f.confirmations[0].detail, /保留專案程式碼/); assert.match(f.confirmations[0].detail, /外部或共用的 Codex 對話不會刪除/);
});

test('cancelled history confirmation does not delete tasks or cancel previews', async () => {
  const f = fixture(); f.cancel();
  assert.deepEqual(await deleteCodexHistories(['one'], f.options), { deletedTaskIds: [], failures: [], cancelled: true });
  assert.deepEqual(f.deleted, []); assert.deepEqual(f.previews, []);
});

test('history batch reports partial failure and retries only retained tasks', async () => {
  const f = fixture(); f.failures.set('one', '停止證據待核對');
  assert.deepEqual(await deleteCodexHistories(['one', 'two'], f.options), {
    deletedTaskIds: ['two'], failures: [{ taskId: 'one', reason: '停止證據待核對' }]
  });
  f.failures.clear();
  assert.deepEqual(await deleteCodexHistories(['one'], f.options), { deletedTaskIds: ['one'], failures: [] });
  assert.deepEqual(f.deleted, ['two', 'one']);
});

test('history deletion rechecks scope after native confirmation and before each item', async () => {
  const f = fixture(); f.options.confirm = async () => { f.drift(); return true; };
  assert.deepEqual(await deleteCodexHistories(['one', 'two'], f.options), {
    deletedTaskIds: [], failures: [{ taskId: 'one', reason: 'scope changed' }, { taskId: 'two', reason: 'scope changed' }]
  });
  assert.deepEqual(f.deleted, []); assert.deepEqual(f.previews, []);
});

test('already deleted history requests are idempotent without another confirmation', async () => {
  const f = fixture(); f.fences.set('one', 'deleted');
  assert.deepEqual(await deleteCodexHistories(['one'], f.options), { deletedTaskIds: ['one'], failures: [] });
  assert.equal(f.confirmations.length, 0); assert.deepEqual(f.deleted, []);
});

test('history requests reject empty unsafe and oversized identities before side effects', async () => {
  for (const ids of [[], ['../other'], ['a'.repeat(101)], Array.from({ length: 1001 }, (_, index) => 'task-' + index)]) {
    const f = fixture(); await assert.rejects(deleteCodexHistories(ids, f.options), /識別無效/);
    assert.equal(f.confirmations.length, 0); assert.deepEqual(f.deleted, []);
  }
  assert.equal(isWorkspaceRequest({ type: 'deleteCodexTasks', taskIds: [] }), false);
  assert.equal(isWorkspaceRequest({ type: 'deleteCodexTasks', taskIds: ['one', 2] }), false);
  assert.equal(isWorkspaceRequest({ type: 'deleteCodexTasks', taskIds: ['one'], extra: true }), false);
  assert.equal(isWorkspaceRequest({ type: 'deleteCodexTasks', taskIds: ['one', 'two'] }), true);
});

test('history batch uses exclusive local admission independently of GitLab account changes', () => {
  const request = { type: 'deleteCodexTasks' as const, taskIds: ['one', 'two'] };
  const a = describeAction(request, { rootKey: 'C:/work', accountKey: 'first' });
  const b = describeAction(request, { rootKey: 'C:/work', accountKey: 'second' });
  assert.equal(a.kind, 'write'); assert.equal(a.concurrency, 'exclusive'); assert.equal(a.resourceKey, 'codex:history');
  assert.equal(a.lockKey, b.lockKey); assert.match(a.lockKey, /^local:/);
});
