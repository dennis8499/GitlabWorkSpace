import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { CodexWorkflowService } from '../../src/codex/workflowService';
import { ProjectWikiStore } from '../../src/codex/projectWiki';
import { GitLabClient } from '../../src/api/gitLabClient';
import type { CodexTaskSpec, CodexTaskState } from '../../src/codex/protocol';
import type { ProjectWikiPreview } from '../../src/codex/workflowProtocol';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
async function fixture(t: test.TestContext) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'glw-wiki-service-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = path.join(root, 'source'); await mkdir(path.join(source, 'wiki'), { recursive: true });
  for (const name of ['index', 'module', 'overview']) await writeFile(path.join(source, 'wiki', name + '.md'), '# ' + name);
  const origin = { kind: 'project-wiki' as const, accountKey: 'account', baseUrl: 'https://gitlab.test', projectId: 1,
    projectPath: 'team/repo', webUrl: 'https://gitlab.test/team/repo', repositoryRoot: source, sourceBranch: 'main', sourceSha: 'a'.repeat(40) };
  const store = new ProjectWikiStore(path.join(root, 'drafts')), id = randomUUID();
  const spec: CodexTaskSpec = { source: { kind: 'project-wiki', projectId: 1 }, title: 'Wiki', root, workspaceKey: root,
    executionRoot: source, prompt: 'Fixture', skill: { name: 'fixture', path: path.join(root, 'SKILL.md') }, writableRoots: [root],
    environmentKey: 'fixture', origin, workflow: { id, runtimeRoot: root, remote: 'origin' } };
  const task: CodexTaskState = { id: 'wiki', title: 'Wiki', root, status: 'completed', createdAt: '2026-11-06T00:00:00Z',
    updatedAt: '2026-11-06T00:00:00Z', origin, result: await store.create(id, origin, source) };
  const calls: Array<{ method: string; slug: string }> = [], messages: Array<{ taskId: string; wiki?: ProjectWikiPreview }> = [];
  let get: ((slug: string, init?: RequestInit) => Promise<Response> | undefined) | undefined;
  let write: (() => Promise<void>) | undefined;
  const pages = new Map<string, unknown>();
  const client = new GitLabClient(origin.baseUrl, 'fixture-token', async (input, init) => {
    const url = new URL(String(input)), method = init?.method ?? 'GET', body = init?.body ? JSON.parse(String(init.body)) : undefined;
    const slug = method === 'POST' ? body.title : decodeURIComponent(url.pathname.split('/wikis/')[1] ?? '');
    calls.push({ method, slug });
    if (method === 'GET') return await get?.(slug, init) ?? new Response(pages.has(slug) ? JSON.stringify(pages.get(slug)) : '{}', { status: pages.has(slug) ? 200 : 404 });
    await write?.(); const page = { ...body, slug, format: 'markdown' }; pages.set(slug, page);
    return new Response(JSON.stringify(page), { headers: { 'content-type': 'application/json' } });
  });
  let scope = 'account', visible = true, cancelled = 0, failed = 0;
  const service = new CodexWorkflowService({ bridge: () => ({ specification: async () => spec, list: () => [task],
    resultAction: async (_taskId, action) => { task.result = await action(spec); } }),
    wiki: () => store, client: async () => client, check: value => () => { if (value.origin?.accountKey !== scope) throw new Error('Scope changed'); },
    visible: () => visible, confirmRetry: async () => true, post: message => messages.push(message),
    publishReview: async () => { throw new Error('Unexpected MR write'); }, cancelled: () => { cancelled++; }, failed: () => { failed++; } });
  t.after(() => service.dispose());
  return { root, store, service, spec, task, calls, messages, counts: () => ({ cancelled, failed }),
    get: (hook: typeof get) => { get = hook; }, write: (hook: typeof write) => { write = hook; },
    hide: () => { visible = false; service.suspendReads(); }, changeAccount: () => { scope = 'another'; service.suspendReads(); } };
}

test('Wiki view cancellation releases its read, preserves checked pages and resumes without re-reading them', async t => {
  const f = await fixture(t), started = deferred<void>();
  const initialResult = { ...f.task.result };
  f.get((slug, init) => slug === 'codebase/module' ? new Promise((_resolve, reject) => {
    started.resolve(); init?.signal?.addEventListener('abort', () => reject(Object.assign(new Error('Cancelled'), { name: 'AbortError' })), { once: true });
  }) : undefined);
  const pending = f.service.previewWiki({ taskId: 'wiki' }); await started.promise;
  assert.equal(f.messages[0].wiki!.progress!.completed, 0);
  f.service.suspendReads(); await pending;
  const partial = f.messages.at(-1)!.wiki!;
  assert.equal(partial.progress!.status, 'cancelled'); assert.equal(partial.progress!.completed, 1);
  assert.equal(f.counts().cancelled, 1); assert.deepEqual(f.task.result, initialResult);
  f.get(undefined);
  await f.service.previewWiki({ taskId: 'wiki' });
  assert.equal(f.messages.at(-1)!.wiki!.progress!.status, 'ready');
  assert.equal(f.calls.filter(call => call.slug === 'codebase/index').length, 1);
  assert.equal(f.calls.some(call => call.method !== 'GET'), false);
});

test('Wiki joins duplicate view reads and discards responses after the account changes', async t => {
  const f = await fixture(t), started = deferred<void>();
  f.get((_slug, init) => new Promise((_resolve, reject) => {
    started.resolve(); init?.signal?.addEventListener('abort', () => reject(Object.assign(new Error('Cancelled'), { name: 'AbortError' })), { once: true });
  }));
  const first = f.service.previewWiki({ taskId: 'wiki' }), second = f.service.previewWiki({ taskId: 'wiki' });
  assert.equal(first, second); await started.promise;
  const before = f.messages.length; f.changeAccount(); await Promise.all([first, second]);
  assert.equal(f.calls.length, 1); assert.equal(f.messages.length, before);
});

test('an accepted Wiki publication finishes after hiding and does not start a new view preview', async t => {
  const f = await fixture(t); await f.service.previewWiki({ taskId: 'wiki' });
  const revision = f.messages.at(-1)!.wiki!.revision, started = deferred<void>(), finish = deferred<void>();
  let firstWrite = true;
  f.write(async () => { if (firstWrite) { firstWrite = false; started.resolve(); await finish.promise; } });
  const publication = f.service.publishWiki('wiki', revision); await started.promise;
  const messages = f.messages.length; f.hide(); finish.resolve(); await publication;
  assert.equal(f.task.result!.state, 'published'); assert.equal(f.calls.filter(call => call.method === 'POST').length, 3);
  assert.equal(f.messages.length, messages);
});

test('queued reads arriving after hiding never restart Wiki or result reads', async t => {
  const f = await fixture(t), originalResult = f.task.result;
  f.hide();
  await f.service.previewWiki({ taskId: 'wiki' });
  await f.service.readResult('wiki');
  assert.deepEqual(f.calls, []); assert.deepEqual(f.messages, []);
  assert.equal(f.task.result, originalResult); assert.equal(f.counts().cancelled, 2);
});
