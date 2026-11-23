import { AsyncLocalStorage } from 'node:async_hooks';
import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { promisify } from 'node:util';

export const windowsLeaseLauncher = path.resolve(__dirname, '../../../resources/windows-local-lease.ps1');
export const windowsLeasePowerShell = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const execFileAsync = promisify(execFile);
const greeting = 'GitLabWorkspaceWindowsLease/v2';
const powershellArgs = ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', windowsLeaseLauncher];
const supervisorTimeout = 0xe0470001;

export interface WindowsLeaseToken {
  directory: string; kind: string; nonce: string; pid: number; birth: string; directoryId: string;
}

export class WindowsLeaseError extends Error {
  constructor(readonly coordinationCode: string, readonly nativeCode?: number, options?: ErrorOptions) {
    super(coordinationCode, options);
    this.name = 'WindowsLeaseError';
  }
}

interface Pending {
  resolve(data: Record<string, unknown>): void;
  reject(error: Error): void;
}

class LeaseBroker {
  private ready = false;
  private readonly pending: Pending[] = [];
  private readonly worker: ChildProcessWithoutNullStreams;
  readonly started: Promise<LeaseBroker>;

  constructor() {
    const worker = this.worker = spawn(windowsLeasePowerShell, powershellArgs, { windowsHide: true });
    let start!: () => void;
    let failed!: (error: Error) => void;
    this.started = new Promise<void>((resolve, reject) => { start = resolve; failed = reject; }).then(() => this);
    const startup = setTimeout(() => worker.kill(), 8_000);
    const disconnected = () => {
      clearTimeout(startup);
      if (broker === this) broker = undefined;
      const error = new WindowsLeaseError('native-disconnected');
      failed(error);
      for (const operation of this.pending.splice(0)) operation.reject(error);
    };
    worker.once('error', disconnected);
    worker.once('close', disconnected);
    worker.stdin.on('error', () => worker.kill());
    worker.stderr.resume();
    createInterface({ input: worker.stdout, crlfDelay: Infinity }).on('line', line => {
      if (!this.ready) {
        if (line !== greeting) { worker.kill(); return; }
        this.ready = true;
        clearTimeout(startup);
        start();
        this.reference(false);
        return;
      }
      const operation = this.pending.shift();
      if (!operation) { worker.kill(); return; }
      try {
        const response = JSON.parse(line);
        if (response?.ok === true && response.data && typeof response.data === 'object') operation.resolve(response.data);
        else if (response?.ok === false && typeof response.code === 'string') {
          operation.reject(new WindowsLeaseError(response.code, response.nativeCode));
        } else throw new Error('Invalid Windows lease response.');
      } catch (error) {
        operation.reject(new WindowsLeaseError('native-disconnected'));
        worker.kill();
      }
      if (!this.pending.length) this.reference(false);
    });
  }

  private reference(active: boolean): void {
    active ? this.worker.ref() : this.worker.unref();
    for (const stream of [this.worker.stdin, this.worker.stdout, this.worker.stderr]) {
      (stream as typeof stream & { ref?(): void; unref?(): void })[active ? 'ref' : 'unref']?.();
    }
  }

  request(input: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (this.worker.exitCode !== null || this.worker.killed) return Promise.reject(new WindowsLeaseError('native-disconnected'));
    this.reference(true);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.worker.kill(), 5_000);
      this.pending.push({
        resolve: value => { clearTimeout(timer); resolve(value); },
        reject: error => { clearTimeout(timer); reject(error); }
      });
      this.worker.stdin.write(JSON.stringify(input) + '\n');
    });
  }
}

let broker: LeaseBroker | undefined;
let localBirth: string | undefined;
const currentBroker = () => (broker ??= new LeaseBroker()).started;

async function request(input: Record<string, unknown>, initial: LeaseBroker): Promise<Record<string, unknown>> {
  try { return await initial.request(input); }
  catch (error) {
    if (!(error instanceof WindowsLeaseError) || error.coordinationCode !== 'native-disconnected') throw error;
    // The request may have committed. Reconnect and repeat the same nonce.
    if (broker === initial) broker = undefined;
    return (await currentBroker()).request(input);
  }
}

export async function windowsProcessBirth(pid: number): Promise<string | null> {
  const result = await request({ action: 'probe', pid }, await currentBroker());
  if (result.birth !== null && typeof result.birth !== 'string') throw new WindowsLeaseError('native-disconnected');
  return result.birth;
}

