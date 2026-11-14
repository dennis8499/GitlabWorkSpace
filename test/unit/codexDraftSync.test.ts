import assert from 'node:assert/strict';
import test from 'node:test';
import { CodexDraftSync } from '../../src/webview/codexDraftSync';
import { editCodexDraft, restoreCodexUi } from '../../src/webview/codexUiState';
import type { CodexUiDraftEntry, CodexUiDraftSnapshot } from '../../src/codex/uiDraftProtocol';
const key = (id: string) => JSON.stringify(['draft', id]);
const entry = (id: string, revision: number, text: string): CodexUiDraftEntry => ({ key: key(id), revision, value: { text, revision: 1 } });
const snapshot = (entries: CodexUiDraftEntry[] = [], patch: Partial<CodexUiDraftSnapshot> = {}): CodexUiDraftSnapshot => ({ scope: 'account-root-a', entries, conflicts: [], ...patch });

test('delayed hydration preserves fresh typing and uses its original CAS base', () => {
  let ui = restoreCodexUi(); const sync = new CodexDraftSync(ui);
  const edited = editCodexDraft(ui, 'a', 'Latest local typing'); sync.note(ui, edited); ui = edited;
  ui = sync.load(snapshot([entry('a', 4, 'Other window'), entry('b', 2, 'Saved other task')]), ui);
  assert.equal(ui.drafts.a.text, 'Latest local typing'); assert.equal(ui.drafts.b.text, 'Saved other task');
  const pending = sync.next(ui)!; assert.equal(pending.updates.length, 1); assert.equal(pending.updates[0].revision, 0);
});

test('a started Issue selection survives delayed first hydration and a later manual selection stays selected', () => {
  let ui = restoreCodexUi(); const sync = new CodexDraftSync(ui), selection = JSON.stringify(['selection', 'current']);
  const started = { ...ui, selectedTaskId: 'new-issue' }; sync.note(ui, started); ui = started;
  const oldGroup = snapshot([{ key: selection, revision: 3, value: 'old-group' }]);
  ui = sync.load(oldGroup, ui);
  assert.equal(ui.selectedTaskId, 'new-issue', 'late hydration must not undo an explicit task-start selection');
  const selected = { ...ui, selectedTaskId: 'other-task' }; sync.note(ui, selected); ui = selected;
  ui = sync.load(oldGroup, ui);
  assert.equal(ui.selectedTaskId, 'other-task', 'a later manual choice takes precedence over the started task');
});

test('a started Issue with restored sync metadata cannot override a later manual choice when its save is acknowledged', () => {
  const selection = JSON.stringify(['selection', 'current']), oldGroup = { key: selection, revision: 3, value: 'old-group' };
  let ui = restoreCodexUi({ selectedTaskId: 'old-group', draftSync: { scope: 'account-root-a', bases: [oldGroup] } });
  const sync = new CodexDraftSync(ui), started = { ...ui, selectedTaskId: 'new-issue' }; sync.note(ui, started); ui = started;
  ui = sync.load(snapshot([oldGroup]), ui);
  assert.equal(ui.selectedTaskId, 'new-issue');
  const savingStarted = sync.next(ui)!;
  assert.deepEqual(savingStarted.updates, [{ key: selection, revision: 3, value: 'new-issue' }]);
  const selected = { ...ui, selectedTaskId: 'other-task' }; sync.note(ui, selected); ui = selected;
  ui = sync.accepted(snapshot([{ key: selection, revision: 4, value: 'new-issue' }]), ui);
  assert.equal(ui.selectedTaskId, 'other-task', 'acknowledging the started task must preserve a newer manual choice');
  const savingManual = sync.next(ui)!;
  assert.deepEqual(savingManual.updates, [{ key: selection, revision: 4, value: 'other-task' }]);
  ui = sync.accepted(snapshot([{ key: selection, revision: 5, value: 'other-task' }]), ui);
  assert.equal(ui.selectedTaskId, 'other-task'); assert.equal(sync.next(ui), undefined);
});

test('automatic owner selection rebases only its system preference while fresh text retains the original CAS', () => {
  const selection = JSON.stringify(['selection', 'current']);
  let ui = restoreCodexUi({ selectedTaskId: 'old-owner', draftSync: { scope: 'account-root-a',
    bases: [{ key: selection, revision: 2, value: 'old-owner' }, entry('a', 2, 'Cached text')] }, drafts: { a: { text: 'Cached text', revision: 1 } } });
  const sync = new CodexDraftSync(ui), edited = editCodexDraft(ui, 'a', 'Fresh local text'); sync.note(ui, edited); ui = edited;
  ui = sync.load(snapshot([{ key: selection, revision: 4, value: 'old-owner' }, entry('a', 4, 'Other window text')]), ui);
  ui = sync.automaticSelection('new-owner', ui)!;
  const updates = sync.next(ui)!.updates;
  assert.deepEqual(updates.find(item => item.key === selection), { key: selection, revision: 4, value: 'new-owner' });
  assert.equal(updates.find(item => item.key === key('a'))!.revision, 2);
  assert.equal(ui.drafts.a.text, 'Fresh local text');
});

