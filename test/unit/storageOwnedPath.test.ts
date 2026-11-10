import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ownedStoragePath } from '../../src/storage/ownedStorage';

test('Windows ownership checks retry transient path answers but reject a stable redirected path', { skip: process.platform !== 'win32' }, async t => {
  const parent = await fs.realpath(os.tmpdir()), root = await fs.mkdtemp(path.join(parent, 'owned-storage-path-'));
  const target = path.join(root, 'nested', 'control'), outside = path.join(parent, path.basename(root) + '-outside');
  await fs.mkdir(target, { recursive: true });
  t.after(async () => {
    assert.equal(path.dirname(await fs.realpath(root)), parent);
    assert.ok(path.basename(root).startsWith('owned-storage-path-'));
    await fs.rm(root, { recursive: true, force: true });
  });
  const real = fs.realpath; let transientCalls = 0;
  const transient = t.mock.method(fs, 'realpath', async (...args: Parameters<typeof real>) => {
    if (String(args[0]) === target) {
      if (transientCalls++ === 0) return outside;
      if (transientCalls === 2) throw Object.assign(new Error('Transient Windows directory handle race.'), { code: 'EBADF' });
    }
    return real(...args);
  });
  assert.equal(await ownedStoragePath(root, target), true);
  assert.equal(transientCalls, 3);
  transient.mock.restore();

  let stableRedirectCalls = 0;
  t.mock.method(fs, 'realpath', async (...args: Parameters<typeof real>) => {
    if (String(args[0]) === target) { stableRedirectCalls++; return outside; }
    return real(...args);
  });
  await assert.rejects(ownedStoragePath(root, target), /清理路徑不可重新導向/);
  assert.equal(stableRedirectCalls, 4);
});
