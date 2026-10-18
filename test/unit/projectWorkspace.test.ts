import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, realpath, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import * as cloneService from '../../src/git/cloneService';

const uri = (fsPath: string) => ({ scheme: 'file', fsPath, toString: () => 'file:' + fsPath });
const roots = new Map<string, string>();
const operations: Array<{ action: string; root: string; ids: number[] }> = [];
const opened: string[] = [];
let realOperations = false;
const vscode = {
  workspace: { workspaceFolders: [] as Array<{ uri: ReturnType<typeof uri> }>,
    getConfiguration: (_section?: string, resource?: ReturnType<typeof uri>) => ({
      get: (key: string, fallback: unknown) => key === 'projectRoot' ? roots.get(resource?.toString() ?? '') ?? fallback : fallback,
      update: async (_key: string, value: string) => { roots.set(resource?.toString() ?? '', value); }
    }) },
  ConfigurationTarget: { Workspace: 2, WorkspaceFolder: 3 },
  window: {
    showOpenDialog: async (_options: any): Promise<any> => undefined,
    showInformationMessage: async (..._args: any[]): Promise<string | undefined> => '開始',
    showWarningMessage: async (..._args: any[]): Promise<string | undefined> => '更新預設分支',
    withProgress: async (_options: any, run: any) => run({ report: () => undefined }, { onCancellationRequested: () => ({ dispose: () => undefined }) })
  },
  commands: { executeCommand: async (_command: string, target: ReturnType<typeof uri>) => { opened.push(target.fsPath); } },
  Uri: { file: uri }, ProgressLocation: { Notification: 15 }
};
const loader = require('node:module') as { _load: (name: string, parent: unknown, main: boolean) => unknown };
const originalLoad = loader._load;
loader._load = (name, parent, main) => name === 'vscode' ? vscode : name === '../git/cloneService' ? {
  ...cloneService,
  cloneProjects: async (root: string, projects: any[], ...args: any[]) => {
    operations.push({ action: 'clone', root, ids: projects.map(project => project.id) });
    if (realOperations) return (cloneService.cloneProjects as any)(root, projects, ...args);
    return { cloned: projects, updated: [], skipped: [] };
  },
  syncLocalDefaultBranches: async (root: string, projects: any[], ...args: any[]) => {
    operations.push({ action: 'sync', root, ids: projects.map(project => project.id) });
    if (realOperations) return (cloneService.syncLocalDefaultBranches as any)(root, projects, ...args);
    return { updated: projects, upToDate: [], skipped: [], failed: [] };
  }
} : originalLoad(name, parent, main);
let WorkspacePanel: typeof import('../../src/workspace/workspacePanel').WorkspacePanel;
try { ({ WorkspacePanel } = require('../../src/workspace/workspacePanel')); }
finally { loader._load = originalLoad; }

const project = { id: 1, name: 'service', path: 'service', path_with_namespace: 'team/service', default_branch: 'main',
  http_url_to_repo: 'https://gitlab.test/team/service.git', web_url: 'https://gitlab.test/team/service' };
