import { createHash } from 'node:crypto';
import { readFile, readdir, stat } from 'node:fs/promises';
import { setImmediate as yieldToLoop } from 'node:timers/promises';
import path from 'node:path';
import { gitDirectoryForRepository } from './repositoryOperationLock';

function* rawIndexChunks(index: Buffer): Generator<void, string> {
  const digest = createHash('sha256');
  for (let offset = 0; offset < index.length; offset += 256 * 1024) {
    digest.update(index.subarray(offset, offset + 256 * 1024));
    yield;
  }
  return digest.digest('hex');
}

/** Index identity ignores stat/checksum caches rewritten by Git status. */
function* indexKeyChunks(index: Buffer, hashBytes: 20 | 32): Generator<void, string> {
  try {
    if (index.length < 12 + hashBytes || index.toString('ascii', 0, 4) !== 'DIRC') return yield* rawIndexChunks(index);
    const version = index.readUInt32BE(4), count = index.readUInt32BE(8);
    if (version < 2 || version > 4 || count > index.length / (42 + hashBytes)) return yield* rawIndexChunks(index);
    const digest = createHash('sha256');
    let cursor = 12;
    let previous: Buffer = Buffer.alloc(0);
    for (let i = 0; i < count; i++) {
      if (i && i % 256 === 0) yield;
      const start = cursor, flagsOffset = start + 40 + hashBytes;
      const flags = index.readUInt16BE(flagsOffset);
      digest.update(index.subarray(start + 24, start + 28)); // mode
      digest.update(index.subarray(start + 40, flagsOffset)); // staged object
      digest.update(String(flags & 0xb000)); // assume-valid and conflict stage
      cursor = flagsOffset + 2;
      let extended = 0;
      if (flags & 0x4000) {
        if (version === 2) return yield* rawIndexChunks(index);
        extended = index.readUInt16BE(cursor) & 0x6000; // sparse/intent-to-add
        cursor += 2;
      }
      digest.update(String(extended));
      let strip = 0;
      if (version === 4) {
        let byte = index[cursor++]; strip = byte & 0x7f;
        for (let n = 0; byte & 0x80; n++) {
          if (n > 8 || cursor >= index.length) return yield* rawIndexChunks(index);
          byte = index[cursor++]; strip = (strip + 1) * 128 + (byte & 0x7f);
        }
        if (strip > previous.length) return yield* rawIndexChunks(index);
      }
      const end = index.indexOf(0, cursor);
      if (end < cursor || end >= index.length - hashBytes) return yield* rawIndexChunks(index);
      const name = version === 4 ? Buffer.concat([previous.subarray(0, previous.length - strip), index.subarray(cursor, end)]) : index.subarray(cursor, end);
      digest.update('\0').update(name).update('\0'); previous = name;
      cursor = version === 4 ? end + 1 : start + Math.ceil((end + 1 - start) / 8) * 8;
    }
    while (cursor < index.length - hashBytes) {
      if (cursor + 8 > index.length - hashBytes) return yield* rawIndexChunks(index);
      const signature = index.toString('ascii', cursor, cursor + 4), size = index.readUInt32BE(cursor + 4);
      if (cursor + 8 + size > index.length - hashBytes) return yield* rawIndexChunks(index);
      // Split indexes require the shared-index bitmap. Unknown required extensions
      // conservatively invalidate instead of hiding a possible content change.
      if (signature === 'link' || /^[a-z]/.test(signature) && signature !== 'sdir') return yield* rawIndexChunks(index);
      cursor += 8 + size;
    }
    return digest.digest('hex');
  } catch { return yield* rawIndexChunks(index); }
}

/** Synchronous pure helper for small fixtures; production reads yield between chunks. */
export function gitIndexContentKey(index: Buffer, hashBytes: 20 | 32 = 20): string {
  const chunks = indexKeyChunks(index, hashBytes);
  let next = chunks.next();
  while (!next.done) next = chunks.next();
  return next.value;
}
export async function gitIndexContentKeyAsync(index: Buffer, hashBytes: 20 | 32 = 20): Promise<string> {
  const chunks = indexKeyChunks(index, hashBytes);
  let next = chunks.next();
  while (!next.done) { await yieldToLoop(); next = chunks.next(); }
  return next.value;
}

