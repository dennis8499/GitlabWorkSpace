import assert from 'node:assert/strict';
import { WorkspacePanel } from '../../src/workspace/workspacePanel';

// Run real controller methods in the Extension Host with an in-memory GitLab substitute.
// No windows, network writes, Git pushes or live projects are used by these tests.
type Harness = Record<string, any>;
const sourceSha = 'a'.repeat(40), targetSha = 'b'.repeat(40);
const identity = { origin: 'https://gitlab.example.invalid', projectId: 10, mrIid: 4,
  sourceProjectId: 20, targetProjectId: 10, sourceBranch: 'feature', targetBranch: 'main', sourceSha, targetSha };
const request = { project_id: 10, iid: 4, source_project_id: 20, target_project_id: 10,
  source_branch: 'feature', target_branch: 'main', diff_refs: { head_sha: sourceSha } };
const groupRoot = 'C:/group', repoPath = 'C:/group/repo';

function panel(client: Harness): Harness {
  const values = new Map<string, unknown>();
  return Object.assign(Object.create(WorkspacePanel.prototype), {
    session: { baseUrl: identity.origin, selectedGroup: { id: 3 }, getClient: async () => client },
    projects: [{ id: 10 }], currentUser: { id: 7 }, selectedMergeRequest: { request, discussions: [] },
    groupRoot, getSkillsContext: () => ({ groupMatch: { status: 'matched', root: groupRoot,
      repositories: [{ path: repoPath, projectId: 10, matched: true }] } }),
    mrWritesInFlight: new Set(), post: () => undefined, loadMergeRequest: async () => undefined,
    context: { globalState: {
      get: (key: string, fallback: unknown) => values.get(key) ?? fallback,
      update: async (key: string, value: unknown) => { values.set(key, value); }
    } }
  });
}

suite('Group delivery and version-bound report controller', () => {
  test('manual comments recheck the current MR head and reconcile a lost response', async () => {
    const notes: Array<{ body: string }> = []; let writes = 0;
    const view = panel({ getMergeRequest: async () => request, listMergeRequestDiscussions: async () => notes.length ? [{ notes }] : [],
      createMergeRequestNote: async (_project: number, _iid: number, text: string) => { writes++; notes.push({ body: text }); throw new Error('response lost'); } });
    await view.postMergeRequestNote(10, 4, 'Merge Report: Repo\nStatic findings');
    await view.postMergeRequestNote(10, 4, 'Merge Report: Repo\nStatic findings');
    assert.equal(writes, 1);
    view.session.getClient = async () => ({ getMergeRequest: async () => ({ ...request, diff_refs: { head_sha: targetSha } }) });
    await assert.rejects(view.postMergeRequestNote(10, 4, 'New note'), /SHA 已變更/);
    assert.equal(typeof view.publishMergeReviewReport, 'undefined');
    assert.equal(typeof view.openGroupQuickReview, 'undefined');
  });

  test('recovers an already pushed immutable commit before invoking Git or requesting credentials', async () => {
    const client = { getProject: async () => ({ id: 10 }), getRepositoryBranch: async () => ({ commit: { id: sourceSha } }) };
    const view = panel(client);
    let verified = 0, saved: Harness | undefined;
    view.requireDelivery = () => ({ id: 'delivery', state: 'committed', projectId: 10, branch: 'feature', headSha: sourceSha });
    view.verifyDeliveredCommit = async () => { verified++; };
    view.saveDelivery = async (value: Harness) => { saved = value; };
    view.session.getCloneCredentials = async () => { throw new Error('must not push again'); };
    await view.pushDelivery('delivery');
    assert.equal(verified, 1);
    assert.equal(saved?.state, 'pushed');
    assert.equal(saved?.headSha, sourceSha);
    client.getRepositoryBranch = async () => ({ commit: { id: targetSha } });
    await assert.rejects(view.pushDelivery('delivery'), /不同版本/);
  });

  test('reconciles an uncertain multi-Repo MR response using the original Issue project', async () => {
    let created: Harness | undefined, writes = 0, issueProject = 0, saved: Harness | undefined;
    const client = {
      getIssue: async (projectId: number) => { issueProject = projectId; return { iid: 4, web_url: 'https://gitlab.example.invalid/group/issue/-/issues/4' }; },
      getProject: async () => ({ id: 10, path_with_namespace: 'group/repo' }),
      findOpenMergeRequestsBySourceBranch: async () => created ? [created] : [],
      getRepositoryBranch: async () => ({ commit: { id: sourceSha } }),
      createMergeRequest: async (_id: number, input: Harness) => {
        writes++; assert.match(input.description, /group\/issue\/-\/issues\/4/);
        created = { project_id: 10, source_branch: 'feature', target_branch: 'main', state: 'opened',
          diff_refs: { head_sha: sourceSha }, web_url: 'https://gitlab.example.invalid/group/repo/-/merge_requests/5' };
        throw new Error('response lost');
      }
    };
    const view = panel(client);
    view.requireDelivery = () => ({ id: 'delivery', state: 'pushed', projectId: 10, issueProjectId: 30, issueIid: 4,
      branch: 'feature', targetBranch: 'main', headSha: sourceSha, reviewerIds: [], summary: 'Change',
      workId: 'work-20261002-example', acceptanceVersion: 'acceptance-v1', changes: 'Change', tests: 'passed' });
    view.verifyDeliveredCommit = async () => undefined;
    view.saveDelivery = async (value: Harness) => { saved = value; };
    await view.createDeliveryMergeRequest('delivery');
    await view.createDeliveryMergeRequest('delivery');
    assert.equal(issueProject, 30);
    assert.equal(writes, 1);
    assert.equal(saved?.state, 'mr-created');
  });
});
