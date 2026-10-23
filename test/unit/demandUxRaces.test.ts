import assert from 'node:assert/strict';
import test from 'node:test';
import type { Memento, SecretStorage } from 'vscode';
import { GitLabClient } from '../../src/api/gitLabClient';
import { GitLabReadCache } from '../../src/api/gitLabReadCache';
import { gitLabReadLifetimeMs } from '../../src/api/gitLabReadKeys';
import { observeRead, type ReadObservation } from '../../src/api/readObservation';
import type { GitLabNetworkGate } from '../../src/api/gitLabNetworkGate';
import type { GitLabMergeRequest, GitLabMetadata } from '../../src/api/types';
import { GitLabSession, type GitLabCachedReadOptions } from '../../src/connection/session';
import { readVerifiedMergeRequestDiff } from '../../src/workspace/mergeRequestDiffRead';

const moduleLoader = require('node:module'), originalLoad = moduleLoader._load;
let WorkspacePanel: any;
moduleLoader._load = (name: string, ...args: unknown[]) => name === 'vscode' ? {} : originalLoad(name, ...args);
try { ({ WorkspacePanel } = require('../../src/workspace/workspacePanel')); }
finally { moduleLoader._load = originalLoad; }

const tick = () => new Promise<void>(resolve => setImmediate(resolve));
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(release => { resolve = release; });
  return { promise, resolve };
}

class State implements Memento {
  private readonly values = new Map<string, unknown>([['gitlabWorkspace.baseUrl', 'https://gitlab.test']]);
  get<T>(key: string, fallback?: T): T | undefined { return this.values.has(key) ? this.values.get(key) as T : fallback; }
  async update(key: string, value: unknown): Promise<void> { this.values.set(key, value); }
  keys(): readonly string[] { return [...this.values.keys()]; }
}

function sessionFor(client: Partial<GitLabClient>): GitLabSession {
  const state = new State();
  const session = new GitLabSession({} as SecretStorage, state, true);
  (session as unknown as { getClient(): Promise<GitLabClient> }).getClient = async () => client as GitLabClient;
  return session;
}

const refs = { base_sha: 'a'.repeat(40), start_sha: 'b'.repeat(40), head_sha: 'c'.repeat(40) };
const mergeRequest = (iid: number): GitLabMergeRequest => ({ id: iid, project_id: 4, iid, title: `MR ${iid}`, state: 'opened',
  web_url: `https://gitlab.test/team/project/-/merge_requests/${iid}`, source_branch: `feature-${iid}`, target_branch: 'main', diff_refs: refs });
const version = { id: 8, base_commit_sha: refs.base_sha, start_commit_sha: refs.start_sha, head_commit_sha: refs.head_sha,
  state: 'collected', real_size: '1', diffs: [{ old_path: 'one.ts', new_path: 'one.ts', diff: '+one' }] };

test('cancelling fixed Diff after version discovery prevents the detail request and does not cache a partial read', async () => {
  const calls: string[] = [], controller = new AbortController();
  let cancelAfterDiscovery = true;
  // The fake transport is in memory; the client and session cancellation paths remain real.
  const gate = { fetch: (fetcher: typeof fetch, input: URL, init: RequestInit) => fetcher(input, init) } as unknown as GitLabNetworkGate;
  const client = new GitLabClient('https://gitlab.test', 'token', async input => {
    const url = new URL(String(input)); calls.push(url.pathname);
    return new Response(JSON.stringify(url.pathname.endsWith('/versions') ? [version] : version));
  }, undefined, undefined, undefined, undefined, undefined, gate);
  const clone = client.withReadSignal.bind(client);
  client.withReadSignal = signal => {
    const scoped = clone(signal), discover = scoped.findMergeRequestDiffVersion.bind(scoped);
    scoped.findMergeRequestDiffVersion = async (...args) => {
      const found = await discover(...args);
      if (cancelAfterDiscovery) { cancelAfterDiscovery = false; controller.abort(); }
      return found;
    };
    return scoped;
  };
  const session = sessionFor(client);
  await assert.rejects(readVerifiedMergeRequestDiff(session, 42, mergeRequest(1), { signal: controller.signal }), { name: 'AbortError' });
  await tick();
  assert.deepEqual(calls, ['/api/v4/projects/4/merge_requests/1/versions']);
  const retried = await readVerifiedMergeRequestDiff(session, 42, mergeRequest(1));
  assert.equal(retried.result.versionId, 8);
  assert.deepEqual(calls, ['/api/v4/projects/4/merge_requests/1/versions', '/api/v4/projects/4/merge_requests/1/versions',
    '/api/v4/projects/4/merge_requests/1/versions/8']);
});

