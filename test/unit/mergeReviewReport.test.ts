import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { parseMergeReviewReport, validateReportIdentity, type MergeReviewReportMetadata } from '../../src/workspace/mergeReviewReport';

const body = '# 審查報告\n\n部分範圍尚未確認，已發現 P1 問題。';
const metadata: MergeReviewReportMetadata = {
  schema: 'MergeReviewReport/v1', origin: 'https://gitlab.example/gitlab', projectId: 10, mrIid: 3,
  sourceProjectId: 20, targetProjectId: 10, sourceBranch: 'feature/中文', targetBranch: 'main',
  sourceSha: 'a'.repeat(40), targetSha: 'b'.repeat(40), comparisonBaseSha: 'c'.repeat(40),
  bodySha256: createHash('sha256').update(body).digest('hex'), contextSha256: 'd'.repeat(64),
  repoPath: 'C:\Group\service--10', mode: 'merge', reviewComplete: false
};
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
