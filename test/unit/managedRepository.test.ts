import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { access, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import * as networkLease from '../../src/api/localNetworkLease';
import type { GitLabProject } from '../../src/api/types';
import { windowsExecutionLeases, withWindowsExecutionLeases } from '../../src/api/windowsLocalLease';
import { ensureManagedRepositoryCache } from '../../src/codex/managedRepository';
import * as gitProcess from '../../src/git/gitProcess';
import * as storageControl from '../../src/storage/controlLease';

const git = (root: string, ...args: string[]) => execFileSync('git',
  ['-C', root, '-c', 'core.hooksPath=', '-c', 'user.name=Cache Test', '-c', 'user.email=cache@test.invalid', '-c', 'commit.gpgsign=false', ...args],
  { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }).trim();

async function fixture(t: test.TestContext, longPaths = false) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'codex-review-cache-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const local = path.join(directory, 'source');
  const storageName = longPaths ? 'storage-' + 's'.repeat(Math.max(0, 120 - path.join(directory, 'storage-').length)) : 'storage';
  const storage = path.join(directory, storageName);
  await mkdir(local); await mkdir(storage);
  git(local, 'init', '-q', '--initial-branch=main');
  await writeFile(path.join(local, 'source.txt'), 'initial\n');
  git(local, 'add', '.'); git(local, 'commit', '-qm', 'initial');
  git(local, 'remote', 'add', 'origin', 'https://gitlab.test/team/repository.git');
  const sha = git(local, 'rev-parse', 'HEAD');
  const project = { id: 1, path_with_namespace: 'team/repository', http_url_to_repo: 'https://gitlab.test/team/repository.git' } as GitLabProject;
  const options = { storage, accountKey: 'account', baseUrl: 'https://gitlab.test', project, sourceSha: sha, localRepository: local };
  return { local, options, sha };
}

test('review cache retains an independent fixed source and leaves a dirty source Repo untouched', async t => {
  const f = await fixture(t), before = git(f.local, 'show-ref');
  await writeFile(path.join(f.local, 'source.txt'), 'uncommitted\n');
  const cache = await ensureManagedRepositoryCache(f.options);
  assert.equal((await ensureManagedRepositoryCache(f.options)).root, cache.root);
  assert.equal(git(f.local, 'show-ref'), before);
  assert.equal(await readFile(path.join(f.local, 'source.txt'), 'utf8'), 'uncommitted\n');
  assert.equal(git(cache.root, 'show', `${f.sha}:source.txt`), 'initial');
  assert.equal(git(cache.root, 'show-ref', '--verify', '--hash', `refs/gitlab-workspace/cache/${f.sha}`), f.sha);
  await assert.rejects(access(path.join(cache.root, 'source.txt')), { code: 'ENOENT' });
  await assert.rejects(access(path.join(cache.root, '.git', 'objects', 'info', 'alternates')), { code: 'ENOENT' });
  for (const root of [f.local, cache.root]) {
    const object = path.join(root, '.git', 'objects', f.sha.slice(0, 2), f.sha.slice(2));
    assert.equal((await stat(object)).nlink, 1, 'the cache must not borrow the source object');
  }
});

test('review caches separate accounts and reject a changed remote before reuse', async t => {
  const f = await fixture(t), first = await ensureManagedRepositoryCache(f.options);
  const other = await ensureManagedRepositoryCache({ ...f.options, accountKey: 'other-account' });
  assert.notEqual(other.root, first.root);
  git(first.root, 'remote', 'set-url', 'origin', 'https://gitlab.test/other/project.git');
  await assert.rejects(ensureManagedRepositoryCache(f.options), /remote/);
  assert.equal(git(other.root, 'remote', 'get-url', 'origin'), f.options.project.http_url_to_repo);
});

