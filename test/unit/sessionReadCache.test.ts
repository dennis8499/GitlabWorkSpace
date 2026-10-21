import assert from 'node:assert/strict';
import test from 'node:test';
import type { Memento, SecretStorage } from 'vscode';
import type { GitLabClient } from '../../src/api/gitLabClient';
import type { GitLabPage, GitLabProject } from '../../src/api/types';
import { gitLabReadLifetimeMs, groupProjectsPageReadKey } from '../../src/api/gitLabReadKeys';
import { GitLabSession } from '../../src/connection/session';
import { OperationLog } from '../../src/logging/operationLog';

class State implements Memento {
  private readonly values = new Map<string, unknown>([['gitlabWorkspace.baseUrl', 'https://gitlab.example.test']]);
  get<T>(key: string, fallback?: T): T | undefined { return (this.values.get(key) as T | undefined) ?? fallback; }
  async update(key: string, value: unknown): Promise<void> { this.values.set(key, value); }
  keys(): readonly string[] { return [...this.values.keys()]; }
}

function fixture(page?: (cursor?: string, signal?: AbortSignal) => Promise<GitLabPage<GitLabProject>>, log?: OperationLog) {
  const client = {
    signal: undefined as AbortSignal | undefined,
    withReadSignal(signal: AbortSignal) { return Object.assign(Object.create(this), { signal }); },
    withRequestBudget() { return this; },
    ...(page ? { listGroupProjectsPage(this: { signal?: AbortSignal }, _groupId: number, cursor?: string) { return page(cursor, this.signal); } } : {})
  };
  const session = new GitLabSession({} as SecretStorage, new State(), true, new State(), log);
  (session as unknown as { getClient(): Promise<GitLabClient> }).getClient = async () => client as unknown as GitLabClient;
  return { session, client };
}

const project = (id: number): GitLabProject => ({ id, name: `Project ${id}`, path: `project-${id}`, path_with_namespace: `group/project-${id}`,
  web_url: '', http_url_to_repo: '' });
const page = (ids: number[], nextCursor?: string): GitLabPage<GitLabProject> => ({ items: ids.map(project), complete: !nextCursor, nextCursor,
  updatedAt: new Date().toISOString() });
const unexpected = async (): Promise<GitLabProject[]> => { throw new Error('The legacy full-collection loader must not run.'); };

test('low-churn resources share a five-minute policy while dynamic resources remain one minute', async () => {
  for (const key of ['group/42/projects', 'group/42/projects/pages/opened/first', 'group/42/milestones', 'project/1/members', 'project/1/labels',
    'project/1/milestones', 'project/1/templates', 'project/1/template-names']) assert.equal(gitLabReadLifetimeMs(key), 300_000, key);
  for (const key of ['group/42/assigned-issues', 'group/42/mergeRequests', 'project/1/issue/2', 'current-user']) assert.equal(gitLabReadLifetimeMs(key), 60_000, key);
  const originalNow = Date.now;
  let now = originalNow();
  Date.now = () => now;
  try {
    const { session } = fixture();
    let optionReads = 0, issueReads = 0;
    const options = () => session.cachedRead('project/1/labels', async () => ++optionReads);
    const issues = () => session.cachedRead('group/42/assigned-issues', async () => ++issueReads);
    await options(); await issues();
    now += 60_000;
    await options(); await issues();
    assert.deepEqual([optionReads, issueReads], [1, 2]);
    now += 240_000;
    await options(); assert.equal(optionReads, 2);
  } finally { Date.now = originalNow; }
});

test('a partial dashboard inventory and a complete form collection share pages and in-flight reads', async () => {
  const requests: Array<string | undefined> = [];
  let finish!: (value: GitLabPage<GitLabProject>) => void;
  const cursor = 'https://gitlab.example.test/api/v4/groups/42/projects?page=2';
  const { session } = fixture(async next => {
    requests.push(next);
    return next ? page([2]) : new Promise(resolve => { finish = resolve; });
  });
  const dashboard = session.cachedRead(groupProjectsPageReadKey(42), client => client.listGroupProjectsPage(42));
  await new Promise<void>(resolve => setImmediate(resolve));
  const form = session.cachedRead('group/42/projects', unexpected);
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(requests.length, 1, 'opening the form joins the dashboard first page');
  finish(page([1], cursor));
  assert.equal((await dashboard).complete, false);
  assert.deepEqual((await form).map(item => item.id), [1, 2], 'partial dashboard data is never returned as a complete collection');
  await session.cachedRead('group/42/projects', unexpected);
  await session.cachedRead(groupProjectsPageReadKey(42, cursor), client => client.listGroupProjectsPage(42, cursor));
  assert.deepEqual(requests, [undefined, cursor]);
});

