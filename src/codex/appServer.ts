import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import { CodexRpcError } from './rpcError';

export interface RpcMessage { id?: number | string; method?: string; params?: Record<string, any>; result?: any; error?: { code: number; message: string; data?: unknown }; }
export interface RpcOptions { signal?: AbortSignal; timeoutMs?: number; }
export interface CodexRpcDiagnostic { method: string; phase: 'sent' | 'completed' | 'failed'; elapsedMs: number; category?: string; }
interface Pending {
  method: string; started: number; sent: boolean; resolve(value: any): void; reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>; removeAbort?(): void;
}
interface Write { line: string; bytes: number; id?: number; }
const maxFrame = 16 * 1024 * 1024, maxQueuedBytes = 1024 * 1024;
/** JSONL transport; product projections, never raw RPC, reach the webview. */
export class CodexAppServer {
  private sequence = 0;
  private buffer = '';
  private decoder = new StringDecoder('utf8');
  private pending = new Map<number | string, Pending>();
  private writes: Write[] = [];
  private queuedBytes = 0;
  private blocked = false;
  private closed = false;
  private childClosed = false;
  private closing?: Promise<void>;
  private closePromise: Promise<void>;
  onNotification: (message: RpcMessage) => void = () => {};
  onRequest: (message: RpcMessage) => void = () => {};
  onExit: (error: Error) => void = () => {};
  onDiagnostic: (event: CodexRpcDiagnostic) => void = () => {};
  constructor(private readonly child: ChildProcessWithoutNullStreams, private readonly timeoutMs = 30_000,
    private readonly terminationTimeoutMs = 5000) {
    this.closePromise = new Promise(resolve => child.once('close', () => { this.childClosed = true; resolve(); }));
    child.stdout.on('data', (data: Buffer) => this.receive(this.decoder.write(data)));
    child.stderr.on('data', () => {});
    child.stdin.on('drain', () => { this.blocked = false; this.flush(); });
    child.stdin.on('error', () => this.fail(new CodexRpcError('transport', undefined, undefined, 'possibly-sent')));
    child.once('error', () => this.fail(new CodexRpcError('transport')));
    child.once('close', () => this.fail(new CodexRpcError('transport', undefined, undefined, 'possibly-sent')));
  }
  async initialize(version: string, experimentalApi = true, signal?: AbortSignal): Promise<void> {
    await this.request('initialize', { clientInfo: { name: 'gitlab_workspace', title: 'GitLab Workspace', version }, capabilities: { experimentalApi } }, { signal });
    this.send({ method: 'initialized', params: {} });
  }
  request<T = any>(method: string, params: Record<string, unknown> = {}, options: RpcOptions = {}): Promise<T> {
    if (this.closed) return Promise.reject(new CodexRpcError('transport', method));
    if (options.signal?.aborted) return Promise.reject(new CodexRpcError('cancelled', method));
    if (this.pending.size >= 128) return Promise.reject(new CodexRpcError('transport', method));
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const finish = (category: 'timeout' | 'cancelled') => {
        const pending = this.pending.get(id); if (!pending) return;
        this.pending.delete(id); clearTimeout(pending.timer); pending.removeAbort?.();
        this.diagnostic(pending, 'failed', category);
        reject(new CodexRpcError(category, method, undefined, pending.sent ? 'possibly-sent' : 'not-sent'));
      };
      const timer = setTimeout(() => finish('timeout'), options.timeoutMs ?? this.timeoutMs);
      const abort = () => finish('cancelled');
      const pending: Pending = { method, started: Date.now(), sent: false, resolve, reject, timer,
        removeAbort: () => options.signal?.removeEventListener('abort', abort) };
      this.pending.set(id, pending); options.signal?.addEventListener('abort', abort, { once: true });
      try { this.send({ id, method, params }); }
      catch (error) { this.pending.delete(id); clearTimeout(timer); pending.removeAbort?.(); reject(error); }
    });
  }
  respond(id: number | string, result: unknown): void { this.send({ id, result }); }
  reject(id: number | string): void { this.send({ id, error: { code: -32601, message: 'Unsupported client interaction' } }); }
  private diagnostic(pending: Pending, phase: CodexRpcDiagnostic['phase'], category?: string): void {
    try { this.onDiagnostic({ method: pending.method, phase, elapsedMs: Date.now() - pending.started, category }); } catch { /* Diagnostics cannot affect execution. */ }
  }
  private send(message: RpcMessage): void {
    if (this.closed) throw new CodexRpcError('transport', message.method);
    const line = JSON.stringify(message) + '\n', bytes = Buffer.byteLength(line);
    if (bytes > maxQueuedBytes || this.queuedBytes + bytes > maxQueuedBytes) throw new CodexRpcError('transport', message.method);
    this.writes.push({ line, bytes, id: message.method && typeof message.id === 'number' ? message.id : undefined });
    this.queuedBytes += bytes; this.flush();
  }
  private flush(): void {
    while (!this.closed && !this.blocked && this.writes.length) {
      const write = this.writes.shift()!; this.queuedBytes -= write.bytes;
      if (write.id !== undefined) {
        const pending = this.pending.get(write.id); if (!pending) continue;
        pending.sent = true; this.diagnostic(pending, 'sent');
      }
      try { this.blocked = !this.child.stdin.write(write.line); }
      catch { this.fail(new CodexRpcError('transport', undefined, undefined, 'possibly-sent')); }
    }
  }
  private invalid(): void {
    this.fail(new CodexRpcError('protocol', undefined, undefined, 'possibly-sent'));
    void this.close().catch(() => {});
  }
  private receive(chunk: string): void {
    if (this.closed) return;
    this.buffer += chunk;
    for (;;) {
      const end = this.buffer.indexOf('\n'); if (end < 0) break;
      const line = this.buffer.slice(0, end).trim(); this.buffer = this.buffer.slice(end + 1);
      if (!line) continue;
      let message: RpcMessage;
      try {
        if (Buffer.byteLength(line) > maxFrame) throw new Error();
        message = JSON.parse(line);
        if (!message || typeof message !== 'object' || Array.isArray(message) ||
          message.id !== undefined && typeof message.id !== 'string' && !Number.isSafeInteger(message.id) ||
          message.method !== undefined && typeof message.method !== 'string' ||
          message.error && (!Number.isSafeInteger(message.error.code) || typeof message.error.message !== 'string')) throw new Error();
      } catch { this.invalid(); return; }
      if (message.method) {
        try { if (message.id !== undefined) this.onRequest(message); else this.onNotification(message); }
        catch { this.invalid(); return; }
      } else if (message.id !== undefined) {
        const pending = this.pending.get(message.id); if (!pending) continue;
        if (Object.hasOwn(message, 'result') === Object.hasOwn(message, 'error')) { this.invalid(); return; }
        this.pending.delete(message.id); clearTimeout(pending.timer); pending.removeAbort?.();
        if (message.error) {
          const error = CodexRpcError.from(pending.method, message.error); this.diagnostic(pending, 'failed', error.category); pending.reject(error);
        } else { this.diagnostic(pending, 'completed'); pending.resolve(message.result); }
      } else { this.invalid(); return; }
    }
    if (Buffer.byteLength(this.buffer) > maxFrame) this.invalid();
  }
  private fail(error: Error): void {
    if (this.closed) return;
    this.closed = true; this.writes = []; this.queuedBytes = 0;
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.removeAbort?.(); pending.reject(error); }
    this.pending.clear(); this.onExit(error);
  }
  close(gracefulTimeoutMs = 5000): Promise<void> { return this.closing ??= this.closeNow(gracefulTimeoutMs); }
  private async waitClosed(timeoutMs: number): Promise<boolean> {
    if (this.childClosed) return true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { return await Promise.race([this.closePromise.then(() => true), new Promise<boolean>(resolve => { timer = setTimeout(() => resolve(false), Math.max(0, timeoutMs)); })]); }
    finally { if (timer) clearTimeout(timer); }
  }
  private async closeNow(gracefulTimeoutMs: number): Promise<void> {
    this.fail(new CodexRpcError('transport'));
    try { this.child.stdin.end(); } catch { /* Still attempt termination. */ }
    if (await this.waitClosed(gracefulTimeoutMs)) return;
    try { this.child.kill(); } catch { /* The receipt remains authoritative. */ }
    if (!await this.waitClosed(this.terminationTimeoutMs)) throw new CodexRpcError('cleanup', undefined, undefined, 'possibly-sent');
  }
}
