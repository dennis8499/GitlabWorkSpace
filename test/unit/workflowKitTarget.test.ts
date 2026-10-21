import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { OperationLog } from '../../src/logging/operationLog';

const storageKey = 'gitlabWorkspace.workflowKit.installRoot';
const skillsStorageKey = 'gitlabWorkspace.skills.repositoryRoot';
const uri = (fsPath: string) => ({ scheme: 'file', fsPath, toString: () => 'file:' + fsPath });
const configuredRoots = new Map<string, string>();
const folderKey = 'gitlabWorkspace.projectFolder';
let preferGroup: boolean | undefined;
let resolvingPython: (() => void) | undefined;
const updates: any[] = [];
const terminals: any[] = [];
const vscode = {
  workspace: {
    workspaceFolders: [] as Array<{ uri: ReturnType<typeof uri> }>,
    workspaceFile: undefined as ReturnType<typeof uri> | undefined,
    getConfiguration: (_section?: string, resource?: ReturnType<typeof uri>) => ({ get: (key: string, fallback: unknown) => key === 'projectRoot' ? configuredRoots.get(resource?.toString() ?? '') ?? fallback
      : fallback,
      update: async (key: string, value: string, target: number) => { updates.push({ key, value, target, resource: resource?.toString() }); configuredRoots.set(resource?.toString() ?? '', value); } })
  },
  ConfigurationTarget: { Global: 1, Workspace: 2, WorkspaceFolder: 3 },
  env: { openExternal: async (_uri: unknown) => true, clipboard: { writeText: async (_text: string) => undefined } },
  window: {
    createTerminal: (options: any) => { terminals.push(options); return { show: () => undefined, sendText: () => undefined }; },
    showQuickPick: async (_items: any[], _options: unknown): Promise<any> => undefined,
    showOpenDialog: async (_options: unknown): Promise<any> => undefined,
    withProgress: async (_options: unknown, task: () => Promise<unknown>) => task()
  },
  Uri: { file: uri, parse: (url: string) => ({ url }) }, ProgressLocation: { Notification: 15 }
};
const moduleLoader = require('node:module') as { _load: (name: string, parent: unknown, main: boolean) => unknown };
const originalLoad = moduleLoader._load;
moduleLoader._load = (name, parent, main) => name === 'vscode' ? vscode : name === './windowsTerminal' ? {
  windowsCodexTerminalOptions: () => ({ shellPath: 'codex.exe' })
} : name === './pythonRuntime' ? {
  resolvePythonRuntime: async () => { resolvingPython?.(); return { executable: process.execPath, args: [], env: process.env }; }
} : originalLoad(name, parent, main);
let WorkspacePanel: typeof import('../../src/workspace/workspacePanel').WorkspacePanel;
try { ({ WorkspacePanel } = require('../../src/workspace/workspacePanel')); }
finally { moduleLoader._load = originalLoad; }

function memory() {
  const values = new Map<string, unknown>();
  return { get: <T>(key: string) => values.get(key) as T | undefined,
    update: async (key: string, value: unknown) => { value === undefined ? values.delete(key) : values.set(key, value); } };
}
const project = (id: number, name: string) => ({ id, name, path: name, path_with_namespace: `team/${name}`,
  http_url_to_repo: `https://gitlab.test/team/${name}.git`, web_url: `https://gitlab.test/team/${name}` });
const argumentValue = (args: string[] | undefined, flag: string) => args?.includes(flag) ? args[args.indexOf(flag) + 1] : undefined;

