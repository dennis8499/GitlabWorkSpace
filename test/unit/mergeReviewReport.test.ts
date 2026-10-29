import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { canonicalSha256, parseMergeReviewReport, validateReportIdentity, type MergeReviewReportMetadata, type MergeReviewTask } from '../fixtures/legacy-review/mergeReviewReport';

const body = '# 審查報告\n\n部分範圍尚未確認，已發現 P1 問題。';
const task: MergeReviewTask = {
  schema: 'MergeReviewTask/v2', origin: 'https://gitlab.example/gitlab', projectId: 10, mrIid: 3,
  sourceProjectId: 20, targetProjectId: 10, sourceBranch: 'feature/中文', targetBranch: 'main',
  sourceSha: 'a'.repeat(40), targetSha: 'b'.repeat(40), groupRoot: 'C:/Group', repoPath: 'C:/Group/service--10',
  sourceRemoteUrl: 'https://gitlab.example/gitlab/source.git', targetRemoteUrl: 'https://gitlab.example/gitlab/target.git', mode: 'merge'
};
const metadata: MergeReviewReportMetadata = {
  schema: 'MergeReviewReport/v2', origin: 'https://gitlab.example/gitlab', projectId: 10, mrIid: 3,
  sourceProjectId: 20, targetProjectId: 10, sourceBranch: 'feature/中文', targetBranch: 'main',
  sourceSha: 'a'.repeat(40), targetSha: 'b'.repeat(40), comparisonBaseSha: 'c'.repeat(40),
  bodySha256: createHash('sha256').update(body).digest('hex'), contextSha256: 'd'.repeat(64),
  repoPath: task.repoPath, groupRoot: task.groupRoot, mode: 'merge', reviewComplete: false,
  contextSchema: 'merge-reviewer-workspace-context/v2', scope: 'group', task, taskSha256: canonicalSha256(task), bindingSha256: ''
};
metadata.bindingSha256 = canonicalSha256(Object.fromEntries(Object.entries(metadata).filter(([key]) => key !== 'bindingSha256')));
const markdown = `${body}\n\n<!-- merge-review-report:${Buffer.from(JSON.stringify(metadata)).toString('base64')} -->\n`;

test('imports the same bound Markdown or JSON, allowing incomplete reports and CRLF clipboard text', () => {
  const pasted = parseMergeReviewReport(markdown.replace(/\n/g, '\r\n'));
  const json = parseMergeReviewReport(JSON.stringify({ report_metadata: metadata, report_body: body }));
  assert.deepEqual(pasted, json);
  assert.equal(pasted.metadata.reviewComplete, false);
  validateReportIdentity(pasted, metadata);
});

test('rejects edited report bodies and unverified legacy text', () => {
  assert.throws(() => parseMergeReviewReport(markdown.replace('P1', 'P0')), /正文摘要/);
  assert.throws(() => parseMergeReviewReport(body), /沒有 MergeReviewReport/);
});

test('binds instance, MR, source/target projects and both current branch SHAs', () => {
  const report = parseMergeReviewReport(markdown);
  for (const patch of [{ origin: 'https://other.example' }, { mrIid: 4 }, { projectId: 11, targetProjectId: 11 },
    { sourceProjectId: 21 }, { sourceSha: 'e'.repeat(40) }, { targetSha: 'f'.repeat(40) }]) {
    assert.throws(() => validateReportIdentity(report, { ...metadata, ...patch }), /目前 MR/);
  }
});

test('binds authoritative Group and actual Repo without parent inference', () => {
  const report = parseMergeReviewReport(markdown);
  assert.throws(() => validateReportIdentity(report, { ...metadata, groupRoot: 'C:/other' }), /Group/);
  assert.throws(() => validateReportIdentity(report, { ...metadata, repoPath: 'C:/Group/other' }), /Repo/);
});

test('protects completeness, scope, priorities, task, context and receipt metadata', () => {
  for (const patch of [{ reviewComplete: true }, { scope: 'repo' }, { priorityCounts: { P0: 0, P1: 0 } },
    { contextSha256: 'e'.repeat(64) }, { task: { ...task, targetSha: 'f'.repeat(40) } },
    { external_binding: { schema: 'unsupported-review-binding/v1', receipt_sha256: '0'.repeat(64) } }]) {
    assert.throws(() => parseMergeReviewReport(JSON.stringify({ report_body: body, report_metadata: { ...metadata, ...patch } })), /摘要/);
  }
  assert.throws(() => parseMergeReviewReport(JSON.stringify({ report_body: body,
    report_metadata: { ...metadata, schema: 'MergeReviewReport/v1' } })), /摘要/);
});
