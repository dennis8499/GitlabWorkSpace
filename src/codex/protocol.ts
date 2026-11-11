import type { BmadCommandRequest } from '../workspace/bmadProtocol';
import type { ReviewerToolId } from '../workspace/reviewSessionProtocol';
import type { ModelRoutingBinding, ModelRoutingSummary } from './modelRoutingProtocol';
import type { CodexTaskOrigin, CodexTaskResult, CodexWorkflowBinding } from './workflowProtocol';
export type { CodexTaskOrigin, CodexTaskResult } from './workflowProtocol';
export type { CodexLaunchDraft, CodexLaunchPatch, CodexLaunchCheck } from './launchProtocol';

export interface CodexExecutionSelection { model?: string; effort?: string; modelEfforts?: string[]; }
export type CodexTaskSource = (
  | { kind: 'free'; repository: string; prompt: string; contexts?: CodexContext[] }
  | { kind: 'skill'; featureId: string; inputs: Record<string, string>; revision: string }
  | { kind: 'bmad'; request: BmadCommandRequest }
  | { kind: 'issue'; projectId: number; issueIid: number; isolated?: boolean }
  | { kind: 'project-wiki'; projectId: number; incrementalFrom?: string }
  | { kind: 'merge-request'; projectId: number; iid: number; intent?: 'review' | 'fix-comments'; discussionIds?: string[] }
  | { kind: 'review'; action: 'resume' | 'refresh'; tool: ReviewerToolId; requestId: string; revision: string }) & CodexExecutionSelection & {
    /** Host-resolved repository; launch requests carry an opaque repository id. */
    repository?: string;
    requirement?: string;
    returnTo?: { mode: 'clone' | 'developer' | 'reviewer' | 'sa' | 'bmad'; issueTab?: 'content' | 'relations' | 'time' };
  };