function fixture(folders: string[], connected = false, workspaceState = memory()) {
  configuredRoots.clear(); preferGroup = undefined; updates.length = 0; resolvingPython = undefined;
  vscode.workspace.workspaceFile = undefined;
  vscode.workspace.workspaceFolders = folders.map(root => ({ uri: uri(root) }));
  vscode.window.showQuickPick = async () => undefined;
  vscode.window.showOpenDialog = async () => undefined;
  vscode.env.openExternal = async () => true;
  const installed = new Map<string, 'group' | 'repository'>();
  const calls: string[][] = [];
  const bundle = { id: 'bundled', archivePath: 'offline.tar.xz', version: '0.17.0', source: 'bundled', format: 'tar.xz', entryRoot: 'workflow-kit', sha256: 'a'.repeat(64) };
  const host: any = Object.assign(Object.create(WorkspacePanel!.prototype), {
    disposed: false, activeMode: 'sa', projectSource: 'local', developerView: 'list',
    requestGeneration: 0, viewGeneration: 0, inventoryGeneration: 0, cloneRootGeneration: 0,
    previewGeneration: 0, issueOpenGeneration: 0, issueBoardGeneration: 0, issueGraphGeneration: 0, mergeRequestGeneration: 0,
    workspaceSectionGenerations: new Map(), workspaceSectionAborts: new Map(),
    mergeRequestSectionAborts: {}, mergeRequestSectionGenerations: { diffs: 0, discussions: 0 },
    issuePanels: { suspendReads: () => undefined },
    workspaceFoldersGeneration: 0, skillsEnvironmentGeneration: 0, workflowKitRefreshGeneration: 0,
    projectRepositoryScanGeneration: 0, localRepositoryScanGeneration: 0,
    workspaceMatch: { status: 'checking', repositories: [] }, projects: connected ? [project(1, 'service'), project(2, 'docs')] : [],
    workspaceSections: { projects: { status: connected ? 'ready' : 'idle' } },
    loadedScopeKey: connected ? 'https://gitlab.test|1|1' : undefined,
    workflowKitStatusReads: new Map(), workflowKitState: { status: 'missing' },
    workflowKitInstallTarget: { manual: false, state: { status: 'missing' } },
    workflowKitSelectingRoot: false, busy: false, writesInFlight: 0, webviewMessagesReceived: 0,
    currentUser: connected ? { id: 1 } : undefined,
    session: { connectionEpoch: 1, baseUrl: connected ? 'https://gitlab.test' : undefined, selectedGroup: connected ? { id: 1 } : undefined,
      getClient: () => { throw new Error('Local Skills must not request GitLab credentials'); } },
    context: { workspaceState, globalState: memory(), extension: { packageJSON: { version: bundle.version } } },
    packages: { listPackages: async () => [bundle], getPackage: async () => bundle },
    sendSnapshot: () => undefined, post: () => undefined,
    runWorkflowKitHelper: async (args: string[], _timeout?: number, beforeLaunch?: () => Promise<void>) => {
      await beforeLaunch?.(); calls.push(args);
      if (args[0] === 'install') {
        const profile = args[args.indexOf('--profile') + 1] as 'group' | 'repository';
        installed.set(args[2], profile);
        return { ok: true, package: 'gitlab-workspace-kit', version: bundle.version, profile };
      }
      return installed.has(args[1]) ? { ok: true, status: 'installed', version: bundle.version, profile: installed.get(args[1]), capabilities: ['query', 'megin-resume'] }
        : { ok: true, status: 'missing' };
    }
  });
  host.onWorkspaceFoldersChanged = () => { host.workspaceFoldersGeneration++; host.skillsEnvironmentGeneration++; host.projectContext = undefined; };
  return { host, installed, calls, workspaceState };
}

async function selectFolder(host: any, root: string): Promise<void> {
  await host.selectProjectFolder(uri(root).toString());
}

async function directories(t: test.TestContext) {
  const temporary = await mkdtemp(path.join(await realpath(os.tmpdir()), 'kit-context-'));
  t.after(async () => { await rm(temporary, { recursive: true, force: true }); });
  const group = path.join(temporary, '工作區 Group');
  const repo = path.join(group, 'renamed-service'), other = path.join(group, 'docs');
  await mkdir(repo, { recursive: true }); await mkdir(other);
  for (const [root, remote] of [[repo, project(1, 'service').http_url_to_repo], [other, project(2, 'docs').http_url_to_repo]]) {
    execFileSync('git', ['init', '--quiet', root]); execFileSync('git', ['-C', root, 'remote', 'add', 'origin', remote]);
  }
  return Promise.all([group, repo, other].map(root => realpath(root)));
}

test('all local features default to the opened Repo even when its origin matches GitLab', async t => {
  const [, repo] = await directories(t); const { host, calls } = fixture([repo], true);
  await host.refreshWorkflowKit();
  assert.equal(host.workflowKitInstallTarget.root, repo); assert.equal(host.cloneRoot, repo);
  assert.equal(host.getSkillsContext().root, repo);
  assert.equal(host.getWorkflowKitPolicy().mode, 'repository');
  await host.installWorkflowKit('bundled');
  assert.equal(argumentValue(calls.find(args => args[0] === 'install'), '--profile'), 'repository');
});

test('additional Git API Repos cannot change the opened project root', async t => {
  const [, repo, other] = await directories(t); const { host } = fixture([repo], true);
  host.gitRepositories = { getInventory: async () => [{ path: other }] };
  await host.refreshWorkflowKit();
  assert.equal(host.getSkillsContext().root, repo); assert.equal(host.getSkillsContext().mode, 'repository');
  assert.deepEqual(host.getSkillsContext().repositories.map((r: any) => r.path), [repo]);
});

test('switching GitLab Group does not change local paths or workflow', async t => {
  const [group] = await directories(t); const { host, installed } = fixture([group], true);
  installed.set(group, 'group'); await host.refreshWorkflowKit();
  host.session.selectedGroup = { id: 2 }; host.projects = [];
  await host.refreshWorkflowKit();
  assert.equal(host.getSkillsContext().mode, 'group'); assert.equal(host.getSkillsContext().root, group);
  assert.equal(host.cloneRoot, group);
});

test('Codex uses the selected workspace folder and rejects a stale context', async t => {
  const [, repo, other] = await directories(t); const { host, installed } = fixture([repo, other]);
  installed.set(repo, 'repository'); installed.set(other, 'repository');
  await selectFolder(host, repo); const context = host.getSkillsContext(); terminals.length = 0;
  await host.openCodexTerminal(context.revision); assert.equal(terminals[0].cwd, repo);
  await selectFolder(host, other); await assert.rejects(host.openCodexTerminal(context.revision), /啟動位置/);
  assert.equal(terminals.length, 1);
});

