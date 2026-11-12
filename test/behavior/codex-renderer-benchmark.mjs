// Production-bundle benchmark with a synthetic Host. Never connects to GitLab or Codex.
/* global window, document, requestAnimationFrame */
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { chromium } from 'playwright-core';
import { createWebviewCsp } from '../../out/src/webviewSecurity.js';
import { readWebviewAssets } from '../../scripts/webview-assets.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const option = (name, fallback) => { const index = process.argv.indexOf(name); return index < 0 ? fallback : process.argv[index + 1]; };
const counts = option('--counts', '2000,10000').split(',').map(Number), samples = Number(option('--samples', '30'));
assert.ok(counts.every(count => Number.isSafeInteger(count) && count > 0 && count <= 10_000));
assert.ok(Number.isSafeInteger(samples) && samples >= 3 && samples <= 300 && samples % 3 === 0);
const baseline = option('--baseline-root'), destination = option('--out');
const roots = [...(baseline ? [{ label: 'before', directory: path.resolve(baseline) }] : []), { label: 'after', directory: path.resolve(option('--bundle-root', root)) }];
const source = await readFile(path.join(root, 'test/behavior/dashboard.test.mjs'), 'utf8');
const ast = ts.createSourceFile('fixtures.mjs', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
const functions = ast.statements.filter(node => ts.isFunctionDeclaration(node) && ['project', 'snapshot'].includes(node.name?.text)).map(node => node.getText(ast));
assert.equal(functions.length, 2, 'Dashboard fixture functions changed; review the benchmark fixture.');
const snapshot = new Function(functions.join('\n') + '; return snapshot;')();
const theme = ':root{--vscode-foreground:#ccc;--vscode-editor-background:#1f1f1f;--vscode-sideBar-background:#181818;--vscode-descriptionForeground:#9d9d9d;--vscode-focusBorder:#0078d4;--vscode-button-background:#0078d4;--vscode-button-foreground:#fff;--vscode-input-background:#313131;--vscode-input-foreground:#ccc;--vscode-panel-border:#444;--vscode-font-family:Segoe UI,sans-serif;--vscode-font-size:13px;--vscode-editor-font-family:Consolas,monospace;}';
const browser = await chromium.launch({ headless: true, ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : { channel: 'chrome' }) });
const measurements = [], checks = [], layoutChecks = [];
const percentile = (values, fraction) => [...values].sort((a, b) => a - b)[Math.min(values.length - 1, Math.ceil(values.length * fraction) - 1)];
const settle = page => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(resolve))))));
const send = (page, data) => page.evaluate(data => window.dispatchEvent(new MessageEvent('message', { data })), data);
const task = id => ({ id, title: `Synthetic task ${id}`, root: 'C:/fixture', status: 'completed', threadId: 'thread-' + id, turnId: 'turn',
  createdAt: '2026-11-06T00:00:00Z', updatedAt: '2026-11-06T00:00:00Z', controls: { canResume: true, canDelete: true, canAutoAccept: true } });
const entries = (count, id = 'a') => Array.from({ length: count }, (_, index) => ({ id: String(index), threadId: 'thread-' + id, turnId: 'turn', kind: 'agent', text: `Reply ${index}\n${'Synthetic content '.repeat(index % 4 + 1)}`, final: true }));

