import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { CodexWorkflowService, CodexReviewNotSentError } from '../../src/codex/workflowService';
import { ProjectWikiStore } from '../../src/codex/projectWiki';
import { GitLabClient } from '../../src/api/gitLabClient';
import { workflowHash } from '../../src/codex/projectWorkflows';
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
  const branchReads: string[] = [];
  let branchSha: string | undefined = origin.sourceSha, branchGet: (() => Promise<Response>) | undefined;
  let get: ((slug: string, init?: RequestInit) => Promise<Response> | undefined) | undefined;
  let write: (() => Promise<void>) | undefined;
  const pages = new Map<string, unknown>();
  const client = new GitLabClient(origin.baseUrl, 'fixture-token', async (input, init) => {
    const url = new URL(String(input)), method = init?.method ?? 'GET', body = init?.body ? JSON.parse(String(init.body)) : undefined;
    if (url.pathname.includes('/repository/branches/')) {
      branchReads.push(url.pathname);
      return branchGet ? branchGet() : new Response(JSON.stringify({ name: origin.sourceBranch, commit: { id: branchSha } }));
    }
    const slug = method === 'POST' ? body.title : decodeURIComponent(url.pathname.split('/wikis/')[1] ?? '');
    calls.push({ method, slug });
    if (method === 'GET') return await get?.(slug, init) ?? new Response(pages.has(slug) ? JSON.stringify(pages.get(slug)) : '{}', { status: pages.has(slug) ? 200 : 404 });
    await write?.(); const page = { ...body, slug, format: 'markdown' }; pages.set(slug, page);
    return new Response(JSON.stringify(page), { headers: { 'content-type': 'application/json' } });
  });
  let scope = 'account', visible = true, cancelled = 0, failed = 0, retirePublished = false, specificationReads = 0;
  const service = new CodexWorkflowService({ bridge: () => ({ specification: async () => {
    specificationReads++; if (task.retention === 'results-only') throw new Error('The task was retired'); return spec;
  }, list: () => [task],
    resultAction: async (_taskId, action) => { task.result = await action(spec); if (retirePublished && task.result.state === 'published') task.retention = 'results-only'; } }),
    wiki: () => store, client: async () => client, check: value => () => { if (value.origin?.accountKey !== scope) throw new Error('Scope changed'); },
    visible: () => visible, confirmRetry: async () => true, post: message => messages.push(message),
    publishReview: async () => { throw new Error('Unexpected MR write'); }, cancelled: () => { cancelled++; }, failed: () => { failed++; } });
  t.after(() => service.dispose());
  return { root, store, service, spec, task, calls, messages, branchReads, counts: () => ({ cancelled, failed }),
    branch: (sha: string | undefined) => { branchSha = sha; }, branchGet: (hook: typeof branchGet) => { branchGet = hook; },
    get: (hook: typeof get) => { get = hook; }, write: (hook: typeof write) => { write = hook; },
    hide: () => { visible = false; service.suspendReads(); }, changeAccount: () => { scope = 'another'; service.suspendReads(); },
    retireOnPublish: () => { retirePublished = true; }, specificationReads: () => specificationReads };
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

test('another task window reads the local Wiki draft without API traffic or task mutations', async t => {
  const f = await fixture(t), result = JSON.stringify(f.task.result);
  f.task.controls = { external: true, canPause: false, canResume: false, canDelete: false, canAutoAccept: false, autoAccept: false };
  await f.service.previewWiki({ taskId: f.task.id, refresh: true, confirmRetry: true });
  assert.deepEqual(f.calls, []);
  assert.equal(JSON.stringify(f.task.result), result);
  assert.equal(f.messages.at(-1)?.wiki?.pages.length, 3);
  assert.equal(f.messages.at(-1)?.wiki?.sourceSha, f.spec.origin!.sourceSha);
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
  assert.deepEqual(f.branchReads, ['/api/v4/projects/1/repository/branches/main']);
});

test('native Wiki publication rejects changed or unverifiable GitLab source metadata before touching the saved draft', async t => {
  for (const sha of ['b'.repeat(40), undefined]) {
    const f = await fixture(t); await f.service.previewWiki({ taskId: 'wiki' });
    const revision = f.messages.at(-1)!.wiki!.revision, draft = path.join(f.root, 'drafts', f.spec.workflow!.id + '.json');
    const before = await readFile(draft), result = structuredClone(f.task.result), reads = f.calls.length;
    const publication = t.mock.method(f.store, 'publish'); f.branch(sha);
    await assert.rejects(f.service.publishWiki('wiki', revision), /來源版本.*重新產生.*草稿保留/);
    assert.deepEqual(f.branchReads, ['/api/v4/projects/1/repository/branches/main']);
    assert.equal(publication.mock.callCount(), 0);
    assert.equal(f.calls.length, reads, 'the rejection performs no Wiki reads or writes');
    assert.deepEqual(await readFile(draft), before, 'the revision and every page baseline remain unchanged');
    assert.deepEqual(f.task.result, result);
  }
});

