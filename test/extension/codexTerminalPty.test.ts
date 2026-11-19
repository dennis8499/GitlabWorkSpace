import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { promisify } from 'node:util';
import { parse } from '@iarna/toml';
import * as vscode from 'vscode';
import { openManualCodexTerminal } from '../../src/codex/manualTerminal';
import { CodexTerminal } from '../../src/codex/terminal';

const compile = promisify(execFile);
const fixture = String.raw`
using System;
using System.IO;
using System.Linq;
using System.Text;
using System.Web.Script.Serialization;

public class CodexFixture {
  public static int Main(string[] args) {
    if (args.Length == 1 && args[0] == "--version") {
      Console.WriteLine("codex-cli 0.169.0");
      return 0;
    }
    string initial = args.Last();
    string file = new JavaScriptSerializer().Deserialize<string>(initial.Substring(initial.IndexOf('"')));
    string prompt = File.ReadAllText(file, Encoding.UTF8);
    string[] values = new [] { Environment.CurrentDirectory, prompt };
    string[] evidence = values.Concat(args).Select(x => Convert.ToBase64String(Encoding.UTF8.GetBytes(x))).ToArray();
    File.WriteAllLines("terminal-evidence.tmp", evidence, new UTF8Encoding(false));
    File.Move("terminal-evidence.tmp", "terminal-evidence.txt");
    if (prompt.StartsWith("Interactive fixture\n", StringComparison.Ordinal)) {
      Console.WriteLine("GLW_CODEX_FIXTURE_WAITING");
      return Console.ReadKey(true).KeyChar == 'g' ? 23 : 29;
    }
    return 0;
  }
}
`;

async function nativeFixture() {
  const compiler = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');
  const fixtureParent = process.env.GITLAB_WORKSPACE_TEST_TMP;
  assert.ok(fixtureParent, 'Extension Host runner should provide isolated storage');
  await access(compiler);
  const root = await realpath(await mkdtemp(path.join(fixtureParent, 'codex-terminal-')));
  const cwd = path.join(root, '工作流程 & O\'Hare’s 測試');
  await mkdir(cwd);
  const source = path.join(root, 'fixture.cs'), executable = path.join(root, 'Codex fixture.exe');
  await writeFile(source, fixture, 'utf8');
  await compile(compiler, ['/nologo', '/target:exe', '/r:System.Web.Extensions.dll', `/out:${executable}`, source], { cwd: root, windowsHide: true });
  return { root, cwd, executable, evidence: path.join(cwd, 'terminal-evidence.txt') };
}

async function manualFixture(cwd: string, test: Mocha.Context) {
  const powerShell = process.env.GITLAB_WORKSPACE_TEST_PWSH ?? '';
  if (process.platform !== 'win32') { test.skip(); return; }
  const options = { cwd, powerShell, script: path.resolve(__dirname, '../../../resources/codex-manual-launch.ps1') };
  const [major, minor] = vscode.version.split('.').map(Number);
  if (major === 1 && minor < 93) {
    await assert.rejects(openManualCodexTerminal(vscode, options), /VS Code 1\.93/);
    test.skip(); return;
  }
  try {
    return await openManualCodexTerminal(vscode, options);
  } catch (error) {
    if (!powerShell && error instanceof Error && error.message.startsWith('找不到可執行的 PowerShell')) { test.skip(); return; }
    throw error;
  }
}

interface TerminalExecutionEvent {
  terminal: vscode.Terminal;
  execution: { commandLine: { value: string }; read(): AsyncIterable<string> };
}

