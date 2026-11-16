import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { CodexBridge, type CodexBridgeOptions } from '../../src/codex/bridge';
import { CodexHistoryStore } from '../../src/codex/historyStore';
import { CodexTaskStore } from '../../src/codex/taskStore';
import { CodexTaskScheduler } from '../../src/codex/scheduler';
import { CodexUiDraftStore } from '../../src/codex/uiDraftStore';
import { createTaskWorkspace, readTaskWorkspace } from '../../src/codex/taskWorkspace';
import type { CodexAppServer } from '../../src/codex/appServer';
import type { CodexEvent, CodexTaskRecord, CodexTaskSpec } from '../../src/codex/protocol';

async function until(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!predicate()) { if (Date.now() >= deadline) throw new Error('History state did not settle'); await new Promise(resolve => setTimeout(resolve, 10)); }
}
async function fixture(t: test.TestContext) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'glw-history-delete-')), storage = path.join(root, 'storage'), project = path.join(root, 'project');
  await mkdir(storage); await mkdir(project); await writeFile(path.join(project, 'result.md'), '# Produced artifact\n');
  const spec: CodexTaskSpec = { source: { kind: 'free', repository: project, prompt: 'private source prompt' }, title: 'History task',
    root: project, executionRoot: project, prompt: 'private source prompt', writableRoots: [project], workspaceKey: project, environmentKey: 'fixture' };
  const drafts = new CodexUiDraftStore(path.join(storage, 'codex-ui-drafts'));
  const bridges: CodexBridge[] = [], nativeDeletes: string[] = [], events: CodexEvent[] = [];
  let cleanupFails = false, nativeFails = false, prepareCount = 0, prepareAllowed = false;
  const options: CodexBridgeOptions = { storage, version: 'fixture', executable: () => '', trusted: () => true, event: event => events.push(event),
    openUrl: async () => {}, prepare: async () => { prepareCount++; if (prepareAllowed) return spec; throw new Error('History deletion must not prepare or run a model'); },
    cleanupDrafts: async id => { if (cleanupFails) throw new Error('draft cleanup unavailable'); await drafts.removeTask(id); },
    client: async () => ({ version: '0.169.0', executable: 'fixture', client: {
      close: async () => {}, request: async (method: string, params: { threadId?: string }) => {
        assert.equal(method, 'thread/delete', 'history deletion never starts or resumes a turn');
        nativeDeletes.push(params.threadId!); if (nativeFails) throw new Error('native deletion unavailable'); return {};
      }
    } as unknown as CodexAppServer }) };
  const make = () => { const bridge = new CodexBridge({ ...options, scheduler: new CodexTaskScheduler('history-fixture', root) }); bridges.push(bridge); return bridge; };
  const record = (id: string): CodexTaskRecord => ({ schema: 'GitLabWorkspaceCodexTask/v3', id, title: spec.title, root: project, spec,
    status: 'paused', ownerPid: process.pid, createdAt: '2026-11-16T00:00:00Z', updatedAt: '2026-11-16T00:00:00Z',
    result: { state: 'ready', summary: 'Produced outcome', reportPath: path.join(project, 'result.md') } });
  const save = (value: CodexTaskRecord) => new CodexTaskStore(path.join(storage, 'codex-tasks')).save(value);
  t.after(async () => { for (const bridge of bridges) await bridge.shutdown(); await rm(root, { recursive: true, force: true }); });
  return { root, storage, project, drafts, spec, record, save, make, nativeDeletes, events, prepareCount: () => prepareCount,
    failCleanup: (value: boolean) => { cleanupFails = value; }, failNative: (value: boolean) => { nativeFails = value; },
    allowPrepare: () => { prepareAllowed = true; } };
}

