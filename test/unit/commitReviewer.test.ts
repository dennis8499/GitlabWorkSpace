import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { commitReviewRuntime, readInstalledCommitReviewer } from '../../src/workspace/commitReviewer';
import { buildSkillGuidePrompt, canCopySkillPrompt, getSkillGuideCard, restoreSkillGuideState } from '../../src/webview/skillsGuideData';
import { isWorkspaceRequest } from '../../src/workspace/workspaceRequestValidation';

const repo = 'C:/工作區 with spaces/service';
const context = { root: 'C:/工作區 with spaces', workspaceRoot: 'C:/工作區 with spaces', repositories: [{ name: 'service', path: repo }] };

test('CommitReviewer cards keep native mode inputs, data argv and current model settings', () => {
  for (const feature of ['commit-draft', 'mr-precheck']) {
    const card = getSkillGuideCard('commit-reviewer', feature);
    const inputs = { [`${feature}.repo`]: repo, ...(feature === 'commit-draft' ? { [`${feature}.issues`]: '#123, team/service#456' } : {}) };
    assert.equal(canCopySkillPrompt(card, inputs), true);
    const prompt = buildSkillGuidePrompt(card, inputs, { ...context, workflowKitRunner: { script_path: 'C:/kit/run.py', script_sha256: 'a'.repeat(64) } });
    const args = JSON.parse(prompt.split('\n').find(line => line.startsWith('inspect argv：'))!.split('argv：')[1]);
    assert.equal(args[0], 'python');
    assert.ok(args.includes('C:/kit/run.py'));
    assert.equal(args[args.indexOf('--repo') + 1], repo);
    assert.equal(args[args.indexOf('--mode') + 1], feature === 'commit-draft' ? 'commit' : 'mr');
    assert.match(prompt, /shell=False/);
    assert.match(prompt, /exit 3/);
    assert.match(prompt, /只有收到開發者明確確認後/);
    assert.match(prompt, /confirmations 記錄該項 ID、確認人及理由/);
    assert.doesNotMatch(prompt, /review_session\.py|\$model-routing|Luna/);
    assert.throws(() => buildSkillGuidePrompt(card, inputs, { ...context, repositories: [] }), /唯一/);
    assert.throws(() => buildSkillGuidePrompt(card, inputs, { ...context, workspaceRootAmbiguous: true }), /工作區根目錄/);
    assert.equal(canCopySkillPrompt(card, { ...inputs, [`${feature}.effort`]: 'max' }), false);
  }
});

test('draft references, alias lists and MR branch input reject incomplete or retired parameters', () => {
  const draft = getSkillGuideCard('commit-reviewer', 'commit-draft');
  for (const issues of ['', '#0', 'https://gitlab.test/issues/123', '#123; echo injected']) {
    assert.equal(canCopySkillPrompt(draft, { 'commit-draft.repo': repo, 'commit-draft.issues': issues }), false);
  }
  const mr = getSkillGuideCard('commit-reviewer', 'mr-precheck');
  for (const target of ['HEAD', '-main', 'main~1', 'refs/tags/v1', 'bad branch', 'a'.repeat(40)]) {
    assert.equal(canCopySkillPrompt(mr, { 'mr-precheck.repo': repo, 'mr-precheck.target': target }), false);
  }
  assert.equal(canCopySkillPrompt(mr, { 'mr-precheck.repo': repo, 'mr-precheck.remote': '--all' }), false);
  const state = restoreSkillGuideState({ tool: 'commit-reviewer', selections: { 'commit-reviewer': 'mr-precheck' },
    inputs: { 'mr-precheck.repo': repo, 'mr-precheck.remote': 'origin', 'mr-precheck.target': 'release/1.0' } });
  assert.equal(state.tool, 'commit-reviewer');
  assert.equal(state.inputs['mr-precheck.target'], 'release/1.0');
  assert.equal(canCopySkillPrompt(mr, state.inputs), true);
});

test('shortcut protocol requires one current Repo or one Issue context', () => {
  const base = { type: 'prepareCommitReview', mode: 'commit', revision: 'current' };
  assert.equal(isWorkspaceRequest({ ...base, repo }), true);
  assert.equal(isWorkspaceRequest({ ...base, projectId: 1, issueIid: 123 }), true);
  for (const value of [base, { ...base, projectId: 1 }, { ...base, repo, projectId: 1, issueIid: 2 }, { ...base, repo, mode: 'stage' }]) {
    assert.equal(isWorkspaceRequest(value), false);
  }
});

test('each new task gets new evidence while resumed tasks retain their workspace-bound directory', () => {
  const root = path.resolve('workspace');
  const first = commitReviewRuntime(root);
  assert.notEqual(first, commitReviewRuntime(root));
  assert.equal(first, commitReviewRuntime(root, first));
  assert.throws(() => commitReviewRuntime(path.resolve('another'), first), /證據目錄/);
  assert.throws(() => commitReviewRuntime(root, path.join(root, '.commit-reviewer-runtime', 'untrusted')), /證據目錄/);
});

test('installed native CLI binding checks required payload bytes and old capabilities', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'glw-commit-binding-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const prefix = '.agents/skills/commit-reviewer/';
  const files: Record<string, string> = {};
  for (const name of ['SKILL.md', 'VERSION', 'scripts/commit_review.py', 'scripts/git_evidence.py', 'assets/mr-report.md']) {
    const bytes = name === 'VERSION' ? '0.1.0\n' : 'fixture\n';
    const file = path.join(root, prefix, name);
    await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, bytes);
    files[prefix + name] = createHash('sha256').update(bytes).digest('hex');
  }
  const runner = path.join(root, '.agents/gitlab-workspace-kit/run.py');
  await mkdir(path.dirname(runner), { recursive: true }); await writeFile(runner, 'runner\n');
  files['.agents/gitlab-workspace-kit/run.py'] = createHash('sha256').update('runner\n').digest('hex');
  const marker = path.join(root, '.gitlab-workspace/tool-manifests/workflow-kit.json');
  await mkdir(path.dirname(marker), { recursive: true });
  await writeFile(marker, JSON.stringify({ version: '1.5.0', files, capabilities: ['commit-draft', 'mr-precheck'] }));
  const binding = await readInstalledCommitReviewer(root);
  assert.equal(binding.version, '0.1.0');
  assert.equal(binding.helper, path.join(root, prefix, 'scripts/commit_review.py'));
  await writeFile(path.join(root, prefix, 'scripts/git_evidence.py'), 'changed');
  await assert.rejects(readInstalledCommitReviewer(root), /內容已變更/);
  await writeFile(marker, JSON.stringify({ files, capabilities: ['merge-repo'] }));
  await assert.rejects(readInstalledCommitReviewer(root), /更新 Skills/);
});
