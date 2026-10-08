import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import type { Memento, SecretStorage } from 'vscode';
import type { GitLabClient, GitLabIssueCapabilities } from '../../src/api/gitLabClient';
import type { GitLabMetadata } from '../../src/api/types';
import { GitLabSession } from '../../src/connection/session';
import { accountTokenKey } from '../../src/connection/accountStore';
import { groupWorkspaceReadKey } from '../../src/api/gitLabReadKeys';

class MemoryStore implements Memento {
  private readonly values = new Map<string, unknown>();
  get<T>(key: string, defaultValue?: T): T | undefined { return (this.values.get(key) as T | undefined) ?? defaultValue; }
  async update(key: string, value: unknown): Promise<void> {
    if (value === undefined) this.values.delete(key);
    else this.values.set(key, value);
  }
  keys(): readonly string[] { return [...this.values.keys()]; }
  setKeysForSync(): void {}
}

class DelayedIdentityStore extends MemoryStore {
  private hideIdentity = false;
  override get<T>(key: string, defaultValue?: T): T | undefined {
    if (this.hideIdentity && key === 'gitlabWorkspace.currentUserId') return defaultValue;
    return super.get<T>(key, defaultValue);
  }
  override async update(key: string, value: unknown): Promise<void> {
    await super.update(key, value);
    if (key === 'gitlabWorkspace.currentUserId' && value !== undefined) this.hideIdentity = true;
  }
  revealIdentity(): void { this.hideIdentity = false; }
}

class MemorySecrets {
  readonly values = new Map<string, string>();
  async get(key: string): Promise<string | undefined> { return this.values.get(key); }
  async store(key: string, value: string): Promise<void> { this.values.set(key, value); }
  async delete(key: string): Promise<void> { this.values.delete(key); }
  onDidChange = () => ({ dispose() {} });
}

