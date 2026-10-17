import assert from 'node:assert/strict';
import test from 'node:test';
import { GitLabApiError, GitLabClient } from '../../src/api/gitLabClient';
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
  const result = await client.listMergeRequestDiffs(4, 8);
  assert.equal(result.diffs.length, 300);
  assert.equal(result.source, 'diffs');
  assert.equal(result.truncated, false);
  assert.deepEqual(result.warnings, []);
  assert.equal(requested.length, 3);
  assert.ok(requested.every((url) => url.includes('/merge_requests/8/diffs')));
});

const changedFile = { old_path: 'file.txt', new_path: 'file.txt', diff: '+updated' };
const jsonResponse = (value: unknown, status = 200, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json', ...headers } });

test('falls back once to changes for unavailable or failed diff endpoints', async (t) => {
  for (const status of [404, 405, 500, 501, 502, 503, 504]) await t.test(`HTTP ${status}`, async () => {
    const requested: URL[] = [];
    const client = new GitLabClient('https://gitlab.example/gitlab', 'token', async (input) => {
      const url = new URL(String(input)); requested.push(url);
      return url.pathname.endsWith('/diffs') ? jsonResponse({}, status) : jsonResponse({ changes: [changedFile], overflow: false });
    });
    const result = await client.listMergeRequestDiffs(4, 8);
    assert.deepEqual(requested.map(url => url.pathname), ['/gitlab/api/v4/projects/4/merge_requests/8/diffs', '/gitlab/api/v4/projects/4/merge_requests/8/changes']);
    assert.equal(requested[0].searchParams.get('per_page'), '100');
    assert.deepEqual(result.diffs, [changedFile]);
    assert.equal(result.source, 'changes'); assert.equal(result.truncated, false);
    assert.equal(result.warnings.length, 1); assert.match(result.warnings[0], /已改用相容差異 API/);
  });
});

test('discards primary pages when a later diff page fails', async () => {
  const requested: URL[] = [];
  const fallbackFile = { ...changedFile, old_path: 'complete.txt', new_path: 'complete.txt' };
  const client = new GitLabClient('https://gitlab.example', 'token', async (input) => {
    const url = new URL(String(input)); requested.push(url);
    if (url.pathname.endsWith('/changes')) return jsonResponse({ changes: [fallbackFile] });
    if (url.searchParams.get('page') === '2') return jsonResponse({}, 500);
    return jsonResponse([changedFile], 200, { 'x-next-page': '2' });
  });
  const result = await client.listMergeRequestDiffs(4, 8);
  assert.deepEqual(result.diffs, [fallbackFile]); assert.equal(result.source, 'changes'); assert.equal(requested.length, 3);
});

test('does not fall back for permission errors, rate limits, other HTTP failures, or malformed primary data', async (t) => {
  for (const status of [400, 401, 403, 408, 409, 422, 429, 505]) await t.test(`HTTP ${status}`, async () => {
    let calls = 0;
    const client = new GitLabClient('https://gitlab.example', 'token', async () => { calls++; return jsonResponse({}, status); });
    await assert.rejects(client.listMergeRequestDiffs(4, 8), (error: unknown) => error instanceof GitLabApiError && error.status === status);
    assert.equal(calls, 1);
  });
  for (const value of [{ changes: [] }, [null], [{ ...changedFile, diff: 1 }], [{ ...changedFile, new_path: '' }], [{ ...changedFile, collapsed: 'true' }], [{ old_path: 'file', new_path: 'file' }]]) {
    let calls = 0;
    const client = new GitLabClient('https://gitlab.example', 'token', async () => { calls++; return jsonResponse(value); });
    await assert.rejects(client.listMergeRequestDiffs(4, 8), /unexpected list response|invalid Merge Request diff entry/);
    assert.equal(calls, 1);
  }
});

test('preserves cancellation without requesting fallback or replacing its error', async (t) => {
  for (const duringFallback of [false, true]) await t.test(duringFallback ? 'during fallback' : 'during primary', async () => {
    const controller = new AbortController();
    const reason = new Error('View is no longer active');
    let calls = 0;
    const client = new GitLabClient('https://gitlab.example', 'token', async () => {
      calls++;
      if (duringFallback && calls === 1) return jsonResponse({}, 500);
      controller.abort(reason); throw reason;
    }).withReadSignal(controller.signal);
    await assert.rejects(client.listMergeRequestDiffs(4, 8), error => error === reason);
    assert.equal(calls, duringFallback ? 2 : 1);
  });
});

test('reports primary and fallback errors without repeated requests', async (t) => {
  const badFallbacks = [jsonResponse({}, 503), jsonResponse({ changes: null }), jsonResponse({ changes: [null] }), jsonResponse({ changes: [], overflow: 'false' })];
  for (const response of badFallbacks) await t.test(`fallback ${response.status}`, async () => {
    let calls = 0;
    const client = new GitLabClient('https://gitlab.example', 'token', async () => ++calls === 1 ? jsonResponse({}, 500) : response);
    await assert.rejects(client.listMergeRequestDiffs(4, 8), (error: unknown) => {
      assert.ok(error instanceof GitLabApiError); assert.match(error.message, /\/diffs：.*HTTP 500.*\/changes：/);
      assert.ok(error.cause instanceof AggregateError); assert.equal(error.cause.errors.length, 2);
      return true;
    });
    assert.equal(calls, 2);
  });
});

test('marks server limits and collapsed or too-large diffs as incomplete', async (t) => {
  for (const source of ['diffs', 'changes'] as const) await t.test(source, async () => {
    const files = [{ ...changedFile, collapsed: true, diff: null }, { ...changedFile, old_path: 'large.txt', new_path: 'large.txt', too_large: true, diff: undefined }];
    const client = new GitLabClient('https://gitlab.example', 'token', async (input) => {
      if (source === 'changes' && String(input).includes('/diffs')) return jsonResponse({}, 500);
      return jsonResponse(source === 'changes' ? { changes: files, overflow: true } : files);
    });
    const result = await client.listMergeRequestDiffs(4, 8);
    assert.equal(result.source, source); assert.equal(result.truncated, true);
    assert.ok(result.diffs.every(file => file.diff === ''));
    assert.ok(result.warnings.some(warning => warning.includes('折疊')));
    assert.ok(result.warnings.some(warning => warning.includes('顯示上限')));
    if (source === 'changes') assert.ok(result.warnings.some(warning => warning.includes('回傳量')));
  });
});

test('accepts empty primary and fallback lists without claiming truncation', async (t) => {
  for (const source of ['diffs', 'changes'] as const) await t.test(source, async () => {
    const client = new GitLabClient('https://gitlab.example', 'token', async (input) => source === 'changes' && String(input).includes('/diffs')
      ? jsonResponse({}, 500) : jsonResponse(source === 'changes' ? { changes: [], overflow: false } : []));
    const result = await client.listMergeRequestDiffs(4, 8);
    assert.deepEqual(result.diffs, []); assert.equal(result.truncated, false); assert.equal(result.source, source);
  });
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
