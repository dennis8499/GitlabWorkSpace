import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { build } from 'vite';
import { JSDOM, VirtualConsole } from 'jsdom';
import { bmadEnvironmentSnapshot, bmadUiSnapshot } from '../fixtures/bmad-ui.mjs';

// The isolated component build stays in memory and does not rewrite extension assets.
const panelPath = fileURLToPath(new URL('../../src/webview/BmadPanel.tsx', import.meta.url)).replaceAll('\\', '/');
const result = await build({ configFile: false, publicDir: false, logLevel: 'silent',
  plugins: [{ name: 'bmad-panel-behavior-entry', resolveId: id => id === 'virtual:bmad-panel-test' ? '\0bmad-panel-test' : undefined,
    load: id => id === '\0bmad-panel-test' ? `import { h, render } from 'preact';
      import { BmadPanel } from ${JSON.stringify(panelPath)};
      window.mountBmad = props => render(h(BmadPanel, props), document.getElementById('root'));` : undefined }],
  build: { write: false, emptyOutDir: false, minify: false,
    rollupOptions: { input: 'virtual:bmad-panel-test', output: { format: 'iife', name: 'BmadPanelBehavior' } } }
});
const script = result.output.find(item => item.type === 'chunk').code;
const copy = value => JSON.parse(JSON.stringify(value));

function withoutProgress(data = bmadUiSnapshot()) {
  data.steps.forEach(step => { step.status = 'not-observed'; step.artifacts = []; });
  data.stories = []; data.currentCandidates = []; data.recommendations = [];
  return data;
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
  let props = { snapshot: options.snapshot ?? bmadUiSnapshot(), ...options,
    onRefresh: () => calls.push(['refresh']), onOpenTerminal: () => calls.push(['terminal']),
    onOpenSettings: () => calls.push(['settings']),
    onCopyCommand: request => calls.push(['copy', copy(request)]),
    onOpenDocumentation: url => calls.push(['documentation', url]),
    onOpenArtifact: (id, path) => calls.push(['open', id, path]),
    onChange: state => { saved = copy(state); if (options.controlled) { props = { ...props, state: saved }; dom.window.mountBmad(props); } }
  };
  const tick = async () => { await new Promise(resolve => dom.window.requestAnimationFrame(() => dom.window.requestAnimationFrame(resolve))); };
  const render = async patch => { props = { ...props, ...patch }; dom.window.mountBmad(props); await tick(); };
  await render({});
  const document = dom.window.document;
  const button = text => [...document.querySelectorAll('button')].find(item => item.textContent.trim() === text || item.getAttribute('aria-label') === text);
  const click = async text => { const item = button(text); assert.ok(item, `Missing button ${text}`); item.click(); await tick(); };
  const task = async id => { const item = document.querySelector(`[data-task-id="${id}"]`); assert.ok(item); item.click(); await tick(); };
  return { dom, document, calls, button, click, task, tick, render, get saved() { return saved; } };
}

test('first use directs installation to WorkflowKit and never offers an independent BMAD installer', async t => {
  const data = withoutProgress(); data.root = undefined; data.version = undefined; data.compatibility = 'unknown';
  data.installation = { state: 'missing', reason: '尚未選擇專案。' };
  data.codex = { state: 'missing', skills: [], reason: '尚未偵測 Codex Skills。' }; data.catalogSource = 'guidance';
  const view = await mount(t, { snapshot: data });
  assert.equal(view.document.querySelector('#bmad-tab-start').getAttribute('aria-selected'), 'true');
  assert.doesNotMatch(view.document.querySelector('.bmad-panel').textContent, /npx bmad-method|官方安裝教學/);
  assert.equal(view.button('開啟終端機').disabled, true);
  assert.ok(view.document.querySelector('#bmad-requirement'));
  assert.equal(view.button('複製 BMAD 提示詞').disabled, true);
  assert.equal(view.button('確認這份產物已完成'), undefined);
  await view.click('開啟 WorkflowKit 設定');
  assert.deepEqual(view.calls.at(-1), ['settings']);
  assert.equal(view.calls.some(call => call[0] === 'terminal'), false, 'copying cannot launch or install anything');
  assert.equal(view.document.querySelector('.tool-drawer'), null);
});

