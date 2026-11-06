import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { ProjectWikiStore, projectWikiMarkdown } from '../../src/codex/projectWiki';
import { GitLabApiError, GitLabClient, GitLabWriteUnknownError } from '../../src/api/gitLabClient';
import type { GitLabWikiPage } from '../../src/api/types';
import type { CodexTaskOrigin } from '../../src/codex/workflowProtocol';

async function fixture(t: test.TestContext) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'glw-project-wiki-'));
  assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = path.join(root, 'source'); await mkdir(path.join(source, 'wiki'), { recursive: true });
  await mkdir(path.join(source, 'src')); await writeFile(path.join(source, 'src/main.ts'), 'export const answer = 42;');
  await writeFile(path.join(source, 'wiki', 'index.md'), '# Project\n\n[Module](module.md)\n[Code](../src/main.ts)\n');
  await writeFile(path.join(source, 'wiki', 'module.md'), '# Module\n\n[Home](index.md)\n');
  const origin: CodexTaskOrigin = { kind: 'project-wiki', accountKey: 'account', baseUrl: 'https://gitlab.test', projectId: 4,
    projectPath: 'team/project', webUrl: 'https://gitlab.test/team/project', repositoryRoot: root, sourceBranch: 'main', sourceSha: 'a'.repeat(40) };
  const id = randomUUID(), store = new ProjectWikiStore(path.join(root, 'drafts')), pages = new Map<string, GitLabWikiPage>(), writes: string[] = [];
  let failure: ((slug: string, content: string) => void) | undefined;
  const client = {
    async getProjectWikiPage(_project: number, slug: string): Promise<GitLabWikiPage> {
      const page = pages.get(slug); if (!page) throw new GitLabApiError('Not found', 404); return { ...page };
    },
    async createProjectWikiPage(_project: number, slug: string, content: string): Promise<GitLabWikiPage> {
      writes.push(slug); failure?.(slug, content);
      const page = { slug, title: slug, content, format: 'markdown' }; pages.set(slug, page); return { ...page };
    },
    async updateProjectWikiPage(project: number, slug: string, content: string): Promise<GitLabWikiPage> { return this.createProjectWikiPage(project, slug, content); }
  };
  return { root, source, origin, id, store, pages, writes, client, setFailure(value: typeof failure) { failure = value; } };
}

test('Wiki generation and preview perform no remote writes; publication rewrites links and persists receipts', async t => {
  const f = await fixture(t);
  const result = await f.store.create(f.id, f.origin, f.source);
  assert.equal(result.state, 'draft'); assert.deepEqual(f.writes, []);
  const preview = await f.store.preview(f.id, f.origin, f.client, () => {});
  assert.deepEqual(f.writes, []); assert.equal(preview.pages.length, 2);
  assert.match(preview.pages[0].content, /https:\/\/gitlab.test\/team\/project\/-\/wikis\/codebase\/module/);
  assert.match(preview.pages[0].content, new RegExp('/-/blob/' + 'a'.repeat(40) + '/src/main.ts'));
  assert.equal((await f.store.publish(f.id, f.origin, preview.revision, f.client, () => {})).state, 'published');
  await new ProjectWikiStore(path.join(f.root, 'drafts')).publish(f.id, f.origin,
    (await f.store.preview(f.id, f.origin, f.client, () => {}, true)).revision, f.client, () => {});
  assert.equal(f.writes.length, 2, 'reopening and publishing already applied pages never duplicates writes');
});

test('Wiki remote changes require a new preview before overwriting', async t => {
  const f = await fixture(t); await f.store.create(f.id, f.origin, f.source);
  const preview = await f.store.preview(f.id, f.origin, f.client, () => {});
  f.pages.set('codebase/index', { slug: 'codebase/index', title: 'codebase/index', content: 'Human edit', format: 'markdown' });
  const result = await f.store.publish(f.id, f.origin, preview.revision, f.client, () => {});
  assert.equal(result.state, 'partial'); assert.match(result.summary, /已變更/); assert.equal(f.writes.length, 0);
  const next = await f.store.preview(f.id, f.origin, f.client, () => {}, true);
  assert.equal(next.pages[0].previousContent, 'Human edit'); assert.equal(next.pages[0].action, 'update');
  assert.equal((await f.store.publish(f.id, f.origin, next.revision, f.client, () => {})).state, 'published');
});

