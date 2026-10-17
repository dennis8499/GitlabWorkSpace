import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { build } from 'vite';
import { JSDOM, VirtualConsole } from 'jsdom';

// Exercise the isolated component without changing generated extension assets.
const panelPath = fileURLToPath(new URL('../../src/webview/BmadPanel.tsx', import.meta.url)).replaceAll('\\', '/');
const result = await build({
  configFile: false, publicDir: false, logLevel: 'silent',
  plugins: [{ name: 'bmad-panel-behavior-entry', resolveId: id => id === 'virtual:bmad-panel-test' ? '\0bmad-panel-test' : undefined,
    load: id => id === '\0bmad-panel-test' ? `import { h, render } from 'preact';
      import { BmadPanel } from ${JSON.stringify(panelPath)};
      window.mountBmad = props => render(h(BmadPanel, props), document.getElementById('root'));` : undefined }],
  build: { write: false, emptyOutDir: false, minify: false,
    rollupOptions: { input: 'virtual:bmad-panel-test', output: { format: 'iife', name: 'BmadPanelBehavior' } } }
});
const script = result.output.find(item => item.type === 'chunk').code;
const copy = value => JSON.parse(JSON.stringify(value));

function snapshot() {
  const node = (id, displayName, phase, required = true) => ({ id, displayName, phase, required,
    module: 'bmm', skill: `bmad-${id}`, menuCode: id.toUpperCase(), description: `${displayName}的工作說明`,
    action: id === 'prd' ? 'create' : '', args: '', precededBy: [], followedBy: [],
    outputLocation: '_bmad-output', outputs: [`${id}.md`] });
  const nodes = [node('brief', '產品簡報', 'analysis', false), node('prd', '需求文件', 'planning'),
    node('arch', '架構設計', 'solutioning'), node('dev', '故事開發', 'implementation'), node('review', '程式碼審查', 'implementation')];
  const artifact = (id, patch = {}) => ({ id, path: `C:/專案/_bmad-output/${id}.md`, relativePath: `_bmad-output/${id}.md`,
    fingerprint: `sha-${id}`, status: 'needs-confirmation', reason: '已偵測到文件，請確認內容。', canConfirm: true, confirmed: false, ...patch });
  return { root: 'C:/專案', revision: 'revision-1', version: '6.2.0', installation: { state: 'ready', reason: 'BMAD 已安裝。' },
    catalogSource: 'installed', nodes,
    phases: [{ id: 'analysis', label: '探索', nodeIds: ['brief'] }, { id: 'planning', label: '規劃', nodeIds: ['prd'] },
      { id: 'solutioning', label: '設計', nodeIds: ['arch'] }, { id: 'implementation', label: '實作', nodeIds: ['dev', 'review'] }],
    edges: [{ from: 'brief', to: 'prd' }, { from: 'prd', to: 'arch' }, { from: 'arch', to: 'dev' }, { from: 'dev', to: 'review' }],
    steps: nodes.map(item => ({ id: item.id, status: item.id === 'brief' ? 'complete' : item.id === 'dev' ? 'draft' : 'not-observed',
      summary: `${item.displayName}狀態`, artifacts: item.id === 'dev' ? [artifact('story-a'),
        artifact('story-b', { status: 'complete', reason: '文件包含完成標記。', canConfirm: false }),
        artifact('story-c', { status: 'complete', confirmed: true, canConfirm: false, reason: '已人工確認。' })] : [] })),
    stories: [{ id: 'story-a', label: '故事 A', mode: 'classic', path: 'story-a.md', status: 'in-progress', reason: '正在實作。' },
      { id: 'story-b', label: '故事 B', mode: 'classic', path: 'story-b.md', status: 'review', reason: '等待審查。' }],
    currentCandidates: [{ stepId: 'dev', artifactId: 'story-a', storyId: 'story-a', label: '故事 A', reason: '開發進行中。' },
      { stepId: 'review', artifactId: 'story-b', storyId: 'story-b', label: '故事 B', reason: '等待程式碼審查。' }],
    recommendations: [{ stepId: 'arch', reason: '接續確認整體架構。' }], watchDirectories: ['C:/專案/_bmad-output'], diagnostics: [] };
}

