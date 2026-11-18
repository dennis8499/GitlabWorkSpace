import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { promisify } from 'node:util';
import { parse } from '@iarna/toml';
import * as vscode from 'vscode';
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
    string[] values = new [] { Environment.CurrentDirectory, File.ReadAllText(file, Encoding.UTF8) };
    string[] evidence = values.Concat(args).Select(x => Convert.ToBase64String(Encoding.UTF8.GetBytes(x))).ToArray();
    File.WriteAllLines("terminal-evidence.tmp", evidence, new UTF8Encoding(false));
    File.Move("terminal-evidence.tmp", "terminal-evidence.txt");
    return 0;
  }
}
`;

suite('Codex CLI integrated terminal', () => {
  test('preserves native Windows argv, execution root and a long UTF-8 prompt', async function () {
    if (process.platform !== 'win32') { this.skip(); return; }
    this.timeout(30_000);
    const compiler = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');
    const fixtureParent = process.env.GITLAB_WORKSPACE_TEST_TMP;
    assert.ok(fixtureParent, 'Extension Host runner should provide isolated storage');
    await access(compiler);
    const root = await mkdtemp(path.join(fixtureParent, 'codex-terminal-'));
    const workingDirectory = path.join(root, '工作流程 測試');
    await mkdir(workingDirectory);
    const cwd = await realpath(workingDirectory);
    const source = path.join(root, 'fixture.cs'), executable = path.join(root, 'Codex fixture.exe');
    await writeFile(source, fixture, 'utf8');
    await compile(compiler, ['/nologo', '/target:exe', '/r:System.Web.Extensions.dll', `/out:${executable}`, source], { cwd: root, windowsHide: true });

    const prompt = '繁體中文\n帶「引號」和 $(literal)\n'.repeat(3_000);
    const runner = new CodexTerminal(vscode, path.join(root, 'storage'));
    const terminal = await runner.launch({ executable: { file: executable, version: '0.169.0' }, model: 'fixture/model', effort: 'xhigh' },
      { title: 'Codex CLI 驗證', cwd, prompt, writableRoots: [cwd] });
    try {
      const evidence = path.join(cwd, 'terminal-evidence.txt');
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
});
