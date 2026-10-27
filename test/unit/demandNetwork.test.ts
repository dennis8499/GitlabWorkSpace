import assert from 'node:assert/strict';
import test from 'node:test';
import { GitLabClient } from '../../src/api/gitLabClient';
import { GitLabReadCache, type GitLabReadCacheOptions } from '../../src/api/gitLabReadCache';
import { gitLabReadLifetimeMs } from '../../src/api/gitLabReadKeys';
import type { GitLabMergeRequest } from '../../src/api/types';

const loader = require('node:module'), original = loader._load;
loader._load = (name: string, ...args: unknown[]) => name === 'vscode' ? {} : original(name, ...args);
let WorkspacePanel: any, IssuePanels: any;
try { ({ WorkspacePanel } = require('../../src/workspace/workspacePanel')); ({ IssuePanels } = require('../../src/issues/issuePanel')); }
finally { loader._load = original; }
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
const project = { id: 1, path: 'one', path_with_namespace: 'team/one', http_url_to_repo: 'https://gitlab.test/team/one.git' };
const mr: GitLabMergeRequest = { id: 100, iid: 1, project_id: 1, source_project_id: 1, target_project_id: 1,
  title: 'MR', web_url: 'https://gitlab.test/team/one/-/merge_requests/1', state: 'opened', source_branch: 'feature', target_branch: 'main',
  diff_refs: { base_sha: 'base-review', start_sha: 'start-review', head_sha: 'head-review' } };

function networkFixture() {
  const calls: URL[] = [];
  let now = 0, request = structuredClone(mr);
  let intercept: ((url: URL) => Promise<Response | undefined>) | undefined;
  const client = new GitLabClient('https://gitlab.test', 'test-token', async input => {
    const url = new URL(String(input)); calls.push(url);
    const override = await intercept?.(url); if (override) return override;
    const endpoint = url.pathname;
    const payload = endpoint.endsWith('/user') ? { id: 9, name: 'Tester' }
      : endpoint.endsWith('/merge_requests/1') || endpoint.endsWith('/merge_requests/2') ? { ...request, iid: Number(endpoint.split('/').at(-1)) }
      : endpoint.includes('/repository/branches/') ? { name: endpoint.split('/').at(-1), commit: { id: endpoint.endsWith('/main') ? 'target-live' : 'source-live' } }
      : endpoint.endsWith('/repository/compare') ? { commits: [] }
      : endpoint.endsWith('/diffs') ? [{ old_path: 'a', new_path: 'a', diff: '+b' }]
      : endpoint.endsWith('/versions') ? [{ id: 12, base_commit_sha: request.diff_refs?.base_sha, start_commit_sha: request.diff_refs?.start_sha, head_commit_sha: request.diff_refs?.head_sha }]
      : endpoint.endsWith('/versions/12') ? { id: 12, base_commit_sha: request.diff_refs?.base_sha, start_commit_sha: request.diff_refs?.start_sha, head_commit_sha: request.diff_refs?.head_sha,
        state: 'collected', real_size: '1', diffs: [{ old_path: 'a', new_path: 'a', diff: '+b' }] }
      : endpoint.endsWith('/groups/42/projects') ? [project]
      : endpoint.endsWith('/projects/1') ? project
      : endpoint.endsWith('/issues/1') ? { id: 101, iid: 1, project_id: 1, title: 'Issue', state: 'opened' }
      : endpoint.endsWith('/issues/1/discussions') ? [{ id: 'thread', notes: Array.from({ length: 200 }, (_, id) => ({ id: id + 1, body: '', system: false })) }]
      : [];
    return new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json' } });
  });
  const cache = new GitLabReadCache(60_000, 256, () => now);
  const session = { baseUrl: 'https://gitlab.test', selectedGroup: { id: 42, full_path: 'team' }, connectionEpoch: 1,
    getClient: async () => client, ensureInstanceChecked: async () => {}, issueCapabilities: {},
    cachedRead: <T>(key: string, load: (client: GitLabClient, signal: AbortSignal) => Promise<T>, options: GitLabReadCacheOptions = {}) =>
      cache.get(key, signal => load(client.withReadSignal(signal), signal), { ...options, lifetimeMs: gitLabReadLifetimeMs(key) }) };
  const host: any = Object.create(WorkspacePanel.prototype);
  Object.assign(host, { disposed: false, panel: { visible: true }, session, currentUser: { id: 9 }, projects: [project], workspaceSections: { projects: { status: 'ready' } },
    requestGeneration: 1, mergeRequestGeneration: 0, mergeRequestSectionGenerations: { diffs: 0, discussions: 0 }, mergeRequestSectionAborts: {},
    context: { globalState: { update: async () => {} } }, sendSnapshot: () => {}, setBusyOwner: () => {}, noteOutcome: () => {} });
  Object.defineProperty(host, 'notifications', { value: { publish: () => {} } });
  return { client, session, cache, calls, host, advance: (ms: number) => { now += ms; },
    change: (patch: Partial<GitLabMergeRequest>) => { request = { ...request, ...patch }; },
    intercept: (handler: typeof intercept) => { intercept = handler; } };
}

