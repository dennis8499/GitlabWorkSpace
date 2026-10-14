export interface WorkspaceRepositoryMatch {
  name: string;
  path: string;
  matched: boolean;
  projectId?: number;
  defaultBranch?: string;
  remoteFingerprint?: string;
  reason?: string;
}
export interface GroupWorkspaceMatch {
  status: 'checking' | 'matched' | 'mismatched' | 'unverified' | 'ambiguous' | 'error';
  profile?: 'group' | 'repository';
  root?: string;
  cloneRoot?: string;
  reason?: string;
  repositories: WorkspaceRepositoryMatch[];
}
