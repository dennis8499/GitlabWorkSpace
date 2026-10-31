'use strict';
const vscode = require('vscode');
const fs = require('node:fs');
const { performance } = require('node:perf_hooks');
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const emit = (event, fields = {}) => fs.appendFileSync(process.env.GLW_AUDIT_EVENTS, JSON.stringify({ event, at: Date.now(), ...fields }) + '\n');
const tabs = () => vscode.window.tabGroups.all.flatMap(group => group.tabs)
  .map(tab => ({ label: tab.label, active: tab.isActive, viewType: tab.input?.viewType, inputType: tab.input?.constructor?.name }));
const dashboardTab = () => tabs().find(tab => tab.viewType?.endsWith('gitlabWorkspace.dashboard'));
async function waitForTab(present) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    const tab = dashboardTab();
    if (present ? tab?.active : !tab) return;
    await wait(50);
  }
  throw new Error(`Dashboard tab did not become ${present ? 'active' : 'closed'}: ${JSON.stringify(tabs())}`);
}

exports.activate = async function activate() {
  try {
    emit('probe-activated', { hostPid: process.pid });
    const extension = vscode.extensions.getExtension('local-dev.gitlab-workspace');
    if (!extension) throw new Error('The isolated VSIX was not discovered.');
    await extension.activate();
    emit('extension-activated', { hostPid: process.pid, memory: process.memoryUsage() });
    const initial = performance.now();
    await vscode.commands.executeCommand('gitlabWorkspace.openWorkspace');
    emit('workspace-command-returned', { elapsedMs: performance.now() - initial, hostPid: process.pid, memory: process.memoryUsage(), tabs: tabs() });
    await waitForTab(true);
    emit('workspace-tab-active', { hostPid: process.pid, memory: process.memoryUsage() });
    if (process.env.GLW_AUDIT_LONG === '1') {
      for (let i = 0; i < 30; i++) {
        await wait(400);
        await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
        await waitForTab(false);
        await wait(200);
        await vscode.commands.executeCommand('gitlabWorkspace.openWorkspace');
        await waitForTab(true);
        emit('reopen-command-returned', { iteration: i + 1, memory: process.memoryUsage() });
      }
      emit('idle-start', { memory: process.memoryUsage() });
      const end = Date.now() + 600000;
      while (Date.now() < end) {
        await wait(10000);
        emit('host-memory', { memory: process.memoryUsage() });
      }
      emit('idle-complete', { memory: process.memoryUsage() });
    }
    emit('probe-complete');
    await vscode.commands.executeCommand('workbench.action.quit');
  } catch (error) {
    emit('probe-error', { error: String(error && error.stack || error) });
    await vscode.commands.executeCommand('workbench.action.quit');
  }
};
