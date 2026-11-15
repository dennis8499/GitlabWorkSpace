import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { atomicNetworkJson } from '../api/localNetworkLease';
import { acquireStorageControl } from '../storage/controlLease';
import { missingFile, ownedStoragePath } from '../storage/ownedStorage';
import { validWorkId } from './workContext';
import type { WorkIndex } from './workContextProtocol';

const scopeKey = (scope: string): string => {
  if (typeof scope !== 'string' || !scope || scope.length > 4096 || scope.includes('\0')) throw new Error('工作關聯範圍無效。');
  return createHash('sha256').update(scope).digest('hex');
};
const fail = (): never => { throw new Error('工作關聯紀錄無法驗證；既有任務與成果保留。'); };
/** Navigation only: no runner, credentials, approvals, or automatically started next step. */
export class WorkContextStore {
  private readonly directory: string;
  constructor(directory: string) { this.directory = path.resolve(directory); }
  private sourceKey(scope: string, sourceIdentity: string): { scope: string; identityDigest: string; file: string } {
    const key = scopeKey(scope), identityDigest = scopeKey(sourceIdentity);
    return { scope: key, identityDigest, file: path.join(this.directory, `source-${key}-${identityDigest}.json`) };
  }
  /** Source aliases carry only hashes and a work ID, never GitLab credentials or payloads. */
  async findSource(scope: string, sourceIdentity: string): Promise<string | undefined> {
    const target = this.sourceKey(scope, sourceIdentity);
    if (!await ownedStoragePath(path.dirname(this.directory), this.directory) || !await ownedStoragePath(this.directory, target.file)) return;
    const info = await lstat(target.file);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 1024) return fail();
    const bytes = await readFile(target.file); if (bytes.length !== info.size) return fail();
    const value = JSON.parse(bytes.toString('utf8')) as Record<string, unknown>;
    if (!value || Object.keys(value).some(key => !['schema', 'scope', 'identityDigest', 'workId'].includes(key)) || value.schema !== 'GitLabWorkspaceWorkSource/v1' ||
      value.scope !== target.scope || value.identityDigest !== target.identityDigest || !validWorkId(value.workId)) return fail();
    return value.workId;
  }
  /** Immutable source-to-work binding. Conflict preserves the existing source history. */
  async bindSource(scope: string, sourceIdentity: string, workId: string): Promise<void> {
    const target = this.sourceKey(scope, sourceIdentity); if (!validWorkId(workId)) return fail();
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    await ownedStoragePath(path.dirname(this.directory), this.directory);
    const gate = await acquireStorageControl(path.join(this.directory, '_write.control'), 'codex-work-index');
    try {
      const existing = await this.findSource(scope, sourceIdentity);
      if (existing) {
        if (existing !== workId) throw new Error('此來源已屬於另一份工作關聯，既有紀錄保留。');
        return;
      }
      await atomicNetworkJson(target.file, { schema: 'GitLabWorkspaceWorkSource/v1', scope: target.scope, identityDigest: target.identityDigest, workId });
    } finally { await gate.release(); }
  }
  private identity(scope: string, workId: string): { scope: string; file: string } {
    if (!validWorkId(workId)) return fail();
    const key = scopeKey(scope); return { scope: key, file: path.join(this.directory, `${key}-${workId}.json`) };
  }
  async read(scope: string, workId: string): Promise<WorkIndex> {
    const target = this.identity(scope, workId);
    if (!await ownedStoragePath(path.dirname(this.directory), this.directory) || !await ownedStoragePath(this.directory, target.file)) {
      return { schema: 'GitLabWorkspaceWorkIndex/v1', scope: target.scope, workId, revision: 0, links: [] };
    }
    const info = await lstat(target.file);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 512 * 1024) return fail();
    const bytes = await readFile(target.file); if (bytes.length !== info.size) return fail();
    const value = JSON.parse(bytes.toString('utf8')) as WorkIndex;
    if (!value || Object.keys(value).some(key => !['schema', 'scope', 'workId', 'revision', 'links'].includes(key)) || value.schema !== 'GitLabWorkspaceWorkIndex/v1' || value.scope !== target.scope || value.workId !== workId ||
      !Number.isSafeInteger(value.revision) || value.revision < 1 || !Array.isArray(value.links) || value.links.length > 1000) return fail();
    const ids = new Set<string>();
    for (const link of value.links) {
      if (!link || Object.keys(link).some(key => !['taskId', 'kind', 'linkedAt'].includes(key)) || !validWorkId(link.taskId) || ids.has(link.taskId) || typeof link.kind !== 'string' || !link.kind.trim() || link.kind.length > 100 || link.kind.includes('\0') ||
        typeof link.linkedAt !== 'string' || !Number.isFinite(Date.parse(link.linkedAt)) || new Date(link.linkedAt).toISOString() !== link.linkedAt) return fail();
      ids.add(link.taskId);
    }
    return value;
  }
  /** Idempotent append under the existing storage gate. CAS is available to explicit editors. */
  async attach(scope: string, workId: string, taskId: string, kind: string, expectedRevision?: number): Promise<WorkIndex> {
    const target = this.identity(scope, workId);
    if (!validWorkId(taskId) || typeof kind !== 'string' || !kind.trim() || kind.length > 100 || kind.includes('\0') ||
      expectedRevision !== undefined && (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0)) return fail();
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    await ownedStoragePath(path.dirname(this.directory), this.directory);
    const gate = await acquireStorageControl(path.join(this.directory, '_write.control'), 'codex-work-index');
    try {
      const current = await this.read(scope, workId), existing = current.links.find(link => link.taskId === taskId);
      if (existing) { if (existing.kind !== kind) return fail(); return current; }
      if (expectedRevision !== undefined && current.revision !== expectedRevision) throw new Error('工作關聯已由其他視窗更新，請重新讀取後再操作。');
      if (current.links.length >= 1000 || current.revision === Number.MAX_SAFE_INTEGER) return fail();
      const next: WorkIndex = { ...current, revision: current.revision + 1, links: [...current.links, { taskId, kind, linkedAt: new Date().toISOString() }] };
      if (Buffer.byteLength(JSON.stringify(next)) > 512 * 1024) return fail();
      // Recheck immediately before replacing an existing file; no redirected storage is followed.
      try { await ownedStoragePath(this.directory, target.file); } catch (error) { if (!missingFile(error)) throw error; }
      await atomicNetworkJson(target.file, next); return structuredClone(next);
    } finally { await gate.release(); }
  }
}
