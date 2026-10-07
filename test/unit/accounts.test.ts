import assert from 'node:assert/strict';
import test from 'node:test';
import type { Memento, SecretStorage } from 'vscode';
import { AccountStore, ACCOUNTS_KEY, ACTIVE_ACCOUNT_KEY, accountId, accountTokenKey } from '../../src/connection/accountStore';
import { GitLabSession } from '../../src/connection/session';

class State implements Memento {
  readonly values = new Map<string, unknown>();
  failKey?: string;
  get<T>(key: string, fallback?: T): T | undefined { return this.values.has(key) ? this.values.get(key) as T : fallback; }
  keys(): string[] { return [...this.values.keys()]; }
  async update(key: string, value: unknown): Promise<void> {
    if (this.failKey === key) { this.failKey = undefined; throw new Error('Persistence failed'); }
    if (value === undefined) this.values.delete(key); else this.values.set(key, value);
  }
}
class Secrets {
  readonly values = new Map<string, string>();
  async get(key: string): Promise<string | undefined> { return this.values.get(key); }
  async store(key: string, value: string): Promise<void> { this.values.set(key, value); }
  async delete(key: string): Promise<void> { this.values.delete(key); }
}
function fixture(global = new State(), workspace = new State(), secrets = new Secrets()) {
  const session = new GitLabSession(secrets as unknown as SecretStorage, global, true, workspace);
  session.ensureInstanceChecked = async () => undefined;
  session.setFetchForTesting(async (_url, init) => {
    const token = new Headers(init?.headers).get('PRIVATE-TOKEN');
    if (!token || token === 'invalid') return new Response('{}', { status: 401 });
    const id = token.startsWith('two') ? 2 : 1;
    return new Response(JSON.stringify({ id, username: 'user-' + id, name: 'User ' + id }), { headers: { 'Content-Type': 'application/json' } });
  });
  return { session, global, workspace, secrets };
}

test('stores different servers and users independently and restores each selected Group', async () => {
  const { session, secrets } = fixture();
  await session.connect('https://gitlab.example.test/', 'one');
  const first = session.activeAccountId!;
  await session.setSelectedGroup({ id: 10, name: 'First', full_path: 'first/group', web_url: '' });
  await session.connect('https://gitlab.example.test', 'two');
  const second = session.activeAccountId!;
  assert.notEqual(first, second);
  assert.equal(Boolean(session.selectedGroup), false);
  await session.setSelectedGroup({ id: 20, name: 'Second', full_path: 'second/group', web_url: '' });
  await session.connect('https://other.example.test/gitlab', 'one');
  assert.equal(session.accounts.length, 3);
  await session.switchAccount(first);
  assert.equal(session.selectedGroup?.id, 10);
  await session.switchAccount(second);
  assert.equal(session.selectedGroup?.id, 20);
  assert.equal(secrets.values.get(accountTokenKey(first)), 'one');
  assert.ok(!JSON.stringify(session.accounts).includes('"token"'));
});

test('upserts a duplicate account and keeps the previous connection on failed login or persistence', async () => {
  const { session, global, secrets, workspace } = fixture();
  await session.connect('https://gitlab.example.test', 'one');
  const active = session.activeAccountId;
  await session.connect('https://gitlab.example.test/', 'one-replacement');
  assert.equal(session.accounts.length, 1);
  assert.equal(secrets.values.get(accountTokenKey(active!)), 'one-replacement');
  await assert.rejects(session.connect('https://other.example.test', 'invalid'));
  assert.equal(session.activeAccountId, active);
  const client = await session.getClient();
  workspace.failKey = ACTIVE_ACCOUNT_KEY;
  await assert.rejects(session.connect('https://other.example.test', 'two'));
  assert.equal(session.activeAccountId, active);
  assert.equal(session.accounts.length, 1);
  assert.equal(await session.getClient(), client);
  assert.ok(!JSON.stringify([...global.values]).includes('one-replacement'));
});

test('logout deletes only the selected token, keeps the list and requires login before switching back', async () => {
  const { session, secrets } = fixture();
  await session.connect('https://gitlab.example.test', 'one');
  const first = session.activeAccountId!;
  await session.connect('https://gitlab.example.test', 'two');
  const second = session.activeAccountId!;
  await session.disconnect();
  assert.equal(session.baseUrl, undefined);
  assert.equal(session.accounts.length, 2);
  assert.equal(session.accounts.find(account => account.id === second)?.needsLogin, true);
  assert.equal(await secrets.get(accountTokenKey(second)), undefined);
  assert.equal(await secrets.get(accountTokenKey(first)), 'one');
  await assert.rejects(session.switchAccount(second), /已登出/);
  await session.switchAccount(first);
  await session.removeAccount(second);
  assert.equal(session.accounts.length, 1);
  assert.equal(session.activeAccountId, first);
});

test('active selections belong to a workspace while account metadata is shared', async () => {
  const original = fixture();
  await original.session.connect('https://gitlab.example.test', 'one');
  const elsewhere = fixture(original.global, new State(), original.secrets);
  await elsewhere.session.initialize();
  assert.equal(elsewhere.session.accounts.length, 1);
  assert.equal(elsewhere.session.baseUrl, undefined);
  const reopened = fixture(original.global, original.workspace, original.secrets);
  await reopened.session.initialize();
  assert.equal(reopened.session.activeAccountId, original.session.activeAccountId);
});