test('initial section follows artifacts, ready environment, and explicit saved selection', async t => {
  const active = await mount(t); assert.equal(active.document.querySelector('#bmad-tab-progress').getAttribute('aria-selected'), 'true');
  const empty = await mount(t, { snapshot: withoutProgress() });
  assert.equal(empty.document.querySelector('#bmad-tab-start').getAttribute('aria-selected'), 'true');
  await empty.click('我想做什麼');
  assert.equal(empty.document.querySelector('.bmad-catalog-toggle').getAttribute('aria-expanded'), 'false');
  assert.equal(empty.document.querySelector('#bmad-catalog-content'), null);
  const saved = await mount(t, { state: { selectedSection: 'start' } });
  assert.equal(saved.document.querySelector('#bmad-tab-start').getAttribute('aria-selected'), 'true');
});

test('task guidance distinguishes direct Build, separate Spec, full planning, review and testing', async t => {
  const view = await mount(t, { snapshot: withoutProgress(), controlled: true });
  await view.click('我想做什麼');
  assert.match(view.document.querySelector('.bmad-task-note').textContent, /不必先跑完整 PRD 或 Sprint/);
  const commands = () => [...view.document.querySelectorAll('.bmad-task-detail .bmad-command-line code')].map(item => item.textContent);
  assert.deepEqual(commands(), ['$bmad-build']);
  await view.task('spec'); assert.deepEqual(commands(), ['$bmad-spec', '$bmad-build']);
  assert.match(view.document.querySelector('.bmad-task-detail').textContent, /SPEC\.md/);
  await view.task('product');
  assert.deepEqual(commands(), ['$bmad-prd', '$bmad-architecture', '$bmad-create-epics-and-stories', '$bmad-sprint-planning', '$bmad-build']);
  assert.match(view.document.querySelector('.bmad-task-note').textContent, /在架構前加入 UX/);
  await view.task('review'); assert.deepEqual(commands(), ['$bmad-code-review', '$bmad-review']);
  assert.match(view.document.querySelector('.bmad-task-note').textContent, /選用檢查/);
  await view.task('tests'); assert.deepEqual(commands(), ['$bmad-qa-generate-e2e-tests']);
  await view.task('continue'); await view.click('複製 $bmad-sprint-planning status');
  assert.deepEqual(view.calls.at(-1), ['copy', { revision: bmadUiSnapshot().revision, command: 'skill', skill: 'bmad-sprint-planning', stepId: 'sprint-status' }]);
  assert.equal(view.saved.selectedTaskId, 'continue');
});

test('capability cards provide concrete next steps without prescribing installation commands', async t => {
  const view = await mount(t, { snapshot: withoutProgress() });
  await view.click('我想做什麼');
  const nextSteps = () => [...view.document.querySelectorAll('.bmad-task-detail .bmad-command-card')].map(card => {
    const fact = [...card.querySelectorAll('.bmad-capability-facts > div')].find(item => item.querySelector('dt')?.textContent === '下一步');
    assert.ok(fact?.querySelector('dd')?.textContent.trim(), 'each capability explains its next step');
    return fact.querySelector('dd').textContent;
  });
  assert.match(nextSteps()[0], /Code Review 為選用/);
  for (const task of ['product', 'spec', 'ux', 'research', 'review', 'tests', 'continue']) {
    await view.task(task); const steps = nextSteps(); assert.ok(steps.length);
    if (task === 'ux') assert.match(steps[0], /\$bmad-architecture/);
    if (task === 'research') assert.match(steps[0], /\$bmad-spec.*\$bmad-prd/);
    if (task === 'tests') assert.match(steps[0], /執行測試.*驗收條件/);
  }
  await view.click('開始使用');
  assert.doesNotMatch(view.document.querySelector('.bmad-panel').textContent, /npx\.ps1|npx\.cmd/);
  assert.deepEqual(view.calls, [], 'reading alternatives does not execute any command');
});

