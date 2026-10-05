import assert from 'node:assert/strict';
import test from 'node:test';
import {
  applyIssueGraphPatch, createIssueGraphPatch, issueGraphBoardColor, issueGraphEdge, issueGraphNodeKey, mapWithConcurrency, selectIssueGraph,
  type IssueGraphNode, type IssueGraphSnapshot
} from '../../src/workspace/issueGraph';

test('uses a shared identity for REST and WorkItem Issue records across projects', () => {
  assert.equal(issueGraphNodeKey(42, 'team/repo', '7'), issueGraphNodeKey(42, 'TEAM/REPO', 7));
  assert.notEqual(issueGraphNodeKey(42, 'team/alpha', 7), issueGraphNodeKey(84, 'team/beta', 7));
  assert.equal(issueGraphNodeKey(undefined, 'team', 7), 'namespace:team:item:7');
});

test('deduplicates undirected links while keeping separate directed block and hierarchy relationships', () => {
  const forward = issueGraphEdge('work-a', 'work-b', 'relates_to');
  const reverse = issueGraphEdge('work-b', 'work-a', 'relates_to');
  assert.deepEqual(forward, reverse);
  assert.deepEqual(issueGraphEdge('work-a', 'work-b', 'blocks'), {
    id: 'blocks:work-a\0work-b', source: 'work-a', target: 'work-b', type: 'blocks'
  });
  assert.notEqual(issueGraphEdge('work-a', 'work-b', 'blocks')?.id, issueGraphEdge('work-a', 'work-b', 'parent')?.id);
  assert.equal(issueGraphEdge('work-a', 'work-a', 'parent'), undefined);
});

test('preserves deterministic Board colors', () => {
  assert.equal(issueGraphBoardColor(31), issueGraphBoardColor(31));
  assert.match(issueGraphBoardColor(31), /^#[\da-f]{6}$/i);
  assert.notEqual(issueGraphBoardColor(31), issueGraphBoardColor(32));
});

test('applies graph deltas with only changed nodes and edges', () => {
  const node = (id: string, title: string): IssueGraphNode => ({ id, sourceIds: [], kind: 'issue', namespacePath: 'team/repo', iid: id,
    title, state: 'opened', labels: [], assignees: [], boardIds: [], assignedToMe: true, isRoot: id === 'a' });
  const previous: IssueGraphSnapshot = { connectedScope: 'scope-a', status: 'loading', roots: ['a'], nodes: [node('a', 'old'), node('b', 'removed')],
    edges: [{ id: 'parent:a:b', source: 'a', target: 'b', type: 'parent' }], boardIssueIds: { 1: [10] }, boardStatus: { 1: { status: 'loading' } }, errors: [], updatedAt: 1 };
  const next: IssueGraphSnapshot = { ...previous, status: 'ready', roots: ['a', 'c'], nodes: [node('a', 'updated'), node('c', 'new')],
    edges: [{ id: 'parent:a:c', source: 'a', target: 'c', type: 'parent' }], boardIssueIds: { 1: [10], 2: [11] },
    boardStatus: { 1: { status: 'ready' }, 2: { status: 'ready' } }, updatedAt: 2 };
  const patch = createIssueGraphPatch(previous, next);
  assert.deepEqual(patch.upsertNodes.map((item) => item.id), ['a', 'c']);
  assert.deepEqual(patch.removeNodeIds, ['b']);
  assert.deepEqual(patch.upsertEdges.map((item) => item.id), ['parent:a:c']);
  assert.deepEqual(patch.removeEdgeIds, ['parent:a:b']);
  assert.deepEqual(applyIssueGraphPatch(previous, patch), next);
});

test('filters primary Issues but retains only their directly connected context', () => {
  const graph: IssueGraphSnapshot = {
    connectedScope: 'scope-a', status: 'ready', roots: ['a', 'b'],
    nodes: [
      { id: 'a', sourceIds: [], kind: 'issue', namespacePath: 'team/a', iid: '1', title: 'Alpha', state: 'opened', labels: [], assignees: [], boardIds: [31], assignedToMe: true, isRoot: true },
      { id: 'b', sourceIds: [], kind: 'issue', namespacePath: 'team/b', iid: '2', title: 'Beta', state: 'closed', labels: [], assignees: [], boardIds: [32], assignedToMe: true, isRoot: true },
      { id: 'c', sourceIds: [], kind: 'task', namespacePath: 'team/a', iid: '3', title: 'Child', state: 'opened', labels: [], assignees: [], boardIds: [], assignedToMe: false, isRoot: false },
      { id: 'd', sourceIds: [], kind: 'issue', namespacePath: 'team/b', iid: '4', title: 'Grandchild', state: 'opened', labels: [], assignees: [], boardIds: [], assignedToMe: false, isRoot: false }
    ],
    edges: [
      { id: 'parent:a-c', source: 'a', target: 'c', type: 'parent' },
      { id: 'parent:c-d', source: 'c', target: 'd', type: 'parent' }
    ],
    boardIssueIds: {}, boardStatus: {}, errors: [], updatedAt: 0
  };
  const result = selectIssueGraph(graph, new Set(['a']), 'all');
  assert.equal(result.rootCount, 1);
  assert.deepEqual(result.nodes.map((node) => node.id), ['a', 'c']);
  assert.deepEqual(result.edges.map((edge) => edge.id), ['parent:a-c']);
  assert.deepEqual(selectIssueGraph(graph, new Set(['a', 'b']), 32).nodes.map((node) => node.id), ['b']);
});

test('limits concurrent API work and keeps results in their original order', async () => {
  let active = 0;
  let peak = 0;
  const result = await mapWithConcurrency([6, 4, 2, 0, -2, -4, -6], 4, async (value) => {
    active++;
    peak = Math.max(peak, active);
    await new Promise((resolve) => setTimeout(resolve, (Math.abs(value) % 3) * 4));
    active--;
    return value * value;
  });
  assert.equal(peak, 4);
  assert.deepEqual(result, [36, 16, 4, 0, 4, 16, 36]);
  await assert.rejects(mapWithConcurrency([1], 0, async (value) => value), RangeError);
});
