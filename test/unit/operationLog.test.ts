import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { OperationLog } from '../../src/logging/operationLog';
import { logGitCommand } from '../../src/git/gitCommandLog';

async function directory(t: TestContext): Promise<string> {
  const prefix = path.resolve(os.tmpdir(), 'workspace-logs-');
  const root = await mkdtemp(prefix);
  assert.ok(path.resolve(root).startsWith(prefix));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test('persists successful and failed operations, captures their original account and correlates API requests', async t => {
  const root = await directory(t), log = new OperationLog(root);
  let accountId = 'first';
  log.setContextSource(() => ({ accountId }));
  await log.run('issue', 'update', {}, async () => {
    accountId = 'second';
    await log.wrapFetch(async () => new Response('{}', { status: 201 }))('https://gitlab.test/api/v4/projects/1/issues?token=hidden', { method: 'POST', body: 'private-description' });
  });
  await assert.rejects(log.run('projects', 'clone', {}, async () => { throw new Error('Synthetic failure'); }));
  const page = await log.query({ feature: 'issue' });
  assert.equal(page.total, 2);
  assert.ok(page.entries.every(entry => entry.accountId === 'first'));
  const api = (await log.query({ feature: 'api' })).entries[0];
  assert.equal(api.operationId, page.entries[0].operationId);
  assert.equal(api.statusCode, 201);
  assert.equal(api.endpoint, 'https://gitlab.test/api/v4/projects/1/issues');
  assert.equal((await log.query({ result: 'error', search: 'Synthetic' })).total, 1);
  log.dispose();
  const reopened = new OperationLog(root);
  assert.equal((await reopened.query()).total, 5);
  assert.ok(!JSON.stringify(await reopened.query()).includes('private-description'));
  reopened.dispose();
});

test('redacts secrets and credentials, paginates and exports the complete filtered result', async t => {
  const root = await directory(t), log = new OperationLog(root);
  log.addSecret('custom-secret-value');
  for (let i = 0; i < 105; i++) log.record({ feature: 'git', action: 'fetch', result: 'success', message: 'custom-secret-value https://user:pass@host glpat-private-token authorization=hidden Bearer hidden' });
  const first = await log.query({ feature: 'git' }), next = await log.query({ feature: 'git', page: 1 });
  assert.equal(first.entries.length, 100); assert.equal(next.entries.length, 5);
  const serialized = JSON.stringify(first);
  for (const secret of ['custom-secret-value', 'user:pass', 'glpat-private-token', 'hidden']) assert.ok(!serialized.includes(secret));
  const destination = path.join(root, 'export.jsonl');
  await log.exportTo(destination, { feature: 'git', page: 1 });
  assert.equal((await readFile(destination, 'utf8')).trim().split('\n').length, 105);
  await log.clear(); assert.equal((await log.query()).total, 0);
  assert.ok((await stat(destination)).isFile(), 'clear only removes managed log segments');
  log.dispose();
});

test('correlates Git exit codes while preserving command results and excluding arguments and output', async t => {
  const log = new OperationLog(await directory(t));
  let identity = 'first';
  log.setContextSource(() => ({ accountId: identity }));
  const failure = Object.assign(new Error('private-stderr-output'), { code: 128 });
  await log.run('workflow', 'prepareDelivery', {}, async () => {
    identity = 'second';
    assert.deepEqual(await logGitCommand(['-c', 'http.extraHeader=private-header', '-C', 'repo', 'show', 'private-argument'], 'repo',
      async () => ({ stdout: 'private-stdout-output' })), { stdout: 'private-stdout-output' });
    await assert.rejects(logGitCommand(['cat-file'], 'repo', async () => { throw failure; }), error => error === failure);
  });
  const entries = (await log.query()).entries;
  assert.ok(entries.every(entry => entry.accountId === 'first'));
  assert.equal(new Set(entries.map(entry => entry.operationId)).size, 1);
  assert.ok(entries.some(entry => entry.action === 'show' && entry.exitCode === 0));
  assert.ok(entries.some(entry => entry.action === 'cat-file' && entry.exitCode === 128));
  const serialized = JSON.stringify(entries);
  for (const value of ['private-header', 'private-argument', 'private-stdout-output', 'private-stderr-output']) assert.ok(!serialized.includes(value));
  log.dispose();
});

test('rotates bounded segments, prunes expired files and tolerates a partial final append', async t => {
  const root = await directory(t);
  const expired = path.join(root, (Date.now() - 31 * 86400000) + '-' + randomUUID() + '.jsonl');
  await writeFile(expired, '{"old":true}\n');
  const log = new OperationLog(root, undefined, { maxBytes: 2000, segmentBytes: 500 });
  for (let i = 0; i < 30; i++) log.record({ feature: 'issue', action: 'read-' + i, result: 'success' });
  await log.flush();
  const files = (await readdir(root)).filter(name => name.endsWith('.jsonl'));
  assert.ok(!files.includes(path.basename(expired)));
  assert.ok((await Promise.all(files.map(name => stat(path.join(root, name))))).reduce((sum, file) => sum + file.size, 0) <= 2000);
  const latest = files.sort().at(-1)!;
  await writeFile(path.join(root, latest), (await readFile(path.join(root, latest), 'utf8')) + '{partial');
  assert.ok((await log.query()).total > 0);
  log.dispose();
});

test('log storage failures report a warning without failing business operations', async t => {
  const root = await directory(t), filename = path.join(root, 'not-a-directory');
  await writeFile(filename, 'file');
  const warnings: string[] = [];
  const log = new OperationLog(filename, message => warnings.push(message));
  assert.equal(await log.run('issue', 'read', {}, async () => 42), 42);
  await log.flush(); assert.ok(warnings.length > 0);
  assert.ok((await log.query()).error);
  log.dispose();
});
