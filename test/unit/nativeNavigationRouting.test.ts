import assert from 'node:assert/strict';
import test from 'node:test';
import { GitLabReadCache } from '../../src/api/gitLabReadCache';
import { GitLabRequestBudget } from '../../src/api/gitLabRequestBudget';
import type { GitLabClient } from '../../src/api/gitLabClient';

const commands: string[] = [];
const loader = require('node:module'), original = loader._load;
loader._load = (name: string, ...args: unknown[]) => name === 'vscode'
  ? { commands: { executeCommand: async (command: string) => { commands.push(command); } } } : original(name, ...args);
let WorkspacePanel: typeof import('../../src/workspace/workspacePanel').WorkspacePanel;
let IssuePanels: typeof import('../../src/issues/issuePanel').IssuePanels;
try {
  ({ WorkspacePanel } = require('../../src/workspace/workspacePanel'));
  ({ IssuePanels } = require('../../src/issues/issuePanel'));
} finally { loader._load = original; }

function hostFixture() {
  const calls: unknown[] = [], messages: unknown[] = [];
  const origin = { accountId: 'account-a', baseUrl: 'https://gitlab.test', groupId: 3, root: 'C:/workspace' };
  const host: any = Object.assign(Object.create(WorkspacePanel.prototype), {
    disposed: false, webviewReady: true, navigationReadCount: 0, panel: { visible: false },
    session: { connectionEpoch: 1 }, projects: [{ id: 10 }, { id: 20 }],
    connectedScopeKey: () => 'connected-a', getNavigationSnapshot: () => ({ scope: 'scope-a' }),
    getNotificationOrigin: () => ({ ...origin }), sendSnapshot: () => {},
    navigateTo: async (mode: string) => { calls.push(['navigate', mode]); },
    openIssue: async (project: number, iid: number) => { calls.push(['issue', project, iid]); },
    loadMergeRequest: async (project: number, iid: number) => { calls.push(['mr', project, iid]); },
    linkedCodexSpec: async (taskId: string) => { calls.push(['task', taskId]); },
    post: (message: unknown) => { messages.push(message); }
  });
  Object.defineProperty(host, 'notifications', { value: undefined, writable: true });
  return { host, calls, messages, origin };
}

test('native MR immutable reads survive viewer cancellation and hand off the shared transport', async t => {
  const f = hostFixture(), cache = new GitLabReadCache(), firstView = new AbortController(), secondView = new AbortController();
  const head = 'b'.repeat(40), base = 'a'.repeat(40);
  const request = { type: 'openMergeRequestDiff', projectId: 10, iid: 2, diffVersionId: 7, oldPath: 'file.ts', newPath: 'file.ts' };
  f.host.selectedMergeRequest = { request: { project_id: 10, target_project_id: 10, source_project_id: 20, iid: 2,
    diff_refs: { base_sha: base, head_sha: head, start_sha: base } }, diffVersionId: 7,
    diffs: [{ old_path: 'file.ts', new_path: 'file.ts', diff: '+change' }], sections: { diffs: { status: 'ready' } } };
  f.host.mergeRequestGeneration = 1; f.host.mergeRequestAbort = firstView;
  f.host.resolveGroupProject = async () => ({ id: 10 });
  let release!: () => void, entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const calls: string[] = [], transportSignals: AbortSignal[] = [];
  const client = (signals: AbortSignal[] = [], budget?: GitLabRequestBudget): GitLabClient => ({
    withReadSignal: (signal: AbortSignal) => client([...signals, signal], budget),
    withRequestBudget: (value: GitLabRequestBudget) => client([...signals, value.signal], value),
    getRepositoryFileBytes: async (_project: number, _file: string, sha: string) => {
      assert.equal(budget?.requests, 2); assert.equal(budget?.bytes, 8 * 1024 * 1024);
      const signal = AbortSignal.any(signals); transportSignals.push(signal); calls.push(sha);
      if (sha === base) {
        entered();
        await new Promise<void>((resolve, reject) => {
          release = resolve;
          const abort = () => reject(Object.assign(new Error('transport cancelled'), { name: 'AbortError' }));
          if (signal.aborted) abort(); else signal.addEventListener('abort', abort, { once: true });
        });
      }
      signal.throwIfAborted(); return Uint8Array.from([sha === base ? 1 : 2]);
    }
  }) as unknown as GitLabClient;
  f.host.session.cachedRead = (key: string, load: (client: GitLabClient, signal: AbortSignal) => Promise<Uint8Array>, options: { signal: AbortSignal }) =>
    cache.get(key, signal => load(client(), signal), options);
  f.host.session.getClient = async () => { throw new Error('viewer clients must not own shared transport'); };
  const documents = require('../../src/git/nativeDocuments') as typeof import('../../src/git/nativeDocuments');
  const originalDocuments = documents.getNativeDocuments;
  const opened: Array<[Uint8Array, Uint8Array]> = [];
  documents.getNativeDocuments = () => ({ openDiff: async (_name: string, before: Uint8Array, after: Uint8Array) => { opened.push([before, after]); } }) as any;
  const handoff = cache.beginHandoff();
  t.after(() => { firstView.abort(); secondView.abort(); handoff.dispose(); documents.getNativeDocuments = originalDocuments; });
  const first = f.host.openMergeRequestDiff(request); await started;
  firstView.abort(); await first;
  assert.equal(transportSignals[0].aborted, false, 'a navigation handoff keeps the shared bytes read alive');
  f.host.mergeRequestAbort = secondView;
  const second = f.host.openMergeRequestDiff(request);
  await new Promise(resolve => setImmediate(resolve)); handoff.dispose();
  assert.deepEqual(calls, [base], 'the second viewer joins the original bytes read');
  release(); await second;
  assert.deepEqual(calls, [base, head]);
  assert.deepEqual(opened, [[Uint8Array.from([1]), Uint8Array.from([2])]], 'only the current viewer opens the immutable comparison');
});

