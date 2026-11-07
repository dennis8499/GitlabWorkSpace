import type { BmadCommandRequest } from '../workspace/bmadProtocol';
import type { ReviewerToolId } from '../workspace/reviewSessionProtocol';
import type { ModelRoutingBinding, ModelRoutingSummary } from './modelRoutingProtocol';
import type { CodexTaskOrigin, CodexTaskResult, CodexWorkflowBinding } from './workflowProtocol';
export type { CodexTaskOrigin, CodexTaskResult } from './workflowProtocol';

export type CodexTaskSource =
  | { kind: 'free'; repository: string; prompt: string; contexts?: CodexContext[]; model?: string; effort?: string }
  | { kind: 'skill'; featureId: string; inputs: Record<string, string>; revision: string }
  | { kind: 'bmad'; request: BmadCommandRequest }
  | { kind: 'issue'; projectId: number; issueIid: number; isolated?: boolean }
  | { kind: 'project-wiki'; projectId: number; incrementalFrom?: string }
  | { kind: 'merge-request'; projectId: number; iid: number; intent?: 'review' | 'fix-comments'; discussionIds?: string[] }
  | { kind: 'review'; action: 'resume' | 'refresh'; tool: ReviewerToolId; requestId: string; revision: string };
export interface CodexTaskSpec {
  source: CodexTaskSource;
  title: string;
  root: string;
  workspaceKey: string;
  prompt: string;
  skill?: { name: string; path: string };
  writableRoots: string[];
  environmentKey: string;
  review?: { tool: ReviewerToolId; requestId: string; revision: string };
  commitReview?: { runtimeRoot: string };
  routing?: ModelRoutingBinding;
  executionRoot?: string;
  origin?: CodexTaskOrigin;
  workflow?: CodexWorkflowBinding;
  model?: string;
  effort?: string;
  contexts?: CodexContext[];
}
export interface CodexContext { kind: 'selection' | 'file' | 'diff'; path: string; text: string; hash: string; }
export interface CodexApprovalSettings { command: boolean; file: boolean; permissions: boolean; }
export interface CodexRecovery {
  checkedAt: string; execution: 'unknown' | 'not-started' | 'running' | 'completed' | 'failed' | 'interrupted';
  cleanup: 'unknown' | 'confirmed'; publication: 'unknown' | 'not-published' | 'pending' | 'confirmed';
  message: string;
}
export interface CodexProgress {
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
  publication?: { kind: 'review' | 'reply'; state: 'pending' | 'confirmed' | 'not-published'; key: string };
  queuePosition?: number;
}
export interface CodexTaskRecord extends Omit<CodexTaskState, 'controls'> {
  schema: 'GitLabWorkspaceCodexTask/v1' | 'GitLabWorkspaceCodexTask/v2';
  spec: CodexTaskSpec;
  ownerPid: number;
  pendingMessage?: string;
  dispatchPending?: boolean;
  routingThreadIds?: string[];
  routingUserMessages?: string[];
  pendingMessageIsUser?: boolean;
  ownerInstance?: string;
  dispatch?: { id: string; state: 'prepared' | 'acknowledged' | 'completed'; createdAt: string; turnId?: string };
  lease?: { directory: string; nonce?: string; receipt?: { path: string; nonce: string }; extras?: Array<{ directory: string; nonce: string }> };
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
export interface CodexStorageProblem { id: string; reason: string; }
export type CodexEvent =
  | { kind: 'tasks'; tasks: CodexTaskState[] }
  | { kind: 'output'; taskId: string; items: CodexOutputItem[]; replace?: boolean }
  | { kind: 'history'; taskId: string; items: CodexOutputItem[]; nextCursor?: string; cursor?: string; evicted?: boolean; reset?: boolean }
  | { kind: 'interactions'; taskId: string; interactions: CodexInteraction[] }
  | { kind: 'environment'; environment: CodexEnvironment };
export type CodexCommand =
  | { action: 'create'; context?: 'none' | 'selection' | 'file' | 'diff' }
  | { action: 'storage' }
  | { action: 'manage' | 'reconcile' | 'diagnostics' | 'fork' | 'goal' | 'handoff' | 'remove-worktree' | 'regenerate-wiki' | 'mr-fix'; taskId: string }
  | { action: 'metadata'; taskId: string; title?: string; pinned?: boolean; archived?: boolean }
  | { action: 'approvals'; taskId: string; settings: CodexApprovalSettings }
  | { action: 'reorder'; taskId: string; direction: 'up' | 'down' }
  | { action: 'open-file'; taskId: string; path: string }
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
    revision, pinned, archived, progress, recovery, goal, publication } = record;
  return { id, title, root, status, workingDirectory: record.spec.executionRoot ?? root, createdAt, updatedAt, threadId, turnId, error, review, modelRouting, origin: record.spec.origin, result,
    revision, pinned, archived, progress: progress ? { ...progress, diff: undefined, hasDiff: !!progress.diff } : undefined, recovery, goal, publication };
}
