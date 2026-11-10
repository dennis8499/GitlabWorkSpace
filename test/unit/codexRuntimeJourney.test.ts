import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { CodexAppServer } from '../../src/codex/appServer';
import { CodexBridge, type CodexBridgeOptions } from '../../src/codex/bridge';
import { CodexTaskScheduler } from '../../src/codex/scheduler';
import { CodexTaskStore } from '../../src/codex/taskStore';
import { CodexProtocolAdapter, invalidateCodexModelCatalog } from '../../src/codex/adapter';
import { codexExecutableVersion, invalidateCodexExecutableCache } from '../../src/codex/process';
import { CodexRpcError } from '../../src/codex/rpcError';
import { validStoredCodexProjection } from '../../src/codex/recordValidation';
import type { CodexEvent, CodexTaskRecord, CodexTaskSpec } from '../../src/codex/protocol';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
async function until(condition: () => boolean): Promise<void> {
  const end = Date.now() + 10_000;
  while (!condition()) { if (Date.now() > end) throw new Error('Lifecycle did not settle'); await new Promise(resolve => setTimeout(resolve, 10)); }
}
async function setup(t: test.TestContext, prepare?: CodexBridgeOptions['prepare']) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'codex-journey-'));
  const spec: CodexTaskSpec = { title: 'Journey', root, workspaceKey: root, prompt: 'hold',
    source: { kind: 'free', repository: root, prompt: 'hold' }, writableRoots: [root], environmentKey: 'journey' };
  const events: CodexEvent[] = [], requests: Array<{ method: string; params: any }> = [];
  let connections = 0, client!: CodexAppServer;
  const bridge = new CodexBridge({ scheduler: new CodexTaskScheduler('journey', root), storage: root, version: 'test',
    executable: () => '', trusted: () => true, prepare: prepare ?? (async () => spec), openUrl: async () => {}, event: event => events.push(event),
    client: async () => {
      connections++;
      const connection = client = new CodexAppServer(spawn(process.execPath, [path.resolve(__dirname, '../../../test/fixtures/codex-app-server.cjs'), root, 'evolution'],
        { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] }), 1000);
      await connection.initialize('test');
      const request = connection.request.bind(connection);
      connection.request = (method, params, options) => { requests.push({ method, params }); return request(method, params, options); };
      return { client: connection, version: '0.166.0', executable: 'offline' };
    } });
  t.after(async () => { await bridge.shutdown(); await rm(root, { recursive: true, force: true }); });
  const state = bridge as any;
  return { root, spec, bridge, events, requests, state, client: () => client, connections: () => connections,
    record: (): CodexTaskRecord => state.records.get('task'), settled: () => state.executions.size === 0 };
}

test('executable probes share work, respect subscriber cancellation and invalidate on file replacement', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'codex-version-')), file = path.join(root, 'codex-fixture');
  t.after(async () => { invalidateCodexExecutableCache(); await rm(root, { recursive: true, force: true }); });
  await writeFile(file, 'version-one');
  let probes = 0, transportSignal: AbortSignal | undefined;
  const held = deferred<string>();
  const probe = async (_file: string, signal: AbortSignal) => { probes++; transportSignal = signal; return held.promise; };
  const controller = new AbortController();
  const first = codexExecutableVersion(file, controller.signal, probe);
  const second = codexExecutableVersion(file, undefined, probe);
  await until(() => probes === 1); await new Promise(resolve => setImmediate(resolve)); controller.abort();
  await assert.rejects(first, { name: 'AbortError' }); assert.equal(transportSignal?.aborted, false);
  held.resolve('codex-cli 0.166.0'); await second;
  await codexExecutableVersion(file, undefined, probe); assert.equal(probes, 1);
  await writeFile(file, 'replacement-version-two');
  const updated = await codexExecutableVersion(file, undefined, async () => { probes++; return 'codex-cli 0.167.0'; });
  assert.equal(updated.version, '0.167.0'); assert.equal(probes, 2);
  invalidateCodexExecutableCache(); await codexExecutableVersion(file, undefined, async () => { probes++; return 'codex-cli 0.167.0'; });
  assert.equal(probes, 3);
});

test('model catalogs are shared per connection with defensive copies and explicit invalidation', async () => {
  const held = deferred<any>(); let requests = 0;
  const client = { request: async () => { requests++; return held.promise; } } as unknown as CodexAppServer;
  const first = new CodexProtocolAdapter(client, '0.166.0').models();
  const second = new CodexProtocolAdapter(client, '0.166.0').models();
  await until(() => requests === 1);
  held.resolve({ data: [{ id: 'model', model: 'model', supportedReasoningEfforts: [] }], nextCursor: null });
  const models = await first; await second; models[0].model = 'modified';
  assert.equal((await new CodexProtocolAdapter(client, '0.166.0').models())[0].model, 'model');
  assert.equal(requests, 1);
  invalidateCodexModelCatalog(client); await new CodexProtocolAdapter(client, '0.166.0').models(); assert.equal(requests, 2);
});

