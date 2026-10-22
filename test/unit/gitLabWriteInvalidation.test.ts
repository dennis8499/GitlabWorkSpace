import assert from 'node:assert/strict';
import test from 'node:test';
import type { Memento, SecretStorage } from 'vscode';
import { GitLabClient, GitLabWriteUnknownError, type FetchLike, type GitLabWriteContext } from '../../src/api/gitLabClient';
import type { GitLabNetworkGate } from '../../src/api/gitLabNetworkGate';
import { GitLabRequestBudget } from '../../src/api/gitLabRequestBudget';
import { GitLabSession } from '../../src/connection/session';

class State implements Memento {
  private readonly values = new Map<string, unknown>([
    ['gitlabWorkspace.baseUrl', 'https://gitlab.example.test'],
    ['gitlabWorkspace.selectedGroupId', 99], ['gitlabWorkspace.selectedGroupLabel', 'other-group']
  ]);
  get<T>(key: string, fallback?: T): T | undefined { return (this.values.get(key) as T | undefined) ?? fallback; }
  async update(key: string, value: unknown): Promise<void> { this.values.set(key, value); }
  keys(): readonly string[] { return [...this.values.keys()]; }
}

function fixture() {
  const callbacks: GitLabWriteContext[] = [], counts = new Map<string, number>();
  const state = new State(), session = new GitLabSession({} as SecretStorage, state, true);
  let graphBody: unknown = { data: { discussionToggleResolve: { errors: [] } } };
  let failure: Error | undefined;
  let rawGraph: string | undefined;
  const fetcher: FetchLike = async (input, init) => {
    const url = new URL(String(input)), method = init?.method ?? 'GET';
    const key = `${method} ${url.pathname}`; counts.set(key, (counts.get(key) ?? 0) + 1);
    if (failure) throw failure;
    if (url.pathname.endsWith('/graphql')) {
      return new Response(rawGraph ?? JSON.stringify(graphBody), { headers: { 'content-type': 'application/json' } });
    }
    if (url.pathname === '/api/v4/groups/99/projects') {
      return new Response(JSON.stringify([{ id: 202, path: 'other', path_with_namespace: 'parent/other' }]),
        { headers: { 'content-type': 'application/json', 'x-next-page': '2' } });
    }
    let value: unknown = [];
    if (url.pathname.endsWith('/user')) value = { id: 7, username: 'user', name: 'User' };
    if (/\/groups\/42\/projects$/.test(url.pathname)) value = [{ id: 101, path: 'repo', path_with_namespace: 'group/repo' }];
    if (/\/projects\/\d+$/.test(url.pathname)) value = { id: Number(url.pathname.split('/').at(-1)), path: 'repo', path_with_namespace: 'group/repo' };
    if (/\/issues\/\d+$/.test(url.pathname)) value = { id: 1, iid: Number(url.pathname.split('/').at(-1)), project_id: 101 };
    return new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
  };
  // This gate calls only the injected fake; no coordination files or network are used.
  const gate = { fetch: async (read: FetchLike, input: URL, init: RequestInit, _safe?: boolean, _limit?: number, onStart?: () => void) => {
    onStart?.(); return read(input, init);
  } } as unknown as GitLabNetworkGate;
  const client = new GitLabClient('https://gitlab.example.test', 'unit-only-token', fetcher, undefined, context => {
    callbacks.push(context);
    (session as unknown as { invalidateAfterWrite(context: GitLabWriteContext): void }).invalidateAfterWrite(context);
  }, undefined, undefined, 30_000, gate);
  (session as unknown as { getClient(): Promise<GitLabClient> }).getClient = async () => client;
  return { client, session, callbacks, counts,
    graph: (body: unknown) => { graphBody = body; }, fail: (error?: Error) => { failure = error; },
    raw: (value: string) => { rawGraph = value; } };
}

