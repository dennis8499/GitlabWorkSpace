import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildWikiGuideContext, buildWikiGuidePrompt, canCopyWikiPrompt, createDefaultWikiGuideInputs, wikiGuideCards
} from '../../src/webview/codebaseWikiGuideData';

test('defines the complete offline Codebase LLM Wiki guide and working default selections', () => {
  assert.equal(wikiGuideCards.length, 13);
  assert.deepEqual(wikiGuideCards.map((card) => card.id), [
    'install', 'ingest', 'query', 'functional-exploration', 'lint', 'audit', 'adr', 'synthesis', 'business-analysis',
    'system-analysis', 'system-design', 'notebooklm-export', 'archaeology'
  ]);

  const defaults = createDefaultWikiGuideInputs();
  assert.equal(defaults['install.operation'], undefined);
  assert.equal(defaults['ingest.mode'], '互動');
  assert.equal(defaults['lint.operation'], '品質檢查');
  assert.equal(defaults['notebooklm-export.root'], '.');
  assert.equal(wikiGuideCards.find((card) => card.id === 'install')!.fields.length, 0);
  assert.equal(canCopyWikiPrompt(wikiGuideCards.find((card) => card.id === 'install')!, defaults), false);
  assert.equal(canCopyWikiPrompt(wikiGuideCards.find((card) => card.id === 'notebooklm-export')!, defaults), true);
});

test('builds prompts from required values while retaining Unicode, spaced paths, and multiline questions', () => {
  const defaults = createDefaultWikiGuideInputs();
  const inputs = {
    ...defaults,
    'query.question': '退款 API 如何處理逾時？\n需要指出設定檔和呼叫路徑。',
    'audit.scope': 'src/payments'
  };

  assert.equal(canCopyWikiPrompt(wikiGuideCards.find((card) => card.id === 'install')!, inputs), false);
  assert.equal(canCopyWikiPrompt(wikiGuideCards.find((card) => card.id === 'query')!, inputs), true);
  assert.match(buildWikiGuidePrompt('install', inputs), /工具抽屜的一張套件卡/);
  assert.ok(buildWikiGuidePrompt('query', inputs).includes(inputs['query.question']));
  assert.match(buildWikiGuidePrompt('audit', inputs), /wiki\/synthesis\/code-audit\.md/);
});

test('preserves the selected Wiki authorization policy in generated prompts', () => {
  const inputs = {
    ...createDefaultWikiGuideInputs(),
    'ingest.path': 'src/payments',
    'query.question': 'PaymentService 如何處理退款？',
    'archaeology.target': 'discount_code',
    'adr.title': '改採事件佇列',
    'synthesis.topic': '付款重試',
    'ingest.mode': '互動'
  };

  assert.match(buildWikiGuidePrompt('ingest', inputs), /等待我確認/);
  assert.match(buildWikiGuidePrompt('query', inputs), /不修改任何檔案/);
  assert.match(buildWikiGuidePrompt('lint', inputs), /修復前等待我確認/);
  assert.match(buildWikiGuidePrompt('audit', inputs), /不得執行程式、測試或自動修正/);
  assert.match(buildWikiGuidePrompt('notebooklm-export', inputs), /等待我一次確認/);
  assert.match(buildWikiGuidePrompt('archaeology', inputs), /唯讀調查/);

  const batchInputs = { ...inputs, 'ingest.mode': '批次' };
  assert.match(buildWikiGuidePrompt('ingest', batchInputs), /Batch Ingest/);
  assert.equal(canCopyWikiPrompt(wikiGuideCards.find((card) => card.id === 'install')!, inputs), false);
  assert.match(buildWikiGuidePrompt('lint', { ...inputs, 'lint.operation': '重建索引' }), /重建 wiki\/index\.md/);
  assert.match(buildWikiGuidePrompt('adr', inputs), /改採事件佇列/);
  assert.match(buildWikiGuidePrompt('synthesis', inputs), /付款重試/);
  assert.match(buildWikiGuidePrompt('business-analysis', inputs), /整體系統/);
  assert.match(buildWikiGuidePrompt('system-analysis', inputs), /solution-neutral/);
  assert.match(buildWikiGuidePrompt('system-design', inputs), /architecture views/);
});

test('adds the selected Group and actual local Repo names and paths to copied prompts', () => {
  const root = 'C:\\workspace with spaces\\皜祈岫 Group';
  const repositories = [
    { name: 'renamed-service', path: root + '\\renamed-service' },
    { name: 'unmapped-tools', path: root + '\\unmapped-tools' }
  ];
  const context = buildWikiGuideContext({
    groupRoot: root, workflowKitVersion: '0.9.0', repositories, repositoryScanStatus: 'ready'
  });
  assert.ok(context.includes(root));
  assert.ok(context.includes('0.9.0'));
  assert.ok(context.includes('renamed-service → ' + root + '\\renamed-service'));
  assert.ok(context.includes('unmapped-tools → ' + root + '\\unmapped-tools'));
  assert.equal(context.includes('team/renamed-service'), false);

  const inputs = { ...createDefaultWikiGuideInputs(), 'query.question': 'Retry failed requests' };
  const prompt = buildWikiGuidePrompt('query', inputs, { groupRoot: root, repositories, repositoryScanStatus: 'ready' });
  assert.match(prompt, /Wiki-first/);
  assert.ok(prompt.includes('Retry failed requests'));
});
test('rejects unknown guide cards instead of copying an empty prompt', () => {
  assert.throws(() => buildWikiGuidePrompt('missing', {}), /未知的 Codebase LLM Wiki 功能/);
});

test('functional exploration starts from current sources and remains read-only in both profiles', () => {
  const inputs = createDefaultWikiGuideInputs();
  const card = wikiGuideCards.find((item) => item.id === 'functional-exploration')!;
  assert.equal(canCopyWikiPrompt(card, inputs), true);
  const native = buildWikiGuidePrompt(card.id, inputs, {
    profile: 'repository', root: 'C:\\工作區 with spaces\\service', repositories: [], repositoryScanStatus: 'ready'
  });
  assert.match(native, /functional_exploration.*先從目前原始碼/s);
  assert.match(native, /只探索單一所選 Repo/);
  assert.match(native, /功能、來源、覆蓋、排除與缺口/);
  assert.match(native, /不執行目標程式或測試/);
  assert.match(native, /不保存文件/);
  assert.equal(native.includes('逐一探索所選 Group'), false);
  assert.match(buildWikiGuidePrompt(card.id, inputs), /有效直屬 Repo.*Repo\/path/);
  assert.match(buildWikiGuidePrompt('query', { 'query.question': '退款流程？' }), /Wiki-first.*先讀取 wiki\/index.md/s);
});



test('full ingest does not require a single path and keeps native scope within the Repo', () => {
  const inputs = { ...createDefaultWikiGuideInputs(), 'ingest.scope': '全部專案' };
  const card = wikiGuideCards.find((item) => item.id === 'ingest')!;
  assert.equal(canCopyWikiPrompt(card, inputs), true);
  const native = buildWikiGuidePrompt('ingest', inputs, { profile: 'repository', root: '/project', repositories: [] });
  assert.match(native, /只涵蓋目前所選 Repo/);
  assert.match(native, /逐檔 hash.*部分完成/s);
  assert.equal(native.includes('--scope group'), false);
  assert.match(buildWikiGuidePrompt('ingest', inputs), /全部合法直屬本機 Git Repo.*尚未對應 GitLab/s);
});
