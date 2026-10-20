import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const vscode = { workspace: { workspaceFolders: [] as unknown[], isTrusted: false } };
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
    projects: [], issues: [], mergeRequests: [], groupIssueBoards: [], groupMilestones: [],
    projectContext: context, groupRoot: context.root, cloneRoot: context.root,
    workspaceMatch: { status: 'matched', root: context.root, profile: 'group', repositories: [] },
    skillsWorkflowKitState: { status: 'installed', profile: 'group', version: 'test', capabilities: ['codebase-wiki'] },
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
      ensureInstanceChecked: async () => { remote.push({ resource: 'instance' }); }
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
      refresh: async () => { local.push('git-refresh'); },
      handleAction: async (_id: string, action: { type: string }) => { local.push(`git-${action.type}-snapshot`); return { id: 'repo' }; }
    }
  });
  return { host, client, remote, cacheReads, local, messages, context, groups };
}

test('local page entries call only the relevant local adapters with or without a GitLab Group', async t => {
  const cases = [
    { mode: 'sa', expected: ['skills', 'inventory'] },
    { mode: 'bmad', expected: ['bmad'] },
    { mode: 'git', expected: ['git-refresh', 'git-list'] },
    { mode: 'admin', expected: [] },
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
    host.packages = { listPackages: async () => [] };
    host.readWorkflowKitState = async () => ({ status: 'installed', profile: 'group', version: 'test', capabilities: ['codebase-wiki'] });
    await host.refresh({ forceNetwork: true });
    const skills = host.getSkillsContext();
    assert.equal(skills.mode, 'group', 'the local folder workflow is retained independently of GitLab Groups');
    assert.equal(skills.root, root);
    assert.deepEqual(skills.availableFeatures, ['codebase-wiki']);
    assert.equal(host.workflowKitInstallTarget.root, root);
    assert.deepEqual(remote, []);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('remote page entries share the selected Group and load only their own data', async t => {
  for (const [mode, resources] of [
    ['clone', ['projects']], ['reviewer', ['projects', 'mergeRequests']],
    ['developer', ['projects', 'issues', 'boards', 'milestones']]
  ] as const) await t.test(mode, async () => {
    const { host, remote, cacheReads, local } = fixture(mode);
    await host.refresh({ forceNetwork: true });
    const data = remote.filter(read => read.groupId !== undefined);
    assert.deepEqual(data.map(read => read.resource).sort(), [...resources].sort());
    assert.ok(data.every(read => read.groupId === 42));
    assert.ok(cacheReads.every(read => read.force === true), 'entry bypasses ready data in the read cache');
    assert.deepEqual(local, mode === 'clone' ? ['download-root'] : [], 'remote lists do not run unrelated Skills or local Git inspections');
    if (mode === 'developer') assert.deepEqual(host.issues.map((issue: any) => issue.project_id), [101]);
  });
});

test('concurrent notifications of one page entry join its request, and a later entry reloads ready data', async () => {
  const { host, client, remote } = fixture('reviewer');
  let finish!: (projects: unknown[]) => void;
  client.listGroupProjects = async (groupId: number) => {
    remote.push({ resource: 'projects', groupId });
    return new Promise(resolve => { finish = resolve; });
  };
  const first = host.refresh({ forceNetwork: true });
  const duplicate = host.refresh({ forceNetwork: true });
  assert.equal(remote.filter(read => read.resource === 'projects').length, 1);
  finish([]); await Promise.all([first, duplicate]);
  assert.equal(remote.filter(read => read.resource === 'mergeRequests').length, 1);
  const later = host.refresh({ forceNetwork: true });
  assert.equal(remote.filter(read => read.resource === 'projects').length, 2);
  finish([]); await later;
  assert.equal(remote.filter(read => read.resource === 'mergeRequests').length, 2);
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
  host.loadIssueGraph = async (connectedScope: string, force: boolean) => { graphs.push({ scope: connectedScope, force }); };
  await host.dispatchMessage({ type: 'setIssueGraphVisibility', connectedScope: scope, visible: true });
  await host.dispatchMessage({ type: 'setIssueGraphVisibility', connectedScope: scope, visible: true });
  assert.equal(host.developerView, 'graph');
  assert.deepEqual(graphs, [{ scope, force: true }]);
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
