import type { IssueCreateInput, IssueUpdateInput } from '../api/requestTypes';
import type { OperationSnapshot } from '../workspace/operations';
import type {
  GitLabEmojiReaction, GitLabIssue, GitLabIssueDiscussion, GitLabIssueTemplate,
  GitLabLabel, GitLabMember, GitLabMergeRequestSummary, GitLabMetadata,
  GitLabMilestone, GitLabProject, GitLabTodo, GitLabUser
} from '../api/types';

export interface IssueFormOptions {
  members: GitLabMember[];
  labels: GitLabLabel[];
  milestones: GitLabMilestone[];
  templates: Array<GitLabIssueTemplate & { key?: string; loaded?: boolean }>;
  warnings?: string[];
  states?: Partial<Record<IssueFormOptionSection, IssueReadState>>;
}

export type IssueFormOptionSection = 'fields' | 'members' | 'labels' | 'milestones' | 'templates';
export interface IssueReadState { status: IssueDetailSectionStatus; error?: string; complete?: boolean; loadedCount?: number; updatedAt?: string; }
/** Continuations remain in the Host; Webview requests can only advance this query. */
export interface IssuePageResult<T> {
  items: T[]; query: string; queryIdentity: string; complete: boolean; updatedAt: string;
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
  user: { id: string | number; name: string; username?: string };
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
export type IssueDetailSectionStatus = 'idle' | 'loading' | 'ready' | 'error' | 'unsupported';

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
  noteReactionStates?: Record<number, IssueReadState>;
  todos: GitLabTodo[];
  timelogs: IssueTimelog[];
  startDate: string | null;
  warnings: string[];
  notices?: string[];
  loadErrors?: Partial<Record<IssueDetailSection, string>>;
  permissionNotice?: string;
  startDateSupported?: boolean;
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
  canLogDatedTime?: boolean;
  canDeleteTimelog: boolean;
  sections?: Partial<Record<IssueDetailSection, IssueDetailSectionStatus>>;
}

export type IssuePanelRequest = (
  | { type: 'ready' }
  | { type: 'reconcileOperations'; pendingIds?: string[] }
  | { type: 'confirmOperationResult'; targetOperationId: string }
  | { type: 'cancelUpload'; targetRequestId: string }
  | { type: 'refresh' }
  | { type: 'loadSection'; sections: IssueDetailSection[] }
  | { type: 'loadFormOptions'; projectId: number; section: IssueFormOptionSection; mode?: 'next' }
  | { type: 'loadCreateProjects'; query?: string; mode?: 'next'; queryIdentity?: string }
  | { type: 'loadNoteReactions'; noteId: number }
  | { type: 'loadTemplate'; requestId: string; projectId: number; key: string }
  | { type: 'copyDescription'; requestId: string; issueId: number }
  | { type: 'selectProject'; projectId: number }
  | { type: 'create'; projectId: number; input: IssueCreateInput }
  | { type: 'update'; issueId: number; input: IssueUpdateInput; expectedUpdatedAt?: string }
  | { type: 'preview'; requestId: string; projectId: number; markdown: string; target?: string }
  | { type: 'search'; requestId: string; projectId: number; query: string; mode?: 'next'; queryIdentity?: string }
  | { type: 'searchProjects'; requestId: string; query: string; mode?: 'next'; queryIdentity?: string }
  | { type: 'upload'; requestId: string; projectId: number; target?: string }
  | { type: 'image'; requestId: string; url: string }
  | { type: 'invoke'; issueId: number; action: IssueAction; payload?: Record<string, unknown> }
  | { type: 'openIssueInGitLab'; issueId: number }
  | { type: 'openLink'; url: string }
) & { requestId?: string; operationId?: string; operationScope?: string; projectId?: number; issueIid?: number };

export type IssueAction =
  | 'close' | 'reopen' | 'subscribe' | 'unsubscribe' | 'todo' | 'todoDone'
  | 'note' | 'editNote' | 'deleteNote' | 'thread' | 'reply' | 'resolveThread'
  | 'react' | 'unreact' | 'reactNote' | 'unreactNote' | 'link' | 'unlink' | 'estimate' | 'spend'
  | 'resetEstimate' | 'resetSpent' | 'deleteTimelog' | 'move' | 'clone' | 'delete'
  | 'createChild' | 'addChild' | 'removeChild' | 'setChildState' | 'updateChild';

export type IssuePanelResponse = (
  | { type: 'createData'; projects: GitLabProject[]; projectsState?: IssuePageResult<GitLabProject>; selectedProjectId?: number; options?: IssueFormOptions; optionsLoading?: boolean; metadata?: GitLabMetadata; canSetStartDate: boolean; canCreateIssue: boolean }
  | { type: 'createProjectsPage'; page: IssuePageResult<GitLabProject> }
  | { type: 'projectData'; projectId: number; options: IssueFormOptions; optionsLoading?: boolean; preserveDraft?: boolean; canSetStartDate?: boolean; canCreateIssue: boolean }
  | { type: 'detailData'; data: IssueDetailData }
  | { type: 'detailPatch'; issueId: number; patch: Partial<IssueDetailData> }
  | { type: 'reply'; requestId: string; result?: unknown; error?: string; notificationOnly?: boolean }
  | { type: 'busy'; value: boolean }
  | { type: 'cancelled' }
  | { type: 'error'; message: string; notificationOnly?: boolean }
  | { type: 'deleted' }
  | { type: 'operationsSnapshot'; snapshot: OperationSnapshot }
  | { type: 'actionResult'; requestId: string; status: 'succeeded' | 'failed' | 'cancelled'; error?: string }
) & { operationId?: string; effect?: 'none' | 'applied' | 'partial' | 'unknown'; refreshError?: string };
