import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { GitLabNetworkGate } from '../../src/api/gitLabNetworkGate';
import { GitLabClient, GitLabWriteUnknownError } from '../../src/api/gitLabClient';
import { LEASE_SCHEMA, LocalNetworkLease, networkHostKey, readNetworkMetadata } from '../../src/api/localNetworkLease';
import { acquireStorageControl } from '../../src/storage/controlLease';
import { OperationLog } from '../../src/logging/operationLog';

const endpoint = new URL('https://coordination.example/api/v4/user');
async function fixture(t: test.TestContext) {
  const parent = await fs.realpath(os.tmpdir());
  const root = await fs.mkdtemp(path.join(parent, 'glw-coordination-recovery-'));
  const directory = path.join(root, 'api', networkHostKey(endpoint.hostname));
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(path.join(root, 'network-policy.json'), JSON.stringify({ schema: 'GitLabWorkspaceNetworkPolicy/v1', api: { startsPerSecond: 1000, concurrency: 2 } }));
  t.after(async () => {
    assert.equal(path.dirname(await fs.realpath(root)), parent);
    assert.ok(path.basename(root).startsWith('glw-coordination-recovery-'));
    await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 30 });
  });
  return { root, directory, control: path.join(directory, 'control.lock'), state: path.join(directory, 'state.json') };
}

test('an admission release failure sends nothing and recovers its reserved slot across clients', async t => {
  const f = await fixture(t), release = LocalNetworkLease.prototype.release;
  let fail = true, sent = 0;
  t.mock.method(LocalNetworkLease.prototype, 'release', async function (this: LocalNetworkLease, ...args: Parameters<typeof release>) {
    if (this.directory === f.control && fail) { fail = false; throw Object.assign(new Error('control sharing failure'), { code: 'EACCES' }); }
    return release.apply(this, args);
  });
  await assert.rejects(new GitLabNetworkGate(f.root, 5_000).fetch(async () => { sent++; return new Response('{}'); }, endpoint));
  assert.equal(sent, 0);
  assert.deepEqual(JSON.parse(await fs.readFile(f.state, 'utf8')).active, [], 'a failure before sending must not strand the current PID slot');
  assert.equal((await new GitLabNetworkGate(f.root, 5_000).fetch(async () => { sent++; return new Response('recovered'); }, endpoint)).status, 200);
  assert.equal(sent, 1);
});

test('a proven dead reserved API control recovers without resetting pacing or foreign reservations', async t => {
  const f = await fixture(t);
  await fs.mkdir(f.control);
  await fs.writeFile(path.join(f.control, 'owner.json'), JSON.stringify({ schema: LEASE_SCHEMA, nonce: randomUUID(), pid: 2147483647,
    createdAt: new Date().toISOString(), kind: 'api-control', state: 'reserved', childPid: null, processTreeConfirmed: false }));
  const foreign = { nonce: randomUUID(), pid: process.pid, startedAt: Date.now(), deadline: Date.now() + 60_000 };
  const cooldown = Date.now() + 100;
  await fs.writeFile(f.state, JSON.stringify({ schema: 'GitLabWorkspaceApiState/v1', nextStartAt: cooldown, cooldownUntil: cooldown, active: [foreign] }));
  let sent = 0;
  await new GitLabNetworkGate(f.root, 800, false).fetch(async () => { sent++; assert.ok(Date.now() >= cooldown); return new Response('{}'); }, endpoint);
  assert.equal(sent, 1);
  const state = JSON.parse(await fs.readFile(f.state, 'utf8'));
  assert.deepEqual(state.active, [foreign]);
  assert.ok(state.nextStartAt >= cooldown);
  assert.equal(state.cooldownUntil, cooldown);
});

test('unreleased admission ownership stays known until another client can safely remove only its orphan', async t => {
  const f = await fixture(t), release = LocalNetworkLease.prototype.release;
  let blocked = true, sent = 0;
  t.mock.method(LocalNetworkLease.prototype, 'release', async function (this: LocalNetworkLease, ...args: Parameters<typeof release>) {
    if (this.directory === f.control && blocked) throw Object.assign(new Error('locked metadata'), { code: 'EPERM' });
    return release.apply(this, args);
  });
  await assert.rejects(new GitLabNetworkGate(f.root, 500).fetch(async () => { sent++; return new Response('{}'); }, endpoint));
  const pending = JSON.parse(await fs.readFile(f.state, 'utf8'));
  assert.equal(pending.active.length, 1);
  assert.equal(pending.active[0].pid, process.pid);
  assert.equal(sent, 0);
  blocked = false;
  await new GitLabNetworkGate(f.root, 500).fetch(async () => { sent++; return new Response('{}'); }, endpoint);
  assert.equal(sent, 1);
  assert.deepEqual(JSON.parse(await fs.readFile(f.state, 'utf8')).active, []);
});