test('migrates legacy data durably, retries interrupted migration and preserves credentials on failure', async () => {
  const global = new State(), workspace = new State(), secrets = new Secrets();
  await global.update('gitlabWorkspace.baseUrl', 'https://gitlab.example.test/');
  await global.update('gitlabWorkspace.currentUserId', 7);
  await global.update('gitlabWorkspace.selectedGroupId', 55);
  await global.update('gitlabWorkspace.selectedGroupLabel', 'team');
  await secrets.store('gitlabWorkspace.accessToken', 'legacy-secret');
  const store = new AccountStore(global, secrets as unknown as SecretStorage, workspace);
  workspace.failKey = ACTIVE_ACCOUNT_KEY;
  await assert.rejects(store.initialize(async () => { throw new Error('Should not probe known identity'); }));
  assert.equal(await secrets.get('gitlabWorkspace.accessToken'), 'legacy-secret');
  assert.equal(global.get('gitlabWorkspace.baseUrl'), 'https://gitlab.example.test/');
  await store.initialize(async () => { throw new Error('Should not probe known identity'); });
  assert.equal(store.active?.group?.id, 55);
  assert.equal(store.list().length, 1);
  assert.equal(await secrets.get(accountTokenKey(accountId('https://gitlab.example.test', 7))), 'legacy-secret');
  assert.equal(await secrets.get('gitlabWorkspace.accessToken'), undefined);
  assert.equal(global.get('gitlabWorkspace.baseUrl'), undefined);
  assert.ok(global.get(ACCOUNTS_KEY));
});

test('failed legacy identity checks leave all original settings and token intact', async () => {
  const global = new State(), secrets = new Secrets();
  await global.update('gitlabWorkspace.baseUrl', 'https://gitlab.example.test');
  await secrets.store('gitlabWorkspace.accessToken', 'legacy-secret');
  const store = new AccountStore(global, secrets as unknown as SecretStorage);
  await assert.rejects(store.initialize(async () => { throw new Error('Offline'); }));
  assert.equal(global.get(ACCOUNTS_KEY), undefined);
  assert.equal(await secrets.get('gitlabWorkspace.accessToken'), 'legacy-secret');
});

test('resumes legacy cleanup after the old URL was removed but another cleanup write failed', async () => {
  const { global, workspace, secrets } = fixture();
  await global.update('gitlabWorkspace.baseUrl', 'https://gitlab.example.test');
  await global.update('gitlabWorkspace.currentUserId', 7);
  await secrets.store('gitlabWorkspace.accessToken', 'legacy-secret');
  global.failKey = 'gitlabWorkspace.currentUserId';
  const store = new AccountStore(global, secrets as unknown as SecretStorage, workspace);
  await assert.rejects(store.initialize(async () => { throw new Error('No identity probe needed'); }));
  assert.equal(global.get('gitlabWorkspace.baseUrl'), undefined);
  assert.equal(await secrets.get('gitlabWorkspace.accessToken'), 'legacy-secret');
  await store.initialize(async () => { throw new Error('No identity probe needed'); });
  assert.equal(store.list().length, 1);
  assert.equal(await secrets.get('gitlabWorkspace.accessToken'), undefined);
  assert.equal(global.get('gitlabWorkspace.currentUserId'), undefined);
});

test('logs out inactive accounts without changing the active client and rejects mismatched relogin identities', async () => {
  const { session, secrets } = fixture();
  await session.connect('https://gitlab.example.test', 'one');
  const first = session.activeAccountId!;
  await session.connect('https://gitlab.example.test', 'two');
  const current = session.activeAccountId, client = await session.getClient();
  await session.logoutAccount(first);
  assert.equal(session.activeAccountId, current);
  assert.equal(await session.getClient(), client);
  assert.equal(await secrets.get(accountTokenKey(first)), undefined);
  await assert.rejects(session.connect('https://gitlab.example.test', 'two', first), /Token 身分/);
  assert.equal(session.activeAccountId, current);
});

test('blocks transitions until API writes complete and prevents writes through an old client after switching', async () => {
  const { session } = fixture();
  await session.connect('https://gitlab.example.test', 'one');
  let release!: () => void, started!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const waiting = new Promise<void>(resolve => { started = resolve; });
  session.setFetchForTesting(async (_url, init) => {
    if (init?.method === 'POST') {
      started(); await gate;
      return new Response('{"id":123,"body":"saved"}');
    }
    const id = new Headers(init?.headers).get('PRIVATE-TOKEN') === 'two' ? 2 : 1;
    return new Response(JSON.stringify({ id, username: 'user-' + id, name: 'User ' + id }));
  });
  const client = await session.getClient();
  const write = client.addIssueNote(1, 2, 'Do not log this body');
  await waiting;
  assert.equal(session.hasActiveWrites, true);
  await assert.rejects(session.disconnect(), /寫入尚未完成/);
  await assert.rejects(session.connect('https://gitlab.example.test', 'two'), /寫入尚未完成/);
  assert.equal(session.accounts.length, 1);
  release(); await write;
  assert.equal(session.hasActiveWrites, false);
  await session.connect('https://gitlab.example.test', 'two');
  await assert.rejects(client.addIssueNote(1, 2, 'stale'), { name: 'AbortError' });
});

test('logout cancels a pending token validation so it cannot restore a connection afterwards', async () => {
  const { session } = fixture();
  await session.connect('https://gitlab.example.test', 'one');
  let release!: () => void, started!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const waiting = new Promise<void>(resolve => { started = resolve; });
  session.setFetchForTesting(async () => { started(); await gate; return new Response('{"id":2,"username":"two","name":"Two"}'); });
  const connecting = session.connect('https://gitlab.example.test', 'two');
  const rejected = assert.rejects(connecting, { name: 'AbortError' });
  await waiting;
  await session.disconnect();
  release(); await rejected;
  assert.equal(session.baseUrl, undefined);
  assert.equal(session.accounts.length, 1);
});
