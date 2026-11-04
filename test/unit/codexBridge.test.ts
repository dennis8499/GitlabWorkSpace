import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { CodexAppServer } from '../../src/codex/appServer';
import { CodexBridge, validateForm } from '../../src/codex/bridge';
import { CodexTaskStore } from '../../src/codex/taskStore';
import { CodexWorkspaceLease } from '../../src/codex/workspaceLease';
import { resolveCodexExecutable } from '../../src/codex/process';
import { canonicalRuntime } from '../../src/codex/taskValidation';
import type { CodexEvent, CodexInteraction, CodexTaskSpec } from '../../src/codex/protocol';

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
async function setup(t: { after(fn: () => Promise<void>): void }, prompt = 'success', mode = '') {
  const root = await mkdtemp(path.join(os.tmpdir(), 'codex-bridge-'));
  const skill = path.join(root, '.agents/skills/codebase-wiki/SKILL.md');
  await mkdir(path.dirname(skill), { recursive: true }); await writeFile(skill, 'offline test Skill');
  const events: CodexEvent[] = [], requests: Array<{ method: string; params: any }> = [];
  const spec: CodexTaskSpec = { title: 'Wiki 查詢', root, workspaceKey: root, source: { kind: 'skill', featureId: 'query', inputs: {}, revision: 'r' },
    prompt, skill: { name: 'codebase-wiki', path: skill }, writableRoots: [root], environmentKey: 'environment' };
  let trusted = true, changed = false;
  const make = (storage = root) => new CodexBridge({ storage, version: 'test', executable: () => '', trusted: () => trusted,
    prepare: async () => ({ ...spec, environmentKey: changed ? 'changed' : 'environment' }), event: event => events.push(event), openUrl: async () => {},
    client: async () => {
      const client = peer(root, 3000, mode); const request = client.request.bind(client);
      client.request = (method, params) => { requests.push({ method, params }); return request(method, params); };
      await client.initialize('test'); return { client, version: '0.165.0', executable: 'offline-peer' };
    } });
  const bridges: CodexBridge[] = [];
  const bridge = make(); bridges.push(bridge);
  t.after(async () => { await Promise.all(bridges.map(value => value.shutdown())); await rm(root, { recursive: true, force: true }); });
  return { root, spec, bridge, events, requests, change: () => { changed = true; }, restore: () => { changed = false; }, untrust: () => { trusted = false; },
    second: () => { const value = make(path.join(root, 'second')); bridges.push(value); return value; } };
}
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
  const bridge = new CodexBridge({ storage: f.root, version: 'test', executable: () => '', trusted: () => true,
    prepare: async () => f.spec, event: () => {}, openUrl: async () => {} });
  t.after(() => bridge.shutdown());
  await bridge.publish(); assert.equal(bridge.list()[0].status, 'completed'); assert.equal(f.requests.length, before); await bridge.shutdown();
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
  assert.ok(f.events.some(value => value.kind === 'history' && value.items[0].text.includes('先前')));
});
test('Unknown server requests stop the turn and release the queue', async t => {
  const f = await setup(t, 'unknown-request');
  await f.bridge.enqueue(f.spec, 'unknown');
  await until(() => ['interrupted', 'uncertain'].includes(f.bridge.list()[0].status));
  await f.bridge.enqueue({ ...f.spec, prompt: 'success' }, 'after-unknown');
  await until(() => f.bridge.list().find(value => value.id === 'after-unknown')?.status === 'completed');
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
