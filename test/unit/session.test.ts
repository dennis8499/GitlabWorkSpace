import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import type { Memento, SecretStorage } from 'vscode';
import type { GitLabClient, GitLabIssueCapabilities } from '../../src/api/gitLabClient';
import type { GitLabMetadata } from '../../src/api/types';
import { GitLabSession } from '../../src/connection/session';

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

test('recognizes CE 16.11.10 as the minimum and reports edition-only features', async () => {
  const session = await sessionWithInstance(Promise.resolve({ version: '16.11.10-ee', enterprise: false }));
  assert.equal(session.issueCapabilities?.hierarchy, false);
  assert.ok(session.instanceWarnings.some((warning) => /Community Edition does not include.*blocking issue links/i.test(warning)));
  assert.ok(!session.instanceWarnings.some((warning) => /below the minimum/i.test(warning)));
});

test('keeps confirmed API capabilities when GitLab version metadata is unavailable', async () => {
  const session = await sessionWithInstance(Promise.reject(new Error('metadata unavailable')));
  assert.equal(session.issueCapabilities?.discussionResolve, false);
  assert.ok(session.instanceWarnings.some((warning) => /version metadata is unavailable.*still load/i.test(warning)));
});

test('stores the access token in SecretStorage only after the current-user check succeeds', async () => {
  const running = await serve(() => ({ status: 200, body: { id: 1, username: 'tester', name: 'Test User' } }));
  const secrets = new MemorySecrets();
  const state = new MemoryStore();
  try {
    const session = new GitLabSession(secrets as unknown as SecretStorage, state);
    const user = await session.connect(running.baseUrl, 'unit-session-token-do-not-use');
    assert.equal(user.username, 'tester');
    assert.equal(secrets.values.get('gitlabWorkspace.accessToken'), 'unit-session-token-do-not-use');
    assert.equal(state.get('gitlabWorkspace.baseUrl'), running.baseUrl);
    assert.deepEqual(running.tokens, ['unit-session-token-do-not-use', 'unit-session-token-do-not-use', 'unit-session-token-do-not-use']);
    assert.match(session.instanceWarnings.join(' '), /capabilities could not be verified/);
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
