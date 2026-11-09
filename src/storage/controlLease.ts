import { lstat, readFile, rmdir, unlink, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { LEASE_SCHEMA, LocalNetworkLease } from '../api/localNetworkLease';
import { missingFile, ownedStoragePath } from './ownedStorage';

/** Known JS control gates own no subprocesses; resource/process leases remain authoritative. */
export async function acquireStorageControl(directory: string, kind: string, options: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<LocalNetworkLease> {
  options.signal?.throwIfAborted();
  const guard = directory + '.recovery', nonce = randomUUID();
  let guarded = false;
  try {
    for (let attempt = 0; attempt < 2 && !guarded; attempt++) {
      try { await writeFile(guard, JSON.stringify({ schema: 'GitLabWorkspaceControlRecovery/v1', kind, pid: process.pid, nonce }), { flag: 'wx', mode: 0o600 }); guarded = true; }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') break;
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        if (!await ownedStoragePath(path.dirname(directory), guard)) break;
        const info = await lstat(guard); if (!info.isFile() || info.size > 1024) break;
        const owner = JSON.parse(await readFile(guard, 'utf8'));
        if (owner.schema !== 'GitLabWorkspaceControlRecovery/v1' || owner.kind !== kind || !/^[a-f0-9-]{36}$/i.test(owner.nonce) || !Number.isSafeInteger(owner.pid) || owner.pid < 1) break;
        let dead = false; try { process.kill(owner.pid, 0); } catch (failure) { dead = (failure as NodeJS.ErrnoException).code === 'ESRCH'; }
        if (!dead || JSON.parse(await readFile(guard, 'utf8')).nonce !== owner.nonce) break;
        await unlink(guard);
      }
    }
    if (guarded && await ownedStoragePath(path.dirname(directory), directory)) {
      const file = path.join(directory, 'owner.json'), info = await lstat(file);
      if (info.isFile() && !info.isSymbolicLink() && info.size <= 4096) {
        const owner = JSON.parse(await readFile(file, 'utf8'));
        if (owner.schema === LEASE_SCHEMA && owner.kind === kind && owner.state === 'reserved' && owner.childPid === null &&
            /^[a-f0-9-]{36}$/i.test(owner.nonce) && Number.isSafeInteger(owner.pid) && owner.pid > 0) {
          let dead = false; try { process.kill(owner.pid, 0); } catch (error) { dead = (error as NodeJS.ErrnoException).code === 'ESRCH'; }
          if (dead && JSON.parse(await readFile(file, 'utf8')).nonce === owner.nonce) { await unlink(file); await rmdir(directory); }
        }
      }
    }
  } catch (error) { if (!missingFile(error)) throw error; }
  finally { if (guarded) await unlink(guard).catch(error => { if (!missingFile(error)) throw error; }); }
  return LocalNetworkLease.acquire(directory, kind, options);
}
