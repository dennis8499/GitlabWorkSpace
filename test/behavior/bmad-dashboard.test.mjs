import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { JSDOM, VirtualConsole } from 'jsdom';
import { describeAction } from '../../out/src/workspace/actionPolicy.js';
import { bmadUiSnapshot, bmadWorkspaceSnapshot } from '../fixtures/bmad-ui.mjs';

const html = await readFile(new URL('../../resources/issue-webview/dashboard.html', import.meta.url), 'utf8');
const script = await readFile(new URL('../../resources/issue-webview/dashboard.js', import.meta.url), 'utf8');
const copy = value => JSON.parse(JSON.stringify(value));
const requestShape = ({ operationId, operationScope, hostSessionId, scopeEpoch, projectRevision, ...request }) => copy(request);

async function mount(t, initial = bmadWorkspaceSnapshot(), saved = { mode: 'bmad' }) {
  const errors = [], requests = [];
  const virtualConsole = new VirtualConsole();
  virtualConsole.on('jsdomError', error => errors.push(error.stack ?? error.message));
  const dom = new JSDOM(html, { url: 'https://bmad-dashboard.example.test', runScripts: 'outside-only', pretendToBeVisual: true, virtualConsole });
  dom.window.addEventListener('error', event => errors.push(event.error?.stack ?? event.message));
  t.after(() => { dom.window.close(); assert.deepEqual(errors, []); });
  let state = saved, revision = 0;
  dom.window.acquireVsCodeApi = () => ({ getState: () => state, setState: value => { state = copy(value); }, postMessage: request => {
    requests.push(request);
    if (request.operationId) queueMicrotask(() => dom.window.dispatchEvent(new dom.window.MessageEvent('message', { data: {
      type: 'operationChanged', operation: { ...describeAction(request, { scopeRevision: request.operationScope }),
        requestId: request.operationId, scopeRevision: request.operationScope, hostSessionId: 'bmad-test-host', revision: ++revision,
        label: '測試操作', status: 'succeeded', phase: '已完成', startedAt: Date.now(), finishedAt: Date.now() }
    } })));
  } });
  const tick = async () => { await new Promise(resolve => dom.window.requestAnimationFrame(() => dom.window.requestAnimationFrame(resolve))); };
  const sendSnapshot = async snapshot => { dom.window.dispatchEvent(new dom.window.MessageEvent('message', { data: { type: 'snapshot', snapshot } })); await tick(); };
  dom.window.eval(script); await tick();
  assert.equal(requests[0]?.type, 'ready');
  await sendSnapshot(initial); await tick();
  const document = dom.window.document;
  const button = text => [...document.querySelectorAll('.bmad-panel button')].find(item => item.textContent.trim() === text);
  const click = async text => { const item = button(text); assert.ok(item, `Missing BMAD button ${text}`); item.click(); await tick(); };
  return { dom, document, requests, tick, sendSnapshot, click, button, get saved() { return state; } };
}

test('packaged dashboard opens BMAD before GitLab login and returns from environment settings', async t => {
  const data = bmadWorkspaceSnapshot(); data.bmad.installation = { state: 'missing', reason: '請先安裝 BMAD。' }; data.bmad.catalogSource = 'bundled';
  const view = await mount(t, data);
  assert.ok(view.document.querySelector('.page[data-mode="bmad"] .bmad-panel'));
  assert.equal(view.document.querySelector('.bmad-panel h1').textContent, '開發流程');
  assert.equal(view.document.querySelectorAll('.bmad-flow-step').length, data.bmad.nodes.length);
  assert.equal(view.document.querySelector('.page .empty-state'), null, 'GitLab login does not block the local BMAD guide');
  await view.click('安裝／設定 BMAD');
  assert.equal(view.document.querySelector('#settings-tab-tools').getAttribute('aria-selected'), 'true');
  assert.match(view.document.querySelector('.tool-drawer').textContent, /工作區與工具/);
  [...view.document.querySelectorAll('.tool-drawer button')].find(item => item.textContent === '關閉').click(); await view.tick();
  assert.equal(view.document.querySelector('.tool-drawer'), null);
  assert.ok(view.document.querySelector('.bmad-panel'));
  assert.equal(view.requests.some(item => item.type === 'connect'), false);
});

