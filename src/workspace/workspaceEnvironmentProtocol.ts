export interface WorkspaceRepositoryMatch {
  name: string;
  path: string;
  matched: boolean;
  projectId?: number;
  remoteFingerprint?: string;
  reason?: string;
}
export interface GroupWorkspaceMatch {
  status: 'checking' | 'matched' | 'mismatched' | 'unverified' | 'ambiguous' | 'error';
  root?: string;
  cloneRoot?: string;
  reason?: string;
  repositories: WorkspaceRepositoryMatch[];
}
