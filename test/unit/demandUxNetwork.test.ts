import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { GitLabClient } from '../../src/api/gitLabClient';
import { GitLabReadCache } from '../../src/api/gitLabReadCache';
import { gitLabReadLifetimeMs } from '../../src/api/gitLabReadKeys';
import { readVerifiedMergeRequestDiff } from '../../src/workspace/mergeRequestDiffRead';
import type { GitLabSession, GitLabCachedReadOptions } from '../../src/connection/session';
import type { GitLabMergeRequest } from '../../src/api/types';
import { selectedCapabilityData } from './graphqlFixture';

const moduleLoader = require('node:module'), originalLoad = moduleLoader._load;
let WorkspacePanel: any;
moduleLoader._load = (name: string, ...args: unknown[]) => name === 'vscode' ? {} : originalLoad(name, ...args);
try { ({ WorkspacePanel } = require('../../src/workspace/workspacePanel')); }
finally { moduleLoader._load = originalLoad; }

const refs = { base_sha: 'base', start_sha: 'start', head_sha: 'head' };
const request: GitLabMergeRequest = { id: 1, project_id: 4, iid: 1, title: 'MR', state: 'opened',
  web_url: 'https://gitlab.test/team/one/-/merge_requests/1', source_branch: 'feature', target_branch: 'main', diff_refs: refs };
const version = { id: 8, base_commit_sha: 'base', start_commit_sha: 'start', head_commit_sha: 'head', state: 'collected', real_size: '1',
  diffs: [{ old_path: 'a', new_path: 'a', diff: '+one' }] };

function fixture(override?: (url: URL) => unknown) {
  const calls: URL[] = [];
  let now = 1000;
  const client = new GitLabClient('https://gitlab.test', 'token', async input => {
    const url = new URL(String(input)); calls.push(url);
    const payload = override?.(url) ?? (url.pathname.endsWith('/versions') ? [version]
      : /\/versions\/\d+$/.test(url.pathname) ? version : request);
    return new Response(JSON.stringify(payload), { headers: { 'content-type': 'application/json' } });
  });
  const cache = new GitLabReadCache(60_000, 256, () => now);
  const session = { cachedRead: <T>(key: string, load: (client: GitLabClient) => Promise<T>, options: GitLabCachedReadOptions = {}) =>
    cache.get(key, signal => load(client.withReadSignal(signal)), { ...options, lifetimeMs: gitLabReadLifetimeMs(key), onRead: options.onState }) } as GitLabSession;
  return { calls, client, session, cache, advance: (delta: number) => { now += delta; } };
}

test('MR server filters use the authenticated identity and only one 100-row page', async () => {
  const f = fixture(() => [request]);
  await f.client.listGroupMergeRequestsPage(42, undefined, { filter: 'reviewer', userId: 9 });
  await f.client.listGroupMergeRequestsPage(42, undefined, { filter: 'assigned', userId: 9 });
  assert.equal(f.calls.length, 2);
  assert.equal(f.calls[0].searchParams.get('reviewer_id'), '9');
  assert.equal(f.calls[1].searchParams.get('assignee_id'), '9');
  assert.equal(f.calls[0].searchParams.get('per_page'), '100');
  await assert.rejects(f.client.listGroupMergeRequestsPage(42, undefined, { filter: 'reviewer', userId: 0 }));
});

test('Host blocks CE and unknown-edition approval before resolving a project or sending HTTP', async () => {
  for (const enterprise of [false, undefined]) {
    const host = Object.create(WorkspacePanel.prototype);
    let calls = 0;
    Object.assign(host, { session: { metadata: { enterprise } }, resolveGroupProject: async () => { calls++; } });
    await assert.rejects(host.approveMergeRequest(4, 1, 'head'), /Community Edition|尚未確認/);
    assert.equal(calls, 0);
  }
});

test('verified Diff A-B-A shares fixed versions, uses five-minute TTL, and manual refresh bypasses it', async () => {
  const f = fixture();
  const a = await readVerifiedMergeRequestDiff(f.session, 42, request);
  await readVerifiedMergeRequestDiff(f.session, 42, { ...request, iid: 2 });
  const before = f.calls.length;
  const again = await readVerifiedMergeRequestDiff(f.session, 42, request);
  assert.equal(f.calls.length, before);
  assert.equal(again.result, a.result);
  assert.equal(a.result.versionId, 8);
  assert.equal(a.result.truncated, false);
  f.advance(60_001);
  await readVerifiedMergeRequestDiff(f.session, 42, request);
  assert.equal(f.calls.length, before);
  await readVerifiedMergeRequestDiff(f.session, 42, request, { force: true });
  assert.equal(f.calls.length, before + 2);
  f.advance(300_001);
  await readVerifiedMergeRequestDiff(f.session, 42, request);
  assert.equal(f.calls.length, before + 4);
});

