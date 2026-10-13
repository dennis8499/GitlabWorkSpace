import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, realpath, rename, rm, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const storageKey = 'gitlabWorkspace.workflowKit.installRoot';
const skillsStorageKey = 'gitlabWorkspace.skills.repositoryRoot';
const uri = (fsPath: string) => ({ scheme: 'file', fsPath });
let preferGroup: boolean | undefined;
let resolvingPython: (() => void) | undefined;
const updates: any[] = [];
const terminals: any[] = [];
const vscode = {
  workspace: {
    workspaceFolders: [] as Array<{ uri: ReturnType<typeof uri> }>,
    getConfiguration: () => ({ get: (key: string, fallback: unknown) => key === 'workflowKit.requireGroupEnvironment' ? preferGroup ?? fallback : fallback,
      update: async (key: string, value: boolean, target: number) => { updates.push({ key, value, target }); preferGroup = value; } })
  },
  ConfigurationTarget: { Global: 1, Workspace: 2 },
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

function fixture(folders: string[], connected = false, workspaceState = memory()) {
  preferGroup = undefined; updates.length = 0; resolvingPython = undefined;
  vscode.workspace.workspaceFolders = folders.map(root => ({ uri: uri(root) }));
  vscode.window.showQuickPick = async () => undefined;
  vscode.window.showOpenDialog = async () => undefined;
  vscode.env.openExternal = async () => true;
  const installed = new Map<string, 'group' | 'repository'>();
  const calls: string[][] = [];
  const bundle = { id: 'bundled', archivePath: 'offline.tar.xz', version: '0.17.0', source: 'bundled', format: 'tar.xz', entryRoot: 'workflow-kit', sha256: 'a'.repeat(64) };
  const host: any = Object.assign(Object.create(WorkspacePanel!.prototype), {
    disposed: false, workspaceFoldersGeneration: 0, skillsEnvironmentGeneration: 0, workflowKitRefreshGeneration: 0,
    workspaceMatch: { status: 'checking', repositories: [] }, projects: connected ? [project(1, 'service'), project(2, 'docs')] : [],
    workspaceSections: { projects: { status: connected ? 'ready' : 'idle' } },
    loadedScopeKey: connected ? 'https://gitlab.test|1|1' : undefined,
    workflowKitStatusReads: new Map(), workflowKitState: { status: 'missing' }, autoHookRefreshGeneration: 0,
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
      if (args[0] === 'autohook') return { ok: true, root: args[2], status: 'disabled', supported: process.platform === 'win32', enabled: false, bundledVersion: '1.1.0' };
      if (args[0] === 'install') {
        const profile = args[args.indexOf('--profile') + 1] as 'group' | 'repository';
        installed.set(args[2], profile);
        return { ok: true, package: 'gitlab-workspace-kit', version: bundle.version, profile };
      }
      return installed.has(args[1]) ? { ok: true, status: 'installed', version: bundle.version, profile: installed.get(args[1]), capabilities: ['query', 'megin-resume'] }
        : { ok: true, status: 'missing' };
    }
  });
  return { host, installed, calls, workspaceState };
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

test('the default auto setting installs native Repo Skills offline and allows downloads', async t => {
  const [, repo] = await directories(t);
  const { host, calls } = fixture([repo]);
  await host.refreshWorkflowKit();
  assert.equal(host.getWorkflowKitPolicy().requireGroupEnvironment, true);
  assert.equal(host.getWorkflowKitPolicy().mode, 'repository');
  assert.equal(host.workflowKitInstallTarget.root, repo);
  await host.openWorkflowKitDownload('github'); await host.installWorkflowKit('bundled');
  assert.equal(calls.find(args => args[0] === 'install')?.at(-1), 'repository');
  assert.equal(host.getSkillsContext().installed.profile, 'repository');
  assert.equal(host.groupRoot, undefined);
});

test('Git API opened Repos participate even when they are not workspace folders', async t => {
  const [, repo, other] = await directories(t);
  const { host } = fixture([repo], true);
  execFileSync('git', ['-C', other, 'remote', 'set-url', 'origin', 'https://other-host.test/team/docs.git']);
  host.gitRepositories = { getInventory: async () => [{ path: other }] };
  await host.refreshWorkflowKit();
  assert.equal(host.workspaceMatch.status, 'mismatched');
  assert.equal(host.workspaceMatch.repositories.length, 2);
  assert.equal(host.getSkillsContext().mode, 'unavailable', 'multiple native candidates require a selection');
});

test('a new Group cannot reuse the previous Groups loaded project list', async t => {
  const [group] = await directories(t);
  const { host, installed } = fixture([group], true);
  installed.set(group, 'group'); await host.refreshWorkflowKit();
  assert.equal(host.getSkillsContext().mode, 'group');
  host.session.selectedGroup = { id: 2 };
  assert.notEqual(host.getSkillsContext().mode, 'group', 'even the immediate snapshot cannot expose stale Group features');
  await host.refreshWorkflowKit();
  assert.equal(host.workspaceMatch.status, 'unverified'); assert.equal(host.groupRoot, undefined);
});

test('Codex launches from the selected verified Repo and rejects a stale context', async t => {
  const [, repo, other] = await directories(t);
  const { host, installed } = fixture([repo, other]);
  installed.set(repo, 'repository'); installed.set(other, 'repository');
  await host.selectSkillsRepository(repo);
  const context = host.getSkillsContext();
  terminals.length = 0;
  await host.openCodexTerminal(context.revision);
  assert.equal(terminals[0].cwd, repo);
  await host.selectSkillsRepository(other);
  await assert.rejects(host.openCodexTerminal(context.revision), /啟動位置/);
  assert.equal(terminals.length, 1, 'no terminal opens for a stale selection');
});

test('empty windows can download and install into a chosen external folder without enabling Skills', async t => {
  const [, repo] = await directories(t);
  const { host, calls } = fixture([]);
  await host.refreshWorkflowKit(); await host.openWorkflowKitDownload('gitea');
  await assert.rejects(host.installWorkflowKit('bundled'), /選擇/);
  await assert.rejects(host.selectSkillsRepository(repo), /目前 VS Code/);
  assert.equal(calls.length, 0);
  vscode.window.showOpenDialog = async options => {
    assert.equal((options as any).canSelectFolders, true); assert.equal((options as any).canSelectFiles, false);
    return [uri(repo)];
  };
  await host.selectWorkflowKitInstallRoot(); await host.installWorkflowKit('bundled');
  assert.equal(host.workflowKitInstallTarget.root, repo);
  assert.equal(host.workflowKitInstallTarget.state.profile, 'repository');
  assert.equal(host.getSkillsContext().mode, 'unavailable');
});

test('Repo selection persists in the workspace and cancellation preserves it', async t => {
  const [, repo, other] = await directories(t);
  const { host, workspaceState } = fixture([repo, other]);
  await host.refreshWorkflowKit(); assert.equal(host.workflowKitInstallTarget.root, undefined);
  await host.selectSkillsRepository(other);
  assert.equal(workspaceState.get(skillsStorageKey), other);
  assert.equal(workspaceState.get(storageKey), undefined, 'Skills selection does not change the installation folder');
  vscode.window.showOpenDialog = async () => [uri(other)];
  await host.selectWorkflowKitInstallRoot(); assert.equal(workspaceState.get(storageKey), other);
  const reopened = fixture([repo, other], false, workspaceState).host;
  await reopened.refreshWorkflowKit(); await reopened.selectWorkflowKitInstallRoot();
  assert.equal(reopened.workflowKitInstallTarget.root, other);
  await reopened.resetWorkflowKitInstallRoot();
  assert.equal(reopened.workflowKitInstallTarget.root, undefined); assert.equal(workspaceState.get(storageKey), undefined);
  assert.equal(reopened.getSkillsContext().root, other, 'reset only affects installation');
});

test('legacy Repo selection migrates once and changing installation never changes native Skills or its verified state', async t => {
  const [group, repo, other] = await directories(t);
  const workspaceState = memory(); await workspaceState.update(storageKey, repo);
  const { host, installed } = fixture([repo, other], false, workspaceState);
  installed.set(repo, 'repository'); installed.set(group, 'group');
  await host.refreshWorkflowKit();
  assert.equal(workspaceState.get(skillsStorageKey), repo);
  const before = host.getSkillsContext();
  vscode.window.showOpenDialog = async () => [uri(group)]; await host.selectWorkflowKitInstallRoot();
  assert.equal(host.workflowKitInstallTarget.state.profile, 'group');
  assert.equal(host.getSkillsContext().root, repo); assert.equal(host.getSkillsContext().installed.profile, 'repository');
  assert.equal(host.getSkillsContext().revision, before.revision);
  installed.delete(repo); await host.refreshWorkflowKit();
  assert.equal(host.workflowKitInstallTarget.state.status, 'installed');
  assert.equal(host.getSkillsContext().installed.status, 'missing');
  assert.deepEqual(host.getSkillsContext().availableFeatures, []);
});

test('resetting installation before the first refresh preserves the legacy Skills Repo preference', async t => {
  const [, repo, other] = await directories(t);
  const workspaceState = memory(); await workspaceState.update(storageKey, other);
  const { host } = fixture([repo, other], false, workspaceState);
  await host.resetWorkflowKitInstallRoot();
  assert.equal(workspaceState.get(storageKey), undefined); assert.equal(workspaceState.get(skillsStorageKey), other);
  assert.equal(host.getSkillsContext().root, other); assert.equal(host.workflowKitInstallTarget.root, undefined);
});

test('Group mode allows another installation folder while Skills keeps using the verified Group root', async t => {
  const [group, repo] = await directories(t);
  const { host, installed, calls } = fixture([group], true); installed.set(group, 'group');
  await host.refreshWorkflowKit(); const before = host.getSkillsContext();
  vscode.window.showOpenDialog = async () => [uri(repo)]; await host.selectWorkflowKitInstallRoot();
  assert.equal(host.workflowKitInstallTarget.root, repo); assert.equal(host.workflowKitInstallTarget.profile, 'repository');
  assert.equal(host.getSkillsContext().root, group); assert.equal(host.getSkillsContext().revision, before.revision);
  await host.installWorkflowKit('bundled'); assert.equal(calls.find(args => args[0] === 'install')?.at(-1), 'repository');
  await host.resetWorkflowKitInstallRoot(); assert.equal(host.workflowKitInstallTarget.root, group);
  assert.equal(host.getSkillsContext().root, group);
});

test('the installation default is the opened folder even when Skills automatically uses its parent Group', async t => {
  const [group, repo] = await directories(t); const { host } = fixture([repo], true);
  await host.refreshWorkflowKit();
  assert.equal(host.getSkillsContext().root, group);
  assert.equal(host.workflowKitInstallTarget.root, repo); assert.equal(host.workflowKitInstallTarget.profile, 'repository');
});

test('ordinary folders can install the Group profile offline and Repo subdirectories are rejected', async t => {
  const [group, repo] = await directories(t); const { host, calls } = fixture([group]);
  await host.refreshWorkflowKit(); await host.installWorkflowKit('bundled');
  assert.equal(calls.find(args => args[0] === 'install')?.at(-1), 'group');
  const child = path.join(repo, 'src'); await mkdir(child);
  vscode.window.showOpenDialog = async () => [uri(child)];
  await assert.rejects(host.selectWorkflowKitInstallRoot(), /Git 根目錄/);
  assert.equal(host.workflowKitInstallTarget.root, group);
  vscode.window.showOpenDialog = async () => [{ scheme: 'vscode-remote', fsPath: child }];
  await assert.rejects(host.selectWorkflowKitInstallRoot(), /本機/);
});

test('deleted installation folders stay visible as invalid targets without falling back or changing Skills', async t => {
  const [group, repo] = await directories(t); const workspaceState = memory();
  const missing = path.join(group, 'removed'); await workspaceState.update(storageKey, missing);
  const { host, calls } = fixture([repo], false, workspaceState);
  await host.refreshWorkflowKit();
  assert.equal(host.workflowKitInstallTarget.root, missing); assert.match(host.workflowKitInstallTarget.error, /不存在|讀取/);
  assert.equal(host.getSkillsContext().root, repo);
  await assert.rejects(host.installWorkflowKit('bundled'), /不存在|讀取/);
  assert.equal(calls.filter(args => args[0] === 'install').length, 0);
});

test('matched Group selects its profile; disabling the setting pins a Repo', async t => {
  const [group, repo, other] = await directories(t);
  const { host, calls } = fixture([group], true);
  await host.refreshWorkflowKit();
  assert.equal(host.groupRoot, group); assert.equal(host.workflowKitInstallTarget.root, group);
  assert.equal(host.getWorkflowKitPolicy().mode, 'group');
  await assert.rejects(host.selectSkillsRepository(repo), /Group/);
  await host.installWorkflowKit('bundled');
  assert.equal(calls.find(args => args[0] === 'install')?.at(-1), 'group');
  await host.setWorkflowKitRequireGroup(false); await host.selectSkillsRepository(other);
  assert.equal(host.getSkillsContext().mode, 'repository'); assert.equal(host.getSkillsContext().root, other);
  assert.equal(updates.at(-1).target, 2);
  await assert.rejects(host.assertWorkflowKitReady(), /單 Repo/);
});

test('installation in another Repo never enables Skills for the selected Repo', async t => {
  const [, repo, other] = await directories(t);
  const { host, installed } = fixture([repo, other]); installed.set(other, 'repository');
  await host.selectSkillsRepository(repo);
  assert.equal(host.getSkillsContext().installed.status, 'missing');
  assert.deepEqual(host.getSkillsContext().availableFeatures, []);
});

test('late status reads cannot overwrite a new installation folder', async t => {
  const [group, repo, other] = await directories(t);
  const { host, workspaceState } = fixture([repo]); await workspaceState.update(storageKey, group);
  let finish!: (value: unknown) => void, start!: () => void;
  const started = new Promise<void>(resolve => { start = resolve; });
  host.runWorkflowKitHelper = async (args: string[]) => args[1] === group ? new Promise(resolve => { finish = resolve; start(); }) : { ok: true, status: 'missing' };
  const old = host.refreshWorkflowKit(); await started;
  await workspaceState.update(storageKey, other); await host.refreshWorkflowKit();
  finish({ ok: true, status: 'installed', version: 'old', profile: 'repository' }); await old;
  assert.equal(host.workflowKitInstallTarget.root, other); assert.equal(host.workflowKitInstallTarget.state.status, 'missing');
});

test('late environment inspection cannot restore a previous target', async t => {
  const [, repo] = await directories(t);
  const { host } = fixture([repo]); const inspect = host.inspectEnvironment.bind(host); const before = await inspect();
  let finish!: (value: unknown) => void;
  host.inspectEnvironment = () => new Promise(resolve => { finish = resolve; });
  const old = host.refreshWorkflowKit(); host.workspaceFoldersGeneration++; host.inspectEnvironment = inspect;
  vscode.workspace.workspaceFolders = [];
  await host.refreshWorkflowKit(); finish(before); await old;
  assert.equal(host.getSkillsContext().mode, 'unavailable');
});

test('installations pin their target and reject duplicate installs and selection changes', async t => {
  const [, repo, other] = await directories(t);
  const { host, calls } = fixture([repo, other]); await host.selectSkillsRepository(repo);
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
  await assert.rejects(host.selectSkillsRepository(other), /等候/);
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

test('MR tasks and delivery evidence use verified remotes instead of canonical folder names', async t => {
  const [group, repo] = await directories(t);
  const { host } = fixture([group], true);
  host.runWorkflowKitHelper = async () => ({ ok: true, status: 'installed', version: '0.17.0', profile: 'group', capabilities: ['merge-mr'] });
  const target = project(1, 'service');
  host.session.getClient = async () => ({ getProject: async () => target });
  host.liveReviewIdentity = async () => ({ identity: { origin: 'https://gitlab.test', projectId: 1, mrIid: 2,
    targetProjectId: 1, sourceProjectId: 1, sourceSha: 'a'.repeat(40), targetSha: 'b'.repeat(40), sourceBranch: 'feature', targetBranch: 'main' },
    request: { web_url: `${target.web_url}/-/merge_requests/2`, source_branch: 'feature', target_branch: 'main' } });
  host.openCodexTerminal = async () => undefined;
  let copied = ''; vscode.env.clipboard.writeText = async text => { copied = text; };
  await host.openMergeReviewTask(1, 2);
  assert.ok(copied.includes(repo), 'the MR task must use the renamed actual Git root');
  const encodedTask = copied.match(/--mr-context-base64 "([A-Za-z0-9+/=]+)"/)?.[1];
  assert.ok(encodedTask);
  const task = JSON.parse(Buffer.from(encodedTask, 'base64').toString('utf8'));
  assert.equal(task.schema, 'MergeReviewTask/v2'); assert.equal(task.groupRoot, group);
  const handoff = { group_root: group, gitlab: { origin: 'https://gitlab.test' }, state: 'complete', repositories: [{
    gitlab_project_id: 1, gitlab_namespace: target.path_with_namespace, repo_path: path.basename(repo), remote_url: target.http_url_to_repo
  }] };
  await host.validateWorkspaceHandoff(handoff);
  await assert.rejects(host.validateWorkspaceHandoff({ ...handoff, repositories: [{ ...handoff.repositories[0], repo_path: 'docs' }] }), /無法唯一對應/);
});

test('Group quick review opens with the actual current kit and rechecks its verified capability', async t => {
  const [group] = await directories(t);
  const root = path.resolve(__dirname, '../../..');
  const installer = path.join(root, 'resources/workflow-kit-installer.py');
  const archive = path.join(root, 'resources/offline-tools/workflow-kit.tar.xz');
  const index = JSON.parse(await readFile(path.join(root, 'resources/offline-tools/manifest.json'), 'utf8'));
  const execute = (args: string[]) => JSON.parse(execFileSync(process.execPath,
    [path.join(root, 'scripts/run-python.mjs'), installer, ...args], { cwd: root, encoding: 'utf8', windowsHide: true }));
  const installed = execute(['install', archive, group, index.version, 'bundled', '--format', 'tar.xz',
    '--entry-root', 'workflow-kit', '--archive-sha256', index.archiveSha256]);
  assert.equal(installed.version, index.version);
  assert.equal((await readFile(path.join(group, '.agents/skills/merge-reviewer/scripts/git_review_context.py'), 'utf8'))
    .includes('--mr-context-base64'), false, 'current native core registers MR arguments through the Workspace adapter');
  const { host } = fixture([group], true);
  host.context.extension.packageJSON.version = index.version;
  let statusReads = 0, omitCapability = false, invalidateOnConfirmation = false;
  host.runWorkflowKitHelper = async (args: string[], _timeout?: number, before?: () => Promise<void>) => {
    await before?.();
    if (args[0] === 'autohook') return { ok: true, root: group, status: 'disabled', enabled: false };
    const state = execute(args);
    if (args[0] === 'status') {
      statusReads++;
      if (omitCapability || invalidateOnConfirmation && statusReads > 2) state.capabilities = state.capabilities.filter((id: string) => id !== 'merge-group');
    }
    return state;
  };
  let copied = '', opened = 0;
  vscode.env.clipboard.writeText = async text => { copied = text; };
  host.openCodexTerminal = async () => { opened++; };
  await host.openGroupQuickReview();
  assert.match(copied, /git_review_context\.py --group-root.*--quick/);
  assert.equal(opened, 1);
  assert.ok(host.getSkillsContext().availableFeatures.includes('merge-group'));

  copied = ''; statusReads = 0; omitCapability = true;
  await assert.rejects(host.openGroupQuickReview(), /Skills 環境或版本已變更/);
  assert.equal(copied, ''); assert.equal(opened, 1);

  statusReads = 0; omitCapability = false; invalidateOnConfirmation = true;
  await assert.rejects(host.openGroupQuickReview(), /Skills 環境或版本已變更/);
  assert.equal(copied, ''); assert.equal(opened, 1, 'capability drift must stop before copying or opening Codex');
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
    if (drift) preferGroup = false;
    return { iid: 2, web_url: 'https://gitlab.test/team/service/-/issues/2' };
  } });
  vscode.env.clipboard.writeText = async text => { copied = text; };
  await host.copyWikiUpdatePrompt(record.id);
  assert.ok(copied.includes(group));
  copied = ''; drift = true;
  await assert.rejects(host.copyWikiUpdatePrompt(record.id), /Skills 環境或版本已變更/);
  assert.equal(copied, '', 'stale delivery evidence must not reach the clipboard');
});

