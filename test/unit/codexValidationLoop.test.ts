import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync, spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { CodexBridge } from '../../src/codex/bridge';
import { CodexAppServer } from '../../src/codex/appServer';
import { CodexTaskScheduler } from '../../src/codex/scheduler';
import { CodexTaskStore } from '../../src/codex/taskStore';
import { collectIssueResult, implementationDigest } from '../../src/codex/projectWorkflows';
import { createRequirementSnapshot, freezeVerificationProfile, validValidationAttempts } from '../../src/codex/workContext';
import type { CodexTaskRecord, CodexTaskSpec } from '../../src/codex/protocol';

// The peer stands in for model decisions, but checks really execute in Node.
// It speaks the same JSONL command/turn events that validateFinal must inspect.
const peerSource = String.raw`
const fs = require('node:fs'), path = require('node:path'), cp = require('node:child_process');
const root = process.argv[2], repo = process.argv[3], mode = process.argv[4];
const stateFile = path.join(repo, '.git', 'validation-loop-state.json');
const send = value => process.stdout.write(JSON.stringify(value) + '\n');
const notify = (method, params) => send({ method, params });
let state = { sequence: 0, implementations: 0, validations: 0 };
try { state = JSON.parse(fs.readFileSync(stateFile, 'utf8')); } catch {}
const save = () => fs.writeFileSync(stateFile, JSON.stringify(state));
require('node:readline').createInterface({ input: process.stdin }).on('line', line => {
 const { id, method, params = {} } = JSON.parse(line);
 if (method === 'initialized') return;
 const result = value => send({ id, result: value });
 if (method === 'initialize') return result({ userAgent: 'validation-loop-peer', platformFamily: 'windows' });
 if (method === 'account/read') return result({ account: { type: 'chatgpt' }, requiresOpenaiAuth: true });
 if (method === 'windowsSandbox/readiness') return result({ status: 'ready' });
 if (method === 'configRequirements/read') return result({ requirements: null });
 if (method === 'config/read') return result({ config: { sandbox_mode: 'workspace-write', approval_policy: 'on-request' }, origins: {} });
 if (method === 'skills/extraRoots/set') return result({});
 if (method === 'skills/list') return result({ data: [{ cwd: root, skills: [{ name: 'codebase-wiki', enabled: true, path: path.join(root, '.agents', 'skills', 'codebase-wiki', 'SKILL.md') }] }] });
 if (method === 'thread/start') return result({ thread: { id: 'validation-thread' } });
 if (method === 'thread/resume') return result({ thread: { id: params.threadId } });
 if (method === 'thread/turns/list') return result({ data: [{ id: 'saved-turn', status: 'completed', items: [{ id: 'saved-message', type: 'agentMessage', text: 'Preserved local implementation.' }] }], nextCursor: null });
 if (method === 'thread/delete') return result({});
 if (method === 'turn/start') {
  const active = { threadId: params.threadId, turnId: 'turn-' + ++state.sequence };
  result({ turn: { id: active.turnId, status: 'inProgress', items: [] } });
  notify('turn/started', { threadId: active.threadId, turn: { id: active.turnId } });
  if (params.input[0].text.startsWith('執行最後驗證。')) {
   state.validations++;
   if (mode === 'exit-during-check') {
    save(); notify('item/started', { ...active, item: { id: 'unfinished-check', type: 'commandExecution', command: 'node --test checks.test.cjs', cwd: repo } });
    process.exit(7);
   }
   const startedAtMs = Date.now();
   // A nested verification process is independent of the parent unit runner.
   // Inheriting its private context makes Node skip every test and exit zero.
   const checkEnv = { ...process.env }; delete checkEnv.NODE_TEST_CONTEXT;
   const checked = mode === 'blocked' ? cp.spawnSync('missing-validation-loop-checker', ['--test'], { cwd: repo, env: checkEnv, encoding: 'utf8', windowsHide: true })
    : cp.spawnSync(process.execPath, ['--test', 'checks.test.cjs'], { cwd: repo, env: checkEnv, encoding: 'utf8', windowsHide: true });
   const exitCode = checked.error ? 127 : checked.status;
   notify('item/completed', { ...active, item: { id: 'check-' + state.validations, type: 'commandExecution',
    command: mode === 'blocked' ? 'missing-validation-loop-checker --test' : 'node --test checks.test.cjs', cwd: repo, exitCode,
    startedAtMs, completedAtMs: Date.now(), aggregatedOutput: checked.error ? 'command not found: missing-validation-loop-checker' : (checked.stdout || '') + (checked.stderr || '') } });
  } else {
   state.implementations++;
   if (mode === 'spec-first' && state.implementations === 1) {
    fs.mkdirSync(path.join(repo, '_bmad-output'), { recursive: true });
    fs.writeFileSync(path.join(repo, '_bmad-output', 'SPEC.md'), '# Requirement\nReturn the expected source value.\n');
   } else {
    const content = mode === 'spec-first' ? 'fixed' : mode === 'changing' ? 'broken-' + state.implementations : mode === 'stalled' ? 'broken' : state.implementations === 1 ? 'broken' : 'fixed';
    fs.writeFileSync(path.join(repo, 'source.txt'), content);
   }
   notify('item/completed', { ...active, item: { id: 'implementation-' + state.implementations, type: 'agentMessage', text: 'Local implementation saved.' } });
  }
  save(); notify('turn/completed', { threadId: active.threadId, turn: { id: active.turnId, status: 'completed', items: [], error: null } }); return;
 }
 send({ id, error: { code: -32601, message: 'unsupported fixture method' } });
}).once('close', () => process.exit(0));
`;

