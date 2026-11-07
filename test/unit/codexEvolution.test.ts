import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, rm, realpath } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { CodexAppServer } from '../../src/codex/appServer';
import { CodexBridge } from '../../src/codex/bridge';
import { captureCodexContext, prepareFreeTask } from '../../src/codex/freeTask';
import { boundTranscriptCache, codexItemBytes } from '../../src/codex/historyBudget';
import { CodexTaskScheduler, codexResourcesOverlap, codexResourcePaths } from '../../src/codex/scheduler';
import { ProjectWikiStore } from '../../src/codex/projectWiki';
import { wikiIncrementalSelection } from '../../src/codex/wikiIncremental';
import type { CodexTaskOrigin } from '../../src/codex/workflowProtocol';
import type { CodexTaskSource, CodexTaskSpec, CodexEvent } from '../../src/codex/protocol';

const until = async (predicate: () => boolean, message = 'state transition') => {
  const deadline = Date.now() + 12000;
  while (!predicate()) { if (Date.now() > deadline) throw new Error('Timed out: ' + message); await new Promise(resolve => setTimeout(resolve, 10)); }
};
async function fixture(t: test.TestContext, mode = 'evolution', maximum = 2) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'codex-evolution-')), repositories = [path.join(root, 'a'), path.join(root, 'b')];
  await Promise.all(repositories.map(root => mkdir(root)));
  const events: CodexEvent[] = [], requests: Array<{ method: string; params: any }> = [], responses: Array<{ id: string | number; result: any }> = [];
  const bridges: CodexBridge[] = [];
  const make = (storage = root) => {
    const bridge = new CodexBridge({ scheduler: new CodexTaskScheduler('test', root), storage, version: 'test', executable: () => '', trusted: () => true, maxConcurrent: () => maximum,
      prepare: async source => { if (source.kind !== 'free') throw new Error('Expected free task'); return prepareFreeTask(source, repositories); },
      openUrl: async () => {}, event: event => events.push(event), client: async cwd => {
        const client = new CodexAppServer(spawn(process.execPath, [path.resolve(__dirname, '../../../test/fixtures/codex-app-server.cjs'), cwd, mode], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] }), 2000);
        await client.initialize('test'); const request = client.request.bind(client), respond = client.respond.bind(client);
        client.request = (method, params, options) => { requests.push({ method, params }); return request(method, params, options); };
        client.respond = (id, result) => { responses.push({ id, result }); respond(id, result); };
        return { client, version: '0.166.0', executable: 'offline-peer' };
      } }); bridges.push(bridge); return bridge;
  };
  const bridge = make();
  const spec = (repository: string, prompt = 'hold'): Promise<CodexTaskSpec> => prepareFreeTask({ kind: 'free', repository, prompt }, repositories);
  t.after(async () => { await Promise.all(bridges.map(bridge => bridge.shutdown())); assert.ok(root.startsWith(os.tmpdir() + path.sep)); await rm(root, { recursive: true, force: true }); });
  return { root, repositories, bridge, make, spec, events, requests, responses };
}
test('independent repositories run together and pausing one preserves the other execution', async t => {
  const f = await fixture(t);
  await f.bridge.enqueue(await f.spec(f.repositories[0]), 'parallel-a');
  await f.bridge.enqueue(await f.spec(f.repositories[1]), 'parallel-b');
  await until(() => f.bridge.list().filter(task => task.status === 'running').length === 2);
  await f.bridge.pause('parallel-a'); assert.equal(f.bridge.list().find(task => task.id === 'parallel-a')?.status, 'paused');
  assert.equal(f.bridge.list().find(task => task.id === 'parallel-b')?.status, 'running');
  await f.bridge.message('parallel-b', 'Continue inspecting');
  assert.ok(f.requests.some(request => request.method === 'turn/steer'));
  await f.bridge.pause('parallel-b');
});
test('a blocked first repository does not prevent another repository from using the remaining machine slot', async t => {
  const f = await fixture(t), second = f.make(path.join(f.root, 'other-window'));
  await f.bridge.enqueue(await f.spec(f.repositories[0]), 'owner'); await until(() => f.bridge.list()[0]?.status === 'running');
  await second.enqueue(await f.spec(f.repositories[0]), 'blocked');
  await second.enqueue(await f.spec(f.repositories[1]), 'runnable');
  await until(() => second.list().find(task => task.id === 'runnable')?.status === 'running');
  assert.equal(second.list().find(task => task.id === 'blocked')?.status, 'queued');
  await second.pause('blocked'); await second.pause('runnable'); await f.bridge.pause('owner');
});