export async function tryWindowsLease(directory: string, kind: string, options: {
  deadline?: number; timeoutMs: number; signal?: AbortSignal;
}): Promise<{ token: WindowsLeaseToken; recovered: boolean } | undefined> {
  options.signal?.throwIfAborted();
  let client: LeaseBroker;
  try {
    client = await currentBroker();
    localBirth ??= await windowsProcessBirth(process.pid) ?? undefined;
    if (!localBirth) return undefined;
  } catch { return undefined; } // Startup and probing have not touched the lease.
  await mkdir(path.dirname(directory), { recursive: true, mode: 0o700 });
  const claim = { action: 'claim', kind, directory: path.resolve(directory), nonce: randomUUID(), pid: process.pid, birth: localBirth };
  // Startup is separate from the local contention window. API admission
  // still supplies an absolute deadline that may already have elapsed.
  const absoluteDeadline = options.deadline ?? Infinity;
  const deadline = Math.min(absoluteDeadline, Date.now() + options.timeoutMs);
  const nonwaiting = options.deadline === undefined && options.timeoutMs === 1;
  let missingSince: number | undefined;
  let contention: WindowsLeaseError | undefined;
  for (;;) {
    options.signal?.throwIfAborted();
    if (Date.now() >= absoluteDeadline || contention && Date.now() >= deadline)
      throw new WindowsLeaseError('queue-timeout', contention?.nativeCode, { cause: contention });
    try {
      const data = await request(claim, broker ?? client);
      if (typeof data.directoryId !== 'string') throw new WindowsLeaseError('native-disconnected');
      const token = { directory: claim.directory, kind, nonce: claim.nonce, pid: claim.pid, birth: claim.birth, directoryId: data.directoryId };
      if (options.signal?.aborted || Date.now() >= absoluteDeadline) {
        await releaseWindowsLease(token);
        options.signal?.throwIfAborted();
        throw new WindowsLeaseError('queue-timeout');
      }
      return { token, recovered: data.recovered === true };
    } catch (error) {
      if (!(error instanceof WindowsLeaseError)) throw error;
      if (error.coordinationCode === 'metadata-missing') {
        missingSince ??= performance.now();
        if (!nonwaiting && performance.now() - missingSince > 2_000) throw error;
      } else {
        missingSince = undefined;
        if (error.coordinationCode !== 'busy' && ![32, 33].includes(error.nativeCode ?? 0)) throw error;
      }
      contention = error;
      const remaining = deadline - Date.now();
      if (nonwaiting || remaining <= 0) throw new WindowsLeaseError('queue-timeout', error.nativeCode, { cause: error });
      const poll = kind === 'api-control' ? 8 : 75;
      await new Promise<void>(resolve => setTimeout(resolve, Math.min(poll, remaining)));
    }
  }
}

export async function releaseWindowsLease(token: WindowsLeaseToken, deadline = Infinity, signal?: AbortSignal): Promise<void> {
  const end = Math.min(deadline, Date.now() + 2_000);
  for (;;) {
    signal?.throwIfAborted();
    if (Date.now() >= deadline) throw new WindowsLeaseError('queue-timeout');
    try {
      const client = await currentBroker();
      signal?.throwIfAborted();
      if (Date.now() >= deadline) throw new WindowsLeaseError('queue-timeout');
      await request({ ...token, action: 'release' }, client);
      return;
    }
    catch (error) {
      if (!(error instanceof WindowsLeaseError) || Date.now() >= end ||
          error.coordinationCode !== 'busy' && ![5, 32, 33].includes(error.nativeCode ?? 0)) throw error;
      await new Promise<void>(resolve => setTimeout(resolve, 10));
    }
  }
}

export async function windowsLeaseActive(token: WindowsLeaseToken): Promise<boolean> {
  return (await request({ ...token, action: 'status' }, await currentBroker())).active !== 0;
}

const executionLeases = new AsyncLocalStorage<() => readonly WindowsLeaseToken[]>();
export function windowsExecutionLeases(additional: readonly WindowsLeaseToken[] = []): WindowsLeaseToken[] {
  return [...new Map([...(executionLeases.getStore()?.() ?? []), ...additional].map(lease => [lease.nonce, lease])).values()];
}
export function withWindowsExecutionLeases<T>(leases: readonly WindowsLeaseToken[], task: () => T): T {
  const parent = executionLeases.getStore();
  return executionLeases.run(() => [...(parent?.() ?? []), ...leases], task);
}