async function until(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 20_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Validation loop did not settle');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}
async function fixture(t: test.TestContext, mode = 'repair', commands?: string[]) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'codex-validation-loop-'))), repo = path.join(root, 'repo'), storage = path.join(root, 'storage');
  await mkdir(repo); await mkdir(storage);
  const git = (...args: string[]) => execFileSync('git', ['-C', repo, '-c', 'core.hooksPath=', '-c', 'user.name=Validation Test', '-c', 'user.email=validation@test.invalid', ...args], { windowsHide: true, encoding: 'utf8' }).trim();
  git('init', '-q', '--initial-branch=main'); await writeFile(path.join(repo, 'source.txt'), 'baseline');
  await writeFile(path.join(repo, 'checks.test.cjs'), "const assert = require('node:assert/strict'); const fs = require('node:fs'); require('node:test')('actual artifact satisfies requirement', () => assert.equal(fs.readFileSync('source.txt', 'utf8'), 'fixed'));\n");
  git('add', '.'); git('commit', '-qm', 'baseline'); const sourceSha = git('rev-parse', 'HEAD'), branch = 'issue/2-local-repair'; git('checkout', '-qb', branch);
  const skill = path.join(root, '.agents', 'skills', 'codebase-wiki', 'SKILL.md'); await mkdir(path.dirname(skill), { recursive: true }); await writeFile(skill, 'Offline fixture skill');
  const peer = path.join(root, 'peer.cjs'); await writeFile(peer, peerSource);
  const checks = commands ?? [mode === 'blocked' ? 'missing-validation-loop-checker --test' : 'node --test checks.test.cjs'];
  const spec: CodexTaskSpec = { root, executionRoot: repo, title: 'Validate local repair', prompt: 'Implement the source requirement.', environmentKey: 'validation-loop', workspaceKey: root,
    source: { kind: 'issue', projectId: 1, issueIid: 2 }, skill: { name: 'codebase-wiki', path: skill }, writableRoots: [repo],
    origin: { kind: 'issue', accountKey: 'offline-account', baseUrl: 'https://gitlab.invalid', projectId: 1, iid: 2, projectPath: 'team/repo',
      repositoryRoot: repo, webUrl: 'https://gitlab.invalid/team/repo/-/issues/2', sourceBranch: 'main', sourceSha, branch },
    workflow: { id: 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa', runtimeRoot: path.join(storage, 'runtime'), remote: 'origin' }, delivery: { mode: 'manual', testCommands: checks },
    workContext: { schema: 'GitLabWorkspaceWorkContext/v1', requirement: createRequirementSnapshot({ source: { kind: 'issue', identity: 'offline-issue-2' }, title: 'Source requirement', description: 'Source must read fixed.' }),
      verification: freezeVerificationProfile({ kind: 'code', commands: checks }) } };
  const bridges: CodexBridge[] = []; let deliveries = 0;
  const make = () => {
    const bridge = new CodexBridge({ storage, version: 'test', executable: () => '', trusted: () => true, event: () => {}, openUrl: async () => {},
      scheduler: new CodexTaskScheduler('validation-loop', path.join(root, 'scheduler')), prepare: async () => spec,
      completed: async (prepared, _id, outputs) => collectIssueResult(prepared, outputs),
      deliver: async record => { deliveries++; return record.result!; },
      client: async () => { const client = new CodexAppServer(spawn(process.execPath, [peer, root, repo, mode], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] }), 5000);
        await client.initialize('test'); return { client, version: '0.165.0', executable: 'offline-validation-peer' }; }
    }); bridges.push(bridge); return bridge;
  };
  t.after(async () => { for (const bridge of bridges) await bridge.shutdown(); await rm(root, { recursive: true, force: true }); });
  const record = async (): Promise<CodexTaskRecord> => {
    const store = new CodexTaskStore(path.join(storage, 'codex-tasks')), records = await store.load();
    assert.deepEqual(store.problems, [], 'durable attempts remain valid task records'); assert.equal(records.length, 1); return records[0];
  };
  const state = async () => JSON.parse(await readFile(path.join(repo, '.git', 'validation-loop-state.json'), 'utf8')) as { sequence: number; implementations: number; validations: number };
  const bridge = make();
  return { root, repo, spec, bridge, make, record, state, deliveries: () => deliveries };
}
test('native final check failure resumes implementation and binds passing evidence to the repaired artifact', async t => {
  const f = await fixture(t); await f.bridge.enqueue(f.spec, 'repair-loop'); await until(() => f.bridge.list()[0]?.status === 'completed');
  const record = await f.record();
  const diagnostic = JSON.stringify({ error: record.error, result: record.result, attempts: record.validationAttempts });
  assert.equal(record.result?.state, 'ready', diagnostic); assert.equal(record.implementationCycles, 2, diagnostic);
  assert.deepEqual(record.validationAttempts?.map(attempt => attempt.state), ['failed', 'passed']);
  assert.equal(record.validationAttempts![0].commands[0].exitCode, 1); assert.equal(record.validationAttempts![1].commands[0].exitCode, 0);
  assert.notEqual(record.validationAttempts![0].artifactDigest, record.validationAttempts![1].artifactDigest);
  assert.equal(record.validation?.artifactDigest, await implementationDigest(f.spec, ['source.txt']));
  assert.equal(validValidationAttempts(record.validationAttempts), true); assert.equal(record.lease?.released, true);
  assert.deepEqual(await f.state(), { sequence: 4, implementations: 2, validations: 2 }); assert.equal(f.deliveries(), 0);
});
test('a specification-only first cycle continues Build before running final verification', async t => {
  const f = await fixture(t, 'spec-first'); await f.bridge.enqueue(f.spec, 'spec-first-loop'); await until(() => f.bridge.list()[0]?.status === 'completed');
  const record = await f.record(), diagnostic = JSON.stringify({ error: record.error, result: record.result, attempts: record.validationAttempts });
  assert.equal(record.result?.state, 'ready', diagnostic); assert.equal(record.implementationCycles, 2, diagnostic);
  assert.deepEqual(record.validationAttempts?.map(attempt => ({ state: attempt.state, cycle: attempt.cycle })), [{ state: 'passed', cycle: 2 }]);
  assert.equal(record.validation?.commands[0]?.exitCode, 0); assert.ok(record.result?.files?.includes('source.txt'));
  assert.ok(record.result?.files?.includes('_bmad-output/SPEC.md'));
  assert.equal(await readFile(path.join(f.repo, 'source.txt'), 'utf8'), 'fixed');
  assert.deepEqual(await f.state(), { sequence: 3, implementations: 2, validations: 1 }); assert.equal(f.deliveries(), 0);
});
test('native blocked check stops after one implementation and preserves failed command evidence', async t => {
  const f = await fixture(t, 'blocked'); await f.bridge.enqueue(f.spec, 'blocked-loop'); await until(() => f.bridge.list()[0]?.status === 'completed');
  const record = await f.record();
  assert.equal(record.result?.state, 'needs-work'); assert.equal(record.implementationCycles, 1); assert.equal(record.validation, undefined);
  assert.equal(record.validationAttempts?.length, 1); assert.equal(record.validationAttempts![0].state, 'blocked'); assert.equal(record.validationAttempts![0].commands[0].exitCode, 127);
  assert.deepEqual(await f.state(), { sequence: 2, implementations: 1, validations: 1 }); assert.equal(f.deliveries(), 0);
});
test('three local validation cycles remain exhausted after bridge restart and resume', async t => {
  const f = await fixture(t, 'changing'); await f.bridge.enqueue(f.spec, 'exhausted-loop'); await until(() => f.bridge.list()[0]?.status === 'completed');
  const before = await f.record(); assert.equal(before.implementationCycles, 3, JSON.stringify({ error: before.error, result: before.result, attempts: before.validationAttempts })); assert.equal(before.validationAttempts?.length, 3);
  assert.deepEqual(await f.state(), { sequence: 6, implementations: 3, validations: 3 });
  await f.bridge.shutdown(); const resumed = f.make(); await resumed.initialize(); await resumed.resume('exhausted-loop');
  await until(() => ['completed', 'failed'].includes(resumed.list()[0]?.status ?? ''));
  const after = await f.record(); assert.equal(after.implementationCycles, 3); assert.equal(after.validationAttempts?.length, 3);
  assert.deepEqual(await f.state(), { sequence: 6, implementations: 3, validations: 3 }); assert.match(after.error ?? after.result?.summary ?? '', /三輪/); assert.equal(f.deliveries(), 0);
});
test('missing approved checks stop without dispatching a validation turn', async t => {
  const f = await fixture(t, 'repair', []); await f.bridge.enqueue(f.spec, 'no-checks'); await until(() => f.bridge.list()[0]?.status === 'completed');
  const record = await f.record(); assert.equal(record.validationAttempts?.length, 1); assert.equal(record.validationAttempts![0].state, 'blocked');
  assert.deepEqual(record.validationAttempts![0].commands, []); assert.equal(record.validation, undefined);
  assert.deepEqual(await f.state(), { sequence: 1, implementations: 1, validations: 0 }); assert.equal(f.deliveries(), 0);
});
test('an unchanged native validation failure stops before exhausting the repair budget', async t => {
  const f = await fixture(t, 'stalled'); await f.bridge.enqueue(f.spec, 'stalled-loop'); await until(() => f.bridge.list()[0]?.status === 'completed');
  const record = await f.record(); assert.equal(record.implementationCycles, 2, JSON.stringify({ error: record.error, result: record.result, attempts: record.validationAttempts })); assert.equal(record.validationAttempts?.length, 2);
  assert.equal(record.validationAttempts![0].artifactDigest, record.validationAttempts![1].artifactDigest); assert.match(record.result?.summary ?? '', /沒有進展/);
  assert.deepEqual(await f.state(), { sequence: 4, implementations: 2, validations: 2 }); assert.equal(f.deliveries(), 0);
});
test('a server exit during final validation preserves an interrupted attempt without another model turn', async t => {
  const f = await fixture(t, 'exit-during-check'); await f.bridge.enqueue(f.spec, 'exited-loop');
  await until(() => f.bridge.list()[0]?.status === 'uncertain' && !f.bridge.list()[0]?.progress?.phase);
  const record = await f.record(); assert.equal(record.implementationCycles, 1); assert.equal(record.validation, undefined);
  assert.equal(record.validationAttempts?.length, 1); assert.equal(record.validationAttempts![0].state, 'interrupted');
  assert.ok(record.validationAttempts![0].completedAt); assert.equal(record.validationAttempts![0].commands[0].exitCode, undefined);
  assert.deepEqual(await f.state(), { sequence: 2, implementations: 1, validations: 1 }); assert.equal(f.deliveries(), 0);
});
