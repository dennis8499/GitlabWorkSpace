import assert from 'node:assert/strict';
import test from 'node:test';
import { actionUsesGitLab, gitActionRemote } from '../../src/workspace/gitLabDependency';
import { connectionLabel, observeConnection } from '../../src/connection/connectionState';

test('GitLab authority is required only for the MR Codex CLI workflow', () => {
  const local = ['scanRepositories', 'installWorkflowKit', 'refreshBmad', 'gitAction', 'codexCliSettings'];
  for (const type of local) assert.equal(actionUsesGitLab({ type }), false);
  for (const kind of ['skill', 'bmad', 'review']) assert.equal(actionUsesGitLab({ type: 'runCodexCli', source: { kind } }), false);
  for (const reviewerTool of ['merge-reviewer', 'release-reviewer']) {
    assert.equal(actionUsesGitLab({ type: 'runCodexCli', source: { kind: 'merge-request', reviewerTool } }), true);
  }
  assert.equal(actionUsesGitLab({ type: 'refresh', mode: 'git' }), false);
  assert.equal(actionUsesGitLab({ type: 'refresh', mode: 'developer' }), true);
  assert.equal(actionUsesGitLab({ type: 'refresh', mode: 'clone', projectSource: 'local' }), false);
});
test('Git dependency resolution includes implicit Fetch and keeps ordinary Rebase local', () => {
  assert.equal(gitActionRemote({ type: 'rebasePreview', ref: 'main' }), undefined);
  assert.equal(gitActionRemote({ type: 'rebase', ref: 'main' }), undefined);
  for (const type of ['rebase', 'rebasePreview'] as const) assert.equal(gitActionRemote({ type, ref: 'main', pullSource: { remote: 'upstream', branch: 'main' } }), 'upstream');
  assert.equal(gitActionRemote({ type: 'push', remote: 'publish', branch: 'work' }), 'publish');
  assert.equal(gitActionRemote({ type: 'stageFile', path: 'a', staged: true }), undefined);
});
test('connection health distinguishes authentication and transport without treating optional API denial as disconnection', () => {
  const connected = { status: 'connected' as const };
  assert.deepEqual(observeConnection(connected, { status: 401 }), { status: 'auth-required' });
  for (const status of [403, 404, 500]) assert.deepEqual(observeConnection(connected, { status }), connected);
  assert.deepEqual(observeConnection(connected, { name: 'AbortError' }), connected);
  assert.deepEqual(observeConnection(connected, new TypeError('network')), { status: 'unavailable' });
  assert.deepEqual(observeConnection(connected, { name: 'TimeoutError' }), { status: 'unavailable' });
  assert.deepEqual(observeConnection({ status: 'unverified' }), connected);
  assert.equal(connectionLabel({ status: 'unverified' }), '尚未驗證');
  assert.equal(connectionLabel({ status: 'auth-required' }), '需要重新登入');
});
