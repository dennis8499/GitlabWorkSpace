import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { CodexAppServer } from '../../src/codex/appServer';
import { CodexBridge, type CodexBridgeOptions } from '../../src/codex/bridge';
import { CodexResultStore } from '../../src/codex/resultStore';
import { CodexTaskStore } from '../../src/codex/taskStore';
import { CodexTaskScheduler } from '../../src/codex/scheduler';
import { CodexRpcError } from '../../src/codex/rpcError';
import type { CodexTaskRecord, CodexTaskSpec } from '../../src/codex/protocol';

const protocolPeer = [path.resolve(__dirname, '../../../test/fixtures/codex-app-server.cjs'), path.resolve(__dirname, '../fixtures/codex-app-server.cjs')].find(existsSync)!;
async function until(predicate: () => boolean, message: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!predicate()) { if (Date.now() >= deadline) throw new Error('Timed out: ' + message); await new Promise(resolve => setTimeout(resolve, 10)); }
}
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
async function fixture(t: test.TestContext, group = false) {
  const parent = await realpath(os.tmpdir()), root = await realpath(await mkdtemp(path.join(parent, 'glw-lifecycle-')));
  const storage = path.join(root, 'storage'), project = path.join(root, 'project'), output = group ? path.join(project, '_bmad-output', 'specs', 'analysis') : project;
  const runtime = path.join(storage, 'codex-group-analysis', 'a'.repeat(32));
  await mkdir(storage); await mkdir(output, { recursive: true }); await writeFile(path.join(output, 'SPEC.md'), '# Retained outcome\n');
  const skill = path.join(project, '.agents', 'skills', 'bmad-spec', 'SKILL.md'); await mkdir(path.dirname(skill), { recursive: true }); await writeFile(skill, 'Offline skill');
  const spec: CodexTaskSpec = { source: { kind: 'free', repository: project, prompt: 'hold' }, title: 'Lifecycle fixture', root: project,
    executionRoot: project, prompt: 'hold', writableRoots: [project], environmentKey: 'fixture', workspaceKey: project };
  if (group) {
    spec.source = { kind: 'group-analysis', requirement: 'Analyse fixture' }; spec.prompt = 'success'; spec.executionRoot = output; spec.writableRoots = [output];
    spec.skill = { name: 'bmad-spec', path: skill };
    spec.groupAnalysis = { id: 'a'.repeat(32), runtimeRoot: runtime, outputRoot: output, groupRoot: project, repositories: [{ id: 'fixture-repo', name: 'fixture', path: project,
      sha: 'a'.repeat(40), snapshotPath: path.join(runtime, 'sources', createHash('sha256').update(project).digest('hex').slice(0, 16)) }] };
    await mkdir(runtime, { recursive: true }); await writeFile(path.join(runtime, 'temporary-source.txt'), 'remove only after sealing');
    await writeFile(path.join(output, 'cards.md'), '# Cards\n');
  }
  const calls: string[] = [], bridges: CodexBridge[] = [], peers: CodexAppServer[] = [];
  let cleanupCount = 0, deleteGate: Promise<void> | undefined, failThread: string | undefined;
  const options: CodexBridgeOptions = {
    storage, version: 'fixture', trusted: () => true, executable: () => '', event: () => {}, openUrl: async () => {}, prepare: async () => spec,
    completed: async () => ({ state: 'ready', summary: 'Verified fixture outcome.', reportPath: path.join(output, 'SPEC.md') }),
    cleanupDrafts: async () => { cleanupCount++; },
    client: async () => {
      const client = new CodexAppServer(spawn(process.execPath, [protocolPeer, project, ''], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] }), 3000);
      peers.push(client); await client.initialize('fixture'); const request = client.request.bind(client);
      client.request = async (method, params = {}, rpcOptions) => {
        calls.push(method + (method === 'thread/delete' ? ':' + params.threadId : ''));
        if (method === 'config/read') return { config: { approval_policy: 'on-request', approvals_reviewer: 'user', sandbox_mode: 'workspace-write' }, origins: {}, layers: [] } as any;
        if (method === 'skills/list') return { data: [{ cwd: project, skills: [{ name: 'bmad-spec', path: skill, enabled: true }] }] } as any;
        if (method === 'thread/delete') {
          const results = await new CodexResultStore(path.join(storage, 'codex-results')).list();
          assert.ok(results.length, 'results must be durable before native conversation deletion');
          await new CodexResultStore(path.join(storage, 'codex-results')).read(results[0].id);
          if (params.threadId === failThread) throw new CodexRpcError('server', method, -32001, 'acknowledged');
          await deleteGate; return {} as any;
        }
        return request(method, params, rpcOptions);
      };
      return { client, version: '0.167.2', executable: 'offline-peer' };
    }
  };
  const make = (overrides: Partial<CodexBridgeOptions> = {}) => {
    const bridge = new CodexBridge({ ...options, ...overrides, scheduler: new CodexTaskScheduler('lifecycle', root) }); bridges.push(bridge); return bridge;
  };
  t.after(async () => {
    for (const bridge of bridges) await bridge.shutdown(); for (const peer of peers) await peer.close();
    assert.equal(path.dirname(root).toLowerCase(), parent.toLowerCase()); await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  });
  const record = (id: string): CodexTaskRecord => ({ schema: 'GitLabWorkspaceCodexTask/v3', id, root: project, title: spec.title, spec,
    ownerPid: process.pid, status: 'paused', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    result: { state: 'ready', summary: 'Retained fixture.', reportPath: path.join(output, 'SPEC.md') } });
  return { root, storage, project, output, runtime, spec, calls, make, record, cleanupCount: () => cleanupCount,
    holdDeletion: (held?: Promise<void>) => { deleteGate = held; }, failDeletion: (thread?: string) => { failThread = thread; } };
}