test('related MR navigation uses project plus iid and rejects stale Issue detail', async () => {
  const f = hostFixture();
  const detail = { issue: { project_id: 10, iid: 2 }, mergeRequests: [{ project_id: 10, iid: 1 }, { project_id: 20, iid: 1 }] };
  f.host.issueNavigation = { mode: 'detail', projectId: 10, issueIid: 2 };
  f.host.issuePanels = { getActiveDetailForNavigation: () => detail };
  const request = { type: 'openRelatedMergeRequest', projectId: 10, issueIid: 2, mergeRequestProjectId: 20, iid: 1 };
  await f.host.dispatchMessage(request);
  assert.deepEqual(f.calls, [['navigate', 'reviewer'], ['mr', 20, 1]]);
  f.calls.length = 0; detail.issue.iid = 3;
  await assert.rejects(f.host.dispatchMessage(request), /Issue 詳情已變更/);
  assert.deepEqual(f.calls, []);
});

test('related MR navigation stops if the account changes while opening the workbench', async () => {
  const f = hostFixture();
  f.host.issueNavigation = { mode: 'detail', projectId: 10, issueIid: 2 };
  f.host.issuePanels = { getActiveDetailForNavigation: () => ({ issue: { project_id: 10, iid: 2 }, mergeRequests: [{ project_id: 20, iid: 1 }] }) };
  f.host.navigateTo = async () => { f.host.session.connectionEpoch++; };
  await f.host.dispatchMessage({ type: 'openRelatedMergeRequest', projectId: 10, issueIid: 2, mergeRequestProjectId: 20, iid: 1 });
  assert.deepEqual(f.calls, []);
});

test('native pagination reads while the Webview is hidden, and releases demand on errors', async () => {
  const f = hostFixture();
  f.host.loadWorkspaceSection = async (...args: unknown[]) => { assert.equal(f.host.navigationReadCount, 1); f.calls.push(args); };
  await f.host.loadNavigationSection('issues', 'scope-a');
  await f.host.loadNavigationSection('mergeRequests', 'scope-a', true);
  assert.deepEqual(f.calls, [['issues', false, 'next'], ['mergeRequests', true, undefined]]);
  assert.equal(f.host.navigationReadCount, 0);
  await assert.rejects(f.host.loadNavigationSection('issues', 'old-scope'), /帳號或 Group 已變更/);
  f.host.loadWorkspaceSection = async () => { throw new Error('network failed'); };
  await assert.rejects(f.host.loadNavigationSection('issues', 'scope-a'), /network failed/);
  assert.equal(f.host.navigationReadCount, 0);
});