test('fixed Diff rejects actual SHA mismatches and missing summary refs without caching unverified contents', async () => {
  const f = fixture(url => /\/versions\/8$/.test(url.pathname) ? { ...version, head_commit_sha: 'wrong' } : undefined);
  await assert.rejects(readVerifiedMergeRequestDiff(f.session, 42, request), /SHA/);
  await assert.rejects(readVerifiedMergeRequestDiff(f.session, 42, request), /SHA/);
  assert.equal(f.calls.length, 4);
  await assert.rejects(readVerifiedMergeRequestDiff(f.session, 42, { ...request, diff_refs: null }), /尚未準備/);
  assert.equal(f.calls.length, 4);
});

test('missing matching version refreshes summary once without enumerating version history', async () => {
  const f = fixture(url => url.pathname.endsWith('/versions') ? [] : undefined);
  await assert.rejects(readVerifiedMergeRequestDiff(f.session, 42, request), /尚未找到/);
  assert.equal(f.calls.length, 3);
  assert.equal(f.calls.filter(url => url.pathname.endsWith('/versions')).length, 2);
});

test('overflow and unknown-size Diff versions remain explicitly incomplete', async () => {
  for (const patch of [{ state: 'overflow' }, { state: 'without_files' }, { state: 'timeout' }, { real_size: '1000+' }]) {
    const f = fixture(url => /\/versions\/8$/.test(url.pathname) ? { ...version, ...patch } : undefined);
    const result = await readVerifiedMergeRequestDiff(f.session, 42, request);
    assert.equal(result.result.truncated, true);
    assert.ok(result.result.warnings.length);
  }
});

test('cache metadata reports original acquisition time and expires without fetching automatically', async () => {
  let now = 100, calls = 0;
  const cache = new GitLabReadCache(60_000, 256, () => now), states: unknown[] = [];
  const options = { onRead: (state: unknown) => states.push(state) };
  await cache.get('a', async () => ++calls, options);
  now = 200;
  await cache.get('a', async () => ++calls, options);
  assert.deepEqual(states, [{ dataSource: 'network', fetchedAt: 100, expiresAt: 60100 }, { dataSource: 'cache', fetchedAt: 100, expiresAt: 60100 }]);
  now = 60101;
  assert.equal(calls, 1);
  await cache.get('a', async () => ++calls, options);
  assert.equal(calls, 2);
});

test('16.11.10 CE version-pinned contract preserves REST reads and conservatively disables missing optional schema', async () => {
  const contract = JSON.parse(readFileSync(path.join(process.cwd(), 'test/fixtures/gitlab-ce-16.11.10-contract.json'), 'utf8'));
  const calls: string[] = [];
  const client = new GitLabClient('https://gitlab.test', 'token', async (input, init) => {
    const url = new URL(String(input)); calls.push(url.pathname);
    const payload = url.pathname.endsWith('/graphql') ? { data: selectedCapabilityData(JSON.parse(String(init?.body)).query, contract.types) }
      : url.pathname.endsWith('/metadata') ? { version: contract.version, enterprise: contract.enterprise }
      : url.pathname.endsWith('/user') ? { id: 9, username: 'me', name: 'Me' }
      : url.pathname.endsWith('/issues/1') ? contract.issue : contract.project;
    return new Response(JSON.stringify(payload), { headers: { 'content-type': 'application/json' } });
  });
  assert.equal((await client.getMetadata()).version, '16.11.10');
  assert.equal((await client.getCurrentUser()).id, 9);
  assert.equal((await client.getProject(4)).id, 4);
  assert.equal((await client.getIssue(4, 1)).iid, 1);
  const capability = await client.getIssueCapabilities();
  assert.equal(capability.childMutations, false);
  assert.equal(capability.timelogCreate, false);
  assert.equal(capability.createPermission, false);
  assert.equal(contract.liveVerified, false);
  assert.ok(calls.length >= 5);
});
