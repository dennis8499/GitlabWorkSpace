import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { CodexUiDraftStore } from '../../src/codex/uiDraftStore';
import { CodexDraftNamespaces } from '../../src/codex/draftNamespaces';
import type { CodexUiDraftEntry } from '../../src/codex/uiDraftProtocol';

async function fixture(t: test.TestContext) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'glw-namespaces-')); t.after(() => rm(root, { recursive: true, force: true }));
  const store = new CodexUiDraftStore(path.join(root, 'drafts')), local = 'a'.repeat(64), first = 'b'.repeat(64), second = 'c'.repeat(64), legacy = 'd'.repeat(64);
  const create = (remote = first) => new CodexDraftNamespaces({ store, local, remote, legacy: [legacy], resolve: async entry => {
    const [kind, keyId] = JSON.parse(entry.key), id = kind === 'pending' ? (entry.value as { taskId?: string } | null)?.taskId : keyId;
    if (!id) return;
    return id.startsWith('local') ? 'local' : id === (remote === first ? 'remote-first' : 'remote-second') ? 'remote' : undefined;
  } });
  const entry = (id: string, text: string, revision = 0): CodexUiDraftEntry => ({ key: JSON.stringify(['draft', id]), revision, value: { text, revision: 1 } });
  return { root, store, local, first, second, legacy, create, entry };
}
test('local drafts survive account switches while remote input and CAS versions remain isolated', async t => {
  const f = await fixture(t), first = f.create();
  await first.save(f.local, f.first, [f.entry('local-task', 'local input'), f.entry('remote-first', 'first account')]);
  const second = f.create(f.second), loaded = await second.read();
  assert.deepEqual(loaded.entries.map(entry => (entry.value as { text: string }).text), ['local input']);
  await second.save(f.local, f.second, [f.entry('local-task', 'changed locally', 1), f.entry('remote-second', 'second account')]);
  assert.deepEqual((await first.read()).entries.map(entry => (entry.value as { text: string }).text), ['changed locally', 'first account']);
  await assert.rejects(second.save(f.local, f.first, [f.entry('remote-second', 'stale owner', 1)]), /帳號已變更/);
  assert.equal((await f.store.read(f.second)).entries[0].revision, 1);
  await assert.rejects(second.save('e'.repeat(64), f.second, []), /專案草稿範圍/);
  await assert.rejects(second.save(f.local, f.second, [f.entry('unknown', 'forged')]), /所屬任務/);
});
test('legacy draft migration preserves originals and conflicts and does not resurrect cleared content', async t => {
  const f = await fixture(t);
  await f.store.save(f.legacy, [f.entry('local-task', 'old input')]);
  const original = await readFile(path.join(f.root, 'drafts', f.legacy + '.json'), 'utf8');
  const first = await f.create().read(); assert.equal(first.entries[0].revision, 1);
  await f.create().save(f.local, f.first, [{ ...first.entries[0], value: null }]);
  const reopened = await f.create().read();
  assert.equal(reopened.entries[0].value, null); assert.deepEqual(reopened.conflicts, []);
  assert.equal(await readFile(path.join(f.root, 'drafts', f.legacy + '.json'), 'utf8'), original);
  await f.store.save(f.legacy, [f.entry('local-task', 'another old revision', 1)]);
  const conflicted = await f.create().read(); assert.equal(conflicted.entries[0].value, null);
  assert.equal(conflicted.conflicts.length, 1);
  assert.equal((await f.create().read()).conflicts.length, 1);
});
test('migration and cross-window writes respect global history deletion fences', async t => {
  const f = await fixture(t);
  await f.store.save(f.legacy, [f.entry('local-task', 'retired content')]);
  await f.store.removeTask('local-task');
  assert.deepEqual((await f.create().read()).entries, []);
  const saved = await f.create().save(f.local, f.first, [f.entry('local-task', 'late write')]);
  assert.deepEqual(saved.entries, []); assert.deepEqual(saved.deletedTaskIds, ['local-task']);
});

test('pending receipt tombstones retain their namespace and legacy receipts never become new operations', async t => {
  const f = await fixture(t), key = (id: string) => JSON.stringify(['pending', id]);
  const local = { key: key('local-operation'), revision: 0, value: { taskId: 'local-task', requestId: 'local-operation' } };
  const remote = { key: key('remote-operation'), revision: 0, value: { taskId: 'remote-first', requestId: 'remote-operation' } };
  await f.store.save(f.legacy, [{ ...local, key: key('legacy-operation') }]);
  assert.deepEqual((await f.create().read()).entries, []);
  await f.create().save(f.local, f.first, [local, remote]);
  await assert.rejects(f.create().save(f.local, f.second, [{ ...remote, revision: 1, value: null }]), /帳號已變更/);
  assert.deepEqual((await f.store.read(f.first)).entries[0].value, remote.value);
  await f.create().save(f.local, f.first, [local, remote].map(entry => ({ ...entry, revision: 1, value: null })));
  assert.deepEqual((await f.create().read()).entries.map(entry => entry.value), [null, null]);
  assert.deepEqual((await f.create(f.second).read()).entries.map(entry => entry.value), [null]);
  assert.equal((await f.store.read(f.local)).entries[0].key, local.key);
  assert.equal((await f.store.read(f.first)).entries[0].key, remote.key);
  assert.equal((await f.store.read(f.legacy)).entries[0].key, key('legacy-operation'));
});
