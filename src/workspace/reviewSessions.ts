import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, readdir, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { isDeepStrictEqual, promisify } from 'node:util';
import { atomicNetworkJson, networkRuntimeRoot } from '../api/localNetworkLease';
import type { PythonRuntime } from './pythonRuntime';
import { isReviewerTool, reviewSessionActions, type ReviewerToolId, type ReviewOutcomeSummary, type ReviewSessionSummary, type ReviewBudgetSummary,
  type ReviewProgressSummary,
  type WorkflowKitRunnerBinding } from './reviewSessionProtocol';
import { workflowKitPythonCommand } from './workflowKitRunner';

const exec = promisify(execFile);
const REQUEST_ID = /^[a-f0-9]{32}$/;
const STATES = new Set(['running', 'ready', 'reviewing', 'validating', 'published', 'failed', 'cancelled']);
const canonical = (value: string): string => process.platform === 'win32' ? value.toLowerCase() : value;
const samePath = (first: string, second: string): boolean => canonical(path.resolve(first)) === canonical(path.resolve(second));

const DEFINITIONS = {
  'merge-reviewer': { marker: '.merge-reviewer-runtime.json', runtimeSchema: 'MergeReviewRuntime/v1', jobSchema: 'MergeReviewSession/v1' },
  'release-reviewer': { marker: '.release-reviewer-runtime.json', runtimeSchema: 'ReleaseReviewRuntime/v1', jobSchema: 'ReleaseReviewSession/v1' },
} as const;

export function reviewSessionScript(skillsDirectory: string, tool: ReviewerToolId): string {
  if (!isReviewerTool(tool)) throw new Error('無效的審查工具。');
  return path.join(skillsDirectory, tool, 'scripts', 'review_session.py');
}

interface ReviewJob {
  schema: 'MergeReviewSession/v1' | 'ReleaseReviewSession/v1';
  request_id: string;
  runtime_root: string;
  state: string;
  phase: string;
  updated_at: string;
  inputs: { workspace: string; workspace_file?: string | null; project: string; base: string; head: string };
  context_dir?: string;
  selected_repo?: string;
  evidence_receipt?: { schema?: string; manifest_sha256?: string };
  report_path?: string;
  report_sha256?: string;
  error?: string;
  network_activity?: { fetch_attempt_count?: number };
  pack_cache_hits?: number;
  fixed_identity?: { base_sha?: string; head_sha?: string; capture_completed_at?: string };
  sync_activity?: Array<{ mode?: string; synced_at?: number }>;
  cleanup_pending?: boolean;
  review_outcome?: unknown;
  report_receipt?: { policy?: string; static_body_sha256?: string; review_outcome?: unknown };
  finished_at_epoch?: number;
  budget?: unknown;
  progress?: unknown;
  remaining_counts?: unknown;
  last_check_at?: unknown;
  recoverable?: boolean;
  terminal?: boolean;
  next_action?: string;
  context_retained?: boolean;
}

