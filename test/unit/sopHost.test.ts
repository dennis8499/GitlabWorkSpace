import assert from 'node:assert/strict';
import test from 'node:test';
import { readSopRecord } from '../../src/workspace/sop';
import { sopConfigKey } from '../../src/workspace/sopStore';

const loader = require('node:module') as { _load: (name: string, parent: unknown, main: boolean) => unknown };
const originalLoad = loader._load;
loader._load = (name, parent, main) => name === 'vscode' ? {} : originalLoad(name, parent, main);
let WorkspacePanel: typeof import('../../src/workspace/workspacePanel').WorkspacePanel;
try { ({ WorkspacePanel } = require('../../src/workspace/workspacePanel')); } finally { loader._load = originalLoad; }

function fixture(client: any) {
  const values = new Map<string, unknown>();
  values.set(sopConfigKey('https://gitlab.test', 1), { difficulties: ['Easy'] });
  const messages: any[] = [];
  const host: any = Object.assign(Object.create(WorkspacePanel.prototype), {
    session: { baseUrl: 'https://gitlab.test', selectedGroup: { id: 1, full_path: 'team' }, getClient: async () => client },
    context: { globalState: { get: (key: string) => values.get(key), update: async (key: string, value: unknown) => { values.set(key, value); } } },
    currentUser: { id: 7, username: 'user', name: 'User' }, connectedScopeKey: () => 'scope',
    sopCreationsInFlight: new Set(), post: (message: unknown) => messages.push(message), noteOutcome: () => undefined
  });
  return { host, messages, values };
}
const story = { id: 50, project_id: 2, iid: 5, title: 'Story', state: 'opened', labels: ['User Story'], web_url: 'https://gitlab.test/story' };
const created = { id: 60, project_id: 1, iid: 6, title: 'Task', state: 'opened', labels: ['Task', 'Easy'], web_url: 'https://gitlab.test/task' };
const request = { type: 'createSopIssue', requestId: 'request', connectedScope: 'scope', creationId: 'create-12345', projectId: 1,
  kind: 'Task', title: 'Task', assigneeId: 7, difficulty: 'Easy', story: { projectId: 2, issueIid: 5 }, fields: {} };

test('creates one card and retries a lost direct-link response without duplicating it', async () => {
  let creations = 0, linkWrites = 0, linked = false;
  const client: any = {
    getProject: async (id: number) => ({ id, path_with_namespace: id === 1 ? 'team/app' : 'team/docs' }),
    listProjectMembers: async () => [{ id: 7 }], listProjectLabels: async () => [{ name: 'Task' }, { name: 'Easy' }],
    getIssue: async (projectId: number) => projectId === 2 ? story : created,
    createIssue: async () => { creations++; return created; },
    listIssueLinks: async () => linked ? [{ ...story, link_type: 'relates_to' }] : [],
    addIssueLink: async () => { linkWrites++; linked = true; throw new Error('response lost after link'); }
  };
  const { host, messages } = fixture(client);
  await assert.rejects(host.createSopIssue(request), /response lost/);
  assert.equal(messages.at(-1).issue.iid, 6);
  await host.createSopIssue({ type: 'retrySopLink', requestId: 'retry', connectedScope: 'scope', creationId: request.creationId });
  assert.equal(creations, 1); assert.equal(linkWrites, 1);
  assert.equal(messages.at(-1).linked, true);
});

test('an unconfirmed create receipt prevents reusing the operation to create a duplicate', async () => {
  let creations = 0;
  const client: any = {
    getProject: async (id: number) => ({ id, path_with_namespace: id === 1 ? 'team/app' : 'team/docs' }),
    listProjectMembers: async () => [{ id: 7 }], listProjectLabels: async () => [{ name: 'Task' }, { name: 'Easy' }],
    getIssue: async () => story,
    createIssue: async () => { creations++; throw new Error('response lost'); }
  };
  const { host } = fixture(client);
  await assert.rejects(host.createSopIssue(request), /response lost/);
  await assert.rejects(host.createSopIssue(request), /結果尚未確認/);
  assert.equal(creations, 1);
});

