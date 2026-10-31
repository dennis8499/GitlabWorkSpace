// Render the built Webview with an isolated mock host. This does not exercise VS Code itself.
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { bmadWorkspaceSnapshot } from '../test/fixtures/bmad-ui.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const output = path.resolve(process.argv[2] ?? path.join(root, '.verification/workflowkit-131-ui'));
const assets = path.join(root, 'resources/issue-webview');
const files = Object.fromEntries(await Promise.all(['dashboard.html', 'dashboard.js', 'dashboard.css'].map(async name => [name, await readFile(path.join(assets, name))])));
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true, executablePath: process.env.GLW_UI_BROWSER ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe' });
const results = [];
const theme = `:root{--vscode-font-family:'Segoe UI',sans-serif;--vscode-font-size:13px;--vscode-editor-font-family:Consolas,monospace;--vscode-foreground:#ddd;--vscode-editor-background:#1e1e1e;--vscode-sideBar-background:#252526;--vscode-editorWidget-background:#252526;--vscode-panel-border:#454545;--vscode-widget-border:#454545;--vscode-focusBorder:#007fd4;--vscode-button-background:#0078d4;--vscode-button-foreground:#fff;--vscode-input-background:#333;--vscode-input-foreground:#fff;--vscode-input-border:#555;--vscode-descriptionForeground:#aaa;--vscode-textLink-foreground:#75beff}`;

async function render(mode, width, setup, name) {
  const context = await browser.newContext({ viewport: { width, height: 900 }, reducedMotion: 'reduce' });
  const page = await context.newPage();
  const errors = [], blocked = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', async route => {
    const url = new URL(route.request().url());
    const key = url.pathname === '/' ? 'dashboard.html' : url.pathname.slice(1);
    if (url.origin !== 'http://workflowkit.test' || !files[key]) { blocked.push(url.href); return route.abort(); }
    return route.fulfill({ contentType: key.endsWith('.js') ? 'text/javascript' : key.endsWith('.css') ? 'text/css' : 'text/html', body: files[key] });
  });
  const project = 'C:/專案/服務 A';
  const snapshot = bmadWorkspaceSnapshot(project);
  const installed = { status: 'installed', version: '1.3.1', profile: 'repository', integrity: 'verified', interfaceCompatibility: 'compatible',
    bmadMode: 'bundled', capabilities: ['query', 'visualize', 'bmad-workflow'], upstreamVersions: { 'bmad-method': '6.12.4' } };
  snapshot.workflowKit = installed; snapshot.workflowKitInstallTarget.state = installed;
  snapshot.workflowKitSource = 'github';
  snapshot.workflowKitReleases = [{ id: 'fixture-1.3.1', version: '1.3.1', source: 'github', assetName: 'gitlab-workspace-kit-1.3.1.zip',
    format: 'zip', entryRoot: 'workflow-kit', available: true, skillCount: 33 }];
  snapshot.skillsContext.installed = installed; snapshot.skillsContext.availableFeatures = installed.capabilities;
  snapshot.activeMode = mode;
  await context.addInitScript(({ mode, project }) => {
    let state = { mode, bmadUiByRoot: { [project]: { selectedSection: 'start' } } };
    let revision = 0;
    window.__mockRequests = [];
    window.acquireVsCodeApi = () => ({ getState: () => state, setState: value => { state = value; }, postMessage: value => {
      window.__mockRequests.push(value);
      if (value.operationId) queueMicrotask(() => window.dispatchEvent(new MessageEvent('message', { data: { type: 'operationChanged', operation: {
        requestId: value.operationId, scopeRevision: value.operationScope, hostSessionId: 'bmad-test-host', revision: ++revision,
        action: value.type, resourceKey: 'skills', label: '測試操作', phase: '已完成', status: 'succeeded', startedAt: Date.now(), finishedAt: Date.now()
      } } })));
    } });
  }, { mode, project });
  await page.goto('http://workflowkit.test/');
  await page.addStyleTag({ content: theme });
  await page.evaluate(value => window.dispatchEvent(new MessageEvent('message', { data: { type: 'snapshot', snapshot: value } })), snapshot);
  await setup(page, snapshot);
  assert.equal(await page.locator('body').evaluate(element => element.scrollWidth <= element.clientWidth), true, 'horizontal overflow');
  assert.deepEqual(errors, []); assert.deepEqual(blocked, []);
  await page.screenshot({ path: path.join(output, `${name}.png`), fullPage: true });
  results.push({ name, width, status: 'PASS' });
  await context.close();
}

