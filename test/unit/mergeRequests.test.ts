import assert from 'node:assert/strict';
import test from 'node:test';
import { GitLabClient } from '../../src/api/gitLabClient';
import type { GitLabMergeRequest } from '../../src/api/types';

const mergeRequest = (projectId: number, iid: number, title: string): GitLabMergeRequest => ({
  id: projectId * 100 + iid, project_id: projectId, iid, title, state: 'opened', web_url: `https://gitlab.example/group/project/-/merge_requests/${iid}`,
  source_branch: 'feature/update', target_branch: 'main', sha: `sha-${iid}`
});

test('loads assigned and review-requested Group MRs, then deduplicates by project and IID', async () => {
  const requested: string[] = [];
  const client = new GitLabClient('https://gitlab.example/gitlab', 'token', async (input) => {
    const url = new URL(String(input));
    requested.push(url.toString());
    const payload = url.searchParams.get('scope') === 'assigned_to_me'
      ? [mergeRequest(4, 7, 'Assigned'), mergeRequest(4, 8, 'Both')]
      : [mergeRequest(4, 8, 'Both'), mergeRequest(5, 7, 'Review')];
    return new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json' } });
  });
  const rows = await client.listGroupMergeRequests(21);
  assert.deepEqual(rows.map((item) => [item.project_id, item.iid]), [[4, 7], [4, 8], [5, 7]]);
  assert.ok(requested.some((url) => url.includes('/api/v4/groups/21/merge_requests') && url.includes('scope=assigned_to_me')));
  assert.ok(requested.some((url) => url.includes('scope=reviews_for_me')));
});

test('keeps assigned MRs when an older GitLab does not support review-requested scope', async () => {
  const client = new GitLabClient('https://gitlab.example', 'token', async (input) => {
    const url = new URL(String(input));
    if (url.searchParams.get('scope') === 'reviews_for_me') return new Response(JSON.stringify({ message: 'scope is unsupported' }), { status: 400 });
    return new Response(JSON.stringify([mergeRequest(4, 7, 'Assigned')]), { status: 200, headers: { 'content-type': 'application/json' } });
  });
  assert.deepEqual((await client.listGroupMergeRequests(21)).map((item) => item.iid), [7]);
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
