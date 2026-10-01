import type { GitLabCompareResult, GitLabGroup, GitLabIssue, GitLabMember, GitLabMergeRequest, GitLabMergeRequestDiff, GitLabProject, GitLabUser } from '../api/types';
import type { GitLabIssueDiscussion } from '../api/types';
import type { IssueFormOptions, IssuePanelRequest, IssuePanelResponse } from '../issues/protocol';

export type WorkspaceMode = 'clone' | 'sa' | 'developer' | 'reviewer';
export type AnalysisIntent = 'requirements' | 'audit';
export type TimerPhase = 'running' | 'paused' | 'ready' | 'sending' | 'posted' | 'uncertain' | 'needs-review';
export type ToolSource = 'auto' | 'github' | 'gitea';
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

export type ToolId = 'codebase-wiki' | 'megin' | 'merge-reviewer';
export interface InstalledToolState {
  tool: ToolId;
  version?: string;
  source?: Exclude<ToolSource, 'auto'>;
  status: 'installed' | 'missing' | 'update-available' | 'checking' | 'installing' | 'error';
  message?: string;
}

export interface ToolReleaseSummary {
  tag: string;
  version: string;
  source: Exclude<ToolSource, 'auto'>;
  assetName: string;
  releaseUrl: string;
  sha256Verified: boolean;
}

export interface WorkspaceSnapshot {
  connected: boolean;
  baseUrl?: string;
  currentUser?: GitLabUser;
  group?: GitLabGroup;
  groups: GitLabGroup[];
  groupRoot?: string;
  projects: GitLabProject[];
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
  tools: InstalledToolState[];
  toolSource: ToolSource;
  toolReleases?: Partial<Record<ToolId, ToolReleaseSummary[]>>;
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
  | { type: 'setMode'; mode: WorkspaceMode }
  | { type: 'issueRequest'; request: IssuePanelRequest; revision?: number }
  | { type: 'closeIssue' }
  | { type: 'connect' }
  | { type: 'disconnect' }
  | { type: 'selectGroup'; groupId?: number }
  | { type: 'selectWorkspace' }
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
  | { type: 'replyMergeRequest'; projectId: number; iid: number; discussionId: string; body: string }
  | { type: 'approveMergeRequest'; projectId: number; iid: number; sha: string }
  | { type: 'mergeMergeRequest'; projectId: number; iid: number; sha: string }
  | { type: 'prepareDelivery'; projectId: number; issueIid: number; workId: string; summary: string; changes: string; tests: string; targetBranch: string; reviewerIds: number[]; acceptanceConfirmed: boolean }
  | { type: 'commitDelivery'; deliveryId: string }
  | { type: 'pushDelivery'; deliveryId: string }
  | { type: 'createDeliveryMergeRequest'; deliveryId: string }
  | { type: 'setToolSource'; source: ToolSource }
  | { type: 'saveGiteaToken'; token: string }
  | { type: 'refreshTools' }
  | { type: 'listToolReleases'; tool: ToolId }
  | { type: 'installTool'; tool: ToolId; version?: string };

export type WorkspaceResponse =
  | { type: 'snapshot'; snapshot: WorkspaceSnapshot }
  | { type: 'busy'; value: boolean; label?: string }
  | { type: 'message'; message: string }
  | { type: 'error'; message: string }
  | { type: 'draftBundle'; bundle: IssueDraftBundle }
  | { type: 'toolReleases'; tool: ToolId; releases: ToolReleaseSummary[]; fallbackMessage?: string }
  | { type: 'draftResults'; analysisId: string; results: DraftIssueResult[] }
  | { type: 'deliveryPreview'; delivery: DeliveryPreview }
  | { type: 'deliveryProgress'; delivery: DeliveryPreview }
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
}
