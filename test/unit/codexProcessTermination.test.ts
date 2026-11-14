import assert from 'node:assert/strict';
import test from 'node:test';
import { windowsTaskkillComplete } from '../../src/codex/processTermination';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

test('Windows taskkill accepts raced exits only after every reported target has gone', () => {
  const output = 'ERROR: The process with PID 72 (child process of PID 51) could not be terminated.\r\n' +
    'Reason: There is no running instance of the task.\r\n' +
    'SUCCESS: The process with PID 51 (child process of PID 999) has been terminated.\r\n';
  const checked: number[] = [];
  assert.equal(windowsTaskkillComplete(128, 51, output, pid => { checked.push(pid); return pid !== 999; }), true);
  assert.deepEqual(checked, [72, 51]);
  assert.equal(windowsTaskkillComplete(128, 51, output, pid => pid !== 72), false);
  assert.equal(windowsTaskkillComplete(128, 51, output, pid => pid !== 51), false);
});

test('Windows stop confirmation rejects missing roots, oversized output and other failures', () => {
  const gone = () => true;
  assert.equal(windowsTaskkillComplete(128, 51, 'ERROR: PID 72', gone), false);
  assert.equal(windowsTaskkillComplete(128, 51, '', gone), false);
  assert.equal(windowsTaskkillComplete(128, 51, 'PID 51' + 'x'.repeat(1024 * 1024), gone), false);
  assert.equal(windowsTaskkillComplete(1, 51, 'PID 51', gone), false);
  assert.equal(windowsTaskkillComplete(null, 51, 'PID 51', gone), false);
  assert.equal(windowsTaskkillComplete(0, 51, '', () => false), true);
});

test('Windows OEM taskkill bytes preserve target PIDs and never turn a missing process into tree proof', () => {
  // Captured from isolated child processes on Traditional Chinese Windows.
  // The Latin-1 transport is lossless; only ASCII PID tokens are interpreted.
  const terminated = Buffer.from('a6a8a55c3a2050494420acb0203238363936202850494420acb020313434343820aabaa46cb342b27ab57ba7c72920aabab342b27ab57ba7c7a477b2d7a4eea1430d0aa6a8a55c3a2050494420acb0203134343438202850494420acb020333738303820aabaa46cb342b27ab57ba7c72920aabab342b27ab57ba7c7a477b2d7a4eea1430d0a', 'hex');
  const output = terminated.toString('latin1'), checked: number[] = [];
  assert.deepEqual(Buffer.from(output, 'latin1'), terminated);
  // Simulate taskkill's mixed-success 128 path using the same OEM PID lines.
  assert.equal(windowsTaskkillComplete(128, 14448, output, pid => { checked.push(pid); return true; }), true);
  assert.deepEqual(checked, [28696, 14448]);
  assert.equal(windowsTaskkillComplete(128, 14448, output, pid => pid !== 28696), false);
  const missing = Buffer.from('bff9bb7e3a20a7e4a4a3a8ecb342b27ab57ba7c720223133323022a1430d0a', 'hex').toString('latin1');
  assert.equal(windowsTaskkillComplete(128, 1320, missing, () => true), false);
});

test('supervisor distinguishes unconfirmed stops and failed receipts without reporting success or sensitive output', async () => {
  for (const outcome of ['confirmed', 'unknown', 'natural-exit', 'receipt-failed']) {
    const writes: string[] = [], diagnostics: string[] = [], child: any = new EventEmitter(), supervisor: any = new EventEmitter();
    child.pid = 51; child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
    child.kill = () => { child.emit('exit', 0); child.emit('close', 0); return true; };
    supervisor.argv = ['node', 'host', 'sensitive-command.exe', process.cwd(), 'sensitive-receipt-path.json', 'a'.repeat(36)];
    supervisor.stdin = new PassThrough(); supervisor.stdout = new PassThrough(); supervisor.stderr = new PassThrough(); supervisor.platform = 'win32'; supervisor.env = { PRIVATE_TOKEN: 'sensitive-environment' };
    supervisor.stderr.on('data', (bytes: Buffer) => diagnostics.push(bytes.toString('utf8')));
    let taskkillCalls = 0;
    const spawn = (executable: string) => {
      if (executable !== 'taskkill.exe') return child;
      taskkillCalls++; const killer: any = new EventEmitter(); killer.stdout = new PassThrough(); killer.stderr = new PassThrough();
      queueMicrotask(() => { killer.stderr.write('sensitive-raw-taskkill-output'); killer.emit('close', outcome === 'unknown' ? 1 : 0); }); return killer;
    };
    const requireFixture = (name: string) => name === 'node:child_process' ? { spawn }
      : name === 'node:fs' ? { writeFileSync: (_file: string, content: string) => { if (outcome === 'receipt-failed') throw new Error('sensitive-write-error'); writes.push(content); } }
        : { windowsTaskkillComplete };
    vm.runInNewContext(readFileSync(path.join(__dirname, '../../src/codex/processHost.js'), 'utf8'), {
      exports: {}, require: requireFixture, process: supervisor, Buffer, setTimeout
    });
    if (outcome === 'natural-exit') { child.emit('exit', 0); child.emit('close', 0); }
    else supervisor.stdin.end();
    await new Promise(resolve => setImmediate(resolve)); await new Promise(resolve => setImmediate(resolve));
    assert.equal(supervisor.exitCode, outcome === 'confirmed' ? 0 : 1);
    assert.equal(writes.length, outcome === 'confirmed' ? 1 : 0);
    assert.equal(taskkillCalls, outcome === 'natural-exit' ? 0 : 1);
    const marker = outcome === 'natural-exit' ? 'native-exited-before-stop' : outcome === 'unknown' ? 'tree-stop-unconfirmed' : 'receipt-write-failed';
    assert.equal(diagnostics.join(''), outcome === 'confirmed' ? '' : `GitLabWorkspace Codex supervisor: ${marker}\n`);
  }
});