function holdAdmission(bridge: CodexBridge, taskId: string) {
  const store = (bridge as any).store, original = store.control.bind(store);
  let enter!: () => void, release!: () => void, held = false;
  const entered = new Promise<void>(resolve => { enter = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
  store.control = (id: string, operation: () => Promise<unknown>) => original(id, async () => {
    if (id === taskId && !held) { held = true; enter(); await gate; }
    return operation();
  });
  return { entered, release };
}

async function managedRecord(f: Awaited<ReturnType<typeof fixture>>, id: string, ownerPid: number) {
  const manifest = await createTaskWorkspace(f.storage, { source: f.spec.source, originRoot: f.project, preparedSpec: f.spec, windowMode: 'origin' }, id);
  manifest.owner = { instance: 'previous-host', pid: ownerPid, generation: 1 };
  await writeFile(path.join(manifest.binding.directory, 'launch.json'), JSON.stringify(manifest));
  const record = f.record(id); record.spec = { ...record.spec, taskWorkspace: manifest.binding }; record.schema = 'GitLabWorkspaceCodexTask/v4';
  record.ownerPid = ownerPid; record.ownerInstance = 'previous-host'; record.ownerGeneration = 1; record.revision = 1;
  await f.save(record); return manifest;
}

test('history tombstones are durable monotonic and validate IDs before any path access', async t => {
  const f = await fixture(t), store = new CodexHistoryStore(path.join(f.storage, 'codex-history-deletions'));
  await assert.rejects(store.read('../foreign'), /識別/);
  await store.control('task', async () => { await store.write('task', 'pending'); await store.write('task', 'deleted'); await store.write('task', 'pending'); });
  assert.equal(await store.read('task'), 'deleted');
  assert.equal((await new CodexHistoryStore(store.directory).list()).get('task'), 'deleted');
  await writeFile(path.join(store.directory, 'corrupt.json'), JSON.stringify({ schema: 'unexpected', id: 'corrupt', state: 'deleted' }));
  await assert.rejects(store.list(), /無法驗證/);
});

test('deleting stopped history removes owned conversation and drafts while preserving code and artifacts across restart', async t => {
  const f = await fixture(t), item = f.record('owned-history'); item.threadId = 'owned-thread'; item.ownedThreadIds = ['owned-thread']; await f.save(item);
  const scope = 'a'.repeat(64), key = JSON.stringify(['draft', item.id]);
  await f.drafts.save(scope, [{ key, revision: 0, value: { text: 'private unsent draft', revision: 1 } }]);
  const bridge = f.make(); await bridge.initialize(); assert.equal(bridge.list()[0].controls?.canDeleteHistory, true);
  await Promise.all([bridge.deleteHistory(item.id), bridge.deleteHistory(item.id)]);
  assert.equal(bridge.historyDeletion(item.id), 'deleted'); assert.deepEqual(bridge.list(), []); assert.deepEqual(f.nativeDeletes, ['owned-thread']);
  const result = await bridge.resultManifest(item.id); assert.equal(result.summary, 'Produced outcome');
  assert.equal(await readFile(path.join(f.project, 'result.md'), 'utf8'), '# Produced artifact\n');
  assert.equal((await f.drafts.read(scope)).entries.length, 0);
  const stale = await f.drafts.save(scope, [{ key, revision: 0, value: { text: 'late draft', revision: 2 } }]); assert.deepEqual(stale.deletedTaskIds, [item.id]);
  await assert.rejects(bridge.resume(item.id), /已刪除/); await assert.rejects(bridge.enqueue(f.spec, item.id), /已刪除/);
  const restarted = f.make(); await restarted.initialize(); assert.deepEqual(restarted.list(), []);
  assert.equal((await restarted.results.list()).length, 1, 'immutable artifacts stay available for dependencies');
  assert.equal(f.prepareCount(), 0);
});

test('deleting history rejects active and uncertain work without creating deletion intent', async t => {
  const f = await fixture(t), active = f.record('active'), uncertain = f.record('uncertain'); active.status = 'running'; uncertain.status = 'uncertain';
  await f.save(active); await f.save(uncertain); const bridge = f.make(); await bridge.initialize();
  assert.equal(bridge.list().find(value => value.id === active.id)?.controls?.canDeleteHistory, false);
  await assert.rejects(bridge.deleteHistory(active.id), /先停止/); await assert.rejects(bridge.deleteHistory(uncertain.id), /先核對/);
  assert.equal(bridge.historyDeletion(active.id), undefined); assert.equal(bridge.historyDeletion(uncertain.id), undefined);
  assert.deepEqual(f.nativeDeletes, []); assert.equal(f.prepareCount(), 0);
});

test('shared and legacy native conversations remain while deleting only the selected extension history', async t => {
  const f = await fixture(t), shared = f.record('shared-owner'), other = f.record('shared-reference'), legacy = f.record('legacy');
  shared.threadId = other.threadId = 'shared-thread'; shared.ownedThreadIds = ['shared-thread']; legacy.threadId = 'unproven-thread';
  await f.save(shared); await f.save(other); await f.save(legacy); const bridge = f.make(); await bridge.initialize();
  await bridge.deleteHistory(shared.id); await bridge.deleteHistory(legacy.id);
  assert.deepEqual(f.nativeDeletes, []); assert.deepEqual(bridge.list().map(value => value.id), [other.id]);
  assert.equal(bridge.list()[0].threadId, 'shared-thread'); assert.equal((await bridge.results.list()).length, 2);
});

test('native deletion failure stays pending and retry removes history only after cleanup succeeds', async t => {
  const f = await fixture(t), item = f.record('native-retry'); item.threadId = 'owned-retry'; item.ownedThreadIds = ['owned-retry']; await f.save(item);
  f.failNative(true); const bridge = f.make(); await bridge.initialize();
  await assert.rejects(bridge.deleteHistory(item.id), /native deletion unavailable/);
  assert.equal(bridge.historyDeletion(item.id), 'pending'); assert.equal(bridge.list().length, 1); assert.equal(bridge.list()[0].cleanupState, 'needs-attention');
  await assert.rejects(bridge.resume(item.id), /正在刪除/); assert.equal(f.prepareCount(), 0);
  f.failNative(false); await bridge.deleteHistory(item.id); assert.equal(bridge.historyDeletion(item.id), 'deleted'); assert.deepEqual(bridge.list(), []);
});

test('pending deletion survives failed draft cleanup and restart completes without another model turn', async t => {
  const f = await fixture(t), item = f.record('restart-cleanup'); await f.save(item); f.failCleanup(true);
  const first = f.make(); await first.initialize(); await assert.rejects(first.deleteHistory(item.id), /draft cleanup unavailable/);
  assert.equal(first.historyDeletion(item.id), 'pending'); assert.equal(first.list().length, 1);
  await first.shutdown(); f.failCleanup(false); const restarted = f.make(); await restarted.initialize();
  await until(() => restarted.historyDeletion(item.id) === 'deleted'); assert.deepEqual(restarted.list(), []); assert.equal(f.prepareCount(), 0);
  assert.equal((await restarted.resultManifest(item.id)).summary, 'Produced outcome');
});

test('another Host observes history removal and late output cannot resurrect the task', async t => {
  const f = await fixture(t), item = f.record('cross-host'); await f.save(item);
  const first = f.make(), second = f.make(); await first.initialize(); await second.initialize();
  await first.deleteHistory(item.id); await until(() => second.historyDeletion(item.id) === 'deleted');
  assert.equal(f.events.some(event => event.kind === 'historyDeleted' && event.taskIds.includes(item.id)), true);
  assert.deepEqual(second.list(), []); const before = f.events.length;
  (second as any).emit({ kind: 'output', taskId: item.id, items: [{ id: 'late', kind: 'agent', text: 'must stay removed' }] });
  (second as any).emit({ kind: 'tasks', tasks: [{ id: item.id }] });
  assert.equal(f.events.slice(before).some(event => event.kind === 'output'), false);
  assert.equal(f.events.slice(before).some(event => event.kind === 'tasks' && event.tasks.length > 0), false);
  const replayStart = f.events.length; await second.publish();
  const replay = f.events.slice(replayStart), fence = replay.findIndex(event => event.kind === 'historyDeleted' && event.taskIds.includes(item.id));
  assert.ok(fence >= 0); assert.ok(fence < replay.findIndex(event => event.kind === 'tasks'), 'new views receive durable deletion fences before task snapshots');
});

test('saved result history can be deleted after its source repository is removed', async t => {
  const f = await fixture(t), item = f.record('source-free'); await f.save(item); const bridge = f.make(); await bridge.initialize();
  await bridge.stopAndClean(item.id); assert.equal(bridge.list()[0].retention, 'results-only');
  await rm(f.project, { recursive: true, force: true }); await bridge.deleteHistory(item.id);
  assert.deepEqual(bridge.list(), []); assert.equal((await bridge.resultManifest(item.id)).summary, 'Produced outcome'); assert.equal(f.prepareCount(), 0);
});

test('confirmed history deletion suppresses stale cleanup warnings but preserves corruption and unrelated problems', async t => {
  const f = await fixture(t), item = f.record('warning-cleanup'); await f.save(item); const bridge = f.make(); await bridge.initialize();
  await bridge.deleteHistory(item.id);
  (bridge as any).emit({ kind: 'environment', environment: { state: 'ready', storageProblems: [
    { id: item.id, kind: 'cleanup', reason: 'stale cleanup failure' }, { id: item.id, reason: 'corrupt record' },
    { id: 'other-task', kind: 'cleanup', reason: 'still needs cleanup' }
  ] } });
  const projected = f.events.filter(event => event.kind === 'environment').at(-1)!;
  assert.equal(projected.kind, 'environment');
  if (projected.kind === 'environment') assert.deepEqual(projected.environment.storageProblems?.map(problem => problem.reason), ['corrupt record', 'still needs cleanup']);
});

test('shutdown waits for an in-flight history watcher reload before releasing storage', async t => {
  const f = await fixture(t), item = f.record('reload-shutdown'); await f.save(item); const bridge = f.make(); await bridge.initialize();
  const history = (bridge as any).historyStore as CodexHistoryStore, original = history.list.bind(history);
  let entered!: () => void, release!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; }), held = new Promise<void>(resolve => { release = resolve; });
  history.list = async ids => { entered(); await held; return original(ids); };
  const reloading = (bridge as any).reload() as Promise<void>; await started;
  let finished = false; const stopping = bridge.shutdown().then(() => { finished = true; });
  await new Promise<void>(resolve => setImmediate(resolve)); assert.equal(finished, false);
  release(); await Promise.all([reloading, stopping]); assert.equal(finished, true);
});

