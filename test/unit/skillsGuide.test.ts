import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { buildSkillGuidePrompt, canCopySkillPrompt, getSkillGuideCard, legacyWikiInputs,
  restoreSkillGuideState, skillGuideTools, getSkillGuideFields, getSkillGuideCards } from '../../src/webview/skillsGuideData';

const context = { groupRoot: 'C:\\工作區 with spaces', workflowKitVersion: '0.15.0', repositories: [
  { name: 'service', path: 'C:\\工作區 with spaces\\service' }
], repositoryScanStatus: 'ready' as const };

test('all executable guide prompts route optional output style once and preserve workflow contracts', () => {
  for (const profile of ['group', 'repository'] as const) {
    for (const card of getSkillGuideCards(profile)) {
      const inputs = Object.fromEntries(card.fields.map(field => [`${card.id}.${field.id}`,
        field.id === 'base' ? 'main' : field.id === 'head' ? 'feature/change' : field.defaultValue ?? 'fixture']));
      const prompt = buildSkillGuidePrompt(card, inputs, { ...context, profile, root: context.repositories[0].path });
      assert.equal(prompt.split('載入 $output-style').length - 1, 1, `${profile}/${card.id}`);
      assert.match(prompt, /未安裝時沿用原 Skill 的 output style/);
      assert.match(prompt, /保留原 Skill 的必要欄位、證據、審查狀態/);
    }
  }
});

test('both Analysis profiles expose exactly the frozen package capability inventory', () => {
  const snapshot = JSON.parse(readFileSync(path.join(__dirname, '../../../resources/offline-tools/source-snapshots.json'), 'utf8'));
  for (const profile of ['group', 'repository'] as const) {
    assert.deepEqual(getSkillGuideCards(profile).map(card => card.id).sort(), snapshot.capabilities[profile]);
  }
});

test('three tool entrances retain Wiki drafts and supported default selections', () => {
  const state = restoreSkillGuideState(undefined, { 'query.question': '退款流程？\n請附來源。' }, 'query');
  assert.equal(state.tool, 'codebase-wiki');
  assert.equal(state.selections['codebase-wiki'], 'query');
  assert.ok(buildSkillGuidePrompt(getSkillGuideCard(state.tool, 'query'), state.inputs, context).includes(state.inputs['query.question']));
  for (const tool of skillGuideTools) assert.equal(getSkillGuideCard(tool.id).tool, tool.id);
  assert.equal(getSkillGuideCard('merge-reviewer', 'merge-mr').id, 'merge-repo');
  assert.equal(restoreSkillGuideState(undefined, {}, 'install').selections['codebase-wiki'], 'query');
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
  assert.match(prompt, /VSCode 工作區根目錄/);
  assert.ok(prompt.includes(`--workspace 為 ${JSON.stringify(context.groupRoot)}`));
  assert.equal(prompt.includes('Repo/review-reports'), false);
  assert.match(prompt, /檔名前綴 release-review/);
  assert.match(prompt, /失敗時停止，不使用過期資料/);
  assert.match(prompt, /只輸出 Markdown/);
  assert.equal(prompt.includes('--include-json'), false);
  assert.match(prompt, /環境設定、DB 建立或套用狀態標為未查證/);
  assert.match(prompt, /review-worklist\.json/);
  assert.match(prompt, /review-result-draft\.json.*尚未審查/);
  assert.match(prompt, /--retain-on-validation-error/);
  assert.match(prompt, /exit 3.*保留同次 context.*完整重驗/);
  assert.match(prompt, /成功、其他失敗或放棄修稿時清理/);
  assert.throws(() => buildSkillGuidePrompt(card, { ...inputs, 'release-review.mode': '直接比較', 'release-review.output': 'Markdown＋JSON' }, context), /只接受 Repo/);
  for (const ref of ['HEAD', 'refs/tags/v1', 'f'.repeat(40), 'main~1']) assert.equal(canCopySkillPrompt(card, { ...inputs, 'release-review.head': ref }), false);
});



