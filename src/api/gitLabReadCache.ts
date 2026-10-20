interface CachedValue {
  expiresAt: number;
  value: unknown;
  bytes: number;
}

interface PendingRead<T> {
  controller: AbortController;
  force: boolean;
  invalidated: boolean;
  settled: boolean;
  subscribers: number;
  promise: Promise<T>;
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
    options: { force?: boolean; signal?: AbortSignal } = {}
  ): Promise<T> {
    const { force = false, signal } = options;
    if (signal?.aborted) return Promise.reject(abortedReadError());
    this.expire();

    if (!force) {
      const cached = this.values.get(key);
      if (cached) {
        this.values.delete(key);
        this.values.set(key, cached);
        return Promise.resolve(cached.value as T);
      }
    }

    let pending = this.inFlight.get(key) as PendingRead<T> | undefined;
    if (!pending || pending.invalidated || (force && !pending.force)) {
      if (pending) pending.invalidated = true;
      pending = this.start(key, load, force);
      this.inFlight.set(key, pending);
    }
    return this.subscribe(pending, signal);
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
    this.values.clear();
    this.cachedBytes = 0;
    for (const pending of this.inFlight.values()) pending.controller.abort();
    this.inFlight.clear();
  }

  private start<T>(key: string, load: (signal: AbortSignal) => Promise<T>, force: boolean): PendingRead<T> {
    const pending: PendingRead<T> = {
      controller: new AbortController(), force, invalidated: false, settled: false, subscribers: 0,
      promise: Promise.resolve(undefined as T)
    };
    pending.promise = Promise.resolve().then(() => load(pending.controller.signal)).then((value) => {
      if (!pending.controller.signal.aborted && !pending.invalidated && this.inFlight.get(key) === pending) {
        this.deleteValue(key);
        const bytes = estimateCacheBytes(value, this.maxBytes) + key.length * 2;
        // Oversized values still reach their subscribers, but cannot evict the entire
        // cache or turn a bounded entry count into unbounded retained memory.
        if (bytes <= this.maxBytes) {
          this.values.set(key, { value, bytes, expiresAt: this.now() + this.lifetimeMs });
          this.cachedBytes += bytes;
          while (this.values.size > this.capacity || this.cachedBytes > this.maxBytes) this.deleteValue(this.values.keys().next().value!);
        }
      }
      return value;
    }).finally(() => {
      pending.settled = true;
      if (this.inFlight.get(key) === pending) this.inFlight.delete(key);
    });
    return pending;
  }

  private subscribe<T>(pending: PendingRead<T>, signal?: AbortSignal): Promise<T> {
    pending.subscribers++;
    return new Promise<T>((resolve, reject) => {
      let active = true;
      const finish = (cancelled: boolean): void => {
        if (!active) return;
        active = false;
        signal?.removeEventListener('abort', onAbort);
        pending.subscribers--;
        if (cancelled && pending.subscribers === 0 && !pending.settled) {
          pending.invalidated = true;
          pending.controller.abort();
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
