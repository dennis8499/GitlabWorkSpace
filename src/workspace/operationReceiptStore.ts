import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { appendFile, mkdir } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import path from 'node:path';
import type { CompactOperationReceipt, OperationReceiptStore } from './operations';

/** Append-only exact receipt lookup; only the requested hash bucket is streamed. */
export class OperationReceiptFileStore implements OperationReceiptStore {
  private initialized?: Promise<void>;
  private queue: Promise<void> = Promise.resolve();
  private readonly cache = new Map<string, CompactOperationReceipt>();
  constructor(private readonly directory: string) {}
  initialize(): Promise<void> {
    return this.initialized ??= mkdir(this.directory, { recursive: true }).then(() => {}, error => { this.initialized = undefined; throw error; });
  }
  flush(): Promise<void> { return this.queue; }
  private filename(id: string): string { return path.join(this.directory, createHash('sha256').update(id).digest('hex').slice(0, 2) + '.jsonl'); }
  private remember(id: string, receipt: CompactOperationReceipt): void {
    this.cache.delete(id); this.cache.set(id, receipt);
    while (this.cache.size > 128) this.cache.delete(this.cache.keys().next().value!);
  }
  async get(id: string): Promise<CompactOperationReceipt | undefined> {
    await this.initialize(); await this.queue;
    const cached = this.cache.get(id); if (cached) { this.remember(id, cached); return { ...cached }; }
    const stream = createReadStream(this.filename(id), { encoding: 'utf8' });
    const lines = createInterface({ input: stream, crlfDelay: Infinity });
    let found: CompactOperationReceipt | undefined;
    try {
      for await (const line of lines) {
        let record: { id?: unknown; receipt?: CompactOperationReceipt };
        try {
          record = JSON.parse(line) as { id?: unknown; receipt?: CompactOperationReceipt };
        } catch { throw new Error('操作收據檔案不完整；為避免重複寫入，請先核對原操作結果。'); }
          const receipt = record?.receipt;
          const valid = typeof record?.id === 'string' && receipt && typeof receipt.requestId === 'string' && typeof receipt.scopeRevision === 'string' &&
            typeof receipt.resourceKey === 'string' && typeof receipt.action === 'string' && typeof receipt.label === 'string' &&
            typeof receipt.phase === 'string' && typeof receipt.startedAt === 'number' &&
            ['succeeded', 'failed', 'cancelled'].includes(receipt.status) && receipt.effect !== 'unknown';
          if (!valid) throw new Error('操作收據格式無效；已停止執行以避免重複寫入。');
          if (record.id === id) found = receipt;
      }
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    finally { lines.close(); stream.destroy(); }
    if (found) this.remember(id, found);
    return found && { ...found };
  }
  save(receipt: CompactOperationReceipt): Promise<void> {
    if (receipt.status === 'queued' || receipt.status === 'running' || receipt.effect === 'unknown') return Promise.resolve();
    const value = { ...receipt };
    const task = this.queue.then(async () => {
      await this.initialize();
      for (const id of new Set([value.requestId, value.correlationId].filter((id): id is string => !!id))) {
        await appendFile(this.filename(id), JSON.stringify({ id, receipt: value }) + '\n', 'utf8'); this.remember(id, value);
      }
    });
    this.queue = task.catch(() => {}); return task;
  }
}