test('notification targets route by Host-owned identity and logs remain available after a scope change', async () => {
  const f = hostFixture();
  let target: any = { kind: 'issue', projectId: 10, iid: 2 };
  f.host.notifications = { snapshot: () => ({ items: [{ id: 'notice', origin: { ...f.origin }, target }] }) };
  await f.host.openNotificationTarget('notice');
  target = { kind: 'mergeRequest', projectId: 20, iid: 4 }; await f.host.openNotificationTarget('notice');
  target = { kind: 'task', taskId: 'task-a' }; await f.host.openNotificationTarget('notice');
  assert.deepEqual(f.calls, [['issue', 10, 2], ['navigate', 'reviewer'], ['mr', 20, 4], ['task', 'task-a'], ['navigate', 'codex']]);
  assert.deepEqual(f.messages, [{ type: 'codexTaskStarted', taskId: 'task-a' }]);
  f.host.getNotificationOrigin = () => ({ ...f.origin, accountId: 'account-b' });
  await assert.rejects(f.host.openNotificationTarget('notice'), /帳號或工作區已變更/);
  const before = commands.length; await f.host.openNotificationTarget('notice', 'logs');
  assert.deepEqual(commands.slice(before), ['gitlabWorkspace.showLogs']);
});

test('notification navigation rechecks scope after awaiting the workbench', async () => {
  const f = hostFixture(), savedOrigin = { ...f.origin };
  f.host.notifications = { snapshot: () => ({ items: [{ id: 'notice', origin: savedOrigin, target: { kind: 'mergeRequest', projectId: 20, iid: 4 } }] }) };
  f.host.navigateTo = async () => { f.origin.accountId = 'account-b'; };
  await assert.rejects(f.host.openNotificationTarget('notice'), /帳號或工作區已變更/);
  assert.deepEqual(f.calls, []);
});

test('environment notification focus survives a workbench that is not ready yet', async () => {
  const f = hostFixture(); f.host.webviewReady = false; f.host.show = async () => {};
  f.host.notifications = { snapshot: () => ({ items: [{ id: 'notice', origin: { ...f.origin }, target: { kind: 'tools', section: 'workflowkit' } }] }) };
  await f.host.openNotificationTarget('notice');
  assert.deepEqual(f.messages, []);
  f.host.webviewReady = true; f.host.publishSettings();
  assert.deepEqual(f.messages, [{ type: 'openSettings', focusSection: 'workflowkit' }]);
  f.host.publishSettings(); assert.equal(f.messages.length, 1);
});

function creationFixture() {
  const messages: any[] = [], reads: number[] = [];
  const project = (id: number) => ({ id, path_with_namespace: `team/project-${id}` });
  const client = { withReadSignal: () => client, getProject: async (id: number) => { reads.push(id); return project(id); }, canCreateIssue: async () => true };
  const panels: any = Object.assign(Object.create(IssuePanels.prototype), {
    navigationVersion: 1, mode: 'create', projectOptionsVersion: 0, creationProjects: new Map(), preferredCreateProject: project(2),
    session: { selectedGroup: { full_path: 'team' }, getClient: async () => client, ensureInstanceChecked: async () => {}, issueCapabilities: {} },
    readCreationProjects: async () => ({ items: [project(1)], complete: false }),
    checkCreateAvailability: async () => ({ status: 'allowed' }), post: (message: any) => { messages.push(message); panels.lastSnapshot = message; }
  });
  return { panels, messages, reads, project, client };
}

test('Issue creation brings the selected project into a partial inventory without changing its paging state', async () => {
  const f = creationFixture();
  await f.panels.loadCreate(1, new AbortController().signal, false);
  const created = f.messages.find(message => message.type === 'createData');
  assert.equal(created.selectedProjectId, 2); assert.deepEqual(created.projects.map((project: any) => project.id), [2, 1]);
  assert.equal(created.projectsState.complete, false); assert.deepEqual(f.reads, [2]);
});

test('a superseded creation read never fetches a project chosen by the next navigation', async () => {
  const f = creationFixture();
  f.panels.readCreationProjects = async () => { f.panels.navigationVersion = 2; f.panels.preferredCreateProject = f.project(3); return { items: [f.project(1)] }; };
  await f.panels.loadCreate(1, new AbortController().signal, false);
  assert.deepEqual(f.reads, []); assert.deepEqual(f.messages, []);
});
