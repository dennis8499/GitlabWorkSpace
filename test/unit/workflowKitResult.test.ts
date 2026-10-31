import assert from 'node:assert/strict';
import test from 'node:test';
import { workflowKitFailure, workflowKitWarnings } from '../../src/workspace/workflowKitResult';

test('installer errors preserve the structured message amid diagnostic output', () => {
  assert.equal(workflowKitFailure('diagnostic\r\n{"ok":false,"error":"交易驗證失敗"}\r\ntrailing diagnostic')?.message, '交易驗證失敗');
  assert.equal(workflowKitFailure('{"ok":false,"error":"obsolete"}\n{"ok":true}')?.message, undefined);
  for (const output of ['not JSON', '{"ok":true}', '{"ok":false}', '[]', 'null', '{"ok":false,"error":17}']) {
    assert.equal(workflowKitFailure(output), undefined);
  }
});

test('installer warnings retain actionable text without accepting invalid result values', () => {
  assert.deepEqual(workflowKitWarnings(['未偵測到 uv；安裝已完成。', '', 3, 'x'.repeat(2001)]), ['未偵測到 uv；安裝已完成。']);
  assert.deepEqual(workflowKitWarnings({ warning: 'ignored' }), []);
});
