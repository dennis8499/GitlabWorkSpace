import { randomUUID } from 'node:crypto';
import { observeRead } from './readObservation';
import path from 'node:path';
import { GitLabReadGate } from './gitLabReadGate';
import { atomicNetworkJson, checkNetworkBudget, LocalNetworkLease, NetworkLeaseError, networkAbort, networkHostKey, networkRuntimeRoot, networkSleep, readNetworkMetadata, secureRuntimeDirectory } from './localNetworkLease';
import { acquireStorageControl } from '../storage/controlLease';
import { currentOperationLog } from '../logging/operationLog';

interface ApiPolicy { startsPerSecond: number; concurrency: number; }
interface NetworkPolicy { schema: 'GitLabWorkspaceNetworkPolicy/v1'; api?: Partial<ApiPolicy>; hosts?: Record<string, Partial<ApiPolicy>>; aliases?: Record<string, string>; }
interface ApiState {
  schema: 'GitLabWorkspaceApiState/v1'; nextStartAt: number; cooldownUntil: number;
  active: Array<{ nonce: string; pid: number; startedAt: number; deadline: number }>;
}
const DEFAULT_POLICY: ApiPolicy = { startsPerSecond: 1, concurrency: 2 };
const RESPONSE_LIMIT = 32 * 1024 * 1024;
// One local contender per host prevents a refresh burst from repeatedly touching
// the same cross-process directory. The file protocol remains authoritative.
const admissions = new Map<string, { gate: GitLabReadGate; users: number }>();
interface Reservation { directory: string; nonce: string; phase: 'admitting' | 'admitted' | 'sending' | 'orphaned' | 'settled'; }
// Only this process's positively known, abandoned reservations may be reclaimed.
const reservations = new Map<string, Map<string, Reservation>>();
const pendingControls = new Map<string, Set<LocalNetworkLease>>();
const controlReleases = new Map<LocalNetworkLease, Promise<void>>();
const CLEANUP_BUDGET_MS = 5_000;

export interface NetworkCoordinationDiagnostics {
  phase: 'admission' | 'cooldown' | 'cleanup'; code: string; systemCode?: string;
  runtimePath: string; leasePath?: string; requestStarted: boolean;
}

export class GitLabNetworkError extends Error {
  readonly effect = 'none';
  constructor(message: string, readonly retryAt?: number, options?: ErrorOptions, readonly diagnostics?: NetworkCoordinationDiagnostics) { super(message, options); this.name = 'GitLabNetworkError'; }
}
export class GitLabNetworkCleanupError extends Error {
  constructor(readonly diagnostics: NetworkCoordinationDiagnostics, options: ErrorOptions) {
    super('GitLab 請求已開始，但本機協調狀態清理未完成；請先核對結果，不要重複送出寫入。', options);
    this.name = 'GitLabNetworkCleanupError';
  }
}
function systemCode(error: unknown): string | undefined {
  const seen = new Set<unknown>();
  while (error && typeof error === 'object' && !seen.has(error)) {
    seen.add(error);
    const value = error as NodeJS.ErrnoException & { cause?: unknown };
    if (typeof value.code === 'string' && /^[A-Z][A-Z0-9_]{1,31}$/.test(value.code)) return value.code;
    error = value.cause;
  }
  return undefined;
}
export function parseRetryAfter(value: string | null, now = Date.now()): number | undefined {
  if (!value?.trim()) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0 && now + seconds * 1000 <= 8.64e15) return now + seconds * 1000;
  if (Number.isFinite(seconds)) return undefined;
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(now, date) : undefined;
}
function checkedPolicy(value: Partial<ApiPolicy>): ApiPolicy {
  const result = { ...DEFAULT_POLICY, ...value };
  if (!Number.isFinite(result.startsPerSecond) || result.startsPerSecond <= 0 || result.startsPerSecond > 10_000
    || !Number.isSafeInteger(result.concurrency) || result.concurrency < 1 || result.concurrency > 128) throw new NetworkLeaseError('Invalid local GitLab network policy.', 'invalid-policy');
  return result;
}

/** Per-host pacing, active requests and cooldown are shared across accounts and processes. */
export class GitLabNetworkGate {
  constructor(private readonly root = networkRuntimeRoot(), private readonly timeoutMs = 30_000) {}