test('configuration retains its scope and drift during Python resolution prevents writes', async t => {
  const [, repo] = await directories(t); const { host } = fixture([repo]);
  await host.setWorkflowKitRequireGroup(false); assert.equal(updates.at(-1).target, 2);
  vscode.workspace.workspaceFolders = []; await host.setWorkflowKitRequireGroup(true); assert.equal(updates.at(-1).target, 1);
  const check = host.captureWorkflowKitAccess(); resolvingPython = () => { preferGroup = false; };
  await assert.rejects(WorkspacePanel!.prototype['runWorkflowKitHelper'].call({ ...host, workflowKitHelper: () => 'unused.py' }, ['inspect'], 1000, check), /已變更/);
});

test('AutoHook follows the Skills root independently of the installation target', async t => {
  const [group, repo] = await directories(t);
  const { host, installed, calls } = fixture([group], true); installed.set(group, 'group');
  await host.refreshWorkflowKit();
  vscode.window.showOpenDialog = async () => [uri(repo)]; await host.selectWorkflowKitInstallRoot();
  assert.equal(host.autoHookState.root, group); assert.equal(host.workflowKitInstallTarget.root, repo);
  await host.manageAutoHook('disable', host.getSkillsContext().revision);
  assert.deepEqual(calls.find(args => args[0] === 'autohook' && args[1] === 'disable'), ['autohook', 'disable', group]);
  await assert.rejects(host.manageAutoHook('enable', 'expired'), /已變更/);
});

