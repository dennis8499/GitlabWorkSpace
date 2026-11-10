import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { atomicNetworkJson } from '../api/localNetworkLease';
import { acquireStorageControl } from '../storage/controlLease';
import { missingFile, ownedStoragePath } from '../storage/ownedStorage';
import { parseCodexUiDraftKey, type CodexUiDraftEntry, type CodexUiDraftConflict, type CodexUiDraftSnapshot } from './uiDraftProtocol';

const schema = 'GitLabWorkspaceCodexUiDraft/v1', maxBytes = 8 * 1024 * 1024, maxEntries = 1000, maxConflicts = 200;
const deletedSchema = 'GitLabWorkspaceCodexUiDraftDeleted/v1';
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value) &&
  [Object.prototype, null].includes(Object.getPrototypeOf(value));
const revision = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;
const fields = (value: Record<string, unknown>, names: string[]) => Object.keys(value).length === names.length && names.every(name => Object.hasOwn(value, name));
const fail = (message = 'Codex 草稿資料無法驗證；原件已保留。'): never => { throw new Error(message); };
function key(value: unknown): string {
  if (typeof value !== 'string' || !value || value.length > 9000) return fail();
  parseCodexUiDraftKey(value); return value;
}
/** Reject lossy JSON values and bound traversal before creating a canonical copy. */
function jsonValue(value: unknown, budget = { bytes: maxBytes }, depth = 0, seen = new Set<object>()): unknown {
  const charge = (bytes: number) => { budget.bytes -= bytes; if (budget.bytes < 0) fail('Codex 草稿超過 8 MiB；既有內容未變更。'); };
  if (value === null || typeof value === 'boolean') { charge(JSON.stringify(value).length); return value; }
  if (typeof value === 'number') { if (!Number.isFinite(value)) return fail(); charge(JSON.stringify(value).length); return value; }
  if (typeof value === 'string') { charge(Buffer.byteLength(value, 'utf8') + 2); return value; }
  if (depth >= 64 || !value || typeof value !== 'object' || seen.has(value) || !Array.isArray(value) && !object(value)) return fail();
  seen.add(value); charge(2);
  try {
    if (Array.isArray(value)) {
      const result: unknown[] = [];
      for (let index = 0; index < value.length; index++) { charge(1); result.push(jsonValue(value[index], budget, depth + 1, seen)); }
      return result;
    }
    const entries: Array<[string, unknown]> = [];
    for (const name of Object.keys(value).sort()) {
      const descriptor = Object.getOwnPropertyDescriptor(value, name)!;
      if (!Object.hasOwn(descriptor, 'value')) return fail();
      charge(Buffer.byteLength(name, 'utf8') + 4); entries.push([name, jsonValue(descriptor.value, budget, depth + 1, seen)]);
    }
    return Object.fromEntries(entries);
  } finally { seen.delete(value); }
}
const equal = (left: unknown, right: unknown): boolean => JSON.stringify(left) === JSON.stringify(right);
function taskFor(key: string, value: unknown): string | undefined {
  const [kind, id] = parseCodexUiDraftKey(key);
  if (['draft', 'reading', 'view', 'launch'].includes(kind)) return id;
  if (kind === 'selection') return typeof value === 'string' ? value : undefined;
  if (kind === 'pending') return object(value) && typeof value.taskId === 'string' ? value.taskId : undefined;
  const pair: unknown = JSON.parse(id);
  if (!Array.isArray(pair) || pair.length !== 2 || typeof pair[0] !== 'string') return fail();
  return pair[0];
}