test('MR selection is one actual HTTP GET, joins duplicate clicks, and branch checks preserve the reviewed Diff SHA', async () => {
  const f = networkFixture();
  await Promise.all([f.host.loadMergeRequest(1, 1), f.host.loadMergeRequest(1, 1)]);
  assert.deepEqual(f.calls.map(url => url.pathname), ['/api/v4/projects/1/merge_requests/1']);
  assert.equal(f.host.selectedMergeRequest.freshness.state, 'not_checked');
  await f.host.loadMergeRequestSection('diffs', 1, 1);
  await f.host.loadMergeRequestSection('discussions', 1, 1);
  const diffs = f.host.selectedMergeRequest.diffs;
  await f.host.loadMergeRequest(1, 1);
  assert.equal(f.calls.length, 4); assert.equal(f.host.selectedMergeRequest.diffs, diffs);
  await Promise.all([f.host.refreshMergeRequestBranches(1, 1), f.host.refreshMergeRequestBranches(1, 1)]);
  assert.equal(f.calls.length, 8, 'one explicit check adds a fresh summary, two branches and compare');
  assert.equal(f.host.selectedMergeRequest.sourceSha, 'head-review');
  assert.equal(f.host.selectedMergeRequest.targetSha, 'start-review');
  assert.equal(f.host.selectedMergeRequest.freshness.sourceSha, 'source-live');
  assert.equal(f.host.selectedMergeRequest.diffs, diffs);
  const before = f.calls.length;
  await f.host.refreshMergeRequestData(1, 1, 'used');
  assert.equal(f.calls.length, before + 4, 'manual refresh updates summary, fixed Diff version and discussions');
  assert.equal(f.calls.slice(before).some(url => /branches|compare/.test(url.pathname)), false);
  f.advance(60_001); await f.host.loadMergeRequest(1, 1);
  assert.equal(f.calls.filter(url => url.pathname.endsWith('/merge_requests/1')).length, 4);
  f.host.selectedMergeRequest.sections.discussions.updatedAt -= 60_001;
  await f.host.loadMergeRequest(1, 1);
  await f.host.loadMergeRequestSection('discussions', 1, 1);
  assert.equal(f.calls.filter(url => url.pathname.endsWith('/discussions')).length, 3, 'the used discussion tab revalidates after its 60-second lifetime');
});

test('MR identity changes cancel an old Diff and late old account results cannot replace the current selection', async () => {
  const f = networkFixture(); await f.host.loadMergeRequest(1, 1);
  let finish!: () => void;
  const delayed = new Promise<void>(resolve => { finish = resolve; });
  f.intercept(async url => { if (url.pathname.endsWith('/versions/12')) { await delayed; return new Response(JSON.stringify({ id: 12, base_commit_sha: 'base-review', start_commit_sha: 'start-review', head_commit_sha: 'head-review', state: 'collected', real_size: '1', diffs: [{ old_path: 'old', new_path: 'old', diff: '+old' }] }), { headers: { 'content-type': 'application/json' } }); } });
  const pending = f.host.loadMergeRequestSection('diffs', 1, 1); await tick();
  f.host.cancelMergeRequestSectionReads();
  assert.equal(f.host.selectedMergeRequest.sections.diffs.status, 'idle', 'hidden views can resume an interrupted section');
  f.change({ diff_refs: { base_sha: 'new-base', start_sha: 'new-start', head_sha: 'new-head' } });
  await f.host.loadMergeRequest(1, 1, { force: true });
  assert.equal(f.host.selectedMergeRequest.sections.diffs.status, 'idle');
  finish(); await pending;
  assert.deepEqual(f.host.selectedMergeRequest.diffs, []);
  f.intercept(undefined); await f.host.loadMergeRequestSection('diffs', 1, 1);
  assert.equal(f.host.selectedMergeRequest.sections.diffs.status, 'ready');
  f.session.connectionEpoch++; f.host.requestGeneration++; f.host.cancelMergeRequestSectionReads(); f.cache.invalidate();
  await f.host.loadMergeRequest(1, 2);
  assert.equal(f.host.selectedMergeRequest.request.iid, 2);
  assert.deepEqual(f.host.selectedMergeRequest.diffs, [], 'Diff data is not cached across MR selections');
});

