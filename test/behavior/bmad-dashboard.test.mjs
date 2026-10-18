import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM, VirtualConsole } from 'jsdom';
import { describeAction } from '../../out/src/workspace/actionPolicy.js';
import { bmadUiSnapshot, bmadWorkspaceSnapshot } from '../fixtures/bmad-ui.mjs';
import { webviewBundle } from './webview-bundle.mjs';

const { html, script } = await webviewBundle('dashboard');
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
  const button = text => [...document.querySelectorAll('.bmad-panel button')].find(item => item.textContent.trim() === text || item.getAttribute('aria-label') === text);
  const click = async text => { const item = button(text); assert.ok(item, `Missing BMAD button ${text}`); item.click(); await tick(); };
  return { dom, document, requests, tick, sendSnapshot, click, button, get saved() { return state; } };
}

test('dashboard offers external CLI onboarding before GitLab login without an integrated installer', async t => {
  const data = bmadWorkspaceSnapshot();
  Object.assign(data.bmad, { version: undefined, compatibility: 'unknown', catalogSource: 'guidance', currentCandidates: [], stories: [], recommendations: [] });
  data.bmad.steps.forEach(step => { step.artifacts = []; step.status = 'not-observed'; });
  data.bmad.installation = { state: 'missing', reason: '請在 CLI 初始化 BMAD。' };
  data.bmad.codex = { state: 'missing', skills: [], reason: '尚未偵測 Codex Skills。' };
  const view = await mount(t, data);
  assert.ok(view.document.querySelector('.page[data-mode="bmad"] .bmad-panel'));
  assert.equal(view.document.querySelector('.bmad-panel h1').textContent, 'BMAD 使用指南');
  assert.equal(view.document.querySelector('#bmad-tab-start').getAttribute('aria-selected'), 'true');
  assert.equal(view.document.querySelector('.page .empty-state'), null);
  assert.equal(view.document.querySelector('form.bmad-prompt-form, .tool-drawer'), null);
  await view.click('複製安裝指令');
  assert.deepEqual(requestShape(view.requests.findLast(item => item.type === 'copyBmadCommand')),
    { type: 'copyBmadCommand', command: 'install', revision: data.bmad.revision });
  await view.click('開啟終端機');
  assert.deepEqual(requestShape(view.requests.findLast(item => item.type === 'openBmadTerminal')),
    { type: 'openBmadTerminal', revision: data.bmad.revision });
  await view.click('官方安裝教學 ↗');
  assert.match(view.requests.findLast(item => item.type === 'openExternal').url, /\/blob\/v6\.12\.4\/docs\/start\/install-bmad\.md$/);
  assert.equal(view.requests.some(item => ['connect', 'installWorkflowKit', 'copyBmadPrompt', 'openCodexTerminal'].includes(item.type)), false);
});

test('dashboard sends native command identity and exact revision while leaving observed progress unchanged', async t => {
  const data = bmadWorkspaceSnapshot(); const view = await mount(t, data);
  assert.equal(view.document.querySelector('.bmad-progress-details').open, false);
  view.document.querySelector('.bmad-current-card button').click(); await view.tick();
  assert.deepEqual(requestShape(view.requests.findLast(item => item.type === 'copyBmadCommand')),
    { type: 'copyBmadCommand', command: 'skill', skill: 'bmad-build', stepId: 'build', storyId: data.bmad.stories[0].id, revision: data.bmad.revision });
  await view.click('開啟產物');
  assert.deepEqual(requestShape(view.requests.findLast(item => item.type === 'openBmadArtifact')),
    { type: 'openBmadArtifact', stepId: 'build', path: data.bmad.steps.find(step => step.id === 'build').artifacts[0].path, revision: data.bmad.revision });
  assert.match(view.document.querySelector('.bmad-artifact .bmad-status-badge').textContent, /進行中/);
  assert.equal(view.button('確認這份產物已完成'), undefined); assert.equal(view.button('撤銷人工確認'), undefined);
  assert.equal(view.requests.some(item => ['confirmBmadArtifact', 'revokeBmadConfirmation'].includes(item.type)), false);
  await view.click('重新偵測');
  assert.deepEqual(requestShape(view.requests.findLast(item => item.type === 'refreshBmad')), { type: 'refreshBmad' });
});

test('dashboard applies live native evidence without discarding task selection or parallel positions', async t => {
  const data = bmadWorkspaceSnapshot(); const view = await mount(t, data);
  await view.click('我想做什麼'); view.document.querySelector('[data-task-id="spec"]').click(); await view.tick();
  const updated = copy(data); updated.bmad.revision = 'revision-after-write';
  updated.bmad.observation = { state: 'watching', lastSuccessfulAt: '2026-10-18T09:01:00Z' };
  const artifact = updated.bmad.steps.find(step => step.id === 'build').artifacts[0];
  Object.assign(artifact, { status: 'complete', nativeStatus: 'done', stage: 'Build 已完成', reason: '原生文件標示 done。', marker: 'status: done' });
  await view.sendSnapshot(updated);
  assert.equal(view.document.querySelector('#bmad-tab-capabilities').getAttribute('aria-selected'), 'true');
  assert.equal(view.document.querySelector('[data-task-id="spec"]').getAttribute('aria-pressed'), 'true');
  assert.ok(view.document.querySelector('.bmad-observation time[datetime="2026-10-18T09:01:00Z"]'));
  await view.click('目前進度');
  assert.match(view.document.querySelector('.bmad-artifact').textContent, /原生狀態已完成/);
  assert.equal(view.document.querySelectorAll('.bmad-current-card').length, 2);
  await view.click('開啟產物'); assert.equal(view.requests.findLast(item => item.type === 'openBmadArtifact').revision, 'revision-after-write');
});

test('dashboard persists section, task and collapsed catalog choices independently per project', async t => {
  const rootA = 'C:/專案/服務 A', rootB = 'C:/專案/服務 B';
  const view = await mount(t, bmadWorkspaceSnapshot(rootA));
  await view.click('我想做什麼'); view.document.querySelector('[data-task-id="product"]').click(); await view.tick();
  view.document.querySelector('.bmad-catalog-toggle').click(); await view.tick();
  view.document.querySelector('[data-step-id="prd"]').click(); await view.tick();
  view.document.getElementById('bmad-phase-solutioning').click(); await view.tick();
  assert.equal(view.saved.bmadUiByRoot[rootA].selectedTaskId, 'product');
  assert.equal(view.saved.bmadUiByRoot[rootA].showCatalog, true);
  await view.sendSnapshot(bmadWorkspaceSnapshot(rootB)); await view.click('開始使用');
  assert.equal(view.saved.bmadUiByRoot[rootB].selectedSection, 'start');
  await view.sendSnapshot(bmadWorkspaceSnapshot(rootA));
  assert.equal(view.document.querySelector('#bmad-tab-capabilities').getAttribute('aria-selected'), 'true');
  assert.equal(view.document.querySelector('[data-task-id="product"]').getAttribute('aria-pressed'), 'true');
  assert.equal(view.document.querySelector('[data-step-id="prd"]').getAttribute('aria-pressed'), 'true');
  assert.equal(view.document.getElementById('bmad-phase-solutioning').getAttribute('aria-expanded'), 'false');
  const reopened = await mount(t, bmadWorkspaceSnapshot(rootA, bmadUiSnapshot(rootA)), view.saved);
  assert.equal(reopened.document.querySelector('.bmad-step-detail h3').textContent, '建立或檢查 PRD');
  assert.equal(reopened.document.querySelector('.bmad-catalog-toggle').getAttribute('aria-expanded'), 'true');
});
