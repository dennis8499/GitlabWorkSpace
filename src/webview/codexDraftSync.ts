import { sanitizeCodexUiDraftValue, parseCodexUiDraftKey, type CodexUiDraftEntry, type CodexUiDraftConflict, type CodexUiDraftSnapshot } from '../codex/uiDraftProtocol';
import type { CodexUiState } from './codexUiState';

export interface CodexDraftSyncMetadata { scope?: string; bases: CodexUiDraftEntry[]; }
const key = (kind: string, id: string) => JSON.stringify([kind, id]);
const stable = (value: unknown): string => JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item)
  ? Object.fromEntries(Object.entries(item).sort(([left], [right]) => left.localeCompare(right))) : item);
const same = (left: unknown, right: unknown) => stable(left ?? null) === stable(right ?? null);
const clean = (entryKey: string, value: unknown) => sanitizeCodexUiDraftValue(entryKey, JSON.parse(JSON.stringify(value)));
function taskOf(entryKey: string, value: unknown): string | undefined {
  const [kind, id] = parseCodexUiDraftKey(entryKey);
  if (['draft', 'reading', 'view', 'launch'].includes(kind)) return id;
  if (kind === 'selection') return typeof value === 'string' ? value : undefined;
  if (kind === 'pending') return value && typeof value === 'object' && typeof (value as { taskId?: unknown }).taskId === 'string' ? (value as { taskId: string }).taskId : undefined;
  if (['interaction', 'submission', 'reply'].includes(kind)) { try { const pair = JSON.parse(id); return Array.isArray(pair) && typeof pair[0] === 'string' ? pair[0] : undefined; } catch { return; } }
}

export function codexDraftEntries(ui: CodexUiState): Map<string, unknown> {
  const entries = new Map<string, unknown>();
  const add = (kind: string, values?: Record<string, unknown>) => {
    for (const [id, value] of Object.entries(values ?? {})) {
      const entryKey = key(kind, id);
      try { entries.set(entryKey, clean(entryKey, value)); } catch { /* Invalid restored data never leaves this Webview. */ }
    }
  };
  add('draft', ui.drafts); add('pending', ui.pending); add('reading', ui.reading); add('interaction', ui.interactionDrafts);
  add('submission', ui.interactionSubmissions); add('view', ui.views); add('reply', ui.workflow?.replies);
  add('launch', Object.fromEntries(Object.entries(ui.launchDrafts ?? {}).map(([id, patch]) => [id, { patch, ...(ui.launchDraftBases?.[id] === undefined ? {} : { baseRevision: ui.launchDraftBases[id] }) }])));
  if (ui.selectedTaskId) add('selection', { current: ui.selectedTaskId });
  return entries;
}

export function restoreCodexDraftSync(value: unknown): CodexDraftSyncMetadata | undefined {
  if (!value || typeof value !== 'object') return;
  const candidate = value as Partial<CodexDraftSyncMetadata>;
  if (typeof candidate.scope !== 'string' || candidate.scope.length > 2000 || !Array.isArray(candidate.bases)) return;
  const bases: CodexUiDraftEntry[] = [];
  for (const entry of candidate.bases.slice(0, 3000)) {
    try {
      if (!entry || typeof entry.key !== 'string' || !Number.isSafeInteger(entry.revision) || entry.revision < 0) continue;
      bases.push({ key: entry.key, revision: entry.revision, value: clean(entry.key, entry.value) });
    } catch { /* Ignore malformed cache metadata. */ }
  }
  return { scope: candidate.scope, bases };
}

