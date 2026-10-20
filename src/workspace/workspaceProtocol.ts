import type { GitLabCompareResult, GitLabGroup, GitLabIssue, GitLabIssueBoard, GitLabMember, GitLabMergeRequest, GitLabMergeRequestDiff, GitLabMilestone, GitLabProject, GitLabUser } from '../api/types';
import type { GitLabIssueDiscussion } from '../api/types';
import type { IssueGraphPatch, IssueGraphSnapshot } from './issueGraph';
import type { IssueFormOptions, IssuePanelRequest, IssuePanelResponse, IssueRelationsData } from '../issues/protocol';
import type { GitPanelMessage, GitPanelRequest } from '../git/gitProtocol';
import type { GitLabCapabilityDiagnostic } from '../api/graphqlCapabilities';
import type { GitLabAccount, AccountOperation, AccountPanelIntent } from '../connection/accountProtocol';
import type { WorkflowKitPolicy } from './workflowKitPolicy';
import type { GroupWorkspaceMatch } from './workspaceEnvironmentProtocol';
import type { ProjectRootContext } from './projectRootProtocol';
import type { OperationSnapshot, WorkspaceOperationState } from './operations';
import type { NotificationRequest, NotificationSnapshot } from '../notifications/notificationProtocol';
import type { RepositoryScanState, ScannedRepository } from '../git/repositoryScanProtocol';
import type { BmadCommandRequest, BmadWorkflowSnapshot } from './bmadProtocol';
import type { BmadEnvironmentCheck } from './bmadEnvironmentProtocol';

export type WorkspaceMode = 'clone' | 'sa' | 'bmad' | 'developer' | 'reviewer' | 'git';

/** Older versions persisted modes that no longer have a workspace page. */
export function normalizeWorkspaceMode(value: unknown): WorkspaceMode {
  switch (value) {
    case 'clone': case 'sa': case 'bmad': case 'developer': case 'reviewer': case 'git': return value;
    default: return 'developer';
  }
}
export type AnalysisIntent = 'requirements' | 'audit';
export type TimerPhase = 'running' | 'paused' | 'ready' | 'sending' | 'posted' | 'uncertain' | 'needs-review';
export type ToolSource = 'gitea' | 'github' | 'bundled';
export type RemoteToolSource = Exclude<ToolSource, 'bundled'>;
export type ToolArchiveFormat = 'zip' | 'tar.xz';
export type WorkspaceDestination = WorkspaceMode | 'issue-create' | 'issue-detail';
export type IssueDetailTab = 'content' | 'relations' | 'time';
export type WorkspaceSection = 'projects' | 'issues' | 'mergeRequests' | 'milestones' | 'boards' | 'graph' | 'repositories';
export interface WorkspaceSectionState { status: 'idle' | 'loading' | 'ready' | 'error' | 'unsupported'; error?: string; updatedAt?: number; refreshing?: boolean; }

/** These identities have different formats and must not be used interchangeably. */
export type ConnectedScope = string & { readonly __connectedScope: unique symbol };
export type LoadedWorkspaceIdentity = string & { readonly __loadedWorkspaceIdentity: unique symbol };

export type IssueNavigation =
  | { mode: 'create'; revision: number }
  | { mode: 'detail'; projectId: number; issueIid: number; tab?: IssueDetailTab; revision: number };

export interface LocalRepositoryState {
  path: string;
  state: 'missing' | 'ready' | 'unsafe';
  branch?: string;
}


export interface IssueDraftEvidence {
  path: string;
  claim: string;
}

export interface IssueDraft {
  id: string;
  projectPath: string;
  title: string;
  description: string;
  acceptanceCriteria: string[];
  sourceEvidence: IssueDraftEvidence[];
  labels?: string[];
}

export interface IssueDraftBundle {
  schema: 'IssueDraftBundle/v1';
  analysisId: string;
  drafts: IssueDraft[];
}

export interface DraftIssueResult {
  draftId: string;
  projectPath: string;
  issueIid?: number;
  url?: string;
  state: 'created' | 'already-created' | 'failed';
  message?: string;
}

export interface WorkspaceTimerEntry {
  id: string;
  projectId: number;
  projectPath: string;
  issueIid: number;
  title: string;
  elapsedSeconds: number;
  phase: TimerPhase;
  summary: string;
  spentAt?: string;
  updatedAt: number;
}

export type BranchFreshness =
  | { state: 'not_checked' }
  | { state: 'checking' }
  | { state: 'current'; sourceSha: string; targetSha: string; checkedAt: number }
  | { state: 'behind'; behindBy: number; sourceSha: string; targetSha: string; checkedAt: number }
  | { state: 'unknown'; reason: string; checkedAt: number };

