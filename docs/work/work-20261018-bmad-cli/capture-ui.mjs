import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { bmadUiSnapshot, bmadWorkspaceSnapshot } from '../../../test/fixtures/bmad-ui.mjs';

const root = new URL('../../../', import.meta.url), output = new URL('./evidence/', import.meta.url);
await mkdir(output, { recursive: true });
const [html, script, css] = await Promise.all([
  readFile(new URL('resources/issue-webview/dashboard.html', root), 'utf8'),
  readFile(new URL('resources/issue-webview/dashboard.js', root), 'utf8'),
  readFile(new URL('resources/issue-webview/dashboard.css', root), 'utf8')
]);
const projectRoot = 'C:/專案/購物平台', errors = [], results = [];
const palettes = {
  dark: { background: '#1e1e1e', surface: '#252526', foreground: '#cccccc', muted: '#aaaaaa', border: '#454545', link: '#4daafc', button: '#0e639c', focus: '#007fd4' },
  light: { background: '#ffffff', surface: '#f3f3f3', foreground: '#252525', muted: '#606060', border: '#b8b8b8', link: '#005fb8', button: '#005fb8', focus: '#005fb8' },
  contrast: { background: '#000000', surface: '#000000', foreground: '#ffffff', muted: '#ffffff', border: '#ffffff', link: '#00ffff', button: '#0f4a85', focus: '#f38518' }
};
function theme(name) {
  const p = palettes[name];
  return `:root { color-scheme:${name === 'light' ? 'light' : 'dark'}; --vscode-font-family:'Segoe UI','Microsoft JhengHei',sans-serif; --vscode-font-size:13px;
    --vscode-foreground:${p.foreground}; --vscode-editor-background:${p.background}; --vscode-sideBar-background:${p.surface}; --vscode-editorWidget-background:${p.surface};
    --vscode-panel-border:${p.border}; --vscode-descriptionForeground:${p.muted}; --vscode-focusBorder:${p.focus}; --vscode-textLink-foreground:${p.link};
    --vscode-button-background:${p.button}; --vscode-button-foreground:#ffffff; --vscode-button-hoverBackground:${p.button};
    --vscode-button-secondaryBackground:${p.surface}; --vscode-button-secondaryForeground:${p.foreground}; --vscode-list-hoverBackground:${p.surface};
    --vscode-input-background:${p.background}; --vscode-input-foreground:${p.foreground}; --vscode-input-border:${p.border};
    --vscode-errorForeground:${name === 'light' ? '#a1260d' : '#f48771'}; --vscode-editorWarning-foreground:${name === 'light' ? '#805700' : '#e0af68'};
    --vscode-testing-iconPassed:${name === 'light' ? '#14702a' : '#73c991'}; --vscode-contrastBorder:${p.border}; }`;
}
function workspace(missing) {
  const bmad = bmadUiSnapshot(projectRoot);
  if (missing) {
    bmad.installation = { state: 'missing', reason: '請在此專案使用官方 CLI 安裝。' };
    bmad.version = undefined; bmad.compatibility = 'unknown'; bmad.catalogSource = 'guidance';
    bmad.codex = { state: 'missing', skills: [], reason: '尚未偵測到 BMAD Codex Skills。' };
    bmad.currentCandidates = []; bmad.stories = []; bmad.steps = bmad.steps.map(step => ({ ...step, artifacts: [], status: 'not-observed' }));
  }
  bmad.observation = { state: 'watching', lastSuccessfulAt: new Date().toISOString() };
  const value = bmadWorkspaceSnapshot(projectRoot, bmad);
  value.bmadEnvironment = { root: projectRoot, checkedAt: new Date().toISOString(), tools: [
    { id: 'node', label: 'Node.js', state: 'ready', version: '24.8.0', reason: '版本檢查成功。' },
    { id: 'npm', label: 'npm', state: 'found', reason: '已在 PATH 找到啟動指令；請在終端確認。' },
    { id: 'codex', label: 'Codex CLI', state: 'found', reason: '已在 PATH 找到啟動指令；請在終端確認。' },
    { id: 'uv', label: 'uv', state: missing ? 'missing' : 'ready', reason: missing ? '目前 PATH 找不到 uv。' : '版本檢查成功。' }
  ] };
  return value;
}

