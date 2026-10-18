export interface RefreshClock {
  now(): number;
  set(callback: () => void, delay: number): unknown;
  clear(timer: unknown): void;
}

const systemClock: RefreshClock = {
  now: () => Date.now(),
  set: (callback, delay) => setTimeout(callback, delay),
  clear: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>)
};

interface PendingRefresh { first: number; dirty: boolean; running: boolean; queued?: boolean; timer?: unknown; }

/** One running refresh and one trailing update per Repo, without polling or retries. */
export class GitRefreshScheduler {
  private readonly pending = new Map<string, PendingRefresh>();
  private disposed = false;
  private active = 0;
  private readonly ready = new Map<string, PendingRefresh>();

  constructor(private readonly refresh: (id: string) => Promise<void>, private readonly clock: RefreshClock = systemClock,
    private readonly options: { concurrency?: number; priorityId?: () => string | undefined } = {}) {
    if (options.concurrency !== undefined && (!Number.isSafeInteger(options.concurrency) || options.concurrency < 1)) throw new RangeError('Refresh concurrency must be positive.');
  }

  notify(id: string): void {
    if (this.disposed) return;
    let state = this.pending.get(id);
    if (!state) {
      state = { first: this.clock.now(), dirty: true, running: false };
      this.pending.set(id, state);
    } else if (!state.dirty) state.first = this.clock.now();
    state.dirty = true;
    if (!state.running && !state.queued) this.schedule(id, state);
  }

  cancel(id?: string): void {
    for (const [key, state] of this.pending) {
      if (id && key !== id) continue;
      if (state.timer !== undefined) this.clock.clear(state.timer);
      this.ready.delete(key);
      this.pending.delete(key);
    }
  }

  dispose(): void { this.disposed = true; this.cancel(); }

  private schedule(id: string, state: PendingRefresh): void {
    if (state.timer !== undefined) this.clock.clear(state.timer);
    const delay = Math.max(0, Math.min(250, 1000 - (this.clock.now() - state.first)));
    state.timer = this.clock.set(() => { void this.run(id, state); }, delay);
  }

  private async run(id: string, state: PendingRefresh): Promise<void> {
    if (this.disposed || this.pending.get(id) !== state) return;
    state.timer = undefined;
    if (this.active >= (this.options.concurrency ?? Infinity)) {
      state.queued = true; this.ready.set(id, state); return;
    }
    state.queued = false; this.ready.delete(id); this.active++;
    state.running = true;
    state.dirty = false;
    try { await this.refresh(id); } catch { /* A failed read waits for a new event or explicit refresh. */ }
    finally {
      state.running = false;
      this.active--;
      if (!this.disposed && this.pending.get(id) === state) {
        if (state.dirty) this.schedule(id, state);
        else this.pending.delete(id);
      }
      this.drain();
    }
  }

  private drain(): void {
    while (!this.disposed && this.ready.size && this.active < (this.options.concurrency ?? Infinity)) {
      const priority = this.options.priorityId?.();
      const prioritized = priority && this.ready.get(priority);
      const entry: [string, PendingRefresh] = priority && prioritized ? [priority, prioritized] : this.ready.entries().next().value!;
      this.ready.delete(entry[0]); void this.run(...entry);
    }
  }
}