async function mount(target, saved = { mode: 'codex' }) {
  const assets = await readWebviewAssets(path.join(target.directory, 'resources/issue-webview'), { allowLegacy: target.label === 'before' });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, reducedMotion: 'reduce' }), page = await context.newPage();
  const errors = [], external = [];
  page.on('pageerror', error => errors.push(String(error)));
  await page.route('**/*', async route => {
    const url = new URL(route.request().url()), name = url.pathname.slice(1);
    if (url.hostname !== '127.0.0.1' || !assets.has(name) && name !== 'theme.css') { external.push(url.origin); await route.abort(); return; }
    let body = name === 'theme.css' ? theme : assets.get(name);
    if (name === 'dashboard.html') body = body.toString().replace('<head>', `<head><meta http-equiv="Content-Security-Policy" content="${createWebviewCsp("'self'", 'benchmark', 'dashboard')}"><link rel="stylesheet" href="/theme.css">`).replace(/<script\b/g, '<script nonce="benchmark"');
    await route.fulfill({ contentType: name.endsWith('.js') ? 'application/javascript' : name.endsWith('.css') ? 'text/css' : name.endsWith('.ttf') ? 'font/ttf' : 'text/html', body });
  });
  await page.addInitScript(saved => {
    window.benchmarkRequests = []; window.benchmarkSaved = saved; window.benchmarkCsp = [];
    window.addEventListener('securitypolicyviolation', event => window.benchmarkCsp.push(event.violatedDirective));
    window.acquireVsCodeApi = () => ({ getState: () => window.benchmarkSaved, setState: value => { window.benchmarkSaved = value; }, postMessage: message => {
      window.benchmarkRequests.push(message);
      if (message.operationId) queueMicrotask(() => window.dispatchEvent(new MessageEvent('message', { data: { type: 'operationChanged', operation: {
        requestId: message.operationId, scopeRevision: message.operationScope, resourceKey: 'codex:' + message.taskId,
        action: message.type, label: 'Synthetic read', kind: 'read', status: 'succeeded', effect: 'none', phase: 'Done', startedAt: Date.now(), finishedAt: Date.now()
      } } })));
    } });
  }, saved);
  await page.goto('http://127.0.0.1:7777/dashboard.html');
  await page.waitForFunction(() => window.benchmarkRequests.some(message => message.type === 'ready'));
  await send(page, { type: 'snapshot', snapshot: snapshot('codex') });
  await settle(page); // Let the visible page install its Host event listener.
  await send(page, { type: 'codexEvent', event: { kind: 'tasks', tasks: [task('a'), task('b')] } });
  await page.getByRole('button', { name: /Synthetic task a/ }).waitFor();
  await settle(page);
  const bundleHash = createHash('sha256');
  for (const [name, bytes] of [...assets].sort(([left], [right]) => left.localeCompare(right))) bundleHash.update(name + '\0').update(bytes);
  return { page, context, errors, external, bundleSha256: bundleHash.digest('hex') };
}
async function geometry(page) {
  return page.evaluate(() => {
    const root = document.querySelector('.codex-output'), bounds = root.getBoundingClientRect();
    const row = [...root.querySelectorAll('[data-virtual-key]')].find(row => row.getBoundingClientRect().bottom > bounds.top && row.getBoundingClientRect().top < bounds.bottom);
    return { top: root.scrollTop, key: row?.dataset.virtualKey, offset: row ? row.getBoundingClientRect().top - bounds.top : undefined };
  });
}
async function functional(target, view, count) {
  const { page } = view;
  await page.locator('.codex-output').evaluate(node => { node.scrollTop = node.scrollHeight / 2; }); await settle(page);
  const before = await geometry(page);
  assert.ok(before.key, 'the scroll region has a visible logical anchor');
  await page.locator('.mode-navigation [data-mode="clone"]').click(); await settle(page);
  await send(page, { type: 'codexEvent', event: { kind: 'output', taskId: 'a', items: [{ id: String(count - 1), threadId: 'thread-a', turnId: 'turn', kind: 'agent', text: 'Hidden streamed reply', final: true }], replace: true } });
  await send(page, { type: 'codexEvent', event: { kind: 'tasks', tasks: [task('a'), task('b')] } }); await settle(page);
  await page.locator('.mode-navigation [data-mode="codex"]').click(); await settle(page);
  const revealed = await geometry(page);
  assert.equal(revealed.key, before.key, 'hidden task updates preserve the visible message when reopened');
  assert.ok(Math.abs(revealed.offset - before.offset) <= 2, `hidden task updates preserve the intra-row offset: ${JSON.stringify({ before, revealed })}`);
  const saved = await page.evaluate(() => window.benchmarkSaved);
  await page.getByRole('button', { name: /Synthetic task b/ }).click(); await settle(page);
  await page.getByRole('button', { name: /Synthetic task a/ }).click(); await settle(page);
  const switched = await geometry(page);
  assert.equal(switched.key, before.key, 'task switches preserve the visible message');
  assert.ok(Math.abs(switched.offset - before.offset) <= 2, 'task switches preserve the intra-row offset');
  const restored = await mount(target, saved);
  try {
    await send(restored.page, { type: 'codexEvent', event: { kind: 'history', taskId: 'a', items: entries(count), nextCursor: 'older' } }); await settle(restored.page);
    const reopened = await geometry(restored.page);
    assert.equal(reopened.key, before.key, 'Webview restoration preserves the visible message');
    assert.ok(Math.abs(reopened.offset - before.offset) <= 2, 'Webview restoration preserves the intra-row offset');
  } finally { await restored.context.close(); }
  // Dispatch the read without Playwright scrolling the offscreen header into
  // view; the user can keep reading while a history request is pending.
  await page.getByRole('button', { name: '讀取更早的對話', exact: true }).evaluate(button => button.click());
  await send(page, { type: 'codexEvent', event: { kind: 'history', taskId: 'a', cursor: 'older', items: entries(100).map(item => ({ ...item, id: 'earlier-' + item.id })) } });
  await settle(page);
  const prepended = await geometry(page);
  assert.equal(prepended.key, before.key, 'history prepends preserve the visible message');
  assert.ok(Math.abs(prepended.offset - before.offset) <= 2, `history prepends preserve the intra-row offset: ${JSON.stringify({ before, prepended })}`);
  await send(page, { type: 'codexEvent', event: { kind: 'output', taskId: 'a', items: [{ id: 'latest', threadId: 'thread-a', turnId: 'turn', kind: 'agent', text: 'New streamed reply', final: true }], replace: true } });
  await settle(page);
  const streamed = await geometry(page);
  assert.equal(streamed.key, before.key, 'streaming leaves an unfollowed reading anchor in place');
  assert.ok(Math.abs(streamed.offset - before.offset) <= 2, 'streaming preserves the intra-row offset');
  await page.getByRole('button', { name: '回到最新', exact: true }).click(); await settle(page);
  assert.equal(await page.evaluate(() => document.activeElement?.textContent?.includes('New streamed reply')), true, 'jumping to latest focuses the newest mounted reply');
  const focus = page.locator('.codex-transcript .codex-copy').first(); await focus.focus();
  await page.evaluate(() => { window.benchmarkFocus = document.activeElement; document.querySelector('.codex-output').scrollTop = 0; }); await settle(page);
  assert.equal(await page.evaluate(() => document.activeElement === window.benchmarkFocus), true, 'virtual scrolling retains the focused reply');
  assert.ok(await page.locator('.codex-transcript .virtual-list-row').count() < 100);
  checks.push({ count, hiddenUpdateAnchor: true, taskSwitchAnchor: true, restoredAnchor: true, historyPrependAnchor: true, streamingAnchor: true, jumpLatestFocus: true, pinnedFocus: true });
}

