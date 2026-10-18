import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { appendFile, mkdir, readFile, readdir, rename, rm, stat, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setImmediate as yieldToHost } from 'node:timers/promises';
import type { FetchLike } from '../api/gitLabClient';
import type { LogContext, LogPage, LogQuery, OperationLogEntry } from './logProtocol';

type Scope = { operationId: string; context: LogContext };
type LogInput = Pick<OperationLogEntry, 'feature' | 'action' | 'result'> & Partial<OperationLogEntry>;
type LogFile = { path: string; size: number; time: number; mtimeMs: number };
type IndexedLine = Pick<OperationLogEntry, 'timestamp' | 'feature' | 'accountId' | 'baseUrl' | 'level' | 'result'> & { offset: number; length: number };
interface SegmentIndex { size: number; mtimeMs: number; lines: IndexedLine[]; }
export type LogOutcome = Pick<OperationLogEntry, 'result'> & Partial<Pick<OperationLogEntry, 'level' | 'message'>>;
const SEGMENT_NAME = /^\d{13}-[a-f0-9-]+\.jsonl$/;
const operationLogs = new AsyncLocalStorage<OperationLog>();
export const currentOperationLog = (): OperationLog | undefined => operationLogs.getStore();

/** One append queue per extension host; independent files avoid cross-window writes. */
export class OperationLog {
  private readonly scope = new AsyncLocalStorage<Scope>();
  private readonly secrets = new Set<string>();
  private readonly listeners = new Set<() => void>();
  private queue: Promise<void> = Promise.resolve();
  private segment?: string;
  private segmentBytes = 0;
  private segmentTime = 0;
  private segmentDay = '';
  private disposed = false;
  private failure?: string;
  private contextSource: () => LogContext = () => ({});
  readonly retentionDays: number;
  readonly maxBytes: number;
  private readonly segmentLimit: number;
  private pendingLines: string[] = [];
  private appendScheduled = false;
  private readonly indexes = new Map<string, SegmentIndex>();

  constructor(readonly directory: string, private readonly onError?: (message: string) => void,
    options: { retentionDays?: number; maxBytes?: number; segmentBytes?: number } = {}) {
    this.retentionDays = options.retentionDays ?? 30;
    this.maxBytes = options.maxBytes ?? 50 * 1024 * 1024;
    this.segmentLimit = Math.min(options.segmentBytes ?? 2 * 1024 * 1024, this.maxBytes);
    this.enqueue(async () => { await mkdir(directory, { recursive: true }); await this.prune(); });
  }

  get error(): string | undefined { return this.failure; }
  setContextSource(source: () => LogContext): void { this.contextSource = source; }
  addSecret(value: string): void { if (value) this.secrets.add(value); }
  onDidChange(listener: () => void): { dispose(): void } {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  }
  dispose(): void { this.disposed = true; this.listeners.clear(); }
  flush(): Promise<void> { return this.queue; }

