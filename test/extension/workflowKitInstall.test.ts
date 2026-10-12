import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, realpath, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import * as vscode from 'vscode';
import { WorkspacePanel } from '../../src/workspace/workspacePanel';

suite('Local workflow kit installation', () => {
  test('Group policy defaults to enabled and resolves real user/workspace overrides for a fresh controller', async () => {
    const configuration = vscode.workspace.getConfiguration('gitlabWorkspace');
    const setting = 'workflowKit.requireGroupEnvironment';
    const previous = configuration.inspect<boolean>(setting);
    assert.equal(previous?.defaultValue, true);
    const hasWorkspace = !!vscode.workspace.workspaceFolders?.length || !!vscode.workspace.workspaceFile;
    const fresh = () => Object.assign(Object.create(WorkspacePanel.prototype), { session: {}, pendingWorkspaceRefresh: false }).getAccountUiState().workflowKitPolicy;
    try {
      if (hasWorkspace) await configuration.update(setting, undefined, vscode.ConfigurationTarget.Workspace);
      await configuration.update(setting, true, vscode.ConfigurationTarget.Global);
      assert.equal(fresh().requireGroupEnvironment, true);
      assert.equal(fresh().allowed, true, 'auto mode falls back to native Repo without GitLab');
      assert.equal(fresh().mode, 'repository');
      await configuration.update(setting, false, vscode.ConfigurationTarget.Global);
      assert.equal(fresh().requireGroupEnvironment, false);
      assert.equal(fresh().allowed, true);
      if (hasWorkspace) {
        await configuration.update(setting, true, vscode.ConfigurationTarget.Workspace);
        assert.equal(fresh().requireGroupEnvironment, true);
        await configuration.update(setting, false, vscode.ConfigurationTarget.Workspace);
        assert.equal(fresh().requireGroupEnvironment, false);
        assert.equal(fresh().settingTarget, 'workspace');
      }
    } finally {
      if (hasWorkspace) await configuration.update(setting, previous?.workspaceValue, vscode.ConfigurationTarget.Workspace);
      await configuration.update(setting, previous?.globalValue, vscode.ConfigurationTarget.Global);
    }
  });

  test('installs real bundled Skills into current and external folders without changing the offline Skills context', async function () {
    this.timeout(120_000);
    const temporaryParent = process.env.GITLAB_WORKSPACE_TEST_TMP;
    assert.ok(temporaryParent, 'Use the isolated Extension Host test runner');
    // Wiki's native installer adds its own staging tree; avoid Windows MAX_PATH in the fixture.
    const tempBase = await realpath(os.tmpdir());
    const temporary = await mkdtemp(path.join(tempBase, 'gw-kit-'));
    const configuration = vscode.workspace.getConfiguration('gitlabWorkspace');
    const setting = 'workflowKit.requireGroupEnvironment';
    const configurationTarget = vscode.workspace.workspaceFolders?.length ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global;
    const previous = configuration.inspect<boolean>(setting);
    await configuration.update(setting, false, configurationTarget);
    let host: any;
    let nativeRepository: { rootUri: vscode.Uri } | undefined;
    const originalWorkspace = vscode.workspace.workspaceFolders?.map(folder => ({ uri: folder.uri, name: folder.name })) ?? [];
    const originalCwd = process.cwd();
    let fixtureAdded = false;
    const gitExtension = vscode.extensions.getExtension('vscode.git');
    assert.ok(gitExtension);
    const gitExports = await gitExtension.activate();
    const nativeGit = gitExports.getAPI(1);
    try {
      const target = path.join(temporary, 'Repo 中文');
      await mkdir(target); execFileSync('git', ['init', '--quiet', target]);
      const root = await realpath(target);
      // VS Code 1.90 applies its parent-repository policy to roots outside the workspace.
      // Register the fixture as a workspace folder, as a user selecting this Repo would.
      const added = new Promise<void>(resolve => {
        const listener = vscode.workspace.onDidChangeWorkspaceFolders(() => { listener.dispose(); resolve(); });
      });
      assert.equal(vscode.workspace.updateWorkspaceFolders(originalWorkspace.length, 0, { uri: vscode.Uri.file(root), name: 'Offline kit fixture' }), true);
      fixtureAdded = true;
      await added;
      nativeRepository = await nativeGit.openRepository(vscode.Uri.file(root));
      assert.ok(nativeRepository, 'VS Code Git must register the actual Repo');
      const extensionRoot = path.resolve(__dirname, '../../..');
      const packageJSON = JSON.parse(await readFile(path.join(extensionRoot, 'package.json'), 'utf8'));
      const archivePath = path.join(extensionRoot, 'resources/offline-tools/workflow-kit.tar.xz');
      const selected = { id: 'bundled', archivePath, version: packageJSON.version, source: 'bundled',
        format: 'tar.xz', entryRoot: 'workflow-kit', sha256: createHash('sha256').update(await readFile(archivePath)).digest('hex') };
      const values = new Map<string, unknown>([['gitlabWorkspace.workflowKit.installRoot', root]]);
      host = Object.assign(Object.create(WorkspacePanel.prototype), {
        disposed: false, busy: false, writesInFlight: 0, webviewMessagesReceived: 0,
        workspaceFoldersGeneration: 0, skillsEnvironmentGeneration: 0, workflowKitRefreshGeneration: 0, workflowKitStatusReads: new Map(),
        workspaceMatch: { status: 'checking', repositories: [] }, projects: [], workspaceSections: {},
        remoteWatchers: [], remoteWatchSignature: '',
        gitRepositories: { getInventory: async () => [{ path: nativeRepository!.rootUri.fsPath }] },
        workflowKitInstallTarget: { manual: false, state: { status: 'missing' } },
        workflowKitState: { status: 'missing' }, workflowKitSelectingRoot: false,
        session: { getClient: () => { throw new Error('Offline installation must not request a GitLab client'); } },
        context: { extensionUri: vscode.Uri.file(extensionRoot), extension: { packageJSON }, workspaceState: {
          get: (key: string) => values.get(key),
          update: async (key: string, value: unknown) => { values.set(key, value); }
        } },
        packages: { listPackages: async () => [selected], getPackage: async () => selected },
        sendSnapshot: () => undefined, post: () => undefined
      });
      await host.refreshWorkflowKit(false);
      assert.equal(host.workflowKitInstallTarget.state.status, 'missing');
      await host.handleMessage({ type: 'installWorkflowKit', packageId: 'bundled' });
      assert.equal(host.workflowKitInstallTarget.root, root);
      assert.equal(host.workflowKitInstallTarget.state.status, 'installed');
      assert.equal(host.workflowKitInstallTarget.state.profile, 'repository');
      assert.equal(host.workflowKitState.status, 'missing');
      assert.equal(host.groupRoot, undefined);
      assert.equal((await readdir(path.join(root, '.agents/skills'))).length, 15);
      assert.match(await readFile(path.join(root, '.agents/skills/megin/SKILL.md'), 'utf8'), /Megin/);
      assert.ok((await readdir(path.join(root, '.agents/skills/megin/scripts'))).includes('repo_workspace.py'));
      assert.ok(!(await readdir(path.join(root, '.agents/skills/megin/scripts'))).includes('group_workspace.py'));
      const skills = host.getSkillsContext();
      assert.equal(skills.root, root); assert.equal(skills.installed.status, 'installed');
      for (const profile of ['group', 'repository']) {
        const external = path.join(temporary, `外部 ${profile}`); await mkdir(external);
        if (profile === 'repository') execFileSync('git', ['init', '--quiet', external]);
        const externalRoot = await realpath(external);
        await host.context.workspaceState.update('gitlabWorkspace.workflowKit.installRoot', externalRoot);
        await host.refreshWorkflowKit(false);
        assert.equal(host.workflowKitInstallTarget.profile, profile);
        await host.handleMessage({ type: 'installWorkflowKit', packageId: 'bundled' });
        assert.equal(host.workflowKitInstallTarget.root, externalRoot);
        assert.equal(host.workflowKitInstallTarget.state.status, 'installed');
        assert.equal(host.workflowKitInstallTarget.state.profile, profile);
        assert.equal((await readdir(path.join(externalRoot, '.agents/skills'))).length, 15);
        assert.equal(host.getSkillsContext().root, root);
        assert.equal(host.getSkillsContext().installed.profile, 'repository');
        assert.equal(host.getSkillsContext().revision, skills.revision);
        assert.equal(vscode.workspace.workspaceFolders?.some(folder => folder.uri.fsPath === externalRoot), false);
      }
    } finally {
      if (host) {
        host.disposed = true;
        host.remoteWatchers.forEach((watcher: vscode.Disposable) => watcher.dispose());
        if (host.remoteRefreshTimer) clearTimeout(host.remoteRefreshTimer);
      }
      if (nativeRepository) await vscode.commands.executeCommand('git.close', nativeRepository.rootUri);
      if (fixtureAdded) {
        const restored = new Promise<void>(resolve => {
          const listener = vscode.workspace.onDidChangeWorkspaceFolders(() => { listener.dispose(); resolve(); });
        });
        assert.equal(vscode.workspace.updateWorkspaceFolders(0, vscode.workspace.workspaceFolders?.length ?? 0, ...originalWorkspace), true);
        await restored;
      }
      if (process.cwd().toLocaleLowerCase().startsWith(temporary.toLocaleLowerCase() + path.sep)) process.chdir(originalCwd);
      await configuration.update(setting, configurationTarget === vscode.ConfigurationTarget.Workspace ? previous?.workspaceValue : previous?.globalValue, configurationTarget);
      assert.equal(path.dirname(await realpath(temporary)), tempBase);
      await rm(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });
});
