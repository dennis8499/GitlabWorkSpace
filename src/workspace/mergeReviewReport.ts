import { createHash } from 'node:crypto';
import path from 'node:path';

export interface MergeReviewIdentity {
  origin: string; projectId: number; mrIid: number; sourceProjectId: number; targetProjectId: number;
  sourceBranch: string; targetBranch: string; sourceSha: string; targetSha: string;
}
export interface MergeReviewReportMetadata extends MergeReviewIdentity {
  schema: 'MergeReviewReport/v2'; bodySha256: string; contextSha256: string;
  comparisonBaseSha: string; mode: 'merge' | 'direct'; repoPath: string; reviewComplete: boolean;
  groupRoot: string; contextSchema: 'merge-reviewer-workspace-context/v2'; scope: 'group' | 'repo';
  task: MergeReviewTask; taskSha256: string; bindingSha256: string;
  megin_binding?: Record<string, unknown>;
}
export interface MergeReviewTask extends MergeReviewIdentity {
  schema: 'MergeReviewTask/v2'; groupRoot: string; repoPath: string;
  sourceRemoteUrl: string; targetRemoteUrl: string; mode: 'merge' | 'direct';
}
export interface ImportedMergeReviewReport { text: string; body: string; metadata: MergeReviewReportMetadata; }
const MARKER = /(?:\r?\n)*<!-- merge-review-report:([A-Za-z0-9+/=]+) -->[ \t\r\n]*$/;
const SHA = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;

export function canonicalSha256(value: unknown): string {
  const canonical = (item: unknown): unknown => Array.isArray(item) ? item.map(canonical)
    : item !== null && typeof item === 'object' ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, entry]) => [key, canonical(entry)])) : item;
  return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
}

function pathKey(value: string): string {
  return /^[a-z]:[\\/]/i.test(value) ? path.win32.normalize(value).toLowerCase() : path.posix.normalize(value);
}

function validTask(task: MergeReviewTask, metadata: MergeReviewReportMetadata): boolean {
  if (!task || task.schema !== 'MergeReviewTask/v2' || typeof task.groupRoot !== 'string' || !task.groupRoot ||
      typeof task.repoPath !== 'string' || !task.repoPath || typeof task.sourceRemoteUrl !== 'string' || !task.sourceRemoteUrl ||
      typeof task.targetRemoteUrl !== 'string' || !task.targetRemoteUrl || !['merge', 'direct'].includes(task.mode)) return false;
  const parser = /^[a-z]:[\\/]/i.test(task.repoPath) ? path.win32 : path.posix;
  if (!parser.isAbsolute(task.repoPath) || !parser.isAbsolute(task.groupRoot) ||
      pathKey(parser.dirname(task.repoPath)) !== pathKey(task.groupRoot) ||
      task.repoPath !== metadata.repoPath || task.groupRoot !== metadata.groupRoot || task.mode !== metadata.mode) return false;
  const keys: Array<keyof MergeReviewIdentity> = ['origin', 'projectId', 'mrIid', 'sourceProjectId', 'targetProjectId',
    'sourceBranch', 'targetBranch', 'sourceSha', 'targetSha'];
  return keys.every(key => task[key] === metadata[key]) &&
    canonicalSha256(task as unknown as Record<string, unknown>) === metadata.taskSha256;
}

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
    if (!match) throw new Error('此報告沒有 MergeReviewReport/v2 中繼資料；可作一般留言，請重新產生報告後匯入。');
    metadata = JSON.parse(Buffer.from(match[1], 'base64').toString('utf8')) as MergeReviewReportMetadata;
    body = normalizedReportBody(text.slice(0, match.index));
  }
  if (!metadata || metadata.schema !== 'MergeReviewReport/v2' || typeof metadata.origin !== 'string' ||
      !/^https?:\/\//.test(metadata.origin) || ['projectId', 'mrIid', 'sourceProjectId', 'targetProjectId'].some((key) => {
        const id = metadata[key as keyof MergeReviewReportMetadata]; return typeof id !== 'number' || !Number.isSafeInteger(id) || id <= 0;
      }) || metadata.projectId !== metadata.targetProjectId ||
      !SHA.test(metadata.sourceSha) || !SHA.test(metadata.targetSha) || !SHA.test(metadata.comparisonBaseSha) ||
      !/^[a-f0-9]{64}$/.test(metadata.contextSha256) || !/^[a-f0-9]{64}$/.test(metadata.bodySha256) ||
      metadata.contextSchema !== 'merge-reviewer-workspace-context/v2' || !['group', 'repo'].includes(metadata.scope) ||
      !validTask(metadata.task, metadata) || metadata.bindingSha256 !== canonicalSha256(
        Object.fromEntries(Object.entries(metadata).filter(([key]) => key !== 'bindingSha256'))
      ) ||
      typeof metadata.reviewComplete !== 'boolean' || !metadata.repoPath || !metadata.sourceBranch || !metadata.targetBranch ||
      !['merge', 'direct'].includes(metadata.mode) || !body || createHash('sha256').update(body).digest('hex') !== metadata.bodySha256) {
    throw new Error('報告版本中繼資料或正文摘要不符；請重新產生或匯入原始報告。');
  }
  const marker = Buffer.from(JSON.stringify(metadata), 'utf8').toString('base64');
  return { body, metadata, text: `${body}\n\n<!-- merge-review-report:${marker} -->\n` };
}

export function validateReportIdentity(report: ImportedMergeReviewReport,
  expected: MergeReviewIdentity & { groupRoot?: string; repoPath?: string }): void {
  const keys: Array<keyof MergeReviewIdentity> = ['origin', 'projectId', 'mrIid', 'sourceProjectId', 'targetProjectId',
    'sourceBranch', 'targetBranch', 'sourceSha', 'targetSha'];
  if (keys.some((key) => report.metadata[key] !== expected[key])) throw new Error('報告不屬於目前 MR，或來源／目標版本已變更；請重新審查。');
  if ((expected.groupRoot && pathKey(expected.groupRoot) !== pathKey(report.metadata.groupRoot)) ||
      (expected.repoPath && pathKey(expected.repoPath) !== pathKey(report.metadata.repoPath))) {
    throw new Error('報告的 Group 或實際 Repo 與目前工作區不同；請重新審查。');
  }
}
