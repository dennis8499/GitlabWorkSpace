interface CachedValue {
  expiresAt: number;
  value: unknown;
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

  constructor(
    private readonly lifetimeMs = 60_000,
    private readonly capacity = 256,
    private readonly now: () => number = Date.now
  ) {
    if (!Number.isSafeInteger(lifetimeMs) || lifetimeMs <= 0) throw new RangeError('Cache lifetime must be positive.');
    if (!Number.isSafeInteger(capacity) || capacity <= 0) throw new RangeError('Cache capacity must be positive.');
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
    if (key !== undefined) this.values.delete(key);
    else this.values.clear();
    for (const [pendingKey, pending] of this.inFlight) {
      if (key === undefined || pendingKey === key) pending.invalidated = true;
    }
  }

  clear(): void {
    this.values.clear();
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
        this.values.delete(key);
        this.values.set(key, { value, expiresAt: this.now() + this.lifetimeMs });
        while (this.values.size > this.capacity) this.values.delete(this.values.keys().next().value!);
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
        if (cancelled && pending.subscribers === 0 && !pending.settled) pending.controller.abort();
      };
      const onAbort = (): void => { finish(true); reject(abortedReadError()); };
      if (signal?.aborted) { onAbort(); return; }
      signal?.addEventListener('abort', onAbort, { once: true });
      pending.promise.then((value) => { finish(false); resolve(value); }, (error: unknown) => { finish(false); reject(error); });
    });
  }

  private expire(): void {
    const now = this.now();
    for (const [key, entry] of this.values) if (entry.expiresAt <= now) this.values.delete(key);
  }
}
