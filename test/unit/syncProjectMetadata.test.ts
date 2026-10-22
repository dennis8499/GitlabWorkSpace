import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, realpath, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import type { Memento, SecretStorage } from 'vscode';
import type { GitLabClient } from '../../src/api/gitLabClient';
import type { GitLabPage, GitLabProject } from '../../src/api/types';
import { GitLabSession } from '../../src/connection/session';
import { OperationLog } from '../../src/logging/operationLog';
import * as cloneService from '../../src/git/cloneService';
import * as workspacePaths from '../../src/workspace/workspacePaths';

const vscode = {
  workspace: { workspaceFolders: [] },
  window: { showWarningMessage: async (..._args: unknown[]): Promise<string | undefined> => '更新預設分支' }
};
let runSync: typeof cloneService.syncLocalDefaultBranches;
const loader = require('node:module') as { _load: (name: string, parent: unknown, main: boolean) => unknown };
const originalLoad = loader._load;
loader._load = (name, parent, main) => name === 'vscode' ? vscode : name === './workspacePaths' ? {
  ...workspacePaths, projectRootRepositoryId: async () => undefined
} : name === '../git/cloneService' ? {
  ...cloneService, syncLocalDefaultBranches: (...args: Parameters<typeof cloneService.syncLocalDefaultBranches>) => runSync(...args)
} : originalLoad(name, parent, main);
let WorkspacePanel: typeof import('../../src/workspace/workspacePanel').WorkspacePanel;
try { ({ WorkspacePanel } = require('../../src/workspace/workspacePanel')); }
finally { loader._load = originalLoad; }

class State implements Memento {
  private readonly values = new Map<string, unknown>([
    ['gitlabWorkspace.baseUrl', 'https://gitlab.test'], ['gitlabWorkspace.selectedGroupId', 3], ['gitlabWorkspace.selectedGroupLabel', 'team']
  ]);
  get<T>(key: string, fallback?: T): T | undefined { return (this.values.get(key) as T | undefined) ?? fallback; }
  async update(key: string, value: unknown): Promise<void> { this.values.set(key, value); }
  keys(): readonly string[] { return [...this.values.keys()]; }
}

const project = (id = 1, name = `service-${id}`): GitLabProject => ({
  id, name, path: name, path_with_namespace: `team/${name}`, default_branch: 'main', empty_repo: false,
  http_url_to_repo: `https://gitlab.test/team/${name}.git`, ssh_url_to_repo: `git@gitlab.test:team/${name}.git`,
  web_url: `https://gitlab.test/team/${name}`
});
const page = (items: GitLabProject[], nextCursor?: string): GitLabPage<GitLabProject> => ({
  items, complete: !nextCursor, nextCursor, updatedAt: new Date().toISOString()
});

