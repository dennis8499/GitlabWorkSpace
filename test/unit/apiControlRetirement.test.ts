import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { LEASE_SCHEMA, LocalNetworkLease, networkHostKey } from '../../src/api/localNetworkLease';
import { GitLabNetworkGate } from '../../src/api/gitLabNetworkGate';
import { GitLabClient } from '../../src/api/gitLabClient';
import { acquireStorageControl } from '../../src/storage/controlLease';
import { OperationLog } from '../../src/logging/operationLog';

const endpoint = new URL('https://retirement.example/api/v4/user');
async function fixture(t: test.TestContext) {
  const parent = await fs.realpath(os.tmpdir()), root = await fs.mkdtemp(path.join(parent, 'glw-api-retire-'));
  const directory = path.join(root, 'api', networkHostKey(endpoint.hostname));
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(path.join(root, 'network-policy.json'), JSON.stringify({ schema: 'GitLabWorkspaceNetworkPolicy/v1', api: { startsPerSecond: 1000, concurrency: 2 } }));
  t.after(async () => {
    const resolved = await fs.realpath(root);
    assert.equal(path.dirname(resolved), parent); assert.ok(path.basename(resolved).startsWith('glw-api-retire-'));
    await fs.rm(resolved, { recursive: true, force: true, maxRetries: 5, retryDelay: 30 });
  });
  return { root, directory, control: path.join(directory, 'control.lock'), state: path.join(directory, 'state.json') };
}

test('API release retires the directory before deleting metadata so a canonical rmdir failure cannot strand admission', async t => {
  const f = await fixture(t), rmdir = fs.rmdir;
  const lease = await LocalNetworkLease.acquire(f.control, 'api-control');
  t.mock.method(fs, 'rmdir', async (...args: Parameters<typeof rmdir>) => {
    if (String(args[0]) === f.control) throw Object.assign(new Error('canonical directory sharing failure'), { code: 'EPERM' });
    return rmdir(...args);
  });
  await lease.release({ deadline: Date.now() + 1000 });
  await assert.rejects(fs.lstat(f.control), { code: 'ENOENT' });
  let sent = 0;
  await new GitLabNetworkGate(f.root, 1000, false).fetch(async () => { sent++; return new Response('{}'); }, endpoint);
  assert.equal(sent, 1); assert.deepEqual(JSON.parse(await fs.readFile(f.state, 'utf8')).active, []);
});

test('retired directory cleanup failure warns without blocking clients or changing a confirmed POST result', async t => {
  const f = await fixture(t), unlink = fs.unlink, output: string[] = [];
  const log = new OperationLog({ info: line => output.push(line), warn: line => output.push(line), error: line => output.push(line) });
  log.addSecret('host-only-token');
  t.after(() => log.dispose());
  t.mock.method(fs, 'unlink', async (...args: Parameters<typeof unlink>) => {
    if (String(args[0]).startsWith(f.control + '.retired-')) throw Object.assign(new Error('host-only-token'), { code: 'EACCES' });
    return unlink(...args);
  });
  let posts = 0;
  const gate = new GitLabNetworkGate(f.root, 1000, false);
  const client = Reflect.construct(GitLabClient, ['https://retirement.example', 'host-only-token', async () => { posts++; return new Response('{"id":7}'); },
    undefined, undefined, undefined, undefined, 2000, gate]) as GitLabClient;
  const issue = await log.run('issue', 'create', {}, () => client.createIssue(1, { title: 'Confirmed single write' }));
  assert.equal(issue.id, 7); assert.equal(posts, 1);
  await gate.fetch(async () => new Response('{}'), endpoint);
  await new GitLabNetworkGate(f.root, 1000, false).fetch(async () => new Response('{}'), endpoint);
  assert.deepEqual(JSON.parse(await fs.readFile(f.state, 'utf8')).active, []);
  const warning = output.find(line => line.includes('retired-cleanup-pending'));
  assert.ok(warning); assert.ok(warning.includes('control.lock.retired-'));
  assert.equal(output.some(line => line.includes('host-only-token')), false);
  assert.ok((await fs.readdir(f.directory)).some(name => name.startsWith('control.lock.retired-')));
  await assert.rejects(fs.lstat(f.control), { code: 'ENOENT' });
});

