import assert from 'node:assert/strict';
import test from 'node:test';
import type { GitLabClient } from '../../src/api/gitLabClient';
import type { CodexTaskSpec } from '../../src/codex/protocol';
import { createRequirementSnapshot } from '../../src/codex/workContext';
import { assertCurrentWorkRequirement } from '../../src/codex/workRequirement';

function fixture(kind: 'issue' | 'merge-request' = 'issue', identity?: string) {
  const iid = kind === 'issue' ? 7 : 2;
  const current = { project_id: 1, iid, title: 'Approved requirement', description: '## Acceptance criteria\n- Return the sum', updated_at: 'later activity', sha: 'a'.repeat(40) };
  const requirement = createRequirementSnapshot({ source: { kind, identity: identity ?? JSON.stringify(['https://gitlab.test', 'account-a', 1, kind, iid]), revision: 'initial activity' },
    title: current.title, description: current.description, supplement: 'Keep the existing API.' });
  const spec: CodexTaskSpec = { root: 'C:/fixture', title: 'Review', prompt: '', source: { kind: 'merge-request', projectId: 1, iid: 2 }, writableRoots: [], workspaceKey: 'fixture', environmentKey: 'fixture',
    origin: { kind: 'merge-request', baseUrl: 'https://gitlab.test', accountKey: 'account-a', projectId: 1, iid: 2, projectPath: 'team/repo', repositoryRoot: 'C:/fixture',
      webUrl: 'https://gitlab.test/team/repo/-/merge_requests/2', sourceBranch: 'feature', sourceSha: 'a'.repeat(40), targetBranch: 'main', targetSha: 'b'.repeat(40) },
    workContext: { schema: 'GitLabWorkspaceWorkContext/v1', requirement } };
  let reads = 0;
  const client = { baseUrl: 'https://gitlab.test', getIssue: async (project: number, actual: number) => { reads++; assert.equal(project, 1); assert.equal(actual, 7); return current; },
    getMergeRequest: async (project: number, actual: number) => { reads++; assert.equal(project, 1); assert.equal(actual, 2); return current; } } as unknown as GitLabClient;
  return { spec, current, client, reads: () => reads };
}
for (const kind of ['issue', 'merge-request'] as const) test(`${kind} requirement title and body changes are rejected even when commit SHAs stay unchanged`, async () => {
  const f = fixture(kind); await assertCurrentWorkRequirement(f.spec, f.client);
  f.current.title = 'Changed requirement'; await assert.rejects(assertCurrentWorkRequirement(f.spec, f.client), /需求正文或標題已變更/);
  f.current.title = 'Approved requirement'; f.current.description += '\n- Changed acceptance';
  await assert.rejects(assertCurrentWorkRequirement(f.spec, f.client), /需求正文或標題已變更/);
  assert.equal(f.spec.origin!.sourceSha, 'a'.repeat(40)); assert.equal(f.reads(), 3);
});
test('activity-only updates preserve requirements and the original supplement', async () => {
  const f = fixture(); f.current.updated_at = 'new discussion activity'; f.spec.source.requirement = 'An unrelated later form value';
  await assertCurrentWorkRequirement(f.spec, f.client); assert.equal(f.reads(), 1);
});
test('invalid or foreign requirement identities are rejected before any GET', async () => {
  const tuples = [JSON.stringify(['https://other.test', 'account-a', 1, 'issue', 7]), JSON.stringify(['https://gitlab.test', 'account-b', 1, 'issue', 7]),
    JSON.stringify(['https://gitlab.test', 'account-a', 0, 'issue', 7]), JSON.stringify(['https://gitlab.test', 'account-a', 1, 'issue', '7']),
    JSON.stringify(['https://gitlab.test', 'account-a', 1, 'merge-request', 7]), 'not-json'];
  for (const identity of tuples) {
    const f = fixture('issue', identity); await assert.rejects(assertCurrentWorkRequirement(f.spec, f.client), /來源需求身分/); assert.equal(f.reads(), 0);
  }
  const f = fixture('merge-request', JSON.stringify(['https://gitlab.test', 'account-a', 2, 'merge-request', 2]));
  await assert.rejects(assertCurrentWorkRequirement(f.spec, f.client), /來源需求身分/); assert.equal(f.reads(), 0);
  const another = fixture(); Object.defineProperty(another.client, 'baseUrl', { value: 'https://gitlab.test/another-installation' });
  await assert.rejects(assertCurrentWorkRequirement(another.spec, another.client), /來源需求身分/); assert.equal(another.reads(), 0);
});
test('legacy tasks and local requirements do not add GitLab reads', async () => {
  const f = fixture(); f.spec.workContext = undefined; await assertCurrentWorkRequirement(f.spec, f.client);
  f.spec.workContext = { schema: 'GitLabWorkspaceWorkContext/v1', requirement: createRequirementSnapshot({ source: { kind: 'free', identity: 'local-work' }, title: 'Local', description: 'Local work' }) };
  await assertCurrentWorkRequirement(f.spec, f.client); assert.equal(f.reads(), 0);
});
test('unexpected remote object identity is not accepted as the captured requirement', async () => {
  const f = fixture(); f.current.project_id = 2;
  await assert.rejects(assertCurrentWorkRequirement(f.spec, f.client), /來源需求身分/); assert.equal(f.reads(), 1);
});
