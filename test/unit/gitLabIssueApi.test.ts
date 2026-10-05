import assert from 'node:assert/strict';
import test from 'node:test';
import { GitLabClient, type FetchLike } from '../../src/api/gitLabClient';

const token = 'issue-api-test-token';
const issue = { id: 401, iid: 7, project_id: 42, title: 'Before', state: 'opened', web_url: 'https://gitlab.example.test/g/p/-/issues/7', updated_at: '2026-09-24T00:00:00Z' };

test('creates an issue with all CE creation fields and reads its live details', async () => {
  const calls: Array<{ url: string; method: string; body?: unknown }> = [];
  const fetcher: FetchLike = async (input, init) => {
    const url = String(input);
    calls.push({ url, method: init?.method ?? 'GET', body: init?.body ? JSON.parse(String(init.body)) as unknown : undefined });
    return new Response(JSON.stringify(issue), { headers: { 'Content-Type': 'application/json' } });
  };
  const client = new GitLabClient('https://gitlab.example.test', token, fetcher);
  await client.createIssue(42, {
    title: 'Before', description: 'Markdown\n\n- [ ] Task', assigneeId: 9,
    labels: ['bug', 'urgent'], milestoneId: 3, dueDate: '2026-10-01', confidential: true
  });
  const detail = await client.getIssue(42, 7);
  assert.equal(detail.id, 401);
  assert.deepEqual(calls[0].body, {
    title: 'Before', description: 'Markdown\n\n- [ ] Task', assignee_id: 9,
    labels: 'bug,urgent', milestone_id: 3, due_date: '2026-10-01', confidential: true
  });
  assert.equal(calls[1].url, 'https://gitlab.example.test/api/v4/projects/42/issues/7');
});

test('updates an issue and rejects a stale local snapshot before writing', async () => {
  const calls: string[] = [];
  const fetcher: FetchLike = async (input, init) => {
    calls.push(`${init?.method ?? 'GET'} ${String(input)}`);
    return new Response(JSON.stringify({ ...issue, title: 'Changed elsewhere', updated_at: '2026-09-24T01:00:00Z' }));
  };
  const client = new GitLabClient('https://gitlab.example.test', token, fetcher);
  await assert.rejects(client.updateIssueIfUnchanged(42, 7, issue.updated_at, { title: 'Mine' }), /changed/i);
  assert.deepEqual(calls, ['GET https://gitlab.example.test/api/v4/projects/42/issues/7']);
});

test('loads discussions and related issues with pagination', async () => {
  const paths: string[] = [];
  const fetcher: FetchLike = async (input) => {
    const url = String(input);
    paths.push(url);
    const payload = url.includes('/discussions') ? [{ id: 'thread-1', notes: [{ id: 1, body: 'Hello' }] }] : [{ id: 2, iid: 8, project_id: 42, issue_link_id: 5, title: 'Related' }];
    return new Response(JSON.stringify(payload));
  };
  const client = new GitLabClient('https://gitlab.example.test', token, fetcher);
  assert.equal((await client.listIssueDiscussions(42, 7)).length, 1);
  assert.equal((await client.listIssueLinks(42, 7)).length, 1);
  assert.ok(paths.every((path) => path.includes('/projects/42/issues/7/')));
});

test('handles a successful issue deletion with no JSON response', async () => {
  const fetcher: FetchLike = async () => new Response(null, { status: 204 });
  const client = new GitLabClient('https://gitlab.example.test', token, fetcher);
  await client.deleteIssue(42, 7);
});

test('loads inherited issue templates through the project template API', async () => {
  const paths: string[] = [];
  const fetcher: FetchLike = async (input) => {
    const path = new URL(String(input)).pathname;
    paths.push(path);
    return new Response(JSON.stringify(path.endsWith('/templates/issues') ? [{ key: 'Bug', name: 'Bug' }] : { content: 'Steps to reproduce' }));
  };
  const client = new GitLabClient('https://gitlab.example.test', token, fetcher);
  assert.deepEqual(await client.listProjectIssueTemplates(42), [{ name: 'Bug', content: 'Steps to reproduce' }]);
  assert.deepEqual(paths, ['/api/v4/projects/42/templates/issues', '/api/v4/projects/42/templates/issues/Bug']);
});

