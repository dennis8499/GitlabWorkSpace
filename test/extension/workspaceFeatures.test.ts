import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, realpath, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import * as vscode from 'vscode';
import { WorkspacePanel } from '../../src/workspace/workspacePanel';
import type { RepositoryScanState, ScannedRepository } from '../../src/git/repositoryScanProtocol';

type Harness = Record<string, any>;
const project = { id: 1, name: 'One', path: 'one', path_with_namespace: 'group/one' };
const issue = (iid: number) => ({ id: 100 + iid, iid, project_id: 1, title: 'Issue ' + iid });

suite('Account, preview and workspace Repo integration', () => {
  test('late Git reads are dropped after hiding, closing or leaving the panel while accepted writes finish', async () => {
    const actions: string[] = [], replies: Array<Record<string, unknown>> = [];
    let inventories = 0;
    const view: Harness = Object.assign(Object.create(WorkspacePanel.prototype), {
      panel: { visible: false }, activeMode: 'git', accountTransitionBusy: false,
      gitRepositories: { handleAction: async (_id: string, action: { type: string }) => { actions.push(action.type); }, setActivePanelRepository: () => undefined },
      post: (message: Record<string, unknown>) => { replies.push(message); }, sendGitRepositories: async () => { inventories++; }
    });
    const read = () => view.handleGitPanelRequest({ type: 'gitAction', repoId: 'repo', requestId: 'late-read', action: { type: 'readDiff', path: 'README.md', staged: false } });
    await read();
    await view.handleGitPanelRequest({ type: 'gitReady' });
    assert.equal(inventories, 0);
    assert.equal(view.gitPanelReady, true, 'a hidden ready message is retained for one refresh when shown');
    view.panel = undefined; await read();
    view.panel = { visible: true }; view.activeMode = 'developer'; await read();
    assert.deepEqual(actions, []);
    assert.equal(replies.length, 3);
    await view.handleGitPanelRequest({ type: 'gitAction', repoId: 'repo', requestId: 'accepted-write', action: { type: 'commit', message: 'Keep working' } });
    assert.deepEqual(actions, ['commit']);
    view.activeMode = 'git'; await read();
    assert.deepEqual(actions, ['commit', 'readDiff']);
  });

  test('only the latest preview request can update selection, without loading Issue edit options', async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const keys: string[] = [], saved: unknown[] = [];
    const client = { getIssue: async (_id: number, iid: number) => { if (iid === 1) await gate; return issue(iid); } };
    const view: Harness = Object.assign(Object.create(WorkspacePanel.prototype), {
      session: { cachedRead: async (key: string, load: (client: unknown) => Promise<unknown>) => { keys.push(key); return load(client); } },
      context: { globalState: { update: async (_key: string, value: unknown) => { saved.push(value); } } },
      issues: [issue(1), issue(2)], previewGeneration: 0, issueOpenGeneration: 0,
      requireGroupProject: () => project, connectedScopeKey: () => 'account:group', selectedIssueKey: () => 'selection', sendSnapshot: () => undefined
    });
    const first = view.selectIssue(1, 1);
    await view.selectIssue(1, 2);
    release(); await first;
    assert.equal(view.selectedIssue.issue.iid, 2);
    assert.equal(view.issuePreview.status, 'ready');
    assert.deepEqual(saved, [{ projectId: 1, issueIid: 2 }]);
    assert.deepEqual(keys, ['project/1/issue/1', 'project/1/issue/2']);
    client.getIssue = async () => { throw new Error('Offline'); };
    await view.selectIssue(1, 1);
    assert.equal(view.issuePreview.status, 'error');
    client.getIssue = async (_id, iid) => issue(iid);
    await view.selectIssue(1, 1);
    assert.equal(view.issuePreview.status, 'ready');
  });

  test('workspace changes cancel the old scan and reject late progress and results', async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let cancelled = false;
    const old: RepositoryScanState = { status: 'completed', repositories: [{ path: 'old', name: 'Old', remotes: [] }], checkedDirectories: 1, errors: [], excludes: ['.git'] };
    const view: Harness = Object.assign(Object.create(WorkspacePanel.prototype), {
      session: {}, gitRepositories: { scanWorkspace: async (signal: AbortSignal, progress: (state: RepositoryScanState) => void) => {
        await gate; cancelled = signal.aborted; progress(old); return old;
      } },
      workspaceFoldersGeneration: 0, inventoryGeneration: 0, localRepositoryScanGeneration: 0, actualRepositoryScanGeneration: 0,
      busy: true, sendSnapshot: () => undefined, refreshInventory: async () => undefined
    });
    const scanning = view.scanRepositories();
    view.onWorkspaceFoldersChanged();
    release(); await scanning;
    assert.equal(cancelled, true);
    assert.equal(view.repositoryScan.status, 'idle');
    assert.equal(view.repositoryScan.repositories.length, 0);
  });

  test('a pending delivery operation blocks account transitions until it finishes', async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const view: Harness = Object.assign(Object.create(WorkspacePanel.prototype), {
      session: {}, writesInFlight: 0, mrWritesInFlight: new Set(), issueRelationWritesInFlight: new Set(), timer: { list: () => [] },
      dispatchMessage: async () => { await gate; }
    });
    const operation = view.handleMessage({ type: 'prepareDelivery', projectId: 1, issueIid: 1 });
    assert.throws(() => view.assertAccountTransitionAllowed(), /完成後才能/);
    release(); await operation;
    assert.doesNotThrow(() => view.assertAccountTransitionAllowed());
  });

  test('scanning registers deep Repos and worktrees with native VS Code Git and reconciles inventories', async function () {
    this.timeout(60000);
    const extension = vscode.extensions.getExtension('local-dev.gitlab-workspace');
    assert.ok(extension);
    const api = await extension.activate() as {
      scanWorkspaceForTesting(signal: AbortSignal, progress: (state: RepositoryScanState) => void): Promise<RepositoryScanState>;
      getRepositoryInventoryForTesting(): Promise<ScannedRepository[]>;
    };
    const prefix = path.resolve(process.env.GITLAB_WORKSPACE_TEST_TMP ?? os.tmpdir(), 'workspace-host-scan-');
    const root = await mkdtemp(prefix);
    assert.ok(path.resolve(root).startsWith(prefix));
    const originalCwd = process.cwd();
    const original = vscode.workspace.workspaceFolders?.map(folder => ({ uri: folder.uri, name: folder.name })) ?? [];
    try {
      const normal = path.join(root, 'deep', 'repo'), linked = path.join(root, 'deep', 'linked');
      await mkdir(normal, { recursive: true });
      execFileSync('git', ['init', '--quiet', normal], { windowsHide: true });
      execFileSync('git', ['-C', normal, '-c', 'user.name=Host Test', '-c', 'user.email=host@example.invalid', 'commit', '--quiet', '--allow-empty', '-m', 'baseline'], { windowsHide: true });
      execFileSync('git', ['-C', normal, 'worktree', 'add', '--quiet', '--detach', linked, 'HEAD'], { windowsHide: true });
      const changed = new Promise<void>(resolve => { const listener = vscode.workspace.onDidChangeWorkspaceFolders(() => { listener.dispose(); resolve(); }); });
      assert.equal(vscode.workspace.updateWorkspaceFolders(0, original.length, { uri: vscode.Uri.file(root), name: 'Scan fixture' }), true);
      await changed;
      const progress: RepositoryScanState[] = [];
      const scanned = await api.scanWorkspaceForTesting(new AbortController().signal, state => progress.push(state));
      assert.equal(scanned.status, 'completed');
      assert.equal(scanned.repositories.length, 2);
      assert.ok(scanned.repositories.every(repository => repository.repositoryId && !repository.registrationError));
      assert.ok(progress.some(state => state.status === 'scanning'));
      const native = vscode.extensions.getExtension('vscode.git')!.exports.getAPI(1);
      const normalize = (value: string) => path.resolve(value).toLocaleLowerCase();
      const nativePaths = new Set(await Promise.all(native.repositories.map(async (repository: { rootUri: vscode.Uri }) => normalize(await realpath(repository.rootUri.fsPath)))));
      const inventory = await api.getRepositoryInventoryForTesting();
      for (const repository of scanned.repositories) {
        assert.ok(nativePaths.has(normalize(repository.path)));
        assert.ok(inventory.some(item => normalize(item.path) === normalize(repository.path)));
      }
    } finally {
      const native = vscode.extensions.getExtension('vscode.git')?.exports?.getAPI(1);
      for (const repository of native?.repositories ?? []) {
        if (repository.rootUri.fsPath.toLocaleLowerCase().startsWith(root.toLocaleLowerCase() + path.sep)) {
          await vscode.commands.executeCommand('git.close', repository.rootUri);
        }
      }
      const changed = new Promise<void>(resolve => { const listener = vscode.workspace.onDidChangeWorkspaceFolders(() => { listener.dispose(); resolve(); }); });
      if (vscode.workspace.updateWorkspaceFolders(0, vscode.workspace.workspaceFolders?.length ?? 0, ...original)) await changed;
      assert.ok(path.resolve(root).startsWith(prefix));
      // VS Code can change the Extension Host working directory to the first added folder.
      if (process.cwd().toLocaleLowerCase().startsWith(root.toLocaleLowerCase())) process.chdir(originalCwd);
      if (!process.env.GITLAB_WORKSPACE_TEST_TMP) {
        try { await rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 }); }
        catch (error) { if (!error || typeof error !== 'object' || !('code' in error) || error.code !== 'EBUSY') throw error; }
      }
    }
  });

  test('opens the real offline administration Webview and handles its Log page request', async function () {
    this.timeout(30000);
    const extension = vscode.extensions.getExtension('local-dev.gitlab-workspace')!;
    const api = await extension.activate() as {
      getLogQueryCountForTesting(): number;
      queryLogsForTesting(query: { search: string }): Promise<{ total: number }>;
    };
    const before = api.getLogQueryCountForTesting();
    await vscode.commands.executeCommand('gitlabWorkspace.openAdmin');
    const deadline = Date.now() + 15000;
    while (api.getLogQueryCountForTesting() <= before && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 50));
    assert.ok(api.getLogQueryCountForTesting() > before, 'the real Webview loaded and requested a Log page');
    assert.ok((await api.queryLogsForTesting({ search: 'openAdmin' })).total > 0);
    await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
  });
});
