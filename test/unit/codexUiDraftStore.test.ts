import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { CodexUiDraftStore } from '../../src/codex/uiDraftStore';

const scope = 'a'.repeat(64), draftKey = (id: string) => JSON.stringify(['draft', id]);
const update = (id: string, revision: number, text: string | null) => ({ key: draftKey(id), revision, value: text === null ? null : { text, revision } });
async function fixture(t: test.TestContext) {
  const parent = await fs.realpath(os.tmpdir()), root = await fs.mkdtemp(path.join(parent, 'codex-ui-drafts-'));
  t.after(async () => {
    assert.equal(path.dirname(await fs.realpath(root)), parent); assert.ok(path.basename(root).startsWith('codex-ui-drafts-'));
    await fs.rm(root, { recursive: true, force: true });
  });
  const directory = path.join(root, 'drafts'), store = new CodexUiDraftStore(directory), file = path.join(directory, scope + '.json');
  return { root, directory, store, file };
}

test('drafts and deletion tombstones survive store recreation without replaying operations', async t => {
  const f = await fixture(t);
  assert.deepEqual(await f.store.read(scope), { scope, entries: [], conflicts: [] });
  const first = await f.store.save(scope, [update('task-a', 0, 'unfinished question')]);
  assert.equal(first.entries[0].revision, 1);
  const reopened = new CodexUiDraftStore(f.directory); assert.deepEqual(await reopened.read(scope), first);
  const deleted = await reopened.save(scope, [update('task-a', 1, null)]);
  assert.deepEqual(deleted.entries[0], { key: draftKey('task-a'), revision: 2, value: null });
  assert.deepEqual(await new CodexUiDraftStore(f.directory).read(scope), deleted);
  const stale = await f.store.save(scope, [update('task-a', 1, 'old window')]);
  assert.deepEqual(stale.entries, deleted.entries); assert.equal(stale.conflicts[0].value && (stale.conflicts[0].value as { text: string }).text, 'old window');
});

test('independent instances merge unrelated entries and retain stale local drafts as durable conflicts', async t => {
  const f = await fixture(t), other = new CodexUiDraftStore(f.directory);
  await Promise.all([f.store.save(scope, [update('task-a', 0, 'A')]), other.save(scope, [update('task-b', 0, 'B')])]);
  assert.equal((await f.store.read(scope)).entries.length, 2);
  const winner = await f.store.save(scope, [update('task-a', 1, 'newer edit')]);
  const conflict = await other.save(scope, [update('task-a', 1, 'stale local edit')]);
  assert.deepEqual(conflict.entries, winner.entries); assert.equal(conflict.conflicts.length, 1);
  assert.deepEqual(Object.keys(conflict.conflicts[0]).sort(), ['createdAt', 'id', 'key', 'value']);
  assert.deepEqual(await new CodexUiDraftStore(f.directory).read(scope), conflict);
  assert.deepEqual(await other.save(scope, [update('task-a', 1, 'stale local edit')]), conflict, 'retry keeps one recoverable local copy');
  const staleDelete = await other.save(scope, [update('task-a', 1, null)]);
  assert.deepEqual(staleDelete.entries, winner.entries); assert.equal(staleDelete.conflicts.length, 2);
  assert.deepEqual(await new CodexUiDraftStore(f.directory).read(scope), staleDelete);
});

