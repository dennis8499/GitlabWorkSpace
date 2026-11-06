import type { RestorableOperation } from '../workspace/actionController';
import type { WorkspaceOperationState } from '../workspace/operations';

export interface CodexDraft { text: string; revision: number; }
export interface CodexPendingDraft extends RestorableOperation { taskId: string; text: string; draftRevision: number; }
export interface CodexUiState {
  selectedTaskId?: string;
  drafts: Record<string, CodexDraft>;
  pending: Record<string, CodexPendingDraft>;
  reading?: Record<string, { top: number; follow: boolean }>;
}
export function restoreCodexUi(value?: Partial<CodexUiState>): CodexUiState {
  const drafts = Object.fromEntries(Object.entries(value?.drafts ?? {}).filter(([id, draft]) =>
    id.length <= 160 && draft && typeof draft.text === 'string' && draft.text.length <= 32000 && Number.isSafeInteger(draft.revision) && draft.revision >= 0));
  const pending = Object.fromEntries(Object.entries(value?.pending ?? {}).filter(([id, item]) =>
    item && id === item.requestId && typeof item.taskId === 'string' && item.taskId.length <= 160 &&
    item.resourceKey === `codex:${item.taskId}` && item.action === 'sendCodexMessage' &&
    typeof item.text === 'string' && item.text.length <= 32000 && Number.isSafeInteger(item.draftRevision)));
  const reading = Object.fromEntries(Object.entries(value?.reading ?? {}).filter(([id, position]) =>
    id.length <= 160 && position && Number.isFinite(position.top) && position.top >= 0 && typeof position.follow === 'boolean'));
  return { selectedTaskId: typeof value?.selectedTaskId === 'string' ? value.selectedTaskId : undefined, drafts, pending, reading };
}
export function retainCodexTasks(state: CodexUiState, ids: readonly string[]): CodexUiState {
  const keep = new Set(ids), filter = <T>(values: Record<string, T>): Record<string, T> => Object.fromEntries(Object.entries(values).filter(([id]) => keep.has(id)));
  return { ...state, selectedTaskId: state.selectedTaskId && keep.has(state.selectedTaskId) ? state.selectedTaskId : ids[0],
    drafts: filter(state.drafts), reading: filter(state.reading ?? {}),
    pending: Object.fromEntries(Object.entries(state.pending).filter(([, item]) => keep.has(item.taskId))) };
}
export function editCodexDraft(state: CodexUiState, taskId: string, text: string): CodexUiState {
  return { ...state, drafts: { ...state.drafts, [taskId]: { text, revision: (state.drafts[taskId]?.revision ?? 0) + 1 } } };
}
/** A receipt clears only the submitted revision; late/duplicate receipts never erase later edits. */
export function settleCodexDrafts(state: CodexUiState, operations: readonly WorkspaceOperationState[]): CodexUiState {
  let next = state;
  for (const [id, pending] of Object.entries(state.pending)) {
    const operation = operations.find(item => item.requestId === id);
    if (!operation || operation.status === 'queued' || operation.status === 'running' || operation.effect === 'unknown') continue;
    if (next === state) next = { ...state, drafts: { ...state.drafts }, pending: { ...state.pending } };
    const draft = next.drafts[pending.taskId];
    if (operation.status === 'succeeded' && operation.effect === 'applied' && draft?.revision === pending.draftRevision && draft.text === pending.text) {
      delete next.drafts[pending.taskId];
    }
    delete next.pending[id];
  }
  return next;
}
