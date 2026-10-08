import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { GitLabClient, type FetchLike } from '../../src/api/gitLabClient';
import type { GraphQLSchemaType } from '../../src/api/graphqlCapabilities';
import { selectedCapabilityData } from './graphqlFixture';

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
  const fetcher: FetchLike = async (input, init) => {
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
  const fetcher: FetchLike = async (input, init) => {
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
  const fetcher: FetchLike = async (input, init) => {
    const url = new URL(String(input));
    paths.push(url.pathname + url.search);
    if (url.pathname.endsWith('/graphql')) {
      const schema: GraphQLSchemaType[] = [
      { name: 'Namespace', fields: [{ name: 'workItem', args: [{ name: 'iid' }] }, { name: 'workItemTypes' }] },
      { name: 'WorkItem', ...names('id iid userPermissions widgets') },
      { name: 'WorkItemWidgetHierarchy', ...names('children') },
      { name: 'WorkItemPermissions', ...names('updateWorkItem deleteWorkItem moveWorkItem cloneWorkItem createNote markNoteAsInternal adminWorkItemLink adminParentLink setWorkItemMetadata') },
      { name: 'Mutation', fields: [
        { name: 'workItemCreate', args: [{ name: 'input', type: { name: 'WorkItemCreateInput' } }] },
        { name: 'workItemUpdate', args: [{ name: 'input', type: { name: 'WorkItemUpdateInput' } }] },
        { name: 'discussionToggleResolve', args: [{ name: 'input', type: { name: 'DiscussionToggleResolveInput' } }] },
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
      { name: 'WorkItemTimelog', fields: [...names('id timeSpent spentAt summary').fields, { name: 'user', type: { name: 'User', kind: 'OBJECT' } }, { name: 'userPermissions', type: { name: 'TimelogPermissions' } }] },
      { name: 'User', fields: names('id name username').fields },
      { name: 'TimelogPermissions', ...names('adminTimelog') }
      ];
      const query = (JSON.parse(String(init?.body)) as { query: string }).query;
      return new Response(JSON.stringify({ data: selectedCapabilityData(query, schema) }));
    }
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
    { name: 'Project', fields: [field('fullPath'), field('workItem', [{ name: 'iid', type: { name: 'String' } }]), field('workItemTypes', [{ name: 'name', type: { name: 'WorkItemsTypeEnum' } }]), field('userPermissions')] },
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
    { name: 'WorkItemUpdateInput', inputFields: names('hierarchyWidget stateEvent title descriptionWidget') },
    { name: 'WorkItemWidgetHierarchyInput', inputFields: names('parentId') }
  ];
  const requestBodies: string[] = [];
  const client = new GitLabClient('https://gitlab-ce-16-11-10.example.test', token, async (_input, init) => {
    const request = JSON.parse(String(init?.body)) as { query: string };
    requestBodies.push(request.query);
    return new Response(JSON.stringify({ data: selectedCapabilityData(request.query, schema as GraphQLSchemaType[]) }));
  });
  const capabilities = await client.getIssueCapabilities();
  assert.ok(requestBodies.length <= 3);
  assert.ok(requestBodies.every((query) => query.includes('__type(name:')));
  assert.ok(requestBodies.every((query) => !query.includes('__schema')));
  assert.equal(capabilities.workItemScope, 'project');
  assert.equal(capabilities.workItemCreatePathField, 'projectPath');
  assert.equal(capabilities.workItemTypeList, true);
  assert.deepEqual(capabilities.issuePermissionFields, ['updateIssue', 'adminIssue', 'createNote']);
  assert.equal(capabilities.hierarchy, true);
  assert.equal(capabilities.childMutations, true);
  assert.equal(capabilities.graphHierarchy, true);
});

test('runs the pinned CE 16.11.10 selective-introspection fixture and checks its generated query', async () => {
  const fixture = JSON.parse(readFileSync(path.join(process.cwd(), 'test/fixtures/gitlab-ce-16.11.10-capabilities.json'), 'utf8')) as {
    sourceTag: string; source: string; types: GraphQLSchemaType[];
  };
  const requests: string[] = [];
  const client = new GitLabClient('https://gitlab-ce-16-11-10.example.test', token, async (_input, init) => {
    const query = (JSON.parse(String(init?.body)) as { query: string }).query;
    requests.push(query);
    return new Response(JSON.stringify({ data: selectedCapabilityData(query, fixture.types) }));
  });
  const capabilities = await client.getIssueCapabilities();
  assert.equal(fixture.sourceTag, 'v16.11.10-ee');
  assert.match(fixture.source, /v16\.11\.10-ee\/app\/graphql/);
  assert.equal(capabilities.workItemScope, 'project');
  assert.equal(capabilities.workItemCreatePathField, 'projectPath');
  assert.equal(capabilities.childMutations, true);
  assert.equal(capabilities.discussionResolve, true);
  assert.equal(capabilities.timelogReport, true);
  assert.ok(requests.length <= 3);
  assert.ok(requests.every((query) => query.includes('__type(name:')));
  assert.ok(requests.every((query) => !query.includes('__schema')));
  assert.ok(requests.flatMap((query) => [...query.matchAll(/__type\(name: "([^"]+)"\)/g)].map((match) => match[1])).length < 40);
});

test('recovers from the GitLab 16.11 authenticated complexity limit without exceeding six concurrent reads', async () => {
  const fixture = JSON.parse(readFileSync(path.join(process.cwd(), 'test/fixtures/gitlab-ce-16.11.10-capabilities.json'), 'utf8')) as {
    types: GraphQLSchemaType[];
  };
  const requests: string[] = [];
  let active = 0;
  let maxActive = 0;
  const client = new GitLabClient('https://gitlab-ce-16-11-10.example.test', token, async (_input, init) => {
    const query = (JSON.parse(String(init?.body)) as { query: string }).query;
    requests.push(query);
    const aliases = [...query.matchAll(/__type\(name: "([^"]+)"\)/g)];
    if (aliases.length > 3) {
      return new Response(JSON.stringify({ errors: [{ message: 'Query has complexity of 899, which exceeds max complexity of 250' }] }));
    }
    active++;
    maxActive = Math.max(maxActive, active);
    try {
      await new Promise((resolve) => setTimeout(resolve, 2));
      return new Response(JSON.stringify({ data: selectedCapabilityData(query, fixture.types) }));
    } finally { active--; }
  });

  const capabilities = await client.getIssueCapabilities();
  assert.equal(requests[0].match(/__type\(name: "/g)?.length, 13, 'retain the efficient one-query GitLab 19 introspection path');
  assert.ok(requests.some((query) => (query.match(/__type\(name: "/g)?.length ?? 0) <= 3));
  const oversizedRetries = requests.slice(1).map((query) => query.match(/__type\(name: "/g)?.length ?? 0).filter((count) => count > 3);
  assert.deepEqual(oversizedRetries, [], `recovery queries contained too many types: ${oversizedRetries.join(', ')}`);
  assert.ok(maxActive > 1 && maxActive <= 6, 'parallel recovery stays within the session read limit');
  assert.equal(capabilities.workItemScope, 'project');
  assert.equal(capabilities.hierarchy, true);
  assert.equal(capabilities.childMutations, true);
  assert.equal(capabilities.timelogReport, true);
});

test('reuses a complete raw __schema response without alias repair or follow-up downloads', async () => {
  const fixture = JSON.parse(readFileSync(path.join(process.cwd(), 'test/fixtures/gitlab-ce-16.11.10-capabilities.json'), 'utf8')) as {
    types: GraphQLSchemaType[];
  };
  const requests: string[] = [];
  const fullSchema = [...fixture.types, { name: 'Query', kind: 'OBJECT', fields: [{ name: 'currentUser', type: { name: 'User', kind: 'OBJECT' } }] }];
  const client = new GitLabClient('https://gitlab-schema.example.test', token, async (_input, init) => {
    const query = (JSON.parse(String(init?.body)) as { query: string }).query;
    requests.push(query);
    return new Response(JSON.stringify({ data: { __schema: { types: fullSchema } } }));
  });
  const capabilities = await client.getIssueCapabilities();
  assert.equal(requests.length, 1);
  assert.match(requests[0], /fields\(includeDeprecated: true\)/);
  assert.equal(capabilities.issuePermissionFields?.includes('updateIssue'), true);
  assert.equal(capabilities.hierarchy, true);
  assert.equal(capabilities.childMutations, true);
  assert.equal(capabilities.discussionResolve, true);
  assert.equal(capabilities.startDate, true);
  assert.equal(capabilities.timelogReport, true);
  assert.equal(capabilities.timelogSource, 'workItem');
});

test('treats empty and malformed complete schema responses as failed detection', async () => {
  const fixture = JSON.parse(readFileSync(path.join(process.cwd(), 'test/fixtures/gitlab-ce-16.11.10-capabilities.json'), 'utf8')) as {
    types: GraphQLSchemaType[];
  };
  const truncatedSchema = [
    ...fixture.types.filter((type) => type.name !== 'WorkItemPermissions'),
    { name: 'Query', kind: 'OBJECT', fields: [{ name: 'currentUser', type: { name: 'User', kind: 'OBJECT' } }] }
  ];
  for (const response of [
    { __schema: { types: [] } },
    { __schema: { types: null } },
    { __schema: { types: [
      { name: 'Query', kind: 'OBJECT', fields: [] },
      { name: 'Mutation', kind: 'OBJECT', fields: [] },
      { name: 'Issue', kind: 'OBJECT', fields: [] }
    ] } },
    { __schema: { types: truncatedSchema } }
  ]) {
    const client = new GitLabClient('https://gitlab-schema.example.test', token, async () =>
      new Response(JSON.stringify({ data: response })));
    await assert.rejects(client.getIssueCapabilities(), /schema introspection response/i);
  }
});

test('treats a truncated selective __type response as a probe failure instead of unsupported capabilities', async () => {
  const client = new GitLabClient('https://gitlab-schema.example.test', token, async () => new Response(JSON.stringify({
    data: { type0: { name: 'Project', kind: 'OBJECT', fields: [] } }
  })));
  await assert.rejects(client.getIssueCapabilities(), /incomplete GraphQL capability response/i);
});

test('discovers paginated Issue.timelogs through wrapped schema types when Work Item widgets are absent', async () => {
  const schema: GraphQLSchemaType[] = [
    { name: 'Project', fields: [{ name: 'fullPath', type: { name: 'ID', kind: 'SCALAR' } }, { name: 'issue', args: [{ name: 'iid', type: { name: 'String', kind: 'SCALAR' } }] }] },
    { name: 'Issue', fields: [{ name: 'timelogs', type: { kind: 'NON_NULL', ofType: { name: 'IssueTimelogConnection', kind: 'OBJECT' } } }] },
    { name: 'IssueTimelogConnection', fields: [
      { name: 'nodes', type: { kind: 'NON_NULL', ofType: { kind: 'LIST', ofType: { kind: 'NON_NULL', ofType: { name: 'IssueTimelog', kind: 'OBJECT' } } } } },
      { name: 'pageInfo', type: { name: 'PageInfo', kind: 'OBJECT' } }
    ] },
    { name: 'IssueTimelog', fields: [
      { name: 'id' }, { name: 'timeSpent' }, { name: 'spentAt' }, { name: 'summary' }, { name: 'user', type: { name: 'User', kind: 'OBJECT' } },
      { name: 'userPermissions', type: { name: 'TimelogPermissions', kind: 'OBJECT' } }
    ] },
    { name: 'User', fields: [{ name: 'id' }, { name: 'name' }] },
    { name: 'PageInfo', fields: [{ name: 'hasNextPage' }, { name: 'endCursor' }] },
    { name: 'TimelogPermissions', fields: [{ name: 'adminTimelog' }] }
  ];
  const queries: string[] = [];
  const client = new GitLabClient('https://gitlab-schema.example.test', token, async (_input, init) => {
    const query = (JSON.parse(String(init?.body)) as { query: string }).query;
    queries.push(query);
    return new Response(JSON.stringify({ data: selectedCapabilityData(query, schema) }));
  });
  const capabilities = await client.getIssueCapabilities();
  assert.ok(queries.length >= 3, 'nested connection and node types are queried without guessing wrappers');
  assert.equal(capabilities.timelogReport, true);
  assert.equal(capabilities.timelogSource, 'issue');
  assert.equal(capabilities.timelogSummary, true);
  assert.deepEqual(capabilities.timelogUserFields, ['id', 'name']);
  assert.equal(capabilities.timelogAdminPermission, true);
});

test('keeps the Namespace and namespacePath GraphQL shape for newer GitLab schemas', async () => {
  const names = (value: string) => value.split(' ').map((name) => ({ name }));
  const scope = { fields: [{ name: 'workItem', args: [{ name: 'iid', type: { name: 'String' } }] }, { name: 'workItemTypes', args: [{ name: 'name', type: { name: 'WorkItemsTypeEnum' } }] }] };
  const schema: GraphQLSchemaType[] = [
    { name: 'Namespace', ...scope },
    { name: 'WorkItem', fields: names('id iid title state webUrl widgets') },
    { name: 'WorkItemWidgetHierarchy', fields: names('parent children') },
    { name: 'Mutation', fields: [
      { name: 'workItemCreate', args: [{ name: 'input', type: { name: 'CreateInput' } }] },
      { name: 'workItemUpdate', args: [{ name: 'input', type: { name: 'UpdateInput' } }] }
    ] },
    { name: 'CreateInput', inputFields: names('namespacePath hierarchyWidget workItemTypeId title') },
    { name: 'UpdateInput', inputFields: names('hierarchyWidget stateEvent title descriptionWidget') },
    { name: 'WorkItemWidgetHierarchyInput', inputFields: names('parentId') }
  ];
  const client = new GitLabClient('https://gitlab.example.test', token, async (_input, init) => {
    const query = (JSON.parse(String(init?.body)) as { query: string }).query;
    return new Response(JSON.stringify({ data: selectedCapabilityData(query, schema) }));
  });
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

test('reads mapped Work Item permissions only when the instance exposes that schema', async () => {
  let body: { query: string; variables: Record<string, unknown> } | undefined;
  const client = new GitLabClient('https://gitlab-ce-16-11-10.example.test', token, async (_input, init) => {
    body = JSON.parse(String(init?.body)) as { query: string; variables: Record<string, unknown> };
    return new Response(JSON.stringify({ data: { project: { workItem: { userPermissions: { updateWorkItem: true, createNote: false } } } } }));
  });
  assert.deepEqual(await client.getWorkItemPermissions('group/project', 7, ['updateWorkItem', 'createNote'], 'project'), { updateWorkItem: true, createNote: false });
  assert.match(body?.query ?? '', /project\(fullPath: \$path\)\s*\{\s*workItem\(iid: \$iid\)/);
  assert.match(body?.query ?? '', /userPermissions\s*\{\s*updateWorkItem createNote\s*\}/);
  assert.deepEqual(body?.variables, { path: 'group/project', iid: '7' });
});

test('selects Work Item permission fields when Issue.userPermissions is absent', async () => {
  const schema: GraphQLSchemaType[] = [
    { name: 'Query', kind: 'OBJECT', fields: [{ name: 'currentUser' }] },
    { name: 'Mutation', kind: 'OBJECT', fields: [{ name: 'workItemUpdate' }] },
    { name: 'Project', kind: 'OBJECT', fields: [
      { name: 'fullPath', type: { name: 'ID', kind: 'SCALAR' } },
      { name: 'workItem', args: [{ name: 'iid', type: { name: 'String', kind: 'SCALAR' } }] }
    ] },
    { name: 'Issue', kind: 'OBJECT', fields: [{ name: 'id' }] },
    { name: 'WorkItem', kind: 'OBJECT', fields: [
      { name: 'id' }, { name: 'iid' }, { name: 'widgets' }, { name: 'userPermissions', type: { name: 'WorkItemPermissions', kind: 'OBJECT' } }
    ] },
    { name: 'WorkItemPermissions', kind: 'OBJECT', fields: [{ name: 'updateWorkItem' }, { name: 'adminWorkItem' }, { name: 'createNote' }] }
  ];
  const client = new GitLabClient('https://gitlab-schema.example.test', token, async () =>
    new Response(JSON.stringify({ data: { __schema: { types: schema } } })));
  const capabilities = await client.getIssueCapabilities();
  assert.equal(capabilities.issuePermissionSource, 'workItem');
  assert.deepEqual(capabilities.workItemPermissionFields, ['updateWorkItem', 'adminWorkItem', 'createNote']);
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
  const schema: GraphQLSchemaType[] = [
    { name: 'Namespace', fields: [{ name: 'workItem', args: [{ name: 'iid' }] }] },
    { name: 'WorkItem', ...names('id iid title state webUrl namespace project widgets workItemType') },
    { name: 'WorkItemWidgetHierarchy', ...names('parent children') },
    { name: 'WorkItemWidgetLinkedItems', ...names('linkedItems') },
    { name: 'WorkItemWidgetLabels', ...names('labels') },
    { name: 'WorkItemWidgetAssignees', ...names('assignees') }
  ];
  const client = new GitLabClient('https://gitlab.example.test', token, async (_input, init) => {
    const query = (JSON.parse(String(init?.body)) as { query: string }).query;
    return new Response(JSON.stringify({ data: selectedCapabilityData(query, schema) }));
  });
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
  assert.deepEqual(calls[1].variables, { path: 'team/service', iid: '7', childrenAfter: 'child-cursor', includeChildren: true, linksAfter: 'link-cursor', includeLinks: true });
  assert.match(calls[0].query, /WorkItemWidgetHierarchy/);
  assert.match(calls[0].query, /WorkItemWidgetLinkedItems/);
  assert.match(calls[0].query, /color textColor/);
  assert.equal(result.root?.id, 'gid://gitlab/WorkItem/12');
  assert.equal(result.parents[0].title, 'Parent');
  assert.equal(result.children.length, 2);
  assert.equal(result.links.length, 2);
  assert.deepEqual(result.links.map((entry) => entry.type), ['RELATED', 'BLOCKS']);
});

for (const scope of ['namespace', 'project'] as const) {
  test('loads graph relations against the GitLab Label.title contract using the ' + scope + ' root', async () => {
    // The GraphQL Label contract uses title; REST labels use name.
    const label: Record<string, string> = { title: 'feature', color: '#AA5500', textColor: '#FFFFFF' };
    const client = new GitLabClient('https://gitlab.example.test', token, async (_input, init) => {
      const { query } = JSON.parse(String(init?.body)) as { query: string };
      const selections = [...query.matchAll(/on WorkItemWidgetLabels\s*\{\s*labels[^{}]*\{\s*nodes\s*\{([^}]+)\}/g)];
      assert.ok(selections.length, 'the request includes label metadata');
      const projected: Record<string, string>[] = [];
      for (const selection of selections) {
        const fields = [...selection[1].matchAll(/(?:(\w+)\s*:\s*)?(\w+)/g)];
        const unknown = fields.find((field) => !Object.hasOwn(label, field[2]));
        if (unknown) return new Response(JSON.stringify({ errors: [{ message: "Field '" + unknown[2] + "' doesn't exist on type 'Label'" }] }));
        projected.push(Object.fromEntries(fields.map((field) => [field[1] ?? field[2], label[field[2]]])));
      }
      const item = (id: string, iid: string) => ({ id, iid, title: id, widgets: [{ labels: { nodes: [projected.at(-1)] } }] });
      return new Response(JSON.stringify({ data: { [scope]: { workItem: {
        ...item('root', '7'), widgets: [
          { labels: { nodes: [projected[0]] } },
          { parent: item('parent', '1'), children: { nodes: [item('child', '8')], pageInfo: { hasNextPage: false } } },
          { linkedItems: { nodes: [{ linkType: 'BLOCKS', workItem: item('linked', '9') }], pageInfo: { hasNextPage: false } } }
        ]
      } } } }));
    });
    const graph = await client.loadIssueGraphRelations('team/service', 7, {
      workItemScope: scope, workItemGraphFields: ['title'], graphWorkItems: true, graphHierarchy: true,
      graphLinkedItems: true, graphLabels: true, graphAssignees: false, graphWorkItemTypes: false
    });
    const items = [graph.root!, ...graph.parents, ...graph.children, ...graph.links.map((link) => link.item)];
    assert.deepEqual(items.map((item) => item.id), ['root', 'parent', 'child', 'linked']);
    assert.equal(graph.links[0].type, 'BLOCKS');
    for (const item of items) assert.deepEqual(item.widgets?.[0].labels?.nodes, [{ name: 'feature', color: '#AA5500', textColor: '#FFFFFF' }]);
  });
}

test('stops requesting a completed WorkItem connection while another connection paginates', async () => {
  const calls: Array<{ query: string; variables: Record<string, unknown> }> = [];
  const client = new GitLabClient('https://gitlab.example.test', token, async (_input, init) => {
    const request = JSON.parse(String(init?.body)) as { query: string; variables: Record<string, unknown> };
    calls.push(request);
    const later = request.variables.includeChildren === false;
    const data = { data: { namespace: { workItem: { id: 'work-item', iid: '7', widgets: [
      ...(later ? [] : [{ children: { nodes: [{ id: 'child-1', iid: '8', title: 'Child', state: 'OPEN' }], pageInfo: { hasNextPage: false } } }]),
      { linkedItems: { nodes: [{ linkType: 'RELATED', workItem: { id: later ? 'linked-2' : 'linked-1', iid: later ? '10' : '9', title: 'Link', state: 'OPEN' } }], pageInfo: { hasNextPage: !later, endCursor: later ? null : 'links-next' } } }
    ] } } } };
    return new Response(JSON.stringify(data));
  });
  const graph = await client.loadIssueGraphRelations('team/project', 7, {
    graphWorkItems: true, graphHierarchy: true, graphLinkedItems: true, graphLabels: false, graphAssignees: false, graphWorkItemTypes: false
  });
  assert.equal(calls.length, 2);
  assert.equal(calls[1].variables.includeChildren, false);
  assert.equal(calls[1].variables.includeLinks, true);
  assert.match(calls[1].query, /children\(first: 100, after: \$childrenAfter\) @include\(if: \$includeChildren\)/);
  assert.equal(graph.children.length, 1);
  assert.equal(graph.links.length, 2);
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

test('loads paginated Issue.timelogs with only schema-confirmed entry fields', async () => {
  const requests: Array<{ query: string; variables: { after: string | null } }> = [];
  const fetcher: FetchLike = async (_input, init) => {
    const body = JSON.parse(String(init?.body)) as { query: string; variables: { after: string | null } };
    requests.push(body);
    const second = body.variables.after === 'next-issue-time';
    const entry = { id: second ? 'issue-time-2' : 'issue-time-1', timeSpent: 60, spentAt: '2026-10-01T12:00:00Z', user: { id: 9, name: 'Tester', username: 'tester' } };
    return new Response(JSON.stringify({ data: { project: { issue: { timelogs: {
      nodes: [entry], pageInfo: { hasNextPage: !second, endCursor: second ? null : 'next-issue-time' }
    } } } } }));
  };
  const client = new GitLabClient('https://gitlab.example.test', token, fetcher);
  const entries = await client.listIssueTimelogs('group/project', 7, 'project', false, 'issue', false, ['id', 'name']);
  assert.deepEqual(entries.map((entry) => entry.id), ['issue-time-1', 'issue-time-2']);
  assert.deepEqual(requests.map((request) => request.variables.after), [null, 'next-issue-time']);
  assert.match(requests[0].query, /project\(fullPath: \$path\)\s*\{\s*issue\(iid: \$iid\)/);
  assert.doesNotMatch(requests[0].query, /summary|userPermissions|username/);
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
