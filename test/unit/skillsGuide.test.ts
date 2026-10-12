import assert from 'node:assert/strict';
import test from 'node:test';
import { buildSkillGuidePrompt, canCopySkillPrompt, getSkillGuideCard, legacyWikiInputs,
  restoreSkillGuideState, skillGuideTools } from '../../src/webview/skillsGuideData';

const context = { groupRoot: 'C:\\工作區 with spaces', workflowKitVersion: '0.15.0', repositories: [
  { name: 'service', path: 'C:\\工作區 with spaces\\service' }
], repositoryScanStatus: 'ready' as const };

test('four tool entrances retain Wiki drafts and use existing Issue/MR destinations', () => {
  const state = restoreSkillGuideState(undefined, { 'query.question': '退款流程？\n請附來源。' }, 'query');
  assert.equal(state.tool, 'codebase-wiki');
  assert.equal(state.selections['codebase-wiki'], 'query');
  assert.ok(buildSkillGuidePrompt(getSkillGuideCard(state.tool, 'query'), state.inputs, context).includes(state.inputs['query.question']));
  for (const tool of skillGuideTools) assert.equal(getSkillGuideCard(tool.id).tool, tool.id);
  assert.equal(getSkillGuideCard('megin').destination, 'developer');
  assert.equal(getSkillGuideCard('merge-reviewer', 'merge-mr').destination, 'reviewer');
  assert.equal(canCopySkillPrompt(getSkillGuideCard('megin'), state.inputs), false);
  assert.equal(restoreSkillGuideState(undefined, {}, 'install').selections['codebase-wiki'], 'development-spec');
});

