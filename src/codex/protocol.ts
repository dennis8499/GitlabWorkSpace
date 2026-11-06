import type { BmadCommandRequest } from '../workspace/bmadProtocol';
import type { ReviewerToolId } from '../workspace/reviewSessionProtocol';
import type { ModelRoutingBinding, ModelRoutingSummary } from './modelRoutingProtocol';
import type { CodexTaskOrigin, CodexTaskResult, CodexWorkflowBinding } from './workflowProtocol';
export type { CodexTaskOrigin, CodexTaskResult } from './workflowProtocol';

export type CodexTaskSource =
  | { kind: 'skill'; featureId: string; inputs: Record<string, string>; revision: string }
  | { kind: 'bmad'; request: BmadCommandRequest }
  | { kind: 'issue'; projectId: number; issueIid: number }
  | { kind: 'project-wiki'; projectId: number }
  | { kind: 'merge-request'; projectId: number; iid: number }
  | { kind: 'review'; action: 'resume' | 'refresh'; tool: ReviewerToolId; requestId: string; revision: string };
export interface CodexTaskSpec {
  source: CodexTaskSource;
  title: string;
  root: string;
  workspaceKey: string;
  prompt: string;
  skill: { name: string; path: string };
  writableRoots: string[];
  environmentKey: string;
  review?: { tool: ReviewerToolId; requestId: string; revision: string };
  routing?: ModelRoutingBinding;
  executionRoot?: string;
  origin?: CodexTaskOrigin;
  workflow?: CodexWorkflowBinding;
}
export type CodexTaskStatus = 'queued' | 'starting' | 'running' | 'waiting' | 'pausing' | 'paused' | 'completed' | 'failed' | 'interrupted' | 'uncertain';
export interface CodexTaskControls {
  external: boolean;
  canPause: boolean;
  canResume: boolean;
  canDelete: boolean;
  canAutoAccept: boolean;
  autoAccept: boolean;
  autoAcceptError?: string;
}
export interface CodexTaskState {
  id: string;
  title: string;
  root: string;
  status: CodexTaskStatus;
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
}
export interface CodexTaskRecord extends Omit<CodexTaskState, 'controls'> {
  schema: 'GitLabWorkspaceCodexTask/v1';
  spec: CodexTaskSpec;
  ownerPid: number;
  pendingMessage?: string;
  dispatchPending?: boolean;
  routingThreadIds?: string[];
  routingUserMessages?: string[];
  pendingMessageIsUser?: boolean;
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
}
export interface CodexEnvironment {
  state: 'unchecked' | 'ready' | 'blocked';
  version?: string;
  executable?: string;
  authenticated?: boolean;
  sandbox?: string;
  message?: string;
}
export type CodexEvent =
  | { kind: 'tasks'; tasks: CodexTaskState[] }
  | { kind: 'output'; taskId: string; items: CodexOutputItem[]; replace?: boolean }
  | { kind: 'history'; taskId: string; items: CodexOutputItem[]; nextCursor?: string; cursor?: string }
  | { kind: 'interactions'; taskId: string; interactions: CodexInteraction[] }
  | { kind: 'environment'; environment: CodexEnvironment };
export const codexTaskActive = (state: CodexTaskStatus): boolean => ['starting', 'running', 'waiting', 'pausing'].includes(state);
export const codexOutputKey = (item: CodexOutputItem): string => JSON.stringify([item.threadId ?? '', item.turnId ?? '', item.id]);
/** Reviewer helpers canonicalize UUID inputs to uuid.hex in their persisted jobs. */
export function canonicalReviewRequestId(value: string): string {
  const result = value.replace(/-/g, '').toLowerCase();
  if (!/^[a-f0-9]{32}$/.test(result)) throw new Error('審查 request ID 格式無效。');
  return result;
}
export function projectCodexTask(record: CodexTaskRecord): CodexTaskState {
  const { id, title, root, status, createdAt, updatedAt, threadId, turnId, error, review, modelRouting, result } = record;
  return { id, title, root, status, createdAt, updatedAt, threadId, turnId, error, review, modelRouting, origin: record.spec.origin, result };
}
