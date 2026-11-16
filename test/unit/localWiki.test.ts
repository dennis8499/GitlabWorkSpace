import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { prepareLocalWikiSource, resolveLocalWikiScope } from '../../src/workspace/localWiki';
import { buildWikiGuidePrompt } from '../../src/webview/codebaseWikiGuideData';
import type { SkillsContext } from '../../src/workspace/workspaceProtocol';

async function fixture(t: test.TestContext) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'gitlab-local-wiki-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const a = path.join(root, '服務 A'), b = path.join(root, '服務 B');
  await Promise.all([mkdir(a), mkdir(b)]);
  const context = { mode: 'group', root, revision: 'local-revision', repositories: [{ name: '服務 A', path: a }, { name: '服務 B', path: b }],
    availableFeatures: ['query', 'ingest', 'lint'] } as SkillsContext;
  return { root, a, b, context };
}

test('offline Repo shortcuts share the Group Wiki and only narrow the selected source', async t => {
  const f = await fixture(t);
  for (const repo of [f.a, f.b]) {
    const scope = await resolveLocalWikiScope(f.context, repo);
    assert.equal(scope.wikiRoot, path.join(f.root, 'wiki'));
    const source = await prepareLocalWikiSource(f.context, repo, 'ingest');
    assert.equal(source.inputs['ingest.path'], path.basename(repo));
    assert.equal(source.inputs['ingest.scope'], '單一路徑');
    assert.equal(source.inputs['wiki.scope'], 'repository');
    assert.match(source.inputs['wiki.coverageLedger'], /ingest-coverage-[a-f0-9]{16}\.json$/);
    const prompt = buildWikiGuidePrompt(source.featureId, source.inputs, { profile: 'group', root: f.root, repositories: f.context.repositories });
    assert.ok(prompt.includes(JSON.stringify(repo)));
    assert.match(prompt, /不得在各 Repo 另建 wiki/);
    assert.match(prompt, /完整所選 Repo 更新.*逐檔 coverage/);
    assert.match(prompt, /不要求全 Group coverage/);
    assert.doesNotMatch(prompt, /這是來源範圍內的局部更新/);
    assert.match(prompt, /dirty、untracked、ignored/);
    const partial = buildWikiGuidePrompt('ingest', { ...source.inputs, 'wiki.scope': 'path', 'ingest.path': path.basename(repo) + '/src' },
      { profile: 'group', root: f.root, repositories: f.context.repositories });
    assert.match(partial, /這是來源範圍內的局部更新/);
    assert.doesNotMatch(partial, /完整所選 Repo 更新/);
    assert.deepEqual(await readdir(repo), []);
  }
  assert.deepEqual((await readdir(f.root)).sort(), ['服務 A', '服務 B']);
});

test('single-Repo Query can start without a Wiki and never creates or searches parent Wikis', async t => {
  const f = await fixture(t);
  const context = { ...f.context, mode: 'repository' as const, root: f.a, repositories: [{ name: '服務 A', path: f.a }] };
  const source = await prepareLocalWikiSource(context, f.a, 'query', '  重試流程？  ');
  assert.equal(source.inputs['query.question'], '重試流程？');
  assert.equal((await resolveLocalWikiScope(context, f.a)).wikiRoot, path.join(f.a, 'wiki'));
  const prompt = buildWikiGuidePrompt('query', source.inputs, { profile: 'repository', root: f.a, repositories: context.repositories });
  assert.match(prompt, /查詢不要求全量 coverage、不執行 Ingest、不寫檔/);
  assert.match(prompt, /不向父 Group 擴張/);
  assert.deepEqual(await readdir(f.a), []);
  await assert.rejects(prepareLocalWikiSource(context, f.b, 'query', 'question'), /不屬於目前 Wiki 工作區/);
  await assert.rejects(prepareLocalWikiSource(context, f.a, 'query', ' '), /查詢的 Wiki 問題/);
});

test('local Wiki sources cannot redirect work outside the trusted workspace or stale Repo list', async t => {
  const f = await fixture(t), nested = path.join(f.a, 'nested');
  await mkdir(nested);
  await assert.rejects(resolveLocalWikiScope({ ...f.context, repositories: [{ name: 'nested', path: nested }] }, nested), /不屬於目前 Wiki 工作區/);
  assert.throws(() => buildWikiGuidePrompt('query', { 'query.question': 'question', 'wiki.sourceRepo': f.b },
    { profile: 'group', root: f.root, repositories: [{ name: '服務 A', path: f.a }] }), /來源 Repo 已變更/);
});