test('an empty window permits package downloads but requires an opened project for local operations', async t => {
  const [, repo] = await directories(t); const { host, calls } = fixture([]);
  await host.refreshWorkflowKit(); await host.openWorkflowKitDownload('gitea');
  await assert.rejects(host.installWorkflowKit('bundled'), /資料夾/);
  await assert.rejects(host.selectProjectRoot(), /資料夾/);
  await assert.rejects(selectFolder(host, repo), /目前 VS Code/);
  assert.equal(calls.length, 0);
});

test('multiple workspace folders require one explicit selection and remember it on reopening', async t => {
  const [, repo, other] = await directories(t); const { host, workspaceState } = fixture([repo, other]);
  await host.refreshWorkflowKit(); assert.equal(host.cloneRoot, undefined);
  await selectFolder(host, other); assert.equal(workspaceState.get(folderKey), uri(other).toString());
  const reopened = fixture([repo, other], false, workspaceState).host; await reopened.refreshWorkflowKit();
  assert.equal(reopened.cloneRoot, other); assert.equal(reopened.getSkillsContext().root, other);
});

test('legacy independent paths do not override the VS Code project root', async t => {
  const [group, repo, other] = await directories(t); const state = memory();
  await state.update(storageKey, group); await state.update(skillsStorageKey, other);
  await state.update('gitlabWorkspace.cloneRoot.legacy', other);
  const { host } = fixture([repo], false, state); await host.refreshWorkflowKit();
  assert.equal(host.cloneRoot, repo); assert.equal(host.getSkillsContext().root, repo);
  assert.equal(host.workflowKitInstallTarget.root, repo);
});

test('changing the shared root switches installation, Skills and Codex together', async t => {
  const [group, repo] = await directories(t); const { host, installed } = fixture([group]);
  installed.set(group, 'group'); installed.set(repo, 'repository'); await host.refreshWorkflowKit();
  const oldRevision = host.getSkillsContext().revision;
  vscode.window.showOpenDialog = async () => [uri(repo)]; await host.selectProjectRoot();
  assert.equal(host.cloneRoot, repo); assert.equal(host.workflowKitInstallTarget.root, repo);
  assert.equal(host.getSkillsContext().root, repo);
  assert.notEqual(host.getSkillsContext().revision, oldRevision);
  assert.equal(updates.at(-1).target, 2); assert.equal(updates.at(-1).key, 'projectRoot');
  terminals.length = 0; await host.openCodexTerminal(host.getSkillsContext().revision); assert.equal(terminals[0].cwd, repo);
  await host.resetWorkflowKitInstallRoot(); assert.equal(host.cloneRoot, group);
});

test('custom roots are saved per workspace folder and cancellation preserves the current setting', async t => {
  const [group, repo, other] = await directories(t); const { host } = fixture([repo, other]);
  await selectFolder(host, repo); vscode.window.showOpenDialog = async () => [uri(group)]; await host.selectProjectRoot();
  assert.equal(updates.at(-1).target, 3); assert.equal(updates.at(-1).resource, uri(repo).toString());
  await selectFolder(host, other); assert.equal(host.cloneRoot, other);
  await selectFolder(host, repo); assert.equal(host.cloneRoot, group);
  vscode.window.showOpenDialog = async () => undefined; await host.selectProjectRoot(); assert.equal(host.cloneRoot, group);
});

test('ordinary folders work offline and an opened Repo subdirectory keeps its own path with a Skills error', async t => {
  const [group, repo] = await directories(t); const { host, calls } = fixture([group]);
  await host.refreshWorkflowKit(); await host.installWorkflowKit('bundled');
  assert.equal(argumentValue(calls.find(args => args[0] === 'install'), '--profile'), 'group');
  const child = path.join(repo, 'src'); await mkdir(child); vscode.window.showOpenDialog = async () => [uri(child)];
  await host.selectProjectRoot(); assert.equal(host.cloneRoot, child);
  assert.match(host.workflowKitInstallTarget.error, /Git 根目錄/);
  await assert.rejects(host.installWorkflowKit('bundled'), /Git 根目錄/);
  vscode.window.showOpenDialog = async () => [{ scheme: 'vscode-remote', fsPath: child }];
  await assert.rejects(host.selectProjectRoot(), /本機/);
});

test('an invalid configured root reports its path and never falls back to the opened folder', async t => {
  const [group, repo] = await directories(t); const { host, calls } = fixture([repo]);
  const missing = path.join(group, 'removed'); configuredRoots.set(uri(repo).toString(), missing);
  await host.refreshWorkflowKit(); assert.equal(host.cloneRoot, undefined);
  assert.match(host.workflowKitInstallTarget.error, /removed/); assert.equal(host.getSkillsContext().root, undefined);
  await assert.rejects(host.installWorkflowKit('bundled'), /不存在|讀取/);
  assert.equal(calls.filter(args => args[0] === 'install').length, 0);
});

