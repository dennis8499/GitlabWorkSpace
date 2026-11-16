import { createHash, randomUUID } from 'node:crypto';
import { mkdir, lstat, readFile, rename, rmdir, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export const LEASE_SCHEMA = 'GitLabWorkspaceLease/v1';
export interface NetworkLeaseOptions { signal?: AbortSignal; timeoutMs?: number; deadline?: number; }
export class NetworkLeaseError extends Error {
  constructor(message: string, readonly coordinationCode: string, options?: ErrorOptions) { super(message, options); this.name = 'NetworkLeaseError'; }
}
export function checkNetworkBudget(options: Pick<NetworkLeaseOptions, 'signal' | 'deadline'>): void {
  options.signal?.throwIfAborted();
  if (options.deadline !== undefined && Date.now() >= options.deadline) {
    throw Object.assign(new NetworkLeaseError('Network coordination deadline expired before sending.', 'queue-timeout'), { name: 'TimeoutError' });
  }
}
/** Reopen metadata only; a partial write must never be blindly repeated. */
export async function readNetworkMetadata(file: string, options: Pick<NetworkLeaseOptions, 'signal' | 'deadline'> = {}): Promise<string> {
  for (let attempt = 0; ; attempt++) {
    checkNetworkBudget(options);
    try { const value = await readFile(file, 'utf8'); checkNetworkBudget(options); return value; }
    catch (error) {
      if (process.platform !== 'win32' || !['EBADF', 'EPERM', 'EACCES', 'EBUSY'].includes((error as NodeJS.ErrnoException).code ?? '') || attempt >= 3) throw error;
      await networkSleep(10 * (attempt + 1), options.signal);
    }
  }
}
export function networkRuntimeRoot(): string {
  if (process.env.GITLAB_WORKSPACE_RUNTIME_DIR) return path.resolve(process.env.GITLAB_WORKSPACE_RUNTIME_DIR);
  return process.platform === 'win32'
    ? path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'GitLabWorkspace', 'runtime-v1')
    : process.env.XDG_RUNTIME_DIR ? path.join(process.env.XDG_RUNTIME_DIR, 'gitlab-workspace', 'runtime-v1')
      : path.join(os.homedir(), '.cache', 'gitlab-workspace', 'runtime-v1');
}
export function networkHostKey(host: string): string { return createHash('sha256').update(host.toLowerCase()).digest('hex'); }
export function networkAbort(message = 'Network operation cancelled before sending.'): Error {
  return Object.assign(new Error(message), { name: 'AbortError', effect: 'none' });
}
export async function networkSleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) throw signal.reason ?? networkAbort();
  await new Promise<void>((resolve, reject) => {
    const onAbort = (): void => { clearTimeout(timer); signal?.removeEventListener('abort', onAbort); reject(signal?.reason ?? networkAbort()); };
    const timer = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve(); }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort();
  });
}
export async function secureRuntimeDirectory(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new NetworkLeaseError('Network coordination directory must be a local directory, not a link.', 'unsafe-path');
}
export async function atomicNetworkJson(file: string, value: unknown, options: Pick<NetworkLeaseOptions, 'signal' | 'deadline'> = {}): Promise<void> {
  checkNetworkBudget(options);
  const temporary = file + '.' + randomUUID() + '.tmp';
  try {
    await writeFile(temporary, JSON.stringify(value), { encoding: 'utf8', mode: 0o600, flag: 'wx', signal: options.signal });
    const deadline = Math.min(Date.now() + 2_000, options.deadline ?? Infinity);
    for (;;) {
      checkNetworkBudget(options);
      try { await rename(temporary, file); break; }
      catch (error) { if (!isTransientWindowsFileError(error) || Date.now() >= deadline) throw error; await networkSleep(10, options.signal); }
    }
  }
  finally { await unlink(temporary).catch(() => undefined); }
}
function isTransientWindowsFileError(error: unknown): boolean {
  return process.platform === 'win32' && ['EPERM', 'EACCES', 'EBUSY'].includes((error as NodeJS.ErrnoException).code ?? '');
}
export interface NetworkLeaseOwner {
  schema: typeof LEASE_SCHEMA; nonce: string; pid: number; createdAt: string; kind: string;
  state?: 'reserved' | 'starting' | 'running' | 'quarantined'; childPid?: number | null;
  childStartedAt?: string; processTreeConfirmed?: boolean;
}

