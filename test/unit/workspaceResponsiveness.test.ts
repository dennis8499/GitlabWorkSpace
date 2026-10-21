import assert from 'node:assert/strict';
import test from 'node:test';
import { OperationTracker } from '../../src/workspace/operations';

function hostFixture(): any {
  const loader = require('node:module') as { _load: (...args: any[]) => any };
  const original = loader._load;
  loader._load = (name, ...args) => name === 'vscode' ? {} : original(name, ...args);
  let Panel: any;
  try { Panel = require('../../src/workspace/workspacePanel').WorkspacePanel; } finally { loader._load = original; }
  const group = { id: 42, name: 'Team', full_path: 'team' }, user = { id: 7 };
  const project = { id: 1, name: 'service', path: 'service', path_with_namespace: 'team/service', http_url_to_repo: 'https://gitlab.test/team/service.git' };
  const host = Object.create(Panel.prototype);
  Object.assign(host, {
    disposed: false, activeMode: 'reviewer', requestGeneration: 1, workspaceFoldersGeneration: 0, skillsEnvironmentGeneration: 0,
    issueBoardGeneration: 0, actualRepositoryScanGeneration: 0, localRepositoryScanGeneration: 0,
    workspaceSections: {}, workspaceSectionGenerations: new Map(), workspaceSectionAborts: new Map(),
    loadedScopeKey: 'https://gitlab.test|7|42', currentUser: user, projects: [project], issues: [], mergeRequests: [],
    groups: [group], projectSource: 'gitlab', developerView: 'list',
    groupIssueBoards: [], groupMilestones: [], context: { globalState: { get: () => undefined } },
    panel: { visible: true }, timer: { setScope: async () => undefined },
    session: { baseUrl: 'https://gitlab.test', selectedGroup: group, connectionEpoch: 1,
      updateCurrentUser: async () => undefined, ensureInstanceChecked: async () => undefined,
      cachedRead: async (key: string) => key === 'groups' ? [group] : key === 'current-user' ? user : key.endsWith('/projects') ? [project] : [] },
    sendSnapshot: () => undefined, setBusyOwner: () => undefined, syncTimerPolling: () => undefined,
    schedulePendingWorkspaceRefresh: () => undefined, refreshWorkflowKit: async () => undefined,
    refreshProjectRoot: async () => undefined, resolveWorkspaceRoot: async () => ({ root: 'C:/fixture/team', match: { status: 'matched' } }),
    loadActiveModeSections: () => undefined, refreshActualRepositories: async () => undefined
  });
  return host;
}

test('MR entry reads remote data without scanning local repository state', async () => {
  const host = hostFixture();
  let scans = 0, localRoots = 0;
  host.refreshLocalRepositoryStates = async () => { scans++; };
  host.refreshProjectRoot = async () => { localRoots++; };
  await host.refreshWorkspace(1, new AbortController().signal, {});
  assert.equal(scans, 0); assert.equal(localRoots, 0);
  assert.equal(host.workspaceSections.projects.status, 'ready');
});

test('expired ready sections remain available while exactly one background read refreshes them', async () => {
  const host = hostFixture();
  const previousRows = [{ iid: 1, title: 'Previously loaded' }];
  host.mergeRequests = previousRows;
  host.workspaceSections.mergeRequests = { status: 'ready', updatedAt: Date.now() - 61_000 };
  let reads = 0, finish!: (value: unknown) => void;
  host.session.cachedRead = () => { reads++; return new Promise(resolve => { finish = resolve; }); };
  const task = host.loadWorkspaceSection('mergeRequests');
  assert.equal(reads, 1);
  assert.equal(host.mergeRequests, previousRows);
  assert.equal(host.workspaceSections.mergeRequests.status, 'ready');
  assert.equal(host.workspaceSections.mergeRequests.refreshing, true);
  await host.loadWorkspaceSection('mergeRequests');
  assert.equal(reads, 1);
  finish([{ iid: 2, title: 'Current' }]); await task;
  assert.equal(host.mergeRequests[0].iid, 2);
  assert.equal(host.workspaceSections.mergeRequests.refreshing, false);
  assert.ok(host.workspaceSections.mergeRequests.updatedAt > Date.now() - 1000);
});

