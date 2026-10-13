import assert from 'node:assert/strict';
import test from 'node:test';
import { isQuickActionsRequest } from '../../src/workspace/quickActionsProtocol';

test('accepts only the navigation initialization and supported destinations', () => {
  assert.equal(isQuickActionsRequest({ type: 'ready' }), true);
  for (const action of ['openWorkspace', 'openMyWork', 'openProjects', 'openAdmin', 'addAccount', 'switchAccount', 'logoutAccount', 'removeAccount', 'manageAccounts']) {
    assert.equal(isQuickActionsRequest({ type: 'perform', action }), true, `${action} is supported`);
  }
});

test('rejects unknown commands and malformed webview messages', () => {
  assert.equal(isQuickActionsRequest({ type: 'perform', action: 'disconnect' }), false);
  assert.equal(isQuickActionsRequest({ type: 'perform', action: 'connect' }), false);
  assert.equal(isQuickActionsRequest({ type: 'perform', action: 'selectGroup' }), false);
  assert.equal(isQuickActionsRequest({ type: 'perform', action: 'arbitrary.command' }), false);
  assert.equal(isQuickActionsRequest({ type: 'runCommand', command: 'gitlabWorkspace.disconnect' }), false);
  assert.equal(isQuickActionsRequest({ type: 'ready', action: 'connect' }), false);
  assert.equal(isQuickActionsRequest(null), false);
  assert.equal(isQuickActionsRequest('perform'), false);
});

test('bounds details requests to a repository identity and a correlated request', () => {
  const repositoryId = 'a'.repeat(32);
  assert.equal(isQuickActionsRequest({ type: 'repositoryDetails', repositoryId, requestId: 'details-1' }), true);
  assert.equal(isQuickActionsRequest({ type: 'cancelRepositoryDetails', repositoryId }), true);
  for (const message of [
    { type: 'repositoryDetails', repositoryId: '../repo', requestId: 'details-1' },
    { type: 'repositoryDetails', repositoryId, requestId: '' },
    { type: 'repositoryDetails', repositoryId, requestId: 'x'.repeat(81) },
    { type: 'repositoryDetails', repositoryId, requestId: 'details-1', command: 'git push' },
    { type: 'cancelRepositoryDetails', repositoryId, requestId: 'details-1' }
  ]) assert.equal(isQuickActionsRequest(message), false);
});
