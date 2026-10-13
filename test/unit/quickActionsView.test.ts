import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import vm from 'node:vm';

const id = 'a'.repeat(32);
const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };

async function fixture() {
  const modulePath = path.resolve(__dirname, '../../src/quickActionsView.js');
  const nativeRequire = createRequire(modulePath);
  const exports: Record<string, any> = {};
  const root = path.resolve(__dirname, '../../..');
  const uri = (fsPath: string) => ({ fsPath, toString: () => fsPath.replaceAll('\\', '/') });
  vm.runInNewContext(readFileSync(modulePath, 'utf8'), { exports, Buffer, process, Error,
    require: (name: string) => name === 'vscode' ? { Uri: { joinPath: (base: { fsPath: string }, ...parts: string[]) => uri(path.join(base.fsPath, ...parts)) } } : nativeRequire(name)
  });
  let receive!: (value: unknown) => void;
  let visibility!: () => void;
  let disposed!: () => void;
  const messages: any[] = [];
  const pending: Array<{ resolve: (value: unknown) => void; reject: (error: Error) => void }> = [];
  let reads = 0;
  const view = { visible: true,
    onDidChangeVisibility: (listener: () => void) => { visibility = listener; return { dispose() {} }; },
    onDidDispose: (listener: () => void) => { disposed = listener; return { dispose() {} }; },
    webview: { options: {}, html: '', cspSource: 'test:',
      asWebviewUri: (value: unknown) => value,
      onDidReceiveMessage: (listener: (value: unknown) => void) => { receive = listener; return { dispose() {} }; },
      postMessage: async (value: unknown) => { messages.push(value); return true; }
    }
  };
  const provider = new exports.QuickActionsViewProvider(uri(root), { accounts: [] }, () => {}, async () => ({ repositories: [{ id, revision: 1 }] }), () => {
    reads++; return new Promise((resolve, reject) => pending.push({ resolve, reject }));
  });
  await provider.resolveWebviewView(view);
  return { provider, view, messages, pending, receive: (value: unknown) => receive(value),
    visibility: (visible: boolean) => { view.visible = visible; visibility(); }, disposeView: () => disposed(), reads: () => reads };
}

test('sidebar host correlates details and cancels work before dispatch or after collapse/hide/dispose', async t => {
  const f = await fixture(); t.after(() => f.provider.dispose());
  const request = (requestId: string) => ({ type: 'repositoryDetails', repositoryId: id, requestId });
  f.receive(request('same-turn'));
  f.receive({ type: 'cancelRepositoryDetails', repositoryId: id });
  await flush(); assert.equal(f.reads(), 0, 'collapse can cancel the queued dispatch');
  f.receive(request('hidden')); await flush(); assert.equal(f.reads(), 1);
  f.visibility(false);
  f.pending[0].resolve({ id, revision: 1, branches: [], stashes: [], recoveryRefs: [] });
  await flush(); assert.equal(f.messages.filter(message => message.type === 'repositoryDetails').length, 0);
  f.receive(request('while-hidden')); await flush(); assert.equal(f.reads(), 1);
  f.visibility(true); await flush();
  f.receive(request('disposed')); await flush();
  f.disposeView();
  f.pending[1].resolve({ id, revision: 1, branches: [], stashes: [], recoveryRefs: [] });
  await flush(); assert.equal(f.messages.filter(message => message.type === 'repositoryDetails').length, 0);
});

test('sidebar host returns current state before details and exposes retryable errors only for the latest request', async t => {
  const f = await fixture(); t.after(() => f.provider.dispose());
  f.receive({ type: 'repositoryDetails', repositoryId: id, requestId: 'old' }); await flush();
  f.receive({ type: 'repositoryDetails', repositoryId: id, requestId: 'new' }); await flush();
  f.pending[0].reject(new Error('outdated failure')); await flush();
  assert.equal(f.messages.filter(message => message.type === 'repositoryDetails').length, 0);
  f.pending[1].resolve({ id, revision: 1, branches: [], stashes: [], recoveryRefs: [] }); await flush();
  assert.equal(f.messages.at(-2).type, 'state');
  assert.equal(f.messages.at(-1).requestId, 'new');
  assert.equal(f.messages.at(-1).details.id, id);
  f.receive({ type: 'repositoryDetails', repositoryId: id, requestId: 'retry' }); await flush();
  f.pending[2].reject(new Error('Cannot read refs')); await flush();
  assert.equal(f.messages.at(-1).error, 'Cannot read refs');
});
