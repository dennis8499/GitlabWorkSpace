import { readFileSync, writeFileSync, statSync, existsSync } from 'node:fs';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const directory = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(directory, '../../..');
const evidence = path.join(directory, 'evidence');
const htmlFile = path.join(directory, 'report.html');
const verificationFile = path.join(directory, 'verification.json');
const bytes = readFileSync(htmlFile);
const html = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
const verification = JSON.parse(readFileSync(verificationFile, 'utf8'));
const sha = value => createHash('sha256').update(value).digest('hex');
const qa = {
  schema: 'GitLabWorkspaceReportQa/v1', checkedAt: new Date().toISOString(), status: 'RUNNING',
  reportSha256: sha(bytes), verificationSha256: sha(readFileSync(verificationFile)),
  verificationGeneratedAt: verification.generatedAt, candidateSha256: verification.candidate.sha256,
  scope: 'Static delivery report only: headless layout, local evidence links and displayed values. External links are inventoried without network requests. No product or native tests are executed.',
  checks: [], viewports: [], screenshots: [], visualReview: { status: 'PENDING' }
};
const check = (name, passed, detail = undefined) => qa.checks.push({ name, status: passed ? 'PASS' : 'FAIL', ...(detail === undefined ? {} : { detail }) });
const server = createServer((request, response) => {
  try {
    const url = new URL(request.url, 'http://127.0.0.1');
    const filename = path.resolve(root, `.${decodeURIComponent(url.pathname)}`);
    const relative = path.relative(root, filename);
    if (relative.startsWith('..') || path.isAbsolute(relative) || !existsSync(filename) || !statSync(filename).isFile()) {
      response.writeHead(404); response.end(); return;
    }
    const type = filename.endsWith('.html') ? 'text/html; charset=utf-8' : filename.endsWith('.json') ? 'application/json; charset=utf-8' : 'application/octet-stream';
    response.writeHead(200, { 'content-type': type, 'cache-control': 'no-store' });
    response.end(request.method === 'HEAD' ? undefined : readFileSync(filename));
  } catch (error) { response.writeHead(500); response.end(error.message); }
});
let browser;
try {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const reportUrl = `${origin}/${path.relative(root, htmlFile).replaceAll('\\', '/')}`;
  browser = await chromium.launch({ headless: true, executablePath: process.env.GLW_REPORT_QA_BROWSER ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe' });
  qa.browser = browser.version();
  check('strict UTF-8 decoding and Chinese headings', html.includes('功能行為與回應時間優化報告') && html.includes('驗收限制與待驗') && !html.includes('\uFFFD'));
  for (const width of [1440, 390]) {
    const context = await browser.newContext({ viewport: { width, height: width === 390 ? 844 : 1000 }, deviceScaleFactor: 1, colorScheme: 'light' });
    const errors = [], blockedRequests = [];
    await context.route('**/*', route => {
      if (new URL(route.request().url()).origin === origin) return route.continue();
      blockedRequests.push(route.request().url()); return route.abort();
    });
    const page = await context.newPage();
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(reportUrl, { waitUntil: 'load' });
    await page.evaluate(() => document.fonts.ready);
    const state = await page.evaluate(() => {
      const tables = [...document.querySelectorAll('.table')].map((wrapper, index) => {
        const initial = wrapper.scrollLeft;
        const scrollable = wrapper.scrollWidth > wrapper.clientWidth + 1;
        wrapper.scrollLeft = 100;
        const canScroll = wrapper.scrollLeft > 0;
        wrapper.scrollLeft = initial;
        return { index, clientWidth: wrapper.clientWidth, scrollWidth: wrapper.scrollWidth, overflowX: getComputedStyle(wrapper).overflowX, scrollable, canScroll };
      });
      return { language: document.documentElement.lang, charset: document.characterSet,
        clientWidth: document.documentElement.clientWidth, scrollWidth: document.documentElement.scrollWidth,
        bodyClientWidth: document.body.clientWidth, bodyScrollWidth: document.body.scrollWidth,
        text: document.body.innerText, tables,
        headings: [...document.querySelectorAll('h2')].map(heading => heading.textContent.trim()),
        rows: [...document.querySelectorAll('tbody tr')].map(row => [...row.querySelectorAll('td')].map(cell => cell.textContent.trim())),
        links: [...document.querySelectorAll('a[href]')].map(link => ({ href: link.getAttribute('href'), label: link.textContent.trim() })) };
    });
    qa.viewports.push({ width, ...Object.fromEntries(Object.entries(state).filter(([name]) => !['text', 'rows', 'links'].includes(name))), errors, blockedRequests });
    check(`${width}: Chinese UTF-8 document`, state.language === 'zh-Hant' && state.charset === 'UTF-8');
    check(`${width}: no body or document horizontal overflow`, state.scrollWidth <= state.clientWidth + 1 && state.bodyScrollWidth <= state.bodyClientWidth + 1,
      { document: [state.clientWidth, state.scrollWidth], body: [state.bodyClientWidth, state.bodyScrollWidth] });
    check(`${width}: tables allow internal horizontal scrolling`, state.tables.length > 0 && state.tables.every(table => ['auto', 'scroll'].includes(table.overflowX) && (!table.scrollable || table.canScroll)), state.tables);
    check(`${width}: no rendering placeholders`, !/\bundefined\b|\bNaN\b|\[object Object\]|\uFFFD/.test(state.text));
    check(`${width}: no runtime errors or external asset requests`, errors.length === 0 && blockedRequests.length === 0, { errors, blockedRequests });
    const exactRow = expected => state.rows.some(row => JSON.stringify(row) === JSON.stringify(expected.map(String)));
    const rowContaining = expected => state.rows.some(row => expected.every(value => row.some(cell => cell.includes(String(value)))));
    check(`${width}: regression counts and phase durations match verification`,
      rowContaining([`${verification.regression.unitPassed}/${verification.regression.unitTests} PASS`])
      && rowContaining([`${verification.regression.behaviorPassed}/${verification.regression.behaviorTests} PASS`])
      && rowContaining([`${verification.regression.stages} stages PASS`, `${verification.regression.seconds} 秒`])
      && verification.regression.extensionHost.every(host => state.text.includes(`${host.vscode}：${host.passed} PASS、${host.pending} opt-in pending`)));
    check(`${width}: final Renderer comparison matches verification`, Object.entries(verification.packagedRenderer.comparison.metrics)
      .every(([name, value]) => exactRow([name, value.baseline, value.revision, `${value.increasePercent}%`, value.status])));
    check(`${width}: all eight feedback rows match verification`, verification.packagedRenderer.firstFeedback.cases.length === 8
      && verification.packagedRenderer.firstFeedback.cases.every(value => exactRow([value.name ?? value.action ?? value.case, value.sampleCount, value.p95Ms ?? value.firstFeedbackP95Ms, value.status])));
    check(`${width}: snapshot workloads match verification`, verification.snapshotBenchmark.workloads.every(value => exactRow([
      `${value.repos} / ${value.issues}`, value.sampleCount, `${value.baseline.updateP95Ms ?? '—'} / ${value.baseline.updateMaxMs}`,
      `${value.revision.updateP95Ms ?? '—'} / ${value.revision.updateMaxMs}`, `${value.baseline.updateBytes} → ${value.revision.updateBytes}`])));
    check(`${width}: graph metrics match verification`, verification.graphBenchmark.every(value => exactRow([value.nodes,
      `${value.selectionP95BeforeMs} → ${value.selectionP95AfterMs}`, `${value.zoomP95BeforeMs} → ${value.zoomP95AfterMs}`,
      value.interactionLongTasksAfter, value.mountLongTasksAfterMs.join(', ') || '0'])));
    check(`${width}: historical search FAIL is retained`, verification.preDraftRendererObservation.comparison.status === 'FAIL'
      && Object.entries(verification.preDraftRendererObservation.comparison.metrics).every(([name, value]) => exactRow([name, value.baseline, value.revision, `${value.increasePercent}%`, value.status]))
      && state.text.includes('搜尋回退原因尚未證實'));
    check(`${width}: all acceptance rows match verification`, verification.acceptance.every(value => exactRow([value.item, value.target, value.measured, value.status, value.scope])));
    check(`${width}: artifact identity and unpublished status are explicit`, verification.candidate.published === false
      && state.text.includes('未發布') && state.text.includes(verification.candidate.sha256) && state.text.includes(`${verification.candidate.bytes} bytes`));
    check(`${width}: real GitLab, native cold start and peak memory remain pending`, state.text.includes('真實 GitLab 與完整原生效能門檻仍待驗')
      && state.text.includes('待 10 次真實程序冷啟動量測')
      && verification.acceptance.some(value => value.item === '完整原生延遲／峰值記憶體回退' && value.status === 'PENDING')
      && verification.pending.every(value => state.text.includes(value)) && verification.limitations.every(value => state.text.includes(value)));
    check(`${width}: Renderer pass cannot imply global native or file-read acceptance`,
      verification.acceptance.some(value => value.item === '封裝 Renderer 延遲／GC 後保留記憶體回退' && value.status === verification.packagedRenderer.comparison.status)
      && verification.acceptance.some(value => value.item === '所有功能的閒置檔案讀取' && value.status === 'PENDING')
      && !verification.acceptance.some(value => value.item === '延遲／記憶體回退'));
    check(`${width}: matrix counts match verification`, state.text.includes(`${verification.functionalMatrix.completeOfflineScenarios} 項的六種離線情境已齊全`)
      && state.text.includes(`${verification.functionalMatrix.pendingOfflineScenarios} 項仍有待驗情境`));
    check(`${width}: five idle phases and VS Code background activity stay separate`, verification.nativeGit.idleChecks.length === 5
      && verification.nativeGit.idleChecks.every(value => exactRow([value.phase, (value.idleMs / 1000).toFixed(3), value.extensionDelta.commands,
        value.extensionDelta.auxiliaryCommands, value.extensionDelta.nativeApiCalls, value.vscodeGitLog.backgroundDelta]))
      && state.text.includes('不宣稱整個 VS Code 都沒有 Git 活動') && state.text.includes('hidden 階段新增 4 筆'));
    check(`${width}: GUI adapter and standalone confirmation are identified`, state.text.includes('Commit test-adapter、Push test-adapter')
      && state.text.includes('standalone Workbench 驗證：Commit workbench-dom、Push workbench-dom'));
    check(`${width}: feature scope is not claimed as full acceptance`, !/57\s*項[^。\n]{0,30}(?:全數|全部)(?:[^。\n]{0,10})(?:通過|驗收完成)/.test(state.text)
      && verification.functionalMatrix.pendingOfflineScenarios > 0 && state.text.includes('仍有待驗情境'));
    if (width === 1440) {
      const local = [], external = [], missingAnchors = [];
      for (const link of state.links) {
        const url = new URL(link.href, reportUrl);
        if (url.origin !== origin) { external.push(link); continue; }
        const filename = path.resolve(root, `.${decodeURIComponent(url.pathname)}`);
        const exists = existsSync(filename) && statSync(filename).isFile();
        const response = exists ? await page.request.head(url.href) : undefined;
        local.push({ ...link, exists, status: response?.status() });
        if (url.hash && exists) {
          const fragment = decodeURIComponent(url.hash.slice(1));
          const found = url.pathname === new URL(reportUrl).pathname
            ? await page.evaluate(id => Boolean(document.getElementById(id) || document.querySelector(`[name="${CSS.escape(id)}"]`)), fragment)
            : readFileSync(filename, 'utf8').includes(`id="${fragment}"`) || readFileSync(filename, 'utf8').includes(`name="${fragment}"`);
          if (!found) missingAnchors.push(link);
        }
      }
      qa.links = { local, externalNotFetched: external, missingAnchors };
      check('all local evidence links resolve with HTTP 200', local.length > 0 && local.every(link => link.exists && link.status === 200));
      check('local fragment anchors resolve', missingAnchors.length === 0, { checked: local.filter(link => link.href.includes('#')).length, missingAnchors });
    }
    for (const [section, heading] of [['top', null], ['performance', '封裝 Renderer 前後比較'], ['gates', '逐項回應時間門檻'], ['idle', '本機 Git 閒置與確認方式'], ['pending', '驗收限制與待驗']]) {
      const filename = `report-${width}-${section}.png`;
      await page.evaluate(() => window.scrollTo(0, 0));
      const clip = heading ? await page.evaluate(name => {
        const headings = [...document.querySelectorAll('h2')], index = headings.findIndex(element => element.textContent.trim() === name);
        if (index < 0) throw new Error(`Missing report section: ${name}`);
        const top = Math.max(0, Math.floor(headings[index].getBoundingClientRect().top + window.scrollY) - 12);
        const end = headings[index + 1]?.getBoundingClientRect().top + window.scrollY || document.documentElement.scrollHeight;
        return { x: 0, y: top, width: innerWidth, height: Math.ceil(end - top) };
      }, heading) : undefined;
      await page.screenshot({ path: path.join(evidence, filename), ...(clip ? { clip, fullPage: true } : {}) });
      qa.screenshots.push(`evidence/${filename}`);
    }
    await context.close();
  }
  check('report and verification did not change during QA', sha(readFileSync(htmlFile)) === qa.reportSha256 && sha(readFileSync(verificationFile)) === qa.verificationSha256);
  qa.status = qa.checks.every(value => value.status === 'PASS') ? 'PASS' : 'FAIL';
} catch (error) {
  qa.status = 'FAIL'; qa.error = error.stack ?? error.message;
} finally {
  await browser?.close();
  await new Promise(resolve => server.close(resolve));
  writeFileSync(path.join(evidence, 'report-qa.json'), JSON.stringify(qa, null, 2) + '\n');
}
console.log(JSON.stringify({ status: qa.status, checks: qa.checks.length, failures: qa.checks.filter(value => value.status !== 'PASS'), screenshots: qa.screenshots, error: qa.error }, null, 2));
if (qa.status !== 'PASS') process.exitCode = 1;
