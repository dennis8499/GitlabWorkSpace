import type { BmadCommandRequest } from '../workspace/bmadProtocol';
import type { ReviewerToolId } from '../workspace/reviewSessionProtocol';
import type { ModelRoutingBinding, ModelRoutingSummary } from './modelRoutingProtocol';
import type { CodexTaskOrigin, CodexTaskResult, CodexWorkflowBinding } from './workflowProtocol';
import type { CodexResultManifest } from './resultProtocol';
import type { CodexDeliveryState, CodexValidationEvidence } from './deliveryProtocol';
import type { CodexGroupAnalysisBinding } from './workflowProtocol';
import type { CodexTaskWorkspaceBinding } from './taskWorkspaceProtocol';
import type { WorkContext, ValidationAttempt, WorkLink } from './workContextProtocol';
import type { LocalWikiBaseline } from '../workspace/localWikiQualityProtocol';
export type { CodexTaskOrigin, CodexTaskResult } from './workflowProtocol';
export type { CodexLaunchDraft, CodexLaunchPatch, CodexLaunchCheck } from './launchProtocol';

export interface CodexExecutionSelection { model?: string; effort?: string; modelEfforts?: string[]; }
export type CodexTaskSource = (
  | { kind: 'free'; repository: string; prompt: string; contexts?: CodexContext[] }
  | { kind: 'skill'; featureId: string; inputs: Record<string, string>; revision: string }
  | { kind: 'bmad'; request: BmadCommandRequest }
  | { kind: 'group-analysis'; repositoryIds?: string[] }
  | { kind: 'issue'; projectId: number; issueIid: number; isolated?: boolean; buildMode?: 'interactive' | 'auto' }
  | { kind: 'project-wiki'; projectId: number; incrementalFrom?: string }
  | { kind: 'merge-request'; projectId: number; iid: number; intent?: 'review' | 'fix-comments'; discussionIds?: string[]; reviewerTool?: ReviewerToolId }
  | { kind: 'review'; action: 'resume' | 'refresh'; tool: ReviewerToolId; requestId: string; revision: string }) & CodexExecutionSelection & {
    /** Host-resolved repository; launch requests carry an opaque repository id. */
    repository?: string;
    requirement?: string;
    additionalSkillIds?: string[];
    testCommands?: string[];
    automaticDelivery?: boolean;
    oneClick?: boolean;
    expectedScope?: string;
    returnTo?: { mode: 'clone' | 'developer' | 'reviewer' | 'sa' | 'bmad'; issueTab?: 'content' | 'relations' | 'time' };
  };
