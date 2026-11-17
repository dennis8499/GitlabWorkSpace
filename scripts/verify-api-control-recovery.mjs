import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { copyFile, cp, lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runTests } from '@vscode/test-electron';
import { isolatedHostEnvironment } from './extension-test-environment.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const manifest = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
const vsix = path.join(root, 'dist', `${manifest.name}-${manifest.version}.vsix`);
const executable = process.env.VSCODE_EXECUTABLE_PATH || path.join(root, '.vscode-test/vscode-win32-x64-archive-1.146.0/Code.exe');
const parent = await realpath(os.tmpdir()), temporary = await mkdtemp(path.join(parent, 'glw-recovery-lifecycle-'));
const evidence = path.join(root, '.gitlab-workspace-validation', 'recovery-lifecycle-' + Date.now());
const hostEnvironment = isolatedHostEnvironment();
// test-electron merges overrides into process.env; undefined explicitly removes
// inherited Electron/VS Code keys rather than accidentally restoring them.
for (const key of hostEnvironment.removed) hostEnvironment.env[key] = undefined;
const quote = value => "'" + value.replaceAll("'", "''") + "'";
const powershell = source => execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from("$ErrorActionPreference='Stop'; $ProgressPreference='SilentlyContinue'; " + source, 'utf16le').toString('base64')], { windowsHide: true, encoding: 'utf8', timeout: 30_000 });
let helper;
await mkdir(evidence, { recursive: true });
try {
  const zip = path.join(temporary, 'package.zip'), extracted = path.join(temporary, 'unpacked');
  await copyFile(vsix, zip);
  powershell(`Add-Type -AssemblyName System.IO.Compression.FileSystem; [IO.Compression.ZipFile]::ExtractToDirectory(${quote(zip)}, ${quote(extracted)})`);
  const extensionPath = path.join(extracted, 'extension');
  const repair = path.join(extensionPath, 'resources/repair-api-control.ps1');
  assert.deepEqual(await readFile(repair), await readFile(path.join(root, 'resources/repair-api-control.ps1')));
  const runtime = path.join(temporary, 'runtime');
  const lock = path.join(runtime, 'api', createHash('sha256').update('recovery-lifecycle.example').digest('hex'), 'control.lock');
  await mkdir(lock, { recursive: true });
  await writeFile(path.join(runtime, 'network-policy.json'), JSON.stringify({ schema: 'GitLabWorkspaceNetworkPolicy/v1', api: { startsPerSecond: 10000, concurrency: 2 } }));
  // Substitute only human input and process observation for this isolated
  // runtime. The packaged service, contributed command, launcher, PowerShell
  // repair functions and both real Extension Host processes remain in use.
  await writeFile(path.join(temporary, 'interactive-fixture.ps1'), '\uFEFF' + `param([string]$RuntimeRoot,[string]$LeasePath,[switch]$Interactive)
$requestedRoot=$RuntimeRoot; $requestedLease=$LeasePath; $requestedInteractive=$Interactive
. ${quote(repair)}
if (-not $requestedInteractive) { Invoke-ApiControlRepair -RuntimeRoot $requestedRoot -LeasePath $requestedLease | ConvertTo-Json -Depth 4; return }
function Read-Host {
  $current=Get-Process -Id $PID
  [IO.File]::WriteAllText(${quote(path.join(temporary, 'helper-ready.json'))}, ([pscustomobject]@{pid=$PID;startedTicks=$current.StartTime.ToUniversalTime().Ticks.ToString()} | ConvertTo-Json))
  while (-not (Test-Path -LiteralPath ${quote(path.join(temporary, 'continue.txt'))})) { Start-Sleep -Milliseconds 50 }
  return 'Y'
}
function Get-RunningApiHosts {
  $hostPid=[int][IO.File]::ReadAllText(${quote(path.join(temporary, 'extension-pid.txt'))})
  if (Get-Process -Id $hostPid -ErrorAction SilentlyContinue) { [pscustomobject]@{ProcessId=$hostPid;Name='Isolated Extension Host'} }
}
$result=Invoke-InteractiveApiControlRepair -RuntimeRoot $requestedRoot -LeasePath $requestedLease
[IO.File]::WriteAllText(${quote(path.join(temporary, 'helper-result.json'))}, ($result | ConvertTo-Json -Depth 4))
`, 'utf8');
  for (const phase of ['blocked', 'reconnected']) {
    const hostLog = createWriteStream(path.join(evidence, phase + '.log'));
    console.log('Packaged recovery phase: ' + phase);
    try { await runTests({ vscodeExecutablePath: executable, extensionDevelopmentPath: extensionPath,
      extensionTestsPath: path.join(root, 'test/fixtures/api-control-recovery-entry.cjs'),
      stdout: hostLog, stderr: hostLog,
      launchArgs: ['--disable-workspace-trust', '--skip-welcome', '--skip-release-notes', '--disable-extensions',
        '--user-data-dir=' + path.join(temporary, 'profile'), '--extensions-dir=' + path.join(temporary, 'extensions')],
      extensionTestsEnv: { ...hostEnvironment.env, GLW_RECOVERY_FIXTURE: temporary, GLW_RECOVERY_REPORT_DIR: evidence, GLW_RECOVERY_PHASE: phase, GITLAB_WORKSPACE_RUNTIME_DIR: runtime } });
    } finally { hostLog.end(); }
    if (phase === 'blocked') {
      const hostPid = Number(await readFile(path.join(temporary, 'extension-pid.txt'), 'utf8'));
      assert.throws(() => process.kill(hostPid, 0), { code: 'ESRCH' });
      helper = JSON.parse(await readFile(path.join(temporary, 'helper-ready.json'), 'utf8'));
      process.kill(helper.pid, 0);
      assert.equal((await readFile(path.join(temporary, 'blocked.json'), 'utf8')).includes('"requests":0'), true);
      await writeFile(path.join(temporary, 'continue.txt'), 'continue after Extension Host exit');
      const deadline = Date.now() + 20_000;
      let result;
      for (;;) {
        try { result = JSON.parse(await readFile(path.join(temporary, 'helper-result.json'), 'utf8')); break; }
        catch (error) { if (error.code !== 'ENOENT' && !(error instanceof SyntaxError) || Date.now() >= deadline) throw error; }
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      assert.equal(result.Status, 'Removed');
      await assert.rejects(lstat(lock), { code: 'ENOENT' });
      await copyFile(path.join(temporary, 'helper-result.json'), path.join(evidence, 'helper-result.json'));
    }
    await copyFile(path.join(temporary, phase + '.json'), path.join(evidence, phase + '.json'));
  }
  await writeFile(path.join(evidence, 'verification.json'), JSON.stringify({ success: true, version: manifest.version,
    vsixSha256: createHash('sha256').update(await readFile(vsix)).digest('hex'), helperSurvivedHostExit: true,
    confirmationAndProcessObservation: 'isolated fixture substitutes human input and observes only its Extension Host',
    reconnected: JSON.parse(await readFile(path.join(evidence, 'reconnected.json'), 'utf8')) }, null, 2));
  console.log('Packaged recovery lifecycle passed: ' + evidence);
} finally {
  await cp(path.join(temporary, 'profile/logs'), path.join(evidence, 'host-logs'), { recursive: true }).catch(() => undefined);
  if (!helper) helper = await readFile(path.join(temporary, 'helper-ready.json'), 'utf8').then(JSON.parse).catch(() => undefined);
  if (helper) powershell(`$p=Get-Process -Id ${Number(helper.pid)} -ErrorAction SilentlyContinue; if ($p -and $p.ProcessName -eq 'powershell' -and $p.StartTime.ToUniversalTime().Ticks.ToString() -eq ${quote(String(helper.startedTicks))}) { Stop-Process -Id $p.Id }`);
  const resolved = await realpath(temporary);
  // eslint-disable-next-line no-unsafe-finally -- Never delete a fixture until its resolved boundary has been verified.
  if (path.dirname(resolved) !== parent || !path.basename(resolved).startsWith('glw-recovery-lifecycle-')) throw new Error('Unsafe lifecycle cleanup path.');
  await rm(resolved, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
