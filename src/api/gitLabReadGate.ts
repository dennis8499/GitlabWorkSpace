interface Waiter {
  signal: AbortSignal;
  resolve: () => void;
  reject: (error: Error) => void;
  onAbort: () => void;
}

/** Bounds read traffic for one connected GitLab session, including reads made by scoped clients. */
export class GitLabReadGate {
  private active = 0;
  private readonly queue: Waiter[] = [];

  constructor(private readonly concurrency = 6, private readonly timeoutMs = 30_000) {
    if (!Number.isSafeInteger(concurrency) || concurrency < 1) throw new RangeError('Concurrency must be positive.');
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw new RangeError('Timeout must be positive.');
  }

  async run<T>(inputSignals: AbortSignal | readonly (AbortSignal | undefined)[] | undefined, operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const controller = new AbortController();
    const signals = (Array.isArray(inputSignals) ? inputSignals : [inputSignals]).filter((signal): signal is AbortSignal => !!signal);
    const listeners: Array<{ signal: AbortSignal; listener: () => void }> = [];
    for (const signal of signals) {
      const listener = (): void => controller.abort(signal.reason ?? aborted());
      if (signal.aborted) listener();
      else {
        listeners.push({ signal, listener });
        signal.addEventListener('abort', listener, { once: true });
      }
    }
    const timeout = setTimeout(() => controller.abort(timeoutError()), this.timeoutMs);
    let acquired = false;
    try {
      await this.acquire(controller.signal);
      acquired = true;
      if (controller.signal.aborted) throw controller.signal.reason ?? aborted();
      return await operation(controller.signal);
    } catch (error) {
      if (controller.signal.aborted && controller.signal.reason instanceof Error) throw controller.signal.reason;
      throw error;
    } finally {
      clearTimeout(timeout);
      for (const { signal, listener } of listeners) signal.removeEventListener('abort', listener);
      if (acquired) this.release();
    }
  }

  private acquire(signal: AbortSignal): Promise<void> {
    if (signal.aborted) return Promise.reject(signal.reason ?? aborted());
    if (this.active < this.concurrency) {
      this.active++;
      return Promise.resolve();
    }
    return new Promise<void>((resolve, reject) => {
      const waiter: Waiter = {
        signal, resolve, reject,
        onAbort: () => {
          const index = this.queue.indexOf(waiter);
          if (index >= 0) this.queue.splice(index, 1);
          signal.removeEventListener('abort', waiter.onAbort);
          reject(signal.reason instanceof Error ? signal.reason : aborted());
        }
      };
      this.queue.push(waiter);
      signal.addEventListener('abort', waiter.onAbort, { once: true });
    });
  }

  private release(): void {
    while (this.queue.length) {
      const waiter = this.queue.shift()!;
      waiter.signal.removeEventListener('abort', waiter.onAbort);
      if (waiter.signal.aborted) {
        waiter.reject(waiter.signal.reason instanceof Error ? waiter.signal.reason : aborted());
        continue;
      }
      waiter.resolve();
      return;
    }
    this.active--;
  }
}

function aborted(): Error {
  const error = new Error('The GitLab read is no longer needed.');
  error.name = 'AbortError';
  return error;
}

function timeoutError(): Error {
  const error = new Error('GitLab read timed out after 30 seconds.');
  error.name = 'TimeoutError';
  return error;
}