test('a background read failure preserves loaded data and exposes a section retry', async () => {
  const host = hostFixture();
  const rows = [{ iid: 1 }]; host.mergeRequests = rows;
  host.workspaceSections.mergeRequests = { status: 'ready', updatedAt: Date.now() - 61_000 };
  host.session.cachedRead = async () => { throw new Error('offline'); };
  await host.loadWorkspaceSection('mergeRequests');
  assert.equal(host.mergeRequests, rows);
  assert.equal(host.workspaceSections.mergeRequests.status, 'ready');
  assert.equal(host.workspaceSections.mergeRequests.error, 'offline');
  assert.equal(host.workspaceSections.mergeRequests.refreshing, false);
});

test('returning to an expired project list revalidates projects without downloading user and groups', async () => {
  const host = hostFixture();
  host.workspaceSections.projects = { status: 'ready', updatedAt: Date.now() - 301_000 };
  const calls: string[] = [];
  host.session.cachedRead = async (key: string) => { calls.push(key); return [{ id: 2, path: 'current', path_with_namespace: 'team/current' }]; };
  await host.loadWorkspaceSection('projects');
  assert.deepEqual(calls, ['group/42/projects/pages/opened/first']);
  assert.equal(host.projects[0].id, 2);
  assert.equal(host.workspaceSections.projects.status, 'ready');
});

test('account activation completes without waiting for workspace list downloads', async () => {
  const host = hostFixture();
  host.issuePanels = { close: () => undefined };
  host.mergeRequestSectionAborts = {};
  host.mergeRequestSectionGenerations = { diffs: 0, discussions: 0 };
  host.groupMilestones = [{ id: 99 }]; host.groupIssueBoards = [{ id: 88 }]; host.projectMembers = [{ id: 77 }];
  host.issueBoardContent = { boardId: 88, issueIds: [1] };
  let finish!: () => void;
  host.refresh = () => new Promise<void>(resolve => { finish = resolve; });
  let settled = false;
  const task = host.connectedUserChanged({ id: 7, name: 'Me' }).then(() => { settled = true; });
  for (let i = 0; i < 20; i++) await Promise.resolve();
  try {
    assert.equal(settled, true, 'the login receipt must not wait for unrelated list downloads');
    assert.deepEqual(host.groupMilestones, []); assert.deepEqual(host.groupIssueBoards, []); assert.deepEqual(host.projectMembers, []);
    assert.equal(host.issueBoardContent, undefined);
  }
  finally { finish?.(); await task; }
});

test('MR reconciliation receipts are never discarded when the pending capacity is reached', async () => {
  const host = hostFixture();
  const entries = Array.from({ length: 250 }, (_, index) => ({ key: `old-${index}`, marker: `marker-${index}`, groupId: 42, userId: 7, projectId: 1, iid: index + 1, state: 'uncertain' }));
  let saved: unknown;
  host.context.globalState = { get: () => entries, update: async (_key: string, value: unknown) => { saved = value; } };
  await assert.rejects(host.savePendingMrWrite({ key: 'new', marker: 'new', groupId: 42, userId: 7, projectId: 1, iid: 300, state: 'sending' }, 'new'), /250/);
  assert.equal(saved, undefined); assert.equal(host.pendingMrWrites().length, 250);
  await host.savePendingMrWrite(undefined, 'old-0');
  const stored = (): unknown => saved;
  assert.equal((stored() as unknown[]).length, 249);
});

test('changing Group clears old remote rows before the new workspace refresh completes', async () => {
  const host = hostFixture(), previous = { id: 1, full_path: 'old' }, next = { id: 42, full_path: 'new' };
  host.session.selectedGroup = previous;
  host.issues = [{ id: 101, project_id: 1 }]; host.mergeRequests = [{ id: 102, project_id: 1 }];
  host.groupIssueBoards = [{ id: 103 }]; host.groupMilestones = [{ id: 104 }]; host.issueGraph = { connectedScope: 'old' };
  host.issuePanels = { close: () => {} }; host.mergeRequestSectionAborts = {}; host.mergeRequestSectionGenerations = { diffs: 0, discussions: 0 };
  host.session.cachedRead = async () => [previous, next];
  host.session.setSelectedGroup = async (group: unknown) => { host.session.selectedGroup = group; };
  const snapshots: any[] = [];
  host.sendSnapshot = () => snapshots.push({ groupId: host.session.selectedGroup.id, issues: [...host.issues], mergeRequests: [...host.mergeRequests], boards: [...host.groupIssueBoards], graph: host.issueGraph });
  let release!: () => void;
  host.refresh = () => { host.sendSnapshot(); return new Promise<void>(resolve => { release = resolve; }); };
  const task = host.selectGroup(next.id);
  await new Promise(resolve => setImmediate(resolve));
  try {
    const switched = snapshots.filter(value => value.groupId === next.id); assert.ok(switched.length);
    assert.ok(switched.every(value => !value.issues.length && !value.mergeRequests.length && !value.boards.length && value.graph === undefined));
  } finally { release?.(); await task; }
});

