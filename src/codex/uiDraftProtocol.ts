import type { CodexInteraction } from './protocol';
/** Durable UI drafts are data only; loading them never dispatches an operation. */
export interface CodexUiDraftEntry { key: string; revision: number; value: unknown | null; }
export interface CodexUiDraftConflict { id: string; key: string; value: unknown | null; createdAt: string; }
export interface CodexUiDraftSnapshot { scope: string; entries: CodexUiDraftEntry[]; conflicts: CodexUiDraftConflict[]; deletedTaskIds?: string[]; }
export const codexUiDraftKinds = ['draft', 'pending', 'reading', 'interaction', 'submission', 'view', 'reply', 'launch', 'selection'] as const;
export type CodexUiDraftKind = typeof codexUiDraftKinds[number];
export function codexUiPublicInteractionFields(interaction: Pick<CodexInteraction, 'kind' | 'questions' | 'schema'>): ReadonlySet<string> | undefined {
  if (interaction.kind !== 'form') return new Set(interaction.questions?.filter(question => !question.isSecret).map(question => question.id) ?? []);
  const schema = interaction.schema, properties = schema?.properties;
  if (schema?.type !== 'object' || !properties || typeof properties !== 'object' || Array.isArray(properties)) return;
  const entries = Object.entries(properties);
  if (entries.some(([, field]) => !field || typeof field !== 'object' || !['string', 'boolean', 'number', 'integer', 'array'].includes(field.type))) return;
  return new Set(entries.filter(([, field]) => !field.secret).map(([id]) => id));
}
export function parseCodexUiDraftKey(key: string): [CodexUiDraftKind, string] {
  const parsed: unknown = JSON.parse(key);
  if (!Array.isArray(parsed) || parsed.length !== 2 || !codexUiDraftKinds.includes(parsed[0]) || typeof parsed[1] !== 'string' ||
    !parsed[1] || parsed[1].length > 8500 || key !== JSON.stringify(parsed)) throw new Error('草稿識別無效。');
  return parsed as [CodexUiDraftKind, string];
}
const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new Error('草稿內容無效。');
  return value as Record<string, unknown>;
};
const text = (value: unknown, max: number): string => { if (typeof value !== 'string' || value.length > max || value.includes('\0')) throw new Error('草稿文字超出範圍。'); return value; };
const integer = (value: unknown): number => { if (!Number.isSafeInteger(value) || Number(value) < 0) throw new Error('草稿版本無效。'); return Number(value); };
function operation(value: unknown, taskId: string, action: string) {
  const item = object(value);
  if (item.action !== action || item.resourceKey !== `codex:${taskId}`) throw new Error('草稿收據不屬於目前任務。');
  return { requestId: text(item.requestId, 200), resourceKey: `codex:${taskId}`, action, label: text(item.label, 1000),
    ...Object.fromEntries(['correlationId', 'scopeRevision', 'lockKey'].flatMap(key => item[key] === undefined ? [] : [[key, text(item[key], 2000)]])) };
}
/** Always clone an explicit allowlist: unknown properties and secret payloads never reach disk. */
export function sanitizeCodexUiDraftValue(key: string, value: unknown, allowedQuestionFields?: ReadonlySet<string>): unknown | null {
  const [kind, id] = parseCodexUiDraftKey(key);
  if (value === null) return null;
  if (kind === 'selection') { if (id !== 'current') throw new Error('選取草稿識別無效。'); return text(value, 160); }
  if (kind === 'view') { if (value !== 'execution' && value !== 'results') throw new Error('草稿分頁無效。'); return value; }
  const item = object(value);
  if (kind === 'draft') return { text: text(item.text, 32000), revision: integer(item.revision) };
  if (kind === 'reading') {
    if (typeof item.top !== 'number' || !Number.isFinite(item.top) || item.top < 0 || typeof item.follow !== 'boolean') throw new Error('閱讀位置無效。');
    return { top: item.top, follow: item.follow, ...(typeof item.anchorKey === 'string' && typeof item.anchorOffset === 'number' && Number.isFinite(item.anchorOffset) && Math.abs(item.anchorOffset) <= 1_000_000 ? { anchorKey: text(item.anchorKey, 8192), anchorOffset: item.anchorOffset } : {}) };
  }
  if (kind === 'launch') {
    const patch = object(item.patch), clean: Record<string, unknown> = {};
    for (const [name, max] of [['requirement', 32000], ['repositoryId', 200], ['model', 200], ['effort', 40]] as const) if (patch[name] !== undefined) clean[name] = text(patch[name], max);
    if (patch.isolated !== undefined) { if (typeof patch.isolated !== 'boolean') throw new Error('工作區設定無效。'); clean.isolated = patch.isolated; }
    if (patch.discussionIds !== undefined) { if (!Array.isArray(patch.discussionIds) || patch.discussionIds.length > 30) throw new Error('討論選取超出範圍。'); clean.discussionIds = patch.discussionIds.map(value => text(value, 200)); }
    return { patch: clean, ...(item.baseRevision === undefined ? {} : { baseRevision: integer(item.baseRevision) }) };
  }
  const taskId = text(item.taskId, 160);
  if (kind === 'pending') {
    const saved = operation(item, taskId, 'sendCodexMessage'); if (id !== saved.requestId) throw new Error('草稿送出識別無效。');
    return { ...saved, taskId, text: text(item.text, 32000), draftRevision: integer(item.draftRevision) };
  }
  if (kind === 'reply') {
    const discussionId = text(item.discussionId, 200); if (id !== JSON.stringify([taskId, discussionId])) throw new Error('討論草稿識別無效。');
    const pending = item.pending === undefined ? undefined : object(item.pending);
    return { taskId, discussionId, text: text(item.text, 50000), revision: integer(item.revision),
      ...(item.confirmedText === undefined ? {} : { confirmedText: text(item.confirmedText, 50000) }),
      ...(item.error === undefined ? {} : { error: text(item.error, 2000) }),
      ...(pending ? { pending: { ...operation(pending, taskId, 'codexCommand'), text: text(pending.text, 50000), draftRevision: integer(pending.draftRevision) } } : {}) };
  }
  const interactionId = text(item.interactionId, 8192);
  if (id !== JSON.stringify([taskId, interactionId])) throw new Error('回答草稿識別無效。');
  if (kind === 'submission') return { ...operation(item, taskId, 'answerCodex'), taskId, interactionId, draftRevision: integer(item.draftRevision) };
  const values = object(item.values);
  if (Object.keys(values).length > 100) throw new Error('回答欄位超出範圍。');
  return { taskId, interactionId, revision: integer(item.revision), values: Object.fromEntries(Object.entries(values)
    .filter(([field]) => !allowedQuestionFields || allowedQuestionFields.has(field))
    .map(([field, content]) => [text(field, 8192), text(content, 32000)])) };
}