test('the pipe supervisor writes proof only after native tree termination, including a failed initial spawn', async () => {
  for (const outcome of ['confirmed', 'unknown', 'never-started']) {
    const writes: string[] = [], child: any = new EventEmitter(), supervisor: any = new EventEmitter();
    child.pid = outcome === 'never-started' ? undefined : 51;
    child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.kill = () => child.emit('close', 0);
    supervisor.argv = ['node', 'host', 'codex.exe', process.cwd(), 'receipt.json', 'a'.repeat(36)];
    supervisor.stdin = new PassThrough(); supervisor.stdout = new PassThrough(); supervisor.stderr = new PassThrough(); supervisor.platform = 'win32'; supervisor.env = {};
    const spawn = (executable: string) => {
      if (executable !== 'taskkill.exe') return child;
      const killer: any = new EventEmitter(); killer.stdout = new PassThrough(); killer.stderr = new PassThrough();
      queueMicrotask(() => killer.emit('close', outcome === 'confirmed' ? 0 : 1)); return killer;
    };
    const requireFixture = (name: string) => name === 'node:child_process' ? { spawn }
      : name === 'node:fs' ? { writeFileSync: (_file: string, content: string) => writes.push(content) }
        : { windowsTaskkillComplete };
    vm.runInNewContext(readFileSync(path.join(__dirname, '../../src/codex/processHost.js'), 'utf8'), {
      exports: {}, require: requireFixture, process: supervisor, Buffer, setTimeout
    });
    if (outcome === 'never-started') { child.emit('error', new Error('ENOENT')); child.emit('close', -1); }
    else supervisor.stdin.end();
    await new Promise(resolve => setImmediate(resolve)); await new Promise(resolve => setImmediate(resolve));
    assert.equal(writes.length, outcome === 'unknown' ? 0 : 1);
    if (writes.length) assert.deepEqual(JSON.parse(writes[0]), { schema: 'GitLabWorkspaceCodexProcess/v1', nonce: 'a'.repeat(36), processTreeConfirmed: true });
  }
});

test('native exit with inherited pipes closes only after confirmed tree termination', async () => {
  for (const { confirmed, exitBeforeProof } of [{ confirmed: true, exitBeforeProof: true }, { confirmed: true, exitBeforeProof: false }, { confirmed: false, exitBeforeProof: true }]) {
    const writes: string[] = [], child: any = new EventEmitter(), supervisor: any = new EventEmitter();
    child.pid = 51; child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
    let nativeExited = false, closeEmitted = false;
    const streams = [child.stdin, child.stdout, child.stderr];
    for (const stream of streams) {
      const destroy = stream.destroy.bind(stream);
      stream.destroy = () => {
        assert.equal(nativeExited, true, 'a pipe may close only after native exit');
        assert.equal(confirmed, true, 'an unknown process tree must retain its pipes and proof');
        destroy();
        if (!closeEmitted && streams.every(item => item.destroyed)) { closeEmitted = true; queueMicrotask(() => child.emit('close', 1)); }
        return stream;
      };
    }
    child.kill = () => {
      const exit = () => { nativeExited = true; child.emit('exit', 1); };
      if (exitBeforeProof) exit(); else setImmediate(exit);
      return true;
    };
    supervisor.argv = ['node', 'host', 'codex.exe', process.cwd(), 'receipt.json', 'a'.repeat(36)];
    supervisor.stdin = new PassThrough(); supervisor.stdout = new PassThrough(); supervisor.stderr = new PassThrough(); supervisor.platform = 'win32'; supervisor.env = {};
    const spawn = (executable: string) => {
      if (executable !== 'taskkill.exe') return child;
      const killer: any = new EventEmitter(); killer.stdout = new PassThrough(); killer.stderr = new PassThrough();
      queueMicrotask(() => killer.emit('close', confirmed ? 0 : 1)); return killer;
    };
    const requireFixture = (name: string) => name === 'node:child_process' ? { spawn }
      : name === 'node:fs' ? { writeFileSync: (_file: string, content: string) => writes.push(content) }
        : { windowsTaskkillComplete };
    vm.runInNewContext(readFileSync(path.join(__dirname, '../../src/codex/processHost.js'), 'utf8'), {
      exports: {}, require: requireFixture, process: supervisor, Buffer, setTimeout
    });
    supervisor.stdin.end();
    await new Promise(resolve => setImmediate(resolve)); await new Promise(resolve => setImmediate(resolve));
    assert.equal(nativeExited, true);
    assert.equal(closeEmitted, confirmed);
    assert.equal(streams.every(stream => stream.destroyed), confirmed);
    assert.equal(writes.length, confirmed ? 1 : 0);
    if (confirmed) assert.deepEqual(JSON.parse(writes[0]), { schema: 'GitLabWorkspaceCodexProcess/v1', nonce: 'a'.repeat(36), processTreeConfirmed: true });
  }
});