test('a new loaded Group scope cannot reuse old rows when project loading fails', async () => {
  const host = hostFixture();
  host.loadedScopeKey = 'https://gitlab.test|7|old'; host.issues = [{ id: 101 }]; host.mergeRequests = [{ id: 102 }];
  host.refreshLocalRepositoryStates = async () => undefined;
  host.mergeRequestSectionAborts = {}; host.mergeRequestSectionGenerations = { diffs: 0, discussions: 0 };
  const read = host.session.cachedRead;
  host.session.cachedRead = (key: string) => key.endsWith('/projects') ? Promise.reject(new Error('project scope unavailable')) : read(key);
  await host.refreshWorkspace(1, new AbortController().signal, {});
  assert.deepEqual(host.projects, []); assert.deepEqual(host.issues, []); assert.deepEqual(host.mergeRequests, []);
});

test('webview repository results cannot weaken a noted unknown effect or release its lock', async () => {
  for (const type of ['clone', 'syncRepos']) {
    const host = hostFixture(), operations = new OperationTracker(); let adapters = 0;
    host.operationTracker = operations; host.runLogged = (_action: string, task: () => Promise<unknown>) => task();
    host.dispatchMessage = async () => {
      adapters++; host.cloneOperation = { id: 'new-operation', phase: 'cancelled', items: [{ state: 'failed', message: 'interrupted' }] };
      host.noteOutcome({ status: 'failed', effect: 'unknown', error: 'Verify the repository result' });
    };
    await host.handleMessage({ type, operationId: type + '-unknown' });
    assert.equal(operations.get(type + '-unknown')?.effect, 'unknown');
    await host.handleMessage({ type, operationId: type + '-repeat' });
    assert.equal(adapters, 1);
  }
});

test('an uncertain batch Issue creation stops the batch and keeps its write lock', async () => {
  const host = hostFixture(), operations = new OperationTracker(); let writes = 0;
  host.operationTracker = operations; host.runLogged = (_action: string, task: () => Promise<unknown>) => task();
  host.issuePublishQueue = Promise.resolve(); host.refresh = async () => {};
  host.session.getClient = async () => ({ listProjectMembers: async () => [], listProjectLabels: async () => [],
    listProjectMilestones: async () => [], canCreateIssue: async () => true, searchProjectIssues: async () => [],
    createIssue: async () => { writes++; throw Object.assign(new Error('write timed out after dispatch'), { effect: 'unknown' }); } });
  const draft = (id: string) => ({ id, projectPath: 'team/service', title: 'Work ' + id, description: '', acceptanceCriteria: ['Complete'], sourceEvidence: [] });
  const request = { type: 'createIssueDrafts', operationId: 'batch-unknown', analysisId: 'analysis', drafts: [draft('first'), draft('second')], options: {} };
  await host.handleMessage(request);
  assert.equal(writes, 1, 'later drafts must not run after an uncertain mutation');
  assert.equal(operations.get('batch-unknown')?.effect, 'unknown');
  assert.ok(host.notifications.snapshot().items.some((item: any) => item.messages.some((message: string) => /核對|確認/.test(message))));
  await host.handleMessage({ ...request, operationId: 'batch-repeat' }); assert.equal(writes, 1);
});

test('opening an Issue rechecks its navigation after waiting for persisted selection', async () => {
  const host = hostFixture(); let release!: () => void, opened = 0;
  host.issueOpenGeneration = 0; host.previewGeneration = 0; host.workspaceSections.projects = { status: 'ready' };
  const issue = { id: 101, iid: 2, project_id: 1, title: 'Old Group issue' };
  host.session.cachedRead = async (key: string) => key.endsWith('/members') ? [] : issue;
  host.context.globalState.update = () => new Promise<void>(resolve => { release = resolve; });
  host.issuePanels = { showIssue: async () => { opened++; } };
  const task = host.openIssue(1, 2);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(typeof release, 'function', 'the selection persistence must be in flight');
  host.session.selectedGroup = { id: 99 }; host.issueOpenGeneration++; host.issueOpenAbort.abort();
  release(); await task;
  assert.equal(opened, 0, 'a Group change during persistence cannot reopen an old Issue');
});
