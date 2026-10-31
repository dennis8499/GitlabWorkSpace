import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { buildSkillGuideContext, buildSkillGuidePrompt, canCopySkillPrompt, getSkillGuideCard, legacyWikiInputs, resolveReviewerRepository,
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

test('both Analysis profiles expose the frozen analysis capabilities while BMAD has its own page', () => {
  const snapshot = JSON.parse(readFileSync(path.join(__dirname, '../../../test/fixtures/workflowkit-release-1.0.0/capabilities.json'), 'utf8'));
  const current = JSON.parse(readFileSync(path.join(__dirname, '../../../test/fixtures/workflowkit-release-1.3.1/capabilities.json'), 'utf8'));
  for (const profile of ['group', 'repository'] as const) {
    assert.equal(snapshot.capabilities[profile].includes('bmad-workflow'), false);
    assert.equal(snapshot.capabilities[profile].length, 14);
    assert.deepEqual(getSkillGuideCards(profile).filter(card => card.id !== 'visualize').map(card => card.id).sort(), snapshot.capabilities[profile]);
    assert.ok(current.capabilities[profile].includes('bmad-workflow'));
    assert.deepEqual(getSkillGuideCards(profile).map(card => card.id).sort(),
      current.capabilities[profile].filter((capability: string) => capability !== 'bmad-workflow'));
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
  assert.deepEqual(card.fields.map(field => field.id), ['repo', 'base', 'head']);
  assert.ok(prompt.includes(`--workspace ${JSON.stringify(context.groupRoot)}`));
  assert.equal(prompt.includes('--include-json'), false);
  assert.match(prompt, /status 恢復、cancel 取消/);
  assert.match(prompt, /references\/session-workflow\.md/);
  assert.match(prompt, /審查準則、固定證據、報告與完成門檻以該 Skill 為準/);
  assert.doesNotMatch(prompt, /technical_details|ReleaseReviewDraft|base_sha/);
  assert.doesNotMatch(prompt, /release_report\.py|evidence\.py batch|--retain-on-validation-error/);
  assert.throws(() => buildSkillGuidePrompt(card, { ...inputs, 'release-review.mode': '直接比較', 'release-review.output': 'Markdown＋JSON' }, context), /只接受 Repo/);
  for (const ref of ['HEAD', 'refs/tags/v1', 'f'.repeat(40), 'main~1']) assert.equal(canCopySkillPrompt(card, { ...inputs, 'release-review.head': ref }), false);
});



test('release prompt binds actual folder and saved multi-root workspace without adding user fields', () => {
  const card = getSkillGuideCard('release-reviewer');
  const inputs = { 'release-review.repo': 'service', 'release-review.base': 'main', 'release-review.head': 'feature' };
  const workspaceRoot = 'C:\\actual workspace';
  const workspaceFile = 'C:\\actual workspace\\review.code-workspace';
  const prompt = buildSkillGuidePrompt(card, inputs, { ...context, workspaceRoot, workspaceFile });
  assert.ok(prompt.includes(`--workspace ${JSON.stringify(workspaceRoot)}`));
  assert.ok(prompt.includes(`--workspace-file ${JSON.stringify(workspaceFile)}`));
  assert.deepEqual(card.fields.map(field => field.id), ['repo', 'base', 'head']);
  assert.throws(() => buildSkillGuidePrompt(card, inputs, { ...context, workspaceRootAmbiguous: true }), /工作區根目錄/);
  assert.throws(() => buildSkillGuidePrompt(card, inputs, { repositories: [] }), /工作區根目錄/);
});

test('Skill agent branch review uses only three inputs and actual saved workspace boundaries', () => {
  const card = getSkillGuideCard('merge-reviewer');
  assert.deepEqual(card.fields.map(field => field.id), ['repo', 'base', 'head']);
  const inputs = { 'merge-repo.repo': 'service', 'merge-repo.base': 'main', 'merge-repo.head': 'feature/payment' };
  assert.equal(canCopySkillPrompt(card, inputs), true);
  for (const invalid of ['HEAD', 'refs/tags/v1', 'a'.repeat(40), 'main~1', 'main..feature', '-bad', 'bad ref']) {
    assert.equal(canCopySkillPrompt(card, { ...inputs, 'merge-repo.head': invalid }), false, invalid);
  }
  assert.equal(canCopySkillPrompt(card, { ...inputs, 'merge-repo.mode': '直接比較' }), false);
  const prompt = buildSkillGuidePrompt(card, inputs, { ...context, workspaceRoot: 'C:/declared', workspaceFile: 'C:/declared/team.code-workspace' });
  assert.match(prompt, /--workspace-file "C:\/declared\/team.code-workspace"/);
  assert.match(prompt, /review_session\.py" start --workspace/);
  assert.match(prompt, /status 恢復/);
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

test('reviewer Repo resolution prefers paths and accepts only unique saved names', () => {
  const repositories = [
    { name: 'service', path: 'C:/team-a/service' },
    { name: 'service', path: 'C:/team-b/service' },
    { name: 'consumer', path: 'C:/team-b/consumer' }
  ];
  assert.equal(resolveReviewerRepository('service', repositories), undefined);
  assert.equal(resolveReviewerRepository('C:\\TEAM-B\\service\\', repositories), repositories[1]);
  assert.equal(resolveReviewerRepository(' consumer ', repositories), repositories[2]);
  assert.equal(resolveReviewerRepository('C:/removed/service', repositories), undefined);
  assert.equal(resolveReviewerRepository('', repositories), undefined);
  assert.equal(resolveReviewerRepository('/Repo', [{ name: 'repo', path: '/repo' }]), undefined);
});

test('both reviewer profiles target the selected workspace Repo and retain the declared workspace', () => {
  const repositories = [...context.repositories, { name: 'consumer', path: 'D:/other root/consumer', defaultBranch: 'trunk' }];
  for (const tool of ['merge-reviewer', 'release-reviewer'] as const) {
    for (const profile of ['group', 'repository'] as const) {
      const card = getSkillGuideCard(tool, undefined, profile);
      assert.deepEqual(card.fields.map(field => field.id), ['repo', 'base', 'head']);
      const inputs = { [`${card.id}.repo`]: 'consumer', [`${card.id}.base`]: 'main', [`${card.id}.head`]: 'feature/manual' };
      const reviewContext = { ...context, profile, root: context.repositories[0].path, repositories,
        workspaceRoot: 'C:/saved workspace', workspaceFile: 'C:/saved workspace/team.code-workspace' };
      const prompt = buildSkillGuidePrompt(card, inputs, reviewContext);
      assert.ok(prompt.includes('專案名稱："D:/other root/consumer"'));
      assert.ok(prompt.includes('--workspace-file "C:/saved workspace/team.code-workspace"'));
      assert.ok(prompt.includes('"feature/manual"'));
      assert.ok(prompt.includes('--project "D:/other root/consumer"'));
      assert.match(prompt, /review_session\.py" start --workspace/);
      assert.doesNotMatch(prompt, /Codex 原生 Code Review|GPT.?6|Luna|model_reasoning_effort/);
      assert.match(prompt, /SKILL\.md 與 references\/session-workflow\.md/);
      assert.ok(prompt.length < 1800, 'Reviewer prompt exceeds the fixture context budget');
      const header = buildSkillGuideContext(card, reviewContext);
      assert.ok(header.includes('consumer → D:/other root/consumer'));
      assert.ok(header.includes('VSCode 工作區根目錄：C:/saved workspace'));
    }
  }
  const wiki = getSkillGuideCard('codebase-wiki', 'query', 'repository');
  const header = buildSkillGuideContext(wiki, { ...context, profile: 'repository', root: context.repositories[0].path });
  assert.match(header, /實際單一 Repo 工作區/);
  assert.doesNotMatch(header, /consumer/);
});
