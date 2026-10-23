import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { issueGraphNodeKey } from '../../src/workspace/issueGraph';
import { GitLabRequestBudget } from '../../src/api/gitLabRequestBudget';
import { GitLabReadCache } from '../../src/api/gitLabReadCache';
import type { Memento, SecretStorage } from 'vscode';
import { GitLabSession } from '../../src/connection/session';
import { ACCOUNTS_KEY, ACTIVE_ACCOUNT_KEY, accountId, accountTokenKey } from '../../src/connection/accountStore';

const executedCommands: string[] = [];
const vscode = {
  workspace: { workspaceFolders: [] as unknown[], isTrusted: false },
  commands: { executeCommand: async (command: string) => { executedCommands.push(command); } }
};
const moduleLoader = require('node:module') as { _load: (name: string, parent: unknown, main: boolean) => unknown };
const originalLoad = moduleLoader._load;
moduleLoader._load = (name, parent, main) => name === 'vscode' ? vscode : originalLoad(name, parent, main);
let WorkspacePanel: typeof import('../../src/workspace/workspacePanel').WorkspacePanel;
try { ({ WorkspacePanel } = require('../../src/workspace/workspacePanel')); }
finally { moduleLoader._load = originalLoad; }

function fixture(mode: string, connected = true) {
  const remote: Array<{ resource: string; groupId?: number }> = [];
  const cacheReads: Array<{ key: string; force?: boolean }> = [];
  const local: string[] = [], messages: any[] = [];
  const groups = [42, 43].map(id => ({ id, name: `Team ${id}`, full_path: `team-${id}`, web_url: '' }));
  const project = { id: 101, name: 'Project', path: 'project', path_with_namespace: 'team-42/project',
    web_url: 'https://gitlab.test/team-42/project', http_url_to_repo: 'https://gitlab.test/team-42/project.git' };
  const client: any = {
    getCurrentUser: async () => { remote.push({ resource: 'user' }); return { id: 7, name: 'Me', username: 'me' }; },
    listGroups: async () => { remote.push({ resource: 'groups' }); return groups; },
    listGroupProjects: async (groupId: number) => { remote.push({ resource: 'projects', groupId }); return [project]; },
    listAssignedGroupIssues: async (groupId: number) => { remote.push({ resource: 'issues', groupId }); return [
      { id: 1001, project_id: 101, iid: 1, state: 'opened', title: 'My Issue' },
      { id: 9001, project_id: 999, iid: 1, state: 'opened', title: 'Outside selected Group' }
    ]; },
    listGroupMergeRequests: async (groupId: number) => { remote.push({ resource: 'mergeRequests', groupId }); return []; },
    listGroupIssueBoards: async (groupId: number) => { remote.push({ resource: 'boards', groupId }); return []; },
    listGroupMilestones: async (groupId: number) => { remote.push({ resource: 'milestones', groupId }); return []; }
  };
  const context = { root: 'C:/local-project', revision: 'local-revision', folders: [], manual: false };
  const host: any = Object.create(WorkspacePanel!.prototype);
  Object.assign(host, {
    disposed: false, panel: { visible: true }, webviewReady: true, activeMode: mode,
    projectSource: 'gitlab', developerView: 'list', requestGeneration: 0, workspaceFoldersGeneration: 0,
    viewGeneration: 0, viewReadAbort: new AbortController(), pendingViewNotices: [], issueNavigation: null,
    skillsEnvironmentGeneration: 0, workflowKitRefreshGeneration: 0, cloneRootGeneration: 0,
    projectRepositoryScanGeneration: 0, inventoryGeneration: 0, previewGeneration: 0,
    issueOpenGeneration: 0, issueBoardGeneration: 0, issueGraphGeneration: 0, mergeRequestGeneration: 0,
    localRepositoryScanGeneration: 0, actualRepositoryScanGeneration: 0,
    workspaceSectionGenerations: new Map(), workspaceSectionAborts: new Map(), workspaceSections: {},
    mergeRequestSectionAborts: {}, mergeRequestSectionGenerations: { diffs: 0, discussions: 0 },
    groups: connected ? groups : [], currentUser: connected ? { id: 7, name: 'Me', username: 'me' } : undefined,
    loadedScopeKey: connected ? 'https://gitlab.test|7|42' : undefined,
    projects: [], issues: [], mergeRequests: [], groupIssueBoards: [], groupMilestones: [],
    projectContext: context, groupRoot: context.root, cloneRoot: context.root,
    workspaceMatch: { status: 'matched', root: context.root, profile: 'group', repositories: [] },
    skillsWorkflowKitState: { status: 'installed', workspaceContract: 2, installerApi: 1, profile: 'group', version: 'test', capabilities: ['codebase-wiki'] },
    skillBranchReads: new Map(), reviewerNativeRepositories: [], remoteWatchers: [],
    repositoryScan: { status: 'idle', checkedDirectories: 0, repositories: [], errors: [], excludes: [] },
    context: { globalState: { get: () => undefined, update: async () => undefined },
      workspaceState: { get: () => undefined, update: async () => undefined }, extension: { packageJSON: { version: 'test' } } },
    session: {
      baseUrl: connected ? 'https://gitlab.test' : undefined, selectedGroup: connected ? groups[0] : undefined, connectionEpoch: 1,
      cachedRead: async (key: string, load: (readClient: unknown) => Promise<unknown>, options: { force?: boolean } = {}) => {
        cacheReads.push({ key, force: options.force }); return load(client);
      },
      setSelectedGroup: async (group: unknown) => { host.session.selectedGroup = group; },
      updateCurrentUser: async () => undefined,
      ensureMetadataChecked: async () => { remote.push({ resource: 'metadata' }); },
      ensureInstanceChecked: async () => { throw new Error('Page entry must not inspect the Issue schema'); }
    },
    issuePanels: { close: () => undefined, suspendReads: () => undefined },
    timer: { setScope: async () => undefined }, syncTimerPolling: () => undefined,
    setBusyOwner: () => undefined, sendSnapshot: () => { messages.push({ type: 'snapshot' }); },
    post: (message: unknown) => { messages.push(message); },
    resolveProjectContext: async () => context, projectContextSignature: () => 'local-signature',
    refreshWorkflowKit: async () => { local.push('skills'); },
    refreshInventory: async () => { local.push('inventory'); },
    refreshBmadWorkflow: async () => { local.push('bmad'); },
    refreshProjectRoot: async () => { local.push('download-root'); },
    sendGitRepositories: async () => { local.push('git-list'); },
    syncBmadVisibility: () => undefined,
    gitRepositories: {
      setActivePanelRepository: () => undefined,
      refresh: async () => { local.push('git-refresh'); },
      handleAction: async (_id: string, action: { type: string }) => { local.push(`git-${action.type}-snapshot`); return { id: 'repo' }; }
    }
  });
  return { host, client, remote, cacheReads, local, messages, context, groups };
}

