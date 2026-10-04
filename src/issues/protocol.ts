import type { IssueCreateInput, IssueUpdateInput } from '../api/gitLabClient';
import type {
  GitLabEmojiReaction, GitLabIssue, GitLabIssueDiscussion, GitLabIssueTemplate,
  GitLabLabel, GitLabMember, GitLabMergeRequestSummary, GitLabMetadata,
  GitLabMilestone, GitLabProject, GitLabTodo, GitLabUser
} from '../api/types';

export interface IssueFormOptions {
  members: GitLabMember[];
  labels: GitLabLabel[];
  milestones: GitLabMilestone[];
  templates: GitLabIssueTemplate[];
  warnings?: string[];
}

export interface IssueTask {
  id: string;
  iid: string;
  title: string;
  description?: string | null;
  descriptionHtml?: string | null;
  state: string;
  webUrl?: string;
  canEdit?: boolean;
}

export interface IssueTimelog {
  id: string;
  timeSpent: number;
  spentAt: string;
  summary?: string | null;
  user: GitLabUser;
  userPermissions?: { adminTimelog: boolean };
}

export interface IssueRelationsData {
  issue: GitLabIssue;
  project: GitLabProject;
  links: GitLabIssue[];
  tasks: IssueTask[];
  parentWorkItemId?: string;
  taskTypeId?: string;
  canLink: boolean;
  canManageChildren: boolean;
}

export type IssueRelationAction =
  | { type: 'createChild'; title: string }
  | { type: 'addChild'; taskIid: number }
  | { type: 'link'; targetProjectId: number; targetIssueIid: number; linkType: 'relates_to' | 'blocks' | 'is_blocked_by' }
  | { type: 'unlink'; linkId: number };

export type IssueDetailSection = 'options' | 'activity' | 'links' | 'mergeRequests' | 'reactions' | 'todos' | 'tasks' | 'permissions' | 'projects' | 'dates' | 'timelogs';
export type IssueDetailSectionStatus = 'loading' | 'ready' | 'error';

export interface IssueDetailData extends IssueRelationsData {
  issue: GitLabIssue;
  project: GitLabProject;
  projects: GitLabProject[];
  user: GitLabUser;
  metadata?: GitLabMetadata;
  options: IssueFormOptions;
  discussions: GitLabIssueDiscussion[];
  mergeRequests: GitLabMergeRequestSummary[];
  reactions: GitLabEmojiReaction[];
  noteReactions: Record<number, GitLabEmojiReaction[]>;
  todos: GitLabTodo[];
  timelogs: IssueTimelog[];
  startDate: string | null;
  warnings: string[];
  canEdit: boolean;
  canDelete: boolean;
  canMove: boolean;
  canClone: boolean;
  canComment: boolean;
  canInternalComment: boolean;
  canTrackTime: boolean;
  canResolveThreads: boolean;
  canSetStartDate: boolean;
  hasStartDate: boolean;
  canLogTime: boolean;
  canDeleteTimelog: boolean;
  sections?: Partial<Record<IssueDetailSection, IssueDetailSectionStatus>>;
}

export type IssuePanelRequest =
  | { type: 'ready' }
  | { type: 'refresh' }
  | { type: 'selectProject'; projectId: number }
  | { type: 'create'; projectId: number; input: IssueCreateInput }
  | { type: 'update'; issueId: number; input: IssueUpdateInput; expectedUpdatedAt?: string }
  | { type: 'preview'; requestId: string; projectId: number; markdown: string }
  | { type: 'search'; requestId: string; projectId: number; query: string }
  | { type: 'searchProjects'; requestId: string; query: string }
  | { type: 'upload'; requestId: string; projectId: number }
  | { type: 'image'; requestId: string; url: string }
  | { type: 'invoke'; issueId: number; action: IssueAction; payload?: Record<string, unknown> }
  | { type: 'openIssueInGitLab'; issueId: number }
  | { type: 'openLink'; url: string };

export type IssueAction =
  | 'close' | 'reopen' | 'subscribe' | 'unsubscribe' | 'todo' | 'todoDone'
  | 'note' | 'editNote' | 'deleteNote' | 'thread' | 'reply' | 'resolveThread'
  | 'react' | 'unreact' | 'reactNote' | 'unreactNote' | 'link' | 'unlink' | 'estimate' | 'spend'
  | 'resetEstimate' | 'resetSpent' | 'deleteTimelog' | 'move' | 'clone' | 'delete'
  | 'createChild' | 'addChild' | 'removeChild' | 'setChildState' | 'updateChild';

export type IssuePanelResponse =
  | { type: 'createData'; projects: GitLabProject[]; selectedProjectId?: number; options?: IssueFormOptions; metadata?: GitLabMetadata; canSetStartDate: boolean; canCreateIssue: boolean }
  | { type: 'projectData'; projectId: number; options: IssueFormOptions; canCreateIssue: boolean }
  | { type: 'detailData'; data: IssueDetailData }
  | { type: 'detailPatch'; issueId: number; patch: Partial<IssueDetailData> }
  | { type: 'reply'; requestId: string; result?: unknown; error?: string }
  | { type: 'busy'; value: boolean }
  | { type: 'cancelled' }
  | { type: 'error'; message: string }
  | { type: 'deleted' };