function inspectionSummary(job: ReviewJob): Pick<ReviewSessionSummary, 'progress' | 'remaining' | 'recovery' | 'lastCheckAt' | 'retainedContext'> {
  const progress = job.progress as Record<string, unknown> | undefined;
  const count = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
  const validationSource = progress?.validation;
  const validation: ReviewProgressSummary['validation'] = validationSource && typeof validationSource === 'object' && !Array.isArray(validationSource)
    ? Object.fromEntries(['repositories', 'contracts', 'searches'].flatMap(key => {
      const value = (validationSource as Record<string, unknown>)[key];
      if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
      const pair = value as Record<string, unknown>;
      if (!count(pair.completed) || !count(pair.total) || pair.completed > pair.total) return [];
      return [[key, { completed: pair.completed, total: pair.total }]];
    })) as ReviewProgressSummary['validation']
    : undefined;
  const current = progress && count(progress.completed) && count(progress.total) && progress.completed <= progress.total ? {
    completed: progress.completed, total: progress.total,
    ...(typeof progress.operation_id === 'string' && progress.completed < progress.total ? { operationId: progress.operation_id } : {}),
    ...(typeof progress.at === 'string' ? { updatedAt: progress.at } : {}),
    ...(typeof progress.stage === 'string' ? { stage: progress.stage } : {}),
    ...(typeof progress.activity === 'string' ? { activity: progress.activity } : {}),
    ...(validation && Object.keys(validation).length ? { validation } : {})
  } : undefined;
  const raw = job.remaining_counts as Record<string, unknown> | undefined;
  const remaining = raw && typeof raw === 'object' && !Array.isArray(raw) ? Object.fromEntries(
    ['changes', 'boundaries', 'parents', 'impacts', 'repositories'].filter(key => count(raw[key])).map(key => [key, raw[key] as number])) : undefined;
  return { progress: current, remaining, lastCheckAt: typeof job.last_check_at === 'string' ? job.last_check_at : undefined,
    retainedContext: job.context_retained === true,
    recovery: { terminal: ['failed', 'cancelled'].includes(job.state) || job.terminal === true,
      recoverable: job.recoverable === true, ...(typeof job.next_action === 'string' ? { nextAction: job.next_action } : {}) } };
}

/** Local display projection only; the native helper enforces the actual checkpoints. */
function budgetSummary(job: ReviewJob, tool: ReviewerToolId): ReviewBudgetSummary | undefined {
  const value = job.budget as Record<string, unknown> | undefined;
  if (!value || value.schema !== 'ReviewBudget/v1' || !['balanced', 'unlimited'].includes(String(value.profile)) ||
    typeof value.started_at_epoch !== 'number' || !Number.isFinite(value.started_at_epoch) ||
    typeof value.repo_count !== 'number' || !Number.isInteger(value.repo_count) || value.repo_count < 1 ||
    value.base_seconds !== (value.repo_count === 1 ? 180 : 360) || typeof value.id !== 'string') return undefined;
  const extension = value.extension as Record<string, unknown> | undefined;
  if (extension && (extension.budget_id !== value.id || extension.additional_seconds !== Number(value.base_seconds) / 2 ||
    typeof extension.update_id !== 'string')) return undefined;
  const terminal = ['published', 'failed', 'cancelled'].includes(job.state);
  const ended = terminal && typeof job.finished_at_epoch === 'number' && Number.isFinite(job.finished_at_epoch)
    ? job.finished_at_epoch : Date.now() / 1000;
  const elapsed = ended - value.started_at_epoch;
  const balanced = value.profile === 'balanced';
  const limit = balanced ? Number(value.base_seconds) + (extension ? Number(extension.additional_seconds) : 0) : undefined;
  // An extension-only update can retain the prior step's wrap-up phase.
  // Project the granted window here; native checkpoints enforce the actual limit.
  let phase: ReviewBudgetSummary['phase'] = elapsed < 0 || (job.phase === 'wrap-up' && !extension) || limit !== undefined && elapsed >= limit
    ? 'wrap-up' : extension ? 'extended-investigation' : 'within-budget';
  if (job.state === 'published') phase = reviewOutcome(job, tool)?.reviewComplete === true ? 'complete' : 'incomplete';
  else if (terminal) phase = 'stopped';
  return { profile: value.profile as ReviewBudgetSummary['profile'], elapsedSeconds: Math.max(0, elapsed),
    ...(balanced ? { baseSeconds: Number(value.base_seconds), limitSeconds: limit,
      remainingSeconds: Math.max(0, limit! - Math.max(0, elapsed)) } : {}), extensionUsed: !!extension, phase };
}

