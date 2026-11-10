import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { acquireStorageControl } from '../../src/storage/controlLease';
import { LEASE_SCHEMA, LocalNetworkLease } from '../../src/api/localNetworkLease';

async function fixture(t: test.TestContext) {
  const parent = await fs.realpath(os.tmpdir()), root = await fs.mkdtemp(path.join(parent, 'control-recovery-'));
  t.after(async () => {
    assert.equal(path.dirname(await fs.realpath(root)), parent);
    assert.ok(path.basename(root).startsWith('control-recovery-'));
    await fs.rm(root, { recursive: true, force: true });
  });
  const directory = path.join(root, 'test.control');
  return { directory, guard: directory + '.recovery' };
}
const guardOwner = (nonce = 'a'.repeat(36), pid = process.pid) => ({ schema: 'GitLabWorkspaceControlRecovery/v1', kind: 'test-control', pid, nonce });

test('incomplete recovery hints never block a free authoritative control lease or get deleted', async t => {
  const f = await fixture(t);
  for (const contents of ['', '{', 'null', '{"schema":"GitLabWorkspaceControlRecovery/v1"']) {
    await fs.writeFile(f.guard, contents);
    const lease = await acquireStorageControl(f.directory, 'test-control', { timeoutMs: 100 }); await lease.release();
    assert.equal(await fs.readFile(f.guard, 'utf8'), contents);
  }
});

test('a missing recovery hint during inspection defers to normal lease admission', async t => {
  const f = await fixture(t); await fs.writeFile(f.guard, JSON.stringify(guardOwner()));
  const read = fs.readFile; let raced = false;
  t.mock.method(fs, 'readFile', async (...args: Parameters<typeof read>) => {
    if (String(args[0]) === f.guard && !raced) { raced = true; await fs.unlink(f.guard); }
    return read(...args);
  });
  const lease = await acquireStorageControl(f.directory, 'test-control', { timeoutMs: 100 }); await lease.release();
  assert.equal(raced, true); await assert.rejects(fs.lstat(f.guard), { code: 'ENOENT' });
});

test('Windows transient recovery-hint reads preserve the hint and do not fail a confirmed scheduler release', { skip: process.platform !== 'win32' }, async t => {
  const f = await fixture(t), read = fs.readFile;
  for (const code of ['EPERM', 'EACCES', 'EBUSY']) {
    const contents = JSON.stringify(guardOwner()); await fs.writeFile(f.guard, contents);
    let raced = false;
    const mock = t.mock.method(fs, 'readFile', async (...args: Parameters<typeof read>) => {
      if (String(args[0]) === f.guard && !raced) { raced = true; throw Object.assign(new Error('read raced with guard writer'), { code }); }
      return read(...args);
    });
    const lease = await acquireStorageControl(f.directory, 'test-control', { timeoutMs: 100 }); await lease.release();
    assert.equal(raced, true); assert.equal(await read(f.guard, 'utf8'), contents); mock.mock.restore();
  }
});

for (const sameNonce of [false, true]) test(`a replaced dead-owner recovery hint is not reclaimed (same nonce: ${sameNonce})`, async t => {
  const f = await fixture(t), previous = guardOwner('a'.repeat(36), 2147483647), replacement = guardOwner(sameNonce ? previous.nonce : 'b'.repeat(36));
  await fs.writeFile(f.guard, JSON.stringify(previous));
  const read = fs.readFile; let reads = 0;
  t.mock.method(fs, 'readFile', async (...args: Parameters<typeof read>) => {
    if (String(args[0]) === f.guard && ++reads === 2) await fs.writeFile(f.guard, JSON.stringify(replacement));
    return read(...args);
  });
  const lease = await acquireStorageControl(f.directory, 'test-control', { timeoutMs: 100 }); await lease.release();
  assert.deepEqual(JSON.parse(await read(f.guard, 'utf8')), replacement);
});

test('a dead control owner that changes to an unconfirmed process state is never reclaimed', async t => {
  const f = await fixture(t), read = fs.readFile, ownerPath = path.join(f.directory, 'owner.json'); await fs.mkdir(f.directory);
  const reserved = { schema: LEASE_SCHEMA, nonce: 'a'.repeat(36), pid: 2147483647, kind: 'test-control', state: 'reserved', childPid: null };
  for (const state of ['quarantined', 'starting', 'running']) {
    await fs.writeFile(ownerPath, JSON.stringify(reserved)); const replacement = { ...reserved, state }; let reads = 0;
    const mock = t.mock.method(fs, 'readFile', async (...args: Parameters<typeof read>) => {
      if (String(args[0]) === ownerPath && ++reads === 2) await fs.writeFile(ownerPath, JSON.stringify(replacement));
      return read(...args);
    });
    await assert.rejects(acquireStorageControl(f.directory, 'test-control', { timeoutMs: 20 }), /Unconfirmed|previous network owner/);
    assert.deepEqual(JSON.parse(await read(ownerPath, 'utf8')), replacement); mock.mock.restore();
  }
});

for (const mode of ['replacement', 'unknown-same-nonce']) test(`finally preserves ${mode} guard while a live authoritative lease still excludes contenders`, async t => {
  const f = await fixture(t), held = await LocalNetworkLease.acquire(f.directory, 'test-control'), read = fs.readFile;
  let replacement: object = guardOwner('b'.repeat(36)), replaced = false;
  t.mock.method(fs, 'readFile', async (...args: Parameters<typeof read>) => {
    if (String(args[0]) === path.join(f.directory, 'owner.json') && !replaced) {
      if (mode === 'unknown-same-nonce') replacement = { nonce: JSON.parse(await read(f.guard, 'utf8')).nonce };
      replaced = true; await fs.writeFile(f.guard, JSON.stringify(replacement));
    }
    return read(...args);
  });
  try {
    await assert.rejects(acquireStorageControl(f.directory, 'test-control', { timeoutMs: 20 }), { name: 'TimeoutError' });
    assert.equal(replaced, true); assert.deepEqual(JSON.parse(await read(f.guard, 'utf8')), replacement);
  } finally { await held.release(); }
});

test('unconfirmed resource owners remain blocked while a proven dead reserved JS control can recover', async t => {
  const f = await fixture(t), ownerPath = path.join(f.directory, 'owner.json'); await fs.mkdir(f.directory);
  const reserved = { schema: LEASE_SCHEMA, nonce: 'a'.repeat(36), pid: 2147483647, kind: 'test-control', state: 'reserved', childPid: null };
  for (const state of ['quarantined', 'starting', 'running']) {
    const owner = { ...reserved, state }; await fs.writeFile(ownerPath, JSON.stringify(owner)); await fs.writeFile(f.guard, '');
    await assert.rejects(acquireStorageControl(f.directory, 'test-control', { timeoutMs: 20 }), /Unconfirmed|previous network owner/);
    assert.deepEqual(JSON.parse(await fs.readFile(ownerPath, 'utf8')), owner); assert.equal(await fs.readFile(f.guard, 'utf8'), '');
  }
  await fs.unlink(f.guard); await fs.writeFile(ownerPath, JSON.stringify(reserved));
  const recovered = await acquireStorageControl(f.directory, 'test-control'); await recovered.release();
  await assert.rejects(fs.lstat(f.directory), { code: 'ENOENT' });
});
