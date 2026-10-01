import assert from 'node:assert/strict';
import test from 'node:test';
import { isQuickActionsRequest } from '../../src/workspace/quickActionsProtocol';

test('accepts only the navigation initialization and supported destinations', () => {
  assert.equal(isQuickActionsRequest({ type: 'ready' }), true);
  for (const action of ['openWorkspace', 'openMyWork', 'openProjects']) {
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