export interface MergeRequestDetail {
  request: GitLabMergeRequest;
  sourceProject?: GitLabProject;
  diffs: GitLabMergeRequestDiff[];
  discussions: GitLabIssueDiscussion[];
  sections: { diffs: WorkspaceSectionState; discussions: WorkspaceSectionState };
  freshness: BranchFreshness;
  targetSha?: string;
  sourceSha?: string;
  compare?: GitLabCompareResult;
  warnings: string[];
}

export interface InstalledWorkflowKitState {
  profile?: 'group' | 'repository';
  upstreamVersions?: Record<string, string>;
  capabilities?: string[];
  version?: string;
  source?: ToolSource;
  status: 'installed' | 'missing' | 'update-available' | 'needs-cleanup' | 'checking' | 'installing' | 'error';
  message?: string;
  legacyPaths?: string[];
}

export interface WorkflowKitInstallTarget {
  profile?: 'group' | 'repository';
  root?: string;
  error?: string;
  manual: boolean;
  state: InstalledWorkflowKitState;
}

export interface SkillsContext {
  mode: 'group' | 'repository' | 'unavailable';
  root?: string;
  revision: string;
  groupMatch: GroupWorkspaceMatch;
  repositories: Array<{ name: string; path: string }>;
  reviewerRepositories?: Array<{ name: string; path: string; defaultBranch?: string }>;
  installed: InstalledWorkflowKitState;
  availableFeatures: string[];
  reason?: string;
  workspaceRoot?: string;
  workspaceFile?: string;
  workspaceRootAmbiguous?: boolean;
}

export interface WorkflowKitPackageSummary {
  id: string;
  version: string;
  skillCount?: number;
  source: ToolSource;
  assetName: string;
  format: ToolArchiveFormat;
  entryRoot: string;
  available: boolean;
  error?: string;
}

export interface WorkspaceSnapshot {
  bmad?: BmadWorkflowSnapshot;
  bmadEnvironment?: BmadEnvironmentCheck;
  notifications?: NotificationSnapshot;
  projectOperationBusy?: boolean;
  operationScope?: string;
  localOperationScope?: string;
  operations?: WorkspaceOperationState[];
  operationSnapshot?: OperationSnapshot;
  projectContext?: ProjectRootContext;
  connected: boolean;
  baseUrl?: string;
  instanceChecking?: boolean;
  instance?: { version?: string; enterprise?: boolean; warnings: string[]; capabilities?: GitLabCapabilityDiagnostic[] };
  currentUser?: GitLabUser;
  group?: GitLabGroup;
  groups: GitLabGroup[];
  groupRoot?: string;
  cloneRoot?: string;
  cloneRootError?: string;
  cloneRootManual?: boolean;
  skillsContext?: SkillsContext;
  workspaceRootError?: string;
  groupRepositories: Array<{ name: string; path: string }>;
  groupRepositoryScanStatus: 'idle' | 'scanning' | 'ready' | 'error';
  groupRepositoryScanError?: string;
  projects: GitLabProject[];
  sections?: Partial<Record<WorkspaceSection, WorkspaceSectionState>>;
  groupMilestones: GitLabMilestone[];
  groupMilestonesError?: string;
  groupIssueBoards: GitLabIssueBoard[];
  groupIssueBoardsError?: string;
  issueBoardContent?: {
    boardId: number;
    connectedScope: string;
    issueIds: number[];
    status: 'loading' | 'ready' | 'error';
    error?: string;
  };
  issueGraph?: IssueGraphSnapshot;
  issueGraphVersion?: number;
  localRepositories: Record<number, LocalRepositoryState>;
  projectLocalRepositories: Record<number, LocalRepositoryState>;
  issues: GitLabIssue[];
  mergeRequests: GitLabMergeRequest[];
  activeMode: WorkspaceMode;
  instanceUserScope?: string;
  connectedScope?: string;
  selectedProjectId?: number;
  selectedIssue?: { project: GitLabProject; issue: GitLabIssue };
  issuePreview?: { projectId: number; issueIid: number; status: 'loading' | 'ready' | 'error'; error?: string };
  accounts?: GitLabAccount[];
  activeAccountId?: string;
  accountOperation?: AccountOperation;
  localWorkspaceRepositories?: ScannedRepository[];
  repositoryScan?: RepositoryScanState;
  projectMembers: GitLabMember[];
  draftOptions?: { projectId: number; options: IssueFormOptions; canCreateIssue: boolean };
  selectedMergeRequest?: MergeRequestDetail;
  timers: WorkspaceTimerEntry[];
  timerVersion?: number;
  scopeEpoch?: number;
  workflowKit: InstalledWorkflowKitState;
  workflowKitInstallTarget: WorkflowKitInstallTarget;
  workflowKitPolicy?: WorkflowKitPolicy;
  workflowKitOperationBusy?: boolean;
  workflowKitSource: ToolSource;
  workflowKitPackages?: WorkflowKitPackageSummary[];
  cloneOperation?: CloneOperationState;
  busy?: boolean;
  error?: string;
}

