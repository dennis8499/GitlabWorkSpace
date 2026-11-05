import type { GitLabIssue, GitLabMergeRequest, GitLabProject } from '../api/types';
import type { WorkspaceSectionState } from './workspaceProtocol';

/** Host-owned, credential-free navigation data. Reading this never starts I/O. */
export interface NavigationSnapshot {
  scope: string;
  connectedScope?: string;
  connected: boolean;
  account?: string;
  group?: string;
  projects: readonly GitLabProject[];
  issues: readonly GitLabIssue[];
  mergeRequests: readonly GitLabMergeRequest[];
  sections: Partial<Record<'projects' | 'issues' | 'mergeRequests', WorkspaceSectionState>>;
}