function apply(ui: CodexUiState, entryKey: string, value: unknown | null): CodexUiState {
  const [kind, id] = parseCodexUiDraftKey(entryKey);
  if (kind === 'selection') return { ...ui, selectedTaskId: value === null ? undefined : value as string };
  if (kind === 'launch') {
    const launchDrafts = { ...ui.launchDrafts }, launchDraftBases = { ...ui.launchDraftBases };
    if (value === null) { delete launchDrafts[id]; delete launchDraftBases[id]; }
    else {
      const item = value as { patch: NonNullable<CodexUiState['launchDrafts']>[string]; baseRevision?: number }; launchDrafts[id] = item.patch;
      if (item.baseRevision === undefined) delete launchDraftBases[id]; else launchDraftBases[id] = item.baseRevision;
    }
    return { ...ui, launchDrafts, launchDraftBases };
  }
  if (kind === 'reply') {
    const replies = { ...ui.workflow?.replies }; if (value === null) delete replies[id]; else replies[id] = value as (typeof replies)[string];
    return { ...ui, workflow: { replies } };
  }
  const property = { draft: 'drafts', pending: 'pending', reading: 'reading', interaction: 'interactionDrafts', submission: 'interactionSubmissions', view: 'views' }[kind] as 'drafts';
  const values: Record<string, unknown> = { ...ui[property] }; if (value === null) delete values[id]; else values[id] = value;
  return { ...ui, [property]: values } as CodexUiState;
}

