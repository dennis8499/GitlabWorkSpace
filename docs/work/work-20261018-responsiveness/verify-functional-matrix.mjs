import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from 'playwright-core';

// Document QA only: no extension, product tests, build or benchmark is launched.
const folder = path.dirname(fileURLToPath(import.meta.url));
const matrixPath = path.join(folder, 'feature-matrix.json');
const htmlPath = path.join(folder, 'functional-matrix.html');
const matrixBytes = readFileSync(matrixPath);
const matrix = JSON.parse(matrixBytes.toString('utf8'));
const expected = matrix.features;
const errors = [];
const networkRequests = [];
const browser = await chromium.launch({ headless: true,
  executablePath: process.env.CHROME_EXECUTABLE_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe' });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, colorScheme: 'light' });
page.on('pageerror', error => errors.push(error.message));
page.on('request', request => { if (/^https?:/.test(request.url())) networkRequests.push(request.url()); });
const rows = () => page.locator('#rows > tr:not(.group):not(.empty)').count();
const result = { schema: 'GitLabWorkspaceFunctionalMatrixCheck/v2', checkedAt: new Date().toISOString(),
  command: 'node docs/work/work-20261018-responsiveness/verify-functional-matrix.mjs',
  browser: browser.version(), scope: 'Offline documentation only; no product, Git, API or performance tests.',
  matrixSha256: createHash('sha256').update(matrixBytes).digest('hex'),
  htmlSha256: createHash('sha256').update(readFileSync(htmlPath)).digest('hex'),
  featureCount: expected.length, evidenceRunCount: matrix.evidenceRuns.length, viewports: [] };
try {
  await page.goto(pathToFileURL(htmlPath).href);
  assert.equal(new URL(page.url()).protocol, 'file:');
  assert.equal(await rows(), 57);
  const title = await page.locator('h1').innerText();
  assert.ok(title.includes('\u529f\u80fd\u9a57\u8b49\u77e9\u9663'));
  assert.equal(await page.evaluate(() => document.characterSet.toUpperCase()), 'UTF-8');
  assert.equal(await page.locator('body').innerText().then(text => text.includes('\ufffd')), false);
  assert.deepEqual(await page.locator('#matrix-data').evaluate(node => JSON.parse(node.textContent)), matrix);
  result.utf8Chinese = 'passed';
  result.embeddedJson = 'identical';
  result.groupCount = await page.locator('#rows > .group').count();
  assert.equal(result.groupCount, 11);
  const filters = {
    offline: f => f.offlineStatus === 'pending', passed: f => f.offlineStatus === 'passed',
    native: f => f.liveStatus.NativeGit === 'pending', live: f => f.liveStatus.liveGitLab === 'pending',
    pending: f => f.offlineStatus === 'pending' || Object.values(f.liveStatus).includes('pending')
      || Object.values(f.scenarios).some(s => s.status === 'pending')
  };
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 });
    const checks = { width, filters: {} };
    for (const [name, predicate] of Object.entries(filters)) {
      await page.selectOption('#filter', name);
      checks.filters[name] = await rows();
      assert.equal(checks.filters[name], expected.filter(predicate).length, name);
    }
    await page.selectOption('#filter', 'all');
    await page.selectOption('#group', { label: 'BMAD' });
    assert.equal(await rows(), 2);
    await page.selectOption('#group', '');
    const query = '\u9644\u4ef6';
    await page.fill('#search', query);
    checks.searchMatches = await rows();
    assert.equal(checks.searchMatches, expected.filter(f => JSON.stringify([f.label, f.id, f.source, f.testFiles, f.notes]).toLocaleLowerCase().includes(query)).length);
    assert.ok(checks.searchMatches > 0 && checks.searchMatches < expected.length);
    await page.fill('#search', 'no-such-feature-qa');
    assert.equal(await rows(), 0);
    assert.equal(await page.locator('#rows > .empty').count(), 1);
    await page.fill('#search', '');
    assert.equal(await rows(), 57);
    checks.documentScrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
    assert.ok(checks.documentScrollWidth <= width + 1, 'Body must fit viewport');
    const table = page.locator('.table-wrap');
    checks.table = await table.evaluate(node => ({ width: node.clientWidth, contentWidth: node.scrollWidth }));
    if (width === 390) {
      assert.ok(checks.table.contentWidth > checks.table.width);
      await table.evaluate(node => { node.scrollLeft = node.scrollWidth; });
      assert.ok(await table.evaluate(node => node.scrollLeft > 0));
      await table.evaluate(node => { node.scrollLeft = 0; });
    }
    checks.screenshot = `functional-matrix-${width}.png`;
    await page.screenshot({ path: path.join(folder, 'evidence', checks.screenshot) });
    result.viewports.push(checks);
  }
  await page.locator('#file').setInputFiles({ name: 'invalid.json', mimeType: 'application/json', buffer: Buffer.from('{invalid') });
  await page.waitForFunction(() => document.getElementById('error').textContent.length > 0);
  const changed = { ...matrix, updatedAt: '2099-01-01' };
  await page.locator('#file').setInputFiles({ name: 'changed.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(changed)) });
  await page.waitForFunction(() => document.getElementById('count').textContent.includes('2099-01-01'));
  await page.locator('#file').setInputFiles(matrixPath);
  await page.waitForFunction(updatedAt => document.getElementById('error').textContent === ''
    && document.getElementById('count').textContent.includes(updatedAt), matrix.updatedAt);
  assert.equal(await rows(), 57);
  result.invalidJson = 'visible error';
  result.jsonReload = 'changed data applied, then original restored';
  const links = await page.locator('a[href]').evaluateAll(nodes => nodes.map(node => node.href));
  const local = links.filter(href => href.startsWith('file:') && !new URL(href).hash);
  result.validFileLinks = local.length;
  result.missingFiles = local.map(href => fileURLToPath(href)).filter(name => !existsSync(name));
  result.missingAnchors = await page.locator('a[href^="#run-"]').evaluateAll(nodes => nodes.map(node => node.hash.slice(1))
    .filter(id => !document.getElementById(decodeURIComponent(id))));
  assert.deepEqual(result.missingFiles, []);
  assert.deepEqual(result.missingAnchors, []);
  assert.deepEqual(errors, []);
  assert.deepEqual(networkRequests, []);
  result.pageErrors = errors;
  result.externalRequests = networkRequests;
  result.status = 'PASS';
} catch (error) {
  result.status = 'FAIL'; result.error = error.stack || String(error);
  process.exitCode = 1;
} finally {
  await browser.close();
  writeFileSync(path.join(folder, 'evidence/functional-matrix-check.json'), JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify(result));
}
