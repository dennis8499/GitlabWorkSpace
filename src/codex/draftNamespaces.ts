import type { CodexUiDraftEntry, CodexUiDraftSnapshot } from './uiDraftProtocol';
import { parseCodexUiDraftKey } from './uiDraftProtocol';
import { CodexUiDraftStore } from './uiDraftStore';

export type CodexDraftNamespace = 'local' | 'remote';
export interface CodexDraftNamespacesOptions {
  store: CodexUiDraftStore;
  local: string;
  remote: string;
  legacy: readonly string[];
  resolve(entry: CodexUiDraftEntry): Promise<CodexDraftNamespace | undefined>;
}
/** Two independent CAS stores. UI keys name immutable tasks, so their versions can be composed without renumbering. */
export class CodexDraftNamespaces {
  constructor(private readonly options: CodexDraftNamespacesOptions) {}
  private pendingTombstone(entry: CodexUiDraftEntry): boolean {
    return entry.value === null && parseCodexUiDraftKey(entry.key)[0] === 'pending';
  }
  private async migrate(): Promise<void> {
    const { store, local, remote } = this.options;
    const scopes = new Set(await store.scopes());
    for (const scope of new Set(this.options.legacy)) {
      if (!scopes.has(scope) || scope === local || scope === remote) continue;
      const previous = await store.read(scope);
      for (const entry of previous.entries) {
        const [kind] = parseCodexUiDraftKey(entry.key);
        // Pending receipts retain their original identity; they are never migrated into a new operation.
        if (['pending', 'submission'].includes(kind) || entry.value === null) continue;
        const namespace = await this.options.resolve(entry);
        if (!namespace) continue;
        const target = namespace === 'local' ? local : remote;
        const migration = JSON.stringify([scope, target, entry.key, entry.revision]);
        if (await store.hasMigration(migration)) continue;
        const current = await store.read(target), existing = current.entries.find(value => value.key === entry.key);
        if (existing && JSON.stringify(existing.value) === JSON.stringify(entry.value) ||
          current.conflicts.some(value => value.key === entry.key && JSON.stringify(value.value) === JSON.stringify(entry.value))) {
          await store.markMigration(migration); continue;
        }
        // Revision zero preserves another window's newer content as a visible conflict.
        await store.save(target, [{ key: entry.key, revision: 0, value: entry.value }]);
        await store.markMigration(migration);
      }
    }
  }
  async read(): Promise<CodexUiDraftSnapshot> {
    await this.migrate();
    const { store, local, remote } = this.options;
    const snapshots = await Promise.all([store.read(local), store.read(remote)]);
    const entries: CodexUiDraftEntry[] = [], conflicts: CodexUiDraftSnapshot['conflicts'] = [];
    for (let index = 0; index < snapshots.length; index++) {
      for (const entry of snapshots[index].entries) {
        const namespace = this.pendingTombstone(entry) ? index === 0 ? 'local' : 'remote' : await this.options.resolve(entry);
        if (namespace === (index === 0 ? 'local' : 'remote')) entries.push(entry);
      }
      for (const conflict of snapshots[index].conflicts) {
        const entry = { ...conflict, revision: 0 };
        const namespace = this.pendingTombstone(entry) ? index === 0 ? 'local' : 'remote' : await this.options.resolve(entry);
        if (namespace === (index === 0 ? 'local' : 'remote')) conflicts.push(conflict);
      }
    }
    return { scope: local, remoteScope: remote, entries, conflicts };
  }
  async save(scope: string, remoteScope: string | undefined, updates: CodexUiDraftEntry[], resolveIds: string[] = []): Promise<CodexUiDraftSnapshot> {
    const { store, local, remote } = this.options;
    if (scope !== local) throw new Error('專案草稿範圍已變更，請重新載入。');
    const localUpdates: CodexUiDraftEntry[] = [], remoteUpdates: CodexUiDraftEntry[] = [];
    const previous = updates.some(entry => this.pendingTombstone(entry)) ? await Promise.all([store.read(local), store.read(remote)]) : [];
    for (const entry of updates) {
      let namespace: CodexDraftNamespace | undefined;
      if (this.pendingTombstone(entry)) {
        const owners = previous.flatMap((snapshot, index) => snapshot.entries.some(value => value.key === entry.key) ? [index === 0 ? 'local' as const : 'remote' as const] : []);
        if (owners.length > 1) throw new Error('送出收據所屬範圍無法確認；原件保留。');
        namespace = owners[0] ?? 'local';
      } else namespace = await this.options.resolve(entry);
      if (!namespace) throw new Error('草稿所屬任務無法確認；原輸入保留。');
      (namespace === 'local' ? localUpdates : remoteUpdates).push(entry);
    }
    if (remoteUpdates.length && remoteScope !== remote) throw new Error('GitLab 草稿帳號已變更；原輸入保留。');
    const results = await Promise.all([store.save(local, localUpdates, resolveIds), store.save(remote, remoteUpdates, resolveIds)]);
    const snapshot = await this.read();
    snapshot.deletedTaskIds = [...new Set(results.flatMap(value => value.deletedTaskIds ?? []))];
    return snapshot;
  }
}