test('installation at a different project cannot enable Skills for the selected project', async t => {
  const [, repo, other] = await directories(t); const { host, installed } = fixture([repo, other]);
  installed.set(other, 'repository'); await selectFolder(host, repo);
  assert.equal(host.getSkillsContext().installed.status, 'missing'); assert.deepEqual(host.getSkillsContext().availableFeatures, []);
});

test('late status reads cannot overwrite a newly configured project root', async t => {
  const [group, repo, other] = await directories(t); const { host } = fixture([repo]);
  configuredRoots.set(uri(repo).toString(), group);
  let finish!: (value: unknown) => void, start!: () => void; const started = new Promise<void>(resolve => { start = resolve; });
  host.runWorkflowKitHelper = async (args: string[]) => args[1] === group ? new Promise(resolve => { finish = resolve; start(); }) : { ok: true, status: 'missing' };
  const old = host.refreshWorkflowKit(); await started;
  configuredRoots.set(uri(repo).toString(), other); await host.refreshWorkflowKit();
  finish({ ok: true, status: 'installed', version: 'old', profile: 'repository' }); await old;
  assert.equal(host.workflowKitInstallTarget.root, other); assert.equal(host.workflowKitInstallTarget.state.status, 'missing');
});

test('late project resolution cannot restore a removed workspace folder', async t => {
  const [, repo] = await directories(t); const { host } = fixture([repo]);
  const resolve = host.resolveProjectContext.bind(host); const before = await resolve();
  let finish!: (value: unknown) => void; host.resolveProjectContext = () => new Promise(done => { finish = done; });
  const old = host.refreshWorkflowKit(); host.resolveProjectContext = resolve; vscode.workspace.workspaceFolders = [];
  await host.refreshWorkflowKit(); finish(before); await old;
  assert.equal(host.getSkillsContext().mode, 'unavailable'); assert.equal(host.cloneRoot, undefined);
});

test('installations pin their target and reject duplicate installs and selection changes', async t => {
  const [, repo, other] = await directories(t);
  const { host, calls } = fixture([repo, other]); await selectFolder(host, repo);
  await host.context.workspaceState.update(storageKey, repo);
  const helper = host.runWorkflowKitHelper;
  let finish!: (value: unknown) => void, start!: () => void;
  const started = new Promise<void>(resolve => { start = resolve; });
  host.runWorkflowKitHelper = async (args: string[], timeout?: number, before?: () => Promise<void>) => {
    if (args[0] !== 'install') return helper(args, timeout, before);
    await before?.(); calls.push(args); start(); return new Promise(resolve => { finish = resolve; });
  };
  const operation = host.installWorkflowKit('bundled'); await started;
  await assert.rejects(host.installWorkflowKit('bundled'), /正在進行/);
  await assert.rejects(selectFolder(host, other), /等候/);
  await assert.rejects(host.selectWorkflowKitInstallRoot(), /等候/);
  await assert.rejects(host.resetWorkflowKitInstallRoot(), /等候/);
  finish({ package: 'gitlab-workspace-kit', version: '0.17.0', profile: 'repository' }); await operation;
  assert.equal(calls.filter(args => args[0] === 'install').length, 1);
});

test('remote drift while choosing a package prevents installation', async t => {
  const [, repo] = await directories(t);
  const { host, calls } = fixture([repo]); const getPackage = host.packages.getPackage;
  host.packages.getPackage = async () => {
    execFileSync('git', ['-C', repo, 'remote', 'set-url', 'origin', 'https://different.test/team/service.git']); return getPackage();
  };
  await assert.rejects(host.installWorkflowKit('bundled'), /remote/);
  assert.equal(calls.filter(args => args[0] === 'install').length, 0);
});

test('a container install does not depend on child repository remotes', async t => {
  const [group, repo] = await directories(t); const { host, calls } = fixture([group]);
  const getPackage = host.packages.getPackage;
  host.packages.getPackage = async () => {
    execFileSync('git', ['-C', repo, 'remote', 'set-url', 'origin', 'https://different.test/team/service.git']);
    return getPackage();
  };
  await host.installWorkflowKit('bundled');
  assert.equal(calls.filter(args => args[0] === 'install').length, 1);
  assert.equal(host.workflowKitInstallTarget.state.status, 'installed');
});

test('a target profile changed while choosing a package prevents installation', async t => {
  const [group] = await directories(t); const { host, calls } = fixture([group]);
  const getPackage = host.packages.getPackage;
  host.packages.getPackage = async () => { execFileSync('git', ['init', '--quiet', group]); return getPackage(); };
  await assert.rejects(host.installWorkflowKit('bundled'), /類型已變更/);
  assert.equal(calls.filter(args => args[0] === 'install').length, 0);
});

