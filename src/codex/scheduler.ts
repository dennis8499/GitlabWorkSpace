import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { lstat, readFile, realpath } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { atomicNetworkJson, LocalNetworkLease, networkRuntimeRoot } from '../api/localNetworkLease';
import { CodexWorkspaceLease } from './workspaceLease';
import { codexRootKey } from './taskStore';
import type { CodexTaskSpec } from './protocol';

const run = promisify(execFile);
const key = (value: string) => process.platform === 'win32' ? value.toLowerCase() : value;
function contains(parent: string, child: string): boolean {
  const relative = path.relative(key(parent), key(child));
  return !relative || !path.isAbsolute(relative) && relative !== '..' && !relative.startsWith('..' + path.sep);
}
export const codexResourcesOverlap = (a: readonly string[], b: readonly string[]): boolean => a.some(x => b.some(y => contains(x, y) || contains(y, x)));
async function canonical(candidate: string): Promise<string> {
  const suffix: string[] = []; let current = path.resolve(candidate);
  for (;;) {
    try { return path.join(await realpath(current), ...suffix); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      const parent = path.dirname(current); if (parent === current) throw error;
      suffix.unshift(path.basename(current)); current = parent;
    }
  }
}
export async function codexResourcePaths(spec: CodexTaskSpec): Promise<string[]> {
  const paths = [...spec.writableRoots, spec.root, ...(spec.origin ? [spec.origin.repositoryRoot] : []),
    ...(spec.workflow ? [spec.workflow.runtimeRoot] : []), ...(spec.commitReview ? [spec.commitReview.runtimeRoot] : [])];
  const repository = spec.origin?.repositoryRoot ?? spec.executionRoot ?? spec.root;
  try {
    const result = await run('git', ['-C', repository, 'rev-parse', '--path-format=absolute', '--git-common-dir'],
      { windowsHide: true, timeout: 5000, maxBuffer: 32_768, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_NO_LAZY_FETCH: '1' } });
    const common = result.stdout.trim();
    if (!path.isAbsolute(common)) throw new Error('Invalid Git common directory');
    paths.push(common);
  } catch {
    // A Git probe failure must not allow worktrees to bypass their shared lock.
    let current = path.resolve(repository);
    for (;;) {
      let found = false;
      try { await lstat(path.join(current, '.git')); found = true; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      if (found) throw new Error('無法核對 Git 共用目錄，請確認 Git 可用後再派發任務。');
      const parent = path.dirname(current); if (parent === current) break; current = parent;
    }
  }
  return [...new Set((await Promise.all(paths.map(canonical))).map(key))].sort();
}
interface ReservationRecord {
  taskId: string; nonce: string; pid: number; instance: string; paths: string[]; quarantined?: boolean; processStopped?: boolean;
  locks: Array<{ directory: string; nonce?: string; primary?: boolean; receipt?: { path: string; nonce: string } }>;
}
export interface CodexReservation {
  primary: CodexWorkspaceLease;
  extras: CodexWorkspaceLease[];
  directory: string;
  release(quarantined: boolean, processStopped?: boolean): Promise<void>;
}
/** Local-machine admission. Existing workspace locks also protect against older extension windows. */
export class CodexTaskScheduler {
  private readonly root: string;
  constructor(private readonly instance: string, runtime = networkRuntimeRoot()) { this.root = path.join(runtime, 'codex-scheduler-v2'); }
  private async read(): Promise<ReservationRecord[]> {
    const file = path.join(this.root, 'reservations.json');
    try {
      const info = await lstat(file); if (!info.isFile() || info.isSymbolicLink() || info.size > 1024 * 1024) throw new Error('排程紀錄無法驗證。');
      const value = JSON.parse(await readFile(file, 'utf8'));
      if (value.schema !== 'GitLabWorkspaceCodexScheduler/v2' || !Array.isArray(value.entries) || value.entries.length > 1000 || value.entries.some((entry: ReservationRecord) =>
        !entry || typeof entry.taskId !== 'string' || !Number.isSafeInteger(entry.pid) || !Array.isArray(entry.paths) || entry.paths.some(p => typeof p !== 'string' || !path.isAbsolute(p)) || !Array.isArray(entry.locks))) throw new Error('排程紀錄無法驗證。');
      return value.entries;
    } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
  }
  private write(entries: ReservationRecord[]): Promise<void> { return atomicNetworkJson(path.join(this.root, 'reservations.json'), { schema: 'GitLabWorkspaceCodexScheduler/v2', entries }); }
  async tryAcquire(taskId: string, spec: CodexTaskSpec, limit: number, signal?: AbortSignal, resources?: string[]): Promise<{ reservation?: CodexReservation; reason?: 'resource' | 'capacity' }> {
    const paths = resources ?? await codexResourcePaths(spec);
    const guard = await LocalNetworkLease.acquire(path.join(this.root, 'control'), 'codex-scheduler', { signal, timeoutMs: 2000 });
    const leases: CodexWorkspaceLease[] = [];
    try {
      let entries = await this.read();
      for (const entry of entries) {
        if (entry.quarantined) continue;
        let dead = false; try { process.kill(entry.pid, 0); } catch (error) { dead = (error as NodeJS.ErrnoException).code === 'ESRCH'; }
        if (!dead) continue;
        const primary = entry.locks.find(lock => lock.primary) ?? entry.locks[0];
        const confirmed = primary && await CodexWorkspaceLease.inspect(primary.directory, primary.receipt) === 'confirmed';
        if (confirmed && primary.nonce) {
          const proof = primary.receipt ?? { path: primary.directory + `.stopped-${primary.nonce}.json`, nonce: primary.nonce };
          for (const lock of entry.locks) {
            if (lock.nonce) await CodexWorkspaceLease.releaseWithProof(lock.directory, lock.nonce, proof);
            else await CodexWorkspaceLease.recoverConfirmed(lock.directory);
          }
          entries = entries.filter(value => value !== entry);
        }
        else entry.quarantined = true;
      }
      if (entries.some(entry => codexResourcesOverlap(entry.paths, paths))) { await this.write(entries); return { reason: 'resource' }; }
      // An unconfirmed process may still be alive. Keep its machine slot until
      // reconciliation proves it stopped, including when its owner has exited.
      if (entries.filter(entry => !entry.processStopped).length >= Math.max(1, Math.min(2, limit))) { await this.write(entries); return { reason: 'capacity' }; }
      const physicalRoots = await Promise.all([spec.root, ...(spec.origin ? [spec.origin.repositoryRoot] : [])].map(canonical));
      const roots = [...new Set(physicalRoots.map(key))].sort();
      const directories = roots.map(root => path.join(networkRuntimeRoot(), 'codex-workspaces', codexRootKey(root) + '.lock'));
      for (const directory of directories) {
        try { leases.push(await CodexWorkspaceLease.acquire(directory, { signal, timeoutMs: 1 })); }
        catch (error) {
          for (const lease of leases) await lease.release();
          if (signal?.aborted) throw error;
          return { reason: 'resource' };
        }
      }
      const primaryIndex = roots.indexOf(key(physicalRoots[0])), primary = leases[primaryIndex];
      const record: ReservationRecord = { taskId, nonce: randomUUID(), pid: process.pid, instance: this.instance, paths,
        locks: await Promise.all(directories.map(async (directory, index) => ({ directory, nonce: await leases[index].ownerNonce(), primary: index === primaryIndex }))) };
      entries.push(record); await this.write(entries);
      return { reservation: { primary, extras: leases.filter((_, index) => index !== primaryIndex), directory: directories[primaryIndex],
        release: async (quarantined, processStopped = false) => {
          const control = await LocalNetworkLease.acquire(path.join(this.root, 'control'), 'codex-scheduler');
          try {
            const latest = await this.read(), owned = latest.find(entry => entry.nonce === record.nonce);
            if (owned && quarantined) { owned.quarantined = true; owned.processStopped = processStopped; const receipt = await primary.processReceipt().catch(() => undefined); if (receipt) owned.locks[primaryIndex].receipt = receipt; }
            await this.write(owned && !quarantined ? latest.filter(entry => entry !== owned) : latest);
          } finally { await control.release(); }
        } } };
    } catch (error) { for (const lease of leases) await lease.release().catch(() => {}); throw error; }
    finally { await guard.release(); }
  }
  async reconcile(taskId: string): Promise<void> {
    const guard = await LocalNetworkLease.acquire(path.join(this.root, 'control'), 'codex-scheduler');
    try {
      const entries = await this.read(), target = entries.find(entry => entry.taskId === taskId);
      if (!target || !target.quarantined) return;
      if (!(await Promise.all(target.locks.map(lock => CodexWorkspaceLease.inspect(lock.directory, lock.receipt)))).every(value => value === 'confirmed')) return;
      await this.write(entries.filter(entry => entry !== target));
    } finally { await guard.release(); }
  }
}
