import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile, lstat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { removeOwnedStorage } from '../../src/storage/ownedStorage';
import { cleanupLegacyLogs } from '../../src/storage/legacyLogs';
import { acquireStorageControl } from '../../src/storage/controlLease';
import { LEASE_SCHEMA } from '../../src/api/localNetworkLease';

async function fixture(t: test.TestContext) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'glw-storage-cleanup-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const storage = path.join(root, 'storage'), project = path.join(root, 'project');
  await mkdir(storage); await mkdir(project);
  await writeFile(path.join(project, 'keep.txt'), 'User work');
  return { storage, project };
}

test('cleanup refuses redirected parents and nested junctions without touching their targets', async t => {
  const f = await fixture(t), owned = path.join(f.storage, 'owned'); await mkdir(owned);
  await symlink(f.project, path.join(owned, 'redirect'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(removeOwnedStorage(f.storage, owned), /重新導向/);
  await assert.rejects(removeOwnedStorage(f.storage, f.project), /超出/);
  assert.equal(await readFile(path.join(f.project, 'keep.txt'), 'utf8'), 'User work');
});
test('only recognized legacy log records are removed', async t => {
  const f = await fixture(t), logs = path.join(f.storage, 'logs'); await mkdir(logs);
  const old = path.join(logs, '1791883431569-50ecade6-0e39-43c2-be2d-9954dfd7c84c.jsonl');
  await writeFile(old, JSON.stringify({ id: 'one', timestamp: '2026-01-01', operationId: 'operation', feature: 'workspace', action: 'activate', level: 'info', result: 'success' }) + '\n');
  await writeFile(path.join(logs, 'user-notes.jsonl'), 'retain');
  assert.equal(await cleanupLegacyLogs(f.storage), true); await assert.rejects(lstat(old), { code: 'ENOENT' });
  assert.equal(await readFile(path.join(logs, 'user-notes.jsonl'), 'utf8'), 'retain');
});
test('a known crashed JS control gate can recover without reclaiming quarantined resource owners', async t => {
  const f = await fixture(t), directory = path.join(f.storage, 'test.control'); await mkdir(directory);
  await writeFile(path.join(directory, 'owner.json'), JSON.stringify({ schema: LEASE_SCHEMA, nonce: 'a'.repeat(36), pid: 2147483647, kind: 'test-control', state: 'reserved', childPid: null }));
  const lease = await acquireStorageControl(directory, 'test-control'); await lease.release();
  await assert.rejects(lstat(directory), { code: 'ENOENT' });
});
