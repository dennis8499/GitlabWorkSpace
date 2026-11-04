import assert from 'node:assert/strict';
import { AsyncLocalStorage } from 'node:async_hooks';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import vm from 'node:vm';
import test from 'node:test';
import { ActionController } from '../../src/workspace/actionController';
import { OperationTracker } from '../../src/workspace/operations';
import { NotificationCenter } from '../../src/notifications/notificationCenter';
import { assertWorkspaceAction, getWorkspaceCapabilities, VIRTUAL_WORKSPACE_REASON } from '../../src/workspace/workspaceCapabilities';

const virtualFolders = [{ uri: { scheme: 'vscode-vfs' } }];
const virtual = getWorkspaceCapabilities(virtualFolders);

test('only a nonempty workspace containing exclusively virtual folders limits local project operations', () => {
  assert.equal(virtual.localProjectOperations.status, 'denied');
  for (const folders of [undefined, [], [{ uri: { scheme: 'file' } }], [...virtualFolders, { uri: { scheme: 'file' } }]]) {
    assert.equal(getWorkspaceCapabilities(folders).isVirtualWorkspace, false);
    assert.equal(getWorkspaceCapabilities(folders).localProjectOperations.status, 'allowed');
  }
});

test('virtual capabilities block local dispatch while preserving remote writes, clipboard and logs', () => {
  const local = ['scanRepositories', 'clone', 'syncRepos', 'installWorkflowKit', 'refreshBmad', 'startCodexTask',
    'loadReviewSessions', 'openBranchReview', 'gitAction', 'gitOpenDiff'];
  for (const type of local) {
    const sent: unknown[] = [], controller = new ActionController(request => sent.push(request));
    controller.setContext({ scopeRevision: 'remote', localOperationScope: 'local', workspaceCapabilities: virtual });
    assert.equal(controller.dispatch({ type }).reason, VIRTUAL_WORKSPACE_REASON);
    assert.equal(sent.length, 0); controller.dispose();
  }
  for (const type of ['submitAccountLogin', 'selectGroup', 'postMergeRequestNote', 'approveMergeRequest', 'copy', 'openLogs']) {
    const sent: unknown[] = [], controller = new ActionController(request => sent.push(request));
    controller.setContext({ scopeRevision: 'remote', workspaceCapabilities: virtual });
    assert.equal(controller.dispatch({ type, projectId: 1, iid: 2, text: 'sample' }).status, 'started');
    assert.equal(sent.length, 1); controller.dispose();
  }
  assert.throws(() => assertWorkspaceAction(virtual, { type: 'refresh', mode: 'git' }), /磁碟/);
  assert.doesNotThrow(() => assertWorkspaceAction(virtual, { type: 'refresh', mode: 'reviewer' }));
});

function load(relative: string, vscode: unknown): any {
  const filename = path.resolve(__dirname, '../../src', relative), nativeRequire = createRequire(filename), exports = {};
  vm.runInNewContext(readFileSync(filename, 'utf8'), { exports, Buffer, process, Error, AbortController, setTimeout, clearTimeout,
    require: (name: string) => name === 'vscode' ? vscode : name === './gitAskpassUi'
      ? { createGitCredentialPrompt: () => async () => undefined } : nativeRequire(name) });
  return exports;
}

test('mixed workspaces never interpret a virtual URI as a local filesystem path', () => {
  const virtualUri = { scheme: 'vscode-vfs', toString: () => 'vscode-vfs://example/project',
    get fsPath(): string { throw new Error('A virtual fsPath must not be read'); } };
  const fileUri = { scheme: 'file', fsPath: 'C:/local-project', toString: () => 'file:///C:/local-project' };
  const { WorkspacePanel } = load('workspace/workspacePanel.js', { workspace: { workspaceFolders: [
    { uri: virtualUri, name: 'Cloud' }, { uri: fileUri, name: 'Local' }
  ] } });
  const folders = Object.create(WorkspacePanel.prototype).projectFolders();
  assert.equal(folders.length, 1); assert.equal(folders[0].path, fileUri.fsPath);
});

