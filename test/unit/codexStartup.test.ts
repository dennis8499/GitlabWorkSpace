import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { CodexAppServer, type RpcOptions } from '../../src/codex/appServer';
import { CodexBridge } from '../../src/codex/bridge';
import { CodexTaskScheduler } from '../../src/codex/scheduler';
import { modelRoutingBinding } from '../../src/codex/modelRouting';
import { CodexRpcError } from '../../src/codex/rpcError';
import type { CodexEvent, CodexTaskSpec } from '../../src/codex/protocol';

function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
async function until(predicate: () => boolean, label = 'startup transition') {
  const deadline = Date.now() + 10_000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('Timed out: ' + label);
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}
const optionalMethods = new Set(['account/rateLimits/read', 'mcpServerStatus/list']);
async function fixture(t: test.TestContext, options: { mode?: string; routed?: boolean; holdReadiness?: boolean } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'codex-startup-'));
  const events: CodexEvent[] = [], calls: Array<{ method: string; options?: RpcOptions }> = [];
  const optional: Array<{ method: string; options?: RpcOptions; pending: ReturnType<typeof deferred<any>> }> = [];
  const readiness = new Map<string, ReturnType<typeof deferred<any>>>();
  if (options.holdReadiness) for (const method of ['account/read', 'windowsSandbox/readiness', 'configRequirements/read']) readiness.set(method, deferred());
  const spec: CodexTaskSpec = { title: 'Startup test', root, workspaceKey: root, prompt: 'hold',
    source: { kind: 'free', repository: root, prompt: 'hold' }, writableRoots: [root], environmentKey: 'startup' };
  if (options.routed) {
    const runtimeRoot = path.join(root, 'runtime'), requestId = 'a'.repeat(32);
    for (const name of ['merge-reviewer', 'model-routing']) {
      const skill = path.join(root, '.agents/skills', name, 'SKILL.md');
      await mkdir(path.dirname(skill), { recursive: true }); await writeFile(skill, 'Offline startup test');
    }
    for (const resource of ['scripts/routing.py', 'references/routing-policy.md', 'references/execution.md', 'references/reviewer-execution.md']) {
      const file = path.join(root, '.agents/skills/model-routing', resource);
      await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, 'Offline routing resource');
    }
    await mkdir(path.join(runtimeRoot, 'jobs'), { recursive: true });
    await writeFile(path.join(runtimeRoot, 'jobs', requestId + '.json'), JSON.stringify({ schema: 'MergeReviewSession/v1',
      request_id: requestId, context_dir: path.join(runtimeRoot, 'sessions', requestId), input_digest: 'b'.repeat(64), state: 'ready' }));
    await writeFile(path.join(root, 'fixture-routing.json'), JSON.stringify({ tool: 'merge-reviewer', requestId, runtimeRoot, requestedEffort: 'auto' }));
    spec.source = { kind: 'skill', featureId: 'merge-repo', inputs: {}, revision: 'startup' };
    spec.skill = { name: 'merge-reviewer', path: path.join(root, '.agents/skills/merge-reviewer/SKILL.md') };
    spec.review = { tool: 'merge-reviewer', requestId, revision: 'startup' };
    spec.routing = await modelRoutingBinding(root, 'merge-reviewer', runtimeRoot, requestId, 'auto');
  }
  let native: CodexAppServer | undefined;
  const bridge = new CodexBridge({ scheduler: new CodexTaskScheduler('startup', root), storage: root, version: 'test',
    executable: () => '', trusted: () => true, prepare: async () => spec, openUrl: async () => {}, event: event => events.push(event),
    client: async () => {
      const client = native = new CodexAppServer(spawn(process.execPath,
        [path.resolve(__dirname, '../../../test/fixtures/codex-app-server.cjs'), root, options.mode ?? 'evolution'],
        { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] }), 1000);
      await client.initialize('test');
      const request = client.request.bind(client);
      client.request = (method, params, rpcOptions) => {
        calls.push({ method, options: rpcOptions });
        if (optionalMethods.has(method)) {
          const pending = deferred<any>(); optional.push({ method, options: rpcOptions, pending });
          // Deliberately ignore abort to verify that late transport results cannot update state.
          return pending.promise;
        }
        if (readiness.has(method)) return readiness.get(method)!.promise;
        return request(method, params, rpcOptions);
      };
      return { client, version: '0.166.0', executable: 'offline-peer' };
    } });
  t.after(async () => { await bridge.shutdown(); await rm(root, { recursive: true, force: true }); });
  return { root, bridge, spec, events, calls, optional, readiness, client: () => native!,
    complete: () => { const record = bridge.list()[0]; native!.onNotification({ method: 'turn/completed', params: {
      threadId: record.threadId, turn: { id: record.turnId, status: 'completed', items: [] } } }); },
    settled: () => (bridge as any).executions.size === 0 };
}

