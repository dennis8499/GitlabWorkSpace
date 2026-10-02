import assert from 'node:assert/strict';
import test from 'node:test';
import { parseMeginHandoff } from '../../src/workspace/meginHandoff';

const workId = 'work-20261002-feature';
function receipt() {
  return { schema: 'megin-gitlab-handoff/v1', work_id: workId, group_root: 'C:\Group',
    plan_version: 'plan-1', requirements_revision: 'req-1', snapshot: 'a'.repeat(64), handoff_sha256: 'b'.repeat(64),
    gitlab: { origin: 'https://gitlab.example', issue_project_id: 10, issue_iid: 3 },
    acceptance: { version: 'acceptance-1', verdict: 'ACCEPTED', snapshot: 'a'.repeat(64) },
    review: { verdict: 'APPROVED' }, checks: [{ id: 'test', status: 'passed' }], state: 'awaiting_user',
    repositories: [{ repo_path: 'service--10', remote: 'upstream', remote_url: 'https://gitlab.example/group/service.git',
      base_branch: 'release', base_commit: 'c'.repeat(40), feature_branch: `feature/${workId}`, allowed_paths: ['app.ts'],
      gitlab_project_id: 10, gitlab_namespace: 'group/service',
      snapshot: { head: 'c'.repeat(40), branch: `feature/${workId}`, product_sha256: 'd'.repeat(64), path_count: 2 },
      staged: { staged_snapshot: 'd'.repeat(64), staged_paths: ['app.ts'] } }] };
}

test('accepts a native staged-file handoff with the approved non-origin remote and target', () => {
  const value = parseMeginHandoff(receipt(), workId);
  assert.equal(value.repositories[0].remote, 'upstream');
  assert.equal(value.repositories[0].base_branch, 'release');
  assert.deepEqual(value.repositories[0].staged.staged_paths, ['app.ts']);
});

test('an acceptance checkbox, wrong Work ID or mismatched staged digest cannot authorize delivery', () => {
  assert.throws(() => parseMeginHandoff({ acceptanceConfirmed: true }, workId));
  assert.throws(() => parseMeginHandoff(receipt(), 'work-20261002-other'));
  const changed = receipt(); changed.repositories[0].staged.staged_snapshot = 'e'.repeat(64);
  assert.throws(() => parseMeginHandoff(changed, workId));
});
