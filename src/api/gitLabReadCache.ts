import { withReadObservation, type ReadObservation } from './readObservation';

interface CachedValue {
  fetchedAt: number;
  expiresAt: number;
  value: unknown;
  bytes: number;
}

interface PendingRead<T> {
  transportListeners: Set<(event: ReadObservation) => void>;
  transport?: ReadObservation;
  fetchedAt?: number;
  controller: AbortController;
  force: boolean;
  handoff: boolean;
  invalidated: boolean;
  settled: boolean;
  subscribers: number;
  promise: Promise<T>;
}

export type GitLabCacheResult = 'hit' | 'miss' | 'joined' | 'refresh';
export interface GitLabReadCacheOptions {
  force?: boolean;
  signal?: AbortSignal;
  lifetimeMs?: number;
  /** Derived collections share pages, but only retain their assembly promise. */
  storeValue?: boolean;
  /** Derived readers stop promptly while their pending page can be handed off. */
  handoff?: boolean;
  onResult?: (result: GitLabCacheResult) => void;
  onRead?: (metadata: { dataSource: 'cache' | 'network'; fetchedAt: number; expiresAt: number }) => void;
  onTransport?: (event: ReadObservation) => void;
}

export function abortedReadError(): Error {
  const error = new Error('The GitLab read is no longer needed.');
  error.name = 'AbortError';
  return error;
}

export function isAbortedRead(error: unknown, signal?: AbortSignal): boolean {
  return signal?.aborted === true || (error instanceof Error && error.name === 'AbortError');
}

/** Short-lived, bounded cache for read-only GitLab data and shared in-flight reads. */
export class GitLabReadCache {
  private readonly values = new Map<string, CachedValue>();
  private readonly inFlight = new Map<string, PendingRead<unknown>>();
  private readonly handoffs = new Set<object>();
  private readonly orphaned = new Set<PendingRead<unknown>>();
  private cachedBytes = 0;

