import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { readReviewJob } from '../workspace/reviewSessions';
import type { CodexTaskSpec } from './protocol';
import { canonicalRuntime } from './taskValidation';
import { atomicNetworkJson } from '../api/localNetworkLease';
import { legacyIdentityDigest, type ModelRoutingState } from './modelRouting';

const digest = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex');
const same = (a: string, b: string): boolean => process.platform === 'win32' ? path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase() : path.resolve(a) === path.resolve(b);
/** Materialize only authorized runtime roots after execution starts, before Windows sandbox setup. */
export async function prepareReviewWritableRoots(spec: CodexTaskSpec): Promise<void> {
  if (!spec.review) return;
  for (const directory of spec.writableRoots.slice(1)) {
    const canonical = await canonicalRuntime(directory, spec.root);
    if (!same(canonical, directory)) throw new Error('審查 runtime 的實體位置已變更。');
    await mkdir(canonical, { recursive: true });
    if (!same(await realpath(canonical), canonical)) throw new Error('審查 runtime 的實體位置已變更。');
  }
}
/** Import usable navigation only after fixed identity validation, while the reviewer is stopped. */
export async function importLegacyReviewCheckpoint(spec: CodexTaskSpec, saved: Pick<ModelRoutingState, 'execution_checkpoint'>): Promise<void> {
  const checkpoint = saved.execution_checkpoint;
  if (!checkpoint || !spec.review) return;
  const runtime = spec.review.runtimeRoot ?? spec.writableRoots[1];
  const job = await readReviewJob(runtime, spec.review.requestId, spec.review.workspaceRoot ?? spec.root,
    [spec.review.repositoryPath!], spec.review.tool);
  if (!['ready', 'reviewing', 'validating'].includes(job.state)) return;
  const context = path.join(runtime, 'sessions', spec.review.requestId);
  const draft = await readFile(path.join(context, spec.review.tool === 'merge-reviewer' ? 'draft.json' : 'review-result-draft.json'));
  if (digest(draft) !== checkpoint.draft_sha256) return;
  const manifest = JSON.parse(await readFile(path.join(context, 'manifest.json'), 'utf8'));
  if (checkpoint.completed_operation_ids.some(id => !Object.hasOwn(manifest.operations ?? {}, id))) return;
  const native = { completed_operation_ids: checkpoint.completed_operation_ids, unread_evidence: checkpoint.unread_evidence,
    open_questions: checkpoint.open_questions, next_action: checkpoint.next_action, request_id: checkpoint.request_id,
    draft_sha256: checkpoint.draft_sha256, source_identity: legacyIdentityDigest(manifest.repositories.map((row: any) => ({ id: row.id, sources: row.sources ?? {} }))),
    at: new Date().toISOString(), imported_from: checkpoint.schema };
  await atomicNetworkJson(path.join(runtime, 'jobs', spec.review.requestId + '.json'), { ...job, execution_checkpoint: native });
}
function strip(body: string, start: string, end: string, keepMarkers: boolean): string {
  const first = body.indexOf(start), last = body.indexOf(end);
  if (first < 0 && last < 0 && keepMarkers) return body;
  if (first < 0 || last <= first || body.indexOf(start, first + 1) >= 0 || body.indexOf(end, last + 1) >= 0) throw new Error('審查報告的人工紀錄邊界無效。');
  if (keepMarkers && (first > 0 && body[first - 1] !== '\n' || body[last - 1] !== '\n')) throw new Error('審查報告的人工紀錄邊界無效。');
  return keepMarkers ? body.slice(0, first + start.length) + '\n<editable-human-confirmations>\n' + body.slice(last) : body.slice(0, first) + body.slice(last + end.length);
}

