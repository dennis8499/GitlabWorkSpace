import assert from 'node:assert/strict';
import test from 'node:test';
import { GitLabClient } from '../../src/api/gitLabClient';
import type { GitLabMergeRequest } from '../../src/api/types';

const mergeRequest = (projectId: number, iid: number, title: string): GitLabMergeRequest => ({
  id: projectId * 100 + iid, project_id: projectId, iid, title, state: 'opened', web_url: `https://gitlab.example/group/project/-/merge_requests/${iid}`,
  source_branch: 'feature/update', target_branch: 'main', sha: `sha-${iid}`
});

test('loads all opened Group Merge Requests without reviewer or assignee restrictions', async () => {
  const requested: string[] = [];
  const me = { id: 9, username: 'me', name: 'Me' };
  const other = { id: 10, username: 'other', name: 'Other' };
  const payload = [
    { ...mergeRequest(4, 1, 'Reviewer only'), reviewers: [me], assignees: [] },
    { ...mergeRequest(4, 2, 'Assignee only'), reviewers: [], assignees: [me] },
    { ...mergeRequest(5, 1, 'Both'), reviewers: [me], assignees: [me] },
    { ...mergeRequest(5, 2, 'Neither'), reviewers: [other], assignees: [other] }
  ];
  const client = new GitLabClient('https://gitlab.example/gitlab', 'token', async (input) => {
    const url = new URL(String(input));
    requested.push(url.toString());
    return new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json' } });
  });
  const rows = await client.listGroupMergeRequests(21);
  assert.deepEqual(rows, payload);
  assert.equal(requested.length, 1);
  const url = new URL(requested[0]);
  assert.equal(url.pathname, '/gitlab/api/v4/groups/21/merge_requests');
  assert.equal(url.searchParams.get('scope'), 'all');
  assert.equal(url.searchParams.get('state'), 'opened');
  assert.equal(url.searchParams.has('reviewer_id'), false);
  assert.equal(url.searchParams.has('assignee_id'), false);
});

test('paginates the Group MR list, deduplicates across pages and excludes closed or merged requests', async () => {
  const requested: URL[] = [];
  const firstPage = Array.from({ length: 100 }, (_, index) => mergeRequest(4, index + 1, `MR ${index + 1}`));
  const subgroupRequest = mergeRequest(5, 1, 'Subgroup MR');
  const client = new GitLabClient('https://gitlab.example', 'token', async (input) => {
    const url = new URL(String(input));
    requested.push(url);
    const page = Number(url.searchParams.get('page') ?? 1);
    const payload = page === 1 ? firstPage : [
      subgroupRequest,
      firstPage[0],
      { ...mergeRequest(4, 101, 'Closed'), state: 'closed' },
      { ...mergeRequest(4, 102, 'Merged'), state: 'merged' }
    ];
    return new Response(JSON.stringify(payload), { status: 200, headers: {
      'content-type': 'application/json', 'x-next-page': page === 1 ? '2' : ''
    } });
  });
  const rows = await client.listGroupMergeRequests(21);
  assert.deepEqual(rows, [...firstPage, subgroupRequest]);
  assert.equal(requested.length, 2);
  assert.equal(requested[1].searchParams.get('page'), '2');
  assert.ok(requested.every(url => url.searchParams.get('state') === 'opened' && url.searchParams.get('per_page') === '100'));
});

test('paginates Merge Request diffs without truncating at 200 files', async () => {
  const requested: string[] = [];
  const client = new GitLabClient('https://gitlab.example', 'token', async (input) => {
    const url = new URL(String(input));
    requested.push(url.toString());
    const page = Number(url.searchParams.get('page') ?? 1);
    const files = Array.from({ length: 100 }, (_, index) => ({ old_path: `file-${page}-${index}.txt`, new_path: `file-${page}-${index}.txt`, diff: '+updated' }));
    return new Response(JSON.stringify(files), { status: 200, headers: { 'content-type': 'application/json', 'x-next-page': page < 3 ? String(page + 1) : '' } });
  });
  const diffs = await client.listMergeRequestDiffs(4, 8);
  assert.equal(diffs.length, 300);
  assert.equal(requested.length, 3);
  assert.ok(requested.every((url) => url.includes('/merge_requests/8/diffs')));
});

test('encodes source branches and pins approvals and merges to the reviewed MR SHA', async () => {
  const calls: Array<{ url: string; method: string; body?: unknown }> = [];
  const client = new GitLabClient('https://gitlab.example', 'secret-token', async (input, init) => {
    const url = String(input);
    const body = init?.body ? JSON.parse(String(init.body)) as unknown : undefined;
    calls.push({ url, method: init?.method ?? 'GET', body });
    const payload = url.includes('source_branch=') ? [] : url.includes('/merge_requests/3/merge') ? mergeRequest(4, 3, 'Merged') : {};
    return new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json' } });
  });
  const result = await client.findOpenMergeRequestsBySourceBranch(4, 'feature/with space');
  assert.deepEqual(result, []);
  assert.match(calls[0].url, /source_branch=feature%2Fwith%20space/);
  await client.approveMergeRequest(4, 3, 'reviewed-sha');
  await client.mergeMergeRequest(4, 3, 'reviewed-sha');
  assert.deepEqual(calls.slice(1).map((call) => [call.method, call.body]), [
    ['POST', { sha: 'reviewed-sha' }], ['PUT', { sha: 'reviewed-sha' }]
  ]);
  assert.ok(calls.every((call) => !call.url.includes('secret-token')));
});
