import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, realpath, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { Memento, SecretStorage } from 'vscode';
import type { GitLabClient } from '../../src/api/gitLabClient';
import type { GitLabPage, GitLabProject } from '../../src/api/types';
import { GitLabSession } from '../../src/connection/session';
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
  for (const folder of workspacePaths.projectFolderNames(initial).values()) await mkdir(path.join(root, folder));
  const events: string[] = [];
  const requests: Array<string | undefined> = [];
  const details: number[] = [];
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
  (session as unknown as { getClient(): Promise<GitLabClient> }).getClient = async () => client as unknown as GitLabClient;
  (session as unknown as { getCloneCredentials(): Promise<unknown> }).getCloneCredentials = async () => ({ baseUrl: 'https://gitlab.test', token: 'fixture' });
  const cachedRead = session.cachedRead.bind(session);
  (session as any).cachedRead = (key: string, load: any, options: any = {}) => {
    reads.push({ key, force: options.force, reason: options.reason }); return cachedRead(key, load, options);
  };
  const host: any = Object.assign(Object.create(WorkspacePanel!.prototype), {
    disposed: false, busy: false, repositoryOperationInProgress: false, workspaceFoldersGeneration: 0,
    root, projects: initial, workspaceSections: { projects: { status: 'ready', complete: true } },
    currentUser: { id: 7 }, session,
    resolveProjectRoot: async () => ({ root: host.root, revision: 'fixture' }),
    projectContextSignature: () => host.root,
    sendSnapshot: () => undefined, post: () => undefined, operationPhase: () => undefined, noteOutcome: () => undefined,
    refreshProjectRoot: async () => undefined, refreshInventory: async () => undefined
  });
  vscode.window.showWarningMessage = async () => { events.push('confirm'); return '更新預設分支'; };
  runSync = async (targetRoot, projects, _baseUrl, _token, _progress, dependencies = {}) => {
    const groupProjects = dependencies.groupProjects ?? projects;
    const resolved: GitLabProject[] = [];
    const invocation = { ids: projects.map(item => item.id), groupProjects,
      targets: projects.map(item => workspacePaths.groupRepositoryPath(targetRoot, item, groupProjects)), resolved };
    invocations.push(invocation);
    for (const item of projects) resolved.push(await dependencies.resolveProject!(item, dependencies.signal));
    return { found: projects.length, updated: [], upToDate: resolved, skipped: [], failed: [] };
  };
  return { host, session, root, events, requests, details, reads, invocations,
    pages: (read: typeof readPage) => { readPage = read; }, detail: (read: typeof readDetail) => { readDetail = read; } };
}

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
  assert.equal(f.invocations[0].groupProjects, initial, 'the confirmed folder mapping is kept');
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
});

test('known incomplete selected metadata bypasses bulk reads and preserves the original per-project resolver', async t => {
  const incomplete = { ...project(2) }; delete incomplete.empty_repo;
  const initial = [project(1), incomplete];
  const f = await fixture(t, initial);
  f.pages(async () => { throw new Error('a known incompatible inventory must not trigger bulk reads'); });
  f.detail(async id => project(id));
  await f.host.syncRepos();
  assert.deepEqual(f.requests, []); assert.deepEqual(f.reads, []);
  assert.deepEqual(f.details, [1, 2]);
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
  assert.equal(f.invocations[0].groupProjects, initial);
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
  for (const item of initial) {
    const target = path.join(f.root, item.path);
    execFileSync('git', ['init', '--quiet', target]);
    execFileSync('git', ['-C', target, 'remote', 'add', 'origin', item.http_url_to_repo]);
  }
  const synced: number[] = [];
  runSync = (targetRoot, projects, baseUrl, token, progress, dependencies) => cloneService.syncLocalDefaultBranches(targetRoot, projects, baseUrl, token, progress,
    { ...dependencies, syncRunner: async plan => { synced.push(plan.project.id); return { state: 'up-to-date' }; } });
  await f.host.syncRepos();
  assert.deepEqual(f.details, [1, 2]); assert.deepEqual(synced, [2]);
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