test('includes ancestor milestones and checks the GitLab GraphQL issue capabilities', async () => {
  const paths: string[] = [];
  const names = (value: string) => ({ fields: value.split(' ').map((name) => ({ name })) });
  const fetcher: FetchLike = async (input) => {
    const url = new URL(String(input));
    paths.push(url.pathname + url.search);
    if (url.pathname.endsWith('/graphql')) return new Response(JSON.stringify({ data: { __schema: { types: [
      { name: 'Namespace', fields: [{ name: 'workItem', args: [{ name: 'iid' }] }, { name: 'workItemTypes' }] },
      { name: 'WorkItem', ...names('id iid userPermissions widgets') },
      { name: 'WorkItemWidgetHierarchy', ...names('children') },
      { name: 'WorkItemPermissions', ...names('updateWorkItem deleteWorkItem moveWorkItem cloneWorkItem createNote markNoteAsInternal adminWorkItemLink adminParentLink setWorkItemMetadata') },
      { name: 'Mutation', fields: [
        { name: 'workItemCreate', args: [{ name: 'input', type: { name: 'WorkItemCreateInput' } }] },
        { name: 'workItemUpdate', args: [{ name: 'input', type: { name: 'WorkItemUpdateInput' } }] },
        { name: 'discussionToggleResolve' },
        { name: 'timelogCreate', args: [{ name: 'input', type: { name: 'TimelogCreateInput' } }] },
        { name: 'timelogDelete', args: [{ name: 'input', type: { name: 'TimelogDeleteInput' } }] }
      ] },
      { name: 'Project', ...names('userPermissions') }, { name: 'ProjectPermissions', ...names('createIssue') },
      { name: 'WorkItemUpdateInput', inputFields: [{ name: 'startAndDueDateWidget' }] },
      { name: 'WorkItemCreateInput', inputFields: [] },
      { name: 'TimelogCreateInput', inputFields: names('issuableId timeSpent summary spentAt').fields },
      { name: 'TimelogDeleteInput', inputFields: [{ name: 'id' }] },
      { name: 'WorkItemWidgetStartAndDueDateUpdateInput', inputFields: [{ name: 'startDate' }] },
      { name: 'WorkItemWidgetStartAndDueDate', ...names('startDate') },
      { name: 'WorkItemWidgetTimeTracking', ...names('timelogs') },
      { name: 'WorkItemTimelog', fields: [...names('id timeSpent spentAt summary user').fields, { name: 'userPermissions', type: { name: 'TimelogPermissions' } }] },
      { name: 'TimelogPermissions', ...names('adminTimelog') }
    ] } } }));
    return new Response(JSON.stringify([{ id: 8, title: 'Parent group milestone' }]));
  };
  const client = new GitLabClient('https://gitlab.example.test', token, fetcher);
  assert.equal((await client.listProjectMilestones(42))[0].title, 'Parent group milestone');
  const capabilities = await client.getIssueCapabilities();
  assert.equal(capabilities.workItemScope, 'namespace');
  assert.equal(capabilities.hierarchy, true);
  assert.equal(capabilities.childMutations, false, 'child writes stay disabled without a supported input shape');
  assert.equal(capabilities.graphWorkItems, true);
  assert.equal(capabilities.graphHierarchy, false);
  assert.equal(capabilities.discussionResolve, true);
  assert.equal(capabilities.startDate, true);
  assert.equal(capabilities.timelogReport, true);
  assert.equal(capabilities.timelogCreate, true);
  assert.equal(capabilities.timelogCreateDated, true);
  assert.equal(capabilities.timelogCreateSummary, true);
  assert.equal(capabilities.timelogAdminPermission, true);
  assert.equal(capabilities.timelogDelete, true);
  assert.equal(capabilities.createPermission, true);
  assert.match(paths[0], /include_ancestors=true/);
});

