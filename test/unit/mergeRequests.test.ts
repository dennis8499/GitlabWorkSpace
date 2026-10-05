import assert from 'node:assert/strict';
import test from 'node:test';
import { GitLabClient } from '../../src/api/gitLabClient';
import type { GitLabMergeRequest } from '../../src/api/types';

const mergeRequest = (projectId: number, iid: number, title: string): GitLabMergeRequest => ({
  id: projectId * 100 + iid, project_id: projectId, iid, title, state: 'opened', web_url: `https://gitlab.example/group/project/-/merge_requests/${iid}`,
  source_branch: 'feature/update', target_branch: 'main', sha: `sha-${iid}`
});

test('loads the paginated 16.11 review list with scope=all and reviewer_id', async () => {
  const requested: string[] = [];
  const client = new GitLabClient('https://gitlab.example/gitlab', 'token', async (input) => {
    const url = new URL(String(input));
    requested.push(url.toString());
    const payload = [mergeRequest(4, 8, 'Both'), mergeRequest(5, 7, 'Review')];
    return new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json' } });
  });
  const rows = await client.listGroupMergeRequests(21, 9);
  assert.deepEqual(rows.map((item) => [item.project_id, item.iid]), [[4, 8], [5, 7]]);
  assert.equal(requested.length, 1);
  assert.equal(new URL(requested[0]).searchParams.get('scope'), 'all');
  assert.equal(new URL(requested[0]).searchParams.get('reviewer_id'), '9');
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
