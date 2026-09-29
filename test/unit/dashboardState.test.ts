import assert from 'node:assert/strict';
import test from 'node:test';
import { restoreManualTimeState } from '../../src/webview/dashboardState';

test('v2 manual time draft is retained for explicit recovery without guessing its Issue', () => {
  const legacyDraft = { duration: '45m', summary: 'Review', spentAt: '2026-09-28' };
  const restored = restoreManualTimeState({ manualTime: legacyDraft });
  assert.deepEqual(restored.manualTimes, {});
  assert.deepEqual(restored.recoveredManualTime, legacyDraft);
});

test('v3 manual time drafts stay attached to their scoped Issue keys', () => {
  const existing = { duration: '30m', summary: 'Existing', spentAt: '' };
  const current = { duration: '1h', summary: 'Current', spentAt: '2026-09-29' };
  const restored = restoreManualTimeState(
    { manualTimes: { '42#7': current } },
    { manualTimes: { '42#7': existing, '43#2': existing } }
  );
  assert.deepEqual(restored.manualTimes, { '42#7': current, '43#2': existing });
  assert.equal(restored.recoveredManualTime, undefined);
});

test('an already recovered draft survives further state migrations', () => {
  const recovered = { duration: '10m', summary: '', spentAt: '' };
  const restored = restoreManualTimeState({ recoveredManualTime: recovered, manualTime: { duration: '20m', summary: '', spentAt: '' } });
  assert.deepEqual(restored.recoveredManualTime, recovered);
});
