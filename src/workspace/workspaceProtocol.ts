import type { GitLabCompareResult, GitLabGroup, GitLabIssue, GitLabIssueBoard, GitLabMember, GitLabMergeRequest, GitLabMergeRequestDiff, GitLabMilestone, GitLabProject, GitLabUser } from '../api/types';
import type { GitLabIssueDiscussion } from '../api/types';
import type { IssueGraphSnapshot } from './issueGraph';
import type { IssueFormOptions, IssuePanelRequest, IssuePanelResponse, IssueRelationsData } from '../issues/protocol';

export type WorkspaceMode = 'clone' | 'sa' | 'developer' | 'reviewer';
export type AnalysisIntent = 'requirements' | 'audit';
export type TimerPhase = 'running' | 'paused' | 'ready' | 'sending' | 'posted' | 'uncertain' | 'needs-review';
export type ToolSource = 'gitea' | 'github' | 'bundled';
export type RemoteToolSource = Exclude<ToolSource, 'bundled'>;
export type ToolArchiveFormat = 'zip' | 'tar.xz';
export type WorkspaceDestination = WorkspaceMode | 'issue-create' | 'issue-detail';
export type IssueDetailTab = 'content' | 'development' | 'relations' | 'time';

export type IssueNavigation =
  | { mode: 'create'; revision: number }
  | { mode: 'detail'; projectId: number; issueIid: number; tab?: IssueDetailTab; revision: number };

export interface LocalRepositoryState {
  path: string;
  state: 'missing' | 'ready' | 'unsafe';
  branch?: string;
}

export interface MeginWorkSummary {
  workId: string;
  status: string;
  planVersion?: string;
  issueProjectId?: number;
  issueIid?: number;
  projectPath?: string;
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
  freshness: BranchFreshness;
  targetSha?: string;
  sourceSha?: string;
  compare?: GitLabCompareResult;
  warnings: string[];
}

export interface InstalledWorkflowKitState {
  version?: string;
  source?: ToolSource;
  status: 'installed' | 'missing' | 'update-available' | 'work-in-progress' | 'needs-cleanup' | 'checking' | 'installing' | 'error';
  message?: string;
  legacyPaths?: string[];
}

export interface WorkflowKitPackageSummary {
  id: string;
  version: string;
  source: ToolSource;
  assetName: string;
  format: ToolArchiveFormat;
  entryRoot: string;
  available: boolean;
  error?: string;
}

export interface WorkspaceSnapshot {
  connected: boolean;
  baseUrl?: string;
  instance?: { version?: string; enterprise?: boolean; warnings: string[] };
  currentUser?: GitLabUser;
  group?: GitLabGroup;
  groups: GitLabGroup[];
  groupRoot?: string;
  workspaceRootError?: string;
  groupRepositories: Array<{ name: string; path: string }>;
  groupRepositoryScanStatus: 'idle' | 'scanning' | 'ready' | 'error';
  groupRepositoryScanError?: string;
  projects: GitLabProject[];
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
  issues: GitLabIssue[];
  mergeRequests: GitLabMergeRequest[];
  activeMode: WorkspaceMode;
  instanceUserScope?: string;
  connectedScope?: string;
  selectedProjectId?: number;
  selectedIssue?: { project: GitLabProject; issue: GitLabIssue };
  projectMembers: GitLabMember[];
  draftOptions?: { projectId: number; options: IssueFormOptions; canCreateIssue: boolean };
  selectedMergeRequest?: MergeRequestDetail;
  timers: WorkspaceTimerEntry[];
  timerVersion?: number;
  scopeEpoch?: number;
  workflowKit: InstalledWorkflowKitState;
  workflowKitSource: ToolSource;
  workflowKitPackages?: WorkflowKitPackageSummary[];
  meginWorkItems: MeginWorkSummary[];
  deliveryRecords: DeliveryPreview[];
  cloneOperation?: CloneOperationState;
  busy?: boolean;
  error?: string;
}

