import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { windowsCodexTerminalOptions } from '../../src/workspace/windowsTerminal';

const powershell = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';

test('starts the installed Windows Codex executable under PowerShell', () => {
  const installed = 'C:\\Tools\\Codex';
  const result = windowsCodexTerminalOptions({ SystemRoot: 'C:\\Windows', PATH: `C:\\Git\\bin;${installed}`, PATHEXT: '.EXE;.PS1' }, (target) =>
    target === 'C:\\Tools\\Codex\\codex.exe' || target === powershell);
  assert.deepEqual(result?.shellArgs, ['-NoLogo', '-NoProfile', '-NoExit', '-Command', "& 'C:\\Tools\\Codex\\codex.exe'"]);
  assert.equal(result?.shellPath, powershell);
  assert.equal(result?.env.PATH, `${installed};C:\\Git\\bin;${installed}`);
  assert.ok(result?.env.PATHEXT?.includes('.CMD'));
  assert.ok(!result?.env.PATHEXT?.includes('.PS1'));
});

test('starts codex.cmd when the executable is unavailable and reports missing launchers', () => {
  const files = new Set(['C:\\Users\\Test\\Codex\\codex.cmd', powershell]);
  const result = windowsCodexTerminalOptions({ SystemRoot: 'C:\\Windows', Path: 'C:\\Users\\Test\\Codex' }, (target) => files.has(target));
  assert.deepEqual(result?.shellArgs, ['-NoLogo', '-NoProfile', '-NoExit', '-Command', "& 'C:\\Users\\Test\\Codex\\codex.cmd'"]);
  assert.equal(windowsCodexTerminalOptions({ SystemRoot: 'C:\\Windows', PATH: '' }, () => false), undefined);
  files.delete(powershell);
  assert.equal(windowsCodexTerminalOptions({ SystemRoot: 'C:\\Windows', Path: 'C:\\Users\\Test\\Codex' }, (target) => files.has(target)), undefined);
});

test('PowerShell launches codex.cmd from a quoted path in the selected working directory', { skip: process.platform !== 'win32' }, t => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'codex-powershell-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const installed = path.join(root, "Codex's tools");
  const workspace = path.join(root, 'Group workspace');
  mkdirSync(installed); mkdirSync(workspace);
  writeFileSync(path.join(installed, 'codex.cmd'), '@echo off\r\necho CODEX_CMD_LAUNCHED\r\necho %CD%\r\n');
  writeFileSync(path.join(installed, 'codex.ps1'), "throw 'codex.ps1 must not run'");
  const options = windowsCodexTerminalOptions({ ...process.env, Path: installed, PATH: installed });
  assert.ok(options);
  const output = execFileSync(options.shellPath, options.shellArgs, {
    cwd: workspace, env: options.env, input: 'exit\r\n', encoding: 'utf8', timeout: 15_000, windowsHide: true
  });
  assert.ok(output.includes('CODEX_CMD_LAUNCHED'));
  assert.ok(output.includes(workspace));
});