// Start observing before the mutation: waiting for a settled screenshot misses
// the frames where new or growing rows still have their previous cached height.
async function verifyLayoutFrames(page, count, stage, mutate) {
  await page.evaluate(() => {
    window.benchmarkLayoutFrames = [];
    const capture = () => {
      const rows = [...document.querySelectorAll('.codex-transcript [data-virtual-index]')];
      const boxes = rows.map(row => row.getBoundingClientRect());
      let rowOverlap = 0, textOverflow = 0, controlOverlap = 0;
      for (let index = 1; index < boxes.length; index++) rowOverlap = Math.max(rowOverlap, boxes[index - 1].bottom - boxes[index].top);
      for (const pre of document.querySelectorAll('.codex-item .codex-markdown, .codex-item pre, .codex-interaction pre')) {
        const range = document.createRange(); range.selectNodeContents(pre);
        textOverflow = Math.max(textOverflow, range.getBoundingClientRect().bottom - pre.getBoundingClientRect().bottom);
        const controls = pre.closest('.codex-interaction')?.querySelector('.button-row');
        if (controls) controlOverlap = Math.max(controlOverlap, range.getBoundingClientRect().bottom - controls.getBoundingClientRect().top);
      }
      window.benchmarkLayoutFrames.push({ total: Number(rows[0]?.getAttribute('aria-setsize') ?? 0), mounted: rows.length, rowOverlap, textOverflow, controlOverlap });
      window.benchmarkLayoutFrame = requestAnimationFrame(capture);
    };
    window.benchmarkLayoutFrame = requestAnimationFrame(capture);
  });
  let frames;
  try {
    await mutate();
    await page.evaluate(() => new Promise(resolve => {
      let remaining = 6;
      const next = () => { if (--remaining) requestAnimationFrame(next); else resolve(); };
      requestAnimationFrame(next);
    }));
  } finally {
    frames = await page.evaluate(() => { window.cancelAnimationFrame(window.benchmarkLayoutFrame); return window.benchmarkLayoutFrames; });
  }
  assert.ok(frames.filter(frame => frame.total === count).length >= 3, `${stage}: the expected transcript must be rendered during the probe`);
  for (const frame of frames) {
    assert.ok(frame.rowOverlap <= 1, `${stage}: adjacent mounted rows overlap: ${JSON.stringify(frame)}`);
    assert.ok(frame.textOverflow <= 1, `${stage}: visible text overflows its layout box: ${JSON.stringify(frame)}`);
    assert.ok(frame.controlOverlap <= 1, `${stage}: interaction text covers its controls: ${JSON.stringify(frame)}`);
    if (frame.total > 200) assert.ok(frame.mounted < 100, `${stage}: long conversations must remain windowed`);
  }
  layoutChecks.push({ count, stage, frames });
}