test('release checks require manual Repo/base/head and preserve literal Unicode paths and refs', () => {
  const state = restoreSkillGuideState();
  const card = getSkillGuideCard('release-reviewer');
  assert.equal(canCopySkillPrompt(card, state.inputs), false);
  const inputs = { ...state.inputs, 'release-review.repo': 'C:\\工作區 with spaces\\service',
    'release-review.base': 'origin/main', 'release-review.head': 'feature/payment' };
  assert.equal(canCopySkillPrompt(card, inputs), true);
  for (const key of ['repo', 'base', 'head']) assert.equal(canCopySkillPrompt(card, { ...inputs, [`release-review.${key}`]: ' ' }), false);
  const prompt = buildSkillGuidePrompt(card, inputs, context);
  assert.ok(prompt.includes(JSON.stringify(inputs['release-review.repo'])));
  assert.match(prompt, /\$release-reviewer/);
  assert.match(prompt, /固定合併前審查/);
  assert.deepEqual(card.fields.map(field => field.id), ['repo', 'base', 'head']);
  assert.match(prompt, /base_sha 的整個 Repo/);
  assert.match(prompt, /所選 Repo\/review-reports\//);
  assert.match(prompt, /檔名前綴 release-review/);
  assert.match(prompt, /失敗時停止，不使用過期資料/);
  assert.match(prompt, /只輸出 Markdown/);
  assert.equal(prompt.includes('--include-json'), false);
  assert.match(prompt, /環境設定、DB 建立或套用狀態標為未查證/);
  assert.match(prompt, /成功、失敗或中止都清理/);
  assert.throws(() => buildSkillGuidePrompt(card, { ...inputs, 'release-review.mode': '直接比較', 'release-review.output': 'Markdown＋JSON' }, context), /只接受 Repo/);
  for (const ref of ['HEAD', 'refs/tags/v1', 'f'.repeat(40), 'main~1']) assert.equal(canCopySkillPrompt(card, { ...inputs, 'release-review.head': ref }), false);
});

test('release saved inputs migrate to three fields while MergeReviewer retains advanced modes', () => {
  const saved = restoreSkillGuideState();
  saved.inputs = { ...saved.inputs, 'release-review.repo': 'service', 'release-review.base': 'main', 'release-review.head': 'feature/payment',
    'release-review.mode': '直接比較', 'release-review.output': 'Markdown＋JSON', 'merge-repo.mode': '直接比較', 'merge-repo.output': 'Markdown＋JSON' };
  const restored = restoreSkillGuideState(saved);
  assert.equal(restored.inputs['release-review.mode'], undefined);
  assert.equal(restored.inputs['release-review.output'], undefined);
  assert.equal(restored.inputs['merge-repo.mode'], '直接比較');
  assert.equal(restored.inputs['merge-repo.output'], 'Markdown＋JSON');
  assert.equal(canCopySkillPrompt(getSkillGuideCard('release-reviewer'), restored.inputs), true);
  const prompt = buildSkillGuidePrompt(getSkillGuideCard('release-reviewer'), restored.inputs, {
    ...context, repositories: [{ ...context.repositories[0], defaultBranch: 'production/local' }]
  });
  assert.ok(prompt.includes('"defaultBranch":"production/local"'));
  assert.match(prompt, /關聯 Repo 使用各自本機預設分支/);
  assert.match(prompt, /獨立 Checklist/);
});

test('review modes keep Group quick, native quick and explicit version contracts separate', () => {
  const state = restoreSkillGuideState();
  const group = buildSkillGuidePrompt(getSkillGuideCard('merge-reviewer', 'merge-group'), state.inputs, context);
  assert.match(group, /--group-root.*--quick/);
  assert.match(group, /不 fetch/);
  assert.equal(group.includes('專案名稱：'), false);
  const inputs = { ...state.inputs, 'merge-quick.repo': 'service', 'merge-repo.repo': 'service',
    'merge-repo.base': 'main', 'merge-repo.head': 'feature/payment' };
  const quick = buildSkillGuidePrompt(getSkillGuideCard('merge-reviewer', 'merge-quick'), inputs, context);
  assert.match(quick, /--quick --remote "origin"/);
  assert.equal(quick.includes('--include-working-tree'), false);
  assert.match(buildSkillGuidePrompt(getSkillGuideCard('merge-reviewer', 'merge-quick'), { ...inputs, 'merge-quick.workingTree': '是' }, context), /--include-working-tree/);
  const explicit = buildSkillGuidePrompt(getSkillGuideCard('merge-reviewer', 'merge-repo'), inputs, context);
  assert.match(explicit, /基礎分支："main"/);
  assert.match(explicit, /比較分支："feature\/payment"/);
  assert.equal(explicit.includes('--quick'), false);
});

test('resume requires a real Work ID format and state round trips without losing tool inputs', () => {
  const state = restoreSkillGuideState();
  const card = getSkillGuideCard('megin', 'megin-resume');
  assert.equal(canCopySkillPrompt(card, { 'megin-resume.workId': 'some work' }), false);
  const saved = { ...state, tool: 'release-reviewer' as const, selections: { ...state.selections, megin: 'megin-resume' },
    inputs: { ...state.inputs, 'megin-resume.workId': 'work-20261010-payment', 'query.question': 'old Wiki draft', 'release-review.repo': 'service' } };
  assert.equal(canCopySkillPrompt(card, saved.inputs), true);
  assert.match(buildSkillGuidePrompt(card, saved.inputs, context), /從最早尚未完成的階段繼續/);
  assert.match(buildSkillGuidePrompt(card, saved.inputs, context), /不得重置/);
  assert.deepEqual(restoreSkillGuideState(saved), saved);
  assert.deepEqual(legacyWikiInputs(saved.inputs)['query.question'], 'old Wiki draft');
  assert.equal(legacyWikiInputs(saved.inputs)['release-review.repo'], undefined);
  assert.equal(canCopySkillPrompt(getSkillGuideCard('release-reviewer'), { ...saved.inputs, 'release-review.mode': 'unknown' }), false);
});

test('native development prompts require exploration, approval and bounded independent reviews', () => {
  const card = getSkillGuideCard('megin', undefined, 'repository');
  const prompt = buildSkillGuidePrompt(card, { 'megin-workflow.task': '改善退款流程' }, {
    ...context, profile: 'repository', root: context.repositories[0].path
  });
  assert.match(prompt, /native v2/);
  assert.match(prompt, /中立釐清問題、受眾、成果與驗收/);
  assert.match(prompt, /事實、假設、需求與技術建議/);
  assert.match(prompt, /明確核准後才開始 BDD／TDD/);
  assert.match(prompt, /red／green 原始證據/);
  assert.match(prompt, /REQ.*SCN.*斷言.*實作.*Review.*人工驗收/);
  assert.match(prompt, /初審為第 0 輪，最多三次修正重審/);
  assert.match(prompt, /新的獨立唯讀 reviewer/);
  assert.match(prompt, /第三次修正仍失敗.*回報未完成/);
  assert.match(prompt, /續作不重置次數/);
});
