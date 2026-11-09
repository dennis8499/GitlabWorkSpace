import { CodexTaskScheduler } from '../../src/codex/scheduler';
import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { CodexAppServer } from '../../src/codex/appServer';
import { CodexBridge } from '../../src/codex/bridge';
import { modelRoutingBinding, readModelRouting, reviewerRunnerRuntime } from '../../src/codex/modelRouting';
import type { CodexEvent, CodexTaskSpec } from '../../src/codex/protocol';

const peer = path.resolve(__dirname, '../../../test/fixtures/codex-app-server.cjs');
test('native runner caches use a separate runtime sibling', () => {
  const native = path.resolve('external/review-runtime');
  assert.equal(reviewerRunnerRuntime(native), path.resolve('external/review-runtime-workflow-kit'));
  assert.notEqual(reviewerRunnerRuntime(native), native);
});
async function until(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!predicate()) { if (Date.now() > deadline) throw new Error('Routing test timed out'); await new Promise(resolve => setTimeout(resolve, 10)); }
}
async function setup(t: { after(fn: () => Promise<void>): void }, options: {
  effort?: string; initial?: string; escalate?: string; mode?: string; release?: boolean;
  model?: string; supportedEfforts?: string[]; recommended?: string; capped?: boolean;
} = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'routing-bridge-'));
  const tool = options.release ? 'release-reviewer' : 'merge-reviewer';
  const requestId = 'a'.repeat(32), runtimeRoot = path.join(root, 'runtime'), effort = options.effort ?? 'auto';
  for (const name of [tool, 'model-routing']) {
    const skill = path.join(root, '.agents/skills', name, 'SKILL.md');
    await mkdir(path.dirname(skill), { recursive: true }); await writeFile(skill, 'Test Skill');
  }
  const directory = path.join(root, '.agents/skills/model-routing');
  for (const file of ['scripts/routing.py', 'references/routing-policy.md', 'references/execution.md', 'references/reviewer-execution.md']) {
    await mkdir(path.dirname(path.join(directory, file)), { recursive: true }); await writeFile(path.join(directory, file), 'Test resource');
  }
  await mkdir(path.join(runtimeRoot, 'jobs'), { recursive: true });
  await writeFile(path.join(runtimeRoot, 'jobs', requestId + '.json'), JSON.stringify({
    schema: options.release ? 'ReleaseReviewSession/v1' : 'MergeReviewSession/v1', request_id: requestId,
    context_dir: path.join(runtimeRoot, 'sessions', requestId), input_digest: 'b'.repeat(64), state: 'ready'
  }));
  await writeFile(path.join(root, 'fixture-routing.json'), JSON.stringify({ tool, requestId, runtimeRoot, requestedEffort: effort,
    initialEffort: options.initial, escalate: options.escalate, model: options.model, supportedEfforts: options.supportedEfforts,
    recommended: options.recommended, capped: options.capped }));
  const binding = await modelRoutingBinding(root, tool, runtimeRoot, requestId, effort);
  if (options.model) Object.assign(binding, { model: options.model, supportedEfforts: options.supportedEfforts, supportsModelSelection: true });
  const spec: CodexTaskSpec = { source: { kind: 'skill', featureId: options.release ? 'release-review' : 'merge-repo', inputs: {}, revision: 'r' },
    title: 'Routing test', root, workspaceKey: root, prompt: 'Use the same frozen session.',
    skill: { name: tool, path: path.join(root, '.agents/skills', tool, 'SKILL.md') },
    writableRoots: [root], environmentKey: 'r', review: { tool, requestId, revision: 'r' }, routing: binding,
    ...(options.model ? { model: options.model, effort } : {}) };
  const requests: Array<{ method: string; params: any }> = [], events: CodexEvent[] = [];
  let completed = 0, cancelled = 0;
  const bridges: CodexBridge[] = [];
  const make = () => {
    const bridge = new CodexBridge({ scheduler: new CodexTaskScheduler('test', root), storage: root, version: 'test', executable: () => '', trusted: () => true,
      prepare: async () => spec, event: event => events.push(event), openUrl: async () => {},
      completed: async () => { completed++; }, cancelReview: async () => { cancelled++; },
      client: async () => {
        const client = new CodexAppServer(spawn(process.execPath, [peer, root, options.mode ?? ''], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] }));
        const request = client.request.bind(client);
        client.request = (method, params) => { requests.push({ method, params }); return request(method, params); };
        await client.initialize('test'); return { client, version: '0.166.0', executable: 'offline-peer' };
      } });
    bridges.push(bridge); return bridge;
  };
  const bridge = make();
  t.after(async () => { for (const item of bridges) await item.shutdown(); await rm(root, { recursive: true, force: true }); });
  return { root, spec, binding, bridge, make, requests, events, completed: () => completed, cancelled: () => cancelled };
}
test('auto assessment, review and escalation use exact Luna efforts without early completion', async t => {
  const f = await setup(t, { initial: 'high', escalate: 'max', mode: 'routing-page', release: true });
  await f.bridge.enqueue(f.spec, 'auto');
  await until(() => f.bridge.list()[0]?.status === 'completed' || f.bridge.list()[0]?.status === 'failed');
  assert.equal(f.bridge.list()[0].status, 'completed', f.bridge.list()[0].error ?? 'Routing should complete');
  const turns = f.requests.filter(item => item.method === 'turn/start');
  assert.deepEqual(turns.map(item => [item.params.model, item.params.effort]), [
    ['gpt-6-luna', 'high'], ['gpt-6-luna', 'high'], ['gpt-6-luna', 'max']
  ]);
  assert.ok(turns[0].params.input[0].text.includes('routing_phase=assess'));
  assert.ok(turns[1].params.input[0].text.includes('routing_phase=review'));
  assert.deepEqual(turns[0].params.outputSchema.properties.action.enum, ['review']);
  assert.equal(turns[1].params.outputSchema, undefined);
  assert.equal(turns[1].params.input.filter((item: any) => item.type === 'skill').length, 1);
  assert.match(turns[1].params.input[0].text, /routing_role=reviewer/);
  assert.equal(new Set(turns.map(item => item.params.threadId)).size, 3);
  assert.ok(f.requests.filter(item => item.method === 'thread/start').slice(1).every(item => item.params.developerInstructions === 'Test resource'));
  assert.match(turns[2].params.input[0].text, /Recheck the affected contract/);
  assert.equal(f.completed(), 1);
  assert.deepEqual(f.bridge.list()[0].modelRouting?.history.map(item => item.effort), ['high', 'max']);
  for (const event of f.events) if (event.kind === 'tasks') for (const task of event.tasks) {
    if (task.status === 'completed') assert.equal(task.modelRouting?.phase, 'complete');
  }
});
test('all five manual efforts bypass assessment and preserve the exact chosen effort', async t => {
  for (const effort of ['low', 'medium', 'high', 'xhigh', 'max'] as const) {
    const f = await setup(t, { effort });
    await f.bridge.enqueue(f.spec, effort);
    await until(() => ['completed', 'failed'].includes(f.bridge.list()[0]?.status));
    assert.equal(f.bridge.list()[0].status, 'completed', f.bridge.list()[0].error ?? 'Manual routing should complete');
    const turns = f.requests.filter(item => item.method === 'turn/start');
    assert.equal(turns.length, 1); assert.equal(turns[0].params.effort, effort);
    assert.ok(turns[0].params.input[0].text.includes('routing_phase=review'));
    assert.ok(turns[0].params.input[0].text.includes('routing.py bind --tool merge-reviewer'));
    assert.ok(turns[0].params.input[0].text.includes(`--effort ${effort}`));
  }
});
test('missing model/effort stops before dispatch without fallback', async t => {
  for (const mode of ['routing-model-missing', 'routing-max-missing']) {
    const f = await setup(t, { effort: 'max', mode });
    await f.bridge.enqueue(f.spec, mode);
    await until(() => f.bridge.list()[0]?.status === 'failed');
    assert.equal(f.requests.filter(item => item.method === 'turn/start').length, 0);
    assert.match(f.bridge.list()[0].error!, /Luna/);
    assert.equal(f.completed(), 0);
  }
});
test('missing decisions and unfinished reviews remain failed rather than completed', async t => {
  for (const mode of ['routing-no-decision', 'routing-incomplete']) {
    const f = await setup(t, { mode });
    await f.bridge.enqueue(f.spec, mode);
    await until(() => f.bridge.list()[0]?.status === 'failed');
    assert.equal(f.completed(), 0);
    assert.match(f.bridge.list()[0].error!, /路由|審查/);
  }
});
test('cancelling a routing turn stops the helper and never starts review', async t => {
  const f = await setup(t, { mode: 'routing-hold' });
  await f.bridge.enqueue(f.spec, 'cancel');
  await until(() => !!f.bridge.list()[0]?.turnId);
  await f.bridge.cancel('cancel');
  assert.equal(f.bridge.list()[0].status, 'interrupted');
  assert.equal(f.requests.filter(item => item.method === 'turn/start').length, 1);
  assert.equal(f.cancelled(), 1); assert.equal(f.completed(), 0);
});
test('pausing a reviewer resumes its conversation at the same effort and fixed request', async t => {
  const f = await setup(t, { effort: 'high', mode: 'routing-hold-review' });
  await f.bridge.enqueue(f.spec, 'paused-reviewer');
  await until(() => !!f.bridge.list()[0]?.turnId);
  const running = f.bridge.list()[0];
  await f.bridge.pause(running.id);
  assert.equal(f.bridge.list()[0].status, 'paused');
  assert.equal(f.cancelled(), 1);
  const before = f.requests.length;
  await f.bridge.resume(running.id);
  await until(() => ['completed', 'failed'].includes(f.bridge.list()[0]?.status));
  assert.equal(f.bridge.list()[0].status, 'completed', f.bridge.list()[0].error ?? 'Reviewer should complete');
  assert.equal(f.bridge.list()[0].threadId, running.threadId);
  assert.deepEqual(f.bridge.list()[0].review, running.review);
  const resumed = f.requests.slice(before);
  assert.equal(resumed.some(item => item.method === 'thread/start'), false);
  assert.equal(resumed.find(item => item.method === 'turn/start')?.params.effort, 'high');
  assert.match(resumed.find(item => item.method === 'turn/start')?.params.input[0].text, new RegExp(f.spec.review!.requestId));
});
test('saved manual routing survives binding recovery and rejects native identity drift', async t => {
  const f = await setup(t, { effort: 'xhigh' });
  await f.bridge.enqueue(f.spec, 'persist');
  await until(() => f.bridge.list()[0]?.status === 'completed');
  const binding = await modelRoutingBinding(f.root, f.binding.tool, f.binding.runtimeRoot, f.binding.requestId);
  assert.equal(binding.requestedEffort, 'xhigh');
  const state = (await readModelRouting(binding))!;
  assert.equal(state.phase, 'complete');
  const filename = path.join(binding.runtimeRoot, 'routing', binding.tool, binding.requestId + '.json');
  await writeFile(filename, JSON.stringify({ ...state, input_digest: 'c'.repeat(64) }));
  await assert.rejects(readModelRouting(binding), /固定身分不符/);
  await writeFile(filename, JSON.stringify(state));
  await f.bridge.shutdown();
  const resumed = f.make();
  await resumed.initialize();
  assert.equal(resumed.list()[0].modelRouting?.effort, 'xhigh');
  const before = f.requests.length;
  await resumed.resume('persist');
  await until(() => resumed.list()[0]?.status === 'completed');
  assert.equal(f.requests.slice(before).filter(item => item.method === 'turn/start').length, 0);
});

