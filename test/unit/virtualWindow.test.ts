import assert from 'node:assert/strict';
import test from 'node:test';
import { restoreScrollAnchor, virtualWindow } from '../../src/webview/virtualWindow';

test('keeps lists of 200 or fewer rows mounted and windows larger lists with ten-row overscan', () => {
  const offsets = Array.from({ length: 205 }, (_, index) => index * 40);
  assert.deepEqual(virtualWindow(200, offsets, 4_000, 240), { start: 0, end: 200 });
  assert.deepEqual(virtualWindow(1_000, Array.from({ length: 1_001 }, (_, index) => index * 40), 4_000, 240), { start: 89, end: 116 });
  assert.deepEqual(virtualWindow(1_000, Array.from({ length: 1_001 }, (_, index) => index * 40), 0, 240), { start: 0, end: 16 });
  assert.deepEqual(virtualWindow(1_000, Array.from({ length: 1_001 }, (_, index) => index * 40), 50_000, 240), { start: 990, end: 1_000 });
});

test('uses measured row offsets for wrapped and variable-height rows', () => {
  const offsets = [0, 32, 96, 128, 224, 256, 288];
  assert.deepEqual(virtualWindow(6, offsets, 120, 80, 2, 1), { start: 1, end: 5 });
});

test('stable scroll anchors survive append, prepend, removal and height changes', () => {
  assert.equal(restoreScrollAnchor(['a', 'b', 'c'], [0, 40, 80, 120], ['a', 'b', 'c', 'd'], [0, 40, 80, 120, 160], 53), 53);
  assert.equal(restoreScrollAnchor(['a', 'b', 'c'], [0, 40, 80, 120], ['new', 'a', 'b', 'c'], [0, 30, 70, 110, 150], 53), 83);
  assert.equal(restoreScrollAnchor(['a', 'b', 'c'], [0, 40, 80, 120], ['a', 'c'], [0, 40, 80], 53), 13);
  assert.equal(restoreScrollAnchor(['a', 'b'], [0, 40, 80], ['a', 'b'], [0, 70, 110], 53), 83);
  assert.equal(restoreScrollAnchor(['a'], [0, 40], ['b'], [0, 40], 20), 0);
});