test('a manual selection made before hydration retains its original CAS and is not silently rebased', () => {
  const selection = JSON.stringify(['selection', 'current']);
  let ui = restoreCodexUi({ selectedTaskId: 'old-owner', draftSync: { scope: 'account-root-a',
    bases: [{ key: selection, revision: 2, value: 'old-owner' }] } });
  const sync = new CodexDraftSync(ui), manual = { ...ui, selectedTaskId: 'manual-choice' }; sync.note(ui, manual); ui = manual;
  ui = sync.load(snapshot([{ key: selection, revision: 4, value: 'other-window-choice' }]), ui);
  assert.deepEqual(sync.next(ui)!.updates, [{ key: selection, revision: 2, value: 'manual-choice' }]);
});

test('automatic owner selection preserves existing conflicts and in-flight selection writes without retrying', () => {
  const selection = JSON.stringify(['selection', 'current']), remote = { key: selection, revision: 4, value: 'old-owner' };
  let ui = restoreCodexUi(); const sync = new CodexDraftSync(ui);
  const conflict = { id: 'selection-conflict', key: selection, value: 'manual-choice', createdAt: '2026-11-14T11:03:19.251Z' };
  ui = sync.load(snapshot([remote], { conflicts: [conflict] }), ui);
  const metadata = sync.metadata();
  assert.equal(sync.automaticSelection('new-owner', ui), undefined);
  assert.deepEqual(sync.conflicts, [conflict]); assert.deepEqual(sync.metadata(), metadata); assert.equal(sync.next(ui), undefined);
  const clean = new CodexDraftSync(restoreCodexUi()); ui = clean.load(snapshot([remote]), restoreCodexUi());
  ui = clean.automaticSelection('first-owner', ui)!;
  const sending = clean.next(ui)!;
  assert.equal(clean.automaticSelection('second-owner', ui), undefined);
  assert.equal(clean.next(ui), undefined, 'an in-flight selection must not be sent twice');
  const rejected = { ...conflict, value: 'first-owner' };
  ui = clean.accepted(snapshot([remote], { conflicts: [rejected] }), ui);
  assert.equal(clean.automaticSelection('second-owner', ui), undefined);
  assert.equal(clean.next(ui), undefined, 'a genuine intervening write requires explicit conflict handling');
  assert.deepEqual(sending.updates, [{ key: selection, revision: 4, value: 'first-owner' }]);
});

test('a held normal acknowledgement cannot erase a later urgent draft or resend it automatically', () => {
  let ui = restoreCodexUi(); const sync = new CodexDraftSync(ui); ui = sync.load(snapshot(), ui);
  let edited = editCodexDraft(ui, 'a', 'First'); sync.note(ui, edited); ui = edited; const first = sync.next(ui)!;
  edited = editCodexDraft(ui, 'a', 'Final keystroke'); sync.note(ui, edited); ui = edited;
  const urgent = sync.urgent(ui)!; assert.equal((urgent.updates[0].value as { text: string }).text, 'Final keystroke'); assert.equal(sync.urgent(ui), undefined);
  ui = sync.accepted(snapshot([{ ...first.updates[0], revision: 1 }]), ui); assert.equal(ui.drafts.a.text, 'Final keystroke');
  const conflict = { id: 'conflict-final', key: key('a'), value: urgent.updates[0].value, createdAt: '2026-11-10T00:00:00Z' };
  ui = sync.load(snapshot([{ ...first.updates[0], revision: 1 }], { conflicts: [conflict] }), ui);
  assert.equal(sync.next(ui), undefined); assert.equal(ui.drafts.a.text, 'Final keystroke');
  const reopened = new CodexDraftSync(restoreCodexUi()), recovered = reopened.load(snapshot([{ ...first.updates[0], revision: 1 }], { conflicts: [conflict] }), restoreCodexUi());
  assert.equal(recovered.drafts.a.text, 'First'); assert.deepEqual(reopened.candidate(conflict, recovered), urgent.updates[0].value, 'the final input remains recoverable as the retained conflict');
});

test('stored conflict resolution sends a no-op CAS and accepts an unchanged revision', () => {
  let ui = editCodexDraft(restoreCodexUi(), 'a', 'Local'); const sync = new CodexDraftSync(ui), remote = entry('a', 4, 'Stored');
  const conflict = { id: 'conflict-1', key: key('a'), value: ui.drafts.a, createdAt: '2026-11-10T00:00:00Z' };
  ui = sync.load(snapshot([remote], { conflicts: [conflict] }), ui); ui = sync.resolve(conflict.id, 'stored', ui);
  const request = sync.next(ui)!; assert.equal(request.updates[0].revision, 4); assert.deepEqual(request.updates[0].value, remote.value); assert.deepEqual(request.resolveConflictIds, [conflict.id]);
  ui = sync.accepted(snapshot([remote]), ui); assert.equal(ui.drafts.a.text, 'Stored'); assert.equal(sync.next(ui), undefined);
});

