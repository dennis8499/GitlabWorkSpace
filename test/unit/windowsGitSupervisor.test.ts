import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, stat, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';

const script = path.resolve(__dirname, '../../../resources/windows-git-supervisor.ps1');
async function start(t: TestContext, executable: string, args: string[], timeoutMs = 10_000, input = Buffer.alloc(0), runtimeDirectory?: string) {
  const parent = await realpath(os.tmpdir());
  const runtime = runtimeDirectory ?? await mkdtemp(path.join(parent, 'glw-windows-supervisor-'));
  if (!runtimeDirectory) t.after(() => rm(runtime, { recursive: true, force: true }));
  const directory = path.join(runtime, `lease-${randomUUID()}`); await mkdir(directory);
  const receiptPath = path.join(directory, 'execution.json'), nonce = randomUUID();
  const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  const output: Buffer[] = [], errors: Buffer[] = [];
  child.stdout.on('data', (bytes: Buffer) => output.push(bytes)); child.stderr.on('data', (bytes: Buffer) => errors.push(bytes));
  const done = new Promise<{ code: number | null; stdout: Buffer; stderr: Buffer }>((resolve, reject) => {
    const timer = setTimeout(() => { child.kill(); reject(new Error('Windows supervisor fixture did not settle.')); }, 30_000);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', code => { clearTimeout(timer); resolve({ code, stdout: Buffer.concat(output), stderr: Buffer.concat(errors) }); });
  });
  child.stdin.on('error', () => undefined);
  child.stdin.end(JSON.stringify({ schema: 'GitLabWorkspaceWindowsGit/v1', executable, args, cwd: directory, timeoutMs, receiptPath, nonce, inputBase64: input.toString('base64') }));
  return { child, done, output, nonce, receiptPath, receipt: async () => JSON.parse(await readFile(receiptPath, 'utf8')) };
}
function running(pid: number): boolean { try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code !== 'ESRCH'; } }
async function gone(pid: number): Promise<void> {
  for (let attempt = 0; attempt < 50 && running(pid); attempt++) await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(running(pid), false, `owned process ${pid} must exit before the operation can be released`);
}

test('Windows Job supervision preserves binary stdin/stdout/stderr and records the real Git exit code', { skip: process.platform !== 'win32' }, async t => {
  const input = Buffer.from([0, 255, 128, 13, 10, 228, 184, 173]);
  const run = await start(t, process.execPath, ['-e', "process.stdin.on('data', b => process.stdout.write(b)); process.stdin.on('end', () => { process.stderr.write(Buffer.from([0,255,13,10])); process.exitCode = 7; });"], 10_000, input);
  const result = await run.done;
  assert.deepEqual(result.stdout, input); assert.deepEqual(result.stderr, Buffer.from([0, 255, 13, 10]));
  assert.deepEqual(await run.receipt(), { schema: 'GitLabWorkspaceGitExecution/v1', nonce: run.nonce, exitCode: 7, processTreeConfirmed: true });
});

test('Windows Git argv is quoted without evaluating PowerShell syntax or changing Unicode, quotes, and trailing slashes', { skip: process.platform !== 'win32' }, async t => {
  const expected = ['', 'space argument', 'a"b', 'tail\\', 'slash\\"quote', '中文', '$(throw 1); & echo unsafe'];
  const run = await start(t, process.execPath, ['-e', 'process.stdout.write(JSON.stringify(process.argv.slice(1)))', '--', ...expected]);
  const result = await run.done;
  assert.deepEqual(JSON.parse(result.stdout.toString('utf8')), expected, result.stderr.toString('utf8'));
  assert.equal((await run.receipt()).exitCode, 0);
});

test('normal root-process exit cannot confirm a still-running descendant; the Job terminates it and leaves no success receipt', { skip: process.platform !== 'win32' }, async t => {
  const code = "const child = require('node:child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {stdio:'inherit', detached:true}); process.stdout.write(String(child.pid)); setTimeout(() => process.exit(0), 100);";
  const run = await start(t, process.execPath, ['-e', code]); const result = await run.done;
  const pid = Number(result.stdout.toString('utf8')); assert.ok(Number.isSafeInteger(pid) && pid > 0, result.stderr.toString('utf8'));
  await gone(pid); await assert.rejects(run.receipt(), { code: 'ENOENT' });
});