async function mount(t, options = {}) {
  const errors = [], calls = [];
  const virtualConsole = new VirtualConsole();
  virtualConsole.on('jsdomError', error => errors.push(error.stack ?? error.message));
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>',
    { url: 'https://bmad.example.test', runScripts: 'outside-only', pretendToBeVisual: true, virtualConsole });
  dom.window.addEventListener('error', event => errors.push(event.error?.stack ?? event.message));
  t.after(() => { dom.window.close(); assert.deepEqual(errors, []); });
  dom.window.eval(script);
  let saved = options.state;
  let props = {
    snapshot: options.snapshot ?? snapshot(), canLaunch: true, ...options,
    onRefresh: () => calls.push(['refresh']), onOpenSettings: () => calls.push(['settings']),
    onLaunch: id => calls.push(['launch', id]), onCopy: id => calls.push(['copy', id]),
    onOpenArtifact: (id, path) => calls.push(['open', id, path]), onConfirm: (id, artifactId) => calls.push(['confirm', id, artifactId]),
    onRevoke: (id, artifactId) => calls.push(['revoke', id, artifactId]),
    onChange: state => { saved = copy(state); if (options.controlled) { props = { ...props, state: saved }; dom.window.mountBmad(props); } }
  };
  const tick = async () => { await new Promise(resolve => dom.window.requestAnimationFrame(() => dom.window.requestAnimationFrame(resolve))); };
  const render = async patch => { props = { ...props, ...patch }; dom.window.mountBmad(props); await tick(); };
  await render({});
  const document = dom.window.document;
  const button = text => [...document.querySelectorAll('button')].find(item => item.textContent.trim() === text);
  const click = async text => { const item = button(text); assert.ok(item, `Missing button ${text}`); item.click(); await tick(); };
  return { dom, document, calls, button, click, tick, render, get saved() { return saved; } };
}

test('flow selection keeps independent current positions and recommendations intact', async t => {
  const view = await mount(t);
  const current = () => [...view.document.querySelectorAll('.bmad-flow-step[aria-current="step"]')].map(node => node.dataset.stepId);
  assert.deepEqual(current(), ['dev', 'review']);
  assert.equal(view.document.querySelectorAll('.bmad-current-card').length, 2);
  assert.equal(view.document.querySelector('.bmad-step-detail h2').textContent, '故事開發');
  view.document.querySelector('[data-step-id="arch"]').click(); await view.tick();
  assert.equal(view.document.querySelector('.bmad-step-detail h2').textContent, '架構設計');
  assert.equal(view.document.querySelector('[data-step-id="arch"]').getAttribute('aria-pressed'), 'true');
  assert.equal(view.document.querySelector('[data-step-id="arch"]').hasAttribute('aria-current'), false);
  assert.deepEqual(current(), ['dev', 'review']);
  assert.equal(view.document.querySelectorAll('[role="progressbar"]').length, 0);
  assert.doesNotMatch(view.document.querySelector('.bmad-position').textContent, /\d+%/);
  assert.deepEqual(view.calls, [], 'viewing a guide does not trigger an operation');
});

test('phases expand, collapse, reveal recommendations and restore saved keyboard selection', async t => {
  const view = await mount(t, { controlled: true, state: { selectedStepId: 'prd', expandedPhases: ['planning'] } });
  assert.equal(view.document.getElementById('bmad-phase-analysis').getAttribute('aria-expanded'), 'false');
  assert.equal(view.document.getElementById('bmad-phase-content-analysis').hidden, true);
  view.document.querySelector('.bmad-recommendations button').click(); await view.tick();
  assert.equal(view.document.getElementById('bmad-phase-solutioning').getAttribute('aria-expanded'), 'true');
  assert.equal(view.saved.selectedStepId, 'arch');
  await view.click('全部展開');
  const arch = view.document.querySelector('[data-step-id="arch"]');
  arch.focus(); arch.dispatchEvent(new view.dom.window.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })); await view.tick();
  assert.equal(view.document.activeElement.dataset.stepId, 'dev');
  assert.equal(view.saved.selectedStepId, 'dev');
  view.document.activeElement.dispatchEvent(new view.dom.window.KeyboardEvent('keydown', { key: 'Home', bubbles: true })); await view.tick();
  assert.equal(view.saved.selectedStepId, 'brief');
  await view.click('全部收合');
  assert.equal([...view.document.querySelectorAll('.bmad-phase-heading')].every(item => item.getAttribute('aria-expanded') === 'false'), true);
  const reopened = await mount(t, { controlled: true, state: view.saved });
  assert.equal(reopened.document.querySelector('.bmad-step-detail h2').textContent, '產品簡報');
  assert.equal([...reopened.document.querySelectorAll('.bmad-phase-heading')].every(item => item.getAttribute('aria-expanded') === 'false'), true);
});

test('artifacts are opened, confirmed and revoked individually without optimistic completion', async t => {
  const view = await mount(t);
  assert.equal(view.document.querySelectorAll('.bmad-artifact').length, 3);
  await view.click('確認這份產物已完成');
  assert.deepEqual(view.calls.at(-1), ['confirm', 'dev', 'story-a']);
  assert.equal(view.document.querySelector('[data-step-id="dev"]').classList.contains('bmad-status-draft'), true);
  assert.equal(view.document.querySelectorAll('.bmad-artifact .bmad-status-badge')[0].textContent, '待確認');
  await view.click('撤銷人工確認');
  assert.deepEqual(view.calls.at(-1), ['revoke', 'dev', 'story-c']);
  await view.click('查看產物');
  assert.deepEqual(view.calls.at(-1), ['open', 'dev', 'C:/專案/_bmad-output/story-a.md']);
  assert.equal([...view.document.querySelectorAll('.bmad-artifact')][1].textContent.includes('確認這份產物已完成'), false);
});