test('GraphQL mutations notify once and derived clients retain only their explicit GraphQL scope', async () => {
  const f = fixture(), scope = { projectId: 101, issueIid: 1, resource: 'issues' as const };
  const budget = new GitLabRequestBudget({ requests: 10 });
  try {
    const scoped = f.client.withWriteScope(scope).withReadSignal(new AbortController().signal).withRequestBudget(budget);
    await scoped.resolveIssueThread('42', true);
    assert.deepEqual(f.callbacks, [{ url: 'https://gitlab.example.test/api/graphql', method: 'POST', scope }]);
    assert.equal(f.counts.get('POST /api/graphql'), 1);
    await scoped.addIssueNote(101, 1, 'Comment');
    assert.equal(f.callbacks.length, 2);
    assert.equal(f.callbacks[1].scope, undefined, 'REST writes must use their URL, including cross-Project operations');
    await f.client.resolveIssueThread('42', false);
    assert.equal(f.callbacks.length, 3);
    assert.equal(f.callbacks[2].scope, undefined, 'the original client is unchanged');
  } finally { budget.dispose(); }
});

for (const [name, body, message, notifications] of [
  ['payload errors', { data: { discussionToggleResolve: { errors: ['Permission denied'] } } }, 'Permission denied', 1],
  ['partial execution errors', { data: { discussionToggleResolve: { errors: [] } }, errors: [{ message: 'Later field failed' }] }, 'Later field failed', 1],
  ['null execution result', { data: null, errors: [{ message: 'Execution failed' }] }, 'Execution failed', 1],
  ['request errors before execution', { errors: [{ message: 'Invalid mutation' }] }, 'Invalid mutation', 0]
] as const) {
  test(`GraphQL ${name} retain conservative single invalidation without retrying`, async () => {
    const f = fixture(); f.graph(body);
    await assert.rejects(f.client.withWriteScope({ projectId: 101, issueIid: 1, resource: 'issues' }).resolveIssueThread('42', true),
      error => error instanceof Error && error.message === message);
    assert.equal(f.callbacks.length, notifications);
    assert.equal(f.counts.get('POST /api/graphql'), 1);
  });
}

for (const kind of ['transport', 'invalid-json'] as const) {
  test(`an uncertain GraphQL ${kind} failure expires reads once without retrying the mutation`, async () => {
    const f = fixture();
    if (kind === 'transport') f.fail(new TypeError('Connection closed after sending')); else f.raw('{');
    await assert.rejects(f.client.withWriteScope({ projectId: 101, resource: 'issues' }).resolveIssueThread('42', true), GitLabWriteUnknownError);
    assert.equal(f.callbacks.length, 1);
    assert.equal(f.callbacks[0].scope?.projectId, 101);
    assert.equal(f.counts.get('POST /api/graphql'), 1);
  });
}

for (const body of [null, [], 'invalid-envelope']) {
  test(`a malformed GraphQL envelope (${JSON.stringify(body)}) preserves unknown writes and never invalidates queries`, async () => {
    const f = fixture(); f.graph(body);
    await assert.rejects(f.client.withWriteScope({ projectId: 101, resource: 'issues' }).resolveIssueThread('42', true), GitLabWriteUnknownError);
    assert.equal(f.callbacks.length, 1);
    await assert.rejects(f.client.graphql('query ReadOnly { currentUser { id } }', {}), /invalid GraphQL response/);
    assert.equal(f.callbacks.length, 1);
    assert.equal(f.counts.get('POST /api/graphql'), 2, 'each read/write is sent once through the fake gate');
  });
}

function cacheReads(f: ReturnType<typeof fixture>) {
  const reads: Array<[string, (client: GitLabClient) => Promise<unknown>]> = [
    ['current-user', c => c.getCurrentUser()],
    ['group/42/projects', c => c.listGroupProjects(42)],
    ['group/42/assigned-issues', c => c.listAssignedGroupIssues(42)],
    ['group/77/assigned-issues', c => c.listAssignedGroupIssues(77)],
    ['project/101/details', c => c.getProject(101)],
    ['project/101/members', c => c.listProjectMembers(101)],
    ['project/101/labels', c => c.listProjectLabels(101)],
    ['project/101/milestones', c => c.listProjectMilestones(101)],
    ['project/101/template-names', c => c.listProjectIssueTemplateNames(101)],
    ['project/101/issue/1', c => c.getIssue(101, 1)],
    ['project/101/issue/2', c => c.getIssue(101, 2)],
    ['project/202/issue/1', c => c.getIssue(202, 1)]
  ];
  return () => Promise.all(reads.map(([key, load]) => f.session.cachedRead(key, load)));
}