test('100 concurrent same-entry CAS saves retain exactly one winner and all 99 distinct losing drafts', { timeout: 30_000 }, async t => {
  const f = await fixture(t), other = new CodexUiDraftStore(f.directory);
  await Promise.all([f.store.save(scope, [update('unrelated-a', 0, 'A')]), other.save(scope, [update('unrelated-b', 0, 'B')])]);
  const results = await Promise.all(Array.from({ length: 100 }, (_, i) => (i % 2 ? other : f.store).save(scope, [update('racing-task', 0, `local draft ${i}`)])));
  const saved = await new CodexUiDraftStore(f.directory).read(scope), winner = saved.entries.find(entry => entry.key === draftKey('racing-task'))!;
  assert.equal(results.length, 100); assert.equal(winner.revision, 1); assert.equal(saved.entries.length, 3); assert.equal(saved.conflicts.length, 99);
  const copies = [winner.value, ...saved.conflicts.map(conflict => conflict.value)].map(value => (value as { text: string }).text);
  assert.deepEqual(new Set(copies), new Set(Array.from({ length: 100 }, (_, i) => `local draft ${i}`)));
  assert.equal(new Set(saved.conflicts.map(conflict => conflict.id)).size, 99);
  const edited = await f.store.save(scope, [update('racing-task', 1, 'newer unsent edit')]);
  const staleClear = await other.save(scope, [update('racing-task', 1, null)]);
  assert.deepEqual(staleClear.entries, edited.entries); assert.equal(staleClear.conflicts.length, 100);
  assert.deepEqual(await new CodexUiDraftStore(f.directory).read(scope), staleClear);
  t.diagnostic(JSON.stringify({ casAttempts: results.length, winners: 1, retainedDistinctLocalCopies: copies.length, durableConflicts: saved.conflicts.length, staleClearPreservedNewerEdit: true }));
});

test('only a current revision update can resolve conflicts belonging to that same entry', async t => {
  const f = await fixture(t);
  await f.store.save(scope, [update('task-a', 0, 'winner'), update('task-b', 0, 'other')]);
  const rejected = await f.store.save(scope, [update('task-a', 0, 'local')]);
  const id = rejected.conflicts[0].id, current = rejected.entries.find(entry => entry.key === draftKey('task-a'))!;
  for (const updates of [[], [update('task-b', 1, 'changed')], [{ ...current, revision: 0 }]]) {
    assert.equal((await f.store.save(scope, updates, [id])).conflicts.length, 1);
  }
  const resolved = await f.store.save(scope, [current], [id]);
  assert.equal(resolved.conflicts.length, 0); assert.deepEqual(resolved.entries.find(entry => entry.key === current.key), current, 'use saved is an idempotent current-version no-op');
  const again = await f.store.save(scope, [update('task-a', 0, 'restore this local copy')]);
  const restored = await f.store.save(scope, [{ key: current.key, revision: current.revision, value: again.conflicts[0].value }], [again.conflicts[0].id]);
  assert.equal(restored.conflicts.length, 0); assert.equal(restored.entries.find(entry => entry.key === current.key)?.revision, 2);
});

test('idempotent values accept different object field order and never advance revisions', async t => {
  const f = await fixture(t), saved = await f.store.save(scope, [{ key: draftKey('a'), revision: 0, value: { b: 2, a: 1 } }]);
  for (const revision of [0, 1, 20]) {
    assert.deepEqual(await f.store.save(scope, [{ key: draftKey('a'), revision, value: { a: 1, b: 2 } }]), saved);
  }
});

test('separate Node processes preserve concurrent independent drafts through the storage control lease', { timeout: 20_000 }, async t => {
  const f = await fixture(t);
  const childScript = `const {CodexUiDraftStore}=require(process.argv[1]); const s=new CodexUiDraftStore(process.argv[2]);
    (async()=>{ for(let i=0;i<8;i++) await s.save(process.argv[3],[{key:JSON.stringify(['draft',process.argv[4]+i]),revision:0,value:{text:'saved'}}]); })().catch(e=>{console.error(e);process.exitCode=1});`;
  const writer = (prefix: string) => new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, ['-e', childScript, require.resolve('../../src/codex/uiDraftStore'), f.directory, scope, prefix], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = ''; child.stderr.on('data', chunk => { stderr += String(chunk); }); child.once('error', reject);
    child.once('close', code => code === 0 ? resolve() : reject(new Error(`Draft writer exited ${code}: ${stderr}`)));
    t.after(() => { if (child.exitCode === null) child.kill(); });
  });
  await Promise.all([writer('left-'), writer('right-')]);
  const saved = await f.store.read(scope); assert.equal(saved.entries.length, 16); assert.equal(saved.conflicts.length, 0);
  assert.equal(new Set(saved.entries.map(entry => entry.key)).size, 16);
});