test('AutoHook rejects duplicate clicks and selection changes while an operation runs', async t => {
  const [, repo, other] = await directories(t);
  const { host, installed, calls } = fixture([repo, other]); installed.set(repo, 'repository');
  await host.selectSkillsRepository(repo);
  const helper = host.runWorkflowKitHelper;
  let finish!: (value: unknown) => void, start!: () => void;
  const started = new Promise<void>(resolve => { start = resolve; });
  host.runWorkflowKitHelper = async (args: string[], timeout?: number, before?: () => Promise<void>) => {
    if (args[0] !== 'autohook' || args[1] === 'status') return helper(args, timeout, before);
    await before?.(); calls.push(args); start(); return new Promise(resolve => { finish = resolve; });
  };
  const operation = host.manageAutoHook('disable', host.getSkillsContext().revision); await started;
  assert.equal(host.workflowKitSettingBusy, true);
  await assert.rejects(host.manageAutoHook('disable', host.getSkillsContext().revision), /等候/);
  await assert.rejects(host.selectSkillsRepository(other), /等候/);
  await assert.rejects(host.installWorkflowKit('bundled'), /正在進行/);
  finish({ ok: true, enabled: false }); await operation;
  assert.equal(calls.filter(args => args[0] === 'autohook' && args[1] === 'disable').length, 1);
  assert.equal(host.workflowKitSettingBusy, false);
});

