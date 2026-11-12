// Isolated Chromium source matrix. Vite writes no assets; all host responses are fixtures.
import { readFile, writeFile, mkdir, access } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import ts from 'typescript';
import { chromium } from 'playwright-core';
import { build } from 'vite';
import { bmadWorkspaceSnapshot, bmadEnvironmentSnapshot } from '../../../test/fixtures/bmad-ui.mjs';
import { createWebviewCsp } from '../../../out/src/webviewSecurity.js';

const directory = path.dirname(fileURLToPath(import.meta.url)), root = path.resolve(directory, '../../..');
const evidence = path.join(directory, 'evidence', 'ui-matrix');
await mkdir(evidence, { recursive: true });
const built = await build({ configFile: path.join(root, 'vite.dashboard.config.mjs'), logLevel: 'silent', build: { write: false, emptyOutDir: false } });
const assets = new Map(built.output.map(item => [item.fileName, Buffer.from(item.type === 'chunk' ? item.code : item.source)]));
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

const draft = { schema: 'GitLabWorkspaceCodexLaunch/v1', id: 'matrix-launch', revision: 1, scope: 'matrix-scope', state: 'ready',
  source: { kind: 'issue', projectId: 1, issueIid: 42 }, title: 'Issue #42 · 修正登入與工作階段', requirement: '保留現有 API 與操作方式，補齊登入過期和登出測試。',
  repositoryId: 'repo', repositories: [{ id: 'repo', name: 'service', path: 'C:/團隊專案/登入與訂單服務' }],
  models: [{ id: 'fixture-model', label: 'Fixture model', efforts: ['medium', 'high'], defaultEffort: 'high' }], model: 'fixture-model', effort: 'high', isolated: true,
  branch: 'issue/42-login', sourceSha: 'a'.repeat(40), workingDirectory: 'C:/工作區/runtime/issue-42/worktree', updatedAt: '2026-11-12T12:00:00Z',
  checks: [['source', '來源與權限'], ['repository', '本機 Repo'], ['workflow', 'WorkflowKit'], ['codex', 'Codex 環境'], ['selection', '執行設定']].map(([id, label]) => ({ id, label, state: 'ready' })) };
