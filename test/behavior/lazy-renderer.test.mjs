/* global window, document, getComputedStyle */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { chromium } from 'playwright-core';
import { createWebviewCsp } from '../../out/src/webviewSecurity.js';
import { readWebviewAssets, webviewAssetPaths } from '../../scripts/webview-assets.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
async function assetsForTest() {
  if (process.env.GITLAB_WORKSPACE_UI_SOURCE !== '1') return readWebviewAssets(path.join(root, 'resources/issue-webview'));
  const { build } = await import('vite');
  const result = await build({ configFile: path.join(root, 'vite.dashboard.config.mjs'), logLevel: 'silent', build: { write: false, emptyOutDir: false } });
  const files = new Map(result.output.map(item => [item.fileName, Buffer.from(item.type === 'chunk' ? item.code : item.source)]));
  for (const name of webviewAssetPaths(JSON.parse(files.get('asset-manifest.json').toString()))) assert.ok(files.has(name), `Missing emitted asset ${name}`);
  return files;
}

test('lazy feature chunks preserve navigation, background state, retry and native modal behavior', { timeout: 60000 }, async t => {
  const assets = await assetsForTest();
  const manifest = JSON.parse(assets.get('asset-manifest.json').toString());
  const featureFile = name => {
    const entry = Object.entries(manifest).find(([key]) => key.endsWith('/' + name + '.tsx') || key === name + '.tsx');
    assert.ok(entry, `Missing lazy manifest entry ${name}`); return entry[1].file;
  };
  const source = await readFile(path.join(root, 'test/behavior/dashboard.test.mjs'), 'utf8');
  const ast = ts.createSourceFile('fixtures.mjs', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const functions = ast.statements.filter(node => ts.isFunctionDeclaration(node) && ['project', 'snapshot'].includes(node.name?.text)).map(node => node.getText(ast));
  assert.equal(functions.length, 2);
  const initial = new Function(functions.join('\n') + '; return snapshot("dashboard");')();
  const browser = await chromium.launch({ headless: true, ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : { channel: 'chrome' }) });
  t.after(() => browser.close());
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, reducedMotion: 'no-preference' });
  const page = await context.newPage(), requested = [], violations = [], errors = [];
  let blocked = featureFile('BmadPanel'), delayed = featureFile('SkillsGuide'), release;
  const delay = new Promise(resolve => { release = resolve; });
  page.on('pageerror', error => errors.push(String(error)));
  await page.route('**/*', async route => {
    const url = new URL(route.request().url()), name = url.pathname.slice(1);
    if (url.hostname !== '127.0.0.1' || !assets.has(name)) { violations.push(url.origin); await route.abort(); return; }
    requested.push(name);
    if (name === blocked) { blocked = undefined; await route.abort(); return; }
    if (name === delayed) { delayed = undefined; await delay; }
    let body = assets.get(name);
    if (name === 'dashboard.html') body = body.toString().replace('<head>', `<head><meta http-equiv="Content-Security-Policy" content="${createWebviewCsp("'self'", 'lazy-test', 'dashboard')}">`).replace(/<script\b/g, '<script nonce="lazy-test"');
    await route.fulfill({ body, contentType: name.endsWith('.js') ? 'application/javascript' : name.endsWith('.css') ? 'text/css' : name.endsWith('.ttf') ? 'font/ttf' : name.endsWith('.json') ? 'application/json' : 'text/html' });
  });
  await page.addInitScript(initial => {
    window.lazyRequests = []; window.lazyCsp = []; window.lazySaved = {};
    window.addEventListener('securitypolicyviolation', event => window.lazyCsp.push(event.violatedDirective));
    const send = data => window.dispatchEvent(new MessageEvent('message', { data }));
    window.acquireVsCodeApi = () => ({ getState: () => window.lazySaved, setState: value => { window.lazySaved = value; }, postMessage: message => {
      window.lazyRequests.push(message);
      if (message.type === 'ready') queueMicrotask(() => send({ type: 'snapshot', snapshot: initial }));
      if (message.type === 'gitReady') queueMicrotask(() => send({ type: 'gitRepositories', available: true, repositories: [], revision: 1 }));
    } });
  }, initial);
  await page.goto('http://127.0.0.1:7878/dashboard.html');
  await page.locator('.home-dashboard').waitFor();
  const featureNames = ['IssueGraph', 'GitControlPanel', 'SkillsGuide', 'BmadPanel', 'CodexWorkspace'];
  for (const name of featureNames) assert.equal(requested.includes(featureFile(name)), false, `Home must not load ${name}`);
  let generation = 0;
  const send = data => page.evaluate(data => window.dispatchEvent(new MessageEvent('message', { data })), data);
  const navigate = mode => send({ type: 'hostNavigation', generation: ++generation, values: { mode } });

  await t.test('a delayed feature never restores an obsolete page', async () => {
    await navigate('sa'); await page.locator('.lazy-feature').waitFor();
    await navigate('dashboard'); release(); await page.locator('.home-dashboard').waitFor();
    await page.waitForFunction(() => document.querySelector('.page')?.dataset.mode === 'dashboard');
    await navigate('sa'); await page.locator('.skills-guide').waitFor();
    assert.equal(requested.filter(name => name === featureFile('SkillsGuide')).length, 1);
  });
  await t.test('a failed chunk can be retried without replaying business actions', async () => {
    await navigate('bmad'); await page.getByRole('button', { name: '重試載入BMAD' }).waitFor();
    const before = await page.evaluate(() => window.lazyRequests.length);
    await page.getByRole('button', { name: '重試載入BMAD' }).click();
    await page.locator('.bmad-panel').waitFor({ timeout: 5000 });
    assert.equal(await page.evaluate(() => window.lazyRequests.length), before);
  });
  await t.test('background Codex state survives until the renderer is first opened', async () => {
    assert.equal(requested.includes(featureFile('CodexWorkspace')), false);
    await send({ type: 'codexEvent', event: { kind: 'tasks', tasks: [{ id: 'background', title: 'Background task preserved', root: 'C:/fixture', status: 'completed', createdAt: '2026-11-12T00:00:00Z', updatedAt: '2026-11-12T00:00:00Z' }] } });
    await navigate('codex'); await page.getByText('Background task preserved', { exact: true }).first().waitFor();
    assert.equal(requested.filter(name => name === featureFile('CodexWorkspace')).length, 1);
    await navigate('dashboard'); await navigate('codex');
    assert.equal(requested.filter(name => name === featureFile('CodexWorkspace')).length, 1);
  });
  await t.test('HTML dialog uses the top layer and follows the VS Code reduce-motion class', async () => {
    await navigate('dashboard');
    await page.locator('.settings-trigger').focus();
    await send({ type: 'openSettings' });
    const dialog = page.locator('dialog.native-dialog'); await dialog.waitFor();
    assert.equal(await dialog.evaluate(element => element.matches(':modal')), true);
    await page.evaluate(() => document.body.classList.add('vscode-reduce-motion'));
    await page.waitForFunction(() => document.querySelector('dialog')?.dataset.presence === 'entered');
    assert.equal(await dialog.evaluate(element => getComputedStyle(element).animationName), 'none');
    await page.keyboard.press('Escape'); await dialog.waitFor({ state: 'detached' });
    await page.waitForFunction(() => document.activeElement?.classList.contains('settings-trigger'));
  });
  assert.deepEqual(violations, []); assert.deepEqual(await page.evaluate(() => window.lazyCsp), []); assert.deepEqual(errors, []);
});
