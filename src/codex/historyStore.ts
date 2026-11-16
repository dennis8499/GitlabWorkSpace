import { lstat, mkdir, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { atomicNetworkJson } from '../api/localNetworkLease';
import { acquireStorageControl } from '../storage/controlLease';
import { missingFile, ownedStoragePath } from '../storage/ownedStorage';

export type CodexHistoryDeletion = 'pending' | 'deleted';
interface HistoryDeletionRecord { schema: 'GitLabWorkspaceCodexHistoryDeletion/v1'; id: string; state: CodexHistoryDeletion; }
const validId = (id: string): boolean => typeof id === 'string' && /^[a-z0-9-]{1,100}$/i.test(id);
/** Separate from execution cleanup tombstones: retiring a connection does not delete its history. */
export class CodexHistoryStore {
  readonly directory: string;
  constructor(directory: string) { this.directory = path.resolve(directory); }
  private file(id: string): string {
    if (!validId(id)) throw new Error('Codex 任務識別無效。');
    return path.join(this.directory, id + '.json');
  }
  private async ensure(): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    await ownedStoragePath(path.dirname(this.directory), this.directory);
  }
  async read(id: string): Promise<CodexHistoryDeletion | undefined> {
    const file = this.file(id);
    if (!await ownedStoragePath(path.dirname(this.directory), this.directory) || !await ownedStoragePath(this.directory, file)) return;
    const info = await lstat(file);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 1024) throw new Error('Codex 歷史刪除紀錄無法驗證。');
    const value = JSON.parse(await readFile(file, 'utf8')) as HistoryDeletionRecord;
    if (!value || Object.keys(value).some(key => !['schema', 'id', 'state'].includes(key)) ||
      value.schema !== 'GitLabWorkspaceCodexHistoryDeletion/v1' || value.id !== id || !['pending', 'deleted'].includes(value.state)) {
      throw new Error('Codex 歷史刪除紀錄無法驗證。');
    }
    return value.state;
  }
  async list(ids?: readonly string[]): Promise<Map<string, CodexHistoryDeletion>> {
    // Fresh fence checks never create storage or revalidate its directory twice.
    // read() still verifies ownership of both the directory and any existing marker.
    if (!ids) await this.ensure();
    const selected = ids ?? (await readdir(this.directory)).flatMap(name => /^([a-z0-9-]{1,100})\.json$/i.exec(name)?.[1] ?? []);
    const values = new Map<string, CodexHistoryDeletion>();
    for (const id of selected) {
      const state = await this.read(id).catch(error => { if (missingFile(error)) return; throw error; });
      if (state) values.set(id, state);
    }
    return values;
  }
  async control<T>(id: string, operation: () => Promise<T>): Promise<T> {
    this.file(id); await this.ensure();
    const lease = await acquireStorageControl(path.join(this.directory, id + '.control'), 'codex-history-deletion');
    try { return await operation(); } finally { await lease.release(); }
  }
  /** Caller holds this ID's history control; deleted is terminal and writes are idempotent. */
  async write(id: string, state: CodexHistoryDeletion): Promise<void> {
    const file = this.file(id); await this.ensure();
    const previous = await this.read(id);
    if (previous === 'deleted' || previous === state) return;
    if (state === 'deleted' && previous !== 'pending') throw new Error('缺少已確認的歷史刪除意圖。');
    await atomicNetworkJson(file, { schema: 'GitLabWorkspaceCodexHistoryDeletion/v1', id, state });
  }
}