test('the 18-repository settings and install replay performs only bounded root probes', async t => {
  const [group] = await directories(t);
  for (let index = 2; index < 18; index++) {
    const root = path.join(group, `repo-${index}`); await mkdir(root);
    execFileSync('git', ['init', '--quiet', root]);
    execFileSync('git', ['-C', root, 'remote', 'add', 'origin', project(index + 1, `repo-${index}`).http_url_to_repo]);
  }
  const { host, calls } = fixture([group], true);
  const inspect = host.inspectEnvironmentSnapshot.bind(host);
  host.inspectEnvironmentSnapshot = async () => { throw new Error('Settings/install must not discover child repositories'); };
  host.projectEnvironmentSnapshots = { clear: () => { throw new Error('Settings must not clear environment snapshots'); },
    invalidate: () => { throw new Error('Install must not invalidate remote discovery'); } };
  const lines: string[] = [];
  const log = new OperationLog({ info: line => lines.push(line), warn: line => lines.push(line), error: line => lines.push(line) });
  t.after(() => log.dispose());
  const checkBudget = (rootBudget: number) => {
    assert.equal(lines.filter(line => line.startsWith('[api]')).length, 0);
    assert.equal(lines.filter(line => line.includes('"network":true')).length, 0);
    assert.equal(lines.filter(line => /^\[git\] var started /.test(line)).length, 0);
    const commands = lines.filter(line => /^\[git\] \S+ started /.test(line));
    assert.ok(commands.length <= rootBudget, `expected at most ${rootBudget} root commands, received ${commands.length}`);
    for (const line of commands) {
      const metadata = JSON.parse(line.slice(line.indexOf('{')));
      assert.equal(metadata.repositoryPath, group, 'no child repository commands are needed');
      assert.match(line, /^\[git\] rev-parse started /);
    }
  };
  await log.run('tools', 'settingsReplay', {}, () => host.dispatchMessage({ type: 'refreshWorkflowKit' }));
  checkBudget(1);
  assert.equal(host.workflowKitInstallTarget.profile, 'group');
  assert.equal(host.workspaceMatch.status, 'unverified', 'target classification is not full Skills discovery');
  lines.length = 0;
  await log.run('tools', 'installReplay', {}, () => host.installWorkflowKit('bundled'));
  checkBudget(3);
  assert.equal(calls.filter(args => args[0] === 'install').length, 1);
  assert.equal(host.workflowKitInstallTarget.state.status, 'installed');
  assert.equal(host.getSkillsContext().mode, 'unavailable');
  delete host.projectEnvironmentSnapshots; host.inspectEnvironmentSnapshot = inspect;
  await host.refreshWorkflowKit();
  assert.equal(host.getSkillsContext().mode, 'group');
  assert.equal(host.getSkillsContext().repositories.length, 18, 'Skills entry still performs complete discovery');
  assert.ok(host.getSkillsContext().availableFeatures.includes('query'));
});

test('concurrent target checks coalesce without cancelling full Skills discovery', async t => {
  const [group] = await directories(t); const { host } = fixture([group]);
  let statusReads = 0;
  const helper = host.runWorkflowKitHelper, inspect = host.inspectEnvironmentSnapshot.bind(host);
  host.runWorkflowKitHelper = async (...args: any[]) => {
    statusReads++; await new Promise(resolve => setTimeout(resolve, 20)); return helper(...args);
  };
  await Promise.all(Array.from({ length: 5 }, () => host.refreshWorkflowKitInstallState()));
  assert.equal(statusReads, 1);
  let release!: () => void, enter!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const entered = new Promise<void>(resolve => { enter = resolve; });
  host.inspectEnvironmentSnapshot = async (...args: any[]) => { enter(); await gate; return inspect(...args); };
  const full = host.refreshWorkflowKit(); await entered;
  const generation = host.skillsEnvironmentGeneration;
  await host.refreshWorkflowKitInstallState();
  assert.equal(host.skillsEnvironmentGeneration, generation, 'target checks do not supersede full discovery');
  release(); await full;
  assert.equal(host.workspaceMatch.status, 'matched');
  assert.equal(host.getSkillsContext().repositories.length, 2);
});

test('settings status survives an aborted Skills-owned status refresh', async t => {
  const [group] = await directories(t); const { host, installed } = fixture([group]);
  installed.set(group, 'group');
  const owner = new AbortController(), helper = host.runWorkflowKitHelper;
  let release!: () => void, enter!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const entered = new Promise<void>(resolve => { enter = resolve; });
  let first = true;
  host.runWorkflowKitHelper = async (...args: any[]) => {
    if (first) { first = false; enter(); await gate; }
    return helper(...args);
  };
  t.after(() => { owner.abort(); release(); });
  const full = host.refreshWorkflowKit(true, owner.signal); await entered;
  const settings = host.refreshWorkflowKitInstallState();
  owner.abort(); release(); await Promise.all([full, settings]);
  assert.equal(host.workflowKitInstallTarget.root, group);
  assert.equal(host.workflowKitInstallTarget.state.status, 'installed');
  assert.equal(host.workflowKitInstallTarget.state.profile, 'group');
});