test('scoped GraphQL writes reload affected Issue reads while retaining options, inventory and unrelated Group HTTP results', async () => {
  const f = fixture(), read = cacheReads(f);
  await read();
  const changes: unknown[] = []; f.session.onDidInvalidateReads(change => changes.push(change));
  await f.client.withWriteScope({ projectId: 101, issueIid: 1, resource: 'issues' }).resolveIssueThread('42', true);
  await read();
  assert.equal(f.counts.get('GET /api/v4/projects/101/issues/1'), 2);
  assert.equal(f.counts.get('GET /api/v4/projects/101/issues/2'), 2, 'GraphQL can also affect children in the same Project');
  assert.equal(f.counts.get('GET /api/v4/groups/42/issues'), 2);
  for (const path of ['user', 'groups/42/projects', 'groups/77/issues', 'projects/101', 'projects/101/members/all',
    'projects/101/labels', 'projects/101/milestones', 'projects/101/templates/issues', 'projects/202/issues/1']) {
    assert.equal(f.counts.get('GET /api/v4/' + path), 1, path);
  }
  assert.deepEqual(changes, [{ groupIds: [42, 99], projectId: 101, resource: 'issues' }]);
});

test('a partial current parent Group inventory cannot suppress Issue, Board and graph invalidation', async () => {
  const f = fixture(), read = cacheReads(f); await read();
  const parentPage = () => f.session.cachedRead('group/99/projects/pages/opened/first', c => c.listGroupProjectsPage(99));
  const page = await parentPage();
  assert.equal(page.complete, false); assert.deepEqual(page.items.map(project => project.id), [202]);
  let boardReads = 0, graphReads = 0;
  const parentReads = () => Promise.all([
    f.session.cachedRead('group/99/assigned-issues', c => c.listAssignedGroupIssues(99)),
    f.session.cachedRead('group-board/99/9/memberships', async () => ++boardReads),
    f.session.cachedRead('group/99/graph/context', async () => ++graphReads)
  ]);
  await parentReads();
  await f.client.withWriteScope({ projectId: 101, issueIid: 1, resource: 'issues' }).resolveIssueThread('42', true);
  await parentReads(); await parentPage(); await read();
  assert.equal(f.counts.get('GET /api/v4/groups/99/issues'), 2);
  assert.deepEqual([boardReads, graphReads], [2, 2]);
  assert.equal(f.counts.get('GET /api/v4/groups/99/projects'), 1, 'the partial Project inventory remains cached');
  assert.equal(f.counts.get('GET /api/v4/groups/77/issues'), 1, 'a noncurrent unrelated Group remains cached');
});

test('REST comments and reactions retain options and other Issues while bare Issue edits still expire label options', async () => {
  const f = fixture(), read = cacheReads(f);
  await read();
  await f.client.addIssueNote(101, 1, 'Comment'); await read();
  await f.client.addIssueReaction(101, 1, 'thumbsup'); await read();
  assert.equal(f.counts.get('GET /api/v4/projects/101/issues/1'), 3);
  assert.equal(f.counts.get('GET /api/v4/projects/101/issues/2'), 1);
  assert.equal(f.counts.get('GET /api/v4/projects/101/labels'), 1);
  assert.equal(f.counts.get('GET /api/v4/projects/101'), 1);
  await f.client.updateIssue(101, 1, { labels: ['new-label'] }); await read();
  assert.equal(f.counts.get('GET /api/v4/projects/101/labels'), 2, 'Issue writes can create labels');
  assert.equal(f.counts.get('GET /api/v4/projects/101'), 2);
  await f.client.createIssue(101, { title: 'New Issue', labels: ['another-label'] }); await read();
  assert.equal(f.counts.get('GET /api/v4/projects/101/labels'), 3, 'creating Issues can also create labels');
});

test('MR comments retain options while bare MR creation preserves the conservative Project invalidation', async () => {
  const f = fixture(), read = cacheReads(f); await read();
  await f.client.createMergeRequestNote(101, 1, 'Review comment'); await read();
  assert.equal(f.counts.get('GET /api/v4/projects/101/labels'), 1);
  await f.client.createMergeRequest(101, { title: 'Review', sourceBranch: 'feature', targetBranch: 'main' }); await read();
  assert.equal(f.counts.get('GET /api/v4/projects/101/labels'), 2);
});

