// Evidence-only production-bundle probe. It never builds, edits application source, or calls GitLab/Codex.
import { readFile, writeFile, mkdir, access } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import ts from 'typescript';
import { chromium } from 'playwright-core';
import { createWebviewCsp } from '../../../out/src/webviewSecurity.js';

const directory = path.dirname(fileURLToPath(import.meta.url)), root = path.resolve(directory, '../../..');
const layout = process.env.QA_LAYOUT === 'classic' ? 'classic' : 'workspace';
const evidence = path.join(directory, 'evidence', process.env.QA_OUTPUT ?? 'ui-matrix');
const patchCss = process.env.QA_PATCH ? await readFile(path.resolve(directory, process.env.QA_PATCH), 'utf8') : '';
await mkdir(evidence, { recursive: true });
const assets = new Map();
for (const name of ['dashboard.html', 'dashboard.js', 'dashboard.css', 'codicon.ttf']) assets.set(name, await readFile(path.join(root, 'resources/issue-webview', name)));
const assetHashes = Object.fromEntries([...assets].map(([name, bytes]) => [name, createHash('sha256').update(bytes).digest('hex')]));
const fixtureText = await readFile(path.join(root, 'test/behavior/dashboard.test.mjs'), 'utf8');
const ast = ts.createSourceFile('fixtures.mjs', fixtureText, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
const fixtureFunctions = ast.statements.filter(node => ts.isFunctionDeclaration(node) && ['project', 'snapshot'].includes(node.name?.text)).map(node => node.getText(ast));
if (fixtureFunctions.length !== 2) throw new Error('Fixture definitions changed; inspect the probe.');
const snapshot = new Function(fixtureFunctions.join('\n') + '; return snapshot;')();
let themeRoot = process.env.VSCODE_THEME_ROOT;
for (const candidate of ['.vscode-test/vscode-win32-x64-archive-1.145.0/a717861c07/resources/app/extensions/theme-defaults/themes', '.vscode-test/vscode-win32-x64-archive-1.90.0/resources/app/extensions/theme-defaults/themes']) {
  if (themeRoot) break;
  try { await access(path.join(root, candidate, 'light_modern.json')); themeRoot = path.join(root, candidate); } catch { /* Try cached fallback. */ }
}
if (!themeRoot) throw new Error('VS Code theme fixtures unavailable.');
async function themeColors(filename) {
  const result = ts.parseConfigFileTextToJson(filename, await readFile(path.join(themeRoot, filename), 'utf8'));
  if (result.error) throw new Error('Invalid theme JSON');
  return { ...(result.config.include ? await themeColors(result.config.include) : {}), ...result.config.colors };
}
const themes = {};
for (const [name, file, bodyClass, light] of [['light', 'light_modern.json', 'vscode-light', true], ['dark', 'dark_modern.json', 'vscode-dark', false], ['hc-dark', 'hc_black.json', 'vscode-high-contrast', false], ['hc-light', 'hc_light.json', 'vscode-high-contrast-light', true]]) {
  const fallback = { foreground: light ? '#3b3b3b' : '#ccc', 'editor.background': light ? '#fff' : '#1f1f1f', 'sideBar.background': light ? '#f8f8f8' : '#181818',
    'descriptionForeground': light ? '#616161' : '#9d9d9d', 'focusBorder': light ? '#005fb8' : '#0078d4', 'button.background': light ? '#005fb8' : '#0078d4', 'button.foreground': '#fff',
    'button.secondaryBackground': light ? '#e5e5e5' : '#313131', 'button.secondaryForeground': light ? '#3b3b3b' : '#ccc', 'input.background': light ? '#fff' : '#313131',
    'input.foreground': light ? '#3b3b3b' : '#ccc', 'input.border': light ? '#cecece' : '#3c3c3c', 'panel.border': light ? '#e5e5e5' : '#2b2b2b',
    'textLink.foreground': light ? '#005fb8' : '#4daafc', 'errorForeground': light ? '#a1260d' : '#f48771', 'testing.iconPassed': light ? '#388a34' : '#73c991' };
  themes[name] = { bodyClass, css: ':root{' + Object.entries({ ...fallback, ...await themeColors(file) }).map(([key, value]) => `--vscode-${key.replaceAll('.', '-')}:${value};`).join('') + '--vscode-font-family:"Segoe UI",sans-serif;--vscode-font-size:13px;--vscode-editor-font-family:Consolas,monospace;}' };
}
const origin = { kind: 'issue', accountKey: 'fixture', baseUrl: 'https://gitlab.test', projectId: 1, projectPath: 'team/service', webUrl: 'https://gitlab.test/team/service/-/issues/42',
  repositoryRoot: 'C:/workspace/service', iid: 42, sourceBranch: 'main', sourceSha: 'a'.repeat(40), branch: 'issue/42-login' };
const task = { id: 'matrix-issue', title: 'Issue #42 · 修正登入與工作階段', root: 'C:/workspace', status: 'waiting', createdAt: '2026-11-10T04:00:00Z', updatedAt: '2026-11-10T04:05:00Z',
  origin, threadId: 'thread-matrix', turnId: 'turn-matrix', controls: { external: false, canPause: true, canResume: false, canDelete: false, canAutoAccept: true, autoAccept: false },
  progress: { phase: 'executing', model: 'fixture-model', plan: [{ step: '核對來源並重現登入問題', status: 'completed' }, { step: '實作與測試', status: 'inProgress' }] },
  pendingMessages: 1, messageQueue: [{ id: 'saved-message', state: 'queued', text: '請一併確認登出後不會保留舊的登入狀態。\n保留現有 API 相容性。' }] };
const draft = { schema: 'GitLabWorkspaceCodexLaunch/v1', id: 'matrix-launch', revision: 1, scope: 'team-scope', state: 'ready', source: { kind: 'issue', projectId: 1, issueIid: 42 },
  title: 'Issue #42 · 修正登入與工作階段', requirement: '保留現有使用方式，補齊登入過期與登出測試。', repositoryId: 'repo', repositories: [{ id: 'repo', name: 'service', path: 'C:/workspace/service' }],
  models: [{ id: 'fixture-model', label: 'Fixture model', efforts: ['medium', 'high'], defaultEffort: 'high' }], model: 'fixture-model', effort: 'high', isolated: true,
  branch: 'issue/42-login', sourceSha: 'a'.repeat(40), workingDirectory: 'C:/runtime/issue-42/worktree', updatedAt: '2026-11-10T04:00:00Z',
  checks: [['source', '來源版本'], ['repository', '本機 Repo'], ['workflow', 'WorkflowKit'], ['codex', 'Codex 登入與權限'], ['selection', '模型與執行設定']].map(([id, label]) => ({ id, label, state: 'ready' })) };
const activeLaunch = process.env.QA_SOURCE_CHANGE === '1' ? { ...draft, sourceSha: 'c'.repeat(40), targetSha: 'd'.repeat(40), sourceChange: { key: 'matrix-source-change', acknowledged: false,
  previous: { sourceSha: 'a'.repeat(40), targetSha: 'b'.repeat(40), title: '原本的登入需求與驗收條件', updatedAt: '2026-11-09T08:00:00Z' },
  current: { sourceSha: 'c'.repeat(40), targetSha: 'd'.repeat(40), title: '更新登入需求：登出與工作階段到期後都必須重新驗證', updatedAt: '2026-11-10T08:00:00Z' }, discussionsChanged: true } } : draft;
const send = (page, message) => page.evaluate(data => window.dispatchEvent(new MessageEvent('message', { data })), message);
const settle = page => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
const settleScroll = page => page.evaluate(() => new Promise(resolve => {
  let last = '', stable = 0, remaining = 120;
  const check = () => { const current = [...document.querySelectorAll('.codex-attention, .codex-conversation')].map(element => element.scrollTop).join(',');
    stable = current === last ? stable + 1 : 0; last = current;
    if (stable >= 5 || --remaining <= 0) resolve(); else requestAnimationFrame(check);
  }; requestAnimationFrame(check);
}));
const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROME_PATH ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe' });
const results = [];
async function mount(themeName, width, scale, requestedLayout = layout) {
  const theme = themes[themeName], page = await browser.newPage({ viewport: { width: Math.floor(width / scale), height: Math.floor(900 / scale) }, deviceScaleFactor: scale, reducedMotion: 'reduce' });
  const errors = [], external = []; page.on('pageerror', error => errors.push(String(error)));
  await page.route('**/*', async route => {
    const url = new URL(route.request().url()), name = path.basename(url.pathname);
    if (url.hostname !== '127.0.0.1') { external.push(url.origin); await route.abort(); return; }
    let body = name === 'theme.css' ? theme.css : assets.get(name);
    if (body === undefined) { await route.fulfill({ status: 404, body: '' }); return; }
    if (name === 'dashboard.css' && patchCss) body = body.toString() + '\n' + patchCss;
    if (name === 'dashboard.html') body = body.toString().replace('<head>', `<head><meta http-equiv="Content-Security-Policy" content="${createWebviewCsp("'self'", 'matrix-probe', 'dashboard')}"><link rel="stylesheet" href="/theme.css">`).replace('<body>', `<body class="${theme.bodyClass}">`).replace(/<script\b/g, '<script nonce="matrix-probe"');
    await route.fulfill({ contentType: name.endsWith('.js') ? 'application/javascript' : name.endsWith('.css') ? 'text/css' : name.endsWith('.ttf') ? 'font/ttf' : 'text/html', body });
  });
  await page.addInitScript(() => { let state = { mode: 'codex' }; window.matrixRequests = []; window.matrixCsp = [];
    const entries = new Map(), conflicts = [], scope = 'matrix-local-host';
    let conflictSequence = 0;
    const respondDrafts = requestId => queueMicrotask(() => window.dispatchEvent(new MessageEvent('message', { data: {
      type: 'codexUiDrafts', requestId, snapshot: { scope, entries: [...entries.values()], conflicts: [...conflicts] }
    } })));
    window.addEventListener('securitypolicyviolation', event => window.matrixCsp.push(event.violatedDirective));
    window.acquireVsCodeApi = () => ({ getState: () => state, setState: next => { state = next; }, postMessage: message => { window.matrixRequests.push(message);
      if (message.type === 'loadCodexUiDrafts') respondDrafts(message.requestId);
      if (message.type === 'saveCodexUiDrafts') {
        const accepted = new Set();
        for (const update of message.updates) {
          const current = entries.get(update.key), revision = current?.revision ?? 0;
          if (update.revision !== revision) {
            conflicts.push({ id: `matrix-conflict-${++conflictSequence}`, key: update.key, value: update.value, createdAt: new Date().toISOString() });
          } else {
            if (JSON.stringify(current?.value ?? null) !== JSON.stringify(update.value)) entries.set(update.key, { ...update, revision: revision + 1 });
            accepted.add(update.key);
          }
        }
        for (let index = conflicts.length - 1; index >= 0; index--) if (message.resolveConflictIds?.includes(conflicts[index].id) && accepted.has(conflicts[index].key)) conflicts.splice(index, 1);
        respondDrafts(message.requestId);
      }
      if (message.operationId && ['codexHistory', 'previewProjectWiki', 'readCodexResult'].includes(message.type)) queueMicrotask(() => window.dispatchEvent(new MessageEvent('message', { data: { type: 'operationChanged', operation: {
        requestId: message.operationId, scopeRevision: message.operationScope, resourceKey: `codex:${message.taskId}`, action: message.type, label: 'Fixture read', status: 'succeeded', phase: 'Done', effect: 'none', startedAt: Date.now() } } })));
    } });
  });
  await page.goto('http://127.0.0.1:7777/dashboard.html'); await page.waitForFunction(() => window.matrixRequests.some(request => request.type === 'ready'));
  await send(page, { type: 'snapshot', snapshot: { ...snapshot('codex'), codexWorkspaceLayout: requestedLayout } }); await page.locator('.codex-workspace').waitFor();
  await page.locator('.codex-draft-sync[data-state="saved"]').waitFor(); await settle(page);
  return { page, errors, external };
}
async function inspect(view, name, state, theme, width, scale) {
  const { page } = view; await settle(page); await page.evaluate(() => document.fonts.ready);
  await page.locator('.codex-draft-sync[data-state="saved"]').waitFor();
  const geometry = await page.evaluate(() => {
    const box = selector => { const element = document.querySelector(selector); if (!element || !element.checkVisibility()) return undefined; const rect = element.getBoundingClientRect(); return { x: rect.x, y: rect.y, width: rect.width, height: rect.height, right: rect.right, bottom: rect.bottom }; };
    const composer = box('.codex-message'), conversation = box('.codex-conversation'), attention = box('.codex-attention'), execution = box('.codex-execution-panel'), resultPanel = box('.codex-results-panel');
    return { viewport: { width: innerWidth, height: innerHeight }, documentWidth: document.documentElement.scrollWidth, conversation, composer, attention, execution, resultPanel,
      horizontalOverflow: document.documentElement.scrollWidth > innerWidth + 1,
      composerClipped: !!composer && (!!conversation && composer.bottom > conversation.bottom + 1 || composer.bottom > innerHeight + 1),
      overlap: !!execution && !!attention && execution.bottom > attention.y + 1, collapsedResults: !!resultPanel && resultPanel.height < 80,
      tabsWithoutPanel: [...document.querySelectorAll('[role="tab"]')].filter(element => element.checkVisibility()).filter(element => !document.getElementById(element.getAttribute('aria-controls'))).map(element => element.textContent), csp: window.matrixCsp };
  });
  await page.screenshot({ path: path.join(evidence, name + '.png') });
  const focusPath = [], seen = new Set(); let badScreenshot = false;
  await page.evaluate(() => { document.activeElement?.blur(); window.scrollTo(0, 0); });
  for (let index = 0; index < 80; index++) {
    await page.keyboard.press('Tab');
    const focus = await page.evaluate(() => {
      const element = document.activeElement; if (!element || element === document.body) return undefined;
      const rect = element.getBoundingClientRect(); let left = 0, top = 0, right = innerWidth, bottom = innerHeight;
      for (let parent = element.parentElement; parent; parent = parent.parentElement) { const style = getComputedStyle(parent), bounds = parent.getBoundingClientRect();
        if (/(auto|scroll|hidden|clip)/.test(style.overflowX)) { left = Math.max(left, bounds.left); right = Math.min(right, bounds.right); }
        if (/(auto|scroll|hidden|clip)/.test(style.overflowY)) { top = Math.max(top, bounds.top); bottom = Math.min(bottom, bounds.bottom); }
      }
      const hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
      return { tag: element.tagName, role: element.getAttribute('role'), id: element.id, name: element.getAttribute('aria-label') || element.textContent?.trim().slice(0, 80) || element.getAttribute('placeholder') || element.tagName,
        selector: element.className, visible: rect.right > left && rect.left < right && rect.bottom > top && rect.top < bottom,
        unobscured: !!hit && (element === hit || element.contains(hit)),
        centerVisible: rect.x + rect.width / 2 >= left && rect.x + rect.width / 2 <= right && rect.y + rect.height / 2 >= top && rect.y + rect.height / 2 <= bottom };
    });
    if (!focus) continue;
    const key = JSON.stringify([focus.tag, focus.id, focus.name, focus.selector]); if (seen.has(key)) break; seen.add(key); focusPath.push(focus);
    if ((!focus.visible || !focus.centerVisible || !focus.unobscured) && !badScreenshot) { await page.screenshot({ path: path.join(evidence, name + '-focus-clipped.png') }); badScreenshot = true; }
  }
  const checks = {}, longDetailScroll = {};
  if (state !== 'launch') {
    if (layout === 'workspace') { await page.locator('#codex-execution-tab').focus(); await page.keyboard.press('End'); checks.arrowNavigation = await page.locator('#codex-results-tab').getAttribute('aria-selected') === 'true'; }
    else checks.classicPanels = await page.locator('#codex-results-panel').isVisible() && await page.locator('#codex-execution-panel').isVisible() && !await page.locator('.codex-content-tabs').isVisible();
    await page.locator('.codex-details-toggle').focus(); await page.keyboard.press('Enter'); await page.keyboard.press('Tab');
    checks.drawerFocus = await page.evaluate(() => { const element = document.activeElement, rect = element.getBoundingClientRect(), hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2); return element === hit || element.contains(hit); });
    await page.keyboard.press('Escape');
    checks.drawerEscape = await page.locator('.codex-details-drawer').getAttribute('hidden') !== null && await page.locator('.codex-details-toggle').evaluate(element => element === document.activeElement);
  }
  if (state === 'waiting') {
    await page.locator('.codex-message-queue summary').focus(); await page.keyboard.press('Enter'); await page.keyboard.press('Tab');
    checks.queueCopyFocus = await page.evaluate(() => { const element = document.activeElement, rect = element.getBoundingClientRect(), hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2); return element.textContent === '複製完整內容' && (element === hit || element.contains(hit)); });
    if (scale === 2) await page.screenshot({ path: path.join(evidence, name + '-queue.png') });
    await page.keyboard.press('Escape'); checks.queueEscape = !await page.locator('.codex-message-queue').evaluate(element => element.open);
  }
  if (scale === 2) {
    const focusTarget = state === 'waiting' ? '.codex-answer-options button' : state === 'launch' ? '#codex-launch-requirement' : '.codex-workflow-result select';
    await page.locator(focusTarget).first().focus(); await settle(page);
    await page.screenshot({ path: path.join(evidence, name + '-focused-content.png') });
  }
  if (state === 'waiting') {
    const detail = Array.from({ length: 50 }, (_, index) => `Approval detail line ${index + 1}: preserve complete command context`).join('\n');
    await send(page, { type: 'codexEvent', event: { kind: 'interactions', taskId: task.id, interactions: [{ id: 'long-approval', taskId: task.id, kind: 'command', title: 'Long approval', detail }] } });
    await settle(page); await page.locator('.codex-interaction pre').focus(); await settleScroll(page); await page.keyboard.press('Home'); await settleScroll(page);
    const scrollPosition = () => page.evaluate(() => [...document.querySelectorAll('.codex-attention, .codex-conversation')].reduce((sum, element) => sum + element.scrollTop, 0));
    const beforeScroll = await scrollPosition(); await page.keyboard.press('PageDown'); await settleScroll(page);
    longDetailScroll.before = beforeScroll; longDetailScroll.after = await scrollPosition();
    checks.longDetailKeyboardScroll = longDetailScroll.after > beforeScroll;
    checks.longDetailPreserved = await page.locator('.codex-interaction pre').textContent() === detail;
    await page.keyboard.press('Tab'); await settleScroll(page);
    checks.longDetailApprovalReachable = await page.evaluate(() => { const element = document.activeElement, rect = element.getBoundingClientRect(), hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2); return element.textContent === '核准本次要求' && (element === hit || element.contains(hit)); });
    if (scale === 2 || width === 320) await page.screenshot({ path: path.join(evidence, name + '-long-approval.png') });
  }
  const inputSelector = state === 'launch' ? '#codex-launch-requirement' : '#codex-follow-up';
  if (state !== 'launch') await page.locator(inputSelector).fill('Preserve this draft across layout changes.');
  const beforeToggle = await page.evaluate(selector => { window.matrixLayoutInput = document.querySelector(selector); return { value: window.matrixLayoutInput.value, requests: window.matrixRequests.length }; }, inputSelector);
  checks.layoutTogglePreservesInput = true; checks.layoutToggleSingleOwner = true; checks.layoutDetailsPresentation = true;
  for (const nextLayout of [layout === 'classic' ? 'workspace' : 'classic', layout]) {
    await send(page, { type: 'snapshot', snapshot: { ...snapshot('codex'), codexWorkspaceLayout: nextLayout } }); await settle(page);
    const changed = await page.evaluate(({ selector, value, expectedLayout }) => {
      const root = document.querySelector('.codex-workspace'), input = document.querySelector(selector), drawer = document.querySelector('.codex-details-drawer');
      return { input: input === window.matrixLayoutInput && input.value === value, single: document.querySelectorAll('.codex-workspace').length === 1 && root.dataset.layout === expectedLayout,
        details: !drawer || getComputedStyle(drawer).position === (expectedLayout === 'classic' ? 'static' : 'absolute') };
    }, { selector: inputSelector, value: beforeToggle.value, expectedLayout: nextLayout });
    checks.layoutTogglePreservesInput &&= changed.input; checks.layoutToggleSingleOwner &&= changed.single; checks.layoutDetailsPresentation &&= changed.details;
  }
  checks.layoutToggleDoesNotStartWork = await page.evaluate(index => !window.matrixRequests.slice(index).some(request => ['startCodexTask', 'resumeCodexTask', 'pauseCodexTask', 'submitCodexLaunch', 'sendCodexMessage', 'answerCodexInteraction'].includes(request.type)), beforeToggle.requests);
  if (state === 'launch' && process.env.QA_SOURCE_CHANGE === '1') {
    const panel = page.locator('.codex-launch-source-change'), acknowledge = panel.locator('button'), start = page.locator('.codex-launch-actions button[type="submit"]');
    checks.sourceChangePanelPresent = await panel.count() === 1 && await panel.textContent().then(text => text.includes(activeLaunch.sourceChange.previous.sourceSha) && text.includes(activeLaunch.sourceChange.current.sourceSha));
    checks.sourceChangeRequiresAcknowledgement = await start.isDisabled() && await acknowledge.isEnabled() && await acknowledge.textContent() === '我已核對更新的來源';
    checks.sourceChangeCanRecheck = await page.locator('.codex-launch-actions button').first().isEnabled();
    await acknowledge.focus(); await settleScroll(page);
    checks.sourceChangeFocus = await acknowledge.evaluate(element => { const rect = element.getBoundingClientRect(), hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2); return element === document.activeElement && (element === hit || element.contains(hit)); });
    await page.screenshot({ path: path.join(evidence, name + '-source-change.png') });
    await page.keyboard.press('Enter'); await settle(page); checks.sourceChangeWaitsForHost = await start.isDisabled();
    const request = await page.evaluate(() => window.matrixRequests.findLast(item => item.type === 'updateCodexLaunch'));
    checks.sourceChangeSavesInput = request?.patch?.acknowledgedSource === activeLaunch.sourceChange.key && request.patch.requirement === beforeToggle.value && request.patch.repositoryId === activeLaunch.repositoryId;
    await send(page, { type: 'codexLaunchDraft', draft: { ...activeLaunch, revision: activeLaunch.revision + 1, sourceChange: { ...activeLaunch.sourceChange, acknowledged: true } } }); await settle(page);
    checks.sourceChangeAcknowledged = await start.isEnabled() && await acknowledge.textContent() === '已核對更新的來源';
    checks.sourceChangeDoesNotStart = await page.evaluate(() => !window.matrixRequests.some(request => ['startCodexTask', 'submitCodexLaunch'].includes(request.type)));
  }
  await page.locator('.codex-draft-sync[data-state="saved"]').waitFor();
  checks.draftsSaved = await page.locator('.codex-draft-sync[data-state="saved"]').isVisible();
  results.push({ name, state, theme, width, scale, layout, ...geometry, focusPath, keyboard: checks, longDetailScroll, errors: view.errors, external: view.external });
}
async function feedbackMetrics() {
  const measurements = [];
  for (const requestedLayout of ['workspace', 'classic']) {
    const view = await mount('dark', 1280, 1, requestedLayout), { page } = view;
    try {
      const tasks = ['A', 'B'].map(label => ({ ...task, id: `latency-${label}`, title: `Warm task ${label}`, status: 'running', pendingMessages: 0, messageQueue: [] }));
      await send(page, { type: 'codexEvent', event: { kind: 'tasks', tasks } });
      for (const value of tasks) await send(page, { type: 'codexEvent', event: { kind: 'output', taskId: value.id, items: Array.from({ length: 500 }, (_, index) => ({ id: `reply-${index}`, kind: 'agent', text: `Cached reply ${index + 1}\n\n- Preserve source context\n- Review local result`, final: true })) } });
      await settle(page); await page.locator('.codex-draft-sync[data-state="saved"]').waitFor();
      const result = await page.evaluate(async () => {
        const measure = action => new Promise((resolve, reject) => {
          const started = performance.now(), expected = action(); let remaining = 120;
          const check = () => {
            if (expected()) requestAnimationFrame(() => requestAnimationFrame(() => resolve(performance.now() - started)));
            else if (--remaining > 0) requestAnimationFrame(check); else reject(new Error('Local feedback did not render.'));
          }; check();
        });
        const localAction = [], warmTaskSwitch = []; let mountedMax = 0;
        for (let index = 0; index < 36; index++) {
          const duration = await measure(() => { const button = document.querySelector('.codex-details-toggle'), expanded = button.getAttribute('aria-expanded') !== 'true'; button.click(); return () => button.getAttribute('aria-expanded') === String(expanded); });
          if (index >= 6) localAction.push(duration);
        }
        for (let index = 0; index < 36; index++) {
          const title = `Warm task ${index % 2 ? 'A' : 'B'}`;
          const duration = await measure(() => { [...document.querySelectorAll('.codex-tasks > button')].find(button => button.querySelector('strong')?.textContent === title).click(); return () => document.querySelector('.codex-task-heading h2').textContent === title; });
          mountedMax = Math.max(mountedMax, document.querySelectorAll('.codex-transcript [data-virtual-index]').length);
          if (index >= 6) warmTaskSwitch.push(duration);
        }
        return { localAction, warmTaskSwitch, mountedMax, remoteActions: window.matrixRequests.filter(request => ['startCodexTask', 'resumeCodexTask', 'pauseCodexTask', 'submitCodexLaunch', 'sendCodexMessage', 'answerCodexInteraction'].includes(request.type)).length };
      });
      const summarize = (samples, threshold) => { const sorted = [...samples].sort((a, b) => a - b); return { samples, count: samples.length, p50Ms: sorted[Math.ceil(sorted.length / 2) - 1], p95Ms: sorted[Math.ceil(sorted.length * .95) - 1], thresholdMs: threshold, passed: sorted[Math.ceil(sorted.length * .95) - 1] <= threshold }; };
      measurements.push({ layout: requestedLayout, localAction: summarize(result.localAction, 100), warmTaskSwitch: summarize(result.warmTaskSwitch, 200), mountedMax: result.mountedMax, remoteActions: result.remoteActions, errors: view.errors, external: view.external });
    } finally { await page.close(); }
  }
  await writeFile(path.join(evidence, 'local-feedback.json'), JSON.stringify({ createdAt: new Date().toISOString(), scope: 'Synthetic local Host, actual production bundle; 1280x900 dark theme, 500 cached replies per task, 6 warmups then 30 samples. Timings run inside the page from handler invocation through the expected DOM state and two animation frames; includes local render feedback, excludes Playwright transport, native VS Code bridge, network/model latency and OS validation.', assetHashes, measurements }, null, 2));
}
try {
  for (const theme of Object.keys(themes)) for (const [width, scale] of (layout === 'classic' ? [[320, 1], [640, 1], [1280, 1]] : [[320, 1], [640, 1], [1280, 1], [1280, 1.25], [1280, 2]])) for (const state of ['waiting', 'results', 'launch']) {
    const name = `${state}-${theme}-${width}-${Math.round(scale * 100)}`;
    if (process.env.QA_FILTER && !new RegExp(process.env.QA_FILTER).test(name)) continue;
    const view = await mount(theme, width, scale), { page } = view;
    try {
      if (state === 'launch') await send(page, { type: 'codexLaunchDraft', draft: activeLaunch, open: true });
      else if (state === 'waiting') {
        await send(page, { type: 'codexEvent', event: { kind: 'tasks', tasks: [task] } });
        await send(page, { type: 'codexEvent', event: { kind: 'output', taskId: task.id, items: [{ id: 'reply', kind: 'agent', text: '已重現登入過期問題。\n\n- 完成 API 相容性核對\n- 正在調整登入狀態處理\n\n[source](src/auth.ts#L12)', final: true }] } });
        await send(page, { type: 'codexEvent', event: { kind: 'interactions', taskId: task.id, interactions: [{ id: 'question', taskId: task.id, kind: 'questions', title: '確認登入有效期間', questions: [{ id: 'duration', question: '登入狀態需要保存多久？', options: [{ label: '目前工作階段', description: '關閉瀏覽器後重新登入' }, { label: '七天', description: '在信任裝置保留登入' }] }] }] } });
      } else {
        const wikiTask = { ...task, id: 'matrix-wiki', title: '專案 Wiki · 檢閱待發布成果', status: 'completed', origin: { ...origin, kind: 'project-wiki', iid: undefined }, pendingMessages: 0, messageQueue: [],
          controls: { ...task.controls, canPause: false, canResume: true, canDelete: true }, result: { state: 'draft', draftId: 'matrix-draft', summary: '已產生來源導覽與使用說明；請檢閱變更後發布。' } };
        await send(page, { type: 'codexEvent', event: { kind: 'tasks', tasks: [wikiTask] } });
        await send(page, { type: 'codexWorkflowResult', taskId: wikiTask.id, wiki: { id: 'matrix-draft', revision: 'preview-1', projectPath: 'team/service', sourceBranch: 'main', sourceSha: origin.sourceSha,
          progress: { status: 'ready', completed: 2, total: 2 }, pages: [{ slug: 'codebase/overview', title: '專案總覽', action: 'update', published: false, previousContent: '# 專案總覽\n\n原有說明。', content: '# 專案總覽\n\n本次更新涵蓋登入流程與測試。\n\n| 模組 | 職責 |\n|---|---|\n| auth | 登入狀態 |\n| api | API 相容性 |\n\n```ts\nconst authenticated = await refreshSession();\n```' }, { slug: 'codebase/testing', title: '測試說明', action: 'create', published: false, content: '# 測試說明\n\n執行 npm test。' }] } });
      }
      await inspect(view, name, state, theme, width, scale);
    } catch (error) { results.push({ name, state, theme, width, scale, probeError: String(error) }); }
    finally { await page.close(); }
    console.log(name);
  }
  if (process.env.QA_FEEDBACK === '1') await feedbackMetrics();
} finally { await browser.close(); }
const currentHashes = Object.fromEntries(await Promise.all([...assets.keys()].map(async name => [name, createHash('sha256').update(await readFile(path.join(root, 'resources/issue-webview', name))).digest('hex')])));
const findings = results.filter(result => result.probeError || result.horizontalOverflow || result.composerClipped || result.overlap || result.collapsedResults || result.errors?.length || result.csp?.length || result.external?.length || result.focusPath?.some(item => !item.visible || !item.centerVisible || !item.unobscured) || Object.values(result.keyboard ?? {}).some(value => value === false));
const report = { createdAt: new Date().toISOString(), scope: 'Read-only production bundle, synthetic local Host; no model or GitLab calls.', zoomMethod: '1280x900 physical viewport represented by CSS viewport divided by 1.25/2 and matching deviceScaleFactor; this simulates display scaling, not browser UI zoom.', assetHashes, patchSha256: patchCss ? createHash('sha256').update(patchCss).digest('hex') : undefined, assetsUnchangedDuringProbe: JSON.stringify(assetHashes) === JSON.stringify(currentHashes), scenarios: results.length, findingCount: findings.length, findings: findings.map(result => ({ name: result.name, probeError: result.probeError, horizontalOverflow: result.horizontalOverflow, composerClipped: result.composerClipped, overlap: result.overlap, collapsedResults: result.collapsedResults, focusIssues: result.focusPath?.filter(item => !item.visible || !item.centerVisible || !item.unobscured), keyboard: result.keyboard, errors: result.errors, csp: result.csp })), results };
await writeFile(path.join(evidence, 'results.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify({ scenarios: report.scenarios, findings: report.findingCount, assetsUnchangedDuringProbe: report.assetsUnchangedDuringProbe, report: path.join(evidence, 'results.json') }));
