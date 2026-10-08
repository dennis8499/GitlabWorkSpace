import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, rm, writeFile, utimes } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { gitIndexContentKey, GitStateFingerprint } from '../../src/git/gitStateFingerprint';

function indexFixture(version: number, names = ['dir/example.txt'], hashBytes: 20 | 32 = 20): Buffer {
  const header = Buffer.alloc(12); header.write('DIRC'); header.writeUInt32BE(version, 4); header.writeUInt32BE(names.length, 8);
  let previous: Buffer = Buffer.alloc(0);
  const entries = names.map((name) => {
    const bytes = Buffer.from(name);
    let shared = 0;
    while (shared < previous.length && shared < bytes.length && previous[shared] === bytes[shared]) shared++;
    let strip = previous.length - shared;
    const encoded = [strip & 0x7f];
    while ((strip = Math.floor(strip / 128))) { strip--; encoded.unshift(0x80 | strip & 0x7f); }
    const nameData = version === 4 ? Buffer.concat([Buffer.from(encoded), bytes.subarray(shared), Buffer.alloc(1)]) : Buffer.concat([bytes, Buffer.alloc(1)]);
    const fixed = Buffer.alloc(42 + hashBytes + (version === 3 ? 2 : 0));
    fixed.writeUInt32BE(0o100644, 24); fixed.fill(1, 40, 40 + hashBytes); fixed.writeUInt16BE(bytes.length | (version === 3 ? 0x4000 : 0), 40 + hashBytes);
    const entry = Buffer.concat([fixed, nameData]); previous = bytes;
    return version === 4 ? entry : Buffer.concat([entry, Buffer.alloc((8 - entry.length % 8) % 8)]);
  });
  return Buffer.concat([header, ...entries, Buffer.alloc(hashBytes)]);
}

test('Git index stat/checksum refreshes do not change staged identity for versions 2, 3, 4 or SHA-256', () => {
  for (const hashBytes of [20, 32] as const) for (const version of [2, 3, 4]) {
    const original = indexFixture(version, undefined, hashBytes), refreshed = Buffer.from(original);
    refreshed.fill(9, 12, 36); // stat cache before mode
    refreshed.writeUInt32BE(0o100644, 12 + 24); // keep semantic mode
    refreshed.fill(3, 12 + 28, 12 + 40);
    refreshed.fill(5, refreshed.length - hashBytes);
    assert.equal(gitIndexContentKey(original, hashBytes), gitIndexContentKey(refreshed, hashBytes));
    const staged = Buffer.from(refreshed); staged[12 + 40] = 2;
    assert.notEqual(gitIndexContentKey(original, hashBytes), gitIndexContentKey(staged, hashBytes));
    const mode = Buffer.from(original); mode.writeUInt32BE(0o100755, 12 + 24);
    assert.notEqual(gitIndexContentKey(original, hashBytes), gitIndexContentKey(mode, hashBytes));
    const conflict = Buffer.from(original); conflict.writeUInt16BE(0x1000, 12 + 40 + hashBytes);
    assert.notEqual(gitIndexContentKey(original, hashBytes), gitIndexContentKey(conflict, hashBytes));
  }
});

test('compressed version 4 paths preserve the same staged identity and unknown formats remain conservative', () => {
  const names = ['a'.repeat(140), 'dir/a.txt', 'dir/b.txt', 'other/檔案.txt'];
  assert.equal(gitIndexContentKey(indexFixture(2, names)), gitIndexContentKey(indexFixture(4, names)));
  assert.equal(gitIndexContentKey(indexFixture(2, names)), gitIndexContentKey(indexFixture(3, names)));
  assert.notEqual(gitIndexContentKey(indexFixture(2, names)), gitIndexContentKey(indexFixture(2, ['different.txt'])));
  const unknown = indexFixture(5), changed = Buffer.from(unknown); changed[12] = 9;
  assert.notEqual(gitIndexContentKey(unknown), gitIndexContentKey(changed));
  assert.doesNotThrow(() => gitIndexContentKey(Buffer.from('DIRC')));
});

test('file and staged-content changes invalidate a Repo while a status-only index rewrite does not', async (t) => {
  const parent = await mkdtemp(path.join(os.tmpdir(), 'git-fingerprint-'));
  t.after(async () => { if (!path.basename(parent).startsWith('git-fingerprint-')) throw new Error('Unsafe fixture cleanup'); await rm(parent, { recursive: true, force: true }); });
  const gitDir = path.join(parent, '.git'), file = path.join(parent, 'example.txt'), indexPath = path.join(gitDir, 'index');
  await mkdir(gitDir); await writeFile(file, 'old'); await writeFile(indexPath, indexFixture(2));
  const fingerprint = new GitStateFingerprint();
  const read = () => fingerprint.read(parent, { head: 'a', working: ['example.txt'] }, [file]);
  const original = read();
  const refreshed = indexFixture(2); refreshed.writeUInt32BE(123, 12);
  await writeFile(indexPath, refreshed); await utimes(indexPath, new Date(), new Date(Date.now() + 1000));
  assert.equal(read(), original);
  refreshed[52] = 2; await writeFile(indexPath, refreshed);
  assert.notEqual(read(), original);
  const staged = read(); await writeFile(file, 'edited again with the same Git status');
  assert.notEqual(read(), staged);
});