test('an unconfirmed stopped process retains its machine slot until reconciliation', async t => {
  const f = await fixture(t), scheduler = new CodexTaskScheduler(randomUUID(), f.root), id = randomUUID();
  const first = await scheduler.tryAcquire(id, await f.spec(f.repositories[0]), 1);
  assert.ok(first.reservation);
  try {
    await first.reservation.primary.quarantine(); await first.reservation.release(true);
    assert.equal((await scheduler.tryAcquire(randomUUID(), await f.spec(f.repositories[1]), 1)).reason, 'capacity');
  } finally {
    await first.reservation.primary.release(); await scheduler.reconcile(id);
  }
  const next = await scheduler.tryAcquire(randomUUID(), await f.spec(f.repositories[1]), 1);
  assert.ok(next.reservation); await next.reservation.primary.release(); await next.reservation.release(false);
});

test('waiting resources preserve local queue order while independent work may proceed', async t => {
  const f = await fixture(t), second = f.make(path.join(f.root, 'ordered-window'));
  const third = path.join(f.root, 'c'); await mkdir(third); f.repositories.push(third);
  const prepare = (second as any).options.prepare;
  (second as any).options.prepare = async (source: CodexTaskSource) => {
    const spec = await prepare(source);
    if (source.kind === 'free' && source.prompt === 'needs-a') spec.writableRoots.push(f.repositories[0]);
    return spec;
  };
  await f.bridge.enqueue(await f.spec(f.repositories[0]), 'resource-owner'); await until(() => f.bridge.list()[0]?.status === 'running');
  const first = await (second as any).options.prepare({ kind: 'free', repository: f.repositories[1], prompt: 'needs-a' });
  await second.enqueue(first, 'ordered-first'); await second.enqueue(await f.spec(f.repositories[1]), 'ordered-second');
  await second.enqueue(await f.spec(third), 'independent-third');
  await until(() => second.list().find(task => task.id === 'independent-third')?.status === 'running');
  assert.equal(second.list().find(task => task.id === 'ordered-second')?.status, 'queued');
  await second.pause('ordered-first'); await second.pause('ordered-second'); await second.pause('independent-third'); await f.bridge.pause('resource-owner');
});
test('free tasks need no Skill and persist progress, dispatch receipts, metadata and independent forks', async t => {
  const f = await fixture(t); await f.bridge.enqueue(await f.spec(f.repositories[0], 'finish'), 'free');
  await until(() => f.bridge.list()[0]?.status === 'completed' && !(f.bridge as any).active);
  const task = f.bridge.list()[0]; assert.equal(task.progress?.tokens?.total, 10); assert.equal(task.progress?.plan?.[0].step, 'Inspect');
  assert.equal(task.progress?.hasDiff, true); assert.equal(task.progress?.diff, undefined);
  assert.equal(f.requests.some(request => request.method === 'skills/list'), false);
  const saved = JSON.parse(await readFile(path.join(f.root, 'codex-tasks/free.json'), 'utf8'));
  assert.equal(saved.dispatch.state, 'completed'); assert.match(saved.dispatch.id, /^[a-f0-9-]{36}$/);
  await f.bridge.metadata('free', { title: 'Renamed', pinned: true, archived: true }); assert.equal(f.bridge.list()[0].pinned, true);
  const fork = await f.bridge.fork('free', task.turnId!);
  assert.equal(f.bridge.list().find(task => task.id === fork)?.status, 'paused');
  assert.equal((await f.bridge.specification(fork)).origin, undefined);
  assert.equal(f.bridge.list().find(task => task.id === 'free')?.threadId, task.threadId);
});
test('granular Auto-Accept leaves file changes and permissions pending and survives reopening with the switch off', async t => {
  const f = await fixture(t); await f.bridge.enqueue(await f.spec(f.repositories[0], 'auto-approvals'), 'limited');
  await until(() => f.bridge.list()[0]?.status === 'waiting');
  await f.bridge.setApprovals('limited', { command: true, file: false, permissions: false }); await f.bridge.setAutoAccept('limited', true);
  await until(() => f.responses.length === 3); assert.deepEqual(f.responses.map(response => response.id), [91, 92, 93]);
  await f.bridge.pause('limited'); await f.bridge.shutdown();
  const reopened = f.make(); await reopened.initialize();
  assert.equal(reopened.list()[0].controls?.autoAccept, false); assert.equal(reopened.list()[0].controls?.approvals?.file, false);
});
test('native Goal continues across turns and waits for the final turn after the goal-complete event', async t => {
  const f = await fixture(t, 'evolution-goal'); await f.bridge.enqueue(await f.spec(f.repositories[0], 'finish'), 'goal');
  await until(() => f.bridge.list()[0]?.status === 'completed' && !(f.bridge as any).active);
  await f.bridge.setGoal('goal', { objective: 'Complete the goal', tokenBudget: 1000 });
  await f.bridge.resume('goal'); await until(() => f.bridge.list()[0]?.goal?.status === 'complete' && !(f.bridge as any).active);
  assert.equal(f.bridge.list()[0].turnId, 'goal-continuation'); assert.equal(f.bridge.list()[0].status, 'completed');
  assert.ok(f.events.some(event => event.kind === 'output' && event.items.some(item => item.text.includes('Native goal continuation'))));
});
test('a Goal time budget interrupts the turn and preserves its paused conversation', async t => {
  const f = await fixture(t, 'evolution-goal-hold'); await f.bridge.enqueue(await f.spec(f.repositories[0], 'finish'), 'timed-goal');
  await until(() => f.bridge.list()[0]?.status === 'completed' && !(f.bridge as any).active);
  await f.bridge.setGoal('timed-goal', { objective: 'Hold within the time budget', tokenBudget: 10000, timeBudgetSeconds: 1 });
  await f.bridge.message('timed-goal', 'hold');
  await until(() => f.bridge.list()[0]?.goal?.status === 'budgetLimited' && !(f.bridge as any).active);
  assert.equal(f.bridge.list()[0].status, 'paused'); assert.ok(f.bridge.list()[0].threadId);
  assert.ok(f.requests.some(request => request.method === 'turn/interrupt'));
});
test('context capture rejects escaping paths and mutated snapshots; cache eviction keeps the selected transcript', async t => {
  const f = await fixture(t), inside = path.join(f.repositories[0], 'a.txt'), outside = path.join(f.root, 'outside.txt');
  await writeFile(inside, 'Original'); await writeFile(outside, 'Outside');
  const context = await captureCodexContext(f.repositories[0], inside);
  await writeFile(inside, 'Changed');
  const source: Extract<CodexTaskSource, { kind: 'free' }> = { kind: 'free', repository: f.repositories[0], prompt: 'Inspect', contexts: [context] };
  assert.ok((await prepareFreeTask(source, f.repositories)).prompt.includes('Original'));
  await assert.rejects(captureCodexContext(f.repositories[0], outside), /Repo/);
  await assert.rejects(prepareFreeTask({ ...source, contexts: [{ ...context, text: 'Tampered' }] }, f.repositories), /快照/);
  const item = { id: 'one', kind: 'agent' as const, text: 'x'.repeat(500) }, result = boundTranscriptCache({ old: [item], selected: [item] }, 'selected', codexItemBytes(item) + 10);
  assert.deepEqual(result.evicted, ['old']); assert.equal(result.cache.selected[0].id, 'one');
  assert.equal(codexResourcesOverlap([f.repositories[0]], [path.join(f.repositories[0], 'nested')]), true);
  assert.equal(codexResourcesOverlap([f.repositories[0]], [f.repositories[1]]), false);
  const physical = (await realpath(f.repositories[0])).toLowerCase();
  assert.ok((await codexResourcePaths(await f.spec(f.repositories[0]))).some(resource => resource.toLowerCase() === physical));
});
test('Wiki incremental selection falls back for incomplete evidence and seeds only verified published pages', async t => {
  const f = await fixture(t), id = randomUUID(), drafts = path.join(f.root, 'wiki-drafts'); await mkdir(drafts);
  const origin: CodexTaskOrigin = { kind: 'project-wiki', accountKey: 'a', baseUrl: 'https://gitlab.test', projectId: 1, projectPath: 'team/project', webUrl: 'https://gitlab.test/team/project', repositoryRoot: f.repositories[0], sourceBranch: 'main', sourceSha: 'a'.repeat(40) };
  const pages = [{ slug: 'codebase/index', file: 'index.md', content: '# Index', sources: ['a.ts'], published: true },
    { slug: 'codebase/other', file: 'other.md', content: '# Keep me', sources: ['b.ts'], published: true }];
  assert.equal(wikiIncrementalSelection(pages, ['a.ts'], false, true).mode, 'full');
  assert.equal(wikiIncrementalSelection(pages, ['new.ts'], true, true).mode, 'full');
  assert.deepEqual(wikiIncrementalSelection(pages, ['a.ts'], true, true).pages, ['codebase/index']);
  await writeFile(path.join(drafts, id + '.json'), JSON.stringify({ schema: 'GitLabWorkspaceProjectWiki/v1', id, origin, revision: 'old', pages, mappingComplete: true }));
  const source = path.join(f.root, 'source'); await mkdir(path.join(source, 'wiki'), { recursive: true });
  const plan = await new ProjectWikiStore(drafts).seedIncremental(id, origin, source, ['a.ts'], true);
  assert.equal(plan.mode, 'incremental'); assert.equal(plan.unchanged[0].file, 'other.md');
  assert.equal(await readFile(path.join(source, 'wiki/other.md'), 'utf8'), '# Keep me');
});
