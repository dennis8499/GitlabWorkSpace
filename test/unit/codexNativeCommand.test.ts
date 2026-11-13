import assert from 'node:assert/strict';
import test from 'node:test';
import { matchesNativeCommand, normalizeNativeCommand } from '../../src/codex/nativeCommand';

const quote = (value: string): string => `'${value.replaceAll("'", `'"'"'`)}'`;
const prefix = 'try { [Console]::OutputEncoding=[System.Text.Encoding]::UTF8 } catch {}\n';

test('native shell argv displays recover one complete body on Windows and POSIX', () => {
  const wrappers = [
    `powershell.exe -NoProfile -Command 'npm.cmd test'`,
    `pwsh -NoLogo -NoProfile -NonInteractive -c "npm.cmd test"`,
    `PWSH.EXE -noprofile -COMMAND 'npm.cmd test'`,
    `C:\\windows\\system32\\windowspowershell\\v1.0\\powershell.exe -NoProfile -Command "npm.cmd test"`,
    `'C:\\Program Files\\PowerShell\\7\\pwsh.exe' -NoProfile -Command 'npm.cmd test'`,
    `"C:\\Program Files\\PowerShell\\7\\pwsh.exe" -NonInteractive -Command "npm.cmd test"`,
    `/bin/bash -lc 'npm.cmd test'`, `/bin/zsh -c 'npm.cmd test'`, `sh -c "npm.cmd test"`,
    `"C:\\Program Files\\Git\\bin\\bash.exe" -lc "npm.cmd test"`
  ];
  for (const actual of wrappers) {
    assert.equal(normalizeNativeCommand(actual), 'npm.cmd test', actual);
    assert.equal(matchesNativeCommand(actual, 'npm.cmd test'), true, actual);
  }
  assert.equal(matchesNativeCommand('bash -lc pytest', 'pytest'), true);
});

test('shlex quoting recovers nested apostrophes, quotes and literal script syntax exactly', () => {
  for (const body of [
    `node -e 'console.log("can't")'`,
    `node -e "console.log('hello')"`,
    `Write-Output '中文 輸出'`,
    `npm.cmd  test`, `npm.cmd\ttest`, `npm.cmd test\nWrite-Output done`,
    `Write-Output '$HOME'; npm.cmd test`, `npm.cmd test; exit 0`,
    `Write-Output \\network\\path`
  ]) assert.equal(normalizeNativeCommand(`pwsh -Command ${quote(body)}`), body, body);
  assert.equal(normalizeNativeCommand(`pwsh -Command "node -e \\"process.exit(0)\\""`), 'node -e "process.exit(0)"');
});

test('matching never folds command whitespace or accepts a command substring', () => {
  assert.equal(matchesNativeCommand('npm.cmd test', 'npm.cmd test'), true);
  assert.equal(normalizeNativeCommand('npm.cmd test'), undefined);
  for (const body of ['npm.cmd  test', ' npm.cmd test', 'npm.cmd test ', 'npm.cmd\ttest',
    'npm.cmd test; exit 0', 'npm.cmd test && exit 0', 'npm.cmd test\nexit 0',
    'echo npm.cmd test', 'npm.cmd test --ignore-scripts']) {
    assert.equal(matchesNativeCommand(`pwsh -Command ${quote(body)}`, 'npm.cmd test'), false, body);
  }
  assert.equal(matchesNativeCommand(' npm.cmd test', 'npm.cmd test'), false);
});

test('unknown flags, additional argv, shell operators and malformed quoting fail closed', () => {
  for (const actual of [
    `pwsh -Command 'npm.cmd test' 'exit 0'`, `pwsh -Command 'npm.cmd test' --`,
    `pwsh -Command 'npm.cmd test'; exit 0`, `pwsh -Command 'npm.cmd test' && exit 0`,
    `pwsh -Command 'npm.cmd test' | echo pass`, `pwsh -Command 'npm.cmd test'#comment`,
    `pwsh -Command 'npm.cmd test'\nexit 0`, `pwsh -Command 'npm.cmd test' > result.txt`,
    `pwsh -ExecutionPolicy Bypass -Command 'npm.cmd test'`, `pwsh -EncodedCommand 'npm.cmd test'`,
    `pwsh -NoExit -Command 'npm.cmd test'`, `pwsh -NoProfile -NoProfile -Command 'npm.cmd test'`,
    `pwsh -Command 'npm.cmd test' -NoProfile`, `pwsh -Command`, `pwsh -Command 'npm.cmd test`,
    `pwsh -Command "npm.cmd test`, `pwsh -Command npm.cmd test`,
    `bash -lc 'npm.cmd test' ignored-argv-zero`, `bash -l -c 'npm.cmd test'`,
    `bash --login -c 'npm.cmd test'`, `bash -LC 'npm.cmd test'`, `bash -lc 'npm.cmd test' &`,
    `cmd.exe /c "npm.cmd test"`, `fish -c 'npm.cmd test'`, `sudo pwsh -Command 'npm.cmd test'`,
    `pwsh -Command 'npm.cmd test'\0`, `pwsh -Command 'npm.cmd ''test'''`,
    `pwsh -Command "npm.cmd ""test"""`
  ]) {
    assert.equal(normalizeNativeCommand(actual), undefined, actual);
    assert.equal(matchesNativeCommand(actual, 'npm.cmd test'), false, actual);
  }
});

test('no recursive unwrap and ambiguous Windows/POSIX quoting cannot prove a match', () => {
  const nested = `pwsh -Command ${quote(`bash -lc 'npm.cmd test'`)}`;
  assert.equal(normalizeNativeCommand(nested), `bash -lc 'npm.cmd test'`);
  assert.equal(matchesNativeCommand(nested, 'npm.cmd test'), false);
  assert.equal(normalizeNativeCommand(String.raw`pwsh -Command "echo \\server"`), undefined);
  const unknown = `cmd.exe /c "npm.cmd test"`;
  assert.equal(matchesNativeCommand(unknown, unknown), true);
  assert.equal(matchesNativeCommand(unknown, 'npm.cmd test'), false);
});

test('only Codex 0.167.2 exact PowerShell UTF8 prefix is transparent, once', () => {
  assert.equal(matchesNativeCommand(`pwsh -Command ${quote(prefix + 'npm.cmd test')}`, 'npm.cmd test'), true);
  for (const body of [
    `${prefix}npm.cmd test; exit 0`, `${prefix}${prefix}npm.cmd test`,
    ` ${prefix}npm.cmd test`, prefix.replace('catch {}', 'catch { exit 0 }') + 'npm.cmd test',
    prefix.replace('\n', '\r\n') + 'npm.cmd test', prefix.replace('UTF8', 'UTF7') + 'npm.cmd test'
  ]) assert.equal(matchesNativeCommand(`pwsh -Command ${quote(body)}`, 'npm.cmd test'), false, body);
  assert.equal(matchesNativeCommand(`bash -c ${quote(prefix + 'npm.cmd test')}`, 'npm.cmd test'), false);
});
