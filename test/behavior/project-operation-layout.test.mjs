/* global window, document, requestAnimationFrame */
import assert from 'node:assert/strict';
import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { chromium } from 'playwright-core';
import { createWebviewCsp } from '../../out/src/webviewSecurity.js';
import { readWebviewAssets } from '../../scripts/webview-assets.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const theme = ':root{--vscode-foreground:#ccc;--vscode-editor-background:#1f1f1f;--vscode-sideBar-background:#181818;--vscode-descriptionForeground:#9d9d9d;--vscode-focusBorder:#0078d4;--vscode-button-background:#0078d4;--vscode-button-foreground:#fff;--vscode-input-background:#313131;--vscode-input-foreground:#ccc;--vscode-panel-border:#444;--vscode-font-family:Segoe UI,sans-serif;--vscode-font-size:13px;}';
const settle = page => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
const send = (page, data) => page.evaluate(data => window.dispatchEvent(new MessageEvent('message', { data })), data);

async function geometry(page) {
  return page.locator('.repo-list').evaluate(list => {
    const { x, y, width, height } = list.getBoundingClientRect();
    return { x, y, width, height, top: list.scrollTop, selected: window.layoutSaved.selectedProjectIds };
  });
}

function unchanged(before, after, stage) {
  for (const key of ['x', 'y', 'width', 'height', 'top']) assert.ok(Math.abs(before[key] - after[key]) <= 1,
    `${stage} must preserve repository ${key}: ${before[key]} -> ${after[key]}`);
  assert.deepEqual(after.selected, before.selected, `${stage} preserves unfinished repository selections`);
}

test('project operation overlays preserve repository geometry and adapt modal focus to short and narrow windows', { timeout: 60000 }, async t => {
  const source = await readFile(path.join(root, 'test/behavior/dashboard.test.mjs'), 'utf8');
  const ast = ts.createSourceFile('fixtures.mjs', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const functions = ast.statements.filter(node => ts.isFunctionDeclaration(node) && ['project', 'snapshot'].includes(node.name?.text)).map(node => node.getText(ast));
  assert.equal(functions.length, 2, 'Review the shared project fixture when its factory changes.');
  const factories = new Function(functions.join('\n') + '; return { project, snapshot };')();
  const initial = factories.snapshot('clone');
  initial.projects = Array.from({ length: 120 }, (_, index) => factories.project(index + 1, `service-${String(index + 1).padStart(3, '0')}`));
  const assets = await readWebviewAssets(path.join(root, 'resources/issue-webview'));
  const browser = await chromium.launch({ headless: true, ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : { channel: 'chrome' }) });
  t.after(() => browser.close());
  const context = await browser.newContext({ viewport: { width: 1280, height: 1000 }, reducedMotion: 'reduce' });
  const page = await context.newPage(), errors = [], external = [];
  page.on('pageerror', error => errors.push(String(error)));
  await page.route('**/*', async route => {
    const url = new URL(route.request().url()), name = url.pathname.slice(1);
    if (url.hostname !== '127.0.0.1' || !assets.has(name) && name !== 'theme.css') { external.push(url.origin); await route.abort(); return; }
    let body = name === 'theme.css' ? theme : assets.get(name);
    if (name === 'dashboard.html') body = body.toString().replace('<head>', `<head><meta http-equiv="Content-Security-Policy" content="${createWebviewCsp("'self'", 'project-layout', 'dashboard')}"><link rel="stylesheet" href="/theme.css">`).replace(/<script\b/g, '<script nonce="project-layout"');
    await route.fulfill({ body, contentType: name.endsWith('.js') ? 'application/javascript' : name.endsWith('.css') ? 'text/css' : name.endsWith('.ttf') ? 'font/ttf' : 'text/html' });
  });
  await page.addInitScript(() => {
    window.layoutSaved = { mode: 'clone', scopeKey: 'team-scope', selectedProjectIds: [1, 2] };
    window.layoutRequests = []; window.layoutCsp = [];
    window.addEventListener('securitypolicyviolation', event => window.layoutCsp.push(event.violatedDirective));
    window.acquireVsCodeApi = () => ({ getState: () => window.layoutSaved, setState: value => { window.layoutSaved = value; },
      postMessage: message => { window.layoutRequests.push(message); } });
  });
  await page.goto('http://127.0.0.1:7879/dashboard.html');
  await page.waitForFunction(() => window.layoutRequests.some(message => message.type === 'ready'));
  await send(page, { type: 'snapshot', snapshot: initial });
  await page.locator('.repo-list .repo-row').first().waitFor(); await settle(page);
  await page.locator('.repo-list').evaluate(list => { list.scrollTop = 600; }); await settle(page);
  const before = await geometry(page); assert.ok(before.height > 200); assert.equal(before.top, 600); assert.deepEqual(before.selected, [1, 2]);
  const output = process.env.GITLAB_WORKSPACE_PROJECT_UI_OUT ?? process.env.GITLAB_WORKSPACE_VALIDATION_DIR;
  const screenshot = async name => { if (output) { await mkdir(output, { recursive: true }); await page.screenshot({ path: path.join(output, name + '.png') }); } };
  await page.locator('.more-actions > summary').click();
  await page.getByRole('button', { name: '更新全部本機預設分支', exact: true }).click();
  await settle(page);
  const request = await page.evaluate(() => window.layoutRequests.findLast(message => message.type === 'syncRepos'));
  assert.ok(request?.operationId); assert.equal(await page.locator('.more-actions').getAttribute('open'), null);
  const receipt = { requestId: request.operationId, scopeRevision: request.operationScope, resourceKey: 'repositories', action: 'syncRepos',
    label: '更新預設分支', phase: '正在檢查本機 Repo', status: 'running', startedAt: Date.now(), effect: 'none' };
  await send(page, { type: 'operationChanged', operation: receipt }); await settle(page);
  unchanged(before, await geometry(page), 'busy preparation');
  const operation = { type: 'cloneOperation', id: 'layout-sync', scopeKey: initial.connectedScope, projectRevision: initial.projectContext.revision,
    phase: 'confirming', label: '預設分支同步結果', items: initial.projects.slice(0, 3).map(project => ({ projectId: project.id, projectPath: project.path_with_namespace, state: 'waiting' })) };
  await send(page, operation); await settle(page);
  unchanged(before, await geometry(page), 'native confirmation');
  assert.match(await page.locator('.repository-operation-summary').innerText(), /等待確認/);
  operation.phase = 'running'; operation.items[0] = { ...operation.items[0], state: 'failed', message: 'Git fetch failed\nfatal: Authentication failed\n' + '完整診斷 '.repeat(80) };
  operation.items[1] = { ...operation.items[1], state: 'skipped', message: '工作目錄有未提交變更' };
  operation.items[2] = { ...operation.items[2], state: 'progress', percent: 42 };
  await send(page, operation); await settle(page);
  unchanged(before, await geometry(page), 'running progress');
  assert.equal(await page.locator('#repository-operation-details').count(), 0); await screenshot('projects-1280-summary');
  await page.locator('.repository-operation-trigger').click(); await settle(page);
  unchanged(before, await geometry(page), 'opening details');
  const overlay = await page.locator('.repository-operation-overlay').boundingBox(), workbench = await page.locator('.workbench').boundingBox();
  assert.ok(overlay.height <= workbench.height / 2 + 1, 'normal details cover at most half the available work area');
  await page.getByRole('button', { name: '失敗（1）', exact: true }).click();
  assert.equal(await page.locator('.operation-message.failed').innerText(), operation.items[0].message);
  await screenshot('projects-1280-details');
  await page.keyboard.press('Escape'); await settle(page);
  unchanged(before, await geometry(page), 'closing details');
  assert.equal(await page.locator('.repository-operation-trigger').evaluate(button => button === document.activeElement), true);
  operation.phase = 'completed'; operation.items[2] = { ...operation.items[2], state: 'updated', percent: undefined };
  await send(page, operation);
  await send(page, { type: 'operationChanged', operation: { ...receipt, status: 'failed', phase: '部分 Repo 更新失敗', finishedAt: Date.now(), effect: 'partial' } });
  await settle(page); unchanged(before, await geometry(page), 'completed results');

  await page.setViewportSize({ width: 1280, height: 650 }); await settle(page);
  assert.ok((await page.locator('.workbench').boundingBox()).height < 600, 'the short scenario measures actual available height');
  const shortBefore = await geometry(page);
  await page.locator('.repository-operation-trigger').click(); await settle(page);
  const modal = page.locator('.repository-operation-modal');
  assert.equal(await modal.evaluate(dialog => dialog.matches(':modal')), true, 'short-height details use native inertness and the top layer');
  assert.equal(Math.round((await modal.boundingBox()).height), 650);
  await page.locator('.repo-row input').first().evaluate(input => input.focus());
  assert.equal(await modal.evaluate(dialog => dialog.contains(document.activeElement)), true, 'background repository controls are inert');
  await page.getByRole('button', { name: '關閉專案操作詳情', exact: true }).focus();
  await page.keyboard.press('Shift+Tab');
  assert.equal(await modal.evaluate(dialog => dialog.contains(document.activeElement)), true, 'backwards tab remains in the modal');
  await screenshot('projects-short-modal');
  await page.keyboard.press('Escape'); await settle(page);
  assert.equal(await modal.count(), 0); unchanged(shortBefore, await geometry(page), 'short modal close');
  assert.equal(await page.locator('.repository-operation-trigger').evaluate(button => button === document.activeElement), true);

  await page.setViewportSize({ width: 320, height: 900 }); await settle(page);
  for (const selector of ['body', '.page', '.clone-list-column', '.repository-operation-summary']) assert.equal(
    await page.locator(selector).evaluate(element => element.scrollWidth <= element.clientWidth + 1), true, `${selector} fits a 320px viewport`);
  await page.locator('.repository-operation-trigger').click(); await settle(page);
  assert.ok((await page.locator('.repository-operation-details').boundingBox()).width <= 320);
  await screenshot('projects-320-details');
  await page.keyboard.press('Escape'); await settle(page);
  assert.deepEqual(errors, []); assert.deepEqual(external, []); assert.deepEqual(await page.evaluate(() => window.layoutCsp), []);
});
