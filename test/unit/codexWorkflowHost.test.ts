import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type { CodexTaskSpec } from '../../src/codex/protocol';
import * as workflows from '../../src/codex/projectWorkflows';
import * as runner from '../../src/workspace/workflowKitRunner';
import * as reviewSessions from '../../src/workspace/reviewSessions';
import * as managedRepositories from '../../src/codex/managedRepository';
import * as installedReviewer from '../../src/workspace/installedReviewer';
import * as reviewerCapabilities from '../../src/workspace/reviewerCapabilities';
import * as pythonRuntime from '../../src/workspace/pythonRuntime';
import * as reviewLaunch from '../../src/workspace/reviewLaunch';
import { canCopySkillPrompt, getSkillGuideCards } from '../../src/webview/skillsGuideData';
import { createRequirementSnapshot } from '../../src/codex/workContext';

const loader = require('node:module'), original = loader._load;
const vscodeApi = { workspace: { getConfiguration: () => ({ get: (_key: string, fallback: unknown) => fallback }) } };
loader._load = (name: string, ...args: unknown[]) => name === 'vscode' ? vscodeApi : original(name, ...args);
let WorkspacePanel: any;
try { ({ WorkspacePanel } = require('../../src/workspace/workspacePanel')); } finally { loader._load = original; }

async function fixture(t: test.TestContext) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'glw-linked-host-'));
  assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repo = path.join(root, 'repo'), cache = path.join(root, 'cache'), skill = path.join(root, '.agents/skills/bmad-help/SKILL.md');
  await mkdir(repo); await mkdir(cache); await mkdir(path.dirname(skill), { recursive: true }); await writeFile(skill, 'test skill');
  const project = { id: 4, name: 'project', path_with_namespace: 'team/project', default_branch: 'main', web_url: 'https://gitlab.test/team/project', http_url_to_repo: 'https://gitlab.test/team/project.git' };
  const mr = { project_id: 4, iid: 8, title: 'Change', source_branch: 'feature', target_branch: 'main', web_url: project.web_url + '/-/merge_requests/8', diff_refs: { head_sha: 'b'.repeat(40) } };
  const calls: string[] = [];
  const client = { baseUrl: 'https://gitlab.test', async getProject() { calls.push('project'); return project; },
    withReadSignal() { return this; }, withRequestBudget() { return this; },
    async getIssue() { calls.push('issue'); return { project_id: 4, iid: 8, title: 'Fix calculation', description: 'Return the correct sum.', labels: ['bug'], updated_at: 'revision-1', web_url: project.web_url + '/-/issues/8' }; },
    async getMergeRequest() { calls.push('mr'); return mr; }, async getRepositoryBranch() { calls.push('branch'); return { commit: { id: 'a'.repeat(40) } }; } };
  const panel = Object.create(WorkspacePanel.prototype);
  panel.codexSourceReads = new Map(); panel.refreshCodexSources = false;
  panel.panel = { visible: true };
  panel.context = { globalStorageUri: { fsPath: path.join(root, 'storage') } }; panel.projectContext = { root };
  panel.session = { baseUrl: 'https://gitlab.test', activeAccountId: 'account-one', getClient: async () => client, getCloneCredentials: async () => ({ token: 'fixture-token' }) };
  panel.currentUser = { id: 9 }; panel.captureProjectAccess = () => () => {};
  panel.resolveGroupProject = async () => project; panel.assertWorkflowKitReady = async () => {};
  panel.linkedRepository = async () => repo; panel.getSkillsContext = () => ({ root, workspaceRoot: root, revision: 'skills-revision' });
  panel.prepareBmadCommand = async () => ({ snapshot: { root, revision: 'bmad-revision', installation: { state: 'ready' },
    codex: { skills: ['bmad-help', 'bmad-build'] }, nodes: [], observation: { state: 'watching' }, compatibility: 'verified' } });
  panel.codexSpec = async (source: CodexTaskSpec['source'], title: string, root: string, selectedSkill: string, prompt: string,
    extraRoots: string[] = [], review?: CodexTaskSpec['review']) =>
    ({ source, title, root, prompt, skill: { name: selectedSkill, path: skill }, writableRoots: [root, ...extraRoots], review, environmentKey: 'installed-skill', workspaceKey: root });
  let reviewInputs: Record<string, string> = {};
  panel.prepareSkillGuideTask = async (request: { inputs: Record<string, string>; featureId: string }) => {
    reviewInputs = request.inputs;
    return { ...await panel.codexSpec({ kind: 'skill', featureId: 'merge-repo', inputs: request.inputs, revision: 'r' }, 'Review', root, 'merge-reviewer', 'Review fixed refs'),
      review: { requestId: 'a'.repeat(32), tool: request.featureId === 'release-review' ? 'release-reviewer' : 'merge-reviewer', revision: 'r' } };
  };
  const previousRemote = workflows.workflowRemote, previousBranch = workflows.issueBranchName, previousRunner = runner.readWorkflowKitRunnerBinding;
  Object.assign(workflows, { workflowRemote: async () => 'company', issueBranchName: async () => 'issue/8-fix-calculation' });
  Object.assign(runner, { readWorkflowKitRunnerBinding: async () => undefined });
  t.mock.method(managedRepositories, 'ensureManagedRepositoryCache', async () => ({ root: cache, remote: 'origin' as const, key: 'cache-key' }));
  t.after(() => { Object.assign(workflows, { workflowRemote: previousRemote, issueBranchName: previousBranch }); Object.assign(runner, { readWorkflowKitRunnerBinding: previousRunner }); });
  return { panel, repo, cache, root, client, project, mr, calls, reviewInputs: () => reviewInputs };
}

