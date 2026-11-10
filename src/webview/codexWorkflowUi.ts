import type { RestorableOperation } from '../workspace/actionController';
import type { WorkspaceOperationState } from '../workspace/operations';

export interface CodexReplyDraft {
  taskId: string; discussionId: string; text: string; revision: number;
  confirmedText?: string;
  error?: string;
  pending?: RestorableOperation & { text: string; draftRevision: number };
}
export interface CodexWorkflowUi { replies: Record<string, CodexReplyDraft>; }
export const codexReplyKey = (taskId: string, discussionId: string): string => JSON.stringify([taskId, discussionId]);
export function restoreCodexWorkflowUi(value?: Partial<CodexWorkflowUi>): CodexWorkflowUi {
  const replies: Record<string, CodexReplyDraft> = {};
  for (const [key, item] of Object.entries(value?.replies ?? {}).slice(0, 500)) {
    if (!item || typeof item.taskId !== 'string' || item.taskId.length > 160 || typeof item.discussionId !== 'string' || item.discussionId.length > 200 ||
      key !== codexReplyKey(item.taskId, item.discussionId) || typeof item.text !== 'string' || item.text.length > 50_000 || !Number.isSafeInteger(item.revision) || item.revision < 0) continue;
    const pending = item.pending;
    replies[key] = { taskId: item.taskId, discussionId: item.discussionId, text: item.text, revision: item.revision,
      ...(typeof item.confirmedText === 'string' && item.confirmedText.length <= 50_000 ? { confirmedText: item.confirmedText } : {}),
      ...(typeof item.error === 'string' && item.error.length <= 2000 ? { error: item.error } : {}),
      ...(pending && typeof pending.requestId === 'string' && pending.requestId.length <= 200 && pending.resourceKey === `codex:${item.taskId}` && pending.action === 'codexCommand' &&
        typeof pending.text === 'string' && pending.text.length <= 50_000 && Number.isSafeInteger(pending.draftRevision) && pending.draftRevision >= 0 ? { pending } : {}) };
  }
  return { replies };
}
export function retainCodexWorkflowUi(value: CodexWorkflowUi | undefined, ids: readonly string[]): CodexWorkflowUi {
  const keep = new Set(ids);
  return { replies: Object.fromEntries(Object.entries(value?.replies ?? {}).filter(([, item]) => keep.has(item.taskId))) };
}
export function editCodexReply(value: CodexWorkflowUi | undefined, taskId: string, discussionId: string, text: string): CodexWorkflowUi {
  const key = codexReplyKey(taskId, discussionId), previous = value?.replies[key];
  return { replies: { ...value?.replies, [key]: { ...previous, taskId, discussionId, text, error: undefined, revision: (previous?.revision ?? 0) + 1 } } };
}
/** Failure/unknown retain text; a receipt confirms only its own submitted body. */
export function settleCodexReplies(value: CodexWorkflowUi | undefined, operations: readonly WorkspaceOperationState[]): CodexWorkflowUi | undefined {
  if (!value) return value;
  let next = value;
  for (const [key, draft] of Object.entries(value.replies)) {
    const pending = draft.pending, operation = pending && operations.find(item => item.requestId === pending.requestId);
    if (!pending || !operation || ['queued', 'running'].includes(operation.status) || operation.effect === 'unknown') continue;
    if (next === value) next = { replies: { ...value.replies } };
    next.replies[key] = { ...draft, pending: undefined, error: operation.status === 'failed' ? operation.error ?? '發布失敗，草稿已保留。' : undefined,
      ...(operation.status === 'succeeded' && operation.effect === 'applied' ? { confirmedText: pending.text } : {}) };
  }
  return next;
}

/** A bounded, exact line comparison: common prefix/suffix are shared; the changed middle is explicit. */
export function wikiLineDiff(previous: string, current: string): Array<{ kind: 'same' | 'removed' | 'added'; text: string }> {
  const before = previous.split('\n'), after = current.split('\n');
  let prefix = 0, suffix = 0;
  while (prefix < before.length && prefix < after.length && before[prefix] === after[prefix]) prefix++;
  while (suffix < before.length - prefix && suffix < after.length - prefix && before[before.length - 1 - suffix] === after[after.length - 1 - suffix]) suffix++;
  return [...before.slice(0, prefix).map(text => ({ kind: 'same' as const, text })),
    ...before.slice(prefix, before.length - suffix).map(text => ({ kind: 'removed' as const, text })),
    ...after.slice(prefix, after.length - suffix).map(text => ({ kind: 'added' as const, text })),
    ...after.slice(after.length - suffix).map(text => ({ kind: 'same' as const, text }))];
}
