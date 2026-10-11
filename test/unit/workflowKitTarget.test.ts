import assert from 'node:assert/strict';
import { mkdtemp, mkdir, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { resolveWorkflowKitInstallRoot } from '../../src/workspace/workspacePaths';

const storageKey = 'gitlabWorkspace.workflowKit.installRoot';
const uri = (fsPath: string) => ({ scheme: 'file', fsPath });
let requireGroup: boolean | undefined = false;
const configurationUpdates: Array<{ key: string; value: unknown; target: number }> = [];
const vscode = {
  workspace: {
    workspaceFolders: [] as Array<{ uri: ReturnType<typeof uri> }>,
    getConfiguration: () => ({
      get: (_key: string, fallback: unknown) => _key === 'workflowKit.requireGroupEnvironment' ? requireGroup ?? fallback : fallback,
      update: async (key: string, value: unknown, target: number) => { configurationUpdates.push({ key, value, target }); requireGroup = value as boolean; }
    })
  },
  ConfigurationTarget: { Global: 1, Workspace: 2 },
  env: { openExternal: async (_uri: unknown) => true },
  window: {
    showOpenDialog: async (_options: unknown): Promise<Array<ReturnType<typeof uri>> | undefined> => undefined,
    withProgress: async (_options: unknown, task: () => Promise<unknown>) => task()
  },
  Uri: { file: uri, parse: (url: string) => ({ url }) }, ProgressLocation: { Notification: 15 }
};
const moduleLoader = require('node:module') as { _load: (name: string, parent: unknown, main: boolean) => unknown };
const originalLoad = moduleLoader._load;
let resolvingPython: (() => void) | undefined;
moduleLoader._load = (name, parent, main) => name === 'vscode' ? vscode : name === './pythonRuntime' ? {
  resolvePythonRuntime: async () => { resolvingPython?.(); return { executable: process.execPath, args: [], env: process.env }; }
} : originalLoad(name, parent, main);
let WorkspacePanel: typeof import('../../src/workspace/workspacePanel').WorkspacePanel;
try { ({ WorkspacePanel } = require('../../src/workspace/workspacePanel')); }
finally { moduleLoader._load = originalLoad; }

function memory() {
  const values = new Map<string, unknown>();
  return {
    get: <T>(key: string) => values.get(key) as T | undefined,
    update: async (key: string, value: unknown) => { if (value === undefined) values.delete(key); else values.set(key, value); }
  };
}

function fixture(folders: string[], workspaceState = memory()) {
  requireGroup = false;
  configurationUpdates.length = 0;
  vscode.workspace.workspaceFolders = folders.map(root => ({ uri: uri(root) }));
  vscode.window.showOpenDialog = async () => undefined;
  vscode.env.openExternal = async () => true;
  const installed = new Set<string>();
  const calls: string[][] = [], messages: any[] = [];
  const bundle = { id: 'bundled', archivePath: 'offline.tar.xz', version: '0.15.0', source: 'bundled', format: 'tar.xz', entryRoot: 'workflow-kit', sha256: 'a'.repeat(64) };
  const host: any = Object.assign(Object.create(WorkspacePanel!.prototype), {
    disposed: false, workspaceFoldersGeneration: 0, workflowKitRefreshGeneration: 0,
    workflowKitStatusReads: new Map(), workflowKitState: { status: 'missing' },
    workflowKitInstallTarget: { manual: false, state: { status: 'missing' } },
    workflowKitSelectingRoot: false, busy: false, writesInFlight: 0,
    webviewMessagesReceived: 0,
    session: { getClient: () => { throw new Error('Local installation must not request GitLab credentials'); } },
    context: { workspaceState, extension: { packageJSON: { version: bundle.version } } },
    packages: { listPackages: async () => [bundle], getPackage: async () => bundle },
    sendSnapshot: () => undefined, post: (message: unknown) => messages.push(message),
    runWorkflowKitHelper: async (args: string[]) => {
      calls.push(args);
      if (args[0] === 'install') {
        installed.add(args[2]);
        return { ok: true, package: 'gitlab-workspace-kit', version: bundle.version };
      }
      return { ok: true, status: installed.has(args[1]) ? 'installed' : 'missing', version: bundle.version };
    }
  });
  return { host, installed, calls, messages, workspaceState };
}

async function directories(t: test.TestContext) {
  const parent = await realpath(os.tmpdir());
  const temporary = await mkdtemp(path.join(parent, 'kit-target-'));
  t.after(async () => {
    assert.equal(path.dirname(await realpath(temporary)), parent);
    await rm(temporary, { recursive: true, force: true });
  });
  const roots = ['工作區 Repo', 'Group', '指定位置'].map(name => path.join(temporary, name));
  await Promise.all(roots.map(root => mkdir(root)));
  return Promise.all(roots.map(root => realpath(root)));
}

test('installation roots prefer manual, then Group, then the single local folder, including Repo subdirectories', async t => {
  const [workspace, group, manual] = await directories(t);
  await mkdir(path.join(workspace, '.git'));
  const child = path.join(workspace, 'nested'); await mkdir(child);
  assert.equal((await resolveWorkflowKitInstallRoot(manual, group, [workspace])).root, manual);
  assert.equal((await resolveWorkflowKitInstallRoot(undefined, group, [workspace, manual])).root, group);
  assert.equal((await resolveWorkflowKitInstallRoot(undefined, undefined, [workspace])).root, workspace);
  assert.equal((await resolveWorkflowKitInstallRoot(undefined, undefined, [child])).root, await realpath(child));
  assert.match((await resolveWorkflowKitInstallRoot(undefined, undefined, [])).error!, /請選擇/);
  assert.match((await resolveWorkflowKitInstallRoot(undefined, undefined, [workspace, manual])).error!, /多個/);
  const missing = path.join(manual, 'missing');
  const invalid = await resolveWorkflowKitInstallRoot(missing, group, [workspace]);
  assert.equal(invalid.root, missing); assert.match(invalid.error!, /不存在/);
  const file = path.join(manual, 'file'); await writeFile(file, 'content');
  assert.match((await resolveWorkflowKitInstallRoot(file, group, [workspace])).error!, /不是資料夾/);
});

test('folder selection persists per workspace, cancellation retains it, and reset restores the default', async t => {
  const [workspace, group, manual] = await directories(t);
  const { host, workspaceState } = fixture([workspace]); host.groupRoot = group;
  await host.refreshWorkflowKit();
  assert.equal(host.workflowKitInstallTarget.root, group);
  let options: any;
  vscode.window.showOpenDialog = async value => { options = value; return [uri(manual)]; };
  await host.dispatchMessage({ type: 'selectWorkflowKitInstallRoot' });
  assert.equal(options.canSelectFolders, true); assert.equal(options.canSelectFiles, false);
  assert.equal(workspaceState.get(storageKey), manual);
  const reopened = fixture([workspace], workspaceState).host;
  await reopened.refreshWorkflowKit();
  assert.equal(reopened.workflowKitInstallTarget.root, manual);
  assert.equal(reopened.workflowKitInstallTarget.manual, true);
  await reopened.selectWorkflowKitInstallRoot();
  assert.equal(reopened.workflowKitInstallTarget.root, manual);
  const isolated = fixture([workspace]).host;
  await isolated.refreshWorkflowKit();
  assert.equal(isolated.workflowKitInstallTarget.root, workspace);
  await reopened.dispatchMessage({ type: 'resetWorkflowKitInstallRoot' });
  assert.equal(workspaceState.get(storageKey), undefined);
  assert.equal(reopened.workflowKitInstallTarget.root, workspace);
  assert.equal(reopened.workflowKitInstallTarget.manual, false);
});

test('an empty offline window can select and install a bundled package without a Group or credentials', async t => {
  const [, , manual] = await directories(t);
  const { host, calls, installed } = fixture([]);
  await host.refreshWorkflowKit();
  assert.equal(host.workflowKitInstallTarget.root, undefined);
  await assert.rejects(host.installWorkflowKit('bundled'), /選擇/);
  vscode.window.showOpenDialog = async () => [uri(manual)];
  await host.handleMessage({ type: 'selectWorkflowKitInstallRoot' });
  await host.handleMessage({ type: 'installWorkflowKit', packageId: 'bundled' });
  assert.equal(calls.find(args => args[0] === 'install')?.[2], manual);
  assert.ok(installed.has(manual));
  assert.equal(host.workflowKitInstallTarget.state.status, 'installed');
  assert.equal(host.workflowKitState.status, 'missing');
  assert.equal(host.groupRoot, undefined);
});

test('a missing saved location stays selected and blocks installation instead of falling back', async t => {
  const [workspace, group, manual] = await directories(t);
  const { host, calls, workspaceState } = fixture([workspace]); host.groupRoot = group;
  const missing = path.join(manual, 'deleted');
  await workspaceState.update(storageKey, missing);
  await host.refreshWorkflowKit();
  assert.equal(host.workflowKitInstallTarget.root, missing);
  assert.match(host.workflowKitInstallTarget.error, /不存在/);
  await assert.rejects(host.installWorkflowKit('bundled'), /不存在/);
  assert.equal(calls.filter(args => args[0] === 'install').length, 0);
});

test('a package installed elsewhere does not satisfy the current Group readiness check', async t => {
  const [workspace, group, manual] = await directories(t);
  const { host, installed, workspaceState } = fixture([workspace]); host.groupRoot = group;
  await workspaceState.update(storageKey, manual); installed.add(manual);
  await host.refreshWorkflowKit();
  assert.equal(host.workflowKitInstallTarget.state.status, 'installed');
  assert.equal(host.workflowKitState.status, 'missing');
  await assert.rejects(host.assertWorkflowKitReady(), /此 Group/);
  installed.add(group);
  await host.assertWorkflowKitReady();
  assert.equal(host.workflowKitState.status, 'installed');
  assert.equal(host.workflowKitInstallTarget.root, manual);
});

test('late status results from a previous target cannot overwrite the new selection', async t => {
  const [workspace, , manual] = await directories(t);
  const { host, workspaceState } = fixture([workspace]);
  let finish!: (value: unknown) => void, start!: () => void;
  const started = new Promise<void>(resolve => { start = resolve; });
  host.runWorkflowKitHelper = async (args: string[]) => args[1] === workspace
    ? new Promise(resolve => { finish = resolve; start(); }) : { ok: true, status: 'missing' };
  const old = host.refreshWorkflowKit(); await started;
  await workspaceState.update(storageKey, manual);
  await host.refreshWorkflowKit();
  finish({ ok: true, status: 'installed', version: 'old' }); await old;
  assert.equal(host.workflowKitInstallTarget.root, manual);
  assert.equal(host.workflowKitInstallTarget.state.status, 'missing');
});

test('installation fixes its target and rejects duplicate installs and selection changes until it completes', async t => {
  const [workspace, group] = await directories(t);
  const { host, calls, installed, messages } = fixture([workspace]);
  await host.refreshWorkflowKit();
  const helper = host.runWorkflowKitHelper;
  let finish!: (value: unknown) => void, start!: () => void;
  const started = new Promise<void>(resolve => { start = resolve; });
  host.runWorkflowKitHelper = async (args: string[]) => {
    if (args[0] !== 'install') return helper(args);
    calls.push(args); start();
    return new Promise(resolve => { finish = resolve; });
  };
  const operation = host.installWorkflowKit('bundled'); await started;
  await assert.rejects(host.installWorkflowKit('bundled'), /正在進行/);
  await assert.rejects(host.selectWorkflowKitInstallRoot(), /等候/);
  await assert.rejects(host.resetWorkflowKitInstallRoot(), /等候/);
  host.groupRoot = group; host.workspaceFoldersGeneration++;
  await host.refreshWorkflowKit();
  assert.equal(host.workflowKitInstallTarget.root, workspace);
  assert.equal(host.workflowKitInstallTarget.state.status, 'installing');
  assert.equal(host.workflowKitState.status, 'missing');
  installed.add(workspace);
  finish({ ok: true, package: 'gitlab-workspace-kit', version: '0.15.0' }); await operation;
  assert.equal(calls.filter(args => args[0] === 'install').length, 1);
  assert.equal(calls.find(args => args[0] === 'install')?.[2], workspace);
  assert.ok(messages.some(message => message.message?.includes(workspace)));
  assert.equal(host.workflowKitInstallTarget.root, group);
  assert.equal(host.workflowKitInstallTarget.state.status, 'missing');
});

test('a Group readiness check started before installation cannot pass on the old installed state', async t => {
  const [workspace] = await directories(t);
  const { host, installed, calls } = fixture([workspace]);
  host.groupRoot = workspace; installed.add(workspace);
  await host.refreshWorkflowKit();
  assert.equal(calls.filter(args => args[0] === 'status').length, 1, 'Group and target share one filesystem status check');
  const helper = host.runWorkflowKitHelper;
  let finish!: (value: unknown) => void, start!: () => void, delayed = false;
  const started = new Promise<void>(resolve => { start = resolve; });
  host.runWorkflowKitHelper = async (args: string[]) => {
    if (args[0] !== 'status' || delayed) return helper(args);
    delayed = true; start();
    return new Promise(resolve => { finish = resolve; });
  };
  const readiness = host.assertWorkflowKitReady(); await started;
  const installation = host.installWorkflowKit('bundled');
  finish({ ok: true, status: 'installed', version: '0.15.0' });
  const results = await Promise.allSettled([readiness, installation]);
  assert.equal(results[0].status, 'rejected');
  if (results[0].status === 'rejected') assert.match(String(results[0].reason), /正在安裝中/);
  assert.equal(results[1].status, 'fulfilled');
  assert.equal(host.workflowKitInstallTarget.state.status, 'installed');
});

test('replacing the selected directory with an alias cannot redirect installation', async t => {
  const [workspace, , manual] = await directories(t);
  const { host, calls } = fixture([workspace]);
  await host.refreshWorkflowKit();
  await rename(workspace, `${workspace}-moved`);
  await symlink(manual, workspace, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(host.installWorkflowKit('bundled'), /安裝位置已變更/);
  assert.equal(calls.filter(args => args[0] === 'install').length, 0);
});

test('the default Group policy blocks every package entry point until login, Group and workspace are ready', async t => {
  const [workspace, group] = await directories(t);
  const { host, calls } = fixture([workspace]);
  requireGroup = undefined;
  let downloads = 0, dialogs = 0;
  vscode.env.openExternal = async () => { downloads++; return true; };
  vscode.window.showOpenDialog = async () => { dialogs++; return undefined; };
  const blocked = async (reason: RegExp) => {
    for (const request of [{ type: 'openWorkflowKitDownload', source: 'github' }, { type: 'importWorkflowKitPackage', source: 'gitea' }, { type: 'installWorkflowKit', packageId: 'bundled' }]) {
      await assert.rejects(host.handleMessage(request), reason);
    }
  };
  await host.refreshWorkflowKit();
  assert.equal(host.getWorkflowKitPolicy().requireGroupEnvironment, true);
  await blocked(/登入/);
  host.session.baseUrl = 'https://gitlab.test'; host.currentUser = { id: 1 };
  await blocked(/選擇.*Group/);
  host.session.selectedGroup = { id: 1 };
  await blocked(/本機資料夾/);
  assert.equal(downloads, 0); assert.equal(dialogs, 0); assert.equal(calls.length, 0);
  host.groupRoot = group;
  await host.refreshWorkflowKit();
  await host.handleMessage({ type: 'openWorkflowKitDownload', source: 'github' });
  await host.handleMessage({ type: 'installWorkflowKit', packageId: 'bundled' });
  assert.equal(downloads, 1);
  assert.equal(calls.find(args => args[0] === 'install')?.[2], group);
  host.pendingWorkspaceRefresh = true;
  await blocked(/正在辨識/);
});

test('Group mode pins the Group target and preserves the saved free-mode location across toggles', async t => {
  const [workspace, group, manual] = await directories(t);
  const { host, workspaceState, calls } = fixture([workspace]);
  host.groupRoot = group; host.currentUser = { id: 1 }; host.session.baseUrl = 'https://gitlab.test'; host.session.selectedGroup = { id: 1 };
  await workspaceState.update(storageKey, manual);
  requireGroup = true;
  await host.refreshWorkflowKit();
  assert.equal(host.workflowKitInstallTarget.root, group);
  assert.equal(host.workflowKitInstallTarget.manual, false);
  await assert.rejects(host.selectWorkflowKitInstallRoot(), /固定/);
  await assert.rejects(host.resetWorkflowKitInstallRoot(), /固定/);
  host.workflowKitInstallTarget = { root: manual, state: { status: 'missing' } };
  await assert.rejects(host.installWorkflowKit('bundled'), /目前 Group 根目錄/);
  assert.equal(calls.filter(args => args[0] === 'install').length, 0);
  await host.setWorkflowKitRequireGroup(false);
  assert.equal(host.workflowKitInstallTarget.root, manual);
  assert.equal(workspaceState.get(storageKey), manual);
  assert.deepEqual(configurationUpdates.at(-1), { key: 'workflowKit.requireGroupEnvironment', value: false, target: 2 });
});

test('settings use the user target in an empty window and invalid values cannot change the policy', async () => {
  const { host } = fixture([]);
  await host.setWorkflowKitRequireGroup(true);
  assert.deepEqual(configurationUpdates.at(-1), { key: 'workflowKit.requireGroupEnvironment', value: true, target: 1 });
  assert.equal(host.getWorkflowKitPolicy().settingTarget, 'user');
  assert.equal(host.getWorkflowKitPolicy().allowed, false);
  await assert.rejects(host.setWorkflowKitRequireGroup('false'), /布林/);
  assert.equal(requireGroup, true);
});

test('a policy change during a folder dialog or archive inspection prevents saving the selection or import', async t => {
  const [workspace, , manual] = await directories(t);
  const { host, workspaceState } = fixture([workspace]);
  vscode.window.showOpenDialog = async () => { requireGroup = true; return [uri(manual)]; };
  await assert.rejects(host.selectWorkflowKitInstallRoot(), /登入/);
  assert.equal(workspaceState.get(storageKey), undefined);
  assert.equal(host.workflowKitSelectingRoot, false);
  requireGroup = false;
  vscode.window.showOpenDialog = async () => [uri('kit.zip')];
  let imports = 0;
  host.packages.importPackage = async () => { imports++; };
  host.runWorkflowKitHelper = async () => { requireGroup = true; return { package: 'gitlab-workspace-kit', version: '0.15.0', sha256: 'a'.repeat(64) }; };
  await assert.rejects(host.importWorkflowKitPackage('github'), /登入/);
  assert.equal(imports, 0); assert.equal(host.workflowKitImporting, false);
});

test('policy changes before installer launch are checked again, while an already launched transaction keeps its target', async t => {
  const [workspace] = await directories(t);
  const { host, calls } = fixture([workspace]);
  await host.refreshWorkflowKit();
  const getPackage = host.packages.getPackage;
  host.packages.getPackage = async () => { requireGroup = true; return getPackage(); };
  await assert.rejects(host.installWorkflowKit('bundled'), /登入/);
  assert.equal(calls.filter(args => args[0] === 'install').length, 0);
  assert.equal(host.workflowKitInstallation, undefined);
  requireGroup = false; host.packages.getPackage = getPackage;
  await host.refreshWorkflowKit();
  const helper = host.runWorkflowKitHelper;
  host.runWorkflowKitHelper = async (args: string[]) => {
    if (args[0] === 'install') requireGroup = true;
    return helper(args);
  };
  await host.installWorkflowKit('bundled');
  assert.equal(calls.find(args => args[0] === 'install')?.[2], workspace);
  assert.equal(host.workflowKitInstallation, undefined);
  assert.equal(host.getWorkflowKitPolicy().allowed, false);
  assert.equal(host.workflowKitInstallTarget.root, undefined);
});

test('a policy change while resolving Python prevents the installer process from launching', async t => {
  const [workspace] = await directories(t);
  const { host } = fixture([workspace]);
  await host.refreshWorkflowKit();
  host.runWorkflowKitHelper = (WorkspacePanel!.prototype as any).runWorkflowKitHelper;
  host.workflowKitHelper = () => { throw new Error('The installer must not launch'); };
  resolvingPython = () => { requireGroup = true; };
  try {
    await assert.rejects(host.installWorkflowKit('bundled'), /登入/);
    assert.equal(host.workflowKitInstallation, undefined);
    assert.equal(host.getWorkflowKitPolicy().allowed, false);
  } finally { resolvingPython = undefined; }
});
