import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, rm, lstat, symlink } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { CodexTaskStore } from '../../src/codex/taskStore';
import { cleanupTaskStorage, taskCleanupPlan } from '../../src/codex/taskCleanup';
import { validStoredCodexProjection } from '../../src/codex/recordValidation';
import type { CodexTaskRecord } from '../../src/codex/protocol';

const git = (root: string, ...args: string[]) => execFileSync('git', ['-C', root, '-c', 'core.hooksPath=', '-c', 'user.name=Persistence Test', '-c', 'user.email=persistence@test.invalid', ...args], { encoding: 'utf8', windowsHide: true });
async function fixture(t: test.TestContext) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'codex-persistence-')); t.after(() => rm(root, { recursive: true, force: true }));
  const storage = path.join(root, 'storage'), group = path.join(root, 'group'), repository = path.join(group, 'service');
  await mkdir(storage); await mkdir(repository, { recursive: true });
  const id = 'a'.repeat(32), runtimeRoot = path.join(storage, 'codex-group-analysis', id), outputRoot = path.join(group, '_bmad-output', 'specs', id);
  const snapshotPath = path.join(runtimeRoot, 'sources', createHash('sha256').update(repository).digest('hex').slice(0, 16));
  const skill = { name: 'bmad-spec', path: path.join(group, '.agents', 'skills', 'bmad-spec', 'SKILL.md'), fingerprint: 'b'.repeat(64) };
  const additional = { id: 'extra-skill', name: 'domain-context', path: path.join(group, '.agents', 'skills', 'domain-context', 'SKILL.md'), fingerprint: 'c'.repeat(64) };
  const record: CodexTaskRecord = { schema: 'GitLabWorkspaceCodexTask/v3', id: 'group-task', title: 'Group analysis', root: group,
    ownerPid: process.pid, status: 'paused', createdAt: '2026-11-13', updatedAt: '2026-11-13',
    spec: { source: { kind: 'group-analysis', requirement: 'PRIVATE REQUIREMENT', repositoryIds: ['repo-service'], additionalSkillIds: ['extra-skill'], testCommands: [] },
      title: 'Group analysis', root: group, executionRoot: outputRoot, workspaceKey: 'group', environmentKey: 'environment', prompt: 'PRIVATE PROMPT',
      writableRoots: [outputRoot], skill, additionalSkills: [additional], delivery: { mode: 'manual', testCommands: [] },
      groupAnalysis: { id, groupRoot: group, runtimeRoot, outputRoot, repositories: [{ id: 'repo-service', name: 'service', path: repository, sha: 'd'.repeat(40), snapshotPath }] } },
    closing: { reason: 'manual', startedAt: '2026-11-13T01:00:00Z' }, cleanupState: 'complete', ownedThreadIds: ['thread-owned'],
    validation: { cwd: outputRoot, artifactDigest: 'e'.repeat(64), testedAt: '2026-11-13T00:00:00Z',
      commands: [{ command: 'node --test', exitCode: 0, cwd: outputRoot, itemId: 'test-item', startedAtMs: 1, completedAtMs: 2 }] } };
  const store = new CodexTaskStore(path.join(storage, 'codex-tasks'));
  return { root, storage, group, repository, runtimeRoot, outputRoot, snapshotPath, record, store };
}

test('new Group, skill, delivery and validation contracts survive task-store round trips', async t => {
  const f = await fixture(t); assert.equal(validStoredCodexProjection(f.record), true);
  f.record.spec.projectRules = [{ path: path.join(f.group, 'AGENTS.override.md'), fingerprint: 'f'.repeat(64) }];
  f.record.spec.requirementSummary = 'Source requirement';
  await f.store.save(f.record); const records = await f.store.load();
  assert.equal(records.length, 1); assert.deepEqual(records[0].spec.groupAnalysis, f.record.spec.groupAnalysis);
  assert.deepEqual(records[0].validation, f.record.validation); assert.deepEqual(f.store.problems, []);
});