test('unknown, quarantined and live API control owners are preserved with zero requests', async t => {
  for (const state of ['quarantined', 'running', 'unknown', 'reserved']) {
    const f = await fixture(t);
    await fs.mkdir(f.control);
    const owner = { schema: LEASE_SCHEMA, nonce: randomUUID(), pid: state === 'reserved' ? process.pid : 2147483647,
      kind: 'api-control', state, childPid: state === 'running' ? 123 : null };
    const contents = JSON.stringify(owner); await fs.writeFile(path.join(f.control, 'owner.json'), contents);
    let sent = 0;
    await assert.rejects(new GitLabNetworkGate(f.root, 80).fetch(async () => { sent++; return new Response('{}'); }, endpoint));
    assert.equal(sent, 0);
    assert.equal(await fs.readFile(path.join(f.control, 'owner.json'), 'utf8'), contents);
  }
});

test('metadata reads retry only bounded Windows sharing errors and never rebase their deadline', { skip: process.platform !== 'win32' }, async t => {
  const f = await fixture(t), read = fs.readFile;
  let reads = 0;
  const mock = t.mock.method(fs, 'readFile', async (...args: Parameters<typeof read>) => {
    if (String(args[0]) === f.state && ++reads <= 2) throw Object.assign(new Error('temporary handle'), { code: 'EBADF' });
    return read(...args);
  });
  await fs.writeFile(f.state, 'metadata');
  assert.equal(await readNetworkMetadata(f.state, { deadline: Date.now() + 500 }), 'metadata');
  assert.equal(reads, 3);
  mock.mock.restore(); reads = 0;
  t.mock.method(fs, 'readFile', async () => { reads++; throw Object.assign(new Error('persistent handle'), { code: 'EBADF' }); });
  await assert.rejects(readNetworkMetadata(f.state, { deadline: Date.now() + 500 }), { code: 'EBADF' });
  assert.equal(reads, 4);
});

test('pre-admission diagnostics reach the operation log without a fetch or credential contents', async t => {
  const f = await fixture(t), mkdir = fs.mkdir, output: string[] = [];
  const sink = { info: (line: string) => output.push(line), warn: (line: string) => output.push(line), error: (line: string) => output.push(line) };
  const log = new OperationLog(sink); log.addSecret('host-only-credential'); t.after(() => log.dispose());
  t.mock.method(fs, 'mkdir', async (...args: Parameters<typeof mkdir>) => {
    if (String(args[0]) === f.directory) throw Object.assign(new Error('host-only-credential'), { code: 'EACCES' });
    return mkdir(...args);
  });
  let sent = 0;
  await assert.rejects(log.run('startup', 'issues', {}, () => new GitLabNetworkGate(f.root, 100).fetch(async () => { sent++; return new Response('{}'); }, endpoint)));
  const line = output.find(value => value.startsWith('[api-coordination] admission error '));
  assert.ok(line);
  const entry = JSON.parse(line.slice(line.indexOf('{')));
  assert.equal(entry.coordinationCode, 'runtime-access');
  assert.equal(entry.coordinationPhase, 'admission');
  assert.equal(entry.systemCode, 'EACCES');
  assert.equal(entry.requestStarted, false);
  assert.equal(entry.runtimePath, f.root);
  assert.equal(sent, 0);
  assert.equal(output.some(value => value.includes('host-only-credential')), false);
});

test('a cancelled admitted request releases its slot without using the cancelled signal for cleanup', async t => {
  const f = await fixture(t), release = LocalNetworkLease.prototype.release, controller = new AbortController();
  let cancelled = false, sent = 0;
  t.mock.method(LocalNetworkLease.prototype, 'release', async function (this: LocalNetworkLease, ...args: Parameters<typeof release>) {
    await release.apply(this, args);
    if (this.directory === f.control && !cancelled) { cancelled = true; controller.abort(); }
  });
  await assert.rejects(new GitLabNetworkGate(f.root, 500).fetch(async () => { sent++; return new Response('{}'); }, endpoint, { signal: controller.signal }), { name: 'AbortError' });
  assert.equal(sent, 0);
  assert.deepEqual(JSON.parse(await fs.readFile(f.state, 'utf8')).active, []);
});

test('post-send cleanup failure remains an unknown write and never repeats the POST', async t => {
  const f = await fixture(t), release = LocalNetworkLease.prototype.release;
  let posts = 0, fail = true;
  t.mock.method(LocalNetworkLease.prototype, 'release', async function (this: LocalNetworkLease, ...args: Parameters<typeof release>) {
    if (this.directory === f.control && posts && fail) { fail = false; throw Object.assign(new Error('cleanup sharing failure'), { code: 'EACCES' }); }
    return release.apply(this, args);
  });
  const gate = new GitLabNetworkGate(f.root, 500);
  const client = Reflect.construct(GitLabClient, ['https://coordination.example', 'SYNTHETIC', async () => { posts++; return new Response('{"id":1}'); },
    undefined, undefined, undefined, undefined, 2000, gate]) as GitLabClient;
  await assert.rejects(client.createIssue(1, { title: 'A single write' }), error => error instanceof GitLabWriteUnknownError);
  assert.equal(posts, 1);
  await new GitLabNetworkGate(f.root, 500).fetch(async () => new Response('{}'), endpoint);
  assert.deepEqual(JSON.parse(await fs.readFile(f.state, 'utf8')).active, []);
  assert.equal(posts, 1);
});