test('packaged dashboard sends current revision and exact artifact identity for BMAD actions', async t => {
  const data = bmadWorkspaceSnapshot();
  const view = await mount(t, data);
  for (const [label, type] of [['在 Codex 執行', 'launchBmadStep'], ['複製提示詞', 'copyBmadPrompt'], ['查看產物', 'openBmadArtifact'], ['確認這份產物已完成', 'confirmBmadArtifact']]) {
    await view.click(label);
    const request = view.requests.findLast(item => item.type === type);
    const expected = { type, stepId: 'build', revision: data.bmad.revision };
    if (type === 'openBmadArtifact') expected.path = `${data.bmad.root}/_bmad-output/specs/spec-checkout/story-a.md`;
    if (type === 'confirmBmadArtifact') expected.artifactId = 'story-a';
    assert.deepEqual(requestShape(request), expected);
  }
  assert.equal(view.document.querySelector('[data-step-id="build"]').classList.contains('bmad-status-draft'), true);
  const updated = copy(data); updated.bmad.revision = 'revision-after-confirmation';
  const artifact = updated.bmad.steps.find(item => item.id === 'build').artifacts[0];
  Object.assign(artifact, { confirmed: true, canConfirm: false, status: 'complete', reason: '已人工確認這份文件。' });
  await view.sendSnapshot(updated);
  assert.match(view.document.querySelector('.bmad-artifact').textContent, /已人工確認/);
  await view.click('撤銷人工確認');
  assert.deepEqual(requestShape(view.requests.findLast(item => item.type === 'revokeBmadConfirmation')),
    { type: 'revokeBmadConfirmation', stepId: 'build', artifactId: 'story-a', revision: 'revision-after-confirmation' });
  await view.click('重新整理');
  assert.deepEqual(requestShape(view.requests.findLast(item => item.type === 'refreshBmad')), { type: 'refreshBmad' });
});

test('packaged dashboard applies artifact updates while preserving selection and both parallel work positions', async t => {
  const data = bmadWorkspaceSnapshot(); const view = await mount(t, data);
  view.document.querySelector('[data-step-id="prd"]').click(); await view.tick();
  const updated = copy(data); updated.bmad.revision = 'revision-after-write';
  const step = updated.bmad.steps.find(item => item.id === 'prd');
  Object.assign(step, { status: 'complete', summary: 'PRD 已儲存且含完成標記。', artifacts: [{ id: 'prd', path: `${updated.bmad.root}/_bmad-output/prd.md`,
    relativePath: '_bmad-output/prd.md', fingerprint: 'prd-sha', status: 'complete', reason: '含完成標記。', canConfirm: false, confirmed: false }] });
  await view.sendSnapshot(updated);
  assert.equal(view.document.querySelector('.bmad-step-detail h2').textContent, '需求文件');
  assert.equal(view.document.querySelector('.bmad-step-detail .bmad-status-badge').textContent, '已完成');
  assert.equal(view.document.querySelectorAll('.bmad-current-card').length, 2);
  assert.equal(view.document.querySelector('[data-step-id="prd"]').hasAttribute('aria-current'), false);
  assert.deepEqual([...view.document.querySelectorAll('.bmad-flow-step[aria-current="step"]')].map(item => item.dataset.stepId), ['build', 'review']);
  await view.click('查看產物');
  assert.equal(view.requests.findLast(item => item.type === 'openBmadArtifact').revision, 'revision-after-write');
});

test('packaged dashboard persists selected nodes and expanded phases independently per project root', async t => {
  const rootA = 'C:/專案/服務 A', rootB = 'C:/專案/服務 B';
  const view = await mount(t, bmadWorkspaceSnapshot(rootA));
  view.document.querySelector('[data-step-id="prd"]').click(); await view.tick();
  view.document.getElementById('bmad-phase-solutioning').click(); await view.tick();
  assert.equal(view.saved.bmadUiByRoot[rootA].selectedStepId, 'prd');
  assert.equal(view.saved.bmadUiByRoot[rootA].expandedPhases.includes('solutioning'), false);
  await view.sendSnapshot(bmadWorkspaceSnapshot(rootB));
  view.document.querySelector('[data-step-id="arch"]').click(); await view.tick();
  assert.equal(view.saved.bmadUiByRoot[rootB].selectedStepId, 'arch');
  await view.sendSnapshot(bmadWorkspaceSnapshot(rootA));
  assert.equal(view.document.querySelector('.bmad-step-detail h2').textContent, '需求文件');
  assert.equal(view.document.getElementById('bmad-phase-solutioning').getAttribute('aria-expanded'), 'false');
  const reopened = await mount(t, bmadWorkspaceSnapshot(rootA, bmadUiSnapshot(rootA)), view.saved);
  assert.equal(reopened.document.querySelector('.bmad-step-detail h2').textContent, '需求文件');
  assert.equal(reopened.document.getElementById('bmad-phase-solutioning').getAttribute('aria-expanded'), 'false');
});