async function fixture(t: test.TestContext, initial = [project()]) {
  const temporaryRoot = await realpath(os.tmpdir());
  const root = await mkdtemp(path.join(temporaryRoot, 'sync-project-metadata-'));
  t.after(async () => {
    assert.equal(path.dirname(await realpath(root)), temporaryRoot);
    await rm(root, { recursive: true, force: true });
  });
  const initialFolders = workspacePaths.projectFolderNames(initial);
  for (const item of initial) {
    const target = path.join(root, initialFolders.get(item.id)!); await mkdir(target);
    execFileSync('git', ['init', '--quiet', target]);
    execFileSync('git', ['-C', target, 'remote', 'add', 'origin', item.http_url_to_repo]);
  }
  const events: string[] = [];
  const requests: Array<string | undefined> = [];
  const details: number[] = [];
  const activity = { clients: 0, credentials: 0, roots: 0, inventories: 0 };
  const messages: Array<{ type: string; message?: string }> = [];
  const confirmations: string[] = [];
  const reads: Array<{ key: string; force?: boolean; reason?: string }> = [];
  const invocations: Array<{ ids: number[]; groupProjects: readonly GitLabProject[]; targets: string[]; resolved: GitLabProject[] }> = [];
  let readPage = async (_cursor?: string, _signal?: AbortSignal): Promise<GitLabPage<GitLabProject>> => page(initial);
  let readDetail = async (id: number): Promise<GitLabProject> => initial.find(item => item.id === id)!;
  const client = {
    signal: undefined as AbortSignal | undefined,
    withReadSignal(signal: AbortSignal) { return Object.assign(Object.create(this), { signal }); },
    withRequestBudget() { return this; },
    listGroupProjectsPage(this: { signal?: AbortSignal }, _groupId: number, cursor?: string) {
      requests.push(cursor); events.push('page'); return readPage(cursor, this.signal);
    },
    async getProject(id: number) { details.push(id); return readDetail(id); }
  };
  const session = new GitLabSession({} as SecretStorage, new State(), true, new State());
  (session as unknown as { getClient(): Promise<GitLabClient> }).getClient = async () => { activity.clients++; return client as unknown as GitLabClient; };
  (session as unknown as { getCloneCredentials(): Promise<unknown> }).getCloneCredentials = async () => { activity.credentials++; return { baseUrl: 'https://gitlab.test', token: 'fixture' }; };
  const cachedRead = session.cachedRead.bind(session);
  (session as any).cachedRead = (key: string, load: any, options: any = {}) => {
    reads.push({ key, force: options.force, reason: options.reason }); return cachedRead(key, load, options);
  };
  const host: any = Object.assign(Object.create(WorkspacePanel!.prototype), {
    disposed: false, busy: false, repositoryOperationInProgress: false, workspaceFoldersGeneration: 0,
    root, projects: initial, workspaceSections: { projects: { status: 'ready', complete: true } },
    currentUser: { id: 7 }, session,
    resolveProjectRoot: async () => { activity.roots++; return { root: host.root, revision: 'fixture' }; },
    projectContextSignature: () => host.root,
    sendSnapshot: () => undefined, post: (message: { type: string; message?: string }) => { messages.push(message); }, operationPhase: () => undefined, noteOutcome: () => undefined,
    refreshProjectRoot: async () => undefined, refreshInventory: async () => { activity.inventories++; }
  });
  vscode.window.showWarningMessage = async (...args: unknown[]) => { confirmations.push(String(args[0])); events.push('confirm'); return '更新預設分支'; };
  runSync = async (targetRoot, projects, _baseUrl, _token, _progress, dependencies = {}) => {
    const groupProjects = dependencies.groupProjects ?? projects;
    const resolved: GitLabProject[] = [];
    const invocation = { ids: projects.map(item => item.id), groupProjects,
      targets: projects.map(item => workspacePaths.groupRepositoryPath(targetRoot, item, groupProjects, dependencies.layout?.folders, dependencies.layout?.rootProjectId)), resolved };
    invocations.push(invocation);
    for (const item of projects) resolved.push(await dependencies.resolveProject!(item, dependencies.signal));
    return { found: projects.length, updated: [], upToDate: resolved, skipped: [], failed: [] };
  };
  return { host, session, root, events, requests, details, reads, invocations, activity, messages, confirmations,
    pages: (read: typeof readPage) => { readPage = read; }, detail: (read: typeof readDetail) => { readDetail = read; } };
}

test('an explicit empty sync selection returns before reading any scope, inventory, credentials or Git state', async () => {
  const messages: Array<{ type: string; message?: string }> = [];
  const host: any = Object.create(WorkspacePanel!.prototype);
  host.post = (message: { type: string; message?: string }) => messages.push(message);
  for (const name of ['session', 'projects']) Object.defineProperty(host, name, { get() { throw new Error(`empty sync read ${name}`); } });
  for (const name of ['resolveProjectRoot', 'refreshInventory', 'refreshProjectRoot']) host[name] = () => { throw new Error(`empty sync called ${name}`); };
  const lines: string[] = [];
  const log = new OperationLog({ info: line => lines.push(line), warn: line => lines.push(line), error: line => lines.push(line) });
  try { await log.withContext({}, () => host.syncRepos([])); }
  finally { log.dispose(); }
  assert.deepEqual(lines, []);
  assert.equal(messages.length, 1); assert.match(messages[0].message!, /勾選要同步/);
});

