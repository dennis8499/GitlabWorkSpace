import type { RestorableOperation } from '../workspace/actionController';
import type { WorkspaceOperationState } from '../workspace/operations';
import { restoreCodexWorkflowUi, retainCodexWorkflowUi, type CodexWorkflowUi } from './codexWorkflowUi';
import type { CodexLaunchPatch, CodexTaskState } from '../codex/protocol';
import { restoreCodexDraftSync, type CodexDraftSyncMetadata } from './codexDraftSync';

export interface CodexDraft { text: string; revision: number; }
export interface CodexPendingDraft extends RestorableOperation { taskId: string; text: string; draftRevision: number; }
export interface CodexReadingPosition { top: number; follow: boolean; anchorKey?: string; anchorOffset?: number; }
export interface CodexInteractionDraft { taskId: string; interactionId: string; values: Record<string, string>; revision: number; }
export interface CodexInteractionSubmission extends RestorableOperation { taskId: string; interactionId: string; draftRevision: number; }
export const codexInteractionKey = (taskId: string, interactionId: string): string => JSON.stringify([taskId, interactionId]);
export function mergeCodexTasks(previous: readonly CodexTaskState[], incoming: readonly CodexTaskState[], removed: readonly string[] = [], replace = false): CodexTaskState[] {
  const existing = new Map(previous.map(task => [task.id, task]));
  const merged = new Map(replace ? [] : existing);
  for (const task of incoming) {
    const current = existing.get(task.id);
    merged.set(task.id, current?.revision !== undefined && (task.revision === undefined || current.revision > task.revision) ? current : task);
  }
  for (const id of removed) merged.delete(id);
  return [...merged.values()];
}
export interface CodexUiState {
  selectedTaskId?: string;
  drafts: Record<string, CodexDraft>;
  pending: Record<string, CodexPendingDraft>;
  reading?: Record<string, CodexReadingPosition>;
  interactionDrafts?: Record<string, CodexInteractionDraft>;
  interactionSubmissions?: Record<string, CodexInteractionSubmission>;
  views?: Record<string, 'execution' | 'results'>;
  workflow?: CodexWorkflowUi;
  launchDrafts?: Record<string, CodexLaunchPatch>;
  launchDraftBases?: Record<string, number>;
  draftSync?: CodexDraftSyncMetadata;
}
function restoreLaunchDrafts(value?: Record<string, CodexLaunchPatch>): Record<string, CodexLaunchPatch> {
  return Object.fromEntries(Object.entries(value ?? {}).slice(0, 100).flatMap(([id, patch]) => {
    if (id.length > 160 || !patch || typeof patch !== 'object' ||
      patch.requirement !== undefined && (typeof patch.requirement !== 'string' || patch.requirement.length > 32000) ||
      patch.repositoryId !== undefined && (typeof patch.repositoryId !== 'string' || patch.repositoryId.length > 200) ||
      patch.model !== undefined && (typeof patch.model !== 'string' || patch.model.length > 200) ||
      patch.effort !== undefined && (typeof patch.effort !== 'string' || patch.effort.length > 40) ||
      patch.isolated !== undefined && typeof patch.isolated !== 'boolean' ||
      patch.discussionIds !== undefined && (!Array.isArray(patch.discussionIds) || patch.discussionIds.length > 30 || patch.discussionIds.some(item => typeof item !== 'string' || item.length > 200))) return [];
    const clean = Object.fromEntries(Object.entries(patch).filter(([key]) => ['requirement', 'repositoryId', 'model', 'effort', 'isolated', 'discussionIds'].includes(key))) as CodexLaunchPatch;
    return [[id, clean]];
  }));
}
export function restoreCodexUi(value?: Partial<CodexUiState>): CodexUiState {
  const drafts = Object.fromEntries(Object.entries(value?.drafts ?? {}).filter(([id, draft]) =>
    id.length <= 160 && draft && typeof draft.text === 'string' && draft.text.length <= 32000 && Number.isSafeInteger(draft.revision) && draft.revision >= 0));
  const pending = Object.fromEntries(Object.entries(value?.pending ?? {}).filter(([id, item]) =>
    item && id === item.requestId && typeof item.taskId === 'string' && item.taskId.length <= 160 &&
    item.resourceKey === `codex:${item.taskId}` && item.action === 'sendCodexMessage' &&
    typeof item.text === 'string' && item.text.length <= 32000 && Number.isSafeInteger(item.draftRevision)));
  const reading = Object.fromEntries(Object.entries(value?.reading ?? {}).filter(([id, position]) =>
    id.length <= 160 && position && Number.isFinite(position.top) && position.top >= 0 && typeof position.follow === 'boolean')
    .map(([id, position]) => [id, { top: position.top, follow: position.follow,
      ...(typeof position.anchorKey === 'string' && position.anchorKey.length <= 8192 && Number.isFinite(position.anchorOffset)
        && Math.abs(position.anchorOffset!) <= 1_000_000 ? { anchorKey: position.anchorKey, anchorOffset: position.anchorOffset } : {}) }]));
  const interactionDrafts = Object.fromEntries(Object.entries(value?.interactionDrafts ?? {}).filter(([key, draft]) =>
    draft && typeof draft.taskId === 'string' && draft.taskId.length <= 160 && typeof draft.interactionId === 'string' && draft.interactionId.length <= 8192 &&
    key === codexInteractionKey(draft.taskId, draft.interactionId) && Number.isSafeInteger(draft.revision) && draft.revision >= 0 &&
    draft.values && typeof draft.values === 'object' && Object.entries(draft.values).length <= 100 &&
    Object.entries(draft.values).every(([field, text]) => field.length <= 8192 && typeof text === 'string' && text.length <= 32000)));
  const interactionSubmissions = Object.fromEntries(Object.entries(value?.interactionSubmissions ?? {}).filter(([key, item]) =>
    item && typeof item.taskId === 'string' && item.taskId.length <= 160 && typeof item.interactionId === 'string' && item.interactionId.length <= 8192 &&
    key === codexInteractionKey(item.taskId, item.interactionId) && typeof item.requestId === 'string' && item.requestId.length <= 160 &&
    item.resourceKey === `codex:${item.taskId}` && item.action === 'answerCodex' && Number.isSafeInteger(item.draftRevision)));
  const views = Object.fromEntries(Object.entries(value?.views ?? {}).filter(([id, view]) => id.length <= 160 && ['execution', 'results'].includes(view)));
  const launchDrafts = restoreLaunchDrafts(value?.launchDrafts);
  const launchDraftBases = Object.fromEntries(Object.entries(value?.launchDraftBases ?? {}).filter(([id, revision]) =>
    Object.hasOwn(launchDrafts, id) && Number.isSafeInteger(revision) && revision >= 0));
  return { selectedTaskId: typeof value?.selectedTaskId === 'string' ? value.selectedTaskId : undefined, drafts, pending, reading,
    interactionDrafts, interactionSubmissions, views, workflow: restoreCodexWorkflowUi(value?.workflow), launchDrafts, launchDraftBases, draftSync: restoreCodexDraftSync(value?.draftSync) };
}
export function retainCodexTasks(state: CodexUiState, ids: readonly string[]): CodexUiState {
  const keep = new Set(ids), filter = <T>(values: Record<string, T>): Record<string, T> => Object.fromEntries(Object.entries(values).filter(([id]) => keep.has(id)));
  return { ...state, selectedTaskId: state.selectedTaskId && keep.has(state.selectedTaskId) ? state.selectedTaskId : ids[0],
    drafts: filter(state.drafts), reading: filter(state.reading ?? {}),
    pending: Object.fromEntries(Object.entries(state.pending).filter(([, item]) => keep.has(item.taskId))),
    interactionDrafts: Object.fromEntries(Object.entries(state.interactionDrafts ?? {}).filter(([, item]) => keep.has(item.taskId))),
    interactionSubmissions: Object.fromEntries(Object.entries(state.interactionSubmissions ?? {}).filter(([, item]) => keep.has(item.taskId))),
    views: filter(state.views ?? {}), workflow: retainCodexWorkflowUi(state.workflow, ids) };
}
/** Secret values never enter this durable state; callers retain them only in memory. */
export function editCodexInteractionDraft(state: CodexUiState, taskId: string, interactionId: string, field: string, text: string, secret = false): CodexUiState {
  const key = codexInteractionKey(taskId, interactionId), previous = state.interactionDrafts?.[key];
  const values = { ...previous?.values };
  if (secret) delete values[field]; else values[field] = text;
  return { ...state, interactionDrafts: { ...state.interactionDrafts, [key]: { taskId, interactionId,
    values, revision: (previous?.revision ?? 0) + 1 } } };
}
export function retainCodexInteractions(state: CodexUiState, taskId: string, interactionIds: readonly string[]): CodexUiState {
  const keep = new Set(interactionIds), retain = <T extends { taskId: string; interactionId: string }>(values?: Record<string, T>) =>
    Object.fromEntries(Object.entries(values ?? {}).filter(([, item]) => item.taskId !== taskId || keep.has(item.interactionId)));
  return { ...state, interactionDrafts: retain(state.interactionDrafts), interactionSubmissions: retain(state.interactionSubmissions) };
}
export function codexInteractionSubmissionState(submission?: CodexInteractionSubmission, operation?: WorkspaceOperationState): 'idle' | 'pending' | 'accepted' | 'failed' | 'unknown' {
  if (!submission) return 'idle';
  if (!operation || operation.status === 'queued' || operation.status === 'running') return 'pending';
  if (operation.effect === 'unknown') return 'unknown';
  return operation.status === 'succeeded' ? 'accepted' : 'failed';
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
  for (const [key, submission] of Object.entries(state.interactionSubmissions ?? {})) {
    const operation = operations.find(item => item.requestId === submission.requestId), draft = next.interactionDrafts?.[key];
    if (operation?.status !== 'succeeded' || operation.effect !== 'applied' || !draft || draft.revision !== submission.draftRevision) continue;
    if (next === state) next = { ...state };
    next.interactionDrafts = { ...next.interactionDrafts }; delete next.interactionDrafts[key];
  }
  return next;
}