test('transition rereads and rejects stale issues, and writes only the managed stage label', async () => {
  let writes = 0, changed: any;
  const issue = { ...created, updated_at: 'new', labels: ['Task', 'Doing', 'customer'] };
  const client: any = {
    withRequestBudget() { return this; }, withWriteScope() { return this; },
    getProject: async () => ({ id: 1, path_with_namespace: 'team/app' }), getIssue: async () => issue,
    listIssueLinks: async () => [], listRelatedMergeRequests: async () => [], listProjectLabels: async () => [{ name: 'Pending' }],
    updateIssueIfUnchanged: async (_project: number, _iid: number, expected: string, input: unknown) => { assert.equal(expected, 'new'); writes++; changed = input; }
  };
  const { host, values } = fixture(client);
  values.set(sopConfigKey('https://gitlab.test', 1), { difficulties: ['Easy'], stages: { Pending: ['Waiting', 'Pending'] } });
  const transition = { type: 'transitionSop', requestId: 'save', connectedScope: 'scope', projectId: 1, issueIid: 6,
    expectedUpdatedAt: 'old', target: 'Pending', fields: { pendingReason: 'blocked', waitingFor: 'QA', progress: 'working', nextStep: 'retry' } };
  await assert.rejects(host.handleSopRequest(transition), /已變更/); assert.equal(writes, 0);
  await host.handleSopRequest({ ...transition, expectedUpdatedAt: 'new' });
  assert.deepEqual(changed.labels, ['Task', 'customer', 'Pending']);
  const record = readSopRecord(changed.description);
  assert.equal(record.pendingFrom, 'Doing'); assert.equal(record.history[0].by, 'user');
  assert.equal(writes, 1);
});

test('detail loads relation pages on demand and refuses a stale continuation', async () => {
  let linkCalls = 0;
  const issue = { ...created, updated_at: 'current' };
  const client: any = {
    withRequestBudget() { return this; }, getProject: async () => ({ id: 1, path_with_namespace: 'team/app' }), getIssue: async () => issue,
    listIssueLinksPage: async (_project: number, _iid: number, cursor?: string) => { linkCalls++; return cursor
      ? { items: [{ ...story, link_type: 'relates_to' }], complete: true }
      : { items: [], complete: false, nextCursor: 'next' }; },
    listRelatedMergeRequestsPage: async () => ({ items: [], complete: true })
  };
  const { host, messages } = fixture(client);
  await host.handleSopRequest({ type: 'loadSopDetail', requestId: 'detail', connectedScope: 'scope', projectId: 1, issueIid: 6 });
  assert.equal(linkCalls, 1); assert.equal(messages.at(-1).linksComplete, false); assert.equal(messages.at(-1).linksCursor, 'next');
  const page = { type: 'loadSopRelationsPage', requestId: 'page', connectedScope: 'scope', projectId: 1, issueIid: 6, kind: 'links', cursor: 'next', expectedUpdatedAt: 'old' };
  await host.handleSopRequest(page); assert.match(messages.at(-1).error, /已變更/); assert.equal(linkCalls, 1);
  await host.handleSopRequest({ ...page, expectedUpdatedAt: 'current' });
  assert.equal(linkCalls, 2); assert.equal(messages.at(-1).complete, true); assert.equal(messages.at(-1).links[0].iid, story.iid);
});

test('unreadable relation data keeps detail available but never reports a passing check', async () => {
  const issue = { ...created, updated_at: 'current' };
  const client: any = { withRequestBudget() { return this; }, getProject: async () => ({ id: 1, path_with_namespace: 'team/app' }),
    getIssue: async () => issue, listIssueLinksPage: async () => { throw new Error('permission denied'); },
    listRelatedMergeRequestsPage: async () => ({ items: [], complete: true }) };
  const { host, messages } = fixture(client);
  await host.handleSopRequest({ type: 'loadSopDetail', requestId: 'detail', connectedScope: 'scope', projectId: 1, issueIid: 6 });
  assert.equal(messages.at(-1).issue.iid, 6); assert.equal(messages.at(-1).linksComplete, false);
  assert.match(messages.at(-1).linksError, /permission denied/);
  assert.ok(Object.values(messages.at(-1).checks).every((check: any) => check.ok === false));
});
