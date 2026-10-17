import assert from 'node:assert/strict';
import test from 'node:test';
import { isQuickActionsRequest } from '../../src/workspace/quickActionsProtocol';

test('accepts only the navigation initialization and supported destinations', () => {
  assert.equal(isQuickActionsRequest({ type: 'ready' }), true);
  for (const action of ['openWorkspace', 'openMyWork', 'openProjects', 'openAdmin', 'openNotifications', 'addAccount', 'switchAccount', 'logoutAccount', 'removeAccount', 'manageAccounts']) {
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

test('accepts bounded operation context on sidebar actions and lifecycle controls', () => {
  const context = { operationId: 'operation-1', operationScope: 'account-7|root-1', hostSessionId: 'host-1', scopeEpoch: 3 };
  for (const request of [
    { type: 'ready' }, { type: 'reconcileOperations' },
    { type: 'perform', action: 'openMyWork' },
    { type: 'perform', action: 'openRepository', repositoryId: 'a'.repeat(32) },
    { type: 'repositoryDetails', repositoryId: 'a'.repeat(32), requestId: 'details-1' },
    { type: 'cancelRepositoryDetails', repositoryId: 'a'.repeat(32) }
  ]) {
    assert.equal(isQuickActionsRequest({ ...request, ...context }), true, `${request.type} accepts lifecycle context`);
    assert.equal(isQuickActionsRequest({ ...request, ...context, token: 'not-allowed' }), false, `${request.type} rejects unrelated fields`);
  }
  assert.equal(isQuickActionsRequest({ type: 'reconcileOperations' }), true, 'older lifecycle callers remain compatible');
});

test('rejects malformed or unbounded operation context without weakening request validation', () => {
  for (const context of [
    { operationId: '' }, { operationId: 'x'.repeat(101) }, { operationId: '../operation' }, { operationId: 1 },
    { operationScope: 'x'.repeat(501) }, { operationScope: {} },
    { hostSessionId: '' }, { hostSessionId: 'x'.repeat(101) }, { hostSessionId: '../session' }, { hostSessionId: 1 },
    { scopeEpoch: -1 }, { scopeEpoch: 0.5 }, { scopeEpoch: Number.MAX_SAFE_INTEGER + 1 }, { scopeEpoch: '1' }
  ]) assert.equal(isQuickActionsRequest({ type: 'perform', action: 'openMyWork', ...context }), false);
  assert.equal(isQuickActionsRequest({ type: 'perform', action: 'arbitrary.command', operationId: 'valid-id' }), false);
  assert.equal(isQuickActionsRequest({ type: 'reconcileOperations', action: 'openMyWork' }), false);
});

test('reconciles bounded pending operation identities without changing ready validation', () => {
  for (const pendingIds of [[], ['operation-1'], Array.from({ length: 200 }, (_, index) => `operation-${index}`)]) {
    assert.equal(isQuickActionsRequest({ type: 'reconcileOperations', pendingIds, operationScope: 'current-scope' }), true);
  }
  for (const pendingIds of [null, 'operation-1', [''], ['../operation'], ['x'.repeat(101)], [123], Array(1), Array(201).fill('operation-1')]) {
    assert.equal(isQuickActionsRequest({ type: 'reconcileOperations', pendingIds }), false);
  }
  assert.equal(isQuickActionsRequest({ type: 'ready', pendingIds: [] }), false, 'ready retains its strict control shape');
  assert.equal(isQuickActionsRequest({ type: 'perform', action: 'openMyWork', pendingIds: [] }), false);
});