function memory() {
  const values = new Map<string, unknown>();
  return { get: <T>(key: string) => values.get(key) as T | undefined,
    update: async (key: string, value: unknown) => { value === undefined ? values.delete(key) : values.set(key, value); } };
}
function controller(folders: string[], workspaceState = memory()) {
  roots.clear(); operations.length = 0; opened.length = 0; realOperations = false;
  vscode.workspace.workspaceFolders = folders.map(folder => ({ uri: uri(folder) }));
  vscode.window.showOpenDialog = async () => undefined;
  vscode.window.showInformationMessage = async () => '開始';
  vscode.window.showWarningMessage = async () => '更新預設分支';
  const host: any = Object.assign(Object.create(WorkspacePanel!.prototype), {
    disposed: false, busy: false, repositoryOperationInProgress: false, workspaceFoldersGeneration: 0,
    projectRepositoryScanGeneration: 0, cloneRootGeneration: 0, projects: [project],
    workspaceMatch: { status: 'mismatched', repositories: [] }, workspaceRootError: '所有 Repo 都須對應所選 GitLab Group。',
    loadedScopeKey: 'https://gitlab.test|7|3', workspaceSections: { projects: { status: 'ready' } }, currentUser: { id: 7 },
    session: { baseUrl: 'https://gitlab.test', connectionEpoch: 1, selectedGroup: { id: 3, full_path: 'team' },
      getClient: async () => { const client = { getProject: async () => project, withReadSignal: (_signal: AbortSignal): unknown => client }; return client; }, getCloneCredentials: async () => ({ baseUrl: 'https://gitlab.test', token: 'fixture' }) },
    context: { workspaceState }, sendSnapshot: () => undefined, post: () => undefined, refresh: async () => undefined,
    refreshWorkflowKit: async () => undefined, onWorkspaceFoldersChanged: () => undefined
  });
  return { host, workspaceState };
}
async function fixture(t: test.TestContext) {
  const tempBase = await realpath(os.tmpdir());
  const base = await mkdtemp(path.join(tempBase, 'project-roots-'));
  t.after(async () => {
    assert.equal(path.dirname(await realpath(base)), tempBase);
    await rm(base, { recursive: true, force: true });
  });
  const root = path.join(base, '混合工作區'), second = path.join(base, '別的工作區');
  await mkdir(root); await mkdir(second);
  async function repo(parent: string, name: string, remote?: string) {
    const directory = path.join(parent, name); await mkdir(directory);
    execFileSync('git', ['init', '--quiet', directory]);
    if (remote) execFileSync('git', ['-C', directory, 'remote', 'add', 'origin', remote]);
    return realpath(directory);
  }
  return { root: await realpath(root), second: await realpath(second), repo };
}

test('mixed containers use their opened root and ignore unrelated Git API Repos', async t => {
  const f = await fixture(t);
  const service = await f.repo(f.root, 'service', project.http_url_to_repo);
  await f.repo(f.root, 'no-origin');
  const unrelated = await f.repo(f.second, 'elsewhere', 'https://other.test/team/elsewhere.git');
  const { host } = controller([f.root]); host.gitRepositories = { getInventory: async () => [{ path: unrelated }] };
  const match = await host.inspectEnvironment(); assert.equal(match.status, 'matched'); assert.equal(match.root, f.root);
  await host.refreshProjectRoot();
  assert.equal(host.cloneRoot, f.root); assert.equal(host.groupRoot, undefined);
  assert.equal(host.projectLocalRepositoryStates[1].path, service);
  assert.equal(host.localRepositoryStates, undefined, 'Issue and Group repository states remain separate');
  await host.clone([1], false); await host.syncRepos(); await host.openLocalWorkspace();
  assert.deepEqual(operations, [{ action: 'clone', root: f.root, ids: [1] }, { action: 'sync', root: f.root, ids: [1] }]);
  assert.deepEqual(opened, [f.root]);
});

test('a single opened Repo uses its own root regardless of origin and multiple roots require selection', async t => {
  const f = await fixture(t); const service = await f.repo(f.root, 'renamed', project.http_url_to_repo);
  const other = await f.repo(f.second, 'other');
  let host = controller([service]).host; assert.equal((await host.resolveProjectRoot()).root, service);
  host = controller([other]).host; assert.equal((await host.resolveProjectRoot()).root, other);
  host = controller([service, other]).host; assert.equal((await host.resolveProjectRoot()).root, undefined);
  await host.selectProjectFolder(uri(other).toString()); assert.equal((await host.resolveProjectRoot()).root, other);
});

test('workspace-folder selection persists and remote account changes leave its root intact', async t => {
  const f = await fixture(t); const { host, workspaceState } = controller([f.root, f.second]);
  await host.refreshProjectRoot(); assert.equal(host.cloneRoot, undefined); assert.match(host.cloneRootError, /選擇/);
  await host.selectProjectFolder(uri(f.second).toString()); await host.refreshProjectRoot(); assert.equal(host.cloneRoot, f.second);
  const reopened = controller([f.root, f.second], workspaceState).host; await reopened.refreshProjectRoot();
  assert.equal(reopened.cloneRoot, f.second);
  reopened.session.selectedGroup = { id: 4 }; reopened.session.baseUrl = 'https://another.test'; reopened.currentUser = { id: 8 };
  await reopened.refreshProjectRoot(); assert.equal(reopened.cloneRoot, f.second);
  vscode.workspace.workspaceFolders = [{ uri: uri(f.root) }]; await reopened.refreshProjectRoot(); assert.equal(reopened.cloneRoot, f.root);
});

