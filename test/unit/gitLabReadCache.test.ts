import assert from 'node:assert/strict';
import test from 'node:test';
import { abortedReadError, GitLabReadCache } from '../../src/api/gitLabReadCache';

test('expires cached values, refreshes failures, and keeps the least-recently-used entries within capacity', async () => {
  let now = 1_000;
  let loads = 0;
  const cache = new GitLabReadCache(60, 2, () => now);
  const read = (key: string, options: { force?: boolean } = {}) => cache.get(key, async () => `${key}:${++loads}`, options);

  assert.equal(await read('a'), 'a:1');
  assert.equal(await read('b'), 'b:2');
  assert.equal(await read('a'), 'a:1');
  assert.equal(await read('c'), 'c:3');
  assert.equal(await read('b'), 'b:4', 'the least-recently-used entry is evicted');
  assert.equal(await read('a', { force: true }), 'a:5', 'manual refresh bypasses a live cache entry');
  now += 60;
  assert.equal(await read('a'), 'a:6', 'expired values are fetched again');

  await assert.rejects(cache.get('failed', async () => { throw new Error('offline'); }), /offline/);
  assert.equal(await cache.get('failed', async () => `recovered:${++loads}`), 'recovered:7');
});

test('coalesces shared reads and cancels the underlying request only after its final subscriber leaves', async () => {
  const cache = new GitLabReadCache();
  let calls = 0;
  let aborts = 0;
  let resolveRead!: (value: string) => void;
  const loader = (signal: AbortSignal): Promise<string> => {
    calls++;
    return new Promise((resolve, reject) => {
      resolveRead = resolve;
      signal.addEventListener('abort', () => { aborts++; reject(abortedReadError()); }, { once: true });
    });
  };
  const firstController = new AbortController();
  const secondController = new AbortController();
  const first = cache.get('shared', loader, { signal: firstController.signal });
  const second = cache.get('shared', loader, { signal: secondController.signal });
  await new Promise<void>((resolve) => setImmediate(resolve));
  firstController.abort();
  await assert.rejects(first, { name: 'AbortError' });
  assert.equal(aborts, 0);
  resolveRead('complete');
  assert.equal(await second, 'complete');
  assert.equal(await cache.get('shared', loader), 'complete');
  assert.equal(calls, 1);
  assert.equal(aborts, 0);

  const lastController = new AbortController();
  const unused = cache.get('unused', (signal) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => { aborts++; reject(abortedReadError()); }, { once: true });
  }), { signal: lastController.signal });
  await new Promise<void>((resolve) => setImmediate(resolve));
  lastController.abort();
  await assert.rejects(unused, { name: 'AbortError' });
  assert.equal(aborts, 1);
});

test('successful writes invalidate cached reads without interrupting existing subscribers', async () => {
  const cache = new GitLabReadCache();
  let loads = 0;
  let finish!: (value: string) => void;
  const pending = cache.get('list', () => new Promise<string>((resolve) => { finish = resolve; }));
  await new Promise<void>((resolve) => setImmediate(resolve));
  cache.invalidate();
  finish('before-write');
  assert.equal(await pending, 'before-write');
  assert.equal(await cache.get('list', async () => `after-write:${++loads}`), 'after-write:1');
});
