import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildWikiGuidePrompt, canCopyWikiPrompt, createDefaultWikiGuideInputs, wikiGuideCards
} from '../../src/webview/codebaseWikiGuideData';

test('defines the complete offline Codebase LLM Wiki guide and working default selections', () => {
  assert.equal(wikiGuideCards.length, 13);
  assert.deepEqual(wikiGuideCards.map((card) => card.id), [
    'development-spec', 'install', 'ingest', 'query', 'lint', 'audit', 'adr', 'synthesis', 'business-analysis',
    'system-analysis', 'system-design', 'notebooklm-export', 'archaeology'
  ]);

  const defaults = createDefaultWikiGuideInputs();
  assert.equal(defaults['install.operation'], '安裝');
  assert.equal(defaults['ingest.mode'], '互動');
  assert.equal(defaults['lint.operation'], '品質檢查');
  assert.equal(defaults['notebooklm-export.root'], '.');
  assert.equal(canCopyWikiPrompt(wikiGuideCards.find((card) => card.id === 'install')!, defaults), false);
  assert.equal(canCopyWikiPrompt(wikiGuideCards.find((card) => card.id === 'notebooklm-export')!, defaults), true);
});

test('builds prompts from required values while retaining Unicode, spaced paths, and multiline questions', () => {
  const defaults = createDefaultWikiGuideInputs();
  const inputs = {
    ...defaults,
    'install.target': 'C:\\workspace with spaces\\my-repo',
    'query.question': '退款 API 如何處理逾時？\n需要指出設定檔和呼叫路徑。',
    'audit.scope': 'src/payments'
  };

  assert.equal(canCopyWikiPrompt(wikiGuideCards.find((card) => card.id === 'install')!, inputs), true);
  assert.equal(canCopyWikiPrompt(wikiGuideCards.find((card) => card.id === 'query')!, inputs), true);
  assert.match(buildWikiGuidePrompt('install', inputs), /C:\\workspace with spaces\\my-repo/);
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
  assert.match(buildWikiGuidePrompt('install', { ...inputs, 'install.target': 'repo', 'install.operation': '升級' }), /升級/);
  assert.match(buildWikiGuidePrompt('lint', { ...inputs, 'lint.operation': '重建索引' }), /重建 wiki\/index\.md/);
  assert.match(buildWikiGuidePrompt('adr', inputs), /改採事件佇列/);
  assert.match(buildWikiGuidePrompt('synthesis', inputs), /付款重試/);
  assert.match(buildWikiGuidePrompt('business-analysis', inputs), /整體系統/);
  assert.match(buildWikiGuidePrompt('system-analysis', inputs), /solution-neutral/);
  assert.match(buildWikiGuidePrompt('system-design', inputs), /architecture views/);
});

test('rejects unknown guide cards instead of copying an empty prompt', () => {
  assert.throws(() => buildWikiGuidePrompt('missing', {}), /未知的 Codebase LLM Wiki 功能/);
});


test('development specifications require the feature and description, then clarify instead of creating Issues', () => {
  const card = wikiGuideCards.find((item) => item.id === 'development-spec')!;
  const defaults = createDefaultWikiGuideInputs();
  assert.equal(canCopyWikiPrompt(card, defaults), false);
  const input = { ...defaults, 'development-spec.scope': '退款', 'development-spec.requirement': '客服可發起退款。' };
  assert.equal(canCopyWikiPrompt(card, input), true);
  const prompt = buildWikiGuidePrompt(card.id, input);
  assert.match(prompt, /development_spec/);
  assert.match(prompt, /未回答保持 draft/);
  assert.match(prompt, /Issue 由我自行建立/);
});