test('entry and conflict caps reject atomically while preserving every existing value', async t => {
  const f = await fixture(t);
  await f.store.save(scope, Array.from({ length: 1000 }, (_, i) => update(`task-${i}`, 0, 'winner')));
  let before = await fs.readFile(f.file);
  await assert.rejects(f.store.save(scope, [update('overflow', 0, 'extra')])); assert.deepEqual(await fs.readFile(f.file), before);
  const conflicts = await f.store.save(scope, Array.from({ length: 200 }, (_, i) => update(`task-${i}`, 0, 'local')));
  assert.equal(conflicts.conflicts.length, 200); before = await fs.readFile(f.file);
  await assert.rejects(f.store.save(scope, [update('task-200', 0, 'extra conflict')])); assert.deepEqual(await fs.readFile(f.file), before);
  assert.deepEqual(await f.store.read(scope), conflicts);
});

test('JSON size and lossless validation failures preserve saved content', async t => {
  const f = await fixture(t); await f.store.save(scope, [update('saved', 0, 'keep')]); const before = await fs.readFile(f.file);
  const cyclic: Record<string, unknown> = {}; cyclic.self = cyclic;
  for (const value of ['x'.repeat(8 * 1024 * 1024), undefined, NaN, Infinity, BigInt(1), new Date(), cyclic, { text: undefined }, [undefined]]) {
    await assert.rejects(f.store.save(scope, [{ key: draftKey('bad'), revision: 0, value }])); assert.deepEqual(await fs.readFile(f.file), before);
  }
  for (const revision of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1]) {
    await assert.rejects(f.store.save(scope, [{ key: draftKey('bad'), revision, value: 'bad' }])); assert.deepEqual(await fs.readFile(f.file), before);
  }
  for (const invalidScope of ['../escape', 'A'.repeat(64), 'a'.repeat(63)]) await assert.rejects(f.store.read(invalidScope));
  await assert.rejects(f.store.save(scope, [{ key: '["unknown","a"]', revision: 0, value: 'bad' }]));
  await assert.rejects(f.store.save(scope, [update('a', 0, '1'), update('a', 0, '2')]));
});

test('malformed and oversized stored files are never replaced by a later save', async t => {
  const f = await fixture(t); await f.store.read(scope);
  for (const content of ['{', '{}', JSON.stringify({ schema: 'other', scope, entries: [], conflicts: [] }), 'x'.repeat(8 * 1024 * 1024 + 1)]) {
    await fs.writeFile(f.file, content); const before = await fs.readFile(f.file);
    await assert.rejects(f.store.read(scope)); await assert.rejects(f.store.save(scope, [update('new', 0, 'must not overwrite')]));
    assert.deepEqual(await fs.readFile(f.file), before);
  }
});

