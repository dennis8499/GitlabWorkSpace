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

test('paginates Group Issue Boards and retains their names and hidden-list settings', async () => {
  const requested: URL[] = [];
  const client = new GitLabClient('https://gitlab.example.test', token, async (input) => {
    const url = new URL(String(input));
    requested.push(url);
    if (url.searchParams.get('page') === '2') {
      return new Response(JSON.stringify([{ id: 9, name: 'Support', hide_closed_list: true }]));
    }
    return new Response(JSON.stringify([{ id: 4, name: 'Delivery', hide_backlog_list: true }]), {
      headers: { Link: '<https://gitlab.example.test/api/v4/groups/3/boards?per_page=100&page=2>; rel="next"' }
    });
  });

  const boards = await client.listGroupIssueBoards(3);
  assert.deepEqual(boards, [
    { id: 4, name: 'Delivery', hide_backlog_list: true },
    { id: 9, name: 'Support', hide_closed_list: true }
  ]);
  assert.equal(requested.length, 2);
  assert.equal(requested[0].pathname, '/api/v4/groups/3/boards');
  assert.equal(requested[0].searchParams.get('per_page'), '100');
});

test('loads assigned Issues from every visible Group Board list with pagination and deduplicates list membership', async () => {
  const calls: Array<{ query: string; variables: Record<string, unknown> }> = [];
  const client = new GitLabClient('https://gitlab.example.test/gitlab', token, async (input, init) => {
    assert.equal(new URL(String(input)).pathname, '/gitlab/api/graphql');
    const body = JSON.parse(String(init?.body)) as { query: string; variables: Record<string, unknown> };
    calls.push(body);

    if (body.query.includes('AssignedGroupIssueBoardLists')) {
      if (body.variables.after === 'board-cursor') {
        return new Response(JSON.stringify({ data: { group: { board: {
          hideBacklogList: true, hideClosedList: true,
          lists: { nodes: [{ id: 'gid://gitlab/List/13', listType: 'label' }], pageInfo: { hasNextPage: false, endCursor: null } }
        } } } }));
      }
      return new Response(JSON.stringify({ data: { group: { board: {
        hideBacklogList: true, hideClosedList: true,
        lists: { nodes: [
          { id: 'gid://gitlab/List/10', listType: 'backlog' },
          { id: 'gid://gitlab/List/11', listType: 'closed' },
          { id: 'gid://gitlab/List/12', listType: 'label' }
        ], pageInfo: { hasNextPage: true, endCursor: 'board-cursor' } }
      } } } }));
    }

    const listId = body.variables.listId;
    const after = body.variables.after;
    const issues = listId === 'gid://gitlab/List/12'
      ? after === 'issue-cursor' ? [{ id: 'gid://gitlab/Issue/102' }, { id: 'gid://gitlab/Issue/104' }] : [{ id: 'gid://gitlab/Issue/101' }, { id: 'gid://gitlab/Issue/102' }]
      : [{ id: 'gid://gitlab/Issue/103' }, { id: 'gid://gitlab/Issue/101' }];
    return new Response(JSON.stringify({ data: { boardList: { issues: {
      nodes: issues,
      pageInfo: { hasNextPage: listId === 'gid://gitlab/List/12' && !after, endCursor: listId === 'gid://gitlab/List/12' && !after ? 'issue-cursor' : null }
    } } } }));
  });

  const issueIds = await client.listAssignedGroupBoardIssueIds('parent/child', 25, 'test-user');
  assert.deepEqual(issueIds, [101, 102, 104, 103]);
  const boardCalls = calls.filter((call) => call.query.includes('AssignedGroupIssueBoardLists'));
  assert.equal(boardCalls.length, 2);
  assert.equal(boardCalls[0].variables.groupPath, 'parent/child');
  assert.equal(boardCalls[0].variables.boardId, 'gid://gitlab/Board/25');
  const issueCalls = calls.filter((call) => call.query.includes('AssignedGroupIssueBoardListIssues'));
  assert.deepEqual(issueCalls.map((call) => call.variables.listId), [
    'gid://gitlab/List/12', 'gid://gitlab/List/12', 'gid://gitlab/List/13'
  ]);
  assert.ok(issueCalls.every((call) => (call.variables.username as string[] | undefined)?.[0] === 'test-user'));
  assert.ok(issueCalls.every((call) => call.query.includes('assigneeUsername')));
});