test('more than one hundred conflict copies resolve in bounded nonempty CAS batches', () => {
  let ui = editCodexDraft(restoreCodexUi(), 'a', 'Local'); const sync = new CodexDraftSync(ui), remote = entry('a', 4, 'Stored');
  const conflicts = Array.from({ length: 101 }, (_, index) => ({ id: `conflict-${index}`, key: key('a'), value: ui.drafts.a, createdAt: '2026-11-10T00:00:00Z' }));
  ui = sync.load(snapshot([remote], { conflicts }), ui); ui = sync.resolve(conflicts[0].id, 'stored', ui);
  const first = sync.next(ui)!; assert.equal(first.updates.length, 1); assert.equal(first.resolveConflictIds?.length, 100);
  ui = sync.accepted(snapshot([remote], { conflicts: conflicts.slice(100) }), ui);
  const second = sync.next(ui)!; assert.equal(second.updates.length, 1); assert.equal(second.resolveConflictIds?.length, 1);
  ui = sync.accepted(snapshot([remote]), ui); assert.equal(sync.next(ui), undefined);
});

test('missing entries preserve dirty drafts while authoritative deletion removes only the named task', () => {
  let ui = restoreCodexUi(); const sync = new CodexDraftSync(ui); ui = sync.load(snapshot([entry('a', 1, 'Saved'), entry('b', 2, 'Keep')]), ui);
  const edited = editCodexDraft(ui, 'a', 'Dirty local'); sync.note(ui, edited); ui = edited;
  ui = sync.load(snapshot([entry('b', 2, 'Keep')]), ui); assert.equal(ui.drafts.a.text, 'Dirty local');
  sync.next(ui); ui = sync.accepted(snapshot([entry('a', 1, 'Saved'), entry('b', 2, 'Keep')], { deletedTaskIds: ['a'] }), ui);
  assert.equal(ui.drafts.a, undefined); assert.equal(ui.drafts.b.text, 'Keep'); assert.equal(sync.next(ui), undefined);
});

test('an absent tombstone is an acknowledged no-op rather than an infinite resend', () => {
  let ui = restoreCodexUi(); const sync = new CodexDraftSync(ui); ui = sync.load(snapshot([entry('a', 1, 'Saved')]), ui);
  const emptied = { ...ui, drafts: {} }; sync.note(ui, emptied); ui = emptied;
  const request = sync.next(ui)!; assert.equal(request.updates[0].value, null);
  ui = sync.accepted(snapshot(), ui); assert.equal(sync.next(ui), undefined); assert.equal(ui.drafts.a, undefined);
});

test('large migrations use at most one hundred entries per acknowledgement', () => {
  let ui = restoreCodexUi(); for (let index = 0; index < 101; index++) ui = editCodexDraft(ui, `task-${index}`, 'Saved input');
  const sync = new CodexDraftSync(ui); ui = sync.load(snapshot(), ui);
  const first = sync.next(ui)!; assert.equal(first.updates.length, 100);
  const firstSaved = first.updates.map(item => ({ ...item, revision: 1 })); ui = sync.accepted(snapshot(firstSaved), ui);
  const second = sync.next(ui)!; assert.equal(second.updates.length, 1);
  ui = sync.accepted(snapshot([...firstSaved, { ...second.updates[0], revision: 1 }]), ui); assert.equal(sync.next(ui), undefined);
});

test('a different root does not inherit old drafts but preserves input typed after mounting', () => {
  let ui = restoreCodexUi(); const original = new CodexDraftSync(ui); ui = original.load(snapshot([entry('old-task', 1, 'Old root content')]), ui);
  const sync = new CodexDraftSync(ui), edited = editCodexDraft(ui, 'new-task', 'Current input'); sync.note(ui, edited);
  const next = sync.load(snapshot([], { scope: 'account-root-b' }), edited);
  assert.equal(next.drafts['old-task'], undefined); assert.equal(next.drafts['new-task'].text, 'Current input');
  assert.deepEqual(sync.next(next)?.updates.map(item => item.key), [key('new-task')]);
});
test('deleting the old selection preserves a newer task selection with a fresh CAS base', () => {
  let ui = restoreCodexUi(); const sync = new CodexDraftSync(ui), selection = JSON.stringify(['selection', 'current']);
  ui = sync.load(snapshot([{ key: selection, revision: 3, value: 'old-task' }]), ui);
  const edited = { ...ui, selectedTaskId: 'new-task' }; sync.note(ui, edited); ui = edited; sync.next(ui);
  ui = sync.accepted(snapshot([], { deletedTaskIds: ['old-task'] }), ui);
  assert.equal(ui.selectedTaskId, 'new-task'); assert.deepEqual(sync.next(ui)?.updates, [{ key: selection, revision: 0, value: 'new-task' }]);
});
