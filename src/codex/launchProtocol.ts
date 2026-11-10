import type { CodexTaskSource } from './protocol';

export interface CodexLaunchCheck {
  id: 'source' | 'repository' | 'workflow' | 'codex' | 'selection';
  label: string;
  state: 'pending' | 'checking' | 'ready' | 'blocked';
  message?: string;
  repair?: 'login' | 'clone' | 'scan' | 'tools' | 'codex-login' | 'sandbox' | 'executable';
}
export interface CodexLaunchSourceSnapshot {
  sourceSha: string;
  targetSha?: string;
  updatedAt?: string;
  title?: string;
}
export interface CodexLaunchDraft {
  schema: 'GitLabWorkspaceCodexLaunch/v1';
  id: string;
  revision: number;
  scope: string;
  state: 'editing' | 'checking' | 'ready' | 'blocked' | 'submitting' | 'submitted' | 'uncertain';
  source: CodexTaskSource;
  title: string;
  requirement: string;
  repositoryId?: string;
  repositories: Array<{ id: string; name: string; path: string }>;
  models: Array<{ id: string; label: string; efforts: string[]; defaultEffort?: string }>;
  model?: string;
  effort?: string;
  isolated: boolean;
  routed?: boolean;
  supportsModelSelection?: boolean;
  root?: string;
  workingDirectory?: string;
  branch?: string;
  sourceSha?: string;
  targetSha?: string;
  sourceSnapshot?: CodexLaunchSourceSnapshot;
  sourceChange?: { key: string; previous: CodexLaunchSourceSnapshot; current: CodexLaunchSourceSnapshot; discussionsChanged?: boolean; acknowledged: boolean };
  discussions?: Array<{ id: string; summary: string; selected: boolean }>;
  checks: CodexLaunchCheck[];
  error?: string;
  taskId?: string;
  updatedAt: string;
  timings?: { openedAt: number; draftReadyAt?: number; checkedMs?: number; submittedAt?: number; queuedAt?: number };
  /** Host check ownership for compare-and-swap; never an execution lease. */
  checkOwner?: { instance: string; pid: number; nonce: string };
  preparationId?: string;
}
export interface CodexLaunchPatch {
  requirement?: string;
  repositoryId?: string;
  model?: string;
  effort?: string;
  isolated?: boolean;
  discussionIds?: string[];
  acknowledgedSource?: string;
}
