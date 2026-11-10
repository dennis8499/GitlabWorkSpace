import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

const html = '<html><head></head><body><script src="app.js"></script></body></html>';
const uri = (fsPath: string) => ({ fsPath, toString: () => fsPath.replaceAll('\\', '/') });

function load(vscode: unknown, read?: () => Promise<string>): any {
  const filename = path.resolve(__dirname, '../../../src/quickActionsView.js');
  const nativeRequire = createRequire(filename), exports = {};
  vm.runInNewContext(readFileSync(filename, 'utf8'), { exports, Buffer, process, Error, AbortController,
    require: (name: string) => name === 'vscode' ? vscode : name === 'node:fs/promises' && read
      ? { ...nativeRequire(name), readFile: read } : nativeRequire(name)
  });
  return exports;
}

test('a failed legacy sidebar asset load releases listeners and permits resolving the view again', async () => {
  let missing = true;
  const { QuickActionsViewProvider } = load({ Uri: { joinPath: (base: { fsPath: string }, ...parts: string[]) => uri(path.join(base.fsPath, ...parts)) } },
    async () => { if (missing) throw new Error('ENOENT'); return html; });
  const sidebar = new QuickActionsViewProvider(uri('extension'), {}, () => {});
  const listeners = new Set<() => void>();
  const listen = (callback: () => void) => { listeners.add(callback); return { dispose: () => listeners.delete(callback) }; };
  const view = { visible: true, onDidDispose: listen, onDidChangeVisibility: listen,
    webview: { html: '', options: {}, cspSource: 'test:', asWebviewUri: (value: unknown) => value,
      onDidReceiveMessage: listen, postMessage: async () => true } };
  await assert.rejects(sidebar.resolveWebviewView(view), /無法載入工作台導覽/);
  assert.equal(listeners.size, 0);
  missing = false;
  await sidebar.resolveWebviewView(view);
  assert.match(view.webview.html, /app.js/);
  sidebar.dispose();
  assert.equal(listeners.size, 0);
});

test('a legacy virtual sidebar does not refresh or read local repository details', async t => {
  let detailReads = 0, refreshes = 0;
  const { QuickActionsViewProvider } = load({ workspace: { workspaceFolders: [{ uri: { scheme: 'vscode-vfs' } }] } });
  const sidebar = new QuickActionsViewProvider({}, { connectionEpoch: 1 }, () => {}, undefined,
    async () => { detailReads++; }, undefined, undefined, () => 'scope', () => ({}), async () => { refreshes++; });
  t.after(() => sidebar.dispose());
  const messages: any[] = [];
  sidebar.view = { visible: true, webview: { postMessage: async (message: unknown) => { messages.push(message); return true; } } };
  await sidebar.refreshRepositories();
  await sidebar.loadRepositoryDetails('repo', 'detail');
  assert.equal(refreshes, 0); assert.equal(detailReads, 0);
  assert.equal(messages.find(message => message.type === 'state').state.workspaceCapabilities.isVirtualWorkspace, true);
  assert.match(messages.find(message => message.type === 'repositoryDetails').error, /磁碟/);
});