test('AutoHook checks Repo identity again immediately before launching Python', async t => {
  const [, repo] = await directories(t);
  const { host, installed, calls } = fixture([repo]); installed.set(repo, 'repository'); await host.refreshWorkflowKit();
  const helper = host.runWorkflowKitHelper;
  host.runWorkflowKitHelper = async (args: string[], timeout?: number, before?: () => Promise<void>) => {
    if (args[0] !== 'autohook' || args[1] === 'status') return helper(args, timeout, before);
    execFileSync('git', ['-C', repo, 'remote', 'set-url', 'origin', 'https://changed.test/team/service.git']);
    await before?.(); throw new Error('must not launch');
  };
  await assert.rejects(host.manageAutoHook('disable', host.getSkillsContext().revision), /Repo 已變更/);
  assert.equal(calls.filter(args => args[0] === 'autohook' && args[1] !== 'status').length, 0);
});

test('late AutoHook status cannot replace a new Skills root or a newer refresh', async t => {
  const [, repo, other] = await directories(t);
  const { host, installed } = fixture([repo, other]); installed.set(repo, 'repository'); installed.set(other, 'repository');
  await host.selectSkillsRepository(repo);
  const helper = host.runWorkflowKitHelper;
  let finish!: (value: unknown) => void;
  host.runWorkflowKitHelper = (args: string[], ...rest: unknown[]) => args[0] === 'autohook' && args[2] === repo
    ? new Promise(resolve => { finish = resolve; }) : helper(args, ...rest);
  const old = host.refreshAutoHook();
  await host.selectSkillsRepository(other);
  finish({ ok: true, root: repo, status: 'enabled', enabled: true, supported: true }); await old;
  assert.equal(host.autoHookState.root, other); assert.equal(host.autoHookState.enabled, false);
  // Same-root responses can be stale too.
  host.runWorkflowKitHelper = () => new Promise(resolve => { finish = resolve; });
  const pending = host.refreshAutoHook(); host.runWorkflowKitHelper = helper; await host.refreshAutoHook();
  finish({ ok: true, root: other, status: 'enabled', enabled: true, supported: true }); await pending;
  assert.equal(host.autoHookState.enabled, false);
});