export interface CloneOperationState {
  id: string;
  projectRevision?: string;
  scopeKey?: string;
  phase: 'running' | 'completed' | 'cancelled' | 'failed';
  label: string;
  items: Array<{
    projectId: number;
    projectPath: string;
    state: 'waiting' | 'starting' | 'progress' | 'completed' | 'updated' | 'upToDate' | 'skipped' | 'failed';
    percent?: number;
    message?: string;
  }>;
}

export type OperationRecoveryMetadata = Pick<WorkspaceOperationState, 'requestId' | 'resourceKey' | 'action' | 'label' | 'correlationId' | 'lockKey' | 'kind'>;

export type WorkspaceRequest = (NotificationRequest
  | GitPanelRequest
  | { type: 'ready'; projectSource?: 'gitlab' | 'local'; developerView?: 'list' | 'graph' }
  | { type: 'reconcileOperations'; pendingIds?: string[] }
  | { type: 'confirmOperationResult'; targetOperationId: string; recovery?: OperationRecoveryMetadata }
  | GitPanelRequest
  | { type: 'refresh'; mode?: WorkspaceMode; projectSource?: 'gitlab' | 'local' }
  | { type: 'retryInstanceCheck' }
  | { type: 'setMode'; mode: WorkspaceMode; projectSource?: 'gitlab' | 'local' }
  | { type: 'setProjectSource'; source: 'gitlab' | 'local' }
  | { type: 'issueRequest'; request: IssuePanelRequest; revision?: number }
  | { type: 'closeIssue' }
  | { type: 'connect' }
  | { type: 'openAccountManager' }
  | { type: 'submitAccountLogin'; requestId: string; baseUrl: string; token: string; accountId?: string }
  | { type: 'disconnect'; accountId?: string }
  | { type: 'addAccount'; accountId?: string }
  | { type: 'switchAccount'; accountId: string }
  | { type: 'removeAccount'; accountId: string }
  | { type: 'openLogs' }
  | { type: 'scanRepositories' }
  | { type: 'cancelRepositoryScan' }
  | { type: 'cancelRepositoryOperation' }
  | { type: 'resyncWorkspace' }
  | { type: 'selectGroup'; groupId?: number }
  | { type: 'selectIssueBoard'; boardId: number; connectedScope: string }
  | { type: 'loadIssueGraph'; connectedScope: string; forceNetwork?: boolean }
  | { type: 'setIssueGraphVisibility'; visible: boolean; connectedScope: string }
  | { type: 'retryWorkspaceSection'; section: 'projects' | 'issues' | 'mergeRequests' | 'milestones' | 'boards'; connectedScope: string }
  | { type: 'loadIssueRelations'; requestId: string; connectedScope: string; projectId: number; issueIid: number }
  | { type: 'mutateIssueRelations'; requestId: string; connectedScope: string; projectId: number; issueIid: number; action: import('../issues/protocol').IssueRelationAction }
  | { type: 'openLocalWorkspace' }
  | { type: 'selectProjectFolder'; folderUri: string }
  | { type: 'selectProjectRoot' }
  | { type: 'resetProjectRoot' }
  | { type: 'selectCloneRoot' }
  | { type: 'resetCloneRoot' }
  | { type: 'openCodexTerminal'; revision: string }
  | { type: 'refreshBmad' }
  | ({ type: 'copyBmadCommand' } & { [Key in keyof BmadCommandRequest]: BmadCommandRequest[Key] })
  | { type: 'openBmadTerminal'; revision: string }
  | { type: 'openBmadArtifact'; revision: string; stepId: string; path: string }
  | { type: 'clone'; projectIds: number[]; cloneAll?: boolean }
  | { type: 'cloneSelection'; requestId: string; scopeKey?: string; projectIds: number[] }
  | { type: 'syncRepos' }
  | { type: 'selectProject'; projectId: number }
  | { type: 'selectIssue'; projectId: number; issueIid: number }
  | { type: 'openIssue'; projectId: number; issueIid: number; tab?: IssueDetailTab }
  | { type: 'createIssue' }
  | { type: 'copy'; text: string }
  | { type: 'importIssueDrafts'; json: string }
  | { type: 'createIssueDrafts'; analysisId: string; drafts: IssueDraft[]; options: Record<string, { assigneeId?: number; labels: string[]; milestoneId?: number }> }
  | { type: 'loadDraftOptions'; projectId: number }
  | { type: 'checkSimilarIssues'; drafts: IssueDraft[] }
  | { type: 'openExternal'; url: string }
  | { type: 'startTimer'; projectId: number; issueIid: number }
  | { type: 'pauseTimer'; id: string }
  | { type: 'resumeTimer'; id: string }
  | { type: 'stopTimer'; id: string }
  | { type: 'addManualTime'; projectId: number; issueIid: number; duration: string; summary: string; spentAt?: string }
  | { type: 'updateTimeEntry'; id: string; duration: string; summary: string; spentAt: string }
  | { type: 'submitTimeEntry'; id: string }
  | { type: 'acknowledgeTimeEntry'; id: string }
  | { type: 'selectMergeRequest'; projectId: number; iid: number }
  | { type: 'refreshMergeRequest'; projectId: number; iid: number }
  | { type: 'reconcileMergeRequestWrite'; projectId: number; iid: number }
  | { type: 'loadMergeRequestSection'; section: 'diffs' | 'discussions'; projectId: number; iid: number }
  | { type: 'postMergeRequestNote'; projectId: number; iid: number; body: string }
  | { type: 'openBranchReview'; projectId: number; iid: number }
  | { type: 'loadSkillBranches'; repo: string; revision: string; requestId: string }
  | { type: 'replyMergeRequest'; projectId: number; iid: number; discussionId: string; body: string }
  | { type: 'approveMergeRequest'; projectId: number; iid: number; sha: string }
  | { type: 'mergeMergeRequest'; projectId: number; iid: number; sha: string }
  | { type: 'setWorkflowKitSource'; source: ToolSource }
  | { type: 'openWorkflowKitDownload'; source: RemoteToolSource }
  | { type: 'importWorkflowKitPackage'; source: RemoteToolSource }
  | { type: 'refreshWorkflowKit' }
  | { type: 'copySkillGuidePrompt'; featureId: string; inputs: Record<string, string>; revision: string }
  | { type: 'openWorkspaceFolder' }
  | { type: 'selectWorkflowKitInstallRoot' }
  | { type: 'resetWorkflowKitInstallRoot' }
  | { type: 'installWorkflowKit'; packageId: string }
) & { projectRevision?: string; operationId?: string; operationScope?: string; hostSessionId?: string; scopeEpoch?: number };

