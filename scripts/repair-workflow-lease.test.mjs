import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const windows = { skip: process.platform !== 'win32' };
const script = fileURLToPath(new URL('../resources/repair-workflow-lease.ps1', import.meta.url));
const native = fileURLToPath(new URL('../resources/repair-workflow-lease-native.cs', import.meta.url));
const quote = value => "'" + value.replaceAll("'", "''") + "'";
function powershell(source) {
  const command = `
    $ErrorActionPreference = 'Stop'
    $ProgressPreference = 'SilentlyContinue'
    [Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
    try { ${source} }
    catch { [Console]::Error.WriteLine($_.Exception.Message); exit 1 }
  `;
  const args = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(command, 'utf16le').toString('base64')];
  return exec('powershell.exe', args, { timeout: 15_000 }).catch(error => { throw new Error(error.stderr?.trim() || error.message); });
}

async function fixture(t, kind = 'workflow-kit-asset') {
  const parent = await realpath(os.tmpdir());
  const root = await mkdtemp(path.join(parent, "glw-workflow-repair-中文 ' & "));
  t.after(async () => {
    const resolved = await realpath(root);
    assert.equal(path.dirname(resolved), parent);
    assert.ok(path.basename(resolved).startsWith('glw-workflow-repair-'));
    await rm(resolved, { recursive: true, force: true, maxRetries: 5, retryDelay: 30 });
  });
  const rootFlag = ['codex', 'git'].includes(kind) ? '-RuntimeRoot' : '-StorageRoot';
  const scope = path.join(root, 'scope');
  const lease = kind === 'git' ? path.join(scope, 'git-network.lock') :
    kind === 'workflow-kit-cache-control' ? path.join(scope, 'workflow-kit-cache.control') :
    path.join(scope, kind === 'codex' ? 'codex-workspaces' : 'workflow-kit-asset-locks', 'f'.repeat(64) + '.lock');
  const snapshotPath = path.join(root, 'proof.json');
  const ownerPath = path.join(lease, 'owner.json');
  await mkdir(lease, { recursive: true });
  const invoke = async ({ rebooted = false, flags = '', mockHosts = '', mockBoot, target = lease,
    mode = rootFlag, proof = snapshotPath } = {}) => {
    const boot = mockBoot ?? (rebooted ? '@{ BootUtc = [DateTime]::UtcNow.AddHours(-1); ObservedUtc = [DateTime]::UtcNow }' :
      '@{ BootUtc = [DateTime]::UtcNow.AddHours(-12); ObservedUtc = [DateTime]::UtcNow.AddHours(-2) }');
    const result = await powershell(`. ${quote(script)}; function Get-WorkflowLeaseBootObservation { ${boot} }; function Assert-WorkflowLeaseClientsStopped { ${mockHosts} }; Invoke-WorkflowLeaseRepair ${mode} ${quote(scope)} -LeasePath ${quote(target)} -SnapshotPath ${quote(proof)} ${flags} | ConvertTo-Json -Compress`);
    return JSON.parse(result.stdout);
  };
  const owner = (pid = 2147483647) => JSON.stringify({ schema: 'GitLabWorkspaceLease/v1', kind, nonce: randomUUID(), pid,
    createdAt: new Date().toISOString(), state: 'reserved', childPid: null, processTreeConfirmed: false });
  return { scope, lease, snapshotPath, ownerPath, invoke, owner };
}

const apply = { flags: '-Apply -ClientsStopped', rebooted: true };

test('workflow lock repair captures an empty directory and retires only that directory after restart', windows, async t => {
  const f = await fixture(t);
  const sibling = path.join(path.dirname(f.lease), '0'.repeat(64) + '.lock');
  await mkdir(sibling);
  const result = await f.invoke();
  assert.deepEqual(result, { Status: 'Captured', LeasePath: f.lease, Kind: 'workflow-kit-asset', SnapshotPath: f.snapshotPath });
  assert.equal((await lstat(f.lease)).isDirectory(), true);
  const proof = JSON.parse(await readFile(f.snapshotPath, 'utf8'));
  assert.equal(proof.Content, 'Empty');
  assert.match(proof.DirectoryIdentity, /^[A-F0-9]{16}:[a-f0-9]{32}$/);
  await assert.rejects(f.invoke(), /already exists/i);
  await assert.rejects(f.invoke({ flags: '-Apply -ClientsStopped' }), /Use Windows Restart/);
  const moved = await f.invoke(apply);
  assert.equal(moved.Status, 'Retired');
  assert.equal(path.dirname(moved.RetiredPath), path.dirname(f.lease));
  await assert.rejects(lstat(f.lease), { code: 'ENOENT' });
  assert.equal((await lstat(moved.RetiredPath)).isDirectory(), true);
  assert.equal((await lstat(sibling)).isDirectory(), true);
  assert.equal((await f.invoke(apply)).Status, 'Missing');
});

test('workflow lock repair preserves verified legacy Codex metadata verbatim', windows, async t => {
  const f = await fixture(t, 'codex');
  const owner = f.owner();
  await writeFile(f.ownerPath, owner);
  assert.equal((await f.invoke()).Kind, 'codex');
  const moved = await f.invoke(apply);
  assert.equal(moved.Status, 'Retired');
  assert.equal(await readFile(path.join(moved.RetiredPath, 'owner.json'), 'utf8'), owner);
  await assert.rejects(lstat(f.lease), { code: 'ENOENT' });
});

