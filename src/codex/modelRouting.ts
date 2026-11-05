import { createHash } from 'node:crypto';
import { lstat, readFile } from 'node:fs/promises';
import path from 'node:path';
import type { CodexAppServer } from './appServer';
import type { ReviewerToolId } from '../workspace/reviewSessionProtocol';

import { routingModel, routingEfforts, type RoutingEffort, type RequestedEffort,
  type ModelRoutingBinding, type ModelRoutingHistory, type ModelRoutingSummary } from './modelRoutingProtocol';
export { routingModel, routingEfforts } from './modelRoutingProtocol';
export type { ModelRoutingBinding } from './modelRoutingProtocol';
export interface ModelRoutingState {
  schema: 'ReviewModelRouting/v1';
  tool: ReviewerToolId;
  request_id: string;
  runtime_root: string;
  context_dir: string;
  draft_path?: string;
  files?: Record<string, string>;
  input_digest: string;
  snapshot_hash: string;
  requested_effort: RequestedEffort;
  model: typeof routingModel;
  effort: RoutingEffort | null;
  phase: 'routing' | 'reviewing' | 'complete';
  reason: string;
  checkpoint: string;
  history: ModelRoutingHistory[];
  revision: number;
  report_path?: string;
}
export function requestedEffort(value: unknown = 'auto'): RequestedEffort {
  if (value === 'auto' || routingEfforts.includes(value as RoutingEffort)) return value as RequestedEffort;
  throw new Error('思考強度須為 auto、low、medium、high、xhigh 或 max。');
}
const samePath = (a: string, b: string): boolean => process.platform === 'win32'
  ? path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase() : path.resolve(a) === path.resolve(b);