test('Host binds Issue development to its selected repository, shared skill and pinned requirement without changing Git', async t => {
  const f = await fixture(t);
  const spec: CodexTaskSpec = await f.panel.prepareLinkedCodexTask({ kind: 'issue', projectId: 4, issueIid: 8 });
  const execution = path.join(spec.workflow!.runtimeRoot, 'repository');
  assert.equal(spec.root, f.root); assert.equal(spec.executionRoot, execution); assert.deepEqual(spec.writableRoots, [execution, path.join(execution, '.git'), path.join(f.root, '_bmad/render')]);
  assert.equal(spec.origin?.branch, 'issue/8-fix-calculation'); assert.equal(spec.workflow?.remote, 'origin');
  assert.match(spec.prompt, /Return the correct sum/); assert.match(spec.prompt, /允許建立本機 Commit/); assert.match(spec.prompt, /\(#8\)/);
  assert.equal(spec.skill?.name, 'bmad-build'); assert.equal(spec.workflow?.managedClone?.cacheRepository, f.cache);
  assert.equal(spec.origin?.sourceSha, 'a'.repeat(40));
  assert.ok(f.calls.includes('issue')); assert.ok(f.calls.includes('branch'));
});

test('Host Wiki preparation uses a private archive destination rather than the working repository', async t => {
  const f = await fixture(t);
  const spec: CodexTaskSpec = await f.panel.prepareLinkedCodexTask({ kind: 'project-wiki', projectId: 4 });
  assert.ok(spec.executionRoot!.startsWith(path.join(f.root, 'storage', 'codex-workflows') + path.sep));
  assert.deepEqual(spec.writableRoots, [spec.executionRoot]); assert.equal(spec.origin?.repositoryRoot, f.cache);
  assert.match(spec.prompt, /git archive/); assert.match(spec.prompt, /不得登入 GitLab 或發布/);
  assert.match(spec.prompt, /不可建立指向這些產物的文件連結/);
});

test('generic Wiki delivery checks fresh GitLab source metadata before any draft preview or publication', async t => {
  for (const changed of [false, true]) {
    const f = await fixture(t), spec = await f.panel.prepareLinkedCodexTask({ kind: 'project-wiki', projectId: 4 });
    f.calls.length = 0;
    t.mock.method(f.client, 'getRepositoryBranch', async () => { f.calls.push('branch'); return { commit: { id: (changed ? 'b' : 'a').repeat(40) } }; });
    f.panel.wikiStore = () => ({ preview: async () => { f.calls.push('preview'); return { revision: 'fixed-revision', uncertain: false, progress: { status: 'ready' } }; },
      publish: async (_id: string, origin: CodexTaskSpec['origin'], revision: string) => {
        f.calls.push('publish'); assert.equal(origin, spec.origin); assert.equal(revision, 'fixed-revision'); return { state: 'published' };
      } });
    const service = f.panel.codexDeliveryService({ spec });
    const publication = service.options.publishWiki({ spec }, () => {});
    if (changed) { await assert.rejects(publication, /來源版本.*重新產生.*草稿保留/); assert.deepEqual(f.calls, ['branch']); }
    else { assert.equal((await publication).state, 'published'); assert.deepEqual(f.calls, ['branch', 'preview', 'publish']); }
  }
});

test('isolated Issue instructions, BMAD outputs and write roots consistently target the independent clone', async t => {
  const f = await fixture(t);
  const spec: CodexTaskSpec = await f.panel.prepareLinkedCodexTask({ kind: 'issue', projectId: 4, issueIid: 8, isolated: true });
  assert.ok(spec.workflow?.managedClone); assert.equal(spec.executionRoot, spec.workflow.managedClone.path);
  assert.ok(spec.prompt.includes(JSON.stringify(spec.executionRoot)));
  assert.ok(spec.prompt.includes('_bmad-output/'));
  assert.equal(spec.prompt.includes(`工作根目錄：${f.repo}\n`), false);
  assert.ok(spec.prompt.includes(`本次只在 Repo ${JSON.stringify(spec.executionRoot)}`));
  assert.equal(spec.writableRoots.includes(f.repo), false);
});

test('selected model and supplemental acceptance criteria retain the same admission identity', async t => {
  const f = await fixture(t);
  f.panel.prepareCodexEnvironment = (source: any, previous?: CodexTaskSpec) => f.panel.prepareLinkedCodexTask(source, previous);
  const source: CodexTaskSpec['source'] = { kind: 'issue', projectId: 4, issueIid: 8, isolated: true,
    requirement: 'Also cover the empty input.', model: 'fixture-model', effort: 'high' };
  const first: CodexTaskSpec = await f.panel.prepareCodexTask(source), rechecked: CodexTaskSpec = await f.panel.prepareCodexTask(first.source, first);
  assert.equal(rechecked.environmentKey, first.environmentKey); assert.equal(rechecked.executionRoot, first.executionRoot);
  assert.equal(rechecked.prompt, first.prompt);
  assert.equal(rechecked.prompt.split(source.requirement!).length - 1, 1);
  assert.equal(rechecked.workContext?.requirement.supplement, source.requirement);
  assert.ok(rechecked.prompt.includes(rechecked.workContext!.requirement.contentDigest));
  assert.equal(rechecked.model, 'fixture-model'); assert.equal(rechecked.effort, 'high');
});

test('isolated tasks pin Group rules without copying the shared installation and reject changed instructions', async t => {
  const f = await fixture(t), rule = path.join(f.root, 'AGENTS.md'); await writeFile(rule, 'Run the project checks before delivery.');
  f.panel.prepareCodexEnvironment = (source: any, previous?: CodexTaskSpec) => f.panel.prepareLinkedCodexTask(source, previous);
  const first: CodexTaskSpec = await f.panel.prepareCodexTask({ kind: 'issue', projectId: 4, issueIid: 8, isolated: true });
  assert.equal(first.projectRules?.length, 1); assert.equal(first.projectRules[0].path, rule);
  assert.match(first.projectRules[0].fingerprint, /^[a-f0-9]{64}$/);
  assert.equal((await f.panel.prepareCodexTask(first.source, first)).environmentKey, first.environmentKey);
  await writeFile(rule, 'Changed instructions');
  await assert.rejects(f.panel.prepareCodexTask(first.source, first), /規則已變更/);
});

test('Wiki and managed MR reviews retain original Group instructions outside their execution directory', async t => {
  const f = await fixture(t), rule = path.join(f.root, 'AGENTS.md'); await writeFile(rule, 'Preserve Group review policy.');
  f.panel.prepareCodexEnvironment = (source: any, previous?: CodexTaskSpec) => f.panel.prepareLinkedCodexTask(source, previous);
  const wiki = await f.panel.prepareCodexTask({ kind: 'project-wiki', projectId: 4 });
  const mr = await f.panel.prepareCodexTask({ kind: 'merge-request', projectId: 4, iid: 8 });
  assert.equal(wiki.projectRules?.[0].path, rule); assert.equal(mr.projectRules?.[0].path, rule);
  await rm(rule);
  await assert.rejects(f.panel.prepareCodexTask(wiki.source, wiki), /規則已變更/);
});

test('Host MR preparation pins two local evidence refs and checks source, target and account again before publication', async t => {
  const f = await fixture(t);
  const spec: CodexTaskSpec = await f.panel.prepareLinkedCodexTask({ kind: 'merge-request', projectId: 4, iid: 8 });
  assert.ok(f.reviewInputs()['merge-repo.base'].startsWith('workbench/mr-8-')); assert.ok(f.reviewInputs()['merge-repo.head'].endsWith('-head'));
  assert.equal(spec.executionRoot, f.cache); await f.panel.assertLinkedReviewCurrent(spec);
  f.mr.diff_refs.head_sha = 'c'.repeat(40); await assert.rejects(f.panel.assertLinkedReviewCurrent(spec), /版本已變更/);
  f.mr.diff_refs.head_sha = 'b'.repeat(40); f.client.getRepositoryBranch = async () => ({ commit: { id: 'd'.repeat(40) } });
  await assert.rejects(f.panel.assertLinkedReviewCurrent(spec), /版本已變更/);
  f.panel.session.activeAccountId = 'another-account'; await assert.rejects(f.panel.assertLinkedReviewCurrent(spec), /原帳號/);
});

async function reviewPublicationFixture(t: test.TestContext, projectPath = 'team/project') {
  const f = await fixture(t); f.project.path_with_namespace = projectPath;
  const spec: CodexTaskSpec = await f.panel.prepareLinkedCodexTask({ kind: 'merge-request', projectId: 4, iid: 8 });
  const receipts: Array<{ state: string }> = [], outcomes: any[] = [];
  f.panel.session.selectedGroup = { id: 17, full_path: 'team' }; f.panel.session.connectionEpoch = 1;
  f.panel.projects = []; f.panel.issues = []; f.panel.mergeRequests = []; f.calls.length = 0;
  const client = f.client as any;
  client.searchGroupProjectsPage = async (groupId: number, query: string, cursor?: string, withShared?: boolean) => {
    f.calls.push('group-projects'); assert.equal(groupId, 17); assert.equal(query, 'project'); assert.equal(withShared, true);
    return cursor ? { items: [f.project], complete: true, updatedAt: 'now' }
      : { items: [{ id: 99, path_with_namespace: 'team/unrelated' }], nextCursor: 'next-group-page', complete: false, updatedAt: 'now' };
  };
  const bridge = { specification: async () => spec, withResources: async (_taskId: string, action: () => Promise<unknown>) => action(), isFinalizing: () => false,
    notePublication: async (_taskId: string, receipt: { state: string }) => { receipts.push(receipt); f.calls.push(receipt.state); } };
  f.panel.getCodexBridge = () => bridge; Object.defineProperty(f.panel, 'operationContext', { value: { getStore: () => undefined } });
  f.panel.noteOutcome = (value: unknown) => outcomes.push(value); f.panel.pendingMrWrites = () => [];
  f.panel.loadMergeRequest = async (projectId: number) => {
    f.calls.push('load-mr'); await WorkspacePanel.prototype.resolveGroupProject.call(f.panel, projectId);
  };
  f.panel.publishMergeRequestText = async (_projectId: number, _iid: number, _body: string, _discussion: unknown, beforeSend: () => Promise<void>) => {
    await beforeSend(); f.calls.push('remote-write');
  };
  return { ...f, spec, receipts, outcomes, client };
}

test('managed MR publication verifies fresh Group membership without requiring a previously opened remote page', async t => {
  for (const projectPath of ['team/project', 'team/subgroup/project', 'shared-owner/project']) await t.test(projectPath, async t => {
    const f = await reviewPublicationFixture(t, projectPath);
    await f.panel.publishCodexReview(4, 8, 'Approved complete report', async () => {}, 'review-task');
    assert.deepEqual(f.panel.projects, [f.project], 'only the server-authorized target project is added');
    assert.deepEqual(f.calls, ['mr', 'project', 'group-projects', 'group-projects', 'load-mr', 'pending', 'mr', 'remote-write', 'confirmed']);
    assert.deepEqual(f.receipts.map(receipt => receipt.state), ['pending', 'confirmed']);
  });
});

test('managed MR publication refuses wrong Group, changed account, changed project path and late scope changes before any receipt or write', async t => {
  for (const mismatch of ['group', 'account', 'path', 'late-group']) await t.test(mismatch, async t => {
    const f = await reviewPublicationFixture(t);
    if (mismatch === 'group') f.client.searchGroupProjectsPage = async () => ({ items: [], complete: true, updatedAt: 'now' });
    if (mismatch === 'account') f.panel.session.activeAccountId = 'another-account';
    if (mismatch === 'path') f.client.getProject = async () => ({ ...f.project, path_with_namespace: 'team/renamed' });
    if (mismatch === 'late-group') f.client.searchGroupProjectsPage = async () => {
      f.panel.session.selectedGroup = { id: 18, full_path: 'other' }; return { items: [f.project], complete: true, updatedAt: 'now' };
    };
    await assert.rejects(f.panel.publishCodexReview(4, 8, 'Approved complete report', async () => {}, 'review-task'), (error: any) =>
      error.name === 'CodexReviewNotSentError' && error.effect === 'none' && /原帳號|Group|專案身分|來源專案|工作區/.test(error.message));
    assert.deepEqual(f.receipts, []); assert.equal(f.calls.includes('remote-write'), false); assert.deepEqual(f.panel.projects, []);
    assert.deepEqual(f.outcomes, [{ effect: 'none' }]);
  });
});

test('managed MR publication does not classify a failed pending-receipt save as a preflight rejection', async t => {
  const f = await reviewPublicationFixture(t), failure = new Error('Receipt persistence failed');
  f.panel.getCodexBridge().notePublication = async () => { throw failure; };
  await assert.rejects(f.panel.publishCodexReview(4, 8, 'Approved complete report', async () => {}, 'review-task'), error => error === failure);
  assert.deepEqual(f.outcomes, []); assert.equal(f.calls.includes('remote-write'), false);
});

test('managed review publication rechecks its linked Issue after beforeSend without resending changed requirements', async t => {
  const f = await reviewPublicationFixture(t), origin = f.spec.origin!;
  let description = 'Approved Issue requirement', checks = 0;
  f.spec.workContext = { schema: 'GitLabWorkspaceWorkContext/v1', requirement: createRequirementSnapshot({ source: { kind: 'issue',
    identity: JSON.stringify([origin.baseUrl, origin.accountKey, 4, 'issue', 7]) }, title: 'Requirement', description }) };
  f.client.getIssue = async () => ({ project_id: 4, iid: 7, title: 'Requirement', description });
  const beforeSend = async () => { if (++checks === 2) description = 'Changed Issue requirement'; };
  await assert.rejects(f.panel.publishCodexReview(4, 8, 'Approved complete report', beforeSend, 'review-task'), /來源需求/);
  assert.deepEqual(f.receipts.map(receipt => receipt.state), ['pending', 'not-published']); assert.equal(f.calls.includes('remote-write'), false);
  await assert.rejects(f.panel.publishCodexReview(4, 8, 'Approved complete report', beforeSend, 'review-task'), /來源需求/);
  assert.equal(f.calls.includes('remote-write'), false); assert.equal(f.receipts.length, 2);
});

test('unrecorded native review reconciliation only reads fresh membership, fixed refs and one exact marker body', async t => {
  for (const outcome of ['absent', 'confirmed', 'duplicate', 'altered', 'author', 'pending', 'late-group', 'changed-MR']) await t.test(outcome, async t => {
    const f = await reviewPublicationFixture(t), body = '# Approved native report\r\n\r\nComplete findings.\r\n';
    const bodyHash = workflows.workflowHash(body.trim());
    const key = workflows.workflowHash([f.spec.origin!.baseUrl, 9, 4, 8, f.spec.origin!.sourceSha, '', body.trim()].join('\0'));
    const marked = body.trim() + '\n\n' + `<!-- gitlab-workspace:mr-write:${key} -->`;
    const note = { id: 41, author: { id: 9 }, body: marked.replace(/\r\n/g, '\n') };
    f.client.listMergeRequestDiscussions = async () => {
      f.calls.push('discussions');
      if (outcome === 'late-group') f.panel.session.selectedGroup = { id: 18, full_path: 'another' };
      return [{ notes: outcome === 'absent' || outcome === 'late-group' ? [] : outcome === 'duplicate' ? [note, { ...note, id: 42 }]
        : [{ ...note, ...(outcome === 'altered' ? { body: note.body.replace('Complete findings.', 'Different findings.') } : {}),
          ...(outcome === 'author' ? { author: { id: 99 } } : {}) }] }];
    };
    if (outcome === 'pending') f.panel.pendingMrWrites = () => [{ key, state: 'uncertain' }];
    if (outcome === 'changed-MR') f.mr.diff_refs.head_sha = 'c'.repeat(40);
    const result = f.panel.reconcileUnrecordedReview(f.spec, { body, bodyHash, reportPath: 'C:/reports/native.md' }, () => {});
    if (outcome === 'absent') assert.deepEqual(await result, { state: 'not-published' });
    else if (outcome === 'confirmed') assert.deepEqual(await result, { state: 'confirmed', key });
    else await assert.rejects(result, /不唯一|對帳紀錄|Group|版本已變更/);
    assert.deepEqual(f.receipts, []); assert.deepEqual(f.outcomes, []); assert.equal(f.calls.includes('remote-write'), false);
  });
});

test('native MR review inputs pass the real branch-review entry validation for both reviewers', async t => {
  for (const reviewerTool of ['merge-reviewer', 'release-reviewer'] as const) {
    const f = await fixture(t), prepare = f.panel.prepareSkillGuideTask.bind(f.panel);
    f.panel.prepareSkillGuideTask = async (request: { featureId: string; inputs: Record<string, string> }, ...args: unknown[]) => {
      const card = getSkillGuideCards('group').find(item => item.id === request.featureId)!;
      assert.ok(card, 'native review selects a public Skill entry');
      assert.equal(canCopySkillPrompt(card, request.inputs), true, 'generated native MR inputs must be accepted by the actual Skill entry');
      assert.equal(canCopySkillPrompt(card, { ...request.inputs, [`${card.id}.effort`]: 'auto' }), false, 'the retired auto sentinel must not enter a fixed-effort Skill');
      return prepare(request, ...args);
    };
    const spec = await f.panel.prepareLinkedCodexTask({ kind: 'merge-request', projectId: 4, iid: 8, reviewerTool });
    assert.equal(spec.origin.reviewerTool, reviewerTool); assert.equal(spec.review.tool, reviewerTool);
    assert.equal(spec.origin.sourceSha, f.mr.diff_refs.head_sha); assert.equal(spec.origin.targetSha, 'a'.repeat(40));
  }
});

test('Host refuses a mismatched project response before preparing any linked task', async t => {
  const f = await fixture(t); f.project.id = 99;
  await assert.rejects(f.panel.prepareLinkedCodexTask({ kind: 'issue', projectId: 4, issueIid: 8 }), /專案身分/);
  assert.deepEqual(f.calls, ['project']);
});

test('MR discussion fixes pin their snapshots and independent clone without inheriting review permissions', async t => {
  const f = await fixture(t);
  const discussion = { id: 'discussion-one', notes: [{ id: 31, body: 'Add a regression test.', author: { name: 'Reviewer' }, system: false, resolved: false }] };
  Object.assign(f.client, { listMergeRequestDiscussions: async () => [discussion] });
  const source: CodexTaskSpec['source'] = { kind: 'merge-request', projectId: 4, iid: 8, intent: 'fix-comments', discussionIds: [discussion.id] };
  const spec: CodexTaskSpec = await f.panel.prepareLinkedCodexTask(source);
  assert.equal(spec.origin?.intent, 'fix-comments'); assert.equal(spec.review, undefined);
  assert.equal(spec.workflow?.worktree, undefined);
  assert.equal(spec.workflow?.managedClone?.sourceSha, f.mr.diff_refs.head_sha);
  assert.equal(spec.executionRoot, spec.workflow?.managedClone?.path);
  assert.equal(spec.writableRoots.includes(path.join(spec.executionRoot!, '.git')), true);
  assert.ok(spec.workflow?.discussions?.[0].text.includes('Add a regression test.'));
  assert.ok(spec.prompt.includes('允許建立本機 Commit'));
  discussion.notes[0].body = 'Changed after queueing';
  const resumed: CodexTaskSpec = await f.panel.prepareLinkedCodexTask(source, spec);
  assert.deepEqual(resumed.workflow?.discussions, spec.workflow?.discussions, 'queue and execution share the captured discussion snapshot');
  f.panel.codexSourceReads.clear(); f.panel.refreshCodexSources = true;
  const refreshed: CodexTaskSpec = await f.panel.prepareLinkedCodexTask(source);
  assert.ok(refreshed.workflow?.discussions?.[0].text.includes('Changed after queueing'), 'explicit recheck captures the new source for acknowledgement');
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
  const report = path.join(f.cache, 'review-reports', 'review.md'); await mkdir(path.dirname(report)); await writeFile(report, '# Native report');
  const session: any = { requestId: spec.review.requestId, state: 'published', reportPath: report,
    baseSha: spec.origin.targetSha, headSha: spec.origin.sourceSha, reviewOutcome: { reviewComplete: true } };
  t.mock.method(reviewSessions, 'readReviewSessions', async () => [session]);
  assert.equal((await f.panel.collectLinkedCodexResult(spec, [])).state, 'ready');
  session.reviewOutcome.reviewComplete = null;
  assert.equal((await f.panel.collectLinkedCodexResult(spec, [])).state, 'needs-work');
  session.reviewOutcome.reviewComplete = true; delete session.headSha;
  assert.equal((await f.panel.collectLinkedCodexResult(spec, [])).state, 'needs-work');
});

test('Host adopts a receipt-verified cleaned Merge v1 report without fixed_identity and keeps the MR SHA mismatch gate', async t => {
  const f = await fixture(t), spec = await f.panel.prepareLinkedCodexTask({ kind: 'merge-request', projectId: 4, iid: 8 });
  const runtime = path.join(f.root, 'legacy-merge-runtime'), report = path.join(f.cache, 'review-reports', 'report-with-no-sha-in-name.md');
  spec.writableRoots.push(runtime); await mkdir(path.join(runtime, 'jobs'), { recursive: true }); await mkdir(path.dirname(report));
  await writeFile(path.join(runtime, '.merge-reviewer-runtime.json'), JSON.stringify({ schema: 'MergeReviewRuntime/v1', directory: runtime }));
  const job: any = { schema: 'MergeReviewSession/v1', request_id: spec.review.requestId, runtime_root: runtime,
    context_dir: path.join(runtime, 'sessions', spec.review.requestId), state: 'published', phase: 'complete', updated_at: new Date().toISOString(),
    inputs: { workspace: f.root, project: f.cache, base: f.reviewInputs()['merge-repo.base'], head: f.reviewInputs()['merge-repo.head'] }, report_path: report,
    review_outcome: { schema: 'MergeReviewOutcome/v1', outcome_available: true, review_complete: true, review_status: 'complete', gaps: [] } };
  const publish = async (head: string) => {
    const body = `# Native Merge report\n- 本機路徑：\`${f.cache}\`\n### 固定版本\n\n| Repo | 角色 | 來源 | 完整 SHA |\n| --- | --- | --- | --- |\n| ${path.basename(f.cache)} | seed | base | \`${spec.origin.targetSha}\` |\n| ${path.basename(f.cache)} | seed | head | \`${head}\` |\n`;
    await writeFile(report, body); job.report_receipt = { policy: 'merge-report-static-body/v1', static_body_sha256: createHash('sha256').update(body).digest('hex'), review_outcome: job.review_outcome };
    await writeFile(path.join(runtime, 'jobs', spec.review.requestId + '.json'), JSON.stringify(job));
  };
  await publish(spec.origin.sourceSha);
  assert.equal((await f.panel.collectLinkedCodexResult(spec, [])).state, 'ready', 'Actual native v1 source fields are parsed instead of assuming Release fixed_identity exists');
  await publish('c'.repeat(40));
  const mismatch = await f.panel.collectLinkedCodexResult(spec, []); assert.equal(mismatch.state, 'needs-work'); assert.match(mismatch.summary, /固定版本不符合/);
});

test('Host resume cannot relabel a captured Merge review as Release or change its intent', async t => {
  const f = await fixture(t), source = { kind: 'merge-request' as const, projectId: 4, iid: 8, reviewerTool: 'merge-reviewer' as const };
  const spec = await f.panel.prepareLinkedCodexTask(source);
  await assert.rejects(f.panel.prepareLinkedCodexTask({ ...source, reviewerTool: 'release-reviewer' }, spec), /Reviewer/);
  await assert.rejects(f.panel.prepareLinkedCodexTask({ ...source, intent: 'fix-comments' }, spec), /Reviewer/);
  const release = await f.panel.prepareLinkedCodexTask({ ...source, reviewerTool: 'release-reviewer' });
  assert.equal(release.review.tool, 'release-reviewer'); assert.equal(release.origin.reviewerTool, 'release-reviewer');
  assert.ok(f.reviewInputs()['release-review.repo']);
  const workspace = JSON.parse(await readFile(path.join(release.workflow.runtimeRoot, 'review.code-workspace'), 'utf8'));
  assert.equal(workspace.folders[0].path, f.cache);
});

test('Host review preparation keeps a managed cache unique and sends workspace-file only through the matching native entry', async t => {
  const f = await fixture(t), runtime = path.join(f.root, 'review-runtime'), workspaceFile = path.join(f.root, 'managed-review.code-workspace');
  const context = { root: f.root, workspaceRoot: f.root, revision: 'stable', mode: 'group', availableFeatures: ['merge-repo', 'release-review'],
    installed: { status: 'installed', version: '1.9.0' }, repositories: [], reviewerRepositories: [{ name: 'Already visible cache', path: f.cache }],
    reviewRuntimeRoot: runtime, releaseReviewRuntimeRoot: path.join(f.root, 'release-runtime') };
  f.panel.getSkillsContext = () => context; f.panel.refreshWorkflowKit = async () => {}; f.panel.refreshInventory = async () => {}; f.panel.operationPhase = () => {};
  const hashes = 'a'.repeat(64), launches: any[] = [];
  t.mock.method(installedReviewer, 'readInstalledReviewerBinding', async (_root: string, tool: any) => ({ schema: 'InstalledReviewerBinding/v1', tool, version: '1.0.0',
    script_path: path.join(f.root, tool, 'review_session.py'), script_sha256: hashes, skill_sha256: hashes, payload_sha256: hashes, payload_files: 3,
    workflow_kit_runner: { script_path: path.join(f.root, 'run.py'), script_sha256: hashes, review_launch_request: 1, review_launch_sha256: hashes, read_only_inspection: true } } as any));
  t.mock.method(reviewerCapabilities, 'readReviewerCapabilities', async (binding: any) => binding.tool === 'merge-reviewer'
    ? { schema: 'MergeReviewCapabilities/v1', protocol_version: 1, draft_formats: ['compact'], features: { launch_preflight: true, read_only_inspection: true } } as any
    : { schema: 'ReviewCapabilities/v1', prepare_evidence: false, features: { request_id: true } } as any);
  t.mock.method(pythonRuntime, 'resolvePythonRuntime', async () => ({ executable: 'python', args: [], env: process.env } as any));
  t.mock.method(reviewSessions, 'sharedReviewCacheRoot', async () => path.join(f.root, 'shared-cache'));
  t.mock.method(reviewSessions, 'sharedReviewCacheV2Root', () => path.join(f.root, 'shared-cache-v2'));
  t.mock.method(reviewLaunch, 'saveReviewLaunchRequest', async (request: any, action: any) => { launches.push(request); return { path: path.join(f.root, 'launch.json'), sha256: hashes, request, action }; });
  const managed = { name: 'team/project', path: f.cache, workspaceFile };
  const release = await WorkspacePanel.prototype.prepareSkillGuideTask.call(f.panel, { featureId: 'release-review', revision: 'stable',
    inputs: { 'release-review.repo': f.cache, 'release-review.base': 'main', 'release-review.head': 'feature', 'release-review.effort': 'high' } }, undefined, undefined, managed);
  assert.equal(release.review.tool, 'release-reviewer'); assert.match(release.prompt, /--workspace-file/); assert.ok(release.prompt.includes(JSON.stringify(workspaceFile)));
  assert.equal(launches.length, 0, 'Release must not create MergeReviewLaunchRequest');
  const merge = await WorkspacePanel.prototype.prepareSkillGuideTask.call(f.panel, { featureId: 'merge-repo', revision: 'stable',
    inputs: { 'merge-repo.repo': f.cache, 'merge-repo.base': 'main', 'merge-repo.head': 'feature', 'merge-repo.effort': 'high' } }, undefined, undefined, managed);
  assert.equal(merge.review.tool, 'merge-reviewer'); assert.equal(launches.length, 1);
  assert.equal(launches[0].project, f.cache); assert.equal(launches[0].workspace_file, workspaceFile);
});

test('Host registers an owned task clone even when its source cache is outside the visible workspace', async t => {
  const f = await fixture(t), spec = await f.panel.prepareLinkedCodexTask({ kind: 'issue', projectId: 4, issueIid: 8 });
  const opened: string[] = []; f.panel.codexWorktrees = new Map(); f.panel.codexRepositories = async () => [];
  f.panel.gitRepositories = { openRepositoryPath: async (root: string) => { opened.push(root); } };
  t.mock.method(workflows, 'verifyManagedExecutionRepository', async () => spec.executionRoot!);
  const verify = t.mock.method(managedRepositories, 'verifyManagedRepositoryCacheBinding', async () => true);
  await f.panel.registerCodexWorktree(spec);
  assert.deepEqual(opened, [spec.executionRoot]); assert.equal(f.panel.codexWorktrees.get(spec.executionRoot).repository, f.cache);
  assert.equal(verify.mock.calls[0].arguments[1], f.cache);
  verify.mock.mockImplementation(async () => false);
  await assert.rejects(f.panel.registerCodexWorktree(spec), /管理快取/);
  assert.equal(opened.length, 1);
});