test('stop and clean deduplicates repeated requests and retains results before deleting its thread', async t => {
  const f = await fixture(t), bridge = f.make(); await bridge.enqueue(f.spec, 'active-task');
  await until(() => !!bridge.list()[0]?.turnId, 'active task');
  const live = (bridge as any).records.get('active-task') as CodexTaskRecord;
  live.result = f.record('active-task').result; await (bridge as any).save(live);
  await bridge.setAutoAccept(live.id, true);
  const gate = deferred(); f.holdDeletion(gate.promise);
  const first = bridge.stopAndClean(live.id, 'manual'), second = bridge.stopAndClean(live.id, 'manual');
  await until(() => f.calls.some(call => call.startsWith('thread/delete:')), 'native deletion after sealing');
  assert.equal(bridge.list()[0].controls?.canAutoAccept, false); gate.resolve(); await Promise.all([first, second]);
  assert.equal(f.calls.filter(call => call.startsWith('thread/delete:')).length, 1);
  assert.equal(f.calls.filter(call => call === 'turn/start').length, 1, 'cleanup must not dispatch another turn');
  assert.equal(f.cleanupCount(), 1); assert.equal(bridge.list()[0].retention, 'results-only');
  await assert.rejects(readFile(path.join(f.storage, 'codex-tasks', live.id + '.json')), { code: 'ENOENT' });
  const result = await bridge.resultManifest(live.id); assert.ok(result.artifacts.some(artifact => artifact.path === 'reports/SPEC.md'));
  assert.equal(JSON.stringify(result).includes('thread-'), false);
});

test('completed Group tasks seal their documents and remove only managed analysis runtime', async t => {
  const f = await fixture(t, true), bridge = f.make(); await bridge.enqueue(f.spec, 'group-task');
  await until(() => !(bridge as any).records.has('group-task') && bridge.list()[0]?.retention === 'results-only', 'automatic result retention');
  assert.equal(bridge.list()[0].status, 'completed'); assert.equal(f.calls.filter(call => call === 'turn/start').length, 1);
  assert.equal(await readFile(path.join(f.output, 'SPEC.md'), 'utf8'), '# Retained outcome\n', 'permanent Group documents remain user assets');
  await assert.rejects(lstat(f.runtime), { code: 'ENOENT' });
  const result = await bridge.resultManifest('group-task'); assert.ok(result.artifacts.some(artifact => artifact.path === 'documents/cards.md'));
});

