import assert from 'node:assert/strict';
import test from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, readFile, realpath, rm, rmdir, symlink, writeFile, lstat } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const exec = promisify(execFile);
const script = fileURLToPath(new URL('../resources/repair-api-control.ps1', import.meta.url));
const quote = value => "'" + value.replaceAll("'", "''") + "'";
async function fixture(t, suffix = '') {
  const parent = await realpath(os.tmpdir()), root = await mkdtemp(path.join(parent, 'glw-repair-tool-' + suffix));
  const host = path.join(root, 'api', 'a'.repeat(64)), control = path.join(host, 'control.lock');
  await mkdir(control, { recursive: true });
  t.after(async () => {
    const resolved = await realpath(root);
    assert.equal(path.dirname(resolved), parent); assert.ok(path.basename(resolved).startsWith('glw-repair-tool-'));
    await rm(resolved, { recursive: true, force: true, maxRetries: 5, retryDelay: 30 });
  });
  const invoke = (options = '', mockHosts = '@()') => {
    const source = `. ${quote(script)}; function Get-RunningApiHosts { ${mockHosts} }; $ErrorActionPreference='Stop'; Invoke-ApiControlRepair -RuntimeRoot ${quote(root)} -LeasePath ${quote(control)} ${options} | ConvertTo-Json -Depth 4`;
    return exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(source, 'utf16le').toString('base64')], { windowsHide: true, timeout: 15_000 });
  };
  const interactive = (answers, mockHosts = '@()', beforePrompt = '') => {
    const source = `. ${quote(script)}; $ErrorActionPreference='Stop'; function Write-Host {}; function Get-RunningApiHosts { ${mockHosts} }; $script:answers=New-Object System.Collections.Queue; ${answers.map(answer => `$script:answers.Enqueue(${quote(answer)})`).join('; ')}; $script:prompts=0; function Read-Host { $script:prompts++; ${beforePrompt}; if ($script:answers.Count -eq 0) { throw 'Unexpected extra prompt' }; return $script:answers.Dequeue() }; $result=Invoke-InteractiveApiControlRepair -RuntimeRoot ${quote(root)} -LeasePath ${quote(control)}; [pscustomobject]@{ Status=$result.Status; Prompts=$script:prompts; Entries=$result.Entries } | ConvertTo-Json -Depth 4`;
    return exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(source, 'utf16le').toString('base64')], { windowsHide: true, timeout: 15_000 });
  };
  return { root, host, control, invoke, interactive };
}

test('interactive recovery requires explicit confirmation and leaves cancelled locks intact', { skip: process.platform !== 'win32' }, async t => {
  const f = await fixture(t);
  const result = JSON.parse((await f.interactive(['', 'Q'])).stdout);
  assert.equal(result.Status, 'Cancelled'); assert.equal(result.Prompts, 2);
  assert.equal((await lstat(f.control)).isDirectory(), true);
});

test('interactive recovery waits for stopped clients then removes only the confirmed empty lock', { skip: process.platform !== 'win32' }, async t => {
  const f = await fixture(t);
  await writeFile(path.join(f.host, 'state.json'), 'preserve-quota');
  const hosts = "if (-not $script:hostObserved) { $script:hostObserved=$true; [pscustomobject]@{ProcessId=123;Name='Code.exe'} } else { @() }";
  const result = JSON.parse((await f.interactive(['Y', 'Y'], hosts)).stdout);
  assert.equal(result.Status, 'Removed'); assert.equal(result.Prompts, 2);
  await assert.rejects(lstat(f.control), { code: 'ENOENT' });
  assert.equal(await readFile(path.join(f.host, 'state.json'), 'utf8'), 'preserve-quota');
});

test('interactive recovery preserves content appearing after confirmation and fails closed on process inspection errors', { skip: process.platform !== 'win32' }, async t => {
  const f = await fixture(t);
  await assert.rejects(f.interactive(['Y'], "throw 'process inspection denied'"), /process inspection denied/);
  assert.equal((await lstat(f.control)).isDirectory(), true);
  await assert.rejects(f.interactive(['Y'], '@()', `[IO.File]::WriteAllText(${quote(path.join(f.control, 'unknown.tmp'))}, 'keep')`), /not empty/);
  assert.equal(await readFile(path.join(f.control, 'unknown.tmp'), 'utf8'), 'keep');
  const result = JSON.parse((await f.interactive([])).stdout);
  assert.equal(result.Status, 'NotEmpty'); assert.equal(result.Prompts, 0); assert.deepEqual(result.Entries, ['unknown.tmp']);
});

test('repair treats missing runtime and host directories as absent without creating them', { skip: process.platform !== 'win32' }, async t => {
  const f = await fixture(t);
  await rmdir(f.control); await rmdir(f.host);
  assert.equal(JSON.parse((await f.invoke()).stdout).Status, 'Missing');
  assert.equal(JSON.parse((await f.interactive([])).stdout).Status, 'Missing');
  const missing = path.join(f.root, 'missing-runtime');
  const source = `& ${quote(script)} -RuntimeRoot ${quote(missing)} -LeasePath ${quote(path.join(missing, 'api', 'a'.repeat(64), 'control.lock'))}`;
  const result = await exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(source, 'utf16le').toString('base64')], { windowsHide: true });
  assert.equal(JSON.parse(result.stdout).Status, 'Missing');
  await assert.rejects(lstat(missing), { code: 'ENOENT' });
});

