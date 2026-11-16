/* global window, document, requestAnimationFrame, getComputedStyle, innerHeight, innerWidth */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { chromium } from 'playwright-core';
import { createWebviewCsp } from '../../out/src/webviewSecurity.js';
import { readWebviewAssets } from '../../scripts/webview-assets.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const theme = ':root{--vscode-foreground:#333;--vscode-editor-background:#fff;--vscode-sideBar-background:#f3f3f3;--vscode-descriptionForeground:#616161;--vscode-focusBorder:#0078d4;--vscode-button-background:#0078d4;--vscode-button-foreground:#fff;--vscode-input-background:#fff;--vscode-input-foreground:#333;--vscode-panel-border:#ccc;--vscode-font-family:Segoe UI,sans-serif;--vscode-font-size:13px;}';
const send = (page, data) => page.evaluate(data => window.dispatchEvent(new MessageEvent('message', { data })), data);
const settle = page => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));

async function focusedGeometry(page, selector) {
  return page.locator(selector).evaluate(async node => {
    node.scrollIntoView({ behavior: 'instant', block: 'center', inline: 'nearest' }); node.focus({ preventScroll: true });
    let previous, stable = 0;
    for (let frame = 0; stable < 5 && frame < 120; frame++) {
      await new Promise(resolve => requestAnimationFrame(resolve));
      const rect = node.getBoundingClientRect(), offsets = [];
      for (let parent = node.parentElement; parent; parent = parent.parentElement) offsets.push(parent.scrollTop, parent.scrollLeft);
      const signature = JSON.stringify([rect.x, rect.y, rect.width, rect.height, ...offsets]);
      stable = signature === previous ? stable + 1 : 0; previous = signature;
    }
    const rect = node.getBoundingClientRect(), hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
    const style = getComputedStyle(node), ancestors = [], owners = [];
    for (let parent = node.parentElement; parent; parent = parent.parentElement) {
      const bounds = parent.getBoundingClientRect();
      if (ancestors.length < 8) ancestors.push({ className: parent.className, y: bounds.y, height: bounds.height, top: parent.scrollTop, client: parent.clientHeight, scroll: parent.scrollHeight, overflow: getComputedStyle(parent).overflowY });
      if (parent.scrollHeight > parent.clientHeight + 1 && ['auto', 'scroll'].includes(getComputedStyle(parent).overflowY)) owners.push(parent.className);
    }
    return { stable: stable >= 5, focused: document.activeElement === node, documentFocused: document.hasFocus(), connected: node.isConnected,
      visible: rect.width > 0 && rect.height > 0 && rect.top >= -1 && rect.bottom <= innerHeight + 1 && rect.left >= -1 && rect.right <= innerWidth + 1 && !!hit && (hit === node || node.contains(hit)),
      focusVisible: node.matches(':focus-visible'), outlineWidth: parseFloat(style.outlineWidth), outlineStyle: style.outlineStyle,
      rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height }, ancestors, owners };
  });
}