function reviewOutcome(job: ReviewJob, tool: ReviewerToolId): ReviewOutcomeSummary | undefined {
  if (job.state !== 'published') return undefined;
  const receiptOutcome = job.report_receipt?.review_outcome;
  const outcome = (job.review_outcome ?? receiptOutcome) as Record<string, unknown> | undefined;
  const schema = tool === 'merge-reviewer' ? 'MergeReviewOutcome/v1' : 'ReleaseReviewOutcome/v1';
  if (outcome && outcome.schema === schema && outcome.outcome_available === true && typeof outcome.review_complete === 'boolean' &&
      typeof outcome.review_status === 'string' && outcome.review_status.trim() &&
      Array.isArray(outcome.gaps) && outcome.gaps.every(gap => typeof gap === 'string') &&
      (receiptOutcome === undefined || isDeepStrictEqual(outcome, receiptOutcome))) {
    return { reviewComplete: outcome.review_complete, reviewStatus: outcome.review_status, gaps: outcome.gaps };
  }
  return { reviewComplete: null, reviewStatus: 'unknown',
    gaps: ['發布紀錄未保存有效的審查結果摘要，無法確認初次審查完整性。'] };
}

async function plain(file: string): Promise<void> {
  for (let probe = path.resolve(file);;) {
    try { if ((await lstat(probe)).isSymbolicLink()) throw new Error('審查 runtime 不能使用連結或 Junction。'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    const parent = path.dirname(probe);
    if (parent === probe) return;
    probe = parent;
  }
}
async function plainBytes(file: string, maxBytes = 512 * 1024): Promise<Buffer> {
  await plain(file);
  const info = await lstat(file);
  if (!info.isFile() || info.size > maxBytes) throw new Error('審查紀錄格式或大小無效。');
  const bytes = await readFile(file);
  if (bytes.length > maxBytes) throw new Error('審查紀錄格式或大小無效。');
  return bytes;
}
async function json(file: string, maxBytes = 512 * 1024): Promise<any> { return JSON.parse((await plainBytes(file, maxBytes)).toString('utf8')); }
interface FixedReviewIdentity { baseSha: string; headSha: string; capturedAt?: string; }
const fullSha = (value: unknown): value is string => typeof value === 'string' && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value);
const digest = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex');
function fixedPair(value: unknown): FixedReviewIdentity | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return;
  const identity = value as Record<string, unknown>;
  if (fullSha(identity.base_sha) && fullSha(identity.head_sha)) return { baseSha: identity.base_sha, headSha: identity.head_sha,
    ...(typeof identity.capture_completed_at === 'string' ? { capturedAt: identity.capture_completed_at } : {}) };
}
function samePair(first: FixedReviewIdentity, second: FixedReviewIdentity): boolean { return first.baseSha === second.baseSha && first.headSha === second.headSha; }

