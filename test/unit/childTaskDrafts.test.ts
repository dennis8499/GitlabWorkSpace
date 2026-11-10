import assert from 'node:assert/strict';
import test from 'node:test';
import { retainChildTaskRows, settleChildTaskDraft, type ChildTaskDraftState } from '../../src/webview/childTaskDrafts';

const saved = (): ChildTaskDraftState => ({
  101: { selectedId: 'task-a', drafts: { 'task-a': { title: 'Submitted', description: '' }, 'task-b': { title: 'Other task', description: 'Keep' } } },
  102: { selectedId: 'task-a', drafts: { 'task-a': { title: 'Another Issue', description: 'Keep' } } }
});

test('legacy child submissions without a task identity cannot consume a task draft', () => {
  const state = saved();
  assert.equal(settleChildTaskDraft(state, 101, undefined, { title: 'Submitted', description: '' }), state);
});

test('settling a child save removes only its exact submitted draft and retains other task and Issue drafts', () => {
  const state = saved(), next = settleChildTaskDraft(state, 101, 'task-a', { title: 'Submitted', description: '' });
  assert.equal(next[101].drafts['task-a'], undefined);
  assert.equal(next[101].selectedId, 'task-a');
  assert.equal(next[101].drafts['task-b'], state[101].drafts['task-b']);
  assert.equal(next[102], state[102]);
  assert.ok(state[101].drafts['task-a'], 'settling never mutates previously persisted state');
});

test('later title or description edits survive a receipt for an older child save', () => {
  const state = saved();
  assert.equal(settleChildTaskDraft(state, 101, 'task-a', { title: 'Older title', description: '' }), state);
  assert.equal(settleChildTaskDraft(state, 101, 'task-a', { title: 'Submitted', description: 'Older description' }), state);
});

test('incomplete child reads retain known task rows while a complete empty list is authoritative', () => {
  const tasks = [{ id: 'task-a', iid: '2', title: 'Task', state: 'OPEN' }];
  assert.equal(retainChildTaskRows(tasks, [], false), tasks);
  assert.deepEqual(retainChildTaskRows(tasks, [], true), []);
  assert.equal(retainChildTaskRows([], tasks, false), tasks);
});
