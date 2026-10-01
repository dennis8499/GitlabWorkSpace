import assert from 'node:assert/strict';
import test from 'node:test';
import { windowsCodexTerminalOptions } from '../../src/workspace/windowsTerminal';

test('starts the installed Windows Codex executable under cmd while preserving the Group path', () => {
  const installed = 'C:\\Tools\\Codex';
  const result = windowsCodexTerminalOptions({ SystemRoot: 'C:\\Windows', PATH: `C:\\Git\\bin;${installed}`, PATHEXT: '.EXE;.PS1' }, (target) =>
    target === 'C:\\Tools\\Codex\\codex.exe' || target === 'C:\\Windows\\System32\\cmd.exe');
  assert.deepEqual(result?.shellArgs, ['/d', '/q', '/k', 'codex.exe']);
  assert.equal(result?.shellPath, 'C:\\Windows\\System32\\cmd.exe');
  assert.equal(result?.env.PATH, `${installed};C:\\Git\\bin;${installed}`);
  assert.ok(result?.env.PATHEXT?.includes('.CMD'));
  assert.ok(!result?.env.PATHEXT?.includes('.PS1'));
});

test('starts codex.cmd when the executable is unavailable and reports missing launchers', () => {
  const files = new Set(['C:\\Users\\Test\\Codex\\codex.cmd', 'C:\\Windows\\System32\\cmd.exe']);
  const result = windowsCodexTerminalOptions({ SystemRoot: 'C:\\Windows', Path: 'C:\\Users\\Test\\Codex' }, (target) => files.has(target));
  assert.deepEqual(result?.shellArgs, ['/d', '/q', '/k', 'codex.cmd']);
  assert.equal(windowsCodexTerminalOptions({ SystemRoot: 'C:\\Windows', PATH: '' }, () => false), undefined);
});