const send = (page, data) => page.evaluate(data => window.dispatchEvent(new MessageEvent('message', { data })), data);
const settle = page => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
const fixtures = () => {
  const value = snapshot('dashboard'), bmad = bmadWorkspaceSnapshot('C:/團隊專案/登入與訂單服務');
  const installed = { status: 'installed', version: '1.5.0', integrity: 'verified', interfaceCompatibility: 'compatible', workspaceContract: 2, installerApi: 1,
    capabilities: ['query', 'merge-repo', 'release-repo', 'bmad-workflow'], bmadMode: 'bundled' };
  return { ...value, bmad: bmad.bmad, bmadEnvironment: bmadEnvironmentSnapshot(bmad.groupRoot), workflowKit: installed,
    workflowKitInstallTarget: { ...bmad.workflowKitInstallTarget, state: installed }, workflowKitSource: 'github',
    projectContext: { root: bmad.groupRoot, folders: [{ uri: 'file:///fixture', name: '登入與訂單服務', path: bmad.groupRoot }], selectedFolderUri: 'file:///fixture' },
    skillsContext: { mode: 'repository', root: bmad.groupRoot, revision: 'matrix-skills', availableFeatures: installed.capabilities, installed,
      repositories: [{ name: '登入與訂單服務', path: bmad.groupRoot }], reviewerRepositories: [{ name: '登入與訂單服務', path: bmad.groupRoot }], groupMatch: { status: 'unverified', repositories: [] } } };
};
const browser = await chromium.launch({ headless: true, ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : { channel: 'chrome' }) });
const results = [];
let latency;
async function mount(themeName, width, height, scale) {
  const theme = themes[themeName], context = await browser.newContext({ viewport: { width: Math.floor(width / scale), height: Math.floor(height / scale) }, deviceScaleFactor: scale, reducedMotion: 'reduce' });
  const page = await context.newPage(), errors = [], external = [];
  page.on('pageerror', error => errors.push(String(error)));
  await page.route('**/*', async route => {
    const url = new URL(route.request().url()), name = url.pathname.slice(1);
    if (url.hostname !== '127.0.0.1') { external.push(url.origin); return route.abort(); }
    let body = name === 'theme.css' ? theme.css : assets.get(name);
    if (body === undefined) return route.fulfill({ status: 404, body: '' });
    if (name === 'dashboard.html') body = body.toString().replace('<head>', `<head><meta http-equiv="Content-Security-Policy" content="${createWebviewCsp("'self'", 'native-ux-matrix', 'dashboard')}"><link rel="stylesheet" href="/theme.css">`).replace('<body>', `<body class="${theme.bodyClass}">`).replace(/<script\b/g, '<script nonce="native-ux-matrix"');
    await route.fulfill({ body, contentType: name.endsWith('.js') ? 'application/javascript' : name.endsWith('.css') ? 'text/css' : name.endsWith('.ttf') ? 'font/ttf' : name.endsWith('.json') ? 'application/json' : 'text/html' });
  });
  await page.addInitScript(initial => {
    let state = { mode: 'dashboard' }; const entries = new Map();
    window.matrixRequests = []; window.matrixCsp = [];
    window.addEventListener('securitypolicyviolation', event => window.matrixCsp.push(event.violatedDirective));
    const respond = data => queueMicrotask(() => window.dispatchEvent(new MessageEvent('message', { data })));
    window.acquireVsCodeApi = () => ({ getState: () => state, setState: next => { state = next; }, postMessage: message => {
      window.matrixRequests.push(message);
      if (message.type === 'ready') respond({ type: 'snapshot', snapshot: initial });
      if (message.type === 'loadCodexUiDrafts' || message.type === 'saveCodexUiDrafts') {
        for (const item of message.updates ?? []) entries.set(item.key, { ...item, revision: (entries.get(item.key)?.revision ?? 0) + 1 });
        respond({ type: 'codexUiDrafts', requestId: message.requestId, snapshot: { scope: 'matrix-host', entries: [...entries.values()], conflicts: [] } });
      }
      if (message.operationId) respond({ type: 'operationChanged', operation: { requestId: message.operationId, scopeRevision: message.operationScope,
        action: message.type, resourceKey: 'matrix', label: 'Fixture receipt', status: 'succeeded', effect: 'none', phase: 'Done', startedAt: Date.now() } });
    } });
  }, fixtures());
  await page.goto('http://127.0.0.1:7879/dashboard.html'); await page.locator('.home-dashboard').waitFor();
  return { page, context, errors, external };
}
async function inspect(view, key, scene, targetSelector) {
  const { page } = view;
  await settle(page); await page.evaluate(() => document.fonts.ready);
  if (scene !== 'tools') await page.evaluate(() => { for (const node of document.querySelectorAll('*')) if (node.scrollTop || node.scrollLeft) node.scrollTo(0, 0); window.scrollTo(0, 0); });
  const geometry = await page.evaluate(() => {
    const visible = node => node.checkVisibility() && node.getBoundingClientRect().width > 0;
    const containers = ['.topbar', '.workspace-navigation', '.page', '.tool-drawer', '.notification-drawer', '.codex-launch', '.skills-guide', '.bmad-panel'];
    return { viewport: { width: innerWidth, height: innerHeight }, documentOverflow: Math.max(0, document.documentElement.scrollWidth - innerWidth),
      containers: containers.flatMap(selector => [...document.querySelectorAll(selector)].filter(visible).map(node => ({ selector, overflow: Math.max(0, node.scrollWidth - node.clientWidth), width: node.clientWidth, height: node.clientHeight }))),
      dialogModal: document.querySelector('dialog')?.matches(':modal'), focused: document.activeElement?.textContent.slice(0, 80) };
  });
  await page.screenshot({ path: path.join(evidence, key + '-' + scene + '.png') });
  let action;
  if (targetSelector) {
    const target = page.locator(targetSelector).first();
    if (await target.count()) {
      if (!await target.isEnabled()) throw new Error(`Fixture action is disabled: ${key}/${scene}`);
      await target.focus(); await settle(page);
      action = await target.evaluate(node => {
        const r = node.getBoundingClientRect(), hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2), style = getComputedStyle(node);
        return { focused: document.activeElement === node, reachable: r.top >= -1 && r.bottom <= innerHeight + 1 && r.left >= -1 && r.right <= innerWidth + 1 && !!hit && (node === hit || node.contains(hit)),
          rect: { x: r.x, y: r.y, width: r.width, height: r.height }, outline: [style.outlineStyle, style.outlineWidth, style.outlineColor], text: node.textContent.slice(0, 100) };
      });
      if (!action.reachable || key.endsWith('-short') || key.endsWith('-narrow')) await page.screenshot({ path: path.join(evidence, key + '-' + scene + '-action.png') });
    }
  }
  const csp = await page.evaluate(() => window.matrixCsp);
  const result = { key, scene, ...geometry, action, errors: [...view.errors], external: [...view.external], csp };
  results.push(result);
  if (geometry.documentOverflow > 1 || geometry.containers.some(item => item.overflow > 1) || action && !action.reachable || view.errors.length || view.external.length || csp.length) console.log(JSON.stringify({ warning: result }));
}
async function measureWarmLatency() {
  const view = await mount('dark', 1280, 900, 1), { page } = view;
  const modes = ['dashboard', 'developer', 'reviewer', 'sa', 'codex'];
  const samples = { navigation: [], taskSelection: [] };
  try {
    for (const mode of [...modes, ...modes]) {
      await page.locator(`.mode-navigation [data-mode="${mode}"]`).click();
      await page.locator(`.page[data-mode="${mode}"]`).waitFor();
      if (mode === 'sa') await page.locator('.skills-guide').waitFor();
      if (mode === 'codex') await page.locator('.codex-workspace').waitFor();
      await settle(page);
    }
    for (let index = 0; index < 40; index++) {
      const mode = modes[index % modes.length];
      samples.navigation.push(await page.evaluate(async mode => {
        const start = performance.now();
        document.querySelector(`.mode-navigation [data-mode="${mode}"]`).click();
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        if (document.querySelector('.page')?.dataset.mode !== mode) throw new Error('Warm navigation did not commit within two frames');
        return { mode, ms: performance.now() - start };
      }, mode));
    }
    const tasks = ['a', 'b'].map(id => ({ id, title: `Warm task ${id}`, root: 'C:/fixture/repo', status: 'completed',
      createdAt: '2026-11-12T12:00:00Z', updatedAt: '2026-11-12T12:00:00Z',
      controls: { external: false, canPause: false, canResume: true, canDelete: true, canAutoAccept: false, autoAccept: false } }));
    await send(page, { type: 'codexEvent', event: { kind: 'tasks', tasks } });
    await page.locator('.codex-tasks button').filter({ hasText: 'Warm task a' }).waitFor();
    for (const task of tasks) await send(page, { type: 'codexEvent', event: { kind: 'history', taskId: task.id, reset: true,
      items: Array.from({ length: 500 }, (_, index) => ({ id: `${task.id}-${index}`, kind: 'agent', text: `Cached output ${index}. Review source, preserve changes, and verify results.`, final: true })) } });
    for (const id of ['b', 'a']) { await page.locator('.codex-tasks button').filter({ hasText: `Warm task ${id}` }).click(); await settle(page); }
    for (let index = 0; index < 40; index++) {
      const id = index % 2 === 0 ? 'b' : 'a';
      samples.taskSelection.push(await page.evaluate(async id => {
        const start = performance.now();
        [...document.querySelectorAll('.codex-tasks button')].find(node => node.querySelector('strong')?.textContent === `Warm task ${id}`).click();
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        if (document.querySelector('.codex-task-heading h2')?.textContent !== `Warm task ${id}`) throw new Error('Task selection did not commit within two frames');
        return { task: id, ms: performance.now() - start };
      }, id));
    }
    const summary = Object.fromEntries(Object.entries(samples).map(([kind, rows]) => {
      const sorted = rows.map(item => item.ms).sort((a, b) => a - b), p95 = sorted[Math.ceil(sorted.length * .95) - 1];
      return [kind, { count: sorted.length, medianMs: sorted[Math.floor(sorted.length / 2)], p95Ms: p95, maxMs: sorted.at(-1), cachedUiWithin100ms: p95 <= 100 }];
    }));
    const requests = await page.evaluate(() => window.matrixRequests.map(item => item.type));
    return { method: 'Real navigation/task button click to two animation frames; chunks preloaded; cached fixtures; 500 transcript items per task; no GitLab/Codex network',
      summary, samples, requests: [...new Set(requests)], errors: view.errors, external: view.external, csp: await page.evaluate(() => window.matrixCsp) };
  } finally { await view.context.close(); }
}
try {
  if (process.env.QA_HEADERS) {
    const definition = ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'issueDetailData');
    if (!definition) throw new Error('Issue detail fixture changed');
    const issueDetailData = new Function(definition.getText(ast) + '; return issueDetailData;')();
    for (const theme of Object.keys(themes)) {
      const view = await mount(theme, 320, 520, 1), { page } = view, key = `${theme}-320-header`;
      try {
        const data = fixtures();
        data.localWorkspaceRepositories = [{ name: '登入與訂單服務', path: 'C:/團隊專案/登入與訂單服務', repositoryId: 'local-repo', projectIds: [1] }];
        await send(page, { type: 'snapshot', snapshot: data });
        await send(page, { type: 'hostNavigation', generation: 1, values: { mode: 'clone', projectSource: 'local' } });
        await page.locator('.local-repositories-panel').waitFor();
        await inspect(view, key, 'repositories', '.repository-scan-trigger');
        await send(page, { type: 'hostNavigation', generation: 2, values: { mode: 'developer' } });
        await send(page, { type: 'issueNavigation', navigation: { mode: 'detail', projectId: 1, issueIid: 1, revision: 1 } });
        await settle(page);
        await send(page, { type: 'issueResponse', revision: 1, response: { type: 'detailData', data: issueDetailData({ ...data.issues[0], title: '登入與訂單服務的工作階段過期處理及使用流程驗證' }, data.projects[0]) } });
        await page.locator('.issue-topbar h1').waitFor();
        await inspect(view, key, 'issue', '.issue-heading-actions button');
      } finally { await view.context.close(); }
    }
  } else {
  for (const theme of Object.keys(themes)) for (const scale of [1, 1.25, 2]) for (const [size, width, height] of [['desktop', 1280, 900], ['narrow', 640, 900], ['short', 1280, 520]]) {
    if (process.env.QA_FILTER && !`${theme}-${scale}-${size}`.includes(process.env.QA_FILTER)) continue;
    const view = await mount(theme, width, height, scale), { page } = view, key = `${theme}-${Math.round(scale * 100)}-${size}`;
    let generation = 0;
    const navigate = async (mode, selector) => { await send(page, { type: 'hostNavigation', generation: ++generation, values: { mode } }); await page.locator(selector).waitFor(); };
    try {
      await inspect(view, key, 'dashboard', '.native-mode-picker:visible, .mode-navigation button');
      await navigate('sa', '.skills-guide');
      await page.locator('[id="wiki-input-query.question"]').fill('說明登入與工作階段管理，列出重要入口與相關測試。');
      await inspect(view, key, 'skills', '.skills-action-bar > button.primary');
      await navigate('bmad', '.bmad-panel'); await page.locator('#bmad-tab-start').click();
      await page.locator('#bmad-requirement').fill('修正登入過期後的操作流程，補齊測試並保留既有 API。');
      await inspect(view, key, 'bmad', '.bmad-prompt-form button.primary');
      await navigate('codex', '.codex-workspace'); await send(page, { type: 'codexLaunchDraft', draft, open: true });
      await page.locator('#codex-launch-requirement').waitFor(); await inspect(view, key, 'launch', '.codex-launch-actions button[type="submit"]');
      await send(page, { type: 'openSettings', focusSection: 'workflowkit', draftId: draft.id }); await page.locator('dialog.native-dialog').waitFor();
      await settle(page);
      const focusedSection = await page.evaluate(() => document.activeElement?.getAttribute('data-settings-section'));
      if (focusedSection !== 'workflowkit') throw new Error(`Settings did not focus the requested section: ${key}: ${focusedSection}`);
      await inspect(view, key, 'tools', '[data-settings-section="workflowkit"]');
      await page.locator('.tool-drawer > .button-row > button').focus(); await settle(page);
      await page.screenshot({ path: path.join(evidence, key + '-tools-return.png') });
      await page.keyboard.press('Escape'); await page.locator('dialog.native-dialog').waitFor({ state: 'detached' });
      await send(page, { type: 'notificationsChanged', snapshot: { sessionId: 'matrix-notices', revision: 1, unreadCount: 1, items: [{ id: 'notice-1', title: '環境需要處理', level: 'warn', messages: ['請檢查 WorkflowKit 環境，完成後返回原任務繼續準備。'], createdAt: Date.now(), updatedAt: Date.now(), contentRevision: 1, read: false }] } });
      await send(page, { type: 'openNotifications' }); await page.locator('.notification-drawer').waitFor();
      await inspect(view, key, 'notifications', '.notification-drawer button');
      console.log(JSON.stringify({ completed: key, cases: results.length }));
    } finally { await view.context.close(); }
  }
  latency = await measureWarmLatency();
  console.log(JSON.stringify({ latency: latency.summary }));
  }
} finally {
  await browser.close();
  const failures = results.filter(item => item.documentOverflow > 1 || item.containers.some(node => node.overflow > 1) || item.action && !item.action.reachable || item.errors.length || item.external.length || item.csp.length);
  const resultFile = process.env.QA_HEADERS ? 'headers-320.json' : process.env.QA_FILTER ? `results-${process.env.QA_FILTER.replace(/[^a-z0-9-]/gi, '_')}.json` : 'results.json';
  await writeFile(path.join(evidence, resultFile), JSON.stringify({ generatedAt: new Date().toISOString(), sourceMode: true, zoomMethod: 'effective viewport / scale + deviceScaleFactor; not native Electron zoom', assetHashes, cases: results.length, failures: failures.length, latency, results }, null, 2));
  console.log(JSON.stringify({ total: results.length, failures: failures.length }));
}