const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe' });
try {
  for (const [width, palette, section, missing, expanded] of [
    [1440, 'dark', 'start', true, false], [480, 'dark', 'start', true, false],
    [1440, 'dark', 'capabilities', false, false], [480, 'dark', 'capabilities', false, true],
    [1440, 'dark', 'progress', false, true], [480, 'dark', 'progress', false, true],
    [1440, 'light', 'capabilities', false, false], [480, 'contrast', 'progress', false, true]
  ]) {
    const page = await browser.newPage({ viewport: { width, height: 1000 }, reducedMotion: 'reduce', deviceScaleFactor: 1 });
    page.on('pageerror', error => { errors.push(error.message); console.error(error.stack ?? error.message); });
    await page.setContent(html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '').replace(/<link\b[^>]*>/gi, ''));
    if (palette === 'contrast') await page.locator('body').evaluate(body => body.classList.add('vscode-high-contrast'));
    await page.addStyleTag({ content: `${css}\n${theme(palette)}` });
    await page.evaluate(({ projectRoot, section }) => {
      let saved = { mode: 'bmad', bmadUiByRoot: { [projectRoot]: { selectedSection: section } } };
      let revision = 0;
      window.bmadRequests = [];
      window.acquireVsCodeApi = () => ({ getState: () => saved, setState: value => { saved = value; }, postMessage: value => {
        window.bmadRequests.push(value);
        if (value.operationId) queueMicrotask(() => window.dispatchEvent(new MessageEvent('message', { data: { type: 'operationChanged', operation: {
          requestId: value.operationId, scopeRevision: value.operationScope, action: value.type, resourceKey: 'clipboard', kind: 'write',
          hostSessionId: 'bmad-test-host', revision: ++revision, label: '複製 BMAD 指令', status: 'succeeded', phase: '已複製',
          startedAt: Date.now(), finishedAt: Date.now(), effect: 'applied'
        } } })));
      } });
    }, { projectRoot, section });
    await page.addScriptTag({ content: script });
    await page.waitForFunction(() => window.bmadRequests.some(item => item.type === 'ready'));
    await page.evaluate(value => window.dispatchEvent(new MessageEvent('message', { data: { type: 'snapshot', snapshot: value } })), workspace(missing));
    await page.locator(`#bmad-tab-${section}`).click();
    await page.locator(`#bmad-section-${section}`).waitFor();
    if (expanded && section === 'capabilities') await page.locator('.bmad-catalog-toggle').click();
    if (expanded && section === 'progress') await page.locator('.bmad-progress-details > summary').click();
    if (missing) {
      await page.getByRole('button', { name: '複製安裝指令', exact: true }).click();
      const copy = await page.evaluate(() => window.bmadRequests.find(item => item.type === 'copyBmadCommand'));
      assert.equal(copy.command, 'install');
      assert.equal(await page.locator('textarea').count(), 0);
    }
    const metrics = await page.evaluate(() => {
      const panel = document.querySelector('.bmad-panel'), page = document.querySelector('.page');
      return { documentWidth: document.documentElement.scrollWidth, pageWidth: page.clientWidth, pageScroll: page.scrollWidth,
        panelWidth: panel.clientWidth, panelScroll: panel.scrollWidth, selectedTab: document.querySelector('.bmad-sections [aria-selected="true"]').textContent,
        capabilityCount: document.querySelectorAll('.bmad-flow-step').length };
    });
    assert.ok(metrics.documentWidth <= width + 1, `document overflows ${width}`);
    assert.ok(metrics.pageScroll <= metrics.pageWidth + 1, `page overflows ${width}`);
    assert.ok(metrics.panelScroll <= metrics.panelWidth + 1, `panel overflows ${width}`);
    const name = `${width}-${palette}-${section}.png`;
    await page.locator('.page').evaluate(element => { element.scrollTop = 0; });
    await page.screenshot({ path: fileURLToPath(new URL(name, output)), animations: 'disabled' });
    let detailScreenshot;
    if (section === 'capabilities') {
      const card = page.locator('.bmad-command-card').first();
      assert.ok((await card.locator('dt').allTextContents()).includes('下一步'));
      await card.scrollIntoViewIfNeeded();
      detailScreenshot = `${width}-${palette}-capability-card.png`;
      await card.screenshot({ path: fileURLToPath(new URL(detailScreenshot, output)), animations: 'disabled' });
    }
    results.push({ width, palette, section, missing, expanded, screenshot: name, ...(detailScreenshot ? { detailScreenshot } : {}), ...metrics });
    await page.close();
  }
  assert.deepEqual(errors, []);
  const hash = value => createHash('sha256').update(value).digest('hex');
  await writeFile(new URL('ui-verification.json', output), JSON.stringify({ status: 'PASS', generatedAt: new Date().toISOString(), browser: browser.version(),
    method: 'Built dashboard assets in real headless Chrome with synthetic project snapshots; no Codex session or BMAD installer is executed.',
    assets: { js: hash(script), css: hash(css) }, results, errors }, null, 2) + '\n');
  console.log(JSON.stringify({ status: 'PASS', screenshots: results.length, results }));
} finally { await browser.close(); }
