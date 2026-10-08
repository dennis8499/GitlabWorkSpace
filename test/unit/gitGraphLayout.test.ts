import assert from 'node:assert/strict';
import test from 'node:test';
import { layoutGitGraph } from '../../src/git/gitGraphLayout';
import type { GitCommitSummary } from '../../src/git/gitProtocol';
import { restoreGitUi } from '../../src/webview/gitUiState';

const commit = (hash: string, parents: string[]): GitCommitSummary => ({ hash, parents, subject: hash, author: 'Test', date: '2026-10-08T00:00:00Z' });

test('draws linear ancestry, roots and an unborn working directory without invented edges', () => {
  assert.equal(layoutGitGraph([]).rows.size, 0);
  const graph = layoutGitGraph([commit('worktree', ['a']), commit('a', ['b']), commit('b', [])]);
  assert.equal(graph.lanes, 1);
  assert.equal(graph.rows.get('b')!.segments.filter((segment) => segment.start === 'node').length, 0);
  assert.equal(layoutGitGraph([commit('worktree', [])]).rows.get('worktree')!.segments.length, 0);
});

test('joins actual merge parents and keeps colors and lanes stable when another page arrives', () => {
  const history = [commit('merge', ['left', 'right', 'third']), commit('left', ['root']), commit('right', ['root']), commit('third', ['root']), commit('root', [])];
  const page = layoutGitGraph(history.slice(0, 3)); const full = layoutGitGraph(history);
  assert.equal(full.rows.get('merge')!.segments.filter((segment) => segment.start === 'node').length, 3);
  assert.ok(full.lanes >= 3);
  for (const hash of ['merge', 'left', 'right']) assert.deepEqual(full.rows.get(hash), page.rows.get(hash));
  assert.equal(full.rows.get('root')!.segments.filter((segment) => segment.start === 'node').length, 0);
});

test('carries disconnected tips and a detached HEAD working node to their real parents', () => {
  const graph = layoutGitGraph([commit('worktree', ['detached']), commit('other', ['root']), commit('detached', ['root']), commit('root', [])]);
  const detached = graph.rows.get('detached')!;
  assert.ok(detached.segments.some((segment) => segment.start === 'top' && segment.end === 'node'));
  assert.notEqual(graph.rows.get('other')!.lane, detached.lane);
});

test('migrates legacy drafts and separates staged and unstaged selections', () => {
  assert.equal(restoreGitUi('{broken').repo, undefined);
  assert.deepEqual(restoreGitUi('[]'), {});
  const legacy = restoreGitUi(JSON.stringify({ repo: { tab: 'history', draft: '保留草稿', selectedPath: 'README.md' } })).repo;
  assert.equal(legacy.draft, '保留草稿'); assert.equal(legacy.selectedPath, 'README.md'); assert.equal(legacy.view, 'graph');
  const current = restoreGitUi(JSON.stringify({ repo: { draft: 'msg', selectedPath: 'same.ts', selectedSection: 'staged', view: 'diff' } })).repo;
  assert.equal(current.selectedSection, 'staged'); assert.equal(current.view, 'diff');
});
