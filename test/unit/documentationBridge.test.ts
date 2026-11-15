import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type * as VSCode from 'vscode';
import { CodexBridge } from '../../src/codex/bridge';
import { CodexTaskStore } from '../../src/codex/taskStore';
import { CodexHostActions, type CodexHostActionOptions } from '../../src/codex/hostActions';
import { createRequirementSnapshot, freezeVerificationProfile } from '../../src/codex/workContext';
import type { CodexTaskRecord } from '../../src/codex/protocol';

function git(root: string, ...args: string[]): string {
  return execFileSync('git', ['-C', root, '-c', 'core.hooksPath=', '-c', 'user.name=Documentation Test', '-c', 'user.email=docs@test.invalid', '-c', 'commit.gpgsign=false', ...args],
    { encoding: 'utf8', windowsHide: true, env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_NO_LAZY_FETCH: '1' } }).trim();
}
async function fixture(t: test.TestContext, criteria = ['Document selected issues']) {
  const parent = await realpath(os.tmpdir()), root = await realpath(await mkdtemp(path.join(parent, 'glw-docs-bridge-'))), repo = path.join(root, 'repo'), storage = path.join(root, 'storage');
  await mkdir(repo); const skill = path.join(root, 'SKILL.md'); await writeFile(skill, 'Documentation task');
  git(repo, 'init', '-q', '--initial-branch=main'); await writeFile(path.join(repo, 'README.md'), '# Baseline\n'); git(repo, 'add', '.'); git(repo, 'commit', '-qm', 'baseline');
  const sha = git(repo, 'rev-parse', 'HEAD'); await writeFile(path.join(repo, 'README.md'), '# Improved issue guide\n');
  const record: CodexTaskRecord = { schema: 'GitLabWorkspaceCodexTask/v3', id: 'task-docs', title: 'Document issues', root: repo,
    status: 'paused', ownerPid: process.pid, createdAt: '2026-11-15T01:00:00.000Z', updatedAt: '2026-11-15T01:00:00.000Z',
    result: { state: 'needs-work', summary: 'Documentation awaits manual review', files: ['README.md'] },
    spec: { source: { kind: 'issue', projectId: 1, issueIid: 2 }, root: repo, executionRoot: repo, title: 'Document issues', prompt: 'Update documentation',
      writableRoots: [repo], workspaceKey: repo, environmentKey: 'fixture', skill: { name: 'bmad-build', path: skill },
      origin: { kind: 'issue', accountKey: 'fixture', baseUrl: 'https://gitlab.test', projectId: 1, projectPath: 'team/repo', webUrl: 'https://gitlab.test/team/repo/-/issues/2',
        repositoryRoot: repo, iid: 2, sourceBranch: 'main', sourceSha: sha, branch: 'main' },
      workflow: { id: 'a'.repeat(32), runtimeRoot: path.join(storage, 'codex-workflows', 'a'.repeat(32)), remote: 'origin' },
      workContext: { schema: 'GitLabWorkspaceWorkContext/v1', requirement: createRequirementSnapshot({ source: { kind: 'issue', identity: 'issue:2' }, title: 'Document issues', description: '', criteria }),
        verification: freezeVerificationProfile({ kind: 'docs', commands: [] }) } } };
  const store = new CodexTaskStore(path.join(storage, 'codex-tasks')); await store.save(record);
  let modelCalls = 0, deliveries = 0;
  const bridge = new CodexBridge({ storage, version: 'test', executable: () => '', trusted: () => true, prepare: async () => { modelCalls++; throw new Error('Must not prepare a model'); },
    client: async () => { modelCalls++; throw new Error('Must not run a model'); }, deliver: async () => { deliveries++; throw new Error('Must not deliver to GitLab'); }, event: () => {}, openUrl: async () => {} });
  await bridge.initialize(); assert.equal(bridge.list().length, 1);
  t.after(async () => { await bridge.shutdown(); assert.equal(path.dirname(root).toLowerCase(), parent.toLowerCase()); await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); });
  const current = () => (bridge as unknown as { records: Map<string, CodexTaskRecord> }).records.get(record.id)!;
  return { root, repo, record, bridge, store, current, modelCalls: () => modelCalls, deliveries: () => deliveries };
}