const longText = (label, lines = 50) => Array.from({ length: lines }, (_, index) => `${label} line ${index + 1}: long conversation content`).join('\n');
const variableEntries = count => entries(count).map((item, index) => ({ ...item,
  kind: index !== 0 && index !== count - 1 && index % 5 === 0 ? 'command' : 'agent', command: 'synthetic command',
  text: longText(`Reply ${index}`, index % 5 === 0 ? 25 : 1 + index % 9)
}));

async function layoutRegression(target) {
  const longView = await mount(target), longPage = longView.page;
  try {
    await verifyLayoutFrames(longPage, 2, 'two-long-replies', () => send(longPage, { type: 'codexEvent', event: {
      kind: 'history', taskId: 'a', reset: true, items: entries(2).map(item => ({ ...item, text: longText(item.id) }))
    } }));
    assert.ok(await longPage.locator('.codex-item .codex-markdown').first().evaluate(node => node.getBoundingClientRect().height) > 360,
      'long messages must grow beyond the dashboard code-block height limit');
    await verifyLayoutFrames(longPage, 2, 'long-interaction-detail', () => send(longPage, { type: 'codexEvent', event: {
      kind: 'interactions', taskId: 'a', interactions: [{ id: 'long-approval', taskId: 'a', kind: 'command', title: 'Synthetic approval', detail: longText('Approval') }]
    } }));
    assert.ok(await longPage.locator('.codex-interaction pre').evaluate(node => node.getBoundingClientRect().height) > 360,
      'long approval details must grow before the controls');
    assert.deepEqual(longView.errors, []); assert.deepEqual(longView.external, []);
    assert.deepEqual(await longPage.evaluate(() => window.benchmarkCsp), []);
  } finally { await longView.context.close(); }

  for (const count of [200, 201, 300, 10_000]) {
    const view = await mount(target), { page } = view, items = variableEntries(count);
    try {
      await verifyLayoutFrames(page, count, `${count}-initial`, () => send(page, { type: 'codexEvent', event: { kind: 'history', taskId: 'a', reset: true, items } }));
      if (count === 200) {
        await verifyLayoutFrames(page, 201, 'threshold-up', () => send(page, { type: 'codexEvent', event: {
          kind: 'output', taskId: 'a', items: [{ ...items[0], id: '200', text: longText('Threshold') }], replace: true
        } }));
        await verifyLayoutFrames(page, 200, 'threshold-down', () => send(page, { type: 'codexEvent', event: { kind: 'history', taskId: 'a', reset: true, items } }));
      }
      const growingId = await page.evaluate(() => {
        const rows = [...document.querySelectorAll('.codex-transcript [data-virtual-key]')];
        const row = rows.slice(0, -1).find(row => row.querySelector('.codex-item.agent'));
        return row ? JSON.parse(row.dataset.virtualKey)[2] : undefined;
      });
      assert.ok(growingId, 'the variable transcript contains a mounted reply before its neighbour');
      await verifyLayoutFrames(page, count, `${count}-stream-growth`, () => send(page, { type: 'codexEvent', event: {
        kind: 'output', taskId: 'a', items: [{ ...items[Number(growingId)], text: longText('Growing reply', 60) }], replace: true
      } }));
      const expand = page.locator('.codex-transcript button[aria-expanded="false"]').first();
      assert.ok(await expand.count(), 'the mounted variable-height window contains expandable output');
      await verifyLayoutFrames(page, count, `${count}-expand`, () => expand.evaluate(button => button.click()));
      await verifyLayoutFrames(page, count, `${count}-narrow`, () => page.setViewportSize({ width: 320, height: 900 }));
      await verifyLayoutFrames(page, count, `${count}-wide`, () => page.setViewportSize({ width: 1280, height: 900 }));
      await page.locator('.codex-reading-actions button').first().evaluate(button => button.click()); await settle(page);
      await verifyLayoutFrames(page, count, `${count}-last-reply-growth`, () => send(page, { type: 'codexEvent', event: {
        kind: 'output', taskId: 'a', items: [{ ...items[count - 1], text: longText('Latest growing reply', 60) }], replace: true
      } }));
      assert.ok(await page.locator('.codex-output').evaluate(node => node.scrollHeight - node.scrollTop - node.clientHeight <= 2),
        'following the latest reply must stay at the bottom while that reply grows');
      assert.deepEqual(view.errors, []); assert.deepEqual(view.external, []);
      assert.deepEqual(await page.evaluate(() => window.benchmarkCsp), []);
    } finally { await view.context.close(); }
  }
}

