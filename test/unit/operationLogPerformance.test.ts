import assert from 'node:assert/strict';
import test from 'node:test';
import { OperationLog, type OperationLogSink } from '../../src/logging/operationLog';

test('a burst sends every record to the native sink synchronously and in order', () => {
  const output: string[] = [];
  const sink: OperationLogSink = { info: line => output.push(line), warn: line => output.push(line), error: line => output.push(line) };
  const log = new OperationLog(sink);
  for (let index = 0; index < 200; index++) log.record({ feature: 'test', action: String(index), result: 'success' });
  assert.equal(output.length, 200, 'no host flush or filesystem work is required to dispatch a burst');
  output.forEach((line, index) => assert.ok(line.startsWith(`[test] ${index} success {`)));
  log.dispose();
});

test('sink failures cannot replace business results or errors and later records can still be written', async () => {
  const output: string[] = [];
  let failed = true;
  const write = (line: string): void => {
    if (failed) throw new Error('native channel unavailable');
    output.push(line);
  };
  const log = new OperationLog({ info: write, warn: write, error: write });
  assert.equal(await log.run('workspace', 'read', {}, async () => 42), 42);
  const original = new Error('business operation failed');
  await assert.rejects(log.run('workspace', 'write', {}, async () => { throw original; }), error => error === original);
  const response = new Response('{}', { status: 200 });
  assert.equal(await log.wrapFetch(async () => response)('https://gitlab.test/api/v4/projects'), response);
  await assert.rejects(log.wrapFetch(async () => { throw original; })('https://gitlab.test/api/v4/projects'), error => error === original);
  failed = false;
  log.record({ feature: 'workspace', action: 'recovered', result: 'success' });
  assert.equal(output.length, 1);
  assert.ok(output[0].startsWith('[workspace] recovered success {'));
  log.dispose();
});

test('disposing the logger suppresses later records while business work can finish', async () => {
  const output: string[] = [];
  const write = (line: string): void => { output.push(line); };
  const log = new OperationLog({ info: write, warn: write, error: write });
  let complete!: () => void;
  const gate = new Promise<void>(resolve => { complete = resolve; });
  const pending = log.run('workspace', 'pending', {}, async () => { await gate; return 42; });
  assert.equal(output.length, 1);
  log.dispose();
  log.dispose();
  log.record({ feature: 'workspace', action: 'after-dispose', result: 'success' });
  complete();
  assert.equal(await pending, 42);
  assert.equal(await log.run('workspace', 'disposed', {}, async () => 7), 7);
  assert.equal(output.length, 1);
});
