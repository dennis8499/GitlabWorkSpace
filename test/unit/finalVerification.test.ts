import assert from 'node:assert/strict';
import test from 'node:test';
import { collectFinalVerification, unchangedVerificationFailure } from '../../src/codex/finalVerification';
import type { CodexOutputItem } from '../../src/codex/protocol';
import type { ValidationAttempt } from '../../src/codex/workContextProtocol';

const cwd = 'C:/project', turnId = 'validation-turn';
function native(command = 'npm test', exitCode = 0, patch: Partial<CodexOutputItem> = {}): CodexOutputItem {
  return { id: 'command-one', kind: 'command', command, exitCode, cwd, turnId, final: true, text: 'Native check result', startedAtMs: 1, completedAtMs: 2, ...patch };
}
function failure(patch: Partial<ValidationAttempt> = {}): ValidationAttempt {
  return { id: 'attempt-one', cycle: 1, startedAt: '2026-11-15T01:00:00.000Z', completedAt: '2026-11-15T01:00:01.000Z', cwd,
    artifactDigest: 'a'.repeat(64), requirementDigest: 'b'.repeat(64), profileDigest: 'c'.repeat(64), state: 'failed', commands: [{ command: 'npm test', exitCode: 1 }], ...patch };
}

test('final verification accepts every approved native command and preserves concrete execution evidence', () => {
  const result = collectFinalVerification(['npm test', 'npm run lint:docs'], [native(), native('npm run lint:docs', 0, { id: 'command-two' })], cwd, turnId, true);
  assert.equal(result.state, 'passed'); assert.deepEqual(result.commands.map(item => [item.command, item.itemId, item.exitCode, item.cwd]),
    [['npm test', 'command-one', 0, cwd], ['npm run lint:docs', 'command-two', 0, cwd]]);
  assert.deepEqual([result.commands[0].startedAtMs, result.commands[0].completedAtMs], [1, 2]);
});

test('final verification retains native nonzero check failures instead of treating them as missing evidence', () => {
  const result = collectFinalVerification(['npm test'], [native('npm test', 1)], cwd, turnId, true);
  assert.equal(result.state, 'failed'); assert.equal(result.commands[0].exitCode, 1); assert.match(result.reason!, /失敗/);
});

test('environment and dependency failures stop repair as blocked', () => {
  for (const [exitCode, output] of [[127, 'not found'], [9009, 'command missing'], [1, 'Cannot find module dependency'], [1, 'ECONNREFUSED'], [1, 'Permission denied']] as const) {
    const result = collectFinalVerification(['npm test'], [native('npm test', exitCode, { text: output })], cwd, turnId, true);
    assert.equal(result.state, 'blocked', output); assert.equal(result.commands[0].exitCode, exitCode);
  }
});

test('cancelled turns and terminated commands preserve interrupted status', () => {
  assert.equal(collectFinalVerification(['npm test'], [native()], cwd, turnId, false).state, 'interrupted');
  for (const exitCode of [130, 137, 143]) {
    const result = collectFinalVerification(['npm test'], [native('npm test', exitCode)], cwd, turnId, true);
    assert.equal(result.state, 'interrupted'); assert.equal(result.commands[0].exitCode, exitCode);
  }
});

test('missing command or exit evidence is incomplete and cannot pass a partial approved command list', () => {
  assert.equal(collectFinalVerification([], [], cwd, turnId, true).state, 'incomplete');
  const partial = collectFinalVerification(['npm test', 'npm run lint'], [native()], cwd, turnId, true);
  assert.equal(partial.state, 'incomplete'); assert.equal(partial.commands[1].exitCode, undefined);
  assert.equal(collectFinalVerification(['npm test'], [native('npm test', 0, { exitCode: undefined })], cwd, turnId, true).state, 'incomplete');
});

test('wrong working directory wrong turn unfinished commands and agent text cannot supply final proof', () => {
  for (const item of [native('npm test', 0, { cwd: 'C:/another-project' }), native('npm test', 0, { turnId: 'older-turn' }),
    native('npm test', 0, { final: false }), native('npm test', 0, { kind: 'agent', text: 'npm test passed' })]) {
    const result = collectFinalVerification(['npm test'], [item], cwd, turnId, true);
    assert.equal(result.state, 'incomplete'); assert.equal(result.commands[0].itemId, undefined);
  }
});

test('the last matching final native command determines the current check outcome', () => {
  const failed = native('npm test', 1), passed = native('npm test', 0, { id: 'retry-native' });
  assert.equal(collectFinalVerification(['npm test'], [failed, passed], cwd, turnId, true).state, 'passed');
  assert.equal(collectFinalVerification(['npm test'], [passed, failed], cwd, turnId, true).state, 'failed');
});

test('unchanged failed checks stop repeated repair only for the same source requirement and profile', () => {
  const prior = failure(), current = failure({ id: 'attempt-two', cycle: 2 });
  assert.equal(unchangedVerificationFailure(prior, current), true);
  for (const patch of [{ artifactDigest: 'd'.repeat(64) }, { requirementDigest: 'd'.repeat(64) }, { profileDigest: 'd'.repeat(64) },
    { state: 'blocked' as const }, { commands: [{ command: 'npm run lint', exitCode: 1 }] }, { commands: [{ command: 'npm test', exitCode: 2 }] }]) {
    assert.equal(unchangedVerificationFailure(prior, failure(patch)), false);
  }
  assert.equal(unchangedVerificationFailure(undefined, current), false);
});