test('full-collection reads prime dashboard pages and forced refresh discards old continuations', async () => {
  let generation = 1;
  const requests: Array<string | undefined> = [];
  const cursor = 'https://gitlab.example.test/api/v4/groups/42/projects?page=2';
  const { session } = fixture(async next => { requests.push(next); return next ? page([generation * 10 + 2]) : page([generation * 10 + 1], cursor); });
  assert.deepEqual((await session.cachedRead('group/42/projects', unexpected)).map(item => item.id), [11, 12]);
  await session.cachedRead(groupProjectsPageReadKey(42), client => client.listGroupProjectsPage(42));
  assert.equal(requests.length, 2);
  generation = 2;
  await session.cachedRead(groupProjectsPageReadKey(42), client => client.listGroupProjectsPage(42), { force: true });
  assert.deepEqual((await session.cachedRead('group/42/projects', unexpected)).map(item => item.id), [21, 22]);
  assert.equal(requests.length, 4, 'a refreshed first page invalidates the earlier continuation snapshot');
});

test('failed continuation remains partial and the next collection read retries only the missing page', async () => {
  const requests: Array<string | undefined> = [];
  const cursor = 'https://gitlab.example.test/api/v4/groups/42/projects?page=2';
  let failures = 1;
  const { session } = fixture(async next => {
    requests.push(next);
    if (next && failures-- > 0) throw new Error('temporary page failure');
    return next ? page([2]) : page([1], cursor);
  });
  await assert.rejects(session.cachedRead('group/42/projects', unexpected), /temporary page failure/);
  assert.deepEqual((await session.cachedRead('group/42/projects', unexpected)).map(item => item.id), [1, 2]);
  assert.deepEqual(requests, [undefined, cursor, cursor]);
});

test('an external first-page refresh cannot return a collection assembled from different generations', async () => {
  let firstReads = 0, finishSecond!: (value: GitLabPage<GitLabProject>) => void;
  const cursor = 'https://gitlab.example.test/api/v4/groups/42/projects?page=2';
  const { session } = fixture(async next => next ? new Promise(resolve => { finishSecond = resolve; }) : page([++firstReads], cursor));
  const collection = session.cachedRead('group/42/projects', unexpected);
  await new Promise<void>(resolve => setImmediate(resolve));
  const rejected = assert.rejects(collection, { name: 'AbortError' });
  await session.cachedRead(groupProjectsPageReadKey(42), client => client.listGroupProjectsPage(42), { force: true });
  finishSecond(page([10]));
  await rejected;
});

test('readers during forced first-page refresh join its replacement instead of mixing a cached old prefix with new pages', async () => {
  let generation = 1, firstReads = 0, secondReads = 0;
  let finish!: (value: GitLabPage<GitLabProject>) => void;
  const cursor = 'https://gitlab.example.test/api/v4/groups/42/projects?page=2';
  const { session } = fixture(async next => {
    if (next) { secondReads++; return page([generation * 10 + 2]); }
    firstReads++;
    return generation === 1 ? page([11], cursor) : new Promise(resolve => { finish = resolve; });
  });
  assert.deepEqual((await session.cachedRead('group/42/projects', unexpected)).map(item => item.id), [11, 12]);
  generation = 2;
  const forced = session.cachedRead(groupProjectsPageReadKey(42), client => client.listGroupProjectsPage(42), { force: true });
  await new Promise<void>(resolve => setImmediate(resolve));
  const form = session.cachedRead('group/42/projects', unexpected);
  const dashboard = session.cachedRead(groupProjectsPageReadKey(42), client => client.listGroupProjectsPage(42));
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.deepEqual([firstReads, secondReads], [2, 1], 'new readers wait for the shared replacement before loading its continuation');
  finish(page([21], cursor));
  await forced;
  assert.deepEqual((await dashboard).items.map(item => item.id), [21]);
  assert.deepEqual((await form).map(item => item.id), [21, 22]);
  assert.deepEqual([firstReads, secondReads], [2, 2]);
});