test('keyboard navigation skips collapsed phases and keeps focus on visible flow nodes', async t => {
  const view = await mount(t, { controlled: true, state: { selectedStepId: 'brief', expandedPhases: ['analysis', 'solutioning', 'implementation'] } });
  const brief = view.document.querySelector('[data-step-id="brief"]');
  brief.focus();
  brief.dispatchEvent(new view.dom.window.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })); await view.tick();
  assert.equal(view.document.activeElement.dataset.stepId, 'arch', 'ArrowDown skips the hidden PRD node');
  assert.equal(view.saved.selectedStepId, 'arch');
  assert.equal(view.document.querySelector('[data-step-id="prd"]').getAttribute('aria-pressed'), 'false');

  view.document.getElementById('bmad-phase-implementation').click(); await view.tick();
  const arch = view.document.querySelector('[data-step-id="arch"]');
  arch.focus();
  arch.dispatchEvent(new view.dom.window.KeyboardEvent('keydown', { key: 'End', bubbles: true })); await view.tick();
  assert.equal(view.document.activeElement.dataset.stepId, 'arch', 'End targets the last visible node when the final phase is collapsed');
  assert.equal(view.saved.selectedStepId, 'arch');
  arch.dispatchEvent(new view.dom.window.KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true })); await view.tick();
  assert.equal(view.document.activeElement.dataset.stepId, 'brief', 'ArrowUp skips the hidden intermediate phase');
  assert.equal(view.saved.selectedStepId, 'brief');
});

test('host snapshots update parallel positions and evidence without changing an explicit selection', async t => {
  const view = await mount(t);
  view.document.querySelector('[data-step-id="prd"]').click(); await view.tick();
  const updated = snapshot(); updated.revision = 'revision-2';
  updated.currentCandidates = [{ stepId: 'review', label: '故事 A 與 B', reason: '兩份故事都在等待審查。' }];
  updated.steps.find(item => item.id === 'prd').status = 'complete';
  updated.steps.find(item => item.id === 'prd').summary = '需求文件已完整。';
  updated.diagnostics = [{ code: 'parse', message: '另有文件尚未完成儲存。', path: '_bmad-output/draft.md' }];
  await view.render({ snapshot: updated });
  assert.equal(view.document.querySelector('.bmad-step-detail h2').textContent, '需求文件');
  assert.equal(view.document.querySelector('.bmad-step-detail .bmad-status-badge').textContent, '已完成');
  assert.equal(view.document.querySelectorAll('.bmad-current-card').length, 1);
  assert.equal(view.document.querySelector('[data-step-id="dev"]').hasAttribute('aria-current'), false);
  assert.match(view.document.querySelector('.bmad-diagnostics').textContent, /文件尚未完成儲存/);
  assert.equal(view.document.querySelector('.bmad-step-summary').textContent, '需求文件已完整。');
});

test('catalog stays readable before installation while environment and launch gates explain actions', async t => {
  const missing = snapshot(); missing.root = undefined; missing.installation = { state: 'missing', reason: '請選擇專案並安裝 BMAD。' };
  missing.catalogSource = 'bundled'; missing.currentCandidates = []; missing.recommendations = [];
  const view = await mount(t, { snapshot: missing });
  assert.equal(view.document.querySelectorAll('.bmad-flow-step').length, missing.nodes.length);
  assert.equal(view.button('在 Codex 執行').disabled, true);
  assert.equal(view.button('複製提示詞').disabled, true);
  view.document.querySelector('[data-step-id="arch"]').click(); await view.tick();
  assert.equal(view.document.querySelector('.bmad-step-detail h2').textContent, '架構設計');
  await view.click('安裝／設定 BMAD'); assert.deepEqual(view.calls.at(-1), ['settings']);
  await view.render({ snapshot: snapshot(), canLaunch: false, launchReason: '請先信任此工作區。' });
  assert.equal(view.button('在 Codex 執行').disabled, true);
  assert.equal(view.button('複製提示詞').disabled, false);
  assert.match(view.document.querySelector('.bmad-action-reason').textContent, /先信任此工作區/);
  await view.render({ canLaunch: true, launchReason: undefined });
  await view.click('在 Codex 執行'); assert.deepEqual(view.calls.at(-1), ['launch', 'arch']);
  await view.click('複製提示詞'); assert.deepEqual(view.calls.at(-1), ['copy', 'arch']);
  await view.click('重新整理'); assert.deepEqual(view.calls.at(-1), ['refresh']);
  assert.equal(view.document.querySelector('[data-step-id="arch"]').classList.contains('bmad-status-not-observed'), true);
});

test('unassigned catalog nodes remain reachable and obsolete saved selection safely falls back', async t => {
  const value = snapshot(); value.phases = value.phases.filter(item => item.id !== 'solutioning');
  const view = await mount(t, { snapshot: value, state: { selectedStepId: 'removed-upstream-step' } });
  assert.ok(view.document.querySelector('[data-step-id="arch"]'));
  assert.match(view.document.getElementById('bmad-phase-other').textContent, /其他工作流程/);
  assert.equal(view.document.querySelector('.bmad-step-detail h2').textContent, '故事開發');
  assert.equal(view.calls.length, 0);
});
