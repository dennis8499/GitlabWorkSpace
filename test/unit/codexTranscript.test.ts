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

test('history interleaves new items at shared anchors, deduplicates incoming identities and preserves untouched items', () => {
  const a = entry('turn', 'a', 'A'), c = entry('turn', 'c', 'C'), e = entry('turn', 'e', 'E');
  const current = [a, c, e];
  const result = mergeCodexTranscript(current, [entry('turn', 'b', 'B'), { ...c, text: 'stale C' },
    entry('turn', 'd', 'D'), { ...e, text: 'Final E', final: true }, entry('turn', 'f', 'F'), entry('turn', 'f', 'Final F', true)], true);
  assert.deepEqual(result.map(item => item.text), ['A', 'B', 'C', 'D', 'Final E', 'Final F']);
  assert.equal(result[0], a); assert.equal(result[2], c);
  assert.deepEqual(current.map(item => item.text), ['A', 'C', 'E']);
});

test('ten thousand transcript items retain their identity while the latest batch changes', () => {
  const current = Array.from({ length: 10_000 }, (_, index) => entry('turn', String(index), String(index)));
  const result = mergeCodexTranscript(current, current.slice(-100).map(item => ({ ...item, text: item.text + ' updated' })));
  assert.equal(result.length, 10_000); assert.equal(result[0], current[0]); assert.equal(result[9899], current[9899]);
  assert.notEqual(result[9900], current[9900]); assert.equal(result[9999].text, '9999 updated');
});

test('reading anchors survive restoration while malformed anchors retain their safe pixel fallback', () => {
  const ui = restoreCodexUi({ reading: { anchored: { top: 1200, follow: false, anchorKey: 'thread/turn/item', anchorOffset: 12 },
    legacy: { top: 400, follow: false }, malformed: { top: 300, follow: false, anchorKey: 'a'.repeat(8193), anchorOffset: 5 } } });
  assert.deepEqual(ui.reading!.anchored, { top: 1200, follow: false, anchorKey: 'thread/turn/item', anchorOffset: 12 });
  assert.deepEqual(ui.reading!.legacy, { top: 400, follow: false });
  assert.deepEqual(ui.reading!.malformed, { top: 300, follow: false });
});
