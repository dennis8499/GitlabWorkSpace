import assert from 'node:assert/strict';
import test from 'node:test';
import type { ExtensionContext, Memento, SecretStorage } from 'vscode';
import { GitLabClient, type FetchLike, type GitLabWriteScope } from '../../src/api/gitLabClient';
import { groupProjectsPageReadKey } from '../../src/api/gitLabReadKeys';
import type { GitLabProject } from '../../src/api/types';
import { GitLabSession } from '../../src/connection/session';
import type { IssuePageResult, IssuePanelRequest, IssuePanelResponse } from '../../src/issues/protocol';
import { OperationTracker } from '../../src/workspace/operations';

const json = (value: unknown, headers?: HeadersInit) => new Response(JSON.stringify(value), { headers });

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

async function waitForRead(started: Promise<void>, request: Promise<unknown>): Promise<void> {
  await Promise.race([started, request.then(() => { throw new Error('The Issue read completed before reaching the deferred request.'); })]);
}

class State implements Memento {
  private readonly values = new Map<string, unknown>([
    ['gitlabWorkspace.baseUrl', 'https://gitlab.example.test'],
    ['gitlabWorkspace.selectedGroupId', 42], ['gitlabWorkspace.selectedGroupLabel', 'team']
  ]);
  get<T>(key: string, fallback?: T): T | undefined { return (this.values.get(key) as T | undefined) ?? fallback; }
  async update(key: string, value: unknown): Promise<void> { this.values.set(key, value); }
  keys(): readonly string[] { return [...this.values.keys()]; }
}

async function fixture(trackOperations = false) {
  const loader = require('node:module'), original = loader._load;
  loader._load = (name: string, ...args: unknown[]) => name === 'vscode' ? {
    window: { showOpenDialog: async () => undefined }
  } : original(name, ...args);
  let Panels: typeof import('../../src/issues/issuePanel').IssuePanels;
  try { Panels = require('../../src/issues/issuePanel').IssuePanels; } finally { loader._load = original; }
  const project = (id: number): GitLabProject => ({ id, name: `Project ${id}`, path: `project-${id}`,
    path_with_namespace: `team/project-${id}`, web_url: '', http_url_to_repo: '' });
  const requests: string[] = [], messages: IssuePanelResponse[] = [];
  const hooks = {
    inventory: [project(1), project(2)],
    projectPath: undefined as string | undefined,
    pause: undefined as undefined | ((path: string) => Promise<void>)
  };
  const fetcher: FetchLike = async input => {
    const url = new URL(String(input)), path = url.pathname;
    requests.push(path + url.search);
    await hooks.pause?.(path);
    if (path === '/api/v4/groups/42/projects') {
      return url.searchParams.get('page') === '2' ? json(hooks.inventory.slice(1))
        : json(hooks.inventory.slice(0, 1), hooks.inventory.length > 1 ? { 'x-next-page': '2' } : {});
    }
    if (path === '/api/v4/projects/1') return json({ ...project(1), ...(hooks.projectPath ? { path_with_namespace: hooks.projectPath } : {}) });
    if (path === '/api/v4/projects/1/issues') return json([{ id: 100, iid: 1, project_id: 1, title: url.searchParams.get('search') }]);
    if (path === '/api/v4/markdown') return json({ html: '<p>Preview</p>' });
    throw new Error(`Unexpected test request: ${path}`);
  };
  const client = new GitLabClient('https://gitlab.example.test', 'test-token', fetcher);
  const state = new State(), session = new GitLabSession({} as SecretStorage, state, true);
  let clientReads = 0;
  session.getClient = async () => { clientReads++; return client; };
  session.ensureInstanceChecked = async () => {};
  const operations = trackOperations ? new OperationTracker() : undefined;
  const panels = new Panels!({} as ExtensionContext, session, () => {}, operations);
  panels.setWorkspace({ post: message => { if (message.type === 'issueResponse') messages.push(message.response); }, navigate: () => {}, show: async () => {} });
  Object.assign(panels, { ready: true });
  const count = (path: string) => requests.filter(request => request.split('?')[0] === '/api/v4/' + path).length;
  return { panels, session, state, client, requests, messages, hooks, count, operations, clientReads: () => clientReads };
}

test('create preview/search reuse real Session inventory pages and project details across consumers', async () => {
  const f = await fixture();
  try {
    await f.session.cachedRead(groupProjectsPageReadKey(42), client => client.listGroupProjectsPage(42));
    await f.session.cachedRead('project/1/details', client => client.getProject(1));
    await f.panels.showCreate();
    assert.equal(f.count('groups/42/projects'), 1, 'creation reuses the dashboard first page without downloading unused continuations');
    for (const suffix of ['one', 'two']) {
      await f.panels.handle({ type: 'preview', requestId: `preview-${suffix}`, projectId: 1, markdown: suffix });
      await f.panels.handle({ type: 'search', requestId: `search-${suffix}`, projectId: 1, query: `  ${suffix}  ` });
    }
    assert.equal(f.count('groups/42/projects'), 1, 'preview and search use the Host-owned picker scope without inventory enumeration');
    assert.equal(f.count('projects/1'), 1, 'previews share the project details cache');
    assert.equal(f.count('markdown'), 2);
    assert.equal(f.count('projects/1/issues'), 2, 'new queries still reach GitLab');
    assert.ok(f.requests.some(request => request.includes('search=one&')));
    assert.equal(f.messages.filter(message => message.type === 'reply').length, 4);
  } finally { f.panels.dispose(); }
});