test('a cold signed-in project entry makes four API reads and never initializes Issue features', async () => {
  const { host, groups } = fixture('clone');
  const baseUrl = 'https://gitlab.test';
  const id = accountId(baseUrl, 7);
  const values = new Map<string, unknown>([
    [ACCOUNTS_KEY, [{ id, baseUrl, userId: 7, name: 'Me', username: 'me', needsLogin: false,
      group: { id: groups[0].id, fullPath: groups[0].full_path } }]],
    [ACTIVE_ACCOUNT_KEY, id]
  ]);
  const state: Memento = {
    get: <T>(key: string, fallback?: T): T | undefined => values.has(key) ? values.get(key) as T : fallback,
    update: async (key: string, value: unknown) => { values.set(key, value); },
    keys: () => [...values.keys()]
  };
  const secrets: SecretStorage = {
    get: async (key: string) => key === accountTokenKey(id) ? 'fixture-only-token' : undefined,
    store: async () => undefined, delete: async () => undefined,
    onDidChange: () => ({ dispose() {} })
  };
  const session = new GitLabSession(secrets, state, true);
  const requests: string[] = [];
  session.setFetchForTesting(async input => {
    const endpoint = new URL(String(input)).pathname;
    requests.push(endpoint);
    let body: unknown;
    if (endpoint === '/api/v4/user') body = { id: 7, name: 'Me', username: 'me' };
    else if (endpoint === '/api/v4/groups') body = groups;
    else if (endpoint === '/api/v4/metadata') body = { version: '16.11.10', enterprise: false };
    else if (endpoint === '/api/v4/groups/42/projects') body = [];
    else throw new Error(`Project entry must not request ${endpoint}`);
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  });
  Object.assign(host, { session, currentUser: undefined, groups: [] });
  await session.initialize({ allowNetwork: false });
  await host.refresh({ reason: 'entry' });
  await session.ensureMetadataChecked();
  assert.deepEqual(requests.sort(), ['/api/v4/groups', '/api/v4/groups/42/projects', '/api/v4/metadata', '/api/v4/user']);
  assert.equal(session.issueCapabilities, undefined);
  assert.equal(session.capabilityDiagnostics.find(item => item.id === 'tasks')?.status, 'unknown');
  await host.refresh({ reason: 'entry' });
  await session.ensureMetadataChecked();
  assert.equal(requests.length, 4, 're-entering the same fresh project page reuses its data');
});

test('workspace pages retain completed pages, bound full-load batches and continue from their next cursor', async () => {
  const { host, client } = fixture('clone');
  const requested: Array<string | undefined> = [];
  client.listGroupProjectsPage = async (_groupId: number, cursor?: string) => {
    requested.push(cursor); const page = Number(cursor ?? '1');
    return { items: [{ id: page, path: `repo-${page}`, path_with_namespace: `team/repo-${page}` }], nextCursor: page < 24 ? String(page + 1) : undefined, complete: page === 24, updatedAt: new Date().toISOString() };
  };
  await host.loadWorkspaceSection('projects');
  assert.deepEqual(requested, [undefined]); assert.equal(host.projects.length, 1); assert.equal(host.workspaceSections.projects.complete, false);
  await host.loadWorkspaceSection('projects', false, 'all');
  assert.equal(requested.length, 21, 'one explicit full-load batch performs at most twenty page requests');
  assert.equal(host.projects.length, 21); assert.equal(host.workspaceSections.projects.complete, false); assert.match(host.workspaceSections.projects.pausedReason, /預算/);
  await host.loadWorkspaceSection('projects', false, 'all');
  assert.equal(host.projects.length, 24); assert.equal(host.workspaceSections.projects.complete, true);
  assert.equal(new Set(requested).size, 24, 'continuation never re-reads a completed page');
  await host.loadWorkspaceSection('projects', false, 'next'); assert.equal(requested.length, 24);
});

test('cancelling a page keeps its completed prefix and resumes the unfinished cursor', async () => {
  const { host, client } = fixture('clone'); const requested: Array<string | undefined> = [];
  let finish!: (value: unknown) => void;
  client.listGroupProjectsPage = async (_id: number, cursor?: string) => {
    requested.push(cursor);
    if (!cursor) return { items: [{ id: 1 }], nextCursor: 'second', complete: false, updatedAt: new Date().toISOString() };
    return new Promise(resolve => { finish = resolve; });
  };
  await host.loadWorkspaceSection('projects');
  const pending = host.loadWorkspaceSection('projects', false, 'next');
  await new Promise(resolve => setImmediate(resolve)); host.workspaceSectionAborts.get('projects').abort();
  finish({ items: [{ id: 2 }], complete: true, updatedAt: new Date().toISOString() }); await pending;
  assert.deepEqual(host.projects.map((project: any) => project.id), [1]); assert.equal(host.workspaceSections.projects.refreshing, false);
  const resumed = host.loadWorkspaceSection('projects', false, 'next'); await new Promise(resolve => setImmediate(resolve));
  finish({ items: [{ id: 2 }], complete: true, updatedAt: new Date().toISOString() }); await resumed;
  assert.deepEqual(requested, [undefined, 'second', 'second']); assert.equal(host.workspaceSections.projects.complete, true);
});

test('an external inventory refresh replaces old dashboard rows before entry or continuation', async t => {
  for (const mode of [undefined, 'next'] as const) await t.test(mode ?? 'entry', async () => {
    const { host, client } = fixture('clone');
    let revision = 1;
    const requests: Array<string | undefined> = [];
    host.session.getGroupProjectsRevision = () => revision;
    client.listGroupProjectsPage = async (_groupId: number, cursor?: string) => {
      requests.push(cursor);
      assert.equal(cursor, undefined, 'a new inventory snapshot must restart from its first page');
      return { items: [{ id: revision }], complete: revision === 2,
        nextCursor: revision === 1 ? 'old-second-page' : undefined, updatedAt: new Date().toISOString() };
    };
    await host.loadWorkspaceSection('projects');
    assert.deepEqual(host.projects.map((project: any) => project.id), [1]);
    revision = 2; // Another consumer force-refreshed the shared first page.
    await host.loadWorkspaceSection('projects', false, mode);
    assert.deepEqual(host.projects.map((project: any) => project.id), [2]);
    assert.equal(host.workspaceSections.projects.complete, true);
    assert.deepEqual(requests, [undefined, undefined]);
  });
});

test('a late continuation from an older inventory generation cannot append to dashboard rows', async () => {
  const { host, client } = fixture('clone');
  let revision = 1, finish!: (value: unknown) => void;
  host.session.getGroupProjectsRevision = () => revision;
  client.listGroupProjectsPage = async (_groupId: number, cursor?: string) => cursor
    ? new Promise(resolve => { finish = resolve; })
    : { items: [{ id: revision }], complete: revision === 2, nextCursor: revision === 1 ? 'second' : undefined, updatedAt: new Date().toISOString() };
  await host.loadWorkspaceSection('projects');
  const continuation = host.loadWorkspaceSection('projects', false, 'next');
  revision = 2;
  finish({ items: [{ id: 9 }], complete: true, updatedAt: new Date().toISOString() });
  await continuation;
  assert.deepEqual(host.projects.map((project: any) => project.id), [1]);
  assert.equal(host.workspaceSections.projects.status, 'idle');
  assert.equal(host.workspaceSections.projects.complete, false, 'stale partial rows must not be treated as a complete clone inventory');
  await host.loadWorkspaceSection('projects');
  assert.deepEqual(host.projects.map((project: any) => project.id), [2]);
});

test('closed assigned Issues load only on an explicit history request and the current-work view can be restored', async () => {
  const { host, client } = fixture('developer'); const states: string[] = [];
  host.projects = [{ id: 101 }]; host.loadedScopeKey = 'https://gitlab.test|7|42';
  host.workspaceSections.projects = { status: 'ready', complete: true };
  client.listAssignedGroupIssuesPage = async (_id: number, _cursor: string | undefined, state: string) => {
    states.push(state); return { items: [{ id: 1, project_id: 101, iid: 1, state: 'opened' }, ...(state === 'all' ? [{ id: 2, project_id: 101, iid: 2, state: 'closed' }] : [])], complete: true, updatedAt: new Date().toISOString() };
  };
  await host.loadWorkspaceSection('issues'); assert.equal(host.issues.length, 1);
  await host.loadWorkspaceSection('issues', false, 'history'); assert.equal(host.issues.length, 2); assert.equal(host.workspaceSections.issues.includeClosed, true);
  await host.loadWorkspaceSection('issues', false, 'current'); assert.equal(host.issues.length, 1);
  assert.deepEqual(states, ['opened', 'all', 'opened']);
});

