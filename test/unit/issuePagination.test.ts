import assert from 'node:assert/strict';
import test from 'node:test';
import type { ExtensionContext } from 'vscode';
import { GitLabClient, type FetchLike } from '../../src/api/gitLabClient';
import type { GitLabNetworkGate } from '../../src/api/gitLabNetworkGate';
import { GitLabReadCache } from '../../src/api/gitLabReadCache';
import { gitLabReadLifetimeMs } from '../../src/api/gitLabReadKeys';
import type { GitLabSession } from '../../src/connection/session';
import type { GitLabIssue, GitLabProject } from '../../src/api/types';
import type { IssuePageResult, IssuePanelResponse } from '../../src/issues/protocol';

const loader = require('node:module'), original = loader._load;
loader._load = (name: string, ...args: unknown[]) => name === 'vscode' ? {} : original(name, ...args);
let Panels: typeof import('../../src/issues/issuePanel').IssuePanels;
try { Panels = require('../../src/issues/issuePanel').IssuePanels; } finally { loader._load = original; }
const tick = () => new Promise<void>(resolve => setImmediate(resolve));

function fixture() {
  let now = 0, moved = false;
  const calls: Array<{ url: URL; method: string; signal?: AbortSignal | null }> = [], messages: IssuePanelResponse[] = [];
  const project = (id: number) => ({ id, name: `Repo ${id}`, path: `repo-${id}`, path_with_namespace: `team/repo-${id}`, web_url: `https://gitlab.test/team/repo-${id}`, http_url_to_repo: `https://gitlab.test/team/repo-${id}.git` });
  const issue = (id: number) => ({ id, iid: id, project_id: 1, title: `Issue ${id}`, state: 'opened', web_url: `https://gitlab.test/team/repo-1/-/issues/${id}` });
  let intercept: ((url: URL, init?: RequestInit) => Promise<Response | undefined>) | undefined;
  const fetcher: FetchLike = async (input, init) => {
    const url = new URL(String(input)), method = init?.method ?? 'GET'; calls.push({ url, method, signal: init?.signal });
    const custom = await intercept?.(url, init); if (custom) return custom;
    const page = Number(url.searchParams.get('page') ?? 1), count = Number(url.searchParams.get('per_page') ?? 20);
    let payload: unknown = [];
    let next = false;
    if (url.pathname.endsWith('/graphql')) payload = { data: { project: { userPermissions: { createIssue: true }, issue: { userPermissions: { updateIssue: true, createNote: true } } } } };
    else if (url.pathname.endsWith('/user')) payload = { id: 9, username: 'tester' };
    else if (/\/projects\/\d+$/.test(url.pathname)) payload = { ...project(Number(url.pathname.split('/').at(-1))), ...(moved ? { path_with_namespace: 'team2/moved' } : {}) };
    else if (/\/issues\/\d+$/.test(url.pathname)) payload = issue(Number(url.pathname.split('/').at(-1)));
    else if (method === 'POST' && url.pathname.endsWith('/issues')) payload = issue(1001);
    else if (url.pathname.endsWith('/projects')) { payload = Array.from({ length: count }, (_, i) => project((page - 1) * count + i + 1)); next = page < 10; }
    else if (url.pathname.endsWith('/issues')) { payload = Array.from({ length: count }, (_, i) => issue((page - 1) * count + i + 1)); next = page < 50; }
    else if (/\/(?:members\/all|labels|milestones)$/.test(url.pathname)) {
      payload = Array.from({ length: count }, (_, i) => ({ id: (page - 1) * count + i + 1, name: `Option ${i}`, title: `Milestone ${i}`, username: `user${i}` })); next = page < 3;
    }
    return new Response(JSON.stringify(payload), { headers: { 'content-type': 'application/json', ...(next ? { 'x-next-page': String(page + 1) } : {}) } });
  };
  const networkGate = { fetch: async (fetcher: FetchLike, url: URL, init: RequestInit, _safe?: boolean, _limit?: number, onStart?: () => void) => { onStart?.(); return fetcher(url, init); } } as unknown as GitLabNetworkGate;
  const client = new GitLabClient('https://gitlab.test', 'fixture-token', fetcher, undefined, undefined, undefined, undefined, 30_000, networkGate);
  const cache = new GitLabReadCache(60_000, 256, () => now);
  const session = { baseUrl: 'https://gitlab.test', selectedGroup: { id: 42, full_path: 'team' }, connectionEpoch: 1,
    issueCapabilities: { createPermission: true, issuePermissionSource: 'issue', issuePermissionFields: ['updateIssue', 'createNote'] },
    ensureInstanceChecked: async () => {}, getClient: async () => client,
    cachedRead: <T>(key: string, load: (client: GitLabClient, signal: AbortSignal) => Promise<T>, options: { signal?: AbortSignal; force?: boolean } = {}) =>
      cache.get(`${session.connectionEpoch}:${key}`, signal => load(client.withReadSignal(signal), signal), { ...options, lifetimeMs: gitLabReadLifetimeMs(key) })
  };
  const panels = new Panels!({} as ExtensionContext, session as unknown as GitLabSession, () => {});
  panels.setWorkspace({ post: message => { if (message.type === 'issueResponse') messages.push(message.response); }, navigate: () => {}, show: async () => {} });
  Object.assign(panels, { ready: true });
  const creation = () => (panels as unknown as { lastSnapshot: Extract<IssuePanelResponse, { type: 'createData' }> }).lastSnapshot;
  const reply = <T>(id: string) => ([...messages].reverse().find(message => message.type === 'reply' && message.requestId === id) as Extract<IssuePanelResponse, { type: 'reply' }>)?.result as IssuePageResult<T>;
  return { panels, client, session, cache, calls, messages, creation, reply, issue, advance: (ms: number) => { now += ms; }, move: () => { moved = true; }, intercept: (value: typeof intercept) => { intercept = value; } };
}