try {
  await render('bmad', 1440, async page => {
    await page.locator('#bmad-requirement').fill('請檢查付款流程，更新相關畫面並驗證結果。');
    assert.equal(await page.getByRole('button', { name: '複製 BMAD 提示詞' }).isEnabled(), true);
  }, 'bmad-ready-1440');
  await render('bmad', 800, async (page, snapshot) => {
    snapshot.workflowKit.bmadMode = 'external';
    snapshot.bmadEnvironment.tools.find(tool => tool.id === 'uv').state = 'missing';
    snapshot.bmadEnvironment.tools.find(tool => tool.id === 'uv').reason = '目前 PATH 找不到 uv。';
    await page.evaluate(value => window.dispatchEvent(new MessageEvent('message', { data: { type: 'snapshot', snapshot: value } })), snapshot);
    await page.getByText('偵測到外部 BMAD', { exact: false }).waitFor();
  }, 'bmad-external-missing-uv-800');
  await render('bmad', 800, async (page, snapshot) => {
    snapshot.workflowKit = { status: 'error', message: '無法驗證 WorkflowKit 安裝內容。' };
    await page.evaluate(value => window.dispatchEvent(new MessageEvent('message', { data: { type: 'snapshot', snapshot: value } })), snapshot);
    await page.getByText('無法驗證 WorkflowKit 安裝內容。', { exact: false }).waitFor();
    assert.equal(await page.getByRole('button', { name: '複製 BMAD 提示詞' }).isEnabled(), false);
  }, 'bmad-kit-error-800');
  await render('sa', 1440, async page => {
    await page.locator('#skill-feature-visualize').click();
    await page.locator('[id="wiki-input-visualize.topic"]').fill('付款服務與退款流程');
    assert.equal(await page.locator('.wiki-copy-button').isEnabled(), true);
  }, 'wiki-visualize-1440');
  await render('sa', 800, async page => {
    await page.locator('#skill-feature-visualize').click();
    await page.locator('[id="wiki-input-visualize.topic"]').fill('付款服務與退款流程');
    await page.locator('.wiki-copy-button').scrollIntoViewIfNeeded();
  }, 'wiki-visualize-800');
  await render('bmad', 1440, async (page, snapshot) => {
    snapshot.workflowKit.warnings = ['未偵測到 uv；安裝已完成，執行 BMAD 工作流程前請先準備 uv。'];
    snapshot.bmadEnvironment.tools.find(tool => tool.id === 'uv').state = 'missing';
    await page.evaluate(value => window.dispatchEvent(new MessageEvent('message', { data: { type: 'snapshot', snapshot: value } })), snapshot);
    await page.getByRole('button', { name: '開啟 WorkflowKit 設定' }).click();
    await page.locator('.tool-drawer').waitFor();
    assert.match(await page.locator('.tool-drawer').innerText(), /WorkflowKit 內建/);
    assert.match(await page.locator('.tool-drawer').innerText(), /33 個 Skills/);
    assert.match(await page.locator('.tool-drawer').innerText(), /安裝時提醒.*uv/);
    await page.locator('.workflow-kit-install-button').scrollIntoViewIfNeeded();
  }, 'workflowkit-settings-1440');
  await writeFile(path.join(output, 'results.json'), JSON.stringify({ scope: 'Built Webview in Chromium with an isolated mock host; not native VS Code.', results }, null, 2) + '\n');
  console.log(JSON.stringify({ output, results }, null, 2));
} finally { await browser.close(); }