test('empty Issue searches return before acquiring a client or checking Group inventory', async () => {
  const f = await fixture();
  try {
    await f.panels.showCreate(); f.requests.length = 0;
    const before = f.clientReads();
    await f.panels.handle({ type: 'search', requestId: 'empty', projectId: 1, query: ' \n\t ' });
    assert.deepEqual(f.requests, []); assert.equal(f.clientReads(), before);
    const reply = f.messages.find(message => message.type === 'reply' && message.requestId === 'empty');
    const page = reply?.type === 'reply' ? reply.result as IssuePageResult<unknown> : undefined;
    assert.deepEqual(page?.items, []); assert.equal(page?.complete, true); assert.equal(page?.query, '');
  } finally { f.panels.dispose(); }
});

test('concurrent preview/search skip inventory refresh and creation/upload verify fresh scoped Project details', async () => {
  const f = await fixture();
  try {
    await f.panels.showCreate(); f.session.invalidateReadCache(); f.requests.length = 0;
    await Promise.all([
      f.panels.handle({ type: 'preview', requestId: 'preview', projectId: 1, markdown: 'Hello' }),
      f.panels.handle({ type: 'search', requestId: 'search', projectId: 1, query: 'Hello' })
    ]);
    assert.equal(f.count('groups/42/projects'), 0, 'the Host picker already proves the selected Project belongs to this Group');
    const before = f.count('projects/1');
    f.hooks.projectPath = 'team2/project-1';
    await assert.rejects(f.panels.handle({ type: 'create', projectId: 1, input: { title: 'New issue' } }), /outside the selected group/i);
    await assert.rejects(f.panels.handle({ type: 'upload', requestId: 'upload', projectId: 1 }), /outside the selected group/i);
    assert.equal(f.count('groups/42/projects'), 0, 'explicit writes validate one fresh Project instead of downloading the Group inventory');
    assert.equal(f.count('projects/1'), before + 2, 'creation and upload independently validate live namespace membership');
    assert.equal(f.count('projects/1/issues'), 1, 'membership failure prevents Issue creation');
  } finally { f.panels.dispose(); }
});

for (const type of ['preview', 'search'] as const) for (const change of ['navigation', 'account', 'group', 'hide'] as const) {
  test(`${type} drops a completed old response after ${change} changes`, async () => {
    const f = await fixture(true); let release!: () => void;
    const delay = new Promise<void>(resolve => { release = resolve; });
    try {
      await f.panels.showCreate();
      const started = deferred();
      f.hooks.pause = async path => {
        if (path === (type === 'preview' ? '/api/v4/markdown' : '/api/v4/projects/1/issues')) { started.resolve(); await delay; }
      };
      const request: IssuePanelRequest = type === 'preview'
        ? { type, requestId: 'stale', projectId: 1, markdown: 'Hello' }
        : { type, requestId: 'stale', projectId: 1, query: 'Hello' };
      const pending = f.panels.handle({ ...request, operationId: 'stale-operation' });
      await waitForRead(started.promise, pending);
      if (change === 'navigation') f.panels.close();
      else if (change === 'account') (f.session as unknown as { connectionEpochValue: number }).connectionEpochValue++;
      else if (change === 'group') await f.state.update('gitlabWorkspace.selectedGroupId', 43);
      else f.panels.suspendReads();
      release(); await pending;
      assert.equal(f.messages.some(message => message.type === 'reply' && message.requestId === 'stale'), false);
      assert.equal(f.operations!.get('stale-operation')?.status, 'cancelled', 'the operation outcome remains observable while the view is hidden');
      const result = f.messages.find(message => message.type === 'actionResult' && message.requestId === 'stale');
      if (change === 'hide') assert.equal(result, undefined, 'hidden views suppress terminal UI messages');
      else assert.equal(result?.type === 'actionResult' ? result.status : undefined, 'cancelled');
    } finally { release(); f.panels.dispose(); }
  });
}