test('AutoHook status errors retain emergency disable state but do not carry it to another root', async t => {
  const [, repo, other] = await directories(t);
  const { host } = fixture([repo, other]); await host.selectSkillsRepository(repo);
  host.autoHookState = { root: repo, status: 'enabled', enabled: true, stateKnown: true, supported: true };
  let reject!: (error: Error) => void;
  const helper = host.runWorkflowKitHelper;
  host.runWorkflowKitHelper = () => new Promise((_resolve, failure) => { reject = failure; });
  const pending = host.refreshAutoHook();
  assert.equal(host.autoHookState.status, 'checking'); assert.equal(host.autoHookState.enabled, true);
  reject(new Error('status unavailable')); await pending;
  assert.equal(host.autoHookState.enabled, true); assert.equal(host.autoHookState.stateKnown, false);
  assert.equal(host.autoHookState.status, 'error'); assert.match(host.autoHookState.message, /status unavailable/);
  host.runWorkflowKitHelper = async (args: string[], ...rest: unknown[]) => {
    if (args[0] === 'autohook') throw new Error('new root unavailable');
    return helper(args, ...rest);
  };
  await host.selectSkillsRepository(other);
  assert.equal(host.autoHookState.root, other); assert.equal(host.autoHookState.enabled, false);
  assert.equal(host.autoHookState.stateKnown, false);
});