test('missing capabilities remain clearly labeled teaching commands and partial installs never fake readiness', async t => {
  const data = withoutProgress(); data.codex.skills = data.codex.skills.filter(skill => skill !== 'bmad-qa-generate-e2e-tests'); data.codex.state = 'partial';
  const view = await mount(t, { snapshot: data, controlled: true, state: { selectedSection: 'capabilities', selectedTaskId: 'tests' } });
  assert.match(view.document.querySelector('.bmad-command-card').textContent, /此專案尚未安裝此能力/);
  assert.match(view.document.querySelector('.bmad-codex-state').textContent, /部分缺少/);
  await view.click('複製 $bmad-qa-generate-e2e-tests'); assert.equal(view.calls.at(-1)[1].skill, 'bmad-qa-generate-e2e-tests');
  data.nodes = data.nodes.filter(node => node.skill !== 'bmad-qa-generate-e2e-tests');
  await view.render({ snapshot: copy(data) }); await view.click('複製 $bmad-qa-generate-e2e-tests');
  assert.equal(view.calls.at(-1)[1].stepId, undefined, 'known canonical teaching can be copied without an installed catalog entry');
  const installed = withoutProgress(); await view.render({ snapshot: installed });
  assert.equal(view.saved.selectedTaskId, 'tests');
  assert.match(view.document.querySelector('.bmad-command-card').textContent, /已偵測 Codex Skill/);
});

test('environment checks display actual tool evidence and pinned documentation links', async t => {
  const data = withoutProgress(), environment = bmadEnvironmentSnapshot(data.root);
  environment.tools.find(tool => tool.id === 'uv').state = 'missing'; environment.tools.find(tool => tool.id === 'uv').reason = 'PATH 找不到 uv。';
  const view = await mount(t, { snapshot: data, environment, state: { selectedSection: 'start' } });
  assert.equal(view.document.querySelectorAll('.bmad-tool-checks li').length, 2);
  assert.match(view.document.querySelector('.bmad-tool-missing').textContent, /PATH 找不到 uv/);
  assert.match(view.document.querySelector('.bmad-tool-found').textContent, /已找到指令/);
  assert.match(view.document.querySelector('.bmad-prerequisites').textContent, /不需要 Node\.js/);
  await view.click('開啟終端機'); assert.deepEqual(view.calls.at(-1), ['terminal']);
  await view.click('查看最新 Release ↗'); assert.equal(view.calls.at(-1)[1], 'https://github.com/bmad-code-org/BMAD-METHOD/releases/latest');
  await view.render({ environment: bmadEnvironmentSnapshot('C:/another-project') });
  assert.equal(view.document.querySelector('.bmad-tool-checks'), null, 'checks from a previous project cannot appear as current evidence');
});

test('task input copies only ready requirements and distinguishes externally managed BMAD', async t => {
  const data = withoutProgress();
  const view = await mount(t, { snapshot: data, controlled: true, kit: { status: 'installed', bmadMode: 'external' } });
  assert.match(view.document.querySelector('.bmad-panel').textContent, /外部 BMAD.*保留/);
  const input = view.document.querySelector('#bmad-requirement');
  input.value = '檢查付款流程\n完成畫面'; input.dispatchEvent(new view.dom.window.Event('input', { bubbles: true })); await view.tick();
  assert.equal(view.button('複製 BMAD 提示詞').disabled, false);
  await view.click('複製 BMAD 提示詞');
  assert.deepEqual(view.calls.at(-1), ['copy', { revision: data.revision, command: 'task', requirement: '檢查付款流程\n完成畫面' }]);
  assert.equal(view.saved.requirement, '檢查付款流程\n完成畫面');
  await view.render({ kit: { status: 'installed', bmadMode: 'bundled', integrity: 'unverified', interfaceCompatibility: 'compatible', capabilities: ['bmad-workflow'] } });
  assert.equal(view.button('複製 BMAD 提示詞').disabled, true);
  await view.render({ kit: { status: 'error', message: '驗證失敗' } });
  assert.equal(view.button('複製 BMAD 提示詞').disabled, true);
  assert.match(view.document.querySelector('.bmad-panel').textContent, /驗證失敗/);
});