test('an explicit Issue selection resolves an unloaded Group project without downloading the full project inventory', async () => {
  const { host, client, remote } = fixture('developer');
  host.projects = [{ id: 101 }]; host.workspaceSections.projects = { status: 'ready', complete: false };
  const issue = { id: 2, project_id: 999, iid: 2, title: 'From the next project page', state: 'opened', labels: [] };
  host.issues = [issue]; let metadataReads = 0;
  client.getProject = async () => { metadataReads++; return { id: 999, path: 'other', path_with_namespace: 'team-42/other', name: 'Other', http_url_to_repo: '', web_url: '' }; };
  client.getIssue = async () => issue;
  await host.selectIssue(999, 2);
  assert.equal(host.selectedIssue.project.id, 999); assert.equal(host.issuePreview.status, 'ready');
  assert.equal(metadataReads, 1); assert.equal(remote.length, 0, 'selection does not download the remaining inventory');
  host.issues.push({ ...issue, project_id: 888 });
  client.getProject = async () => ({ id: 888, path_with_namespace: 'other-group/repo' });
  await assert.rejects(host.resolveGroupProject(888), /不屬於/);
  assert.equal(host.projects.some((project: any) => project.id === 888), false);
});

test('ten thousand Issues and one hundred Boards show one hundred roots without network fan-out; expansion preserves closed context and colors', async () => {
  const { host, client } = fixture('developer');
  host.projects = [{ id: 101, name: 'Repo', path: 'repo', path_with_namespace: 'team-42/repo', http_url_to_repo: 'https://gitlab.test/team-42/repo.git', web_url: '' }];
  host.issues = Array.from({ length: 10_000 }, (_, index) => ({ id: index + 1, project_id: 101, iid: index + 1, title: `Issue ${index + 1}`, state: 'opened', labels: [], web_url: '' }));
  host.groupIssueBoards = Array.from({ length: 100 }, (_, index) => ({ id: index + 9, name: `Board ${index + 9}` })); host.issueGraphVersion = 0;
  client.listGroupIssueBoards = async () => host.groupIssueBoards;
  host.session.getClient = async () => client;
  host.session.issueCapabilities = { graphWorkItems: true, graphLinkedItems: true };
  let relations = 0, boards = 0, labels = 0;
  client.listProjectLabels = async () => { labels++; return []; };
  client.loadIssueGraphRelations = async () => {
    relations++; return { parents: [], children: [], links: [{ type: 'relates_to', item: { id: 'gid://gitlab/WorkItem/999', iid: '999', title: 'Closed related Issue', state: 'closed', project: { id: 'gid://gitlab/Project/101', fullPath: 'team-42/repo' }, workItemType: { name: 'Issue' } } }] };
  };
  client.listGroupBoardIssueMemberships = async (_path: string, boardId: number) => { boards++; return boardId === 9 ? [{ issueId: 999, projectId: 101, iid: 999 }, { issueId: 1, projectId: 101, iid: 1 }] : []; };
  const scope = host.connectedScopeKey();
  await host.loadIssueGraph(scope);
  assert.equal(host.issueGraph.roots.length, 100); assert.equal(relations, 0); assert.equal(boards, 0); assert.equal(labels, 0);
  assert.equal(host.issueGraph.boardStatus[9].status, 'idle');
  const first = host.issueGraph.roots[0]; await host.loadIssueGraph(scope, false, [first]);
  assert.equal(relations, 1); assert.equal(boards, 0);
  const relatedId = issueGraphNodeKey(101, 'team-42/repo', 999);
  assert.equal(host.issueGraph.nodes.find((node: any) => node.id === relatedId).state, 'closed');
  await host.loadIssueGraph(scope, false, undefined, true);
  assert.equal(boards, 20, 'Board membership is loaded only by explicit request, at most twenty Boards per batch'); assert.deepEqual(host.issueGraph.nodes.find((node: any) => node.id === relatedId).boardIds, [9]);
  await host.loadIssueGraph(scope, false, [first]); assert.equal(relations, 1, 'an already-expanded root is not read again');
  assert.deepEqual(host.issueGraph.nodes.find((node: any) => node.id === relatedId).boardIds, [9]);
  await host.loadIssueGraph(scope, false, host.issueGraph.roots);
  assert.equal(relations, 21, 'a batch expands at most twenty additional roots');
  let finish!: (value: unknown) => void, cancellingReads = 0;
  client.loadIssueGraphRelations = async () => { cancellingReads++; return new Promise(resolve => { finish = resolve; }); };
  const pending = host.loadIssueGraph(scope, false, [host.issueGraph.roots[30]]);
  await new Promise(resolve => setImmediate(resolve));
  const queued = host.loadIssueGraph(scope, false, [host.issueGraph.roots[31]]);
  await host.dispatchMessage({ type: 'loadIssueGraph', connectedScope: scope, cancel: true });
  finish({ parents: [], children: [], links: [] }); await Promise.all([pending, queued]);
  assert.equal(cancellingReads, 1, 'cancellation also drops graph work queued behind the active batch');
  assert.equal(host.issueGraph.status, 'partial'); assert.ok(host.issueGraph.nodes.length >= 100);
});

test('Board colors resume a partially read Board before another Board without rereading completed pages', async () => {
  const { host, client } = fixture('developer');
  host.projects = [{ id: 101, path_with_namespace: 'team-42/repo', http_url_to_repo: 'local' }];
  host.issues = [{ id: 1, project_id: 101, iid: 1, title: 'Root', state: 'opened', labels: [] }];
  host.groupIssueBoards = [{ id: 9, name: 'Large Board' }, { id: 10, name: 'Next Board' }];
  client.listGroupIssueBoards = async () => host.groupIssueBoards;
  host.issueGraphVersion = 0; host.session.getClient = async () => client;
  const batches: GitLabRequestBudget[] = [], completed: string[] = [];
  let budget!: GitLabRequestBudget;
  client.withRequestBudget = (next: GitLabRequestBudget) => { budget = next; batches.push(next); return client; };
  client.listGroupBoardIssueMembershipsPage = async (_path: string, id: number, cursor?: { page: number }) => {
    budget.reserve(); const page = cursor?.page ?? 0; completed.push(`${id}:${page}`);
    return { items: [{ issueId: page + 1, projectId: 101, iid: page + 1 }], complete: id === 10 || page === 25, nextCursor: id === 9 && page < 25 ? { page: page + 1 } : undefined };
  };
  const scope = host.connectedScopeKey(); await host.loadIssueGraph(scope);
  await host.loadIssueGraph(scope, false, undefined, true);
  assert.equal(completed.length, 20); assert.equal(host.issueGraph.boardStatus[9].status, 'partial');
  assert.ok(!completed.some(value => value.startsWith('10:')));
  await host.loadIssueGraph(scope, false, undefined, true);
  assert.deepEqual(completed, [...Array.from({ length: 26 }, (_, index) => `9:${index}`), '10:0']);
  assert.equal(host.issueGraph.boardStatus[9].status, 'ready'); assert.equal(host.issueGraph.boardStatus[10].status, 'ready');
  assert.deepEqual(host.issueGraph.nodes[0].boardIds, [9, 10]);
  assert.ok(batches.every(batch => batch.usedRequests <= 20));
});