test('cancelled Project validation cannot start preview while a completed independent search remains observable', async () => {
  const f = await fixture(); let release!: () => void;
  const delay = new Promise<void>(resolve => { release = resolve; });
  try {
    await f.panels.showCreate(); f.session.invalidateReadCache(); f.requests.length = 0;
    const started = deferred();
    f.hooks.pause = async path => { if (path === '/api/v4/projects/1') { started.resolve(); await delay; } };
    const pending = Promise.all([
      f.panels.handle({ type: 'preview', requestId: 'cancel-preview', projectId: 1, markdown: 'Hello' }),
      f.panels.handle({ type: 'search', requestId: 'cancel-search', projectId: 1, query: 'Hello' })
    ]);
    await waitForRead(started.promise, pending);
    f.panels.close(); release(); await pending;
    assert.equal(f.count('groups/42/projects'), 0);
    assert.equal(f.count('markdown'), 0, 'an abandoned Project details read cannot initiate Markdown rendering');
    assert.equal(f.messages.some(message => message.type === 'reply' && message.requestId === 'cancel-preview'), false);
    const preview = f.messages.find(message => message.type === 'actionResult' && message.requestId === 'cancel-preview');
    assert.equal(preview?.type === 'actionResult' ? preview.status : undefined, 'cancelled');
    const search = f.messages.find(message => message.type === 'actionResult' && message.requestId === 'cancel-search');
    assert.ok(search?.type === 'actionResult' && ['succeeded', 'cancelled'].includes(search.status), 'search has its own receipt independent of optional preview validation');
  } finally { release(); f.panels.dispose(); }
});

test('restored create forms cancel pending shared reads across another hide and ready cycle', async () => {
  const f = await fixture(); let release!: () => void;
  const delay = new Promise<void>(resolve => { release = resolve; });
  try {
    await f.panels.showCreate(); f.panels.suspendReads(); await f.panels.handle({ type: 'ready' });
    f.session.invalidateReadCache(); f.requests.length = 0;
    const started = deferred();
    f.hooks.pause = async path => { if (path === '/api/v4/projects/1') { started.resolve(); await delay; } };
    const pending = f.panels.handle({ type: 'preview', requestId: 'restored-preview', projectId: 1, markdown: 'Hello' });
    await waitForRead(started.promise, pending);
    f.panels.suspendReads(); await f.panels.handle({ type: 'ready' });
    release(); await pending;
    assert.equal(f.count('markdown'), 0, 'a cancelled project details lookup cannot start Markdown rendering after resume');
    assert.equal(f.messages.some(message => message.type === 'reply' && message.requestId === 'restored-preview'), false);
    const result = f.messages.find(message => message.type === 'actionResult' && message.requestId === 'restored-preview');
    assert.equal(result?.type === 'actionResult' ? result.status : undefined, 'cancelled');
  } finally { release(); f.panels.dispose(); }
});

test('Issue GraphQL writes carry their known scope while opaque hierarchy children retain broad invalidation', async () => {
  const f = await fixture();
  const writes: Array<{ action: string; scope?: GitLabWriteScope }> = [];
  const client = {
    scope: undefined as GitLabWriteScope | undefined,
    withWriteScope(scope: GitLabWriteScope): GitLabClient { return Object.assign(Object.create(this), { scope }); },
    async resolveIssueThread() { writes.push({ action: 'resolve', scope: this.scope }); },
    async createChildTask() { writes.push({ action: 'createChild', scope: this.scope }); },
    async getWorkItemTypeAndParent() { return { id: 'new-task', type: 'Task' }; },
    async setChildParent() { writes.push({ action: 'parent', scope: this.scope }); },
    async setChildState() { writes.push({ action: 'state', scope: this.scope }); },
    async updateChildTask() { writes.push({ action: 'updateChild', scope: this.scope }); }
  };
  const issue = { id: 100, iid: 1, project_id: 1, title: 'Parent', state: 'opened' };
  Object.assign(f.session, { getClient: async () => client as unknown as GitLabClient,
    currentIssueCapabilities: { discussionResolve: true } });
  Object.assign(f.panels, { issue, mode: 'detail', suspended: true,
    lastSnapshot: { type: 'detailData', data: { issue, project: { path_with_namespace: 'team/one' },
      parentWorkItemId: 'parent', taskTypeId: 'task-type', canManageChildren: true,
      tasks: [{ id: 'opaque-task', iid: '2', canEdit: true }], discussions: [{ id: 'known-thread' }] } } });
  try {
    for (const [action, payload] of [
      ['resolveThread', { discussionId: 'known-thread', resolved: true }],
      ['resolveThread', { discussionId: 'unknown-thread', resolved: true }],
      ['createChild', { title: 'New task' }], ['addChild', { taskIid: 3 }],
      ['removeChild', { taskId: 'opaque-task' }], ['setChildState', { taskId: 'opaque-task', stateEvent: 'close' }],
      ['updateChild', { taskId: 'opaque-task', title: 'Updated', description: 'Body' }]
    ] as const) await f.panels.handle({ type: 'invoke', issueId: issue.id, action, payload });
    const scope: GitLabWriteScope = { projectId: 1, issueIid: 1, resource: 'issues' };
    assert.deepEqual(writes, [
      { action: 'resolve', scope }, { action: 'resolve', scope: undefined }, { action: 'createChild', scope }, { action: 'parent', scope },
      { action: 'parent', scope: undefined }, { action: 'state', scope: undefined }, { action: 'updateChild', scope: undefined }
    ]);
    assert.deepEqual(f.requests, [], 'scope propagation never performs additional GitLab reads');
  } finally { f.panels.dispose(); }
});
