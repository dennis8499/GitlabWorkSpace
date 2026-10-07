import assert from 'node:assert/strict';
import test from 'node:test';
import { buildLoadGraphEdges, buildLoadIssueWork, buildLoadMergeRequestBranches } from './live-fixture-plan.mjs';

test('the managed load plan creates exactly 20 projects, 500 issues, 50 merge requests and 200 graph nodes', () => {
  const projectIds = Array.from({ length: 20 }, (_, index) => index + 100);
  const issues = buildLoadIssueWork(projectIds);
  const branches = buildLoadMergeRequestBranches();
  const graphEdges = buildLoadGraphEdges(issues.filter((issue) => issue.graph));

  assert.equal(new Set(issues.map((issue) => issue.projectId)).size, 20);
  assert.equal(issues.length, 500);
  assert.equal(issues.filter((issue) => issue.projectId === projectIds[0]).length, 25);
  assert.equal(issues.filter((issue) => issue.graph).length, 200);
  assert.equal(new Set(issues.filter((issue) => issue.graph).map((issue) => issue.projectId)).size, 20);
  assert.deepEqual(issues.slice(0, 11).map((issue) => issue.graph), [true, true, true, true, true, true, true, true, true, true, false]);
  assert.equal(branches.reduce((count, project) => count + project.branches.length, 0), 50);
  assert.deepEqual(branches.map((project) => project.branches.length), [...Array(10).fill(3), ...Array(10).fill(2)]);
  assert.equal(graphEdges.length, 199);
  assert.equal(graphEdges.every((edge) => edge.source.projectId && edge.target.projectId), true);
  assert.ok(graphEdges.some((edge) => edge.source.projectId !== edge.target.projectId), 'the ordered graph traverses Repo boundaries');
});

test('load-plan helpers reject incomplete project inventories and preserve graph ordering across repositories', () => {
  assert.throws(() => buildLoadIssueWork([1, 2, 3]), /requires 20/);
  assert.throws(() => buildLoadIssueWork([...Array(19).keys()].map((value) => value + 1).concat(1)), /requires 20/);
  const issues = buildLoadIssueWork(Array.from({ length: 20 }, (_, index) => index + 1)).filter((issue) => issue.graph);
  assert.equal(issues[9].projectId, 1);
  assert.equal(issues[10].projectId, 2);
  assert.equal(issues.at(-1).graphOrdinal, 200);
  assert.deepEqual(buildLoadGraphEdges([{ projectId: 1, iid: 1 }]), []);
});