  async fetch(fetcher: (input: string | URL | Request, init?: RequestInit) => Promise<Response>, input: URL, init: RequestInit = {}, safeRead = ['GET', 'HEAD'].includes((init.method ?? 'GET').toUpperCase()), responseLimit = RESPONSE_LIMIT, onStart?: () => void, onBytes?: (bytes: number) => void): Promise<Response> {
    const signal = init.signal ?? undefined;
    const deadline = Date.now() + this.timeoutMs;
    let attempt = 0;
    for (;;) {
      let reservation: Reservation;
      observeRead({ transportStage: 'waiting' });
      try { reservation = await this.acquire(input.hostname, signal, deadline); }
      catch (error) {
        if (signal?.aborted && signal.reason?.name !== 'TimeoutError') throw signal.reason ?? networkAbort();
        throw this.failure(error, 'admission', false);
      }
      let response: Response;
      try {
        if (signal?.aborted) throw networkAbort();
        reservation.phase = 'sending';
        onStart?.();
        observeRead({ transportStage: 'sending' });
        response = await fetcher(input, init);
        if (response.status === 429 || response.status === 503) {
          const retryAt = parseRetryAfter(response.headers.get('retry-after')) ?? Date.now() + (response.status === 429 ? 30_000 : Math.min(30_000, 1_000 * 2 ** attempt));
          try { await this.cooldown(reservation.directory, retryAt); }
          catch (error) { throw this.failure(error, 'cooldown', true); }
          observeRead({ transportStage: 'cooldown', retryAt });
          if (safeRead && attempt < 2 && retryAt + 100 < deadline) {
            await response.body?.cancel().catch(() => undefined);
            attempt++;
            continue;
          }
        }
        // Read while owning the slot: a response header alone does not finish a download.
        const buffered = await boundedResponse(response, signal, responseLimit, onBytes);
        return buffered;
      } catch (error) {
        if (signal?.aborted) throw signal.reason ?? networkAbort();
        if (safeRead && attempt < 2 && error instanceof TypeError && Date.now() + 500 * 2 ** attempt < deadline) {
          attempt++;
          try { await this.cooldown(reservation.directory, Date.now() + 250 * 2 ** attempt + Math.random() * 250); }
          catch (failure) { throw this.failure(failure, 'cooldown', true); }
          continue;
        }
        throw error;
      } finally {
        const started = reservation.phase === 'sending';
        reservation.phase = 'settled';
        try { await this.finish(reservation.directory, reservation.nonce); }
        // eslint-disable-next-line no-unsafe-finally -- Cleanup failures must surface before unsafe recovery or deletion.
        catch (error) { throw this.failure(error, 'cleanup', started); }
      }
    }
  }

  private failure(error: unknown, phase: NetworkCoordinationDiagnostics['phase'], requestStarted: boolean): Error {
    const osCode = systemCode(error);
    const code = error instanceof NetworkLeaseError ? error.coordinationCode
      : error instanceof Error && error.name === 'TimeoutError' ? 'queue-timeout'
        : ['EACCES', 'EPERM', 'EROFS'].includes(osCode ?? '') ? 'runtime-access'
          : 'coordination-unavailable';
    const leasePath = error && typeof error === 'object' && 'leasePath' in error && typeof error.leasePath === 'string' ? error.leasePath : undefined;
    const diagnostics: NetworkCoordinationDiagnostics = { phase, code, systemCode: osCode, runtimePath: this.root, leasePath, requestStarted };
    currentOperationLog()?.record({ feature: 'api-coordination', action: phase, result: 'error', network: false,
      coordinationCode: code, coordinationPhase: phase, systemCode: osCode, runtimePath: this.root, leasePath, requestStarted,
      message: `本機網路協調失敗；${requestStarted ? '請求已開始，結果須核對' : '尚未送出 GitLab 請求'}。` });
    if (requestStarted) return new GitLabNetworkCleanupError(diagnostics, { cause: error });
    const message = error instanceof GitLabNetworkError ? error.message : code === 'queue-timeout'
      ? 'GitLab 請求在等待本機網路額度時逾時，尚未送出；請稍後重試。'
      : code === 'metadata-missing' ? '本機 API 控制鎖缺少擁有者資料，尚未送出 GitLab 請求；請開啟 Log 核對鎖路徑，依本機網路負載控制文件進行離線檢查。'
      : `本機 GitLab 網路協調無法使用（${osCode ?? code}），尚未送出請求；請開啟 Log 查看原因。`;
    return new GitLabNetworkError(message, error instanceof GitLabNetworkError ? error.retryAt : undefined, { cause: error }, diagnostics);
  }

