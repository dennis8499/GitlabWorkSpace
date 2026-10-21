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

test('starts a fresh read when the final subscriber cancels and ignores the old response', async () => {
  const cache = new GitLabReadCache();
  let calls = 0;
  let finishStale!: (value: string) => void;
  const loader = (signal: AbortSignal): Promise<string> => {
    calls++;
    if (calls === 1) {
      // Model a transport that completes after its consumer has already cancelled.
      return new Promise((resolve) => { finishStale = resolve; });
    }
    return Promise.resolve('fresh-data');
  };
  const controller = new AbortController();
  const cancelled = cache.get('issue-list', loader, { signal: controller.signal });
  await new Promise<void>((resolve) => setImmediate(resolve));

  controller.abort();
  await assert.rejects(cancelled, { name: 'AbortError' });

  assert.equal(await cache.get('issue-list', loader), 'fresh-data');
  finishStale('stale-data');
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.equal(await cache.get('issue-list', loader), 'fresh-data');
  assert.equal(calls, 2, 'the stale response neither overwrites the new value nor starts another read');
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

test('retained bytes evict LRU values and oversized responses remain uncached without discarding useful entries', async () => {
  const cache = new GitLabReadCache(60_000, 256, Date.now, 500);
  const loads = new Map<string, number>();
  const read = (key: string, length = 100) => cache.get(key, async () => { loads.set(key, (loads.get(key) ?? 0) + 1); return 'x'.repeat(length); });
  await read('a'); await read('b'); await read('c');
  await read('b'); assert.equal(loads.get('b'), 1);
  await read('large', 1000); await read('large', 1000);
  assert.equal(loads.get('large'), 2, 'an oversized read reaches subscribers but is not retained');
  await read('b'); assert.equal(loads.get('b'), 1, 'oversized reads do not flush unrelated cached data');
  await read('a'); assert.equal(loads.get('a'), 2, 'byte capacity evicted the oldest entry before entry capacity');
  cache.invalidateWhere(key => key === 'b'); await read('b'); assert.equal(loads.get('b'), 2);
});

test('resource lifetimes expire independently and derived assemblies retain no duplicate collection', async () => {
  let now = 0, dynamic = 0, inventory = 0, assemblies = 0;
  const cache = new GitLabReadCache(60_000, 256, () => now);
  const readDynamic = () => cache.get('issues', async () => ++dynamic);
  const readInventory = () => cache.get('projects', async () => ++inventory, { lifetimeMs: 300_000 });
  await readDynamic(); await readInventory();
  now = 60_000;
  assert.equal(await readDynamic(), 2);
  assert.equal(await readInventory(), 1);
  now = 300_000;
  assert.equal(await readInventory(), 2);
  const assemble = () => cache.get('collection', async () => { assemblies++; return readInventory(); }, { storeValue: false });
  await assemble(); await assemble();
  assert.equal(assemblies, 2);
  assert.equal(inventory, 2, 'derived assemblies reuse retained pages');
});

test('navigation handoff joins a cancelled consumer and hide cancels unreplaced work immediately', async () => {
  const cache = new GitLabReadCache();
  let requests = 0, aborts = 0;
  let finish!: (value: string) => void;
  const load = (signal: AbortSignal): Promise<string> => {
    requests++;
    return new Promise((resolve, reject) => {
      finish = resolve;
      signal.addEventListener('abort', () => { aborts++; reject(abortedReadError()); }, { once: true });
    });
  };
  const firstSignal = new AbortController();
  const first = cache.get('projects', load, { signal: firstSignal.signal });
  await new Promise<void>(resolve => setImmediate(resolve));
  const handoff = cache.beginHandoff();
  firstSignal.abort();
  await assert.rejects(first, { name: 'AbortError' });
  const outcomes: string[] = [];
  const replacement = cache.get('projects', load, { onResult: result => outcomes.push(result) });
  handoff.dispose();
  assert.equal(aborts, 0);
  finish('complete');
  assert.equal(await replacement, 'complete');
  assert.equal(requests, 1);
  assert.deepEqual(outcomes, ['joined']);

  const hiddenSignal = new AbortController();
  const unused = cache.get('other', load, { signal: hiddenSignal.signal });
  await new Promise<void>(resolve => setImmediate(resolve));
  const abandoned = cache.beginHandoff();
  hiddenSignal.abort();
  await assert.rejects(unused, { name: 'AbortError' });
  assert.equal(aborts, 0);
  cache.cancelHandoffs();
  assert.equal(aborts, 1, 'hide does not wait for the navigation finally block');
  abandoned.dispose();
});

test('forced reads supersede older work and late old completion cannot replace refreshed data', async () => {
  const cache = new GitLabReadCache();
  const outcomes: string[] = [];
  let finish!: (value: string) => void, requests = 0;
  const first = cache.get('shared', async () => { requests++; return new Promise<string>(resolve => { finish = resolve; }); });
  await new Promise<void>(resolve => setImmediate(resolve));
  const refreshed = cache.get('shared', async () => { requests++; return 'new'; }, { force: true, onResult: result => outcomes.push(result) });
  assert.equal(await refreshed, 'new');
  finish('old');
  assert.equal(await first, 'old');
  assert.equal(await cache.get('shared', async () => 'unexpected', { onResult: result => outcomes.push(result) }), 'new');
  assert.equal(requests, 2);
  assert.deepEqual(outcomes, ['refresh', 'hit']);
});