test('invalid or unavailable selected IDs reject before any client or repository lookup', async t => {
  const f = await fixture(t);
  for (const ids of [null, '1', [0], [-1], [1.5], [NaN], [Infinity], ['1'], [Number.MAX_SAFE_INTEGER + 1], [1, 999]]) {
    await assert.rejects(f.host.syncRepos(ids), /無效|不在已載入/);
  }
  f.host.projects = [{ ...project(), path_with_namespace: 'another-team/service-1' }];
  await assert.rejects(f.host.syncRepos([1]), /不屬於目前 Group/);
  assert.deepEqual(f.activity, { clients: 0, credentials: 0, roots: 0, inventories: 0 });
  assert.deepEqual(f.requests, []); assert.deepEqual(f.invocations, []);
});

test('selected sync deduplicates IDs, keeps the complete layout and never clones a missing selection', async t => {
  const initial = [project(1), project(2), project(3)];
  const f = await fixture(t, initial);
  await rm(path.join(f.root, workspacePaths.projectFolderNames(initial).get(1)!), { recursive: true });
  await f.host.syncRepos([1, 2, 2]);
  assert.deepEqual(f.invocations.map(call => call.ids), [[2]]);
  assert.deepEqual(f.invocations[0].groupProjects, initial);
  assert.deepEqual(f.invocations[0].targets, [path.join(f.root, initial[1].path)]);
  assert.deepEqual(f.requests, [undefined]); assert.deepEqual(f.details, []);
  assert.match(f.confirmations[0], /選取的 1 個/);
  assert.deepEqual(f.host.cloneOperation.items.map((item: { projectId: number }) => item.projectId), [2]);
});

test('a selection without an existing local Repo performs no sync or fresh metadata request', async t => {
  const f = await fixture(t, [project(1), project(2)]);
  await rm(path.join(f.root, project(1).path), { recursive: true });
  await f.host.syncRepos([1]);
  assert.deepEqual(f.invocations, []); assert.deepEqual(f.requests, []); assert.deepEqual(f.details, []);
  assert.equal(f.activity.credentials, 0); assert.deepEqual(f.confirmations, []);
  assert.ok(f.messages.some(message => /選取專案尚無/.test(message.message ?? '')));
});

