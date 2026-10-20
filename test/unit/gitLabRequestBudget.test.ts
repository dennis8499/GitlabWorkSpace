import assert from 'node:assert/strict';
import test from 'node:test';
import { GitLabClient } from '../../src/api/gitLabClient';
import { GitLabRequestBudget } from '../../src/api/gitLabRequestBudget';

test('scoped clones share the actual HTTP allowance including transparent read retries', async () => {
  let calls = 0;
  const client = new GitLabClient('https://budget-retry.example.test', 'synthetic', async () => {
    calls++; return new Response('{}', { status: 503, headers: { 'Retry-After': '0' } });
  });
  const budget = new GitLabRequestBudget({ requests: 2 });
  try {
    const scoped = client.withRequestBudget(budget);
    await assert.rejects(scoped.withReadSignal(new AbortController().signal).getCurrentUser(), { name: 'GitLabBudgetExceededError', budget: 'requests' });
    await assert.rejects(scoped.getMetadata(), { name: 'GitLabBudgetExceededError' });
    assert.equal(calls, 2); assert.equal(budget.usedRequests, 2);
  } finally { budget.dispose(); }
});

test('byte and hard wall-time budgets interrupt response streams and prevent later requests', async () => {
  let calls = 0, cancelled = false;
  const client = new GitLabClient('https://budget-stream.example.test', 'synthetic', async () => {
    calls++; return new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(9)); }, cancel() { cancelled = true; } }));
  });
  const bytes = new GitLabRequestBudget({ bytes: 8 });
  try {
    await assert.rejects(client.withRequestBudget(bytes).getCurrentUser(), { name: 'GitLabBudgetExceededError', budget: 'bytes' });
    assert.equal(cancelled, true); assert.equal(calls, 1);
  } finally { bytes.dispose(); }
  cancelled = false;
  const deadline = new GitLabRequestBudget({ timeoutMs: 100 });
  try {
    await assert.rejects(client.withRequestBudget(deadline).getCurrentUser());
    assert.equal(cancelled, true);
    await assert.rejects(client.withRequestBudget(deadline).getMetadata());
    assert.equal(calls, 2, 'expired work must not schedule another HTTP request');
  } finally { deadline.dispose(); }
});

test('Board list and membership pages resume without replay and preserve a failed checkpoint', async () => {
  const client = new GitLabClient('https://budget-board.example.test', 'synthetic', async () => { throw new Error('unexpected network'); });
  const visited: string[] = []; let fail = true;
  client.graphql = async <T>(_query: string, variables: Record<string, unknown>): Promise<T> => {
    visited.push(`${variables.listId ?? 'lists'}:${variables.after ?? 'start'}`);
    if (!variables.listId) return { group: { board: { hideBacklogList: false, hideClosedList: false, lists: { nodes: [{ id: 'gid://gitlab/List/1', listType: 'label' }], pageInfo: { hasNextPage: false } } } } } as T;
    if (!variables.after) return { boardList: { issues: { nodes: [{ id: 'gid://gitlab/Issue/101', projectId: 5, iid: 1 }], pageInfo: { hasNextPage: true, endCursor: 'next' } } } } as T;
    if (fail) throw new Error('synthetic interruption');
    return { boardList: { issues: { nodes: [{ id: 'gid://gitlab/Issue/102', projectId: 5, iid: 2 }], pageInfo: { hasNextPage: false } } } } as T;
  };
  const lists = await client.listGroupBoardIssueMembershipsPage('team', 1);
  const first = await client.listGroupBoardIssueMembershipsPage('team', 1, lists.nextCursor);
  const before = JSON.stringify(first.nextCursor);
  await assert.rejects(client.listGroupBoardIssueMembershipsPage('team', 1, first.nextCursor), /synthetic interruption/);
  assert.equal(JSON.stringify(first.nextCursor), before);
  fail = false;
  const last = await client.listGroupBoardIssueMembershipsPage('team', 1, first.nextCursor);
  assert.deepEqual([...first.items, ...last.items].map(item => item.issueId), [101, 102]);
  assert.equal(last.complete, true); assert.equal(last.nextCursor, undefined);
  assert.deepEqual(visited, ['lists:start', 'gid://gitlab/List/1:start', 'gid://gitlab/List/1:next', 'gid://gitlab/List/1:next']);
  await assert.rejects(client.listGroupBoardIssueMembershipsPage('other-team', 1, first.nextCursor), /different or invalid scope/);
});
