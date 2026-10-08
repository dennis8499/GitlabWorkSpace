import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { gitDirectoryForRepository } from './repositoryOperationLock';

/** Index identity excludes stat and optional performance caches, which status may rewrite.
 * Format: https://git-scm.com/docs/gitformat-index
 */
export function gitIndexContentKey(index: Buffer, hashBytes: 20 | 32 = 20): string {
  const fallback = () => createHash('sha256').update(index).digest('hex');
  try {
    if (index.length < 12 + hashBytes || index.toString('ascii', 0, 4) !== 'DIRC') return fallback();
    const version = index.readUInt32BE(4), count = index.readUInt32BE(8);
    if (version < 2 || version > 4 || count > index.length / (42 + hashBytes)) return fallback();
    const digest = createHash('sha256');
    let cursor = 12;
    let previous: Buffer = Buffer.alloc(0);
    for (let i = 0; i < count; i++) {
      const start = cursor, flagsOffset = start + 40 + hashBytes;
      const flags = index.readUInt16BE(flagsOffset);
      digest.update(index.subarray(start + 24, start + 28)); // mode
      digest.update(index.subarray(start + 40, flagsOffset)); // staged object
      digest.update(String(flags & 0xb000)); // assume-valid and conflict stage
      cursor = flagsOffset + 2;
      let extended = 0;
      if (flags & 0x4000) {
        if (version === 2) return fallback();
        extended = index.readUInt16BE(cursor) & 0x6000; // sparse/intent-to-add
        cursor += 2;
      }
      digest.update(String(extended));
      let strip = 0;
      if (version === 4) {
        let byte = index[cursor++]; strip = byte & 0x7f;
        for (let n = 0; byte & 0x80; n++) {
          if (n > 8 || cursor >= index.length) return fallback();
          byte = index[cursor++]; strip = (strip + 1) * 128 + (byte & 0x7f);
        }
        if (strip > previous.length) return fallback();
      }
      const end = index.indexOf(0, cursor);
      if (end < cursor || end >= index.length - hashBytes) return fallback();
      const name = version === 4 ? Buffer.concat([previous.subarray(0, previous.length - strip), index.subarray(cursor, end)]) : index.subarray(cursor, end);
      digest.update('\0').update(name).update('\0'); previous = name;
      cursor = version === 4 ? end + 1 : start + Math.ceil((end + 1 - start) / 8) * 8;
    }
    while (cursor < index.length - hashBytes) {
      if (cursor + 8 > index.length - hashBytes) return fallback();
      const signature = index.toString('ascii', cursor, cursor + 4), size = index.readUInt32BE(cursor + 4);
      if (cursor + 8 + size > index.length - hashBytes) return fallback();
      // Split indexes require the shared-index bitmap. Unknown required extensions
      // conservatively invalidate instead of hiding a possible content change.
      if (signature === 'link' || /^[a-z]/.test(signature) && signature !== 'sdir') return fallback();
      cursor += 8 + size;
    }
    return digest.digest('hex');
  } catch { return fallback(); }
}

function fileStamp(file: string): string {
  try { const stat = statSync(file, { bigint: true }); return stat.mtimeNs + ':' + stat.size + ':' + stat.ino; }
  catch { return 'missing'; }
}
function contents(file: string): string {
  try {
    if (statSync(file).size > 16 * 1024 * 1024) return fileStamp(file);
    return createHash('sha256').update(readFileSync(file)).digest('hex');
  } catch { return 'missing'; }
}

export class GitStateFingerprint {
  private readonly indexes = new Map<string, { stamp: string; value: string }>();

  read(root: string, state: unknown, changedFiles: readonly string[], hashBytes: 20 | 32 = 20): string {
    const gitDir = gitDirectoryForRepository(root);
    let commonDir = gitDir;
    if (gitDir) { try { commonDir = path.resolve(gitDir, readFileSync(path.join(gitDir, 'commondir'), 'utf8').trim()); } catch { /* Ordinary Repo. */ } }
    const digest = createHash('sha256').update(JSON.stringify(state));
    for (const file of [...new Set(changedFiles)].sort()) digest.update(file).update(fileStamp(file));
    if (gitDir && commonDir) {
      const indexPath = path.join(gitDir, 'index'), stamp = fileStamp(indexPath);
      let index = this.indexes.get(indexPath);
      if (!index || index.stamp !== stamp) {
        const sha256 = hashBytes === 32 || /objectformat\s*=\s*sha256/i.test(readText(path.join(commonDir, 'config')));
        let value = stamp;
        try { if (statSync(indexPath).size <= 16 * 1024 * 1024) value = gitIndexContentKey(readFileSync(indexPath), sha256 ? 32 : 20); } catch { /* Unborn Repo. */ }
        index = { stamp, value }; this.indexes.set(indexPath, index);
        if (this.indexes.size > 128) this.indexes.delete(this.indexes.keys().next().value!);
      }
      digest.update(index.value);
      for (const file of [path.join(gitDir, 'HEAD'), path.join(commonDir, 'config'), path.join(gitDir, 'config.worktree'), path.join(commonDir, 'packed-refs'), path.join(commonDir, 'refs', 'stash')]) digest.update(contents(file));
      const backups = path.join(commonDir, 'refs', 'gitlab-workspace', 'backups');
      digest.update(fileStamp(backups));
      try { for (const name of readdirSync(backups).sort().slice(-200)) digest.update(name).update(contents(path.join(backups, name))); } catch { /* No recovery refs. */ }
      for (const file of ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'REBASE_HEAD', 'rebase-merge', 'rebase-apply']) digest.update(fileStamp(path.join(gitDir, file)));
    }
    return digest.digest('hex');
  }
}

function readText(file: string): string { try { return readFileSync(file, 'utf8'); } catch { return ''; } }
