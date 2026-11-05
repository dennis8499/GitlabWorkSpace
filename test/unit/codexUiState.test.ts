import assert from 'node:assert/strict';
import test from 'node:test';
import { editCodexDraft, restoreCodexUi, settleCodexDrafts, type CodexUiState } from '../../src/webview/codexUiState';
import type { WorkspaceOperationState } from '../../src/workspace/operations';

const receipt = (patch: Partial<WorkspaceOperationState> = {}): WorkspaceOperationState => ({ requestId: 'op-1', resourceKey: 'codex:task-a',
  scopeRevision: 'root-1', action: 'sendCodexMessage', label: 'Send', status: 'succeeded', effect: 'applied', startedAt: 1, phase: 'Accepted', ...patch });
function submitted(): CodexUiState {
  const state = editCodexDraft(restoreCodexUi(), 'task-a', 'First draft');
  state.pending['op-1'] = { requestId: 'op-1', taskId: 'task-a', resourceKey: 'codex:task-a', action: 'sendCodexMessage', label: 'Send', text: 'First draft', draftRevision: 1 };
  return state;
}
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