async function serve(response: (tokenHeader: string | undefined) => { status: number; body: unknown }): Promise<{ server: Server; baseUrl: string; tokens: Array<string | undefined> }> {
  const tokens: Array<string | undefined> = [];
  const server = createServer((request, responseStream) => {
    const auth = request.headers['private-token'];
    const token = Array.isArray(auth) ? auth[0] : auth;
    tokens.push(token);
    const result = response(token);
    responseStream.writeHead(result.status, { 'Content-Type': 'application/json' });
    responseStream.end(JSON.stringify(result.body));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as AddressInfo;
  return { server, baseUrl: `http://127.0.0.1:${address.port}`, tokens };
}

async function stop(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

async function sessionWithInstance(metadata: Promise<GitLabMetadata>): Promise<GitLabSession> {
  const session = new GitLabSession(new MemorySecrets() as unknown as SecretStorage, new MemoryStore());
  const capabilities = { hierarchy: false, childMutations: false, discussionResolve: false } as GitLabIssueCapabilities;
  (session as unknown as { getClient: () => Promise<GitLabClient> }).getClient = async () => ({
    getMetadata: () => metadata,
    getIssueCapabilities: async () => capabilities
  } as unknown as GitLabClient);
  await session.ensureInstanceChecked();
  return session;
}

test('recognizes CE 16.11.10 as the minimum and keeps edition limits in capability diagnostics', async () => {
  const session = await sessionWithInstance(Promise.resolve({ version: '16.11.10-ee', enterprise: false }));
  assert.equal(session.issueCapabilities?.hierarchy, false);
  assert.ok(!session.instanceWarnings.some((warning) => /blocking issue links/i.test(warning)));
  const blockingLinks = session.capabilityDiagnostics.find((item) => item.id === 'blockingLinks');
  assert.equal(blockingLinks?.status, 'unsupported');
  assert.match(blockingLinks?.reason ?? '', /Community Edition/);
  assert.ok(!session.instanceWarnings.some((warning) => /低於最低支援版本/));
  assert.equal(session.capabilityDiagnostics.find((item) => item.id === 'mergeRequestApprovals')?.status, 'supported');
});

test('does not infer Premium or Ultimate blocking-link support from Enterprise Edition metadata', async () => {
  const session = await sessionWithInstance(Promise.resolve({ version: '19.4.1-ee', enterprise: true }));
  const blockingLinks = session.capabilityDiagnostics.find((item) => item.id === 'blockingLinks');
  assert.equal(blockingLinks?.status, 'unknown');
  assert.match(blockingLinks?.reason ?? '', /Premium 或 Ultimate/);
});

test('keeps confirmed API capabilities when GitLab version metadata is unavailable', async () => {
  const session = await sessionWithInstance(Promise.reject(new Error('metadata unavailable')));
  assert.equal(session.issueCapabilities?.discussionResolve, false);
  assert.ok(session.instanceWarnings.some((warning) => /不能確認是否符合最低支援版本.*仍可使用/));
});

test('backs failed version and capability probes off for 60 seconds but lets a manual check retry immediately', async () => {
  const session = new GitLabSession(new MemorySecrets() as unknown as SecretStorage, new MemoryStore());
  let metadataRequests = 0;
  let versionRequests = 0;
  let capabilityRequests = 0;
  (session as unknown as { getClient: () => Promise<GitLabClient> }).getClient = async () => ({
    getMetadata: async () => { metadataRequests++; throw new Error('metadata unavailable'); },
    getVersion: async () => { versionRequests++; throw new Error('version unavailable'); },
    getIssueCapabilities: async () => { capabilityRequests++; throw new Error('schema unavailable'); }
  } as unknown as GitLabClient);
  const originalNow = Date.now;
  let now = 1_800_000_000_000;
  Date.now = () => now;
  try {
    await session.ensureInstanceChecked();
    await session.ensureInstanceChecked();
    assert.deepEqual([metadataRequests, versionRequests, capabilityRequests], [1, 1, 1]);
    now += 59_999;
    await session.ensureInstanceChecked();
    assert.deepEqual([metadataRequests, versionRequests, capabilityRequests], [1, 1, 1]);
    now++;
    await session.ensureInstanceChecked();
    assert.deepEqual([metadataRequests, versionRequests, capabilityRequests], [2, 2, 2]);
    await session.ensureInstanceChecked({ force: true });
    assert.deepEqual([metadataRequests, versionRequests, capabilityRequests], [3, 3, 3]);
  } finally { Date.now = originalNow; }
});

test('a manual schema recheck clears an unknown diagnostic after a successful retry', async () => {
  const session = new GitLabSession(new MemorySecrets() as unknown as SecretStorage, new MemoryStore());
  let capabilityRequests = 0;
  (session as unknown as { getClient: () => Promise<GitLabClient> }).getClient = async () => ({
    getMetadata: async () => ({ version: '16.11.10', enterprise: false }),
    getIssueCapabilities: async () => {
      capabilityRequests++;
      if (capabilityRequests === 1) throw new Error('temporary schema failure');
      return { issuePermissionSource: 'issue', issuePermissionFields: ['updateIssue', 'createNote'] } as GitLabIssueCapabilities;
    }
  } as unknown as GitLabClient);
  await session.ensureInstanceChecked();
  assert.equal(session.capabilityDiagnostics.find((item) => item.id === 'permissions')?.status, 'unknown');
  await session.ensureInstanceChecked({ force: true });
  assert.equal(session.capabilityDiagnostics.find((item) => item.id === 'permissions')?.status, 'supported');
  assert.equal(capabilityRequests, 2);
});

test('persists validated capabilities for one hour per GitLab account and instance revision', async () => {
  const state = new MemoryStore();
  await state.update('gitlabWorkspace.baseUrl', 'https://gitlab.example.test');
  await state.update('gitlabWorkspace.currentUserId', 7);
  const capabilities = {
    workItemScope: 'project', workItemCreatePathField: 'projectPath', issuePermissionSource: 'issue',
    issuePermissionFields: ['updateIssue', 'createNote'], workItemPermissionFields: [], workItemFields: [], workItemGraphFields: [],
    hierarchy: true, childMutations: true, graphWorkItems: true, graphHierarchy: true, graphLinkedItems: true,
    graphLabels: true, graphAssignees: true, graphWorkItemTypes: true, discussionResolve: true, startDate: true,
    timelogReport: true, timelogSource: 'issue', timelogUserFields: ['username'], timelogCreate: true,
    timelogCreateDated: true, timelogCreateSummary: true, timelogAdminPermission: true, timelogDelete: true, createPermission: true
  } satisfies GitLabIssueCapabilities;
  let metadata: GitLabMetadata = { version: '16.11.10', revision: 'revision-a', enterprise: false };
  let capabilityRequests = 0;
  const client = {
    getMetadata: async () => metadata,
    getIssueCapabilities: async () => { capabilityRequests++; return capabilities; }
  } as unknown as GitLabClient;
  const createSession = (): GitLabSession => {
    const session = new GitLabSession(new MemorySecrets() as unknown as SecretStorage, state);
    (session as unknown as { getClient: () => Promise<GitLabClient> }).getClient = async () => client;
    return session;
  };
  const originalNow = Date.now;
  let now = 1_800_000_000_000;
  Date.now = () => now;
  try {
    await createSession().ensureInstanceChecked();
    assert.equal(capabilityRequests, 1);
    await createSession().ensureInstanceChecked();
    assert.equal(capabilityRequests, 1, 'the next session reuses the same account and revision snapshot');

    await createSession().ensureInstanceChecked({ force: true });
    assert.equal(capabilityRequests, 2, 'manual detection bypasses the persistent snapshot');

    await state.update('gitlabWorkspace.currentUserId', 8);
    await createSession().ensureInstanceChecked();
    assert.equal(capabilityRequests, 3, 'a different account gets an independent snapshot');

    metadata = { ...metadata, revision: 'revision-b' };
    await createSession().ensureInstanceChecked();
    assert.equal(capabilityRequests, 4, 'a server upgrade invalidates the earlier snapshot');

    now += 60 * 60 * 1000 + 1;
    await createSession().ensureInstanceChecked();
    assert.equal(capabilityRequests, 5, 'snapshots expire after one hour');
  } finally { Date.now = originalNow; }
});

test('scopes an in-flight capability probe to the account that becomes available before the probe completes', async () => {
  const state = new MemoryStore();
  await state.update('gitlabWorkspace.baseUrl', 'https://gitlab.example.test');
  const capabilities: GitLabIssueCapabilities = {
    hierarchy: false, childMutations: false, graphWorkItems: false, graphHierarchy: false, graphLinkedItems: false,
    graphLabels: false, graphAssignees: false, graphWorkItemTypes: false, discussionResolve: false, startDate: false,
    timelogReport: false, timelogCreate: false, timelogCreateDated: false, timelogCreateSummary: false,
    timelogAdminPermission: false, timelogDelete: false, createPermission: false
  };
  let releaseCapabilities!: (value: GitLabIssueCapabilities) => void;
  const pendingCapabilities = new Promise<GitLabIssueCapabilities>((resolve) => { releaseCapabilities = resolve; });
  let notifyProbeStarted!: () => void;
  const probeStarted = new Promise<void>((resolve) => { notifyProbeStarted = resolve; });
  let capabilityRequests = 0;
  const client = {
    getMetadata: async () => ({ version: '19.4.1', revision: 'revision-a', enterprise: false }),
    getIssueCapabilities: () => { capabilityRequests++; notifyProbeStarted(); return pendingCapabilities; }
  } as unknown as GitLabClient;
  const createSession = (): GitLabSession => {
    const session = new GitLabSession(new MemorySecrets() as unknown as SecretStorage, state);
    (session as unknown as { getClient: () => Promise<GitLabClient> }).getClient = async () => client;
    return session;
  };

  const firstSession = createSession();
  const checking = firstSession.ensureInstanceChecked();
  await probeStarted;
  await state.update('gitlabWorkspace.currentUserId', 35);
  releaseCapabilities(capabilities);
  await checking;

  const snapshot = state.get<{ scope: string }>('gitlabWorkspace.issueCapabilities.v1');
  assert.equal(snapshot?.scope, JSON.stringify(['https://gitlab.example.test', 35, '19.4.1', 'revision-a', false]));
  await createSession().ensureInstanceChecked();
  assert.equal(capabilityRequests, 1, 'the completed probe is reused for the now-known account');
});

test('persists a live capability probe when global state briefly lags the authenticated account', async () => {
  const state = new DelayedIdentityStore();
  const secrets = new MemorySecrets();
  const capabilities: GitLabIssueCapabilities = {
    workItemScope: 'project', workItemCreatePathField: 'projectPath', issuePermissionSource: 'issue',
    issuePermissionFields: ['updateIssue', 'createNote'], workItemPermissionFields: [], workItemFields: [], workItemGraphFields: [],
    hierarchy: false, childMutations: false, graphWorkItems: false, graphHierarchy: false, graphLinkedItems: false,
    graphLabels: false, graphAssignees: false, graphWorkItemTypes: false, discussionResolve: false, startDate: false,
    timelogReport: false, timelogSource: 'issue', timelogUserFields: ['username'], timelogCreate: false,
    timelogCreateDated: false, timelogCreateSummary: false, timelogAdminPermission: false, timelogDelete: false, createPermission: false
  };
  let capabilityRequests = 0;
  const client = {
    getMetadata: async () => ({ version: '19.4.1', revision: 'revision-a', enterprise: false }),
    getIssueCapabilities: async () => { capabilityRequests++; return capabilities; }
  } as unknown as GitLabClient;
  const session = new GitLabSession(secrets as unknown as SecretStorage, state, true);
  session.setFetchForTesting(async () => new Response(JSON.stringify({ id: 35, username: 'validation-user' }), {
    status: 200, headers: { 'Content-Type': 'application/json' }
  }));
  (session as unknown as { getClient: () => Promise<GitLabClient> }).getClient = async () => client;

  const user = await session.connect('https://gitlab.example.test', 'test-only-token');
  assert.equal(user.id, 35);
  assert.equal(state.get<number>('gitlabWorkspace.currentUserId'), undefined, 'the test store simulates a temporarily stale Memento read');
  const snapshot = state.get<{ scope: string }>('gitlabWorkspace.issueCapabilities.v1');
  assert.equal(snapshot?.scope, JSON.stringify(['https://gitlab.example.test', 35, '19.4.1', 'revision-a', false]));

  state.revealIdentity();
  const nextSession = new GitLabSession(secrets as unknown as SecretStorage, state);
  (nextSession as unknown as { getClient: () => Promise<GitLabClient> }).getClient = async () => client;
  await nextSession.ensureInstanceChecked();
  assert.equal(capabilityRequests, 1, 'the validated snapshot is reused once the account ID is visible');
});

test('discards version and capability probe results from an earlier connection epoch', async () => {
  let releaseOldMetadata: ((value: GitLabMetadata) => void) | undefined;
  let releaseOldCapabilities: ((value: GitLabIssueCapabilities) => void) | undefined;
  const oldMetadata = new Promise<GitLabMetadata>((resolve) => { releaseOldMetadata = resolve; });
  const oldCapabilities = new Promise<GitLabIssueCapabilities>((resolve) => { releaseOldCapabilities = resolve; });
  const session = new GitLabSession(new MemorySecrets() as unknown as SecretStorage, new MemoryStore());
  const oldClient = {
    getMetadata: () => oldMetadata, getIssueCapabilities: () => oldCapabilities
  } as unknown as GitLabClient;
  const newClient = {
    getMetadata: async () => ({ version: '16.11.10', enterprise: false }),
    getIssueCapabilities: async () => ({ hierarchy: false, discussionResolve: true } as GitLabIssueCapabilities)
  } as unknown as GitLabClient;
  let selectedClient = oldClient;
  (session as unknown as { getClient: () => Promise<GitLabClient> }).getClient = async () => selectedClient;
  const oldCheck = session.ensureInstanceChecked();
  await new Promise((resolve) => setImmediate(resolve));
  const internals = session as unknown as {
    connectionEpochValue: number; currentMetadata?: GitLabMetadata; currentIssueCapabilities?: GitLabIssueCapabilities;
    metadataCheck?: Promise<void>; capabilitiesCheck?: Promise<void>;
  };
  internals.connectionEpochValue++;
  internals.currentMetadata = undefined;
  internals.currentIssueCapabilities = undefined;
  internals.metadataCheck = undefined;
  internals.capabilitiesCheck = undefined;
  selectedClient = newClient;
  await session.ensureInstanceChecked();
  releaseOldMetadata?.({ version: '15.0.0', enterprise: true });
  releaseOldCapabilities?.({ hierarchy: true, discussionResolve: false } as GitLabIssueCapabilities);
  await oldCheck;
  assert.equal(session.metadata?.version, '16.11.10');
  assert.equal(session.issueCapabilities?.discussionResolve, true);
});

test('stores the access token in SecretStorage only after the current-user check succeeds', async () => {
  const running = await serve(() => ({ status: 200, body: { id: 1, username: 'tester', name: 'Test User' } }));
  const secrets = new MemorySecrets();
  const state = new MemoryStore();
  try {
    const session = new GitLabSession(secrets as unknown as SecretStorage, state);
    const user = await session.connect(running.baseUrl, 'unit-session-token-do-not-use');
    assert.equal(user.username, 'tester');
    assert.equal(secrets.values.get(accountTokenKey(session.activeAccountId!)), 'unit-session-token-do-not-use');
    assert.equal(session.baseUrl, running.baseUrl);
    assert.equal(state.get('gitlabWorkspace.baseUrl'), undefined);
    assert.deepEqual(running.tokens, ['unit-session-token-do-not-use', 'unit-session-token-do-not-use', 'unit-session-token-do-not-use', 'unit-session-token-do-not-use']);
    assert.equal(session.capabilityDiagnostics.find((item) => item.id === 'permissions')?.status, 'unknown');
    assert.match(session.capabilityDiagnostics.find((item) => item.id === 'permissions')?.reason ?? '', /無法讀取 GitLab GraphQL Schema/);
  } finally {
    await stop(running.server);
  }
});

test('does not persist an access token rejected by GitLab', async () => {
  const running = await serve(() => ({ status: 401, body: { message: 'do not echo the token' } }));
  const secrets = new MemorySecrets();
  const state = new MemoryStore();
  try {
    const session = new GitLabSession(secrets as unknown as SecretStorage, state);
    await assert.rejects(session.connect(running.baseUrl, 'unit-invalid-token-do-not-use'));
    assert.equal(secrets.values.size, 0);
    assert.equal(state.keys().length, 0);
  } finally {
    await stop(running.server);
  }
});

test('clears the previously selected group after connecting to a different GitLab server', async () => {
  const first = await serve(() => ({ status: 200, body: { id: 1, username: 'first', name: 'First User' } }));
  const second = await serve(() => ({ status: 200, body: { id: 2, username: 'second', name: 'Second User' } }));
  const secrets = new MemorySecrets();
  const state = new MemoryStore();
  try {
    const session = new GitLabSession(secrets as unknown as SecretStorage, state);
    await session.connect(first.baseUrl, 'unit-first-server-token');
    await session.setSelectedGroup({ id: 55, name: 'Old Group', full_path: 'old/group', web_url: '' });

    await session.connect(second.baseUrl, 'unit-second-server-token');

    assert.equal(session.baseUrl, second.baseUrl);
    assert.equal(session.selectedGroup, undefined);
    assert.equal(state.get('gitlabWorkspace.selectedGroupId'), undefined);
    assert.equal(state.get('gitlabWorkspace.selectedGroupLabel'), undefined);
  } finally {
    await Promise.all([stop(first.server), stop(second.server)]);
  }
});

test('keeps the selected group when reconnecting to the same normalized GitLab server URL', async () => {
  const running = await serve(() => ({ status: 200, body: { id: 1, username: 'tester', name: 'Test User' } }));
  const secrets = new MemorySecrets();
  const state = new MemoryStore();
  try {
    const session = new GitLabSession(secrets as unknown as SecretStorage, state);
    await session.connect(running.baseUrl, 'unit-first-token');
    await session.setSelectedGroup({ id: 55, name: 'Current Group', full_path: 'current/group', web_url: '' });

    await session.connect(`${running.baseUrl}/`, 'unit-second-token');

    assert.equal(session.baseUrl, running.baseUrl);
    assert.equal(session.selectedGroup?.id, 55);
    assert.equal(session.selectedGroup?.full_path, 'current/group');
  } finally {
    await stop(running.server);
  }
});

test('clears the selected Group when the account changes on the same GitLab server', async () => {
  const server = createServer(async (request, responseStream) => {
    const supplied = request.headers['private-token'];
    const token = Array.isArray(supplied) ? supplied[0] : supplied;
    const result = request.url === '/api/v4/user'
      ? { status: 200, body: { id: token === 'unit-account-one' ? 1 : 2, username: `user-${token === 'unit-account-one' ? 1 : 2}`, name: 'Test User' } }
      : request.url === '/api/v4/metadata'
        ? { status: 200, body: { version: '19.4.1', revision: 'test' } }
        : { status: 200, body: { data: {} } };
    responseStream.writeHead(result.status, { 'Content-Type': 'application/json' });
    responseStream.end(JSON.stringify(result.body));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as AddressInfo;
  const state = new MemoryStore();
  const session = new GitLabSession(new MemorySecrets() as unknown as SecretStorage, state);
  try {
    await session.connect(`http://127.0.0.1:${address.port}`, 'unit-account-one');
    await session.setSelectedGroup({ id: 55, name: 'First account group', full_path: 'first/group', web_url: '' });
    await session.connect(`http://127.0.0.1:${address.port}`, 'unit-account-two');
    assert.equal(session.selectedGroup, undefined);
    assert.equal(session.accounts.find(account => account.id === session.activeAccountId)?.userId, 2);
  } finally { await stop(server); }
});


test('a successful MR write expires its Group review list and leaves unrelated cached reads intact', async (t) => {
  let reads = 0, writes = 0;
  const request = { id: 1, project_id: 101, iid: 1, state: 'opened', title: 'Before write' };
  const server = createServer((incoming, response) => {
    let body: unknown = { id: 7, username: 'reviewer', name: 'Reviewer' };
    if (incoming.url?.includes('/groups/42/merge_requests')) { reads++; body = [{ ...request }]; }
    if (incoming.method === 'POST' && incoming.url?.includes('/projects/101/merge_requests')) {
      writes++; request.title = 'After write'; body = request;
    }
    response.writeHead(200, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(body));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => stop(server));
  const session = new GitLabSession(new MemorySecrets() as unknown as SecretStorage, new MemoryStore());
  await session.connect('http://127.0.0.1:' + (server.address() as AddressInfo).port, 'unit-only-cache-token');
  await session.setSelectedGroup({ id: 42, name: 'Group', full_path: 'group', web_url: '' });
  const key = groupWorkspaceReadKey(42, 'mergeRequests');
  const read = () => session.cachedRead(key, client => client.listGroupMergeRequests(42, 7));
  let unrelatedReads = 0;
  const unrelated = () => session.cachedRead('group/99/boards', async () => { unrelatedReads++; return [99]; });
  assert.equal((await read())[0].title, 'Before write'); await read(); await unrelated();
  assert.equal(reads, 1);
  const changes: unknown[] = [];
  const subscription = session.onDidInvalidateReads(change => changes.push(change));
  await (await session.getClient()).createMergeRequest(101, { title: 'New MR', sourceBranch: 'feature', targetBranch: 'main' });
  assert.equal(writes, 1);
  assert.equal((await read())[0].title, 'After write');
  assert.equal(reads, 2, 'the same key used by the Workspace is invalidated after the write');
  await unrelated(); assert.equal(unrelatedReads, 1);
  assert.deepEqual(changes, [{ groupIds: [42], projectId: 101, resource: 'mergeRequests' }]);
  subscription.dispose();
});