test('Windows PowerShell reads the packaged Chinese prompts and literal special-character paths', { skip: process.platform !== 'win32' }, async t => {
  const f = await fixture(t, "中文 ' & $() ` ");
  assert.deepEqual((await readFile(script)).subarray(0, 3), Buffer.from([0xef, 0xbb, 0xbf]));
  assert.equal(JSON.parse((await f.invoke()).stdout).Status, 'Empty');
  const literalFile = await exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script,
    '-RuntimeRoot', f.root, '-LeasePath', f.control], { windowsHide: true });
  assert.equal(JSON.parse(literalFile.stdout).Status, 'Empty', 'File mode must preserve special characters as literal arguments');
  const source = `[Console]::OutputEncoding=New-Object System.Text.UTF8Encoding($false); . ${quote(script)}; function Read-Host { 'Q' }; Invoke-InteractiveApiControlRepair -RuntimeRoot ${quote(f.root)} -LeasePath ${quote(f.control)} | Out-Null`;
  const result = await exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(source, 'utf16le').toString('base64')], { windowsHide: true });
  assert.match(result.stdout, /本機連線復原/); assert.match(result.stdout, /已取消/); assert.ok(result.stdout.includes(f.control));
});

test('repair inspection lists an empty lock without modifying it', { skip: process.platform !== 'win32' }, async t => {
  const f = await fixture(t), result = JSON.parse((await f.invoke()).stdout);
  assert.equal(result.Status, 'Empty'); assert.equal(result.LeasePath, f.control); assert.deepEqual(result.Entries, []);
  assert.equal((await lstat(f.control)).isDirectory(), true);
});

test('repair apply requires both an explicit target and the stopped-client assertion', { skip: process.platform !== 'win32' }, async t => {
  const f = await fixture(t);
  await assert.rejects(f.invoke('-Apply'), /ClientsStopped/);
  const command = `. ${quote(script)}; Invoke-ApiControlRepair -RuntimeRoot ${quote(f.root)} -Apply -ClientsStopped`;
  await assert.rejects(exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(command, 'utf16le').toString('base64')], { windowsHide: true }), /explicit LeasePath/);
  assert.equal((await lstat(f.control)).isDirectory(), true);
});

test('repair removes only the empty canonical API lock and preserves quota, policy and Git ownership', { skip: process.platform !== 'win32' }, async t => {
  const f = await fixture(t), preserved = [path.join(f.host, 'state.json'), path.join(f.root, 'network-policy.json'), path.join(f.root, 'git-network.lock', 'owner.json')];
  await mkdir(path.dirname(preserved[2]));
  for (const file of preserved) await writeFile(file, 'preserve-exactly');
  assert.equal(JSON.parse((await f.invoke('-Apply -ClientsStopped')).stdout).Status, 'Removed');
  await assert.rejects(lstat(f.control), { code: 'ENOENT' });
  for (const file of preserved) assert.equal(await readFile(file, 'utf8'), 'preserve-exactly');
  assert.equal(JSON.parse((await f.invoke('-Apply -ClientsStopped')).stdout).Status, 'Missing');
});

test('repair preserves owner metadata and hidden temporary files in nonempty locks', { skip: process.platform !== 'win32' }, async t => {
  const f = await fixture(t);
  for (const filename of ['owner.json', '.owner.json.partial.tmp']) {
    await writeFile(path.join(f.control, filename), 'keep');
    if (filename.startsWith('.')) {
      const source = `[IO.File]::SetAttributes(${quote(path.join(f.control, filename))}, [IO.FileAttributes]::Hidden)`;
      await exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(source, 'utf16le').toString('base64')], { windowsHide: true });
    }
    const inspection = JSON.parse((await f.invoke()).stdout);
    assert.equal(inspection.Status, 'NotEmpty'); assert.ok(inspection.Entries.includes(filename));
    await assert.rejects(f.invoke('-Apply -ClientsStopped'), /not empty/);
    assert.equal(await readFile(path.join(f.control, filename), 'utf8'), 'keep');
  }
});

test('repair refuses a running host, failed process inspection, or a host appearing before deletion', { skip: process.platform !== 'win32' }, async t => {
  const f = await fixture(t);
  for (const hosts of ["[pscustomobject]@{ ProcessId=123; Name='Code.exe' }", "throw 'process inspection denied'", "if ($script:hostChecked) { [pscustomobject]@{ ProcessId=123; Name='Code.exe' } } else { $script:hostChecked=$true; @() }"]) {
    await assert.rejects(f.invoke('-Apply -ClientsStopped', hosts));
    assert.equal((await lstat(f.control)).isDirectory(), true);
  }
});

test('repair rejects out-of-scope paths and junctions without following them', { skip: process.platform !== 'win32' }, async t => {
  const f = await fixture(t), other = path.join(f.root, 'other'); await mkdir(other);
  const run = target => {
    const source = `. ${quote(script)}; function Get-RunningApiHosts { @() }; Invoke-ApiControlRepair -RuntimeRoot ${quote(f.root)} -LeasePath ${quote(target)} -Apply -ClientsStopped`;
    return exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(source, 'utf16le').toString('base64')], { windowsHide: true });
  };
  for (const target of [other, path.join(f.root, 'git-network.lock'), path.join(f.root, '..', 'outside', 'control.lock'), f.control.slice(2)]) await assert.rejects(run(target));
  await rmdir(f.control); await symlink(other, f.control, 'junction');
  await assert.rejects(f.invoke('-Apply -ClientsStopped'), /Reparse/);
  assert.equal((await lstat(other)).isDirectory(), true);
});
