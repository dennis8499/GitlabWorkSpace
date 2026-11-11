import { lstat, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import type { ReviewerToolId } from '../workspace/reviewSessionProtocol';

import { routingModel, routingEfforts, validModelEfforts, autoEfforts, selectRoutingEffort, type RoutingEffort, type RequestedEffort,
  type ModelRoutingBinding, type ModelRoutingHistory } from './modelRoutingProtocol';
export { routingModel, routingEfforts } from './modelRoutingProtocol';
export type { ModelRoutingBinding } from './modelRoutingProtocol';
export interface ModelRoutingState {
  schema: 'ReviewModelRouting/v1' | 'ReviewModelRouting/v2';
  tool: ReviewerToolId;
  request_id: string;
  runtime_root: string;
  context_dir: string;
  draft_path?: string;
  files?: Record<string, string>;
  input_digest: string;
  snapshot_hash: string;
  fixed_sources: Record<string, unknown>;
  requested_effort: RequestedEffort;
  model: string;
  supported_efforts?: string[];
  recommended_effort?: string;
  capped?: boolean;
  effort: RoutingEffort | null;
  phase: 'routing' | 'reviewing' | 'complete';
  reason: string;
  checkpoint: string;
  history: ModelRoutingHistory[];
  revision: number;
  report_path?: string;
  nativeState?: 'failed' | 'cancelled';
  execution_checkpoint?: { schema: 'ReviewExecutionCheckpoint/v1'; request_id: string; snapshot_hash: string; draft_sha256: string;
    completed_operation_ids: string[]; unread_evidence: string[]; open_questions: string[]; next_action: string };
}
export function requestedEffort(value: unknown = 'auto'): RequestedEffort {
  if (typeof value === 'string' && /^[a-z][a-z0-9_-]{0,39}$/.test(value)) return value;
  throw new Error('思考強度格式無效。');
}
const samePath = (a: string, b: string): boolean => process.platform === 'win32'
  ? path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase() : path.resolve(a) === path.resolve(b);
async function plainFile(filename: string, maximum = 4 * 1024 * 1024): Promise<string> {
  for (let probe = path.resolve(filename); ;) {
    const info = await lstat(probe).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'ENOENT') throw error; return undefined; });
    if (info?.isSymbolicLink()) throw new Error('Model Routing 路徑不可包含連結。');
    const parent = path.dirname(probe); if (parent === probe) break; probe = parent;
  }
  const info = await lstat(filename);
  if (!info.isFile() || info.size > maximum) throw new Error('Model Routing 檔案格式或大小無效。');
  return readFile(filename, 'utf8');
}
export async function readModelRouting(binding: ModelRoutingBinding): Promise<ModelRoutingState | undefined> {
  return readModelRoutingRecord(binding, false);
}
/** Audit reads retain routing history after native termination; they never authorize dispatch. */
export async function inspectModelRouting(binding: ModelRoutingBinding): Promise<ModelRoutingState | undefined> {
  return readModelRoutingRecord(binding, true);
}
async function readModelRoutingRecord(binding: ModelRoutingBinding, allowTerminal: boolean): Promise<ModelRoutingState | undefined> {
  const filename = path.join(binding.runtimeRoot, 'routing', binding.tool, binding.requestId + '.json');
  let text: string;
  try { text = await plainFile(filename); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
  const value = JSON.parse(text) as ModelRoutingState;
  const efforts: readonly string[] = binding.supportedEfforts ?? routingEfforts;
  const dynamic = binding.model !== undefined && binding.supportedEfforts !== undefined;
  if (value.schema !== (dynamic ? 'ReviewModelRouting/v2' : 'ReviewModelRouting/v1') ||
      dynamic && (!validModelEfforts(value.supported_efforts) || JSON.stringify(value.supported_efforts) !== JSON.stringify(binding.supportedEfforts)) ||
      value.tool !== binding.tool || value.request_id !== binding.requestId ||
      !samePath(value.runtime_root, binding.runtimeRoot) || value.requested_effort !== binding.requestedEffort ||
      value.model !== (binding.model ?? routingModel) || !['routing', 'reviewing', 'complete'].includes(value.phase) ||
      !Number.isSafeInteger(value.revision) || value.revision < 0 ||
      value.effort !== null && !efforts.includes(value.effort) ||
      value.phase !== 'routing' && value.effort === null ||
      !Array.isArray(value.history) || value.history.length > efforts.length ||
      value.history.some((entry, index) => !efforts.includes(entry.effort) || typeof entry.reason !== 'string' ||
        index > 0 && autoEfforts(efforts).indexOf(entry.effort) <= autoEfforts(efforts).indexOf(value.history[index - 1].effort)) ||
      typeof value.reason !== 'string' || typeof value.checkpoint !== 'string' || !/^[a-f0-9]{64}$/.test(value.snapshot_hash)) {
    throw new Error('Model Routing 紀錄與目前審查不符，請核對原始 session。');
  }
  if (dynamic && binding.requestedEffort === 'auto' && value.effort !== null) {
    const selected = selectRoutingEffort(value.recommended_effort ?? '', efforts);
    if (selected.effort !== value.effort || selected.capped !== value.capped) throw new Error('Model Routing 自動強度與模型能力不符。');
  }
  if (value.execution_checkpoint !== undefined) {
    const checkpoint = value.execution_checkpoint;
    const texts = (items: unknown, maximum: number, length: number): boolean => Array.isArray(items) && items.length <= maximum &&
      items.every(item => typeof item === 'string' && !!item.trim() && item.length <= length) && new Set(items).size === items.length;
    if (!checkpoint || checkpoint.schema !== 'ReviewExecutionCheckpoint/v1' || checkpoint.request_id !== binding.requestId ||
        checkpoint.snapshot_hash !== value.snapshot_hash || !/^[a-f0-9]{64}$/.test(checkpoint.draft_sha256) ||
        !texts(checkpoint.completed_operation_ids, 1000, 200) || !texts(checkpoint.unread_evidence, 200, 2000) ||
        !texts(checkpoint.open_questions, 100, 2000) || typeof checkpoint.next_action !== 'string' || !checkpoint.next_action.trim() ||
        checkpoint.next_action.length > 4000) throw new Error('Model Routing checkpoint 與固定審查不符或格式無效。');
  }
  const job = JSON.parse(await plainFile(path.join(binding.runtimeRoot, 'jobs', binding.requestId + '.json')));
  if (job.schema !== (binding.tool === 'merge-reviewer' ? 'MergeReviewSession/v1' : 'ReleaseReviewSession/v1') ||
      job.request_id !== binding.requestId || job.input_digest !== value.input_digest ||
      !samePath(job.context_dir, value.context_dir) || !samePath(value.context_dir, path.join(binding.runtimeRoot, 'sessions', binding.requestId)) ||
      !['ready', 'reviewing', 'validating', 'published', ...(allowTerminal ? ['failed', 'cancelled'] : [])].includes(job.state) ||
      binding.requestedEffort !== 'auto' && value.effort !== binding.requestedEffort ||
      value.phase === 'complete' && (job.state !== 'published' || !job.report_path || job.report_path !== value.report_path)) {
    throw new Error('Model Routing 的原生審查已停止或固定身分不符，請保留診斷後核對。');
  }
  if (!value.fixed_sources || legacyIdentityDigest(value.fixed_sources) !== value.snapshot_hash) throw new Error('舊審查的固定來源紀錄已損壞。');
  try {
    const manifest = JSON.parse(await plainFile(path.join(value.context_dir, 'manifest.json'), 64 * 1024 * 1024));
    const identity: Record<string, unknown> = { input_digest: job.input_digest, repositories: manifest.repositories.map((repo: any) => ({
      id: repo.id, sources: Object.fromEntries(Object.entries(repo.sources ?? {}).filter(([, source]) => source && typeof source === 'object' && !Array.isArray(source))
        .map(([name, source]) => [name, (source as any).ref ?? null])), snapshot_sources: Object.keys(repo.snapshot?.sources ?? {}).sort()
    })) };
    for (const key of ['base_sha', 'head_sha', 'merge_base', 'diff_base', 'selected_repo', 'entry_repo']) if (Object.hasOwn(manifest, key)) identity[key] = manifest[key];
    if (legacyIdentityDigest(identity) !== value.snapshot_hash) throw new Error('舊審查的固定快照已變更。');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || !['published', 'failed', 'cancelled'].includes(job.state)) throw error;
  }
  return ['failed', 'cancelled'].includes(job.state) ? { ...value, nativeState: job.state } : value;
}
/** Matches the historical Python identity digest; only used to authenticate old records. */
export function legacyIdentityDigest(value: unknown): string {
  const ordered = (item: any): any => Array.isArray(item) ? item.map(ordered) : item && typeof item === 'object'
    ? Object.fromEntries(Object.keys(item).sort().map(key => [key, ordered(item[key])])) : item;
  return createHash('sha256').update(JSON.stringify(ordered(value))).digest('hex');
}
// Legacy records are read-only; new requests use the native Reviewer.
