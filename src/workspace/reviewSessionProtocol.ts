/** Browser-safe projection of a local review job. */
export interface ReviewSessionSummary {
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
}
