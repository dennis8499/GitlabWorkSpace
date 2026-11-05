import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import type { CodexTaskRecord } from './protocol';
import { canonicalReviewRequestId } from './protocol';
import { atomicNetworkJson } from '../api/localNetworkLease';
import { requestedEffort } from './modelRouting';

export const codexRootKey = (root: string): string => createHash('sha256').update(process.platform === 'win32' ? root.toLowerCase() : root).digest('hex');
export const validTaskId = (id: unknown): id is string => typeof id === 'string' && /^[a-z0-9-]{1,100}$/i.test(id);
export class CodexTaskStore {
  private queue = Promise.resolve();
  constructor(readonly directory: string) {}
  async load(): Promise<CodexTaskRecord[]> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const records: CodexTaskRecord[] = [];
    for (const name of await readdir(this.directory)) {
      if (!/^[a-z0-9-]{1,100}\.json$/i.test(name)) continue;
      const info = await lstat(path.join(this.directory, name));
      if (!info.isFile() || info.isSymbolicLink() || info.size > 1024 * 1024) throw new Error('Codex 任務紀錄格式無效。');
      const value = JSON.parse(await readFile(path.join(this.directory, name), 'utf8')) as CodexTaskRecord;
      if (value.schema !== 'GitLabWorkspaceCodexTask/v1' || !validTaskId(value.id) || name !== value.id + '.json' ||
          !Number.isSafeInteger(value.ownerPid) || value.ownerPid < 1 || !value.spec || typeof value.spec.prompt !== 'string' ||
          !path.isAbsolute(value.spec.root) || value.root !== value.spec.root || !value.spec.skill ||
          !path.isAbsolute(value.spec.skill.path) || !Array.isArray(value.spec.writableRoots) ||
          value.spec.writableRoots.some(root => typeof root !== 'string' || !path.isAbsolute(root)) ||
          !['queued', 'starting', 'running', 'waiting', 'completed', 'failed', 'interrupted', 'uncertain'].includes(value.status)) {
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
      await atomicNetworkJson(path.join(this.directory, record.id + '.json'), JSON.parse(serialized));
    });
    this.queue = task.catch(() => {}); return task;
  }
  async flush(): Promise<void> { await this.queue; }
}