test('first download works in an empty folder and cancellation preserves the selected projects', async t => {
  const f = await fixture(t); const { host } = controller([f.root]);
  await host.refreshProjectRoot(); assert.equal(host.cloneRoot, f.root);
  vscode.window.showInformationMessage = async () => undefined;
  await host.clone([1], false); assert.equal(host.cloneOperation.phase, 'cancelled'); assert.equal(operations.length, 0);
  vscode.window.showInformationMessage = async () => '開始'; await host.clone([1], false);
  assert.deepEqual(operations[0].ids, [1]);
});

test('target origin mismatches remain blocked by the real clone and update preflight', async t => {
  const f = await fixture(t); const service = await f.repo(f.root, 'service', 'https://gitlab.test/other/service.git');
  const { host } = controller([f.root]); realOperations = true;
  await assert.rejects(host.clone([1], false), /not a Git repository for team\/service/);
  await host.syncRepos(); assert.equal(host.cloneOperation.items[0].state, 'skipped');
  assert.match(host.cloneOperation.items[0].message, /not a Git repository for team\/service/);
  assert.equal(execFileSync('git', ['-C', service, 'remote', 'get-url', 'origin'], { encoding: 'utf8' }).trim(), 'https://gitlab.test/other/service.git');
});

test('dialog, credentials and confirmation drift cannot redirect project operations', async t => {
  const f = await fixture(t); const { host } = controller([f.root]);
  vscode.window.showOpenDialog = async () => { vscode.workspace.workspaceFolders = [{ uri: uri(f.second) }]; return [uri(f.second)]; };
  await assert.rejects(host.selectProjectRoot(), /已變更/); assert.equal(roots.size, 0);
  vscode.workspace.workspaceFolders = [{ uri: uri(f.root) }];
  vscode.window.showInformationMessage = async () => { host.workspaceFoldersGeneration++; return '開始'; };
  await assert.rejects(host.clone([1], false), /已變更/); assert.equal(operations.length, 0);
  await f.repo(f.root, 'service', project.http_url_to_repo);
  vscode.window.showWarningMessage = async () => { host.session.connectionEpoch++; return '更新預設分支'; };
  await assert.rejects(host.syncRepos(), /已變更/); assert.equal(operations.length, 0);
});

test('late project root inspection cannot restore a previous selected folder', async t => {
  const f = await fixture(t); const { host } = controller([f.root]);
  const resolve = host.resolveProjectContext.bind(host); let finish!: (value: unknown) => void;
  host.resolveProjectContext = () => new Promise(done => { finish = done; });
  const pending = host.refreshProjectRoot(); host.resolveProjectContext = resolve;
  vscode.workspace.workspaceFolders = [{ uri: uri(f.second) }]; await host.refreshProjectRoot();
  finish({ root: f.root, manual: false }); await pending;
  assert.equal(host.cloneRoot, f.second);
});

test('root settings changed while resolving credentials stop clone and sync before launch', async t => {
  const f = await fixture(t); await f.repo(f.root, 'service', project.http_url_to_repo);
  const { host } = controller([f.root]);
  host.session.getCloneCredentials = async () => {
    roots.set(uri(f.root).toString(), f.second);
    return { baseUrl: 'https://gitlab.test', token: 'fixture' };
  };
  await assert.rejects(host.clone([1], false), /已變更/); assert.equal(operations.length, 0);
  roots.clear(); await assert.rejects(host.syncRepos(), /已變更/); assert.equal(operations.length, 0);
});

test('repository scans use the selected shared root including an external custom folder', async t => {
  const f = await fixture(t); const { host } = controller([f.root]); roots.set(uri(f.root).toString(), f.second);
  await host.refreshProjectRoot(); let scanned: readonly string[] | undefined;
  host.gitRepositories = { scanWorkspace: async (_signal: AbortSignal, _progress: unknown, targets: readonly string[]) => {
    scanned = targets; return { status: 'completed', checkedDirectories: 0, repositories: [], errors: [], excludes: ['.git'] };
  } };
  host.refreshInventory = async () => undefined; await host.scanRepositories(); assert.deepEqual(scanned, [f.second]);
});
