import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { codexCapabilities } from '../../src/codex/adapter';
import { isWorkspaceRequest } from '../../src/workspace/workspaceRequestValidation';

test('0.167.2 destructive thread cleanup is gated by the captured method and required identity', async () => {
  const contract = JSON.parse(await readFile(path.resolve('test/fixtures/codex-app-server-0.167.2.contract.json'), 'utf8'));
  assert.equal(contract.version, '0.167.2');
  assert.deepEqual(contract.deleteParams.required, ['threadId']);
  assert.equal(contract.deleteParams.properties.threadId.type, 'string');
  assert.deepEqual(contract.methods['thread/delete'].properties.method.enum, ['thread/delete']);
  assert.equal(codexCapabilities(contract.version).deleteThread, true);
  for (const version of ['0.166.0', '0.167.0', '0.167.2-alpha.1', '0.168.0']) assert.equal(codexCapabilities(version).deleteThread, false);
  for (const value of Object.values(contract.schemas) as Array<{ sha256: string }>) assert.match(value.sha256, /^[a-f0-9]{64}$/);
});

test('approval messages accept the captured session decisions and scopes without accepting arbitrary policy objects', async () => {
  const contract = JSON.parse(await readFile(path.resolve('test/fixtures/codex-app-server-0.167.2.contract.json'), 'utf8'));
  const decisions = contract.commandApprovalDecision.oneOf.flatMap((item: { enum?: string[] }) => item.enum ?? []);
  assert.deepEqual(decisions, ['accept', 'acceptForSession', 'decline', 'cancel']);
  assert.ok(contract.schemas['CommandExecutionRequestApprovalParams.json'].properties.includes('availableDecisions'));
  assert.deepEqual(contract.permissionGrantScope.enum, ['turn', 'session']);
  const message = (answer: unknown) => ({ type: 'answerCodex', taskId: 'task-one', interactionId: 'request-one', answer });
  for (const decision of decisions) assert.equal(isWorkspaceRequest(message({ decision })), true);
  assert.equal(isWorkspaceRequest(message({ decision: 'accept', scope: 'session' })), true);
  assert.equal(isWorkspaceRequest(message({ decision: 'accept', execpolicyAmendment: ['git', 'status'] })), true);
  assert.deepEqual(contract.networkPolicyRuleAction.enum, ['allow', 'deny']);
  assert.deepEqual(contract.networkPolicyAmendment.required, ['action', 'host']);
  assert.equal(isWorkspaceRequest(message({ decision: 'accept', networkPolicyAmendment: { action: 'allow', host: 'example.com' } })), true);
  assert.equal(isWorkspaceRequest(message({ decision: 'accept', networkPolicyAmendment: { action: 'deny', host: 'example.com' } })), true);
  assert.equal(isWorkspaceRequest(message({ decision: 'accept', networkPolicyAmendment: { action: 'global', host: 'example.com' } })), false);
  assert.equal(isWorkspaceRequest(message({ decision: 'accept', networkPolicyAmendment: { action: 'allow', host: '' } })), false);
  assert.equal(isWorkspaceRequest(message({ decision: 'accept', scope: 'global' })), false);
  assert.equal(isWorkspaceRequest(message({ decision: 'accept', applyNetworkPolicyAmendment: { action: 'allow', host: '*' } })), false);
  assert.ok(contract.commandApprovalDecision.oneOf.some((item: { properties?: object }) => item.properties && 'applyNetworkPolicyAmendment' in item.properties),
    'the native wire option uses applyNetworkPolicyAmendment');
});
