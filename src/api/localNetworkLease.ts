import { createHash, randomUUID } from 'node:crypto';
import type { BigIntStats } from 'node:fs';
import { mkdir, lstat, readFile, readdir, rename, rmdir, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ownedStoragePath } from '../storage/ownedStorage';
import { currentOperationLog, type OperationLog } from '../logging/operationLog';
import { releaseWindowsLease, tryWindowsLease, WindowsLeaseError, type WindowsLeaseToken } from './windowsLocalLease';

export const LEASE_SCHEMA = 'GitLabWorkspaceLease/v1';
export interface NetworkLeaseOptions { signal?: AbortSignal; timeoutMs?: number; deadline?: number; log?: OperationLog; recoverable?: boolean; }
export class NetworkLeaseError extends Error {
  leasePath?: string;
  leaseKind?: string;
  constructor(message: string, readonly coordinationCode: string, options?: ErrorOptions & { leasePath?: string; leaseKind?: string }) {
    super(message, options); this.name = 'NetworkLeaseError'; this.leasePath = options?.leasePath; this.leaseKind = options?.leaseKind;
  }
}
type WorkflowLeaseKind = 'codex' | 'workflow-kit-asset' | 'workflow-kit-cache-control';
const workflowLeaseKind = (kind?: string): kind is WorkflowLeaseKind => kind === 'codex' || kind === 'workflow-kit-asset' || kind === 'workflow-kit-cache-control';
const workflowLeaseLabel: Record<WorkflowLeaseKind, string> = {
  codex: 'Codex 工作區鎖', 'workflow-kit-asset': 'WorkflowKit 附件鎖', 'workflow-kit-cache-control': 'WorkflowKit 快取控制鎖'
};
const workflowLeaseReasons: Record<string, string> = {
  'queue-timeout': '等待其他操作釋放鎖時逾時，請稍後重試。',
  'metadata-missing': '缺少擁有者資料，請依離線復原步驟檢查。',
  'owner-publication-pending': '暫時讀不到擁有者資料，請稍後重試。若持續出現，請依離線復原步驟檢查。',
  'metadata-unreadable': '無法讀取擁有者資料，請檢查本機權限或檔案占用。',
  'terminal-exit-unconfirmed': '尚未確認終端已退出，已保留鎖供離線檢查。',
  'process-tree-unconfirmed': '缺少程序樹完成證據，已保留鎖供離線檢查。',
  'retired-cleanup-pending': '已釋放，舊目錄清理待處理。',
  'unpublished-cleanup-pending': '未取得，空目錄清理待處理。',
  'release-pending': '尚未釋放，下次操作會重試釋放這把鎖。'
};

function leaseSystemCode(error: unknown): string | undefined {
  for (let depth = 0; error instanceof Error && depth < 5; depth++, error = error.cause) {
    const code = (error as NodeJS.ErrnoException).code;
    if (typeof code === 'string') return code;
  }
  return undefined;
}