test('a closing record replays cleanup after restart using its sealed results without its old repository', async t => {
  const f = await fixture(t), record = f.record('recover-closing');
  record.closing = { reason: 'manual', startedAt: new Date().toISOString() }; record.cleanupState = 'running'; record.ownedThreadIds = [];
  await new CodexResultStore(path.join(f.storage, 'codex-results')).seal(record, [], 'manual');
  await new CodexTaskStore(path.join(f.storage, 'codex-tasks')).save(record); await rm(f.project, { recursive: true, force: true });
  const bridge = f.make({ prepare: async () => { throw new Error('recovery must not prepare a new execution'); }, client: async () => { throw new Error('no owned threads remain'); } });
  await bridge.initialize(); await until(() => !(bridge as any).records.has(record.id) && bridge.list()[0]?.retention === 'results-only', 'closing replay after archive');
  const manifest = await bridge.resultManifest(record.id); assert.equal(manifest.id, record.id);
  const exported = path.join(f.root, 'recovered-export'); await bridge.results.exportTo(record.id, exported);
  assert.equal(await readFile(path.join(exported, 'reports', 'SPEC.md'), 'utf8'), '# Retained outcome\n');
  assert.equal(f.cleanupCount(), 1); assert.deepEqual(f.calls, []);
});

test('confirmed native deletions are checkpointed and unknown errors do not discard remaining ownership', async t => {
  const f = await fixture(t), record = f.record('partial-delete'); record.ownedThreadIds = ['owned-first', 'owned-second'];
  await new CodexTaskStore(path.join(f.storage, 'codex-tasks')).save(record);
  f.failDeletion('owned-second'); const first = f.make(); await first.initialize();
  await assert.rejects(first.stopAndClean(record.id, 'deleted'), /失敗|核對/);
  const saved = (await new CodexTaskStore(path.join(f.storage, 'codex-tasks')).load()).find(value => value.id === record.id)!;
  assert.deepEqual(saved.ownedThreadIds, ['owned-second']); assert.equal(saved.cleanupState, 'needs-attention');
  assert.ok(await lstat(path.join(f.project, 'SPEC.md'))); await first.shutdown();
  f.failDeletion(); const second = f.make(); await second.initialize();
  await until(() => !(second as any).records.has(record.id) && second.list()[0]?.retention === 'results-only', 'remaining deletion replay');
  assert.deepEqual(f.calls.filter(call => call.startsWith('thread/delete:')), ['thread/delete:owned-first', 'thread/delete:owned-second', 'thread/delete:owned-second']);
});

test('effective execution settings are resolved at the actual cwd and preserve read-only and managed approval routing', async t => {
  const f = await fixture(t), bridge = f.make(), calls: Array<{ method: string; params: any }> = [];
  const client = { request: async (method: string, params: any) => { calls.push({ method, params }); return {
    config: { sandbox_mode: 'read-only', approval_policy: 'untrusted', approvals_reviewer: 'guardian_subagent' } }; } } as unknown as CodexAppServer;
  const settings = await (bridge as any).executionSettings(client, f.output, [f.project], new AbortController().signal);
  assert.deepEqual(calls, [{ method: 'config/read', params: { cwd: f.output, includeLayers: false } }]);
  assert.deepEqual(settings, { sandboxPolicy: { type: 'readOnly', networkAccess: false }, approvalPolicy: 'untrusted', approvalsReviewer: 'guardian_subagent' });
  assert.equal(f.calls.some(call => ['command/exec', 'process/spawn', 'thread/shellCommand'].includes(call)), false);
});