suite('Codex CLI integrated terminal', () => {
  test('preserves native Windows argv, execution root and a long UTF-8 prompt', async function () {
    if (process.platform !== 'win32') { this.skip(); return; }
    this.timeout(30_000);
    const { root, cwd, executable, evidence } = await nativeFixture();
    const prompt = '繁體中文\n帶「引號」和 $(literal)\n'.repeat(3_000);
    const runner = new CodexTerminal(vscode, path.join(root, 'storage'));
    const terminal = await runner.launch({ executable: { file: executable, version: '0.169.0' }, model: 'fixture/model', effort: 'xhigh' },
      { title: 'Codex CLI 驗證', cwd, prompt, writableRoots: [cwd] });
    try {
      let contents: string | undefined;
      for (let attempt = 0; attempt < 150 && contents === undefined; attempt++) {
        contents = await readFile(evidence, 'utf8').catch(error => { if (error.code === 'ENOENT') return undefined; throw error; });
        if (contents === undefined) await setTimeout(100);
      }
      assert.ok(contents, 'native fixture did not receive the terminal arguments');
      const [actualCwd, actualPrompt, ...args] = contents.trim().split(/\r?\n/).map(value => Buffer.from(value, 'base64').toString('utf8'));
      assert.equal(await realpath(actualCwd), cwd);
      assert.equal(actualPrompt, prompt);
      assert.deepEqual(args.slice(-6, -1), ['--model', 'fixture/model', '--config', 'model_reasoning_effort="xhigh"', '--']);
      const writable = args.find(value => value.startsWith('sandbox_workspace_write.writable_roots='));
      assert.ok(writable);
      assert.deepEqual(parse(writable).sandbox_workspace_write, { writable_roots: [cwd] });
    } finally { terminal.dispose(); }
  });

  test('prefilled Codex waits for Enter and preserves native argv, terminal IO and exit code', async function () {
    if (process.platform !== 'win32') { this.skip(); return; }
    this.timeout(30_000);
    const { root, cwd, executable, evidence } = await nativeFixture();
    const manual = await manualFixture(root, this);
    if (!manual) return;
    const window = vscode.window as typeof vscode.window & { onDidStartTerminalShellExecution: vscode.Event<TerminalExecutionEvent> };
    let visible!: (seen: boolean) => void;
    const commands: string[] = [];
    let latestOutput = '';
    const nativeOutput = new Promise<boolean>(resolve => { visible = resolve; });
    const listener = window.onDidStartTerminalShellExecution(({ terminal, execution }) => {
      if (terminal !== manual.terminal) return;
      commands.push(execution.commandLine.value);
      if (execution.commandLine.value.trim() !== 'codex') return;
      const stream = execution.read();
      void (async () => {
        let output = '';
        for await (const chunk of stream) {
          output = (output + chunk).slice(-4_096);
          latestOutput = output;
          if (output.includes('GLW_CODEX_FIXTURE_WAITING')) { visible(true); return; }
        }
        visible(false);
      })().catch(() => visible(false));
    });
    try {
      manual.terminal.show();
      assert.equal(await Promise.race([manual.requested, setTimeout(500, 'waiting')]), 'waiting');
      await assert.rejects(access(evidence), { code: 'ENOENT' });
      assert.equal(vscode.window.activeTerminal, manual.terminal);
      await vscode.commands.executeCommand('workbench.action.terminal.sendSequence', { text: '\r' });
      assert.equal(await Promise.race([manual.requested, setTimeout(8_000, 'Enter timeout', { ref: false })]), true,
        `Shell Integration commands: ${JSON.stringify(commands)}. Terminal output: ${JSON.stringify(latestOutput)}`);

      const prompt = 'Interactive fixture\n繁體中文\n帶「引號」和 $(literal)\n';
      const storage = path.join(root, '資料 O\'Hare’s & scope');
      const runner = new CodexTerminal(vscode, storage);
      const terminal = await runner.launch({ executable: { file: executable, version: '0.169.0' }, model: 'fixture/model', effort: 'xhigh' },
        { title: 'Codex 等候模式驗證', cwd, prompt, writableRoots: [cwd] }, { manual });
      assert.equal(terminal, manual.terminal);
      assert.equal(await Promise.race([nativeOutput, setTimeout(8_000, 'native output timeout', { ref: false })]), true,
        `Shell Integration commands: ${JSON.stringify(commands)}. Terminal output: ${JSON.stringify(latestOutput)}`);
      terminal.sendText('g', false);
      assert.deepEqual(await Promise.race([manual.completion, setTimeout(8_000, 'Codex timeout', { ref: false })]), { state: 'exited', code: 23 });
      const [actualCwd, actualPrompt, ...args] = (await readFile(evidence, 'utf8')).trim().split(/\r?\n/).map(value => Buffer.from(value, 'base64').toString('utf8'));
      assert.equal(await realpath(actualCwd), cwd);
      assert.equal(actualPrompt, prompt);
      assert.deepEqual(args.slice(0, 3), ['--no-daemon', '--sandbox', 'workspace-write']);
      assert.deepEqual(args.slice(-6, -1), ['--model', 'fixture/model', '--config', 'model_reasoning_effort="xhigh"', '--']);
      const writable = args.find(value => value.startsWith('sandbox_workspace_write.writable_roots='));
      assert.ok(writable);
      assert.deepEqual(parse(writable).sandbox_workspace_write, { writable_roots: [cwd] });
    } finally { listener.dispose(); manual.close(); }
  });

  test('closing the prefilled PowerShell terminal cancels its pending launch', async function () {
    const cwd = process.env.GITLAB_WORKSPACE_TEST_TMP;
    assert.ok(cwd);
    const manual = await manualFixture(cwd, this);
    if (!manual) return;
    manual.terminal.show();
    manual.terminal.dispose();
    try {
      assert.equal(await Promise.race([manual.requested, setTimeout(5_000, 'close timeout', { ref: false })]), false);
      assert.deepEqual(await manual.completion, { state: 'not-started' });
    } finally { manual.close(); }
  });
});
