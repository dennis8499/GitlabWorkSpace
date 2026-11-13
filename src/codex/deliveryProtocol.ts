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
export interface CodexDeliveryState {
  mode: 'automatic' | 'manual';
  state: 'pending' | 'running' | 'published' | 'needs-attention' | 'cancelled';
  steps: CodexDeliveryStep[];
  artifactDigest?: string;
  deliveredCommitSha?: string;
  url?: string;
  error?: string;
}
export interface CodexValidationEvidence {
  cwd: string;
  artifactDigest: string;
  testedAt: string;
  commands: Array<{ command: string; exitCode: number; cwd?: string; itemId?: string; startedAtMs?: number; completedAtMs?: number }>;
  turnId?: string;
  /** Only an independently verified already-satisfied requirement may use this. */
  noChanges?: boolean;
}