test('compact progress keeps parallel positions and exact native work identity without manual completion', async t => {
  const data = bmadUiSnapshot(); const view = await mount(t, { snapshot: data });
  assert.equal(view.document.querySelectorAll('.bmad-current-card').length, 2);
  assert.equal(view.document.querySelector('.bmad-progress-details').open, false);
  assert.equal(view.document.querySelector('[role="progressbar"]'), null);
  assert.doesNotMatch(view.document.querySelector('.bmad-position').textContent, /\d+%/);
  assert.equal(view.button('確認這份產物已完成'), undefined);
  const first = view.document.querySelector('.bmad-current-card button'); first.click(); await view.tick();
  assert.deepEqual(view.calls.at(-1), ['copy', { revision: data.revision, command: 'skill', skill: 'bmad-build', stepId: 'build', storyId: data.stories[0].id }]);
  assert.equal(view.calls.at(-1)[1].artifactId, undefined, 'a native command identifies one work source at a time');
  assert.match(view.document.querySelector('.bmad-artifact').textContent, /status: in-progress/);
  await view.click('開啟產物'); assert.deepEqual(view.calls.at(-1), ['open', 'build', data.steps.find(step => step.id === 'build').artifacts[0].path]);
  assert.match(view.document.querySelector('.bmad-artifact .bmad-status-badge').textContent, /進行中/);
});

test('artifact snapshots refresh native status and freshness while explicit guidance selection survives', async t => {
  const data = bmadUiSnapshot(); const view = await mount(t, { snapshot: data, controlled: true });
  await view.click('我想做什麼'); await view.task('research');
  const updated = copy(data); updated.revision = 'after-write'; updated.observation = { state: 'refreshing', lastSuccessfulAt: data.observedAt };
  await view.render({ snapshot: updated });
  assert.equal(view.document.querySelector('#bmad-tab-capabilities').getAttribute('aria-selected'), 'true');
  assert.equal(view.document.querySelector('#bmad-task-title').textContent, '先研究再做決定');
  assert.match(view.document.querySelector('.bmad-observation').textContent, /正在更新/);
  updated.observation = { state: 'watching', lastSuccessfulAt: '2026-10-18T09:01:00Z' };
  const artifact = updated.steps.find(step => step.id === 'build').artifacts[0];
  Object.assign(artifact, { status: 'complete', nativeStatus: 'done', stage: 'Build 已完成', marker: 'status: done', reason: '工作文件明確標示 done。' });
  await view.render({ snapshot: copy(updated) }); await view.click('目前進度');
  assert.match(view.document.querySelector('.bmad-artifact').textContent, /原生狀態已完成/);
  assert.ok(view.document.querySelector('.bmad-observation time[datetime="2026-10-18T09:01:00Z"]'));
  assert.ok(view.document.querySelector('.bmad-artifact time[datetime="2026-10-18T08:55:00Z"]'));
  assert.equal(view.document.querySelectorAll('.bmad-current-card').length, 2);
  assert.deepEqual(view.calls, [], 'observed progress never triggers a mutation');
});