test('deletion admission fences a concurrent resume in another Host before preparation', async t => {
  const f = await fixture(t), item = f.record('delete-wins'); await f.save(item); f.allowPrepare();
  const deleting = f.make(), resuming = f.make(); await deleting.initialize(); await resuming.initialize();
  (resuming as any).schedule = () => {};
  const held = holdAdmission(deleting, item.id), deletion = deleting.deleteHistory(item.id); await held.entered;
  const resume = assert.rejects(resuming.resume(item.id), /正在刪除|已刪除/);
  held.release(); await Promise.all([deletion, resume]);
  assert.equal(f.prepareCount(), 0); assert.deepEqual(f.nativeDeletes, []); assert.equal(deleting.historyDeletion(item.id), 'deleted');
});

test('resume admission wins without deletion implicitly stopping or changing the queued task', async t => {
  const f = await fixture(t), item = f.record('resume-wins'); await f.save(item); f.allowPrepare();
  const resuming = f.make(), deleting = f.make(); await resuming.initialize(); await deleting.initialize();
  (resuming as any).schedule = () => {};
  const held = holdAdmission(resuming, item.id), resume = resuming.resume(item.id); await held.entered;
  const deletion = assert.rejects(deleting.deleteHistory(item.id), /先停止/);
  held.release(); await Promise.all([resume, deletion]);
  assert.equal(f.prepareCount(), 1); assert.equal(deleting.historyDeletion(item.id), undefined);
  assert.equal(resuming.list().find(task => task.id === item.id)?.status, 'queued'); assert.deepEqual(f.nativeDeletes, []);
});

