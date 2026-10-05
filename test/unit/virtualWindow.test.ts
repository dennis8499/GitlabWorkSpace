import assert from 'node:assert/strict';
import test from 'node:test';
import { virtualWindow } from '../../src/webview/virtualWindow';

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
