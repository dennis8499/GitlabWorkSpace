import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, mkdir, readFile, readdir, realpath, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { atomicNetworkJson } from '../api/localNetworkLease';
import { acquireStorageControl } from '../storage/controlLease';
import { ownedStoragePath, removeOwnedStorage } from '../storage/ownedStorage';

export const immutableSourceCacheLimits = { entries: 16, bytes: 1024 * 1024 * 1024, archiveBytes: 512 * 1024 * 1024, indexBytes: 8 * 1024 * 1024 } as const;
export interface ImmutableSourceCacheOptions {
  directory: string;
  /** An account/project or explicitly local Group namespace; never a credential. */
  scope: string;
  signal?: AbortSignal;
  observe?(observation: { id: string; reused: boolean; archiveBytes: number }): void;
}
interface ArchiveReceipt {
  schema: 'GitLabWorkspaceImmutableSource/v1'; id: string; repository: string; sourceSha: string; scopeDigest: string;
  archiveSha256: string; archiveBytes: number; indexSha256: string; indexBytes: number; createdAt: string;
}
export interface ImmutableSourceArchive { archive: string; index: string; reused: boolean; }
const hash = (bytes: string) => createHash('sha256').update(bytes).digest('hex');
const same = (a: string, b: string) => process.platform === 'win32' ? path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase() : path.resolve(a) === path.resolve(b);
async function fileDigest(file: string, maximum: number, signal?: AbortSignal): Promise<{ sha256: string; bytes: number }> {
  const info = await lstat(file);
  if (!info.isFile() || info.isSymbolicLink() || info.size > maximum) throw new Error('不可變來源快取檔案超過限制或不可安全讀取。');
  const digest = createHash('sha256'); let bytes = 0;
  for await (const chunk of createReadStream(file)) {
    signal?.throwIfAborted(); bytes += chunk.length;
    if (bytes > maximum) throw new Error('不可變來源快取超過容量限制。');
    digest.update(chunk);
  }
  if (bytes !== info.size) throw new Error('不可變來源快取在讀取期間變更。');
  return { sha256: digest.digest('hex'), bytes };
}
async function readEntry(root: string, directory: string, identity: Pick<ArchiveReceipt, 'id' | 'repository' | 'sourceSha' | 'scopeDigest'>,
  signal?: AbortSignal): Promise<{ receipt: ArchiveReceipt; index: string } | undefined> {
  if (!await ownedStoragePath(root, directory)) return;
  const manifest = path.join(directory, 'receipt.json');
  if (!await ownedStoragePath(root, manifest)) return;
  const info = await lstat(manifest);
  if (!info.isFile() || info.size > 16_384) return;
  let receipt: ArchiveReceipt;
  try { receipt = JSON.parse(await readFile(manifest, 'utf8')); } catch (error) { if (error instanceof SyntaxError) return; throw error; }
  if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt) || receipt.schema !== 'GitLabWorkspaceImmutableSource/v1' || Object.entries(identity).some(([key, value]) => receipt[key as keyof ArchiveReceipt] !== value) ||
      !Number.isFinite(Date.parse(receipt.createdAt)) || !/^[a-f0-9]{64}$/.test(receipt.archiveSha256) || !/^[a-f0-9]{64}$/.test(receipt.indexSha256) ||
      !Number.isSafeInteger(receipt.archiveBytes) || receipt.archiveBytes < 0 || receipt.archiveBytes > immutableSourceCacheLimits.archiveBytes ||
      !Number.isSafeInteger(receipt.indexBytes) || receipt.indexBytes < 0 || receipt.indexBytes > immutableSourceCacheLimits.indexBytes) return;
  const archive = path.join(directory, 'source.zip'), indexFile = path.join(directory, 'tree.txt');
  if (!await ownedStoragePath(root, archive) || !await ownedStoragePath(root, indexFile)) return;
  const actual = await fileDigest(archive, immutableSourceCacheLimits.archiveBytes, signal), index = await fileDigest(indexFile, immutableSourceCacheLimits.indexBytes, signal);
  if (actual.sha256 !== receipt.archiveSha256 || actual.bytes !== receipt.archiveBytes || index.sha256 !== receipt.indexSha256 || index.bytes !== receipt.indexBytes) return;
  return { receipt, index: await readFile(indexFile, 'utf8') };
}
/** The cache-wide control gate also pins entries while they are being extracted. */
async function trim(root: string, incomingBytes: number, signal?: AbortSignal): Promise<void> {
  const entries: Array<{ directory: string; bytes: number; modified: number }> = [];
  for (const name of await readdir(root)) {
    signal?.throwIfAborted(); if (!/^[a-f0-9]{64}$/.test(name)) continue;
    const directory = path.join(root, name); await ownedStoragePath(root, directory);
    let bytes = 0;
    for (const file of await readdir(directory)) {
      const target = path.join(directory, file); await ownedStoragePath(root, target);
      const info = await lstat(target);
      if (!info.isFile()) throw new Error('不可變來源快取包含非預期項目，無法清理。');
      bytes += info.size;
    }
    entries.push({ directory, bytes, modified: (await lstat(directory)).mtimeMs });
  }
  entries.sort((a, b) => a.modified - b.modified);
  let bytes = entries.reduce((sum, entry) => sum + entry.bytes, incomingBytes), count = entries.length + 1;
  for (const entry of entries) {
    if (bytes <= immutableSourceCacheLimits.bytes && count <= immutableSourceCacheLimits.entries) break;
    signal?.throwIfAborted(); await removeOwnedStorage(root, entry.directory); bytes -= entry.bytes; count--;
  }
}
/** Reuses only immutable bytes. The archive path is valid solely during consume; output stays task-owned. */
export async function withImmutableSourceArchive<T>(options: ImmutableSourceCacheOptions, repository: string, sourceSha: string,
  capture: (archive: string) => Promise<string>, consume: (source: ImmutableSourceArchive) => Promise<T>): Promise<T> {
  options.signal?.throwIfAborted();
  if (!options.scope || options.scope.length > 4096 || !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/i.test(sourceSha)) throw new Error('不可變來源快取缺少有效範圍或固定 SHA。');
  const canonical = await realpath(repository), root = path.resolve(options.directory);
  if (!same(await realpath(path.dirname(root)), path.dirname(root))) throw new Error('不可變來源快取父目錄不可重新導向。');
  await mkdir(root, { recursive: true, mode: 0o700 });
  if (!same(await realpath(root), root) || !await ownedStoragePath(path.dirname(root), root)) throw new Error('不可變來源快取目錄不可重新導向。');
  const scopeDigest = hash(options.scope), normalized = process.platform === 'win32' ? canonical.toLowerCase() : canonical;
  const identity = { id: hash(JSON.stringify([normalized, sourceSha, scopeDigest])), repository: normalized, sourceSha, scopeDigest };
  const directory = path.join(root, identity.id), stage = path.join(root, '.capture-' + randomUUID());
  const control = await acquireStorageControl(path.join(root, 'control'), 'immutable-source-cache', { signal: options.signal, timeoutMs: 120_000 });
  let quarantine = false;
  try {
    // Capture/extraction can own subprocesses. A dead Host must not be treated
    // as a recoverable JS-only control gate while a child may still be running.
    await control.update({ state: 'running' });
    const cached = await readEntry(root, directory, identity, options.signal);
    if (cached) {
      options.signal?.throwIfAborted();
      const result = await consume({ archive: path.join(directory, 'source.zip'), index: cached.index, reused: true });
      options.signal?.throwIfAborted(); options.observe?.({ id: identity.id, reused: true, archiveBytes: cached.receipt.archiveBytes }); return result;
    }
    await removeOwnedStorage(root, directory);
    await mkdir(stage, { mode: 0o700 }); await ownedStoragePath(root, stage);
    const archive = path.join(stage, 'source.zip'), index = await capture(archive);
    options.signal?.throwIfAborted();
    if (Buffer.byteLength(index) > immutableSourceCacheLimits.indexBytes) throw new Error('固定來源索引超過容量限制。');
    const actual = await fileDigest(archive, immutableSourceCacheLimits.archiveBytes, options.signal);
    const result = await consume({ archive, index, reused: false });
    options.signal?.throwIfAborted();
    await writeFile(path.join(stage, 'tree.txt'), index, { flag: 'wx', mode: 0o600 });
    const receipt: ArchiveReceipt = { schema: 'GitLabWorkspaceImmutableSource/v1', ...identity,
      archiveSha256: actual.sha256, archiveBytes: actual.bytes, indexSha256: hash(index), indexBytes: Buffer.byteLength(index), createdAt: new Date().toISOString() };
    await atomicNetworkJson(path.join(stage, 'receipt.json'), receipt);
    await trim(root, actual.bytes + Buffer.byteLength(index) + Buffer.byteLength(JSON.stringify(receipt)), options.signal);
    options.signal?.throwIfAborted(); await rename(stage, directory);
    options.observe?.({ id: identity.id, reused: false, archiveBytes: actual.bytes }); return result;
  } catch (error) {
    quarantine = !!error && typeof error === 'object' && 'workflowCleanupUncertain' in error;
    if (quarantine) await control.update({ state: 'quarantined' });
    throw error;
  } finally {
    if (!quarantine) {
      try { await removeOwnedStorage(root, stage); } finally { await control.release(); }
    }
  }
}
