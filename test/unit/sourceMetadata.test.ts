import assert from 'node:assert/strict';
import test from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { cachedSourceMetadata } from '../../src/codex/sourceMetadata';

const exec = promisify(execFile);
async function storage(t: test.TestContext): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'codex-source-metadata-'));
  t.after(() => rm(root, { recursive: true, force: true })); return root;
}

test('source cache expires at sixty seconds and isolates accounts and mutable callers', async t => {
  const root = await storage(t); let time = 1000, calls = 0;
  const load = async () => ({ version: ++calls }), now = () => time;
  const first = await cachedSourceMetadata(root, 'account', 'project:1', load, false, now);
  first.version = 100;
  assert.equal((await cachedSourceMetadata(root, 'account', 'project:1', load, false, now)).version, 1);
  time = 60_999; assert.equal((await cachedSourceMetadata(root, 'account', 'project:1', load, false, now)).version, 1);
  time = 61_000; assert.equal((await cachedSourceMetadata(root, 'account', 'project:1', load, false, now)).version, 2);
  assert.equal((await cachedSourceMetadata(root, 'other-account', 'project:1', load, false, now)).version, 3);
});

test('explicit refresh works within one clock millisecond and concurrent refresh joins one read', async t => {
  const root = await storage(t); let calls = 0;
  const load = async () => ({ version: ++calls }), now = () => 1000;
  await cachedSourceMetadata(root, 'account', 'key', load, false, now);
  assert.equal((await cachedSourceMetadata(root, 'account', 'key', load, true, now)).version, 2);
  const slow = async () => { const version = ++calls; await new Promise(resolve => setTimeout(resolve, 50)); return { version }; };
  const results = await Promise.all([cachedSourceMetadata(root, 'account', 'key', slow, true, now), cachedSourceMetadata(root, 'account', 'key', slow, true, now)]);
  assert.deepEqual(results, [{ version: 3 }, { version: 3 }]); assert.equal(calls, 3);
});

test('separate processes share one cache miss without a process-local singleton', async t => {
  const root = await storage(t), count = path.join(root, 'loads.txt');
  const module = require.resolve('../../src/codex/sourceMetadata');
  const script = `const fs=require('node:fs/promises');const {cachedSourceMetadata}=require(process.argv[1]);cachedSourceMetadata(process.argv[2],'account','project:one',async()=>{await fs.appendFile(process.argv[3],'load\\n');await new Promise(r=>setTimeout(r,100));return {sha:'fixed'}},false,()=>1000).then(x=>process.stdout.write(JSON.stringify(x))).catch(e=>{process.stderr.write(String(e));process.exitCode=1});`;
  const results = await Promise.all([exec(process.execPath, ['-e', script, module, root, count], { windowsHide: true }), exec(process.execPath, ['-e', script, module, root, count], { windowsHide: true })]);
  for (const result of results) assert.deepEqual(JSON.parse(result.stdout), { sha: 'fixed' });
  assert.equal((await readFile(count, 'utf8')).trim().split(/\r?\n/).length, 1);
});

test('loader errors release admission and cannot poison later reads', async t => {
  const root = await storage(t);
  await assert.rejects(cachedSourceMetadata(root, 'account', 'key', async () => { throw new Error('source unavailable'); }), /source unavailable/);
  assert.deepEqual(await cachedSourceMetadata(root, 'account', 'key', async () => ({ value: 'recovered' })), { value: 'recovered' });
  await assert.rejects(cachedSourceMetadata(root, 'account', 'undefined', async () => undefined), /格式無效/);
});

test('a forged expiry cannot extend the shared freshness window', async t => {
  const root = await storage(t); let calls = 0;
  const load = async () => ({ version: ++calls });
  await cachedSourceMetadata(root, 'account', 'key', load, false, () => 1000);
  const directory = path.join(root, 'codex-source-metadata'), file = path.join(directory, (await readdir(directory)).find(name => name.endsWith('.json'))!);
  const saved = JSON.parse(await readFile(file, 'utf8')); saved.expiresAt = 1_000_000_000; await writeFile(file, JSON.stringify(saved));
  assert.equal((await cachedSourceMetadata(root, 'account', 'key', load, false, () => 61_001)).version, 2);
});
