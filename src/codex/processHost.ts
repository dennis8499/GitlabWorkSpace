/** A pipe-owning supervisor: an Extension Host crash closes stdin and stops the owned tree. */
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
const [executable, cwd, receiptPath, nonce] = process.argv.slice(2);
if (!executable || !cwd) process.exit(2);
const childEnvironment = { ...process.env };
delete childEnvironment.ELECTRON_RUN_AS_NODE;
delete childEnvironment.ELECTRON_NO_ASAR;
const child = spawn(executable, ['app-server', '--listen', 'stdio://'], {
  cwd, env: childEnvironment, shell: false, windowsHide: true, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe']
});
let stopping = false;
let stopped: Promise<boolean> | undefined;
function stop(): void {
  if (stopping) return;
  stopping = true;
  process.stdin.unpipe(child.stdin);
  if (!child.pid) { process.exitCode = 1; return; }
  if (process.platform === 'win32') {
    stopped = new Promise(resolve => {
      const killer = spawn('taskkill.exe', ['/PID', String(child.pid!), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      killer.once('error', () => { child.kill(); resolve(false); });
      killer.once('close', code => { child.kill(); resolve(code === 0); });
    });
  } else {
    try { process.kill(-child.pid, 'SIGKILL'); stopped = Promise.resolve(true); } catch { child.kill('SIGKILL'); stopped = Promise.resolve(false); }
  }
}
// Keep the native process alive until the supervisor has terminated its whole tree.
process.stdin.pipe(child.stdin, { end: false });
child.stdout.pipe(process.stdout);
child.stderr.pipe(process.stderr);
process.stdin.once('end', stop);
process.stdin.once('error', stop);
process.stdout.once('error', stop);
child.stdin.on('error', stop);
process.once('SIGTERM', stop);
process.once('SIGINT', stop);
child.once('error', () => { process.exitCode = 1; process.stdin.destroy(); });
child.once('close', code => {
  void (async () => {
    const processTreeConfirmed = await stopped ?? false;
    if (receiptPath && /^[a-z0-9-]{16,128}$/i.test(nonce) && processTreeConfirmed) {
      try { writeFileSync(receiptPath, JSON.stringify({ schema: 'GitLabWorkspaceCodexProcess/v1', nonce, processTreeConfirmed }), { flag: 'wx', mode: 0o600 }); }
      catch { /* The parent retains its lease if the receipt cannot be saved. */ }
    }
    process.exitCode = stopping ? 0 : code ?? 1; process.stdin.destroy();
  })();
});