test('AutoHook re-reads actual state after a failed operation and rejects malformed status', async t => {
  const [, repo] = await directories(t); const { host } = fixture([repo]); await host.refreshWorkflowKit();
  host.autoHookState = { root: repo, status: 'enabled', enabled: true, stateKnown: true, supported: true };
  const helper = host.runWorkflowKitHelper; let statuses = 0;
  host.runWorkflowKitHelper = async (args: string[], ...rest: unknown[]) => {
    if (args[0] !== 'autohook') return helper(args, ...rest);
    if (args[1] !== 'status') throw new Error('disable failed');
    statuses++; return { root: repo, status: 'needs-revalidation', enabled: true, supported: true };
  };
  await assert.rejects(host.manageAutoHook('disable', host.getSkillsContext().revision), /disable failed/);
  assert.equal(statuses, 1); assert.equal(host.workflowKitSettingBusy, false);
  assert.equal(host.autoHookState.enabled, true); assert.equal(host.autoHookState.status, 'needs-revalidation');
  host.runWorkflowKitHelper = async () => ({ root: repo, status: 'disabled' });
  await host.refreshAutoHook();
  assert.equal(host.autoHookState.status, 'error'); assert.equal(host.autoHookState.stateKnown, false);
  assert.equal(host.autoHookState.enabled, true);
});

