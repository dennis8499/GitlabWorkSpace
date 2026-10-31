export type ReviewerToolId = 'merge-reviewer' | 'release-reviewer';
export function isReviewerTool(value: unknown): value is ReviewerToolId {
  return value === 'merge-reviewer' || value === 'release-reviewer';
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
export interface ReviewerCapabilities {
  schema: 'ReviewCapabilities/v1';
  tool: ReviewerToolId;
  skill_version: string;
  prepare_evidence: boolean;
  supports_parallel_agents?: boolean;
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
