import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, unlink, copyFile } from 'node:fs/promises';
import path from 'node:path';
import { validStoredCodexProjection } from './recordValidation';
import type { CodexTaskRecord, CodexStorageProblem } from './protocol';
import { canonicalReviewRequestId, codexTaskActive } from './protocol';
import { atomicNetworkJson } from '../api/localNetworkLease';
import { requestedEffort } from './modelRouting';
import { validateExecutionSelection } from './executionSelection';
import { cleanupTaskStorage, taskCleanupPlan, validateCleanupPlan, type CodexCleanupPlan } from './taskCleanup';
import { missingFile, ownedStoragePath, removeOwnedStorage, removeOwnedAtomicTemps } from '../storage/ownedStorage';
import { acquireStorageControl } from '../storage/controlLease';

export const codexRootKey = (root: string): string => createHash('sha256').update(process.platform === 'win32' ? root.toLowerCase() : root).digest('hex');
export const validTaskId = (id: unknown): id is string => typeof id === 'string' && /^[a-z0-9-]{1,100}$/i.test(id);
export class CodexTaskDeletedError extends Error {
  constructor() { super('此 Codex 任務紀錄已刪除。'); }
}
export class CodexTaskStore {
  private queue = Promise.resolve();
  problems: CodexStorageProblem[] = [];
  private cleanupProblems: CodexStorageProblem[] = [];
  constructor(readonly directory: string, private readonly cleanup: (plan: CodexCleanupPlan) => Promise<void> = plan => cleanupTaskStorage(path.dirname(directory), plan)) {}
  async load(): Promise<CodexTaskRecord[]> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const records: CodexTaskRecord[] = [], problems: CodexStorageProblem[] = [];
    for (const name of await readdir(this.directory)) {
      if (!/^[a-z0-9-]{1,100}\.json$/i.test(name)) continue;
      try {
      if (await this.isDeleted(name.slice(0, -5))) continue;
      let info;
      try { info = await lstat(path.join(this.directory, name)); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error; }
      if (!info.isFile() || info.isSymbolicLink() || info.size > 4 * 1024 * 1024) throw new Error('Codex 任務紀錄格式無效。');
      let value: CodexTaskRecord;
      try { value = JSON.parse(await readFile(path.join(this.directory, name), 'utf8')) as CodexTaskRecord; }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error; }
      if (await this.isDeleted(name.slice(0, -5))) continue;
      if (!validStoredCodexProjection(value)) throw new Error('Codex 任務顯示資料無法驗證。');
      if (value.schema === 'GitLabWorkspaceCodexTask/v1' && info.size > 1024 * 1024 || value.spec?.executionRoot !== undefined &&
        (typeof value.spec.executionRoot !== 'string' || !path.isAbsolute(value.spec.executionRoot)) || value.approvalSettings &&
        !['command', 'file', 'permissions'].every(key => typeof value.approvalSettings![key as keyof typeof value.approvalSettings] === 'boolean')) throw new Error('Codex 任務設定無效。');
      if (!['GitLabWorkspaceCodexTask/v1', 'GitLabWorkspaceCodexTask/v2'].includes(value.schema) || !validTaskId(value.id) || name !== value.id + '.json' ||
          !Number.isSafeInteger(value.ownerPid) || value.ownerPid < 1 || !value.spec || typeof value.spec.prompt !== 'string' ||
          typeof value.spec.root !== 'string' || !path.isAbsolute(value.spec.root) || value.root !== value.spec.root ||
          (value.spec.source?.kind !== 'free' && (!value.spec.skill || typeof value.spec.skill.path !== 'string' || !path.isAbsolute(value.spec.skill.path))) || !Array.isArray(value.spec.writableRoots) ||
          value.spec.writableRoots.some(root => typeof root !== 'string' || !path.isAbsolute(root)) ||
          !['queued', 'starting', 'running', 'waiting', 'pausing', 'paused', 'completed', 'failed', 'interrupted', 'uncertain'].includes(value.status)) {
        throw new Error('Codex 任務紀錄損壞；請先核對儲存區，避免重複執行。');
      }
      if (value.review) value.review.requestId = canonicalReviewRequestId(value.review.requestId);
      if (value.spec.review) value.spec.review.requestId = canonicalReviewRequestId(value.spec.review.requestId);
      if (value.spec.origin || value.spec.workflow) {
        const origin = value.spec.origin, workflow = value.spec.workflow;
        if (!origin || !workflow || !['issue', 'project-wiki', 'merge-request'].includes(origin.kind) || value.spec.source.kind !== origin.kind ||
          !/^[a-f0-9-]{32,36}$/i.test(workflow.id) || !path.isAbsolute(workflow.runtimeRoot) ||
          workflow.sourceRoot !== undefined && !path.isAbsolute(workflow.sourceRoot) ||
          !value.spec.executionRoot || !path.isAbsolute(value.spec.executionRoot) || !path.isAbsolute(origin.repositoryRoot) ||
          typeof origin.accountKey !== 'string' || !origin.accountKey || typeof origin.baseUrl !== 'string' ||
          !Number.isSafeInteger(origin.projectId) || origin.projectId < 1 || typeof origin.sourceBranch !== 'string' ||
          !/^[a-f0-9]{40,64}$/.test(origin.sourceSha) || origin.kind === 'issue' && (!origin.branch || !Number.isSafeInteger(origin.iid)) ||
          origin.kind === 'merge-request' && (!Number.isSafeInteger(origin.iid) || !origin.targetBranch || !/^[a-f0-9]{40,64}$/.test(origin.targetSha ?? ''))) {
          throw new Error('Codex 任務來源或執行綁定格式無效。');
        }
      }
      const routing = value.spec.routing;
      validateExecutionSelection(value.spec.source);
      validateExecutionSelection({ model: value.spec.model, effort: value.spec.effort });
      if (routing) {
        if (!value.spec.review || routing.tool !== value.spec.review.tool || routing.requestId !== value.spec.review.requestId ||
            !path.isAbsolute(routing.runtimeRoot) || !path.isAbsolute(routing.skillPath) ||
            path.resolve(routing.skillPath) !== path.join(value.root, '.agents/skills/model-routing/SKILL.md') ||
            !/^[a-f0-9]{64}$/.test(routing.payloadHash)) throw new Error('Codex 任務的 Model Routing 身分無效。');
        requestedEffort(routing.requestedEffort);
        if (routing.model !== undefined || routing.supportedEfforts !== undefined) {
          validateExecutionSelection({ model: routing.model, effort: routing.requestedEffort, modelEfforts: routing.supportedEfforts });
          if (!routing.model || !routing.supportedEfforts) throw new Error('審查模型能力設定不完整。');
        }
      }
      records.push(value);
      } catch { problems.push({ id: name.slice(0, -5), reason: '任務紀錄無法驗證；原件已保留，請檢查儲存區並重新載入。' }); }
    }
    this.problems = [...problems, ...this.cleanupProblems];
    return records;
  }
  save(record: CodexTaskRecord): Promise<void> {
    if (!validTaskId(record.id)) return Promise.reject(new Error('Codex 任務識別無效。'));
    const serialized = JSON.stringify(record);
    if (Buffer.byteLength(serialized) > 4 * 1024 * 1024) return Promise.reject(new Error('Codex 任務紀錄超過 4 MiB，請縮小上下文或差異範圍。'));
    const task = this.queue.then(async () => {
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      if (await this.isDeleted(record.id)) throw new CodexTaskDeletedError();
      const file = path.join(this.directory, record.id + '.json');
      if (record.schema === 'GitLabWorkspaceCodexTask/v2') {
        try {
          const previous = JSON.parse(await readFile(file, 'utf8'));
          if (previous.schema === 'GitLabWorkspaceCodexTask/v1') {
            if (codexTaskActive(previous.status) && previous.ownerPid !== process.pid) throw new Error('請先重載所有執行中的舊版視窗。');
            await copyFile(file, file + '.v1-backup', 1).catch(error => { if (error.code !== 'EEXIST') throw error; });
          }
        } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      }
      await atomicNetworkJson(file, JSON.parse(serialized));
      // A different window may have deleted the record while this write was pending.
      if (await this.isDeleted(record.id)) {
        await unlink(path.join(this.directory, record.id + '.json')).catch(error => { if (error.code !== 'ENOENT') throw error; });
        await removeOwnedStorage(this.directory, path.join(this.directory, record.id + '.json.v1-backup'));
        throw new CodexTaskDeletedError();
      }
    });
    this.queue = task.catch(() => {}); return task;
  }
  async isDeleted(id: string): Promise<boolean> {
    if (!validTaskId(id)) throw new Error('Codex 任務識別無效。');
    try {
      const pending = path.join(this.directory, id + '.cleanup.json');
      if (await ownedStoragePath(this.directory, pending)) return true;
      const info = await lstat(path.join(this.directory, id + '.deleted.json'));
      if (!info.isFile() || info.isSymbolicLink() || info.size > 1024) throw new Error('Codex 刪除紀錄格式無效。');
      return true;
    } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
  }
  async control<T>(id: string, operation: () => Promise<T>): Promise<T> {
    if (!validTaskId(id)) throw new Error('Codex 任務識別無效。');
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const lease = await acquireStorageControl(path.join(this.directory, id + '.control'), 'codex-control');
    try { return await operation(); } finally { await lease.release(); }
  }
  async remove(id: string, prepare?: (record: CodexTaskRecord) => Promise<void>): Promise<void> {
    await this.control(id, async () => {
      await this.flush();
      if (await this.isDeleted(id)) { await this.finishCleanup(id); return; }
      const record = (await this.load()).find(value => value.id === id);
      if (!record) return;
      if (codexTaskActive(record.status) || ['queued', 'uncertain'].includes(record.status) || record.result?.state === 'uncertain' || record.publication?.state === 'pending') throw new Error('請先暫停任務並確認清理及發布結果，再刪除紀錄。');
      if (record.lease && record.lease.released !== true) throw new Error('請先核對任務狀態，確認程序與執行鎖已釋放，再刪除紀錄。');
      await prepare?.(record);
      await ownedStoragePath(path.dirname(this.directory), this.directory);
      // The atomic journal also fences stale writers if the host exits before the tombstone.
      await atomicNetworkJson(path.join(this.directory, id + '.cleanup.json'), taskCleanupPlan(record));
      await this.finishCleanup(id);
    });
  }
  private async finishCleanup(id: string): Promise<void> {
    const journal = path.join(this.directory, id + '.cleanup.json');
    let plan: CodexCleanupPlan | undefined;
    if (await ownedStoragePath(this.directory, journal)) {
      const info = await lstat(journal);
      if (!info.isFile() || info.size > 64 * 1024) throw new Error('刪除清理清單無法驗證。');
      plan = JSON.parse(await readFile(journal, 'utf8')); validateCleanupPlan(plan!, id);
    }
    if (!await this.isDeleted(id)) return;
    try {
      const legacy = path.join(this.directory, id + '.json');
      if (!plan && await ownedStoragePath(this.directory, legacy)) {
        const info = await lstat(legacy);
        if (!info.isFile() || info.size > 4 * 1024 * 1024) throw new Error('舊刪除紀錄無法驗證。');
        const record = JSON.parse(await readFile(legacy, 'utf8')) as CodexTaskRecord;
        if (record.id !== id || !validStoredCodexProjection(record)) throw new Error('舊刪除紀錄無法驗證。');
        plan = taskCleanupPlan(record); validateCleanupPlan(plan, id); await atomicNetworkJson(journal, plan);
      }
      if (!await ownedStoragePath(this.directory, path.join(this.directory, id + '.deleted.json'))) {
      await atomicNetworkJson(path.join(this.directory, id + '.deleted.json'), {
        schema: 'GitLabWorkspaceCodexDeleted/v1', id, deletedAt: new Date().toISOString()
      });
      }
      await removeOwnedStorage(this.directory, path.join(this.directory, id + '.json'));
      await removeOwnedStorage(this.directory, path.join(this.directory, id + '.json.v1-backup'));
      for (const suffix of ['.json', '.cleanup.json', '.deleted.json']) await removeOwnedAtomicTemps(this.directory, path.join(this.directory, id + suffix));
      if (plan) { await this.cleanup(plan); await removeOwnedStorage(this.directory, journal); }
      this.cleanupProblems = this.cleanupProblems.filter(problem => problem.id !== id);
    } catch (error) {
      this.cleanupProblems = [...this.cleanupProblems.filter(problem => problem.id !== id), { id, kind: 'cleanup', reason: '對話已移除，附屬資料清理待重試；請按重新讀取。' }];
      throw error;
    }
  }
  async retryCleanup(): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    await ownedStoragePath(path.dirname(this.directory), this.directory);
    const names = new Set(await readdir(this.directory));
    const atomicIds = new Set([...names].flatMap(name => {
      const match = /^([a-z0-9-]{1,100})\.(?:json|cleanup\.json|deleted\.json)\.[a-f0-9-]{36}\.tmp$/i.exec(name); return match ? [match[1]] : [];
    }));
    const ids = new Set([...names].flatMap(name => {
      const match = /^([a-z0-9-]{1,100})\.(cleanup|deleted)\.json$/i.exec(name);
      return match && (match[2] === 'cleanup' || names.has(match[1] + '.json') || names.has(match[1] + '.json.v1-backup') || atomicIds.has(match[1])) ? [match[1]] : [];
    }));
    for (const id of ids) {
      try { await this.control(id, () => this.finishCleanup(id)); }
      catch (error) {
        if (missingFile(error)) continue;
        this.cleanupProblems = [...this.cleanupProblems.filter(problem => problem.id !== id), { id, kind: 'cleanup', reason: '刪除清理尚未完成或清單無法驗證；原件已保留，請重新讀取重試。' }];
      }
    }
  }
  async flush(): Promise<void> { await this.queue; }
}