test('multi-page WorkItem and REST relations retain each completed checkpoint across actual request budgets', async t => {
  for (const mode of ['work-items', 'rest-links']) await t.test(mode, async () => {
    const { host, client } = fixture('developer');
    host.projects = [{ id: 101, path_with_namespace: 'team-42/repo', http_url_to_repo: 'local' }];
    host.issues = [{ id: 1, project_id: 101, iid: 1, title: 'Root', state: 'opened', labels: [] }];
    host.issueGraphVersion = 0; host.session.getClient = async () => client;
    host.session.issueCapabilities = { graphWorkItems: mode === 'work-items', graphLinkedItems: mode === 'work-items' };
    let budget!: GitLabRequestBudget; const batches: GitLabRequestBudget[] = [], completed: number[] = [];
    client.withRequestBudget = (next: GitLabRequestBudget) => { budget = next; batches.push(next); return client; };
    client.listProjectLabels = async () => { budget.reserve(); return []; };
    client.loadIssueGraphRelationsPage = async (_path: string, _iid: number, _caps: unknown, cursor?: { page: number }) => {
      budget.reserve(); const page = cursor?.page ?? 0; completed.push(page);
      return { parents: [], links: [], children: [{ id: `gid://gitlab/WorkItem/${page + 2}`, iid: String(page + 2), title: 'Child', project: { id: 'gid://gitlab/Project/101', fullPath: 'team-42/repo' }, workItemType: { name: 'Issue' } }], complete: page === 26, nextCursor: page < 26 ? { page: page + 1 } : undefined };
    };
    client.listIssueLinksPage = async (_project: number, _iid: number, cursor?: string) => {
      budget.reserve(); const page = Number(cursor ?? 0); completed.push(page);
      return { items: [{ id: page + 2, project_id: 101, iid: page + 2, title: 'Related', state: 'closed', labels: [] }], complete: page === 26, nextCursor: page < 26 ? String(page + 1) : undefined };
    };
    const scope = host.connectedScopeKey(); await host.loadIssueGraph(scope); const root = host.issueGraph.roots[0];
    await host.loadIssueGraph(scope, false, [root]);
    assert.equal(completed.length, 19, 'Label lookup and relation pages share the actual twenty-request budget');
    assert.equal(host.issueGraph.nodes.find((node: any) => node.id === root).relationsStatus, 'partial');
    await host.loadIssueGraph(scope, false, [root]);
    assert.deepEqual(completed, Array.from({ length: 27 }, (_, index) => index), 'successful relation pages are not requested again');
    assert.equal(host.issueGraph.nodes.find((node: any) => node.id === root).relationsStatus, 'ready');
    assert.equal(host.issueGraph.edges.length, 27); assert.ok(batches.every(batch => batch.usedRequests <= 20));
  });
});

test('Issue-list Board selection shares twenty actual requests, resumes twenty-six pages, and preserves the complete cache contract', async () => {
  const { host, client, cacheReads } = fixture('developer'); host.groupIssueBoards = [{ id: 9, name: 'Large Board' }];
  let olderCompleteCache: number[] | undefined;
  host.session.cachedRead = async (key: string, load: (value: unknown) => Promise<number[]>, options: { force?: boolean } = {}) => {
    cacheReads.push({ key, force: options.force });
    if (!options.force && olderCompleteCache) return olderCompleteCache;
    const result = await load(client); olderCompleteCache = result; return result;
  };
  const completed: number[] = [], batches: GitLabRequestBudget[] = []; let budget!: GitLabRequestBudget;
  client.withRequestBudget = (value: GitLabRequestBudget) => { budget = value; batches.push(value); return client; };
  client.listAssignedGroupBoardIssueIds = async () => { throw new Error('Production selection must not call the complete legacy API.'); };
  client.listGroupBoardIssueMembershipsPage = async (groupPath: string, boardId: number, cursor: { page: number } | undefined, username: string) => {
    assert.equal(groupPath, 'team-42'); assert.equal(boardId, 9); assert.equal(username, 'me'); budget.reserve();
    const page = cursor?.page ?? 0; completed.push(page);
    return { items: [{ issueId: page + 1 }], complete: page === 25, nextCursor: page < 25 ? { page: page + 1 } : undefined };
  };
  const scope = host.connectedScopeKey(); await host.selectIssueBoard(9, scope);
  assert.equal(completed.length, 20); assert.equal(host.issueBoardContent.status, 'partial'); assert.equal(host.issueBoardContent.complete, false);
  assert.equal(host.issueBoardContent.loadedCount, 20); assert.equal(host.issueBoardLoad.cursor.page, 20);
  olderCompleteCache = [999]; // SWR may retain a complete value from before a paused refresh.
  await host.selectIssueBoard(9, scope, 'continue');
  assert.deepEqual(completed, Array.from({ length: 26 }, (_, index) => index));
  assert.equal(host.issueBoardContent.status, 'ready'); assert.equal(host.issueBoardContent.complete, true); assert.equal(host.issueBoardContent.loadedCount, 26);
  assert.equal(cacheReads[1].force, true, 'continuation bypasses an older complete cache value');
  assert.ok(batches.every(value => value.usedRequests <= 20));
  assert.ok(cacheReads.every(read => read.key === 'group-board/42/9/assigned/me'), 'partial batches retain the existing complete-only cache namespace');
  host.invalidateWorkspaceReads({ groupIds: [999], resource: 'issues' }); assert.ok(host.issueBoardLoad);
  host.invalidateWorkspaceReads({ groupIds: [42], resource: 'issues' }); assert.equal(host.issueBoardLoad, undefined); assert.equal(host.issueBoardContent.status, 'partial'); assert.deepEqual(host.issueBoardContent.issueIds, []);
});

test('Issue-list Board cancellation is scoped and keeps the unfinished cursor; late other-Board and account results cannot replace it', async () => {
  const { host, client } = fixture('developer'); host.groupIssueBoards = [{ id: 9, name: 'A' }, { id: 10, name: 'B' }];
  let finish!: (value: unknown) => void; let pause = true; const completed: string[] = [];
  client.listGroupBoardIssueMembershipsPage = async (_group: string, id: number, cursor?: { page: number }) => {
    completed.push(`${id}:${cursor?.page ?? 0}`);
    if (id === 9 && cursor?.page === 1 && pause) return new Promise(resolve => { finish = resolve; });
    return { items: [{ issueId: id === 9 ? (cursor ? 2 : 1) : 999 }], complete: id === 10 || !!cursor, nextCursor: id === 9 && !cursor ? { page: 1 } : undefined };
  };
  const scope = host.connectedScopeKey(); const first = host.selectIssueBoard(9, scope); await new Promise(resolve => setImmediate(resolve));
  await host.selectIssueBoard(10, scope, 'cancel'); await host.selectIssueBoard(9, 'stale-scope', 'cancel');
  assert.equal(host.issueBoardAbort.signal.aborted, false, 'a different Board or scope cannot cancel the active selection');
  await host.selectIssueBoard(9, scope, 'cancel'); assert.equal(host.issueBoardContent.status, 'partial');
  finish({ items: [{ issueId: 2 }], complete: true }); await first;
  assert.deepEqual(host.issueBoardContent.issueIds, [1]); assert.equal(host.issueBoardLoad.cursor.page, 1);
  pause = false; await host.selectIssueBoard(9, scope, 'continue');
  assert.deepEqual(completed, ['9:0', '9:1', '9:1']); assert.deepEqual(host.issueBoardContent.issueIds, [1, 2]);
  host.issueBoardLoad = undefined; pause = true;
  const stale = host.selectIssueBoard(9, scope); await new Promise(resolve => setImmediate(resolve));
  await host.selectIssueBoard(10, scope); finish({ items: [{ issueId: 777 }], complete: true }); await stale;
  assert.equal(host.issueBoardContent.boardId, 10); assert.deepEqual(host.issueBoardContent.issueIds, [999]);
  host.issueBoardLoad = undefined; const oldAccount = host.selectIssueBoard(9, scope); await new Promise(resolve => setImmediate(resolve));
  host.session.connectionEpoch++;
  finish({ items: [{ issueId: 888 }], complete: true }); await oldAccount;
  assert.notDeepEqual(host.issueBoardContent?.issueIds, [888]);
});

