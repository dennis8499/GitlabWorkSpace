import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { CodexAppServer } from '../../src/codex/appServer';
import { CodexBridge, validateForm, type CodexBridgeOptions } from '../../src/codex/bridge';
import { CodexTaskStore, codexRootKey } from '../../src/codex/taskStore';
import { networkRuntimeRoot } from '../../src/api/localNetworkLease';
import { CodexTaskScheduler } from '../../src/codex/scheduler';
import { CodexWorkspaceLease } from '../../src/codex/workspaceLease';
import { resolveCodexExecutable } from '../../src/codex/process';
import { canonicalRuntime } from '../../src/codex/taskValidation';
import type { CodexEvent, CodexInteraction, CodexTaskRecord, CodexTaskSpec } from '../../src/codex/protocol';

const fixture = path.resolve(__dirname, '../../../test/fixtures/codex-app-server.cjs');
function peer(root = process.cwd(), timeout = 3000, mode = '') {
  return new CodexAppServer(spawn(process.execPath, [fixture, root, mode], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] }), timeout);
}
async function until(predicate: () => boolean, label = 'condition'): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!predicate()) { if (Date.now() > deadline) throw new Error(`Timed out: ${label}`); await new Promise(resolve => setTimeout(resolve, 10)); }
}
test('Codex JSONL handshake, split UTF-8, overlapping request IDs, and redacted errors', async () => {
  const client = peer();
  try {
    await client.initialize('test');
    const [a, b] = await Promise.all([client.request('test/echo', { value: 'a', delay: 20 }), client.request('test/echo', { value: 'b' })]);
    assert.equal(a.value, 'a'); assert.equal(b.value, 'b');
    assert.deepEqual(await client.request('test/split'), { text: '中文輸出' });
    await assert.rejects(client.request('test/error'), error => error instanceof Error && !error.message.includes('SECRET') && error.message.includes('-32600'));
  } finally { await client.close(); }
});
test('Codex rejects malformed output, deadlines and exited processes', async () => {
  for (const method of ['test/bad-json', 'test/ignore', 'test/exit']) {
    const client = peer(process.cwd(), 1000);
    try { await client.initialize('test'); await assert.rejects(client.request(method)); }
    finally { await client.close(); }
  }
});
async function setup(t: { after(fn: () => Promise<void>): void }, prompt = 'success', mode = '', hooks: Partial<Pick<CodexBridgeOptions, 'started' | 'completed'>> = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'codex-bridge-'));
  const skill = path.join(root, '.agents/skills/codebase-wiki/SKILL.md');
  await mkdir(path.dirname(skill), { recursive: true }); await writeFile(skill, 'offline test Skill');
  const events: CodexEvent[] = [], requests: Array<{ method: string; params: any }> = [], responses: Array<{ id: number | string; result: any }> = [];
  const spec: CodexTaskSpec = { title: 'Wiki 查詢', root, workspaceKey: root, source: { kind: 'skill', featureId: 'query', inputs: {}, revision: 'r' },
    prompt, skill: { name: 'codebase-wiki', path: skill }, writableRoots: [root], environmentKey: 'environment' };
  let trusted = true, changed = false;
  const make = (storage = root) => new CodexBridge({ scheduler: new CodexTaskScheduler('test', root), storage, version: 'test', executable: () => '', trusted: () => trusted,
    ...hooks,
    prepare: async () => ({ ...spec, environmentKey: changed ? 'changed' : 'environment' }), event: event => events.push(event), openUrl: async () => {},
    client: async () => {
      const client = peer(root, 3000, mode); const request = client.request.bind(client);
      client.request = (method, params) => { requests.push({ method, params }); return request(method, params); };
      const respond = client.respond.bind(client);
      client.respond = (id, result) => { responses.push({ id, result }); respond(id, result); };
      await client.initialize('test'); return { client, version: '0.165.0', executable: 'offline-peer' };
    } });
  const bridges: CodexBridge[] = [];
  const bridge = make(); bridges.push(bridge);
  t.after(async () => { await Promise.all(bridges.map(value => value.shutdown())); await rm(root, { recursive: true, force: true }); });
  return { root, spec, bridge, events, requests, responses, change: () => { changed = true; }, restore: () => { changed = false; }, untrust: () => { trusted = false; },
    second: () => { const value = make(path.join(root, 'second')); bridges.push(value); return value; } };
}
function linkIssue(spec: CodexTaskSpec): void {
  spec.source = { kind: 'issue', projectId: 1, issueIid: 2 }; spec.executionRoot = spec.root;
  spec.origin = { kind: 'issue', accountKey: 'test', baseUrl: 'https://gitlab.test', projectId: 1, iid: 2, projectPath: 'team/project',
    repositoryRoot: spec.root, webUrl: 'https://gitlab.test/team/project/-/issues/2', sourceBranch: 'main', sourceSha: 'a'.repeat(40), branch: 'issue/2-development' };
  spec.workflow = { id: 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa', runtimeRoot: path.join(spec.root, 'runtime'), remote: 'origin' };
}

test('shutdown waits for an auxiliary connection being created and closes it exactly once', async t => {
  const f = await setup(t), options = (f.bridge as any).options as CodexBridgeOptions, original = options.client!;
  let enter!: () => void, release!: () => void, closes = 0;
  const entered = new Promise<void>(resolve => { enter = resolve; }), held = new Promise<void>(resolve => { release = resolve; });
  options.client = async root => {
    const connection = await original(root), close = connection.client.close.bind(connection.client);
    connection.client.close = async timeout => { closes++; await close(timeout); };
    enter(); await held; return connection;
  };
  const models = f.bridge.models(f.root); void models.catch(() => {}); await entered;
  const closing = f.bridge.shutdown(); release(); await closing;
  await assert.rejects(models, /關閉/); assert.equal(closes, 1);
});

test('history returns its borrowed task client without closing the running server', async t => {
  const f = await setup(t, 'hold'), options = (f.bridge as any).options as CodexBridgeOptions, original = options.client!;
  let closes = 0, created = 0;
  options.client = async root => {
    created++; const connection = await original(root), close = connection.client.close.bind(connection.client);
    connection.client.close = async timeout => { closes++; await close(timeout); }; return connection;
  };
  await f.bridge.enqueue(f.spec, 'borrowed'); await until(() => !!f.bridge.list()[0]?.turnId);
  await f.bridge.history('borrowed'); assert.equal(created, 1); assert.equal(closes, 0);
  await f.bridge.pause('borrowed'); assert.equal(closes, 1);
});

test('Issue workflow continues from specification to verified implementation and only publishes the final completed state', async t => {
  let turns = 0;
  const f = await setup(t, 'success', '', { completed: async () => ++turns === 1
    ? { state: 'needs-work', summary: 'Only a specification exists.' } : { state: 'ready', summary: 'Implementation and tests verified.' } });
  linkIssue(f.spec); await f.bridge.enqueue(f.spec, 'issue-workflow');
  await until(() => f.bridge.list()[0]?.status === 'completed');
  assert.equal(turns, 2); assert.equal(f.bridge.list()[0].result?.state, 'ready');
  assert.equal(f.requests.filter(request => request.method === 'turn/start').length, 2);
  assert.ok(f.requests.some(request => request.method === 'skills/extraRoots/set'));
  assert.equal(f.events.filter(event => event.kind === 'tasks' && event.tasks[0]?.status === 'completed').length, 1);
});

test('Issue handoff remains pausable and never starts another turn after pause', async t => {
  let entered = false, release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const f = await setup(t, 'success', '', { completed: async () => { entered = true; await held; return { state: 'needs-work', summary: 'Continue Build.' }; } });
  linkIssue(f.spec); await f.bridge.enqueue(f.spec, 'pausable-issue');
  await until(() => entered);
  assert.equal(f.bridge.list()[0].controls?.canPause, true);
  const pause = f.bridge.pause('pausable-issue');
  await until(() => f.bridge.list()[0].status === 'pausing'); release(); await pause;
  await until(() => f.bridge.list()[0].status === 'paused');
  assert.equal(f.requests.filter(request => request.method === 'turn/start').length, 1);
});

test('Linked task admission reuses an active task instead of launching another conversation', async t => {
  const f = await setup(t, 'hold'); linkIssue(f.spec);
  const first = await f.bridge.enqueue(f.spec, 'first-issue');
  const second = await f.bridge.enqueue({ ...f.spec }, 'second-issue');
  assert.equal(second, first); assert.equal(f.bridge.list().length, 1);
});

test('An artifact collection failure remains actionable after a confirmed completed turn', async t => {
  const f = await setup(t, 'success', '', { completed: async () => { throw new Error('Draft needs a source link repair.'); } });
  linkIssue(f.spec); await f.bridge.enqueue(f.spec, 'repair-artifact');
  await until(() => f.bridge.list()[0]?.status === 'completed');
  assert.equal(f.bridge.list()[0].result?.state, 'needs-work');
  assert.match(f.bridge.list()[0].result!.summary, /source link repair/);
  assert.equal(f.bridge.list()[0].controls?.canResume, true);
});

test('Unknown publication outcomes retain their record until reconciliation', async t => {
  const f = await setup(t);
  await f.bridge.enqueue(f.spec, 'pending-publication'); await until(() => f.bridge.list()[0]?.status === 'completed');
  await f.bridge.resultAction('pending-publication', async () => ({ state: 'uncertain', summary: 'Verify the remote page.' }));
  assert.equal(f.bridge.list()[0].controls?.canResume, false);
  assert.equal(f.bridge.list()[0].controls?.canDelete, false);
  await assert.rejects(f.bridge.resume('pending-publication'), /核對/);
  await assert.rejects(f.bridge.delete('pending-publication'), /暫停/);
  await assert.rejects(new CodexTaskStore(path.join(f.root, 'codex-tasks')).remove('pending-publication'), /發布結果/);
  await f.bridge.resultAction('pending-publication', async () => ({ state: 'published', summary: 'Remote page confirmed.' }));
  await f.bridge.delete('pending-publication'); assert.deepEqual(f.bridge.list(), []);
});

test('Bridge persists acceptance, serializes tasks and keeps business outcomes separate', async t => {
  const f = await setup(t, 'hold');
  await Promise.all([f.bridge.enqueue(f.spec, 'one'), f.bridge.enqueue(f.spec, 'one')]);
  await until(() => f.bridge.list().some(value => value.id === 'one' && value.turnId !== undefined));
  await f.bridge.enqueue({ ...f.spec, prompt: 'success' }, 'two');
  assert.equal(f.bridge.list().find(value => value.id === 'two')?.status, 'queued');
  await f.bridge.enqueue(f.spec, 'one');
  assert.equal(f.requests.filter(value => value.method === 'turn/start').length, 1);
  await f.bridge.message('one', 'finish now');
  await until(() => f.events.some(event => event.kind === 'tasks' && event.tasks.find(value => value.id === 'two')?.status === 'completed'));
  const saved = JSON.parse(await readFile(path.join(f.root, 'codex-tasks/two.json'), 'utf8'));
  assert.equal(saved.status, 'completed'); assert.ok(saved.threadId); assert.equal(saved.dispatchPending, false);
  assert.equal('spec' in f.bridge.list()[0], false);
  assert.equal(f.events.some(event => event.kind === 'output' && event.items.some(item => item.text.includes('處理中'))), true);
});
test('Bridge publishes completed tasks only after their state is durably saved', async t => {
  const f = await setup(t, 'hold');
  const save = CodexTaskStore.prototype.save;
  let blocked = false, release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  t.mock.method(CodexTaskStore.prototype, 'save', function (this: CodexTaskStore, record: CodexTaskRecord) {
    const writing = save.call(this, record);
    if (record.id !== 'durable' || record.status !== 'running' || record.dispatchPending || blocked) return writing;
    return writing.then(async () => { blocked = true; await gate; });
  });
  try {
    await f.bridge.enqueue(f.spec, 'durable');
    await until(() => blocked, 'running state saved');
    await f.bridge.message('durable', 'finish now');
    await f.bridge.publish();
    assert.equal(f.bridge.list()[0].status, 'running');
    assert.equal(f.events.some(event => event.kind === 'tasks' && event.tasks[0]?.status === 'completed'), false);
    assert.equal(JSON.parse(await readFile(path.join(f.root, 'codex-tasks/durable.json'), 'utf8')).status, 'running');
  } finally { release(); }
  await until(() => f.bridge.list()[0].status === 'completed', 'completed state saved');
  assert.equal(JSON.parse(await readFile(path.join(f.root, 'codex-tasks/durable.json'), 'utf8')).status, 'completed');
});
test('Bridge routes every supported interaction and rejects expired answers', async t => {
  const f = await setup(t, 'interactive');
  await f.bridge.enqueue(f.spec, 'interactive');
  const handled = new Set<string>();
  for (let index = 0; index < 6; index++) {
    let interaction: CodexInteraction | undefined;
    await until(() => {
      interaction = f.events.flatMap(event => event.kind === 'interactions' ? event.interactions : []).find(value => !handled.has(value.id)); return !!interaction;
    });
    const current = interaction!; handled.add(current.id);
    await f.bridge.answer('interactive', current.id, { decision: 'accept', answers: { choice: 'A' }, content: { name: 'test' } });
    await assert.rejects(f.bridge.answer('interactive', current.id, { decision: 'accept' }), /已失效/);
  }
  await until(() => f.bridge.list()[0].status === 'completed');
});
test('Bridge shares the physical workspace lock across independent hosts', async t => {
  const f = await setup(t, 'hold'), second = f.second();
  await f.bridge.enqueue(f.spec, 'first-host');
  await until(() => !!f.bridge.list()[0].turnId);
  await second.enqueue({ ...f.spec, prompt: 'success' }, 'second-host');
  await new Promise(resolve => setTimeout(resolve, 180));
  assert.equal(second.list()[0].status, 'queued');
  await f.bridge.cancel('first-host');
  await until(() => second.list()[0].status === 'completed');
});
test('Bridge verifies trust and environment before dispatch and never replays a lost turn', async t => {
  const f = await setup(t, 'drop-response');
  await f.bridge.enqueue(f.spec, 'uncertain');
  await until(() => f.bridge.list()[0].status === 'uncertain');
  assert.equal(f.requests.filter(value => value.method === 'turn/start').length, 1);
  f.change(); await assert.rejects(f.bridge.resume('uncertain'), /已變更/);
  f.untrust(); await assert.rejects(f.bridge.enqueue(f.spec, 'untrusted'), /信任/);
});
test('Reopening the Bridge preserves saved threads without automatically executing', async t => {
  const f = await setup(t);
  await f.bridge.enqueue(f.spec, 'saved'); await until(() => f.bridge.list()[0].status === 'completed');
  await f.bridge.shutdown();
  const before = f.requests.length;
  const store = new CodexTaskStore(path.join(f.root, 'codex-tasks'));
  assert.ok((await store.load())[0].threadId);
  const bridge = new CodexBridge({ scheduler: new CodexTaskScheduler('test', f.root), storage: f.root, version: 'test', executable: () => '', trusted: () => true,
    prepare: async () => f.spec, event: () => {}, openUrl: async () => {} });
  t.after(() => bridge.shutdown());
  await bridge.publish(); assert.equal(bridge.list()[0].status, 'completed'); assert.equal(f.requests.length, before); await bridge.shutdown();
});
test('Reopening a webview replays already loaded historical pages without losing the oldest cursor', async t => {
  const f = await setup(t, 'success', 'paged-history');
  await f.bridge.enqueue(f.spec, 'history-cache'); await until(() => f.bridge.list()[0].status === 'completed');
  await f.bridge.history('history-cache');
  await f.bridge.history('history-cache', 'older');
  await f.bridge.history('history-cache');
  const before = f.requests.filter(request => request.method === 'thread/turns/list').length;
  f.events.length = 0;
  await f.bridge.publish();
  const replay = f.events.find(event => event.kind === 'history');
  assert.ok(replay?.kind === 'history');
  assert.deepEqual(replay.items.map(item => item.text), ['earlier', 'latest']);
  assert.equal(replay.cursor, 'older'); assert.equal(replay.nextCursor, 'oldest');
  assert.equal(f.requests.filter(request => request.method === 'thread/turns/list').length, before);
  await f.bridge.delete('history-cache'); f.events.length = 0; await f.bridge.publish();
  assert.equal(f.events.some(event => event.kind === 'history'), false, 'deletion also clears historical page caches');
});
test('MCP form answers are checked before forwarding to tools', () => {
  const schema = { type: 'object', required: ['name'], properties: { name: { type: 'string', minLength: 2 }, count: { type: 'integer', minimum: 1 } } };
  validateForm(schema, { name: 'ok', count: 2 });
  assert.throws(() => validateForm(schema, {})); assert.throws(() => validateForm(schema, { name: 'x' }));
  assert.throws(() => validateForm(schema, { name: 'ok', count: 1.2 })); assert.throws(() => validateForm(schema, { name: 'ok', extra: 'bad' }));
});

test('A recovered task loads its saved conversation and sends a follow-up rather than the original prompt', async t => {
  const f = await setup(t);
  await f.bridge.enqueue(f.spec, 'resume');
  await until(() => f.events.some(event => event.kind === 'tasks' && event.tasks[0].status === 'completed'));
  const threadId = f.bridge.list()[0].threadId;
  await f.bridge.resume('resume');
  await until(() => f.requests.filter(value => value.method === 'turn/start').length === 2);
  await until(() => f.bridge.list()[0].status === 'completed');
  assert.equal(f.bridge.list()[0].threadId, threadId);
  assert.ok(f.requests.some(value => value.method === 'thread/resume'));
  assert.match(f.requests.filter(value => value.method === 'turn/start')[1].params.input[0].text, /先核對/);
  assert.match(f.requests.filter(value => value.method === 'turn/start')[1].params.input[0].text, /原始任務/);
  assert.doesNotMatch(f.requests.filter(value => value.method === 'turn/start')[1].params.input[0].text, /審查 request ID/);
  assert.ok(f.events.some(value => value.kind === 'history' && value.items[0].text.includes('先前')));
});
test('Unknown server requests stop the turn and release the queue', async t => {
  const f = await setup(t, 'unknown-request');
  await f.bridge.enqueue(f.spec, 'unknown');
  await until(() => ['interrupted', 'uncertain'].includes(f.bridge.list()[0].status));
  await f.bridge.enqueue({ ...f.spec, prompt: 'success' }, 'after-unknown');
  await until(() => f.bridge.list().find(value => value.id === 'after-unknown')?.status === 'completed');
});

test('Pause settles process cleanup, preserves the conversation, and lets the next task run', async t => {
  const f = await setup(t, 'hold');
  await f.bridge.enqueue(f.spec, 'pause-one');
  await until(() => !!f.bridge.list().find(task => task.id === 'pause-one')?.turnId);
  const thread = f.bridge.list()[0].threadId;
  await f.bridge.setAutoAccept('pause-one', true);
  await f.bridge.enqueue({ ...f.spec, prompt: 'success' }, 'after-pause');
  await f.bridge.enqueue(f.spec, 'pause-queued');
  await f.bridge.pause('pause-queued');
  assert.equal(f.bridge.list().find(task => task.id === 'pause-queued')?.status, 'paused');
  await f.bridge.pause('pause-one');
  assert.equal(f.bridge.list().find(task => task.id === 'pause-one')?.status, 'paused');
  assert.equal(f.bridge.list().find(task => task.id === 'pause-one')?.controls?.canDelete, true);
  await until(() => f.bridge.list().find(task => task.id === 'after-pause')?.status === 'completed');
  await f.bridge.resume('pause-one');
  await until(() => f.requests.filter(request => request.method === 'turn/start').length === 3);
  await until(() => f.bridge.list().find(task => task.id === 'pause-one')?.status === 'completed');
  assert.equal(f.bridge.list().find(task => task.id === 'pause-one')?.threadId, thread);
  assert.equal(f.bridge.list().find(task => task.id === 'pause-one')?.controls?.autoAccept, true);
  assert.match(f.requests.filter(request => request.method === 'turn/start').at(-1)!.params.input[0].text, /先核對/);
  assert.equal(f.requests.filter(request => request.method === 'turn/start').some(request => request.params.threadId === undefined), false);
});

test('Pausing before the first dispatch does not retain an unmaterialized thread or resend the original input', async t => {
  const f = await setup(t, 'original setup task', 'hold-before-turn');
  await f.bridge.enqueue(f.spec, 'pause-setup');
  await until(() => !!f.bridge.list()[0]?.threadId);
  await f.bridge.pause('pause-setup');
  assert.equal(f.bridge.list()[0].status, 'paused'); assert.equal(f.bridge.list()[0].threadId, undefined);
  assert.equal(f.requests.some(request => request.method === 'turn/start'), false);
  await f.bridge.resume('pause-setup'); await until(() => f.bridge.list()[0].status === 'completed');
  const turns = f.requests.filter(request => request.method === 'turn/start');
  assert.equal(turns.length, 1); assert.equal(turns[0].params.input[0].text, f.spec.prompt);
  assert.equal(f.requests.some(request => request.method === 'thread/resume'), false);
});

test('A failed helper cleanup keeps the task uncertain and prevents deletion', async t => {
  const f = await setup(t, 'hold');
  const spec = { ...f.spec, review: { tool: 'merge-reviewer' as const, requestId: 'a'.repeat(32), revision: 'r', runtimeRoot: path.join(f.root, 'runtime'), workspaceRoot: f.root, repositoryPath: f.root } };
  (f.bridge as any).options.cancelReview = async () => { throw new Error('helper cleanup not confirmed'); };
  await f.bridge.enqueue(spec, 'helper-pause');
  await until(() => !!f.bridge.list()[0].turnId);
  await f.bridge.cancel('helper-pause');
  assert.equal(f.bridge.list()[0].status, 'uncertain');
  assert.equal(f.bridge.list()[0].controls?.canDelete, false);
  await assert.rejects(f.bridge.delete('helper-pause'), /清理/);
  const directory = path.join(networkRuntimeRoot(), 'codex-workspaces', codexRootKey(await realpath(f.root)) + '.lock');
  assert.equal(JSON.parse(await readFile(path.join(directory, 'owner.json'), 'utf8')).state, 'quarantined');
  await assert.rejects(CodexWorkspaceLease.acquire(directory, { timeoutMs: 50 }), /incompatible|quarantined/);
});

test('A watcher reload cannot replace the queued record while resume is being saved', async t => {
  const f = await setup(t);
  await f.bridge.enqueue(f.spec, 'resume-race'); await until(() => f.bridge.list()[0].status === 'completed');
  const save = CodexTaskStore.prototype.save;
  let entered = false, release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  t.mock.method(CodexTaskStore.prototype, 'save', async function (this: CodexTaskStore, record: CodexTaskRecord) {
    if (record.id === 'resume-race' && record.status === 'queued' && !entered) { entered = true; await gate; }
    return save.call(this, record);
  });
  const resumed = f.bridge.resume('resume-race');
  try {
    await until(() => entered); await f.bridge.publish();
    assert.equal(f.bridge.list()[0].controls?.canResume, false);
    assert.equal(f.bridge.list()[0].controls?.canDelete, false);
  } finally { release(); }
  await resumed;
  await until(() => f.requests.filter(request => request.method === 'turn/start').length === 2);
  await until(() => f.bridge.list()[0].status === 'completed');
});

test('A stale watcher snapshot cannot regress a paused task or clear its Auto-Accept setting', async t => {
  const f = await setup(t, 'hold');
  await f.bridge.enqueue(f.spec, 'stale-pause'); await until(() => !!f.bridge.list()[0].turnId);
  const stale = structuredClone((f.bridge as any).records.get('stale-pause')) as CodexTaskRecord;
  await f.bridge.setAutoAccept('stale-pause', true); await f.bridge.pause('stale-pause');
  t.mock.method(CodexTaskStore.prototype, 'load', async () => [stale]);
  await f.bridge.publish();
  assert.equal(f.bridge.list()[0].status, 'paused');
  assert.equal(f.bridge.list()[0].controls?.autoAccept, true);
});

test('Deletion retains generated results and conversations, and tombstones reject stale writers in every host', async t => {
  const f = await setup(t, 'hold');
  await f.bridge.enqueue(f.spec, 'delete-me');
  await until(() => !!f.bridge.list()[0].turnId);
  await assert.rejects(f.bridge.delete('delete-me'), /暫停/);
  await f.bridge.pause('delete-me');
  const store = new CodexTaskStore(path.join(f.root, 'codex-tasks')), stale = (await store.load())[0];
  const result = path.join(f.root, 'generated-report.md'); await writeFile(result, 'Retained report');
  const observer = new CodexBridge({ ...(f.bridge as any).options, event: () => {} });
  t.after(() => observer.shutdown()); await observer.publish();
  await f.bridge.delete('delete-me'); await observer.publish();
  assert.equal(f.bridge.list().length, 0); assert.equal(observer.list().length, 0);
  assert.equal(await readFile(result, 'utf8'), 'Retained report');
  await assert.rejects(store.save(stale), /已刪除/);
  await assert.rejects(f.bridge.enqueue(f.spec, 'delete-me'), /已刪除/);
  assert.equal((await store.load()).length, 0);
  assert.equal(f.requests.some(request => ['thread/archive', 'thread/delete'].includes(request.method)), false);
});

test('A late watcher snapshot cannot resurrect a deleted task', async t => {
  const f = await setup(t);
  await f.bridge.enqueue(f.spec, 'deleted-snapshot'); await until(() => f.bridge.list()[0].status === 'completed');
  const stale = structuredClone((f.bridge as any).records.get('deleted-snapshot')) as CodexTaskRecord;
  await f.bridge.delete('deleted-snapshot');
  t.mock.method(CodexTaskStore.prototype, 'load', async () => [stale]);
  await f.bridge.publish(); assert.deepEqual(f.bridge.list(), []);
});

test('Auto-Accept is off by default, drains pending approvals once, and leaves questions and MCP interactions manual', async t => {
  const f = await setup(t, 'auto-approvals', 'duplicate-approval');
  await f.bridge.enqueue(f.spec, 'auto-task');
  await until(() => f.bridge.list()[0].status === 'waiting');
  assert.equal(f.bridge.list()[0].controls?.autoAccept, false); assert.equal(f.responses.length, 0);
  await f.bridge.setAutoAccept('auto-task', true);
  await until(() => f.responses.length === 5);
  assert.deepEqual(f.responses.map(response => response.id), [91, 92, 93, 94, 95]);
  assert.deepEqual(f.responses.slice(0, 4).map(response => response.result), Array.from({ length: 4 }, () => ({ decision: 'accept' })));
  assert.deepEqual(f.responses[4].result, { permissions: { network: { enabled: true } }, scope: 'turn' });
  await until(() => [...(f.bridge as any).interactions.values()].some((value: any) => value.projection.kind === 'questions'));
  assert.equal(f.responses.length, 5);
  await f.bridge.setAutoAccept('auto-task', false);
  for (const kind of ['questions', 'form', 'url']) {
    await until(() => [...(f.bridge as any).interactions.values()].some((value: any) => value.projection.kind === kind));
    const pending = [...(f.bridge as any).interactions.values()].find((value: any) => value.projection.kind === kind) as any;
    await f.bridge.answer('auto-task', pending.projection.id, { decision: 'accept', answers: { choice: 'A' }, content: { name: 'test' } });
  }
  await until(() => f.bridge.list()[0].status === 'completed');
  const observer = new CodexBridge({ ...(f.bridge as any).options, event: () => {} }); t.after(() => observer.shutdown());
  await observer.publish(); assert.equal(observer.list()[0].controls?.autoAccept, false);
  await until(() => f.events.some(event => event.kind === 'output' && event.items.some(item => item.kind === 'notice' && item.text.includes('已自動核准'))));
});

test('an immediate manual reply during interaction delivery cannot race auto-answer', async t => {
  const f = await setup(t, 'auto-approvals');
  const options = (f.bridge as any).options as CodexBridgeOptions;
  options.event = event => {
    f.events.push(event);
    if (event.kind === 'interactions') for (const interaction of event.interactions) {
      if (interaction.kind === 'command' || interaction.kind === 'file' || interaction.kind === 'permissions') {
        void f.bridge.answer(interaction.taskId, interaction.id, { decision: 'decline' });
      }
    }
  };
  await f.bridge.enqueue(f.spec, 'immediate-reply');
  await until(() => f.responses.length >= 1);
  assert.equal(f.responses[0].result.decision, 'decline');
  await f.bridge.pause('immediate-reply');
});

test('Auto-Accept respects allowed decisions and turns off after a transport response error', async t => {
  const f = await setup(t, 'auto-approvals', 'no-single-approval');
  await f.bridge.enqueue(f.spec, 'restricted-auto'); await until(() => f.bridge.list()[0].status === 'waiting');
  await f.bridge.setAutoAccept('restricted-auto', true); assert.equal(f.responses.length, 0);
  const pending = [...(f.bridge as any).interactions.values()][0] as any;
  pending.request.params.availableDecisions = ['accept', 'decline'];
  pending.client.respond = () => { throw new Error('response transport failed'); };
  await f.bridge.setAutoAccept('restricted-auto', true);
  assert.equal(f.bridge.list()[0].controls?.autoAccept, false);
  assert.match(f.bridge.list()[0].controls?.autoAcceptError ?? '', /已關閉/);
  assert.equal((f.bridge as any).interactions.size, 1);
});

test('A connection lost after sending an approval disables Auto-Accept and retains an uncertain outcome', async t => {
  const f = await setup(t, 'auto-approvals', 'exit-after-approval');
  await f.bridge.enqueue(f.spec, 'lost-approval'); await until(() => f.bridge.list()[0].status === 'waiting');
  await f.bridge.setAutoAccept('lost-approval', true);
  await until(() => f.bridge.list()[0].status === 'uncertain');
  assert.equal(f.bridge.list()[0].controls?.autoAccept, false);
  assert.match(f.bridge.list()[0].controls?.autoAcceptError ?? '', /連線已中斷/);
  assert.equal(f.responses.length, 1);
});
test('Workspace lease recovery requires an exact supervisor completion receipt', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'codex-lease-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = path.join(root, 'workspace.lock'), nonce = '12345678-1234-1234-1234-123456789abc';
  await mkdir(directory);
  await writeFile(path.join(directory, 'owner.json'), JSON.stringify({ schema: 'GitLabWorkspaceLease/v1', kind: 'codex', nonce, pid: 2147483647 }));
  await assert.rejects(CodexWorkspaceLease.acquire(directory, { timeoutMs: 50 }), /previous|stopped/);
  const receipt = directory + `.stopped-${nonce}.json`;
  await writeFile(receipt, JSON.stringify({ schema: 'GitLabWorkspaceCodexProcess/v1', nonce, processTreeConfirmed: true }));
  const lease = await CodexWorkspaceLease.acquire(directory, { timeoutMs: 50 }); await lease.release();
});