test('unknown versions, blocked evidence and observation failures remain visible without invented completion', async t => {
  const data = bmadUiSnapshot(); data.version = '6.13.0'; data.compatibility = 'unverified';
  data.observation = { state: 'error', lastSuccessfulAt: data.observedAt, error: '檔案正在寫入，請稍後重新偵測。' };
  data.steps.find(step => step.id === 'build').artifacts[0].status = 'blocked';
  data.diagnostics = [{ code: 'conflict', message: '兩個正式來源的狀態不同。', path: '_bmad-output/story.md' }];
  const view = await mount(t, { snapshot: data });
  assert.match(view.document.querySelector('.bmad-version').textContent, /6\.13\.0.*6\.12\.4/);
  assert.match(view.document.querySelector('.bmad-environment-notice').textContent, /尚未經本頁驗證/);
  assert.match(view.document.querySelector('.bmad-observation').textContent, /更新失敗/);
  assert.match(view.document.querySelector('.bmad-artifact').textContent, /受阻/);
  assert.match(view.document.querySelector('.bmad-diagnostics').textContent, /正式來源/);
  await view.click('重新偵測'); assert.deepEqual(view.calls.at(-1), ['refresh']);
  await view.click('我想做什麼'); await view.click('複製 $bmad-build');
  assert.equal(view.calls.at(-1)[1].command, 'skill', 'generic teaching stays available when observation is temporarily unavailable');
});

test('catalog stays collapsed until requested, keeps custom entries readable and skips folded phases with keyboard', async t => {
  const data = withoutProgress(); data.nodes.push({ ...data.nodes[0], id: 'custom', skill: 'bmad-custom', displayName: '<script>custom()</script>', phase: 'custom', description: '專案新增的能力。' });
  const view = await mount(t, { snapshot: data, controlled: true, state: { selectedSection: 'capabilities', selectedTaskId: 'obsolete', selectedStepId: 'removed', expandedPhases: ['plan', 'solutioning', 'ship', 'anytime', 'other'] } });
  assert.equal(view.document.querySelector('#bmad-catalog-content'), null);
  view.document.querySelector('.bmad-catalog-toggle').click(); await view.tick();
  assert.match(view.document.querySelector('#bmad-phase-other').textContent, /其他能力/);
  assert.equal(view.document.querySelector('#bmad-phase-content-planning').hidden, true);
  const brief = view.document.querySelector('[data-step-id="brief"]'); brief.focus();
  brief.dispatchEvent(new view.dom.window.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })); await view.tick();
  assert.equal(view.document.activeElement.dataset.stepId, 'arch'); assert.equal(view.saved.selectedStepId, 'arch');
  assert.match(view.document.querySelector('.bmad-related').textContent, /參考順序/);
  view.document.querySelector('[data-step-id="custom"]').click(); await view.tick();
  assert.equal(view.document.querySelector('.bmad-step-detail h3').textContent, '<script>custom()</script>');
  assert.match(view.document.querySelector('.bmad-step-detail').textContent, /用 \$bmad-help 依目前產物判斷下一步/);
  assert.equal(view.document.querySelector('.bmad-step-detail script'), null);
  const reopened = await mount(t, { snapshot: data, state: view.saved });
  assert.equal(reopened.document.querySelector('.bmad-catalog-toggle').getAttribute('aria-expanded'), 'true');
  assert.equal(reopened.document.querySelector('[data-step-id="custom"]').getAttribute('aria-pressed'), 'true');
});

test('section tabs support keyboard navigation and persist the chosen section', async t => {
  const view = await mount(t, { controlled: true });
  const progress = view.document.getElementById('bmad-tab-progress'); progress.focus();
  progress.dispatchEvent(new view.dom.window.KeyboardEvent('keydown', { key: 'Home', bubbles: true })); await view.tick();
  assert.equal(view.saved.selectedSection, 'start'); assert.equal(view.document.activeElement.id, 'bmad-tab-start');
  view.document.activeElement.dispatchEvent(new view.dom.window.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })); await view.tick();
  assert.equal(view.saved.selectedSection, 'capabilities'); assert.equal(view.document.activeElement.id, 'bmad-tab-capabilities');
});