test('preview then Issue details shares actual HTTP reads and 200 comments have zero initial reaction GETs', async () => {
  const f = networkFixture(), panels = new IssuePanels({}, f.session, () => {});
  panels.setWorkspace({ post: () => {}, navigate: () => {}, show: async () => {} }); Object.assign(panels, { ready: true });
  try {
    const issue = await f.session.cachedRead('project/1/issue/1', client => client.getIssue(1, 1));
    await f.session.cachedRead('project/1/details', client => client.getProject(1));
    await f.session.cachedRead('current-user', client => client.getCurrentUser());
    const before = f.calls.length;
    await panels.showIssue(issue); await panels.handle({ type: 'loadSection', sections: ['activity', 'permissions'] });
    assert.equal(f.calls.filter(url => url.pathname.endsWith('/issues/1')).length, 1);
    assert.equal(f.calls.slice(before).some(url => /members|award_emoji/.test(url.pathname)), false);
    await Promise.all([panels.handle({ type: 'loadNoteReactions', noteId: 1 }), panels.handle({ type: 'loadNoteReactions', noteId: 1 }), panels.handle({ type: 'loadNoteReactions', noteId: 2 })]);
    assert.deepEqual(f.calls.filter(url => url.pathname.endsWith('/award_emoji')).map(url => url.pathname).sort(), [
      '/api/v4/projects/1/issues/1/notes/1/award_emoji', '/api/v4/projects/1/issues/1/notes/2/award_emoji']);
    await panels.showIssue(issue); await panels.handle({ type: 'loadSection', sections: ['activity', 'permissions'] }); await panels.handle({ type: 'loadNoteReactions', noteId: 1 });
    assert.equal(f.calls.filter(url => url.pathname.endsWith('/award_emoji')).length, 2);
    await panels.handle({ type: 'refresh' }); await panels.handle({ type: 'loadSection', sections: ['permissions'] }); await tick();
    assert.equal(f.calls.filter(url => url.pathname.endsWith('/issues/1')).length, 2);
    assert.equal(f.calls.filter(url => url.pathname.endsWith('/projects/1')).length, 5, 'each detail entry checks fresh Owner access in addition to cached project data');
  } finally { panels.dispose(); }
});

test('failed MR refresh makes a previously allowed merge unavailable until rechecked', async () => {
  const f = networkFixture();
  f.change({ user: { can_merge: true }, draft: false, has_conflicts: false, rebase_in_progress: false, detailed_merge_status: 'mergeable' });
  await f.host.loadMergeRequest(1, 1);
  assert.equal(f.host.selectedMergeRequest.mergeAvailability.status, 'allowed');
  f.intercept(async url => url.pathname.endsWith('/merge_requests/1') ? new Response('{}', { status: 403 }) : undefined);
  await assert.rejects(f.host.loadMergeRequest(1, 1, { force: true }));
  assert.equal(f.host.selectedMergeRequest.mergeAvailability.status, 'unknown');
});

test('new Issue form performs zero option HTTP GETs until each section is explicitly requested', async () => {
  const f = networkFixture(), panels = new IssuePanels({}, f.session, () => {});
  panels.setWorkspace({ post: () => {}, navigate: () => {}, show: async () => {} }); Object.assign(panels, { ready: true });
  try {
    await panels.showCreate();
    assert.deepEqual(f.calls.map(url => url.pathname), ['/api/v4/groups/42/projects']);
    await Promise.all([panels.handle({ type: 'loadFormOptions', projectId: 1, section: 'fields' }), panels.handle({ type: 'loadFormOptions', projectId: 1, section: 'fields' })]);
    assert.deepEqual(f.calls.slice(1).map(url => url.pathname).sort(), ['/api/v4/projects/1/labels', '/api/v4/projects/1/members/all', '/api/v4/projects/1/milestones']);
    await panels.handle({ type: 'loadFormOptions', projectId: 1, section: 'templates' });
    assert.equal(f.calls.length, 5); assert.equal(f.calls.at(-1)!.pathname, '/api/v4/projects/1/templates/issues');
  } finally { panels.dispose(); }
});