test('Windows API retirement rechecks ownership after a sharing failure and preserves a replacement', { skip: process.platform !== 'win32' }, async t => {
  const f = await fixture(t), rename = fs.rename, lease = await LocalNetworkLease.acquire(f.control, 'api-control');
  const replacement = { ...JSON.parse(await fs.readFile(path.join(f.control, 'owner.json'), 'utf8')), nonce: randomUUID() };
  let attempts = 0;
  t.mock.method(fs, 'rename', async (...args: Parameters<typeof rename>) => {
    if (String(args[0]) === f.control) {
      attempts++; await fs.writeFile(path.join(f.control, 'owner.json'), JSON.stringify(replacement));
      throw Object.assign(new Error('sharing failure after owner replacement'), { code: 'EPERM' });
    }
    return rename(...args);
  });
  await assert.rejects(lease.release(), { coordinationCode: 'owner-changed' });
  assert.equal(attempts, 1); assert.deepEqual(JSON.parse(await fs.readFile(path.join(f.control, 'owner.json'), 'utf8')), replacement);
});

test('unexpected retired contents retain all metadata while the canonical lease is released', async t => {
  const f = await fixture(t), lease = await LocalNetworkLease.acquire(f.control, 'api-control');
  const owner = await fs.readFile(path.join(f.control, 'owner.json'), 'utf8');
  await fs.writeFile(path.join(f.control, 'unknown'), 'preserve'); await lease.release();
  await assert.rejects(fs.lstat(f.control), { code: 'ENOENT' });
  const retired = (await fs.readdir(f.directory)).find(name => name.startsWith('control.lock.retired-')); assert.ok(retired);
  assert.equal(await fs.readFile(path.join(f.directory, retired, 'owner.json'), 'utf8'), owner);
  assert.equal(await fs.readFile(path.join(f.directory, retired, 'unknown'), 'utf8'), 'preserve');
});

test('deadline expiry after successful retirement leaves the old metadata and never strands the canonical lock', async t => {
  const f = await fixture(t), rename = fs.rename, now = Date.now, lease = await LocalNetworkLease.acquire(f.control, 'api-control');
  let offset = 0;
  t.mock.method(Date, 'now', () => now() + offset);
  t.mock.method(fs, 'rename', async (...args: Parameters<typeof rename>) => {
    await rename(...args); if (String(args[0]) === f.control) offset = 5000;
  });
  await lease.release({ deadline: Date.now() + 1000 }); await lease.release();
  await assert.rejects(fs.lstat(f.control), { code: 'ENOENT' });
  const retired = (await fs.readdir(f.directory)).find(name => name.startsWith('control.lock.retired-')); assert.ok(retired);
  assert.equal(JSON.parse(await fs.readFile(path.join(f.directory, retired, 'owner.json'), 'utf8')).kind, 'api-control');
});

test('a failed API retirement preserves the authoritative owner and can retry with its original lease', async t => {
  const f = await fixture(t), rename = fs.rename, lease = await LocalNetworkLease.acquire(f.control, 'api-control');
  const owner = await fs.readFile(path.join(f.control, 'owner.json'), 'utf8');
  const mock = t.mock.method(fs, 'rename', async (...args: Parameters<typeof rename>) => {
    if (String(args[0]) === f.control) throw Object.assign(new Error('retirement sharing failure'), { code: 'EPERM' });
    return rename(...args);
  });
  await assert.rejects(lease.release({ deadline: Date.now() + 50 }));
  assert.equal(await fs.readFile(path.join(f.control, 'owner.json'), 'utf8'), owner);
  mock.mock.restore(); await lease.release(); await assert.rejects(fs.lstat(f.control), { code: 'ENOENT' });
});