test('selecting three of sixteen repositories executes exactly three real fetches and no clones', async t => {
  const initial = Array.from({ length: 16 }, (_, index) => project(index + 1));
  const f = await fixture(t, initial);
  const parent = await realpath(os.tmpdir());
  const serverRoot = await mkdtemp(path.join(parent, 'sync-selection-origin-'));
  const remote = path.join(serverRoot, 'origin.git'), source = path.join(serverRoot, 'source');
  const git = (...args: string[]) => execFileSync('git', args, { encoding: 'utf8', windowsHide: true }).trim();
  git('init', '--quiet', '--bare', '--template=', remote);
  git('init', '--quiet', '--template=', '--initial-branch=main', source);
  git('-C', source, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', '-c', 'commit.gpgsign=false', 'commit', '--quiet', '--allow-empty', '-m', 'Fixture');
  git('-C', source, 'push', '--quiet', remote, 'main');
  const sha = git('-C', source, 'rev-parse', 'HEAD');
  const selectedIds = [2, 7, 14];
  for (const id of selectedIds) git('-C', path.join(f.root, project(id).path), 'symbolic-ref', 'HEAD', 'refs/heads/main');
  const lines: string[] = [];
  const log = new OperationLog({ info: line => lines.push(line), warn: line => lines.push(line), error: line => lines.push(line) });
  const index = Number(process.env.GIT_CONFIG_COUNT ?? '0');
  const changes: Record<string, string> = { GIT_CONFIG_COUNT: String(index + selectedIds.length), GIT_ALLOW_PROTOCOL: 'file',
    GITLAB_WORKSPACE_RUNTIME_DIR: path.join(serverRoot, 'network-runtime') };
  selectedIds.forEach((id, offset) => {
    changes[`GIT_CONFIG_KEY_${index + offset}`] = `url.${pathToFileURL(remote).href}.insteadOf`;
    changes[`GIT_CONFIG_VALUE_${index + offset}`] = project(id).http_url_to_repo;
  });
  const previous = new Map(Object.keys(changes).map(key => [key, process.env[key]]));
  t.after(async () => {
    for (const [key, value] of previous) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    log.dispose(); assert.equal(path.dirname(await realpath(serverRoot)), parent); await rm(serverRoot, { recursive: true, force: true });
  });
  Object.assign(process.env, changes);
  runSync = cloneService.syncLocalDefaultBranches;
  await log.withContext({}, () => f.host.syncRepos([2, 7, 7, 14]));
  const networkStarts = lines.filter(line => line.startsWith('[git]') && line.includes(' started ') && line.includes('"network":true'));
  assert.equal(networkStarts.length, 3); assert.ok(networkStarts.every(line => line.startsWith('[git] fetch started ')));
  assert.equal(lines.filter(line => line.startsWith('[git] fetch success ')).length, 3);
  assert.equal(lines.some(line => line.startsWith('[git] clone ')), false);
  assert.deepEqual(f.requests, [undefined]); assert.deepEqual(f.details, []);
  assert.deepEqual(f.host.cloneOperation.items.map((item: { projectId: number; state: string }) => [item.projectId, item.state]), [[2, 'updated'], [7, 'updated'], [14, 'updated']]);
  for (const item of initial) {
    const args = ['-C', path.join(f.root, item.path), 'rev-parse', '--verify', '--quiet', 'refs/remotes/origin/main'];
    if (selectedIds.includes(item.id)) assert.equal(git(...args), sha);
    else assert.throws(() => git(...args), `unselected Repo ${item.id} must not fetch`);
  }
});

test('each confirmed sync forces all fresh metadata pages before running only confirmed projects', async t => {
  const initial = [project(1), project(2)];
  const f = await fixture(t, initial);
  const cursor = 'https://gitlab.test/api/v4/groups/3/projects?page=2';
  let branch = 'release';
  f.pages(async next => next ? page([{ ...initial[1], default_branch: branch }]) : page([{ ...initial[0], default_branch: branch }], cursor));
  await f.host.syncRepos();
  branch = 'stable';
  await f.host.syncRepos();
  assert.deepEqual(f.requests, [undefined, cursor, undefined, cursor]);
  assert.deepEqual(f.reads, [
    { key: 'group/3/projects', force: true, reason: 'sync-repos' }, { key: 'group/3/projects', force: true, reason: 'sync-repos' }
  ]);
  assert.deepEqual(f.events, ['confirm', 'page', 'page', 'confirm', 'page', 'page']);
  assert.deepEqual(f.details, []);
  assert.deepEqual(f.invocations.map(call => call.resolved.map(item => item.default_branch)), [['release', 'release'], ['stable', 'stable']]);
  assert.deepEqual(f.invocations[0].groupProjects, initial, 'the confirmed folder mapping is kept');
});

test('a controlled 16 Repo inventory needs one fresh page and no per-project detail reads', async t => {
  const initial = Array.from({ length: 16 }, (_, index) => project(index + 1));
  const f = await fixture(t, initial);
  f.pages(async () => page(initial.map(item => ({ ...item, default_branch: 'release' }))));
  await f.host.syncRepos();
  assert.deepEqual(f.requests, [undefined]); assert.deepEqual(f.details, []);
  assert.equal(f.invocations.length, 1);
  assert.deepEqual(f.invocations[0].ids, initial.map(item => item.id));
  assert.deepEqual(f.invocations[0].resolved.map(item => item.id), initial.map(item => item.id));
  assert.equal(f.invocations[0].resolved.length, 16);
  assert.match(f.confirmations[0], /全部 16 個/);
});

test('known incomplete selected metadata bypasses bulk reads and preserves the original per-project resolver', async t => {
  const incomplete = { ...project(2) }; delete incomplete.empty_repo;
  const initial = [project(1), incomplete];
  const f = await fixture(t, initial);
  f.pages(async () => { throw new Error('a known incompatible inventory must not trigger bulk reads'); });
  f.detail(async id => project(id));
  await f.host.syncRepos();
  assert.deepEqual(f.requests, []); assert.deepEqual(f.reads, []);
  assert.deepEqual([...f.details].sort((first, second) => first - second), [1, 2]);
});

for (const field of ['path', 'path_with_namespace', 'http_url_to_repo', 'ssh_url_to_repo', 'default_branch', 'empty_repo'] as const) {
  test(`fresh metadata missing ${field} uses a detail fallback without treating missing fields as false`, async t => {
    const f = await fixture(t);
    const incomplete = { ...project() };
    delete (incomplete as Partial<GitLabProject>)[field];
    f.pages(async () => page([incomplete]));
    f.detail(async () => ({ ...project(), default_branch: 'release' }));
    await f.host.syncRepos();
    assert.deepEqual(f.requests, [undefined]); assert.deepEqual(f.details, [1]);
    assert.equal(f.invocations[0].resolved[0].default_branch, 'release');
  });
}

test('explicit empty and missing-default-branch metadata is authoritative without a detail fallback', async t => {
  const f = await fixture(t);
  f.pages(async () => page([{ ...project(), empty_repo: true, default_branch: null, ssh_url_to_repo: null }]));
  await f.host.syncRepos();
  assert.deepEqual(f.details, []);
  assert.equal(f.invocations[0].resolved[0].empty_repo, true);
  assert.equal(f.invocations[0].resolved[0].default_branch, null);
});

test('removed projects are skipped and newly listed duplicate names cannot expand scope or redirect confirmed paths', async t => {
  const initial = [project(1), project(2)];
  const f = await fixture(t, initial);
  f.pages(async () => page([initial[1], project(3, initial[1].path)]));
  await f.host.syncRepos();
  assert.deepEqual(f.details, []);
  assert.deepEqual(f.invocations[0].ids, [2]);
  assert.deepEqual(f.invocations[0].groupProjects, initial);
  assert.deepEqual(f.invocations[0].targets, [path.join(f.root, initial[1].path)]);
  assert.equal(f.host.cloneOperation.items.find((item: any) => item.projectId === 1).state, 'skipped');
  assert.match(f.host.cloneOperation.items.find((item: any) => item.projectId === 1).message, /目前 Group/);
});

test('a completely removed selection performs no sync and no detail requests', async t => {
  const f = await fixture(t); f.pages(async () => page([]));
  await f.host.syncRepos();
  assert.deepEqual(f.invocations, []); assert.deepEqual(f.details, []);
  assert.equal(f.host.cloneOperation.items[0].state, 'skipped');
});

test('a detail fallback failure skips only that repository through the real sync preflight', async t => {
  const initial = [project(1), project(2)];
  const f = await fixture(t, initial);
  f.pages(async () => page(initial.map(item => { const incomplete = { ...item }; delete incomplete.empty_repo; return incomplete; })));
  f.detail(async id => { if (id === 1) throw new Error('detail metadata unavailable'); return project(id); });
  const synced: number[] = [];
  runSync = (targetRoot, projects, baseUrl, token, progress, dependencies) => cloneService.syncLocalDefaultBranches(targetRoot, projects, baseUrl, token, progress,
    { ...dependencies, syncRunner: async plan => { synced.push(plan.project.id); return { state: 'up-to-date' }; } });
  await f.host.syncRepos();
  // Independent metadata preflights may finish their local repository checks in either order.
  assert.deepEqual([...f.details].sort((first, second) => first - second), [1, 2]); assert.deepEqual(synced, [2]);
  assert.equal(f.host.cloneOperation.items.find((item: any) => item.projectId === 1).state, 'skipped');
  assert.match(f.host.cloneOperation.items.find((item: any) => item.projectId === 1).message, /detail metadata unavailable/);
  assert.equal(f.host.cloneOperation.items.find((item: any) => item.projectId === 2).state, 'upToDate');
});

test('a failed continuation cannot execute repositories from an incomplete fresh snapshot', async t => {
  const f = await fixture(t);
  f.pages(async next => { if (next) throw new Error('continuation unavailable'); return page([project()], 'next'); });
  await assert.rejects(f.host.syncRepos(), /continuation unavailable/);
  assert.deepEqual(f.requests, [undefined, 'next']);
  assert.deepEqual(f.invocations, []); assert.deepEqual(f.details, []);
});

test('cancelling the confirmation sends no fresh metadata or detail requests', async t => {
  const f = await fixture(t); vscode.window.showWarningMessage = async () => undefined;
  await f.host.syncRepos();
  assert.deepEqual(f.requests, []); assert.deepEqual(f.details, []); assert.deepEqual(f.invocations, []);
  assert.equal(f.host.cloneOperation.phase, 'cancelled');
});

test('cancelling a selected sync sends no fresh reads or repository operations', async t => {
  const f = await fixture(t, [project(1), project(2)]);
  vscode.window.showWarningMessage = async () => undefined;
  await f.host.syncRepos([2]);
  assert.deepEqual(f.requests, []); assert.deepEqual(f.details, []); assert.deepEqual(f.invocations, []);
  assert.equal(f.activity.credentials, 0); assert.equal(f.host.cloneOperation.phase, 'cancelled');
});

test('aborting a pending fresh snapshot stops before sync starts', async t => {
  const f = await fixture(t);
  let started!: () => void, finish!: (value: GitLabPage<GitLabProject>) => void;
  const reading = new Promise<void>(resolve => { started = resolve; });
  f.pages(async () => { started(); return new Promise(resolve => { finish = resolve; }); });
  const pending = f.host.syncRepos(); await reading;
  f.host.repositoryOperationAbort.abort(); finish(page([project()]));
  await pending;
  assert.deepEqual(f.invocations, []); assert.deepEqual(f.details, []);
  assert.equal(f.host.cloneOperation.phase, 'cancelled');
});

for (const drift of ['account', 'root'] as const) {
  test(`${drift} drift during a fresh read stops before sync starts`, async t => {
    const f = await fixture(t);
    f.pages(async () => {
      if (drift === 'account') (f.session as any).connectionEpochValue++;
      else f.host.root = path.join(f.root, 'different-root');
      return page([project()]);
    });
    await assert.rejects(f.host.syncRepos(), /已變更/);
    assert.deepEqual(f.invocations, []); assert.deepEqual(f.details, []);
  });
}

for (const drift of ['account', 'group', 'root'] as const) {
  test(`selected sync rejects ${drift} drift during its fresh metadata read`, async t => {
    const f = await fixture(t, [project(1), project(2)]);
    f.pages(async () => {
      if (drift === 'account') (f.session as any).connectionEpochValue++;
      else if (drift === 'group') Object.defineProperty(f.session, 'selectedGroup', { value: { id: 4, full_path: 'other-team' } });
      else f.host.root = path.join(f.root, 'different-root');
      return page([project(1), project(2)]);
    });
    await assert.rejects(f.host.syncRepos([2]), /已變更/);
    assert.deepEqual(f.invocations, []); assert.deepEqual(f.details, []); assert.equal(f.activity.credentials, 0);
  });
}

test('selected sync still rechecks a changed origin after confirmation before any fetch', async t => {
  const f = await fixture(t, [project(1), project(2)]);
  let writes = 0;
  runSync = (root, projects, baseUrl, token, onProgress, dependencies) => cloneService.syncLocalDefaultBranches(root, projects, baseUrl, token, onProgress,
    { ...dependencies, syncRunner: async () => { writes++; return { state: 'up-to-date' }; } });
  vscode.window.showWarningMessage = async () => {
    execFileSync('git', ['-C', path.join(f.root, project(2).path), 'remote', 'set-url', 'origin', 'https://gitlab.test/other-team/service-2.git']);
    return '更新預設分支';
  };
  await assert.rejects(f.host.syncRepos([2]), /位置已|safe repository|占用/);
  assert.equal(writes, 0);
});