test('native Wiki publication waits for fresh source metadata and checks the account again before any draft publication', async t => {
  const f = await fixture(t); await f.service.previewWiki({ taskId: 'wiki' });
  const revision = f.messages.at(-1)!.wiki!.revision, draft = path.join(f.root, 'drafts', f.spec.workflow!.id + '.json');
  const before = await readFile(draft), started = deferred<void>(), response = deferred<Response>();
  const publication = t.mock.method(f.store, 'publish');
  f.branchGet(() => { started.resolve(); return response.promise; });
  const pending = f.service.publishWiki('wiki', revision); await started.promise;
  assert.equal(publication.mock.callCount(), 0);
  f.changeAccount(); response.resolve(new Response(JSON.stringify({ commit: { id: f.spec.origin!.sourceSha } })));
  await assert.rejects(pending, /Scope changed/);
  assert.equal(publication.mock.callCount(), 0); assert.deepEqual(await readFile(draft), before);
  assert.equal(f.calls.some(call => call.method !== 'GET'), false);
});

test('native Wiki source lookup failures preserve the draft and never fall back to local seed refs', async t => {
  const f = await fixture(t); await f.service.previewWiki({ taskId: 'wiki' });
  const revision = f.messages.at(-1)!.wiki!.revision, draft = path.join(f.root, 'drafts', f.spec.workflow!.id + '.json');
  const before = await readFile(draft), failure = new Error('Fresh GitLab source lookup failed');
  const publication = t.mock.method(f.store, 'publish');
  f.branchGet(async () => { throw failure; });
  await assert.rejects(f.service.publishWiki('wiki', revision), error => error === failure);
  assert.equal(publication.mock.callCount(), 0); assert.deepEqual(await readFile(draft), before);
  assert.equal(f.calls.some(call => call.method !== 'GET'), false);
});

test('queued reads arriving after hiding never restart Wiki or result reads', async t => {
  const f = await fixture(t), originalResult = f.task.result;
  f.hide();
  await f.service.previewWiki({ taskId: 'wiki' });
  await f.service.readResult('wiki');
  assert.deepEqual(f.calls, []); assert.deepEqual(f.messages, []);
  assert.equal(f.task.result, originalResult); assert.equal(f.counts().cancelled, 2);
});

test('a visible Wiki publication posts its retained result without previewing a retired task', async t => {
  const f = await fixture(t); await f.service.previewWiki({ taskId: 'wiki' });
  const revision = f.messages.at(-1)!.wiki!.revision, reads = f.specificationReads(); f.retireOnPublish();
  await f.service.publishWiki('wiki', revision);
  assert.equal(f.task.retention, 'results-only'); assert.equal(f.specificationReads(), reads);
  assert.equal(f.calls.filter(call => call.method === 'POST').length, 3);
  assert.equal(f.messages.at(-1)?.wiki, undefined);
});

async function reviewFixture(t: test.TestContext) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'glw-review-service-')); t.after(() => rm(root, { recursive: true, force: true }));
  const reports = path.join(root, 'review-reports'); await mkdir(reports); const reportPath = path.join(reports, 'review.md');
  await writeFile(reportPath, '# Complete MR report\n');
  const origin = { kind: 'merge-request' as const, accountKey: 'account', baseUrl: 'https://gitlab.test', projectId: 1, iid: 2,
    projectPath: 'team/repo', webUrl: 'https://gitlab.test/team/repo', repositoryRoot: root, sourceBranch: 'feature', sourceSha: 'a'.repeat(40),
    targetBranch: 'main', targetSha: 'b'.repeat(40), intent: 'review' as const };
  const spec: CodexTaskSpec = { source: { kind: 'merge-request', projectId: 1, iid: 2, intent: 'review' }, title: 'Review', root, workspaceKey: root,
    executionRoot: root, prompt: 'Private execution prompt', writableRoots: [], environmentKey: 'fixture', origin };
  const task: CodexTaskState = { id: 'review', title: spec.title, root, status: 'completed', createdAt: '2026-11-13T00:00:00Z',
    updatedAt: '2026-11-13T00:00:00Z', origin, result: { state: 'ready', summary: 'Complete review', reportPath } };
  const writes: Array<{ taskId: string; body: string }> = [], states: string[] = [];
  let current = true, publish: (body: string) => Promise<void> = async body => {
    task.publication = { kind: 'review', state: 'confirmed', key: 'receipt', bodyHash: workflowHash(body.trim()) };
  };
  const client = new GitLabClient(origin.baseUrl, 'fixture-token', async input => {
    const pathname = new URL(String(input)).pathname;
    const response = pathname.includes('/merge_requests/') ? { sha: current ? origin.sourceSha : 'c'.repeat(40), target_branch: origin.targetBranch }
      : { commit: { id: origin.targetSha } };
    return new Response(JSON.stringify(response), { headers: { 'content-type': 'application/json' } });
  });
  const service = new CodexWorkflowService({ bridge: () => ({ specification: async () => spec, list: () => [task], resultAction: async (_id, action) => {
    task.result = await action(spec); states.push(task.result.state); if (task.result.state === 'published') task.retention = 'results-only';
  } }), wiki: () => { throw new Error('Unexpected Wiki access'); }, client: async () => client, check: () => () => {}, visible: () => true,
    confirmRetry: async () => false, post: () => {}, cancelled: () => {}, failed: () => {},
    publishReview: async (projectId, iid, body, beforeSend, taskId) => {
      assert.equal(projectId, 1); assert.equal(iid, 2); await beforeSend(); writes.push({ taskId, body }); await publish(body);
    } });
  t.after(() => service.dispose());
  return { root, service, task, writes, states, publish: (hook: typeof publish) => { publish = hook; }, changeSource: () => { current = false; } };
}