export interface CloneOperationState {
  id: string;
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

export type WorkspaceRequest =
  | { type: 'ready' }
  | { type: 'refresh' }
  | { type: 'toggleFullDisplay' }
  | { type: 'setMode'; mode: WorkspaceMode }
  | { type: 'issueRequest'; request: IssuePanelRequest; revision?: number }
  | { type: 'closeIssue' }
  | { type: 'connect' }
  | { type: 'disconnect' }
  | { type: 'selectGroup'; groupId?: number }
  | { type: 'selectIssueBoard'; boardId: number; connectedScope: string }
  | { type: 'loadIssueGraph'; connectedScope: string }
  | { type: 'loadIssueRelations'; requestId: string; connectedScope: string; projectId: number; issueIid: number }
  | { type: 'mutateIssueRelations'; requestId: string; connectedScope: string; projectId: number; issueIid: number; action: import('../issues/protocol').IssueRelationAction }
  | { type: 'openLocalWorkspace' }
  | { type: 'openCodexTerminal' }
  | { type: 'copyAndOpenCodex'; text: string; returnTo: string }
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
  | { type: 'postMergeRequestNote'; projectId: number; iid: number; body: string }
  | { type: 'openMergeReviewTask'; projectId: number; iid: number }
  | { type: 'openGroupQuickReview' }
  | { type: 'importMergeReviewReport'; projectId: number; iid: number; text?: string }
  | { type: 'publishMergeReviewReport'; projectId: number; iid: number; text: string }
  | { type: 'replyMergeRequest'; projectId: number; iid: number; discussionId: string; body: string }
  | { type: 'approveMergeRequest'; projectId: number; iid: number; sha: string }
  | { type: 'mergeMergeRequest'; projectId: number; iid: number; sha: string }
  | { type: 'prepareDelivery'; projectId: number; issueIid: number; workId: string; summary: string; changes: string; tests: string; targetBranch: string; reviewerIds: number[]; acceptanceConfirmed: boolean }
  | { type: 'commitDelivery'; deliveryId: string }
  | { type: 'copyWikiUpdatePrompt'; deliveryId: string }
  | { type: 'pushDelivery'; deliveryId: string }
  | { type: 'createDeliveryMergeRequest'; deliveryId: string }
  | { type: 'setWorkflowKitSource'; source: ToolSource }
  | { type: 'openWorkflowKitDownload'; source: RemoteToolSource }
  | { type: 'importWorkflowKitPackage'; source: RemoteToolSource }
  | { type: 'refreshWorkflowKit' }
  | { type: 'installWorkflowKit'; packageId: string };

export type WorkspaceResponse =
  | { type: 'snapshot'; snapshot: WorkspaceSnapshot }
  | { type: 'timersChanged'; instanceUserScope: string; version: number; timers: WorkspaceTimerEntry[] }
  | { type: 'issueGraphChanged'; connectedScope: string; version: number; graph: IssueGraphSnapshot }
  | { type: 'issueRelations'; requestId: string; connectedScope: string; projectId: number; issueIid: number; data?: IssueRelationsData; mutationApplied?: boolean; error?: string }
  | { type: 'busy'; value: boolean; label?: string }
  | { type: 'message'; message: string }
  | { type: 'error'; message: string }
  | { type: 'draftBundle'; bundle: IssueDraftBundle }
  | { type: 'draftResults'; analysisId: string; results: DraftIssueResult[] }
  | { type: 'deliveryPreview'; delivery: DeliveryPreview }
  | { type: 'deliveryProgress'; delivery: DeliveryPreview }
  | { type: 'mergeReviewReportImported'; projectId: number; iid: number; text: string; sourceSha: string; targetSha: string }
  | { type: 'draftOptions'; projectId: number; options: IssueFormOptions; canCreateIssue: boolean }
  | { type: 'similarIssues'; items: Array<{ draftId: string; projectPath: string; issues: Array<{ iid: number; title: string; webUrl: string }> }> }
  | { type: 'issueResponse'; response: IssuePanelResponse; revision?: number }
  | { type: 'issueNavigation'; navigation: IssueNavigation | null }
  | { type: 'requestCloneSelection'; requestId: string }
  | ({ type: 'cloneOperation' } & CloneOperationState)
  | { type: 'reply'; requestId: string; value?: unknown; error?: string };

export interface DeliveryPreview {
  id: string;
  projectId: number;
  issueIid: number;
  repoPath: string;
  branch: string;
  targetBranch: string;
  workId: string;
  acceptanceConfirmed: boolean;
  summary: string;
  changes: string;
  tests: string;
  reviewerIds: number[];
  headSha: string;
  baseSha: string;
  baseTargetSha: string;
  diffSha256: string;
  statusSnapshot: string;
  diffStat: string;
  diff: string;
  changedFiles: string[];
  gate: { ok: boolean; reasons: string[] };
  state: 'preview' | 'committed' | 'pushed' | 'mr-created';
  mergeRequestUrl?: string;
  error?: string;
  updatedAt: number;
  instanceVerified?: boolean;
  handoffSha256?: string;
  groupRoot?: string;
  remote?: string;
  remoteUrl?: string;
  issueProjectId?: number;
  planVersion?: string;
  acceptanceVersion?: string;
  acceptedSnapshot?: string;
  reviewResult?: { verdict: string; context?: string; snapshot?: string };
  verificationResults?: Array<{ id: string; status: string; executed?: number }>;
  approvedRepositories?: Array<{ repoPath: string; projectId: number; branch: string; commit?: string; baseSha?: string; allowedPaths?: string[] }>;
}