  sanitize(value: string): string {
    let result = value;
    for (const secret of this.secrets) result = result.split(secret).join('[redacted]');
    return result.replace(/\b(?:glpat|gldt|glrt|glcbt)-[\w-]+/gi, '[redacted]')
      .replace(/(https?:\/\/)[^\s/@]+(?::[^\s/@]*)?@/gi, '$1[redacted]@')
      .replace(/((?:private-token|authorization|access_token|token|password)\s*[=:]\s*)[^\s,;"}]+/gi, '$1[redacted]')
      .replace(/\bBearer\s+[^\s,;"}]+/gi, 'Bearer [redacted]').slice(0, 2048);
  }

  record(input: LogInput): void {
    if (this.disposed) return;
    const current = this.scope.getStore();
    const source = { ...(current?.context ?? this.contextSource()), ...input };
    // An explicit allowlist prevents accidental request bodies, environments or tokens in logs.
    const entry: OperationLogEntry = {
      id: randomUUID(), timestamp: new Date().toISOString(), operationId: current?.operationId ?? randomUUID(),
      level: input.level ?? (input.result === 'error' ? 'error' : 'info'),
      feature: this.sanitize(input.feature), action: this.sanitize(input.action), result: input.result
    };
    for (const key of ['accountId', 'baseUrl', 'repositoryPath', 'message', 'method', 'endpoint'] as const) {
      if (typeof source[key] === 'string') entry[key] = this.sanitize(source[key]);
    }
    for (const key of ['groupId', 'projectId', 'issueIid', 'durationMs', 'statusCode', 'exitCode'] as const) {
      if (typeof source[key] === 'number' && Number.isFinite(source[key])) entry[key] = source[key];
    }
    const line = JSON.stringify(entry) + '\n';
    this.pendingLines.push(line);
    if (this.appendScheduled) return;
    this.appendScheduled = true;
    this.enqueue(async () => {
      const pending = this.pendingLines; this.pendingLines = []; this.appendScheduled = false;
      const day = new Date().toISOString().slice(0, 10);
      let batch = '', batchBytes = 0;
      const append = async (): Promise<void> => {
        if (!batch) return;
        await appendFile(this.segment!, batch, 'utf8'); this.segmentBytes += batchBytes;
        this.indexes.delete(this.segment!); batch = ''; batchBytes = 0;
      };
      for (const next of pending) {
        const bytes = Buffer.byteLength(next);
        if (!this.segment || this.segmentBytes + batchBytes + bytes > this.segmentLimit || this.segmentDay !== day) {
          await append();
          this.segmentTime = Math.max(Date.now(), this.segmentTime + 1); this.segmentDay = day;
          this.segment = path.join(this.directory, this.segmentTime + '-' + randomUUID() + '.jsonl'); this.segmentBytes = 0;
        }
        batch += next; batchBytes += bytes;
      }
      await append();
      await this.prune();
      for (const listener of this.listeners) { try { listener(); } catch { /* consumer disposal */ } }
    });
  }

  async run<T>(feature: string, action: string, context: LogContext, task: () => Promise<T>, outcome?: () => LogOutcome): Promise<T> {
    const parent = this.scope.getStore();
    const scope: Scope = { operationId: parent?.operationId ?? randomUUID(), context: { ...(parent?.context ?? this.contextSource()), ...context } };
    return operationLogs.run(this, () => this.scope.run(scope, async () => {
      const start = Date.now();
      this.record({ feature, action, result: 'started' });
      try {
        const value = await task();
        this.record({ feature, action, result: 'success', ...outcome?.(), durationMs: Date.now() - start });
        return value;
      } catch (error) {
        const cancelled = error instanceof Error && error.name === 'AbortError';
        this.record({ feature, action, result: cancelled ? 'cancelled' : 'error', durationMs: Date.now() - start,
          message: feature === 'git' ? 'Git 操作未完成；請依相關紀錄的結束碼檢查。' : error instanceof Error ? error.message.split(/\r?\n/, 1)[0].slice(0, 500) : '操作失敗。' });
        throw error;
      }
    }));
  }

  wrapFetch(fetcher: FetchLike): FetchLike {
    return async (url, init) => {
      const target = new URL(String(url));
      const start = Date.now();
      const current = this.scope.getStore();
      const captured: Scope = current ?? { operationId: randomUUID(), context: { ...this.contextSource() } };
      return this.scope.run(captured, async () => {
        const detail = { feature: 'api', action: 'GitLab API', method: init?.method ?? 'GET', endpoint: target.origin + target.pathname };
        try {
          const response = await fetcher(url, init);
          this.record({ ...detail, result: response.ok ? 'success' : 'error', statusCode: response.status, durationMs: Date.now() - start });
          return response;
        } catch (error) {
          this.record({ ...detail, result: error instanceof Error && error.name === 'AbortError' ? 'cancelled' : 'error',
            durationMs: Date.now() - start, message: error instanceof Error ? error.message : '請求失敗。' });
          throw error;
        }
      });
    };
  }

  async query(query: LogQuery = {}, signal?: AbortSignal): Promise<LogPage> {
    signal?.throwIfAborted();
    await this.flush();
    signal?.throwIfAborted();
    const page = Math.max(0, Math.floor(query.page ?? 0));
    const entries: OperationLogEntry[] = [];
    const accounts = new Map<string, { id: string; baseUrl?: string }>();
    let total = 0;
    try {
      const files = await this.files();
      const paths = new Set(files.map(file => file.path));
      for (const filename of this.indexes.keys()) if (!paths.has(filename)) this.indexes.delete(filename);
      const search = query.search?.toLocaleLowerCase();
      let scanned = 0;
      for (const file of files) {
        signal?.throwIfAborted();
        const index = await this.segmentIndex(file, signal);
        let buffer: Buffer | undefined;
        for (let position = index.lines.length - 1; position >= 0; position--) {
          if (++scanned % 1024 === 0) { await yieldToHost(); signal?.throwIfAborted(); }
          const line = index.lines[position];
          if (line.accountId && !accounts.has(line.accountId)) accounts.set(line.accountId, { id: line.accountId, baseUrl: line.baseUrl });
          if (!this.matchesMetadata(line, query)) continue;
          const selected = total >= page * 100 && entries.length < 100;
          let text: string | undefined;
          if (search || selected) {
            buffer ??= await readFile(file.path, { signal });
            text = buffer.subarray(line.offset, line.offset + line.length).toString('utf8');
          }
          if (search && !text!.toLocaleLowerCase().includes(search)) continue;
          if (total >= page * 100 && entries.length < 100) entries.push(JSON.parse(text!) as OperationLogEntry);
          total++;
        }
      }
    } catch (error) { if (signal?.aborted) throw error; this.reportFailure(); }
    return { entries, page, pageSize: 100, total, error: this.failure, accounts: [...accounts.values()] };
  }

  async exportTo(destination: string, query: LogQuery = {}, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    await this.flush();
    signal?.throwIfAborted();
    const temporary = path.join(path.dirname(destination), `.${path.basename(destination)}.${randomUUID()}.tmp`);
    try {
      await writeFile(temporary, '', { encoding: 'utf8', flag: 'wx' });
      let batch = '';
      for await (const entry of this.entries(signal)) {
        if (!this.matches(entry, query)) continue;
        batch += JSON.stringify(entry) + '\n';
        if (batch.length >= 64 * 1024) { await appendFile(temporary, batch, 'utf8'); batch = ''; }
      }
      if (batch) await appendFile(temporary, batch, 'utf8');
      signal?.throwIfAborted();
      await rename(temporary, destination);
    } finally {
      await rm(temporary, { force: true });
    }
  }

  async clear(): Promise<void> {
    this.enqueue(async () => {
      for (const file of await this.files()) await unlink(file.path);
      this.segment = undefined; this.segmentBytes = 0;
      this.indexes.clear();
      for (const listener of this.listeners) listener();
    });
    await this.flush();
  }

  private enqueue(task: () => Promise<void>): void {
    this.queue = this.queue.then(task).then(() => { this.failure = undefined; }, () => this.reportFailure());
  }
  private reportFailure(): void {
    const first = !this.failure;
    this.failure = '無法讀寫本機 Log；請檢查儲存空間與資料夾權限。';
    if (first) { try { this.onError?.(this.failure); } catch { /* logging never blocks an operation */ } }
  }
  private async files(): Promise<LogFile[]> {
    const names = await readdir(this.directory);
    const files = await Promise.all(names.filter(name => SEGMENT_NAME.test(name)).map(async name => {
      const filename = path.join(this.directory, name);
      const info = await stat(filename).catch(() => undefined);
      return info?.isFile() ? { path: filename, size: info.size, mtimeMs: info.mtimeMs, time: Number(name.slice(0, 13)) } : undefined;
    }));
    return files.filter((file): file is NonNullable<typeof file> => !!file).sort((a, b) => b.time - a.time || b.path.localeCompare(a.path));
  }
  private async prune(): Promise<void> {
    let bytes = 0;
    const cutoff = Date.now() - this.retentionDays * 86400_000;
    for (const file of await this.files()) {
      bytes += file.size;
      if (file.time >= cutoff && bytes <= this.maxBytes) continue;
      await unlink(file.path).catch(error => { if (error.code !== 'ENOENT') throw error; });
      this.indexes.delete(file.path);
      if (file.path === this.segment) { this.segment = undefined; this.segmentBytes = 0; }
    }
  }
  private async segmentIndex(file: LogFile, signal?: AbortSignal): Promise<SegmentIndex> {
    const cached = this.indexes.get(file.path);
    if (cached?.size === file.size && cached.mtimeMs === file.mtimeMs) return cached;
    const buffer = await readFile(file.path, { signal });
    const lines: IndexedLine[] = [];
    let offset = 0, scanned = 0;
    while (offset < buffer.length) {
      const newline = buffer.indexOf(10, offset), end = newline < 0 ? buffer.length : newline;
      try {
        const entry = JSON.parse(buffer.subarray(offset, end).toString('utf8')) as OperationLogEntry;
        if (typeof entry.id === 'string' && typeof entry.timestamp === 'string' && typeof entry.action === 'string' && typeof entry.feature === 'string') {
          lines.push({ offset, length: end - offset, timestamp: entry.timestamp, feature: entry.feature, accountId: entry.accountId,
            baseUrl: entry.baseUrl, level: entry.level, result: entry.result });
        }
      } catch { /* Ignore an incomplete final append after a host crash. */ }
      offset = end + 1;
      if (++scanned % 256 === 0) { await yieldToHost(); signal?.throwIfAborted(); }
    }
    const index = { size: file.size, mtimeMs: file.mtimeMs, lines };
    this.indexes.set(file.path, index); return index;
  }

  private matchesMetadata(entry: IndexedLine, query: LogQuery): boolean {
    return (!query.feature || entry.feature === query.feature) && (!query.accountId || entry.accountId === query.accountId) &&
      (!query.level || entry.level === query.level) && (!query.result || entry.result === query.result) &&
      (!query.from || entry.timestamp >= query.from) && (!query.to || entry.timestamp <= query.to);
  }

  private async *entries(signal?: AbortSignal): AsyncGenerator<OperationLogEntry> {
    let scanned = 0;
    for (const file of await this.files()) {
      signal?.throwIfAborted();
      const text = await readFile(file.path, { encoding: 'utf8', signal }).catch(error => { if (error.code === 'ENOENT') return ''; throw error; });
      const lines = text.trim().split('\n');
      for (let i = lines.length - 1; i >= 0; i--) {
        if (++scanned % 256 === 0) { await yieldToHost(); signal?.throwIfAborted(); }
        try {
          const entry = JSON.parse(lines[i]) as OperationLogEntry;
          if (typeof entry.id === 'string' && typeof entry.timestamp === 'string' && typeof entry.action === 'string' && typeof entry.feature === 'string') yield entry;
        } catch { /* a partial final append after a host crash is ignored */ }
      }
    }
  }
  private matches(entry: OperationLogEntry, query: LogQuery): boolean {
    return (!query.feature || entry.feature === query.feature) && (!query.accountId || entry.accountId === query.accountId) &&
      (!query.level || entry.level === query.level) && (!query.result || entry.result === query.result) &&
      (!query.from || entry.timestamp >= query.from) && (!query.to || entry.timestamp <= query.to) &&
      (!query.search || JSON.stringify(entry).toLocaleLowerCase().includes(query.search.toLocaleLowerCase()));
  }
}
