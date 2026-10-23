import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import type { ExtensionContext, Memento, SecretStorage } from 'vscode';
import { GitLabClient, type FetchLike } from '../../src/api/gitLabClient';
import type { GitLabNetworkGate } from '../../src/api/gitLabNetworkGate';
import { GitLabSession } from '../../src/connection/session';
import type { GitLabMergeRequest } from '../../src/api/types';
import { selectedCapabilityData } from './graphqlFixture';

// Purpose-built wire-contract examples, NOT a captured CE schema or live test.
// Exact tag references are recorded in the fixture; positive optional GraphQL
// responses below exercise permission handling only when a server exposes them.
const contract = JSON.parse(readFileSync(path.join(process.cwd(), 'test/fixtures/gitlab-ce-16.11.10-contract.json'), 'utf8'));
const user = { id: 9, username: 'contract-user', name: 'Contract User' };
const issue = { ...contract.issue, updated_at: '2024-04-18T10:00:00Z' };
const refs = { base_sha: 'a'.repeat(40), start_sha: 'b'.repeat(40), head_sha: 'c'.repeat(40) };
const request: GitLabMergeRequest = { id: 51, iid: 1, project_id: 4, title: 'Contract MR', state: 'opened',
  source_branch: 'feature', target_branch: 'main', web_url: 'https://gitlab.test/team/one/-/merge_requests/1',
  diff_refs: refs, reviewers: [user], assignees: [user] };
const version = { id: 8, base_commit_sha: refs.base_sha, start_commit_sha: refs.start_sha, head_commit_sha: refs.head_sha,
  state: 'collected', real_size: '1', diffs: [{ old_path: 'a.ts', new_path: 'a.ts', diff: '@@ -1 +1 @@\n-a\n+b' }] };
const timeStats = { time_estimate: 7200, total_time_spent: 1800, human_time_estimate: '2h', human_total_time_spent: '30m' };

const loader = require('node:module'), original = loader._load;
loader._load = (name: string, ...args: unknown[]) => name === 'vscode' ? {} : original(name, ...args);
let Panels: typeof import('../../src/issues/issuePanel').IssuePanels, WorkspacePanel: any;
try { Panels = require('../../src/issues/issuePanel').IssuePanels; ({ WorkspacePanel } = require('../../src/workspace/workspacePanel')); }
finally { loader._load = original; }

class MemoryStore implements Memento {
  readonly values = new Map<string, unknown>();
  get<T>(key: string, fallback?: T): T | undefined { return this.values.has(key) ? this.values.get(key) as T : fallback; }
  keys(): readonly string[] { return [...this.values.keys()]; }
  async update(key: string, value: unknown): Promise<void> { if (value === undefined) this.values.delete(key); else this.values.set(key, value); }
}

function fixture() {
  const calls: Array<{ url: URL; method: string; body?: Record<string, any>; headers: Headers }> = [];
  const fetcher: FetchLike = async (input, init) => {
    const url = new URL(String(input)), method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ url, method, body, headers: new Headers(init?.headers) });
    let payload: unknown;
    if (url.pathname.endsWith('/user')) payload = user;
    else if (url.pathname.endsWith('/metadata') || url.pathname.endsWith('/version')) payload = { version: contract.version, enterprise: contract.enterprise, revision: 'synthetic-contract' };
    else if (url.pathname.endsWith('/graphql')) {
      const query = String(body.query);
      payload = { data: query.includes('CanCreateIssue') ? { project: { userPermissions: { createIssue: true } } }
        : query.includes('IssuePermissions') ? { project: { issue: { userPermissions: { updateIssue: true, adminIssue: false, createNote: true } } } }
        : selectedCapabilityData(query, contract.types) };
    } else if (url.pathname.endsWith('/groups/42/projects')) payload = [contract.project];
    else if (url.pathname.endsWith('/groups/42/merge_requests')) payload = [request];
    else if (url.pathname.endsWith('/versions/8')) payload = version;
    else if (url.pathname.endsWith('/versions')) payload = [version];
    else if (/\/(?:time_estimate|add_spent_time|reset_time_estimate|reset_spent_time)$/.test(url.pathname)) payload = timeStats;
    else if (url.pathname.endsWith('/merge_requests/1')) payload = request;
    else if (url.pathname.endsWith('/issues/1') || url.pathname.endsWith('/issues')) payload = { ...issue, ...(method !== 'GET' ? { title: body.title ?? issue.title } : {}) };
    else if (url.pathname.endsWith('/projects/4')) payload = contract.project;
    else throw new Error(`Unexpected contract request: ${method} ${url.pathname}`);
    return new Response(JSON.stringify(payload), { headers: { 'content-type': 'application/json' } });
  };
  const gate = { fetch: async (fetcher: FetchLike, input: URL, init: RequestInit, _safe: boolean, _limit: number, onStart?: () => void) => { onStart?.(); return fetcher(input, init); } } as unknown as GitLabNetworkGate;
  const client = new GitLabClient('https://gitlab.test', 'contract-token', fetcher, undefined, undefined, undefined, undefined, 30_000, gate);
  const state = new MemoryStore(), secrets = new Map<string, string>();
  const session = new GitLabSession({ get: async key => secrets.get(key), store: async (key, value) => { secrets.set(key, value); }, delete: async key => { secrets.delete(key); }, onDidChange: () => ({ dispose() {} }) } as SecretStorage, state, true);
  // Keep the real Session account transition and the real Client wire methods,
  // replacing only its transport factory with our no-network Client.
  (session as unknown as { makeClient(): GitLabClient }).makeClient = () => client;
  return { calls, client, session, state, secrets };
}