test('concurrent and repeated release share one retirement and never remove a successor owner', async t => {
  const f = await fixture(t), rename = fs.rename, lease = await LocalNetworkLease.acquire(f.control, 'api-control');
  let moves = 0, successor: LocalNetworkLease | undefined;
  t.mock.method(fs, 'rename', async (...args: Parameters<typeof rename>) => {
    await rename(...args);
    if (String(args[0]) === f.control && ++moves === 1) successor = await LocalNetworkLease.acquire(f.control, 'api-control');
  });
  const first = lease.release(), second = lease.release();
  const outcomes = await Promise.allSettled([first, second]);
  assert.equal(first, second, 'concurrent calls use the same in-flight promise');
  for (const outcome of outcomes) if (outcome.status === 'rejected') throw outcome.reason;
  assert.equal(moves, 1); assert.ok(successor);
  const owner = await fs.readFile(path.join(f.control, 'owner.json'), 'utf8');
  await lease.release(); assert.equal(await fs.readFile(path.join(f.control, 'owner.json'), 'utf8'), owner);
  await successor.release(); await assert.rejects(fs.lstat(f.control), { code: 'ENOENT' });
});

test('a successor control releases independently while its predecessor is still cleaning retired metadata', async t => {
  const f = await fixture(t), write = fs.writeFile, mkdir = fs.mkdir, unlink = fs.unlink, rename = fs.rename;
  let writes = 0, secondBlocked = false, blockGarbage = false, garbageBlocked = false, overlapped = false;
  let secondStarted!: () => void, releaseState!: () => void, releaseResponse!: () => void, releaseCleanup!: () => void;
  const secondReady = new Promise<void>(resolve => { secondStarted = resolve; });
  const stateReady = new Promise<void>(resolve => { releaseState = resolve; });
  const responseReady = new Promise<void>(resolve => { releaseResponse = resolve; });
  const cleanupReady = new Promise<void>(resolve => { releaseCleanup = resolve; });
  t.mock.method(fs, 'writeFile', async (...args: Parameters<typeof write>) => {
    if (String(args[0]).startsWith(f.state + '.') && ++writes === 2) { secondBlocked = true; secondStarted(); await stateReady; }
    return write(...args);
  });
  t.mock.method(fs, 'mkdir', async (...args: Parameters<typeof mkdir>) => {
    try { return await mkdir(...args); }
    catch (error) {
      if (String(args[0]) === f.control && secondBlocked) { secondBlocked = false; releaseState(); }
      throw error;
    }
  });
  t.mock.method(fs, 'unlink', async (...args: Parameters<typeof unlink>) => {
    if (String(args[0]).startsWith(f.control + '.retired-') && blockGarbage && !garbageBlocked) { garbageBlocked = true; await cleanupReady; }
    return unlink(...args);
  });
  t.mock.method(fs, 'rename', async (...args: Parameters<typeof rename>) => {
    await rename(...args);
    if (String(args[0]) === f.control && garbageBlocked) { overlapped = true; releaseCleanup(); }
  });
  const gate = new GitLabNetworkGate(f.root, 10_000, false);
  let firstStarted!: () => void;
  const firstReady = new Promise<void>(resolve => { firstStarted = resolve; });
  const first = gate.fetch(async () => { firstStarted(); await responseReady; return new Response('first'); }, endpoint);
  await firstReady;
  const second = gate.fetch(async () => new Response('second'), endpoint);
  await secondReady; blockGarbage = true; releaseResponse();
  // A bounded escape releases the fixture even if the ownership regression returns.
  const escape = setTimeout(releaseCleanup, 1000); t.after(() => clearTimeout(escape));
  const outcomes = await Promise.allSettled([first, second]);
  for (const outcome of outcomes) if (outcome.status === 'rejected') throw outcome.reason;
  assert.equal(garbageBlocked, true); assert.equal(overlapped, true, 'the successor must retire while predecessor cleanup is blocked');
  assert.deepEqual(JSON.parse(await fs.readFile(f.state, 'utf8')).active, []);
  await assert.rejects(fs.lstat(f.control), { code: 'ENOENT' });
});