test('a Git deadline kills its complete Windows Job before any completion can be confirmed', { skip: process.platform !== 'win32' }, async t => {
  const code = "const child = require('node:child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {stdio:'inherit'}); process.stdout.write(JSON.stringify([process.pid, child.pid])); setInterval(() => {}, 1000);";
  const run = await start(t, process.execPath, ['-e', code], 300); const result = await run.done;
  const pids = JSON.parse(result.stdout.toString('utf8')); for (const pid of pids) await gone(pid);
  await assert.rejects(run.receipt(), { code: 'ENOENT' });
});

test('terminating the Windows supervisor closes the Job and does not strand Git helpers', { skip: process.platform !== 'win32' }, async t => {
  const run = await start(t, process.execPath, ['-e', 'process.stdout.write(String(process.pid)); setInterval(() => {}, 1000);']);
  for (let attempt = 0; attempt < 500 && !run.output.length; attempt++) await new Promise(resolve => setTimeout(resolve, 20));
  const pid = Number(Buffer.concat(run.output).toString('utf8')); assert.ok(pid > 0);
  run.child.kill(); await run.done; await gone(pid); await assert.rejects(run.receipt(), { code: 'ENOENT' });
});

test('the supervisor executes a local Git command under the same Job protocol', { skip: process.platform !== 'win32' }, async t => {
  const run = await start(t, 'git', ['--version']); const result = await run.done;
  assert.match(result.stdout.toString('utf8'), /^git version /, result.stderr.toString('utf8'));
  assert.equal((await run.receipt()).processTreeConfirmed, true);
});


test('verified Windows supervisor cache is reused on warm starts and a modified DLL fails before Git starts', { skip: process.platform !== 'win32' }, async t => {
  const runtime = await mkdtemp(path.join(await realpath(os.tmpdir()), 'glw-supervisor-cache-'));
  t.after(() => rm(runtime, { recursive: true, force: true }));
  // Temporary directories in the sandbox inherit a writable sandbox group.
  // Establish the same private per-user boundary as LocalAppData before caching.
  const secured = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    '$directory=[IO.DirectoryInfo]::new([Console]::In.ReadToEnd()); $acl=$directory.GetAccessControl(); $acl.SetAccessRuleProtection($true,$false); $sid=[Security.Principal.WindowsIdentity]::GetCurrent().User; $rule=[Security.AccessControl.FileSystemAccessRule]::new($sid,"FullControl","ContainerInherit,ObjectInherit","None","Allow"); $acl.AddAccessRule($rule); $directory.SetAccessControl($acl)'], { input: runtime, windowsHide: true });
  assert.equal(secured.status, 0, secured.stderr.toString());
  const started = performance.now();
  const cold = await start(t, 'git', ['--version'], 10_000, Buffer.alloc(0), runtime); await cold.done; assert.equal((await cold.receipt()).exitCode, 0);
  const coldMs = performance.now() - started;
  const cacheRoot = path.join(runtime, 'windows-git-supervisor-cache-v1');
  const entries = (await readdir(cacheRoot)).filter(name => /^[a-f0-9]{64}$/.test(name)); assert.equal(entries.length, 1);
  const dll = path.join(cacheRoot, entries[0], 'supervisor.dll'), modified = (await stat(dll)).mtimeMs;
  const warmStart = performance.now();
  const warm = await start(t, 'git', ['--version'], 10_000, Buffer.alloc(0), runtime); await warm.done; assert.equal((await warm.receipt()).exitCode, 0);
  const warmMs = performance.now() - warmStart; assert.equal((await stat(dll)).mtimeMs, modified, 'a warm invocation never recompiles its validated source');
  t.diagnostic(`supervisor local Git cold=${coldMs.toFixed(1)}ms warm=${warmMs.toFixed(1)}ms`);
  const verifiedBytes = await readFile(dll);
  await writeFile(dll, Buffer.from('unverified binary fixture'));
  const rejected = await start(t, process.execPath, ['-e', 'process.stdout.write("MUST_NOT_START")'], 10_000, Buffer.alloc(0), runtime);
  const result = await rejected.done; assert.equal(result.stdout.length, 0); assert.match(result.stderr.toString(), /could not be processed/);
  await assert.rejects(rejected.receipt(), { code: 'ENOENT' });
  await writeFile(dll, verifiedBytes);
  const entry = path.dirname(dll), moved = entry + '-fixture';
  await rename(entry, moved); await symlink(moved, entry, 'junction');
  const linked = await start(t, process.execPath, ['-e', 'process.stdout.write("MUST_NOT_START")'], 10_000, Buffer.alloc(0), runtime);
  assert.equal((await linked.done).stdout.length, 0); await assert.rejects(linked.receipt(), { code: 'ENOENT' });
});