test('required readiness starts in parallel and never queries optional status before turn acknowledgement', async t => {
  const f = await fixture(t, { holdReadiness: true });
  await f.bridge.enqueue(f.spec, 'parallel');
  const required = ['account/read', 'configRequirements/read', ...(process.platform === 'win32' ? ['windowsSandbox/readiness'] : [])];
  await until(() => required.every(method => f.calls.some(call => call.method === method)));
  assert.equal(f.calls.some(call => call.method === 'turn/start'), false);
  assert.equal(f.optional.length, 0);
  f.readiness.get('account/read')!.resolve({ requiresOpenaiAuth: true, account: { type: 'chatgpt' } });
  f.readiness.get('windowsSandbox/readiness')!.resolve({ status: 'ready' });
  f.readiness.get('configRequirements/read')!.resolve({ requirements: null });
  await until(() => f.optional.length === 2);
  assert.ok(f.calls.findIndex(call => call.method === 'turn/start') < f.calls.findIndex(call => optionalMethods.has(call.method)));
  assert.deepEqual(f.optional.map(call => call.method).sort(), [...optionalMethods].sort());
  assert.ok(f.optional.every(call => call.options?.timeoutMs === 5000 && call.options.signal));
  await until(() => typeof (f.bridge.diagnosticSnapshot('parallel').startup as any).firstResponseMs === 'number');
  const diagnostics = f.bridge.diagnosticSnapshot('parallel') as any;
  assert.equal(diagnostics.startup.origin, 'execution-start');
  assert.equal(diagnostics.startup.firstResponseFrom, 'dispatchSent');
  for (const phase of ['prepareMs', 'processMs', 'initializeMs', 'readinessMs', 'dispatchMs', 'executionToDispatchMs', 'firstResponseMs', 'executionToFirstResponseMs']) {
    assert.equal(typeof diagnostics.startup[phase], 'number', phase);
    assert.ok(diagnostics.startup[phase] >= 0, phase);
  }
  assert.ok(diagnostics.rpc.some((entry: any) => entry.method === 'turn/start'));
  await f.bridge.pause('parallel');
  assert.ok(f.optional.every(call => call.options?.signal?.aborted));
});

test('readiness failures still prohibit dispatch and optional status requests', async t => {
  for (const mode of ['logged-out', 'managed', ...(process.platform === 'win32' ? ['sandbox-missing'] : [])]) {
    const f = await fixture(t, { mode });
    await f.bridge.enqueue(f.spec, mode);
    await until(() => f.settled() && f.bridge.list()[0]?.status === 'failed');
    assert.equal(f.calls.some(call => call.method === 'turn/start'), false, mode);
    assert.equal(f.optional.length, 0, mode);
  }
});

test('first model response timing ignores the immediate user message echo', async t => {
  const f = await fixture(t, { mode: 'startup-user-echo' });
  await f.bridge.enqueue(f.spec, 'response'); await until(() => f.optional.length === 2);
  assert.equal((f.bridge.diagnosticSnapshot('response').startup as any).firstResponseMs, undefined);
  await new Promise(resolve => setTimeout(resolve, 35));
  await f.client().request('test/agent-response');
  await until(() => typeof (f.bridge.diagnosticSnapshot('response').startup as any).firstResponseMs === 'number');
  assert.ok((f.bridge.diagnosticSnapshot('response').startup as any).firstResponseMs >= 30);
  await f.bridge.pause('response');
});