test('Group writable roots require the output and permit only the exact helper runtime', async t => {
  const f = await fixture(t), helperRuntime = path.join(f.group, '.gitlab-workspace', 'runtime');
  for (const roots of [[f.outputRoot], [f.outputRoot, helperRuntime], [helperRuntime, f.outputRoot]]) {
    const record = structuredClone(f.record); record.spec.writableRoots = roots;
    assert.equal(validStoredCodexProjection(record), true);
  }
  for (const roots of [[], [helperRuntime], [f.outputRoot, f.group], [f.outputRoot, path.dirname(helperRuntime)],
    [f.outputRoot, path.join(f.repository, '.git')], [f.outputRoot, path.join(helperRuntime, 'tmp')]]) {
    const record = structuredClone(f.record); record.spec.writableRoots = roots;
    assert.equal(validStoredCodexProjection(record), false, JSON.stringify(roots));
  }
});

test('new persisted contracts reject malformed paths, fingerprints, identities and incomplete receipts', async t => {
  const f = await fixture(t);
  const mutations: Array<(record: CodexTaskRecord) => void> = [
    record => { record.spec.groupAnalysis!.runtimeRoot = path.join(f.storage, 'elsewhere', record.spec.groupAnalysis!.id); },
    record => { record.spec.groupAnalysis!.repositories[0].snapshotPath = f.repository; },
    record => { record.spec.groupAnalysis!.outputRoot = f.group; },
    record => { record.spec.writableRoots = [f.group]; },
    record => { record.spec.source = { ...record.spec.source, repositoryIds: ['../service'] } as typeof record.spec.source; },
    record => { record.spec.additionalSkills![0].fingerprint = 'not-a-digest'; },
    record => { record.spec.skill!.fingerprint = 'not-a-digest'; },
    record => { record.spec.additionalSkills!.push({ ...record.spec.additionalSkills![0] }); },
    record => { record.spec.delivery!.testCommands = ['npm test\nWrite-Output bad']; },
    record => { record.spec.projectRules = [{ path: path.join(f.repository, 'AGENTS.md'), fingerprint: 'f'.repeat(64) }]; },
    record => { record.spec.projectRules = [{ path: path.join(f.group, 'AGENTS.md'), fingerprint: 'invalid' }]; },
    record => { record.spec.projectRules = [{ path: path.join(f.group, 'AGENTS.md'), fingerprint: 'f'.repeat(64) }, { path: path.join(f.group, 'AGENTS.override.md'), fingerprint: 'f'.repeat(64) }]; },
    record => { record.spec.requirementSummary = 'x'.repeat(8001); },
    record => { record.validation!.commands[0].completedAtMs = 0; },
    record => { record.validation!.artifactDigest = 'wrong'; },
    record => { record.closing!.reason = 'unexpected' as 'manual'; },
    record => { record.ownedThreadIds = ['thread-owned', 'thread-owned']; },
    record => { record.delivery = { mode: 'automatic', state: 'published', steps: [{ id: 'commit', kind: 'commit', state: 'confirmed', key: 'f'.repeat(64) }] }; }
  ];
  for (const mutate of mutations) {
    const record = structuredClone(f.record); mutate(record); assert.equal(validStoredCodexProjection(record), false);
  }
  const redirected = structuredClone(f.record);
  redirected.spec.groupAnalysis!.runtimeRoot = path.join(f.root, 'other-storage', 'codex-group-analysis', redirected.spec.groupAnalysis!.id);
  redirected.spec.groupAnalysis!.repositories[0].snapshotPath = path.join(redirected.spec.groupAnalysis!.runtimeRoot, 'sources', path.basename(f.snapshotPath));
  assert.equal(validStoredCodexProjection(redirected), true, 'storage ownership requires the task store, not just a structural check');
  await f.store.save(redirected); assert.equal((await f.store.load()).length, 0); assert.equal(f.store.problems.length, 1);
});

