import assert from 'node:assert/strict';
import test from 'node:test';
import { windowsTaskkillComplete } from '../../src/codex/processTermination';

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
