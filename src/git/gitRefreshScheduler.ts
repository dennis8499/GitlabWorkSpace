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

interface PendingRefresh { first: number; dirty: boolean; running: boolean; timer?: unknown; }

/** One running refresh and one trailing update per Repo, without polling or retries. */
export class GitRefreshScheduler {
  private readonly pending = new Map<string, PendingRefresh>();
  private disposed = false;

  constructor(private readonly refresh: (id: string) => Promise<void>, private readonly clock: RefreshClock = systemClock) {}

  notify(id: string): void {
    if (this.disposed) return;
    let state = this.pending.get(id);
    if (!state) {
      state = { first: this.clock.now(), dirty: true, running: false };
      this.pending.set(id, state);
    } else if (!state.dirty) state.first = this.clock.now();
    state.dirty = true;
    if (!state.running) this.schedule(id, state);
  }

  cancel(id?: string): void {
    for (const [key, state] of this.pending) {
      if (id && key !== id) continue;
      if (state.timer !== undefined) this.clock.clear(state.timer);
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
    state.running = true;
    state.dirty = false;
    try { await this.refresh(id); } catch { /* A failed read waits for a new event or explicit refresh. */ }
    finally {
      state.running = false;
      if (this.disposed || this.pending.get(id) !== state) return;
      if (state.dirty) this.schedule(id, state);
      else this.pending.delete(id);
    }
  }
}
