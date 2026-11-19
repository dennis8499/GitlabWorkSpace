import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { LocalNetworkLease, reportWorkflowLeaseError } from '../../src/api/localNetworkLease';
import { OperationLog } from '../../src/logging/operationLog';

async function fixture(t: test.TestContext, name = 'workflow-kit-cache.control') {
  const parent = await fs.realpath(os.tmpdir());
  const root = await fs.mkdtemp(path.join(parent, 'glw-workflow-lease-'));
  t.after(async () => {
    const resolved = await fs.realpath(root);
    assert.equal(path.dirname(resolved), parent);
    assert.match(path.basename(resolved), /^glw-workflow-lease-/);
    await fs.rm(resolved, { recursive: true, force: true, maxRetries: 5, retryDelay: 30 });
  });
  return { root, directory: path.join(root, name), owner: path.join(root, name, 'owner.json') };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

for (const kind of ['workflow-kit-cache-control', 'workflow-kit-asset', 'codex'] as const) {
  test(`releases ${kind} before removing owner metadata from the retired directory`, async t => {
    const f = await fixture(t), unlink = fs.unlink;
    const lease = await LocalNetworkLease.acquire(f.directory, kind);
    const owner = JSON.parse(await fs.readFile(f.owner, 'utf8'));
    assert.equal(owner.state, kind === 'workflow-kit-cache-control' ? 'running' : 'reserved');
    let retiredOwner: string | undefined;
    t.mock.method(fs, 'unlink', async (...args: Parameters<typeof unlink>) => {
      const file = String(args[0]);
      assert.notEqual(file, f.owner);
      if (file.startsWith(f.directory + '.retired-')) {
        assert.equal(JSON.parse(await fs.readFile(file, 'utf8')).nonce, owner.nonce);
        await assert.rejects(fs.lstat(f.directory), { code: 'ENOENT' });
        retiredOwner = file;
      }
      return unlink(...args);
    });
    await lease.release();
    assert.ok(retiredOwner);
    assert.deepEqual(await fs.readdir(f.root), []);
  });
}

test('retries only the original workflow release after a pre-commit failure', async t => {
  const f = await fixture(t), rename = fs.rename;
  const lease = await LocalNetworkLease.acquire(f.directory, 'workflow-kit-cache-control');
  const original = await fs.readFile(f.owner, 'utf8');
  const failing = t.mock.method(fs, 'rename', async (...args: Parameters<typeof rename>) => {
    if (String(args[0]) === f.directory) throw Object.assign(new Error('sharing failure'), { code: 'EACCES' });
    return rename(...args);
  });
  await assert.rejects(lease.release({ deadline: Date.now() + 150 }), { coordinationCode: 'release-pending', leasePath: f.directory });
  assert.equal(await fs.readFile(f.owner, 'utf8'), original);
  failing.mock.restore();
  const successor = await LocalNetworkLease.acquire(f.directory, 'workflow-kit-cache-control');
  const newOwner = await fs.readFile(f.owner, 'utf8');
  assert.notEqual(newOwner, original);
  await lease.release();
  assert.equal(await fs.readFile(f.owner, 'utf8'), newOwner);
  await successor.release();
});

test('preserves the successor if the directory changed while release was pending', async t => {
  const f = await fixture(t), rename = fs.rename;
  const lease = await LocalNetworkLease.acquire(f.directory, 'workflow-kit-asset');
  const failed = t.mock.method(fs, 'rename', async (...args: Parameters<typeof rename>) => {
    if (String(args[0]) === f.directory) throw Object.assign(new Error('access denied'), { code: 'EROFS' });
    return rename(...args);
  });
  await assert.rejects(lease.release(), { coordinationCode: 'release-pending' });
  failed.mock.restore();
  const archived = path.join(f.root, 'archived');
  await rename(f.directory, archived);
  await fs.mkdir(f.directory);
  const oldOwner = await fs.readFile(path.join(archived, 'owner.json'), 'utf8');
  // Even matching metadata is not ownership of a different directory.
  await fs.writeFile(f.owner, oldOwner);
  await assert.rejects(LocalNetworkLease.acquire(f.directory, 'workflow-kit-asset', { timeoutMs: 250 }), { coordinationCode: 'queue-timeout' });
  assert.equal(await fs.readFile(f.owner, 'utf8'), oldOwner);
});

test('bounds waiting on an in-flight release and lets a successor enter before retired cleanup finishes', { timeout: 5_000 }, async t => {
  const f = await fixture(t), rename = fs.rename, unlink = fs.unlink;
  const lease = await LocalNetworkLease.acquire(f.directory, 'workflow-kit-asset');
  const failed = t.mock.method(fs, 'rename', async (...args: Parameters<typeof rename>) => {
    if (String(args[0]) === f.directory) throw Object.assign(new Error('retirement failed'), { code: 'EIO' });
    return rename(...args);
  });
  await assert.rejects(lease.release(), { coordinationCode: 'release-pending' });
  failed.mock.restore();

  const atRename = deferred(), allowRename = deferred();
  const atCleanup = deferred(), allowCleanup = deferred();
  t.mock.method(fs, 'rename', async (...args: Parameters<typeof rename>) => {
    if (String(args[0]) === f.directory) { atRename.resolve(); await allowRename.promise; }
    return rename(...args);
  });
  let firstCleanup = true;
  t.mock.method(fs, 'unlink', async (...args: Parameters<typeof unlink>) => {
    if (firstCleanup && String(args[0]).startsWith(f.directory + '.retired-')) {
      firstCleanup = false;
      atCleanup.resolve();
      await allowCleanup.promise;
    }
    return unlink(...args);
  });

  const retry = lease.release();
  try {
    await atRename.promise;
    await assert.rejects(LocalNetworkLease.acquire(f.directory, 'workflow-kit-asset', { timeoutMs: 120 }), { coordinationCode: 'queue-timeout' });
    const controller = new AbortController();
    const stopped = new Error('workflow wait cancelled');
    const waiting = LocalNetworkLease.acquire(f.directory, 'workflow-kit-asset', { signal: controller.signal });
    controller.abort(stopped);
    await assert.rejects(waiting, error => error === stopped);
    const next = LocalNetworkLease.acquire(f.directory, 'workflow-kit-asset', { timeoutMs: 1_000 });
    allowRename.resolve();
    await atCleanup.promise;
    const successor = await next;
    const successorOwner = await fs.readFile(f.owner, 'utf8');
    allowCleanup.resolve();
    await retry;
    assert.equal(await fs.readFile(f.owner, 'utf8'), successorOwner);
    await successor.release();
  } finally { allowRename.resolve(); allowCleanup.resolve(); await retry; }
});

test('cleans only the empty directory created for a failed workflow owner publication', async t => {
  const f = await fixture(t), writeFile = fs.writeFile;
  let foreignEntry = false;
  t.mock.method(fs, 'writeFile', async (...args: Parameters<typeof writeFile>) => {
    if (String(args[0]).startsWith(f.owner + '.')) {
      if (foreignEntry) await writeFile(path.join(f.directory, 'foreign'), 'preserve');
      throw Object.assign(new Error('publication interrupted'), { code: 'EIO' });
    }
    return writeFile(...args);
  });
  await assert.rejects(LocalNetworkLease.acquire(f.directory, 'workflow-kit-asset'), { coordinationCode: 'owner-unconfirmed' });
  await assert.rejects(fs.lstat(f.directory), { code: 'ENOENT' });
  foreignEntry = true;
  await assert.rejects(LocalNetworkLease.acquire(f.directory, 'workflow-kit-asset'), { coordinationCode: 'owner-unconfirmed' });
  assert.equal(await fs.readFile(path.join(f.directory, 'foreign'), 'utf8'), 'preserve');
});

test('restarts the missing-owner grace period when a different directory replaces the lock', async t => {
  const f = await fixture(t), lstat = fs.lstat;
  let probes = 0, clock = 0;
  await fs.mkdir(f.directory);
  t.mock.method(performance, 'now', () => clock);
  t.mock.method(fs, 'lstat', async (...args: Parameters<typeof lstat>) => {
    if (String(args[0]) === f.directory && ++probes === 2) {
      await fs.rename(f.directory, path.join(f.root, 'previous'));
      await fs.mkdir(f.directory);
      clock = 2_100;
    }
    if (String(args[0]) === f.directory && probes === 4) await fs.rmdir(f.directory);
    return Reflect.apply(lstat, fs, args);
  });
  const lease = await LocalNetworkLease.acquire(f.directory, 'workflow-kit-asset', { timeoutMs: 3_000 });
  await lease.release();
  assert.deepEqual(await fs.readdir(f.root), ['previous']);
});

test('reports persistent missing workflow metadata with the exact path and preserves the lock', async t => {
  const f = await fixture(t), output: string[] = [];
  await fs.mkdir(f.directory);
  let clock = 0;
  t.mock.method(performance, 'now', () => { clock += 2_100; return clock; });
  const log = new OperationLog({ error: line => output.push(line), info: () => undefined, warn: () => undefined });
  await log.withContext({}, () => assert.rejects((async () => {
    try { await LocalNetworkLease.acquire(f.directory, 'workflow-kit-cache-control'); }
    catch (error) { throw reportWorkflowLeaseError(error, 'workflowKitStatus', 'admission'); }
  })(), { coordinationCode: 'metadata-missing', leasePath: f.directory }));
  assert.equal(output.length, 1);
  const entry = JSON.parse(output[0].slice(output[0].indexOf('{')));
  assert.equal(entry.leaseKind, 'workflow-kit-cache-control');
  assert.equal(entry.systemCode, 'ENOENT');
  assert.equal(entry.coordinationPhase, 'admission');
  assert.equal(entry.leasePath, f.directory);
  assert.deepEqual(await fs.readdir(f.directory), []);
});

test('keeps a workflow attachment exclusive across processes until the first holder releases it', { timeout: 5_000 }, async t => {
  const f = await fixture(t);
  const child = spawn(process.execPath, ['-e', `
    const { LocalNetworkLease } = require(process.argv[1]);
    (async () => {
      const lease = await LocalNetworkLease.acquire(process.argv[2], 'workflow-kit-asset');
      process.stdout.write('ready\\n');
      process.stdin.once('end', () => lease.release().catch(error => { console.error(error); process.exitCode = 1; }));
      process.stdin.resume();
    })().catch(error => { console.error(error); process.exitCode = 1; });
  `, require.resolve('../../src/api/localNetworkLease'), f.directory], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  const exited = once(child, 'close');
  t.after(async () => { child.stdin.end(); await exited; });
  const ready = await Promise.race([once(child.stdout, 'data').then(([data]) => String(data)), exited.then(() => '')]);
  assert.match(ready, /ready/);
  await assert.rejects(LocalNetworkLease.acquire(f.directory, 'workflow-kit-asset', { timeoutMs: 100 }), { coordinationCode: 'queue-timeout' });
  child.stdin.end();
  assert.deepEqual(await exited, [0, null]);
  const successor = await LocalNetworkLease.acquire(f.directory, 'workflow-kit-asset');
  await successor.release();
});
