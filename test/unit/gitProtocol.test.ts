import assert from 'node:assert/strict';
import test from 'node:test';
import { isGitObjectId, isGitPanelRequest, isGitRefName, isGitRemoteName } from '../../src/git/gitProtocol';

const oid = 'a'.repeat(40);

test('accepts GUI Git requests only when their Repo, action, refs, and paths are valid', () => {
  assert.equal(isGitPanelRequest({ type: 'gitReady' }), true);
  assert.equal(isGitPanelRequest({ type: 'gitOpenRepository', path: 'C:\\workspace\\repo' }), true);
  assert.equal(isGitPanelRequest({ type: 'gitOpenMergeEditor', repositoryId: 'a'.repeat(32), path: 'src/file.ts' }), true);
  assert.equal(isGitPanelRequest({ type: 'gitOpenDiff', repositoryId: 'a'.repeat(32), path: 'A space/檔案.ts', staged: false, ref: oid }), true);
  assert.equal(isGitPanelRequest({ type: 'gitOpenDiff', repositoryId: 'bad', path: '../outside', staged: false }), false);
  assert.equal(isGitPanelRequest({ type: 'gitAction', repoId: 'a'.repeat(32), requestId: 'request-1', action: { type: 'discard', path: '../outside' } }), false);
  assert.equal(isGitPanelRequest({ type: 'gitAction', repoId: 'a'.repeat(32), requestId: 'request-1', action: { type: 'push', remote: '-u', branch: 'main', force: true, setUpstream: true } }), false);
  assert.equal(isGitPanelRequest({ type: 'gitAction', repoId: 'a'.repeat(32), requestId: 'request-1', action: { type: 'rebase', ref: 'main', interactive: true, todo: [{ hash: oid, action: 'exec' }] } }), false);
});

test('validates Git refs and full object IDs without accepting option-like names', () => {
  assert.equal(isGitObjectId(oid), true);
  assert.equal(isGitObjectId('b'.repeat(64)), true);
  assert.equal(isGitObjectId('c'.repeat(12)), false);
  assert.equal(isGitRefName('feature/中文-branch'), true);
  assert.equal(isGitRefName('release candidate'), false);
  assert.equal(isGitRefName('-n'), false);
  assert.equal(isGitRefName('feature/../main'), false);
  assert.equal(isGitRemoteName('origin'), true);
  assert.equal(isGitRemoteName('-u'), false);
});