test('CE 16.11.10 contract login verifies /user and preserves exact CE metadata without claiming live acceptance', async () => {
  const f = fixture();
  const connected = await f.session.connect('https://gitlab.test/', 'contract-token');
  assert.equal(connected.id, 9); assert.equal(f.session.baseUrl, 'https://gitlab.test');
  assert.equal(f.calls[0].url.pathname, '/api/v4/user'); assert.equal(f.calls[0].headers.get('PRIVATE-TOKEN'), 'contract-token');
  await f.session.ensureMetadataChecked();
  assert.equal(f.session.metadata?.version, '16.11.10'); assert.equal(f.session.metadata?.enterprise, false);
  assert.equal(contract.liveVerified, false); assert.match(contract.note, /not an exported CE schema or live acceptance evidence/);
  assert.ok([...f.secrets.values()].includes('contract-token'));
});

test('CE 16.11.10 contract Group Project inventory requests one 100-result page with subgroup and shared boundaries', async () => {
  const f = fixture();
  const page = await f.client.listGroupProjectsPage(42);
  assert.equal(f.calls.length, 1); assert.equal(page.items[0].id, 4); assert.equal(page.complete, true);
  assert.equal(f.calls[0].url.searchParams.get('per_page'), '100');
  assert.equal(f.calls[0].url.searchParams.get('include_subgroups'), 'true');
  assert.equal(f.calls[0].url.searchParams.get('with_shared'), 'false');
});

test('CE 16.11.10 contract Issue create/update retain REST fields and enforce the optimistic update preflight', async () => {
  const f = fixture();
  assert.equal((await f.client.createIssue(4, { title: 'New', description: 'Body', assigneeId: 9, labels: ['bug'], milestoneId: 3, dueDate: '2024-05-01', confidential: true })).title, 'New');
  assert.deepEqual(f.calls[0].body, { title: 'New', description: 'Body', assignee_id: 9, labels: 'bug', milestone_id: 3, due_date: '2024-05-01', confidential: true });
  assert.equal(f.calls[0].method, 'POST'); assert.equal(f.calls[0].url.pathname, '/api/v4/projects/4/issues');
  await f.client.updateIssueIfUnchanged(4, 1, issue.updated_at, { title: 'Edited', assigneeId: null, labels: [], milestoneId: null, dueDate: null, stateEvent: 'close' });
  assert.equal(f.calls[1].method, 'GET'); assert.equal(f.calls[2].method, 'PUT');
  assert.deepEqual(f.calls[2].body, { title: 'Edited', assignee_ids: [], labels: '', milestone_id: 0, due_date: '', state_event: 'close' });
  const writes = f.calls.filter(call => call.method === 'PUT').length;
  await assert.rejects(f.client.updateIssueIfUnchanged(4, 1, 'stale', { title: 'Rejected' }), /changed/);
  assert.equal(f.calls.filter(call => call.method === 'PUT').length, writes);
});