test('creation uses one inventory page and Host-owned continuations, selecting a project never enumerates the inventory', async () => {
  const f = fixture();
  try {
    await f.panels.showCreate();
    assert.equal(f.creation().projects.length, 100); assert.equal(f.creation().projectsState?.complete, false);
    assert.equal(f.calls.filter(call => call.url.pathname.endsWith('/groups/42/projects')).length, 1);
    assert.equal(JSON.stringify(f.creation().projectsState).includes('nextCursor'), false);
    await f.panels.handle({ type: 'loadCreateProjects', mode: 'next', queryIdentity: f.creation().projectsState?.queryIdentity });
    assert.equal(f.creation().projectsState?.items.length, 200);
    await f.panels.handle({ type: 'selectProject', projectId: 101 });
    assert.equal(f.creation().selectedProjectId, 101);
    assert.equal(f.calls.filter(call => call.url.pathname.endsWith('/groups/42/projects')).length, 2);
    await assert.rejects(f.panels.handle({ type: 'selectProject', projectId: 999 }), /outside/);
    f.move();
    await assert.rejects(f.panels.handle({ type: 'create', projectId: 101, input: { title: 'Moved' } }), /outside/);
    assert.equal(f.calls.some(call => call.method === 'POST' && call.url.pathname.endsWith('/issues')), false);
  } finally { f.panels.dispose(); }
});

test('members, labels and milestones load separate twenty-result pages and retain other options', async () => {
  const f = fixture();
  try {
    await f.panels.showCreate();
    const before = f.calls.length;
    await f.panels.handle({ type: 'loadFormOptions', projectId: 1, section: 'members' });
    assert.equal(f.calls.length, before + 1); assert.equal(f.calls.at(-1)?.url.searchParams.get('per_page'), '20');
    assert.deepEqual(f.creation().options?.labels, []); assert.deepEqual(f.creation().options?.milestones, []);
    await f.panels.handle({ type: 'loadFormOptions', projectId: 1, section: 'labels' });
    await f.panels.handle({ type: 'loadFormOptions', projectId: 1, section: 'members', mode: 'next' });
    assert.equal(f.creation().options?.members.length, 40); assert.equal(f.creation().options?.labels.length, 20);
    assert.equal(f.creation().options?.states?.milestones?.status, 'idle');
    assert.ok(f.messages.filter(message => message.type === 'projectData').every(message => message.preserveDraft === true));
    assert.equal(JSON.stringify(f.creation().options).includes('nextCursor'), false);
  } finally { f.panels.dispose(); }
});