test('Bridge manual documentation acceptance persists exact human checks and source digests without model or GitLab work', async t => {
  const f = await fixture(t), preview = await f.bridge.documentationPreview(f.record.id);
  assert.deepEqual(preview.checks, ['Document selected issues']); await f.bridge.confirmDocumentation(f.record.id, preview.artifactDigest, preview.checks);
  const saved = (await f.store.load([f.record.id]))[0]; assert.equal(saved.result!.state, 'ready');
  assert.deepEqual(saved.validation!.manual!.checks, preview.checks); assert.equal(saved.validation!.artifactDigest, preview.artifactDigest);
  assert.equal(saved.validation!.requirementDigest, saved.spec.workContext!.requirement.contentDigest); assert.deepEqual(saved.validation!.commands, []);
  assert.match(saved.validation!.profileDigest!, /^[a-f0-9]{64}$/); assert.equal(f.modelCalls(), 0); assert.equal(f.deliveries(), 0);
  assert.equal(git(f.repo, 'rev-list', '--count', 'HEAD'), '1'); assert.equal(await readFile(path.join(f.repo, 'README.md'), 'utf8'), '# Improved issue guide\n');
});

test('Bridge document acceptance rejects changed files changed requirements and omitted human checks', async t => {
  const f = await fixture(t), preview = await f.bridge.documentationPreview(f.record.id);
  await writeFile(path.join(f.repo, 'README.md'), '# Changed after preview\n');
  await assert.rejects(f.bridge.confirmDocumentation(f.record.id, preview.artifactDigest, preview.checks), /文件或驗收項目已變更/);
  const latest = await f.bridge.documentationPreview(f.record.id);
  await assert.rejects(f.bridge.confirmDocumentation(f.record.id, latest.artifactDigest, []), /文件或驗收項目已變更/);
  const record = f.current(); record.spec.workContext = { ...record.spec.workContext!, requirement: createRequirementSnapshot({ source: { kind: 'issue', identity: 'issue:2' },
    title: 'Changed requirement', description: '', criteria: ['Document unselected issues as well'] }) }; await f.store.save(record);
  await assert.rejects(f.bridge.confirmDocumentation(f.record.id, latest.artifactDigest, latest.checks), /文件或驗收項目已變更/);
  assert.equal(f.current().validation, undefined); assert.equal(f.modelCalls(), 0); assert.equal(f.deliveries(), 0);
});

test('Bridge document preview rejects mixed code and configured executable checks', async t => {
  const f = await fixture(t), record = f.current(); await writeFile(path.join(f.repo, 'main.ts'), 'export const changed = true;\n'); record.result!.files!.push('main.ts');
  await assert.rejects(f.bridge.documentationPreview(record.id), /人工驗收只適用/);
  record.result!.files = ['README.md']; await rm(path.join(f.repo, 'main.ts'));
  record.spec.workContext = { ...record.spec.workContext!, verification: freezeVerificationProfile({ kind: 'docs', commands: ['npm run lint:docs'] }) };
  await assert.rejects(f.bridge.documentationPreview(record.id), /人工驗收只適用/);
  assert.equal(record.validation, undefined); assert.equal(f.modelCalls(), 0); assert.equal(f.deliveries(), 0);
});

test('Host opening a changed document diff cannot authorize stale Bridge manual acceptance', async t => {
  const f = await fixture(t, []), options = { bridge: () => f.bridge, check: () => {}, diff: async () => { await writeFile(path.join(f.repo, 'README.md'), '# Edited while reviewing\n'); } } as unknown as CodexHostActionOptions;
  let picks = 0;
  const api = { workspace: { isTrusted: true }, window: { showQuickPick: async (items: unknown[]) => { picks++; return items; }, showInformationMessage: async () => {} } } as unknown as typeof VSCode;
  await assert.rejects(new CodexHostActions(options, api).run({ action: 'confirm-documentation', taskId: f.record.id }), /文件或驗收項目已變更/);
  assert.equal(picks, 1); assert.equal(f.current().validation, undefined); assert.equal(f.current().result!.state, 'needs-work');
  assert.equal(f.modelCalls(), 0); assert.equal(f.deliveries(), 0);
});
