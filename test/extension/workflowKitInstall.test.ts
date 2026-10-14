import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, realpath, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import * as vscode from 'vscode';
import { WorkspacePanel } from '../../src/workspace/workspacePanel';

suite('Local workflow kit installation', () => {
  test('the shared root setting defaults to the opened folder and supports workspace overrides', async () => {
    const folder = vscode.workspace.workspaceFolders?.[0];
    const configuration = vscode.workspace.getConfiguration('gitlabWorkspace', folder?.uri);
    const setting = 'projectRoot'; const previous = configuration.inspect<string>(setting);
    const currentValue = () => vscode.workspace.getConfiguration('gitlabWorkspace', folder?.uri).get<string>(setting);
    assert.equal(previous?.defaultValue, '');
    const target = folder && (vscode.workspace.workspaceFile || (vscode.workspace.workspaceFolders?.length ?? 0) > 1)
      ? vscode.ConfigurationTarget.WorkspaceFolder : vscode.ConfigurationTarget.Workspace;
    try {
      await configuration.update(setting, '', target); assert.equal(currentValue(), '');
      await configuration.update(setting, 'custom', target); assert.equal(currentValue(), 'custom');
    } finally {
      await configuration.update(setting, target === vscode.ConfigurationTarget.WorkspaceFolder ? previous?.workspaceFolderValue : previous?.workspaceValue, target);
    }
  });

  test('installs real bundled Skills and follows shared root changes for offline Skills', async function () {
    this.timeout(120_000);
    const temporaryParent = process.env.GITLAB_WORKSPACE_TEST_TMP;
    assert.ok(temporaryParent, 'Use the isolated Extension Host test runner');
    // Wiki's native installer adds its own staging tree; avoid Windows MAX_PATH in the fixture.
    const tempBase = await realpath(os.tmpdir());
    const temporary = await mkdtemp(path.join(tempBase, 'gw-kit-'));
    let configuration: vscode.WorkspaceConfiguration | undefined;
    let previous: ReturnType<vscode.WorkspaceConfiguration['inspect']>;
    const setting = 'projectRoot';
    let configurationTarget = vscode.ConfigurationTarget.WorkspaceFolder;
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
      configuration = vscode.workspace.getConfiguration('gitlabWorkspace', vscode.Uri.file(root));
      previous = configuration.inspect<string>(setting);
      configurationTarget = (vscode.workspace.workspaceFolders?.length ?? 0) > 1 ? vscode.ConfigurationTarget.WorkspaceFolder : vscode.ConfigurationTarget.Workspace;
      await configuration.update(setting, '', configurationTarget);
      const values = new Map<string, unknown>([['gitlabWorkspace.projectFolder', vscode.Uri.file(root).toString()]]);
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
        // This focused fixture skips the constructor's workspace-refresh lifecycle.
        // Keep real environment checks, status reads and installs, but do not start
        // filesystem watchers that can refresh this partially initialized controller.
        watchRepositoryRemotes: async () => undefined,
        sendSnapshot: () => undefined, post: () => undefined
      });
      await host.refreshWorkflowKit(false);
      assert.equal(host.workflowKitInstallTarget.state.status, 'missing');
      await host.handleMessage({ type: 'installWorkflowKit', packageId: 'bundled' });
      assert.equal(host.workflowKitInstallTarget.root, root);
      assert.equal(host.workflowKitInstallTarget.state.status, 'installed');
      assert.equal(host.workflowKitInstallTarget.state.profile, 'repository');
      assert.equal(host.workflowKitState.status, 'installed');
      assert.equal(host.cloneRoot, root);
      assert.equal(host.groupRoot, root);
      assert.equal((await readdir(path.join(root, '.agents/skills'))).length, 16);
      assert.match(await readFile(path.join(root, '.agents/skills/megin/SKILL.md'), 'utf8'), /Megin/);
      assert.ok((await readdir(path.join(root, '.agents/skills/megin/scripts'))).includes('repo_workspace.py'));
      assert.ok(!(await readdir(path.join(root, '.agents/skills/megin/scripts'))).includes('group_workspace.py'));
      const skills = host.getSkillsContext();
      assert.equal(skills.root, root); assert.equal(skills.installed.status, 'installed');
      for (const profile of ['group', 'repository']) {
        const external = path.join(temporary, `外部 ${profile}`); await mkdir(external);
        if (profile === 'repository') execFileSync('git', ['init', '--quiet', external]);
        const externalRoot = await realpath(external);
        await configuration.update(setting, externalRoot, configurationTarget);
        await host.refreshWorkflowKit(false);
        assert.equal(host.workflowKitInstallTarget.profile, profile);
        await host.handleMessage({ type: 'installWorkflowKit', packageId: 'bundled' });
        assert.equal(host.workflowKitInstallTarget.root, externalRoot);
        assert.equal(host.workflowKitInstallTarget.state.status, 'installed');
        assert.equal(host.workflowKitInstallTarget.state.profile, profile);
        assert.equal((await readdir(path.join(externalRoot, '.agents/skills'))).length, 16);
        assert.equal(host.getSkillsContext().root, externalRoot);
        assert.equal(host.getSkillsContext().installed.profile, profile);
        assert.notEqual(host.getSkillsContext().revision, skills.revision);
        assert.equal(vscode.workspace.workspaceFolders?.some(folder => folder.uri.fsPath === externalRoot), false);
      }
    } finally {
      if (host) {
        host.disposed = true;
        host.remoteWatchers.forEach((watcher: vscode.Disposable) => watcher.dispose());
        if (host.remoteRefreshTimer) clearTimeout(host.remoteRefreshTimer);
      }
      if (configuration) await configuration.update(setting, configurationTarget === vscode.ConfigurationTarget.WorkspaceFolder ? previous?.workspaceFolderValue : previous?.workspaceValue, configurationTarget);
      if (nativeRepository) await vscode.commands.executeCommand('git.close', nativeRepository.rootUri);
      if (fixtureAdded) {
        const restored = new Promise<void>(resolve => {
          const listener = vscode.workspace.onDidChangeWorkspaceFolders(() => { listener.dispose(); resolve(); });
        });
        assert.equal(vscode.workspace.updateWorkspaceFolders(0, vscode.workspace.workspaceFolders?.length ?? 0, ...originalWorkspace), true);
        await restored;
      }
      if (process.cwd().toLocaleLowerCase().startsWith(temporary.toLocaleLowerCase() + path.sep)) process.chdir(originalCwd);
      assert.equal(path.dirname(await realpath(temporary)), tempBase);
      await rm(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });
});