  private async settings(hostname: string, signal: AbortSignal | undefined, deadline: number): Promise<{ host: string; policy: ApiPolicy }> {
    checkNetworkBudget({ signal, deadline });
    let config: NetworkPolicy = { schema: 'GitLabWorkspaceNetworkPolicy/v1' };
    try { config = JSON.parse(await readNetworkMetadata(path.join(this.root, 'network-policy.json'), { signal, deadline })) as NetworkPolicy; }
    catch (error) {
      if (error instanceof SyntaxError) throw new NetworkLeaseError('Cannot parse local GitLab network policy.', 'invalid-policy', { cause: error });
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    if (!config || config.schema !== 'GitLabWorkspaceNetworkPolicy/v1' || config.aliases !== undefined && (!config.aliases || typeof config.aliases !== 'object' || Array.isArray(config.aliases))) throw new NetworkLeaseError('Unsupported local GitLab network policy.', 'invalid-policy');
    const original = hostname.toLowerCase().replace(/\.$/, '');
    const alias = config.aliases?.[original] ?? original;
    if (typeof alias !== 'string') throw new NetworkLeaseError('Invalid GitLab host alias.', 'invalid-policy');
    const host = alias.toLowerCase().replace(/\.$/, '');
    if (!host || host.length > 255 || /[\s/\\]/.test(host)) throw new NetworkLeaseError('Invalid GitLab host alias.', 'invalid-policy');
    return { host, policy: checkedPolicy({ ...config.api, ...config.hosts?.[host] }) };
  }
  private async state(directory: string, deadline?: number): Promise<ApiState> {
    try {
      const state = JSON.parse(await readNetworkMetadata(path.join(directory, 'state.json'), { deadline })) as ApiState;
      if (state.schema !== 'GitLabWorkspaceApiState/v1' || !Number.isFinite(state.nextStartAt) || !Number.isFinite(state.cooldownUntil)
        || !Array.isArray(state.active) || state.active.some(item => typeof item.nonce !== 'string' || !Number.isSafeInteger(item.pid) || !Number.isFinite(item.deadline))) throw new Error('Invalid network state.');
      return state;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { schema: 'GitLabWorkspaceApiState/v1', nextStartAt: 0, cooldownUntil: 0, active: [] };
      if (error instanceof NetworkLeaseError) throw error;
      throw new NetworkLeaseError('Network coordination state is invalid; inspect it before retrying.', 'invalid-state', { cause: error });
    }
  }
  private async acquire(hostname: string, signal: AbortSignal | undefined, deadline: number): Promise<Reservation> {
    const { host, policy } = await this.settings(hostname, signal, deadline);
    const directory = path.join(this.root, 'api', networkHostKey(host));
    let entry = admissions.get(directory);
    if (!entry) { entry = { gate: new GitLabReadGate(1, 2_147_483_647), users: 0 }; admissions.set(directory, entry); }
    entry.users++;
    try {
      return await entry.gate.run([signal, AbortSignal.timeout(Math.max(1, deadline - Date.now()))], current => this.acquireShared(directory, policy, current, deadline));
    } catch (error) {
      if (pendingControls.has(path.join(directory, 'control.lock')) || this.reclaimable(directory).length) {
        try { await this.finish(directory); }
        catch (cleanupError) { this.failure(cleanupError, 'cleanup', false); }
      }
      throw error;
    } finally { if (--entry.users === 0) admissions.delete(directory); }
  }
  private async acquireShared(directory: string, policy: ApiPolicy, signal: AbortSignal, deadline: number): Promise<Reservation> {
    await secureRuntimeDirectory(directory);
    let observedCooldown = 0;
    for (;;) {
      if (signal?.aborted) throw signal.reason ?? networkAbort();
      checkNetworkBudget({ signal, deadline });
      const control = await this.control(directory, deadline, signal);
      let delay: number;
      let reserved: Reservation | undefined;
      try {
        const state = await this.state(directory, deadline);
        // A dead request owner cannot consume a new slot. Live owners retain slots until cleanup.
        state.active = state.active.filter(item => {
          try { process.kill(item.pid, 0); return true; }
          catch (error) { return (error as NodeJS.ErrnoException).code !== 'ESRCH'; }
        });
        const reclaimed = this.pruneKnown(directory, state);
        const now = Date.now(), readyAt = Math.max(state.nextStartAt, state.cooldownUntil);
        if (state.cooldownUntil > now && observedCooldown !== state.cooldownUntil) {
          observedCooldown = state.cooldownUntil;
          observeRead({ transportStage: 'cooldown', retryAt: state.cooldownUntil });
        }
        if (readyAt >= deadline) throw new GitLabNetworkError('GitLab requested a pause. Resume after ' + new Date(readyAt).toISOString() + '.', readyAt);
        if (state.active.length < policy.concurrency && readyAt <= now) {
          const nonce = randomUUID();
          reserved = { directory, nonce, phase: 'admitting' };
          let pending = reservations.get(directory);
          if (!pending) { pending = new Map(); reservations.set(directory, pending); }
          pending.set(nonce, reserved);
          state.active.push({ nonce, pid: process.pid, startedAt: now, deadline });
          state.nextStartAt = now + 1000 / policy.startsPerSecond;
          await this.commit(directory, state, reclaimed, deadline, signal);
        } else {
          if (reclaimed.length) await this.commit(directory, state, reclaimed, deadline, signal);
        }
        delay = Math.max(10, Math.min(100, readyAt - now));
      } catch (error) { if (reserved) reserved.phase = 'orphaned'; throw error; }
      finally {
        try { await this.releaseControl(control, deadline); }
        // eslint-disable-next-line no-unsafe-finally -- Retain the reservation before surfacing failed ownership cleanup.
        catch (error) { if (reserved) reserved.phase = 'orphaned'; throw error; }
      }
      if (reserved) { reserved.phase = 'admitted'; return reserved; }
      await networkSleep(delay + Math.random() * 10, signal);
    }
  }
  private async cooldown(directory: string, until: number): Promise<void> {
    const deadline = Date.now() + CLEANUP_BUDGET_MS, control = await this.control(directory, deadline);
    try { const state = await this.state(directory, deadline), reclaimed = this.pruneKnown(directory, state); state.cooldownUntil = Math.max(state.cooldownUntil, until); await this.commit(directory, state, reclaimed, deadline); }
    finally { await this.releaseControl(control, deadline); }
  }
  private async finish(directory: string, _nonce?: string): Promise<void> {
    const deadline = Date.now() + CLEANUP_BUDGET_MS, control = await this.control(directory, deadline);
    try { const state = await this.state(directory, deadline), reclaimed = this.pruneKnown(directory, state); await this.commit(directory, state, reclaimed, deadline); }
    finally { await this.releaseControl(control, deadline); }
  }
  private reclaimable(directory: string): Reservation[] {
    return [...(reservations.get(directory)?.values() ?? [])].filter(value => value.phase === 'orphaned' || value.phase === 'settled');
  }
  private pruneKnown(directory: string, state: ApiState): string[] {
    const known = this.reclaimable(directory).map(value => value.nonce);
    state.active = state.active.filter(item => item.pid !== process.pid || !known.includes(item.nonce));
    return known;
  }
  private async commit(directory: string, state: ApiState, reclaimed: string[], deadline: number, signal?: AbortSignal): Promise<void> {
    await atomicNetworkJson(path.join(directory, 'state.json'), state, { deadline, signal });
    const pending = reservations.get(directory);
    for (const nonce of reclaimed) pending?.delete(nonce);
    if (!pending?.size) reservations.delete(directory);
  }
  private async control(directory: string, deadline: number, signal?: AbortSignal): Promise<LocalNetworkLease> {
    const controlPath = path.join(directory, 'control.lock');
    for (const pending of [...(pendingControls.get(controlPath) ?? [])]) {
      const releasing = controlReleases.get(pending);
      if (releasing) { try { await releasing; } catch { /* Retry only this recorded owner below. */ } }
      if (pendingControls.get(controlPath)?.has(pending)) await this.releaseControl(pending, deadline);
    }
    checkNetworkBudget({ deadline, signal });
    try { return await acquireStorageControl(controlPath, 'api-control', { deadline, signal }); }
    catch (error) {
      if (error instanceof Error && Object.isExtensible(error)) Object.assign(error, { leasePath: controlPath });
      throw error;
    }
  }
  private async releaseControl(control: LocalNetworkLease, deadline: number): Promise<void> {
    const existing = controlReleases.get(control);
    if (existing) return existing;
    let pending = pendingControls.get(control.directory);
    if (!pending) { pending = new Set(); pendingControls.set(control.directory, pending); }
    pending.add(control);
    const release = control.release({ deadline });
    controlReleases.set(control, release);
    try {
      await release; pending.delete(control);
      if (!pending.size && pendingControls.get(control.directory) === pending) pendingControls.delete(control.directory);
    } finally { if (controlReleases.get(control) === release) controlReleases.delete(control); }
  }
}

async function boundedResponse(response: Response, signal: AbortSignal | undefined, limit: number, onBytes?: (bytes: number) => void): Promise<Response> {
  if (Number(response.headers.get('content-length') ?? 0) > limit) { await response.body?.cancel(); throw new Error('GitLab response is too large; it was not treated as complete.'); }
  const reader = response.body?.getReader();
  if (!reader) return response;
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  const abort = (): void => { void reader.cancel(signal?.reason).catch(() => undefined); };
  signal?.addEventListener('abort', abort, { once: true });
  try {
    for (;;) {
      if (signal?.aborted) throw signal.reason ?? networkAbort();
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      onBytes?.(chunk.value.byteLength);
      if (bytes > limit) throw new Error('GitLab response is too large; it exceeded its byte budget and was not treated as complete.');
      chunks.push(chunk.value);
    }
    if (signal?.aborted) throw signal.reason ?? networkAbort();
    const body = new Uint8Array(bytes);
    let offset = 0;
    for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength; }
    return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
  } catch (error) { await reader.cancel().catch(() => undefined); throw error; }
  finally { signal?.removeEventListener('abort', abort); reader.releaseLock(); }
}