/** Only the fixed body may supply legacy identity; editable human prose never does. */
async function mergeReportIdentity(job: ReviewJob): Promise<{ identity?: FixedReviewIdentity; hasFixedTable: boolean } | undefined> {
  if (job.state !== 'published' || !job.report_path) return;
  await plain(job.report_path);
  const info = await lstat(job.report_path), actual = await realpath(job.report_path);
  if (!info.isFile() || info.isSymbolicLink() || info.size > 8 * 1024 * 1024 ||
      !samePath(path.dirname(actual), await realpath(path.join(job.inputs.project, 'review-reports')))) return;
  const bytes = await plainBytes(actual, 8 * 1024 * 1024), body = bytes.toString('utf8'); if (!Buffer.from(body, 'utf8').equals(bytes)) return;
  const start = '<!-- merge-confirmations:start -->', end = '<!-- merge-confirmations:end -->';
  const first = body.indexOf(start), last = body.indexOf(end);
  let staticBody = body, fixedBody = body;
  if (first >= 0 || last >= 0) {
    if (first < 0 || last <= first || body.indexOf(start, first + 1) >= 0 || body.indexOf(end, last + 1) >= 0 ||
        first > 0 && body[first - 1] !== '\n' || body[last - 1] !== '\n') return;
    staticBody = body.slice(0, first + start.length) + '\n<editable-human-confirmations>\n' + body.slice(last);
    fixedBody = body.slice(0, first) + body.slice(last + end.length);
  }
  if (job.report_receipt != null) {
    if (job.report_receipt.policy !== 'merge-report-static-body/v1' || digest(staticBody) !== job.report_receipt.static_body_sha256 ||
        job.review_outcome && job.report_receipt.review_outcome && !isDeepStrictEqual(job.review_outcome, job.report_receipt.review_outcome)) return;
  } else if (digest(bytes) !== job.report_sha256) return;
  const lines = fixedBody.split(/\r?\n/), headings = lines.flatMap((line, index) => line === '### 固定版本' ? [index] : []);
  if (headings.length === 0) return { hasFixedTable: false };
  if (headings.length !== 1) return;
  const marked = (value: string): string | undefined => { const fence = /^`+/.exec(value)?.[0];
    if (!fence || !value.endsWith(fence) || value.length < fence.length * 2) return;
    const content = value.slice(fence.length, -fence.length); return content.startsWith(' ') && content.endsWith(' ') ? content.slice(1, -1) : content; };
  const locations = lines.filter(line => line.startsWith('- 本機路徑：')).map(line => marked(line.slice('- 本機路徑：'.length)));
  if (locations.length !== 1 || !locations[0] || !samePath(locations[0], job.inputs.project)) return;
  let index = headings[0] + 1; while (lines[index] === '') index++;
  if (lines[index++] !== '| Repo | 角色 | 來源 | 完整 SHA |' || lines[index++] !== '| --- | --- | --- | --- |') return;
  const selectedName = path.basename(job.inputs.project).replace(/\|/g, '\\|'), sources: Record<string, string> = {};
  for (; lines[index]?.startsWith('|'); index++) {
    const cells = lines[index].split(/(?<!\\)\|/).slice(1, -1).map(cell => cell.trim()); if (cells.length !== 4) return;
    if (cells[1] !== 'seed') continue;
    if (cells[0] !== selectedName) return; // A second selected Repo cannot be mixed into this pair.
    if (!['base', 'head'].includes(cells[2])) continue;
    const reference = marked(cells[3]); if (!fullSha(reference) || Object.hasOwn(sources, cells[2])) return;
    sources[cells[2]] = reference;
  }
  const identity = fixedPair({ base_sha: sources.base, head_sha: sources.head });
  return identity ? { identity, hasFixedTable: true } : undefined;
}

/** Merge v1 keeps refs in its captured manifest, then removes that context on finish. */
export async function readReviewFixedIdentity(job: ReviewJob, root: string, tool: ReviewerToolId): Promise<FixedReviewIdentity | undefined> {
  const provided = Object.hasOwn(job, 'fixed_identity'), fixed = fixedPair(job.fixed_identity);
  if (provided && !fixed) return; // Invalid metadata must not silently fall back to another source.
  if (tool !== 'merge-reviewer') return fixed;
  try {
    const report = job.state === 'published' ? await mergeReportIdentity(job) : undefined;
    if (job.state === 'published' && !report) return;
    // Existing native fixed metadata remains usable with older, receipt-valid
    // renderers. A present version table must agree; it cannot be ignored.
    if (provided) return !report?.hasFixedTable || report.identity && samePair(fixed!, report.identity) ? fixed : undefined;
    if (job.state === 'published' && !report?.identity) return;
    const context = path.join(root, 'sessions', job.request_id);
    if (!job.context_dir || !samePath(job.context_dir, context)) return;
    await plain(context);
    let contextExists = true;
    try { if (!(await lstat(context)).isDirectory()) return; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; contextExists = false; }
    if (!contextExists) return report?.identity; // Only a verified published report survives normal native cleanup.
    const owner = await json(path.join(context, '.merge-reviewer-owned.json'));
    if (owner.schema !== 'merge-reviewer-session/v2' || !samePath(owner.directory, context) || !samePath(owner.runtime, root) ||
        owner.request_id !== job.request_id || !/^[a-f0-9]{32}$/.test(owner.token ?? '')) return;
    const manifestBytes = await plainBytes(path.join(context, 'manifest.json'), 64 * 1024 * 1024), manifest = JSON.parse(manifestBytes.toString('utf8'));
    if (job.evidence_receipt?.schema !== 'MergeReviewEvidenceReceipt/v1' || digest(manifestBytes) !== job.evidence_receipt.manifest_sha256 ||
        manifest.schema !== 'merge-reviewer-workspace-context/v3' || manifest.request_id !== job.request_id || !samePath(manifest.runtime_root, root) ||
        !samePath(manifest.context_dir, context) || !samePath(manifest.workspace, job.inputs.workspace) || !Array.isArray(manifest.repositories) ||
        typeof manifest.selected_repo !== 'string' || job.selected_repo !== undefined && manifest.selected_repo !== job.selected_repo) return;
    const selected = manifest.repositories.filter((repo: any) => repo.id === manifest.selected_repo);
    if (selected.length !== 1 || selected[0].role !== 'seed' || selected[0].state !== 'captured' || !samePath(selected[0].path, job.inputs.project)) return;
    const repo = selected[0], identity = fixedPair(repo.native);
    if (!identity || repo.native.base_input !== job.inputs.base || repo.native.head_input !== job.inputs.head ||
        repo.sources?.base?.ref !== identity.baseSha || repo.sources?.head?.ref !== identity.headSha || report?.identity && !samePair(identity, report.identity)) return;
    return { ...identity, ...(typeof manifest.capture_completed_at === 'string' ? { capturedAt: manifest.capture_completed_at } : {}) };
  } catch { return; } // Missing or conflicting evidence is unknown, never an authorization to bypass the MR SHA gate.
}
async function ownedRuntime(root: string, tool: ReviewerToolId = 'merge-reviewer'): Promise<boolean> {
  if (!isReviewerTool(tool)) throw new Error('無效的審查工具。');
  try {
    await plain(root);
    const definition = DEFINITIONS[tool];
    const marker = await json(path.join(root, definition.marker));
    if (marker.schema !== definition.runtimeSchema || typeof marker.directory !== 'string' ||
        !samePath(marker.directory, await realpath(root))) throw new Error('審查 runtime 所有權無效。');
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}
export async function readReviewJob(root: string, id: string, workspace: string, repositories: readonly string[],
  tool: ReviewerToolId = 'merge-reviewer'): Promise<ReviewJob> {
  if (!REQUEST_ID.test(id) || !await ownedRuntime(root, tool)) throw new Error('找不到這份本機審查。');
  const job = await json(path.join(root, 'jobs', id + '.json')) as ReviewJob;
  if (job.schema !== DEFINITIONS[tool].jobSchema || job.request_id !== id || !samePath(job.runtime_root, root) ||
      !STATES.has(job.state) || !job.inputs || !samePath(job.inputs.workspace, workspace) ||
      !repositories.some(repo => samePath(repo, job.inputs.project)) ||
      typeof job.updated_at !== 'string' || typeof job.phase !== 'string' ||
      typeof job.inputs.base !== 'string' || typeof job.inputs.head !== 'string') throw new Error('審查紀錄不屬於目前工作區。');
  if (job.report_path && !samePath(path.dirname(job.report_path), path.join(job.inputs.project, 'review-reports'))) throw new Error('審查報告路徑無效。');
  return job;
}
/** A local-only read: never starts capture, Git, API refresh, or directory creation. */
export async function readReviewSessions(root: string, workspace: string, repositories: readonly string[],
  tool: ReviewerToolId = 'merge-reviewer'): Promise<ReviewSessionSummary[]> {
  if (!await ownedRuntime(root, tool)) return [];
  let files: string[];
  try { files = await readdir(path.join(root, 'jobs')); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
  const results: ReviewSessionSummary[] = [];
  for (const name of files.filter(file => REQUEST_ID.test(file.replace(/\.json$/, '')) && file.endsWith('.json')).slice(-1000)) {
    let job: ReviewJob;
    try { job = await readReviewJob(root, name.slice(0, -5), workspace, repositories, tool); }
    catch { continue; } // Another declared workspace may share an explicit runtime.
    const fixed = await readReviewFixedIdentity(job, root, tool);
    results.push({ tool, requestId: job.request_id, repository: path.basename(job.inputs.project), repositoryPath: job.inputs.project,
      base: job.inputs.base, head: job.inputs.head, state: job.state, phase: job.phase, updatedAt: job.updated_at,
      reportPath: job.report_path, error: job.error, fetchCount: job.network_activity?.fetch_attempt_count ?? 0,
      packCacheHits: job.pack_cache_hits ?? 0, cleanupPending: job.cleanup_pending === true,
      reviewOutcome: reviewOutcome(job, tool),
      budget: budgetSummary(job, tool),
      ...inspectionSummary(job),
      baseSha: fixed?.baseSha, headSha: fixed?.headSha, capturedAt: fixed?.capturedAt,
      syncObservations: (job.sync_activity ?? []).filter(row => ['owner', 'joined', 'cached'].includes(row.mode ?? '') &&
        typeof row.synced_at === 'number' && Number.isFinite(row.synced_at)).map(row => ({ mode: row.mode!, at: new Date(row.synced_at! * 1000).toISOString() })) });
  }
  return results.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, 100);
}
export async function cancelReviewSession(root: string, id: string, workspace: string, repositories: readonly string[],
  python: PythonRuntime, skillsDirectory: string, tool: ReviewerToolId = 'merge-reviewer',
  runner?: WorkflowKitRunnerBinding): Promise<void> {
  const job = await readReviewJob(root, id, workspace, repositories, tool);
  if (!reviewSessionActions({ state: job.state, retainedContext: job.context_retained,
    recovery: { terminal: job.terminal === true, recoverable: job.recoverable === true } }).cancel) throw new Error('這份審查已結束，沒有可取消的工作。');
  const script = reviewSessionScript(skillsDirectory, tool);
  await plain(script);
  const command = await workflowKitPythonCommand(python, runner, ['-B', script, 'cancel', '--runtime-root', root, '--request-id', id]);
  await exec(command.executable, command.args,
    { env: python.env, encoding: 'utf8', windowsHide: true, timeout: 15_000, maxBuffer: 64 * 1024 });
}
/** A known Git write invalidates observations, never restarts an existing review. */
export async function invalidateReviewSync(root: string, commonDirectory: string): Promise<void> {
  const common = path.resolve(commonDirectory);
  const key = createHash('sha256').update(JSON.stringify(common)).digest('hex');
  if (await ownedRuntime(root, 'merge-reviewer') || await ownedRuntime(root, 'release-reviewer')) {
    const directory = path.join(root, 'invalidations');
    await plain(directory); await mkdir(directory, { recursive: true });
    await atomicNetworkJson(path.join(directory, key + '.json'), {
      schema: 'MergeReviewInvalidation/v1', at: new Date().toISOString(), nonce: randomUUID(),
    });
  }
  const caches = new Map([[await sharedReviewCacheRoot(root), 'ReviewerSharedCache/v1'],
    [sharedReviewCacheV2Root(), 'ReviewerSharedCache/v2']]);
  for (const [shared, _schema] of caches) {
    try {
      await plain(shared);
      const marker = await json(path.join(shared, '.review-shared-cache.json'));
      if (!['ReviewerSharedCache/v1', 'ReviewerSharedCache/v2'].includes(marker.schema) || typeof marker.directory !== 'string' || !samePath(marker.directory, await realpath(shared)))
        throw new Error('審查共享快取所有權無效。');
      const directory = path.join(shared, 'invalidations');
      await plain(directory); await mkdir(directory, { recursive: true });
      await atomicNetworkJson(path.join(directory, key + '.json'), {
        schema: 'ReviewerSharedInvalidation/v1', at: new Date().toISOString(), nonce: randomUUID(),
      });
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
}

export function sharedReviewCacheV2Root(): string {
  return path.resolve(process.env.REVIEW_SHARED_CACHE_DIR || path.join(networkRuntimeRoot(), 'reviewer-cache-v2'));
}
export function defaultReviewRuntime(workspace: string, tool: ReviewerToolId): string {
  const identity = createHash('sha256').update(JSON.stringify(path.resolve(workspace))).digest('hex').slice(0, 12);
  return path.join(networkRuntimeRoot(), 'r2', identity + (tool === 'merge-reviewer' ? '-m' : '-r'));
}

export function reviewRuntimeCandidates(preferred: string, workspace: string, tool: ReviewerToolId): string[] {
  const legacyCaseRoots = process.platform === 'win32' && /^[a-z]:/i.test(workspace)
    ? [workspace[0].toLowerCase() + workspace.slice(1), workspace[0].toUpperCase() + workspace.slice(1)].map(value => defaultReviewRuntime(value, tool)) : [];
  return [...new Set([preferred, ...legacyCaseRoots, path.join(workspace,
    tool === 'merge-reviewer' ? '.review-runtime' : '.release-review-runtime')].map(root => path.resolve(root)))];
}

/** Old sessions stay at their original root; no migration, capture or network. */
export async function resolveReviewRuntime(preferred: string, id: string, workspace: string,
  repositories: readonly string[], tool: ReviewerToolId): Promise<string> {
  const matches: string[] = [];
  for (const root of reviewRuntimeCandidates(preferred, workspace, tool)) {
    if (!await ownedRuntime(root, tool)) continue;
    try { await readReviewJob(root, id, workspace, repositories, tool); matches.push(root); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  if (matches.length !== 1) throw new Error('審查紀錄不存在或有重複身分，請使用原 runtime 確認。');
  return matches[0];
}

export async function sharedReviewCacheRoot(root: string, override = process.env.REVIEW_SHARED_CACHE_DIR): Promise<string> {
  if (override) return path.resolve(override);
  const resolved = path.resolve(root), name = path.basename(resolved);
  if (name === '.review-runtime' || name === '.release-review-runtime') return path.join(path.dirname(resolved), '.review-shared-cache');
  if (name === 'release-reviewer') {
    return path.join(path.dirname(resolved), '.review-shared-cache');
  }
  if (path.basename(path.dirname(resolved)) === 'r2' && /^[a-f0-9]{12}-[mr]$/.test(name)) {
    return path.join(path.dirname(resolved), '.review-shared-cache');
  }
  return path.join(resolved, '.review-shared-cache');
}

/** A host nonce prevents a new Extension Host from reviving an earlier epoch. */
export function reviewerAuthScope(hostNonce: string, baseUrl: string | undefined,
  accountId: string | undefined, userId: number | undefined, connectionEpoch: number): string {
  return createHash('sha256').update(JSON.stringify([hostNonce, baseUrl, accountId, userId, connectionEpoch])).digest('hex');
}

/** Known credential transitions invalidate observations locally, without Git or API reads. */
export async function invalidateReviewAuth(roots: readonly string[]): Promise<number> {
  const candidates = new Map<string, string>();
  candidates.set(sharedReviewCacheV2Root(), 'ReviewerSharedCache/v2');
  for (const root of new Set(roots)) candidates.set(await sharedReviewCacheRoot(root), 'ReviewerSharedCache/v1');
  let updated = 0;
  for (const [shared, _schema] of candidates) {
    try {
      await plain(shared);
      const marker = await json(path.join(shared, '.review-shared-cache.json'));
      if (!['ReviewerSharedCache/v1', 'ReviewerSharedCache/v2'].includes(marker.schema) || typeof marker.directory !== 'string' || !samePath(marker.directory, await realpath(shared)))
        throw new Error('審查共享快取所有權無效。');
      const directory = path.join(shared, 'invalidations');
      await plain(directory); await mkdir(directory, { recursive: true });
      await atomicNetworkJson(path.join(directory, 'auth.json'), {
        schema: 'ReviewerAuthInvalidation/v1', at: new Date().toISOString(), nonce: randomUUID(),
      });
      updated++;
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  return updated;
}

/** A read that wins admission just before a push must not stay cached after it. */
export async function withReviewSyncInvalidation<T>(roots: readonly string[], commonDirectory: string,
  operation: () => Promise<T>): Promise<T> {
  const invalidate = async (): Promise<void> => {
    for (const root of new Set(roots)) await invalidateReviewSync(root, commonDirectory);
  };
  await invalidate();
  try { return await operation(); }
  finally { await invalidate(); }
}