test('explicit result actions share deletion admission and recheck durable history before effects', async t => {
  const f = await fixture(t), item = f.record('result-admission'); await f.save(item);
  const acting = f.make(), deleting = f.make(); await acting.initialize(); await deleting.initialize();
  let enter!: () => void, release!: () => void;
  const entered = new Promise<void>(resolve => { enter = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
  const action = acting.withHistoryAvailable(item.id, async () => { enter(); await gate; return 'restored'; }); await entered;
  const deletion = deleting.deleteHistory(item.id); await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(deleting.historyDeletion(item.id), undefined, 'result action holds the task gate until its authorized effect completes');
  release(); assert.equal(await action, 'restored'); await deletion;
  let invoked = false;
  await assert.rejects(acting.withHistoryAvailable(item.id, async () => { invoked = true; }), /已刪除/);
  assert.equal(invoked, false);
});

test('a restarted Host can claim stopped history from an exited managed owner for cleanup only', async t => {
  const f = await fixture(t), ownerPid = Number(execFileSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8', windowsHide: true }));
  const manifest = await managedRecord(f, 'exited-owner', ownerPid), restarted = f.make(); await restarted.initialize();
  assert.equal(restarted.list()[0].controls?.canDeleteHistory, true);
  await restarted.deleteHistory(manifest.binding.taskId);
  assert.deepEqual(restarted.list(), []); assert.equal(f.prepareCount(), 0); assert.deepEqual(f.nativeDeletes, []);
  assert.equal((await restarted.resultManifest(manifest.binding.taskId)).summary, 'Produced outcome');
  const retired = await readTaskWorkspace(f.storage, manifest.binding.workspaceFile);
  assert.equal(retired.retired?.resultId, manifest.binding.taskId); assert.equal(retired.preparedSpec, undefined);
  assert.doesNotMatch(JSON.stringify(retired.source), /private source prompt/);
});

test('managed history held by a live owner remains blocked without changing ownership', async t => {
  const f = await fixture(t), manifest = await managedRecord(f, 'live-owner', process.pid), other = f.make(); await other.initialize();
  assert.equal(other.list()[0].controls?.canDeleteHistory, false);
  await assert.rejects(other.deleteHistory(manifest.binding.taskId), /另一個視窗/);
  assert.equal(other.historyDeletion(manifest.binding.taskId), undefined);
  assert.equal((await readTaskWorkspace(f.storage, manifest.binding.workspaceFile)).owner?.instance, 'previous-host'); assert.equal(f.prepareCount(), 0);
});

test('history deletion preserves Group source snapshots referenced by another stopped task', async t => {
  const f = await fixture(t), id = 'a'.repeat(32), runtime = path.join(f.storage, 'codex-group-analysis', id), output = path.join(f.project, '_bmad-output', 'shared');
  const snapshot = path.join(runtime, 'sources', createHash('sha256').update(f.project).digest('hex').slice(0, 16));
  const skill = path.join(f.project, '.agents', 'skills', 'bmad-spec', 'SKILL.md');
  await mkdir(snapshot, { recursive: true }); await mkdir(output, { recursive: true }); await mkdir(path.dirname(skill), { recursive: true });
  await writeFile(skill, 'Offline Group fixture'); await writeFile(path.join(snapshot, 'source.ts'), 'export const preserved = true;');
  const spec: CodexTaskSpec = { ...f.spec, source: { kind: 'group-analysis', requirement: 'Preserve shared captured sources' }, executionRoot: output,
    writableRoots: [output], skill: { name: 'bmad-spec', path: skill }, groupAnalysis: { id, groupRoot: f.project, runtimeRoot: runtime,
      outputRoot: output, repositories: [{ id: 'source', name: 'source', path: f.project, sha: 'a'.repeat(40), snapshotPath: snapshot }] } };
  const selected = f.record('group-selected'), retained = f.record('group-retained'); selected.spec = spec; retained.spec = spec;
  await f.save(selected); await f.save(retained); const bridge = f.make(); await bridge.initialize();
  await assert.rejects(bridge.deleteHistory(selected.id), /其他任務仍在使用/);
  assert.equal(await readFile(path.join(snapshot, 'source.ts'), 'utf8'), 'export const preserved = true;');
  assert.equal(bridge.historyDeletion(selected.id), 'pending');
  assert.equal(bridge.list().find(task => task.id === retained.id)?.controls?.canResume, true);
  await bridge.deleteHistory(retained.id); await bridge.deleteHistory(selected.id);
  assert.deepEqual(bridge.list(), []); assert.equal((await bridge.results.list()).length, 2); assert.equal(f.prepareCount(), 0);
});

test('owned conversation deletion resumes after a native error and Host restart without another turn', async t => {
  const f = await fixture(t), item = f.record('native-restart'); item.threadId = 'owned-after-restart'; item.ownedThreadIds = ['owned-after-restart'];
  await f.save(item); f.failNative(true); const first = f.make(); await first.initialize();
  await assert.rejects(first.deleteHistory(item.id), /native deletion unavailable/); assert.equal(first.historyDeletion(item.id), 'pending');
  await first.shutdown(); f.failNative(false); const restarted = f.make(); await restarted.initialize();
  await until(() => restarted.historyDeletion(item.id) === 'deleted');
  assert.deepEqual(restarted.list(), []); assert.deepEqual(f.nativeDeletes, ['owned-after-restart', 'owned-after-restart']);
  assert.equal((await restarted.resultManifest(item.id)).summary, 'Produced outcome'); assert.equal(f.prepareCount(), 0);
});
