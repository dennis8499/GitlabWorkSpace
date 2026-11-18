import assert from 'node:assert/strict';
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { setTimeout } from 'node:timers/promises';
import { parse } from '@iarna/toml';
import type * as VSCode from 'vscode';
import { probeCliBuildAuto } from '../../src/codex/buildAutoCli';
import { CodexTerminal } from '../../src/codex/terminal';

const executable = { file: process.execPath, version: '0.169.0', identity: 'native-cli' };
const catalog = JSON.stringify({ models: [
  { slug: 'model-hidden', visibility: 'hidden' },
  { slug: 'model-suite', display_name: 'Model Suite', visibility: 'list', default_reasoning_level: 'high',
    supported_reasoning_levels: [{ effort: 'high' }, { effort: 'ultra' }, { effort: 'auto' }] }
] });

async function fixture(t: TestContext) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'glw-cli-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workingDirectory = path.join(root, '測試工作區');
  await mkdir(workingDirectory);
  const cwd = await realpath(workingDirectory);
  const terminals: VSCode.TerminalOptions[] = [], choices: VSCode.QuickPickItem[][] = [], selections: (number | undefined)[] = [];
  const inputs: (string | undefined)[] = [], probes: string[][] = [];
  const listeners = new Set<(terminal: VSCode.Terminal) => void>();
  let opened = 0, exitStatus: VSCode.TerminalExitStatus | undefined;
  const terminal = { show: () => { opened++; }, get exitStatus() { return exitStatus; } } as VSCode.Terminal;
  const vscode = {
    CancellationTokenSource: class { token = {}; cancel() {} dispose() {} },
    TerminalExitReason: { Process: 2 },
    window: {
      showQuickPick: async (items: VSCode.QuickPickItem[]) => { choices.push(items); const choice = selections.shift(); return choice === undefined ? undefined : items[choice]; },
      showInputBox: async () => inputs.shift(),
      createTerminal: (options: VSCode.TerminalOptions) => { terminals.push(options); return terminal; },
      onDidCloseTerminal: (listener: (terminal: VSCode.Terminal) => void) => { listeners.add(listener); return { dispose: () => listeners.delete(listener) }; }
    }
  } as unknown as typeof VSCode;
  const services = { resolve: async () => executable, version: async () => executable,
    probe: async (_file: string, args: string[], checkedCwd?: string) => {
      probes.push(args);
      assert.equal(checkedCwd, cwd);
      return catalog;
    } };
  const runner = new CodexTerminal(vscode, path.join(root, 'storage'), services);
  return { runner, services, root, cwd, terminals, choices, selections, inputs, probes, opened: () => opened,
    close: (reason: VSCode.TerminalExitReason) => { exitStatus = { reason, code: 0 }; for (const listener of listeners) listener(terminal); } };
}

test('passes a catalog model, supported effort, scoped directories and a UTF-8 file to the native terminal', async t => {
  const { runner, cwd, terminals, choices, selections, probes, close, opened } = await fixture(t);
  selections.push(1, 2);
  const selection = await runner.choose('', cwd);
  assert.deepEqual(selection, { executable, model: 'model-suite', effort: 'ultra' });
  assert.deepEqual(probes, [['debug', 'models']]);
  assert.deepEqual(choices.map(items => items.map(item => item.label)), [
    ['沿用 CLI 設定', 'Model Suite', '輸入模型 ID'], ['使用模型預設', 'high', 'ultra']
  ]);
  const prompt = '中文\n"引號" $(literal)\n'.repeat(5_000);
  await runner.launch(selection!, { title: '工作流程', cwd, prompt, writableRoots: [cwd] });
  const [options] = terminals;
  assert.equal(options.shellPath, executable.file);
  assert.equal(options.cwd, cwd);
  assert.equal(options.isTransient, true);
  assert.equal(opened(), 1);
  const args = options.shellArgs as string[];
  assert.deepEqual(args.slice(0, 3), ['--no-daemon', '--sandbox', 'workspace-write']);
  assert.ok(args.includes('sandbox_workspace_write.network_access=false'));
  const roots = args.find(arg => arg.startsWith('sandbox_workspace_write.writable_roots='));
  assert.deepEqual(parse(roots!).sandbox_workspace_write, { writable_roots: [cwd] });
  assert.deepEqual(args.slice(-6, -1), ['--model', 'model-suite', '--config', 'model_reasoning_effort="ultra"', '--']);
  const file = JSON.parse(args.at(-1)!.split('檔案路徑 ')[1]) as string;
  assert.ok(args.at(-1)!.length < 1024);
  assert.equal(await readFile(file, 'utf8'), prompt);
  close(2);
  for (let attempt = 0; attempt < 40; attempt++) {
    const present = await lstat(file).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; });
    if (!present) return;
    await setTimeout(25);
  }
  assert.fail('closed terminal did not release its prompt file');
});

