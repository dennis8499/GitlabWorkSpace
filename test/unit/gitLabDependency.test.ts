import assert from 'node:assert/strict';
import test from 'node:test';
import { actionUsesGitLab, gitActionRemote, sourceUsesGitLab, taskUsesGitLab } from '../../src/workspace/gitLabDependency';
import { isLocalWorkspaceAction } from '../../src/workspace/actionPolicy';
import { connectionLabel, observeConnection } from '../../src/connection/connectionState';

test('GitLab authority is independent of local storage scope and write classification', () => {
  for (const type of ['publishProjectWiki', 'publishCodexReview']) {
    assert.equal(isLocalWorkspaceAction({ type }), true);
    assert.equal(actionUsesGitLab({ type }), true);
  }
  for (const type of ['scanRepositories', 'installWorkflowKit', 'refreshBmad', 'gitAction']) assert.equal(actionUsesGitLab({ type }), false);
  assert.equal(actionUsesGitLab({ type: 'refresh', mode: 'git' }), false);
  assert.equal(actionUsesGitLab({ type: 'refresh', mode: 'developer' }), true);
  assert.equal(actionUsesGitLab({ type: 'refresh', mode: 'clone', projectSource: 'local' }), false);
  assert.equal(actionUsesGitLab({ type: 'prepareCommitReview', repo: 'local' }), false);
  assert.equal(actionUsesGitLab({ type: 'prepareCommitReview', projectId: 1 }), true);
  assert.equal(actionUsesGitLab({ type: 'codexCommand', command: { action: 'publish-group-issues' } }), true);
});
test('stored task provenance and expected account bindings retain remote authority', () => {
  const source = { kind: 'free' as const, repository: 'repo', prompt: 'work' };
  assert.equal(sourceUsesGitLab(source), false);
  assert.equal(sourceUsesGitLab({ ...source, expectedScope: 'original-account' }), true);
  assert.equal(taskUsesGitLab({ source }), false);
  assert.equal(actionUsesGitLab({ type: 'sendCodexMessage' }, { source: { kind: 'issue', projectId: 1, issueIid: 2 } }), true);
  assert.equal(actionUsesGitLab({ type: 'sendCodexMessage' }, { source }), false);
  assert.equal(actionUsesGitLab({ type: 'codexCommand', command: { action: 'reconcile' } }, { source }), false);
  assert.equal(actionUsesGitLab({ type: 'codexCommand', command: { action: 'reconcile' } }, { source: { kind: 'issue', projectId: 1, issueIid: 2 } }), true);
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