test('a user supplement accepted during assessment reaches the fresh reviewer context', async t => {
  const f = await setup(t, { mode: 'routing-hold-assess' });
  await f.bridge.enqueue(f.spec, 'steer');
  await until(() => !!f.bridge.list()[0]?.turnId);
  await f.bridge.message('steer', 'Also check the zero-count caller.');
  await until(() => ['completed', 'failed'].includes(f.bridge.list()[0]?.status));
  assert.equal(f.bridge.list()[0].status, 'completed', f.bridge.list()[0].error ?? 'Steered routing should complete');
  const turns = f.requests.filter(item => item.method === 'turn/start');
  assert.equal(turns.length, 2);
  assert.notEqual(turns[0].params.threadId, turns[1].params.threadId);
  assert.match(turns[1].params.input[0].text, /Also check the zero-count caller/);
});

test('published review follow-up answers use the selected Luna effort without recapture', async t => {
  const f = await setup(t, { effort: 'xhigh' });
  await f.bridge.enqueue(f.spec, 'followup');
  await until(() => f.bridge.list()[0]?.status === 'completed');
  await f.bridge.message('followup', 'Explain the existing report.');
  await until(() => f.bridge.list()[0]?.status === 'completed');
  const turns = f.requests.filter(item => item.method === 'turn/start');
  assert.equal(turns.length, 2);
  assert.equal(turns[1].params.effort, 'xhigh');
  assert.equal(turns[1].params.outputSchema, undefined);
  assert.match(turns[1].params.input[0].text, /Explain the existing report/);
  assert.doesNotMatch(turns[1].params.input[0].text, /routing_phase=assess/);
});

