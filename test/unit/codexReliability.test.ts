import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtemp, writeFile, rm, mkdir, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { CodexAppServer } from '../../src/codex/appServer';
import { CodexRpcError } from '../../src/codex/rpcError';
import { CodexTaskStore } from '../../src/codex/taskStore';
import type { CodexTaskRecord } from '../../src/codex/protocol';
import { isCodexCommand } from '../../src/codex/commands';
import { projectCodexProgress } from '../../src/codex/progress';
import { CodexWorkspaceLease } from '../../src/codex/workspaceLease';

function fake(write?: (chunk: Buffer, callback: () => void) => void) {
  const child = new EventEmitter() as EventEmitter & { stdin: Writable; stdout: PassThrough; stderr: PassThrough; kill(): boolean };
  child.stdin = new Writable({ highWaterMark: 1, write: (chunk, _encoding, callback) => { if (write) write(chunk, callback); else callback(); } });
  child.stdout = new PassThrough(); child.stderr = new PassThrough(); let kills = 0;
  child.kill = () => { kills++; return false; };
  const client = new CodexAppServer(child as unknown as ChildProcessWithoutNullStreams, 100, 5);
  return { client, child, kills: () => kills };
}
test('unresponsive child close has a hard deadline and shares the same failure', async () => {
  const f = fake(), start = Date.now();
  const closing = f.client.close(5); assert.equal(closing, f.client.close(500));
  await assert.rejects(closing, error => error instanceof CodexRpcError && error.category === 'cleanup');
  assert.ok(Date.now() - start < 1000); assert.equal(f.kills(), 1);
  f.child.emit('close');
});
test('transport observes backpressure, cancels unsent writes and redacts structured errors', async () => {
  const writes: string[] = []; let release!: () => void;
  const f = fake((chunk, callback) => { writes.push(chunk.toString()); release = callback; });
  const first = f.client.request('first'), abort = new AbortController();
  const second = f.client.request('second', {}, { signal: abort.signal }); abort.abort();
  await assert.rejects(second, error => error instanceof CodexRpcError && error.delivery === 'not-sent');
  assert.equal(writes.length, 1); release();
  f.child.stdout.write(JSON.stringify({ id: 1, error: { code: -32600, message: 'SECRET', data: { type: 'modelProviderMismatch', secret: 'SECRET' } } }) + '\n');
  await assert.rejects(first, error => error instanceof CodexRpcError && error.category === 'provider' && !JSON.stringify(error).includes('SECRET'));
  assert.equal(writes.length, 1); f.child.emit('close'); await f.client.close();
});
test('one corrupt record remains intact while valid v1 records load and migrate with a backup', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'codex-store-isolation-')); t.after(() => rm(root, { recursive: true, force: true }));
  const store = new CodexTaskStore(path.join(root, 'records')); await mkdir(store.directory);
  await writeFile(path.join(store.directory, 'broken.json'), '{bad');
  const record: CodexTaskRecord = { schema: 'GitLabWorkspaceCodexTask/v1', id: 'valid', ownerPid: process.pid, root, title: 'test', status: 'paused', createdAt: '2026-01-01', updatedAt: '2026-01-01',
    spec: { source: { kind: 'free', repository: root, prompt: 'test' }, title: 'test', root, workspaceKey: root, prompt: 'test', writableRoots: [root], environmentKey: 'test' } };
  await store.save(record);
  const malformed = [ { title: {} }, { progress: { plan: {} } }, { result: { state: 'ready', summary: 'Invalid', replyDrafts: {} } },
    { modelRouting: { phase: 'reviewing', history: {} } }, { goal: { objective: 'Goal', tokensUsed: {} } } ];
  for (const [index, fields] of malformed.entries()) {
    const id = 'malformed-' + index;
    await writeFile(path.join(store.directory, id + '.json'), JSON.stringify({ ...record, ...fields, id }));
  }
  assert.equal((await store.load()).length, 1); assert.equal(store.problems.length, malformed.length + 1);
  assert.ok(store.problems.some(problem => problem.id === 'broken'));
  assert.equal(await readFile(path.join(store.directory, 'broken.json'), 'utf8'), '{bad');
  record.schema = 'GitLabWorkspaceCodexTask/v2'; await store.save(record);
  assert.equal(JSON.parse(await readFile(path.join(store.directory, 'valid.json.v1-backup'), 'utf8')).schema, 'GitLabWorkspaceCodexTask/v1');
});
test('new controls reject cross-boundary payloads and progress only accepts bounded fields', () => {
  assert.equal(isCodexCommand({ action: 'metadata', taskId: 'one', pinned: true }), true);
  assert.equal(isCodexCommand({ action: 'create', repository: 'C:/arbitrary' }), false);
  assert.equal(isCodexCommand({ action: 'approvals', taskId: 'one', settings: { command: true, file: true, permissions: true, extra: true } }), false);
  const result = projectCodexProgress(undefined, 'thread/tokenUsage/updated', { tokenUsage: { total: { totalTokens: 10, inputTokens: 6, outputTokens: 4 } }, secret: 'SECRET' });
  assert.equal(result?.tokens?.total, 10); assert.ok(!JSON.stringify(result).includes('SECRET'));
});

test('quarantined locks require exact owner and durable process-stop proof', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'codex-exact-proof-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = path.join(root, 'lease'), lease = await CodexWorkspaceLease.acquire(directory);
  const nonce = await lease.ownerNonce(), receipt = await lease.processReceipt(); await lease.quarantine();
  assert.equal(await CodexWorkspaceLease.inspect(directory, receipt), 'unknown');
  await assert.rejects(CodexWorkspaceLease.releaseWithProof(directory, nonce, receipt), /停止收據/);
  await writeFile(receipt.path, JSON.stringify({ schema: 'GitLabWorkspaceCodexProcess/v1', nonce, processTreeConfirmed: true }));
  assert.equal(await CodexWorkspaceLease.inspect(directory, receipt), 'confirmed');
  await assert.rejects(CodexWorkspaceLease.releaseWithProof(directory, 'different-owner', receipt), /擁有者已變更/);
  await CodexWorkspaceLease.releaseWithProof(directory, nonce, receipt);
  assert.equal(await CodexWorkspaceLease.inspect(directory), 'confirmed');
  assert.ok(await readFile(receipt.path, 'utf8')); await CodexWorkspaceLease.clearReceipt(receipt);
});