test('Missing CLI, login, sandbox and managed requirements block execution before a turn starts', async t => {
  await assert.rejects(resolveCodexExecutable(path.join(os.tmpdir(), 'missing-codex-executable', 'codex.exe')), /找不到/);
  for (const mode of ['logged-out', ...(process.platform === 'win32' ? ['sandbox-missing'] : []), 'managed']) {
    const f = await setup(t, 'success', mode);
    await f.bridge.check(f.root);
    assert.ok(f.events.some(event => event.kind === 'environment' && event.environment.state === 'blocked'));
    await f.bridge.enqueue(f.spec, 'blocked-' + mode);
    await until(() => f.bridge.list()[0].status === 'failed');
    assert.equal(f.requests.some(value => value.method === 'thread/start' || value.method === 'turn/start'), false);
  }
});

test('A rejected follow-up is not retained for a later resume after environment repair', async t => {
  const f = await setup(t);
  await f.bridge.enqueue(f.spec, 'follow-up');
  await until(() => f.events.some(event => event.kind === 'tasks' && event.tasks[0].status === 'completed'));
  f.change(); await assert.rejects(f.bridge.message('follow-up', 'This rejected message must not run later'), /已變更/);
  f.restore(); await f.bridge.resume('follow-up');
  await until(() => f.requests.filter(value => value.method === 'turn/start').length === 2);
  assert.doesNotMatch(f.requests.filter(value => value.method === 'turn/start')[1].params.input[0].text, /rejected message/);
});