test('redirected draft storage is rejected without replacing the link or outside data', async t => {
  const f = await fixture(t), external = path.join(f.root, 'external'); await fs.mkdir(external);
  const outsideFile = path.join(external, scope + '.json'); await fs.writeFile(outsideFile, 'outside original');
  await fs.symlink(external, f.directory, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(f.store.read(scope)); await assert.rejects(f.store.save(scope, [update('new', 0, 'bad')]));
  assert.equal((await fs.lstat(f.directory)).isSymbolicLink(), true); assert.equal(await fs.readFile(outsideFile, 'utf8'), 'outside original');
  await fs.unlink(f.directory); await fs.mkdir(f.directory);
  await fs.symlink(external, f.file, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(f.store.read(scope)); await assert.rejects(f.store.save(scope, [update('new', 0, 'bad')]));
  assert.equal((await fs.lstat(f.file)).isSymbolicLink(), true); assert.equal(await fs.readFile(outsideFile, 'utf8'), 'outside original');
});

test('task deletion clears all scopes and conflicts while fencing stale windows and new scopes', async t => {
  const f = await fixture(t), otherScope = 'b'.repeat(64), taskId = 'task-delete', pair = JSON.stringify([taskId, 'question']);
  const related = [
    { key: draftKey(taskId), revision: 0, value: { text: 'main draft' } },
    { key: JSON.stringify(['reading', taskId]), revision: 0, value: { top: 10, follow: false } },
    { key: JSON.stringify(['view', taskId]), revision: 0, value: 'results' },
    { key: JSON.stringify(['interaction', pair]), revision: 0, value: { taskId, values: { answer: 'unfinished answer' } } },
    { key: JSON.stringify(['submission', pair]), revision: 0, value: { taskId, requestId: 'answer-receipt' } },
    { key: JSON.stringify(['reply', pair]), revision: 0, value: { taskId, text: 'unfinished GitLab reply' } },
    { key: JSON.stringify(['pending', 'send-receipt']), revision: 0, value: { taskId, text: 'unconfirmed send' } },
    { key: JSON.stringify(['selection', 'current']), revision: 0, value: taskId },
  ];
  for (const selectedScope of [scope, otherScope]) {
    await f.store.save(selectedScope, [...related, update('unrelated', 0, 'keep')]);
    await f.store.save(selectedScope, [update(taskId, 0, 'also remove this local conflict')]);
  }
  await new CodexUiDraftStore(f.directory).removeTask(taskId);
  for (const selectedScope of [scope, otherScope]) {
    const saved = await f.store.read(selectedScope); assert.deepEqual(saved.entries.map(entry => entry.key), [draftKey('unrelated')]); assert.equal(saved.conflicts.length, 0);
  }
  for (const stale of related) {
    const rejected = await f.store.save(scope, [stale]); assert.deepEqual(rejected.deletedTaskIds, [taskId]);
    assert.deepEqual(rejected.entries.map(entry => entry.key), [draftKey('unrelated')]);
  }
  const unopenedScope = 'c'.repeat(64);
  const rejected = await new CodexUiDraftStore(f.directory).save(unopenedScope, [update(taskId, 0, 'resurrection')]);
  assert.deepEqual(rejected.deletedTaskIds, [taskId]); assert.equal(rejected.entries.length, 0);
  assert.deepEqual(await f.store.read(unopenedScope), { scope: unopenedScope, entries: [], conflicts: [] });
  await f.store.removeTask(taskId); await f.store.save(scope, [update('unrelated', 1, 'still editable')]);
});

test('task deletion and a concurrent first save cannot leave a resurrected draft', async t => {
  const f = await fixture(t), other = new CodexUiDraftStore(f.directory);
  const results = await Promise.allSettled([f.store.removeTask('racing-delete'), other.save(scope, [update('racing-delete', 0, 'old window')])]);
  assert.equal(results[0].status, 'fulfilled'); assert.equal((await f.store.read(scope)).entries.length, 0);
  const rejected = await other.save('d'.repeat(64), [update('racing-delete', 0, 'later window')]);
  assert.deepEqual(rejected.deletedTaskIds, ['racing-delete']); assert.equal(rejected.entries.length, 0);
});

test('clearing a deleted task and selecting a new task does not block unrelated draft saves', async t => {
  const f = await fixture(t), selectionKey = JSON.stringify(['selection', 'current']);
  await f.store.save(scope, [update('deleted', 0, 'remove'), { key: selectionKey, revision: 0, value: 'deleted' }]);
  await f.store.removeTask('deleted');
  const saved = await f.store.save(scope, [update('deleted', 1, null), update('other', 0, 'new edit'), { key: selectionKey, revision: 0, value: 'other' }]);
  assert.equal(saved.entries.some(entry => entry.key === draftKey('deleted')), false);
  assert.equal(saved.entries.find(entry => entry.key === selectionKey)?.value, 'other');
  assert.deepEqual(saved.entries.find(entry => entry.key === draftKey('other'))?.value, { text: 'new edit', revision: 0 });
  assert.equal(saved.conflicts.length, 0); assert.deepEqual(saved.deletedTaskIds, ['deleted']);
  assert.deepEqual(await f.store.read(scope), { scope, entries: saved.entries, conflicts: saved.conflicts });
});

test('deleted incoming edits return only caller-known tombstones and do not block unrelated saves or replace selection', async t => {
  const f = await fixture(t), selectionKey = JSON.stringify(['selection', 'current']);
  assert.equal(await f.store.isTaskDeleted('deleted'), false);
  await f.store.removeTask('deleted'); await f.store.removeTask('another-scope-private-task');
  assert.equal(await new CodexUiDraftStore(f.directory).isTaskDeleted('deleted'), true);
  await f.store.save(scope, [{ key: selectionKey, revision: 0, value: 'other' }]);
  const saved = await f.store.save(scope, [update('deleted', 0, 'stale unsent text'), update('other', 0, 'keep new edit'), { key: selectionKey, revision: 0, value: 'deleted' }]);
  assert.deepEqual(saved.deletedTaskIds, ['deleted']); assert.equal(saved.entries.some(entry => entry.key === draftKey('deleted')), false);
  assert.equal(saved.entries.find(entry => entry.key === selectionKey)?.value, 'other');
  assert.deepEqual(saved.entries.find(entry => entry.key === draftKey('other'))?.value, { text: 'keep new edit', revision: 0 });
  assert.equal(saved.conflicts.length, 0);
  const persisted = JSON.parse(await fs.readFile(f.file, 'utf8'));
  assert.deepEqual(Object.keys(persisted).sort(), ['conflicts', 'entries', 'schema', 'scope']);
  assert.deepEqual(await new CodexUiDraftStore(f.directory).read(scope), { scope, entries: saved.entries, conflicts: saved.conflicts });
  assert.equal((await f.store.save(scope, [])).deletedTaskIds, undefined, 'empty saves do not enumerate deletion markers');
  await assert.rejects(f.store.isTaskDeleted('')); await assert.rejects(f.store.isTaskDeleted('x'.repeat(161)));
});

test('a persisted deletion fence recovers interrupted cleanup of all same-task fields when one stale field is saved', async t => {
  const f = await fixture(t), taskId = 'interrupted-delete', pair = JSON.stringify([taskId, 'question']);
  const selectionKey = JSON.stringify(['selection', 'current']);
  await f.store.save(scope, [update(taskId, 0, 'old main'), update('other', 0, 'keep'),
    { key: JSON.stringify(['reading', taskId]), revision: 0, value: { top: 10, follow: false } },
    { key: JSON.stringify(['interaction', pair]), revision: 0, value: { taskId, values: { answer: 'old answer' } } },
    { key: JSON.stringify(['pending', 'old-receipt']), revision: 0, value: { taskId, text: 'old pending' } },
    { key: selectionKey, revision: 0, value: taskId },
  ]);
  await f.store.save(scope, [update(taskId, 0, 'old local conflict')]);
  // Model a stop immediately after removeTask's atomic marker write, before cleanup.
  const task = createHash('sha256').update(taskId).digest('hex');
  await fs.writeFile(path.join(f.directory, 'deleted-' + task + '.json'), JSON.stringify({ schema: 'GitLabWorkspaceCodexUiDraftDeleted/v1', task }));
  assert.equal(await f.store.isTaskDeleted(taskId), true);
  const saved = await new CodexUiDraftStore(f.directory).save(scope, [update(taskId, 1, 'stale window'), update('other', 1, 'new unrelated edit'),
    { key: selectionKey, revision: 1, value: 'other' },
  ]);
  assert.deepEqual(saved.deletedTaskIds, [taskId]); assert.equal(saved.conflicts.length, 0);
  assert.deepEqual(new Set(saved.entries.map(entry => entry.key)), new Set([draftKey('other'), selectionKey]));
  assert.equal(saved.entries.find(entry => entry.key === selectionKey)?.value, 'other');
  assert.equal(saved.entries.find(entry => entry.key === selectionKey)?.revision, 2, 'selection CAS uses its stored revision before deleted fields are purged');
  assert.deepEqual(await f.store.read(scope), { scope, entries: saved.entries, conflicts: [] });
});

test('malformed deletion fences are preserved and prevent draft writes', async t => {
  const f = await fixture(t); await f.store.removeTask('deleted');
  const marker = (await fs.readdir(f.directory)).find(name => name.startsWith('deleted-'))!;
  const file = path.join(f.directory, marker); await fs.writeFile(file, '{');
  await assert.rejects(f.store.save(scope, [update('deleted', 0, 'must not return')])); await assert.rejects(f.store.removeTask('deleted'));
  assert.equal(await fs.readFile(file, 'utf8'), '{');
});