async function fileStamp(file: string): Promise<string> {
  try { const info = await stat(file, { bigint: true }); return info.mtimeNs + ':' + info.size + ':' + info.ino; }
  catch { return 'missing'; }
}
async function contents(file: string): Promise<string> {
  try {
    if ((await stat(file)).size > 16 * 1024 * 1024) return fileStamp(file);
    return gitIndexContentKeyAsync(await readFile(file));
  } catch { return 'missing'; }
}
async function readText(file: string): Promise<string> { try { return await readFile(file, 'utf8'); } catch { return ''; } }

export class GitStateFingerprint {
  private readonly indexes = new Map<string, { stamp: string; value: string }>();
  private readonly reads = new Map<string, Promise<string>>();

  read(root: string, state: unknown, changedFiles: readonly string[], hashBytes: 20 | 32 = 20): Promise<string> {
    const files = [...new Set(changedFiles)].sort();
    const stateText = JSON.stringify(state);
    const key = JSON.stringify([root, stateText, files, hashBytes]);
    const pending = this.reads.get(key);
    if (pending) return pending;
    const task = this.load(root, stateText, files, hashBytes);
    this.reads.set(key, task);
    void task.finally(() => { if (this.reads.get(key) === task) this.reads.delete(key); }).catch(() => undefined);
    return task;
  }

  private async load(root: string, stateText: string, changedFiles: readonly string[], hashBytes: 20 | 32): Promise<string> {
    const gitDir = await gitDirectoryForRepository(root);
    let commonDir = gitDir;
    if (gitDir) { const common = await readText(path.join(gitDir, 'commondir')); if (common.trim()) commonDir = path.resolve(gitDir, common.trim()); }
    const digest = createHash('sha256').update(stateText);
    // Keep filesystem fan-out bounded; large dirty Repos yield after each native I/O.
    for (let offset = 0; offset < changedFiles.length; offset += 4) {
      const files = changedFiles.slice(offset, offset + 4);
      const stamps = await Promise.all(files.map(fileStamp));
      files.forEach((file, index) => digest.update(file).update(stamps[index]));
    }
    if (gitDir && commonDir) {
      const indexPath = path.join(gitDir, 'index'), stamp = await fileStamp(indexPath);
      let index = this.indexes.get(indexPath);
      if (!index || index.stamp !== stamp) {
        const sha256 = hashBytes === 32 || /objectformat\s*=\s*sha256/i.test(await readText(path.join(commonDir, 'config')));
        let value = stamp;
        try { if ((await stat(indexPath)).size <= 16 * 1024 * 1024) value = await gitIndexContentKeyAsync(await readFile(indexPath), sha256 ? 32 : 20); } catch { /* Unborn Repo. */ }
        index = { stamp, value }; this.indexes.set(indexPath, index);
        if (this.indexes.size > 128) this.indexes.delete(this.indexes.keys().next().value!);
      }
      digest.update(index.value);
      for (const file of [path.join(gitDir, 'HEAD'), path.join(commonDir, 'config'), path.join(gitDir, 'config.worktree'), path.join(commonDir, 'packed-refs'), path.join(commonDir, 'refs', 'stash')]) digest.update(await contents(file));
      const backups = path.join(commonDir, 'refs', 'gitlab-workspace', 'backups');
      digest.update(await fileStamp(backups));
      try { for (const name of (await readdir(backups)).sort().slice(-200)) digest.update(name).update(await contents(path.join(backups, name))); } catch { /* No recovery refs. */ }
      for (const file of ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'REBASE_HEAD', 'rebase-merge', 'rebase-apply']) digest.update(await fileStamp(path.join(gitDir, file)));
    }
    return digest.digest('hex');
  }
}