test('filesystem helpers are serialized and queued requests recheck before launch', async t => {
  const [, repo] = await directories(t); const { host } = fixture([repo]);
  let release!: () => void;
  const waiting = new Promise<void>(resolve => { release = resolve; });
  const order: string[] = [];
  const run = WorkspacePanel!.prototype['runWorkflowKitHelper'].bind(host);
  const first = run(['status'], 1000, async () => { order.push('first'); await waiting; throw new Error('first guard'); });
  const second = run(['autohook'], 1000, () => { order.push('second'); throw new Error('second guard'); });
  const completed = Promise.all([assert.rejects(first, /first guard/), assert.rejects(second, /second guard/)]);
  await new Promise(resolve => setImmediate(resolve)); assert.deepEqual(order, ['first']);
  release(); await completed; assert.deepEqual(order, ['first', 'second']);
});

test('AutoHook blocks enable on non-Windows and confirms trust instructions on Windows', async t => {
  const [, repo] = await directories(t); const { host, installed } = fixture([repo]); installed.set(repo, 'repository');
  await host.refreshWorkflowKit(); const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
  t.after(() => Object.defineProperty(process, 'platform', platform));
  Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
  await assert.rejects(host.manageAutoHook('enable', host.getSkillsContext().revision), /Windows/);
  Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
  const messages: any[] = []; host.post = (message: unknown) => messages.push(message);
  await host.manageAutoHook('enable', host.getSkillsContext().revision);
  assert.match(messages.at(-1).message, /重新開啟 Codex.*\/hooks.*信任/);
});