test('a failed first cache preparation is shared and a corrected request can retry', async t => {
  const f = await fixture(t);
  git(f.local, 'remote', 'set-url', 'origin', 'https://gitlab.test/other/project.git');
  const rejected = await Promise.allSettled([ensureManagedRepositoryCache(f.options), ensureManagedRepositoryCache(f.options)]);
  for (const result of rejected) {
    assert.equal(result.status, 'rejected');
    assert.match(String(result.reason), /不符合所選專案/);
  }
  git(f.local, 'remote', 'set-url', 'origin', f.options.project.http_url_to_repo!);
  const cache = await ensureManagedRepositoryCache(f.options);
  assert.equal(git(cache.root, 'show-ref', '--verify', '--hash', `refs/gitlab-workspace/cache/${f.sha}`), f.sha);
});

function latch() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

async function queuedCache(t: test.TestContext, waits: {
  control?: (signal: AbortSignal | undefined) => Promise<void>;
  network?: (signal: AbortSignal | undefined) => Promise<void>;
  localWrite?: (command: 'config' | 'update-ref', signal: AbortSignal | undefined) => Promise<void>;
} = {}) {
  const storage = await mkdtemp(path.join(os.tmpdir(), 'codex-review-queue-'));
  t.after(() => rm(storage, { recursive: true, force: true }));
  const first = 'a'.repeat(40), second = 'b'.repeat(40), third = 'c'.repeat(40);
  const fetchStarted = latch(), finishFetch = latch();
  const fetches: { sha: string; callers: string[] }[] = [];
  const fetchSignals: (AbortSignal | undefined)[] = [];
  const releases: number[] = [];
  let gitCalls = 0, controls = 0;
  const refs: string[] = [];
  const available = new Set<string>();
  const project = { id: 1, path_with_namespace: 'team/repository', http_url_to_repo: 'https://gitlab.test/team/repository.git' } as GitLabProject;
  const result = (code: number, stdout = '') => ({ code, stdout, stderr: '', truncated: false });
  const captureWithDelayedFetch: typeof gitProcess.captureGitProcess = async (_exe, args, opts) => {
    assert.ok(opts?.cwd);
    gitCalls++;
    const sha = args.at(-1) ?? '';
    if (args.includes('fetch')) {
      await waits.network?.(opts.signal);
      opts.signal?.throwIfAborted();
      fetches.push({ sha, callers: windowsExecutionLeases().map(lease => lease.nonce) });
      fetchSignals.push(opts.signal);
      if (sha === first) { fetchStarted.resolve(); await finishFetch.promise; }
      opts.signal?.throwIfAborted();
      available.add(sha);
      return result(0);
    }
    if (args.includes('--verify') && sha.endsWith('^{commit}')) {
      const commit = sha.slice(0, -9);
      return available.has(commit) ? result(0, commit) : result(1);
    }
    if (args.includes('update-ref')) {
      await waits.localWrite?.('update-ref', opts.signal);
      opts.signal?.throwIfAborted();
      refs.push(sha);
      return result(0);
    }
    if (args.includes('config')) {
      await waits.localWrite?.('config', opts.signal);
      opts.signal?.throwIfAborted();
      return result(0);
    }
    if (args.includes('init')) { await mkdir(path.join(sha, '.git'), { recursive: true }); return result(0); }
    if (args.includes('--show-toplevel')) return result(0, opts.cwd);
    if (args.includes('--git-common-dir')) return result(0, path.join(opts.cwd, '.git'));
    if (args.includes('get-url')) return result(0, project.http_url_to_repo);
    assert.ok(args.includes('remote'), `unexpected Git command ${args.join(' ')}`);
    return result(0);
  };
  t.mock.method(storageControl, 'acquireStorageControl', async (_directory: string, _kind: string,
    options?: Parameters<typeof storageControl.acquireStorageControl>[2]) => {
    const claim = ++controls;
    await waits.control?.(options?.signal);
    return { release: async () => { releases.push(claim); } };
  });
  t.mock.method(gitProcess, 'captureGitProcess', captureWithDelayedFetch);
  const prepare = (sha: string, caller: string, beforeAccess?: () => Promise<void>, signal?: AbortSignal, assertCurrent?: () => void) =>
    withWindowsExecutionLeases([{ nonce: caller, kind: 'codex', directory: path.join(storage, caller + '.lock'), pid: process.pid,
      birth: 'fixture', directoryId: caller }], () => ensureManagedRepositoryCache({
      storage, accountKey: 'account', baseUrl: 'https://gitlab.test', project, sourceSha: sha, signal, beforeAccess, assertCurrent
    }));
  const queue = async (sha: string, caller: string, signal?: AbortSignal, assertCurrent?: () => void) => {
    const admitted = latch();
    const task = prepare(sha, caller, async () => { admitted.resolve(); }, signal, assertCurrent);
    await Promise.race([admitted.promise, task.then(() => assert.fail('the Git preparation started before joining the queue'))]);
    await new Promise<void>(resolve => setImmediate(resolve));
    return { task };
  };
  return { storage, first, second, third, fetchStarted, finishFetch, fetches, fetchSignals, releases, refs, prepare, queue,
    get gitCalls() { return gitCalls; } };
}