test('coordination failures carry a safe admission reason instead of losing the system cause', async t => {
  const f = await fixture(t), mkdir = fs.mkdir;
  t.mock.method(fs, 'mkdir', async (...args: Parameters<typeof mkdir>) => {
    if (String(args[0]) === f.directory) throw Object.assign(new Error('fixture permission denied'), { code: 'EACCES' });
    return mkdir(...args);
  });
  let sent = false;
  await assert.rejects(new GitLabNetworkGate(f.root, 100).fetch(async () => { sent = true; return new Response('{}'); }, endpoint), error => {
    const failure = error as Error & { effect?: string; diagnostics?: { phase: string; systemCode?: string; requestStarted: boolean } };
    assert.equal(failure.effect, 'none');
    assert.equal(failure.diagnostics?.phase, 'admission');
    assert.equal(failure.diagnostics?.systemCode, 'EACCES');
    assert.equal(failure.diagnostics?.requestStarted, false);
    return true;
  });
  assert.equal(sent, false);
});

test('control recovery cannot restart an exhausted absolute admission budget', async t => {
  const f = await fixture(t), read = fs.readFile;
  await fs.mkdir(f.control);
  const ownerPath = path.join(f.control, 'owner.json');
  const owner = { schema: LEASE_SCHEMA, nonce: randomUUID(), pid: 2147483647, kind: 'api-control', state: 'reserved', childPid: null };
  await fs.writeFile(ownerPath, JSON.stringify(owner));
  let delayed = false;
  t.mock.method(fs, 'readFile', async (...args: Parameters<typeof read>) => {
    if (String(args[0]) === ownerPath && !delayed) { delayed = true; await new Promise(resolve => setTimeout(resolve, 60)); }
    return read(...args);
  });
  const options = { timeoutMs: 40, deadline: Date.now() + 40 };
  await assert.rejects(acquireStorageControl(f.control, 'api-control', options), { name: 'TimeoutError' });
  assert.deepEqual(JSON.parse(await read(ownerPath, 'utf8')), owner, 'budget expiry must not delete the inspected owner');
});

test('legacy non-waiting resource claims can persist their first owner without extending contended waits', async t => {
  const f = await fixture(t), write = fs.writeFile;
  const directory = path.join(f.root, 'resource.lock');
  t.mock.method(fs, 'writeFile', async (...args: Parameters<typeof write>) => {
    if (String(args[0]).startsWith(path.join(directory, 'owner.json.'))) await new Promise(resolve => setTimeout(resolve, 20));
    return write(...args);
  });
  const lease = await LocalNetworkLease.acquire(directory, 'codex', { timeoutMs: 1 });
  const owner = JSON.parse(await fs.readFile(path.join(directory, 'owner.json'), 'utf8'));
  assert.equal(owner.pid, process.pid);
  assert.equal(owner.kind, 'codex');
  await assert.rejects(LocalNetworkLease.acquire(directory, 'codex', { timeoutMs: 1 }), { name: 'TimeoutError' });
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(directory, 'owner.json'), 'utf8')), owner);
  await lease.release();
  await assert.rejects(fs.lstat(directory), { code: 'ENOENT' });
});

test('cleanup stops starting I/O after its independent budget and preserves ownership for a later client', async t => {
  const f = await fixture(t), read = fs.readFile, write = fs.writeFile, now = Date.now;
  let offset = 0, sent = 0, expired = false, writesAfterExpiry = 0;
  const clock = t.mock.method(Date, 'now', () => now() + offset);
  t.mock.method(fs, 'readFile', async (...args: Parameters<typeof read>) => {
    const value = await read(...args);
    if (String(args[0]) === f.state && sent && !expired) { expired = true; offset = 6000; }
    return value;
  });
  t.mock.method(fs, 'writeFile', async (...args: Parameters<typeof write>) => { if (offset) writesAfterExpiry++; return write(...args); });
  await assert.rejects(new GitLabNetworkGate(f.root, 500).fetch(async () => { sent++; return new Response('{}'); }, endpoint), error => {
    const failure = error as Error & { effect?: string; diagnostics?: { requestStarted: boolean; code: string } };
    assert.equal(failure.effect, undefined);
    assert.equal(failure.diagnostics?.requestStarted, true);
    assert.equal(failure.diagnostics?.code, 'queue-timeout');
    return true;
  });
  assert.equal(sent, 1); assert.equal(writesAfterExpiry, 0);
  assert.equal(JSON.parse(await read(f.state, 'utf8')).active.length, 1);
  assert.equal(JSON.parse(await read(path.join(f.control, 'owner.json'), 'utf8')).pid, process.pid);
  offset = 0; clock.mock.restore();
  await new GitLabNetworkGate(f.root, 500).fetch(async () => new Response('{}'), endpoint);
  assert.deepEqual(JSON.parse(await read(f.state, 'utf8')).active, []);
});
