import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { inspectHostExecutable, isolatedHostEnvironment, prepareHost } from './extension-test-environment.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const [option, filename] = process.argv.slice(2);
if (option && (option !== '--preflight-file' || !filename)) throw new Error('Usage: test-workspace-trust.mjs [--preflight-file proof.json]');
const proof = filename ? JSON.parse(await readFile(filename, 'utf8')) : await prepareHost();
const inspected = await inspectHostExecutable(proof.executable, proof.requested);
if (inspected.version !== proof.version) throw new Error('The test host changed after preflight');
const tempParent = await realpath(os.tmpdir());
const temporary = await mkdtemp(path.join(tempParent, 'glw-trust-test-'));
const extensions = path.join(temporary, 'extensions'), profile = path.join(temporary, 'profile'), workspace = path.join(temporary, 'project');
const report = path.join(temporary, 'trust-result.json');
const manifest = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
const delivered = path.join(extensions, `${manifest.publisher}.${manifest.name}-${manifest.version}`);
const helper = path.join(extensions, 'local-dev.trust-probe-1.0.0');
let child, browser;
let diagnostics = '';
async function waitFor(check, label) {
  const deadline = Date.now() + 45_000;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${label}. ${diagnostics.slice(-4000)}`);
    await new Promise(resolve => setTimeout(resolve, 100));
  }
}
async function state() {
  try { return JSON.parse(await readFile(report, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT' || error instanceof SyntaxError) return {}; throw error; }
}
try {
  await Promise.all([mkdir(delivered, { recursive: true }), mkdir(helper, { recursive: true }), mkdir(workspace),
    mkdir(path.join(profile, 'User'), { recursive: true })]);
  // Install the prepared production tree as an ordinary extension. Development
  // hosts and @vscode/test-electron disable trust and cannot prove this contract.
  for (const name of ['package.json', 'out/src', 'resources', 'node_modules/yaml', 'node_modules/@iarna/toml']) {
    await cp(path.join(root, name), path.join(delivered, name), { recursive: true });
  }
  await writeFile(path.join(profile, 'User/settings.json'), JSON.stringify({
    'security.workspace.trust.enabled': true, 'security.workspace.trust.startupPrompt': 'never',
    'window.dialogStyle': 'custom', 'workbench.startupEditor': 'none', 'git.autoRepositoryDetection': false,
    'extensions.autoUpdate': false, 'extensions.autoCheckUpdates': false, 'update.mode': 'none', 'telemetry.telemetryLevel': 'off'
  }));
  await writeFile(path.join(helper, 'package.json'), JSON.stringify({ name: 'trust-probe', publisher: 'local-dev', version: '1.0.0',
    engines: { vscode: '^1.90.0' }, main: './index.js', activationEvents: ['onStartupFinished'],
    capabilities: { untrustedWorkspaces: { supported: true } } }));
  await writeFile(path.join(helper, 'index.js'), String.raw`
const vscode = require('vscode'), fs = require('node:fs');
exports.activate = function(context) {
  const filename = process.env.GLW_TRUST_PROBE_REPORT;
  let running = false, rerun = false;
  async function check() {
    if (running) { rerun = true; return; } running = true;
    try {
      const report = fs.existsSync(filename) ? JSON.parse(fs.readFileSync(filename, 'utf8')) : {};
      if (!vscode.workspace.isTrusted) {
        const extension = vscode.extensions.getExtension('local-dev.gitlab-workspace');
        let activationAllowed = false, reason;
        try { if (extension) { await extension.activate(); activationAllowed = extension.isActive; } }
        catch (error) { reason = error.message; }
        report.before = { trusted: false, activationAllowed, reason };
        fs.writeFileSync(filename, JSON.stringify(report));
        await vscode.commands.executeCommand('workbench.trust.manage');
      } else {
        // Verify persisted trust in a fresh host after the native Trust action.
        if (report.before && !report.reloaded) {
          report.reloaded = true;
          fs.writeFileSync(filename, JSON.stringify(report));
          void vscode.commands.executeCommand('workbench.action.reloadWindow').catch(error => {
            // Reload terminates this extension host and cancels its command RPC.
            if (error.name !== 'Canceled' && error.message !== 'Canceled') fs.writeFileSync(filename, JSON.stringify({ error: error.stack }));
          });
          return;
        }
        let extension;
        for (let i = 0; i < 100; i++) {
          extension = vscode.extensions.getExtension('local-dev.gitlab-workspace');
          if (extension) break;
          await new Promise(resolve => setTimeout(resolve, 100));
        }
        if (!extension) throw new Error('The installed target was not enabled after granting trust');
        await extension.activate();
        report.after = { trusted: true, active: extension.isActive };
        fs.writeFileSync(filename, JSON.stringify(report));
      }
    } catch(error) { fs.writeFileSync(filename, JSON.stringify({ error: error.stack })); }
    finally { running = false; if (rerun) { rerun = false; void check(); } }
  }
  context.subscriptions.push(vscode.workspace.onDidGrantWorkspaceTrust(() => { void check(); }));
  void check();
};`);
  const port = await new Promise((resolve, reject) => {
    const server = net.createServer(); server.once('error', reject);
    server.listen(0, '127.0.0.1', () => { const value = server.address().port; server.close(() => resolve(value)); });
  });
  const { env } = isolatedHostEnvironment();
  child = spawn(proof.executable, [workspace, '--new-window', '--skip-welcome', '--skip-release-notes', '--locale=en',
    `--user-data-dir=${profile}`, `--extensions-dir=${extensions}`, `--remote-debugging-port=${port}`],
  { windowsHide: true, env: { ...env, GLW_TRUST_PROBE_REPORT: report }, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', data => { diagnostics = (diagnostics + data).slice(-20_000); });
  child.stderr.on('data', data => { diagnostics = (diagnostics + data).slice(-20_000); });
  await waitFor(async () => {
    const result = await state(); if (result.error) throw new Error(result.error); return result.before;
  }, 'Restricted Mode activation proof');
  assert.equal((await state()).before.activationAllowed, false, 'the installed target cannot activate in Restricted Mode');
  await waitFor(async () => { try { return (await fetch(`http://127.0.0.1:${port}/json/version`)).ok; } catch { return false; } }, 'isolated browser');
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  const page = await waitFor(() => browser.contexts().flatMap(context => context.pages()).find(page => page.url().includes('workbench')), 'workbench page');
  await page.locator('.workspace-trust-editor').getByRole('button', { name: /^Trust(?:\s|$)/ }).first().click({ timeout: 30_000 });
  const granted = await waitFor(async () => {
    const result = await state(); if (result.error) throw new Error(result.error); return result.after;
  }, 'activation after native Trust action');
  assert.equal((await state()).reloaded, true);
  assert.equal(granted.trusted, true); assert.equal(granted.active, true);
  console.log(JSON.stringify({ test: 'workspace-trust', vscode: proof.version, ...(await state()) }));
} finally {
  await browser?.close().catch(() => {});
  if (child?.pid && child.exitCode === null) {
    if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    else child.kill();
  }
  const target = await realpath(temporary);
  // eslint-disable-next-line no-unsafe-finally -- Never remove an unverified cleanup target.
  if (path.dirname(target) !== tempParent || !path.basename(target).startsWith('glw-trust-test-')) throw new Error('Unsafe trust-test cleanup path');
  await rm(target, { recursive: true, force: true, maxRetries: 12, retryDelay: 200 });
}
