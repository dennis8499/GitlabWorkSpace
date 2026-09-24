import assert from 'node:assert/strict';
import test from 'node:test';
import { GitLabApiError, GitLabClient, type FetchLike } from '../../src/api/gitLabClient';

const token = 'unit-test-token-do-not-use';

test('paginates groups using GitLab Link headers and keeps authorization on the configured API', async () => {
  const calls: Array<{ url: string; tokenHeader: string | null; redirect: RequestRedirect | undefined }> = [];
  const fetcher: FetchLike = async (input, init) => {
    const url = String(input);
    calls.push({
      url,
      tokenHeader: new Headers(init?.headers).get('PRIVATE-TOKEN'),
      redirect: init?.redirect
    });
    if (url.includes('page=2')) return new Response(JSON.stringify([{ id: 2, name: 'Child', full_path: 'parent/child', web_url: '' }]));
    return new Response(JSON.stringify([{ id: 1, name: 'Parent', full_path: 'parent', web_url: '' }]), {
      headers: { Link: '<http://127.0.0.1:8929/gitlab/api/v4/groups?all_available=false&per_page=100&page=2>; rel="next"' }
    });
  };
  const client = new GitLabClient('http://127.0.0.1:8929/gitlab/', token, fetcher);
  const groups = await client.listGroups();
  assert.deepEqual(groups.map((group) => group.full_path), ['parent', 'parent/child']);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].url, 'http://127.0.0.1:8929/gitlab/api/v4/groups?all_available=false&per_page=100');
  assert.ok(calls.every((call) => call.tokenHeader === token && call.redirect === 'manual'));
});

test('includes subgroup projects and filters assigned group issues to those project IDs', async () => {
  const requested: string[] = [];
  const fetcher: FetchLike = async (input) => {
    const url = String(input);
    requested.push(url);
    if (url.includes('/projects?')) {
      return new Response(JSON.stringify([{ id: 20, path: 'repo', path_with_namespace: 'parent/child/repo' }]));
    }
    return new Response(JSON.stringify([
      { iid: 1, project_id: 20, state: 'opened' },
      { iid: 2, project_id: 99, state: 'closed' }
    ]));
  };
  const client = new GitLabClient('https://gitlab.example.test', token, fetcher);
  const projects = await client.listGroupProjects(3);
  const issues = await client.listAssignedGroupIssues(3, new Set(projects.map((project) => project.id)));
  assert.match(requested[0], /include_subgroups=true/);
  assert.match(requested[1], /scope=assigned_to_me&state=all/);
  assert.deepEqual(issues.map((issue) => issue.iid), [1]);
});

test('creates an issue with an optional description and one assignee', async () => {
  let capturedBody: Record<string, unknown> | undefined;
  const fetcher: FetchLike = async (_input, init) => {
    capturedBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return new Response(JSON.stringify({ iid: 7, project_id: 42, title: 'Failure', state: 'opened', web_url: 'https://gitlab.example.test/p/r/-/issues/7' }));
  };
  const client = new GitLabClient('https://gitlab.example.test', token, fetcher);
  const created = await client.createIssue(42, { title: 'Failure', description: 'Need help', assigneeId: 5 });
  assert.equal(created.iid, 7);
  assert.deepEqual(capturedBody, { title: 'Failure', description: 'Need help', assignee_id: 5 });
});

test('creates an unassigned issue without sending an assignee_id field', async () => {
  let capturedBody: Record<string, unknown> | undefined;
  const fetcher: FetchLike = async (_input, init) => {
    capturedBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return new Response(JSON.stringify({ iid: 8, project_id: 42, title: 'Unassigned', state: 'opened', web_url: 'https://gitlab.example.test/p/r/-/issues/8' }));
  };
  const client = new GitLabClient('https://gitlab.example.test', token, fetcher);
  const created = await client.createIssue(42, { title: 'Unassigned' });
  assert.equal(created.iid, 8);
  assert.deepEqual(capturedBody, { title: 'Unassigned' });
  assert.equal(Object.hasOwn(capturedBody ?? {}, 'assignee_id'), false);
});

test('does not expose the token or response body in authentication errors', async () => {
  const fetcher: FetchLike = async () => new Response(`bad ${token}`, { status: 401 });
  const client = new GitLabClient('https://gitlab.example.test', token, fetcher);
  await assert.rejects(client.getCurrentUser(), (error: unknown) => {
    assert.ok(error instanceof GitLabApiError);
    assert.doesNotMatch(error.message, /unit-test-token-do-not-use|bad/);
    return true;
  });
});

test('rejects pagination links outside the configured GitLab API path', async () => {
  const fetcher: FetchLike = async () => new Response('[]', {
    headers: { Link: '<https://attacker.example/api/v4/groups?page=2>; rel="next"' }
  });
  const client = new GitLabClient('https://gitlab.example.test/gitlab', token, fetcher);
  await assert.rejects(client.listGroups(), /outside the configured API/);
});
