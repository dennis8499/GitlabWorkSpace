export interface IssueCreateInput {
  title: string;
  description?: string;
  assigneeId?: number;
  labels?: string[];
  milestoneId?: number;
  dueDate?: string;
  startDate?: string;
  confidential?: boolean;
}

export interface IssueUpdateInput {
  title?: string;
  description?: string;
  assigneeId?: number | null;
  labels?: string[];
  milestoneId?: number | null;
  dueDate?: string | null;
  startDate?: string | null;
  confidential?: boolean;
  discussionLocked?: boolean;
  stateEvent?: 'close' | 'reopen';
}

export interface GitLabIssueCapabilities {
  /** Issue hierarchy endpoints vary between Namespace and Project on older and newer GitLab releases. */
  workItemScope?: 'namespace' | 'project';
  /** The input field used to create a child Work Item on this instance. */
  workItemCreatePathField?: 'projectPath' | 'namespacePath';
  issuePermissionFields?: string[];
  workItemPermissionFields?: string[];
  issuePermissionSource?: 'issue' | 'workItem';
  workItemFields?: string[];
  workItemGraphFields?: string[];
  workItemTypeList?: boolean;
  hierarchy: boolean;
  childMutations: boolean;
  graphWorkItems: boolean;
  graphHierarchy: boolean;
  graphLinkedItems: boolean;
  graphLabels: boolean;
  graphAssignees: boolean;
  graphWorkItemTypes: boolean;
  discussionResolve: boolean;
  startDate: boolean;
  timelogReport: boolean;
  timelogSource?: 'workItem' | 'issue';
  timelogSummary?: boolean;
  timelogUserFields?: string[];
  timelogCreate: boolean;
  timelogCreateDated?: boolean;
  timelogCreateSummary?: boolean;
  timelogAdminPermission?: boolean;
  timelogDelete: boolean;
  createPermission: boolean;
}

export type GitLabWorkItemScope = 'namespace' | 'project';

export interface GitLabMergeRequestCreateInput {
  title: string;
  description?: string;
  sourceBranch: string;
  targetBranch: string;
  reviewerIds?: number[];
  assigneeId?: number;
}