test('cancelled full inventory hands its pending page to dashboard navigation and hide cancels orphans', async () => {
  let requests = 0, aborts = 0, finish!: (value: GitLabPage<GitLabProject>) => void;
  const { session } = fixture((_cursor, signal) => {
    requests++;
    return new Promise((resolve, reject) => {
      finish = resolve;
      signal?.addEventListener('abort', () => { aborts++; reject(Object.assign(new Error('cancelled'), { name: 'AbortError' })); }, { once: true });
    });
  });
  const controller = new AbortController();
  const form = session.cachedRead('group/42/projects', unexpected, { signal: controller.signal });
  await new Promise<void>(resolve => setImmediate(resolve));
  const handoff = session.beginReadHandoff();
  controller.abort(); await assert.rejects(form, { name: 'AbortError' });
  const dashboard = session.cachedRead(groupProjectsPageReadKey(42), client => client.listGroupProjectsPage(42));
  handoff.dispose();
  assert.equal(aborts, 0);
  finish(page([1]));
  assert.deepEqual((await dashboard).items.map(item => item.id), [1]);
  assert.equal(requests, 1);

  const hiddenController = new AbortController();
  const pending = session.cachedRead('group/99/projects', unexpected, { signal: hiddenController.signal });
  await new Promise<void>(resolve => setImmediate(resolve));
  const abandoned = session.beginReadHandoff();
  hiddenController.abort(); await assert.rejects(pending, { name: 'AbortError' });
  session.cancelReadHandoffs();
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(aborts, 1);
  abandoned.dispose();
});

test('handoff retains the pending page without allowing an abandoned full reader to fetch further pages', async () => {
  const requests: Array<string | undefined> = [];
  let finish!: (value: GitLabPage<GitLabProject>) => void;
  const cursor = 'https://gitlab.example.test/api/v4/groups/42/projects?page=2';
  const { session } = fixture(async next => {
    requests.push(next);
    return next ? page([2]) : new Promise(resolve => { finish = resolve; });
  });
  const controller = new AbortController();
  const form = session.cachedRead('group/42/projects', unexpected, { signal: controller.signal });
  await new Promise<void>(resolve => setImmediate(resolve));
  const handoff = session.beginReadHandoff();
  controller.abort(); await assert.rejects(form, { name: 'AbortError' });
  const dashboard = session.cachedRead(groupProjectsPageReadKey(42), client => client.listGroupProjectsPage(42));
  finish(page([1], cursor));
  assert.equal((await dashboard).complete, false);
  // The replacement refresh may still be waiting for unrelated sections. Its
  // lease must not let the abandoned form continue downloading a full inventory.
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.deepEqual(requests, [undefined]);
  assert.equal(session.getGroupProjectsRevision(42), 1);
  handoff.dispose();
});

test('an account reset clears cached pages and handoffs and old completions cannot populate the new epoch', async () => {
  let requests = 0, finish!: (value: GitLabPage<GitLabProject>) => void;
  const { session } = fixture(async () => {
    requests++;
    return requests === 1 ? new Promise(resolve => { finish = resolve; }) : page([2]);
  });
  const controller = new AbortController();
  const old = session.cachedRead('group/42/projects', unexpected, { signal: controller.signal });
  await new Promise<void>(resolve => setImmediate(resolve));
  const handoff = session.beginReadHandoff();
  controller.abort(); await assert.rejects(old, { name: 'AbortError' });
  await (session as unknown as { resetConnection(): Promise<void> }).resetConnection();
  finish(page([1]));
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.deepEqual((await session.cachedRead('group/42/projects', unexpected)).map(item => item.id), [2]);
  assert.equal(requests, 2);
  handoff.dispose();
});

test('cache diagnostics expose hit and joined outcomes without leaking a read key', async () => {
  const lines: string[] = [];
  const log = new OperationLog({ info: line => lines.push(line), warn: line => lines.push(line), error: line => lines.push(line) });
  const { session } = fixture(undefined, log);
  let finish!: (value: number) => void;
  const key = 'group-board/42/9/assigned/private-user';
  const first = session.cachedRead(key, async () => new Promise<number>(resolve => { finish = resolve; }), { reason: 'entry' });
  const joined = session.cachedRead(key, async () => 9, { reason: 'tab' });
  await new Promise<void>(resolve => setImmediate(resolve));
  finish(1); await first; await joined;
  await session.cachedRead(key, async () => 9, { reason: 'entry' });
  assert.ok(lines.some(line => line.includes('"cacheResult":"miss"')));
  assert.ok(lines.some(line => line.includes('"cacheResult":"joined"')));
  assert.ok(lines.some(line => line.includes('"cacheResult":"hit"')));
  assert.ok(lines.every(line => !line.includes('private-user') && !line.includes('group-board/')));
});