try {
  for (let round = 0; round < 3; round++) for (const count of counts) for (const target of round % 2 ? [...roots].reverse() : roots) {
    console.log(JSON.stringify({ stage: 'start', label: target.label, count, round }));
    const view = await mount(target), { page } = view;
    try {
      // Seed the same live batches in both builds. The former history merger
      // has a cubic anchor search for one entirely new large history packet.
      await page.evaluate(items => {
        for (let index = 0; index < items.length; index += 100) window.dispatchEvent(new MessageEvent('message', {
          data: { type: 'codexEvent', event: { kind: 'output', taskId: 'a', items: items.slice(index, index + 100), replace: true } }
        }));
      }, entries(count));
      await send(page, { type: 'codexEvent', event: { kind: 'history', taskId: 'a', items: [], nextCursor: 'older' } }); await settle(page);
      const latencies = [];
      for (let sample = 0; sample < samples / 3; sample++) latencies.push(await page.evaluate(async ({ count, sample }) => {
        const items = Array.from({ length: Math.min(100, count) }, (_, offset) => ({ id: String(count - Math.min(100, count) + offset),
          threadId: 'thread-a', turnId: 'turn', kind: 'agent', text: `Updated ${sample} / ${offset}\nSynthetic streamed response`, final: true }));
        const started = performance.now(); window.dispatchEvent(new MessageEvent('message', { data: { type: 'codexEvent', event: { kind: 'output', taskId: 'a', items, replace: true } } }));
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        return performance.now() - started;
      }, { count, sample }));
      const mounted = await page.locator('.codex-item').count(), nodes = await page.locator('*').count(), csp = await page.evaluate(() => window.benchmarkCsp);
      measurements.push({ label: target.label, count, round, latencies, mounted, nodes, bundleSha256: view.bundleSha256, errors: view.errors, external: view.external, csp });
      assert.deepEqual(view.errors, []); assert.deepEqual(csp, []); assert.deepEqual(view.external, []);
      assert.ok(mounted > 0, 'the selected transcript must contain mounted replies');
      if (target.label === 'after') {
        assert.equal(await page.locator('.codex-transcript [aria-setsize]').first().getAttribute('aria-setsize'), String(count), 'the complete transcript remains available');
        assert.ok(mounted < 100 || count <= 200, 'long transcripts must remain windowed');
        if (round === 0 && count === Math.max(...counts)) await functional(target, view, count);
      }
      console.log(JSON.stringify({ label: target.label, count, round, p95Ms: Math.round(percentile(latencies, 0.95)), mounted }));
    } finally { await view.context.close(); }
  }
  for (const count of counts) {
    const values = measurements.filter(row => row.label === 'after' && row.count === count).flatMap(row => row.latencies);
    assert.ok(percentile(values, 0.95) <= 100, `Codex ${count}-item updates must meet the 100ms p95 budget`);
  }
  await layoutRegression(roots.find(target => target.label === 'after'));
} finally {
  const summary = roots.flatMap(target => counts.map(count => {
    const rows = measurements.filter(row => row.label === target.label && row.count === count), latencies = rows.flatMap(row => row.latencies);
    return { label: target.label, count, samples: latencies.length, p50Ms: percentile(latencies, 0.5), p95Ms: percentile(latencies, 0.95), mountedMax: Math.max(...rows.map(row => row.mounted)) };
  }));
  const report = { schema: 'GitLabWorkspaceCodexRendererBenchmark/v1', checkedAt: new Date().toISOString(), browser: browser.version(),
    method: 'Production bundle, synthetic Host, live batches seed the complete transcript; updates dispatch through two animation frames. Layout probes observe every animation frame across long text, threshold changes, streaming, expansion and viewport changes. Excludes OS input, native VS Code bridge and external service latency.', summary, checks, measurements, layoutChecks };
  if (destination) { await mkdir(path.dirname(path.resolve(destination)), { recursive: true }); await writeFile(destination, JSON.stringify(report, null, 2) + '\n'); }
  console.log(JSON.stringify({ summary, checks, layoutChecks: layoutChecks.map(({ count, stage, frames }) => ({ count, stage, frames: frames.length })) })); await browser.close();
}
