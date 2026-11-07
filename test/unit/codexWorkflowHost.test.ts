import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { CodexTaskSpec } from '../../src/codex/protocol';
import * as workflows from '../../src/codex/projectWorkflows';
import * as runner from '../../src/workspace/workflowKitRunner';
import * as reviewSessions from '../../src/workspace/reviewSessions';

const loader = require('node:module'), original = loader._load;
loader._load = (name: string, ...args: unknown[]) => name === 'vscode' ? {} : original(name, ...args);
let WorkspacePanel: any;
try { ({ WorkspacePanel } = require('../../src/workspace/workspacePanel')); } finally { loader._load = original; }

async function fixture(t: test.TestContext) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'glw-linked-host-'));
  assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repo = path.join(root, 'repo'), skill = path.join(root, '.agents/skills/bmad-help/SKILL.md');
  await mkdir(repo); await mkdir(path.dirname(skill), { recursive: true }); await writeFile(skill, 'test skill');
  const project = { id: 4, name: 'project', path_with_namespace: 'team/project', default_branch: 'main', web_url: 'https://gitlab.test/team/project' };
  const mr = { iid: 8, title: 'Change', source_branch: 'feature', target_branch: 'main', web_url: project.web_url + '/-/merge_requests/8', diff_refs: { head_sha: 'b'.repeat(40) } };
  const calls: string[] = [];
  const client = { async getProject() { calls.push('project'); return project; },
    withReadSignal() { return this; }, withRequestBudget() { return this; },
    async getIssue() { calls.push('issue'); return { iid: 8, title: 'Fix calculation', description: 'Return the correct sum.', labels: ['bug'], updated_at: 'revision-1', web_url: project.web_url + '/-/issues/8' }; },
    async getMergeRequest() { calls.push('mr'); return mr; }, async getRepositoryBranch() { calls.push('branch'); return { commit: { id: 'a'.repeat(40) } }; } };
  const panel = Object.create(WorkspacePanel.prototype);
  panel.panel = { visible: true };
  panel.context = { globalStorageUri: { fsPath: path.join(root, 'storage') } }; panel.projectContext = { root };
  panel.session = { baseUrl: 'https://gitlab.test', activeAccountId: 'account-one', getClient: async () => client };
  panel.currentUser = { id: 9 }; panel.captureProjectAccess = () => () => {};
  panel.resolveGroupProject = async () => project; panel.assertWorkflowKitReady = async () => {};
  panel.linkedRepository = async () => repo; panel.getSkillsContext = () => ({ root, workspaceRoot: root, revision: 'skills-revision' });
  panel.prepareBmadCommand = async () => ({ snapshot: { root, revision: 'bmad-revision', installation: { state: 'ready' },
    codex: { skills: ['bmad-help'] }, observation: { state: 'watching' }, compatibility: 'verified' } });
  panel.codexSpec = async (source: CodexTaskSpec['source'], title: string, root: string, _skill: string, prompt: string) =>
    ({ source, title, root, prompt, skill: { name: 'bmad-help', path: skill }, writableRoots: [root], environmentKey: 'installed-skill', workspaceKey: root });
  let reviewInputs: Record<string, string> = {};
  panel.prepareSkillGuideTask = async (request: { inputs: Record<string, string> }) => {
    reviewInputs = request.inputs;
    return { ...await panel.codexSpec({ kind: 'skill', featureId: 'merge-repo', inputs: request.inputs, revision: 'r' }, 'Review', root, 'merge-reviewer', 'Review fixed refs'),
      review: { requestId: 'a'.repeat(32), tool: 'merge-reviewer', revision: 'r' } };
  };
  const previousRemote = workflows.workflowRemote, previousBranch = workflows.issueBranchName, previousRunner = runner.readWorkflowKitRunnerBinding;
  Object.assign(workflows, { workflowRemote: async () => 'company', issueBranchName: async () => 'issue/8-fix-calculation' });
  Object.assign(runner, { readWorkflowKitRunnerBinding: async () => undefined });
  t.after(() => { Object.assign(workflows, { workflowRemote: previousRemote, issueBranchName: previousBranch }); Object.assign(runner, { readWorkflowKitRunnerBinding: previousRunner }); });
  return { panel, repo, root, client, project, mr, calls, reviewInputs: () => reviewInputs };
}

test('Host binds Issue development to its selected repository, shared skill and pinned requirement without changing Git', async t => {
  const f = await fixture(t);
  const spec: CodexTaskSpec = await f.panel.prepareLinkedCodexTask({ kind: 'issue', projectId: 4, issueIid: 8 });
  assert.equal(spec.root, f.root); assert.equal(spec.executionRoot, f.repo); assert.deepEqual(spec.writableRoots, [f.repo, path.join(f.root, '_bmad/render')]);
  assert.equal(spec.origin?.branch, 'issue/8-fix-calculation'); assert.equal(spec.workflow?.remote, 'company');
  assert.match(spec.prompt, /Return the correct sum/); assert.match(spec.prompt, /不得自動提交/);
  assert.equal(spec.origin?.sourceSha, 'a'.repeat(40));
  assert.ok(f.calls.includes('issue')); assert.ok(f.calls.includes('branch'));
});

