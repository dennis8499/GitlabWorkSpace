import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { codexCapabilities, CodexProtocolAdapter } from '../../src/codex/adapter';
import { CodexRpcError } from '../../src/codex/rpcError';
import type { CodexAppServer } from '../../src/codex/appServer';

test('advanced capabilities match the captured official protocol and generated files retain their identity', async () => {
  const root = path.resolve(__dirname, '../../../src/codex/generated');
  const contract = JSON.parse(await readFile(path.join(root, 'contract.json'), 'utf8'));
  assert.equal(contract.version, '0.166.0');
  for (const [file, digest] of Object.entries(contract.files)) {
    const content = (await readFile(path.join(root, file), 'utf8')).replace(/\r\n/g, '\n');
    assert.equal(createHash('sha256').update(content).digest('hex'), digest, file);
  }
  assert.equal(codexCapabilities('0.166.0').goals, true);
  for (const version of ['0.165.0', '0.166.0-alpha.1', '0.167.0']) assert.equal(codexCapabilities(version).goals, false);
});
test('only whitelisted reads retry once; mutations and repeating pagination cursors are rejected', async () => {
  let count = 0;
  const client = { request: async () => { if (++count === 1) throw new CodexRpcError('timeout'); return { data: [], nextCursor: null }; } } as unknown as CodexAppServer;
  const adapter = new CodexProtocolAdapter(client, '0.166.0');
  await adapter.models(); assert.equal(count, 2);
  await assert.rejects(adapter.read('turn/start'), /不允許/); assert.equal(count, 2);
  const looping = new CodexProtocolAdapter({ request: async () => ({ data: [], nextCursor: 'repeat' }) } as unknown as CodexAppServer, '0.166.0');
  await assert.rejects(looping.models(), error => error instanceof CodexRpcError && error.category === 'protocol');
});
