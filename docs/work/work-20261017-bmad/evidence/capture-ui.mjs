import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { readBmadWorkflow } from '../../../../out/src/workspace/bmadWorkflow.js';
import { bmadWorkspaceSnapshot } from '../../../../test/fixtures/bmad-ui.mjs';

const root = new URL('../../../../', import.meta.url), output = new URL('./', import.meta.url);
const [html, script, css, catalog] = await Promise.all([
  readFile(new URL('resources/issue-webview/dashboard.html', root), 'utf8'),
  readFile(new URL('resources/issue-webview/dashboard.js', root), 'utf8'),
  readFile(new URL('resources/issue-webview/dashboard.css', root), 'utf8'),
  readFile(new URL('resources/bmad/bmad-help.csv', root), 'utf8')
]);
const bmad = await readBmadWorkflow({ bundledCatalog: catalog });
const projectRoot = 'C:/專案/購物平台';
Object.assign(bmad, { root: projectRoot, revision: 'visual-fixture', version: '6.12.4',
  installation: { state: 'ready', reason: 'BMAD 已安裝。' } });
const find = skill => bmad.nodes.find(node => node.skill === skill);
const build = find('bmad-build'), review = find('bmad-code-review'), prd = find('bmad-prd');
const artifact = { id: 'story-checkout', path: `${projectRoot}/_bmad-output/specs/spec-checkout/story-checkout.md`,
  relativePath: '_bmad-output/specs/spec-checkout/story-checkout.md', fingerprint: 'visual-fixture-sha',
  status: 'needs-confirmation', reason: '已偵測到工作文件；請核對內容後逐份確認。', canConfirm: true, confirmed: false };
Object.assign(bmad.steps.find(step => step.id === build.id), { status: 'needs-confirmation', summary: '已偵測到 1 份產物，需要確認是否完成。', artifacts: [artifact] });
Object.assign(bmad.steps.find(step => step.id === prd.id), { status: 'complete', summary: '需求文件含明確完成標記。' });
bmad.currentCandidates = [{ stepId: build.id, artifactId: artifact.id, label: '購物車結帳流程', reason: '此工作正在實作，已有草稿產物。' },
  { stepId: review.id, storyId: 'story-receipt', label: '電子收據寄送', reason: '另一份故事已進入程式碼審查。' }];
bmad.recommendations = [{ stepId: review.id, reason: '實作完成並確認後，接續獨立審查。' }];
bmad.stories = [{ id: 'story-checkout', label: '購物車結帳流程', mode: 'spec', path: artifact.path, status: 'in-progress', reason: '進行付款與庫存處理。' },
  { id: 'story-receipt', label: '電子收據寄送', mode: 'classic', path: 'receipt.md', status: 'review', reason: '等待程式碼審查。' }];
const snapshot = bmadWorkspaceSnapshot(projectRoot, bmad);
const theme = `:root { color-scheme:dark; --vscode-font-family:'Segoe UI','Microsoft JhengHei',sans-serif; --vscode-font-size:13px;
 --vscode-foreground:#cccccc; --vscode-editor-background:#1e1e1e; --vscode-sideBar-background:#252526; --vscode-editorWidget-background:#252526;
 --vscode-panel-border:#454545; --vscode-descriptionForeground:#aaaaaa; --vscode-focusBorder:#007fd4; --vscode-textLink-foreground:#4daafc;
 --vscode-button-background:#0e639c; --vscode-button-foreground:#ffffff; --vscode-button-hoverBackground:#1177bb;
 --vscode-button-secondaryBackground:#3a3d41; --vscode-button-secondaryForeground:#ffffff; --vscode-list-hoverBackground:#2a2d2e;
 --vscode-input-background:#3c3c3c; --vscode-input-foreground:#cccccc; --vscode-input-border:#555555; --vscode-errorForeground:#f48771;
 --vscode-editorWarning-foreground:#cca700; --vscode-testing-iconPassed:#73c991; }`;
const browser = await chromium.launch({ headless: true, executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe' });
const results = [], errors = [];
try {
  for (const width of [1440, 480]) {
    const page = await browser.newPage({ viewport: { width, height: 1000 }, deviceScaleFactor: 1, reducedMotion: 'reduce' });
    page.on('pageerror', error => errors.push(error.message));
    await page.setContent(html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '').replace(/<link\b[^>]*>/gi, ''));
    await page.addStyleTag({ content: `${css}\n${theme}` });
    await page.evaluate(() => {
      let saved = { mode: 'bmad' };
      window.acquireVsCodeApi = () => ({ getState: () => saved, setState: value => { saved = value; }, postMessage: () => {} });
    });
    await page.addScriptTag({ content: script });
    await page.waitForTimeout(80);
    await page.evaluate(value => window.dispatchEvent(new MessageEvent('message', { data: { type: 'snapshot', snapshot: value } })), snapshot);
    await page.locator('.bmad-flow-step').first().waitFor();
    await page.waitForTimeout(150);
    const measure = async label => {
      const metrics = await page.evaluate(() => {
        const panel = document.querySelector('.bmad-panel'), page = document.querySelector('.page');
        return { viewport: innerWidth, bodyWidth: document.documentElement.scrollWidth,
          pageClientWidth: page.clientWidth, pageScrollWidth: page.scrollWidth, panelClientWidth: panel.clientWidth, panelScrollWidth: panel.scrollWidth,
          nodes: document.querySelectorAll('.bmad-flow-step').length, edges: document.querySelectorAll('.bmad-flow-line').length,
          currentPositions: document.querySelectorAll('.bmad-current-card').length,
          selectedStep: document.querySelector('.bmad-step-selected')?.dataset.stepId };
      });
      assert.ok(metrics.bodyWidth <= width + 1, `${label}: document overflows`);
      assert.ok(metrics.pageScrollWidth <= metrics.pageClientWidth + 1, `${label}: page overflows`);
      assert.ok(metrics.panelScrollWidth <= metrics.panelClientWidth + 1, `${label}: panel overflows`);
      const file = `bmad-${label}.png`;
      await page.screenshot({ path: fileURLToPath(new URL(file, output)), animations: 'disabled' });
      results.push({ label, screenshot: file, ...metrics });
    };
    await measure(`${width}-flow`);
    if (width === 480) {
      await page.locator('.bmad-flow-step', { hasText: '實作與內建檢視' }).click();
      await page.waitForTimeout(100);
      assert.equal(await page.locator('.bmad-step-detail').evaluate(element => document.activeElement === element), true, 'narrow selection focuses its guide');
      await measure(`${width}-guide`);
      await page.getByRole('button', { name: '← 返回流程圖' }).click();
      assert.equal(await page.locator('.bmad-step-selected').evaluate(element => document.activeElement === element), true, 'return restores graph keyboard focus');
    }
    await page.close();
  }
  assert.deepEqual(errors, []);
  const sha256 = value => createHash('sha256').update(value).digest('hex');
  await writeFile(new URL('ui-capture.json', output), JSON.stringify({ schema: 'BmadUiVisualCapture/v1',
    generatedAt: new Date().toISOString(), status: 'PASS', browser: browser.version(),
    method: 'Actual built dashboard assets in headless Chrome, official bundled catalog, synthetic workspace and artifact snapshot. This does not run VS Code, Codex or GitLab.',
    assets: { dashboardJsSha256: sha256(script), dashboardCssSha256: sha256(css), catalogSha256: sha256(catalog) }, results, errors }, null, 2) + '\n');
  console.log(JSON.stringify(results, null, 2));
} finally { await browser.close(); }