test('queued cache cancellation settles before the active fetch and preserves FIFO retries', { timeout: 20_000 }, async t => {
  const f = await queuedCache(t);
  const active = f.prepare(f.first, 'active');
  const tasks: Promise<unknown>[] = [active];
  const cancelled = new AbortController();
  try {
    await Promise.race([f.fetchStarted.promise, active.then(() => assert.fail('the first fetch did not wait'))]);
    const abandoned = await f.queue(f.second, 'abandoned', cancelled.signal);
    tasks.push(abandoned.task);
    const later = await f.queue(f.third, 'later');
    tasks.push(later.task);
    cancelled.abort();
    await assert.rejects(abandoned.task, { name: 'AbortError' });
    assert.deepEqual(f.fetches, [{ sha: f.first, callers: ['active'] }]);
    assert.deepEqual(f.refs, []);

    const retry = await f.queue(f.second, 'retry');
    tasks.push(retry.task);
    f.finishFetch.resolve();
    await Promise.all([active, later.task, retry.task]);
    assert.deepEqual(f.fetches, [{ sha: f.first, callers: ['active'] }, { sha: f.third, callers: ['later'] }, { sha: f.second, callers: ['retry'] }]);
    assert.deepEqual(f.refs, [f.first, f.third, f.second]);
  } finally {
    f.finishFetch.resolve();
    await Promise.allSettled(tasks);
  }
});

test('queued callers share one fetch under the surviving caller context', { timeout: 20_000 }, async t => {
  const f = await queuedCache(t);
  const active = f.prepare(f.first, 'active');
  const tasks: Promise<unknown>[] = [active];
  const cancelled = new AbortController();
  try {
    await Promise.race([f.fetchStarted.promise, active.then(() => assert.fail('the first fetch did not wait'))]);
    const creator = await f.queue(f.second, 'cancelled creator', cancelled.signal);
    tasks.push(creator.task);
    let current = true;
    const staleError = new Error('project changed while queued');
    const stale = await f.queue(f.second, 'stale caller', undefined, () => { if (!current) throw staleError; });
    tasks.push(stale.task);
    const survivor = await f.queue(f.second, 'surviving caller');
    tasks.push(survivor.task);
    cancelled.abort();
    await assert.rejects(creator.task, { name: 'AbortError' });
    current = false;
    const rejected = assert.rejects(stale.task, error => error === staleError);
    f.finishFetch.resolve();
    const [before, after] = await Promise.all([active, survivor.task]);
    await rejected;
    assert.equal(before.root, after.root);
    assert.deepEqual(f.fetches, [{ sha: f.first, callers: ['active'] }, { sha: f.second, callers: ['surviving caller'] }]);
    assert.deepEqual(f.refs, [f.first, f.second]);
  } finally {
    f.finishFetch.resolve();
    await Promise.allSettled(tasks);
  }
});

test('cancelling the last cache caller while waiting for control starts no Git process', { timeout: 10_000 }, async t => {
  const waiting = latch(), unlock = latch();
  let shared: AbortSignal | undefined;
  const f = await queuedCache(t, { control: async signal => { shared = signal; waiting.resolve(); await unlock.promise; } });
  const caller = new AbortController();
  const operation = f.prepare(f.first, 'caller', undefined, caller.signal);
  const cancelled = assert.rejects(operation, { name: 'AbortError' });
  try {
    await waiting.promise;
    caller.abort();
    assert.equal(shared?.aborted, true);
    unlock.resolve();
    await cancelled;
    assert.equal(f.gitCalls, 0);
    assert.deepEqual(f.releases, [1]);
  } finally {
    unlock.resolve();
    f.finishFetch.resolve();
    await Promise.allSettled([operation, cancelled]);
  }
});

