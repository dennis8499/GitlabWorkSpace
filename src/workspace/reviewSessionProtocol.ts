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
}