test('release prompt binds actual folder and saved multi-root workspace without adding user fields', () => {
  const card = getSkillGuideCard('release-reviewer');
  const inputs = { 'release-review.repo': 'service', 'release-review.base': 'main', 'release-review.head': 'feature' };
  const workspaceRoot = 'C:\\actual workspace';
  const workspaceFile = 'C:\\actual workspace\\review.code-workspace';
  const prompt = buildSkillGuidePrompt(card, inputs, { ...context, workspaceRoot, workspaceFile });
  assert.ok(prompt.includes(`--workspace 為 ${JSON.stringify(workspaceRoot)}`));
  assert.ok(prompt.includes(`--workspace-file ${JSON.stringify(workspaceFile)}`));
  assert.deepEqual(card.fields.map(field => field.id), ['repo', 'base', 'head']);
  assert.throws(() => buildSkillGuidePrompt(card, inputs, { ...context, workspaceRootAmbiguous: true }), /工作區根目錄/);
  assert.throws(() => buildSkillGuidePrompt(card, inputs, { repositories: [] }), /工作區根目錄/);
});

test('native branch review uses only three inputs and actual saved workspace boundaries', () => {
  const card = getSkillGuideCard('merge-reviewer');
  assert.deepEqual(card.fields.map(field => field.id), ['repo', 'base', 'head']);
  const inputs = { 'merge-repo.repo': 'service', 'merge-repo.base': 'main', 'merge-repo.head': 'feature/payment' };
  assert.equal(canCopySkillPrompt(card, inputs), true);
  for (const invalid of ['HEAD', 'refs/tags/v1', 'a'.repeat(40), 'main~1', 'main..feature', '-bad', 'bad ref']) {
    assert.equal(canCopySkillPrompt(card, { ...inputs, 'merge-repo.head': invalid }), false, invalid);
  }
  assert.equal(canCopySkillPrompt(card, { ...inputs, 'merge-repo.mode': '直接比較' }), false);
  const prompt = buildSkillGuidePrompt(card, inputs, { ...context, workspaceRoot: 'C:/declared', workspaceFile: 'C:/declared/team.code-workspace' });
  assert.match(prompt, /merge-reviewer-workspace-context\/v3/);
  assert.match(prompt, /--workspace-file "C:\/declared\/team.code-workspace"/);
  assert.match(prompt, /只輸出 Markdown/);
  assert.match(prompt, /<base-commit前8碼>-<head-commit前8碼>\.md/);
  assert.match(prompt, /比較資訊：Repo／路徑、輸入分支與實際 ref/);
  assert.match(prompt, /--summary/);
  assert.match(prompt, /batch-read／batch-search/);
  assert.match(prompt, /問題描述、重現原因、預期結果、實際結果、證據、建議改善方式/);
  assert.match(prompt, /line_start／line_end/);
  assert.match(prompt, /行號、來源及完整 ref/);
  assert.doesNotMatch(prompt, /技術附錄/);
  assert.doesNotMatch(prompt, /--quick|--mode|--scope|--target|--include-json|--mr-context/);
  assert.throws(() => buildSkillGuidePrompt(card, inputs, { ...context, workspaceRootAmbiguous: true }), /工作區根目錄/);
});

test('removed review modes migrate with explicit branch confirmation and preserve Wiki drafts', () => {
  const saved = { tool: 'merge-reviewer' as const, selections: { 'merge-reviewer': 'merge-group' }, inputs: {
    'merge-repo.repo': 'service', 'merge-repo.base': 'main', 'merge-repo.head': 'feature/payment',
    'merge-repo.target': '已暫存內容', 'merge-repo.output': 'Markdown＋JSON', 'merge-group.output': 'Markdown',
    'query.question': '退款？' } };
  const state = restoreSkillGuideState(saved);
  assert.equal(state.selections['merge-reviewer'], 'merge-repo');
  assert.ok(state.migrationNotice);
  assert.equal(state.inputs['merge-repo.confirmationRequired'], 'true');
  assert.equal(state.inputs['merge-repo.target'], undefined);
  assert.equal(state.inputs['merge-group.output'], undefined);
  assert.equal(state.inputs['query.question'], '退款？');
  assert.equal(canCopySkillPrompt(getSkillGuideCard('merge-reviewer'), state.inputs), false);
  assert.deepEqual(restoreSkillGuideState(state), state);
  delete state.inputs['merge-repo.confirmationRequired'];
  assert.equal(canCopySkillPrompt(getSkillGuideCard('merge-reviewer'), state.inputs), true);
});