test('CE 16.11.10 permission wire contract honors explicit grants and denials without inventing missing permission fields', async () => {
  const f = fixture();
  assert.equal(await f.client.canCreateIssue('team/one'), true);
  const permissions = await f.client.getIssuePermissions('team/one', 1, ['updateIssue', 'adminIssue', 'createNote']);
  assert.deepEqual(permissions, { updateIssue: true, adminIssue: false, createNote: true });
  assert.ok(f.calls.every(call => call.url.pathname === '/api/graphql'));
  assert.deepEqual(f.calls[1].body?.variables, { path: 'team/one', iid: '1' });
  const conservative = await f.client.getIssueCapabilities();
  assert.equal(conservative.createPermission, false, 'the synthetic missing-field probe does not assert CE permission capability support');
});

test('CE 16.11.10 time contract uses REST estimate/spent-time endpoints independently of optional GraphQL timelog mutations', async () => {
  const f = fixture();
  assert.deepEqual(await f.client.setTimeEstimate(4, 1, '2h'), timeStats);
  assert.deepEqual(await f.client.addSpentTime(4, 1, '30m', 'Work completed'), timeStats);
  await f.client.resetTimeEstimate(4, 1); await f.client.resetSpentTime(4, 1);
  assert.deepEqual(f.calls.map(call => [call.method, call.url.pathname.split('/').at(-1), call.body]), [
    ['POST', 'time_estimate', { duration: '2h' }], ['POST', 'add_spent_time', { duration: '30m', summary: 'Work completed' }],
    ['POST', 'reset_time_estimate', {}], ['POST', 'reset_spent_time', {}]
  ]);
  assert.equal(f.calls.some(call => call.url.pathname.endsWith('/graphql')), false);
});

test('CE 16.11.10 missing subtask capability keeps child creation disabled and sends no GraphQL mutation', async () => {
  const f = fixture(); await f.session.connect('https://gitlab.test', 'contract-token'); await f.session.ensureInstanceChecked();
  assert.equal(f.session.issueCapabilities?.childMutations, false); assert.equal(f.session.issueCapabilities?.hierarchy, false);
  const panels = new Panels!({} as ExtensionContext, f.session, () => {});
  Object.assign(panels, { ready: true, suspended: true, issue, mode: 'detail', lastSnapshot: { type: 'detailData', data: { issue, project: contract.project, canManageChildren: false } } });
  const before = f.calls.length;
  try {
    await assert.rejects(panels.handle({ type: 'invoke', issueId: issue.id, action: 'createChild', payload: { title: 'Unsupported child' } }), /permission|child/i);
    assert.equal(f.calls.length, before);
    assert.equal(f.calls.some(call => /^\s*mutation\b/.test(String(call.body?.query))), false);
  } finally { panels.dispose(); }
});

test('CE 16.11.10 MR contract reads exact diff versions and server filters while Host blocks approval writes for CE', async () => {
  const f = fixture();
  assert.equal((await f.client.getMergeRequest(4, 1)).iid, 1);
  await f.client.listGroupMergeRequestsPage(42, undefined, { filter: 'reviewer', userId: 9 });
  await f.client.listGroupMergeRequestsPage(42, undefined, { filter: 'assigned', userId: 9 });
  assert.equal(f.calls[1].url.searchParams.get('reviewer_id'), '9'); assert.equal(f.calls[2].url.searchParams.get('assignee_id'), '9');
  assert.equal(f.calls[1].url.searchParams.get('per_page'), '100');
  assert.equal(await f.client.findMergeRequestDiffVersion(4, 1, refs), 8);
  const diff = await f.client.getMergeRequestDiffVersion(4, 1, 8, refs);
  assert.equal(diff.versionId, 8); assert.equal(diff.truncated, false); assert.deepEqual(diff.diffRefs, refs);
  await f.session.connect('https://gitlab.test', 'contract-token'); await f.session.ensureMetadataChecked();
  assert.equal(f.session.capabilityDiagnostics.find(item => item.id === 'mergeRequestApprovals')?.status, 'unsupported');
  const host = Object.create(WorkspacePanel.prototype); Object.assign(host, { session: f.session });
  const before = f.calls.length;
  await assert.rejects(host.approveMergeRequest(4, 1, refs.head_sha), /Community Edition/);
  assert.equal(f.calls.length, before); assert.equal(f.calls.some(call => call.url.pathname.endsWith('/approve')), false);
});