/** Local fixed-request inspection; never dispatches a model or captures sources. */
export async function inspectNativeReview(spec: CodexTaskSpec): Promise<{ published: boolean; complete?: boolean; cleanupPending?: boolean; terminal?: boolean; fingerprint: string; reportPath?: string; summary: string;
  timings?: { firstDraftAt: string | null; capturedAt: string | null; publishedAt: number | null; helperSeconds: Record<string, number> } }> {
  if (!spec.review) throw new Error('缺少原生審查識別。');
  const review = spec.review, runtime = review.runtimeRoot ?? spec.routing?.runtimeRoot ?? spec.writableRoots[1];
  const workspace = review.workspaceRoot ?? spec.workflow?.reviewWorkspace ?? spec.root;
  const repository = review.repositoryPath ?? spec.origin?.repositoryRoot ?? (spec.source.kind === 'skill' ? spec.source.inputs[`${spec.source.featureId}.repo`] : undefined);
  if (!runtime || !repository) throw new Error('審查缺少固定 runtime 或 Repo，請重新確認任務。');
  let job;
  try { await lstat(path.join(runtime, 'jobs', review.requestId + '.json')); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { published: false, fingerprint: 'not-started', summary: '尚未建立原生審查。' }; throw error; }
  try { job = await readReviewJob(runtime, review.requestId, workspace, [repository], review.tool); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { published: false, fingerprint: 'not-started', summary: '尚未建立原生審查。' }; throw error; }
  const raw = job as unknown as Record<string, any>;
  const context = path.join(runtime, 'sessions', review.requestId);
  const hashes = await Promise.all(['manifest.json', review.tool === 'merge-reviewer' ? 'draft.json' : 'review-result-draft.json'].map(async file => {
    try { return digest(await readFile(path.join(context, file))); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
  }));
  const fingerprint = digest(JSON.stringify([job.state, hashes, raw.execution_checkpoint]));
  const timings = { firstDraftAt: typeof raw.first_draft_at === 'string' ? raw.first_draft_at : null,
    capturedAt: job.fixed_identity?.capture_completed_at ?? null, publishedAt: typeof raw.finished_at_epoch === 'number' ? raw.finished_at_epoch : null,
    helperSeconds: Object.fromEntries(['step_seconds', 'read_seconds', 'search_seconds', 'check_diagnostic_seconds', 'finish_total_seconds', 'validation_publish_seconds'].flatMap(key =>
      typeof raw.metrics?.[key] === 'number' ? [[key, raw.metrics[key] as number]] : [])) };
  if (job.state !== 'published') return { published: false, terminal: ['failed', 'cancelled'].includes(job.state), fingerprint, timings, summary: '原生審查尚未發布，沿原 request 完成必要證據、草稿與 finish。' };
  if (!job.report_path) throw new Error('發布紀錄缺少報告。');
  const info = await lstat(job.report_path), actual = await realpath(job.report_path);
  if (!info.isFile() || info.isSymbolicLink() || info.size > 8 * 1024 * 1024 || !same(path.dirname(actual), await realpath(path.join(repository, 'review-reports')))) throw new Error('發布報告路徑無效。');
  let body = await readFile(actual, 'utf8');
  if (review.tool === 'merge-reviewer') {
    if (raw.report_receipt?.policy === 'merge-report-static-body/v1') {
      if (digest(strip(body, '<!-- merge-confirmations:start -->', '<!-- merge-confirmations:end -->', true)) !== raw.report_receipt.static_body_sha256) throw new Error('報告收據與內容不符。');
      if (raw.review_outcome && raw.report_receipt.review_outcome && JSON.stringify(raw.review_outcome) !== JSON.stringify(raw.report_receipt.review_outcome)) throw new Error('報告與審查結果不符。');
    } else if (raw.report_receipt != null) throw new Error('不支援的原生報告收據。');
    else if (digest(body) !== raw.report_sha256) throw new Error('報告收據與內容不符。');
  } else {
    // Release's native read_text normalizes newlines and hashes the full report,
    // including its metadata marker, excluding only the human Checklist block.
    body = body.replace(/\r\n?/g, '\n');
    if (digest(strip(body, '<!-- release-checklist:start -->', '<!-- release-checklist:end -->', false)) !== raw.report_static_sha256) throw new Error('上版報告收據與內容不符。');
  }
  const outcome = raw.review_outcome ?? raw.report_receipt?.review_outcome;
  const complete = outcome?.schema === (review.tool === 'merge-reviewer' ? 'MergeReviewOutcome/v1' : 'ReleaseReviewOutcome/v1') && outcome.review_complete === true &&
    (review.tool === 'release-reviewer' || outcome.outcome_available === true);
  return { published: true, complete, cleanupPending: job.cleanup_pending === true, fingerprint, timings, reportPath: job.report_path, summary: complete ? '報告已發布，原生審查完整。' : '報告已發布，仍有必要缺口；請查看報告。' };
}
