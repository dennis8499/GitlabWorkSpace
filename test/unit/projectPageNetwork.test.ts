import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { GitLabClient } from '../../src/api/gitLabClient';
import { GitLabReadCache, type GitLabReadCacheOptions } from '../../src/api/gitLabReadCache';
import { gitLabReadLifetimeMs } from '../../src/api/gitLabReadKeys';
import { OperationLog } from '../../src/logging/operationLog';

const loader = require('node:module') as { _load: (name: string, parent: unknown, main: boolean) => unknown };
const originalLoad = loader._load;
loader._load = (name, parent, main) => name === 'vscode' ? {} : originalLoad(name, parent, main);
let WorkspacePanel: typeof import('../../src/workspace/workspacePanel').WorkspacePanel;
try { ({ WorkspacePanel } = require('../../src/workspace/workspacePanel')); }
finally { loader._load = originalLoad; }

test('a project page reads one hundred projects in one HTTP request and checks their folders without remote Git', async () => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'glw-project-network-')));
  const cache = new GitLabReadCache();
  const lines: string[] = [], requests: URL[] = [], failures: unknown[] = [];
  const log = new OperationLog({ info: line => lines.push(line), warn: line => lines.push(line), error: line => lines.push(line) });
  try {
    await mkdir(path.join(root, 'project-1-unrelated'));
    const project = (id: number) => ({ id, name: `Project ${id}`, path: `project-${id}`,
      path_with_namespace: `team/project-${id}`, web_url: `https://gitlab.test/team/project-${id}`,
      http_url_to_repo: `https://gitlab.test/team/project-${id}.git` });
    const client = new GitLabClient('https://gitlab.test', 'fixture-token', log.wrapFetch(async input => {
      const url = new URL(String(input)); requests.push(url);
      assert.equal(url.pathname, '/api/v4/groups/42/projects', 'entry must not query individual projects or other remote resources');
      assert.equal(url.searchParams.get('per_page'), '100');
      const nextPage = url.searchParams.get('page') === '2';
      return new Response(JSON.stringify(nextPage ? [project(101)] : Array.from({ length: 100 }, (_, index) => project(index + 1))),
        { status: 200, headers: { 'content-type': 'application/json', 'x-next-page': nextPage ? '' : '2' } });
    }));
    const group = { id: 42, name: 'Team', full_path: 'team', web_url: 'https://gitlab.test/team' };
    const context = { root, revision: 'local-root', folders: [], manual: false };
    const host: any = Object.create(WorkspacePanel!.prototype);
    Object.assign(host, {
      disposed: false, panel: { visible: true }, activeMode: 'clone', projectSource: 'gitlab', developerView: 'list',
      requestGeneration: 0, workspaceFoldersGeneration: 0, cloneRootGeneration: 0, projectRepositoryScanGeneration: 0,
      groups: [group], currentUser: { id: 7, name: 'Me', username: 'me' }, loadedScopeKey: 'https://gitlab.test|7|42',
      projects: [], issues: [], projectContext: context, projectLocalRepositoryStates: {},
      workspaceSections: {}, workspaceSectionGenerations: new Map(), workspaceSectionAborts: new Map(),
      session: {
        baseUrl: 'https://gitlab.test', selectedGroup: group, connectionEpoch: 1, log,
        ensureMetadataChecked: async () => undefined,
        cachedRead: <T>(key: string, load: (readClient: GitLabClient, signal: AbortSignal) => Promise<T>, options: GitLabReadCacheOptions = {}) =>
          cache.get(key, signal => load(client.withReadSignal(signal), signal), { ...options, lifetimeMs: gitLabReadLifetimeMs(key) })
      },
      resolveProjectContext: async () => context, projectContextSignature: () => 'local-root',
      syncBmadVisibility: () => undefined, setBusyOwner: () => undefined, sendSnapshot: () => undefined,
      noteOutcome: (outcome: unknown) => failures.push(outcome)
    });

    await log.run('workspace', 'openProjects', {}, () => host.refresh({ reason: 'entry' }));
    assert.equal(requests.length, 1, 'one page request supplies the entire visible project list');
    assert.equal(host.projects.length, 100);
    assert.equal(host.workspaceSections.projects.complete, false, 'the next page is advertised without being downloaded');
    assert.equal(Object.keys(host.projectLocalRepositoryStates).length, 100, 'all visible folders are inspected locally');
    assert.equal(host.projectLocalRepositoryStates[1].state, 'missing', 'an ordinary folder does not prove repository ownership');
    assert.equal(host.projectLocalRepositoryStates[2].state, 'missing');
    assert.ok(lines.some(line => line.startsWith('[git] rev-parse started')), 'the test exercises the real local root probe');
    assert.equal(lines.some(line => line.startsWith('[git]') && line.includes('"network":true')), false);

    await log.run('workspace', 'openProjects', {}, () => host.refresh({ reason: 'entry' }));
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(requests.length, 1, 'fresh re-entry and idle do not download more pages or per-project details');

    await host.dispatchMessage({ type: 'retryWorkspaceSection', section: 'projects', connectedScope: host.connectedScopeKey(), mode: 'next' });
    assert.equal(requests.length, 2, 'the user explicitly requests the next page');
    assert.equal(requests[1].searchParams.get('page'), '2');
    assert.equal(host.projects.length, 101);
    assert.equal(host.workspaceSections.projects.complete, true);
    assert.deepEqual(failures, []);
    assert.equal(lines.some(line => line.startsWith('[git]') && line.includes('"network":true')), false);
  } finally {
    cache.invalidate(); log.dispose();
    await rm(root, { recursive: true, force: true });
  }
});