test('an aborted view cannot supersede an already pending settings status', async t => {
  const [group] = await directories(t); const { host, installed } = fixture([group]);
  installed.set(group, 'group');
  const owner = new AbortController(), helper = host.runWorkflowKitHelper;
  let release!: () => void, enter!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const entered = new Promise<void>(resolve => { enter = resolve; });
  host.runWorkflowKitHelper = async (...args: any[]) => { enter(); await gate; return helper(...args); };
  t.after(() => { owner.abort(); release(); });
  const settings = host.refreshWorkflowKitInstallState(); await entered;
  const view = host.refreshWorkflowKitInstallState(true, owner.signal);
  owner.abort(); release(); await Promise.all([settings, view]);
  assert.equal(host.workflowKitInstallTarget.state.status, 'installed');
});

test('a target-only root or profile change cannot retain another Skills mapping', async t => {
  const [group, repo, other] = await directories(t); const { host, installed } = fixture([repo]);
  await host.refreshWorkflowKit();
  assert.equal(host.getSkillsContext().repositories[0].path, repo);
  installed.set(other, 'repository'); configuredRoots.set(uri(repo).toString(), other);
  await host.refreshWorkflowKitInstallState();
  assert.equal(host.workflowKitInstallTarget.root, other);
  assert.equal(host.workflowKitInstallTarget.state.status, 'installed');
  assert.equal(host.workspaceMatch.status, 'unverified');
  assert.deepEqual(host.getSkillsContext().repositories, []);
  assert.deepEqual(host.getSkillsContext().availableFeatures, []);
  configuredRoots.set(uri(repo).toString(), group); await host.refreshWorkflowKit();
  assert.equal(host.getSkillsContext().mode, 'group');
  execFileSync('git', ['init', '--quiet', group]);
  await host.refreshWorkflowKitInstallState();
  assert.equal(host.workflowKitInstallTarget.profile, 'repository');
  assert.equal(host.workspaceMatch.status, 'unverified');
  assert.deepEqual(host.getSkillsContext().repositories, []);
});

test('late target-only status cannot overwrite a newly selected root', async t => {
  const [group, repo, other] = await directories(t); const { host } = fixture([repo]);
  configuredRoots.set(uri(repo).toString(), group);
  let finish!: (value: unknown) => void, enter!: () => void;
  const entered = new Promise<void>(resolve => { enter = resolve; });
  host.runWorkflowKitHelper = async (args: string[]) => args[1] === group
    ? new Promise(resolve => { finish = resolve; enter(); }) : { ok: true, status: 'missing' };
  const old = host.refreshWorkflowKitInstallState(); await entered;
  configuredRoots.set(uri(repo).toString(), other); await host.refreshWorkflowKitInstallState();
  finish({ ok: true, status: 'installed', version: 'old', profile: 'group' }); await old;
  assert.equal(host.workflowKitInstallTarget.root, other);
  assert.equal(host.workflowKitInstallTarget.state.status, 'missing');
});

test('replacing an inspected directory with an alias cannot redirect installation', async t => {
  const [, repo, other] = await directories(t);
  const { host, calls } = fixture([repo]); const getPackage = host.packages.getPackage;
  host.packages.getPackage = async () => {
    await rename(repo, `${repo}-moved`); await symlink(other, repo, process.platform === 'win32' ? 'junction' : 'dir'); return getPackage();
  };
  await assert.rejects(host.installWorkflowKit('bundled'), /工作區|位置/);
  assert.equal(calls.filter(args => args[0] === 'install').length, 0);
});

test('copying rechecks versions and rejects stale context and retired features', async t => {
  const [, repo] = await directories(t);
  const { host, installed } = fixture([repo]); installed.set(repo, 'repository'); await host.refreshWorkflowKit();
  let copied = ''; vscode.env.clipboard.writeText = async text => { copied = text; };
  const request = { type: 'copySkillGuidePrompt', revision: host.getSkillsContext().revision, featureId: 'query', inputs: { 'query.question': 'What does this Repo do?' } };
  await host.copySkillGuidePrompt(request); assert.match(copied, /實際單一 Repo/); assert.equal(copied.includes('實際 Group'), false);
  await assert.rejects(host.copySkillGuidePrompt({ ...request, revision: 'stale' }), /已變更/);
  host.runWorkflowKitHelper = async () => ({ ok: true, status: 'update-available', version: '0.16.0', profile: 'repository', capabilities: ['query'] });
  await host.refreshWorkflowKit(); const revision = host.getSkillsContext().revision;
  await assert.rejects(host.copySkillGuidePrompt({ ...request, revision }), /更新/);
  await assert.rejects(host.copySkillGuidePrompt({ ...request, revision, featureId: 'megin-resume', inputs: { 'megin-resume.workId': 'work-20261011-unknown' } }), /更新|未知|功能/);
});

