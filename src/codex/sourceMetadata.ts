import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { atomicNetworkJson } from '../api/localNetworkLease';
import { acquireStorageControl } from '../storage/controlLease';
import { ownedStoragePath } from '../storage/ownedStorage';

/** A shared short-lived read cache. Publication checks deliberately bypass it. */
export async function cachedSourceMetadata<T>(storage: string, account: string, key: string,
  load: () => Promise<T>, refresh = false, now = Date.now): Promise<T> {
  const identity = createHash('sha256').update(JSON.stringify([account, key])).digest('hex');
  const directory = path.join(storage, 'codex-source-metadata'), file = path.join(directory, identity + '.json');
  await mkdir(directory, { recursive: true }); await ownedStoragePath(storage, directory);
  let observedRevision: string | undefined;
  if (refresh) {
    try { await ownedStoragePath(storage, file); observedRevision = createHash('sha256').update(await readFile(file)).digest('hex'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  const lease = await acquireStorageControl(file + '.control', 'codex-source-read');
  try {
    try {
      const info = await lstat(file);
      if (!info.isFile() || info.isSymbolicLink() || info.size > 2 * 1024 * 1024) throw new Error('來源快取無法驗證。');
      await ownedStoragePath(storage, file);
      const bytes = await readFile(file), saved = JSON.parse(bytes.toString('utf8'));
      if (saved.schema === 'GitLabWorkspaceCodexSource/v2' && saved.identity === identity &&
        Number.isFinite(saved.fetchedAt) && Number.isFinite(saved.expiresAt) && saved.expiresAt === saved.fetchedAt + 60_000 &&
        saved.fetchedAt <= now() && saved.expiresAt > now() &&
        (!refresh || createHash('sha256').update(bytes).digest('hex') !== observedRevision)) return structuredClone(saved.value) as T;
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    const value = await load();
    const serialized = JSON.stringify(value);
    if (serialized === undefined || Buffer.byteLength(serialized) > 2 * 1024 * 1024) throw new Error('來源資料格式無效或超過快照上限，請縮小需求。');
    const fetchedAt = now();
    await atomicNetworkJson(file, { schema: 'GitLabWorkspaceCodexSource/v2', identity, revision: randomUUID(), fetchedAt, expiresAt: fetchedAt + 60_000, value });
    return structuredClone(value);
  } finally { await lease.release(); }
}