/** Cross-language exclusive lease. Unknown owners are never reclaimed by age or PID. */
export class LocalNetworkLease {
  private released = false;
  private constructor(readonly directory: string, private owner: NetworkLeaseOwner) {}
  static async acquire(directory: string, kind: string, options: NetworkLeaseOptions = {}): Promise<LocalNetworkLease> {
    const deadline = Math.min(options.deadline ?? Infinity, Date.now() + (options.timeoutMs ?? 30_000));
    // Legacy resource callers use timeoutMs: 1 for a single non-waiting claim.
    // Only explicit deadlines also bound the first claim's metadata I/O.
    options = { ...options, deadline: options.deadline === undefined ? undefined : deadline };
    checkNetworkBudget(options);
    await secureRuntimeDirectory(path.dirname(directory));
    let missingOwnerSince: number | undefined;
    for (;;) {
      checkNetworkBudget(options);
      try {
        await mkdir(directory, { mode: 0o700 });
        const owner: NetworkLeaseOwner = { schema: LEASE_SCHEMA, nonce: randomUUID(), pid: process.pid, createdAt: new Date().toISOString(), kind, state: 'reserved', childPid: null, processTreeConfirmed: false };
        try { await atomicNetworkJson(path.join(directory, 'owner.json'), owner, options); }
        catch (error) { throw new NetworkLeaseError('Could not establish network lease; coordination is blocked until inspected.', 'owner-unconfirmed', { cause: error }); }
        return new LocalNetworkLease(directory, owner);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST' && !isTransientWindowsFileError(error)) throw error;
      }
      let info;
      try { info = await lstat(directory); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
        if (!isTransientWindowsFileError(error) || Date.now() >= deadline) throw error;
        await networkSleep(10, options.signal); continue;
      }
      if (!info.isDirectory() || info.isSymbolicLink()) throw new NetworkLeaseError('Unsafe network lease directory.', 'unsafe-path');
      try {
        const owner = JSON.parse(await readNetworkMetadata(path.join(directory, 'owner.json'), options)) as NetworkLeaseOwner;
        if (owner.schema !== LEASE_SCHEMA || !owner.nonce || !Number.isSafeInteger(owner.pid) || owner.pid < 1 || owner.kind !== kind || owner.state === 'quarantined') {
          throw new NetworkLeaseError('Unconfirmed or incompatible network operation owns this lease; inspect it before retrying.', 'owner-unconfirmed');
        }
        try { process.kill(owner.pid, 0); }
        catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') throw new NetworkLeaseError('A previous network owner stopped; its subprocess state must be checked before recovery.', 'owner-unconfirmed', { cause: error }); }
        missingOwnerSince = undefined;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT' && !isTransientWindowsFileError(error)) throw error;
        missingOwnerSince ??= Date.now();
        if (Date.now() - missingOwnerSince > 2_000) throw new NetworkLeaseError('Network lease metadata is missing; automatic recovery would be unsafe.', 'metadata-missing', { cause: error });
      }
      if (Date.now() >= deadline) throw Object.assign(new NetworkLeaseError('Timed out waiting for another network operation. No request was sent.', 'queue-timeout'), { name: 'TimeoutError', effect: 'none' });
      const poll = kind === 'api-control' ? 5 + Math.random() * 5 : 100 + Math.random() * 50;
      await networkSleep(Math.min(poll, deadline - Date.now()), options.signal);
    }
  }
  async update(fields: Partial<NetworkLeaseOwner>): Promise<void> {
    const current = JSON.parse(await readNetworkMetadata(path.join(this.directory, 'owner.json'))) as NetworkLeaseOwner;
    if (current.nonce !== this.owner.nonce) throw new NetworkLeaseError('Network lease owner changed.', 'owner-changed');
    this.owner = { ...this.owner, ...fields, schema: LEASE_SCHEMA, nonce: this.owner.nonce, pid: this.owner.pid, kind: this.owner.kind };
    await atomicNetworkJson(path.join(this.directory, 'owner.json'), this.owner);
  }
  async release(options: Pick<NetworkLeaseOptions, 'deadline'> = {}): Promise<void> {
    if (this.released) return;
    const current = JSON.parse(await readNetworkMetadata(path.join(this.directory, 'owner.json'), options)) as NetworkLeaseOwner;
    if (current.nonce !== this.owner.nonce) throw new NetworkLeaseError('Refusing to release a different network lease owner.', 'owner-changed');
    if (this.owner.kind === 'git' && !this.owner.processTreeConfirmed) {
      await this.update({ state: 'quarantined' });
      throw new Error('Git subprocess termination is unconfirmed; the network lease remains blocked.');
    }
    // The owner file is removed before the empty directory; contenders cannot replace it meanwhile.
    const deadline = Math.min(Date.now() + 2_000, options.deadline ?? Infinity);
    for (;;) {
      checkNetworkBudget(options);
      try { await unlink(path.join(this.directory, 'owner.json')); break; }
      catch (error) { if (!isTransientWindowsFileError(error) || Date.now() >= deadline) throw error; await networkSleep(10); }
    }
    for (;;) {
      checkNetworkBudget(options);
      try { await rmdir(this.directory); break; }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') break;
        if (!isTransientWindowsFileError(error) || Date.now() >= deadline) throw error;
        await networkSleep(10);
        // A completed Windows deletion may already have allowed a new owner to enter.
        try { const replacement = JSON.parse(await readNetworkMetadata(path.join(this.directory, 'owner.json'), options)); if (replacement.nonce !== this.owner.nonce) break; }
        catch (readError) { if ((readError as NodeJS.ErrnoException).code !== 'ENOENT' && !isTransientWindowsFileError(readError)) throw readError; }
      }
    }
    this.released = true;
  }
}