test('dead API owner recovery preserves metadata on retirement failure and leaves quota state untouched', async t => {
  const f = await fixture(t), rename = fs.rename, rmdir = fs.rmdir;
  await fs.mkdir(f.control);
  const owner = JSON.stringify({ schema: LEASE_SCHEMA, nonce: randomUUID(), pid: 2147483647, kind: 'api-control', state: 'reserved', childPid: null });
  await fs.writeFile(path.join(f.control, 'owner.json'), owner);
  const state = JSON.stringify({ schema: 'GitLabWorkspaceApiState/v1', nextStartAt: 123, cooldownUntil: 456, active: [] });
  await fs.writeFile(f.state, state);
  const renameMock = t.mock.method(fs, 'rename', async (...args: Parameters<typeof rename>) => {
    if (String(args[0]) === f.control) throw Object.assign(new Error('retirement sharing failure'), { code: 'EPERM' });
    return rename(...args);
  });
  const rmdirMock = t.mock.method(fs, 'rmdir', async (...args: Parameters<typeof rmdir>) => {
    if (String(args[0]) === f.control) throw Object.assign(new Error('canonical directory sharing failure'), { code: 'EPERM' });
    return rmdir(...args);
  });
  await assert.rejects(acquireStorageControl(f.control, 'api-control', { timeoutMs: 50 }));
  assert.equal(await fs.readFile(path.join(f.control, 'owner.json'), 'utf8'), owner);
  assert.equal(await fs.readFile(f.state, 'utf8'), state);
  renameMock.mock.restore(); rmdirMock.mock.restore();
  const recovered = await acquireStorageControl(f.control, 'api-control'); await recovered.release();
  assert.equal(await fs.readFile(f.state, 'utf8'), state);
});

for (const unexpected of [false, true]) test(`failed API owner publication rolls back only its own empty directory (unexpected content: ${unexpected})`, async t => {
  const f = await fixture(t), write = fs.writeFile;
  t.mock.method(fs, 'writeFile', async (...args: Parameters<typeof write>) => {
    if (String(args[0]).startsWith(path.join(f.control, 'owner.json.'))) {
      if (unexpected) await write(path.join(f.control, 'unknown'), 'keep');
      throw Object.assign(new Error('owner publication denied'), { code: 'EACCES' });
    }
    return write(...args);
  });
  await assert.rejects(LocalNetworkLease.acquire(f.control, 'api-control'));
  if (unexpected) assert.equal(await fs.readFile(path.join(f.control, 'unknown'), 'utf8'), 'keep');
  else await assert.rejects(fs.lstat(f.control), { code: 'ENOENT' });
});

test('missing API owner diagnostics identify the exact lease without sending a request or deleting the directory', async t => {
  const f = await fixture(t), read = fs.readFile, now = Date.now;
  await fs.mkdir(f.control); let offset = 0, sent = 0;
  t.mock.method(Date, 'now', () => now() + offset);
  t.mock.method(fs, 'readFile', async (...args: Parameters<typeof read>) => {
    if (String(args[0]) === path.join(f.control, 'owner.json')) offset += 2100;
    return read(...args);
  });
  await assert.rejects(new GitLabNetworkGate(f.root, 30_000, false).fetch(async () => { sent++; return new Response('{}'); }, endpoint), error => {
    const diagnostics = (error as Error & { diagnostics?: { code: string; leasePath?: string; requestStarted: boolean } }).diagnostics;
    assert.equal(diagnostics?.code, 'metadata-missing'); assert.equal(diagnostics?.leasePath, f.control); assert.equal(diagnostics?.requestStarted, false);
    return true;
  });
  assert.equal(sent, 0); assert.equal((await fs.lstat(f.control)).isDirectory(), true);
});
