import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { lstat, readFile, unlink } from 'node:fs/promises';
import path from 'node:path';
import { LocalNetworkLease, networkRuntimeRoot } from '../api/localNetworkLease';

export interface GitProcessOutput { code: number; stdout: string; stderr: string; truncated: boolean; }

/** Own the complete subprocess lifetime; an aborted Git helper must not retain pipes or locks. */
export async function captureGitProcess(executable: string, args: readonly string[], options: {
  cwd?: string; env?: NodeJS.ProcessEnv; signal?: AbortSignal; timeoutMs?: number;
  maxStdoutBytes?: number; allowTruncated?: boolean; input?: string; onStderr?: (text: string) => void;
  network?: boolean;
} = {}): Promise<GitProcessOutput> {
  const timeoutMs = options.timeoutMs ?? 300_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2_147_483_647) return Promise.reject(new RangeError('Git timeout must be a positive 32-bit integer.'));
  if (options.signal?.aborted) return Promise.reject(aborted());
  const network = options.network ?? isGitNetworkCommand(args);
  const lease = network
    ? await LocalNetworkLease.acquire(path.join(networkRuntimeRoot(), 'git-network.lock'), 'git', { signal: options.signal, timeoutMs }) : undefined;
  let processTreeConfirmed = !lease;
  const supervised = process.platform === 'win32' && !!lease;
  const nonce = randomUUID();
  const receiptPath = lease ? path.join(lease.directory, `execution-${nonce}.json`) : undefined;
  try {
    await lease?.update({ state: 'starting', childPid: null, processTreeConfirmed: false });
    if (options.signal?.aborted) { processTreeConfirmed = true; throw aborted(); }
    return await new Promise<GitProcessOutput>((resolve, reject) => {
    const child = spawn(supervised ? 'powershell.exe' : executable,
      supervised ? ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.resolve(__dirname, '../../../resources/windows-git-supervisor.ps1')] : [...args],
      // Git before 2.46 ignores GIT_NO_LAZY_FETCH. An empty transport allowlist
      // also stops implicit promisor fetches during supposedly local reads.
      { cwd: options.cwd, env: { ...process.env, ...options.env, GIT_NO_LAZY_FETCH: '1', ...(!network ? { GIT_ALLOW_PROTOCOL: '' } : {}) }, shell: false, windowsHide: true, detached: process.platform !== 'win32',
      stdio: [supervised || options.input !== undefined ? 'pipe' : 'ignore', 'pipe', 'pipe'] });
    const output: Buffer[] = [], errors: Buffer[] = [];
    let bytes = 0, received = 0, errorBytes = 0, truncated = false, settled = false, interrupted: Error | undefined;
    let termination: Promise<void> | undefined;
    const recording = lease?.update({ state: 'running', childPid: child.pid ?? null, childStartedAt: new Date().toISOString() }) ?? Promise.resolve();
    const stop = (error?: Error): void => {
      if (error) interrupted ??= error;
      if (termination) return;
      termination = new Promise<void>(done => {
        if (process.platform !== 'win32' || !child.pid) {
          if (!child.pid) { processTreeConfirmed = true; done(); return; }
          try { process.kill(-child.pid, 'SIGTERM'); } catch { child.kill(); }
          setTimeout(() => {
            try { process.kill(-child.pid!, 'SIGKILL'); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') processTreeConfirmed = true; }
            setTimeout(() => {
              try { process.kill(-child.pid!, 0); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') processTreeConfirmed = true; }
              done();
            }, 50);
          }, 250);
          return;
        }
        // The PID is the directly spawned child, never a user-supplied process identifier.
        const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
        killer.once('error', () => { child.kill(); done(); });
        killer.once('close', code => { processTreeConfirmed = code === 0; child.kill(); done(); });
      });
    };
    const onAbort = (): void => stop(aborted());
    options.signal?.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(() => stop(Object.assign(new Error('Git operation timed out.'), { name: 'TimeoutError' })), timeoutMs);
    const cleanup = (): void => { clearTimeout(timer); options.signal?.removeEventListener('abort', onAbort); };
    child.stdout?.on('data', (raw: Buffer) => {
      const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
      const limit = options.maxStdoutBytes ?? 8 * 1024 * 1024;
      if (bytes < limit) { const part = chunk.subarray(0, limit - bytes); output.push(part); bytes += part.length; }
      received += chunk.length;
      if (received > limit) {
        truncated = true;
        stop(options.allowTruncated ? undefined : Object.assign(new Error('Git output exceeds the supported size; the result was not treated as complete.'), { name: 'GitOutputLimitError' }));
      }
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      if (errorBytes < 64 * 1024) { const part = chunk.subarray(0, 64 * 1024 - errorBytes); errors.push(part); errorBytes += part.length; }
      try { options.onStderr?.(chunk.toString('utf8')); } catch { /* Progress consumers cannot change Git's result. */ }
    });
    child.once('error', error => {
      if (settled) return;
      if (child.pid) { stop(error); return; }
      settled = true; cleanup(); processTreeConfirmed = true;
      void recording.then(() => reject(interrupted ?? error), reject);
    });
    child.once('close', code => {
      if (settled) return;
      settled = true;
      void (async () => {
        if (!termination && !supervised) {
          if (process.platform === 'win32' || !child.pid) processTreeConfirmed = true;
          else {
            // Git can exit just before its local transport helper is reaped.
            // Keep admission, cancellation and the deadline active while the
            // whole group settles; elapsed time never confirms completion.
            const groupExited = await waitForProcessGroupExit(child.pid, () => !!termination);
            if (groupExited) processTreeConfirmed = true;
            if (!groupExited && !termination) stop(new Error('Git exited while a helper was still running; the result is incomplete.'));
          }
        }
        await Promise.all([recording, termination ?? Promise.resolve()]);
        if (supervised && !termination) {
          try {
            const info = await lstat(receiptPath!);
            if (!info.isFile() || info.isSymbolicLink() || info.size > 1024) throw new Error('Invalid Git execution receipt.');
            const receipt = JSON.parse(await readFile(receiptPath!, 'utf8'));
            if (receipt.schema !== 'GitLabWorkspaceGitExecution/v1' || receipt.nonce !== nonce || receipt.processTreeConfirmed !== true || !Number.isSafeInteger(receipt.exitCode)) throw new Error('Invalid Git execution receipt.');
            code = receipt.exitCode; processTreeConfirmed = true;
          } catch (error) {
            throw Object.assign(new Error('Git process-tree completion could not be confirmed; its network lease is quarantined.'), { cause: error });
          }
        }
        if (interrupted) throw interrupted;
        return { code: code ?? -1, stdout: new TextDecoder().decode(Buffer.concat(output), { stream: truncated }), stderr: Buffer.concat(errors).toString('utf8'), truncated };
      })().then(resolve, reject).finally(cleanup);
    });
    if (supervised || options.input !== undefined) {
      child.stdin?.on('error', () => undefined);
      child.stdin?.end(supervised ? JSON.stringify({ schema: 'GitLabWorkspaceWindowsGit/v1', executable, args, cwd: options.cwd, timeoutMs, receiptPath, nonce, inputBase64: options.input === undefined ? undefined : Buffer.from(options.input).toString('base64') }) : options.input);
    }
    if (options.signal?.aborted) onAbort();
    void recording.catch(error => stop(error instanceof Error ? error : new Error('Could not record Git subprocess ownership.')));
  });
  } finally {
    if (lease) {
      // Only our exact nonce-named receipt is removed; unknown metadata keeps the lease blocked.
      if (receiptPath) await unlink(receiptPath).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; });
      await lease.update({ processTreeConfirmed, ...(processTreeConfirmed ? {} : { state: 'quarantined' as const }) });
      await lease.release();
    }
  }
}

async function waitForProcessGroupExit(pid: number, stopping: () => boolean): Promise<boolean> {
  const deadline = performance.now() + 500;
  while (!stopping()) {
    try { process.kill(-pid, 0); }
    catch (error) { return (error as NodeJS.ErrnoException).code === 'ESRCH'; }
    if (performance.now() >= deadline) return false;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  return false;
}

export function isGitNetworkCommand(args: readonly string[]): boolean {
  for (let index = 0; index < args.length; index++) {
    const value = args[index];
    if (['-c', '-C', '--git-dir', '--work-tree', '--namespace', '--config-env'].includes(value)) { index++; continue; }
    if (value.startsWith('-')) continue;
    return ['fetch', 'push', 'pull', 'clone', 'ls-remote', 'submodule'].includes(value);
  }
  return false;
}

function aborted(): Error { return Object.assign(new Error('Git operation cancelled.'), { name: 'AbortError' }); }
