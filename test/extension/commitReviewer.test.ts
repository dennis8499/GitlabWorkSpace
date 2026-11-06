import assert from 'node:assert/strict';
import { realpath } from 'node:fs/promises';
import path from 'node:path';
import { WorkspacePanel } from '../../src/workspace/workspacePanel';
import { commitReviewRuntime } from '../../src/workspace/commitReviewer';

type Harness = Record<string, any>;
const repo = { name: 'service', path: 'C:/workspace/service', projectId: 1 };
const project = { id: 1, path_with_namespace: 'team/service', default_branch: 'main' };

suite('CommitReviewer trusted form handoff', () => {
  function fixture() {
    const replies: any[] = [];
    const skills = { revision: 'current', repositories: [repo], reviewerRepositories: [repo] };
    const view: Harness = Object.assign(Object.create(WorkspacePanel.prototype), {
      session: { connectionEpoch: 1 }, projects: [project],
      getSkillsContext: () => skills, connectedScopeKey: () => 'account:group',
      refreshWorkflowKit: async () => undefined, refreshInventory: async () => undefined,
      resolveGroupProject: async () => project, inspectEnvironment: async () => ({ repositories: [repo] }),
      post: (message: unknown) => replies.push(message)
    });
    return { view, replies, skills };
  }

  test('Git and Issue handoffs only fill current repository inputs', async () => {
    const { view, replies } = fixture();
    await view.prepareCommitReview({ mode: 'commit', revision: 'current', repo: repo.path });
    assert.deepEqual(replies.pop(), { type: 'commitReviewReady', revision: 'current', mode: 'commit', inputs: { 'commit-draft.repo': repo.path } });
    await view.prepareCommitReview({ mode: 'commit', revision: 'current', projectId: 1, issueIid: 123 });
    assert.equal(replies.at(-1).inputs['commit-draft.issues'], 'team/service#123');
    await view.prepareCommitReview({ mode: 'mr', revision: 'current', projectId: 1, issueIid: 123 });
    assert.equal(replies.at(-1).inputs['mr-precheck.target'], 'main');
    assert.equal(replies.at(-1).inputs['mr-precheck.remote'], undefined);
  });

  test('ambiguous Issue repositories remain unselected and stale contexts are rejected', async () => {
    const { view, replies, skills } = fixture();
    const second = { ...repo, path: 'C:/workspace/another' };
    skills.reviewerRepositories = [repo, second];
    view.inspectEnvironment = async () => ({ repositories: [repo, second] });
    await view.prepareCommitReview({ mode: 'commit', revision: 'current', projectId: 1, issueIid: 123 });
    assert.equal(replies.at(-1).inputs['commit-draft.repo'], '');
    await assert.rejects(view.prepareCommitReview({ mode: 'commit', revision: 'old', repo: repo.path }), /已變更/);
    await assert.rejects(view.prepareCommitReview({ mode: 'commit', revision: 'current', repo: 'C:/outside' }), /不在目前/);
    view.resolveGroupProject = async () => { view.session.connectionEpoch++; return project; };
    await assert.rejects(view.prepareCommitReview({ mode: 'mr', revision: 'current', projectId: 1, issueIid: 123 }), /帳號或專案已變更/);
  });

  test('resumed Codex skill tasks retain evidence while new tasks receive separate directories', async () => {
    const root = await realpath(path.resolve(__dirname, '../../..'));
    const source = { kind: 'skill', featureId: 'commit-draft', inputs: {}, revision: 'current' };
    const view: Harness = Object.assign(Object.create(WorkspacePanel.prototype), {
      resolveProjectContext: async () => ({ root }), refreshWorkflowKit: async () => undefined,
      getSkillsContext: () => ({ revision: 'current' }),
      prepareSkillGuideTask: async (request: unknown, requestId?: string, runtime?: string) => ({
        source: request, root, skill: { name: 'commit-reviewer', path: __filename },
        commitReview: { runtimeRoot: commitReviewRuntime(root, runtime) }
      })
    });
    const first = await view.prepareCodexTask(source);
    const resumed = await view.prepareCodexTask(source, first);
    const second = await view.prepareCodexTask(source);
    assert.equal(resumed.commitReview.runtimeRoot, first.commitReview.runtimeRoot);
    assert.notEqual(second.commitReview.runtimeRoot, first.commitReview.runtimeRoot);
    assert.equal(resumed.review, undefined);
    assert.equal(resumed.routing, undefined);
  });
});
