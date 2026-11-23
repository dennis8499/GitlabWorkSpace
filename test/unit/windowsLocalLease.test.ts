import assert from 'node:assert/strict';
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import test, { type TestContext } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { promisify } from 'node:util';
import { GitLabNetworkGate } from '../../src/api/gitLabNetworkGate';
import { LocalNetworkLease, networkHostKey } from '../../src/api/localNetworkLease';
import { runWindowsLeaseProcess, windowsLeaseActive, windowsLeaseLauncher, windowsLeasePowerShell, windowsProcessBirth } from '../../src/api/windowsLocalLease';
import { acquireStorageControl } from '../../src/storage/controlLease';

const windows = { skip: process.platform !== 'win32', timeout: 30_000 };
const exec = promisify(execFile);
const kind = 'api-control';
const acquire = (directory: string) => LocalNetworkLease.acquire(directory, kind, { recoverable: true, timeoutMs: 8_000 });
const acquirePath = require.resolve('../../src/api/localNetworkLease');
const executionPath = require.resolve('../../src/api/windowsLocalLease');

async function fixture(t: TestContext) {
  const parent = await realpath(os.tmpdir());
  const root = await mkdtemp(path.join(parent, 'glw-windows-lease-'));
  t.after(async () => {
    const resolved = await realpath(root);
    assert.equal(path.dirname(resolved), parent);
    assert.ok(path.basename(resolved).startsWith('glw-windows-lease-'));
    await rm(resolved, { recursive: true, force: true, maxRetries: 8, retryDelay: 50 });
  });
  const directory = path.join(root, 'control.lock');
  const ownerPath = path.join(directory, 'owner.json');
  return { root, directory, ownerPath };
}

function abruptOwnerScript(directory: string, body: string): string {
  return `
    const { LocalNetworkLease } = require(${JSON.stringify(acquirePath)});
    const { runWindowsLeaseProcess } = require(${JSON.stringify(executionPath)});
    (async () => {
      const lease = await LocalNetworkLease.acquire(${JSON.stringify(directory)}, ${JSON.stringify(kind)},
        { recoverable: true, timeoutMs: 8000 });
      if (!lease.recovery) throw new Error('Windows lease was not used');
      ${body}
    })().catch(error => { console.error(error); process.exitCode = 1; });
  `;
}

