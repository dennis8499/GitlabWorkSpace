export interface WikiPageDigest { path: string; sha256: string; size: number; notes?: string[]; sources?: string[]; }
export interface LocalWikiBaseline {
  schema: 'GitLabWorkspaceLocalWikiBaseline/v1';
  binding: string;
  pages: WikiPageDigest[];
}
export interface WikiFinding { severity: 'critical' | 'warning' | 'info'; code: string; message: string; page?: string; }
export interface LocalWikiQualityReceipt {
  schema: 'GitLabWorkspaceLocalWikiQuality/v1';
  scope: 'partial' | 'full' | 'inspection';
  changedPages: string[];
  findings: WikiFinding[];
  unrelatedFindings: number;
  coverage?: { ok: boolean; status?: string; errors: string[] };
  checks: Array<{ command: string; exitCode: number }>;
}