test('manual MR publication binds the task and retires only after its matching confirmed receipt', async t => {
  const f = await reviewFixture(t); await f.service.readResult('review'); await f.service.publishReview('review', ' Full report ');
  assert.deepEqual(f.writes, [{ taskId: 'review', body: ' Full report ' }]); assert.deepEqual(f.states, ['published']);
  assert.equal(f.task.retention, 'results-only'); assert.equal(f.task.result?.reportPath, path.join(f.root, 'review-reports', 'review.md'));
});

test('manual MR publication preserves uncertain results for missing, pending or stale receipts', async t => {
  for (const receipt of ['missing', 'pending', 'stale', 'other-pending']) {
    const f = await reviewFixture(t);
    f.publish(async body => {
      if (receipt === 'missing') return;
      f.task.publication = { kind: 'review', key: 'receipt', state: receipt === 'pending' ? 'pending' : 'confirmed', bodyHash: workflowHash(receipt === 'stale' ? 'old body' : body.trim()) };
      if (receipt === 'other-pending') f.task.publications = { other: { kind: 'reply', key: 'other', state: 'pending' } };
    });
    await assert.rejects(f.service.publishReview('review', 'Current report'), /收據/);
    assert.equal(f.task.result?.state, 'uncertain'); assert.equal(f.task.retention, undefined); assert.deepEqual(f.states, ['uncertain']);
  }
});

test('manual MR publication keeps known unsent reports retryable and rejects changed sources before sending', async t => {
  const f = await reviewFixture(t), failure = new Error('Write was not sent');
  f.publish(async body => { f.task.publication = { kind: 'review', key: 'receipt', state: 'not-published', bodyHash: workflowHash(body.trim()) }; throw failure; });
  await assert.rejects(f.service.publishReview('review', 'Report'), error => error === failure);
  assert.equal(f.task.result?.state, 'ready'); assert.deepEqual(f.states, []);
  f.changeSource(); await assert.rejects(f.service.publishReview('review', 'Report'), /版本已變更/); assert.equal(f.writes.length, 1);
});

test('a typed Host rejection before publication intent retains the ready report and its failure message', async t => {
  const f = await reviewFixture(t), failure = new CodexReviewNotSentError('Fresh Group membership rejected', { cause: new Error('Fixture lookup failed') });
  (f.service as any).options.publishReview = async () => { throw failure; };
  await assert.rejects(f.service.publishReview('review', 'Complete report'), error => error === failure);
  assert.equal(failure.effect, 'none'); assert.equal(f.task.result?.state, 'ready'); assert.equal(f.task.publication, undefined);
  assert.match(f.task.result?.summary ?? '', /發布未送出.*Fresh Group membership rejected/);
  assert.deepEqual(f.writes, []); assert.deepEqual(f.states, ['ready']); assert.equal(f.task.retention, undefined);
});

test('an untyped rejection or any saved publication intent remains uncertain even when called not-sent', async t => {
  for (const scenario of ['untyped', 'pending', 'historical-receipt']) await t.test(scenario, async child => {
    const f = await reviewFixture(child), failure = scenario === 'untyped' ? new Error('Ambiguous failure') : new CodexReviewNotSentError('Incorrect no-send label');
    f.publish(async body => {
      if (scenario === 'pending') f.task.publication = { kind: 'review', state: 'pending', key: 'intent', bodyHash: workflowHash(body.trim()) };
      if (scenario === 'historical-receipt') f.task.publications = { older: { kind: 'review', state: 'not-published', key: 'older', bodyHash: workflowHash('earlier report') } };
      throw failure;
    });
    await assert.rejects(f.service.publishReview('review', 'Complete report'), error => error === failure);
    assert.equal(f.task.result?.state, 'uncertain'); assert.deepEqual(f.states, ['uncertain']); assert.equal(f.task.retention, undefined);
  });
});