async function readWhenPresent(filename: string): Promise<string> {
  const deadline = Date.now() + 12_000;
  for (;;) {
    try {
      const content = await readFile(filename, 'utf8');
      if (content) return content;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    assert.ok(Date.now() < deadline, 'fixture subprocess did not start');
    await sleep(30);
  }
}

async function stopFixture(child: ChildProcess, ended: Promise<unknown>): Promise<void> {
  if (child.exitCode === null && child.signalCode === null) child.kill();
  await ended;
}

test('Windows publishes a complete owner and recovers the exact lock after the writer exits', windows, async t => {
  const f = await fixture(t);
  await assert.rejects(exec(process.execPath, ['-e', abruptOwnerScript(f.directory, 'process.exit(22);')], { timeout: 14_000 }), { code: 22 });
  const before = JSON.parse(await readFile(f.ownerPath, 'utf8'));
  assert.equal(before.state, 'running');
  assert.equal(before.lifecycle.version, 2);
  assert.deepEqual(before.lifecycle.jobs, []);
  assert.equal(await windowsProcessBirth(before.pid), null);
  // A pre-upgrade storage-control caller sees a fenced v1 owner.
  await assert.rejects(acquireStorageControl(f.directory, kind, { timeoutMs: 150 }), { coordinationCode: 'owner-unconfirmed' });
  const replacement = await acquire(f.directory);
  assert.ok(replacement.recovery);
  assert.notEqual(replacement.recovery.directoryId, before.lifecycle.directoryId);
  assert.notEqual(replacement.recovery.nonce, before.nonce);
  await replacement.release();
});

test('Windows distinguishes PID reuse and preserves a dead legacy owner', windows, async t => {
  const f = await fixture(t);
  const original = await acquire(f.directory);
  assert.ok(original.recovery);
  await assert.rejects(LocalNetworkLease.acquire(f.directory, kind, { recoverable: true, timeoutMs: 1 }), { name: 'TimeoutError' });
  const old = JSON.parse(await readFile(f.ownerPath, 'utf8'));
  old.lifecycle.birth = '1'; // A prior process's creation identity under the current PID.
  await writeFile(f.ownerPath, JSON.stringify(old));
  const replacement = await acquire(f.directory);
  assert.ok(replacement.recovery);
  assert.notEqual(replacement.recovery.directoryId, original.recovery.directoryId);
  await original.release();
  assert.equal(JSON.parse(await readFile(f.ownerPath, 'utf8')).nonce, replacement.recovery.nonce);
  await replacement.release();

  const legacy = { ...old, pid: 2_147_483_647 };
  delete legacy.lifecycle;
  await mkdir(f.directory);
  await writeFile(f.ownerPath, JSON.stringify(legacy));
  await assert.rejects(acquire(f.directory), { coordinationCode: 'owner-unconfirmed' });
  assert.equal(await readFile(f.ownerPath, 'utf8'), JSON.stringify(legacy));
});

test('Windows repeats a claim with the same nonce after the first broker loses its reply', windows, async t => {
  const f = await fixture(t);
  const request = {
    action: 'claim', kind, directory: f.directory, nonce: randomUUID(), pid: process.pid, birth: await windowsProcessBirth(process.pid)
  };
  assert.ok(request.birth);
  const broker = async () => {
    const child = spawn(windowsLeasePowerShell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-File', windowsLeaseLauncher], { windowsHide: true });
    const ended = once(child, 'exit');
    const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
    const read = async () => {
      const { value } = await lines.next();
      assert.ok(typeof value === 'string', 'the broker closed before replying');
      return value;
    };
    t.after(() => stopFixture(child, ended));
    assert.equal(await read(), 'GitLabWorkspaceWindowsLease/v2');
    return { child, ended, read };
  };
  const first = await broker();
  first.child.stdin.write(JSON.stringify(request) + '\n');
  const owner = JSON.parse(await readWhenPresent(f.ownerPath));
  await stopFixture(first.child, first.ended);

  const replacement = await broker();
  replacement.child.stdin.write(JSON.stringify(request) + '\n');
  const reply = JSON.parse(await replacement.read());
  assert.equal(reply.ok, true);
  assert.equal(reply.data.directoryId, owner.lifecycle.directoryId);
  assert.equal(JSON.parse(await readFile(f.ownerPath, 'utf8')).nonce, request.nonce);
  replacement.child.stdin.write(JSON.stringify({ ...request, action: 'release', directoryId: reply.data.directoryId }) + '\n');
  assert.equal(JSON.parse(await replacement.read()).ok, true);
});

test('Windows waits for supervised descendants after the lease owner is killed', windows, async t => {
  const f = await fixture(t);
  const marker = path.join(f.root, 'descendant');
  const descendant = `require('node:fs').writeFileSync(${JSON.stringify(marker)}, String(process.pid)); setInterval(() => {}, 1000);`;
  const main = `require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(descendant)}], { stdio: 'ignore' }); setInterval(() => {}, 1000);`;
  const body = `await runWindowsLeaseProcess(process.execPath, ['-e', ${JSON.stringify(main)}], [lease.recovery],
    { timeoutMs: 20000, maxStdoutBytes: 4096 });`;
  const host = spawn(process.execPath, ['-e', abruptOwnerScript(f.directory, body)], { stdio: 'ignore', windowsHide: true });
  const ended = once(host, 'exit');
  try {
    const descendantPid = Number(await readWhenPresent(marker));
    assert.ok(await windowsProcessBirth(descendantPid));
    const owner = JSON.parse(await readFile(f.ownerPath, 'utf8'));
    assert.equal(owner.lifecycle.jobs.length, 1);
    await assert.rejects(LocalNetworkLease.acquire(f.directory, kind, { recoverable: true, timeoutMs: 1 }), { name: 'TimeoutError' });
    await stopFixture(host, ended);
    const replacement = await acquire(f.directory);
    assert.ok(replacement.recovery);
    assert.equal(await windowsProcessBirth(descendantPid), null);
    await replacement.release();
  } finally { await stopFixture(host, ended); }
});

test('Windows retains ownership if the supervisor itself is killed before recording completion', windows, async t => {
  const f = await fixture(t);
  const marker = path.join(f.root, 'started');
  const main = `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'started'); setInterval(() => {}, 1000);`;
  const body = `await runWindowsLeaseProcess(process.execPath, ['-e', ${JSON.stringify(main)}], [lease.recovery],
    { timeoutMs: 20000, maxStdoutBytes: 4096 });`;
  const host = spawn(process.execPath, ['-e', abruptOwnerScript(f.directory, body)], { stdio: 'ignore', windowsHide: true });
  const ended = once(host, 'exit');
  try {
    await readWhenPresent(marker);
    const before = await readFile(f.ownerPath, 'utf8');
    const [supervisor] = JSON.parse(before).lifecycle.jobs;
    assert.equal(await windowsProcessBirth(supervisor.pid), supervisor.birth);
    process.kill(supervisor.pid);
    await ended;
    await assert.rejects(acquire(f.directory), { coordinationCode: 'process-tree-unconfirmed' });
    assert.equal(await readFile(f.ownerPath, 'utf8'), before);
  } finally { await stopFixture(host, ended); }
});

test('Windows forwards stdin, exit status and timeout under the same lease', windows, async t => {
  const f = await fixture(t);
  const lease = await acquire(f.directory);
  assert.ok(lease.recovery);
  try {
    const options = { timeoutMs: 5_000, maxStdoutBytes: 4096, input: 'fixture\n' };
    const result = await runWindowsLeaseProcess(process.execPath, ['-e',
      "process.stdin.pipe(process.stdout); console.error('stderr'); process.exitCode = 124;"], [lease.recovery], options);
    assert.equal(result.stdout, 'fixture\n');
    assert.equal(result.stderr.trim(), 'stderr');
    assert.equal(result.code, 124);
    await assert.rejects(runWindowsLeaseProcess(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], [lease.recovery],
      { ...options, timeoutMs: 400 }), { name: 'TimeoutError' });
    assert.equal(await windowsLeaseActive(lease.recovery), false);
  } finally { await lease.release(); }
});

test('Windows API drops a reused PID reservation while honoring the saved cooldown and sending once', windows, async t => {
  const f = await fixture(t);
  const endpoint = new URL('https://gitlab.example.test/api/v4/test');
  const directory = path.join(f.root, 'api', networkHostKey(endpoint.hostname));
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(f.root, 'network-policy.json'),
    JSON.stringify({ schema: 'GitLabWorkspaceNetworkPolicy/v1', api: { concurrency: 1, startsPerSecond: 1 } }));
  const cooldown = Date.now() + 700;
  await writeFile(path.join(directory, 'state.json'), JSON.stringify({
    schema: 'GitLabWorkspaceApiState/v1', nextStartAt: 0, cooldownUntil: cooldown,
    active: [{ nonce: 'prior', pid: process.pid, birth: '1', startedAt: Date.now(), deadline: Date.now() + 60_000 }]
  }));
  let requests = 0;
  const result = await new GitLabNetworkGate(f.root, 8_000).fetch(async () => {
    assert.ok(Date.now() >= cooldown);
    requests++;
    return new Response('fixture');
  }, endpoint);
  assert.equal(result.status, 200);
  assert.equal(requests, 1);
  assert.deepEqual(JSON.parse(await readFile(path.join(directory, 'state.json'), 'utf8')).active, []);
});