test('supports CLI defaults, custom models and cancelling selection when the catalog is unavailable', async t => {
  const { runner, services, cwd, choices, selections, inputs, terminals } = await fixture(t);
  const attempts: string[][] = [];
  services.probe = async (_file, args) => { attempts.push(args); throw new Error('catalog unavailable'); };
  assert.equal(await runner.choose('', cwd), undefined);
  assert.deepEqual(attempts, [['debug', 'models'], ['debug', 'models', '--bundled']]);
  assert.deepEqual(choices[0].map(item => item.label), ['沿用 CLI 設定', '輸入模型 ID']);
  assert.equal(terminals.length, 0);
  selections.push(0, 1);
  const inherited = await runner.choose('', cwd);
  inputs.push('custom/provider-model', 'high');
  const custom = await runner.choose('', cwd);
  assert.deepEqual(inherited, { executable });
  assert.deepEqual(custom, { executable, model: 'custom/provider-model', effort: 'high' });
  await runner.launch(inherited!, { title: '查詢', cwd, prompt: '查詢', writableRoots: [] });
  const args = terminals[0].shellArgs as string[];
  assert.ok(args.includes('read-only'));
  assert.ok(!args.includes('--model'));
  assert.ok(!args.some(arg => arg.startsWith('model_reasoning_effort=')));
});

test('refuses mismatched writable scopes, invalid effort and replaced CLI binaries', async t => {
  const { runner, services, root, cwd, terminals } = await fixture(t);
  const input = { title: '查詢', cwd, prompt: '查詢', writableRoots: [cwd] };
  await assert.rejects(runner.launch({ executable, model: 'model-suite', effort: 'high -c' }, input), /模型或思考強度/);
  await assert.rejects(runner.launch({ executable }, { ...input, writableRoots: [path.join(root, 'outside')] }), /超出.*可寫範圍/);
  services.version = async () => ({ ...executable, identity: 'replaced' });
  await assert.rejects(runner.launch({ executable }, input), /執行檔已變更/);
  assert.equal(terminals.length, 0);
});

test('rejects a redirected parent of the working directory', async t => {
  const { runner, root, cwd, terminals } = await fixture(t);
  const link = path.join(root, 'redirect');
  await mkdir(path.join(cwd, 'nested'));
  try { await symlink(cwd, link, 'junction'); }
  catch (error) {
    if (process.platform !== 'win32' || (error as NodeJS.ErrnoException).code !== 'EPERM') throw error;
    t.skip('Windows test environment disallows junction creation'); return;
  }
  await assert.rejects(runner.launch({ executable }, { title: '查詢', cwd: path.join(link, 'nested'), prompt: '查詢', writableRoots: [cwd] }), /不可重新導向/);
  assert.equal(terminals.length, 0);
});

test('checks CLI login and opens the native login command in the integrated terminal', async t => {
  const { runner, services, cwd, terminals } = await fixture(t);
  services.probe = async (_file, args) => {
    assert.deepEqual(args, ['login', 'status']);
    throw Object.assign(new Error('not logged in'), { code: 1 });
  };
  assert.deepEqual(await runner.check('', cwd), { version: executable.version, loggedIn: false });
  await runner.login('', cwd);
  assert.equal(terminals[0].shellPath, executable.file);
  assert.deepEqual(terminals[0].shellArgs, ['login']);
  assert.equal(terminals[0].cwd, cwd);
});

test('checks Build Auto through the CLI sandbox and verifies the committed scratch file', async t => {
  if (process.platform !== 'win32') { t.skip('Build Auto sandbox probe targets Windows'); return; }
  const { root, cwd } = await fixture(t);
  await mkdir(path.join(cwd, '.git'));
  const calls: Array<{ file: string; args: string[]; cwd: string; env: NodeJS.ProcessEnv }> = [];
  const storage = path.join(root, 'storage');
  const result = await probeCliBuildAuto(executable, cwd, storage, undefined, async (file, args, at, env) => {
    calls.push({ file, args, cwd: at, env: { ...env } });
    if (args[0] === 'rev-parse') return cwd;
    if (args[0] === 'features') return 'multi_agent deprecated true\r\n';
    if (args.at(-1) === 'HEAD:proof.txt') return readFile(path.join(at, 'proof.txt'), 'utf8');
    return '';
  });
  assert.equal(result.state, 'ready');
  assert.equal(result.gitSandbox, 'verified');
  const sandbox = calls.filter(call => call.args[0] === 'sandbox');
  assert.deepEqual(sandbox.map(call => call.args.slice(-3)), [['add', '--', 'proof.txt'], ['-q', '-m', 'Git sandbox capability probe'],
    ['commit.gpgSign=false', 'show', 'HEAD:proof.txt']]);
  for (const call of sandbox) {
    assert.equal(call.file, executable.file);
    assert.notEqual(call.cwd, cwd);
    const roots = call.args.find(arg => arg.startsWith('sandbox_workspace_write.writable_roots='));
    assert.deepEqual(parse(roots!).sandbox_workspace_write, { writable_roots: [call.cwd, path.join(call.cwd, '.git')] });
    assert.equal(call.env.GIT_CONFIG_GLOBAL, path.join(call.cwd, 'empty.gitconfig'));
  }
  await assert.rejects(lstat(sandbox[0].cwd), { code: 'ENOENT' });
});

test('leaves Build Auto unavailable without an enabled child-agent feature', async t => {
  if (process.platform !== 'win32') { t.skip('Build Auto sandbox probe targets Windows'); return; }
  const { root, cwd } = await fixture(t);
  await mkdir(path.join(cwd, '.git'));
  const calls: string[] = [];
  const result = await probeCliBuildAuto(executable, cwd, root, undefined, async (_file, args) => {
    calls.push(args[0]);
    return args[0] === 'rev-parse' ? cwd : 'multi_agent deprecated false\n';
  });
  assert.equal(result.state, 'unavailable');
  assert.equal(result.gitSandbox, 'unverified');
  assert.deepEqual(calls, ['rev-parse', 'features']);
});