test('local page entries call only the relevant local adapters with or without a GitLab Group', async t => {
  const cases = [
    { mode: 'sa', expected: ['skills', 'inventory'] },
    { mode: 'bmad', expected: ['bmad'] },
    { mode: 'git', expected: ['git-refresh', 'git-list'] },
    { mode: 'clone', expected: ['inventory'] }
  ];
  for (const connected of [true, false]) for (const { mode, expected } of cases) await t.test(`${mode}, connected=${connected}`, async () => {
    const { host, local, remote, cacheReads } = fixture(mode, connected);
    if (mode === 'clone') host.projectSource = 'local';
    await host.refresh({ forceNetwork: true });
    assert.deepEqual(local, expected);
    assert.deepEqual(remote, [], 'local entry does not call GitLab identity, capability or data APIs');
    assert.deepEqual(cacheReads, []);
    assert.equal(host.busy, false);
  });
});

test('Skills identifies a local multi-Repo folder and becomes ready without an account or Group', async () => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'gitlab-workspace-local-scope-')));
  try {
    const { host, remote, context } = fixture('sa', false);
    Object.assign(context, { root, folders: [] });
    host.projectContext = context;
    delete host.refreshWorkflowKit;
    host.packages = { listReleases: async () => [] };
    host.readWorkflowKitState = async () => ({ status: 'installed', workspaceContract: 2, installerApi: 1, profile: 'group', version: 'test', capabilities: ['codebase-wiki'] });
    await host.refresh({ forceNetwork: true });
    const skills = host.getSkillsContext();
    assert.equal(skills.mode, 'group', 'the local folder workflow is retained independently of GitLab Groups');
    assert.equal(skills.root, root);
    assert.deepEqual(skills.availableFeatures, ['codebase-wiki']);
    assert.equal(host.workflowKitInstallTarget.root, root);
    assert.deepEqual(remote, []);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('opening Output preserves the active page and selection without refreshing adapters', async () => {
  const { host, local, remote, messages } = fixture('reviewer', false);
  const selectedMergeRequest = { request: { projectId: 101, iid: 4 }, draft: 'keep this reply' };
  host.selectedMergeRequest = selectedMergeRequest;
  const signal = host.viewReadAbort.signal;
  const before = executedCommands.length;
  await host.dispatchMessage({ type: 'openLogs' });
  assert.deepEqual(executedCommands.slice(before), ['gitlabWorkspace.showLogs']);
  assert.equal(host.activeMode, 'reviewer');
  assert.equal(host.selectedMergeRequest, selectedMergeRequest);
  assert.equal(signal.aborted, false);
  assert.deepEqual(local, []);
  assert.deepEqual(remote, []);
  assert.deepEqual(messages, []);
});

test('remote page entries share the selected Group, respect freshness and load only their own data', async t => {
  for (const [mode, resources] of [
    ['clone', ['projects']], ['reviewer', ['projects', 'mergeRequests']],
    ['developer', ['projects', 'issues']]
  ] as const) await t.test(mode, async () => {
    const { host, remote, cacheReads, local } = fixture(mode);
    await host.refresh();
    const data = remote.filter(read => read.groupId !== undefined);
    assert.deepEqual(data.map(read => read.resource).sort(), [...resources].sort());
    assert.ok(data.every(read => read.groupId === 42));
    assert.ok(cacheReads.every(read => read.force === false), 'ordinary entry uses the scoped read cache');
    assert.deepEqual(local, mode === 'clone' ? ['download-root'] : [], 'remote lists do not run unrelated Skills or local Git inspections');
    if (mode === 'developer') assert.deepEqual(host.issues.map((issue: any) => issue.project_id), [101]);
  });
});

test('concurrent and later fresh page entries reuse data while manual refresh reloads it', async () => {
  const { host, client, remote } = fixture('reviewer');
  let finish!: (projects: unknown[]) => void;
  client.listGroupProjects = async (groupId: number) => {
    remote.push({ resource: 'projects', groupId });
    return new Promise(resolve => { finish = resolve; });
  };
  const first = host.refresh();
  const duplicate = host.refresh();
  assert.equal(remote.filter(read => read.resource === 'projects').length, 1);
  finish([]); await Promise.all([first, duplicate]);
  assert.equal(remote.filter(read => read.resource === 'mergeRequests').length, 1);
  await host.refresh();
  assert.equal(remote.filter(read => read.resource === 'projects').length, 1);
  assert.equal(remote.filter(read => read.resource === 'mergeRequests').length, 1);
  const later = host.refresh({ forceNetwork: true, reason: 'manual' });
  assert.equal(remote.filter(read => read.resource === 'projects').length, 2);
  finish([]); await later;
  assert.equal(remote.filter(read => read.resource === 'mergeRequests').length, 2);
});

test('lazy filters load only their requested section, coalesce clicks, and retry a failed first read', async () => {
  const { host, client, remote, cacheReads } = fixture('developer');
  await host.refresh();
  const scope = host.connectedScopeKey();
  let reads = 0, finish!: (value: unknown) => void;
  client.listGroupIssueBoardsPage = async () => {
    reads++;
    if (reads === 1) throw new Error('temporary Board failure');
    return new Promise(resolve => { finish = resolve; });
  };
  await host.dispatchMessage({ type: 'ensureWorkspaceSection', section: 'boards', connectedScope: scope });
  assert.equal(host.workspaceSections.boards.status, 'error');
  const first = host.dispatchMessage({ type: 'ensureWorkspaceSection', section: 'boards', connectedScope: scope });
  const duplicate = host.dispatchMessage({ type: 'ensureWorkspaceSection', section: 'boards', connectedScope: scope });
  assert.equal(reads, 2, 'repeated clicks join the retry already in flight');
  finish({ items: [{ id: 9, name: 'Delivery' }], complete: true, updatedAt: new Date().toISOString() });
  await Promise.all([first, duplicate]);
  assert.equal(host.workspaceSections.boards.status, 'ready');
  assert.deepEqual(host.groupIssueBoards.map((board: any) => board.id), [9]);
  assert.equal(remote.some(read => read.resource === 'milestones'), false);
  await host.dispatchMessage({ type: 'ensureWorkspaceSection', section: 'boards', connectedScope: scope });
  assert.equal(reads, 2, 'a fresh opened filter reuses its section');
  await host.dispatchMessage({ type: 'ensureWorkspaceSection', section: 'milestones', connectedScope: scope });
  assert.equal(remote.filter(read => read.resource === 'milestones').length, 1);
  assert.deepEqual(cacheReads.filter(read => read.key.includes('/boards/')).map(read => read.force), [false, true],
    'only an explicit retry bypasses cache, and repeated retry clicks join it');
  assert.equal(cacheReads.find(read => read.key.includes('/milestones/'))?.force, false);
});

test('lazy filter messages reject old scopes, unsupported sections, and hidden or other pages', async () => {
  const { host, remote } = fixture('developer');
  const scope = host.connectedScopeKey();
  await host.dispatchMessage({ type: 'ensureWorkspaceSection', section: 'boards', connectedScope: 'old-scope' });
  await host.dispatchMessage({ type: 'ensureWorkspaceSection', section: 'projects', connectedScope: scope });
  host.panel.visible = false;
  await host.dispatchMessage({ type: 'ensureWorkspaceSection', section: 'boards', connectedScope: scope });
  host.panel.visible = true; host.activeMode = 'reviewer';
  await host.dispatchMessage({ type: 'ensureWorkspaceSection', section: 'milestones', connectedScope: scope });
  assert.deepEqual(remote, []);
  assert.equal(host.requestedWorkspaceSections?.size ?? 0, 0);
});

test('restored filters wait for delayed cold entry before registering their Group demand', async () => {
  const { host, client, groups, remote } = fixture('developer');
  host.groups = []; host.loadedScopeKey = undefined;
  let finish!: (value: unknown) => void;
  client.listGroups = async () => new Promise(resolve => { finish = resolve; });
  const entry = host.refresh();
  const restored = host.dispatchMessage({ type: 'ensureWorkspaceSection', section: 'boards', connectedScope: host.connectedScopeKey() });
  assert.equal(remote.some(read => read.resource === 'boards'), false, 'filter loading waits for scope initialization');
  finish(groups);
  await Promise.all([entry, restored]);
  assert.equal(host.workspaceSections.boards.status, 'ready');
  assert.equal(host.requestedWorkspaceSections.has('boards'), true);
  assert.equal(remote.filter(read => read.resource === 'boards').length, 1);
});

test('an explicit failed-filter retry bypasses a retained fresh page and shares one HTTP request', async () => {
  const { host, groups } = fixture('developer');
  const baseUrl = 'https://gitlab.test', id = accountId(baseUrl, 7);
  const values = new Map<string, unknown>([
    [ACCOUNTS_KEY, [{ id, baseUrl, userId: 7, name: 'Me', username: 'me', needsLogin: false,
      group: { id: groups[0].id, fullPath: groups[0].full_path } }]], [ACTIVE_ACCOUNT_KEY, id]
  ]);
  const state: Memento = {
    get: <T>(key: string, fallback?: T): T | undefined => values.has(key) ? values.get(key) as T : fallback,
    update: async (key: string, value: unknown) => { values.set(key, value); }, keys: () => [...values.keys()]
  };
  const secrets: SecretStorage = {
    get: async (key: string) => key === accountTokenKey(id) ? 'fixture-only-token' : undefined,
    store: async () => undefined, delete: async () => undefined, onDidChange: () => ({ dispose() {} })
  };
  const session = new GitLabSession(secrets, state, true);
  let requests = 0, finish!: (value: Response) => void, retryStarted!: () => void;
  const retryRequest = new Promise<void>(resolve => { retryStarted = resolve; });
  const response = (boardId: number) => new Response(JSON.stringify([{ id: boardId, name: `Board ${boardId}` }]),
    { status: 200, headers: { 'content-type': 'application/json' } });
  session.setFetchForTesting(async input => {
    assert.equal(new URL(String(input)).pathname, '/api/v4/groups/42/boards');
    requests++;
    if (requests === 1) return response(9);
    if (requests === 2) return new Response('unavailable', { status: 500 });
    return new Promise(resolve => { finish = resolve; retryStarted(); });
  });
  await session.initialize({ allowNetwork: false }); host.session = session;
  const scope = host.connectedScopeKey();
  await host.dispatchMessage({ type: 'ensureWorkspaceSection', section: 'boards', connectedScope: scope });
  await host.loadWorkspaceSection('boards', true);
  assert.equal(host.workspaceSections.boards.status, 'ready', 'failed revalidation retains the previous rows');
  assert.ok(host.workspaceSections.boards.error); assert.deepEqual(host.groupIssueBoards.map((board: any) => board.id), [9]);
  const retry = host.dispatchMessage({ type: 'ensureWorkspaceSection', section: 'boards', connectedScope: scope });
  const repeated = host.dispatchMessage({ type: 'ensureWorkspaceSection', section: 'boards', connectedScope: scope });
  await Promise.race([retryRequest, Promise.all([retry, repeated]).then(() => { assert.fail('retry returned the retained page without issuing HTTP'); })]);
  assert.equal(requests, 3, 'retry reaches HTTP despite the retained fresh cached page, exactly once');
  finish(response(10)); await Promise.all([retry, repeated]);
  assert.deepEqual(host.groupIssueBoards.map((board: any) => board.id), [10]);
  assert.equal(host.workspaceSections.boards.error, undefined);
});

test('entry and manual refresh revisit only filters used in the current Group', async () => {
  const { host, client, remote } = fixture('developer');
  let memberships = 0;
  client.listGroupBoardIssueMemberships = async () => { memberships++; return []; };
  const count = (resource: string) => remote.filter(read => read.resource === resource).length;
  await host.refresh();
  await host.refresh({ forceNetwork: true, reason: 'manual' });
  assert.equal(count('projects'), 2); assert.equal(count('issues'), 2);
  assert.equal(count('boards'), 0); assert.equal(count('milestones'), 0);
  await host.dispatchMessage({ type: 'ensureWorkspaceSection', section: 'milestones', connectedScope: host.connectedScopeKey() });
  host.workspaceSections.milestones.updatedAt = Date.now() - 301_000;
  await host.refresh();
  assert.equal(count('milestones'), 2, 'returning revalidates a previously used, expired filter');
  await host.refresh({ forceNetwork: true, reason: 'manual' });
  assert.equal(count('milestones'), 3, 'manual refresh includes the filter already used');
  assert.equal(count('boards'), 0); assert.equal(memberships, 0, 'refresh does not load unused graph Board colors');
});

test('switching back to a warm Group shares cached pages without restoring another Group filter demand', async () => {
  const { host, client, remote, cacheReads } = fixture('developer');
  const cache = new GitLabReadCache();
  host.session.cachedRead = (key: string, load: (value: unknown) => Promise<unknown>, options: any = {}) => {
    cacheReads.push({ key, force: options.force });
    return cache.get(key, () => load(client), options);
  };
  await host.refresh();
  const oldScope = host.connectedScopeKey();
  await host.dispatchMessage({ type: 'ensureWorkspaceSection', section: 'boards', connectedScope: oldScope });
  await host.selectGroup(43);
  assert.equal(host.requestedWorkspaceSections.size, 0);
  const before = remote.length;
  await host.dispatchMessage({ type: 'ensureWorkspaceSection', section: 'milestones', connectedScope: oldScope });
  assert.equal(remote.length, before, 'late filter events cannot read the next Group');
  await host.selectGroup(42);
  assert.equal(remote.filter(read => read.resource === 'projects' && read.groupId === 42).length, 1);
  assert.equal(remote.filter(read => read.resource === 'issues' && read.groupId === 42).length, 1);
  assert.equal(remote.filter(read => read.resource === 'boards').length, 1);
  assert.equal(host.requestedWorkspaceSections.size, 0);
  assert.ok(cacheReads.every(read => read.force !== true), 'Group navigation never forces a fresh page');
});

test('selecting the current Group keeps its view without reads while account transition guards still apply', async () => {
  const { host, remote, cacheReads } = fixture('developer');
  const issue = { id: 1, title: 'Keep this detail' };
  host.selectedIssue = issue;
  host.refresh = async () => { throw new Error('same-Group selection must not refresh'); };
  host.accountTransitionBusy = true;
  await assert.rejects(host.selectGroup(42), /帳號/);
  host.accountTransitionBusy = false;
  assert.equal(await host.selectGroup(42), true);
  assert.equal(host.selectedIssue, issue);
  assert.deepEqual(remote, []); assert.deepEqual(cacheReads, []);
});

test('Group selection rechecks its account after waiting for Group choices', async () => {
  const { host, groups } = fixture('developer');
  let finish!: (value: unknown) => void;
  host.session.cachedRead = () => new Promise(resolve => { finish = resolve; });
  const selection = host.selectGroup(43);
  host.session.connectionEpoch++;
  finish(groups);
  await assert.rejects(selection, /帳號已變更/);
  assert.equal(host.session.selectedGroup.id, 42);
});

test('loading graph colors first awaits one Board-list page without downloading its continuation', async () => {
  const { host, client } = fixture('developer');
  await host.refresh(); host.issueGraphVersion = 0;
  host.session.getClient = async () => client;
  let finish!: (value: unknown) => void, memberships = 0;
  const cursors: Array<string | undefined> = [];
  client.listGroupIssueBoardsPage = async (_id: number, cursor?: string) => {
    cursors.push(cursor);
    return new Promise(resolve => { finish = resolve; });
  };
  client.listGroupBoardIssueMemberships = async () => { memberships++; return []; };
  const graph = host.loadIssueGraph(host.connectedScopeKey(), false, undefined, true);
  assert.deepEqual(cursors, [undefined]); assert.equal(memberships, 0);
  finish({ items: [{ id: 9, name: 'Delivery' }], complete: false, nextCursor: 'next-boards', updatedAt: new Date().toISOString() });
  await graph;
  assert.equal(memberships, 1); assert.deepEqual(cursors, [undefined]);
  assert.equal(host.workspaceSections.boards.complete, false, 'the next Board-list page remains an explicit action');
  assert.equal(host.requestedWorkspaceSections.has('boards'), true);
});

test('graph cancellation also stops the Board-list dependency it started', async () => {
  const { host, client } = fixture('developer');
  await host.refresh(); host.issueGraphVersion = 0;
  host.session.getClient = async () => client;
  let finish!: (value: unknown) => void, memberships = 0;
  client.listGroupIssueBoardsPage = async () => new Promise(resolve => { finish = resolve; });
  client.listGroupBoardIssueMemberships = async () => { memberships++; return []; };
  const scope = host.connectedScopeKey();
  const graph = host.loadIssueGraph(scope, false, undefined, true);
  const boardController = host.workspaceSectionAborts.get('boards');
  assert.ok(boardController);
  await host.dispatchMessage({ type: 'loadIssueGraph', connectedScope: scope, cancel: true });
  assert.equal(boardController.signal.aborted, true);
  finish({ items: [{ id: 9, name: 'Delivery' }], complete: true, updatedAt: new Date().toISOString() });
  await graph;
  assert.equal(memberships, 0); assert.deepEqual(host.groupIssueBoards, []);
  assert.equal(host.issueGraph.status, 'partial');
});

test('returning to remote pages uses five-minute projects and one-minute MR freshness', async () => {
  const { host, remote } = fixture('reviewer');
  await host.refresh();
  const count = (resource: string) => remote.filter(read => read.resource === resource).length;
  host.workspaceSections.projects.updatedAt = Date.now() - 61_000;
  host.workspaceSections.mergeRequests.updatedAt = Date.now() - 61_000;
  await host.refresh();
  assert.equal(count('projects'), 1, 'project inventory remains fresh for five minutes');
  assert.equal(count('mergeRequests'), 2, 'expired MR list is read on entry');
  host.workspaceSections.projects.updatedAt = Date.now() - 301_000;
  await host.refresh();
  assert.equal(count('projects'), 2, 'expired project inventory is read on entry');
  assert.equal(count('mergeRequests'), 2, 'fresh MR list is reused');
});

test('an expired dashboard joins another consumer revalidating the same project page', async () => {
  const { host, client } = fixture('clone');
  const cache = new GitLabReadCache();
  let reads = 0, finish!: (value: unknown) => void;
  client.listGroupProjectsPage = async () => { reads++; return new Promise(resolve => { finish = resolve; }); };
  host.session.cachedRead = (key: string, load: (value: unknown) => Promise<unknown>, options: any = {}) => cache.get(key, () => load(client), options);
  host.workspaceSections.projects = { status: 'ready', updatedAt: Date.now() - 301_000 };
  const other = host.session.cachedRead('group/42/projects/pages/opened/first', () => client.listGroupProjectsPage(42));
  await new Promise(resolve => setImmediate(resolve));
  const entry = host.refresh();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(reads, 1, 'expiry resets the UI without forcing another HTTP request');
  finish({ items: [], complete: true, updatedAt: new Date().toISOString() });
  await Promise.all([other, entry]);
});

test('reloading expired Issues rebuilds graph roots and drops older relation checkpoints', async () => {
  const { host, client } = fixture('developer');
  let iid = 1;
  host.developerView = 'graph'; host.session.getClient = async () => client;
  client.listAssignedGroupIssues = async () => [{ id: iid, project_id: 101, iid, title: `Issue ${iid}`, state: 'opened', labels: [], web_url: '' }];
  await host.refresh();
  const oldRoot = host.issueGraph.roots[0];
  host.issueGraph.nodes[0].relationsStatus = 'ready';
  host.graphRelationLoads.set(oldRoot, { complete: true });
  host.graphBoardLoads.set(999, { complete: true });
  iid = 2; host.workspaceSections.issues.updatedAt = Date.now() - 61_000;
  await host.refresh();
  assert.deepEqual(host.issueGraph.roots, [issueGraphNodeKey(101, 'team-42/project', 2)]);
  assert.equal(host.issueGraph.nodes.some((node: any) => node.id === oldRoot), false);
  assert.equal(host.graphRelationLoads.size, 0); assert.equal(host.graphBoardLoads.size, 0);
});

test('a manual refresh arriving during cache-backed entry performs one forced pass', async () => {
  const { host, client, remote } = fixture('reviewer');
  let finish!: (value: unknown[]) => void, projects = 0;
  client.listGroupProjects = async (groupId: number) => {
    projects++; remote.push({ resource: 'projects', groupId });
    return projects === 1 ? new Promise(resolve => { finish = resolve; }) : [];
  };
  const entry = host.refresh();
  const manual = host.refresh({ forceNetwork: true, reason: 'manual' });
  const duplicate = host.refresh({ forceNetwork: true, reason: 'manual' });
  assert.equal(projects, 1);
  finish([]);
  await Promise.all([entry, manual, duplicate]);
  assert.equal(projects, 2, 'manual notifications join one forced revalidation');
  assert.equal(remote.filter(read => read.resource === 'mergeRequests').length, 2);
});

test('switching modes and restoring the Webview do not refetch fresh remote sections', async () => {
  const { host, remote } = fixture('reviewer');
  await host.refresh();
  await host.dispatchMessage({ type: 'setMode', mode: 'developer' });
  await host.dispatchMessage({ type: 'setMode', mode: 'reviewer' });
  host.viewGeneration++; host.webviewReady = false;
  await host.dispatchMessage({ type: 'ready' });
  assert.equal(remote.filter(read => read.resource === 'projects').length, 1);
  assert.equal(remote.filter(read => read.resource === 'mergeRequests').length, 1);
  assert.equal(remote.filter(read => read.resource === 'issues').length, 1);
  host.invalidateWorkspaceReads({ groupIds: [42], resource: 'mergeRequests' });
  await host.refresh();
  assert.equal(remote.filter(read => read.resource === 'projects').length, 1);
  assert.equal(remote.filter(read => read.resource === 'mergeRequests').length, 2, 'write invalidation is consumed despite the TTL');
});

test('a mode transition hands off its pending project read instead of cancelling and resending it', async () => {
  const { host, client } = fixture('reviewer');
  const cache = new GitLabReadCache();
  let reads = 0, transportSignal!: AbortSignal, finish!: (value: unknown) => void;
  let readSignal!: AbortSignal;
  host.session.beginReadHandoff = () => cache.beginHandoff();
  host.session.cancelReadHandoffs = () => cache.cancelHandoffs();
  host.session.cachedRead = (key: string, load: (value: unknown) => Promise<unknown>, options: any) =>
    cache.get(key, signal => { readSignal = signal; return load(client); }, options);
  client.listGroupProjectsPage = async () => {
    reads++; transportSignal = readSignal;
    return new Promise(resolve => { finish = resolve; });
  };
  const previous = host.refresh();
  await new Promise(resolve => setImmediate(resolve));
  const replacement = host.dispatchMessage({ type: 'setMode', mode: 'developer' });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(transportSignal.aborted, false, 'replacement page owns the original transport');
  assert.equal(reads, 1, 'shared inventory is requested once');
  finish({ items: [], complete: true, updatedAt: new Date().toISOString() });
  await Promise.all([previous, replacement]);
  assert.equal(host.activeMode, 'developer');
  assert.equal(host.workspaceSections.projects.complete, true);
  assert.equal(transportSignal.aborted, false);
});

test('command navigation starts its handoff before closing Issue reads and releases it on failure', async () => {
  const { host } = fixture('reviewer');
  let active = false, closed = 0;
  host.session.beginReadHandoff = () => {
    active = true;
    return { dispose: () => { active = false; } };
  };
  host.issuePanels.close = () => { assert.equal(active, true); closed++; };
  host.show = async () => undefined;
  await host.navigateTo('reviewer');
  assert.equal(closed, 1); assert.equal(active, false);
  host.show = async () => { throw new Error('navigation failed'); };
  await assert.rejects(host.navigateTo('developer'), /navigation failed/);
  assert.equal(closed, 2); assert.equal(active, false);
});

test('duplicate ready messages load once per view generation and a restored view loads once again', async () => {
  const { host, local, remote } = fixture('sa', false);
  await host.dispatchMessage({ type: 'ready', projectSource: 'local' });
  await host.dispatchMessage({ type: 'ready', projectSource: 'local' });
  assert.deepEqual(local, ['skills', 'inventory']);
  host.viewGeneration++;
  host.webviewReady = false;
  host.viewReadAbort.abort();
  await host.dispatchMessage({ type: 'ready', projectSource: 'local' });
  await host.dispatchMessage({ type: 'ready', projectSource: 'local' });
  assert.deepEqual(local, ['skills', 'inventory', 'skills', 'inventory']);
  assert.deepEqual(remote, []);
});

test('graph visibility loads once per entry and manual refresh follows the currently visible Issue view', async () => {
  const { host } = fixture('developer');
  const scope = host.connectedScopeKey();
  const graphs: Array<{ scope: string; force: boolean }> = [];
  host.loadIssueGraph = async (connectedScope: string, force = false) => { graphs.push({ scope: connectedScope, force }); };
  await host.dispatchMessage({ type: 'setIssueGraphVisibility', connectedScope: scope, visible: true });
  await host.dispatchMessage({ type: 'setIssueGraphVisibility', connectedScope: scope, visible: true });
  assert.equal(host.developerView, 'graph');
  assert.deepEqual(graphs, [{ scope, force: false }]);
  await host.dispatchMessage({ type: 'refresh', mode: 'developer' });
  assert.equal(graphs.length, 2, 'manual refresh reloads the visible graph');
  await host.dispatchMessage({ type: 'setIssueGraphVisibility', connectedScope: scope, visible: false });
  assert.equal(host.developerView, 'list');
  await host.dispatchMessage({ type: 'refresh', mode: 'developer' });
  assert.equal(graphs.length, 2, 'list refresh does not re-read a hidden graph');
  await host.dispatchMessage({ type: 'setIssueGraphVisibility', connectedScope: scope, visible: true });
  assert.equal(graphs.length, 3, 'entering the graph again performs a new explicit read');
});

test('overlapping graph loads share one request and a later manual load starts a new one', async () => {
  const { host } = fixture('developer');
  const scope = host.connectedScopeKey();
  let loads = 0, finish!: () => void;
  host.loadIssueGraphNow = async () => {
    loads++;
    return new Promise<void>(resolve => { finish = resolve; });
  };
  const first = host.loadIssueGraph(scope, true), second = host.loadIssueGraph(scope, true);
  assert.equal(loads, 1);
  finish(); await Promise.all([first, second]);
  const next = host.loadIssueGraph(scope, true);
  assert.equal(loads, 2);
  finish(); await next;
});

test('rapid graph hide and re-entry starts a fresh read while the aborted read is still finishing', async () => {
  const { host } = fixture('developer');
  const scope = host.connectedScopeKey();
  const reads: Array<{ controller: AbortController; finish: () => void }> = [];
  host.loadIssueGraphNow = () => {
    const controller = new AbortController();
    host.issueGraphAbort = controller; host.issueGraphVisible = true;
    return new Promise<void>(resolve => { reads.push({ controller, finish: resolve }); });
  };
  const old = host.loadIssueGraph(scope, true);
  host.hideIssueGraph();
  assert.equal(reads[0].controller.signal.aborted, true);
  const current = host.loadIssueGraph(scope, true);
  assert.equal(reads.length, 2, 're-entry must not join the cancelled request');
  const currentRead = host.issueGraphRead;
  reads[0].finish(); await old;
  assert.equal(host.issueGraphRead, currentRead, 'the old completion cannot clear the new in-flight read');
  reads[1].finish(); await current;
  assert.equal(host.issueGraphRead, undefined);
});

test('Board selection during page entry is retained and loaded once after its lists are ready', async () => {
  const { host, client } = fixture('developer');
  host.loadedScopeKey = 'https://gitlab.test|7|42';
  host.groupIssueBoards = [{ id: 88, name: 'Delivery' }];
  let finishProjects!: (projects: unknown[]) => void;
  client.listGroupProjects = () => new Promise(resolve => { finishProjects = resolve; });
  client.listGroupIssueBoards = async () => [{ id: 88, name: 'Delivery' }];
  const boards: Array<{ path: string; id: number; force: boolean }> = [];
  host.loadIssueBoardContent = async (groupPath: string, boardId: number, _generation: number, _scope: string, force = false) => {
    boards.push({ path: groupPath, id: boardId, force });
  };
  const entry = host.refresh({ forceNetwork: true });
  await host.selectIssueBoard(88, host.connectedScopeKey());
  assert.equal(host.selectedIssueBoardId, 88);
  assert.deepEqual(boards, [], 'selection does not compete with the page entry read');
  finishProjects([]); await entry;
  assert.deepEqual(boards, [{ path: 'team-42', id: 88, force: true }]);
});

test('manual Git page refresh updates the selected local snapshot without remote reads', async () => {
  const { host, local, remote, messages } = fixture('git', false);
  host.selectedGitRepositoryId = 'repo';
  await host.dispatchMessage({ type: 'refresh', mode: 'git' });
  assert.deepEqual(local, ['git-refresh', 'git-list', 'git-refresh-snapshot']);
  assert.ok(messages.some(message => message.type === 'gitSnapshot' && message.snapshot.id === 'repo'));
  assert.deepEqual(remote, []);
});

test('workspace and remote-config events mark data dirty without scheduling Git or API reads', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { host, local, remote, cacheReads } = fixture('sa');
  host.refresh = () => { throw new Error('A workspace event must not refresh pages'); };
  host.refreshInventory = () => { throw new Error('A workspace event must not inspect Git'); };
  host.onWorkspaceFoldersChanged();
  host.scheduleSkillsEnvironmentRefresh();
  t.mock.timers.tick(10_000);
  assert.equal(host.workspaceRefreshPending, true);
  assert.equal(host.pendingWorkspaceRefresh, true);
  assert.deepEqual(local, []); assert.deepEqual(remote, []); assert.deepEqual(cacheReads, []);
});

test('Group selection preserves local scope, Skills state and helper guards while remote guards remain pinned', async () => {
  const { host, remote, local, context } = fixture('sa');
  const originalMatch = host.workspaceMatch, originalSkills = host.skillsWorkflowKitState;
  const localScope = host.getLocalOperationScope();
  const localGuard = host.captureWorkflowKitAccess();
  const remoteGuard = host.captureWorkflowKitAccess(true);
  await host.selectGroup(43);
  assert.equal(host.session.selectedGroup.id, 43);
  assert.equal(host.projectContext, context); assert.equal(host.workspaceMatch, originalMatch);
  assert.equal(host.skillsWorkflowKitState, originalSkills);
  assert.equal(host.getLocalOperationScope(), localScope);
  assert.doesNotThrow(localGuard); assert.throws(remoteGuard, /已變更/);
  assert.deepEqual(local, []);
  assert.deepEqual(remote.map(read => read.resource), ['groups'], 'selection itself reads Group choices but does not refresh the local page');
  host.session.connectionEpoch++;
  assert.throws(localGuard, /已變更/, 'account epoch protection still applies');
});
