import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, unlink } from 'node:fs/promises';
import path from 'node:path';
import type { CodexTaskRecord } from './protocol';
import { canonicalReviewRequestId, codexTaskActive } from './protocol';
import { atomicNetworkJson, LocalNetworkLease } from '../api/localNetworkLease';
import { requestedEffort } from './modelRouting';

export const codexRootKey = (root: string): string => createHash('sha256').update(process.platform === 'win32' ? root.toLowerCase() : root).digest('hex');
export const validTaskId = (id: unknown): id is string => typeof id === 'string' && /^[a-z0-9-]{1,100}$/i.test(id);
export class CodexTaskDeletedError extends Error {
  constructor() { super('此 Codex 任務紀錄已刪除。'); }
}
export class CodexTaskStore {
  private queue = Promise.resolve();
  constructor(readonly directory: string) {}
  async load(): Promise<CodexTaskRecord[]> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const records: CodexTaskRecord[] = [];
    for (const name of await readdir(this.directory)) {
      if (!/^[a-z0-9-]{1,100}\.json$/i.test(name)) continue;
      if (await this.isDeleted(name.slice(0, -5))) continue;
      let info;
      try { info = await lstat(path.join(this.directory, name)); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error; }
      if (!info.isFile() || info.isSymbolicLink() || info.size > 1024 * 1024) throw new Error('Codex 任務紀錄格式無效。');
      let value: CodexTaskRecord;
      try { value = JSON.parse(await readFile(path.join(this.directory, name), 'utf8')) as CodexTaskRecord; }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error; }
      if (await this.isDeleted(name.slice(0, -5))) continue;
      if (value.schema !== 'GitLabWorkspaceCodexTask/v1' || !validTaskId(value.id) || name !== value.id + '.json' ||
          !Number.isSafeInteger(value.ownerPid) || value.ownerPid < 1 || !value.spec || typeof value.spec.prompt !== 'string' ||
          !path.isAbsolute(value.spec.root) || value.root !== value.spec.root || !value.spec.skill ||
          !path.isAbsolute(value.spec.skill.path) || !Array.isArray(value.spec.writableRoots) ||
          value.spec.writableRoots.some(root => typeof root !== 'string' || !path.isAbsolute(root)) ||
          !['queued', 'starting', 'running', 'waiting', 'pausing', 'paused', 'completed', 'failed', 'interrupted', 'uncertain'].includes(value.status)) {
        throw new Error('Codex 任務紀錄損壞；請先核對儲存區，避免重複執行。');
      }
      if (value.review) value.review.requestId = canonicalReviewRequestId(value.review.requestId);
      if (value.spec.review) value.spec.review.requestId = canonicalReviewRequestId(value.spec.review.requestId);
      const routing = value.spec.routing;
      if (routing) {
        if (!value.spec.review || routing.tool !== value.spec.review.tool || routing.requestId !== value.spec.review.requestId ||
            !path.isAbsolute(routing.runtimeRoot) || !path.isAbsolute(routing.skillPath) ||
            path.resolve(routing.skillPath) !== path.join(value.root, '.agents/skills/model-routing/SKILL.md') ||
            !/^[a-f0-9]{64}$/.test(routing.payloadHash)) throw new Error('Codex 任務的 Model Routing 身分無效。');
        requestedEffort(routing.requestedEffort);
      }
      records.push(value);
    }
    return records;
  }
  save(record: CodexTaskRecord): Promise<void> {
    if (!validTaskId(record.id)) return Promise.reject(new Error('Codex 任務識別無效。'));
    const serialized = JSON.stringify(record);
    const task = this.queue.then(async () => {
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      if (await this.isDeleted(record.id)) throw new CodexTaskDeletedError();
      await atomicNetworkJson(path.join(this.directory, record.id + '.json'), JSON.parse(serialized));
      // A different window may have deleted the record while this write was pending.
      if (await this.isDeleted(record.id)) {
        await unlink(path.join(this.directory, record.id + '.json')).catch(error => { if (error.code !== 'ENOENT') throw error; });
        throw new CodexTaskDeletedError();
      }
    });
    this.queue = task.catch(() => {}); return task;
  }
  async isDeleted(id: string): Promise<boolean> {
    if (!validTaskId(id)) throw new Error('Codex 任務識別無效。');
    try {
      const info = await lstat(path.join(this.directory, id + '.deleted.json'));
      if (!info.isFile() || info.isSymbolicLink() || info.size > 1024) throw new Error('Codex 刪除紀錄格式無效。');
      return true;
    } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
  }
  async control<T>(id: string, operation: () => Promise<T>): Promise<T> {
    if (!validTaskId(id)) throw new Error('Codex 任務識別無效。');
    const lease = await LocalNetworkLease.acquire(path.join(this.directory, id + '.control'), 'codex-control');
    try { return await operation(); } finally { await lease.release(); }
  }
  async remove(id: string): Promise<void> {
    await this.control(id, async () => {
      await this.flush();
      if (await this.isDeleted(id)) return;
      const record = (await this.load()).find(value => value.id === id);
      if (!record) return;
      if (codexTaskActive(record.status) || ['queued', 'uncertain'].includes(record.status)) throw new Error('請先暫停任務並確認清理完成，再刪除紀錄。');
      await atomicNetworkJson(path.join(this.directory, id + '.deleted.json'), {
        schema: 'GitLabWorkspaceCodexDeleted/v1', id, deletedAt: new Date().toISOString()
      });
      await unlink(path.join(this.directory, id + '.json')).catch(error => { if (error.code !== 'ENOENT') throw error; });
    });
  }
  async flush(): Promise<void> { await this.queue; }
}