test('MR branch handoff uses the actual mapped Repo and does not copy or launch Codex', async t => {
  const [group, repo] = await directories(t);
  const { host } = fixture([group], true);
  const target = project(1, 'service');
  host.session.getClient = async () => ({ getMergeRequest: async () => ({ project_id: 1, target_project_id: 1, source_project_id: 1,
    source_branch: 'feature', target_branch: 'main' }) });
  host.navigateTo = async () => undefined;
  let result: any;
  host.post = (message: any) => { if (message.type === 'branchReviewReady') result = message; };
  await host.refreshWorkflowKit();
  await host.openBranchReview(1, 2);
  assert.equal(result.inputs['merge-repo.repo'], repo);
  assert.equal(result.inputs['merge-repo.base'], 'origin/main');
  assert.equal(result.inputs['merge-repo.head'], 'origin/feature');
  host.session.getClient = async () => ({ getMergeRequest: async () => ({ project_id: 1, target_project_id: 1, source_project_id: 2,
    source_branch: 'feature', target_branch: 'main' }) });
  await host.openBranchReview(1, 2);
  assert.equal(result.inputs['merge-repo.repo'], ''); assert.match(result.notice, /fork/);
});

test('concurrent checks coalesce and each Skills page entry rechecks locally without a full Repo scan', async t => {
  const [group] = await directories(t); const { host } = fixture([group], true);
  let reads = 0, packages = 0, resolutions = 0, scans = 0;
  const original = host.runWorkflowKitHelper, listPackages = host.packages.listPackages, resolve = host.resolveProjectContext;
  host.packages.listPackages = async () => { packages++; return listPackages(); };
  host.resolveProjectContext = async () => { resolutions++; return resolve.call(host); };
  host.runWorkflowKitHelper = async (...args: any[]) => { reads++; await new Promise(resolve => setTimeout(resolve, 20)); return original(...args); };
  await Promise.all(Array.from({ length: 5 }, () => host.refreshWorkflowKit()));
  assert.equal(reads, 1); assert.equal(packages, 1); assert.equal(resolutions, 1);
  host.refreshActualRepositoriesNow = async () => { scans++; await new Promise(resolve => setTimeout(resolve, 20)); };
  await Promise.all(Array.from({ length: 5 }, () => host.refreshActualRepositories(group, host.connectedScopeKey())));
  assert.equal(scans, 1);
  host.actualRepositoriesRoot = group; host.actualRepositoryScanStatus = 'ready';
  host.context.globalState = memory(); host.hideIssueGraph = () => undefined;
  for (let count = 0; count < 3; count++) {
    await host.dispatchMessage({ type: 'setMode', mode: 'clone', projectSource: 'local' });
    await host.dispatchMessage({ type: 'setMode', mode: 'sa' });
  }
  assert.equal(scans, 1); assert.equal(reads, 4); assert.equal(packages, 4);
  assert.equal(resolutions, 7, 'each local Repo and Skills entry resolves its current project once');
});

test('Repo refresh retains the current list until replacement and preserves it on failure', async t => {
  const [group, repo, other] = await directories(t); const { host } = fixture([group]);
  await host.refreshWorkflowKit(); host.actualRepositoryScanGeneration = 0;
  const old = [{ name: 'old', path: repo }], replacement = [{ name: 'new', path: other }];
  host.actualRepositoriesRoot = group; host.actualRepositories = old;
  const paths = require('../../src/workspace/workspacePaths') as typeof import('../../src/workspace/workspacePaths');
  const scanner = paths.scanLocalGroupRepositories;
  t.after(() => { paths.scanLocalGroupRepositories = scanner; });
  let release!: (value: any[]) => void;
  paths.scanLocalGroupRepositories = () => new Promise(resolve => { release = resolve; });
  const pending = host.refreshActualRepositories(group, 'offline');
  assert.equal(host.actualRepositoryScanStatus, 'scanning'); assert.equal(host.actualRepositories, old);
  release(replacement); await pending;
  assert.equal(host.actualRepositoryScanStatus, 'ready'); assert.equal(host.actualRepositories, replacement);
  paths.scanLocalGroupRepositories = async () => { throw new Error('temporarily unavailable'); };
  await host.refreshActualRepositories(group, 'offline');
  assert.equal(host.actualRepositoryScanStatus, 'error'); assert.match(host.actualRepositoryScanError, /unavailable/);
  assert.equal(host.actualRepositories, replacement);
  host.groupRoot = other;
  await host.refreshActualRepositories(other, 'offline');
  assert.deepEqual(host.actualRepositories, [], 'a different environment must not retain the previous Repo list');
});


test('shared root drift during Python resolution prevents writes', async t => {
  const [, repo, other] = await directories(t); const { host } = fixture([repo]);
  const check = host.captureWorkflowKitAccess(); resolvingPython = () => { configuredRoots.set(uri(repo).toString(), other); };
  await assert.rejects(WorkspacePanel!.prototype['runWorkflowKitHelper'].call(Object.assign(Object.create(WorkspacePanel!.prototype), host,
    { workflowKitHelper: () => 'unused.py' }), ['inspect'], 1000, check), /已變更/);
});

