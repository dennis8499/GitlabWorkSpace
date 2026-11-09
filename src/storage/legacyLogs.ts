import { lstat, readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { missingFile, ownedStoragePath, removeOwnedStorage } from './ownedStorage';

/** This version uses VS Code's native log sink; only its obsolete JSONL format is reclaimed. */
export async function cleanupLegacyLogs(storage: string): Promise<boolean> {
  const directory = path.join(storage, 'logs');
  let pending = false;
  try {
    if (!await ownedStoragePath(storage, directory)) return false;
    const names = await readdir(directory); pending = names.length > 100;
    for (const name of names.slice(0, 100)) {
      if (!/^\d{13}-[a-f0-9-]{36}\.jsonl$/i.test(name)) { pending = true; continue; }
      const file = path.join(directory, name);
      try {
        await ownedStoragePath(storage, file);
        const before = await lstat(file);
        if (!before.isFile() || before.size > 16 * 1024 * 1024) { pending = true; continue; }
        const lines = (await readFile(file, 'utf8')).trim().split(/\r?\n/);
        if (!lines.every(line => {
          const entry = JSON.parse(line);
          return entry && typeof entry.id === 'string' && typeof entry.timestamp === 'string' && typeof entry.operationId === 'string' &&
            typeof entry.feature === 'string' && typeof entry.action === 'string' && ['info', 'warn', 'error'].includes(entry.level) &&
            ['started', 'success', 'error', 'cancelled'].includes(entry.result);
        })) { pending = true; continue; }
        const after = await lstat(file);
        if (before.size !== after.size || before.mtimeMs !== after.mtimeMs) { pending = true; continue; }
        await removeOwnedStorage(storage, file);
      } catch (error) { if (!missingFile(error)) pending = true; }
    }
  } catch (error) { if (!missingFile(error)) pending = true; }
  return pending;
}