test('loads complete Issue Board membership so related unassigned Issues can inherit Board colors', async () => {
  const calls: Array<{ query: string; variables: Record<string, unknown> }> = [];
  const client = new GitLabClient('https://gitlab.example.test', token, async (input, init) => {
    const body = JSON.parse(String(init?.body)) as { query: string; variables: Record<string, unknown> };
    calls.push(body);
    if (body.query.includes('GroupIssueBoardLists')) {
      return new Response(JSON.stringify({ data: { group: { board: {
        hideBacklogList: true, hideClosedList: false,
        lists: { nodes: [{ id: 'gid://gitlab/List/4', listType: 'label' }, { id: 'gid://gitlab/List/5', listType: 'closed' }], pageInfo: { hasNextPage: false, endCursor: null } }
      } } } }));
    }
    const closed = body.variables.listId === 'gid://gitlab/List/5';
    return new Response(JSON.stringify({ data: { boardList: { issues: {
      nodes: closed ? [{ id: 'gid://gitlab/Issue/202', iid: '1', projectId: 200 }] : [{ id: 'gid://gitlab/Issue/101', iid: '1', projectId: 100 }, { id: 'gid://gitlab/Issue/202', iid: '1', projectId: 200 }],
      pageInfo: { hasNextPage: false, endCursor: null }
    } } } }));
  });

  assert.deepEqual(await client.listGroupBoardIssueIds('parent/child', 25), [101, 202]);
  const issueQueries = calls.filter((call) => call.query.includes('GroupIssueBoardListIssues'));
  assert.equal(issueQueries.length, 2);
  assert.ok(issueQueries.every((call) => !call.query.includes('assigneeUsername')));
  assert.ok(issueQueries.every((call) => !Object.hasOwn(call.variables, 'username')));
  assert.deepEqual(issueQueries.map((call) => call.variables.listId), ['gid://gitlab/List/4', 'gid://gitlab/List/5']);
  assert.deepEqual(await client.listGroupBoardIssueMemberships('parent/child', 25), [
    { issueId: 101, projectId: 100, iid: 1 }, { issueId: 202, projectId: 200, iid: 1 }
  ]);
});

test('retains empty repository metadata from the project details API', async () => {
  const requested: string[] = [];
  const client = new GitLabClient('https://gitlab.example.test', token, async (input) => {
    requested.push(String(input));
    return new Response(JSON.stringify({
      id: 20,
      name: 'repo',
      path: 'repo',
      path_with_namespace: 'parent/repo',
      web_url: 'https://gitlab.example.test/parent/repo',
      http_url_to_repo: 'https://gitlab.example.test/parent/repo.git',
      default_branch: null,
      empty_repo: true
    }));
  });

  const project = await client.getProject(20);
  assert.equal(requested[0], 'https://gitlab.example.test/api/v4/projects/20');
  assert.equal(project.default_branch, null);
  assert.equal(project.empty_repo, true);
});

test('paginates group milestones and includes closed milestones from descendant groups', async () => {
  const requested: URL[] = [];
  const fetcher: FetchLike = async (input) => {
    const url = new URL(String(input));
    requested.push(url);
    if (url.searchParams.get('page') === '2') {
      return new Response(JSON.stringify([{ id: 12, group_id: 8, title: 'Previous release', state: 'closed' }]));
    }
    return new Response(JSON.stringify([{ id: 11, group_id: 8, title: 'Next release', state: 'active' }]), {
      headers: { Link: '<https://gitlab.example.test/api/v4/groups/3/milestones?include_descendants=true&per_page=100&page=2>; rel="next"' }
    });
  };
  const client = new GitLabClient('https://gitlab.example.test', token, fetcher);
  const milestones = await client.listGroupMilestones(3);

  assert.equal(requested.length, 2);
  assert.equal(requested[0].pathname, '/api/v4/groups/3/milestones');
  assert.equal(requested[0].searchParams.get('include_descendants'), 'true');
  assert.equal(requested[0].searchParams.get('per_page'), '100');
  assert.deepEqual(milestones.map((milestone) => [milestone.id, milestone.group_id, milestone.state]), [
    [11, 8, 'active'], [12, 8, 'closed']
  ]);
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

test('passes cancellation signals to read requests and never to GraphQL mutations', async () => {
  const controller = new AbortController();
  const calls: Array<{ method: string; signal?: AbortSignal }> = [];
  let successfulWrites = 0;
  const client = new GitLabClient('https://gitlab.example.test', token, async (_input, init) => {
    calls.push({ method: init?.method ?? 'GET', signal: init?.signal ?? undefined });
    const body = init?.body ? JSON.parse(String(init.body)) as { query?: string } : undefined;
    if (body?.query?.startsWith('mutation')) return new Response(JSON.stringify({ data: { ok: true } }));
    if (String(_input).includes('/graphql')) return new Response(JSON.stringify({ data: { ok: true } }));
    if (String(_input).includes('/groups?')) return new Response('[]');
    if ((init?.method ?? 'GET') === 'POST') return new Response(JSON.stringify({ iid: 7, project_id: 42 }));
    return new Response(JSON.stringify({ id: 5, username: 'tester', name: 'Tester' }));
  }, undefined, () => { successfulWrites++; });
  const readClient = client.withReadSignal(controller.signal);

  await readClient.getCurrentUser();
  await readClient.listGroups();
  await readClient.graphql('query ReadCheck { currentUser { id } }', {});
  await readClient.graphql('mutation WriteCheck { updateIssue }', {});
  await readClient.createIssue(42, { title: 'Created' });

  assert.deepEqual(calls.map((call) => !!call.signal), [true, true, true, false, false]);
  assert.equal(successfulWrites, 2);
});