test('workflow lock retirement preserves an already occupied destination and the original lease', windows, async t => {
  const f = await fixture(t);
  const siblingName = 'occupied.retired';
  const sibling = path.join(path.dirname(f.lease), siblingName);
  await mkdir(sibling);
  await writeFile(path.join(sibling, 'marker'), 'keep-sibling');
  const owner = f.owner();
  await writeFile(f.ownerPath, owner);
  const source = `
    Add-Type -Path ${quote(native)}
    $directory = [WorkflowLeaseDirectory]::Open(${quote(f.lease)}, $true)
    try {
      $null = $directory.Retire(${quote(siblingName)})
    } catch {
      $cause = $_.Exception.GetBaseException()
      if ($cause -isnot [ComponentModel.Win32Exception]) { throw }
      $cause.NativeErrorCode
    } finally {
      $directory.Dispose()
    }
  `;
  const { stdout } = await powershell(source);
  assert.equal(stdout.trim(), '183', 'Expected ERROR_ALREADY_EXISTS');
  assert.equal(await readFile(f.ownerPath, 'utf8'), owner);
  assert.equal(await readFile(path.join(sibling, 'marker'), 'utf8'), 'keep-sibling');
});

test('workflow lock repair preserves a replacement directory with the same metadata', windows, async t => {
  const f = await fixture(t, 'workflow-kit-cache-control');
  const owner = f.owner();
  await writeFile(f.ownerPath, owner);
  await f.invoke();
  const old = f.lease + '.original';
  await rename(f.lease, old);
  await mkdir(f.lease);
  await writeFile(f.ownerPath, owner);
  await assert.rejects(f.invoke(apply), /differs from the captured snapshot/);
  assert.equal(await readFile(f.ownerPath, 'utf8'), owner);
  assert.equal(await readFile(path.join(old, 'owner.json'), 'utf8'), owner);
});

test('workflow lock repair rejects replaced owner bytes and unexpected entries', windows, async t => {
  const f = await fixture(t, 'workflow-kit-cache-control');
  await writeFile(f.ownerPath, f.owner());
  await f.invoke();
  const successor = f.owner();
  await writeFile(f.ownerPath, successor);
  await assert.rejects(f.invoke(apply), /differs from the captured snapshot/);
  const unexpected = path.join(f.lease, 'owner.json.partial');
  await writeFile(unexpected, 'keep');
  await assert.rejects(f.invoke(apply), /unexpected entries/);
  assert.equal(await readFile(f.ownerPath, 'utf8'), successor);
  assert.equal(await readFile(unexpected, 'utf8'), 'keep');
});

test('workflow lock repair requires confirmation, a stopped host and verifiable boot evidence', windows, async t => {
  const f = await fixture(t);
  await f.invoke();
  await assert.rejects(f.invoke({ flags: '-Apply' }), /ClientsStopped/);
  await assert.rejects(f.invoke({ ...apply, mockHosts: "throw 'A host is running'" }), /A host is running/);
  await assert.rejects(f.invoke({ ...apply, mockBoot: "throw 'Boot time is unavailable'" }), /Boot time is unavailable/);
  await assert.rejects(f.invoke({ ...apply, mockHosts: "if ($script:checked) { throw 'A host started during repair' }; $script:checked = $true" }), /A host started during repair/);
  assert.equal((await lstat(f.lease)).isDirectory(), true);
});

test('workflow lock repair refuses capture of an owner whose process is still running', windows, async t => {
  const f = await fixture(t);
  await writeFile(f.ownerPath, f.owner(process.pid));
  await assert.rejects(f.invoke(), /lease process is still running/);
  await assert.rejects(lstat(f.snapshotPath), { code: 'ENOENT' });
});

test('workflow lock repair rejects other lock kinds and paths outside the indicated root', windows, async t => {
  const f = await fixture(t);
  await assert.rejects(f.invoke({ mode: '-RuntimeRoot' }), /not a supported local lease/);
  await assert.rejects(f.invoke({ target: path.join(f.scope, 'unrelated.lock') }), /not a supported local lease/);
  await assert.rejects(f.invoke({ target: f.scope + '-sibling\\workflow-kit-cache.control' }), /inside the specified root/);
  const otherOwner = path.join(f.scope, 'workflow-kit-cache.control', 'owner.json');
  await mkdir(path.dirname(otherOwner));
  await assert.rejects(f.invoke({ proof: otherOwner }), /outside the specified storage or runtime root/);
  await assert.rejects(lstat(otherOwner), { code: 'ENOENT' });
});

test('local lease repair preserves a legacy reviewer Git lock and receipt through restart', windows, async t => {
  const f = await fixture(t, 'git');
  const nonce = randomUUID();
  const owner = { ...JSON.parse(f.owner()), nonce: nonce.replaceAll('-', ''), state: 'running' };
  await writeFile(f.ownerPath, JSON.stringify(owner));
  await writeFile(path.join(f.lease, 'execution-' + nonce + '.json'),
    JSON.stringify({ schema: 'GitLabWorkspaceGitExecution/v1', nonce, processTreeConfirmed: true, exitCode: 0 }));
  assert.equal((await f.invoke()).Kind, 'git');
  const retired = await f.invoke(apply);
  assert.equal(retired.Status, 'Retired');
  assert.deepEqual(JSON.parse(await readFile(path.join(retired.RetiredPath, 'owner.json'), 'utf8')), owner);
});

test('workflow lock repair refuses to traverse an ancestor junction', windows, async t => {
  const f = await fixture(t);
  const lockParent = path.dirname(f.lease);
  const redirected = lockParent + '.actual';
  await rename(lockParent, redirected);
  try { await symlink(redirected, lockParent, 'junction'); }
  catch (error) {
    if (error.code !== 'EPERM' && error.code !== 'EACCES') throw error;
    t.skip('The test environment does not permit creating a junction');
    return;
  }
  await assert.rejects(f.invoke(), /redirected/);
  assert.equal((await lstat(path.join(redirected, path.basename(f.lease)))).isDirectory(), true);
});
