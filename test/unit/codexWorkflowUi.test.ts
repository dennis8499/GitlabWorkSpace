import assert from 'node:assert/strict';
import test from 'node:test';
import { codexReplyKey, editCodexReply, restoreCodexWorkflowUi, retainCodexWorkflowUi, settleCodexReplies, wikiLineDiff } from '../../src/webview/codexWorkflowUi';
import type { WorkspaceOperationState } from '../../src/workspace/operations';

const key = codexReplyKey('task-a', 'discussion-a');
const receipt = (patch: Partial<WorkspaceOperationState> = {}): WorkspaceOperationState => ({ requestId: 'reply-op', resourceKey: 'codex:task-a',
  scopeRevision: 'root-1', action: 'codexCommand', label: 'Publish reply', status: 'succeeded', effect: 'applied', startedAt: 1, phase: 'Confirmed', ...patch });
function pendingReply() {
  const state = editCodexReply(undefined, 'task-a', 'discussion-a', 'Submitted reply');
  state.replies[key].pending = { requestId: 'reply-op', resourceKey: 'codex:task-a', action: 'codexCommand', label: 'Publish reply', text: 'Submitted reply', draftRevision: 1 };
  return state;
}
test('MR reply drafts and publication correlation survive serialization with task isolation', () => {
  const state = editCodexReply(pendingReply(), 'task-b', 'discussion-a', 'Another task');
  const restored = restoreCodexWorkflowUi(JSON.parse(JSON.stringify(state)));
  assert.equal(restored.replies[key].pending?.requestId, 'reply-op');
  assert.equal(restored.replies[codexReplyKey('task-b', 'discussion-a')].text, 'Another task');
  assert.equal(retainCodexWorkflowUi(restored, ['task-b']).replies[key], undefined);
  const forged = pendingReply(); forged.replies[key].pending!.resourceKey = 'codex:another-task';
  assert.equal(restoreCodexWorkflowUi(forged).replies[key].pending, undefined);
});
test('MR reply publication is confirmed only by an applied receipt, retaining later edits and failures', () => {
  const pending = pendingReply();
  for (const patch of [{ status: 'running' }, { status: 'failed', effect: 'unknown' }] as Partial<WorkspaceOperationState>[]) {
    const next = settleCodexReplies(pending, [receipt(patch)])!;
    assert.ok(next.replies[key].pending); assert.equal(next.replies[key].confirmedText, undefined);
  }
  const failed = settleCodexReplies(pending, [receipt({ status: 'failed', effect: 'none', error: 'Permission denied' })])!;
  assert.equal(failed.replies[key].text, 'Submitted reply'); assert.equal(failed.replies[key].pending, undefined);
  assert.equal(failed.replies[key].error, 'Permission denied'); assert.equal(failed.replies[key].confirmedText, undefined);
  const edited = editCodexReply(pending, 'task-a', 'discussion-a', 'Later draft');
  const confirmed = settleCodexReplies(edited, [receipt()])!;
  assert.equal(confirmed.replies[key].text, 'Later draft'); assert.equal(confirmed.replies[key].confirmedText, 'Submitted reply');
  assert.equal(settleCodexReplies(confirmed, [receipt()]), confirmed);
});
test('Wiki source comparison preserves unchanged boundaries and exact added and removed lines', () => {
  assert.deepEqual(wikiLineDiff('heading\nold\nfooter', 'heading\nnew\nfooter'), [
    { kind: 'same', text: 'heading' }, { kind: 'removed', text: 'old' }, { kind: 'added', text: 'new' }, { kind: 'same', text: 'footer' }
  ]);
  assert.deepEqual(wikiLineDiff('same', 'same'), [{ kind: 'same', text: 'same' }]);
  const before = 'a\nb\nc', after = 'a\nx\ny\nc', diff = wikiLineDiff(before, after);
  assert.equal(diff.filter(row => row.kind !== 'added').map(row => row.text).join('\n'), before);
  assert.equal(diff.filter(row => row.kind !== 'removed').map(row => row.text).join('\n'), after);
});