test('A first-turn retry retains the original task and supplemental input without replaying an unknown dispatch', async t => {
  for (const state of ['no-thread', 'empty-thread', 'unknown-dispatch']) {
    const f = await setup(t, 'original task context', 'empty-thread'), now = new Date().toISOString();
    await new CodexTaskStore(path.join(f.root, 'codex-tasks')).save({ schema: 'GitLabWorkspaceCodexTask/v1',
      id: state, spec: f.spec, title: f.spec.title, root: f.root, status: state === 'unknown-dispatch' ? 'uncertain' : 'interrupted',
      ownerPid: process.pid, createdAt: now, updatedAt: now,
      threadId: state === 'no-thread' ? undefined : 'saved-empty-thread', dispatchPending: state === 'unknown-dispatch' });
    await f.bridge.message(state, 'supplemental retry instruction');
    if (state === 'unknown-dispatch') {
      await until(() => f.bridge.list()[0].status === 'uncertain');
      assert.equal(f.requests.some(value => value.method === 'turn/start'), false);
      assert.match(f.bridge.list()[0].error!, /不會自動重送/);
    } else {
      await until(() => f.bridge.list()[0].status === 'completed');
      const input = f.requests.find(value => value.method === 'turn/start')!.params.input[0].text;
      assert.match(input, /original task context/); assert.match(input, /supplemental retry instruction/);
    }
  }
});

test('Reviewer admission rejects runtimes inside any Repo and overly broad writable roots', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'codex-runtime-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const project = path.join(root, 'project'), external = path.join(root, 'external');
  await mkdir(project); await mkdir(external);
  execFileSync('git', ['init', '-q', project], { windowsHide: true });
  assert.equal(await canonicalRuntime(path.join(external, 'missing', 'runtime'), project), path.join(await import('node:fs/promises').then(fs => fs.realpath(external)), 'missing', 'runtime'));
  await assert.rejects(canonicalRuntime(root, project), /不可包含/);
  await assert.rejects(canonicalRuntime(path.join(project, 'runtime'), project), /Repo 內/);
});
