import assert from 'node:assert/strict';
import test from 'node:test';
import { IssueTimeTracker } from '../../src/workspace/timeTracker';

const project = { id: 1, path_with_namespace: 'group/project' };
const issue = { iid: 2, title: 'Work' };
function tracker() {
  const values = new Map<string, unknown>();
  return new IssueTimeTracker({ keys: () => [...values.keys()], get: <T>(key: string, fallback?: T): T | undefined => (values.get(key) ?? fallback) as T,
    update: async (key: string, value: unknown) => { values.set(key, value); } });
}

test('capacity rejects new work without deleting running, ready or uncertain time entries', async () => {
  const store = tracker(); await store.setScope('https://gitlab.test', 1);
  const running = await store.start(project, issue);
  for (let index = 0; index < 249; index++) await store.addManual(project, issue, '1m', String(index));
  const before = store.list();
  await assert.rejects(store.addManual(project, issue, '1m', 'overflow'), /250|上限|容量/);
  assert.deepEqual(store.list(), before);
  assert.ok(store.list().some(entry => entry.id === running.id && entry.phase === 'running'));
  const pending = store.list().find(entry => entry.phase === 'ready')!;
  await store.beginSubmit(pending.id); await store.finishSubmit(pending.id, false);
  await assert.rejects(store.addManual(project, issue, '1m', 'overflow'), /250|上限|容量/);
  assert.equal(store.list().find(entry => entry.id === pending.id)?.phase, 'uncertain');
  await store.stop(running.id);
});

test('capacity retires only posted history and rejects invalid dates before changing a time entry', async () => {
  const store = tracker(); await store.setScope('https://gitlab.test', 1);
  const posted = await store.addManual(project, issue, '1m', 'posted');
  await store.beginSubmit(posted.id); await store.finishSubmit(posted.id, true);
  for (let index = 0; index < 250; index++) await store.addManual(project, issue, '1m', String(index));
  assert.equal(store.list().length, 250);
  assert.ok(!store.list().some(entry => entry.id === posted.id));
  await assert.rejects(store.addManual(project, issue, '1m', '', '2026-02-31'), /日期/);
  const entry = store.list()[0], before = store.list();
  await assert.rejects(store.updateEntry(entry.id, '2h', 'changed', '2026-02-31'), /日期/);
  assert.deepEqual(store.list(), before);
});