test('matches the GitLab CE 16.11.10 GraphQL compatibility contract using Project and projectPath', async () => {
  const names = (value: string) => value.split(' ').map((name) => ({ name }));
  const field = (name: string, args?: Array<{ name: string; type: { name: string } }>) => ({ name, ...(args ? { args } : {}) });
  const schema = [
    { name: 'Project', fields: [field('workItem', [{ name: 'iid', type: { name: 'String' } }]), field('workItemTypes', [{ name: 'name', type: { name: 'WorkItemsTypeEnum' } }]), field('userPermissions')] },
    { name: 'WorkItem', fields: names('id iid title state webUrl userPermissions widgets') },
    { name: 'WorkItemPermissions', fields: names('updateWorkItem adminParentLink') },
    { name: 'WorkItemWidgetHierarchy', fields: names('parent children') },
    { name: 'Issue', fields: names('userPermissions') },
    { name: 'IssuePermissions', fields: names('updateIssue adminIssue createNote') },
    { name: 'ProjectPermissions', fields: names('createIssue') },
    { name: 'Mutation', fields: [
      field('workItemCreate', [{ name: 'input', type: { name: 'WorkItemCreateInput' } }]),
      field('workItemUpdate', [{ name: 'input', type: { name: 'WorkItemUpdateInput' } }])
    ] },
    { name: 'WorkItemCreateInput', inputFields: names('projectPath workItemTypeId title hierarchyWidget') },
    { name: 'WorkItemUpdateInput', inputFields: names('hierarchyWidget stateEvent title descriptionWidget') }
  ];
  let requestBody = '';
  const client = new GitLabClient('https://gitlab-ce-16-11-10.example.test', token, async (_input, init) => {
    requestBody = String(init?.body);
    return new Response(JSON.stringify({ data: { __schema: { types: schema } } }));
  });
  const capabilities = await client.getIssueCapabilities();
  assert.match(requestBody, /__schema/);
  assert.equal(capabilities.workItemScope, 'project');
  assert.equal(capabilities.workItemCreatePathField, 'projectPath');
  assert.equal(capabilities.workItemTypeList, true);
  assert.deepEqual(capabilities.issuePermissionFields, ['updateIssue', 'adminIssue', 'createNote']);
  assert.equal(capabilities.hierarchy, true);
  assert.equal(capabilities.childMutations, true);
  assert.equal(capabilities.graphHierarchy, true);
});

test('keeps the Namespace and namespacePath GraphQL shape for newer GitLab schemas', async () => {
  const names = (value: string) => value.split(' ').map((name) => ({ name }));
  const scope = { fields: [{ name: 'workItem', args: [{ name: 'iid', type: { name: 'String' } }] }, { name: 'workItemTypes', args: [{ name: 'name', type: { name: 'WorkItemsTypeEnum' } }] }] };
  const client = new GitLabClient('https://gitlab.example.test', token, async () => new Response(JSON.stringify({ data: { __schema: { types: [
    { name: 'Namespace', ...scope },
    { name: 'WorkItem', fields: names('id iid title state webUrl widgets') },
    { name: 'WorkItemWidgetHierarchy', fields: names('parent children') },
    { name: 'Mutation', fields: [
      { name: 'workItemCreate', args: [{ name: 'input', type: { name: 'CreateInput' } }] },
      { name: 'workItemUpdate', args: [{ name: 'input', type: { name: 'UpdateInput' } }] }
    ] },
    { name: 'CreateInput', inputFields: names('namespacePath hierarchyWidget workItemTypeId title') },
    { name: 'UpdateInput', inputFields: names('hierarchyWidget stateEvent title descriptionWidget') }
  ] } } })));
  const capabilities = await client.getIssueCapabilities();
  assert.equal(capabilities.workItemScope, 'namespace');
  assert.equal(capabilities.workItemCreatePathField, 'namespacePath');
  assert.equal(capabilities.childMutations, true);
});

test('queries only Issue permissions confirmed by the instance schema', async () => {
  let body: { query: string; variables: Record<string, unknown> } | undefined;
  const client = new GitLabClient('https://gitlab-ce-16-11-10.example.test', token, async (_input, init) => {
    body = JSON.parse(String(init?.body)) as { query: string; variables: Record<string, unknown> };
    return new Response(JSON.stringify({ data: { project: { issue: { userPermissions: { updateIssue: true, createNote: false } } } } }));
  });
  const permissions = await client.getIssuePermissions('group/project', 7, ['updateIssue', 'createNote']);
  assert.deepEqual(permissions, { updateIssue: true, createNote: false });
  assert.match(body?.query ?? '', /issue\(iid: \$iid\)/);
  assert.match(body?.query ?? '', /userPermissions\s*\{\s*updateIssue createNote\s*\}/);
  assert.deepEqual(body?.variables, { path: 'group/project', iid: '7' });
});

