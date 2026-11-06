import assert from 'node:assert/strict';
import test from 'node:test';
import { mergeCodexTranscript, projectCodexItem } from '../../src/codex/transcript';
import type { CodexOutputItem } from '../../src/codex/protocol';
import { retainCodexTasks, restoreCodexUi } from '../../src/webview/codexUiState';

const entry = (turnId: string, id: string, text: string, final = false): CodexOutputItem => ({ threadId: 'thread', turnId, id, kind: 'agent', text, final });
test('history pages share item identity with live output, including reused IDs in different turns', () => {
  let items = mergeCodexTranscript([], [entry('turn-b', 'reply', 'In flight')]);
  items = mergeCodexTranscript(items, [entry('turn-a', 'reply', 'Earlier', true), entry('turn-b', 'reply', 'Older snapshot')], true);
  assert.deepEqual(items.map(item => item.text), ['Earlier', 'In flight']);
  items = mergeCodexTranscript(items, [entry('turn-b', 'reply', 'Complete answer', true)], true);
  items = mergeCodexTranscript(items, [entry('turn-0', 'reply', 'Oldest', true)], true);
  items = mergeCodexTranscript(items, [entry('turn-a', 'reply', 'Earlier', true), entry('turn-b', 'reply', 'Complete answer', true)], true);
  assert.deepEqual(items.map(item => item.text), ['Oldest', 'Earlier', 'Complete answer']);
});
test('one command item contains the command, streamed output and exit status without a second output block', () => {
  const item = projectCodexItem('thread', 'turn', { id: 'command', type: 'commandExecution', command: 'git status', aggregatedOutput: 'clean', status: 'completed', exitCode: 0 }, true)!;
  assert.equal(item.command, 'git status'); assert.equal(item.text, 'clean'); assert.equal(item.exitCode, 0);
  const merged = mergeCodexTranscript([{ ...item, text: 'cle', final: false }], [item], true);
  assert.equal(merged.length, 1); assert.equal(merged[0].text, 'clean');
});
test('deleted task drafts, pending operations and reading positions are removed together', () => {
  const restored = restoreCodexUi({ selectedTaskId: 'deleted', drafts: { deleted: { text: 'draft', revision: 1 } },
    reading: { deleted: { top: 200, follow: false }, retained: { top: 40, follow: false } } });
  const next = retainCodexTasks(restored, ['retained']);
  assert.equal(next.selectedTaskId, 'retained'); assert.deepEqual(next.drafts, {});
  assert.deepEqual(next.reading, { retained: { top: 40, follow: false } });
});