test('native approval choices cannot be forged and explicitly advertised session grants preserve their exact scope', async t => {
  const f = await fixture(t), record = f.record('approval-contract'); record.threadId = 'owned-approval-thread'; record.turnId = 'approval-turn';
  await new CodexTaskStore(path.join(f.storage, 'codex-tasks')).save(record);
  const bridge = f.make(); await bridge.initialize();
  const stored = (bridge as any).records.get(record.id) as CodexTaskRecord, responses: unknown[] = [];
  const client = { respond: (_id: unknown, value: unknown) => responses.push(value), reject: () => assert.fail('valid interaction rejected') } as unknown as CodexAppServer;
  const active = { record: stored, client, abort: new AbortController(), settled: Promise.resolve(), settle: () => {} };
  (bridge as any).executions.set(record.id, active); let sequence = 0;
  const request = (method: string, params: Record<string, unknown>) => {
    const id = ++sequence;
    (bridge as any).receiveInteraction(stored, client, { id, method, params: { threadId: stored.threadId, turnId: stored.turnId, ...params } });
    return [...(bridge as any).interactions.values()].find((value: any) => value.request.id === id).projection.id as string;
  };
  try {
    let interaction = request('item/commandExecution/requestApproval', { command: 'npm.cmd test', cwd: f.project, availableDecisions: ['decline', 'cancel'] });
    await assert.rejects(bridge.answer(record.id, interaction, { decision: 'accept' }), /原生提供/);
    await assert.rejects(bridge.answer(record.id, interaction, { decision: 'acceptForSession' }), /原生提供/);
    assert.equal(responses.length, 0); await bridge.answer(record.id, interaction, { decision: 'decline' });
    interaction = request('item/commandExecution/requestApproval', { command: 'npm.cmd test', cwd: f.project, availableDecisions: ['acceptForSession', 'decline'] });
    await bridge.answer(record.id, interaction, { decision: 'acceptForSession' });
    assert.deepEqual(responses.at(-1), { decision: 'acceptForSession' });
    const amendment = ['npm.cmd', 'test'];
    interaction = request('item/commandExecution/requestApproval', { command: 'npm.cmd test', cwd: f.project,
      availableDecisions: [{ acceptWithExecpolicyAmendment: { execpolicy_amendment: amendment } }, 'decline'] });
    await assert.rejects(bridge.answer(record.id, interaction, { decision: 'accept', execpolicyAmendment: ['git', 'push'] }), /原生提供/);
    await bridge.answer(record.id, interaction, { decision: 'accept', execpolicyAmendment: amendment });
    assert.deepEqual(responses.at(-1), { decision: { acceptWithExecpolicyAmendment: { execpolicy_amendment: amendment } } });
    interaction = request('item/permissions/requestApproval', { permissions: { network: { enabled: true } }, cwd: f.project });
    await assert.rejects(bridge.answer(record.id, interaction, { decision: 'accept', scope: 'always' as any }), /範圍/);
    await bridge.answer(record.id, interaction, { decision: 'accept', scope: 'session' });
    assert.deepEqual(responses.at(-1), { permissions: { network: { enabled: true } }, scope: 'session' });
    interaction = request('item/tool/requestUserInput', { questions: [{ id: 'one', question: 'Choose one' }] });
    await assert.rejects(bridge.answer(record.id, interaction, { decision: 'acceptForSession' }), /範圍/);
    await bridge.answer(record.id, interaction, { decision: 'accept', answers: { one: 'Answer' } });
    assert.deepEqual(responses.at(-1), { answers: { one: { answers: ['Answer'] } } });
  } finally { (bridge as any).executions.delete(record.id); }
});

test('automatic finalization keeps unfinished goals, queued input and unanswered questions resumable', async t => {
  const f = await fixture(t), bridge = f.make(), records: CodexTaskRecord[] = [];
  for (const state of ['active', 'paused', 'blocked', 'usageLimited', 'budgetLimited']) {
    const record = f.record('goal-' + state.toLowerCase()); record.status = 'completed'; record.goal = { objective: 'Unfinished work', status: state }; records.push(record);
  }
  const queued = f.record('queued-input'); queued.status = 'completed'; queued.queuedMessages = [{ id: 'message', text: 'Pending input', state: 'queued' }]; records.push(queued);
  const question = f.record('pending-question'); question.status = 'completed'; records.push(question);
  const store = new CodexTaskStore(path.join(f.storage, 'codex-tasks')); for (const record of records) await store.save(record);
  await bridge.initialize();
  (bridge as any).interactions.set('question', { projection: { taskId: question.id, kind: 'questions' } });
  for (const record of records) await (bridge as any).sealAndClean((bridge as any).records.get(record.id), 'completed');
  assert.equal((await store.load()).length, records.length); assert.deepEqual(await bridge.results.list(), []);
  assert.deepEqual(f.calls, []); assert.equal(f.cleanupCount(), 0);
  (bridge as any).interactions.clear();
});

