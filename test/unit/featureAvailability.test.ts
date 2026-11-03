import assert from 'node:assert/strict';
import test from 'node:test';
import { checkPermissionAvailability } from '../../src/api/actionAvailability';
import { issueFeatureAvailability, issueAvailabilityFlags } from '../../src/issues/issueAvailability';
import { sanitizeDiagnostic, sanitizeFeedbackDiagnostics } from '../../src/logging/diagnosticText';
import { availabilityBlocker, availabilityProps, blockedWhen, firstBlocker, groupFeatureBlockers } from '../../src/webview/featureAvailability';

test('permission probes distinguish allowed, denied and failed without repeating the read', async () => {
  let reads = 0;
  assert.deepEqual(await checkPermissionAvailability(async () => { reads++; return true; }, '沒有建立權限', sanitizeDiagnostic), { status: 'allowed' });
  assert.deepEqual(await checkPermissionAvailability(async () => { reads++; return false; }, '沒有建立權限', sanitizeDiagnostic), { status: 'denied', reason: '沒有建立權限' });
  const failed = await checkPermissionAvailability(async () => { reads++; throw new Error('offline glpat-private-secret'); }, '沒有建立權限', sanitizeDiagnostic);
  assert.equal(failed.status, 'unknown'); assert.match(failed.reason!, /無法確認/);
  assert.match(failed.details!, /offline/); assert.doesNotMatch(failed.details!, /private-secret/);
  assert.equal(reads, 3);
});

test('progressive Issue permissions keep checks, failures, schema limits and denials distinct', () => {
  const derive = (data: Parameters<typeof issueFeatureAvailability>[0], diagnostics: Parameters<typeof issueFeatureAvailability>[1] = []) => issueFeatureAvailability(data, diagnostics, sanitizeDiagnostic);
  assert.match(derive({ canEdit: false, sections: { permissions: 'loading' } }).canEdit!.reason!, /正在確認/);
  const failed = derive({ canEdit: false, sections: { permissions: 'error' }, loadErrors: { permissions: 'offline token=private' } }).canEdit!;
  assert.equal(failed.status, 'unknown'); assert.equal(availabilityBlocker(failed)!.tone, 'error'); assert.doesNotMatch(failed.details!, /private/);
  const stale = derive({ canEdit: true, sections: { permissions: 'error' }, loadErrors: { permissions: 'offline' } });
  assert.equal(stale.canEdit!.status, 'unknown'); assert.equal(issueAvailabilityFlags(stale).canEdit, false);
  assert.equal(derive({ canEdit: false, sections: { permissions: 'ready' } }).canEdit!.status, 'denied');
  assert.equal(derive({ canEdit: true, sections: { permissions: 'ready' } }).canEdit!.status, 'allowed');
  const unsupported = derive({ canManageChildren: false }, [{ id: 'tasks', label: '子工作', status: 'unsupported', reason: '此 Schema 沒有子工作操作。' }]);
  assert.match(unsupported.canManageChildren!.reason!, /Schema/);
  assert.equal(derive({ canManageChildren: false, sections: { permissions: 'ready', tasks: 'idle' } }).canManageChildren!.status, 'unknown');
  assert.equal(derive({ canSetStartDate: false, canEdit: true, startDateSupported: false, sections: { dates: 'ready', permissions: 'ready' } }).canSetStartDate!.status, 'denied');
  assert.equal(derive({ canDelete: false, deleteAvailability: { status: 'unknown', reason: 'Owner 尚未確認' } }).canDelete!.status, 'unknown');
});

test('controls share a stable description and repeated causes are grouped with affected action labels', () => {
  const waiting = blockedWhen(true, '正在處理，請稍候。')!;
  const missing = blockedWhen(true, '請選擇 Repo。')!;
  const selected = firstBlocker(waiting, missing);
  assert.equal(availabilityProps('git', selected).disabled, true);
  assert.equal(availabilityProps('git', selected)['aria-describedby'], availabilityProps('git', { ...waiting })['aria-describedby']);
  const groups = groupFeatureBlockers({ Fetch: waiting, Pull: { ...waiting }, Push: missing, Refresh: undefined });
  assert.equal(groups.length, 2); assert.deepEqual(groups[0].labels, ['Fetch', 'Pull']);
  assert.deepEqual(availabilityProps('git', undefined), { disabled: false, 'aria-describedby': undefined });
  assert.equal(availabilityBlocker({ status: 'allowed' }), undefined);
  assert.doesNotMatch(availabilityProps('git:C:/service with spaces', missing)['aria-describedby']!, /\s/);
});

test('inline diagnostic envelopes redact secrets while Issue drafts and Git commit messages stay exact', () => {
  assert.doesNotMatch(sanitizeDiagnostic('Authorization: Bearer private-header'), /private-header/);
  const response = { type: 'snapshot', snapshot: {
    operations: [{ error: 'offline glpat-private', phase: '失敗' }],
    sections: { issues: { error: 'Bearer private' } },
    selectedMergeRequest: { warnings: ['token=private'], request: { description: 'token=private' } },
    skillsContext: { reason: 'plain-secret', installed: { status: 'missing' } },
    draft: { description: 'plain-secret' }, git: { message: 'token=private' }
  } };
  const sanitized = sanitizeFeedbackDiagnostics(response, value => sanitizeDiagnostic(value, ['plain-secret']));
  assert.equal(sanitized.snapshot.operations[0].error, 'offline [redacted]');
  assert.equal(sanitized.snapshot.sections.issues.error, 'Bearer [redacted]');
  assert.equal(sanitized.snapshot.selectedMergeRequest.warnings[0], 'token=[redacted]');
  assert.equal(sanitized.snapshot.skillsContext.reason, '[redacted]');
  assert.equal(sanitized.snapshot.draft.description, 'plain-secret');
  assert.equal(sanitized.snapshot.git.message, 'token=private');
  assert.equal(response.snapshot.operations[0].error, 'offline glpat-private');
});
