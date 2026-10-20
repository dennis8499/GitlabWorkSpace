import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import vm from 'node:vm';
import test from 'node:test';
import type { GitAskpassRequest } from '../../src/git/gitAskpass';

function fixture() {
  const calls: Array<{ type: string; options?: any; token?: any }> = [];
  let input: (options: any, token: any) => Promise<string | undefined> = async () => 'fixture-input';
  let session: () => Promise<unknown> = async () => undefined;
  let quickPick: (items: any[], options: any) => Promise<any> = async items => items[0];
  class CancellationTokenSource {
    listeners = new Set<() => void>();
    token = { isCancellationRequested: false, onCancellationRequested: (listener: () => void) => { this.listeners.add(listener); return { dispose: () => this.listeners.delete(listener) }; } };
    cancel() { this.token.isCancellationRequested = true; for (const listener of this.listeners) listener(); }
    dispose() { this.listeners.clear(); }
  }
  const filename = path.resolve(__dirname, '../../src/git/gitAskpassUi.js'), native = createRequire(filename), exports: Record<string, any> = {};
  vm.runInNewContext(readFileSync(filename, 'utf8'), { exports, URL, require: (name: string) => name === 'vscode' ? {
    CancellationTokenSource,
    authentication: { getSession: async (provider: string, scopes: string[], options: any) => { calls.push({ type: 'session', options: { provider, scopes: [...scopes], ...options } }); return session(); } },
    window: {
      showInputBox: async (options: any, token: any) => { calls.push({ type: 'input', options, token }); return input(options, token); },
      showQuickPick: async (items: any[], options: any, token: any) => { calls.push({ type: 'trust', options: { ...options, items }, token }); return quickPick(items, options); }
    }
  } : native(name) });
  return { calls, prompt: exports.createGitCredentialPrompt() as (request: GitAskpassRequest, signal: AbortSignal) => Promise<string | undefined>,
    setInput: (callback: typeof input) => { input = callback; }, setSession: (callback: typeof session) => { session = callback; }, setQuickPick: (callback: typeof quickPick) => { quickPick = callback; } };
}

test('public credential inputs mask secrets, cancel through a VS Code token, and do not open another prompt', async () => {
  const f = fixture(), controller = new AbortController();
  f.setInput(async (_options, token) => new Promise(resolve => token.onCancellationRequested(() => resolve(undefined))));
  const pending = f.prompt({ kind: 'password', remote: 'https://git.example.test/team/repo.git', prompt: 'Password' }, controller.signal);
  assert.equal(f.calls[0].options.password, true); controller.abort(); assert.equal(await pending, undefined);
  assert.equal(f.calls[0].token.isCancellationRequested, true);
  assert.equal(await f.prompt({ kind: 'username', remote: 'https://git.example.test/team/repo.git', prompt: 'Username' }, controller.signal), undefined);
  assert.equal(f.calls.length, 1);
});

test('SSH host trust requires an explicit no/yes selection and shows the supplied fingerprint', async () => {
  const f = fixture(), signal = new AbortController().signal;
  const result = await f.prompt({ kind: 'ssh-confirm', remote: 'ssh.test:team/repo.git', prompt: 'ED25519 fingerprint SHA256:fixture. Continue (yes/no)?' }, signal);
  assert.equal(result, 'no'); assert.deepEqual(Array.from(f.calls[0].options.items, (item: any) => item.label), ['no', 'yes']);
  assert.match(f.calls[0].options.placeHolder, /SHA256:fixture/);
  f.setQuickPick(async items => items[1]);
  assert.equal(await f.prompt({ kind: 'ssh-confirm', remote: 'ssh.test:team/repo.git', prompt: 'Continue (yes/no)?' }, signal), 'yes');
});

test('GitHub uses only an existing public silent session and falls back to input after rejected credentials', async () => {
  const f = fixture(), signal = new AbortController().signal;
  f.setSession(async () => ({ account: { label: 'fixture-github-user' }, accessToken: 'fixture-existing-token' }));
  assert.equal(await f.prompt({ kind: 'username', remote: 'https://github.com/team/repo.git', prompt: 'Username' }, signal), 'fixture-github-user');
  assert.equal(await f.prompt({ kind: 'password', remote: 'https://github.com/team/repo.git', prompt: 'Password' }, signal), 'fixture-existing-token');
  assert.equal(f.calls.length, 1); assert.deepEqual({ ...f.calls[0].options }, { provider: 'github', scopes: ['repo'], silent: true });
  assert.equal(await f.prompt({ kind: 'password', remote: 'https://github.com/team/repo.git', prompt: 'Password' }, signal), 'fixture-input');
  assert.equal(f.calls.at(-1)?.type, 'input');
});

test('cancelling while a public session lookup is pending never opens an input afterward', async () => {
  const f = fixture(), controller = new AbortController(); let finish!: (value: unknown) => void;
  f.setSession(() => new Promise(resolve => { finish = resolve; }));
  const pending = f.prompt({ kind: 'password', remote: 'https://github.com/team/repo.git', prompt: 'Password' }, controller.signal);
  controller.abort(); finish(undefined); assert.equal(await pending, undefined);
  assert.deepEqual(f.calls.map(call => call.type), ['session']);
});
