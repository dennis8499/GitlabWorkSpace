import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';

export interface RpcMessage { id?: number | string; method?: string; params?: Record<string, any>; result?: any; error?: { code: number; message: string }; }
/** Narrow client for the Codex CLI 0.165.0 app-server protocol. No raw RPC reaches a webview. */
export class CodexAppServer {
  private sequence = 0;
  private buffer = '';
  private decoder = new StringDecoder('utf8');
  private pending = new Map<number | string, { resolve(value: any): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>();
  private closed = false;
  private closing?: Promise<void>;
  private closePromise: Promise<void>;
  onNotification: (message: RpcMessage) => void = () => {};
  onRequest: (message: RpcMessage) => void = () => {};
  onExit: (error: Error) => void = () => {};
  constructor(private readonly child: ChildProcessWithoutNullStreams, private readonly timeoutMs = 30_000) {
    this.closePromise = new Promise(resolve => child.once('close', () => resolve()));
    child.stdout.on('data', (data: Buffer) => this.receive(this.decoder.write(data)));
    // Drain diagnostics; raw server output can contain prompt or authentication data.
    child.stderr.on('data', () => {});
    child.stdin.on('error', () => this.fail(new Error('Codex 通訊已中斷；請先核對任務紀錄。')));
    child.once('error', () => this.fail(new Error('無法啟動 Codex App Server。')));
    child.once('close', () => this.fail(new Error('Codex App Server 已結束；請核對任務後續作。')));
  }
  async initialize(version: string): Promise<void> {
    await this.request('initialize', { clientInfo: { name: 'gitlab_workspace', title: 'GitLab Workspace', version }, capabilities: { experimentalApi: true } });
    this.send({ method: 'initialized', params: {} });
  }
  request<T = any>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    if (this.closed) return Promise.reject(new Error('Codex 通訊已關閉。'));
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`Codex ${method} 回應逾時；請先核對結果。`)); }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try { this.send({ id, method, params }); } catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error); }
    });
  }
  respond(id: number | string, result: unknown): void { this.send({ id, result }); }
  reject(id: number | string): void { this.send({ id, error: { code: -32601, message: 'Unsupported client interaction' } }); }
  private send(message: RpcMessage): void {
    if (this.closed) throw new Error('Codex 通訊已關閉。');
    this.child.stdin.write(JSON.stringify(message) + '\n');
  }
  private receive(chunk: string): void {
    if (this.closed) return;
    this.buffer += chunk;
    if (this.buffer.length > 16 * 1024 * 1024) { this.fail(new Error('Codex 回應超過通訊大小上限。')); void this.close(); return; }
    for (;;) {
      const end = this.buffer.indexOf('\n');
      if (end < 0) break;
      const line = this.buffer.slice(0, end).trim(); this.buffer = this.buffer.slice(end + 1);
      if (!line) continue;
      let message: RpcMessage;
      try { message = JSON.parse(line); if (!message || typeof message !== 'object' || Array.isArray(message)) throw new Error(); }
      catch { this.fail(new Error('Codex 傳回無效的 JSON-RPC 訊息。')); void this.close(); return; }
      if (message.method) {
        try { if (message.id !== undefined) this.onRequest(message); else this.onNotification(message); }
        catch { this.fail(new Error('Codex 事件無法處理；請核對任務紀錄。')); void this.close(); }
      } else if (message.id !== undefined) {
        const pending = this.pending.get(message.id);
        if (!pending) continue;
        this.pending.delete(message.id); clearTimeout(pending.timer);
        if (message.error) pending.reject(Object.assign(new Error(`Codex 請求失敗 (${message.error.code})。`), { rpcCode: message.error.code }));
        else pending.resolve(message.result);
      }
    }
  }
  private fail(error: Error): void {
    if (this.closed) return;
    this.closed = true;
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error); }
    this.pending.clear(); this.onExit(error);
  }
  close(gracefulTimeoutMs = 5000): Promise<void> {
    return this.closing ??= this.closeNow(gracefulTimeoutMs);
  }
  private async closeNow(gracefulTimeoutMs: number): Promise<void> {
    this.fail(new Error('Codex 通訊已關閉。'));
    this.child.stdin.end();
    const timer = setTimeout(() => { this.child.kill(); }, gracefulTimeoutMs);
    try { await this.closePromise; } finally { clearTimeout(timer); }
  }
}