test('Host Wiki preparation uses a private archive destination rather than the working repository', async t => {
  const f = await fixture(t);
  const spec: CodexTaskSpec = await f.panel.prepareLinkedCodexTask({ kind: 'project-wiki', projectId: 4 });
  assert.ok(spec.executionRoot!.startsWith(path.join(f.root, 'storage', 'codex-workflows') + path.sep));
  assert.deepEqual(spec.writableRoots, [spec.executionRoot]); assert.equal(spec.origin?.repositoryRoot, f.repo);
  assert.match(spec.prompt, /git archive/); assert.match(spec.prompt, /不得登入 GitLab 或發布/);
  assert.match(spec.prompt, /不可建立指向這些產物的文件連結/);
});

test('Host MR preparation pins two local evidence refs and checks source, target and account again before publication', async t => {
  const f = await fixture(t);
  const spec: CodexTaskSpec = await f.panel.prepareLinkedCodexTask({ kind: 'merge-request', projectId: 4, iid: 8 });
  assert.ok(f.reviewInputs()['merge-repo.base'].startsWith('workbench/mr-8-')); assert.ok(f.reviewInputs()['merge-repo.head'].endsWith('-head'));
  assert.equal(spec.executionRoot, f.repo); await f.panel.assertLinkedReviewCurrent(spec);
  f.mr.diff_refs.head_sha = 'c'.repeat(40); await assert.rejects(f.panel.assertLinkedReviewCurrent(spec), /版本已變更/);
  f.mr.diff_refs.head_sha = 'b'.repeat(40); f.client.getRepositoryBranch = async () => ({ commit: { id: 'd'.repeat(40) } });
  await assert.rejects(f.panel.assertLinkedReviewCurrent(spec), /版本已變更/);
  f.panel.session.activeAccountId = 'another-account'; await assert.rejects(f.panel.assertLinkedReviewCurrent(spec), /原帳號/);
});

test('Host refuses a mismatched project response before preparing any linked task', async t => {
  const f = await fixture(t); f.project.id = 99;
  await assert.rejects(f.panel.prepareLinkedCodexTask({ kind: 'issue', projectId: 4, issueIid: 8 }), /專案身分/);
  assert.deepEqual(f.calls, ['project']);
});

test('MR discussion fixes pin their snapshots and worktree without inheriting review permissions', async t => {
  const f = await fixture(t);
  const discussion = { id: 'discussion-one', notes: [{ id: 31, body: 'Add a regression test.', author: { name: 'Reviewer' }, system: false, resolved: false }] };
  Object.assign(f.client, { listMergeRequestDiscussions: async () => [discussion] });
  const source: CodexTaskSpec['source'] = { kind: 'merge-request', projectId: 4, iid: 8, intent: 'fix-comments', discussionIds: [discussion.id] };
  const spec: CodexTaskSpec = await f.panel.prepareLinkedCodexTask(source);
  assert.equal(spec.origin?.intent, 'fix-comments'); assert.equal(spec.review, undefined);
  assert.equal(spec.workflow?.worktree?.sourceSha, f.mr.diff_refs.head_sha);
  assert.equal(spec.executionRoot, spec.workflow?.worktree?.path);
  assert.ok(spec.workflow?.discussions?.[0].text.includes('Add a regression test.'));
  assert.ok(spec.prompt.includes('提交、推送、回覆及解決討論由使用者操作'));
  discussion.notes[0].body = 'Changed after queueing';
  await assert.rejects(f.panel.prepareLinkedCodexTask(source, spec), /討論在排隊期間已變更/);
});

test('Host reconciliation unlocks a Wiki draft after an unknown write has been checked', async t => {
  const f = await fixture(t), spec = await f.panel.prepareLinkedCodexTask({ kind: 'project-wiki', projectId: 4 });
  let result: any = { state: 'uncertain' };
  f.panel.linkedCodexSpec = async () => spec;
  f.panel.wikiStore = () => ({ preview: async () => ({ id: spec.workflow.id, revision: 'reconciled', sourceBranch: 'main', sourceSha: spec.origin.sourceSha,
    projectPath: spec.origin.projectPath, uncertain: false, pages: [{ slug: 'codebase/index', published: false }] }) });
  f.panel.getCodexBridge = () => ({ specification: async () => spec,
    resultAction: async (_id: string, action: any) => { result = await action(spec); }, list: () => [{ id: 'wiki', result }] });
  f.panel.post = () => {};
  await f.panel.previewLinkedWiki({ type: 'previewProjectWiki', taskId: 'wiki', refresh: true });
  assert.equal(result.state, 'draft'); assert.equal(result.revision, 'reconciled');
});

test('MR completion requires a native report receipt with matching SHAs and confirmed review completeness', async t => {
  const f = await fixture(t), spec = await f.panel.prepareLinkedCodexTask({ kind: 'merge-request', projectId: 4, iid: 8 });
  spec.writableRoots.push(path.join(f.root, 'review-runtime'));
  const report = path.join(f.repo, 'review-reports', 'review.md'); await mkdir(path.dirname(report)); await writeFile(report, '# Native report');
  const session: any = { requestId: spec.review.requestId, state: 'published', reportPath: report,
    baseSha: spec.origin.targetSha, headSha: spec.origin.sourceSha, reviewOutcome: { reviewComplete: true } };
  t.mock.method(reviewSessions, 'readReviewSessions', async () => [session]);
  assert.equal((await f.panel.collectLinkedCodexResult(spec, [])).state, 'ready');
  session.reviewOutcome.reviewComplete = null;
  assert.equal((await f.panel.collectLinkedCodexResult(spec, [])).state, 'needs-work');
  session.reviewOutcome.reviewComplete = true; delete session.headSha;
  assert.equal((await f.panel.collectLinkedCodexResult(spec, [])).state, 'needs-work');
});