export function reportWorkflowLeaseError(error: unknown, action: string, phase: 'admission' | 'cleanup', log: OperationLog | undefined = currentOperationLog()): Error {
  if (!(error instanceof NetworkLeaseError) || !workflowLeaseKind(error.leaseKind)) return error instanceof Error ? error : new Error(String(error));
  const { leaseKind, leasePath, coordinationCode } = error;
  const systemCode = leaseSystemCode(error);
  const label = workflowLeaseLabel[leaseKind];
  const reason = workflowLeaseReasons[coordinationCode] ?? (systemCode === 'ESRCH'
    ? '原擁有程序已退出，請依離線復原步驟確認相關操作已結束。'
    : '擁有者或鎖路徑無法確認，請依離線復原步驟檢查。');
  const message = `${label}${reason}請開啟 GitLab Workspace Log 核對鎖路徑。`;
  const runtimePath = leasePath && path.dirname(leaseKind === 'workflow-kit-cache-control' ? leasePath : path.dirname(leasePath));
  log?.record({ feature: 'workflow-coordination', action, result: 'error', level: phase === 'cleanup' ? 'warn' : 'error',
    network: false, coordinationPhase: phase, coordinationCode, systemCode, leaseKind, runtimePath, leasePath, message });
  const reported = new NetworkLeaseError(message, coordinationCode, { cause: error, leasePath, leaseKind });
  reported.name = error.name;
  return phase === 'admission' ? Object.assign(reported, { effect: 'none' }) : reported;
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
const isWorkflowMetadataAccessError = (error: unknown): boolean => ['EBADF', 'EPERM', 'EACCES', 'EBUSY'].includes(leaseSystemCode(error) ?? '');

function sameLeaseDirectory(first: BigIntStats, second: BigIntStats): boolean {
  return second.isDirectory() && !second.isSymbolicLink() && first.dev === second.dev && first.ino === second.ino && first.birthtimeNs === second.birthtimeNs;
}

async function isSameLeaseDirectory(directory: string, expected: BigIntStats): Promise<boolean> {
  try { return sameLeaseDirectory(expected, await lstat(directory, { bigint: true })); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
}
export interface NetworkLeaseOwner {
  schema: typeof LEASE_SCHEMA; nonce: string; pid: number; createdAt: string; kind: string;
  state?: 'reserved' | 'starting' | 'running' | 'quarantined'; childPid?: number | null;
  childStartedAt?: string; processTreeConfirmed?: boolean;
}

async function checkedApiControlOwner(directory: string, expected: NetworkLeaseOwner, options: NetworkLeaseOptions): Promise<void> {
  checkNetworkBudget(options);
  if (!await ownedStoragePath(path.dirname(directory), directory)) throw new NetworkLeaseError('API control lease disappeared before retirement.', 'owner-changed', { leasePath: directory });
  checkNetworkBudget(options);
  const file = path.join(directory, 'owner.json'), info = await lstat(file);
  if (!info.isFile() || info.isSymbolicLink() || info.size > 4096) throw new NetworkLeaseError('Unsafe API control lease metadata.', 'owner-unconfirmed', { leasePath: directory });
  const owner = JSON.parse(await readNetworkMetadata(file, options)) as NetworkLeaseOwner | null;
  if (!owner || owner.schema !== LEASE_SCHEMA || owner.kind !== 'api-control' || owner.state !== 'reserved' || owner.childPid !== null ||
      owner.nonce !== expected.nonce || owner.pid !== expected.pid || !/^[a-f0-9-]{36}$/i.test(owner.nonce) || !Number.isSafeInteger(owner.pid) || owner.pid < 1) {
    throw new NetworkLeaseError('Refusing to retire an unconfirmed or different API control owner.', 'owner-changed', { leasePath: directory });
  }
}

function warnApiControlCleanup(error: unknown, leasePath: string, code: string): void {
  currentOperationLog()?.record({ feature: 'api-coordination', action: 'cleanup', result: 'error', level: 'warn', network: false,
    coordinationPhase: 'cleanup', coordinationCode: code, leasePath, systemCode: (error as NodeJS.ErrnoException)?.code,
    message: code === 'retired-cleanup-pending' ? 'API 控制鎖已釋放；舊目錄清理未完成，後續請求可繼續。' : 'API 控制鎖尚未建立；空目錄清理未完成，請檢查指定路徑。' });
}

async function checkedWorkflowOwner(directory: string, expected: NetworkLeaseOwner, identity: BigIntStats, options: NetworkLeaseOptions): Promise<void> {
  checkNetworkBudget(options);
  const changed = () => new NetworkLeaseError('Workflow lease owner changed before retirement.', 'owner-changed');
  if (!await ownedStoragePath(path.dirname(directory), directory) || !await isSameLeaseDirectory(directory, identity)) throw changed();
  checkNetworkBudget(options);
  const file = path.join(directory, 'owner.json');
  const info = await lstat(file).catch(error => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw changed();
    throw error;
  });
  if (!info.isFile() || info.isSymbolicLink() || info.size > 4096) {
    throw new NetworkLeaseError('Unsafe workflow lease metadata.', 'owner-unconfirmed');
  }
  const owner = JSON.parse(await readNetworkMetadata(file, options)) as NetworkLeaseOwner | null;
  if (owner?.schema !== LEASE_SCHEMA || owner.nonce !== expected.nonce || owner.pid !== expected.pid ||
      owner.kind !== expected.kind || owner.state !== expected.state || owner.childPid !== expected.childPid ||
      owner.state === 'quarantined' || !await isSameLeaseDirectory(directory, identity)) throw changed();
}

function warnLeaseCleanup(error: unknown, leasePath: string, kind: string, code: string, log?: OperationLog): void {
  if (workflowLeaseKind(kind)) {
    reportWorkflowLeaseError(new NetworkLeaseError('Workflow lease cleanup is pending.', code, { cause: error, leasePath, leaseKind: kind }),
      'release', 'cleanup', log);
  } else warnApiControlCleanup(error, leasePath, code);
}

async function waitForWorkflowRelease(release: Promise<void>, deadline: number, signal?: AbortSignal): Promise<void> {
  const timer = AbortSignal.timeout(Math.min(2_147_483_647, Math.max(1, deadline - Date.now())));
  const onTimeout = () => new NetworkLeaseError('Timed out waiting for a pending workflow lock release.', 'queue-timeout');
  const stop = signal ? AbortSignal.any([signal, timer]) : timer;
  let abort!: () => void;
  const cancelled = new Promise<never>((_resolve, reject) => {
    abort = () => reject(signal?.aborted ? signal.reason : onTimeout());
    stop.addEventListener('abort', abort, { once: true });
    if (stop.aborted) abort();
  });
  try { await Promise.race([release, cancelled]); }
  finally { stop.removeEventListener('abort', abort); }
  checkNetworkBudget({ deadline, signal });
}

/** Only reserved JS API controls may detach. The caller serializes release or holds the recovery guard. */
export async function retireApiControlLease(directory: string, owner: NetworkLeaseOwner, options: NetworkLeaseOptions = {}): Promise<void> {
  return retireOwnedLease(directory, owner, options, checkedApiControlOwner);
}

async function retireOwnedLease(directory: string, owner: NetworkLeaseOwner, options: NetworkLeaseOptions,
  checkOwner: (directory: string, owner: NetworkLeaseOwner, options: NetworkLeaseOptions) => Promise<void>, committed?: () => void): Promise<void> {
  const retired = directory + '.retired-' + owner.nonce + '-' + randomUUID();
  const budget = { ...options, deadline: Math.min(Date.now() + 2_000, options.deadline ?? Infinity) };
  try {
    for (;;) {
      checkNetworkBudget(budget);
      try {
        await lstat(retired);
        throw new NetworkLeaseError('Lease retirement destination is occupied.', owner.kind === 'api-control' ? 'owner-changed' : 'retirement-destination-occupied', { leasePath: retired });
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      await checkOwner(directory, owner, budget);
      checkNetworkBudget(budget);
      try { await rename(directory, retired); break; }
      catch (error) {
        if (!isTransientWindowsFileError(error) || Date.now() >= budget.deadline) throw error;
        await networkSleep(10, options.signal);
      }
    }
  } catch (error) {
    if (error instanceof Error && Object.isExtensible(error)) Object.assign(error, { leasePath: directory });
    throw error;
  }
  // Rename is the release commit. Never revisit the canonical path or fail admission
  // because garbage collection failed after a successor could already own it.
  committed?.();
  try {
    await checkOwner(retired, owner, budget);
    checkNetworkBudget(budget);
    const entries = await readdir(retired);
    if (entries.length !== 1 || entries[0] !== 'owner.json') throw new NetworkLeaseError('Retired lease contains unexpected files; all metadata was preserved.', 'owner-unconfirmed');
    checkNetworkBudget(budget); await unlink(path.join(retired, 'owner.json'));
    checkNetworkBudget(budget); await rmdir(retired);
  } catch (error) { warnLeaseCleanup(error, retired, owner.kind, 'retired-cleanup-pending', options.log); }
}

/** Cross-language exclusive lease. Unknown owners are never reclaimed by age or PID. */
export class LocalNetworkLease {
  private static readonly pendingWorkflowReleases = new Map<string, LocalNetworkLease>();
  private released = false;
  private releaseInFlight?: Promise<void>;
  private releaseCommitted?: Promise<void>;
  private constructor(readonly directory: string, private owner: NetworkLeaseOwner, private readonly identity?: BigIntStats,
    private readonly log?: OperationLog, readonly recovery?: WindowsLeaseToken) {}
  private static workflowKey(directory: string): string {
    const absolute = path.resolve(directory);
    return process.platform === 'win32' ? absolute.toLowerCase() : absolute;
  }
  static async acquire(directory: string, kind: string, options: NetworkLeaseOptions = {}): Promise<LocalNetworkLease> {
    try {
      if (options.recoverable) {
        const recoverable = await this.acquireRecoverable(directory, kind, options);
        if (recoverable) return recoverable;
      }
      return await this.acquireExclusive(directory, kind, options);
    }
    catch (error) {
      if (error instanceof NetworkLeaseError) {
        error.leasePath ??= directory;
        error.leaseKind ??= kind;
      } else if (workflowLeaseKind(kind) && isWorkflowMetadataAccessError(error)) {
        throw new NetworkLeaseError('Workflow lease metadata could not be read.', 'metadata-unreadable', { cause: error, leasePath: directory, leaseKind: kind });
      }
      throw error;
    }
  }
  static async acquireRecoverable(directory: string, kind: string, options: NetworkLeaseOptions): Promise<LocalNetworkLease | undefined> {
    if (process.platform !== 'win32') return;
    const acquired = await tryWindowsLease(directory, kind, {
      deadline: options.deadline, timeoutMs: options.timeoutMs ?? 30_000, signal: options.signal
    }).catch(error => { throw windowsLeaseFailure(error, directory, kind); });
    if (!acquired) return;
    const { token } = acquired;
    if (acquired.recovered) (options.log ?? currentOperationLog())?.record({
      feature: 'local-lock', action: 'recover', result: 'success', leasePath: directory, leaseKind: kind, coordinationCode: 'owner-retired'
    });
    return new LocalNetworkLease(token.directory,
      { schema: LEASE_SCHEMA, nonce: token.nonce, pid: token.pid, kind, state: 'running', createdAt: new Date().toISOString() },
      undefined, options.log, token);
  }
  private static async acquireExclusive(directory: string, kind: string, options: NetworkLeaseOptions): Promise<LocalNetworkLease> {
    const deadline = Math.min(options.deadline ?? Infinity, Date.now() + (options.timeoutMs ?? 30_000));
    const workflow = workflowLeaseKind(kind);
    // Legacy resource callers use timeoutMs: 1 for a single non-waiting claim.
    // Only explicit deadlines also bound the first claim's metadata I/O.
    options = { ...options, deadline: options.deadline === undefined ? undefined : deadline };
    checkNetworkBudget(options);
    await secureRuntimeDirectory(path.dirname(directory));
    const pending = workflow ? this.pendingWorkflowReleases.get(this.workflowKey(directory)) : undefined;
    if (pending?.owner.kind === kind) {
      try {
        checkNetworkBudget({ deadline, signal: options.signal });
        const release = pending.release({ deadline, signal: options.signal });
        const committed = pending.releaseCommitted ? Promise.race([pending.releaseCommitted, release]) : release;
        await waitForWorkflowRelease(committed, deadline, options.signal);
      }
      catch (error) {
        options.signal?.throwIfAborted();
        if (!(error instanceof NetworkLeaseError) || error.coordinationCode !== 'owner-changed') throw error;
      }
    }
    let missingOwnerSince: number | undefined;
    let previousDirectory: BigIntStats | undefined;
    let previousMetadataCode: string | undefined;
    for (;;) {
      checkNetworkBudget(options);
      let claimed = false;
      try {
        await mkdir(directory, { mode: 0o700 });
        claimed = true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST' && !isTransientWindowsFileError(error)) throw error;
        if (workflow && isTransientWindowsFileError(error) && !await ownedStoragePath(path.dirname(directory), directory)) throw error;
      }
      if (claimed) {
        const created = kind === 'api-control' || workflow ? await lstat(directory, { bigint: true }) : undefined;
        if (created && (!created.isDirectory() || created.isSymbolicLink())) throw new NetworkLeaseError('Unsafe network lease directory.', 'unsafe-path');
        // A pre-existing extension only reclaims dead cache controls marked reserved.
        const state = kind === 'workflow-kit-cache-control' ? 'running' : 'reserved';
        const owner: NetworkLeaseOwner = { schema: LEASE_SCHEMA, nonce: randomUUID(), pid: process.pid, createdAt: new Date().toISOString(), kind, state, childPid: null, processTreeConfirmed: false };
        try { await atomicNetworkJson(path.join(directory, 'owner.json'), owner, options); }
        catch (error) {
          if (created) {
            try {
              const cleanup = { deadline: Date.now() + 1_000 };
              checkNetworkBudget(cleanup);
              if (await ownedStoragePath(path.dirname(directory), directory)) {
                checkNetworkBudget(cleanup);
                const same = await isSameLeaseDirectory(directory, created);
                checkNetworkBudget(cleanup);
                if (same) await rmdir(directory);
              }
            } catch (cleanupError) { warnLeaseCleanup(cleanupError, directory, kind, 'unpublished-cleanup-pending', options.log); }
          }
          if (workflow && options.signal?.aborted) options.signal.throwIfAborted();
          throw new NetworkLeaseError('Could not establish network lease; no operation entered the lease.', 'owner-unconfirmed', { cause: error });
        }
        return new LocalNetworkLease(directory, owner, created, options.log);
      }
      let info;
      try { info = await lstat(directory, { bigint: true }); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') { previousDirectory = undefined; missingOwnerSince = undefined; continue; }
        if (!isTransientWindowsFileError(error) || Date.now() >= deadline) throw error;
        await networkSleep(10, options.signal); continue;
      }
      if (!info.isDirectory() || info.isSymbolicLink()) throw new NetworkLeaseError('Unsafe network lease directory.', 'unsafe-path');
      if (workflow && (!previousDirectory || !sameLeaseDirectory(previousDirectory, info))) missingOwnerSince = undefined;
      previousDirectory = info;
      const file = path.join(directory, 'owner.json');
      try {
        if (workflow) {
          const metadata = await lstat(file);
          if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > 4096) {
            throw new NetworkLeaseError('Unsafe workflow lease metadata.', 'owner-unconfirmed');
          }
        }
        const owner = JSON.parse(await readNetworkMetadata(file, options)) as NetworkLeaseOwner | null;
        if (!owner || owner.schema !== LEASE_SCHEMA || !owner.nonce || !Number.isSafeInteger(owner.pid) || owner.pid < 1 || owner.kind !== kind || owner.state === 'quarantined') {
          throw new NetworkLeaseError('Unconfirmed or incompatible network operation owns this lease; inspect it before retrying.', 'owner-unconfirmed');
        }
        try { process.kill(owner.pid, 0); }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ESRCH') {
            if (workflow && !await isSameLeaseDirectory(directory, info)) { missingOwnerSince = undefined; continue; }
            throw new NetworkLeaseError('A previous network owner stopped; its subprocess state must be checked before recovery.', 'owner-unconfirmed', { cause: error });
          }
        }
        missingOwnerSince = undefined;
      } catch (error) {
        if (workflow && error instanceof SyntaxError) throw new NetworkLeaseError('Malformed workflow lease metadata.', 'owner-unconfirmed', { cause: error });
        const code = (error as NodeJS.ErrnoException).code;
        const inaccessible = workflow ? isWorkflowMetadataAccessError(error) : isTransientWindowsFileError(error);
        if (code !== 'ENOENT' && !inaccessible) throw error;
        const now = workflow ? performance.now() : Date.now();
        if (workflow && previousMetadataCode !== code) missingOwnerSince = undefined;
        previousMetadataCode = code;
        missingOwnerSince ??= now;
        if (now - missingOwnerSince > 2_000) {
          if (workflow && !await isSameLeaseDirectory(directory, info)) { missingOwnerSince = undefined; continue; }
          if (workflow && inaccessible) throw new NetworkLeaseError('Workflow lease metadata could not be read.', 'metadata-unreadable', { cause: error });
          if (workflow) {
            try { await readNetworkMetadata(file, options); missingOwnerSince = undefined; continue; }
            catch (current) { if ((current as NodeJS.ErrnoException).code !== 'ENOENT') throw current; }
          }
          throw new NetworkLeaseError('Network lease metadata is missing; automatic recovery would be unsafe.', 'metadata-missing', { cause: error });
        }
        if (workflow && inaccessible && Date.now() >= deadline) {
          throw new NetworkLeaseError('Workflow lease metadata could not be read.', 'metadata-unreadable', { cause: error });
        }
        if (kind === 'codex' && Date.now() >= deadline) {
          throw new NetworkLeaseError('Codex lease owner publication is pending or missing.', 'owner-publication-pending', { cause: error });
        }
      }
      if (Date.now() >= deadline) throw Object.assign(new NetworkLeaseError('Timed out waiting for another network operation. No request was sent.', 'queue-timeout'), { name: 'TimeoutError', effect: 'none' });
      const poll = kind === 'api-control' ? 5 + Math.random() * 5 : 100 + Math.random() * 50;
      await networkSleep(Math.min(poll, deadline - Date.now()), options.signal);
    }
  }
  async update(fields: Partial<NetworkLeaseOwner>): Promise<void> {
    if (this.recovery) throw new NetworkLeaseError('Windows process supervision owns changes to this lease.', 'invalid-lifecycle',
      { leasePath: this.directory, leaseKind: this.owner.kind });
    const current = JSON.parse(await readNetworkMetadata(path.join(this.directory, 'owner.json'))) as NetworkLeaseOwner;
    if (current.nonce !== this.owner.nonce) throw new NetworkLeaseError('Network lease owner changed.', 'owner-changed');
    this.owner = { ...this.owner, ...fields, schema: LEASE_SCHEMA, nonce: this.owner.nonce, pid: this.owner.pid, kind: this.owner.kind };
    await atomicNetworkJson(path.join(this.directory, 'owner.json'), this.owner);
  }
  release(options: Pick<NetworkLeaseOptions, 'deadline' | 'signal'> = {}): Promise<void> {
    const kind = this.owner.kind;
    if (this.recovery) {
      if (this.released) return Promise.resolve();
      return this.releaseInFlight ??= releaseWindowsLease(this.recovery, options.deadline, options.signal).then(
        () => { this.released = true; },
        error => { throw windowsLeaseFailure(error, this.directory, kind); }
      ).finally(() => { this.releaseInFlight = undefined; });
    }
    if (kind !== 'api-control' && !workflowLeaseKind(kind)) return this.releaseLegacy(options);
    if (this.released) return Promise.resolve();
    if (this.releaseInFlight) return this.releaseInFlight;
    const key = this.identity && workflowLeaseKind(kind) ? LocalNetworkLease.workflowKey(this.directory) : undefined;
    const identity = this.identity;
    const forgetPending = () => {
      if (key && LocalNetworkLease.pendingWorkflowReleases.get(key) === this) LocalNetworkLease.pendingWorkflowReleases.delete(key);
    };
    let retire: Promise<void>;
    if (key && identity) {
      let markCommitted!: () => void;
      this.releaseCommitted = new Promise(resolve => { markCommitted = resolve; });
      retire = retireOwnedLease(this.directory, this.owner, { ...options, log: this.log },
        (directory, owner, budget) => checkedWorkflowOwner(directory, owner, identity, budget),
        () => { forgetPending(); markCommitted(); });
    } else retire = retireApiControlLease(this.directory, this.owner, options);
    this.releaseInFlight = retire.then(() => {
      this.released = true; this.releaseInFlight = undefined; this.releaseCommitted = undefined;
    }, error => {
      this.releaseInFlight = undefined; this.releaseCommitted = undefined;
      if (!key) throw error;
      const changed = error instanceof NetworkLeaseError && error.coordinationCode === 'owner-changed';
      if (changed) forgetPending();
      else LocalNetworkLease.pendingWorkflowReleases.set(key, this);
      throw new NetworkLeaseError('Could not retire the workflow lease.', changed ? 'owner-changed' : 'release-pending', {
        cause: error, leaseKind: kind, leasePath: this.directory
      });
    });
    return this.releaseInFlight;
  }
  private async releaseLegacy(options: Pick<NetworkLeaseOptions, 'deadline'>): Promise<void> {
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

function windowsLeaseFailure(error: unknown, directory: string, kind: string): unknown {
  if (!(error instanceof WindowsLeaseError)) return error;
  const code = workflowLeaseKind(kind) && error.coordinationCode === 'metadata-unreadable'
    ? 'owner-unconfirmed' : error.coordinationCode;
  const osCode = code === 'metadata-missing' ? 'ENOENT' : error.nativeCode === 5 ? 'EACCES' :
    error.nativeCode === 32 || error.nativeCode === 33 ? 'EBUSY' : undefined;
  const cause = osCode ? Object.assign(error, { code: osCode }) : error;
  const mapped = new NetworkLeaseError('Windows 本機鎖無法取得或完成復原（' + code + '）。', code,
    { cause, leasePath: directory, leaseKind: kind });
  if (code === 'queue-timeout') mapped.name = 'TimeoutError';
  return mapped;
}