export interface WindowsProcessOptions {
  cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs: number; signal?: AbortSignal; input?: string;
  maxStdoutBytes: number; allowTruncated?: boolean; onStderr?: (text: string) => void;
}

export interface WindowsProcessResult { code: number; stdout: string; stderr: string; truncated: boolean; }

export async function execLeasedFile(executable: string, args: readonly string[], options: {
  cwd: string; env: NodeJS.ProcessEnv; timeout: number; maxBuffer: number;
}, extra: readonly WindowsLeaseToken[] = []): Promise<{ stdout: string; stderr: string }> {
  const leases = windowsExecutionLeases(extra);
  if (!leases.length) return execFileAsync(executable, args, { ...options, windowsHide: true });
  const result = await runWindowsLeaseProcess(executable, args, leases, {
    cwd: options.cwd, env: options.env, timeoutMs: options.timeout, maxStdoutBytes: options.maxBuffer
  });
  if (result.code !== 0) throw Object.assign(new Error('受監督的工具程序未成功完成。'), result);
  return result;
}

export async function runWindowsLeaseProcess(executable: string, args: readonly string[],
  leases: readonly WindowsLeaseToken[], options: WindowsProcessOptions): Promise<WindowsProcessResult> {
  options.signal?.throwIfAborted();
  const cwd = options.cwd === undefined ? undefined : path.resolve(options.cwd);
  const child = spawn(windowsLeasePowerShell, [...powershellArgs, '-StartMonitor'], { cwd, env: options.env, windowsHide: true });
  // Send the launch with argv separate from the command shell. Keeping stdin
  // open lets the monitor distinguish completion from cancellation or host exit.
  const launch = JSON.stringify({ executable, args, leases, cwd, timeoutMs: options.timeoutMs,
    input: options.input === undefined ? undefined : Buffer.from(options.input).toString('base64'), cancel: 'stdin' });
  return new Promise((resolve, reject) => {
    const output: Buffer[] = [], errors: Buffer[] = [];
    let received = 0, errorBytes = 0, interrupted: Error | undefined, stopTimer: NodeJS.Timeout | undefined;
    const stop = (cause?: Error) => {
      interrupted ??= cause;
      if (stopTimer) return;
      child.stdin.end('cancel\n');
      // If the monitor itself is stuck, a missing completion record keeps
      // any already-authorized operation fenced.
      stopTimer = setTimeout(() => child.kill(), 8_000);
    };
    const abort = () => stop(options.signal?.reason instanceof Error ? options.signal.reason : new Error('Operation cancelled.'));
    const timer = setTimeout(() => stop(Object.assign(new Error('Operation timed out.'), { name: 'TimeoutError' })), options.timeoutMs + 8_000);
    const cleanup = () => {
      clearTimeout(timer); clearTimeout(stopTimer);
      options.signal?.removeEventListener('abort', abort);
    };
    child.stdin.on('error', () => undefined);
    child.stdout.on('data', (chunk: Buffer) => {
      const remaining = options.maxStdoutBytes - received;
      if (remaining > 0) output.push(chunk.subarray(0, remaining));
      received += chunk.length;
      if (received > options.maxStdoutBytes) {
        stop(options.allowTruncated ? undefined : new Error('Process output exceeds the supported size.'));
      }
    });
    child.stderr.on('data', (chunk: Buffer) => {
      if (errorBytes < 64 * 1024) errors.push(chunk.subarray(0, 64 * 1024 - errorBytes));
      errorBytes += chunk.length;
      try { options.onStderr?.(chunk.toString('utf8')); } catch { /* Observers do not own the process. */ }
    });
    child.once('error', error => { cleanup(); reject(error); });
    child.once('close', code => {
      cleanup();
      if (interrupted) { reject(interrupted); return; }
      const truncated = received > options.maxStdoutBytes;
      if (!truncated && code !== null && (code >>> 0) === supervisorTimeout) {
        reject(Object.assign(new Error('Operation timed out.'), { name: 'TimeoutError' }));
        return;
      }
      resolve({ code: code ?? -1, stdout: new TextDecoder().decode(Buffer.concat(output), { stream: truncated }),
        stderr: Buffer.concat(errors).toString('utf8'), truncated });
    });
    child.stdin.write(launch + '\n');
    options.signal?.addEventListener('abort', abort, { once: true });
    if (options.signal?.aborted) abort();
  });
}