/** Durable UI data only. No read, merge or conflict resolution dispatches a task. */
export class CodexUiDraftStore {
  constructor(private readonly directory: string) {}
  private file(scope: string): string {
    if (typeof scope !== 'string' || !/^[a-f0-9]{64}$/.test(scope)) return fail('Codex 草稿範圍無效。');
    return path.join(this.directory, scope + '.json');
  }
  private async ensureDirectory(): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    if (!await ownedStoragePath(path.dirname(this.directory), this.directory)) fail();
  }
  private deletedFile(taskId: string): { file: string; task: string } {
    const task = createHash('sha256').update(taskId).digest('hex');
    return { file: path.join(this.directory, 'deleted-' + task + '.json'), task };
  }
  private async deleted(taskId: string): Promise<boolean> {
    const { file, task } = this.deletedFile(taskId);
    if (!await ownedStoragePath(this.directory, file)) return false;
    const info = await lstat(file); if (!info.isFile() || info.isSymbolicLink() || info.size > 256) return fail();
    const bytes = await readFile(file); if (bytes.length > 256) return fail();
    const marker: unknown = JSON.parse(bytes.toString('utf8'));
    if (!object(marker) || !fields(marker, ['schema', 'task']) || marker.schema !== deletedSchema || marker.task !== task) return fail();
    return true;
  }
  async isTaskDeleted(taskId: string): Promise<boolean> {
    if (typeof taskId !== 'string' || !taskId || taskId.length > 160 || taskId.includes('\0')) return fail();
    await this.ensureDirectory(); return this.deleted(taskId);
  }
  async read(scope: string): Promise<CodexUiDraftSnapshot> {
    const file = this.file(scope); await this.ensureDirectory();
    if (!await ownedStoragePath(this.directory, file)) return { scope, entries: [], conflicts: [] };
    let info;
    try { info = await lstat(file); } catch (error) { if (missingFile(error)) return { scope, entries: [], conflicts: [] }; throw error; }
    if (!info.isFile() || info.isSymbolicLink() || info.size > maxBytes) return fail();
    const bytes = await readFile(file); if (bytes.length > maxBytes) return fail();
    const stored: unknown = JSON.parse(bytes.toString('utf8'));
    if (!object(stored) || !fields(stored, ['schema', 'scope', 'entries', 'conflicts']) || stored.schema !== schema || stored.scope !== scope ||
        !Array.isArray(stored.entries) || stored.entries.length > maxEntries || !Array.isArray(stored.conflicts) || stored.conflicts.length > maxConflicts) return fail();
    const budget = { bytes: maxBytes }, keys = new Set<string>(), ids = new Set<string>();
    const entries: CodexUiDraftEntry[] = stored.entries.map(value => {
      if (!object(value) || !fields(value, ['key', 'revision', 'value']) || !revision(value.revision) || value.revision < 1) return fail();
      const name = key(value.key); if (keys.has(name)) return fail(); keys.add(name);
      return { key: name, revision: value.revision, value: jsonValue(value.value, budget) };
    });
    const conflicts: CodexUiDraftConflict[] = stored.conflicts.map(value => {
      if (!object(value) || !fields(value, ['id', 'key', 'value', 'createdAt']) || typeof value.id !== 'string' || !uuid.test(value.id) || ids.has(value.id) ||
          typeof value.createdAt !== 'string' || !Number.isFinite(Date.parse(value.createdAt)) || new Date(value.createdAt).toISOString() !== value.createdAt) return fail();
      ids.add(value.id); return { id: value.id, key: key(value.key), value: jsonValue(value.value, budget), createdAt: value.createdAt };
    });
    return { scope, entries, conflicts };
  }
  async save(scope: string, updates: CodexUiDraftEntry[], resolveConflictIds: string[] = []): Promise<CodexUiDraftSnapshot> {
    const file = this.file(scope), budget = { bytes: maxBytes }, keys = new Set<string>();
    if (!Array.isArray(updates) || updates.length > maxEntries || !Array.isArray(resolveConflictIds) || resolveConflictIds.length > maxConflicts ||
        resolveConflictIds.some(id => typeof id !== 'string' || !uuid.test(id))) return fail();
    const clean = updates.map(update => {
      if (!object(update) || !fields(update, ['key', 'revision', 'value']) || !revision(update.revision)) return fail();
      const name = key(update.key); if (keys.has(name)) return fail(); keys.add(name);
      return { key: name, revision: update.revision, value: jsonValue(update.value, budget) };
    });
    await this.ensureDirectory();
    // The directory gate also fences creation of a new scope against task deletion.
    const lease = await acquireStorageControl(path.join(this.directory, '_write.control'), 'codex-ui-drafts');
    try {
      const snapshot = await this.read(scope), entries = new Map(snapshot.entries.map(entry => [entry.key, entry]));
      const active: typeof clean = [], deletedTaskIds = new Set<string>(), deletionStates = new Map<string, boolean>();
      for (const update of clean) {
        const current = entries.get(update.key);
        const incomingTaskId = taskFor(update.key, update.value);
        const taskId = incomingTaskId ?? (update.value === null && current ? taskFor(current.key, current.value) : undefined);
        if (taskId !== undefined) {
          if (!deletionStates.has(taskId)) deletionStates.set(taskId, await this.deleted(taskId));
          if (deletionStates.get(taskId)) {
            // Reject this stale update without blocking unrelated edits. Project
            // only task IDs already supplied by this caller, never global markers.
            if (incomingTaskId !== undefined) deletedTaskIds.add(incomingTaskId);
            if (current && taskFor(current.key, current.value) === taskId) entries.delete(update.key);
            continue;
          }
        }
        active.push(update);
      }
      const eligible = new Set<string>(), rejected: Array<{ key: string; value: unknown }> = [];
      for (const update of active) {
        const current = entries.get(update.key), currentRevision = current?.revision ?? 0;
        if (update.revision === currentRevision) {
          eligible.add(update.key);
          if (!current || !equal(current.value, update.value)) {
            if (currentRevision === Number.MAX_SAFE_INTEGER) return fail();
            entries.set(update.key, { ...update, revision: currentRevision + 1 });
          }
        } else if (!current || !equal(current.value, update.value)) rejected.push(update);
      }
      // Use stored revisions for CAS before recovering an interrupted deletion;
      // its remaining fields must never be projected back to UI or persisted.
      for (const [key, entry] of entries) if (deletedTaskIds.has(taskFor(entry.key, entry.value) ?? '')) entries.delete(key);
      const resolving = new Set(resolveConflictIds);
      const conflicts = snapshot.conflicts.filter(conflict => !deletedTaskIds.has(taskFor(conflict.key, conflict.value) ?? '') && !(resolving.has(conflict.id) && eligible.has(conflict.key)));
      for (const update of rejected) if (!conflicts.some(conflict => conflict.key === update.key && equal(conflict.value, update.value))) {
        conflicts.push({ key: update.key, value: update.value, id: randomUUID(), createdAt: new Date().toISOString() });
      }
      const next: CodexUiDraftSnapshot = { scope, entries: [...entries.values()], conflicts };
      const stored = { schema, ...next };
      if (next.entries.length > maxEntries || next.conflicts.length > maxConflicts || Buffer.byteLength(JSON.stringify(stored), 'utf8') > maxBytes) {
        return fail('Codex 草稿超過保存上限；既有內容未變更，請先處理已保存的草稿或衝突。');
      }
      await atomicNetworkJson(file, stored);
      return structuredClone({ ...next, ...(deletedTaskIds.size ? { deletedTaskIds: [...deletedTaskIds] } : {}) });
    } finally { await lease.release(); }
  }
  /** Persist the deletion fence before removing all related drafts and local conflict copies. */
  async removeTask(taskId: string): Promise<void> {
    if (typeof taskId !== 'string' || !taskId || taskId.length > 160 || taskId.includes('\0')) return fail();
    await this.ensureDirectory();
    const lease = await acquireStorageControl(path.join(this.directory, '_write.control'), 'codex-ui-drafts');
    try {
      if (!await this.deleted(taskId)) {
        const { file, task } = this.deletedFile(taskId); await atomicNetworkJson(file, { schema: deletedSchema, task });
      }
      for (const name of await readdir(this.directory)) {
        if (!/^[a-f0-9]{64}\.json$/.test(name)) continue;
        const scope = name.slice(0, -5), snapshot = await this.read(scope);
        const entries = snapshot.entries.filter(entry => taskFor(entry.key, entry.value) !== taskId);
        const conflicts = snapshot.conflicts.filter(conflict => taskFor(conflict.key, conflict.value) !== taskId);
        if (entries.length !== snapshot.entries.length || conflicts.length !== snapshot.conflicts.length) {
          await atomicNetworkJson(this.file(scope), { schema, scope, entries, conflicts });
        }
      }
    } finally { await lease.release(); }
  }
}