for (const kind of ['note', 'thread', 'reply', 'edit', 'mr-note'] as const) {
  test(`${kind} quick actions keep the cross-resource invalidation fallback without extra HTTP`, async () => {
    const f = fixture(), read = cacheReads(f); await read();
    const body = kind === 'note' ? 'Move this Issue\n/move other-group/project' : kind === 'thread' ? '/label ~new-label'
      : kind === 'reply' ? 'Summary\n/spend 1h 2026-10-22' : '  /close';
    if (kind === 'note') await f.client.addIssueNote(101, 1, body);
    else if (kind === 'thread') await f.client.createIssueThread(101, 1, body);
    else if (kind === 'reply') await f.client.replyToIssueThread(101, 1, 'thread', body);
    else if (kind === 'edit') await f.client.updateIssueNote(101, 1, 'thread', 3, body);
    else await f.client.createMergeRequestNote(101, 1, body);
    assert.equal(f.callbacks.length, 1);
    assert.equal(f.callbacks[0].invalidateAll, true);
    assert.equal([...f.counts].filter(([key]) => !key.startsWith('GET ')).reduce((sum, [, count]) => sum + count, 0), 1,
      'quick actions are submitted once without preflight or retry');
    await read();
    for (const path of ['user', 'projects/101/labels', 'projects/202/issues/1', 'groups/77/issues']) {
      assert.equal(f.counts.get('GET /api/v4/' + path), 2, path);
    }
  });
}

test('an uncertain quick-action write invalidates target/options once while a failed read never invalidates', async () => {
  const f = fixture(), read = cacheReads(f); await read();
  const changes: unknown[] = []; f.session.onDidInvalidateReads(change => changes.push(change));
  f.fail(new TypeError('Connection closed after sending'));
  await assert.rejects(f.client.addIssueNote(101, 1, '/move other-group/project'), GitLabWriteUnknownError);
  assert.equal(f.counts.get('POST /api/v4/projects/101/issues/1/notes'), 1);
  assert.equal(f.callbacks.length, 1); assert.equal(f.callbacks[0].invalidateAll, true);
  assert.deepEqual(changes, [{ groupIds: [], resource: 'all' }]);
  f.fail(); await read(); await read();
  assert.equal(f.counts.get('GET /api/v4/projects/101/labels'), 2);
  assert.equal(f.counts.get('GET /api/v4/projects/202/issues/1'), 2);
  f.fail(new TypeError('Read failed'));
  await assert.rejects(f.client.getProject(101), /Read failed/);
  assert.equal(f.callbacks.length, 1, 'read errors cannot invalidate a write cache');
});

test('unscoped GraphQL and cross-Project REST writes retain the full invalidation fallback', async () => {
  for (const action of ['graphql', 'move', 'clone', 'merge'] as const) {
    const f = fixture(), read = cacheReads(f); await read();
    if (action === 'graphql') await f.client.resolveIssueThread('42', true);
    else if (action === 'move') await f.client.withWriteScope({ projectId: 101, issueIid: 1, resource: 'issues' }).moveIssue(101, 1, 202);
    else if (action === 'clone') await f.client.withWriteScope({ projectId: 101, issueIid: 1, resource: 'issues' }).cloneIssue(101, 1, 202);
    else await f.client.mergeMergeRequest(101, 1, 'source-sha');
    assert.equal([...f.counts].filter(([key]) => !key.startsWith('GET ')).reduce((sum, [, count]) => sum + count, 0), 1, action);
    await read();
    assert.equal(f.counts.get('GET /api/v4/user'), 2, action);
    assert.equal(f.counts.get('GET /api/v4/projects/101/labels'), 2, action);
    assert.equal(f.counts.get('GET /api/v4/projects/202/issues/1'), 2, action);
    assert.equal(f.counts.get('GET /api/v4/projects/101'), 2, action);
    assert.equal(f.counts.get('GET /api/v4/projects/101/issues/1'), 2, action);
    assert.equal(f.counts.get('GET /api/v4/groups/77/issues'), 2, action);
  }
});