test('uses the legacy Project root and projectPath when creating a child task', async () => {
  let body: { query: string; variables: Record<string, unknown> } | undefined;
  const client = new GitLabClient('https://gitlab-ce-16-11-10.example.test', token, async (_input, init) => {
    body = JSON.parse(String(init?.body)) as { query: string; variables: Record<string, unknown> };
    const data = body.query.includes('mutation CreateChildTask')
      ? { workItemCreate: { errors: [] } }
      : { project: { workItem: { id: 'gid://gitlab/WorkItem/401' } } };
    return new Response(JSON.stringify({ data }));
  });
  assert.equal(await client.getWorkItemId('group/project', 7, 'project'), 'gid://gitlab/WorkItem/401');
  assert.match(body?.query ?? '', /project\(fullPath: \$path\)/);
  await client.createChildTask('group/project', 'gid://gitlab/WorkItem/401', 'gid://gitlab/WorkItems::Type/5', 'Task', 'projectPath');
  assert.match(body?.query ?? '', /workItemCreate\(input: \{ projectPath: \$path/);
  assert.doesNotMatch(body?.query ?? '', /namespacePath/);
});

test('detects read-only Issue graph fields without requiring WorkItem edit permissions', async () => {
  const names = (value: string) => ({ fields: value.split(' ').map((name) => ({ name })) });
  const client = new GitLabClient('https://gitlab.example.test', token, async () => new Response(JSON.stringify({ data: { __schema: { types: [
    { name: 'Namespace', fields: [{ name: 'workItem', args: [{ name: 'iid' }] }] },
    { name: 'WorkItem', ...names('id iid title state webUrl namespace project widgets workItemType') },
    { name: 'WorkItemWidgetHierarchy', ...names('parent children') },
    { name: 'WorkItemWidgetLinkedItems', ...names('linkedItems') },
    { name: 'WorkItemWidgetLabels', ...names('labels') },
    { name: 'WorkItemWidgetAssignees', ...names('assignees') }
  ] } } })));
  const capabilities = await client.getIssueCapabilities();
  assert.equal(capabilities.graphWorkItems, true);
  assert.equal(capabilities.graphHierarchy, true);
  assert.equal(capabilities.graphLinkedItems, true);
  assert.equal(capabilities.graphLabels, true);
  assert.equal(capabilities.graphAssignees, true);
  assert.equal(capabilities.graphWorkItemTypes, true);
  assert.equal(capabilities.hierarchy, true, 'hierarchy reads do not depend on WorkItem mutation permissions');
  assert.equal(capabilities.childMutations, false);
});

test('paginates WorkItem parents, child items, linked items, and reads label metadata using read-only capabilities', async () => {
  const calls: Array<{ query: string; variables: Record<string, unknown> }> = [];
  const page = (after: string | null) => ({
    data: { namespace: { workItem: {
      id: 'gid://gitlab/WorkItem/12', iid: '7',
      widgets: [{
        parent: { id: 'gid://gitlab/WorkItem/5', iid: '1', title: 'Parent', state: 'OPEN' },
        children: {
          nodes: [{ id: `gid://gitlab/WorkItem/child-${after ?? 'first'}`, iid: after ? '9' : '8', title: after ? 'Second child' : 'First child', state: 'OPEN' }],
          pageInfo: { hasNextPage: !after, endCursor: after ? null : 'child-cursor' }
        },
        linkedItems: {
          nodes: [{ linkType: after ? 'BLOCKS' : 'RELATED', workItem: { id: `gid://gitlab/WorkItem/link-${after ?? 'first'}`, iid: after ? '11' : '10', title: after ? 'Blocked item' : 'Related item', state: 'OPEN' } }],
          pageInfo: { hasNextPage: !after, endCursor: after ? null : 'link-cursor' }
        },
        labels: {
          nodes: [{ name: after ? 'ready' : 'feature', color: after ? '#00AA77' : '#AA5500', textColor: '#FFFFFF' }],
          pageInfo: { hasNextPage: !after, endCursor: after ? null : 'label-cursor' }
        }
      }]
    } } }
  });
  const client = new GitLabClient('https://gitlab.example.test/gitlab', token, async (_input, init) => {
    calls.push(JSON.parse(String(init?.body)) as { query: string; variables: Record<string, unknown> });
    return new Response(JSON.stringify(page(String(init?.body).includes('child-cursor') ? 'next' : null)));
  });
  const result = await client.loadIssueGraphRelations('team/service', 7, {
    graphWorkItems: true, graphHierarchy: true, graphLinkedItems: true, graphLabels: true,
    graphAssignees: false, graphWorkItemTypes: false
  });
  assert.equal(calls.length, 2);
  assert.equal(calls[0].variables.path, 'team/service');
  assert.equal(calls[0].variables.iid, '7');
  assert.deepEqual(calls[1].variables, { path: 'team/service', iid: '7', childrenAfter: 'child-cursor', linksAfter: 'link-cursor' });
  assert.match(calls[0].query, /WorkItemWidgetHierarchy/);
  assert.match(calls[0].query, /WorkItemWidgetLinkedItems/);
  assert.match(calls[0].query, /color textColor/);
  assert.equal(result.root?.id, 'gid://gitlab/WorkItem/12');
  assert.equal(result.parents[0].title, 'Parent');
  assert.equal(result.children.length, 2);
  assert.equal(result.links.length, 2);
  assert.deepEqual(result.links.map((entry) => entry.type), ['RELATED', 'BLOCKS']);
});

test('loads Work Item relations from the legacy Project query root', async () => {
  let request: { query: string; variables: Record<string, unknown> } | undefined;
  const client = new GitLabClient('https://gitlab-ce-16-11-10.example.test', token, async (_input, init) => {
    request = JSON.parse(String(init?.body)) as { query: string; variables: Record<string, unknown> };
    return new Response(JSON.stringify({ data: { project: { workItem: { id: 'gid://gitlab/WorkItem/401', iid: '7', title: 'Issue' } } } }));
  });
  const result = await client.loadIssueGraphRelations('group/project', 7, {
    workItemScope: 'project', workItemGraphFields: ['title'], graphWorkItems: true,
    graphHierarchy: false, graphLinkedItems: false, graphLabels: false, graphAssignees: false, graphWorkItemTypes: false
  });
  assert.match(request?.query ?? '', /project\(fullPath: \$path\)/);
  assert.doesNotMatch(request?.query ?? '', /namespace\(fullPath/);
  assert.deepEqual(request?.variables, { path: 'group/project', iid: '7' });
  assert.equal(result.root?.id, 'gid://gitlab/WorkItem/401');
});

test('updates one CE assignee and edits a note through its discussion', async () => {
  const calls: Array<{ method: string; path: string; body: Record<string, unknown> }> = [];
  const fetcher: FetchLike = async (input, init) => {
    calls.push({ method: init?.method ?? 'GET', path: new URL(String(input)).pathname, body: init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {} });
    return new Response(JSON.stringify(issue));
  };
  const client = new GitLabClient('https://gitlab.example.test', token, fetcher);
  await client.updateIssue(42, 7, { assigneeId: 9 });
  await client.updateIssue(42, 7, { assigneeId: null });
  await client.updateIssueNote(42, 7, 'thread-one', 88, 'Edited');
  assert.deepEqual(calls[0].body.assignee_ids, [9]);
  assert.deepEqual(calls[1].body.assignee_ids, []);
  assert.equal(calls[2].path, '/api/v4/projects/42/issues/7/discussions/thread-one/notes/88');
  assert.equal(calls[2].method, 'PUT');
});

test('checks per-project creation permission and manages a note reaction', async () => {
  const calls: Array<{ path: string; method: string; body?: unknown }> = [];
  const fetcher: FetchLike = async (input, init) => {
    const path = new URL(String(input)).pathname;
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(String(init.body)) as unknown : undefined;
    calls.push({ path, method, body });
    if (path.endsWith('/graphql')) return new Response(JSON.stringify({ data: { project: { userPermissions: { createIssue: false } } } }));
    if (method === 'DELETE') return new Response(null, { status: 204 });
    return new Response(JSON.stringify(method === 'GET' ? [{ id: 6, name: 'thumbsup', user: { id: 9 } }] : { id: 7, name: 'eyes' }));
  };
  const client = new GitLabClient('https://gitlab.example.test', token, fetcher);
  assert.equal(await client.canCreateIssue('group/project'), false);
  assert.equal((await client.listIssueNoteReactions(42, 7, 88))[0].name, 'thumbsup');
  await client.addIssueNoteReaction(42, 7, 88, 'eyes');
  await client.removeIssueNoteReaction(42, 7, 88, 6);
  assert.equal(calls[0].path, '/api/graphql');
  assert.equal(calls[1].path, '/api/v4/projects/42/issues/7/notes/88/award_emoji');
  assert.equal(calls[2].method, 'POST');
  assert.deepEqual(calls[2].body, { name: 'eyes' });
  assert.equal(calls[3].path, '/api/v4/projects/42/issues/7/notes/88/award_emoji/6');
});

test('GraphQL child task mutation keeps the token in the host and reports mutation errors', async () => {
  const requests: Array<{ url: string; headers: HeadersInit | undefined; body: Record<string, unknown> }> = [];
  const fetcher: FetchLike = async (input, init) => {
    requests.push({ url: String(input), headers: init?.headers, body: JSON.parse(String(init?.body)) as Record<string, unknown> });
    return new Response(JSON.stringify({ data: { workItemCreate: { errors: ['No permission'] } } }));
  };
  const client = new GitLabClient('https://gitlab.example.test', token, fetcher);
  await assert.rejects(client.createChildTask('group/project', 'gid://gitlab/WorkItem/401', 'gid://gitlab/WorkItems::Type/5', 'Child'), /No permission/);
  assert.equal(requests[0].url, 'https://gitlab.example.test/api/graphql');
  assert.equal((requests[0].headers as Record<string, string>)['PRIVATE-TOKEN'], token);
  assert.deepEqual(requests[0].body.variables, {
    path: 'group/project', parent: 'gid://gitlab/WorkItem/401', type: 'gid://gitlab/WorkItems::Type/5', title: 'Child'
  });
  assert.doesNotMatch(JSON.stringify(requests[0].body), /issue-api-test-token/);
});

test('verifies a selected child item is a Task and reads its current parent before adding it', async () => {
  let request: { query: string; variables: Record<string, unknown> } | undefined;
  const fetcher: FetchLike = async (_input, init) => {
    request = JSON.parse(String(init?.body)) as { query: string; variables: Record<string, unknown> };
    return new Response(JSON.stringify({ data: { namespace: { workItem: {
      id: 'gid://gitlab/WorkItem/416', workItemType: { name: 'Task' }, widgets: [{ parent: { id: 'gid://gitlab/WorkItem/401' } }]
    } } } }));
  };
  const client = new GitLabClient('https://gitlab.example.test', token, fetcher);
  const item = await client.getWorkItemTypeAndParent('group/project', 16, true, true);
  assert.deepEqual(item, { id: 'gid://gitlab/WorkItem/416', type: 'Task', parentId: 'gid://gitlab/WorkItem/401' });
  assert.match(request?.query ?? '', /workItemType\s*\{\s*name\s*\}/);
  assert.match(request?.query ?? '', /WorkItemWidgetHierarchy\s*\{\s*parent\s*\{\s*id\s*\}/);
  assert.deepEqual(request?.variables, { path: 'group/project', iid: '16' });
  await assert.rejects(client.getWorkItemTypeAndParent('group/project', 16, false, true), /cannot verify/i);
});

test('child task title and description use the work item description widget', async () => {
  let body: { query: string; variables: Record<string, unknown> } | undefined;
  const fetcher: FetchLike = async (_input, init) => {
    body = JSON.parse(String(init?.body)) as { query: string; variables: Record<string, unknown> };
    return new Response(JSON.stringify({ data: { workItemUpdate: { errors: [] } } }));
  };
  const client = new GitLabClient('https://gitlab.example.test', token, fetcher);
  await client.updateChildTask('gid://gitlab/WorkItem/99', 'Updated child', '**Details**');
  assert.match(body?.query ?? '', /descriptionWidget:\s*\{ description: \$description \}/);
  assert.deepEqual(body?.variables, { id: 'gid://gitlab/WorkItem/99', title: 'Updated child', description: '**Details**' });
});

test('start dates and individual time entries use the supported GraphQL contracts', async () => {
  const calls: Array<{ query: string; variables: Record<string, unknown> }> = [];
  const fetcher: FetchLike = async (_input, init) => {
    const body = JSON.parse(String(init?.body)) as { query: string; variables: Record<string, unknown> };
    calls.push(body);
    if (body.query.includes('SetIssueStartDate')) return new Response(JSON.stringify({ data: { workItemUpdate: { errors: [] } } }));
    if (body.query.includes('IssueStartDate')) return new Response(JSON.stringify({ data: { namespace: { workItem: { widgets: [{ startDate: '2026-10-02' }] } } } }));
    if (body.query.includes('IssueTimelogs')) return new Response(JSON.stringify({ data: { namespace: { workItem: { widgets: [{ timelogs: { nodes: [{ id: 'gid://gitlab/Timelog/1', timeSpent: 3600, spentAt: '2026-09-24T12:00:00Z', summary: 'Review', user: { id: 9, name: 'Tester', username: 'tester' }, userPermissions: { adminTimelog: true } }] } }] } } } }));
    if (body.query.includes('AddIssueTimelog')) return new Response(JSON.stringify({ data: { timelogCreate: { errors: [] } } }));
    return new Response(JSON.stringify({ data: { timelogDelete: { errors: [] } } }));
  };
  const client = new GitLabClient('https://gitlab.example.test', token, fetcher);
  await client.setIssueStartDate('gid://gitlab/WorkItem/401', '2026-10-02');
  assert.equal(await client.getIssueStartDate('group/project', 7), '2026-10-02');
  assert.equal((await client.listIssueTimelogs('group/project', 7))[0].summary, 'Review');
  await client.createIssueTimelog(401, '1h', 'Review', '2026-09-24T12:00:00Z');
  await client.createIssueTimelog(401, '30m');
  await client.deleteIssueTimelog('gid://gitlab/Timelog/1');
  assert.deepEqual(calls[0].variables, { id: 'gid://gitlab/WorkItem/401', startDate: '2026-10-02' });
  assert.deepEqual(calls[3].variables.input, { issuableId: 'gid://gitlab/Issue/401', timeSpent: '1h', summary: 'Review', spentAt: '2026-09-24T12:00:00Z' });
  assert.deepEqual(calls[4].variables.input, { issuableId: 'gid://gitlab/Issue/401', timeSpent: '30m', summary: '' });
  assert.deepEqual(calls[5].variables, { id: 'gid://gitlab/Timelog/1' });
});

test('time entries load every GraphQL cursor page', async () => {
  const cursors: unknown[] = [];
  const fetcher: FetchLike = async (_input, init) => {
    const body = JSON.parse(String(init?.body)) as { variables: { after: string | null } };
    cursors.push(body.variables.after);
    const second = body.variables.after === 'next-time';
    return new Response(JSON.stringify({ data: { namespace: { workItem: { widgets: [{ timelogs: { nodes: [{ id: second ? 'time-2' : 'time-1', timeSpent: 60, spentAt: '2026-09-24T12:00:00Z', user: { id: 9, name: 'Tester', username: 'tester' } }], pageInfo: { hasNextPage: !second, endCursor: second ? null : 'next-time' } } }] } } } }));
  };
  const client = new GitLabClient('https://gitlab.example.test', token, fetcher);
  assert.deepEqual((await client.listIssueTimelogs('group/project', 7)).map((entry) => entry.id), ['time-1', 'time-2']);
  assert.deepEqual(cursors, [null, 'next-time']);
});

test('attachment reads stay on the configured GitLab uploads path and keep authentication in the host', async () => {
  const paths: string[] = [];
  const fetcher: FetchLike = async (input, init) => {
    paths.push(String(input));
    assert.equal((init?.headers as Record<string, string>)['PRIVATE-TOKEN'], token);
    return new Response(new Uint8Array([137, 80, 78, 71]), { headers: { 'Content-Type': 'image/png' } });
  };
  const client = new GitLabClient('https://gitlab.example.test', token, fetcher);
  const result = await client.downloadUpload('https://gitlab.example.test/group/project/uploads/hash/image.png');
  assert.deepEqual([...result.bytes], [137, 80, 78, 71]);
  assert.equal(result.contentType, 'image/png');
  await assert.rejects(client.downloadUpload('https://other.example.test/uploads/image.png'), /outside/);
  await assert.rejects(client.downloadUpload('https://gitlab.example.test/api/v4/user'), /outside/);
  assert.deepEqual(paths, ['https://gitlab.example.test/group/project/uploads/hash/image.png']);
  const nested = new GitLabClient('https://gitlab.example.test/gitlab', token, fetcher);
  await assert.rejects(nested.downloadUpload('https://gitlab.example.test/gitlab-evil/uploads/steal.png'), /outside/);
});
