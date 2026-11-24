import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import { SnapshotTransport } from '../../src/workspace/snapshotTransport';
import type { WorkspaceResponse, WorkspaceSnapshot } from '../../src/workspace/workspaceProtocol';

const html = '<html><head></head><body><script src="app.js"></script></body></html>';
const uri = (fsPath: string) => ({ fsPath, toString: () => fsPath.replaceAll('\\', '/') });

function surface() {
  const listeners = new Set<() => void>();
  let closed = false;
  const listen = (callback: () => void) => { listeners.add(callback); return { dispose: () => listeners.delete(callback) }; };
  let onDispose = () => {}, onVisibility = () => {};
  return { visible: true, listeners, get closed() { return closed; },
    setVisible(value: boolean) { this.visible = value; onVisibility(); },
    reveal() {},
    dispose() { closed = true; onDispose(); },
    onDidDispose(callback: () => void) { onDispose = callback; return listen(callback); },
    onDidChangeViewState(callback: () => void) { onVisibility = callback; return listen(callback); },
    webview: { html: '', options: {}, cspSource: 'test:', asWebviewUri: (value: unknown) => value,
      onDidReceiveMessage: listen, postMessage: async () => true }
  };
}

function load(relative: string, vscode: unknown, read: () => Promise<string>): any {
  const filename = path.resolve(__dirname, '../../src', relative);
  const nativeRequire = createRequire(filename);
  const exports = {};
  vm.runInNewContext(readFileSync(filename, 'utf8'), { exports, Buffer, process, Error, AbortController,
    require: (name: string) => name === 'vscode' ? vscode : name === 'node:fs/promises'
      ? { ...nativeRequire(name), readFile: read } : nativeRequire(name)
  });
  return exports;
}

function fixture(read: () => Promise<string>) {
  const panels: ReturnType<typeof surface>[] = [];
  const vscode = { Uri: { joinPath: (base: { fsPath: string }, ...parts: string[]) => uri(path.join(base.fsPath, ...parts)) },
    ViewColumn: { Active: 1 }, window: { createWebviewPanel: () => { const panel = surface(); panels.push(panel); return panel; } } };
  const { WorkspacePanel } = load('workspace/workspacePanel.js', vscode, read);
  const host = Object.create(WorkspacePanel.prototype);
  const sent: WorkspaceResponse[] = [];
  const transport = new SnapshotTransport();
  const cached: WorkspaceSnapshot = {
    connected: false, groups: [], projects: [], activeMode: 'dashboard', issues: [], mergeRequests: [],
    groupMilestones: [], groupIssueBoards: [], localRepositories: {}, projectLocalRepositories: {}, projectMembers: [], timers: [],
    workflowKit: { status: 'missing' }, workflowKitInstallTarget: { manual: false, state: { status: 'missing' } }, workflowKitSource: 'github'
  };
  let entries = 0;
  Object.assign(host, { context: { extensionUri: uri('extension') }, activeMode: 'dashboard', disposed: false,
    viewGeneration: 0, viewReadAbort: new AbortController(), pendingViewNotices: [], issueNavigation: null, snapshotTransport: transport,
    sendSnapshot() { const message = transport.next(cached, 'offline'); if (message) sent.push(message); },
    post(message: WorkspaceResponse) { sent.push(message); },
    refresh: async () => { entries++; },
    suspendViewReads() {
      host.viewGeneration++;
      host.webviewReady = false;
      host.viewReadAbort.abort();
    },
    handleMessage(message: unknown) { return host.dispatchMessage(message); },
    scheduleGitRepositoryListSend() {}
  });
  return { host, panels, sent, get entries() { return entries; } };
}

test('a missing Dashboard asset disposes its panel and a repaired build can be opened', async () => {
  let missing = true;
  const f = fixture(async () => { if (missing) throw new Error('ENOENT'); return html; });
  await assert.rejects(f.host.show(), /無法載入工作台介面/);
  assert.equal(f.host.panel, undefined);
  assert.equal(f.panels[0].closed, true);
  missing = false;
  await f.host.show();
  assert.equal(f.panels.length, 2);
  assert.match(f.panels[1].webview.html, /app.js/);
  f.panels[1].dispose();
});

test('closing a Dashboard while its asset is loading cannot restore a dead panel', async () => {
  let resolve!: (value: string) => void;
  const f = fixture(() => new Promise(done => { resolve = done; }));
  const pending = f.host.show();
  f.panels[0].dispose(); resolve(html);
  await pending;
  assert.equal(f.host.panel, undefined);
  assert.equal(f.panels[0].webview.html, '');
});

test('a recreated Dashboard receives a full snapshot and navigation in the same view generation', async () => {
  const f = fixture(async () => html);
  await f.host.show();
  await f.host.handleMessage({ type: 'ready' });
  assert.equal(f.sent[0]?.type, 'snapshot');

  f.sent.length = 0;
  await f.host.handleMessage({ type: 'ready' });
  assert.deepEqual(f.sent.map(message => message.type), ['snapshot', 'issueNavigation']);
  assert.equal(f.host.viewGeneration, 0);
  assert.equal(f.entries, 1);
  assert.equal(f.sent[0].type === 'snapshot' && f.sent[0].snapshot.activeMode, 'dashboard');
});

test('a Dashboard that signals ready while hidden restores once when shown', async () => {
  const f = fixture(async () => html);
  await f.host.show();
  const panel = f.panels[0];
  panel.setVisible(false);
  await f.host.handleMessage({ type: 'ready', projectSource: 'local' });
  assert.equal(f.host.webviewReady, false);
  assert.equal(f.entries, 0);
  assert.equal(f.sent.length, 0);

  panel.setVisible(true);
  panel.setVisible(true);
  assert.equal(f.host.webviewReady, true);
  assert.equal(f.host.viewReadAbort.signal.aborted, false);
  assert.equal(f.host.projectSource, 'local');
  assert.equal(f.sent[0]?.type, 'snapshot');
  await f.host.handleMessage({ type: 'ready' });
  assert.equal(f.entries, 1);
});
