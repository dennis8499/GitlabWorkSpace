/** Browser-safe identity for canonical host roots; POSIX names remain case sensitive. */
export function normalizeProjectRoot(value: string): string {
  const root = value.trim();
  if (/^(?:[a-z]:[\\/]|[\\/]{2})/i.test(root)) {
    const normalized = root.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
    return /^[a-z]:$/.test(normalized) ? normalized + '/' : normalized;
  }
  return root === '/' ? root : root.replace(/\/+$/, '');
}

export const projectDraftScope = (root: string): string => 'project-root:' + normalizeProjectRoot(root);

export function scopeProjectRoot(scope?: string): string | undefined {
  if (scope?.startsWith('project-root:')) return normalizeProjectRoot(scope.slice(13));
  if (scope?.startsWith('repository:')) return normalizeProjectRoot(scope.slice(11));
  const match = scope?.match(/^project:(.*):(group|repository|local)$/);
  return match ? normalizeProjectRoot(match[1]) : undefined;
}

/** Canonical data wins; old aliases are copied, never deleted or re-imported over it. */
export function savedProjectScope(root: string, values: object, current?: string, profile?: string): string | undefined {
  const entries = values as Record<string, unknown>, canonical = projectDraftScope(root), identity = normalizeProjectRoot(root);
  if (Object.hasOwn(entries, canonical)) return canonical;
  if (current && scopeProjectRoot(current) === identity && Object.hasOwn(entries, current)) return current;
  const matching = Object.keys(entries).filter(key => scopeProjectRoot(key) === identity);
  return matching.find(key => key.endsWith(':' + profile))
    ?? matching.find(key => key.endsWith(':local'))
    ?? matching.find(key => key.endsWith(':group'))
    ?? matching.find(key => key.endsWith(':repository'))
    ?? matching.find(key => key.startsWith('repository:')) ?? matching.sort()[0];
}

export function savedRootKey(root: string, values: object): string | undefined {
  const entries = values as Record<string, unknown>, canonical = projectDraftScope(root);
  return Object.hasOwn(entries, canonical) ? canonical
    : Object.hasOwn(entries, root) ? root
    : Object.keys(entries).find(key => !key.startsWith('project-root:') && normalizeProjectRoot(key) === normalizeProjectRoot(root));
}

export type ExplicitStateEdits = Record<string, unknown>;
const equal = (a: unknown, b: unknown): boolean => Object.is(a, b) || JSON.stringify(a) === JSON.stringify(b);

/** Capture only the changes made by a particular user event, including clears. */
export function recordStateEdits(edits: ExplicitStateEdits, before: object, after: object, maps: readonly string[] = []): void {
  const previous = before as ExplicitStateEdits, next = after as ExplicitStateEdits;
  for (const key of new Set([...Object.keys(previous), ...Object.keys(next)])) {
    if (equal(previous[key], next[key])) continue;
    if (!maps.includes(key)) { edits[key] = next[key]; continue; }
    const a = (previous[key] ?? {}) as ExplicitStateEdits, b = (next[key] ?? {}) as ExplicitStateEdits;
    const patch = (edits[key] ??= {}) as ExplicitStateEdits;
    for (const name of new Set([...Object.keys(a), ...Object.keys(b)])) if (!equal(a[name], b[name])) patch[name] = b[name];
  }
}

export function applyStateEdits<T extends object>(state: T, edits: ExplicitStateEdits, maps: readonly string[] = []): T {
  const result = { ...state } as ExplicitStateEdits;
  for (const [key, value] of Object.entries(edits)) {
    if (!maps.includes(key)) { if (value === undefined) delete result[key]; else result[key] = value; continue; }
    const merged = { ...(result[key] as object ?? {}) } as ExplicitStateEdits;
    for (const [name, item] of Object.entries(value as ExplicitStateEdits)) { if (item === undefined) delete merged[name]; else merged[name] = item; }
    result[key] = merged;
  }
  return result as T;
}

export function sameHydratingIdentity(before: { activeAccountId?: string; baseUrl?: string; group?: { id: number } } | undefined,
  after: { activeAccountId?: string; baseUrl?: string; group?: { id: number } }): boolean {
  return !before || (!before.activeAccountId || !after.activeAccountId || before.activeAccountId === after.activeAccountId)
    && (!before.baseUrl || !after.baseUrl || before.baseUrl === after.baseUrl)
    && (!before.group || !after.group || before.group.id === after.group.id);
}
