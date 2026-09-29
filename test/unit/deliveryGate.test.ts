import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { evaluateMeginDeliveryGate } from '../../src/workspace/deliveryGate';

const diffSha256 = createHash('sha256').update('accepted diff').digest('hex');
const base = {
  workId: 'MEGIN-123-feature', headSha: 'head-1', baseSha: 'base-1',
  localTargetSha: 'target-1', cloudTargetSha: 'target-1', status: ' M src/file.ts',
  diffSha256, acceptanceConfirmed: true
};

test('allows an accepted working diff only when the local target matches GitLab', () => {
  assert.deepEqual(evaluateMeginDeliveryGate(base), { ok: true, reasons: [] });
  const stale = evaluateMeginDeliveryGate({ ...base, cloudTargetSha: 'target-2' });
  assert.equal(stale.ok, false);
  assert.match(stale.reasons.join(' '), /GitLab 最新提交/);
});

test('blocks absent Megin acceptance, unstaged files and content-free delivery previews', () => {
  const noAcceptance = evaluateMeginDeliveryGate({ ...base, acceptanceConfirmed: false });
  assert.match(noAcceptance.reasons.join(' '), /人工驗收/);
  assert.match(evaluateMeginDeliveryGate({ ...base, status: '?? new-file.ts' }).reasons.join(' '), /尚未追蹤/);
  assert.match(evaluateMeginDeliveryGate({ ...base, status: 'M  src/file.ts' }).reasons.join(' '), /暫存區/);
  assert.match(evaluateMeginDeliveryGate({ ...base, diffSha256: createHash('sha256').update('').digest('hex') }).reasons.join(' '), /沒有可交付/);
});
