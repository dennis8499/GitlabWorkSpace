import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

const html = '<html><head></head><body><script src="app.js"></script></body></html>';
const uri = (fsPath: string) => ({ fsPath, toString: () => fsPath.replaceAll('\\', '/') });

function surface() {
  const listeners = new Set<() => void>();
  let closed = false;
  const listen = (callback: () => void) => { listeners.add(callback); return { dispose: () => listeners.delete(callback) }; };
  let onDispose = () => {};
  return { visible: true, listeners, get closed() { return closed; },
    reveal() {},
    dispose() { closed = true; onDispose(); },
    onDidDispose(callback: () => void) { onDispose = callback; return listen(callback); },
    onDidChangeViewState: listen, onDidChangeVisibility: listen,
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
  Object.assign(host, { context: { extensionUri: uri('extension') }, activeMode: 'dashboard', disposed: false,
    suspendViewReads() {}, scheduleGitRepositoryListSend() {} });
  return { host, panels };
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