test('warm launch model reads avoid new processes and config changes invalidate the cache', async t => {
  const f = await setup(t);
  await Promise.all([f.bridge.models(f.root), f.bridge.models(f.root)]);
  await f.bridge.models(f.root); assert.equal(f.connections(), 1);
  await mkdir(path.join(f.root, '.codex')); await writeFile(path.join(f.root, '.codex/config.toml'), 'model = "test"');
  await f.bridge.models(f.root); assert.equal(f.connections(), 2);
  f.bridge.invalidateEnvironment(); await f.bridge.models(f.root); assert.equal(f.connections(), 3);
});

test('launch preflight and models stay warm, skip optional MCP, and invalidate on settings or auth changes', async t => {
  const f = await setup(t), previousHome = process.env.CODEX_HOME;
  process.env.CODEX_HOME = path.join(f.root, 'user-codex');
  t.after(() => { if (previousHome === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = previousHome; });
  await mkdir(process.env.CODEX_HOME);
  const cold = await Promise.all([f.bridge.preflight(f.root), f.bridge.preflight(f.root)]);
  await f.bridge.models(f.root); assert.equal(f.connections(), 2);
  assert.equal(cold[0].state, 'ready'); cold[0].state = 'blocked';
  assert.equal((await f.bridge.preflight(f.root)).state, 'ready');
  await f.bridge.models(f.root); assert.equal(f.connections(), 2);
  assert.equal(f.requests.some(request => request.method === 'mcpServerStatus/list'), false);

  await mkdir(path.join(f.root, '.codex')); await writeFile(path.join(f.root, '.codex/config.toml'), 'model = "changed"');
  await Promise.all([f.bridge.preflight(f.root), f.bridge.models(f.root)]); assert.equal(f.connections(), 4);
  await writeFile(path.join(process.env.CODEX_HOME, 'auth.json'), '{"account":"changed"}');
  await Promise.all([f.bridge.preflight(f.root), f.bridge.models(f.root)]); assert.equal(f.connections(), 6);
  await Promise.all([f.bridge.preflight(f.root), f.bridge.models(f.root)]); assert.equal(f.connections(), 6);

  await f.bridge.check(f.root); assert.equal(f.connections(), 7);
  assert.ok(f.requests.some(request => request.method === 'mcpServerStatus/list'));
  await Promise.all([f.bridge.preflight(f.root), f.bridge.models(f.root)]); assert.equal(f.connections(), 9);
  await Promise.all([f.bridge.preflight(f.root), f.bridge.models(f.root)]); assert.equal(f.connections(), 9);
});

test('concurrent environment checks share the process while cancelling one caller preserves the other', async t => {
  const f = await setup(t), original = f.state.options.client;
  const held = deferred<any>(); let transportSignal: AbortSignal | undefined, reads = 0;
  f.state.options.client = async (root: string) => {
    const connection = await original(root), request = connection.client.request.bind(connection.client);
    connection.client.request = (method: string, params: Record<string, unknown>, options: { signal?: AbortSignal }) => {
      if (method === 'account/read') { reads++; transportSignal = options?.signal; return held.promise; }
      return request(method, params, options);
    };
    return connection;
  };
  const controller = new AbortController();
  const first = f.bridge.check(f.root, controller.signal), second = f.bridge.check(f.root);
  await until(() => reads === 1); controller.abort();
  await assert.rejects(first, { name: 'AbortError' }); assert.equal(transportSignal?.aborted, false);
  held.resolve({ requiresOpenaiAuth: false });
  const environment = await second;
  assert.equal(environment.state, 'ready'); assert.equal(environment.compatibility, 'verified'); assert.equal(f.connections(), 1);
});

test('preflight is visible and pausing cancels it before any App Server starts', async t => {
  let preflightSignal: AbortSignal | undefined;
  const f = await setup(t, async (_source, _previous, signal) => {
    preflightSignal = signal;
    return new Promise((_resolve, reject) => signal!.addEventListener('abort', () => reject(signal!.reason), { once: true }));
  });
  const openedAt = Date.now() - 1000;
  f.spec.launch = { openedAt, draftReadyAt: openedAt + 100, checkedMs: 200, submittedAt: openedAt + 800 };
  await f.bridge.enqueue(f.spec, 'task'); await until(() => !!preflightSignal);
  assert.equal(f.bridge.list()[0].status, 'starting'); assert.equal(f.bridge.list()[0].progress?.phase, 'preflight');
  await f.bridge.pause('task');
  assert.equal(preflightSignal?.aborted, true); assert.equal(f.connections(), 0);
  assert.equal(f.bridge.list()[0].status, 'paused'); assert.equal(f.bridge.list()[0].progress?.phase, undefined);
  const diagnostics = f.bridge.diagnosticSnapshot('task');
  const startup = diagnostics.startup as Record<string, number>, journey = diagnostics.journey as Record<string, number>;
  assert.equal(typeof startup.queueWaitMs, 'number'); assert.equal(typeof startup.cleanupMs, 'number');
  assert.deepEqual(diagnostics.launch, f.spec.launch);
  assert.equal(journey.openedToDraftReadyMs, 100); assert.equal(journey.openedToSubmittedMs, 800);
  assert.equal(journey.submittedToQueueMs, Date.parse(f.record().createdAt) - f.spec.launch.submittedAt!);
  assert.equal(journey.openedToExecutionMs, startup.executionStartedAt - openedAt);
  assert.equal(journey.openedToSettledMs, journey.openedToExecutionMs + startup.executionToSettledMs);
  assert.equal(journey.openedToFirstResponseMs, undefined);
  assert.equal(validStoredCodexProjection(f.record()), true);
  for (const launch of [{ openedAt: 'private text' }, { openedAt, checkedMs: Infinity }, { openedAt, submittedAt: -1 }, { openedAt: Number.MAX_SAFE_INTEGER + 1 }]) {
    assert.equal(validStoredCodexProjection({ ...f.record(), spec: { ...f.spec, launch } }), false);
  }
  // Diagnostics expose only timing fields, even if a legacy stored object contains extra metadata.
  Object.assign(f.record().spec.launch!, { privateNote: 'omit this' });
  assert.equal('privateNote' in (f.bridge.diagnosticSnapshot('task').launch as object), false);
});

test('supplements during preflight survive until dispatch and duplicate operation IDs steer once', async t => {
  const held = deferred<CodexTaskSpec>(); let preparing = false;
  const f = await setup(t, async () => { preparing = true; return held.promise; });
  await f.bridge.enqueue(f.spec, 'task'); await until(() => preparing);
  await Promise.all([f.bridge.message('task', 'Include the edge case', 'supplement'),
    f.bridge.message('task', 'Include the edge case', 'supplement')]);
  assert.equal(f.record().queuedMessages?.[0].state, 'queued'); assert.equal(f.requests.length, 0);
  held.resolve(f.spec); await until(() => f.settled() && f.bridge.list()[0]?.status === 'completed');
  assert.equal(f.requests.filter(request => request.method === 'turn/steer').length, 1);
  assert.equal(f.record().queuedMessages?.[0].state, 'accepted');
  await f.bridge.message('task', 'Include the edge case', 'supplement');
  assert.equal(f.requests.filter(request => request.method === 'turn/steer').length, 1);
});

test('approval resolution clears stale waiting and sends the saved supplemental message', async t => {
  const f = await setup(t); await f.bridge.enqueue(f.spec, 'task'); await until(() => !!f.bridge.list()[0]?.turnId);
  const task = f.bridge.list()[0];
  // This synthetic interaction is client-owned; do not let the fixture's normal
  // approval sequence complete the turn before queued steering can be sent.
  f.client().respond = () => {};
  f.client().onRequest({ id: 992, method: 'item/commandExecution/requestApproval', params: { threadId: task.threadId, turnId: task.turnId, command: 'git status' } });
  await until(() => f.bridge.list()[0].status === 'waiting');
  await f.bridge.message('task', 'Check the tests too', 'waiting-message');
  assert.equal(f.requests.some(request => request.method === 'turn/steer'), false);
  const interaction = [...f.state.interactions.values()][0] as any;
  await f.bridge.answer('task', interaction.projection.id, { decision: 'accept' });
  await until(() => f.settled());
  assert.notEqual(f.bridge.list()[0].progress?.waitReason, 'approval');
  assert.equal(f.requests.filter(request => request.method === 'turn/steer').length, 1);
});

test('an ambiguous supplemental send persists uncertainty and cannot replay by operation ID', async t => {
  const f = await setup(t); await f.bridge.enqueue(f.spec, 'task'); await until(() => !!f.bridge.list()[0]?.turnId);
  const request = f.client().request.bind(f.client()); let sends = 0;
  f.client().request = (method, params, options) => {
    if (method === 'turn/steer') { sends++; return Promise.reject(new CodexRpcError('timeout', method, undefined, 'possibly-sent')); }
    return request(method, params, options);
  };
  await assert.rejects(f.bridge.message('task', 'A possibly sent instruction', 'unknown-send'), /逾時/);
  await assert.rejects(f.bridge.message('task', 'A possibly sent instruction', 'unknown-send'), /逾時/);
  assert.equal(sends, 1); assert.equal(f.record().queuedMessages?.[0].state, 'uncertain');
  const stored = JSON.parse(await readFile(path.join(f.root, 'codex-tasks/task.json'), 'utf8'));
  assert.equal(stored.queuedMessages[0].state, 'uncertain'); await f.bridge.pause('task');
});

test('reopening a stopped task persists an interrupted send as uncertain without replay', async t => {
  const f = await setup(t); await f.bridge.enqueue(f.spec, 'task'); await until(() => !!f.bridge.list()[0]?.turnId); await f.bridge.pause('task');
  f.record().queuedMessages = [{ id: 'interrupted-send', text: 'Preserved instruction', state: 'sending' }];
  await f.state.save(f.record()); await f.bridge.shutdown();
  const reopened = new CodexBridge({ ...f.state.options });
  try {
    await reopened.initialize();
    assert.equal(reopened.list()[0].uncertainMessages, 1);
    const stored = JSON.parse(await readFile(path.join(f.root, 'codex-tasks/task.json'), 'utf8'));
    assert.equal(stored.queuedMessages[0].state, 'uncertain');
    assert.equal(f.requests.some(request => request.method === 'turn/steer'), false);
  } finally { await reopened.shutdown(); }
});

test('all pending publication receipts block control until individually reconciled', async t => {
  const f = await setup(t); await f.bridge.enqueue(f.spec, 'task'); await until(() => !!f.bridge.list()[0]?.turnId); await f.bridge.pause('task');
  await f.bridge.notePublication('task', { kind: 'reply', discussionId: 'first', key: 'first-key', state: 'pending' });
  await f.bridge.notePublication('task', { kind: 'reply', discussionId: 'second', key: 'second-key', state: 'confirmed' });
  assert.equal(f.bridge.list()[0].controls?.canResume, false); assert.equal(f.bridge.list()[0].controls?.canDelete, false);
  await assert.rejects(f.bridge.resume('task'), /核對 MR/);
  const checked: string[] = [];
  f.state.options.reconcilePublication = async (_spec: CodexTaskSpec, publication: { key: string }) => { checked.push(publication.key); return 'confirmed'; };
  await f.bridge.reconcile('task');
  assert.deepEqual(checked, ['first-key']); assert.equal(f.bridge.list()[0].publications?.first.state, 'confirmed');
  assert.equal(f.bridge.list()[0].controls?.canResume, true);
});

test('task deltas contain only changed tasks and deletions while explicit publish restores a full snapshot', async t => {
  const f = await setup(t); f.state.options.taskDeltas = true;
  await f.bridge.publish(); assert.ok(f.events.some(event => event.kind === 'tasks'));
  await f.bridge.enqueue(f.spec, 'task'); await until(() => !!f.bridge.list()[0]?.turnId); await f.bridge.pause('task');
  f.events.length = 0;
  await f.bridge.metadata('task', { title: 'Renamed' });
  const deltas = f.events.filter(event => event.kind === 'tasksDelta');
  assert.ok(deltas.some(event => event.tasks.length === 1 && event.tasks[0].title === 'Renamed'));
  assert.equal(f.events.some(event => event.kind === 'tasks'), false);
  await f.bridge.publish(); assert.ok(f.events.some(event => event.kind === 'tasks' && event.tasks[0].title === 'Renamed'));
  f.events.length = 0; await f.bridge.delete('task');
  assert.ok(f.events.some(event => event.kind === 'tasksDelta' && event.removedIds.includes('task')));
});

test('targeted task reads retain unrelated validation problems and never drop other loaded tasks', async t => {
  const f = await setup(t); await f.bridge.enqueue(f.spec, 'task'); await until(() => !!f.bridge.list()[0]?.turnId); await f.bridge.pause('task');
  const directory = path.join(f.root, 'codex-tasks'), store = new CodexTaskStore(directory);
  const other = { ...structuredClone(f.record()), id: 'other', title: 'Other task' };
  await store.save(other); await writeFile(path.join(directory, 'damaged.json'), '{invalid');
  await store.load(); assert.ok(store.problems.some(problem => problem.id === 'damaged'));
  assert.deepEqual((await store.load(['task'])).map(record => record.id), ['task']);
  assert.ok(store.problems.some(problem => problem.id === 'damaged'));
  await f.state.reload();
  const changed = { ...other, title: 'Changed elsewhere', revision: (other.revision ?? 0) + 1, updatedAt: new Date(Date.now() + 100).toISOString() };
  await store.save(changed); await f.state.reload(['other']);
  assert.equal(f.bridge.list().find(task => task.id === 'other')?.title, 'Changed elsewhere');
  assert.ok(f.bridge.list().some(task => task.id === 'task'));
});