test('Codex focused composer and long approval remain visible in short zoomed viewports', { timeout: 60000 }, async t => {
  const source = await readFile(path.join(root, 'test/behavior/dashboard.test.mjs'), 'utf8');
  const ast = ts.createSourceFile('fixtures.mjs', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const factories = ast.statements.filter(node => ts.isFunctionDeclaration(node) && ['project', 'snapshot'].includes(node.name?.text)).map(node => node.getText(ast));
  assert.equal(factories.length, 2);
  const snapshot = new Function(factories.join('\n') + '; return snapshot;')()('codex');
  Object.assign(snapshot, { group: undefined, groups: [], projects: [], issues: [], mergeRequests: [], groupRoot: undefined, cloneRoot: undefined,
    connectedScope: 'short-height', instanceUserScope: 'short-height', operationScope: 'short-height', localOperationScope: 'short-height', groupRepositories: [] });
  const assets = await readWebviewAssets(path.join(root, 'resources/issue-webview'));
  const browser = await chromium.launch({ headless: true, ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : { channel: 'chrome' }) });
  t.after(() => browser.close());
  const task = { id: 'short-height', title: 'Native zoom · waiting for approval', root: 'C:/offline/zoom-fixture', status: 'waiting', threadId: 'offline-thread', turnId: 'offline-turn',
    createdAt: '2026-11-16T00:00:00Z', updatedAt: '2026-11-16T00:00:00Z', progress: { phase: 'executing', waitReason: 'approval' },
    controls: { external: false, canPause: true, canResume: false, canDelete: false, canAutoAccept: true, autoAccept: false } };
  const detail = Array.from({ length: 48 }, (_, index) => `Approval line ${index + 1}: ${'核對長命令與檔案範圍 '.repeat(4)}`).join('\n');
  for (const viewport of [{ width: 464, height: 272 }, { width: 320, height: 272 }, { width: 464, height: 400 }, { width: 1280, height: 272 }]) await t.test(`${viewport.width}x${viewport.height}`, async () => {
    const context = await browser.newContext({ viewport: { width: 928, height: 544 }, reducedMotion: 'reduce' }), page = await context.newPage();
    try {
      const errors = [], external = [];
      page.on('pageerror', error => errors.push(String(error)));
      await page.route('**/*', async route => {
        const url = new URL(route.request().url()), name = url.pathname.slice(1);
        if (url.hostname !== '127.0.0.1' || !assets.has(name) && name !== 'theme.css') { external.push(url.origin); await route.abort(); return; }
        let body = name === 'theme.css' ? theme : assets.get(name);
        if (name === 'dashboard.html') body = body.toString().replace('<head>', `<head><meta http-equiv="Content-Security-Policy" content="${createWebviewCsp("'self'", 'short-height', 'dashboard')}"><link rel="stylesheet" href="/theme.css">`).replace(/<script\b/g, '<script nonce="short-height"');
        await route.fulfill({ body, contentType: name.endsWith('.js') ? 'application/javascript' : name.endsWith('.css') ? 'text/css' : name.endsWith('.ttf') ? 'font/ttf' : 'text/html' });
      });
      await page.addInitScript(() => {
        let state = { mode: 'codex' }; const entries = new Map();
        window.shortRequests = []; window.shortCsp = [];
        window.addEventListener('securitypolicyviolation', event => window.shortCsp.push(event.violatedDirective));
        window.acquireVsCodeApi = () => ({ getState: () => state, setState: value => { state = value; }, postMessage: message => {
          window.shortRequests.push(message);
          if (['loadCodexUiDrafts', 'saveCodexUiDrafts'].includes(message.type)) queueMicrotask(() => {
            for (const update of message.updates ?? []) entries.set(update.key, { ...update, revision: (entries.get(update.key)?.revision ?? 0) + 1 });
            window.dispatchEvent(new MessageEvent('message', { data: { type: 'codexUiDrafts', requestId: message.requestId, snapshot: { scope: 'short-height', entries: [...entries.values()], conflicts: [] } } }));
          });
        } });
        window.shortSaved = () => state;
      });
      await page.goto('http://127.0.0.1:7881/dashboard.html');
      await page.waitForFunction(() => window.shortRequests.some(message => message.type === 'ready'));
      await send(page, { type: 'snapshot', snapshot }); await settle(page);
      const tasks = viewport.width >= 720 ? [task, ...Array.from({ length: 1999 }, (_, index) => ({ ...task, id: `other-${index}`, title: `Other history ${index}`, status: 'completed' }))] : [task];
      await send(page, { type: 'codexEvent', event: { kind: 'tasks', tasks } });
      await send(page, { type: 'codexEvent', event: { kind: 'interactions', taskId: task.id, interactions: [{ id: 'approval', taskId: task.id, kind: 'command', title: '核對完整命令', detail }] } });
      await page.locator('#codex-follow-up').waitFor(); await settle(page);
      await page.locator('#codex-follow-up').evaluate(input => { input.value = '尚未傳送的完整需求'; input.dispatchEvent(new Event('input', { bubbles: true })); });
      await page.waitForFunction(() => window.shortSaved().codexUi?.drafts?.['short-height']?.text === '尚未傳送的完整需求');
      for (const theme of ['vscode-dark', 'vscode-light']) for (const size of [{ width: 928, height: 544 }, { width: 742, height: 435 }, viewport]) {
        await page.evaluate(theme => { document.body.className = theme; }, theme);
        await page.setViewportSize(size); await settle(page);
        for (const selector of ['#codex-follow-up', '.codex-interaction button[type="submit"]', '#codex-follow-up']) {
          const focus = await focusedGeometry(page, selector);
          assert.equal(focus.stable, true, JSON.stringify(focus)); assert.equal(focus.focused, true, JSON.stringify(focus));
          assert.equal(focus.documentFocused, true, JSON.stringify(focus)); assert.equal(focus.connected, true, JSON.stringify(focus));
          assert.equal(focus.visible, true, `${theme} ${size.width}x${size.height} ${selector} must be fully visible: ${JSON.stringify(focus)}`);
          assert.equal(focus.focusVisible, true); assert.ok(focus.outlineWidth >= 1 && focus.outlineStyle !== 'none');
          if (size.height <= 400) assert.deepEqual(focus.owners, ['app-shell'], 'short content has one scrolling ancestor instead of two competing viewports');
        }
        if (size.height <= 400 && size.width >= 720) {
          const rail = await page.locator('.codex-task-rows').evaluate(list => ({ height: list.clientHeight, total: list.scrollHeight, mounted: list.querySelectorAll('.codex-task-select').length }));
          assert.ok(rail.height > 0 && rail.height <= size.height, `the task rail keeps a bounded viewport: ${JSON.stringify(rail)}`);
          assert.ok(rail.total > rail.height); assert.equal(rail.mounted, 50);
        }
      }
      assert.equal(await page.locator('.codex-interaction pre').textContent(), detail);
      assert.equal(await page.locator('#codex-follow-up').inputValue(), '尚未傳送的完整需求');
      assert.equal(await page.evaluate(() => window.shortRequests.some(request => ['sendCodexMessage', 'answerCodex', 'resumeCodexTask'].includes(request.type))), false);
      assert.deepEqual(errors, []); assert.deepEqual(external, []); assert.deepEqual(await page.evaluate(() => window.shortCsp), []);
    } finally { await context.close(); }
  });
});
