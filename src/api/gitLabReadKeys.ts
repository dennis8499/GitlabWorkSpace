/** Shared read keys keep loads and write invalidation in the same namespace. */
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
