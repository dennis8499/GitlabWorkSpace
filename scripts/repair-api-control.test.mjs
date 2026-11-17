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
async function fixture(t) {
  const parent = await realpath(os.tmpdir()), root = await mkdtemp(path.join(parent, 'glw-repair-tool-'));
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
  return { root, host, control, invoke };
}

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