test('late filtered MR pages cannot append rows or cursors after the filter changes', async () => {
  const oldPage = deferred<any>(), cache = new GitLabReadCache();
  const calls: Array<{ filter: string; cursor?: string }> = [], keys: string[] = [];
  const assignedCursor = 'https://gitlab.test/api/v4/groups/42/merge_requests?page=2&assignee_id=7';
  const page = (items: GitLabMergeRequest[], nextCursor?: string) => ({ items, nextCursor, complete: !nextCursor, updatedAt: new Date().toISOString() });
  const client: any = {
    withRequestBudget() { return this; },
    listGroupMergeRequestsPage: async (_groupId: number, cursor: string | undefined, selection: { filter: string }) => {
      calls.push({ filter: selection.filter, cursor });
      if (selection.filter === 'reviewer') return oldPage.promise;
      return cursor ? page([mergeRequest(21)]) : page([mergeRequest(20)], assignedCursor);
    }
  };
  const host = Object.create(WorkspacePanel.prototype);
  Object.assign(host, {
    disposed: false, panel: { visible: true }, activeMode: 'reviewer', currentUser: { id: 7 },
    mergeRequestFilter: 'reviewer', mergeRequests: [], projects: [], issues: [], groupIssueBoards: [], groupMilestones: [],
    workspaceSections: {}, workspaceSectionPages: new Map(), workspaceSectionGenerations: new Map(),
    workspaceSectionAborts: new Map(), workspaceSectionReads: new Map(),
    session: { baseUrl: 'https://gitlab.test', selectedGroup: { id: 42 },
      cachedRead: <T>(key: string, load: (readClient: GitLabClient) => Promise<T>, options: GitLabCachedReadOptions = {}) => {
        keys.push(key);
        return cache.get(key, () => load(client), { ...options, lifetimeMs: gitLabReadLifetimeMs(key), onRead: options.onState });
      } },
    sendSnapshot: () => undefined, noteOutcome: () => undefined
  });
  const oldRead = host.loadWorkspaceSection('mergeRequests');
  await tick(); assert.equal(calls.length, 1);
  host.changeMergeRequestFilter('assigned');
  await host.loadWorkspaceSection('mergeRequests');
  oldPage.resolve(page([mergeRequest(10)], 'https://gitlab.test/api/v4/groups/42/merge_requests?page=2&reviewer_id=7'));
  await oldRead; await tick();
  assert.deepEqual(host.mergeRequests.map((request: GitLabMergeRequest) => request.iid), [20]);
  assert.equal(host.workspaceSectionPages.get('mergeRequests').cursor, assignedCursor);
  await host.loadWorkspaceSection('mergeRequests', false, 'next');
  assert.deepEqual(host.mergeRequests.map((request: GitLabMergeRequest) => request.iid), [20, 21]);
  assert.deepEqual(calls, [{ filter: 'reviewer', cursor: undefined }, { filter: 'assigned', cursor: undefined },
    { filter: 'assigned', cursor: assignedCursor }]);
  assert.match(keys[0], /query\/reviewer-7\/pages/);
  assert.ok(keys.slice(1).every(key => /query\/assigned-7\/pages/.test(key)));
});

test('metadata with a version but missing edition reads the fallback once and then reuses its confirmed edition', async () => {
  const calls: string[] = [];
  const session = sessionFor({
    getMetadata: async () => { calls.push('metadata'); return { version: '16.11.10' }; },
    getVersion: async () => { calls.push('version'); return { version: '16.11.10', enterprise: false }; }
  });
  await session.ensureMetadataChecked();
  assert.equal(session.metadata?.enterprise, false);
  assert.deepEqual(calls, ['metadata', 'version']);
  await session.ensureMetadataChecked();
  assert.deepEqual(calls, ['metadata', 'version']);
});

test('version fallback preserves explicit Community Edition metadata when the fallback omits edition', async () => {
  const calls: string[] = [];
  const session = sessionFor({
    getMetadata: async () => { calls.push('metadata'); return { version: '', enterprise: false } as GitLabMetadata; },
    getVersion: async () => { calls.push('version'); return { version: '16.11.10' }; }
  });
  await session.ensureMetadataChecked();
  assert.equal(session.metadata?.version, '16.11.10');
  assert.equal(session.metadata?.enterprise, false);
  assert.deepEqual(calls, ['metadata', 'version']);
});

test('pending read subscribers receive current transport state and cancellation removes only that observer', async () => {
  const cache = new GitLabReadCache(), gate = deferred<void>(), body = deferred<string>();
  const firstStates: ReadObservation[] = [], joinedStates: ReadObservation[] = [];
  const firstController = new AbortController();
  let loads = 0, transportSignal: AbortSignal | undefined;
  const load = async (signal: AbortSignal) => {
    loads++; transportSignal = signal;
    observeRead({ transportStage: 'waiting' });
    await gate.promise;
    observeRead({ transportStage: 'sending' });
    return body.promise;
  };
  const first = cache.get('shared', load, { signal: firstController.signal, onTransport: event => firstStates.push(event) });
  await tick();
  const joined = cache.get('shared', load, { onTransport: event => joinedStates.push(event) });
  assert.deepEqual(joinedStates, [{ transportStage: 'waiting' }], 'a late subscriber gets the current pending stage');
  firstController.abort(); await assert.rejects(first, { name: 'AbortError' });
  assert.equal(transportSignal?.aborted, false);
  gate.resolve(); await tick();
  assert.deepEqual(firstStates, [{ transportStage: 'waiting' }]);
  assert.deepEqual(joinedStates, [{ transportStage: 'waiting' }, { transportStage: 'sending' }]);
  body.resolve('complete'); assert.equal(await joined, 'complete');
  assert.equal(loads, 1);
});