export type WorkspaceResponse =
  | { type: 'notificationsChanged'; snapshot: NotificationSnapshot }
  | { type: 'openNotifications' }
  | { type: 'operationChanged'; operation: WorkspaceOperationState }
  | { type: 'operationsSnapshot'; snapshot: OperationSnapshot }
  | { type: 'branchReviewReady'; revision: string; inputs: Record<string, string>; notice?: string }
  | { type: 'skillBranches'; revision: string; repo: string; requestId: string; branches: string[]; error?: string }
  | { type: 'openAccountManager'; intent: AccountPanelIntent }
  | { type: 'accountLoginResult'; requestId: string; error?: string; name?: string }
  | GitPanelMessage
  | { type: 'snapshot'; snapshot: WorkspaceSnapshot; streamId?: string; version?: number; scope?: string }
  | { type: 'snapshotPatch'; streamId: string; scope: string; baseVersion: number; version: number; changes: Partial<WorkspaceSnapshot>; cleared: Array<keyof WorkspaceSnapshot> }
  | { type: 'timersChanged'; instanceUserScope: string; version: number; timers: WorkspaceTimerEntry[] }
  | { type: 'issueGraphChanged'; connectedScope: string; version: number; graph: IssueGraphSnapshot }
  | ({ type: 'issueGraphPatch'; version: number } & IssueGraphPatch)
  | { type: 'issueRelations'; requestId: string; connectedScope: string; projectId: number; issueIid: number; data?: IssueRelationsData; mutationApplied?: boolean; effect?: WorkspaceOperationState['effect']; refreshError?: string; error?: string }
  | { type: 'busy'; value: boolean; label?: string }
  | { type: 'message'; message: string }
  | { type: 'error'; message: string; scopeRevision?: string }
  | { type: 'draftBundle'; bundle: IssueDraftBundle }
  | { type: 'draftResults'; analysisId: string; results: DraftIssueResult[] }
  | { type: 'draftOptions'; projectId: number; options: IssueFormOptions; canCreateIssue: boolean }
  | { type: 'similarIssues'; items: Array<{ draftId: string; projectPath: string; issues: Array<{ iid: number; title: string; webUrl: string }> }> }
  | { type: 'issueResponse'; response: IssuePanelResponse; revision?: number }
  | { type: 'issueNavigation'; navigation: IssueNavigation | null }
  | { type: 'requestCloneSelection'; requestId: string }
  | ({ type: 'cloneOperation' } & CloneOperationState)
  | { type: 'reply'; requestId: string; value?: unknown; error?: string };
