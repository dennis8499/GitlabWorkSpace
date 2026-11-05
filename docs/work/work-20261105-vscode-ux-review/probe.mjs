// Read-only UI audit using production bundles and synthetic data; no GitLab or Codex connection.
// Run after npm.cmd run prepare:validation: node docs/work/work-20261105-vscode-ux-review/probe.mjs
import { readFile, writeFile, mkdir, access } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import ts from 'typescript';
import { chromium } from 'playwright-core';
import { createWebviewCsp } from '../../../out/src/webviewSecurity.js';
import { bmadWorkspaceSnapshot } from '../../../test/fixtures/bmad-ui.mjs';

const directory = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(directory, '../../..');
const evidence = process.env.UX_EVIDENCE_DIR ? path.resolve(root, process.env.UX_EVIDENCE_DIR) : path.join(directory, 'evidence');
await mkdir(evidence, { recursive: true });
const fixtureSource = await readFile(path.join(root, 'test/behavior/dashboard.test.mjs'), 'utf8');
const ast = ts.createSourceFile('dashboard.test.mjs', fixtureSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
const fixtureNames = new Set(['project', 'snapshot', 'gitSnapshot', 'issueDetailData']);
const fixtureFunctions = ast.statements.filter(node => ts.isFunctionDeclaration(node) && fixtureNames.has(node.name?.text)).map(node => node.getText(ast));
if (fixtureFunctions.length !== fixtureNames.size) throw new Error('Expected fixture functions have changed; inspect before updating this probe.');
const { snapshot, gitSnapshot, issueDetailData } = new Function(`const gitHead='a'.repeat(40),gitParent='b'.repeat(40),gitSide='c'.repeat(40); ${fixtureFunctions.join('\n')}; return {snapshot,gitSnapshot,issueDetailData};`)();

let themeRoot = process.env.VSCODE_THEME_ROOT;
if (!themeRoot) {
  for (const candidate of [
    '.vscode-test/vscode-win32-x64-archive-1.145.0/a717861c07/resources/app/extensions/theme-defaults/themes',
    '.vscode-test/vscode-win32-x64-archive-1.90.0/resources/app/extensions/theme-defaults/themes'
  ]) {
    try { await access(path.join(root, candidate, 'light_modern.json')); themeRoot = path.join(root, candidate); break; } catch { /* Try another cached installation. */ }
  }
}
if (!themeRoot) throw new Error('Set VSCODE_THEME_ROOT to an installed theme-defaults/themes directory.');
async function themeColors(filename) {
  const content = await readFile(path.join(themeRoot, filename), 'utf8');
  const parsed = ts.parseConfigFileTextToJson(filename, content);
  if (parsed.error) throw new Error('Invalid theme JSON');
  return { ...(parsed.config.include ? await themeColors(parsed.config.include) : {}), ...parsed.config.colors };
}
const themes = {};
for (const [name, file, bodyClass, light] of [
  ['light', 'light_modern.json', 'vscode-light', true],
  ['dark', 'dark_modern.json', 'vscode-dark', false],
  ['hc-dark', 'hc_black.json', 'vscode-high-contrast', false],
  ['hc-light', 'hc_light.json', 'vscode-high-contrast-light', true]
]) {
  const colors = await themeColors(file);
  // Theme files omit editor defaults. These explicit fallbacks are fixture values,
  // not a claim to reproduce the VS Code theme service or OS high contrast exactly.
  const fallback = {
    foreground: light ? '#3b3b3b' : '#cccccc',
    'editor.background': light ? '#ffffff' : '#1f1f1f',
    'sideBar.background': light ? '#f8f8f8' : '#181818',
    'descriptionForeground': light ? '#616161' : '#9d9d9d',
    'focusBorder': light ? '#005fb8' : '#0078d4',
    'button.background': light ? '#005fb8' : '#0078d4',
    'button.foreground': '#ffffff',
    'button.secondaryBackground': light ? '#e5e5e5' : '#313131',
    'button.secondaryForeground': light ? '#3b3b3b' : '#cccccc',
    'input.background': light ? '#ffffff' : '#313131',
    'input.foreground': light ? '#3b3b3b' : '#cccccc',
    'input.border': light ? '#cecece' : '#3c3c3c',
    'panel.border': light ? '#e5e5e5' : '#2b2b2b',
    'textLink.foreground': light ? '#005fb8' : '#4daafc',
    'errorForeground': light ? '#a1260d' : '#f48771',
    'testing.iconPassed': light ? '#388a34' : '#73c991',
    'list.activeSelectionBackground': light ? '#005fb8' : '#04395e',
    'list.activeSelectionForeground': '#ffffff'
  };
  themes[name] = { bodyClass, css: ':root{' + Object.entries({ ...fallback, ...colors }).map(([key, value]) => `--vscode-${key.replaceAll('.', '-')}:${value};`).join('')
    + '--vscode-font-family:"Segoe UI",sans-serif;--vscode-font-size:13px;--vscode-editor-font-family:Consolas,monospace;}' };
}
const nonce = 'synthetic-audit-nonce';
async function assetResponse(url) {
  try {
    const theme = themes[url.searchParams.get('theme') ?? 'light'];
    if (url.pathname === '/theme.css') {
      return { contentType: 'text/css', body: theme.css };
    }
    const surface = url.pathname.startsWith('/sidebar') ? 'sidebar' : 'dashboard';
    const assetRoot = path.join(root, 'resources', surface === 'sidebar' ? 'sidebar-webview' : 'issue-webview');
    const basename = path.basename(url.pathname);
    if (!/^(?:(dashboard|sidebar)\.(html|js|css)|codicon\.ttf)$/.test(basename)) return { status: 404, body: '' };
    let content = await readFile(path.join(assetRoot, basename));
    if (basename.endsWith('.html')) {
      content = content.toString().replace('<head>', `<head><meta http-equiv="Content-Security-Policy" content="${createWebviewCsp("'self'", nonce, surface)}"><link rel="stylesheet" href="/theme.css?theme=${url.searchParams.get('theme') ?? 'light'}">`)
        .replace('<body>', `<body class="${theme.bodyClass}">`)
        .replace(/<script\b/g, `<script nonce="${nonce}"`);
    }
    return { contentType: basename.endsWith('.ttf') ? 'font/ttf' : basename.endsWith('.js') ? 'application/javascript' : basename.endsWith('.css') ? 'text/css' : 'text/html', body: content };
  } catch { return { status: 500, body: 'Audit asset error' }; }
}
const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROME_PATH ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe' });
const results = [];
const messages = page => page.evaluate(() => window.auditRequests);
const send = (page, message) => page.evaluate(data => window.dispatchEvent(new MessageEvent('message', { data })), message);
const settle = page => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
async function mount({ mode = 'dashboard', theme = 'light', width = 1280, height = 900, scale = 1, sidebar = false, data, initial = {} } = {}) {
  const page = await browser.newPage({ viewport: { width: Math.floor(width / scale), height: Math.floor(height / scale) }, deviceScaleFactor: scale, reducedMotion: 'reduce' });
  const errors = [], csp = [], externalRequests = [];
  page.on('pageerror', error => errors.push(String(error)));
  await page.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.hostname !== '127.0.0.1') { externalRequests.push(url.origin); await route.abort(); }
    else await route.fulfill(await assetResponse(url));
  });
  await page.addInitScript(({ mode, initial }) => {
    let saved = { mode, ...initial };
    window.auditRequests = [];
    window.auditCsp = [];
    window.auditGetSavedState = () => saved;
    window.addEventListener('securitypolicyviolation', event => window.auditCsp.push({ directive: event.violatedDirective, blocked: event.blockedURI }));
    window.acquireVsCodeApi = () => ({
      getState: () => saved,
      setState: next => { saved = next; },
      postMessage: message => { window.auditRequests.push(message); }
    });
  }, { mode, initial });
  await page.goto(`http://127.0.0.1:7777/${sidebar ? 'sidebar' : 'dashboard'}.html?theme=${theme}`);
  await page.waitForFunction(() => window.auditRequests?.some(message => message.type === 'ready'));
  if (sidebar) await send(page, { type: 'state', state: data });
  else await send(page, { type: 'snapshot', snapshot: data ?? snapshot(mode) });
  await page.locator(sidebar ? '.quick-actions' : '.app-shell').waitFor(); await settle(page);
  return { page, errors, csp, externalRequests };
}
async function save(view, name) {
  const { page, errors, externalRequests } = view;
  await page.evaluate(() => document.fonts.ready);
  const geometry = await page.evaluate(() => {
    const visible = element => element.checkVisibility({ visibilityProperty: true }) && !element.closest('[inert]');
    const sizes = ['.topbar', '.workbench', '.page', '.statusbar', '.quick-actions', '.repo-section', '.git-workbench', '.git-shell', '.codex-panel'].map(selector => {
      const node = document.querySelector(selector); if (!node) return null;
      const rect = node.getBoundingClientRect();
      return { selector, x: rect.x, y: rect.y, width: rect.width, height: rect.height, clientWidth: node.clientWidth, scrollWidth: node.scrollWidth };
    }).filter(Boolean);
    return {
      viewport: { width: innerWidth, height: innerHeight }, documentWidth: document.documentElement.scrollWidth,
      sizes,
      clippedControls: [...document.querySelectorAll('button,input,select,textarea,summary')].filter(visible).map(element => {
        const rect = element.getBoundingClientRect();
        return { name: element.getAttribute('aria-label') || element.textContent?.trim().slice(0, 70), x: rect.x, right: rect.right, y: rect.y, bottom: rect.bottom };
      }).filter(rect => rect.x < -1 || rect.right > innerWidth + 1),
      unnamedTabPanels: [...document.querySelectorAll('[role="tabpanel"]')].filter(visible).filter(element => !element.hasAttribute('aria-label') && !element.hasAttribute('aria-labelledby')).length,
      tabsWithoutControlledPanel: [...document.querySelectorAll('[role="tab"]')].filter(visible).filter(element => !document.getElementById(element.getAttribute('aria-controls'))).map(element => element.textContent),
      csp: window.auditCsp
    };
  });
  await page.screenshot({ path: path.join(evidence, `${name}.png`), fullPage: false });
  results.push({ name, ...geometry, errors, externalRequests });
  return geometry;
}
try {
  if (process.env.UX_CODEX_ONLY === '1') {
    const view = await mount();
    const task = { id: 'final-durable-task', title: 'Synthetic draft durability task', root: 'C:/synthetic/repo', status: 'running', createdAt: '2026-11-05T00:00:00Z', updatedAt: '2026-11-05T00:00:00Z' };
    await send(view.page, { type: 'codexEvent', event: { kind: 'tasks', tasks: [] } }); await settle(view.page);
    await send(view.page, { type: 'codexEvent', event: { kind: 'tasks', tasks: [task] } }); await settle(view.page);
    await view.page.locator('#codex-follow-up').waitFor();
    const saved = await view.page.evaluate(() => {
      const input = document.getElementById('codex-follow-up'); input.value = 'Synthetic last keystroke'; input.dispatchEvent(new Event('input', { bubbles: true }));
      const immediate = window.auditGetSavedState().codexUi;
      if (immediate.drafts['final-durable-task']?.text !== input.value) throw new Error('Last keystroke is not synchronously durable');
      document.querySelector('.codex-message').requestSubmit();
      if (!Object.keys(window.auditGetSavedState().codexUi.pending).length) throw new Error('Pending identity is not synchronously durable');
      input.value = 'Synthetic later edit'; input.dispatchEvent(new Event('input', { bubbles: true }));
      return window.auditGetSavedState();
    });
    await save(view, 'codex-final-pending'); await view.page.close();
    const restored = await mount({ initial: saved });
    await send(restored.page, { type: 'codexEvent', event: { kind: 'tasks', tasks: [task] } }); await settle(restored.page);
    if (await restored.page.locator('#codex-follow-up').inputValue() !== 'Synthetic later edit') throw new Error('Rebuilt draft changed');
    await restored.page.locator('.codex-panel > summary').click(); await save(restored, 'codex-final-restored');
    const requests = await messages(restored.page);
    results.at(-1).durability = { immediateInputSaved: true, immediatePendingSaved: true, laterEditRestored: true,
      reconciliationRequested: requests.some(request => request.type === 'reconcileOperations'), automaticallyResent: requests.some(request => request.type === 'sendCodexMessage') };
    await restored.page.close();
  } else if (process.env.UX_DIFF_ONLY === '1') {
    for (const theme of Object.keys(themes)) {
      const view = await mount({ mode: 'git', theme, width: 1280 }); const repo = gitSnapshot();
      await send(view.page, { type: 'gitRepositories', available: true, repositories: [repo], selectedRepositoryId: repo.id, revision: 1 }); await settle(view.page);
      await view.page.waitForFunction(() => window.auditRequests.some(message => message.type === 'gitAction' && message.action.type === 'open'));
      const open = (await messages(view.page)).findLast(message => message.type === 'gitAction' && message.action.type === 'open');
      await send(view.page, { type: 'gitSnapshot', requestId: open.requestId, snapshot: repo });
      await send(view.page, { type: 'gitActionResult', requestId: open.requestId }); await settle(view.page);
      await view.page.locator('.git-change-name').first().click(); await settle(view.page);
      const diff = (await messages(view.page)).findLast(message => message.type === 'gitAction' && message.action.type === 'readDiff');
      await send(view.page, { type: 'gitSnapshot', requestId: diff.requestId, snapshot: { ...repo, revision: 2, diffPath: 'service.ts', diffStaged: false,
        diffText: 'diff --git a/service.ts b/service.ts\n--- a/service.ts\n+++ b/service.ts\n@@ -1 +1 @@\n-old\n+new' } });
      await send(view.page, { type: 'gitActionResult', requestId: diff.requestId }); await settle(view.page);
      await save(view, `diff-contrast-${theme}`);
      results.at(-1).contrast = await view.page.locator('.git-diff-line').evaluateAll(elements => {
        const canvas = document.createElement('canvas'); canvas.width = canvas.height = 1; const context = canvas.getContext('2d');
        const rgba = color => { context.clearRect(0, 0, 1, 1); context.fillStyle = color; context.fillRect(0, 0, 1, 1); return [...context.getImageData(0, 0, 1, 1).data]; };
        const blend = (front, back) => front.slice(0, 3).map((value, index) => value * front[3] / 255 + back[index] * (1 - front[3] / 255));
        const luminance = rgb => rgb.map(value => value / 255).map(value => value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4).reduce((sum, value, index) => sum + value * [.2126, .7152, .0722][index], 0);
        return elements.map(element => {
          const ancestors = []; for (let parent = element; parent; parent = parent.parentElement) ancestors.unshift(parent);
          const background = ancestors.reduce((back, parent) => blend(rgba(getComputedStyle(parent).backgroundColor), back), [255, 255, 255]);
          const foreground = blend(rgba(getComputedStyle(element).color), background), first = luminance(foreground), second = luminance(background);
          return { kind: element.className, text: element.textContent, foreground, background, ratio: (Math.max(first, second) + .05) / (Math.min(first, second) + .05) };
        });
      });
      await view.page.close();
    }
  } else if (process.env.UX_MATRIX_ONLY === '1') {
    const git = async view => {
      const repo = { ...gitSnapshot(), name: '很長的儲存庫名稱 Long repository name', branch: 'feature/長中文分支名稱-with-a-long-English-branch', path: 'C:/長路徑/very-long-folder/another-folder/project' };
      await send(view.page, { type: 'gitRepositories', available: true, repositories: [repo], selectedRepositoryId: repo.id, revision: 1 }); await settle(view.page);
      await view.page.waitForFunction(() => window.auditRequests.some(message => message.type === 'gitAction' && message.action.type === 'open'));
      const open = (await messages(view.page)).findLast(message => message.type === 'gitAction' && message.action.type === 'open');
      await send(view.page, { type: 'gitSnapshot', requestId: open.requestId, snapshot: repo });
      await send(view.page, { type: 'gitActionResult', requestId: open.requestId }); await settle(view.page);
    };
    for (const mode of (process.env.UX_MATRIX_MODES ?? 'dashboard,clone,developer,reviewer,sa,bmad,git').split(',')) for (const width of [480, 640, 960, 1280]) {
      const data = mode === 'bmad' ? bmadWorkspaceSnapshot() : snapshot(mode);
      if (mode === 'reviewer') {
        const request = { id: 41, iid: 4, project_id: 1, title: '長中文與英文 Merge Request title for narrow layout', state: 'opened', source_branch: 'feature/long-branch', target_branch: 'main', diff_refs: { head_sha: 'a'.repeat(40) } };
        data.mergeRequests = [request]; data.selectedMergeRequest = { request, diffs: [], discussions: [], sections: { diffs: { status: 'ready' }, discussions: { status: 'ready' } }, freshness: { state: 'not_checked' }, sourceSha: 'a'.repeat(40), mergeAvailability: { status: 'unknown', reason: 'Synthetic fixture' } };
      }
      const view = await mount({ mode, width, data });
      if (mode === 'git') { await git(view); await view.page.locator('.git-toolbar .git-actions-menu > summary').click(); }
      await save(view, `matrix-${mode}-${width}`);
      if (mode === 'git') {
        await view.page.keyboard.press('ArrowDown');
        const focusedMenuItem = await view.page.evaluate(() => document.activeElement?.getAttribute('role') === 'menuitem');
        await view.page.keyboard.press('Escape');
        results.at(-1).menuKeyboard = { focusedMenuItem, restoredSummary: await view.page.locator('.git-toolbar .git-actions-menu > summary').evaluate(element => document.activeElement === element), closed: await view.page.locator('.git-toolbar .git-actions-menu').evaluate(element => !element.open) };
      }
      await view.page.close();
    }
    // Equivalent effective viewport and device scale, not an actual VS Code zoom test.
    for (const theme of process.env.UX_MATRIX_MODES ? [] : Object.keys(themes)) for (const scale of [1.25, 2]) {
      const view = await mount({ mode: 'git', theme, width: 960, height: 900, scale }); await git(view);
      await view.page.locator('.git-toolbar .git-actions-menu > summary').click();
      await save(view, `matrix-git-${theme}-${scale}`); results.at(-1).simulatedScale = scale;
      await view.page.close();
    }
    if (!process.env.UX_MATRIX_MODES) {
    const view = await mount({ mode: 'git', width: 640 }); await git(view);
    const before = await view.page.locator('.git-commit-summary strong').first().evaluate(element => parseFloat(getComputedStyle(element).fontSize));
    await view.page.evaluate(() => document.styleSheets[0].insertRule(':root { --vscode-font-size: 20px; }', document.styleSheets[0].cssRules.length));
    const after = await view.page.locator('.git-commit-summary strong').first().evaluate(element => parseFloat(getComputedStyle(element).fontSize));
    await save(view, 'matrix-git-font-setting'); results.at(-1).fontSetting = { before, after, followsSetting: after > before };
    await view.page.close();
    }
  } else {
  for (const theme of Object.keys(themes)) {
    const view = await mount({ theme }); await save(view, `dashboard-${theme}`); await view.page.close();
  }
  for (const mode of ['clone', 'sa', 'bmad']) {
    const data = mode === 'bmad' ? bmadWorkspaceSnapshot() : snapshot(mode);
    const view = await mount({ mode, data }); await save(view, `${mode}-overview`); await view.page.close();
  }
  const localData = snapshot('clone');
  Object.assign(localData, { connected: false, currentUser: undefined, group: undefined, groups: [], accounts: [], connectedScope: undefined, instanceUserScope: undefined,
    localWorkspaceRepositories: [{ path: 'C:/workspace/service', name: 'service', repositoryId: 'repo-a', remotes: [] }] });
  const localView = await mount({ mode: 'clone', data: localData, initial: { projectSource: 'local' } }); await save(localView, 'local-projects-offline'); await localView.page.close();
  for (const width of process.env.UX_SKIP_LEGACY_SIDEBAR === '1' ? [] : [240, 320]) {
    const repo = gitSnapshot();
    const view = await mount({ sidebar: true, width, height: 700, data: { connected: false, accounts: [], activeMode: 'git', gitAvailable: true,
      repositories: [repo, { ...repo, id: 'repo-b', name: '另一個很長名稱的工作區專案', path: 'C:/workspace/another-very-long-repository-name', branch: 'feature/long-branch-name' }] } });
    await save(view, `sidebar-${width}`);
    results.at(-1).keyboard = [];
    for (let index = 0; index < 17; index++) { await view.page.keyboard.press('Tab'); results.at(-1).keyboard.push(await view.page.evaluate(() => document.activeElement?.getAttribute('aria-label') || document.activeElement?.textContent?.trim().slice(0, 90))); }
    await view.page.close();
  }
  for (const theme of ['light', 'hc-dark', 'hc-light']) {
    const view = await mount({ mode: 'git', theme });
    const repo = gitSnapshot();
    await send(view.page, { type: 'gitRepositories', available: true, repositories: [repo], selectedRepositoryId: repo.id, revision: 1 }); await settle(view.page);
    await view.page.waitForFunction(() => window.auditRequests.some(message => message.type === 'gitAction' && message.action.type === 'open'));
    const open = (await messages(view.page)).findLast(message => message.type === 'gitAction' && message.action.type === 'open');
    await send(view.page, { type: 'gitSnapshot', requestId: open.requestId, snapshot: repo });
    await send(view.page, { type: 'gitActionResult', requestId: open.requestId }); await settle(view.page);
    await save(view, `git-${theme}`);
    results.at(-1).theme = await view.page.locator('.git-workbench').getAttribute('data-theme');
    results.at(-1).typography = await view.page.evaluate(() => [...document.querySelectorAll('.git-panel-eyebrow,.git-nav-group > summary,.git-commit-summary strong,.git-commit-author,.git-commit-row')].map(element => ({ text: element.textContent?.trim().slice(0, 60), fontSize: getComputedStyle(element).fontSize, color: getComputedStyle(element).color })));
    if (theme === 'light') {
      await view.page.setViewportSize({ width: 640, height: 700 }); await save(view, 'git-narrow-640');
      await view.page.locator('.account-menu > summary').click(); await save(view, 'account-menu-narrow-640');
      await view.page.locator('.account-menu > summary').click();
      await view.page.locator('.git-actions-menu > summary').click(); await save(view, 'git-menu-narrow-640');
      await view.page.locator('.git-actions-menu > summary').click();
      await view.page.setViewportSize({ width: 1280, height: 900 });
      await view.page.locator('.git-change-name').first().click(); await settle(view.page);
      const diff = (await messages(view.page)).findLast(message => message.type === 'gitAction' && message.action.type === 'readDiff');
      if (!diff) throw new Error('Expected readDiff request');
      await send(view.page, { type: 'gitSnapshot', requestId: diff.requestId, snapshot: { ...repo, revision: 2, diffPath: 'service.ts', diffStaged: false,
        diffText: 'diff --git a/service.ts b/service.ts\n--- a/service.ts\n+++ b/service.ts\n@@ -1 +1 @@\n-old\n+new' } });
      await send(view.page, { type: 'gitActionResult', requestId: diff.requestId }); await settle(view.page);
      await save(view, 'git-diff-light');
      results.at(-1).hunkColors = await view.page.locator('.git-diff-line.hunk').evaluate(element => ({ foreground: getComputedStyle(element).color, background: getComputedStyle(element).backgroundColor }));
    }
    await view.page.close();
  }
  const mrData = snapshot('reviewer');
  const request = { id: 41, iid: 4, project_id: 1, title: 'Synthetic MR for UX review', state: 'opened', source_branch: 'feature', target_branch: 'main', diff_refs: { head_sha: 'a'.repeat(40) } };
  mrData.mergeRequests = [request]; mrData.selectedMergeRequest = { request, diffs: [], discussions: [], sections: { diffs: { status: 'ready' }, discussions: { status: 'ready' } }, freshness: { state: 'not_checked' }, sourceSha: 'a'.repeat(40), mergeAvailability: { status: 'unknown', reason: 'Synthetic fixture: permission unverified' } };
  const mrView = await mount({ mode: 'reviewer', data: mrData }); await save(mrView, 'mr-tabs');
  await mrView.page.close();
  const issueData = snapshot('developer');
  const issueView = await mount({ mode: 'developer', data: issueData });
  await send(issueView.page, { type: 'issueNavigation', navigation: { mode: 'detail', projectId: 1, issueIid: 1, revision: 1 } }); await settle(issueView.page);
  await send(issueView.page, { type: 'issueResponse', revision: 1, response: { type: 'detailData', data: issueDetailData(issueData.issues[0], issueData.projects[0]) } }); await settle(issueView.page);
  await save(issueView, 'issue-detail-permissions'); await issueView.page.close();

  const view = await mount(); const { page } = view;
  const task = id => ({ id, title: `Synthetic task ${id}`, root: `C:/workspace/repo-${id}`, status: 'running', createdAt: '2026-11-04T00:00:00Z', updatedAt: '2026-11-04T00:00:00Z' });
  await send(page, { type: 'codexEvent', event: { kind: 'tasks', tasks: [] } }); await settle(page);
  await send(page, { type: 'codexEvent', event: { kind: 'tasks', tasks: [task('a'), task('b')] } }); await settle(page);
  await page.locator('#codex-follow-up').fill('Draft that should survive a task switch');
  await page.getByRole('button', { name: /Synthetic task b/ }).click(); await settle(page);
  await page.getByRole('button', { name: /Synthetic task a/ }).click(); await settle(page);
  const draftAfterSwitch = await page.locator('#codex-follow-up').inputValue();
  await page.locator('#codex-follow-up').fill('Draft while host response is pending');
  await page.locator('.codex-message button').click(); await settle(page);
  const draftAfterUnacknowledgedSend = await page.locator('#codex-follow-up').inputValue();
  const followupRequests = (await messages(page)).filter(message => message.type === 'sendCodexMessage');
  await page.locator('#codex-follow-up').fill('Second draft while previous operation is pending');
  await page.locator('.codex-message button').click(); await settle(page);
  const draftAfterBlockedSend = await page.locator('#codex-follow-up').inputValue();
  const followupCountAfterBlockedSend = (await messages(page)).filter(message => message.type === 'sendCodexMessage').length;
  await send(page, { type: 'codexEvent', event: { kind: 'output', taskId: 'a', replace: true, items: [{ id: 'm1', kind: 'agent', text: 'Synthetic complete reply' }] } });
  await send(page, { type: 'codexEvent', event: { kind: 'interactions', taskId: 'a', interactions: [{ id: 'approval-a', taskId: 'a', kind: 'command', title: 'Run synthetic command', detail: 'git status --short' }] } }); await settle(page);
  const codex = await page.evaluate(() => ({
    liveRegions: [...document.querySelectorAll('.codex-panel [aria-live],.codex-panel [role="status"],.codex-panel [role="log"],.codex-panel [role="alert"]')].map(element => ({ role: element.getAttribute('role'), live: element.getAttribute('aria-live'), text: element.textContent })),
    focus: { tag: document.activeElement?.tagName, name: document.activeElement?.textContent?.trim().slice(0, 90) },
    interaction: document.querySelector('.codex-interaction')?.textContent,
    draftAfterSwitch: document.querySelector('#codex-follow-up')?.value
  }));
  await save(view, 'codex-interaction');
  results.push({ name: 'codex-drafts-and-announcements', draftAfterSwitch, draftAfterUnacknowledgedSend, draftAfterBlockedSend, sentCount: followupRequests.length, followupCountAfterBlockedSend, ...codex });
  await page.locator('.settings-trigger').click(); await page.getByRole('dialog').waitFor(); await settle(page);
  const modalInitialFocus = await page.evaluate(() => document.activeElement?.textContent);
  await page.keyboard.press('Shift+Tab'); await settle(page);
  const modalWrappedFocus = await page.evaluate(() => ({ name: document.activeElement?.textContent, withinDialog: !!document.activeElement?.closest('[role="dialog"]') }));
  await page.keyboard.press('Escape'); await settle(page);
  results.push({ name: 'settings-focus', modalInitialFocus, modalWrappedFocus, returnedToTrigger: await page.locator('.settings-trigger').evaluate(node => document.activeElement === node) });
  await page.close();
  const graphData = snapshot('developer');
  const nodes = graphData.issues.map(issue => ({ id: `project:${issue.project_id}:issue:${issue.iid}`, sourceIds: [], kind: 'issue', projectId: issue.project_id,
    namespacePath: `team/${issue.project_id === 1 ? 'alpha' : 'beta'}`, iid: String(issue.iid), title: issue.title, state: issue.state, labels: [], assignees: [], boardIds: [], assignedToMe: true, isRoot: true, relationsStatus: 'ready' }));
  graphData.issueGraph = { connectedScope: 'team-scope', status: 'ready', roots: nodes.map(node => node.id), nodes, edges: [], boardIssueIds: {}, boardStatus: {}, errors: [], updatedAt: Date.now() }; graphData.issueGraphVersion = 1;
  const graphView = await mount({ mode: 'developer', data: graphData, initial: { scopeKey: 'team-scope', developerView: 'graph', graphAnimationEnabled: false } });
  await graphView.page.locator('.graph-node').first().waitFor(); await save(graphView, 'issue-graph');
  const session = await graphView.page.context().newCDPSession(graphView.page); const tree = await session.send('Accessibility.getFullAXTree');
  results.push({ name: 'graph-accessibility-tree', domNodeButtons: await graphView.page.locator('.graph-node[role="button"]').count(),
    exposedNodeButtons: tree.nodes.filter(node => !node.ignored && node.role?.value === 'button' && /符合篩選的主要 Issue|關聯工作/.test(node.name?.value ?? '')).map(node => ({ role: node.role.value, name: node.name.value })),
    imageRoles: tree.nodes.filter(node => !node.ignored && /image|img/.test(node.role?.value ?? '')).map(node => ({ role: node.role.value, name: node.name?.value })) });
  await graphView.page.close();
  }
} finally {
  const bundle = await readFile(path.join(root, 'resources/issue-webview/dashboard.js'));
  await writeFile(path.join(evidence, 'probe-results.json'), JSON.stringify({ schema: 'GitLabWorkspaceUxReview/v1', checkedAt: new Date().toISOString(), commit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
    browser: browser.version(), dashboardBundleSha256: createHash('sha256').update(bundle).digest('hex'), themeRoot: path.relative(root, themeRoot),
    limitations: ['Synthetic Host messages; no real GitLab or Codex connection', 'Theme JSON plus documented fixture fallbacks; not the VS Code theme service', 'Viewport resizing is not actual 200% VS Code zoom', 'Chromium accessibility tree is not an NVDA test'], results }, null, 2) + '\n');
  await browser.close();
}
console.log(`Saved ${results.length} probe results to ${path.relative(root, evidence)}`);
