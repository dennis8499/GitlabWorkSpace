import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, stat, symlink, truncate, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { immutableSourceCacheLimits, withImmutableSourceArchive, type ImmutableSourceCacheOptions } from '../../src/codex/immutableSourceCache';
import { exportCommitSnapshot } from '../../src/codex/projectWorkflows';
import { resolvePythonRuntime } from '../../src/workspace/pythonRuntime';

async function fixture(t: test.TestContext) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'immutable-source-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repo = path.join(root, 'repo'); await mkdir(repo);
  return { root, repo, options: { directory: path.join(root, 'cache'), scope: 'account-a/project-1' } satisfies ImmutableSourceCacheOptions };
}
const sha = 'a'.repeat(40);
const entries = async (directory: string) => (await readdir(directory)).filter(name => /^[a-f0-9]{64}$/.test(name));
test('immutable archives and indexes are reused without recapture while consumers keep independent outputs', async t => {
  const f = await fixture(t); let captures = 0; const reuse: boolean[] = [];
  const capture = async (archive: string) => { captures++; await writeFile(archive, 'fixed commit bytes'); return '100644 blob source.txt\0'; };
  for (let index = 0; index < 2; index++) {
    await withImmutableSourceArchive(f.options, f.repo, sha, capture, async source => {
      reuse.push(source.reused); assert.equal(source.index, '100644 blob source.txt\0');
      await writeFile(path.join(f.root, 'output-' + index), await readFile(source.archive));
    });
  }
  await writeFile(path.join(f.root, 'output-0'), 'consumer edits');
  assert.equal(captures, 1); assert.deepEqual(reuse, [false, true]);
  assert.equal(await readFile(path.join(f.root, 'output-1'), 'utf8'), 'fixed commit bytes');
});
test('immutable source keys isolate accounts, repositories and commit versions', async t => {
  const f = await fixture(t), another = path.join(f.root, 'another'); await mkdir(another); let captures = 0;
  const capture = async (archive: string) => { captures++; await writeFile(archive, 'bytes'); return 'tree'; };
  const cases = [[f.options, f.repo, sha], [{ ...f.options, scope: 'account-b/project-1' }, f.repo, sha],
    [f.options, another, sha], [f.options, f.repo, 'b'.repeat(40)]] as const;
  for (const [options, repo, commit] of cases) await withImmutableSourceArchive(options, repo, commit, capture, async () => {});
  assert.equal(captures, 4); assert.equal((await entries(f.options.directory)).length, 4);
});
test('corrupted immutable archive bytes or tree indexes are rebuilt before consumption', async t => {
  const f = await fixture(t); let captures = 0;
  const capture = async (archive: string) => { captures++; await writeFile(archive, 'good bytes'); return 'good index'; };
  const consume = async (source: { archive: string; index: string }) => {
    assert.equal(await readFile(source.archive, 'utf8'), 'good bytes'); assert.equal(source.index, 'good index');
  };
  await withImmutableSourceArchive(f.options, f.repo, sha, capture, consume);
  const directory = path.join(f.options.directory, (await entries(f.options.directory))[0]);
  await writeFile(path.join(directory, 'source.zip'), 'tampered');
  await withImmutableSourceArchive(f.options, f.repo, sha, capture, consume);
  await writeFile(path.join(directory, 'tree.txt'), 'tampered');
  await withImmutableSourceArchive(f.options, f.repo, sha, capture, consume);
  assert.equal(captures, 3);
});
test('concurrent immutable source readers capture once and cancellation leaves no valid cache entry', async t => {
  const f = await fixture(t); let captures = 0;
  const capture = async (archive: string) => { captures++; await writeFile(archive, 'fixed'); return 'tree'; };
  await Promise.all([0, 1, 2].map(() => withImmutableSourceArchive(f.options, f.repo, sha, capture, async source => assert.equal(await readFile(source.archive, 'utf8'), 'fixed'))));
  assert.equal(captures, 1);
  const controller = new AbortController();
  await assert.rejects(withImmutableSourceArchive({ ...f.options, signal: controller.signal }, f.repo, 'c'.repeat(40),
    async archive => { await writeFile(archive, 'cancelled'); controller.abort(); return 'tree'; }, async () => assert.fail('cancelled capture was consumed')), { name: 'AbortError' });
  assert.equal((await entries(f.options.directory)).length, 1);
  assert.ok(!(await readdir(f.options.directory)).some(name => name.startsWith('.capture-')));
});
test('immutable source cache evicts only its oldest entries and rejects oversized archives', async t => {
  const f = await fixture(t);
  const capture = async (archive: string) => { await writeFile(archive, 'bytes'); return 'tree'; };
  for (let index = 0; index <= immutableSourceCacheLimits.entries; index++) {
    await withImmutableSourceArchive(f.options, f.repo, index.toString(16).padStart(40, '0'), capture, async () => {});
  }
  assert.equal((await entries(f.options.directory)).length, immutableSourceCacheLimits.entries);
  await assert.rejects(withImmutableSourceArchive(f.options, f.repo, 'f'.repeat(40), async archive => {
    await writeFile(archive, ''); await truncate(archive, immutableSourceCacheLimits.archiveBytes + 1); return 'tree';
  }, async () => assert.fail('oversized archive was consumed')), /限制/);
  assert.equal((await entries(f.options.directory)).length, immutableSourceCacheLimits.entries);
});
test('failed validation and aborted waiters cannot publish or consume a cache entry', async t => {
  const f = await fixture(t); let waiterCaptured = false, entered!: () => void, release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; }), started = new Promise<void>(resolve => { entered = resolve; });
  const capture = async (archive: string) => { await writeFile(archive, 'bytes'); return 'tree'; };
  await assert.rejects(withImmutableSourceArchive(f.options, f.repo, sha, capture, async () => { throw new Error('invalid archive payload'); }), /invalid archive payload/);
  assert.equal((await entries(f.options.directory)).length, 0);
  const holder = withImmutableSourceArchive(f.options, f.repo, sha, capture, async () => { entered(); await gate; });
  await started;
  const controller = new AbortController(), waiter = withImmutableSourceArchive({ ...f.options, signal: controller.signal }, f.repo, 'b'.repeat(40),
    async archive => { waiterCaptured = true; return capture(archive); }, async () => assert.fail('aborted waiter consumed an entry'));
  controller.abort(); await assert.rejects(waiter, { name: 'AbortError' });
  release(); await holder; assert.equal(waiterCaptured, false); assert.equal((await entries(f.options.directory)).length, 1);
});
test('redirected cache entries are rejected without deleting the external target', async t => {
  const f = await fixture(t), outside = path.join(f.root, 'outside'); await mkdir(outside);
  const capture = async (archive: string) => { await writeFile(archive, 'bytes'); return 'tree'; };
  await withImmutableSourceArchive(f.options, f.repo, sha, capture, async () => {});
  const directory = path.join(f.options.directory, (await entries(f.options.directory))[0]); await rm(directory, { recursive: true });
  await writeFile(path.join(outside, 'sentinel'), 'preserve');
  try { await symlink(outside, directory, process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (error) {
    if (['EPERM', 'EACCES', 'ENOSYS'].includes((error as NodeJS.ErrnoException).code ?? '')) { t.skip('This environment does not permit directory links'); return; }
    throw error;
  }
  await assert.rejects(withImmutableSourceArchive(f.options, f.repo, sha, capture, async () => assert.fail('redirected cache consumed')), /重新導向/);
  assert.equal(await readFile(path.join(outside, 'sentinel'), 'utf8'), 'preserve');
});
test('unconfirmed source subprocess cleanup quarantines its cache gate and retains evidence', async t => {
  const f = await fixture(t);
  await assert.rejects(withImmutableSourceArchive(f.options, f.repo, sha, async archive => {
    await writeFile(archive, 'partial archive'); throw Object.assign(new Error('child stop unknown'), { workflowCleanupUncertain: true });
  }, async () => assert.fail('unconfirmed capture consumed')), /child stop unknown/);
  const owner = JSON.parse(await readFile(path.join(f.options.directory, 'control', 'owner.json'), 'utf8'));
  assert.equal(owner.state, 'quarantined'); assert.equal((await entries(f.options.directory)).length, 0);
  assert.equal((await readdir(f.options.directory)).filter(name => name.startsWith('.capture-')).length, 1);
  await assert.rejects(withImmutableSourceArchive(f.options, f.repo, sha, async () => assert.fail('quarantine dispatched capture'), async () => {}), /Unconfirmed|incompatible/);
});
test('fixed commit cache materializes independent task snapshots and excludes working tree changes', async t => {
  const f = await fixture(t), git = (...args: string[]) => execFileSync('git', ['-C', f.repo, '-c', 'core.hooksPath=',
    '-c', 'user.name=Cache Test', '-c', 'user.email=cache@test.invalid', ...args], { encoding: 'utf8', windowsHide: true }).trim();
  git('init', '-q', '--initial-branch=main'); await writeFile(path.join(f.repo, 'source.txt'), 'committed');
  git('add', '.'); git('commit', '-qm', 'baseline'); const commit = git('rev-parse', 'HEAD');
  await writeFile(path.join(f.repo, 'source.txt'), 'dirty'); await writeFile(path.join(f.repo, 'private.txt'), 'private');
  const python = await resolvePythonRuntime('python'), observations: boolean[] = [], options = { ...f.options, observe: (row: { reused: boolean }) => observations.push(row.reused) };
  const first = path.join(f.root, 'task-one'), second = path.join(f.root, 'task-two');
  await exportCommitSnapshot(f.repo, commit, first, python, options);
  await writeFile(path.join(first, 'source.txt'), 'task edit');
  await exportCommitSnapshot(f.repo, commit, second, python, options);
  assert.deepEqual(observations, [false, true]); assert.equal(await readFile(path.join(second, 'source.txt'), 'utf8'), 'committed');
  await assert.rejects(stat(path.join(second, 'private.txt')), { code: 'ENOENT' });
});
