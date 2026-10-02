import { createHash } from 'node:crypto';

export interface MergeReviewIdentity {
  origin: string; projectId: number; mrIid: number; sourceProjectId: number; targetProjectId: number;
  sourceBranch: string; targetBranch: string; sourceSha: string; targetSha: string;
}
export interface MergeReviewReportMetadata extends MergeReviewIdentity {
  schema: 'MergeReviewReport/v1'; bodySha256: string; contextSha256: string;
  comparisonBaseSha: string; mode: 'merge' | 'direct'; repoPath: string; reviewComplete: boolean;
}
export interface ImportedMergeReviewReport { text: string; body: string; metadata: MergeReviewReportMetadata; }
const MARKER = /(?:\r?\n)*<!-- merge-review-report:([A-Za-z0-9+/=]+) -->[ \t\r\n]*$/;
const SHA = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;

export function normalizedReportBody(body: string): string {
  return body.replace(/\r\n/g, '\n').replace(/\r/g, '\n').replace(/^[ \t\n]+|[ \t\n]+$/g, '');
}

export function parseMergeReviewReport(text: string): ImportedMergeReviewReport {
  if (typeof text !== 'string' || text.length > 2_000_000) throw new Error('審查報告格式或大小無效。');
  let body: string;
  let metadata: MergeReviewReportMetadata;
  if (text.trimStart().startsWith('{')) {
    const value = JSON.parse(text) as { report_metadata?: MergeReviewReportMetadata; report_body?: string };
    if (typeof value.report_body !== 'string' || !value.report_metadata) throw new Error('JSON 缺少報告正文與版本中繼資料。');
    body = normalizedReportBody(value.report_body); metadata = value.report_metadata;
  } else {
    const match = MARKER.exec(text);
    if (!match) throw new Error('此報告沒有 MergeReviewReport/v1 中繼資料；可作一般留言，請重新產生報告後匯入。');
    metadata = JSON.parse(Buffer.from(match[1], 'base64').toString('utf8')) as MergeReviewReportMetadata;
    body = normalizedReportBody(text.slice(0, match.index));
  }
  if (!metadata || metadata.schema !== 'MergeReviewReport/v1' || typeof metadata.origin !== 'string' ||
      !/^https?:\/\//.test(metadata.origin) || ['projectId', 'mrIid', 'sourceProjectId', 'targetProjectId'].some((key) => {
        const id = metadata[key as keyof MergeReviewReportMetadata]; return typeof id !== 'number' || !Number.isSafeInteger(id) || id <= 0;
      }) || metadata.projectId !== metadata.targetProjectId ||
      !SHA.test(metadata.sourceSha) || !SHA.test(metadata.targetSha) || !SHA.test(metadata.comparisonBaseSha) ||
      !/^[a-f0-9]{64}$/.test(metadata.contextSha256) || !/^[a-f0-9]{64}$/.test(metadata.bodySha256) ||
      typeof metadata.reviewComplete !== 'boolean' || !metadata.repoPath || !metadata.sourceBranch || !metadata.targetBranch ||
      !['merge', 'direct'].includes(metadata.mode) || !body || createHash('sha256').update(body).digest('hex') !== metadata.bodySha256) {
    throw new Error('報告版本中繼資料或正文摘要不符；請重新產生或匯入原始報告。');
  }
  const marker = Buffer.from(JSON.stringify(metadata), 'utf8').toString('base64');
  return { body, metadata, text: `${body}\n\n<!-- merge-review-report:${marker} -->\n` };
}

export function validateReportIdentity(report: ImportedMergeReviewReport, expected: MergeReviewIdentity): void {
  const keys: Array<keyof MergeReviewIdentity> = ['origin', 'projectId', 'mrIid', 'sourceProjectId', 'targetProjectId',
    'sourceBranch', 'targetBranch', 'sourceSha', 'targetSha'];
  if (keys.some((key) => report.metadata[key] !== expected[key])) throw new Error('報告不屬於目前 MR，或來源／目標版本已變更；請重新審查。');
}
