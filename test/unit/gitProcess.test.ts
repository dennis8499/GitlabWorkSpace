import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { captureGitProcess } from '../../src/git/gitProcess';

test('Git subprocess deadline and explicit cancellation settle and clean their process', async () => {
  await assert.rejects(captureGitProcess(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { timeoutMs: 30 }), { name: 'TimeoutError' });
  const controller = new AbortController();
  const task = captureGitProcess(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { signal: controller.signal });
  setTimeout(() => controller.abort(), 30);
  await assert.rejects(task, { name: 'AbortError' });
  const stopped = new AbortController(); stopped.abort();
  await assert.rejects(captureGitProcess('must-never-start', [], { signal: stopped.signal }), { name: 'AbortError' });
});

test('Git byte limits reject incomplete structure and explicitly mark bounded UTF-8 Diff prefixes', async () => {
  const args = ['-e', 'process.stdout.write("中文".repeat(10000));setInterval(()=>{},1000)'];
  await assert.rejects(captureGitProcess(process.execPath, args, { maxStdoutBytes: 1024, timeoutMs: 5000 }), { name: 'GitOutputLimitError' });
  const result = await captureGitProcess(process.execPath, args, { maxStdoutBytes: 1024, allowTruncated: true, timeoutMs: 5000 });
  assert.equal(result.truncated, true);
  assert.ok(Buffer.byteLength(result.stdout) <= 1024);
  assert.ok(!result.stdout.includes('\uFFFD'));
});

test('explicit cancellation removes the spawned process tree before releasing its promise', async t => {
  const parent = await realpath(os.tmpdir()), root = await mkdtemp(path.join(parent, 'glw-process-cleanup-'));
  const marker = path.join(root, 'pids.json');
  let pids: number[] = [];
  t.after(async () => {
    for (const pid of pids) { try { process.kill(pid); } catch { /* Already terminated. */ } }
    if (path.dirname(root) !== parent || !path.basename(root).startsWith('glw-process-cleanup-')) throw new Error('Unsafe fixture cleanup');
    await rm(root, { recursive: true, force: true });
  });
  const source = 'const c=require("node:child_process").spawn(process.execPath,["-e","setInterval(()=>{},1000)"],{stdio:"ignore",windowsHide:true});require("node:fs").writeFileSync(process.argv[1],JSON.stringify([process.pid,c.pid]));setInterval(()=>{},1000)';
  const controller = new AbortController();
  const task = captureGitProcess(process.execPath, ['-e', source, marker], { signal: controller.signal, timeoutMs: 5000 });
  const rejection = assert.rejects(task, { name: 'AbortError' });
  for (let tick = 0; tick < 200; tick++) {
    try { pids = JSON.parse(await readFile(marker, 'utf8')); break; } catch { await new Promise(resolve => setTimeout(resolve, 10)); }
  }
  controller.abort(); await rejection;
  assert.equal(pids.length, 2, 'parent and helper both started');
  for (const pid of pids) assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
});
