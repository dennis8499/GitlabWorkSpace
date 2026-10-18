import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { OperationLog } from '../../src/logging/operationLog';

test('a burst of log records prunes once and keeps every record in order', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'workspace-log-batch-'));
  const log = new OperationLog(root);
  try {
    await log.flush();
    let prunes = 0;
    const target = log as unknown as { prune(): Promise<void> };
    const original = target.prune.bind(log); target.prune = async () => { prunes++; await original(); };
    for (let index = 0; index < 200; index++) log.record({ feature: 'test', action: String(index), result: 'success' });
    await log.flush();
    assert.equal(prunes, 1, 'records in one burst must share retention I/O');
    const page = await log.query(); assert.equal(page.total, 200); assert.equal(page.entries[0].action, '199');
  } finally { log.dispose(); await log.flush(); await rm(root, { recursive: true, force: true }); }
});

test('cancelling an export preserves an existing destination and removes temporary output', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'workspace-log-export-'));
  const log = new OperationLog(path.join(root, 'logs'));
  try {
    const destination = path.join(root, 'export.jsonl'); await writeFile(destination, 'previous export');
    for (let index = 0; index < 600; index++) log.record({ feature: 'test', action: String(index), result: 'success' });
    await log.flush();
    const controller = new AbortController();
    const query = log.exportTo.bind(log) as (destination: string, query: unknown, signal: AbortSignal) => Promise<void>;
    const pending = query(destination, {}, controller.signal);
    setImmediate(() => controller.abort());
    await assert.rejects(pending, { name: 'AbortError' });
    assert.equal(await readFile(destination, 'utf8'), 'previous export');
    assert.deepEqual((await readdir(root)).sort(), ['export.jsonl', 'logs']);
  } finally { log.dispose(); await log.flush(); await rm(root, { recursive: true, force: true }); }
});

test('an already cancelled log query does not scan storage or return results', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'workspace-log-cancel-'));
  const log = new OperationLog(root);
  try {
    log.record({ feature: 'test', action: 'one', result: 'success' }); await log.flush();
    const query = log.query.bind(log) as (value: unknown, signal: AbortSignal) => Promise<unknown>;
    const controller = new AbortController(); controller.abort();
    await assert.rejects(query({}, controller.signal), { name: 'AbortError' });
  } finally { log.dispose(); await log.flush(); await rm(root, { recursive: true, force: true }); }
});
