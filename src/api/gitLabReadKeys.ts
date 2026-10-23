/** Shared read keys keep loads and write invalidation in the same namespace. */
import { createHash } from 'node:crypto';

/** Low-churn inventories/options outlive the dynamic Issue and MR state. */
export function gitLabReadLifetimeMs(key: string): number {
  if (/^group\/\d+\/(?:project-search|verified-mr-diff)(?:\/|$)/.test(key)) return 300_000;
  return /^group\/\d+\/(?:projects|milestones)(?:\/|$)/.test(key) ||
    /^project\/\d+\/(?:members|labels|milestones|templates|template-names)(?:\/|$)/.test(key) ? 300_000 : 60_000;
}

export function groupProjectsPageReadKey(groupId: number, cursor?: string): string {
  return `group/${groupId}/projects/pages/opened/${cursor ? createHash('sha256').update(cursor).digest('hex') : 'first'}`;
}

export type GroupWorkspaceSection = 'issues' | 'mergeRequests' | 'milestones' | 'boards';
export function groupWorkspaceReadKey(groupId: number, section: GroupWorkspaceSection): string {
  return `group/${groupId}/${section === 'issues' ? 'assigned-issues' : section}`;
}
export function groupBoardReadPrefix(groupId: number): string { return `group-board/${groupId}/`; }
export function groupBoardReadKey(groupId: number, boardId: number, kind: 'memberships' | 'assigned', username = ''): string {
  return `${groupBoardReadPrefix(groupId)}${boardId}/${kind}${kind === 'assigned' ? `/${encodeURIComponent(username)}` : ''}`;
}
export interface GitLabReadInvalidation {
  groupIds: readonly number[];
  projectId?: number;
  resource: 'issues' | 'mergeRequests' | 'group' | 'all';
}
