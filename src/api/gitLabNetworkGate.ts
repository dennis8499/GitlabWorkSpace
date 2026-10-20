import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { GitLabReadGate } from './gitLabReadGate';
import { atomicNetworkJson, LocalNetworkLease, networkAbort, networkHostKey, networkRuntimeRoot, networkSleep, secureRuntimeDirectory } from './localNetworkLease';

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

export class GitLabNetworkError extends Error {
  readonly effect = 'none';
  constructor(message: string, readonly retryAt?: number, options?: ErrorOptions) { super(message, options); this.name = 'GitLabNetworkError'; }
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
    || !Number.isSafeInteger(result.concurrency) || result.concurrency < 1 || result.concurrency > 128) throw new GitLabNetworkError('Invalid local GitLab network policy.');
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
      let reservation: { directory: string; nonce: string };
      try { reservation = await this.acquire(input.hostname, signal, deadline); }
      catch (error) {
        if (signal?.aborted) throw networkAbort();
        if (error instanceof GitLabNetworkError) throw error;
        throw new GitLabNetworkError('Network coordination is unavailable; no GitLab request was sent.', undefined, { cause: error });
      }
      let response: Response;
      try {
        if (signal?.aborted) throw networkAbort();
        onStart?.();
        response = await fetcher(input, init);
        if (response.status === 429 || response.status === 503) {
          const retryAt = parseRetryAfter(response.headers.get('retry-after')) ?? Date.now() + (response.status === 429 ? 30_000 : Math.min(30_000, 1_000 * 2 ** attempt));
          await this.cooldown(reservation.directory, retryAt);
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
          await this.cooldown(reservation.directory, Date.now() + 250 * 2 ** attempt + Math.random() * 250);
          continue;
        }
        throw error;
      } finally {
        try { await this.finish(reservation.directory, reservation.nonce); }
        catch (error) { throw new Error('The request finished but its coordination state could not be released; inspect it before retrying.', { cause: error }); }
      }
    }
  }

  private async settings(hostname: string): Promise<{ host: string; policy: ApiPolicy }> {
    let config: NetworkPolicy = { schema: 'GitLabWorkspaceNetworkPolicy/v1' };
    try { config = JSON.parse(await readFile(path.join(this.root, 'network-policy.json'), 'utf8')) as NetworkPolicy; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new GitLabNetworkError('Cannot read local GitLab network policy.'); }
    if (config.schema !== 'GitLabWorkspaceNetworkPolicy/v1' || config.aliases !== undefined && (!config.aliases || typeof config.aliases !== 'object' || Array.isArray(config.aliases))) throw new GitLabNetworkError('Unsupported local GitLab network policy.');
    const original = hostname.toLowerCase().replace(/\.$/, '');
    const host = (config.aliases?.[original] ?? original).toLowerCase().replace(/\.$/, '');
    if (!host || host.length > 255 || /[\s/\\]/.test(host)) throw new GitLabNetworkError('Invalid GitLab host alias.');
    return { host, policy: checkedPolicy({ ...config.api, ...config.hosts?.[host] }) };
  }
  private async state(directory: string): Promise<ApiState> {
    try {
      const state = JSON.parse(await readFile(path.join(directory, 'state.json'), 'utf8')) as ApiState;
      if (state.schema !== 'GitLabWorkspaceApiState/v1' || !Number.isFinite(state.nextStartAt) || !Number.isFinite(state.cooldownUntil)
        || !Array.isArray(state.active) || state.active.some(item => typeof item.nonce !== 'string' || !Number.isSafeInteger(item.pid) || !Number.isFinite(item.deadline))) throw new Error('Invalid network state.');
      return state;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { schema: 'GitLabWorkspaceApiState/v1', nextStartAt: 0, cooldownUntil: 0, active: [] };
      throw new GitLabNetworkError('Network coordination state is invalid; inspect it before retrying.');
    }
  }
  private async acquire(hostname: string, signal: AbortSignal | undefined, deadline: number): Promise<{ directory: string; nonce: string }> {
    const { host, policy } = await this.settings(hostname);
    const directory = path.join(this.root, 'api', networkHostKey(host));
    let entry = admissions.get(directory);
    if (!entry) { entry = { gate: new GitLabReadGate(1, 2_147_483_647), users: 0 }; admissions.set(directory, entry); }
    entry.users++;
    try {
      return await entry.gate.run([signal, AbortSignal.timeout(Math.max(1, deadline - Date.now()))], current => this.acquireShared(directory, policy, current, deadline));
    } finally { if (--entry.users === 0) admissions.delete(directory); }
  }
  private async acquireShared(directory: string, policy: ApiPolicy, signal: AbortSignal, deadline: number): Promise<{ directory: string; nonce: string }> {
    await secureRuntimeDirectory(directory);
    for (;;) {
      if (signal?.aborted) throw signal.reason ?? networkAbort();
      if (Date.now() >= deadline) throw new GitLabNetworkError('GitLab request budget expired before sending.');
      const control = await LocalNetworkLease.acquire(path.join(directory, 'control.lock'), 'api-control', { signal, timeoutMs: Math.max(1, deadline - Date.now()) });
      let delay = 100;
      try {
        const state = await this.state(directory);
        // A dead request owner cannot consume a new slot. Live owners retain slots until cleanup.
        state.active = state.active.filter(item => {
          try { process.kill(item.pid, 0); return true; }
          catch (error) { return (error as NodeJS.ErrnoException).code !== 'ESRCH'; }
        });
        const now = Date.now(), readyAt = Math.max(state.nextStartAt, state.cooldownUntil);
        if (readyAt >= deadline) throw new GitLabNetworkError('GitLab requested a pause. Resume after ' + new Date(readyAt).toISOString() + '.', readyAt);
        if (state.active.length < policy.concurrency && readyAt <= now) {
          const nonce = randomUUID();
          state.active.push({ nonce, pid: process.pid, startedAt: now, deadline });
          state.nextStartAt = now + 1000 / policy.startsPerSecond;
          await atomicNetworkJson(path.join(directory, 'state.json'), state);
          return { directory, nonce };
        }
        delay = Math.max(10, Math.min(100, readyAt - now));
      } finally { await control.release(); }
      await networkSleep(delay + Math.random() * 10, signal);
    }
  }
  private async cooldown(directory: string, until: number): Promise<void> {
    const control = await LocalNetworkLease.acquire(path.join(directory, 'control.lock'), 'api-control');
    try { const state = await this.state(directory); state.cooldownUntil = Math.max(state.cooldownUntil, until); await atomicNetworkJson(path.join(directory, 'state.json'), state); }
    finally { await control.release(); }
  }
  private async finish(directory: string, nonce: string): Promise<void> {
    const control = await LocalNetworkLease.acquire(path.join(directory, 'control.lock'), 'api-control');
    try { const state = await this.state(directory); state.active = state.active.filter(item => item.nonce !== nonce); await atomicNetworkJson(path.join(directory, 'state.json'), state); }
    finally { await control.release(); }
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