export interface CodexTaskSpec {
  workContext?: WorkContext;
  localWikiBaseline?: LocalWikiBaseline;
  taskWorkspace?: CodexTaskWorkspaceBinding;
  bmadArtifacts?: { outputRoot: string; projectChangesRoot?: string; seedRoot?: string };
  source: CodexTaskSource;
  title: string;
  root: string;
  workspaceKey: string;
  prompt: string;
  requirementSummary?: string;
  skill?: { name: string; path: string; fingerprint?: string };
  additionalSkills?: Array<{ id: string; name: string; path: string; fingerprint: string }>;
  projectRules?: Array<{ path: string; fingerprint: string }>;
  delivery?: { mode: 'automatic' | 'manual'; testCommands?: string[] };
  groupAnalysis?: CodexGroupAnalysisBinding;
  writableRoots: string[];
  environmentKey: string;
  preparationKey?: string;
  review?: { tool: ReviewerToolId; requestId: string; revision: string; runtimeRoot?: string; workspaceRoot?: string; repositoryPath?: string;
    launchBinding?: { path: string; sha256: string } };
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
  workContext?: WorkContext;
  validationAttempts?: ValidationAttempt[];
  implementationCycles?: number;
  workLinks?: WorkLink[];
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
  groupAnalysis?: { id: string; repositories: Array<{ id: string; name: string; sha: string; projectPath?: string }> };
  bmadProjectChanges?: boolean;
  retention?: 'results-only';
  savedResult?: CodexResultManifest;
  delivery?: CodexDeliveryState;
  validation?: CodexValidationEvidence;
  cleanupState?: 'pending' | 'running' | 'complete' | 'needs-attention';
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
  schema: 'GitLabWorkspaceCodexTask/v1' | 'GitLabWorkspaceCodexTask/v2' | 'GitLabWorkspaceCodexTask/v3' | 'GitLabWorkspaceCodexTask/v4';
  spec: CodexTaskSpec;
  ownerPid: number;
  ownerGeneration?: number;
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
  closing?: { reason: 'completed' | 'manual' | 'deleted'; startedAt: string };
  ownedThreadIds?: string[];
  temporaryRefs?: Array<{ repository: string; ref: string; sha: string }>;
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
  availableDecisions?: Array<string | { acceptWithExecpolicyAmendment: { execpolicy_amendment: string[] } }
    | { applyNetworkPolicyAmendment: { network_policy_amendment: { action: 'allow' | 'deny'; host: string } } }>;
  permissionScopes?: Array<'turn' | 'session'>;
}
export interface CodexInteractionAnswer {
  decision: 'accept' | 'acceptForSession' | 'decline' | 'cancel';
  scope?: 'turn' | 'session';
  execpolicyAmendment?: string[];
  networkPolicyAmendment?: { action: 'allow' | 'deny'; host: string };
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
  cwd?: string;
  startedAtMs?: number;
  completedAtMs?: number;
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
  capabilities?: { fork: boolean; goals: boolean; usage: boolean; extraSkills: boolean; deleteThread?: boolean };
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
  | { action: 'manage-local-connections' }
  | { action: 'manage' | 'reconcile' | 'diagnostics' | 'fork' | 'goal' | 'handoff' | 'handoff-review' | 'open-worktree' | 'remove-worktree' | 'regenerate-wiki' | 'mr-fix' | 'reprepare' | 'stop-cleanup' | 'manual-handoff' | 'retry-delivery' | 'confirm-delivery' | 'confirm-documentation' | 'publish-group-issues' | 'apply-project-changes' | 'export-result' | 'copy-handoff' | 'new-from-result' | 'restore-result'; taskId: string }
  | { action: 'open-artifact'; taskId: string; artifactId: string }
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
    revision, pinned, archived, progress, recovery, goal, publication, publications, delivery, validation, cleanupState,
    validationAttempts, implementationCycles } = record;
  return { id, title, root, status, workingDirectory: record.spec.executionRoot ?? root, isolated: !!(record.spec.workflow?.worktree || record.spec.workflow?.managedClone || record.spec.taskWorkspace), selection: { model: record.spec.model ?? record.spec.routing?.model ?? (record.spec.routing ? 'gpt-6-luna' : undefined), effort: record.spec.routing?.requestedEffort ?? record.spec.effort }, createdAt, updatedAt, threadId, turnId, error, review, modelRouting, origin: record.spec.origin,
    result: result?.wikiQuality ? { ...result, wikiQuality: undefined } : result,
    revision, pinned, archived, progress: progress ? { ...progress, diff: undefined, hasDiff: !!progress.diff } : undefined, recovery, goal, publication, publications, delivery, validation, cleanupState,
    workContext: record.spec.workContext, validationAttempts, implementationCycles,
    pendingMessages: record.queuedMessages?.filter(item => item.state === 'queued' || item.state === 'sending').length,
    uncertainMessages: record.queuedMessages?.filter(item => item.state === 'uncertain').length,
    messageQueue: record.queuedMessages?.flatMap(item => item.state === 'accepted' ? [] : [{ id: item.id, text: item.text, state: item.state }]),
    ...(record.spec.groupAnalysis ? { groupAnalysis: { id: record.spec.groupAnalysis.id,
      repositories: record.spec.groupAnalysis.repositories.map(({ id, name, sha, projectPath }) => ({ id, name, sha, projectPath })) } } : {}),
    bmadProjectChanges: !!record.spec.bmadArtifacts?.projectChangesRoot,
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