test('Group cleanup removes only its owned runtime while retaining BMAD documents and source repositories', async t => {
  const f = await fixture(t); await mkdir(f.snapshotPath, { recursive: true }); await writeFile(path.join(f.snapshotPath, 'source.txt'), 'snapshot');
  await mkdir(f.outputRoot, { recursive: true }); await writeFile(path.join(f.outputRoot, 'SPEC.md'), 'Final specification');
  await writeFile(path.join(f.repository, 'source.txt'), 'User source');
  const plan = taskCleanupPlan(f.record);
  assert.equal(plan.schema, 'GitLabWorkspaceCodexCleanup/v2');
  assert.ok(!JSON.stringify(plan).includes('PRIVATE')); assert.deepEqual(plan.spec.groupAnalysis?.repositories, []);
  await f.store.save(f.record); await f.store.remove(f.record.id);
  await assert.rejects(lstat(f.runtimeRoot), { code: 'ENOENT' });
  assert.equal(await readFile(path.join(f.outputRoot, 'SPEC.md'), 'utf8'), 'Final specification');
  assert.equal(await readFile(path.join(f.repository, 'source.txt'), 'utf8'), 'User source');
});

test('Group cleanup refuses redirected or foreign runtimes without touching the linked target', async t => {
  const f = await fixture(t); await writeFile(path.join(f.repository, 'keep.txt'), 'Keep');
  await mkdir(path.dirname(f.runtimeRoot), { recursive: true });
  await symlink(f.repository, f.runtimeRoot, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(cleanupTaskStorage(f.storage, taskCleanupPlan(f.record)), /重新導向/);
  assert.equal(await readFile(path.join(f.repository, 'keep.txt'), 'utf8'), 'Keep');
  const plan = taskCleanupPlan(f.record); plan.spec.groupAnalysis!.runtimeRoot = f.repository;
  await assert.rejects(cleanupTaskStorage(f.storage, plan), /不屬於/);
});

test('uncertain delivery and unfinished closing cannot create a deletion fence', async t => {
  const f = await fixture(t);
  f.record.delivery = { mode: 'automatic', state: 'needs-attention', steps: [{ id: 'wiki', kind: 'wiki', state: 'uncertain', key: 'a'.repeat(64) }] };
  await f.store.save(f.record); await assert.rejects(f.store.remove(f.record.id), /交付/);
  assert.equal(await f.store.isDeleted(f.record.id), false);
  f.record.delivery = undefined; f.record.cleanupState = 'needs-attention';
  await f.store.save(f.record); await assert.rejects(f.store.remove(f.record.id), /清理/);
  assert.equal(await f.store.isDeleted(f.record.id), false);
});

test('temporary refs use exact recorded SHA and retain user changes and permanent result branches', async t => {
  const f = await fixture(t); git(f.repository, 'init', '-q', '--initial-branch=main');
  await writeFile(path.join(f.repository, 'source.txt'), 'initial'); git(f.repository, 'add', '.'); git(f.repository, 'commit', '-qm', 'initial');
  const original = git(f.repository, 'rev-parse', 'HEAD').trim();
  await writeFile(path.join(f.repository, 'source.txt'), 'next'); git(f.repository, 'add', '.'); git(f.repository, 'commit', '-qm', 'next');
  const advanced = git(f.repository, 'rev-parse', 'HEAD').trim(), id = 'b'.repeat(32);
  const first = `refs/heads/workbench/mr-2-${id}-base`, changed = `refs/heads/workbench/mr-2-${id}-head`;
  git(f.repository, 'update-ref', first, original); git(f.repository, 'update-ref', changed, advanced); git(f.repository, 'update-ref', 'refs/heads/issue/1-result', advanced);
  const record = structuredClone(f.record); delete record.spec.groupAnalysis; record.spec.source = { kind: 'issue', projectId: 1, issueIid: 1 };
  record.spec.origin = { kind: 'issue', accountKey: 'test', baseUrl: 'https://gitlab.test', projectId: 1, projectPath: 'team/repo', webUrl: 'https://gitlab.test/team/repo',
    repositoryRoot: f.repository, iid: 1, sourceBranch: 'main', sourceSha: original, branch: 'issue/1-result' };
  record.spec.workflow = { id, runtimeRoot: path.join(f.storage, 'codex-workflows', id), remote: 'origin', temporaryRefs: [{ ref: first, sha: original }, { ref: changed, sha: original }] };
  await cleanupTaskStorage(f.storage, taskCleanupPlan(record));
  assert.equal(git(f.repository, 'for-each-ref', '--format=%(refname)', first).trim(), '');
  assert.equal(git(f.repository, 'rev-parse', changed).trim(), advanced);
  assert.equal(git(f.repository, 'rev-parse', 'issue/1-result').trim(), advanced);
  await cleanupTaskStorage(f.storage, taskCleanupPlan(record));
});

test('v1/v2 histories coexist with v3 and a v2 migration preserves then cleans its backup', async t => {
  const f = await fixture(t);
  const legacy = structuredClone(f.record);
  delete legacy.closing; delete legacy.cleanupState; delete legacy.validation; delete legacy.ownedThreadIds;
  delete legacy.spec.groupAnalysis; delete legacy.spec.additionalSkills; delete legacy.spec.delivery; delete legacy.spec.skill!.fingerprint;
  legacy.spec.source = { kind: 'free', repository: f.group, prompt: 'legacy' }; legacy.spec.executionRoot = f.group; legacy.spec.writableRoots = [f.group];
  legacy.id = 'old-v1'; legacy.schema = 'GitLabWorkspaceCodexTask/v1'; await f.store.save(legacy);
  const v2 = structuredClone(legacy); v2.id = 'old-v2'; v2.schema = 'GitLabWorkspaceCodexTask/v2'; await f.store.save(v2);
  const migrated = structuredClone(v2); migrated.schema = 'GitLabWorkspaceCodexTask/v3'; migrated.spec.additionalSkills = []; migrated.spec.source.additionalSkillIds = [];
  await f.store.save(migrated); await f.store.save(f.record);
  assert.deepEqual((await f.store.load()).map(record => record.schema).sort(), ['GitLabWorkspaceCodexTask/v1', 'GitLabWorkspaceCodexTask/v3', 'GitLabWorkspaceCodexTask/v3']);
  const backup = path.join(f.store.directory, 'old-v2.json.v2-backup'); assert.equal(JSON.parse(await readFile(backup, 'utf8')).schema, 'GitLabWorkspaceCodexTask/v2');
  await f.store.remove('old-v2'); await assert.rejects(lstat(backup), { code: 'ENOENT' });
  await writeFile(backup, 'late stale backup'); await f.store.retryCleanup(); await assert.rejects(lstat(backup), { code: 'ENOENT' });
});

test('new contracts fail closed in legacy schema and active old-host records cannot be upgraded in place', async t => {
  const f = await fixture(t), legacy = structuredClone(f.record); legacy.schema = 'GitLabWorkspaceCodexTask/v2';
  assert.equal(validStoredCodexProjection(legacy), false); await assert.rejects(f.store.save(legacy), /v3/);
  legacy.spec.source = { kind: 'free', repository: f.group, prompt: 'legacy' }; legacy.spec.writableRoots = [f.group]; legacy.spec.executionRoot = f.group;
  delete legacy.spec.groupAnalysis; delete legacy.spec.additionalSkills; delete legacy.spec.delivery; delete legacy.spec.skill!.fingerprint;
  delete legacy.closing; delete legacy.cleanupState; delete legacy.ownedThreadIds; delete legacy.validation;
  legacy.status = 'running'; legacy.ownerPid = process.ppid; await f.store.save(legacy);
  const migrated = structuredClone(legacy); migrated.schema = 'GitLabWorkspaceCodexTask/v3';
  await assert.rejects(f.store.save(migrated), /重載/);
  assert.equal((await f.store.load())[0].schema, 'GitLabWorkspaceCodexTask/v2');
  legacy.ownerPid = 2147483647; await f.store.save(legacy);
  migrated.ownerPid = process.pid; migrated.status = 'interrupted';
  await f.store.save(migrated);
  assert.equal((await f.store.load())[0].schema, 'GitLabWorkspaceCodexTask/v3', 'a dead old host must permit durable recovery');
});
