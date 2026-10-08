/** Shared read keys keep loads and write invalidation in the same namespace. */
export type GroupWorkspaceSection = 'mergeRequests' | 'milestones' | 'boards';
export function groupWorkspaceReadKey(groupId: number, section: GroupWorkspaceSection): string {
  return `group/${groupId}/${section}`;
}
export interface GitLabReadInvalidation {
  groupIds: readonly number[];
  projectId?: number;
  resource: 'issues' | 'mergeRequests' | 'group' | 'all';
}