  constructor(
    private readonly lifetimeMs = 60_000,
    private readonly capacity = 256,
    private readonly now: () => number = Date.now,
    private readonly maxBytes = 32 * 1024 * 1024
  ) {
    if (!Number.isSafeInteger(lifetimeMs) || lifetimeMs <= 0) throw new RangeError('Cache lifetime must be positive.');
    if (!Number.isSafeInteger(capacity) || capacity <= 0) throw new RangeError('Cache capacity must be positive.');
    if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) throw new RangeError('Cache byte capacity must be positive.');
  }

  get<T>(
    key: string,
    load: (signal: AbortSignal) => Promise<T>,
    options: GitLabReadCacheOptions = {}
  ): Promise<T> {
    const { force = false, signal } = options;
    const lifetimeMs = options.lifetimeMs ?? this.lifetimeMs;
    if (!Number.isSafeInteger(lifetimeMs) || lifetimeMs <= 0) throw new RangeError('Cache lifetime must be positive.');
    if (signal?.aborted) return Promise.reject(abortedReadError());
    this.expire();

    if (!force) {
      const cached = this.values.get(key);
      if (cached) {
        this.values.delete(key);
        this.values.set(key, cached);
        options.onResult?.('hit');
        options.onRead?.({ dataSource: 'cache', fetchedAt: cached.fetchedAt, expiresAt: cached.expiresAt });
        return Promise.resolve(cached.value as T);
      }
    }

    let pending = this.inFlight.get(key) as PendingRead<T> | undefined;
    if (!pending || pending.invalidated || (force && !pending.force)) {
      if (pending) pending.invalidated = true;
      options.onResult?.(force ? 'refresh' : 'miss');
      pending = this.start(key, load, force, lifetimeMs, options.storeValue !== false, options.handoff !== false);
      this.inFlight.set(key, pending);
    } else options.onResult?.('joined');
    const subscribed = pending;
    return this.subscribe(pending, signal, options.onTransport).then(value => {
      const fetchedAt = subscribed.fetchedAt ?? this.now();
      options.onRead?.({ dataSource: 'network', fetchedAt, expiresAt: fetchedAt + lifetimeMs });
      return value;
    });
  }

  /** Preserve pending work while same-session navigation replaces its consumers. */
  beginHandoff(): { dispose(): void } {
    const handoff = {};
    this.handoffs.add(handoff);
    return { dispose: () => {
      if (!this.handoffs.delete(handoff) || this.handoffs.size) return;
      this.abortOrphans();
    } };
  }

  cancelHandoffs(): void {
    this.handoffs.clear();
    this.abortOrphans();
  }

  private abortOrphans(): void {
    for (const pending of this.orphaned) {
      if (!pending.subscribers && !pending.settled) {
        pending.invalidated = true;
        pending.controller.abort();
      }
    }
    this.orphaned.clear();
  }

  invalidate(key?: string): void {
    if (key !== undefined) this.deleteValue(key);
    else { this.values.clear(); this.cachedBytes = 0; }
    for (const [pendingKey, pending] of this.inFlight) {
      if (key === undefined || pendingKey === key) pending.invalidated = true;
    }
  }

  invalidateWhere(matches: (key: string) => boolean): number {
    let invalidated = 0;
    for (const key of this.values.keys()) {
      if (matches(key)) { this.deleteValue(key); invalidated++; }
    }
    for (const [key, pending] of this.inFlight) {
      if (matches(key)) { pending.invalidated = true; invalidated++; }
    }
    return invalidated;
  }

  clear(): void {
    this.cancelHandoffs();
    this.values.clear();
    this.cachedBytes = 0;
    for (const pending of this.inFlight.values()) pending.controller.abort();
    this.inFlight.clear();
  }

  private start<T>(key: string, load: (signal: AbortSignal) => Promise<T>, force: boolean, lifetimeMs: number, storeValue: boolean, handoff: boolean): PendingRead<T> {
    const pending: PendingRead<T> = {
      controller: new AbortController(), force, handoff, invalidated: false, settled: false, subscribers: 0, transportListeners: new Set(),
      promise: Promise.resolve(undefined as T)
    };
    pending.promise = Promise.resolve().then(() => withReadObservation(event => {
      pending.transport = event;
      for (const listener of pending.transportListeners) { try { listener(event); } catch { /* Presentation only. */ } }
    }, () => load(pending.controller.signal))).then((value) => {
      pending.fetchedAt = this.now();
      if (storeValue && !pending.controller.signal.aborted && !pending.invalidated && this.inFlight.get(key) === pending) {
        this.deleteValue(key);
        const bytes = estimateCacheBytes(value, this.maxBytes) + key.length * 2;
        // Oversized values still reach their subscribers, but cannot evict the entire
        // cache or turn a bounded entry count into unbounded retained memory.
        if (bytes <= this.maxBytes) {
          this.values.set(key, { value, bytes, fetchedAt: pending.fetchedAt, expiresAt: pending.fetchedAt + lifetimeMs });
          this.cachedBytes += bytes;
          while (this.values.size > this.capacity || this.cachedBytes > this.maxBytes) this.deleteValue(this.values.keys().next().value!);
        }
      }
      return value;
    }).finally(() => {
      pending.settled = true;
      this.orphaned.delete(pending);
      if (this.inFlight.get(key) === pending) this.inFlight.delete(key);
    });
    return pending;
  }

  private subscribe<T>(pending: PendingRead<T>, signal?: AbortSignal, onTransport?: (event: ReadObservation) => void): Promise<T> {
    this.orphaned.delete(pending);
    pending.subscribers++;
    const listener = onTransport ? (event: ReadObservation) => onTransport(event) : undefined;
    if (listener) {
      pending.transportListeners.add(listener);
      if (pending.transport) { try { listener(pending.transport); } catch { /* Presentation only. */ } }
    }
    return new Promise<T>((resolve, reject) => {
      let active = true;
      const finish = (cancelled: boolean): void => {
        if (!active) return;
        active = false;
        signal?.removeEventListener('abort', onAbort);
        pending.subscribers--;
        if (listener) pending.transportListeners.delete(listener);
        if (cancelled && pending.subscribers === 0 && !pending.settled) {
          if (this.handoffs.size && pending.handoff) this.orphaned.add(pending);
          else { pending.invalidated = true; pending.controller.abort(); }
        }
      };
      const onAbort = (): void => { finish(true); reject(abortedReadError()); };
      if (signal?.aborted) { onAbort(); return; }
      signal?.addEventListener('abort', onAbort, { once: true });
      pending.promise.then((value) => { finish(false); resolve(value); }, (error: unknown) => { finish(false); reject(error); });
    });
  }

  private expire(): void {
    const now = this.now();
    for (const [key, entry] of this.values) if (entry.expiresAt <= now) this.deleteValue(key);
  }

  private deleteValue(key: string): void {
    const entry = this.values.get(key);
    if (entry) { this.cachedBytes -= entry.bytes; this.values.delete(key); }
  }
}

/** Conservative retained-size estimate without materializing a second JSON copy. */
function estimateCacheBytes(value: unknown, limit: number): number {
  const seen = new WeakSet<object>();
  let bytes = 0;
  const visit = (item: unknown, depth: number): void => {
    if (bytes > limit) return;
    if (typeof item === 'string') { bytes += item.length * 2 + 16; return; }
    if (!item || typeof item !== 'object') { bytes += 8; return; }
    if (seen.has(item)) return;
    if (depth > 64) { bytes = Infinity; return; }
    seen.add(item); bytes += 64;
    if (ArrayBuffer.isView(item)) { bytes += item.byteLength; return; }
    for (const key in item) {
      if (bytes > limit) break;
      if (!Object.hasOwn(item, key)) continue;
      bytes += key.length * 2 + 8;
      visit((item as Record<string, unknown>)[key], depth + 1);
    }
  };
  try { visit(value, 0); } catch { return Infinity; }
  return bytes;
}
