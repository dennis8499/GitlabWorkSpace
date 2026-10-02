import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { WorkspacePanel } from '../../src/workspace/workspacePanel';

// Run real controller methods in the Extension Host with an in-memory GitLab substitute.
// No windows, network writes, Git pushes or live projects are used by these tests.
type Harness = Record<string, any>;
const sourceSha = 'a'.repeat(40), targetSha = 'b'.repeat(40);
const identity = { origin: 'https://gitlab.example.invalid', projectId: 10, mrIid: 4,
  sourceProjectId: 20, targetProjectId: 10, sourceBranch: 'feature', targetBranch: 'main', sourceSha, targetSha };
const request = { project_id: 10, iid: 4, source_project_id: 20, target_project_id: 10,
  source_branch: 'feature', target_branch: 'main', diff_refs: { head_sha: sourceSha } };

function report(body = 'Incomplete review with P1 findings'): string {
  const metadata = { schema: 'MergeReviewReport/v1', ...identity, comparisonBaseSha: targetSha,
    mode: 'merge', repoPath: 'C:/group/repo', contextSha256: 'c'.repeat(64), reviewComplete: false,
    bodySha256: createHash('sha256').update(body).digest('hex') };
  return `${body}\n\n<!-- merge-review-report:${Buffer.from(JSON.stringify(metadata)).toString('base64')} -->\n`;
}

function panel(client: Harness): Harness {
  const values = new Map<string, unknown>();
  return Object.assign(Object.create(WorkspacePanel.prototype), {
    session: { baseUrl: identity.origin, selectedGroup: { id: 3 }, getClient: async () => client },
    projects: [{ id: 10 }], currentUser: { id: 7 }, selectedMergeRequest: { request, discussions: [] },
    mrWritesInFlight: new Set(), post: () => undefined, loadMergeRequest: async () => undefined,
    context: { globalState: {
      get: (key: string, fallback: unknown) => values.get(key) ?? fallback,
      update: async (key: string, value: unknown) => { values.set(key, value); }
    } }
  });
}

suite('Group delivery and version-bound report controller', () => {
  test('publishes a valid incomplete report after rechecking the target immediately before writing', async () => {
    const calls: string[] = [];
    const client = {
      getMergeRequest: async () => request,
      getRepositoryBranch: async (projectId: number) => {
        calls.push(projectId === 20 ? 'source' : 'target');
        return { commit: { id: projectId === 20 ? sourceSha : targetSha } };
      },
      listMergeRequestDiscussions: async () => { calls.push('reconcile'); return []; },
      createMergeRequestNote: async (_project: number, _iid: number, text: string) => {
        calls.push('write'); assert.match(text, /merge-review-report:/);
      }
    };
    await panel(client).publishMergeReviewReport(10, 4, report());
    assert.equal(calls.at(-1), 'write');
    assert.equal(calls.filter((c) => c === 'target').length, 2);
    assert.ok(calls.lastIndexOf('target') > calls.indexOf('reconcile'));
  });

  test('stops publication when the target changes during reconciliation and leaves no uncertain write', async () => {
    let targetReads = 0, writes = 0;
    const client = {
      getMergeRequest: async () => request,
      getRepositoryBranch: async (projectId: number) => ({ commit: { id: projectId === 20 ? sourceSha : ++targetReads === 1 ? targetSha : 'd'.repeat(40) } }),
      listMergeRequestDiscussions: async () => [],
      createMergeRequestNote: async () => { writes++; }
    };
    const view = panel(client);
    await assert.rejects(view.publishMergeReviewReport(10, 4, report()), /版本已變更/);
    assert.equal(writes, 0);
    assert.deepEqual(view.pendingMrWrites(), []);
  });

  test('reconciles an uncertain report response without creating a duplicate note', async () => {
    const notes: Array<{ body: string }> = [];
    let writes = 0;
    const client = {
      getMergeRequest: async () => request,
      getRepositoryBranch: async (projectId: number) => ({ commit: { id: projectId === 20 ? sourceSha : targetSha } }),
      listMergeRequestDiscussions: async () => notes.length ? [{ notes }] : [],
      createMergeRequestNote: async (_project: number, _iid: number, text: string) => {
        writes++; notes.push({ body: text }); throw new Error('response lost');
      }
    };
    const view = panel(client);
    await view.publishMergeReviewReport(10, 4, report());
    await view.publishMergeReviewReport(10, 4, report());
    assert.equal(writes, 1);
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