/** Every write uses the last acknowledged revision for its own entry. */
export class CodexDraftSync {
  scope?: string;
  loaded = false;
  conflicts: CodexUiDraftConflict[] = [];
  private bases = new Map<string, CodexUiDraftEntry>();
  private remote = new Map<string, CodexUiDraftEntry>();
  private dirty = new Set<string>();
  private changedHere = new Set<string>();
  private submitted?: CodexUiDraftEntry[];
  private submittedResolutions: string[] = [];
  private resolving = new Set<string>();
  private urgentVersions = new Map<string, string>();
  constructor(ui: CodexUiState) {
    const saved = restoreCodexDraftSync(ui.draftSync); this.scope = saved?.scope;
    for (const entry of saved?.bases ?? []) this.bases.set(entry.key, entry);
    const local = codexDraftEntries(ui);
    for (const entryKey of new Set([...local.keys(), ...this.bases.keys()])) if (!same(local.get(entryKey), this.bases.get(entryKey)?.value)) this.dirty.add(entryKey);
  }
  metadata(): CodexDraftSyncMetadata | undefined { return this.scope ? { scope: this.scope, bases: [...this.bases.values()] } : undefined; }
  note(before: CodexUiState, after: CodexUiState): void {
    const previous = codexDraftEntries(before), next = codexDraftEntries(after);
    for (const entryKey of new Set([...previous.keys(), ...next.keys()])) {
      if (same(previous.get(entryKey), next.get(entryKey))) continue;
      this.changedHere.add(entryKey);
      if (same(next.get(entryKey), this.bases.get(entryKey)?.value)) this.dirty.delete(entryKey); else this.dirty.add(entryKey);
    }
  }
  load(snapshot: CodexUiDraftSnapshot, ui: CodexUiState): CodexUiState {
    if (this.scope && this.scope !== snapshot.scope) {
      const current = codexDraftEntries(ui); this.bases.clear(); this.remote.clear(); this.dirty.clear(); ui = { drafts: {}, pending: {} };
      for (const entryKey of this.changedHere) if (current.has(entryKey)) { ui = apply(ui, entryKey, current.get(entryKey)); this.dirty.add(entryKey); }
    }
    this.scope = snapshot.scope; this.loaded = true;
    ui = this.purgeDeleted(snapshot, ui);
    return this.absorb(snapshot, ui, true);
  }
  private purgeDeleted(snapshot: CodexUiDraftSnapshot, ui: CodexUiState): CodexUiState {
    const deleted = new Set(snapshot.deletedTaskIds ?? []); if (!deleted.size) return ui;
    const current = codexDraftEntries(ui), removed = new Set<string>();
    for (const entryKey of new Set([...current.keys(), ...this.bases.keys(), ...this.remote.keys(), ...this.dirty])) {
      if (parseCodexUiDraftKey(entryKey)[0] === 'selection' && typeof current.get(entryKey) === 'string' && !deleted.has(String(current.get(entryKey))) &&
        [this.bases.get(entryKey)?.value, this.remote.get(entryKey)?.value, this.submitted?.find(item => item.key === entryKey)?.value].some(value => typeof value === 'string' && deleted.has(value))) {
        this.bases.delete(entryKey); this.remote.delete(entryKey); this.submitted = this.submitted?.filter(item => item.key !== entryKey); this.dirty.add(entryKey); continue;
      }
      const value = current.get(entryKey) ?? this.bases.get(entryKey)?.value ?? this.remote.get(entryKey)?.value;
      if (!deleted.has(taskOf(entryKey, value) ?? '')) continue;
      removed.add(entryKey); ui = apply(ui, entryKey, null); this.bases.delete(entryKey); this.remote.delete(entryKey); this.dirty.delete(entryKey); this.changedHere.delete(entryKey); this.urgentVersions.delete(entryKey);
    }
    this.submitted = this.submitted?.filter(entry => !removed.has(entry.key));
    for (const conflict of this.conflicts) if (removed.has(conflict.key)) this.resolving.delete(conflict.id);
    this.conflicts = this.conflicts.filter(conflict => !removed.has(conflict.key));
    return ui;
  }
  private absorb(snapshot: CodexUiDraftSnapshot, ui: CodexUiState, hydrate = false): CodexUiState {
    const deleted = new Set(snapshot.deletedTaskIds ?? []), entries = snapshot.entries.filter(entry => !deleted.has(taskOf(entry.key, entry.value) ?? ''));
    this.conflicts = snapshot.conflicts.filter(conflict => !deleted.has(taskOf(conflict.key, conflict.value) ?? '')).map(conflict => ({ ...conflict, value: clean(conflict.key, conflict.value) }));
    for (const id of this.resolving) if (!this.conflicts.some(item => item.id === id)) this.resolving.delete(id);
    const keys = new Set(entries.map(entry => entry.key)), local = codexDraftEntries(ui);
    for (const entryKey of this.remote.keys()) if (!keys.has(entryKey)) this.remote.delete(entryKey);
    for (const entryKey of this.bases.keys()) if (!keys.has(entryKey) && !this.dirty.has(entryKey)) { ui = apply(ui, entryKey, null); this.bases.delete(entryKey); this.remote.delete(entryKey); }
    for (const entry of entries) {
      const received = { ...entry, value: clean(entry.key, entry.value) };
      this.remote.set(entry.key, received);
      if (this.dirty.has(entry.key) && same(local.get(entry.key), received.value)) this.dirty.delete(entry.key);
      if (!this.dirty.has(entry.key)) {
        const previous = this.bases.get(entry.key);
        if (hydrate || !previous || received.revision > previous.revision || !same(received.value, previous.value)) ui = apply(ui, entry.key, received.value);
        this.bases.set(entry.key, received);
      }
    }
    return { ...ui, draftSync: this.metadata() };
  }
  next(ui: CodexUiState): { scope: string; updates: CodexUiDraftEntry[]; resolveConflictIds?: string[] } | undefined {
    if (!this.loaded || !this.scope || this.submitted) return;
    const blocked = new Set(this.conflicts.filter(item => !this.resolving.has(item.id)).map(item => item.key)), values = codexDraftEntries(ui);
    const candidates = new Set([...this.dirty, ...this.conflicts.filter(item => this.resolving.has(item.id)).map(item => item.key)]);
    const updates = [...candidates].filter(entryKey => !blocked.has(entryKey)).slice(0, 100).map(entryKey => ({ key: entryKey, revision: this.bases.get(entryKey)?.revision ?? 0, value: values.get(entryKey) ?? null }));
    if (!updates.length && !this.resolving.size) return;
    this.submitted = updates;
    this.submittedResolutions = [...this.resolving].filter(id => this.conflicts.some(item => item.id === id && updates.some(update => update.key === item.key))).slice(0, 100);
    return { scope: this.scope, updates, ...(this.submittedResolutions.length ? { resolveConflictIds: this.submittedResolutions } : {}) };
  }
  accepted(snapshot: CodexUiDraftSnapshot, ui: CodexUiState): CodexUiState {
    ui = this.purgeDeleted(snapshot, ui);
    const current = codexDraftEntries(ui), remote = new Map(snapshot.entries.map(entry => [entry.key, entry]));
    for (const update of this.submitted ?? []) {
      const received = remote.get(update.key), conflicted = snapshot.conflicts.some(item => item.key === update.key && same(item.value, update.value));
      if (received) this.bases.set(update.key, { ...received, value: clean(received.key, received.value) });
      if (conflicted) { this.dirty.add(update.key); continue; }
      if (!received && update.value === null) {
        this.bases.delete(update.key); this.remote.delete(update.key);
        if (same(current.get(update.key), null)) this.dirty.delete(update.key);
      } else if (received && (received.revision > update.revision || received.revision === update.revision && same(received.value, update.value))) {
        if (same(current.get(update.key), update.value)) { this.dirty.delete(update.key); ui = apply(ui, update.key, received.value); }
        else this.dirty.add(update.key);
      }
    }
    this.submitted = undefined; for (const id of this.submittedResolutions) this.resolving.delete(id); this.submittedResolutions = [];
    return this.absorb(snapshot, ui);
  }
  failed(): void { this.submitted = undefined; }
  urgent(ui: CodexUiState): { scope: string; updates: CodexUiDraftEntry[] } | undefined {
    if (!this.loaded || !this.scope) return;
    const values = codexDraftEntries(ui), updates: CodexUiDraftEntry[] = [];
    for (const entryKey of this.dirty) {
      const value = values.get(entryKey) ?? null, revision = this.bases.get(entryKey)?.revision ?? 0, version = `${revision}:${stable(value)}`;
      if (this.urgentVersions.get(entryKey) === version || this.submitted?.some(item => item.key === entryKey && same(item.value, value)) || this.conflicts.some(item => item.key === entryKey && same(item.value, value))) continue;
      this.urgentVersions.set(entryKey, version); updates.push({ key: entryKey, revision, value });
      if (updates.length === 100) break;
    }
    return updates.length ? { scope: this.scope, updates } : undefined;
  }
  candidate(conflict: CodexUiDraftConflict, ui: CodexUiState): unknown {
    return this.dirty.has(conflict.key) ? codexDraftEntries(ui).get(conflict.key) ?? null : conflict.value;
  }
  resolve(id: string, choice: 'stored' | 'mine', ui: CodexUiState): CodexUiState {
    const conflict = this.conflicts.find(item => item.id === id); if (!conflict) return ui;
    const received = this.remote.get(conflict.key); if (received) this.bases.set(conflict.key, received); else this.bases.delete(conflict.key);
    const value = choice === 'stored' ? received?.value ?? null : this.candidate(conflict, ui);
    for (const item of this.conflicts) if (item.key === conflict.key) this.resolving.add(item.id);
    ui = apply(ui, conflict.key, value);
    this.dirty.add(conflict.key); // Resolution itself needs an acknowledged CAS, including the stored/no-op choice.
    return { ...ui, draftSync: this.metadata() };
  }
  stored(conflict: CodexUiDraftConflict): unknown { return this.remote.get(conflict.key)?.value ?? null; }
}

export function codexDraftConflictText(value: unknown): string {
  if (value === null) return '（已清空）';
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object') {
    const item = value as { text?: unknown; patch?: { requirement?: unknown }; values?: unknown };
    if (typeof item.text === 'string') return item.text;
    if (typeof item.patch?.requirement === 'string') return item.patch.requirement;
    if (item.values) return JSON.stringify(item.values, null, 2);
  }
  return JSON.stringify(value, null, 2);
}
