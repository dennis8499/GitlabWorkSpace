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