test('Wiki follow-ups refresh the stored draft, preserve publication baselines and validate source citations', async t => {
  const f = await fixture(t); await f.store.create(f.id, f.origin, f.source);
  const initial = await f.store.preview(f.id, f.origin, f.client, () => {});
  await f.store.publish(f.id, f.origin, initial.revision, f.client, () => {});
  await writeFile(path.join(f.source, 'wiki/index.md'), '# Revised\n[Source](src/main.ts:12)');
  await f.store.create(f.id, f.origin, f.source);
  const next = await f.store.preview(f.id, f.origin, f.client, () => {});
  assert.match(next.pages[0].content, /src\/main.ts#L12/); assert.equal(next.pages[0].published, false);
  assert.equal(next.pages[0].action, 'update'); assert.equal(next.pages[1].published, true);
  await writeFile(path.join(f.source, 'wiki/index.md'), '[Missing](src/missing.ts)');
  await assert.rejects(f.store.create(f.id, f.origin, f.source), /來源不在|找不到可發布的目標/);
  assert.match((await f.store.preview(f.id, f.origin, f.client, () => {})).pages[0].content, /Revised/);
});

test('Wiki partial failure preserves successful pages and retry publishes only remaining pages', async t => {
  const f = await fixture(t); await f.store.create(f.id, f.origin, f.source);
  const preview = await f.store.preview(f.id, f.origin, f.client, () => {});
  f.setFailure(slug => { if (slug === 'codebase/module') throw new GitLabApiError('Forbidden', 403); });
  assert.equal((await f.store.publish(f.id, f.origin, preview.revision, f.client, () => {})).state, 'partial');
  f.setFailure(undefined);
  const next = await f.store.preview(f.id, f.origin, f.client, () => {}, true);
  await f.store.publish(f.id, f.origin, next.revision, f.client, () => {});
  assert.deepEqual(f.writes, ['codebase/index', 'codebase/module', 'codebase/module']);
});

test('Wiki transport uncertainty is reconciled by reading, without automatically repeating a write', async t => {
  const f = await fixture(t); await f.store.create(f.id, f.origin, f.source);
  const preview = await f.store.preview(f.id, f.origin, f.client, () => {});
  f.setFailure((slug, content) => {
    f.pages.set(slug, { slug, title: slug, content, format: 'markdown' }); throw new GitLabWriteUnknownError();
  });
  assert.equal((await f.store.publish(f.id, f.origin, preview.revision, f.client, () => {})).state, 'uncertain');
  f.setFailure(undefined);
  const next = await f.store.preview(f.id, f.origin, f.client, () => {}, true);
  assert.equal(next.pages[0].published, true);
  await f.store.publish(f.id, f.origin, next.revision, f.client, () => {});
  assert.deepEqual(f.writes, ['codebase/index', 'codebase/module']);
});

test('Wiki unanswered uncertainty, account changes and stale preview cannot trigger a remote write', async t => {
  const f = await fixture(t); await f.store.create(f.id, f.origin, f.source);
  const preview = await f.store.preview(f.id, f.origin, f.client, () => {});
  await assert.rejects(f.store.publish(f.id, { ...f.origin, accountKey: 'another' }, preview.revision, f.client, () => {}), /帳號/);
  await assert.rejects(f.store.publish(f.id, f.origin, 'stale', f.client, () => {}), /重新預覽/);
  await assert.rejects(f.store.publish(f.id, f.origin, preview.revision, f.client, () => { throw new Error('account changed'); }), /account changed/);
  assert.equal(f.writes.length, 0);
  f.setFailure(() => { throw new GitLabWriteUnknownError(); });
  await f.store.publish(f.id, f.origin, preview.revision, f.client, () => {});
  const next = await f.store.preview(f.id, f.origin, f.client, () => {}, true);
  assert.match(next.error!, /待核對/);
  await f.store.publish(f.id, f.origin, next.revision, f.client, () => {});
  assert.equal(f.writes.length, 1);
});

test('Wiki Markdown rejects unsafe links and preserves literal code examples', async t => {
  const f = await fixture(t);
  assert.throws(() => projectWikiMarkdown('[bad](javascript:alert)', 'index.md', ['index.md'], f.origin, f.source), /不安全/);
  assert.throws(() => projectWikiMarkdown('[bad](file:///elsewhere/private.md)', 'index.md', ['index.md'], f.origin, f.source), /本機/);
  assert.throws(() => projectWikiMarkdown('[bad](../../outside)', 'index.md', ['index.md'], f.origin, f.source), /找不到/);
  const code = '```md\n[example](file:///example)\n```';
  assert.equal(projectWikiMarkdown(code, 'index.md', ['index.md'], f.origin, f.source), code);
  const converted = projectWikiMarkdown('---\ntitle: Overview\n---\n# Overview\n[[module|Module]] and `src/main.ts:12`', 'index.md', ['index.md', 'module.md'], f.origin, f.source, new Set(['src/main.ts']));
  assert.ok(converted.startsWith('# Overview')); assert.match(converted, /\[Module\]\(https:.*\/codebase\/module\)/);
  assert.match(converted, /\[`src\/main.ts:12`\]\(https:.*\/src\/main.ts#L12\)/);
  const metadata = projectWikiMarkdown('[Coverage](ingest-coverage.json)\n[Checks][checks]\n[checks]: .workflow-runtime/checks.json\n`wiki/ingest-coverage.json`\n`wiki/.workflow-runtime/test-output.txt`',
    'index.md', ['index.md'], f.origin, f.source, new Set(['wiki/ingest-coverage.json', 'wiki/.workflow-runtime/checks.json', 'wiki/.workflow-runtime/test-output.txt']));
  assert.match(metadata, /Coverage（本機驗證資料）/); assert.match(metadata, /Checks（本機驗證資料）/);
  assert.doesNotMatch(metadata, /\]\(|undefined/); assert.match(metadata, /`wiki\/ingest-coverage.json`/);
  assert.match(projectWikiMarkdown('[Page source](src/index.html)', 'index.md', ['index.md'], f.origin, f.source, new Set(['src/index.html'])), /\/-\/blob\/.*\/src\/index.html/);
});

test('CE Wiki REST contract uses encoded nested slugs, Markdown payloads and the existing authenticated write path', async () => {
  const seen: Array<{ url: string; init?: RequestInit }> = [];
  const page = { slug: 'codebase/overview', title: 'codebase/overview', content: '# Overview', format: 'markdown' };
  const client = new GitLabClient('https://gitlab.test', 'test-token', async (url, init) => {
    seen.push({ url: String(url), init });
    return new Response(JSON.stringify(String(url).includes('with_content=1') ? [page] : page), { headers: { 'content-type': 'application/json' } });
  });
  await client.listProjectWikiPages(4); await client.getProjectWikiPage(4, page.slug);
  await client.createProjectWikiPage(4, page.slug, page.content); await client.updateProjectWikiPage(4, page.slug, page.content);
  assert.ok(seen[1].url.endsWith('/projects/4/wikis/codebase%2Foverview'));
  assert.equal(seen[2].init?.method, 'POST'); assert.equal(seen[3].init?.method, 'PUT');
  assert.deepEqual(JSON.parse(seen[2].init!.body as string), { title: page.slug, content: page.content, format: 'markdown' });
  assert.equal(new Headers(seen[3].init?.headers).get('PRIVATE-TOKEN'), 'test-token');
  assert.throws(() => client.getProjectWikiPage(4, '../unsafe'), /invalid/);
});