test('selected reviewer model is used for assessment, capped review, follow-up and saved recovery', async t => {
  const f = await setup(t, { model: 'fixture-model', supportedEfforts: ['low', 'xhigh'], initial: 'xhigh', recommended: 'max', capped: true });
  await f.bridge.enqueue(f.spec, 'selected');
  await until(() => ['completed', 'failed'].includes(f.bridge.list()[0]?.status));
  assert.equal(f.bridge.list()[0].status, 'completed', f.bridge.list()[0].error ?? 'Selected model should complete');
  const turns = f.requests.filter(item => item.method === 'turn/start');
  assert.deepEqual(turns.map(item => [item.params.model, item.params.effort]), [['fixture-model', 'xhigh'], ['fixture-model', 'xhigh']]);
  assert.match(turns[0].params.input[0].text, /--model "fixture-model" --supported-efforts low,xhigh/);
  assert.equal(f.bridge.list()[0].modelRouting?.capped, true);
  assert.equal(f.bridge.list()[0].modelRouting?.recommendedEffort, 'max');
  const recovered = await modelRoutingBinding(f.root, f.binding.tool, f.binding.runtimeRoot, f.binding.requestId);
  assert.equal(recovered.model, 'fixture-model'); assert.deepEqual(recovered.supportedEfforts, ['low', 'xhigh']);
  const preparedAgain = await modelRoutingBinding(f.root, f.binding.tool, f.binding.runtimeRoot, f.binding.requestId, recovered.requestedEffort, true, recovered);
  assert.equal(preparedAgain.model, recovered.model); assert.deepEqual(preparedAgain.supportedEfforts, recovered.supportedEfforts);
  assert.equal((await readModelRouting(preparedAgain))?.phase, 'complete');
  await f.bridge.message('selected', 'Explain this report.');
  await until(() => ['completed', 'failed'].includes(f.bridge.list()[0]?.status));
  assert.equal(f.requests.filter(item => item.method === 'turn/start').at(-1)?.params.model, 'fixture-model');
});

test('a selected model becoming unavailable after assessment stops without another model', async t => {
  const f = await setup(t, { model: 'fixture-model', supportedEfforts: ['high'], mode: 'routing-selected-removed' });
  await f.bridge.enqueue(f.spec, 'removed');
  await until(() => f.bridge.list()[0]?.status === 'failed');
  assert.equal(f.requests.filter(item => item.method === 'turn/start').length, 1);
  assert.match(f.bridge.list()[0].error!, /fixture-model/);
});

test('manual catalog effort labels do not require a known Auto rank', async t => {
  const f = await setup(t, { model: 'fixture-model', supportedEfforts: ['custom'], effort: 'custom' });
  await f.bridge.enqueue(f.spec, 'manual-custom');
  await until(() => ['completed', 'failed'].includes(f.bridge.list()[0]?.status));
  assert.equal(f.bridge.list()[0].status, 'completed', f.bridge.list()[0].error ?? 'Manual effort should complete');
  assert.deepEqual(f.requests.filter(item => item.method === 'turn/start').map(item => item.params.effort), ['custom']);
});
