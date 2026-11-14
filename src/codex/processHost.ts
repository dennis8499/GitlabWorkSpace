/** A pipe-owning supervisor: an Extension Host crash closes stdin and stops the owned tree. */
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { windowsTaskkillComplete } from './processTermination';
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
let nativeExited = false, pipesSettled = false;
function settleOwnedPipes(processTreeConfirmed: boolean): void {
  // A killed native process can leave inherited pipe handles open. Completion
  // of its owned tree and its own exit must both precede releasing these pipes.
  if (!processTreeConfirmed || !nativeExited || pipesSettled) return;
  pipesSettled = true;
  child.stdout.unpipe(process.stdout); child.stderr.unpipe(process.stderr);
  child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy();
}
function stop(): void {
  if (stopping) return;
  stopping = true;
  process.stdin.unpipe(child.stdin);
  if (!child.pid) { process.exitCode = 1; return; }
  if (process.platform === 'win32') {
    stopped = new Promise(resolve => {
      const killer = spawn('taskkill.exe', ['/PID', String(child.pid!), '/T', '/F'], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      let output = '';
      const collect = (bytes: Buffer): void => { if (output.length <= 1024 * 1024) output += bytes.toString('latin1'); };
      killer.stdout.on('data', collect); killer.stderr.on('data', collect);
      killer.once('error', () => { child.kill(); resolve(false); });
      killer.once('close', code => {
        child.kill();
        const deadline = Date.now() + 1500;
        const confirm = (): void => {
          if (windowsTaskkillComplete(code, child.pid!, output)) resolve(true);
          else if (code === 128 && Date.now() < deadline) setTimeout(confirm, 100);
          else resolve(false);
        };
        confirm();
      });
    });
  } else {
    try { process.kill(-child.pid, 'SIGKILL'); stopped = Promise.resolve(true); } catch { child.kill('SIGKILL'); stopped = Promise.resolve(false); }
  }
  void stopped.then(settleOwnedPipes);
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
child.once('exit', () => {
  nativeExited = true;
  if (stopped) void stopped.then(settleOwnedPipes);
});
child.once('error', () => { if (!child.pid) stopped = Promise.resolve(true); process.exitCode = 1; process.stdin.destroy(); });
child.once('close', code => {
  void (async () => {
    const processTreeConfirmed = await stopped ?? false;
    let failure: 'native-exited-before-stop' | 'tree-stop-unconfirmed' | 'receipt-write-failed' | undefined;
    if (!processTreeConfirmed) failure = stopped ? 'tree-stop-unconfirmed' : 'native-exited-before-stop';
    else if (receiptPath) {
      if (!/^[a-z0-9-]{16,128}$/i.test(nonce)) failure = 'receipt-write-failed';
      else try { writeFileSync(receiptPath, JSON.stringify({ schema: 'GitLabWorkspaceCodexProcess/v1', nonce, processTreeConfirmed }), { flag: 'wx', mode: 0o600 }); }
      catch { failure = 'receipt-write-failed'; }
    }
    if (failure) {
      // Stable, non-sensitive markers survive the transport's sanitized stderr
      // tail. Native exit or a requested stop alone is never tree-stop proof.
      try { process.stderr.write(`GitLabWorkspace Codex supervisor: ${failure}\n`); } catch { /* The exit code still reports failure. */ }
    }
    process.exitCode = failure ? 1 : stopping ? 0 : code ?? 1; process.stdin.destroy();
  })();
});