export interface CodexTaskSpec {
  source: CodexTaskSource;
  title: string;
  root: string;
  workspaceKey: string;
  prompt: string;
  skill?: { name: string; path: string };
  writableRoots: string[];
  environmentKey: string;
  review?: { tool: ReviewerToolId; requestId: string; revision: string; runtimeRoot?: string; workspaceRoot?: string; repositoryPath?: string };
  commitReview?: { runtimeRoot: string };
  routing?: ModelRoutingBinding;
  executionRoot?: string;
  origin?: CodexTaskOrigin;
  workflow?: CodexWorkflowBinding;
  model?: string;
  effort?: string;
  contexts?: CodexContext[];
  launch?: { openedAt: number; draftReadyAt?: number; checkedMs?: number; submittedAt?: number };
}
export interface CodexContext { kind: 'selection' | 'file' | 'diff'; path: string; text: string; hash: string; }
export interface CodexApprovalSettings { command: boolean; file: boolean; permissions: boolean; }
export interface CodexRecovery {
  checkedAt: string; execution: 'unknown' | 'not-started' | 'running' | 'completed' | 'failed' | 'interrupted';
  cleanup: 'unknown' | 'confirmed'; publication: 'unknown' | 'not-published' | 'pending' | 'confirmed';
  message: string;
}
export interface CodexProgress {
  phase?: 'preflight' | 'process' | 'readiness' | 'workspace' | 'conversation' | 'executing' | 'verifying' | 'cleanup';
  plan?: Array<{ step: string; status: 'pending' | 'inProgress' | 'completed' }>;
  diff?: string;
  hasDiff?: boolean;
  model?: string;
  effort?: string;
  tokens?: { total: number; input: number; output: number; contextWindow?: number };
  quota?: { usedPercent: number; resetsAt?: number };
  tool?: string;
  waitReason?: 'approval' | 'quota' | 'resource' | 'tool' | 'capacity' | 'storage';
  updatedAt?: string;
}
export interface CodexGoal { objective: string; tokenBudget?: number; timeBudgetSeconds?: number; status?: string; tokensUsed?: number; startedAt?: string; timeUsedSeconds?: number; }
export type CodexTaskStatus = 'queued' | 'starting' | 'running' | 'waiting' | 'pausing' | 'paused' | 'completed' | 'failed' | 'interrupted' | 'uncertain';
export interface CodexTaskControls {
  external: boolean;
  canPause: boolean;
  canResume: boolean;
  canDelete: boolean;
  canAutoAccept: boolean;
  autoAccept: boolean;
  autoAcceptError?: string;
  approvals?: CodexApprovalSettings;
}
export interface CodexTaskState {
  id: string;
  title: string;
  root: string;
  status: CodexTaskStatus;
  workingDirectory?: string;
  isolated?: boolean;
  selection?: CodexExecutionSelection;
  createdAt: string;
  updatedAt: string;
  threadId?: string;
  turnId?: string;
  error?: string;
  review?: CodexTaskSpec['review'];
  modelRouting?: ModelRoutingSummary;
  controls?: CodexTaskControls;
  origin?: CodexTaskOrigin;
  result?: CodexTaskResult;
  revision?: number;
  pinned?: boolean;
  archived?: boolean;
  progress?: CodexProgress;
  recovery?: CodexRecovery;
  goal?: CodexGoal;
  publication?: CodexPublication;
  publications?: Record<string, CodexPublication>;
  blockers?: Array<{ kind: 'approval' | 'resource' | 'capacity' | 'quota' | 'tool' | 'storage' | 'reconcile'; message: string }>;
  primaryAction?: { kind: 'answer' | 'reconcile' | 'results' | 'handoff' | 'resume' | 'pause'; label: string; enabled: boolean; reason?: string };
  queuePosition?: number;
  pendingMessages?: number;
  uncertainMessages?: number;
  messageQueue?: Array<{ id: string; text: string; state: 'queued' | 'sending' | 'uncertain' }>;
}
export interface CodexPublication {
  kind: 'review' | 'reply'; state: 'pending' | 'confirmed' | 'not-published'; key: string;
  discussionId?: string; bodyHash?: string; operationId?: string; error?: string;
}
export function canReprepareCodexTask(task: CodexTaskState): boolean {
  return !!task.origin && ['issue', 'merge-request', 'project-wiki'].includes(task.origin.kind) &&
    ['paused', 'completed', 'failed', 'interrupted'].includes(task.status) && !!task.controls?.canResume && !!task.controls?.canDelete && !task.controls.external &&
    task.result?.state !== 'uncertain' && task.publication?.state !== 'pending' && !Object.values(task.publications ?? {}).some(item => item.state === 'pending') &&
    task.recovery?.cleanup !== 'unknown' && task.recovery?.publication !== 'unknown' && task.recovery?.publication !== 'pending' &&
    !task.uncertainMessages && !task.messageQueue?.some(item => item.state === 'uncertain' || item.state === 'sending');
}
export interface CodexTaskRecord extends Omit<CodexTaskState, 'controls'> {
  schema: 'GitLabWorkspaceCodexTask/v1' | 'GitLabWorkspaceCodexTask/v2';
  spec: CodexTaskSpec;
  ownerPid: number;
  pendingMessage?: string;
  queuedMessages?: Array<{ id: string; text: string; state: 'queued' | 'sending' | 'accepted' | 'uncertain' }>;
  dispatchPending?: boolean;
  routingThreadIds?: string[];
  routingUserMessages?: string[];
  pendingMessageIsUser?: boolean;
  ownerInstance?: string;
  dispatch?: { id: string; state: 'prepared' | 'acknowledged' | 'completed'; createdAt: string; turnId?: string; model?: string; effort?: string; acknowledgedAt?: string };
  executionHistory?: Array<{ threadId?: string; turnId?: string; model?: string; effort?: string; sentAt: string; acknowledgedAt?: string; completedAt?: string; observedModel?: string; tokens?: CodexProgress['tokens'] }>;
  legacyRouting?: { binding: ModelRoutingBinding; checkpoint?: unknown; migratedAt: string };
  nativeReviewTimings?: { firstDraftAt: string | null; capturedAt: string | null; publishedAt: number | null; helperSeconds: Record<string, number> };
  reviewTimeline?: Array<{ phase: string; status: CodexTaskStatus; waitReason?: CodexProgress['waitReason']; startedAt: string; endedAt?: string }>;
  lease?: { directory: string; nonce?: string; receipt?: { path: string; nonce: string }; released?: boolean; extras?: Array<{ directory: string; nonce: string }> };
  forkedFrom?: { taskId: string; threadId: string; turnId: string };
  approvalSettings?: CodexApprovalSettings;
}
export interface CodexInteraction {
  id: string;
  taskId: string;
  kind: 'command' | 'file' | 'permissions' | 'questions' | 'form' | 'url';
  title: string;
  detail?: string;
  questions?: Array<{ id: string; question: string; isSecret?: boolean; options?: Array<{ label: string; description?: string }> }>;
  schema?: Record<string, unknown>;
  url?: string;
}
export interface CodexInteractionAnswer {
  decision: 'accept' | 'decline' | 'cancel';
  answers?: Record<string, string>;
  content?: Record<string, unknown>;
}
export interface CodexOutputItem {
  id: string;
  threadId?: string;
  turnId?: string;
  kind: 'agent' | 'command' | 'file' | 'tool' | 'user' | 'notice';
  text: string;
  command?: string;
  status?: string;
  exitCode?: number;
  final?: boolean;
  durationMs?: number;
  files?: Array<{ path: string; kind?: string; diff?: string }>;
}
export interface CodexEnvironment {
  compatibility?: 'verified' | 'basic';
  state: 'unchecked' | 'ready' | 'blocked';
  version?: string;
  executable?: string;
  authenticated?: boolean;
  sandbox?: string;
  message?: string;
  capabilities?: { fork: boolean; goals: boolean; usage: boolean; extraSkills: boolean };
  mcp?: Array<{ name: string; status: string }>;
  checkedAt?: string;
  storageProblems?: CodexStorageProblem[];
}
export interface CodexStorageProblem { id: string; reason: string; kind?: 'cleanup'; }
export type CodexEvent =
  | { kind: 'tasks'; tasks: CodexTaskState[] }
  | { kind: 'tasksDelta'; tasks: CodexTaskState[]; removedIds: string[]; revision: number }
  | { kind: 'output'; taskId: string; items: CodexOutputItem[]; replace?: boolean }
  | { kind: 'history'; taskId: string; items: CodexOutputItem[]; nextCursor?: string; cursor?: string; evicted?: boolean; reset?: boolean }
  | { kind: 'interactions'; taskId: string; interactions: CodexInteraction[] }
  | { kind: 'environment'; environment: CodexEnvironment };