test('a failing helper process exposes its JSON error instead of the entire command', async t => {
  const [group, repo] = await directories(t);
  const { host } = fixture([repo]);
  const script = path.join(group, 'failed-helper.cjs');
  host.workflowKitHelper = () => script; host.context.extensionUri = uri(repo);
  for (const stream of ['stdout', 'stderr']) {
    await writeFile(script, `process.${stream}.write(JSON.stringify({ok:false,error:"交易驗證失敗"})); process.exitCode=1;`);
    await assert.rejects(WorkspacePanel!.prototype['runWorkflowKitHelper'].call(host, ['status', repo], 1000), (error: Error) => {
      assert.equal(error.message, '交易驗證失敗');
      assert.doesNotMatch(error.message, /Command failed|failed-helper/);
      return true;
    });
  }
});

test('filesystem helpers are serialized and queued requests recheck before launch', async t => {
  const [, repo] = await directories(t); const { host } = fixture([repo]);
  let release!: () => void;
  const waiting = new Promise<void>(resolve => { release = resolve; });
  const order: string[] = [];
  const run = WorkspacePanel!.prototype['runWorkflowKitHelper'].bind(host);
  const first = run(['status'], 1000, async () => { order.push('first'); await waiting; throw new Error('first guard'); });
  const second = run(['status'], 1000, () => { order.push('second'); throw new Error('second guard'); });
  const completed = Promise.all([assert.rejects(first, /first guard/), assert.rejects(second, /second guard/)]);
  await new Promise(resolve => setImmediate(resolve)); assert.deepEqual(order, ['first']);
  release(); await completed; assert.deepEqual(order, ['first', 'second']);
});

test('stale project revisions cannot install into a newly selected root', async t => {
  const [, repo, other] = await directories(t); const { host, calls } = fixture([repo]);
  await host.refreshWorkflowKit(); const revision = host.projectContext.revision;
  configuredRoots.set(uri(repo).toString(), other);
  await assert.rejects(host.dispatchMessage({ type: 'installWorkflowKit', packageId: 'bundled', projectRevision: revision }), /根目錄已變更/);
  assert.equal(calls.some(args => args[0] === 'install'), false);
});

test('root selection locks before asynchronous resolution and blocks downloads until cancellation', async t => {
  const [, repo] = await directories(t); const { host } = fixture([repo], true);
  const resolve = host.resolveProjectContext.bind(host); let release!: () => void;
  const gate = new Promise<void>(done => { release = done; });
  host.resolveProjectContext = async () => { await gate; return resolve(); };
  const selecting = host.selectProjectRoot();
  await assert.rejects(host.selectProjectRoot(), /等候/);
  await assert.rejects(host.clone([1], false), /完成/);
  release(); await selecting; assert.equal(host.workflowKitSelectingRoot, false); assert.equal(updates.length, 0);
});

test('repository operations block installation at the shared root', async t => {
  const [, repo] = await directories(t); const { host, calls } = fixture([repo]); await host.refreshWorkflowKit();
  host.repositoryOperationInProgress = true;
  await assert.rejects(host.installWorkflowKit('bundled'), /等候/);
  assert.equal(calls.some(args => args[0] === 'install'), false);
});

test('a saved workspace keeps root overrides on its folder even before a second folder is added', async t => {
  const [group, repo] = await directories(t); const { host } = fixture([repo]);
  vscode.workspace.workspaceFile = uri(path.join(group, 'projects.code-workspace'));
  vscode.window.showOpenDialog = async () => [uri(group)]; await host.selectProjectRoot();
  assert.equal(updates.at(-1).target, vscode.ConfigurationTarget.WorkspaceFolder);
  assert.equal(updates.at(-1).resource, uri(repo).toString());
});

test('Git action feedback preserves handled failure reasons and tracks readonly selection independently', async t => {
  const [, repo] = await directories(t); const { host } = fixture([repo]); await host.refreshWorkflowKit();
  const messages: any[] = [];
  host.panel = { visible: true, webview: { postMessage: (message: unknown) => { messages.push(message); return Promise.resolve(true); } } };
  host.webviewReady = true; host.post = (WorkspacePanel.prototype as any).post;
  host.dispatchMessage = async (request: any) => { host.post({ type: 'gitActionResult', requestId: request.requestId, error: 'branch is protected' }); };
  const scope = host.getLocalOperationScope();
  await host.handleMessage({ type: 'gitAction', requestId: 'git-write', operationId: 'write', operationScope: scope, repoId: 'repo', action: { type: 'push', remote: 'origin', branch: 'main' } });
  const receipt = messages.filter(message => message.type === 'operationChanged').at(-1).operation;
  assert.equal(receipt.status, 'failed'); assert.equal(receipt.phase, '處理失敗'); assert.equal(receipt.error, 'branch is protected');
  const before = messages.filter(message => message.type === 'operationChanged').length;
  await host.handleMessage({ type: 'gitAction', requestId: 'git-read', operationId: 'read', operationScope: scope, repoId: 'repo', action: { type: 'readCommit', hash: 'a'.repeat(40) } });
  const readReceipts = messages.filter(message => message.type === 'operationChanged').slice(before);
  assert.equal(readReceipts.at(-1).operation.requestId, 'read');
  assert.equal(readReceipts.at(-1).operation.status, 'failed');
  assert.equal(readReceipts.at(-1).operation.kind, 'read');
});
