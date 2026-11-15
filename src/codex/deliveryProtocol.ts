/** Durable checkpoints belong to a task; never persist credentials or raw tool output. */
export interface CodexDeliveryStep {
  id: string;
  kind: 'commit' | 'push' | 'merge-request' | 'issue-note' | 'review-note' | 'reply' | 'upload' | 'wiki';
  state: 'prepared' | 'sending' | 'confirmed' | 'uncertain';
  key: string;
  bodyHash?: string;
  resourceId?: number;
  url?: string;
  sha?: string;
  parentSha?: string;
  treeSha?: string;
  error?: string;
}
export interface CodexDeliveryConfirmation {
  digest: string;
  confirmedAt: string;
  /** Captures the reviewed local history before the Host's optional final commit. */
  headSha?: string;
  /** Fresh GitLab target observed in the human-reviewed Issue delivery preview. */
  targetSha?: string;
  /** Stable Issue content shown in that preview; activity timestamps are excluded. */
  issueDigest?: string;
}
export interface CodexIssueDeliverySnapshot {
  id: number;
  projectId: number;
  iid: number;
  title: string;
  description: string;
  state: string;
  labels: string[];
  assigneeIds: number[];
  milestoneId: number | null;
  dueDate: string | null;
  startDate: string | null;
  confidential: boolean;
  discussionLocked: boolean;
  issueType: string;
}
export interface CodexDeliveryTargetPreview {
  branch: string;
  baselineSha: string;
  sha: string;
  compareUrl: string;
  advanced: boolean;
  issue?: CodexIssueDeliverySnapshot;
  issueDigest?: string;
}
export interface CodexDeliveryState {
  mode: 'automatic' | 'manual';
  state: 'pending' | 'running' | 'published' | 'needs-attention' | 'cancelled';
  steps: CodexDeliveryStep[];
  artifactDigest?: string;
  deliveredCommitSha?: string;
  url?: string;
  error?: string;
  confirmation?: CodexDeliveryConfirmation;
}
export interface CodexValidationEvidence {
  requirementDigest?: string;
  profileDigest?: string;
  /** Explicit local human verification; an empty command list is never a successful test. */
  manual?: { confirmedAt: string; checks: string[] };
  cwd: string;
  artifactDigest: string;
  testedAt: string;
  commands: Array<{ command: string; exitCode: number; cwd?: string; itemId?: string; startedAtMs?: number; completedAtMs?: number }>;
  turnId?: string;
  /** Only an independently verified already-satisfied requirement may use this. */
  noChanges?: boolean;
}
