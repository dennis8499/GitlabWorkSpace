import { readFile, writeFile, access } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import { chromium } from 'playwright-core';

const evidenceDir = path.dirname(fileURLToPath(import.meta.url));
const reportPath = path.resolve(evidenceDir, '../report.html');
const reportUrl = pathToFileURL(reportPath);
const source = await readFile(reportPath, 'utf8');
const dom = new JSDOM(source);
const failures = [];
const checked = new Set();
for (const element of dom.window.document.querySelectorAll('[href], [src]')) {
  const raw = element.getAttribute('href') ?? element.getAttribute('src');
  if (!raw || checked.has(raw)) continue;
  checked.add(raw);
  const target = new URL(raw, reportUrl);
  if (target.protocol !== 'file:') continue;
  try {
    const file = fileURLToPath(target);
    await access(file);
    if (target.hash && path.resolve(file) === reportPath && !dom.window.document.getElementById(decodeURIComponent(target.hash.slice(1)))) {
      failures.push({ target: raw, error: 'missing anchor' });
    }
  } catch { failures.push({ target: raw, error: 'missing file' }); }
}
const browser = await chromium.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
const views = [];
try {
  const page = await browser.newPage();
  page.on('pageerror', error => failures.push({ error: error.message }));
  for (const width of [1440, 800]) {
    await page.setViewportSize({ width, height: 1000 });
    await page.goto(reportUrl.href);
    await page.locator('h1').waitFor();
    // The report deliberately lazy-loads below-the-fold evidence. Explicitly
    // decode every image for this asset check, without changing the HTML file.
    const decodeFailures = await page.evaluate(async () => {
      const results = await Promise.all([...document.images].map(async img => {
        img.loading = 'eager';
        try { await img.decode(); return undefined; }
        catch { return img.getAttribute('src'); }
      }));
      return results.filter(Boolean);
    });
    for (const target of decodeFailures) failures.push({ width, target, error: 'image decode failed' });
    const layout = await page.evaluate(() => ({
      width: innerWidth, scrollWidth: document.documentElement.scrollWidth,
      imagesLoaded: [...document.images].every(img => img.complete && img.naturalWidth > 0)
    }));
    if (layout.scrollWidth > layout.width || !layout.imagesLoaded) failures.push({ width, error: 'overflow or missing image', layout });
    const screenshot = `report-${width}.png`;
    await page.screenshot({ path: path.join(evidenceDir, screenshot) });
    views.push({ ...layout, screenshot });
  }
} finally { await browser.close(); }
const result = { schema: 'GitLabWorkspaceReportQA/v1', status: failures.length ? 'FAIL' : 'PASS', generatedAt: new Date().toISOString(), checkedReferences: checked.size, views, failures };
await writeFile(path.join(evidenceDir, 'report-qa.json'), JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify(result));
if (failures.length) process.exitCode = 1;
