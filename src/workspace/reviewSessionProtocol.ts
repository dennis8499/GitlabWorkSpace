export type ReviewerToolId = 'merge-reviewer' | 'release-reviewer';
export function isReviewerTool(value: unknown): value is ReviewerToolId {
  return value === 'merge-reviewer' || value === 'release-reviewer';
}

export interface WorkflowKitRunnerBinding {
  script_path: string;
  script_sha256: string;
  syntax_analysis?: SyntaxAnalysisBinding;
}

export interface SyntaxAnalysisBinding {
  schema: 'SyntaxAnalysisBinding/v1';
  script_path: string;
  engine_sha256: string;
  languages: string[];
  default_mode: 'auto' | 'off';
}

/** Identity and local integrity measurements for an installed Reviewer payload. */
export interface InstalledReviewerBinding {
  schema: 'InstalledReviewerBinding/v1';
  tool: ReviewerToolId;
  version: string;
  script_path: string;
  script_sha256: string;
  skill_sha256: string;
  payload_sha256: string;
  payload_files: number;
  workflow_kit_runner?: WorkflowKitRunnerBinding;
}

/** The helper's persisted initial review decision, independent of publication or cleanup. */
export interface ReviewOutcomeSummary {
  reviewComplete: boolean | null;
  reviewStatus: string;
  gaps: string[];
}

/** Browser-safe projection of a local review job. */
export interface ReviewSessionSummary {
  tool: ReviewerToolId;
  requestId: string;
  repository: string;
  repositoryPath: string;
  base: string;
  head: string;
  state: string;
  phase: string;
  updatedAt: string;
  reportPath?: string;
  error?: string;
  fetchCount: number;
  packCacheHits: number;
  cleanupPending?: boolean;
  reviewOutcome?: ReviewOutcomeSummary;
  baseSha?: string;
  headSha?: string;
  capturedAt?: string;
  syncObservations?: Array<{ mode: string; at: string }>;
  budget?: ReviewBudgetSummary;
}
export interface ReviewBudgetSummary {
  profile: 'balanced' | 'unlimited';
  elapsedSeconds: number;
  baseSeconds?: number;
  limitSeconds?: number;
  remainingSeconds?: number;
  extensionUsed: boolean;
  phase: 'within-budget' | 'extended-investigation' | 'wrap-up' | 'complete' | 'incomplete' | 'stopped';
}
export type ReviewerCapabilityFeature =
  | 'request_id' | 'read_only_view' | 'status_summary' | 'read_window' | 'updates_file'
  | 'durable_review_progress' | 'phase_metrics' | 'literal_search_batch' | 'patch_encoding'
  | 'operation_diagnostics';
export interface ReviewerSessionCapabilities {
  schema: 'ReviewCapabilities/v1';
  tool: ReviewerToolId;
  skill_version: string;
  prepare_evidence: boolean;
  updates_schema: 'ReviewUpdates/v1' | 'ReleaseReviewUpdates/v1';
  shared_cache_schema: 'ReviewerSharedCache/v2';
  payload_sha256: string;
  payload_files?: number;
  runtime_root: string;
  git_commands: 0;
  network_commands: 0;
  features?: Partial<Record<ReviewerCapabilityFeature, boolean>>;
  observability?: { agent_tool_round_trips: number | null; model_tokens: number | null; http_requests: number | null; ssh_requests: number | null };
  budget_schema?: 'ReviewBudget/v1';
  budget_profiles?: readonly ('balanced' | 'unlimited')[];
}

/** Native capability response exposed by MergeReviewer 0.20.4 and newer. */
export interface NativeMergeReviewerCapabilities {
  schema: 'MergeReviewCapabilities/v1';
  protocol_version: 1;
  draft_formats: readonly ('compact' | 'v3')[];
  features: {
    artifact_scopes: readonly ('context' | 'runtime')[];
    read_only_artifact_view: boolean;
    request_preflight: boolean;
    incremental_resume: boolean;
    phase_metrics: boolean;
  };
}

export type ReviewerCapabilities = ReviewerSessionCapabilities | NativeMergeReviewerCapabilities;
