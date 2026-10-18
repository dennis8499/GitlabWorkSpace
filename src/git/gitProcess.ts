import { spawn } from 'node:child_process';

export interface GitProcessOutput { code: number; stdout: string; stderr: string; truncated: boolean; }

/** Own the complete subprocess lifetime; an aborted Git helper must not retain pipes or locks. */
export function captureGitProcess(executable: string, args: readonly string[], options: {
  cwd?: string; env?: NodeJS.ProcessEnv; signal?: AbortSignal; timeoutMs?: number;
  maxStdoutBytes?: number; allowTruncated?: boolean; input?: string; onStderr?: (text: string) => void;
} = {}): Promise<GitProcessOutput> {
  const timeoutMs = options.timeoutMs ?? 300_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) return Promise.reject(new RangeError('Git timeout must be positive.'));
  if (options.signal?.aborted) return Promise.reject(aborted());
  return new Promise((resolve, reject) => {
    const child = spawn(executable, [...args], { cwd: options.cwd, env: options.env, shell: false, windowsHide: true, detached: process.platform !== 'win32',
      stdio: [options.input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'] });
    const output: Buffer[] = [], errors: Buffer[] = [];
    let bytes = 0, received = 0, errorBytes = 0, truncated = false, settled = false, interrupted: Error | undefined;
    let termination: Promise<void> | undefined;
    const stop = (error?: Error): void => {
      if (error) interrupted ??= error;
      if (termination) return;
      termination = new Promise<void>(done => {
        if (process.platform !== 'win32' || !child.pid) {
          try { if (child.pid) process.kill(-child.pid, 'SIGTERM'); else child.kill(); } catch { child.kill(); }
          done(); return;
        }
        // The PID is the directly spawned child, never a user-supplied process identifier.
        const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
        killer.once('error', () => { child.kill(); done(); });
        killer.once('close', () => { child.kill(); done(); });
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
    child.once('error', error => { if (!settled) { settled = true; cleanup(); reject(interrupted ?? error); } });
    child.once('close', code => {
      if (settled) return;
      settled = true; cleanup();
      void (termination ?? Promise.resolve()).then(() => {
        if (interrupted) reject(interrupted);
        else resolve({ code: code ?? -1, stdout: new TextDecoder().decode(Buffer.concat(output), { stream: truncated }), stderr: Buffer.concat(errors).toString('utf8'), truncated });
      });
    });
    if (options.input !== undefined) { child.stdin?.on('error', () => undefined); child.stdin?.end(options.input); }
    if (options.signal?.aborted) onAbort();
  });
}

function aborted(): Error { return Object.assign(new Error('Git operation cancelled.'), { name: 'AbortError' }); }
