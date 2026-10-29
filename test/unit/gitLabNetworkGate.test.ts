import assert from 'node:assert/strict';
import test from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { GitLabNetworkGate, parseRetryAfter } from '../../src/api/gitLabNetworkGate';
import { GitLabClient } from '../../src/api/gitLabClient';
import { LEASE_SCHEMA, LocalNetworkLease } from '../../src/api/localNetworkLease';
import { isGitNetworkCommand } from '../../src/git/gitProcess';

const exec = promisify(execFile);
async function fixture(t: { after(fn: () => Promise<void>): void }, api = { startsPerSecond: 1000, concurrency: 2 }): Promise<string> {
  const parent = await realpath(os.tmpdir()), root = await mkdtemp(path.join(parent, 'glw-network-gate-'));
  t.after(async () => { assert.equal(path.dirname(root), parent); assert.ok(path.basename(root).startsWith('glw-network-gate-')); await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 30 }); });
  await writeFile(path.join(root, 'network-policy.json'), JSON.stringify({ schema: 'GitLabWorkspaceNetworkPolicy/v1', api }));
  return root;
}
test('Retry-After accepts delta and HTTP date without negative waits', () => {
  assert.equal(parseRetryAfter('60', 1000), 61_000);
  assert.equal(parseRetryAfter('Thu, 01 Jan 1970 00:00:05 GMT', 1000), 5000);
  assert.equal(parseRetryAfter('Thu, 01 Jan 1970 00:00:00 GMT', 1000), 1000);
  assert.equal(parseRetryAfter('invalid', 1000), undefined);
});
test('independent clients and ports share host concurrency and request pacing', async t => {
  const root = await fixture(t, { startsPerSecond: 25, concurrency: 2 });
  const gates = [new GitLabNetworkGate(root), new GitLabNetworkGate(root)];
  let active = 0, peak = 0;
  const starts: number[] = [];
  const fetcher = async () => { starts.push(Date.now()); peak = Math.max(peak, ++active); await new Promise(resolve => setTimeout(resolve, 95)); active--; return new Response('{}'); };
  await Promise.all(Array.from({ length: 8 }, (_, index) => gates[index % 2].fetch(fetcher, new URL('https://same.example:' + (8000 + index) + '/api/v4/user'))));
  assert.ok(peak <= 2); assert.equal(starts.length, 8);
  // Keep enough separation to catch independent per-client gates while tolerating Windows timer jitter around the 40 ms target.
  for (let index = 1; index < starts.length; index++) assert.ok(starts[index] - starts[index - 1] >= 25, 'host start rate is shared');
  assert.equal((await readdir(path.join(root, 'api'))).length, 1);
});
test('429 cooldown is shared, manual re-entry cannot send and writes are never retried', async t => {
  const root = await fixture(t), first = new GitLabNetworkGate(root, 100), second = new GitLabNetworkGate(root, 100);
  let calls = 0;
  const fetcher = async () => { calls++; return new Response('{}', { status: 429, headers: { 'Retry-After': '60' } }); };
  assert.equal((await first.fetch(fetcher, new URL('https://same.example/api/v4/issues'), { method: 'POST', headers: { 'PRIVATE-TOKEN': 'SYNTHETIC-SECRET' } })).status, 429);
  await assert.rejects(second.fetch(fetcher, new URL('https://same.example/api/v4/user')), /requested a pause/);
  assert.equal(calls, 1);
  const host = (await readdir(path.join(root, 'api')))[0];
  const saved = await readFile(path.join(root, 'api', host, 'state.json'), 'utf8');
  assert.ok(!saved.includes('SYNTHETIC-SECRET')); assert.deepEqual(JSON.parse(saved).active, []);
});
test('cancelling a queued request sends nothing and leaves no reservation', async t => {
  const root = await fixture(t, { startsPerSecond: 1000, concurrency: 1 });
  const first = new GitLabNetworkGate(root), second = new GitLabNetworkGate(root);
  let release!: () => void, entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const running = first.fetch(async () => { entered(); await new Promise<void>(resolve => { release = resolve; }); return new Response('{}'); }, new URL('https://same.example/api/v4/user'));
  await started;
  const controller = new AbortController(); let sent = false;
  const queued = second.fetch(async () => { sent = true; return new Response('{}'); }, new URL('https://same.example/api/v4/user'), { signal: controller.signal });
  controller.abort(); await assert.rejects(queued, { name: 'AbortError' }); release(); await running;
  assert.equal(sent, false);
});
test('a write deadline while waiting for admission reports not sent rather than unknown', async t => {
  const root = await fixture(t, { startsPerSecond: 1000, concurrency: 1 }), gate = new GitLabNetworkGate(root);
  let release!: () => void, entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const running = gate.fetch(async () => { entered(); await new Promise<void>(resolve => { release = resolve; }); return new Response('{}'); }, new URL('https://same.example/api/v4/user'));
  await started; let sent = false;
  const client = Reflect.construct(GitLabClient, ['https://same.example', 'SYNTHETIC', async () => { sent = true; return new Response('{}'); }, undefined, undefined, undefined, undefined, 30, gate]) as GitLabClient;
  await assert.rejects(client.createIssue(1, { title: 'Queued' }), (error: unknown) => error instanceof Error && 'effect' in error && error.effect === 'none');
  release(); await running; assert.equal(sent, false);
});
test('a quarantined or dead lease is retained instead of being reclaimed by age', async t => {
  const root = await fixture(t), directory = path.join(root, 'git-network.lock');
  await mkdir(directory);
  await writeFile(path.join(directory, 'owner.json'), JSON.stringify({ schema: LEASE_SCHEMA, nonce: 'old', pid: process.pid, createdAt: '1970-01-01T00:00:00Z', kind: 'git', state: 'quarantined' }));
  await assert.rejects(LocalNetworkLease.acquire(directory, 'git', { timeoutMs: 50 }), /Unconfirmed/);
  assert.equal(JSON.parse(await readFile(path.join(directory, 'owner.json'), 'utf8')).nonce, 'old');
});
test('50 simulated user operations across processes obey one local host quota', async t => {
  const root = await fixture(t), events = path.join(root, 'events.jsonl');
  const modulePath = require.resolve('../../src/api/gitLabNetworkGate');
  const code = `const fs=require('node:fs');const {GitLabNetworkGate}=require(process.argv[1]);const gate=new GitLabNetworkGate(process.argv[2]);(async()=>{for(let i=0;i<10;i++)await gate.fetch(async()=>{fs.appendFileSync(process.argv[3],JSON.stringify({kind:'start',pid:process.pid})+'\\n');await new Promise(r=>setTimeout(r,20));fs.appendFileSync(process.argv[3],JSON.stringify({kind:'end',pid:process.pid})+'\\n');return new Response('{}')},new URL('https://same.example/api/v4/user'))})().catch(e=>{console.error(e);process.exitCode=1});`;
  const outcomes = await Promise.allSettled(Array.from({ length: 5 }, () => exec(process.execPath, ['-e', code, modulePath, root, events], { windowsHide: true, timeout: 30_000 })));
  for (const outcome of outcomes) if (outcome.status === 'rejected') throw outcome.reason;
  const entries = (await readFile(events, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  let active = 0, peak = 0, starts = 0;
  for (const entry of entries) { if (entry.kind === 'start') { starts++; peak = Math.max(peak, ++active); } else active--; }
  assert.equal(starts, 50); assert.equal(active, 0); assert.ok(peak <= 2);
});
test('Git network detection handles global options without mistaking local refs for commands', () => {
  assert.equal(isGitNetworkCommand(['-c', 'core.quotepath=false', '-C', 'repo', 'fetch', 'origin']), true);
  assert.equal(isGitNetworkCommand(['show', 'fetch']), false);
  assert.equal(isGitNetworkCommand(['-C', 'fetch', 'status']), false);
});
