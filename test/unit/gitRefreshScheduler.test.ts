import assert from 'node:assert/strict';
import test from 'node:test';
import { GitRefreshScheduler, type RefreshClock } from '../../src/git/gitRefreshScheduler';

class Clock implements RefreshClock {
  time = 0;
  private next = 0;
  readonly timers = new Map<number, { due: number; callback: () => void }>();
  now(): number { return this.time; }
  set(callback: () => void, delay: number): number { const id = ++this.next; this.timers.set(id, { due: this.time + delay, callback }); return id; }
  clear(timer: unknown): void { this.timers.delete(timer as number); }
  async advance(ms: number): Promise<void> {
    const target = this.time + ms;
    for (let safety = 0; safety < 1000; safety++) {
      const next = [...this.timers].sort((a, b) => a[1].due - b[1].due).find((item) => item[1].due <= target);
      if (!next) { this.time = target; return; }
      this.time = next[1].due; this.timers.delete(next[0]); next[1].callback();
      for (let tick = 0; tick < 30; tick++) await Promise.resolve();
    }
    throw new Error('Refresh timer did not settle.');
  }
}

test('coalesces event bursts and reaches a maximum wait of one second', async () => {
  const clock = new Clock(); let reads = 0;
  const scheduler = new GitRefreshScheduler(async () => { reads++; }, clock);
  for (let i = 0; i < 100; i++) scheduler.notify('repo');
  await clock.advance(249); assert.equal(reads, 0);
  await clock.advance(1); assert.equal(reads, 1);
  for (let i = 0; i < 10; i++) { scheduler.notify('repo'); await clock.advance(100); }
  assert.equal(reads, 2);
  await clock.advance(60_000); assert.equal(reads, 2); assert.equal(clock.timers.size, 0);
});

test('keeps one running refresh and one trailing refresh, without retrying errors', async () => {
  const clock = new Clock(); let reads = 0; let release!: () => void;
  const scheduler = new GitRefreshScheduler(async () => { reads++; if (reads === 1) await new Promise<void>((resolve) => { release = resolve; }); else throw new Error('Repo unavailable'); }, clock);
  scheduler.notify('repo'); await clock.advance(250);
  for (let i = 0; i < 100; i++) scheduler.notify('repo');
  await clock.advance(5000); assert.equal(reads, 1);
  release(); for (let i = 0; i < 30; i++) await Promise.resolve();
  await clock.advance(250); assert.equal(reads, 2);
  await clock.advance(60_000); assert.equal(reads, 2); assert.equal(clock.timers.size, 0);
});

test('cancels queued and trailing work on hide, switch or disposal', async () => {
  const clock = new Clock(); let reads = 0;
  const scheduler = new GitRefreshScheduler(async () => { reads++; }, clock);
  scheduler.notify('a'); scheduler.notify('b'); scheduler.cancel('a');
  await clock.advance(250); assert.equal(reads, 1);
  scheduler.notify('b'); scheduler.dispose(); scheduler.notify('c');
  await clock.advance(60_000); assert.equal(reads, 1); assert.equal(clock.timers.size, 0);
});