test('final tests use native command evidence and a changed source digest prevents automatic delivery', async t => {
  for (const mutate of [false, true]) {
    const f = await fixture(t), git = (...args: string[]) => execFileSync('git', ['-C', f.project, '-c', 'core.hooksPath=', '-c', 'user.name=Validation Test',
      '-c', 'user.email=validation@test.invalid', '-c', 'commit.gpgsign=false', ...args], { encoding: 'utf8', windowsHide: true }).trim();
    git('init', '-q', '--initial-branch=main'); git('config', 'core.autocrlf', 'false'); await writeFile(path.join(f.project, 'main.ts'), 'base\n');
    git('add', '.'); git('commit', '-qm', 'baseline'); const base = git('rev-parse', 'HEAD'); await writeFile(path.join(f.project, 'main.ts'), 'candidate\n');
    f.spec.source = { kind: 'issue', projectId: 1, issueIid: 1 }; f.spec.prompt = 'success';
    f.spec.skill = { name: 'bmad-spec', path: path.join(f.project, '.agents', 'skills', 'bmad-spec', 'SKILL.md') };
    f.spec.origin = { kind: 'issue', accountKey: 'fixture', baseUrl: 'https://example.test', projectId: 1, iid: 1, projectPath: 'g/p', webUrl: 'https://example.test/g/p',
      repositoryRoot: f.project, sourceBranch: 'main', sourceSha: base, branch: 'main' };
    f.spec.workflow = { id: 'b'.repeat(32), runtimeRoot: path.join(f.storage, 'codex-workflows', 'b'.repeat(32)), remote: 'origin' };
    f.spec.delivery = { mode: 'automatic', testCommands: ['npm.cmd test'] };
    let delivered = 0, evidence: CodexTaskRecord['validation'];
    const bridge = f.make({ completed: async () => ({ state: 'ready', summary: 'Candidate ready.', files: ['main.ts'] }),
      deliver: async (record, checkpoint) => {
        delivered++; evidence = structuredClone(record.validation);
        await checkpoint({ mode: 'automatic', state: 'published', deliveredCommitSha: base, steps: [{ id: 'push', kind: 'push', key: 'a'.repeat(64), state: 'confirmed', sha: base }] });
        return { state: 'published', summary: 'Fixture publication confirmed.', files: ['main.ts'] };
      } });
    const options = (bridge as any).options as CodexBridgeOptions, originalClient = options.client!;
    options.client = async root => {
      const connection = await originalClient(root), request = connection.client.request.bind(connection.client);
      connection.client.request = async (method, params = {}, rpcOptions) => {
        if (method === 'turn/start' && String((params.input as any)?.[0]?.text).startsWith('執行最後驗證')) {
          f.calls.push('validation/turn/start');
          setTimeout(() => { void (async () => {
            if (mutate) await writeFile(path.join(f.project, 'main.ts'), 'changed after candidate digest\n');
            const threadId = params.threadId, turnId = 'native-validation';
            connection.client.onNotification({ method: 'turn/started', params: { threadId, turn: { id: turnId } } });
            connection.client.onNotification({ method: 'item/completed', params: { threadId, turnId, item: { id: 'native-test', type: 'commandExecution',
              command: 'npm.cmd test', cwd: f.project, source: 'agent', status: 'completed', exitCode: 0, startedAtMs: Date.now(), completedAtMs: Date.now() } } });
            connection.client.onNotification({ method: 'turn/completed', params: { threadId, turn: { id: turnId, status: 'completed', items: [] } } });
          })(); }, 0);
          return { turn: { id: 'native-validation', status: 'inProgress', items: [] } } as any;
        }
        return request(method, params, rpcOptions);
      };
      return connection;
    };
    const id = mutate ? 'changed-validation' : 'verified-validation'; await bridge.enqueue(f.spec, id);
    await until(() => mutate ? bridge.list().find(task => task.id === id)?.result?.state === 'needs-work' : !(bridge as any).records.has(id) && bridge.list().find(task => task.id === id)?.retention === 'results-only', 'native validation result')
      .catch(error => { throw new Error(String(error) + ': ' + JSON.stringify({ tasks: bridge.list(), calls: f.calls, problems: (bridge as any).store.problems })); });
    assert.equal(f.calls.filter(call => call === 'validation/turn/start').length, 1);
    assert.equal(f.calls.some(call => ['command/exec', 'process/spawn', 'thread/shellCommand'].includes(call)), false);
    assert.equal(delivered, mutate ? 0 : 1);
    if (!mutate) { assert.equal(evidence?.cwd, f.project); assert.equal(evidence?.commands[0].itemId, 'native-test'); assert.equal(evidence?.commands[0].exitCode, 0); }
    else { assert.match(bridge.list().find(task => task.id === id)!.result!.summary, /驗證|來源|提交/); assert.equal((await new CodexTaskStore(path.join(f.storage, 'codex-tasks')).load()).find(task => task.id === id)?.validation, undefined); }
  }
});