export type CodexCommand =
  | { action: 'create'; context?: 'none' | 'selection' | 'file' | 'diff' }
  | { action: 'storage' }
  | { action: 'manage' | 'reconcile' | 'diagnostics' | 'fork' | 'goal' | 'handoff' | 'handoff-review' | 'open-worktree' | 'remove-worktree' | 'regenerate-wiki' | 'mr-fix' | 'reprepare'; taskId: string }
  | { action: 'metadata'; taskId: string; title?: string; pinned?: boolean; archived?: boolean }
  | { action: 'approvals'; taskId: string; settings: CodexApprovalSettings }
  | { action: 'reorder'; taskId: string; direction: 'up' | 'down' }
  | { action: 'open-file'; taskId: string; path: string; line?: number }
  | { action: 'open-diff'; taskId: string }
  | { action: 'publish-reply'; taskId: string; discussionId: string; body: string };
export const codexTaskActive = (state: CodexTaskStatus): boolean => ['starting', 'running', 'waiting', 'pausing'].includes(state);
export const codexOutputKey = (item: CodexOutputItem): string => JSON.stringify([item.threadId ?? '', item.turnId ?? '', item.id]);
/** Reviewer helpers canonicalize UUID inputs to uuid.hex in their persisted jobs. */
export function canonicalReviewRequestId(value: string): string {
  const result = value.replace(/-/g, '').toLowerCase();
  if (!/^[a-f0-9]{32}$/.test(result)) throw new Error('審查 request ID 格式無效。');
  return result;
}
export function projectCodexTask(record: CodexTaskRecord): CodexTaskState {
  const { id, title, root, status, createdAt, updatedAt, threadId, turnId, error, review, modelRouting, result,
    revision, pinned, archived, progress, recovery, goal, publication, publications } = record;
  return { id, title, root, status, workingDirectory: record.spec.executionRoot ?? root, isolated: !!record.spec.workflow?.worktree, selection: { model: record.spec.model ?? record.spec.routing?.model ?? (record.spec.routing ? 'gpt-6-luna' : undefined), effort: record.spec.routing?.requestedEffort ?? record.spec.effort }, createdAt, updatedAt, threadId, turnId, error, review, modelRouting, origin: record.spec.origin, result,
    revision, pinned, archived, progress: progress ? { ...progress, diff: undefined, hasDiff: !!progress.diff } : undefined, recovery, goal, publication, publications,
    pendingMessages: record.queuedMessages?.filter(item => item.state === 'queued' || item.state === 'sending').length,
    uncertainMessages: record.queuedMessages?.filter(item => item.state === 'uncertain').length,
    messageQueue: record.queuedMessages?.flatMap(item => item.state === 'accepted' ? [] : [{ id: item.id, text: item.text, state: item.state }]),
    ...projectTaskJourney(record) };
}

/** A finished model turn and a verified deliverable are distinct product states. */
export function projectTaskJourney(task: Pick<CodexTaskState, 'status' | 'progress' | 'result' | 'publication' | 'publications' | 'origin'>): Pick<CodexTaskState, 'blockers' | 'primaryAction'> {
  const blockers: NonNullable<CodexTaskState['blockers']> = [];
  const pending = task.publication?.state === 'pending' || Object.values(task.publications ?? {}).some(item => item.state === 'pending');
  if (task.status === 'uncertain' || pending || task.result?.state === 'uncertain') {
    blockers.push({ kind: 'reconcile', message: '先核對已執行工作及發布結果，再接續操作。' });
    return { blockers, primaryAction: { kind: 'reconcile', label: '核對結果', enabled: !codexTaskActive(task.status) } };
  }
  if (task.status === 'waiting') return { blockers: [{ kind: 'approval', message: '需要你的回答或核准。' }], primaryAction: { kind: 'answer', label: '回答目前要求', enabled: true } };
  const waits = { resource: '等待共用資源釋放', capacity: '等待本機執行槽位', quota: '等待額度可用', tool: '等待外部工具', storage: '等待儲存區修復' };
  const reason = task.progress?.waitReason;
  if (reason && reason !== 'approval') blockers.push({ kind: reason, message: waits[reason] });
  if (codexTaskActive(task.status) || task.status === 'queued') return { blockers, primaryAction: { kind: 'pause', label: '暫停', enabled: task.status !== 'pausing' } };
  if (task.result && ['ready', 'draft', 'published', 'partial'].includes(task.result.state)) return { blockers, primaryAction: { kind: 'results', label: '檢閱成果', enabled: true } };
  return { blockers, primaryAction: { kind: 'resume', label: task.status === 'completed' ? '接續修正' : '恢復任務', enabled: true } };
}
