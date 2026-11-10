import assert from 'node:assert/strict';
import test from 'node:test';
import { codexInteractionKey, codexInteractionSubmissionState, editCodexDraft, editCodexInteractionDraft, mergeCodexTasks, restoreCodexUi, retainCodexInteractions, retainCodexTasks, settleCodexDrafts, type CodexUiState } from '../../src/webview/codexUiState';
import type { WorkspaceOperationState } from '../../src/workspace/operations';
import type { CodexTaskState } from '../../src/codex/protocol';

const receipt = (patch: Partial<WorkspaceOperationState> = {}): WorkspaceOperationState => ({ requestId: 'op-1', resourceKey: 'codex:task-a',
  scopeRevision: 'root-1', action: 'sendCodexMessage', label: 'Send', status: 'succeeded', effect: 'applied', startedAt: 1, phase: 'Accepted', ...patch });
function submitted(): CodexUiState {
  const state = editCodexDraft(restoreCodexUi(), 'task-a', 'First draft');
  state.pending['op-1'] = { requestId: 'op-1', taskId: 'task-a', resourceKey: 'codex:task-a', action: 'sendCodexMessage', label: 'Send', text: 'First draft', draftRevision: 1 };
  return state;
}
test('only a confirmed matching answer revision clears a question draft', () => {
  let state = editCodexInteractionDraft(restoreCodexUi(), 'task-a', 'old-question', 'public', 'Original answer');
  const key = codexInteractionKey('task-a', 'old-question');
  state.interactionSubmissions = { [key]: { requestId: 'answer-1', taskId: 'task-a', interactionId: 'old-question', draftRevision: 1,
    action: 'answerCodex', resourceKey: 'codex:task-a', label: 'Answer' } };
  const accepted = receipt({ requestId: 'answer-1', action: 'answerCodex' });
  assert.equal(settleCodexDrafts(state, [accepted]).interactionDrafts?.[key], undefined);
  for (const patch of [{ status: 'running' }, { status: 'failed', effect: 'none' }, { effect: 'unknown' }] as Partial<WorkspaceOperationState>[]) {
    assert.equal(settleCodexDrafts(state, [{ ...accepted, ...patch }]).interactionDrafts?.[key]?.values.public, 'Original answer');
  }
  state = editCodexInteractionDraft(state, 'task-a', 'old-question', 'public', 'Newer answer');
  assert.equal(settleCodexDrafts(state, [accepted]).interactionDrafts?.[key]?.values.public, 'Newer answer');
});
test('task drafts and pending correlation survive serialization independently', () => {
  const state = editCodexDraft(submitted(), 'task-b', 'Second task draft');
  state.selectedTaskId = 'task-b';
  const restored = restoreCodexUi(JSON.parse(JSON.stringify(state)));
  assert.equal(restored.drafts['task-a'].text, 'First draft'); assert.equal(restored.drafts['task-b'].text, 'Second task draft');
  assert.equal(restored.pending['op-1'].taskId, 'task-a'); assert.equal(restored.selectedTaskId, 'task-b');
});
test('only authoritative acceptance clears the submitted revision', () => {
  for (const patch of [{ status: 'running' }, { status: 'failed', effect: 'none' }, { status: 'cancelled', effect: 'none' }, { status: 'failed', effect: 'unknown' }, { effect: 'none' }] as Partial<WorkspaceOperationState>[]) {
    assert.equal(settleCodexDrafts(submitted(), [receipt(patch)]).drafts['task-a'].text, 'First draft');
  }
  const next = settleCodexDrafts(submitted(), [receipt()]); assert.equal(next.drafts['task-a'], undefined);
  const edited = editCodexDraft(next, 'task-a', 'Later draft'); assert.equal(settleCodexDrafts(edited, [receipt()]), edited);
});
test('late acceptance never clears newer edits, including an edit back to the same text', () => {
  let state = editCodexDraft(submitted(), 'task-a', 'Changed'); state = editCodexDraft(state, 'task-a', 'First draft');
  assert.equal(settleCodexDrafts(state, [receipt()]).drafts['task-a'].text, 'First draft');
});
test('interaction drafts survive serialization per task and secret values never enter persisted state', () => {
  let state = editCodexInteractionDraft(restoreCodexUi(), 'task-a', 'question-1', 'scope', 'Local only');
  state = editCodexInteractionDraft(state, 'task-b', 'question-1', 'scope', 'Other task');
  state = editCodexInteractionDraft(state, 'task-a', 'question-1', 'password', 'never-store-this', true);
  const serialized = JSON.stringify(state);
  assert.ok(!serialized.includes('never-store-this'));
  const restored = restoreCodexUi(JSON.parse(serialized));
  assert.equal(restored.interactionDrafts?.[codexInteractionKey('task-a', 'question-1')].values.scope, 'Local only');
  assert.equal(restored.interactionDrafts?.[codexInteractionKey('task-b', 'question-1')].values.scope, 'Other task');
});
test('interaction receipts distinguish retryable failure from unknown and preserve task-scoped drafts', () => {
  const submission = { requestId: 'answer-1', taskId: 'task-a', interactionId: 'question-1', resourceKey: 'codex:task-a', action: 'answerCodex', label: 'Answer', draftRevision: 1 };
  const operation = receipt({ requestId: 'answer-1', action: 'answerCodex' });
  assert.equal(codexInteractionSubmissionState(submission), 'pending');
  assert.equal(codexInteractionSubmissionState(submission, { ...operation, status: 'failed', effect: 'none' }), 'failed');
  assert.equal(codexInteractionSubmissionState(submission, { ...operation, status: 'failed', effect: 'unknown' }), 'unknown');
  assert.equal(codexInteractionSubmissionState(submission, operation), 'accepted');
  let state = editCodexInteractionDraft(restoreCodexUi(), 'task-a', 'question-1', 'scope', 'Answer');
  state.interactionSubmissions = { [codexInteractionKey('task-a', 'question-1')]: submission };
  state = editCodexInteractionDraft(state, 'task-b', 'question-2', 'scope', 'Retained');
  const retained = retainCodexInteractions(restoreCodexUi(JSON.parse(JSON.stringify(state))), 'task-a', []);
  assert.equal(retained.interactionDrafts?.[codexInteractionKey('task-a', 'question-1')], undefined);
  assert.equal(retained.interactionSubmissions?.[codexInteractionKey('task-a', 'question-1')], undefined);
  assert.equal(retained.interactionDrafts?.[codexInteractionKey('task-b', 'question-2')].values.scope, 'Retained');
  assert.equal(Object.keys(retainCodexTasks(retained, []).interactionDrafts ?? {}).length, 0);
});
test('task deltas preserve unrelated tasks and ignore old task revisions before full resync', () => {
  const task = (id: string, revision: number): CodexTaskState => ({ id, revision, title: id, root: 'C:/repo', status: 'running', createdAt: '2026-11-10', updatedAt: '2026-11-10' });
  const previous = [task('a', 3), task('b', 1)];
  const next = mergeCodexTasks(previous, [{ ...task('a', 2), status: 'completed' }, task('c', 1)]);
  assert.equal(next.length, 3); assert.equal(next.find(item => item.id === 'a')?.status, 'running');
  const deleted = mergeCodexTasks(next, [], ['b']); assert.deepEqual(deleted.map(item => item.id), ['a', 'c']);
  assert.deepEqual(mergeCodexTasks(deleted, [task('a', 2)], [], true).map(item => [item.id, item.revision]), [['a', 3]]);
});
test('launch edits remain independent of task retention and restore only bounded editable fields', () => {
  const state = restoreCodexUi({ launchDrafts: { draft: { requirement: 'Unsaved last keystroke', model: 'model', isolated: true,
    ...({ untrustedField: 'drop' } as object) }, malformed: { requirement: 'x'.repeat(32001) } } });
  assert.equal(retainCodexTasks(state, []).launchDrafts?.draft.requirement, 'Unsaved last keystroke');
  assert.equal(state.launchDrafts?.malformed, undefined);
  assert.equal('untrustedField' in state.launchDrafts!.draft, false);
});
test('launch draft base revisions survive recreation with their patch and discard orphan or invalid metadata', () => {
  const state = restoreCodexUi({ launchDrafts: { local: { requirement: 'Crash before autosave' }, invalid: { requirement: 'Retained text' } },
    launchDraftBases: { local: 4, invalid: -1, orphan: 99 } });
  const restored = restoreCodexUi(JSON.parse(JSON.stringify(retainCodexTasks(state, []))));
  assert.equal(restored.launchDrafts?.local.requirement, 'Crash before autosave');
  assert.deepEqual(restored.launchDraftBases, { local: 4 });
  assert.equal(restoreCodexUi({ launchDraftBases: { orphan: 1 } }).launchDraftBases?.orphan, undefined);
});
