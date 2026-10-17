import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

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
    disposed: false, workspaceFoldersGeneration: 0, skillsEnvironmentGeneration: 0, workflowKitRefreshGeneration: 0,
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
    context: { workspaceState, extension: { packageJSON: { version: bundle.version } } },
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
  await host.selectProjectFolder(uri(root).toString()); await host.refreshWorkflowKit();
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

test('replacing an inspected directory with an alias cannot redirect installation', async t => {
  const [, repo, other] = await directories(t);
  const { host, calls } = fixture([repo]); const getPackage = host.packages.getPackage;
  host.packages.getPackage = async () => {
    await rename(repo, `${repo}-moved`); await symlink(other, repo, process.platform === 'win32' ? 'junction' : 'dir'); return getPackage();
  };
  await assert.rejects(host.installWorkflowKit('bundled'), /工作區|位置/);
  assert.equal(calls.filter(args => args[0] === 'install').length, 0);
});

test('copying rechecks versions and rejects stale context and unknown old Work IDs', async t => {
  const [, repo] = await directories(t);
  const { host, installed } = fixture([repo]); installed.set(repo, 'repository'); await host.refreshWorkflowKit();
  let copied = ''; vscode.env.clipboard.writeText = async text => { copied = text; };
  const request = { type: 'copySkillGuidePrompt', revision: host.getSkillsContext().revision, featureId: 'query', inputs: { 'query.question': 'What does this Repo do?' } };
  await host.copySkillGuidePrompt(request); assert.match(copied, /實際單一 Repo/); assert.equal(copied.includes('實際 Group'), false);
  await assert.rejects(host.copySkillGuidePrompt({ ...request, revision: 'stale' }), /已變更/);
  host.runWorkflowKitHelper = async () => ({ ok: true, status: 'work-in-progress', version: '0.16.0', profile: 'repository', capabilities: ['query', 'megin-resume'], activeWorkIds: ['work-20261011-existing'] });
  await host.refreshWorkflowKit(); const revision = host.getSkillsContext().revision;
  await assert.rejects(host.copySkillGuidePrompt({ ...request, revision }), /舊版/);
  await assert.rejects(host.copySkillGuidePrompt({ ...request, revision, featureId: 'megin-resume', inputs: { 'megin-resume.workId': 'work-20261011-unknown' } }), /既有 Work ID/);
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
  const handoff = { group_root: group, gitlab: { origin: 'https://gitlab.test' }, state: 'complete', repositories: [{
    gitlab_project_id: 1, gitlab_namespace: target.path_with_namespace, repo_path: path.basename(repo), remote_url: target.http_url_to_repo
  }] };
  await host.validateWorkspaceHandoff(handoff);
  await assert.rejects(host.validateWorkspaceHandoff({ ...handoff, repositories: [{ ...handoff.repositories[0], repo_path: 'docs' }] }), /無法唯一對應/);
});

test('concurrent Skills and Repo checks run once and warm Analysis navigation adds no full scans', async t => {
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
    await host.dispatchMessage({ type: 'setMode', mode: 'clone' });
    await host.dispatchMessage({ type: 'setMode', mode: 'sa' });
  }
  assert.equal(scans, 1); assert.equal(reads, 1); assert.equal(packages, 1); assert.equal(resolutions, 1);
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

test('post-delivery Wiki copying rejects a context change during Issue reads', async t => {
  const [group] = await directories(t);
  const { host } = fixture([group], true);
  host.runWorkflowKitHelper = async () => ({ ok: true, status: 'installed', version: '0.17.0', profile: 'group', capabilities: ['ingest'] });
  const record = { id: 'delivery', workId: 'work-existing', handoffSha256: 'handoff', instanceScope: 'scope',
    state: 'committed', repoPath: 'renamed-service', changes: 'change', tests: 'passed' };
  host.requireDelivery = async () => record;
  host.deliveryRecords = () => [record];
  host.runMeginHandoff = async () => ({ state: 'complete', work_id: record.workId, plan_version: 'plan-v1',
    acceptance: { version: 'acceptance-v1' }, handoff_sha256: record.handoffSha256,
    gitlab: { issue_project_id: 1, issue_iid: 2 }, checks: [],
    repositories: [{ repo_path: record.repoPath, gitlab_project_id: 1, staged: { staged_paths: ['src/main.ts'] } }],
    delivery: { completion_ok: true, repositories: [{ repo_path: record.repoPath, feature_commit: 'a'.repeat(40) }] } });
  host.validateWorkspaceHandoff = async () => undefined;
  let drift = false, copied = '';
  host.session.getClient = async () => ({ getIssue: async () => {
    if (drift) configuredRoots.set(uri(group).toString(), path.join(group, 'docs'));
    return { iid: 2, web_url: 'https://gitlab.test/team/service/-/issues/2' };
  } });
  vscode.env.clipboard.writeText = async text => { copied = text; };
  await host.copyWikiUpdatePrompt(record.id);
  assert.ok(copied.includes(group));
  copied = ''; drift = true;
  await assert.rejects(host.copyWikiUpdatePrompt(record.id), /Skills 環境或版本已變更/);
  assert.equal(copied, '', 'stale delivery evidence must not reach the clipboard');
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
  const scope = host.operationScope();
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
