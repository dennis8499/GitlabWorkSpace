import assert from 'node:assert/strict';
import test from 'node:test';
import {
  countHiddenProjectSelection,
  reconcileProjectSelection,
  toggleProjectSelection
} from '../../src/workspace/repositorySelection';

test('keeps only current project IDs and removes duplicates after refresh', () => {
  assert.deepEqual(reconcileProjectSelection([4, 2, 4, 99], [2, 4, 7]), [4, 2]);
});

test('selecting or clearing the search results preserves checked hidden projects', () => {
  const selected = toggleProjectSelection([4, 99], [2, 4, 7], true);
  assert.deepEqual(selected, [4, 99, 2, 7]);
  assert.deepEqual(toggleProjectSelection(selected, [2, 4, 7], false), [99]);
});

test('counts selected projects outside the current search without changing the selection', () => {
  assert.equal(countHiddenProjectSelection([4, 99, 2], [2, 4]), 1);
  assert.deepEqual(reconcileProjectSelection([4, 99, 2], [2, 4]), [4, 2]);
});
