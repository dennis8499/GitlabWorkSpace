import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import os from 'node:os';
import { CodexBridge } from '../../src/codex/bridge';
import type { CodexAppServer } from '../../src/codex/appServer';
import type { CodexEvent, CodexTaskRecord } from '../../src/codex/protocol';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
const page = (text = 'History') => ({ data: [{ id: 'turn', status: 'completed', items: [{ id: 'reply', type: 'agentMessage', text }] }], nextCursor: 'older' });
function fixture(t: test.TestContext, read: (params: Record<string, unknown>) => Promise<unknown> = async () => page()) {
  let now = 1000, clients = 0, requests = 0, closed = 0;
  const events: CodexEvent[] = [], root = path.join(os.tmpdir(), 'glw-history-cache-fixture');
  const record: CodexTaskRecord = { schema: 'GitLabWorkspaceCodexTask/v1', id: 'task', root, title: 'Fixture', status: 'completed',
    ownerPid: process.pid, threadId: 'thread', turnId: 'turn', createdAt: '2026-11-06T00:00:00Z', updatedAt: '2026-11-06T00:00:01Z',
    spec: { root, workspaceKey: 'fixture', title: 'Fixture', source: { kind: 'skill', featureId: 'query', inputs: {}, revision: 'fixture' },
      prompt: 'Fixture', skill: { name: 'fixture', path: path.join(root, 'SKILL.md') }, writableRoots: [root], environmentKey: 'fixture' } };
  const client = { request: async (_method: string, params: Record<string, unknown>) => { requests++; return read(params); }, close: async () => { closed++; } } as unknown as CodexAppServer;
  const bridge = new CodexBridge({ storage: root, version: 'test', executable: () => '', trusted: () => true,
    prepare: async () => record.spec, openUrl: async () => {}, event: event => events.push(event), now: () => now,
    client: async () => { clients++; return { client, version: 'fixture', executable: 'fixture' }; } });
  const state = bridge as any;
  state.initialized = Promise.resolve(); state.records.set(record.id, record);
  t.after(async () => { state.active = undefined; await bridge.shutdown(); });
  return { bridge, state, record, client, events, counts: () => ({ clients, requests, closed }), advance: () => { now += 60_001; } };
}

test('history shares in-flight pages and replays cached data without creating an App Server', async t => {
  const hold = deferred<unknown>();
  const f = fixture(t, async () => hold.promise);
  const first = f.bridge.history('task'), second = f.bridge.history('task');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.counts().clients, 1); assert.equal(f.counts().requests, 1);
  hold.resolve(page()); await Promise.all([first, second]);
  f.events.length = 0;
  await f.bridge.history('task');
  assert.deepEqual(f.counts(), { clients: 1, requests: 1, closed: 1 });
  assert.ok(f.events.some(event => event.kind === 'history' && event.items[0].text === 'History'));
});

test('history separates cursors and task revisions, expires after sixty seconds and supports explicit refresh', async t => {
  const f = fixture(t);
  await f.bridge.history('task'); await f.bridge.history('task', 'older'); await f.bridge.history('task', 'older');
  assert.equal(f.counts().requests, 2);
  f.advance(); await f.bridge.history('task'); assert.equal(f.counts().requests, 3);
  await f.bridge.history('task', undefined, true); assert.equal(f.counts().requests, 4);
  f.record.updatedAt = '2026-11-06T00:00:02Z'; await f.bridge.history('task'); assert.equal(f.counts().requests, 5);
  f.record.threadId = 'another-thread'; await f.bridge.history('task'); assert.equal(f.counts().requests, 6);
});

test('failed history is not cached and a late read cannot overwrite a forced fresh page', async t => {
  const hold = deferred<unknown>(); let attempt = 0;
  const f = fixture(t, async () => {
    attempt++;
    if (attempt === 1) throw new Error('Unavailable');
    return attempt === 2 ? hold.promise : page('Fresh');
  });
  await assert.rejects(f.bridge.history('task'), /Unavailable/);
  const older = f.bridge.history('task'); await new Promise(resolve => setImmediate(resolve));
  await f.bridge.history('task', undefined, true);
  f.events.length = 0; hold.resolve(page('Stale')); await older;
  assert.equal(f.events.some(event => event.kind === 'history'), false);
  await f.bridge.history('task');
  assert.equal(f.counts().requests, 3);
  assert.ok(f.events.some(event => event.kind === 'history' && event.items[0].text === 'Fresh'));
});

test('cancelling a history subscriber never closes the client executing an active task', async t => {
  const hold = deferred<unknown>(), f = fixture(t, async () => hold.promise), controller = new AbortController();
  f.state.active = { record: f.record, client: f.client };
  const pending = f.bridge.history('task', undefined, false, controller.signal);
  await new Promise(resolve => setImmediate(resolve)); controller.abort();
  await assert.rejects(pending, error => error instanceof Error && error.name === 'AbortError');
  assert.equal(f.counts().closed, 0); assert.equal(f.counts().clients, 0);
  hold.resolve(page()); await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.events.some(event => event.kind === 'history'), false);
});

test('an unchanged workflow result preserves the task version and its warm history page', async t => {
  const f = fixture(t); let saves = 0;
  f.state.store.control = async (_id: string, action: () => Promise<void>) => action();
  f.state.store.save = async () => { saves++; };
  f.state.reload = async () => {};
  f.record.result = { state: 'draft', summary: 'Preview ready', draftId: 'draft', revision: 'checked' };
  const version = f.record.updatedAt;
  await f.bridge.history('task');
  await f.bridge.resultAction('task', async () => ({ ...f.record.result!, url: undefined }));
  await f.bridge.history('task');
  assert.equal(saves, 0); assert.equal(f.record.updatedAt, version); assert.equal(f.counts().requests, 1);
  await f.bridge.resultAction('task', async () => ({ ...f.record.result!, summary: 'New result' }));
  await f.bridge.history('task');
  assert.equal(saves, 1); assert.notEqual(f.record.updatedAt, version); assert.equal(f.counts().requests, 2);
});