test('Issue searches page on demand, share repeated queries for sixty seconds and isolate account epochs', async () => {
  const f = fixture();
  try {
    await f.panels.showCreate();
    const search = (requestId: string, mode?: 'next', queryIdentity?: string) => f.panels.handle({ type: 'search', requestId, projectId: 1, query: 'common', mode, queryIdentity });
    const before = f.calls.length;
    await Promise.all([search('one'), search('duplicate')]);
    assert.equal(f.calls.length, before + 1); assert.equal(f.reply<GitLabIssue>('one').items.length, 20);
    const identity = f.reply<GitLabIssue>('one').queryIdentity;
    await search('next', 'next', identity); assert.equal(f.reply<GitLabIssue>('next').items.length, 40);
    assert.equal(f.calls.length, before + 2); assert.equal(JSON.stringify(f.reply('next')).includes('nextCursor'), false);
    await search('repeat'); assert.equal(f.calls.length, before + 2);
    f.advance(60_001); await search('expired'); assert.equal(f.calls.length, before + 3);
    f.session.connectionEpoch++; f.cache.clear();
    await f.panels.handle({ type: 'search', requestId: 'wrong-epoch', projectId: 1, query: 'common' });
    assert.ok(f.messages.some(message => message.type === 'reply' && message.requestId === 'wrong-epoch' && !!message.error));
    assert.equal(f.calls.length, before + 3);
  } finally { f.panels.dispose(); }
});

test('a replacement query cancels the old HTTP read and cannot publish its late results', async () => {
  const f = fixture(); let release!: () => void;
  const delayed = new Promise<void>(resolve => { release = resolve; });
  try {
    await f.panels.showCreate();
    f.intercept(async url => { if (url.searchParams.get('search') === 'old') { await delayed; return new Response('[]'); } return undefined; });
    const old = f.panels.handle({ type: 'search', requestId: 'old', projectId: 1, query: 'old' }); await tick();
    await f.panels.handle({ type: 'search', requestId: 'new', projectId: 1, query: 'new' });
    assert.equal(f.calls.find(call => call.url.searchParams.get('search') === 'old')?.signal?.aborted, true);
    release(); await old;
    assert.equal(f.messages.some(message => message.type === 'reply' && message.requestId === 'old'), false);
    assert.equal(f.reply('new').query, 'new');
  } finally { release(); f.panels.dispose(); }
});

test('picker inventories reuse five-minute pages while filtered queries do not collide with full inventory keys', async () => {
  const f = fixture();
  try {
    await f.panels.showCreate(); const inventory = () => f.calls.filter(call => call.url.pathname.endsWith('/groups/42/projects'));
    f.advance(60_001); await f.panels.showCreate(); assert.equal(inventory().length, 1);
    await f.panels.handle({ type: 'loadCreateProjects', query: 'repo' });
    assert.equal(inventory().length, 2); assert.equal(inventory().at(-1)?.url.searchParams.get('per_page'), '20');
    await f.panels.handle({ type: 'loadCreateProjects', query: '' }); assert.equal(inventory().length, 2);
    f.advance(240_000); await f.panels.showCreate(); assert.equal(inventory().length, 3);
  } finally { f.panels.dispose(); }
});

test('target Project search uses one twenty-result page and rejects another query continuation', async () => {
  const f = fixture();
  try {
    await f.panels.showIssue(f.issue(1) as GitLabIssue);
    await f.panels.handle({ type: 'searchProjects', requestId: 'projects', query: 'repo' });
    assert.equal(f.reply<GitLabProject>('projects').items.length, 20);
    const searches = () => f.calls.filter(call => call.url.pathname === '/api/v4/projects');
    assert.equal(searches().length, 1); assert.equal(searches()[0].url.searchParams.get('membership'), 'true');
    await f.panels.handle({ type: 'searchProjects', requestId: 'projects-next', query: 'repo', mode: 'next', queryIdentity: f.reply('projects').queryIdentity });
    assert.equal(f.reply('projects-next').items.length, 40); assert.equal(searches().length, 2);
    await f.panels.handle({ type: 'searchProjects', requestId: 'bad-next', query: 'other', mode: 'next', queryIdentity: f.reply('projects').queryIdentity });
    assert.equal(searches().length, 2);
    assert.ok(f.messages.some(message => message.type === 'reply' && message.requestId === 'bad-next' && !!message.error));
  } finally { f.panels.dispose(); }
});

test('complete Issue search retains second-page idempotency matches', async () => {
  const f = fixture();
  f.intercept(async url => url.pathname.endsWith('/issues') ? new Response(JSON.stringify([{ ...f.issue(Number(url.searchParams.get('page') ?? 1)), description: url.searchParams.has('page') ? 'marker-found' : '' }]), { headers: url.searchParams.has('page') ? {} : { 'x-next-page': '2' } }) : undefined);
  try {
    const complete = await f.client.searchProjectIssues(1, 'idempotency-marker');
    assert.equal(complete.length, 2); assert.equal(complete[1].description, 'marker-found');
  } finally { f.panels.dispose(); }
});