test('cancelling the last cache caller during Git network admission starts no fetch', { timeout: 10_000 }, async t => {
  const waiting = latch(), unlock = latch();
  let shared: AbortSignal | undefined;
  const f = await queuedCache(t, { network: async signal => { shared = signal; waiting.resolve(); await unlock.promise; } });
  const caller = new AbortController();
  const operation = f.prepare(f.first, 'caller', undefined, caller.signal);
  const cancelled = assert.rejects(operation, { name: 'AbortError' });
  try {
    await waiting.promise;
    caller.abort();
    assert.equal(shared?.aborted, true);
    unlock.resolve();
    await cancelled;
    assert.deepEqual(f.fetches, []);
    assert.deepEqual(f.refs, []);
    assert.deepEqual(f.releases, [1]);
  } finally {
    unlock.resolve();
    f.finishFetch.resolve();
    await Promise.allSettled([operation, cancelled]);
  }
});

test('cancelling a running cache owner keeps its leases and the surviving fetch', { timeout: 10_000 }, async t => {
  const f = await queuedCache(t);
  const owner = new AbortController();
  let ownerSettled = false;
  const active = f.prepare(f.first, 'owner', undefined, owner.signal).finally(() => { ownerSettled = true; });
  const cancelled = assert.rejects(active, { name: 'AbortError' });
  let survivor: Promise<unknown> | undefined;
  try {
    await f.fetchStarted.promise;
    ({ task: survivor } = await f.queue(f.first, 'survivor'));
    owner.abort();
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(ownerSettled, false);
    assert.equal(f.fetchSignals[0]?.aborted, false);
    assert.deepEqual(f.releases, []);
    f.finishFetch.resolve();
    await Promise.all([cancelled, survivor]);
    assert.deepEqual(f.fetches, [{ sha: f.first, callers: ['owner'] }]);
    assert.deepEqual(f.refs, [f.first]);
    assert.deepEqual(f.releases, [1]);
  } finally {
    f.finishFetch.resolve();
    await Promise.allSettled([active, cancelled, survivor]);
  }
});

test('cancelling the last running cache caller fences its retry until the supervisor settles', { timeout: 10_000 }, async t => {
  const f = await queuedCache(t);
  const caller = new AbortController();
  let activeSettled = false;
  const active = f.prepare(f.first, 'cancelled', undefined, caller.signal).finally(() => { activeSettled = true; });
  const cancelled = assert.rejects(active, { name: 'AbortError' });
  let retry: Promise<unknown> | undefined;
  try {
    await f.fetchStarted.promise;
    caller.abort();
    ({ task: retry } = await f.queue(f.first, 'retry'));
    assert.equal(f.fetchSignals[0]?.aborted, true);
    assert.equal(activeSettled, false);
    assert.deepEqual(f.releases, []);
    assert.deepEqual(f.fetches, [{ sha: f.first, callers: ['cancelled'] }]);
    f.finishFetch.resolve();
    await Promise.all([cancelled, retry]);
    assert.deepEqual(f.fetches, [{ sha: f.first, callers: ['cancelled'] }, { sha: f.first, callers: ['retry'] }]);
    assert.deepEqual(f.refs, [f.first]);
    assert.deepEqual(f.releases, [1, 2]);
  } finally {
    f.finishFetch.resolve();
    await Promise.allSettled([active, cancelled, retry]);
  }
});