test('optional timeout is not retried and late quota merges with the latest progress', async t => {
  const f = await fixture(t);
  await f.bridge.enqueue(f.spec, 'quota'); await until(() => f.optional.length === 2);
  f.optional.find(call => call.method === 'mcpServerStatus/list')!.pending.reject(new CodexRpcError('timeout', 'mcpServerStatus/list'));
  const record = f.bridge.list()[0];
  f.client().onNotification({ method: 'thread/tokenUsage/updated', params: { threadId: record.threadId, turnId: record.turnId,
    tokenUsage: { total: { totalTokens: 90, inputTokens: 60, outputTokens: 30 } } } });
  f.optional.find(call => call.method === 'account/rateLimits/read')!.pending.resolve({ rateLimits: { primary: { usedPercent: 17 } } });
  await until(() => f.bridge.progress('quota')?.quota?.usedPercent === 17);
  assert.equal(f.bridge.progress('quota')?.tokens?.total, 90);
  assert.equal(f.calls.filter(call => call.method === 'mcpServerStatus/list').length, 1);
  assert.ok((f.bridge.diagnosticSnapshot('quota').rpc as any[]).some(entry => entry.method === 'account/read'));
  await f.bridge.pause('quota');
});

test('completion, cancellation, exit and shutdown abort optional reads and suppress late data', async t => {
  for (const action of ['complete', 'cancel', 'exit', 'shutdown'] as const) {
    const f = await fixture(t); await f.bridge.enqueue(f.spec, action); await until(() => f.optional.length === 2);
    if (action === 'complete') f.complete();
    if (action === 'cancel') await f.bridge.cancel(action);
    if (action === 'exit') f.client().onExit(new Error('Offline transport closed'));
    if (action === 'shutdown') await f.bridge.shutdown();
    await until(f.settled, action);
    assert.ok(f.optional.every(call => call.options?.signal?.aborted), action);
    const eventCount = f.events.length, before = f.bridge.progress(action);
    for (const call of f.optional) call.pending.resolve(call.method === 'account/rateLimits/read'
      ? { rateLimits: { primary: { usedPercent: 99 } } } : { data: [{ name: 'STALE', authStatus: 'ready' }] });
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(f.bridge.progress(action), before, action);
    assert.equal(f.events.length, eventCount, action);
  }
});

test('newer environments before and after dispatch survive an older task MCP response', async t => {
  for (const timing of ['before-dispatch', 'after-dispatch']) {
    const f = await fixture(t), replacement = { state: 'blocked', message: 'Newer inspection' };
    if (timing === 'before-dispatch') (f.bridge as any).options.started = async () => { (f.bridge as any).environment = replacement; };
    await f.bridge.enqueue(f.spec, timing); await until(() => f.optional.length === 2);
    if (timing === 'after-dispatch') (f.bridge as any).environment = replacement;
    f.optional.find(call => call.method === 'mcpServerStatus/list')!.pending.resolve({ data: [{ name: 'STALE', authStatus: 'ready' }] });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal((f.bridge as any).environment, replacement, timing);
    await f.bridge.pause(timing);
  }
});

test('resumed conversations dispatch before optional reads and cancel the previous execution queries', async t => {
  const f = await fixture(t); await f.bridge.enqueue(f.spec, 'resume'); await until(() => f.optional.length === 2);
  const thread = f.bridge.list()[0].threadId;
  await f.bridge.pause('resume'); await f.bridge.resume('resume'); await until(() => f.optional.length === 4);
  assert.equal(f.bridge.list()[0].threadId, thread);
  assert.ok(f.calls.some(call => call.method === 'thread/resume'));
  assert.ok(f.optional.slice(0, 2).every(call => call.options?.signal?.aborted));
  assert.ok(f.optional.slice(2).every(call => !call.options?.signal?.aborted));
  f.optional[0].pending.resolve({ rateLimits: { primary: { usedPercent: 99 } } });
  await new Promise(resolve => setImmediate(resolve));
  assert.notEqual(f.bridge.progress('resume')?.quota?.usedPercent, 99);
  await f.bridge.pause('resume');
});

test('routed reviews start status reads after dispatch once across assessment and review turns', async t => {
  const f = await fixture(t, { routed: true, mode: 'routing-page' });
  await f.bridge.enqueue(f.spec, 'routing');
  await until(() => f.settled() && ['completed', 'failed'].includes(f.bridge.list()[0]?.status));
  assert.equal(f.bridge.list()[0].status, 'completed', f.bridge.list()[0].error ?? 'Routed startup should complete');
  assert.equal(f.calls.filter(call => call.method === 'turn/start').length, 2);
  assert.equal(f.optional.length, 2);
  assert.ok(f.optional.every(call => call.options?.signal?.aborted));
  assert.ok(f.calls.findIndex(call => call.method === 'turn/start') < f.calls.findIndex(call => optionalMethods.has(call.method)));
  const diagnostics = f.bridge.diagnosticSnapshot('routing') as any;
  assert.equal(typeof diagnostics.startup.firstResponseMs, 'number');
});