test('Skills use only file folders to resolve the review workspace and its ambiguity', () => {
  const virtualUri = { scheme: 'vscode-vfs', toString: () => 'vscode-vfs://example/project',
    get fsPath(): string { throw new Error('A virtual fsPath must not be read'); } };
  const local = (root: string) => ({ uri: { scheme: 'file', fsPath: root, toString: () => `file:///${root}` } });
  const first = local('C:/local-project'), second = local('C:/other-project');
  for (const [workspaceFolders, root, ambiguous] of [
    [[{ uri: virtualUri }], undefined, false],
    [[{ uri: virtualUri }, first], first.uri.fsPath, false],
    [[first, { uri: virtualUri }, second], undefined, true],
    [[], undefined, false]
  ] as const) {
    const { WorkspacePanel } = load('workspace/workspacePanel.js', { workspace: { workspaceFolders } });
    const host = Object.assign(Object.create(WorkspacePanel.prototype), {
      session: {}, projects: [], projectContextSignature: () => 'folders'
    });
    const skills = host.getSkillsContext();
    assert.equal(skills.workspaceRoot, root);
    assert.equal(skills.workspaceRootAmbiguous, ambiguous);
  }
});

test('a virtual Dashboard skips local environment and inventory probes', async () => {
  const { WorkspacePanel } = load('workspace/workspacePanel.js', { workspace: { workspaceFolders: virtualFolders } });
  const host = Object.assign(Object.create(WorkspacePanel.prototype), {
    dashboardSections: { local: { status: 'loading' } }, sendSnapshot() {},
    resolveProjectContext: async () => { throw new Error('Unexpected local environment probe'); },
    refreshInventory: async () => { throw new Error('Unexpected inventory scan'); }
  });
  await host.refreshDashboardLocal(1, new AbortController().signal, () => true);
  assert.equal(host.dashboardSections.local.status, 'idle');
});

test('the Host rejects direct local commands and control messages before entering their adapters', async t => {
  const { WorkspacePanel } = load('workspace/workspacePanel.js', { workspace: { workspaceFolders: virtualFolders } });
  const notifications = new NotificationCenter(), operations = new OperationTracker();
  t.after(() => { notifications.dispose(); operations.dispose(); });
  const host = Object.assign(Object.create(WorkspacePanel.prototype), {
    session: {}, operationTracker: operations, notificationCenter: notifications, operationContextStorage: new AsyncLocalStorage(),
    actionScope: () => 'scope', getLocalOperationScope: () => 'local', getNotificationOrigin: () => ({}),
    runLogged: (_action: unknown, task: () => Promise<unknown>) => task(),
    withCodexWriteGuard: (_request: unknown, task: () => Promise<unknown>) => task(), writesInFlight: 0
  });
  let entered = 0;
  await assert.rejects(host.runCommandAction('clone', async () => { entered++; }, { operationId: 'blocked-clone' }), /磁碟/);
  assert.equal(entered, 0);
  assert.equal(operations.get('blocked-clone')?.status, 'failed');
  assert.equal(operations.get('blocked-clone')?.effect, 'none');
  await assert.rejects(host.runAction({ type: 'gitReady' }, async () => { entered++; }), /磁碟/);
  await host.runCommandAction('postMergeRequestNote', async () => { entered++; }, { operationId: 'remote-note' });
  assert.equal(entered, 1);
  assert.equal(operations.get('remote-note')?.status, 'succeeded');
});

test('virtual startup and sidebar entry do not activate Git or read repository details', async t => {
  class Emitter { event = () => ({ dispose() {} }); fire() {} dispose() {} }
  let gitProbes = 0, detailReads = 0, refreshes = 0;
  const vscode = { EventEmitter: Emitter, workspace: { workspaceFolders: virtualFolders },
    extensions: { getExtension: () => { gitProbes++; throw new Error('Unexpected Git probe'); } } };
  const { GitRepositoryService } = load('git/gitRepositoryService.js', vscode);
  const service = new GitRepositoryService({}, {}, {});
  t.after(() => service.dispose());
  assert.equal((await service.getInventory()).length, 0);
  assert.equal((await service.getSummaryState()).available, false);
  assert.equal(gitProbes, 0);
  await assert.rejects(service.openRepositoryPath('C:/stale-root'), /磁碟/);
  const { QuickActionsViewProvider } = load('quickActionsView.js', vscode);
  const sidebar = new QuickActionsViewProvider({}, { connectionEpoch: 1 }, () => {}, undefined,
    async () => { detailReads++; }, undefined, undefined, () => 'scope', () => ({}), async () => { refreshes++; });
  const messages: any[] = [];
  const view = { visible: true, webview: { postMessage: async (message: unknown) => { messages.push(message); return true; } } };
  sidebar.view = view;
  await sidebar.refreshRepositories();
  await sidebar.loadRepositoryDetails('repo', 'detail');
  assert.equal(refreshes, 0); assert.equal(detailReads, 0);
  assert.equal(messages.find(message => message.type === 'state').state.workspaceCapabilities.isVirtualWorkspace, true);
  assert.match(messages.find(message => message.type === 'repositoryDetails').error, /磁碟/);
  sidebar.dispose();
});