for (const command of ['config', 'update-ref'] as const) test(`cancelling during cache ${command} keeps the local write and queues a retry`,
  { skip: command === 'config' && process.platform !== 'win32', timeout: 10_000 }, async t => {
    const writing = latch(), finishWrite = latch();
    const writes: (AbortSignal | undefined)[] = [];
    const f = await queuedCache(t, { localWrite: async (name, signal) => {
      if (name !== command) return;
      writes.push(signal);
      writing.resolve();
      await finishWrite.promise;
    } });
    f.finishFetch.resolve();
    const caller = new AbortController();
    const operation = f.prepare(f.first, 'cancelled', undefined, caller.signal);
    const cancelled = assert.rejects(operation, { name: 'AbortError' });
    let retry: Promise<unknown> | undefined;
    try {
      await Promise.race([writing.promise, cancelled.then(() => assert.fail('the request ended before the local write'))]);
      caller.abort();
      ({ task: retry } = await f.queue(f.first, 'retry'));
      assert.deepEqual(writes, [undefined]);
      assert.deepEqual(f.releases, []);
      assert.deepEqual(f.refs, []);
      assert.deepEqual(f.fetches, command === 'config' ? [] : [{ sha: f.first, callers: ['cancelled'] }]);
      finishWrite.resolve();
      await Promise.all([cancelled, retry]);
      assert.deepEqual(writes, [undefined, undefined]);
      assert.deepEqual(f.releases, [1, 2]);
      assert.deepEqual(f.fetches, [{ sha: f.first, callers: [command === 'config' ? 'retry' : 'cancelled'] }]);
      assert.deepEqual(f.refs, command === 'config' ? [f.first] : [f.first, f.first]);
    } finally {
      finishWrite.resolve();
      await Promise.allSettled([operation, cancelled, retry]);
    }
  });

for (const stage of [true, false]) test(stage
  ? 'cancelling before cache publication discards its staged repository'
  : 'cancelling during cache publication completes the cache receipt', { timeout: 10_000 }, async t => {
  const f = await queuedCache(t);
  const reached = latch(), continueWrite = latch();
  const parent = path.join(f.storage, 'codex-repositories');
  const write = networkLease.atomicNetworkJson;
  t.mock.method(networkLease, 'atomicNetworkJson', async (file: string, value: unknown) => {
    if (stage) await write(file, value);
    if (stage ? path.basename(file) === 'gitlab-workspace-cache.json' : path.dirname(file) === parent) {
      reached.resolve();
      await continueWrite.promise;
    }
    if (!stage) await write(file, value);
  });
  f.finishFetch.resolve();
  const caller = new AbortController();
  const operation = f.prepare(f.first, 'cancelled', undefined, caller.signal);
  const cancelled = assert.rejects(operation, { name: 'AbortError' });
  try {
    await Promise.race([reached.promise, cancelled.then(() => assert.fail('the request ended before the publication fixture'))]);
    caller.abort();
    assert.deepEqual(f.releases, []);
    continueWrite.resolve();
    await cancelled;
    assert.deepEqual(f.fetches, []);
    const paths = (await readdir(parent)).sort();
    if (stage) assert.deepEqual(paths, []);
    else {
      assert.equal(paths.length, 2);
      assert.deepEqual(await readFile(path.join(parent, paths[0], '.git', 'gitlab-workspace-cache.json')),
        await readFile(path.join(parent, paths[0] + '.json')));
    }
    await f.prepare(f.first, 'retry');
    assert.deepEqual(f.releases, [1, 2]);
    assert.deepEqual(f.fetches, [{ sha: f.first, callers: ['retry'] }]);
  } finally {
    continueWrite.resolve();
    await Promise.allSettled([operation, cancelled]);
  }
});

test('Windows review caches keep fixed refs with paths longer than MAX_PATH', { skip: process.platform !== 'win32' }, async t => {
  const f = await fixture(t, true), before = await readFile(path.join(f.local, '.git', 'config'));
  const cache = await ensureManagedRepositoryCache(f.options), retained = `refs/gitlab-workspace/cache/${f.sha}`;
  assert.ok(path.join(cache.root, '.git', retained + '.lock').length > 260);
  assert.equal(git(cache.root, 'show-ref', '--verify', '--hash', retained), f.sha);
  assert.equal(git(cache.root, 'config', '--local', '--get', 'core.longpaths'), 'true');
  assert.deepEqual(await readFile(path.join(f.local, '.git', 'config')), before);
});