async function plainFile(filename: string): Promise<string> {
  for (let probe = path.resolve(filename); ;) {
    const info = await lstat(probe).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'ENOENT') throw error; return undefined; });
    if (info?.isSymbolicLink()) throw new Error('Model Routing 路徑不可包含連結。');
    const parent = path.dirname(probe); if (parent === probe) break; probe = parent;
  }
  const info = await lstat(filename);
  if (!info.isFile() || info.size > 4 * 1024 * 1024) throw new Error('Model Routing 檔案格式或大小無效。');
  return readFile(filename, 'utf8');
}
export async function modelRoutingBinding(root: string, tool: ReviewerToolId, runtimeRoot: string,
  requestId: string, effort?: unknown): Promise<ModelRoutingBinding> {
  if (!/^[a-f0-9]{32}$/.test(requestId)) throw new Error('Model Routing request ID 無效。');
  const directory = path.join(root, '.agents/skills/model-routing');
  const hash = createHash('sha256');
  let reviewerInstructions = '';
  for (const relative of ['SKILL.md', 'scripts/routing.py', 'references/routing-policy.md', 'references/execution.md', 'references/reviewer-execution.md']) {
    const content = await plainFile(path.join(directory, relative));
    if (relative === 'references/reviewer-execution.md') reviewerInstructions = content;
    hash.update(relative).update('\0').update(content).update('\0');
  }
  if (effort === undefined) {
    try { effort = JSON.parse(await plainFile(path.join(runtimeRoot, 'routing', tool, requestId + '.json'))).requested_effort; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  return { tool, requestId, runtimeRoot, requestedEffort: requestedEffort(effort),
    skillPath: path.join(directory, 'SKILL.md'), payloadHash: hash.digest('hex'), reviewerInstructions };
}
export async function readModelRouting(binding: ModelRoutingBinding): Promise<ModelRoutingState | undefined> {
  const filename = path.join(binding.runtimeRoot, 'routing', binding.tool, binding.requestId + '.json');
  let text: string;
  try { text = await plainFile(filename); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
  const value = JSON.parse(text) as ModelRoutingState;
  if (value.schema !== 'ReviewModelRouting/v1' || value.tool !== binding.tool || value.request_id !== binding.requestId ||
      !samePath(value.runtime_root, binding.runtimeRoot) || value.requested_effort !== binding.requestedEffort ||
      value.model !== routingModel || !['routing', 'reviewing', 'complete'].includes(value.phase) ||
      !Number.isSafeInteger(value.revision) || value.revision < 0 ||
      value.effort !== null && !routingEfforts.includes(value.effort) ||
      value.phase !== 'routing' && value.effort === null ||
      !Array.isArray(value.history) || value.history.length > routingEfforts.length ||
      value.history.some((entry, index) => !routingEfforts.includes(entry.effort) || typeof entry.reason !== 'string' ||
        index > 0 && routingEfforts.indexOf(entry.effort) <= routingEfforts.indexOf(value.history[index - 1].effort)) ||
      typeof value.reason !== 'string' || typeof value.checkpoint !== 'string' || !/^[a-f0-9]{64}$/.test(value.snapshot_hash)) {
    throw new Error('Model Routing 紀錄與目前審查不符，請核對原始 session。');
  }
  const job = JSON.parse(await plainFile(path.join(binding.runtimeRoot, 'jobs', binding.requestId + '.json')));
  if (job.schema !== (binding.tool === 'merge-reviewer' ? 'MergeReviewSession/v1' : 'ReleaseReviewSession/v1') ||
      job.request_id !== binding.requestId || job.input_digest !== value.input_digest ||
      !samePath(job.context_dir, value.context_dir) || !samePath(value.context_dir, path.join(binding.runtimeRoot, 'sessions', binding.requestId)) ||
      !['ready', 'reviewing', 'validating', 'published'].includes(job.state) ||
      binding.requestedEffort !== 'auto' && value.effort !== binding.requestedEffort ||
      value.phase === 'complete' && (job.state !== 'published' || !job.report_path || job.report_path !== value.report_path)) {
    throw new Error('Model Routing 的原生審查已停止或固定身分不符，請保留診斷後核對。');
  }
  return value;
}
export async function requireRoutingEffort(client: CodexAppServer, effort: RoutingEffort): Promise<void> {
  let cursor: string | undefined;
  const visited = new Set<string>();
  do {
    const page = await client.request('model/list', { limit: 100, includeHidden: true, ...(cursor ? { cursor } : {}) });
    const model = page.data?.find((entry: any) => entry.model === routingModel || entry.id === routingModel);
    if (model) {
      if (!model.supportedReasoningEfforts?.some((entry: any) => entry.reasoningEffort === effort)) {
        throw new Error(`目前 Codex 不支援 GPT-6 Luna ${effort}；已保留審查進度，請核對模型設定。`);
      }
      return;
    }
    cursor = page.nextCursor ?? undefined;
    if (cursor && visited.has(cursor)) throw new Error('Codex 模型目錄分頁無法完成。');
    if (cursor) visited.add(cursor);
  } while (cursor);
  throw new Error('目前 Codex 未提供 GPT-6 Luna；已保留審查進度，請核對模型設定。');
}
export function routingSummary(binding: ModelRoutingBinding, state?: ModelRoutingState): ModelRoutingSummary {
  return { model: routingModel, requestedEffort: binding.requestedEffort, effort: state?.effort ?? undefined,
    phase: !state || state.phase === 'routing' ? 'assessing' : state.phase,
    reason: state?.reason ?? '', history: state?.history ?? [], reportPath: state?.report_path };
}
export function routingTurnPrompt(binding: ModelRoutingBinding, phase: 'assess' | 'review', original: string, state?: ModelRoutingState): string {
  return `${phase === 'review' ? '$' + binding.tool + ' routing_role=reviewer' : '$model-routing'} routing_adapter=workbench routing_phase=${phase} effort=${binding.requestedEffort}\n` +
    `tool=${binding.tool}; request_id=${binding.requestId}; runtime_root=${JSON.stringify(binding.runtimeRoot)}\n` +
    (phase === 'assess' ? '先讀已安裝 model-routing 的 SKILL.md 與 references/execution.md。'
      : '先讀原生 Reviewer Skill 的審查規則及 authoring 文件；Routing 操作參考 model-routing 的 references/execution.md。') +
    '沿用既有 native job、固定 SHA 與草稿；只有尚無 job 才依下列原始指令 capture 一次。\n' +
    (phase === 'assess' ? '本輪只固定證據、bind、依內容判斷並儲存 decide，然後回傳 action=review。\n'
      : '本輪是已路由的正式審查，assessment 已結束。由目前 Agent 完成原生 Reviewer 的完整證據審查、草稿、check 與 finish；先 status 並讀 routing checkpoint，重核受新風險影響的既有判斷。只有兩種成功出口：原生 finish 收據核對後執行 routing.py complete，再回傳 action=complete；或先保存草稿及 routing.py escalate，再回傳 action=escalate。單獨讀取 status 不完成本輪。\n') +
    (state ? '已保存的交接資料（路徑照原樣使用）：' + JSON.stringify({ context_dir: state.context_dir, revision: state.revision,
      draft_path: state.draft_path ?? path.join(state.context_dir, binding.tool === 'merge-reviewer' ? 'draft.json' : 'review-result-draft.json'),
      files: state.files ?? { manifest: path.join(state.context_dir, 'manifest.json'),
        ...(binding.tool === 'merge-reviewer' ? { native_start: path.join(state.context_dir, 'start.json'), initial_reads: path.join(state.context_dir, 'initial-reads.json') }
          : { worklist: path.join(state.context_dir, 'review-worklist.json') }) },
      snapshot_hash: state.snapshot_hash, effort: state.effort, checkpoint: state.checkpoint }) + '\n'
      : phase === 'review' ? `本次為手動強度 ${binding.requestedEffort}。先檢查原生 job 是否存在；尚無 job 時依原生 Skill start 一次。接著執行已安裝 model-routing/scripts/routing.py bind --tool ${binding.tool} --runtime-root ${JSON.stringify(binding.runtimeRoot)} --request-id ${binding.requestId} --effort ${binding.requestedEffort}，使用 bind 回傳的 context、draft、files 與 revision 繼續本輪正式審查；不執行自動判斷。\n` : '') +
    (phase === 'assess' ? '不建立子 Agent。先保存 decide，本輪結尾只回傳 {"action":"review","request_id":"本次 ID"}。'
      : '不建立子 Agent。直接完成原生審查與草稿；可恢復的 authoring／coverage 錯誤要沿同一 request 修正。完成並保存 routing complete 後交付報告連結與重點；升級前必須保存 routing escalate。') +
    '\n\n原始審查指令：\n' + original;
}
export const routingAssessmentOutputSchema = { type: 'object', properties: {
  action: { type: 'string', enum: ['review'] }, request_id: { type: 'string' }
}, required: ['action', 'request_id'], additionalProperties: false };

/** The shared runner's native-session cache must be writable outside the Repo. */
export function reviewerRunnerRuntime(nativeRuntime: string): string {
  const resolved = path.resolve(nativeRuntime);
  return path.join(path.dirname(resolved), path.basename(resolved) + '-workflow-kit');
}
