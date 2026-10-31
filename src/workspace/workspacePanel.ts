import { readReviewerCapabilities } from './reviewerCapabilities';
import * as vscode from 'vscode';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { AsyncLocalStorage } from 'node:async_hooks';
import { access, readFile, writeFile, mkdir, mkdtemp, unlink, rmdir, readdir, lstat, realpath } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { GitLabApiError, gitLabWriteFailureEffect, type GitLabClient } from '../api/gitLabClient';
import { timeEntryTimestamp } from '../api/timeEntry';
import { mergeAvailability } from '../api/actionAvailability';
import { GitLabBudgetExceededError, GitLabRequestBudget } from '../api/gitLabRequestBudget';
import { withReadObservation, type ReadObservation } from '../api/readObservation';
import { readVerifiedMergeRequestDiff } from './mergeRequestDiffRead';
import { gitLabReadLifetimeMs, groupBoardReadKey, groupWorkspaceReadKey, type GitLabReadInvalidation } from '../api/gitLabReadKeys';
import type { GitLabGraphWorkItem, GitLabGroup, GitLabIssue, GitLabIssueBoard, GitLabMergeRequest, GitLabMilestone, GitLabProject, GitLabUser, GitLabPage, GitLabBoardMembershipCursor, GitLabIssueGraphCursor } from '../api/types';
import type { IssueFormOptions } from '../issues/protocol';
import type { IssuePanels } from '../issues/issuePanel';
import { cloneProjects, createScopedGitEnvironment, prepareOperationLayout, projectRemoteIdentity, projectRemoteMatches, syncLocalDefaultBranches } from '../git/cloneService';
import { resolveLocalRepositoryLayout } from './localRepositoryLayout';
import { groupRepositoryPath, inspectWorkflowKitInstallRoot, localRepositoryStateAsync, resolveWorkflowKitInstallRoot, sameLocalPath, sameRealLocalPathAsync, scanLocalGroupRepositories, type LocalGroupRepository, type WorkspaceRootResolution } from './workspacePaths';
import { resolvePythonRuntime } from './pythonRuntime';
import { workflowKitFailure, workflowKitWarnings } from './workflowKitResult';
import { BmadWorkflowController } from './bmadWorkflowController';
import { buildBmadCommand } from './bmadCommand';
import { bmadKitTaskIssue } from './bmadKit';
import { inspectBmadEnvironment } from './bmadEnvironment';
import type { BmadEnvironmentCheck } from './bmadEnvironmentProtocol';
import type { BmadCommandRequest } from './bmadProtocol';
import { IssueTimeTracker, gitLabDuration } from './timeTracker';
import { OperationTracker, isActiveOperation, type WorkspaceOperationState } from './operations';
import { SnapshotTransport } from './snapshotTransport';
import { describeAction, effectiveOperationScope } from './actionPolicy';
import { NotificationCenter } from '../notifications/notificationCenter';
import { collectWorkspaceFeedback } from '../notifications/workspaceFeedback';
import type { NotificationOrigin } from '../notifications/notificationProtocol';
import { issueGraphEdge, issueGraphNodeKey, mapWithConcurrency, type IssueGraphNode, type IssueGraphSnapshot } from './issueGraph';
import { buildIssueDraftDescription, containsIssueDraftMarker, matchDraftProject, parseIssueDraftBundle } from './issueDrafts';
import { WorkflowKitReleaseManager, WORKFLOW_KIT_RELEASES, TOOL_SOURCE_KEY, compareVersions, PackageIntegrityError } from './workflowKitReleases';
import { installedKitIdentity } from './workflowKitIntegration';
import type {
  BranchFreshness, ConnectedScope, LoadedWorkspaceIdentity, DraftIssueResult, InstalledWorkflowKitState, IssueDetailTab, IssueDraft,
  CloneOperationState, SkillsContext, IssueNavigation, MergeRequestDetail, OperationRecoveryMetadata, RemoteToolSource, ToolSource, WorkflowKitInstallTarget, WorkspaceMode, WorkspaceRequest, WorkspaceResponse, WorkspaceSection, WorkspaceSectionState, WorkspaceSnapshot, WorkspaceTimerEntry
} from './workspaceProtocol';
import type { WorkflowKitRelease } from './workflowKitReleases';
import { normalizeWorkspaceMode } from './workspaceProtocol';
import type { GitLabSession } from '../connection/session';
import { isAllowedGitRemote, normalizeGitLabBaseUrl } from '../api/urlPolicy';
import type { AccountOperation, AccountPanelIntent } from '../connection/accountProtocol';
import type { GroupWorkspaceMatch } from './workspaceEnvironment';
import { ProjectEnvironmentSnapshotCache } from './projectEnvironmentSnapshotCache';
import { PROJECT_FOLDER_KEY, PROJECT_ROOT_SETTING, resolveProjectRootContext, selectedProjectFolder, type ProjectFolder, type ProjectRootContext } from './projectRoot';
import { resolveSkillsContext } from './skillsContext';
import { buildSkillGuideContext, buildSkillGuidePrompt, canCopySkillPrompt, getSkillGuideCards, resolveReviewerRepository } from '../webview/skillsGuideData';
import { collectReviewerRepositories } from './reviewerRepositories';
import { readReviewerBranches } from './reviewerBranches';
import { readReviewSessions, readReviewJob, cancelReviewSession, reviewSessionScript, invalidateReviewAuth, reviewerAuthScope, defaultReviewRuntime, reviewRuntimeCandidates, resolveReviewRuntime } from './reviewSessions';
import { isReviewerTool, type ReviewerToolId } from './reviewSessionProtocol';
import { reviewerExecutionFromConfiguration, type ReviewerExecutionOverrides } from './reviewExecution';
import { readInstalledReviewerBinding } from './installedReviewer';
import { workflowKitPolicy, type WorkflowKitPolicy } from './workflowKitPolicy';
import { GitRepositoryService } from '../git/gitRepositoryService';
import { withGitDirectoryLock, withGitDirectoryLocks } from '../git/repositoryOperationLock';
import { isGitPanelRequest, isGitWriteAction } from '../git/gitProtocol';
import type { GitPanelMessage } from '../git/gitProtocol';
import type { LogContext } from '../logging/logProtocol';
import type { LogOutcome } from '../logging/operationLog';
import { logGitCommand } from '../git/gitCommandLog';
import { localPathKey, DEFAULT_SCAN_EXCLUDES, type RepositoryScanState, type ScannedRepository } from '../git/repositoryScanner';

const execFileAsync = promisify(execFile);
const SELECTED_MODE_KEY = 'gitlabWorkspace.workspace.mode';
const MR_WRITES_KEY = 'gitlabWorkspace.pendingMrWrites.v1';
const MAX_DIFF_BYTES = 320_000;
const SELECTED_GIT_REPOSITORY_KEY = 'gitlabWorkspace.selectedGitRepositoryId';
const ALLOWED_MODES = new Set<WorkspaceMode>(['clone', 'sa', 'bmad', 'developer', 'reviewer', 'git']);

interface PendingMrWrite { key: string; marker: string; groupId: number; userId: number; projectId: number; iid: number; discussionId?: string; state: 'sending' | 'uncertain'; }
type ActionMetadata = Pick<WorkspaceRequest, 'operationId' | 'operationScope' | 'hostSessionId' | 'scopeEpoch'>;
type ActionOutcome = Parameters<OperationTracker['noteOutcome']>[1];
interface WorkspaceRefreshOptions {
  forceNetwork?: boolean;
  forceRepositories?: boolean;
  refreshGitSnapshot?: boolean;
  reason?: string;
}

/** A failed read may leave the server's cooldown active after its request ends. */
function readFailureTransport(state: WorkspaceSectionState | undefined, error: unknown): Pick<WorkspaceSectionState, 'transportStage' | 'retryAt'> {
  const reported = error && typeof error === 'object' && 'retryAt' in error && typeof error.retryAt === 'number' ? error.retryAt : undefined;
  const retryAt = reported ?? (state?.transportStage === 'cooldown' ? state.retryAt : undefined);
  return retryAt !== undefined && Number.isFinite(retryAt) && retryAt > Date.now()
    ? { transportStage: 'cooldown', retryAt } : { transportStage: undefined, retryAt: undefined };
}

export class WorkspacePanel implements vscode.Disposable {
  private projectEnvironmentSnapshots?: ProjectEnvironmentSnapshotCache;
  private bmad?: BmadWorkflowController;
  private bmadEnvironment?: BmadEnvironmentCheck;
  private bmadEnvironmentRead?: { root?: string; task: Promise<void> };
  private issuePreview?: WorkspaceSnapshot['issuePreview'];
  private previewGeneration = 0;
  private previewAbort?: AbortController;
  private writesInFlight = 0;
  private accountTransitionBusy = false;
  private accountOperation?: AccountOperation;
  private pendingAccountPanel?: AccountPanelIntent;
  private accountLoginRequestId?: string;
  private readonly accountLoginReceipts = new Map<string, Extract<WorkspaceResponse, { type: 'accountLoginResult' }>>();
  private localWorkspaceRepositories: ScannedRepository[] = [];
  private reviewerNativeRepositories: ScannedRepository[] = [];
  private reviewerWorkspaceFolders?: { signature: string; folders: string[] };
  private repositoryScan: RepositoryScanState = { status: 'idle', checkedDirectories: 0, repositories: [], errors: [], excludes: DEFAULT_SCAN_EXCLUDES };
  private repositoryScanAbort?: AbortController;
  private repositoryOperationAbort?: AbortController;
  private inventoryGeneration = 0;
  private panel?: vscode.WebviewPanel;
  private readonly timer: IssueTimeTracker;
  private readonly packages: WorkflowKitReleaseManager;
  private interval?: NodeJS.Timeout;
  private timerVersion = 0;
  private issueGraphVersion = 0;
  private timerTickInFlight = false;
  private localRepositoryStates: WorkspaceSnapshot['localRepositories'] = {};
  private localRepositoriesKey?: string;
  private localRepositoryScanGeneration = 0;
  private projectLocalRepositoryStates: WorkspaceSnapshot['projectLocalRepositories'] = {};
  private projectRepositoriesKey?: string;
  private projectRepositoryScanGeneration = 0;
  private projectContext?: ProjectRootContext;
  private cloneRoot?: string;
  private cloneRootError?: string;
  private cloneRootManual = false;
  private cloneRootScope?: string;
  private cloneRootGeneration = 0;
  private cloneRootSelecting = false;
  private actualRepositories: LocalGroupRepository[] = [];
  private actualRepositoriesRoot?: string;
  private actualRepositoryScanStatus: WorkspaceSnapshot['groupRepositoryScanStatus'] = 'idle';
  private actualRepositoryScanError?: string;
  private actualRepositoryScanTask?: { key: string; task: Promise<void> };
  private actualRepositoryScanGeneration = 0;
  private actualRepositoryScanAbort?: AbortController;
  private workspaceMatch: GroupWorkspaceMatch = { status: 'checking', repositories: [] };
  private skillsEnvironmentGeneration = 0;
  private remoteWatchers: vscode.Disposable[] = [];
  private remoteWatchSignature = '';
  private remoteRefreshTimer?: ReturnType<typeof setTimeout>;
  private groupRoot?: string;
  private workspaceRootError?: string;
  private workspaceFoldersGeneration = 0;
  private pendingWorkspaceRefresh = false;
  private groups: WorkspaceSnapshot['groups'] = [];
  private projects: GitLabProject[] = [];
  private readonly workspaceSections: Partial<Record<WorkspaceSection, WorkspaceSectionState>> = {};
  private workspaceSectionPages = new Map<WorkspaceSection, { scope: string; cursor?: string; complete: boolean; includeClosed: boolean; seen: Set<string>; projectRevision?: number }>();
  private readonly workspaceSectionGenerations = new Map<WorkspaceSection, number>();
  private readonly workspaceSectionAborts = new Map<WorkspaceSection, AbortController>();
  private workspaceSectionReads = new Map<WorkspaceSection, { scope: string; task: Promise<void>; controller?: AbortController }>();
  private requestedWorkspaceSections = new Set<'boards' | 'milestones'>();
  private issueNavigation: IssueNavigation | null = null;
  private viewGeneration = 0;
  private navigationGeneration = 0;
  private viewReadAbort = new AbortController();
  private readonly pendingViewNotices: unknown[] = [];
  private pendingNotificationsOpen = false;
  private pendingSettingsOpen = false;
  private restoredOnce = false;
  private readonly gitWriteReceipts = new Map<string, Extract<GitPanelMessage, { type: 'gitActionResult' }>>();
  private groupMilestones: GitLabMilestone[] = [];
  private groupMilestonesError?: string;
  private groupIssueBoards: GitLabIssueBoard[] = [];
  private groupIssueBoardsError?: string;
  private selectedIssueBoardId?: number;
  private issueBoardContent?: WorkspaceSnapshot['issueBoardContent'];
  private issueBoardGeneration = 0;
  private issueBoardAbort?: AbortController;
  private issueBoardLoad?: { connectedScope: string; connectionEpoch: number; groupPath: string; boardId: number; username: string; cursor?: GitLabBoardMembershipCursor; issueIds: Set<number>; complete: boolean; updatedAt: number };
  private issueGraph?: IssueGraphSnapshot;
  private issueGraphGeneration = 0;
  private issueGraphAbort?: AbortController;
  private issueGraphRootLimit = 100;
  private graphReadCancellation = 0;
  private graphBoardMemberships = new Map<number, Array<{ issueId: number; projectId?: number; iid?: number }>>();
  private graphBoardLoads = new Map<number, { cursor?: GitLabBoardMembershipCursor; complete: boolean }>();
  private graphRelationLoads = new Map<string, { workItemsCursor?: GitLabIssueGraphCursor; workItemsComplete: boolean; linksCursor?: string; linksComplete: boolean; workItemsFailed?: boolean }>();
  private issueGraphPublishTimer?: NodeJS.Timeout;
  private issueGraphRequestedScope?: string;
  private issueGraphRead?: { scope: string; task: Promise<void> };
  private issueGraphVisible = false;
  private issueGraphStale = false;
  private snapshotGraphScope?: string;
  private issues: GitLabIssue[] = [];
  private mergeRequests: GitLabMergeRequest[] = [];
  private mergeRequestFilter: 'all' | 'reviewer' | 'assigned' = 'all';
  private selectedIssue?: WorkspaceSnapshot['selectedIssue'];
  private projectMembers: WorkspaceSnapshot['projectMembers'] = [];
  private selectedMergeRequest?: MergeRequestDetail;
  private mergeRequestGeneration = 0;
  private mergeRequestAbort?: AbortController;
  private mergeRequestSummaryGeneration = 0;
  private mergeRequestRead?: { key: string; force: boolean; controller: AbortController; task: Promise<void> };
  private mergeRequestBranchRead?: { key: string; controller: AbortController; task: Promise<void> };
  private readonly mergeRequestSectionAborts: Partial<Record<'diffs' | 'discussions', AbortController>> = {};
  private readonly mergeRequestSectionGenerations: Record<'diffs' | 'discussions', number> = { diffs: 0, discussions: 0 };
  private readonly mrWritesInFlight = new Set<string>();
  private selectedProjectId?: number;
  private activeMode: WorkspaceMode;
  private projectSource: 'gitlab' | 'local' = 'gitlab';
  private developerView: 'list' | 'graph' = 'list';
  private currentUser?: GitLabUser;
  private workflowKitState: InstalledWorkflowKitState = { status: 'missing' };
  private workflowKitInstallWarnings?: { root: string; version: string; warnings: string[] };
  private workflowKitStateRoot?: string;
  private skillsWorkflowKitState: InstalledWorkflowKitState = { status: 'missing' };
  private skillsWorkflowKitStateRoot?: string;
  private workflowKitInstallTarget: WorkflowKitInstallTarget = { manual: false, state: { status: 'missing' } };
  private workflowKitInstallation?: WorkflowKitInstallTarget;
  private workflowKitSelectingRoot = false;
  private workflowKitCheckingRelease = false;
  private workflowKitHelperQueue?: Promise<void>;
  private workflowKitRefreshGeneration = 0;
  private workflowKitRefreshTask?: { signature: string; projects: GitLabProject[]; installation: WorkflowKitInstallTarget | undefined; signal?: AbortSignal; task: Promise<void> };
  private workflowKitInstallRefreshGeneration = 0;
  private workflowKitInstallRefreshTask?: { signature: string; installation: WorkflowKitInstallTarget | undefined; signal?: AbortSignal; task: Promise<void> };
  private workflowKitInstallIdentity?: { revision: string; root?: string; profile?: 'group' | 'repository'; remoteFingerprint?: string };
  private operationTracker?: OperationTracker;
  private get operations(): OperationTracker { return this.operationTracker ??= new OperationTracker(operation => {
    this.notifications.recordOperation(operation);
    this.post({ type: 'operationChanged', operation });
  }); }
  private operationContextStorage?: AsyncLocalStorage<string>;
  private get operationContext(): AsyncLocalStorage<string> { return this.operationContextStorage ??= new AsyncLocalStorage<string>(); }
  private busyOwners?: Map<string, string>;
  private get notifications(): NotificationCenter { return this.notificationCenter ??= new NotificationCenter(); }
  private readonly skillBranchReads = new Map<string, Promise<string[]>>();
  private reviewWatcher?: vscode.FileSystemWatcher;
  private reviewWatcherRoot?: string;
  private reviewRefreshTimer?: NodeJS.Timeout;
  private reviewAuthHostNonce?: string;
  private reviewAuthTransition = false;
  private readonly workflowKitStatusReads = new Map<string, Promise<InstalledWorkflowKitState>>();
  private workflowKitReleases: WorkflowKitRelease[] = [];
  private busy = false;
  private instanceCheckBusy = false;
  private repositoryOperationInProgress = false;
  private cloneOperation?: CloneOperationState;
  private webviewReady = false;
  private readyViewGeneration?: number;
  private readonly cloneSelectionWaiters = new Map<string, { resolve: (projectIds: number[]) => void; timeout: NodeJS.Timeout }>();
  private requestGeneration = 0;
  private refreshScopeKey?: string;
  private refreshTask?: Promise<void>;
  private refreshForceNetwork = false;
  private workspaceRefreshPending = false;
  private pendingMergeRequestRead?: { projectId: number; iid: number };
  private refreshAbort?: AbortController;
  private issueOpenGeneration = 0;
  private issueOpenAbort?: AbortController;
  private loadedScopeKey?: LoadedWorkspaceIdentity;
  private snapshotTransport?: SnapshotTransport;
  private associatedRepositoryCache?: { repositories: ScannedRepository[]; projects: GitLabProject[]; value: ScannedRepository[] };
  private skillsContextCache?: { signature: string; context?: ProjectRootContext; match: GroupWorkspaceMatch; installed: InstalledWorkflowKitState; projects: GitLabProject[]; value: SkillsContext };
  private disposed = false;
  private timerQueue: Promise<unknown> = Promise.resolve();
  private issuePublishQueue: Promise<unknown> = Promise.resolve();
  private readonly issueRelationWritesInFlight = new Set<string>();
  private selectedGitRepositoryId?: string;
  private gitPanelReady = false;
  private gitRepositoryListDirty = false;
  private gitRepositoryListTimer?: ReturnType<typeof setTimeout>;
  private webviewMessagesSent = 0;
  private webviewMessagesReceived = 0;
  private readonly gitMessages: vscode.Disposable;
  private readonly gitRepositoryChanges: vscode.Disposable;
  private readonly readInvalidation: vscode.Disposable;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly session: GitLabSession,
    private readonly issuePanels: IssuePanels,
    private readonly syncSidebarState?: () => void | Promise<void>,
    private readonly gitRepositories?: GitRepositoryService,
    private notificationCenter?: NotificationCenter,
    operationTracker?: OperationTracker
  ) {
    if (operationTracker) {
      this.operationTracker = operationTracker;
      context.subscriptions.push(operationTracker.subscribe(operation => this.post({ type: 'operationChanged', operation })));
    }
    context.subscriptions.push(this.notifications.onDidChange(() => this.post({ type: 'notificationsChanged', snapshot: this.notifications.snapshot() })));
    this.timer = new IssueTimeTracker(context.globalState);
    session.setBeforeTransition(async () => {
      this.assertAccountTransitionAllowed();
      this.reviewAuthHostNonce = randomUUID();
      this.reviewAuthTransition = true;
      this.skillsContextCache = undefined;
      await this.invalidateReviewAuthObservations();
      const pause = () => this.enqueueTimer(async () => {
        for (const entry of this.timer.list()) if (entry.phase === 'running') await this.timer.pause(entry.id);
      });
      if (this.timer.list().some(entry => entry.phase === 'running') && session.log) await session.log.run('time', 'pauseForAccountChange', this.logContext(), pause);
      else await pause();
      this.previewAbort?.abort(); this.previewGeneration++;
    });
    session.setAfterTransition?.(async () => {
      if (!this.reviewAuthTransition) return;
      try { await this.invalidateReviewAuthObservations(); }
      finally { this.reviewAuthTransition = false; }
    });
    context.subscriptions.push(vscode.workspace.onDidChangeWorkspaceFolders(() => this.onWorkspaceFoldersChanged()));
    context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(event => {
      if (event.affectsConfiguration('gitlabWorkspace.reviewer.execution') || event.affectsConfiguration('gitlabWorkspace.reviewRuntimePath')) {
        this.skillsContextCache = undefined;
        this.sendSnapshot();
      }
      if (!event.affectsConfiguration(`gitlabWorkspace.${PROJECT_ROOT_SETTING}`)) return;
      this.onWorkspaceFoldersChanged();
      void Promise.resolve(this.syncSidebarState?.()).catch(() => undefined);
    }));
    const savedToolSource = context.globalState.get<unknown>(TOOL_SOURCE_KEY);
    if (savedToolSource !== 'gitea' && savedToolSource !== 'github') {
      void Promise.resolve(context.globalState.update(TOOL_SOURCE_KEY, 'github')).catch(() => undefined);
    }
    this.packages = new WorkflowKitReleaseManager(context.globalStorageUri.fsPath);
    this.activeMode = normalizeWorkspaceMode(context.globalState.get<unknown>(SELECTED_MODE_KEY));
    this.selectedGitRepositoryId = context.globalState.get<string>(SELECTED_GIT_REPOSITORY_KEY);
    this.gitMessages = gitRepositories?.onDidMessage((message) => this.post(message)) ?? { dispose: () => undefined };
    this.gitRepositoryChanges = gitRepositories?.onDidChangeRepositoryList(() => {
      this.skillBranchReads.clear();
      this.gitRepositoryListDirty = true;
      this.scheduleGitRepositoryListSend();
      this.scheduleSkillsEnvironmentRefresh();
    }) ?? { dispose: () => undefined };
    this.readInvalidation = session.onDidInvalidateReads((change) => this.invalidateWorkspaceReads(change));
    context.subscriptions.push(session.onDidChangeInstanceChecks?.(() => {
      this.sendSnapshot();
      void Promise.resolve(this.syncSidebarState?.()).catch(() => undefined);
    }) ?? { dispose: () => undefined });
    context.subscriptions.push(this.gitMessages, this.gitRepositoryChanges, this.readInvalidation);
    this.issuePanels.setWorkspace({
      post: (message) => this.post(message),
      show: () => this.show('developer'),
      navigate: (navigation) => { this.issueNavigation = navigation; if (navigation) this.activeMode = 'developer'; this.post({ type: 'issueNavigation', navigation }); }
    });
  }

  dispose(): void {
    this.reviewWatcher?.dispose();
    if (this.reviewRefreshTimer) clearTimeout(this.reviewRefreshTimer);
    this.projectEnvironmentSnapshots?.clear();
    this.bmad?.dispose();
    this.remoteWatchers?.forEach(watcher => watcher.dispose());
    if (this.remoteRefreshTimer) clearTimeout(this.remoteRefreshTimer);
    this.disposed = true;
    this.gitMessages.dispose(); this.gitRepositoryChanges.dispose(); this.readInvalidation.dispose();
    this.suspendViewReads();
    this.gitWriteReceipts.clear();
    this.gitRepositories?.setActivePanelRepository(undefined);
    this.repositoryScanAbort?.abort(); this.previewAbort?.abort();
    this.repositoryOperationAbort?.abort();
    this.issueGraphGeneration++;
    this.issueGraphAbort?.abort();
    this.issueBoardAbort?.abort();
    this.mergeRequestAbort?.abort();
    this.cancelMergeRequestSectionReads();
    this.issueOpenAbort?.abort();
    if (this.issueGraphPublishTimer) clearTimeout(this.issueGraphPublishTimer);
    if (this.gitRepositoryListTimer) clearTimeout(this.gitRepositoryListTimer);
    this.localRepositoryScanGeneration++;
    this.actualRepositoryScanGeneration++;
    this.actualRepositoryScanAbort?.abort();
    if (this.interval) clearInterval(this.interval);
    this.webviewReady = false;
    for (const waiter of this.cloneSelectionWaiters.values()) {
      clearTimeout(waiter.timeout);
      waiter.resolve([]);
    }
    this.cloneSelectionWaiters.clear();
    this.panel?.dispose();
    this.panel = undefined;
  }

  async show(mode?: WorkspaceMode, options: { refresh?: boolean } = {}): Promise<void> {
    const changed = !!mode && mode !== this.activeMode;
    if (mode && ALLOWED_MODES.has(mode)) this.activeMode = mode;
    const assetRoot = vscode.Uri.joinPath(this.context.extensionUri, 'resources', 'issue-webview');
    if (!this.panel) {
      const panel = vscode.window.createWebviewPanel('gitlabWorkspace.dashboard', 'GitLab Workspace', vscode.ViewColumn.Active, {
        enableScripts: true,
        localResourceRoots: [assetRoot]
      });
      this.panel = panel;
      this.webviewReady = false;
      const nonce = randomBytes(16).toString('base64');
      const htmlPath = vscode.Uri.joinPath(assetRoot, 'dashboard.html');
      let html = await readFile(htmlPath.fsPath, 'utf8');
      const base = panel.webview.asWebviewUri(assetRoot).toString().replace(/\/$/, '') + '/';
      html = html.replace('<head>', `<head><base href="${base}"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${panel.webview.cspSource} data: https:; style-src ${panel.webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}' ${panel.webview.cspSource}; worker-src ${panel.webview.cspSource} blob:; font-src ${panel.webview.cspSource};">`);
      html = html.replace(/<script([^>]*)>/, `<script nonce="${nonce}"$1>`);
      panel.webview.html = html;
      const messageListener = panel.webview.onDidReceiveMessage((message: unknown) => {
        void this.handleMessage(message).catch(() => undefined);
      });
      panel.onDidDispose(() => {
        messageListener.dispose();
        if (this.panel === panel) {
          this.pendingSettingsOpen = false;
          this.gitRepositories?.setActivePanelRepository(undefined);
          if (this.gitRepositoryListTimer) { clearTimeout(this.gitRepositoryListTimer); this.gitRepositoryListTimer = undefined; }
          this.suspendViewReads();
          this.panel = undefined; this.webviewReady = false;
        }
      });
      panel.onDidChangeViewState(() => {
        if (this.panel !== panel) return;
        this.gitRepositories?.setActivePanelRepository(panel.visible && this.activeMode === 'git' ? this.selectedGitRepositoryId : undefined);
        if (!panel.visible) this.suspendViewReads();
        if (panel.visible) this.scheduleGitRepositoryListSend();
      });
    } else {
      this.panel.reveal(vscode.ViewColumn.Active);
    }
    if (this.webviewReady && options.refresh !== false && changed) {
      await this.withReadHandoff(async () => {
        this.cancelPageReads(); this.sendSnapshot();
        await this.refresh({ reason: 'entry' });
      });
    }
  }

  async navigateTo(mode?: WorkspaceMode, repositoryId?: string): Promise<void> {
    await this.withReadHandoff(() => this.navigateToPage(mode, repositoryId));
  }

  private async navigateToPage(mode?: WorkspaceMode, repositoryId?: string): Promise<void> {
    const generation = (this.navigationGeneration ?? 0) + 1;
    this.navigationGeneration = generation;
    const current = () => !this.disposed && generation === this.navigationGeneration;
    const panelAlreadyReady = !!this.panel && this.webviewReady;
    const sameGitRepository = (mode ?? this.activeMode) === 'git' && this.activeMode === 'git' && (!repositoryId || repositoryId === this.selectedGitRepositoryId);
    this.issueOpenGeneration++;
    this.issuePanels.close();
    if (mode && ALLOWED_MODES.has(mode)) {
      if (repositoryId && this.gitRepositories) {
        const state = this.gitRepositories.getCachedSummaryState();
        if (!current()) { this.noteOutcome({ status: 'cancelled', effect: 'none' }); return; }
        if (!state.repositories.some((repository) => repository.id === repositoryId)) {
          throw new Error('找不到這個工作區 Repo，請重新整理側欄清單。');
        }
        this.selectedGitRepositoryId = repositoryId;
        await this.context.globalState.update(SELECTED_GIT_REPOSITORY_KEY, repositoryId);
        if (!current()) { this.noteOutcome({ status: 'cancelled', effect: 'none' }); return; }
      }
      this.activeMode = mode;
      await this.context.globalState.update(SELECTED_MODE_KEY, mode);
    }
    if (!current()) { this.noteOutcome({ status: 'cancelled', effect: 'none' }); return; }
    this.gitRepositories?.setActivePanelRepository(this.activeMode === 'git' && this.panel?.visible ? this.selectedGitRepositoryId : undefined);
    await this.show(undefined, { refresh: !panelAlreadyReady });
    if (!current()) { this.noteOutcome({ status: 'cancelled', effect: 'none' }); return; }
    if (panelAlreadyReady) {
      this.cancelPageReads();
      this.sendSnapshot();
      await this.refresh({ reason: 'entry', refreshGitSnapshot: sameGitRepository });
    }
  }

  getActiveMode(): WorkspaceMode { return this.activeMode; }
  getSelectedGitRepositoryId(): string | undefined { return this.selectedGitRepositoryId; }
  getGitLabProjects(): readonly GitLabProject[] { return this.projects; }
  getAccountUiState(): { accountOperation?: AccountOperation; workflowKitPolicy: WorkflowKitPolicy } {
    return { accountOperation: this.accountOperation, workflowKitPolicy: this.getWorkflowKitPolicy() };
  }

  async openAccountManager(accountId?: string, startLogin = false): Promise<void> {
    if (accountId && !this.session.accounts.some(account => account.id === accountId)) throw new Error('找不到此 GitLab 帳號。');
    this.pendingAccountPanel = { id: randomUUID(), startLogin, accountId };
    await this.show(undefined, { refresh: false });
    if (this.webviewReady) {
      this.sendSnapshot();
      this.publishAccountPanel();
    }
  }

  private publishAccountPanel(): void {
    if (!this.pendingAccountPanel || !this.webviewReady) return;
    this.post({ type: 'openAccountManager', intent: this.pendingAccountPanel });
    this.pendingAccountPanel = undefined;
  }
  getWebviewMessageCountsForTesting(): { sent: number; received: number } {
    return { sent: this.webviewMessagesSent, received: this.webviewMessagesReceived };
  }

  getNotificationOrigin(): NotificationOrigin {
    return { accountId: this.session.activeAccountId, baseUrl: this.session.baseUrl,
      groupId: this.session.selectedGroup?.id, root: this.projectContext?.root ?? this.groupRoot };
  }

  async openNotifications(): Promise<void> {
    this.pendingNotificationsOpen = true;
    await this.show(undefined, { refresh: false });
    if (this.webviewReady) { this.post({ type: 'openNotifications' }); this.pendingNotificationsOpen = false; }
  }

  async openSettings(): Promise<void> {
    this.pendingSettingsOpen = true;
    try { await this.show(undefined, { refresh: false }); }
    catch (error) { this.pendingSettingsOpen = false; throw error; }
    this.publishSettings();
  }

  private publishSettings(): void {
    if (!this.pendingSettingsOpen || !this.webviewReady) return;
    this.post({ type: 'openSettings' });
    this.pendingSettingsOpen = false;
  }

  async refreshFromSidebar(): Promise<void> {
    this.issueOpenGeneration++;
    if (this.issueNavigation) await this.issuePanels.refreshActive();
    else await this.refresh({ forceNetwork: true, forceRepositories: true, refreshGitSnapshot: true, reason: 'manual' });
    await this.syncSidebarState?.();
  }

  async selectGroupFromSidebar(group?: GitLabGroup): Promise<void> {
    await this.selectGroup(group?.id);
  }

  async disconnectFromSidebar(): Promise<void> {
    await this.runLogged('disconnect', () => this.disconnect());
  }

  async connectFromSidebar(): Promise<void> {
    await this.runLogged('connect', () => this.connect());
  }

  async accountFromSidebar(action: 'addAccount' | 'switchAccount' | 'removeAccount', accountId?: string): Promise<void> {
    await this.runLogged(action, () => action === 'addAccount' ? this.connect(accountId) : action === 'switchAccount'
      ? this.switchAccount(accountId) : this.removeAccount(accountId));
  }

  async scanFromSidebar(): Promise<void> { await this.runLogged('scanRepositories', () => this.scanRepositories()); }

  private assertAccountTransitionAllowed(): void {
    if (this.repositoryOperationInProgress || this.gitRepositories?.hasActiveOperations || this.session.hasActiveWrites || this.writesInFlight ||
      this.mrWritesInFlight.size || this.issueRelationWritesInFlight.size || this.timer.list().some(entry => entry.phase === 'sending')) {
      throw new Error('目前有 GitLab 寫入或 Repo 操作，完成後才能切換帳號或登出。');
    }
  }

  private logContext(): LogContext {
    return { accountId: this.session.activeAccountId, baseUrl: this.session.baseUrl, groupId: this.session.selectedGroup?.id };
  }
  private runLogged<T>(action: string, task: () => Promise<T>, context: LogContext = {}, outcome?: () => LogOutcome): Promise<T> {
    const feature = /Account|connect|disconnect/i.test(action) ? 'account' : /timer|Time/i.test(action) ? 'time'
      : /Issue|issue/i.test(action) ? 'issue' : /Merge|Review/i.test(action) ? 'workflow'
      : /Kit|Package/i.test(action) ? 'tools' : /scan|clone|syncRepos/i.test(action) ? 'projects' : /Group/i.test(action) ? 'group'
      : this.activeMode === 'sa' ? 'analysis' : 'workspace';
    return this.session.log?.run(feature, action, { ...this.logContext(), ...context }, task, outcome) ?? task();
  }

  async cloneFromSidebar(
    mode: 'all' | 'selected' | 'pick'
  ): Promise<void> {
    try {
      await this.navigateTo('clone');
      const group = this.session.selectedGroup;
      if (!group) { this.post({ type: 'error', message: '請先連線 GitLab 並選擇 Group。' }); return; }
      if (mode === 'pick') {
        const picks = await vscode.window.showQuickPick(this.projects.map((project) => ({
          label: project.name, description: project.namespace?.full_path ?? project.path_with_namespace, detail: project.path, project
        })), { title: '選擇要下載或更新的專案', placeHolder: '可複選 Repo', canPickMany: true, ignoreFocusOut: true });
        if (!picks?.length) { this.noteOutcome({ status: 'cancelled', effect: 'none' }); return; }
        await this.clone(picks.map((item) => item.project.id), false);
      } else if (mode === 'all') {
        await this.clone([], true);
      } else {
        await this.waitForWebviewReady();
        const ids = await this.requestSelectedProjectIds();
        if (this.session.selectedGroup?.id !== group.id) { this.post({ type: 'message', message: '目前 Group 已變更，請重新選取專案。' }); return; }
        if (!ids.length) { this.post({ type: 'message', message: '請先在專案清單勾選要下載或更新的 Repo。' }); return; }
        await this.clone(ids, false);
      }
    } catch (error) { this.post({ type: 'error', message: readableError(error) }); }
  }

  async syncFromSidebar(): Promise<void> {
    try { await this.navigateTo('clone'); await this.syncRepos(); }
    catch (error) { this.post({ type: 'error', message: readableError(error) }); }
  }

  private async requestSelectedProjectIds(): Promise<number[]> {
    const requestId = randomUUID();
    const response = new Promise<number[]>((resolve) => {
      const timeout = setTimeout(() => {
        this.cloneSelectionWaiters.delete(requestId);
        resolve([]);
      }, 15000);
      this.cloneSelectionWaiters.set(requestId, { resolve, timeout });
    });
    this.post({ type: 'requestCloneSelection', requestId });
    return response;
  }

  private async waitForWebviewReady(): Promise<void> {
    if (this.webviewReady && this.panel) return;
    const deadline = Date.now() + 15000;
    while (!this.webviewReady && this.panel && Date.now() < deadline) {
      await new Promise<void>((resolve) => setTimeout(resolve, 100));
    }
    if (!this.webviewReady) throw new Error('工作台尚未載入完成，請稍後再試。');
  }

  private post(message: unknown): void {
    if (message && typeof message === 'object' && 'type' in message) {
      const value = message as WorkspaceResponse;
      if (value.type === 'issueResponse' && value.response.type === 'detailData') {
        const { issue, project } = value.response.data;
        if (this.projects.some(item => item.id === issue.project_id)) {
          const assigned = (issue.assignees ?? []).some(user => user.id === this.currentUser?.id);
          const exists = this.issues.some(item => item.project_id === issue.project_id && item.iid === issue.iid);
          this.issues = this.issues.flatMap(item => item.project_id === issue.project_id && item.iid === issue.iid ? assigned ? [issue] : [] : [item]);
          if (assigned && !exists) this.issues = [...this.issues, issue];
          if (this.selectedIssue?.issue.project_id === issue.project_id && this.selectedIssue.issue.iid === issue.iid) this.selectedIssue = { issue, project };
          this.sendSnapshot();
        }
      }
      if (value.type === 'error' || value.type === 'gitError') this.noteOutcome({ status: 'failed', error: value.message });
      if (value.type === 'gitActionResult' && value.error) this.noteOutcome({ status: 'failed', error: value.error, effect: value.effect });
      if (value.type === 'gitActionResult' && value.refreshError) this.noteOutcome({ effect: value.effect, refreshError: value.refreshError });
      if (value.type === 'accountLoginResult' && value.error) this.noteOutcome({ status: 'failed', effect: 'none', error: value.error });
      if (value.type === 'issueRelations' && value.error) this.noteOutcome(value.mutationApplied
        ? { status: 'succeeded', effect: 'applied', refreshError: value.error }
        : { status: 'failed', effect: value.effect ?? 'none', error: value.error });
      if (value.type === 'issueResponse' && (value.response.type === 'error' || value.response.type === 'reply')) {
        const response = value.response;
        const error = response.type === 'error' ? response.message : response.error;
        const effect = 'effect' in response ? response.effect : undefined;
        if (error) this.noteOutcome(effect === 'applied'
          ? { status: 'succeeded', effect, refreshError: error }
          : { status: 'failed', error, effect });
      }
      if (value.type === 'issueResponse' && value.response.type === 'actionResult') this.noteOutcome({
        status: value.response.status, effect: value.response.effect, error: value.response.error, refreshError: value.response.refreshError
      });
      if (value.type === 'draftResults' && value.results.some(item => item.state === 'failed')) {
        const id = this.operationContext.getStore(), operation = id && this.operations.get(id);
        const unknown = operation && operation.effect === 'unknown';
        this.noteOutcome({ status: 'failed', effect: unknown ? 'unknown' : value.results.some(item => item.state !== 'failed') ? 'partial' : 'none',
          error: unknown ? operation.error ?? 'Issue 建立結果未確認，請先核對，勿直接重送。' : '部分 Issue 建立失敗，請查看結果後重試未建立項目。' });
      }
    }
    if (message && typeof message === 'object' && 'type' in message) {
      const value = message as WorkspaceResponse;
      const id = this.operationContext.getStore();
      if (value.type === 'draftResults' && id && this.operations.get(id)?.effect === 'unknown') {
        this.notifications.publish({ level: 'warn', title: '建立 Issue', message: 'Issue 寫入結果未確認，已停止後續草稿；請先到 GitLab 核對實際結果，勿直接重送。', operationId: id, origin: this.getNotificationOrigin() });
      } else if (collectWorkspaceFeedback(this.notifications, value, this.getNotificationOrigin(), id,
        id => this.operations.get(id)?.requestId)) return;
    }
    if (message && typeof message === 'object' && 'type' in message) {
      if (message.type === 'issueResponse' && 'response' in message && message.response && typeof message.response === 'object'
        && 'requestId' in message.response && 'error' in message.response && typeof message.response.error === 'string') {
        for (const operation of this.operations.list()) {
          if (operation.action === 'issueRequest' && operation.correlationId === message.response.requestId) this.operations.noteError(operation.requestId, message.response.error);
        }
      }
      if (message.type === 'gitActionResult' && 'requestId' in message && 'error' in message && typeof message.error === 'string') {
        for (const operation of this.operations.list()) {
          if (operation.action === 'gitAction' && operation.correlationId === message.requestId) this.operations.noteError(operation.requestId, message.error);
        }
      }
      if (message.type === 'cloneOperation' && 'items' in message && Array.isArray(message.items)) {
        const items = message.items as CloneOperationState['items'];
        const active = items.find(item => item.state === 'starting' || item.state === 'progress');
        for (const operation of this.operations.list(this.operationScope())) {
          if (['clone', 'syncRepos'].includes(operation.action)) this.operations.update(operation.requestId, {
            phase: active ? `正在處理 ${active.projectPath}` : '正在核對 Repo 結果…', total: items.length,
            completed: items.filter(item => ['completed', 'updated', 'upToDate', 'skipped', 'failed'].includes(item.state)).length });
        }
      }
    }
    if (message && typeof message === 'object' && 'type' in message && 'message' in message &&
      (message.type === 'error' || message.type === 'gitError') && typeof message.message === 'string') {
      this.session.log?.record({ feature: message.type === 'gitError' ? 'git' : 'workspace', action: 'operationError', result: 'error', message: message.message });
    }
    if (!this.disposed && (!this.panel || this.panel.visible === false || !this.webviewReady) && message && typeof message === 'object' && 'type' in message &&
      (message.type === 'accountLoginResult' ||
        message.type === 'issueResponse' && 'response' in message && message.response && typeof message.response === 'object' && 'type' in message.response && message.response.type === 'reply')) {
      this.pendingViewNotices.push(message);
      if (this.pendingViewNotices.length > 128) this.pendingViewNotices.shift();
    }
    this.sendViewMessage(message);
  }

  private sendViewMessage(message: unknown): void {
    if (this.panel && this.panel.visible !== false && this.webviewReady && !this.disposed) {
      this.webviewMessagesSent++;
      void this.panel.webview.postMessage(message);
    }
  }

  private rememberGitWriteReceipt(receipt: Extract<GitPanelMessage, { type: 'gitActionResult' }>): void {
    if (this.disposed) return;
    this.gitWriteReceipts.set(receipt.requestId, receipt);
    if (this.gitWriteReceipts.size > 128) this.gitWriteReceipts.delete(this.gitWriteReceipts.keys().next().value!);
  }

  private async sendGitRepositories(): Promise<void> {
    if (!this.panel || !this.gitRepositories) return;
    const generation = this.viewGeneration;
    this.gitRepositoryListDirty = false;
    try {
      const state = this.gitRepositories.getCachedSummaryState();
      if (generation !== this.viewGeneration || this.disposed) { this.gitRepositoryListDirty = true; return; }
      this.post({
        type: 'gitRepositories',
        repositories: state.repositories,
        available: state.available,
        message: state.message,
        revision: state.revision,
        selectedRepositoryId: this.selectedGitRepositoryId
      });
    } catch (error) {
      this.gitRepositoryListDirty = true;
      this.post({ type: 'gitError', message: readableError(error) });
    }
  }

  private scheduleGitRepositoryListSend(): void {
    if (!this.panel?.visible || !this.gitPanelReady || this.activeMode !== 'git' || !this.gitRepositoryListDirty) return;
    if (this.gitRepositoryListTimer) clearTimeout(this.gitRepositoryListTimer);
    this.gitRepositoryListTimer = setTimeout(() => {
      this.gitRepositoryListTimer = undefined;
      if (this.panel?.visible && this.gitPanelReady && this.activeMode === 'git' && this.gitRepositoryListDirty) void this.sendGitRepositories();
    }, 1_000);
  }

  private async handleGitPanelRequest(request: import('../git/gitProtocol').GitPanelRequest): Promise<void> {
    if (request.type === 'gitAction' && !isGitWriteAction(request.action) &&
      (!this.panel?.visible || this.activeMode !== 'git')) {
      this.noteOutcome({ status: 'cancelled', effect: 'none' });
      this.post({ type: 'gitActionResult', requestId: request.requestId });
      return;
    }
    if (request.type === 'gitAction' && this.accountTransitionBusy &&
      isGitWriteAction(request.action)) {
      this.post({ type: 'gitActionResult', requestId: request.requestId, error: '帳號正在切換，請稍後再執行版控操作。' });
      return;
    }
    if (!this.gitRepositories) {
      this.post({ type: 'gitError', message: 'Git 版控服務尚未載入。' });
      return;
    }
    if (request.type === 'gitAcknowledgeResult') { this.gitWriteReceipts.delete(request.requestId); return; }
    if (request.type === 'gitReady') {
      this.gitPanelReady = true;
      this.gitRepositoryListDirty = true;
      this.gitRepositories.setActivePanelRepository(this.panel?.visible && this.activeMode === 'git' ? this.selectedGitRepositoryId : undefined, false);
      if (this.panel?.visible && this.activeMode === 'git') await this.sendGitRepositories();
      for (const receipt of this.gitWriteReceipts.values()) this.sendViewMessage(receipt);
      return;
    }
    if (request.type === 'gitOpenRepository') {
      const repositoryId = await this.gitRepositories.openRepositoryPath(request.path);
      if (!repositoryId) throw new Error('這個 Group Repo 尚未由 VS Code Git 偵測到，請先重新開啟此 Repo。');
      await this.navigateTo('git', repositoryId);
      return;
    }
    if (request.type === 'gitOpenMergeEditor' || request.type === 'gitOpenFile' || request.type === 'gitOpenDiff') {
      try {
        if (request.type === 'gitOpenDiff') await this.gitRepositories.openNativeDiff(request.repositoryId, request.path, request.staged, request.ref, request.parent);
        else await this.gitRepositories.openRepositoryFile(request.repositoryId, request.path, request.type === 'gitOpenMergeEditor');
      }
      catch (error) { this.post({ type: 'gitError', message: readableError(error) }); }
      return;
    }
    try {
      if (request.action.type === 'open' || request.action.type === 'refresh') {
        this.selectedGitRepositoryId = request.repoId;
        void this.context.globalState.update(SELECTED_GIT_REPOSITORY_KEY, request.repoId);
        this.gitRepositories.setActivePanelRepository(this.panel?.visible && this.activeMode === 'git' ? request.repoId : undefined, false);
      }
      const snapshot = await this.gitRepositories.handleAction(request.repoId, request.action);
      if (snapshot) this.post({ type: 'gitSnapshot', snapshot, requestId: request.requestId });
      const write = isGitWriteAction(request.action);
      const cancelled = !write && !snapshot || snapshot?.actionCancelled === true || request.action.type === 'commit' && snapshot?.commitCompleted === false;
      const receipt: Extract<GitPanelMessage, { type: 'gitActionResult' }> = { type: 'gitActionResult', requestId: request.requestId,
        commitCompleted: snapshot?.commitCompleted, write, effect: snapshot?.actionEffect ?? (write && !cancelled ? 'applied' : 'none') };
      if (cancelled) this.noteOutcome({ status: 'cancelled', effect: 'none' });
      else this.noteOutcome({ effect: receipt.effect });
      if (request.repoId === this.selectedGitRepositoryId) {
        try { await this.syncSidebarState?.(); }
        catch (error) { receipt.refreshError = readableError(error); this.noteOutcome({ refreshError: receipt.refreshError }); }
      }
      if (isGitWriteAction(request.action)) this.rememberGitWriteReceipt(receipt);
      this.post(receipt);
    } catch (error) {
      const details = error && typeof error === 'object' ? error as { effect?: WorkspaceOperationState['effect']; refreshError?: string; commitCompleted?: boolean; actionCancelled?: boolean } : {};
      const effect = details.effect ?? (isGitWriteAction(request.action) && /結果(?:尚未|未能)確認/.test(readableError(error)) ? 'unknown' : 'none');
      const receipt: Extract<GitPanelMessage, { type: 'gitActionResult' }> = { type: 'gitActionResult', requestId: request.requestId,
        ...(effect === 'applied' ? { refreshError: details.refreshError ?? readableError(error) } : { error: readableError(error) }),
        effect, commitCompleted: details.commitCompleted, write: isGitWriteAction(request.action) };
      this.noteOutcome({ status: details.actionCancelled ? 'cancelled' : effect === 'applied' ? 'succeeded' : 'failed', effect, error: receipt.error, refreshError: receipt.refreshError });
      if (isGitWriteAction(request.action)) this.rememberGitWriteReceipt(receipt);
      this.post(receipt);
    }
  }

  private async handleMessage(value: unknown): Promise<void> {
    try { await this.handleOperationMessage(value); }
    catch (error) {
      if (value && typeof value === 'object' && 'type' in value && typeof value.type === 'string' && ['control', 'local'].includes(describeAction(value as { type: string }).kind)) {
        this.post({ type: 'error', message: readableError(error) });
      }
      throw error;
    }
  }

  private async handleOperationMessage(value: unknown): Promise<void> {
    if (!value || typeof value !== 'object' || !('type' in value) || typeof value.type !== 'string') return;
    let request = value as WorkspaceRequest;
    if (request.operationId !== undefined && (typeof request.operationId !== 'string' || !/^[a-z0-9-]{1,100}$/i.test(request.operationId))) throw new Error('操作識別碼無效，請重新載入工作台。');
    if (request.operationScope !== undefined && (typeof request.operationScope !== 'string' || request.operationScope.length > 500)) throw new Error('工作區識別資料無效，請重新載入工作台。');
    let normalizationError: unknown;
    if (request.type === 'issueRequest' && this.issuePanels?.normalizeOperationRequest) {
      try { request = { ...request, request: this.issuePanels.normalizeOperationRequest(request.request) }; }
      catch (error) { normalizationError = error; }
    }
    await this.runAction(request, async () => {
      if (normalizationError) { this.noteOutcome({ effect: 'none' }); throw normalizationError; }
      await this.dispatchMessage(request);
      // Repository adapters already note the authoritative result, including
      // uncertainty after cancellation. A UI summary must not weaken it.
      if (request.type === 'scanRepositories') {
        if (this.repositoryScan.status === 'cancelled') return { status: 'cancelled', effect: 'none' };
        if (this.repositoryScan.status === 'error') return { status: 'failed', error: this.repositoryScan.errors.map(item => item.message).join('；'), effect: 'none' };
      }
    });
  }

  getOperationScope(): string { return this.operationScope(); }
  getLocalOperationScope(): string {
    return `local:${this.projectContext?.revision ?? this.groupRoot ?? 'none'}:${this.session.connectionEpoch ?? 0}`;
  }
  private actionScope(request: { type: string; [key: string]: unknown }): string {
    if (request.type === 'confirmOperationResult' && typeof request.targetOperationId === 'string') {
      const target = this.operations.get(request.targetOperationId);
      const action = target?.action ?? (request.recovery as OperationRecoveryMetadata | undefined)?.action;
      if (action) request = { type: action };
    }
    return effectiveOperationScope(request, { scopeRevision: this.operationScope(), localOperationScope: this.getLocalOperationScope() }) ?? this.operationScope();
  }

  async refreshAfterIssueChange(): Promise<void> {
    // IssuePanels already reconciles the affected detail. Do not fan out reads.
    this.issueGraphStale = true;
    this.sendSnapshot();
  }


  async runCommandAction<T>(action: string, task: () => Promise<T>, metadata: ActionMetadata & { repositoryId?: string } = {}): Promise<T | undefined> {
    let result: T | undefined;
    const navigation = ['openWorkspace', 'openProjects', 'openAnalysis', 'openBmad', 'openMyWork', 'openReviewer', 'openGit', 'openAdmin', 'openRepository', 'openNotifications', 'openSettings', 'manageAccounts', 'logoutAccount'].includes(action);
    await this.runAction({ type: navigation ? 'perform' : action, ...(navigation ? { action } : {}), ...metadata }, async () => { result = await task(); });
    return result;
  }

  private async runAction(request: { type: string; [key: string]: unknown } & ActionMetadata, task: () => Promise<void | ActionOutcome>): Promise<void> {
    if (request.type === 'refresh') request = { ...request, mode: this.activeMode,
      projectSource: this.activeMode === 'clone' && !this.isRemotePage() ? 'local' : this.projectSource };
    const scopeRevision = this.actionScope(request);
    const policy = describeAction(request, { scopeRevision, localOperationScope: this.getLocalOperationScope(), accountKey: this.session.activeAccountId, rootKey: this.projectContext?.root ?? this.groupRoot });
    if (policy.kind === 'control' || policy.kind === 'local') { await task(); return; }
    const requestId = request.operationId ?? randomUUID();
    const state: WorkspaceOperationState = {
      requestId, scopeRevision: request.operationScope ?? scopeRevision, resourceKey: policy.resourceKey,
      action: policy.action, label: policy.label, kind: policy.kind, concurrency: policy.concurrency, lockKey: policy.lockKey,
      retryable: policy.retryable, cancellable: policy.cancellable, notify: policy.notify,
      correlationId: request.type === 'issueRequest' && request.request && typeof request.request === 'object' && 'requestId' in request.request
        ? String(request.request.requestId) : typeof request.requestId === 'string' ? request.requestId : undefined,
      phase: '正在準備…', status: 'queued', startedAt: Date.now()
    };
    const execute = () => withReadObservation(event => {
      if (event.transportStage) this.operations.update(requestId, { transportStage: event.transportStage, retryAt: event.retryAt });
    }, () => this.operationContext.run(requestId, async () => {
      try {
        if (request.hostSessionId !== undefined && request.hostSessionId !== this.operations.sessionId) throw new Error('工作台連線已更新，請重新執行操作。');
        if (request.scopeEpoch !== undefined && request.scopeEpoch !== this.session.connectionEpoch || request.operationScope && request.operationScope !== this.actionScope(request)) throw new Error('工作區或帳號已變更，請重新執行操作。');
        if (policy.kind === 'write' && this.accountTransitionBusy) throw new Error('帳號正在切換，請稍後再執行操作。');
      } catch (error) {
        // None of these guards has entered the adapter. Publish an explicit
        // no-effect receipt so every view can release its provisional waiting.
        this.noteOutcome({ effect: 'none' });
        throw error;
      }
      // Context changes have their own guards; they must not count themselves as an active data write.
      const contextChange = ['connect', 'submitAccountLogin', 'switchAccount', 'disconnect', 'logoutAccount', 'removeAccount', 'selectGroup',
        'selectProjectFolder', 'selectProjectRoot', 'resetProjectRoot', 'selectCloneRoot', 'resetCloneRoot', 'selectWorkflowKitInstallRoot', 'resetWorkflowKitInstallRoot'].includes(policy.action);
      const guardedWrite = policy.kind === 'write' && !contextChange;
      if (guardedWrite) this.writesInFlight++;
      try {
        const outcome = await task();
        if (policy.kind === 'read' && scopeRevision !== this.actionScope(request)) return { status: 'cancelled' as const, effect: 'none' as const };
        return outcome;
      } finally {
        if (guardedWrite) this.writesInFlight--;
      }
    }));
    const tracked = () => this.operations.run(state, execute);
    const logged = () => this.runLogged(policy.action, tracked, {
      projectId: typeof request.projectId === 'number' ? request.projectId : undefined,
      issueIid: typeof request.issueIid === 'number' ? request.issueIid : undefined
    }, () => {
      const operation = this.operations.get(requestId);
      return { result: operation?.status === 'failed' ? 'error' : operation?.status === 'cancelled' ? 'cancelled' : 'success',
        ...(operation?.refreshError || operation?.effect === 'partial' ? { level: 'warn' as const } : {}),
        message: operation?.refreshError ?? operation?.error };
    });
    // Capture reads too: a failure can arrive after the user switches accounts.
    await this.notifications.run({ operationId: requestId, title: policy.label, origin: this.getNotificationOrigin() }, async () => {
      try { await logged(); }
      finally {
        const operation = this.operations.get(requestId);
        if (operation) this.notifications.recordOperation(operation);
      }
    });
  }

  private noteOutcome(outcome: ActionOutcome): void {
    const requestId = this.operationContext.getStore();
    if (requestId) this.operations.noteOutcome(requestId, Object.fromEntries(Object.entries(outcome).filter(([, value]) => value !== undefined)) as ActionOutcome);
  }

  private resolveUnknownFor(resourceKey: string, effect: 'none' | 'applied'): void {
    for (const operation of this.operations.list(this.operationScope())) {
      if (operation.resourceKey === resourceKey && operation.effect === 'unknown') this.operations.resolveUnknown(operation.requestId, {
        status: 'succeeded', effect, error: undefined,
        phase: effect === 'applied' ? '已核對，操作已完成' : '已確認未寫入，可重新操作'
      });
    }
  }

  private setBusyOwner(owner: string, label?: string): void {
    const owners = this.busyOwners ??= new Map();
    if (label) owners.set(owner, label); else owners.delete(owner);
    this.post({ type: 'busy', value: owners.size > 0, label: [...owners.values()].at(-1) });
  }

  private async reconcileAfterWrite(task: () => Promise<void>): Promise<void> {
    this.operationPhase('', '正在重新核對結果…');
    try { await task(); }
    catch (error) {
      const refreshError = `操作結果已保存，但重新載入失敗：${readableError(error)}`;
      this.noteOutcome({ refreshError });
      this.post({ type: 'message', message: refreshError });
    }
  }

  private cloneProgressPublisher(operation: CloneOperationState): { publish(immediate?: boolean): void; dispose(): void } {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let lastPublished = 0;
    const emit = () => {
      if (timer) { clearTimeout(timer); timer = undefined; }
      if (this.disposed) return;
      lastPublished = Date.now();
      this.cloneOperation = { ...operation, items: operation.items.map(item => ({ ...item })) };
      this.post({ type: 'cloneOperation', ...this.cloneOperation });
    };
    return {
      publish: (immediate = true) => {
        if (immediate || Date.now() - lastPublished >= 150) emit();
        else if (!timer) timer = setTimeout(emit, 150 - (Date.now() - lastPublished));
      },
      dispose: () => { if (timer) clearTimeout(timer); timer = undefined; }
    };
  }

  private repositoryOutcome(): ActionOutcome {
    const operation = this.cloneOperation;
    if (!operation) return { effect: 'none' };
    const applied = operation.items.some(item => ['completed', 'updated', 'upToDate'].includes(item.state));
    if (operation.phase === 'cancelled') return { status: 'cancelled', effect: applied ? 'partial' : 'none' };
    if (operation.phase === 'failed' || operation.items.some(item => item.state === 'failed')) return {
      status: 'failed', effect: applied ? 'partial' : 'none', error: operation.items.find(item => item.state === 'failed')?.message
    };
    return { effect: applied ? 'applied' : 'none' };
  }

  private async dispatchMessage(value: unknown): Promise<void> {
    this.webviewMessagesReceived++;
    if (!value || typeof value !== 'object' || !('type' in value) || typeof value.type !== 'string') return;
    if (isGitPanelRequest(value)) {
      await this.handleGitPanelRequest(value);
      return;
    }
    const request = value as WorkspaceRequest;
    if (request.projectRevision !== undefined) {
      const current = await this.resolveProjectContext();
      if (request.projectRevision !== current.revision) throw new Error('專案根目錄已變更，請重新確認操作位置。');
    }
    switch (request.type) {
      case 'ready': {
        if (this.readyViewGeneration === this.viewGeneration && this.webviewReady) { this.sendSnapshot(); break; }
        this.readyViewGeneration = this.viewGeneration;
        this.webviewReady = true;
        this.snapshotTransport?.reset();
        this.snapshotGraphScope = undefined;
        this.post({ type: 'operationsSnapshot', snapshot: this.operations.snapshot() });
        if (this.viewReadAbort.signal.aborted) this.viewReadAbort = new AbortController();
        // Local navigation and account forms must not wait for remote data or
        // a Python installation inspection before becoming usable.
        this.sendSnapshot();
        this.publishAccountPanel();
        if (this.pendingNotificationsOpen) { this.post({ type: 'openNotifications' }); this.pendingNotificationsOpen = false; }
        this.publishSettings();
        const generation = this.viewGeneration;
        if (request.projectSource === 'gitlab' || request.projectSource === 'local') this.projectSource = request.projectSource;
        this.developerView = request.developerView === 'graph' ? 'graph' : 'list';
        if (request.mergeRequestFilter && ['all', 'reviewer', 'assigned'].includes(request.mergeRequestFilter)) this.mergeRequestFilter = request.mergeRequestFilter;
        await this.refresh({ reason: 'entry' });
        if (generation !== this.viewGeneration || this.disposed) break;
        this.restoredOnce = true;
        if (this.activeMode === 'reviewer' && this.pendingMergeRequestRead) {
          const { projectId, iid } = this.pendingMergeRequestRead;
          void this.loadMergeRequest(projectId, iid).catch(error => this.post({ type: 'error', message: readableError(error) }));
        }
        this.post({ type: 'issueNavigation', navigation: this.issueNavigation });
        for (const notice of this.pendingViewNotices.splice(0)) this.sendViewMessage(notice);
        if (this.pendingNotificationsOpen) { this.post({ type: 'openNotifications' }); this.pendingNotificationsOpen = false; }
        this.publishAccountPanel();
        this.publishSettings();
        break;
      }
      case 'reconcileOperations': {
        const generation = this.viewGeneration, signal = this.viewReadAbort.signal;
        const snapshot = await this.operations.snapshotWithStored(undefined, request.pendingIds, signal);
        if (!signal.aborted && generation === this.viewGeneration) this.post({ type: 'operationsSnapshot', snapshot });
        break;
      }
      case 'resyncWorkspace': this.snapshotTransport?.reset(); this.snapshotGraphScope = undefined; this.sendSnapshot(); break;
      case 'cancelRepositoryOperation': this.repositoryOperationAbort?.abort(); break;
      case 'confirmOperationResult': await this.confirmOperationResult(request.targetOperationId, request.recovery); break;
      case 'refresh':
        if (this.issueNavigation) await this.issuePanels.refreshActive();
        else await this.refresh({ forceNetwork: true, forceRepositories: true, refreshGitSnapshot: true, reason: 'manual' });
        break;
      case 'refreshBmad': await this.refreshBmadWorkflow(true); break;
      case 'copyBmadCommand': await this.copyBmadCommand({ revision: request.revision, command: request.command, skill: request.skill,
        stepId: request.stepId, artifactId: request.artifactId, storyId: request.storyId, requirement: request.requirement }); break;
      case 'openBmadTerminal': await this.openBmadTerminal(request.revision); break;
      case 'openBmadArtifact': await this.openBmadArtifact(request.revision, request.stepId, request.path); break;
      case 'publishNotification':
        if (!['info', 'warn', 'error'].includes(request.level) || typeof request.message !== 'string' || request.message.length > 4096 ||
          request.title !== undefined && (typeof request.title !== 'string' || request.title.length > 200)) break;
        if (request.hostSessionId !== undefined && request.hostSessionId !== this.operations.sessionId ||
          request.operationScope && ![this.operationScope(), this.getLocalOperationScope()].includes(request.operationScope) || request.scopeEpoch !== undefined &&
          (!Number.isSafeInteger(request.scopeEpoch) || request.scopeEpoch < 0 || request.scopeEpoch !== this.session.connectionEpoch)) break;
        this.notifications.publish({ level: request.level, message: request.message, title: request.title, origin: this.getNotificationOrigin(),
          operationId: typeof request.operationId === 'string' ? request.operationId : undefined }); break;
      case 'markNotificationsRead':
        if (Number.isSafeInteger(request.revision) && request.revision >= 0 && Array.isArray(request.ids) && request.ids.length <= 500 && request.ids.every(id => typeof id === 'string' && id.length <= 160)) this.notifications.markRead(request.ids, request.revision);
        break;
      case 'markAllNotificationsRead':
        if (Number.isSafeInteger(request.revision) && request.revision >= 0) this.notifications.markAllRead(request.revision);
        break;
      case 'removeNotification':
        if (typeof request.id === 'string' && request.id.length <= 160) this.notifications.remove(request.id);
        break;
      case 'clearNotifications':
        if (Number.isSafeInteger(request.revision) && request.revision >= 0) this.notifications.clear(request.revision);
        break;
      case 'retryInstanceCheck':
        if (this.instanceCheckBusy) break;
        this.instanceCheckBusy = true;
        this.sendSnapshot();
        try {
          await this.session.ensureInstanceChecked({ force: true });
          await this.issuePanels.refreshActive();
        } finally {
          this.instanceCheckBusy = false;
          this.sendSnapshot();
        }
        break;
      case 'setMode':
        if (!ALLOWED_MODES.has(request.mode)) return;
        await this.withReadHandoff(async () => {
          this.cancelPageReads();
          this.activeMode = request.mode;
          if (request.mergeRequestFilter && ['all', 'reviewer', 'assigned'].includes(request.mergeRequestFilter)) this.changeMergeRequestFilter(request.mergeRequestFilter);
          if (request.projectSource === 'gitlab' || request.projectSource === 'local') this.projectSource = request.projectSource;
          if (request.mode !== 'developer') this.hideIssueGraph();
          await this.context.globalState.update(SELECTED_MODE_KEY, request.mode);
          this.sendSnapshot(); this.syncBmadVisibility();
          await this.refresh({ reason: 'entry' });
        });
        break;
      case 'setMergeRequestFilter':
        if (request.connectedScope !== this.connectedScopeKey() || !['all', 'reviewer', 'assigned'].includes(request.filter)) break;
        if (this.mergeRequestFilter === request.filter) break;
        this.changeMergeRequestFilter(request.filter);
        this.sendSnapshot();
        if (this.activeMode === 'reviewer') await this.refresh({ reason: 'entry' });
        break;
      case 'setProjectSource':
        if (request.source !== 'gitlab' && request.source !== 'local') return;
        if (this.projectSource === request.source) break;
        await this.withReadHandoff(async () => {
          this.cancelPageReads(); this.projectSource = request.source;
          this.sendSnapshot();
          if (this.activeMode === 'clone') await this.refresh({ reason: 'entry' });
        });
        break;
      case 'issueRequest':
        try { await this.issuePanels.handle({ ...request.request, operationId: this.operationContext.getStore() ?? request.operationId,
          operationScope: request.operationScope ?? this.operationScope() }, request.revision, true); }
        catch (error) { const operationId = this.operationContext.getStore();
          const effect = operationId ? this.operations.get(operationId)?.effect : undefined;
          this.post({ type: 'issueResponse', revision: request.revision, response: { type: 'error', message: readableError(error), effect,
          notificationOnly: ['create', 'update', 'invoke', 'upload'].includes(request.request.type) &&
            !(error instanceof Error && error.name === 'IssueValidationError') && !(error instanceof GitLabApiError && [400, 409, 422].includes(error.status ?? 0)) } });
          if (['create', 'update', 'invoke', 'upload'].includes(request.request.type)) throw error; }
        break;
      case 'closeIssue': this.issueOpenGeneration++; this.issueOpenAbort?.abort(); this.issuePanels.close(); break;
      case 'connect': await this.connect(); break;
      case 'openAccountManager': await this.openAccountManager(); break;
      case 'submitAccountLogin': await this.submitAccountLogin(request); break;
      case 'disconnect': await this.disconnect(request.accountId); break;
      case 'addAccount': await this.connect(request.accountId); break;
      case 'switchAccount': await this.switchAccount(request.accountId); break;
      case 'removeAccount': await this.removeAccount(request.accountId); break;
      case 'scanRepositories': await this.scanRepositories(request.resume === true); break;
      case 'cancelRepositoryScan': this.repositoryScanAbort?.abort(); break;
      case 'openLogs': await vscode.commands.executeCommand('gitlabWorkspace.showLogs'); break;
      case 'selectGroup': await this.selectGroup(request.groupId); break;
      case 'selectIssueBoard': await this.selectIssueBoard(request.boardId, request.connectedScope, request.mode); break;
      case 'loadIssueGraph':
        if (request.cancel && request.connectedScope === this.connectedScopeKey()) {
          this.graphReadCancellation = (this.graphReadCancellation ?? 0) + 1;
          this.issueGraphAbort?.abort();
          if (this.issueGraphPublishTimer) clearTimeout(this.issueGraphPublishTimer);
          this.issueGraphPublishTimer = undefined;
          if (this.issueGraph) {
            this.issueGraph = { ...this.issueGraph, status: 'partial', errors: [...this.issueGraph.errors, '已取消本批載入，已取得的節點保留。'] };
            for (const node of this.issueGraph.nodes) if (node.relationsStatus === 'loading') node.relationsStatus = 'idle';
            for (const board of Object.values(this.issueGraph.boardStatus)) if (board.status === 'loading') board.status = 'idle';
            this.issueGraphVersion++; this.post({ type: 'issueGraphChanged', connectedScope: request.connectedScope, version: this.issueGraphVersion, graph: this.issueGraph });
          }
          break;
        }
        if (request.moreRoots && request.connectedScope === this.connectedScopeKey()) this.issueGraphRootLimit = Math.min(this.issues.length, (this.issueGraphRootLimit ?? 100) + 100);
        await this.loadIssueGraph(request.connectedScope, request.forceNetwork === true, request.nodeIds, request.loadBoards); break;
      case 'setIssueGraphVisibility': {
        if (request.connectedScope !== this.connectedScopeKey()) break;
        const entering = request.visible && !this.issueGraphVisible;
        if (this.activeMode === 'developer') this.developerView = request.visible ? 'graph' : 'list';
        if (request.visible && this.activeMode === 'developer') {
          this.issueGraphVisible = true;
          if (entering && !this.refreshTask) await this.loadIssueGraph(request.connectedScope);
        } else this.hideIssueGraph();
        break;
      }
      case 'retryWorkspaceSection':
        if (request.connectedScope === this.connectedScopeKey()) {
          if (request.mode === 'cancel') this.workspaceSectionAborts.get(request.section)?.abort();
          else if (request.mode) await this.loadWorkspaceSection(request.section, false, request.mode);
          else await this.loadWorkspaceSection(request.section, true);
        }
        break;
      case 'ensureWorkspaceSection':
        await this.ensureWorkspaceSection(request.section, request.connectedScope);
        break;
      case 'loadIssueRelations': {
        const connectedScope = request.connectedScope;
        const generation = this.viewGeneration;
        const signal = this.viewReadAbort.signal;
        try {
          const data = await this.issuePanels.loadIssueRelations(request.projectId, request.issueIid, signal);
          if (!signal.aborted && generation === this.viewGeneration && connectedScope === this.connectedScopeKey()) this.post({ type: 'issueRelations', requestId: request.requestId, connectedScope, projectId: request.projectId, issueIid: request.issueIid, data });
        } catch (error) {
          if (!signal.aborted && generation === this.viewGeneration && connectedScope === this.connectedScopeKey()) this.post({ type: 'issueRelations', requestId: request.requestId, connectedScope, projectId: request.projectId, issueIid: request.issueIid, error: readableError(error) });
        }
        break;
      }
      case 'mutateIssueRelations': {
        const connectedScope = request.connectedScope;
        const writeKey = `${connectedScope}:${request.projectId}:${request.issueIid}`;
        if (connectedScope !== this.connectedScopeKey()) break;
        if (this.issueRelationWritesInFlight.has(writeKey)) {
          this.post({ type: 'issueRelations', requestId: request.requestId, connectedScope, projectId: request.projectId, issueIid: request.issueIid, error: '此 Issue 的關係更新仍在處理中。' });
          break;
        }
        this.issueRelationWritesInFlight.add(writeKey);
        let mutationApplied = false;
        try {
          await this.issuePanels.mutateIssueRelations(request.projectId, request.issueIid, request.action);
          mutationApplied = true;
          const data = await this.issuePanels.loadIssueRelations(request.projectId, request.issueIid);
          if (connectedScope !== this.connectedScopeKey()) break;
          this.post({ type: 'issueRelations', requestId: request.requestId, connectedScope, projectId: request.projectId, issueIid: request.issueIid, mutationApplied, data });
          if (this.issueGraphRequestedScope === connectedScope) {
            if (this.issueGraphVisible) void this.loadIssueGraph(connectedScope, true);
            else this.issueGraphStale = true;
          }
        } catch (error) {
          const effect = error && typeof error === 'object' && 'effect' in error ? error.effect as WorkspaceOperationState['effect'] : mutationApplied ? 'applied' : 'none';
          this.noteOutcome(mutationApplied ? { status: 'succeeded', effect: 'applied', refreshError: readableError(error) }
            : { status: 'failed', effect, error: readableError(error) });
          if (connectedScope === this.connectedScopeKey()) {
            this.post({ type: 'issueRelations', requestId: request.requestId, connectedScope, projectId: request.projectId, issueIid: request.issueIid, mutationApplied, effect, error: mutationApplied
              ? `關係已更新，但重新載入失敗：${readableError(error)}`
              : readableError(error) });
            if (mutationApplied && this.issueGraphRequestedScope === connectedScope) {
              if (this.issueGraphVisible) void this.loadIssueGraph(connectedScope, true);
              else this.issueGraphStale = true;
            }
          }
        } finally {
          this.issueRelationWritesInFlight.delete(writeKey);
        }
        break;
      }
      case 'openLocalWorkspace': await this.openLocalWorkspace(); break;
      case 'selectProjectFolder': await this.selectProjectFolder(request.folderUri); break;
      case 'selectProjectRoot': await this.selectProjectRoot(); break;
      case 'resetProjectRoot': await this.selectProjectRoot(true); break;
      case 'selectCloneRoot': await this.selectProjectRoot(); break;
      case 'resetCloneRoot': await this.selectProjectRoot(true); break;
      case 'clone': await this.clone(request.projectIds, !!request.cloneAll); break;
      case 'cloneSelection': {
        const waiter = this.cloneSelectionWaiters.get(request.requestId);
        if (!waiter) break;
        clearTimeout(waiter.timeout);
        this.cloneSelectionWaiters.delete(request.requestId);
        const scopeKey = this.connectedScopeKey();
        const availableIds = new Set(this.projects.map((project) => project.id));
        const projectIds = request.scopeKey === scopeKey && Array.isArray(request.projectIds)
          ? [...new Set(request.projectIds.filter((id) => Number.isSafeInteger(id) && availableIds.has(id)))]
          : [];
        waiter.resolve(projectIds);
        break;
      }
      case 'syncRepos': await this.syncRepos(request.projectIds); break;
      case 'selectProject': this.selectedProjectId = request.projectId; await this.context.globalState.update('gitlabWorkspace.selectedProjectId', request.projectId); this.sendSnapshot(); break;
      case 'selectIssue': await this.selectIssue(request.projectId, request.issueIid); break;
      case 'openIssue': await this.openIssue(request.projectId, request.issueIid, request.tab); break;
      case 'createIssue': this.issueOpenGeneration++; await this.issuePanels.showCreate(); break;
      case 'copy': await vscode.env.clipboard.writeText(request.text); this.post({ type: 'message', message: '已複製到剪貼簿。' }); break;
      case 'importIssueDrafts': this.post({ type: 'draftBundle', bundle: parseIssueDraftBundle(request.json) }); break;
      case 'createIssueDrafts': await this.createDrafts(request.analysisId, request.drafts, request.options); break;
      case 'loadDraftOptions': await this.loadDraftOptions(request.projectId); break;
      case 'checkSimilarIssues': await this.checkSimilarIssues(request.drafts); break;
      case 'openExternal': await this.openExternal(request.url); break;
      case 'startTimer': await this.startTimer(request.projectId, request.issueIid); break;
      case 'pauseTimer': await this.updateTimer(() => this.timer.pause(request.id)); break;
      case 'resumeTimer': await this.updateTimer(() => this.timer.resume(request.id)); break;
      case 'stopTimer': await this.updateTimer(() => this.timer.stop(request.id)); break;
      case 'addManualTime': await this.addManualTime(request.projectId, request.issueIid, request.duration, request.summary, request.spentAt); break;
      case 'updateTimeEntry': await this.updateTimeEntry(request.id, request.duration, request.summary, request.spentAt); break;
      case 'submitTimeEntry': await this.submitTime(request.id); break;
      case 'acknowledgeTimeEntry': await this.acknowledgeTimeEntry(request.id); break;
      case 'selectMergeRequest': await this.loadMergeRequest(request.projectId, request.iid); break;
      case 'refreshMergeRequest': await this.refreshMergeRequestBranches(request.projectId, request.iid); break;
      case 'reconcileMergeRequestWrite': await this.reconcileMergeRequestWrite(request.projectId, request.iid); break;
      case 'loadMergeRequestSection': await this.loadMergeRequestSection(request.section, request.projectId, request.iid); break;
      case 'postMergeRequestNote': await this.postMergeRequestNote(request.projectId, request.iid, request.body); break;
      case 'openBranchReview': await this.openBranchReview(request.projectId, request.iid); break;
      case 'loadSkillBranches': await this.loadSkillBranches(request.repo, request.revision, request.requestId); break;
      case 'loadReviewerCapabilities': await this.loadReviewerCapabilities(request.revision, request.requestId, request.tool); break;
      case 'replyMergeRequest': await this.replyMergeRequest(request.projectId, request.iid, request.discussionId, request.body); break;
      case 'approveMergeRequest': await this.approveMergeRequest(request.projectId, request.iid, request.sha); break;
      case 'mergeMergeRequest': await this.mergeMergeRequest(request.projectId, request.iid, request.sha); break;
      case 'setWorkflowKitSource': await this.setWorkflowKitSource(request.source); break;
      case 'openWorkflowKitDownload': await this.openWorkflowKitDownload(request.source); break;
      case 'copySkillGuidePrompt': await this.copySkillGuidePrompt(request); break;
      case 'loadReviewSessions': await this.loadReviewSessions(request.revision, request.tool); break;
      case 'cancelReviewSession': await this.controlReviewSession(request, 'cancel'); break;
      case 'copyReviewRefresh': await this.controlReviewSession(request, 'refresh'); break;
      case 'copyReviewResume': await this.controlReviewSession(request, 'resume'); break;
      case 'openReviewReport': await this.controlReviewSession(request, 'report'); break;
      case 'refreshWorkflowKit': await this.refreshWorkflowKitInstallState(); break;
      case 'checkWorkflowKitReleases': await this.refreshWorkflowKitReleases(request.source); break;
      case 'openWorkspaceFolder': await vscode.commands.executeCommand('workbench.action.files.openFolder'); break;
      case 'selectWorkflowKitInstallRoot': await this.selectWorkflowKitInstallRoot(); break;
      case 'resetWorkflowKitInstallRoot': await this.resetWorkflowKitInstallRoot(); break;
      case 'installWorkflowKit': await this.installWorkflowKit(request.releaseId); break;
      default: break;
    }
  }

  private async loadActiveModeSections(mode: WorkspaceMode, forceNetwork = false, reason = 'entry'): Promise<void> {
    this.syncBmadVisibility();
    if (!this.connectedScopeKey() || this.disposed || this.panel?.visible === false) return;
    const sections: Array<'issues' | 'mergeRequests' | 'milestones' | 'boards'> = mode === 'reviewer' ? ['mergeRequests']
      : mode === 'developer' ? ['issues', ...(this.requestedWorkspaceSections ?? [])] : [];
    await Promise.all(sections.map(section => this.loadWorkspaceSection(section, forceNetwork, undefined, reason)));
  }

  private async ensureWorkspaceSection(section: 'boards' | 'milestones', connectedScope: string): Promise<void> {
    const current = () => !this.disposed && this.panel?.visible !== false && this.activeMode === 'developer' &&
      !!connectedScope && connectedScope === this.connectedScopeKey();
    if (!['boards', 'milestones'].includes(section) || !current()) return;
    const loadedScope = `${this.session.baseUrl}|${this.currentUser!.id}|${this.session.selectedGroup!.id}`;
    // Restored filters can arrive before entry has initialized this Group. Join
    // that entry first so its scope reset cannot erase the requested filter.
    if (this.loadedScopeKey !== loadedScope) {
      await this.refresh({ reason: 'entry' });
      if (!current() || this.loadedScopeKey !== loadedScope) return;
    }
    const pending = this.workspaceSectionReads?.get(section);
    if (pending?.scope === connectedScope && !pending.controller?.signal.aborted) { await pending.task; return; }
    const retry = !!(this.workspaceSections[section]?.error || (section === 'boards' ? this.groupIssueBoardsError : this.groupMilestonesError));
    await this.loadWorkspaceSection(section, retry, undefined, retry ? 'retry' : 'demand');
  }

  private setWorkspaceSectionState(section: WorkspaceSection, status: WorkspaceSectionState['status'], error?: string, publish = true): void {
    const previous = this.workspaceSections[section];
    this.workspaceSections[section] = status === 'loading' && previous?.status === 'ready'
      ? { ...previous, error: undefined, refreshing: true }
      : { status, ...(error ? { error } : {}), ...(status === 'ready' ? { updatedAt: Date.now(), refreshing: false } : {}) };
    if (publish) this.sendSnapshot();
  }

  private invalidateWorkspaceReads(change: GitLabReadInvalidation): void {
    const groupId = this.session.selectedGroup?.id;
    if (change.resource !== 'all' && (groupId === undefined || !change.groupIds.includes(groupId))) return;
    const sections: WorkspaceSection[] = change.resource === 'mergeRequests' ? ['mergeRequests']
      : change.resource === 'issues' ? ['issues', 'boards'] : ['projects', 'issues', 'mergeRequests', 'boards', 'milestones'];
    for (const section of sections) {
      this.workspaceSectionPages?.delete(section);
      this.workspaceSectionAborts.get(section)?.abort();
      this.workspaceSectionAborts.delete(section);
      this.workspaceSectionGenerations.set(section, (this.workspaceSectionGenerations.get(section) ?? 0) + 1);
      this.setWorkspaceSectionState(section, 'idle', undefined, false);
    }
    if (change.resource === 'issues' || change.resource === 'all' || change.resource === 'group') {
      this.issueGraphStale = true;
      this.issueBoardAbort?.abort(); this.issueBoardGeneration++; this.issueBoardLoad = undefined;
      const connectedScope = this.connectedScopeKey();
      this.issueBoardContent = this.selectedIssueBoardId !== undefined && connectedScope ? { boardId: this.selectedIssueBoardId, connectedScope, issueIds: [], loadedCount: 0, complete: false, status: 'partial', pausedReason: '議題已變更；請重新載入看板歸屬。' } : undefined;
    }
    this.sendSnapshot();
  }

  private async withReadHandoff(task: () => Promise<void>): Promise<void> {
    const handoff = this.session.beginReadHandoff?.();
    try { await task(); }
    finally { handoff?.dispose(); }
  }

  private cancelPageReads(): void {
    this.graphReadCancellation = (this.graphReadCancellation ?? 0) + 1;
    this.gitRepositories?.setActivePanelRepository(undefined);
    this.bmad?.setContext(this.projectContext?.root, this.projectContext?.revision, false);
    this.inventoryGeneration++;
    this.refreshAbort?.abort(); this.requestGeneration++;
    this.previewAbort?.abort(); this.previewGeneration++;
    this.issueOpenAbort?.abort(); this.issueOpenGeneration++;
    this.issueBoardAbort?.abort(); this.issueBoardGeneration++;
    this.issueGraphAbort?.abort(); this.issueGraphGeneration++;
    this.mergeRequestAbort?.abort(); this.mergeRequestGeneration++;
    this.cancelMergeRequestSectionReads();
    if (this.selectedMergeRequest) {
      for (const section of ['diffs', 'discussions'] as const) {
        if (this.selectedMergeRequest.sections[section].status === 'loading') this.selectedMergeRequest.sections[section] = { status: 'idle' };
      }
    }
    this.issuePanels.suspendReads();
    for (const [section, controller] of this.workspaceSectionAborts) {
      controller.abort();
      this.workspaceSectionGenerations.set(section, (this.workspaceSectionGenerations.get(section) ?? 0) + 1);
      const previous = this.workspaceSections[section];
      if (previous?.status === 'loading') this.setWorkspaceSectionState(section, 'idle', undefined, false);
      else if (previous?.refreshing) this.workspaceSections[section] = { ...previous, refreshing: false };
    }
    this.workspaceSectionAborts.clear();
    this.busy = false;
  }

  private suspendViewReads(): void {
    this.session.cancelReadHandoffs?.();
    this.bmad?.setContext(this.projectContext?.root, this.projectContext?.revision, false);
    this.viewGeneration++;
    this.snapshotTransport?.reset();
    this.viewReadAbort.abort();
    this.actualRepositoryScanAbort?.abort();
    this.webviewReady = false;
    this.gitPanelReady = false;
    this.gitRepositories?.setActivePanelRepository(undefined);
    if (this.gitRepositoryListTimer) clearTimeout(this.gitRepositoryListTimer);
    this.gitRepositoryListTimer = undefined;
    this.refreshAbort?.abort();
    this.requestGeneration++;
    this.busy = false;
    this.inventoryGeneration++;
    this.repositoryScanAbort?.abort();
    this.previewAbort?.abort(); this.previewGeneration++;
    this.issueOpenAbort?.abort(); this.issueOpenGeneration++;
    this.issueBoardAbort?.abort(); this.issueBoardGeneration++;
    this.mergeRequestAbort?.abort(); this.mergeRequestGeneration++;
    this.cancelMergeRequestSectionReads();
    if (this.selectedMergeRequest) {
      const sections = { ...this.selectedMergeRequest.sections };
      for (const section of ['diffs', 'discussions'] as const) if (sections[section]?.status === 'loading') sections[section] = { status: 'idle' };
      this.selectedMergeRequest = { ...this.selectedMergeRequest, sections };
    }
    for (const [section, state] of Object.entries(this.workspaceSections) as [WorkspaceSection, WorkspaceSectionState][]) {
      if (state.status === 'loading') this.setWorkspaceSectionState(section, 'idle', undefined, false);
      else if (state.refreshing) this.workspaceSections[section] = { ...state, refreshing: false };
    }
    for (const [section, controller] of this.workspaceSectionAborts) {
      controller.abort();
      this.workspaceSectionGenerations.set(section, (this.workspaceSectionGenerations.get(section) ?? 0) + 1);
    }
    this.workspaceSectionAborts.clear();
    this.localRepositoryScanGeneration++;
    this.actualRepositoryScanGeneration++;
    this.hideIssueGraph();
    this.issuePanels.suspendReads();
  }

  private resetWorkspaceSections(): void {
    for (const controller of this.workspaceSectionAborts.values()) controller.abort();
    this.workspaceSectionAborts.clear();
    for (const key of Object.keys(this.workspaceSections) as WorkspaceSection[]) delete this.workspaceSections[key];
    for (const [section, generation] of this.workspaceSectionGenerations) this.workspaceSectionGenerations.set(section, generation + 1);
  }

  /** SWR retains data only within one Group; transitions clear it before any await. */
  private clearRemoteGroupData(): void {
    this.resetWorkspaceSections();
    this.workspaceSectionReads?.clear();
    this.requestedWorkspaceSections?.clear();
    this.projects = []; this.issues = []; this.mergeRequests = [];
    this.selectedProjectId = undefined; this.selectedIssue = undefined; this.selectedMergeRequest = undefined;
    this.pendingMergeRequestRead = undefined; this.projectMembers = [];
    this.groupMilestones = []; this.groupMilestonesError = undefined;
    this.groupIssueBoards = []; this.groupIssueBoardsError = undefined;
    this.selectedIssueBoardId = undefined; this.issueBoardContent = undefined; this.issueBoardLoad = undefined;
    this.previewAbort?.abort(); this.previewGeneration++; this.issuePreview = undefined;
    this.issueOpenAbort?.abort(); this.issueOpenGeneration++;
    this.issueGraphAbort?.abort(); this.issueGraphGeneration++;
    this.issueBoardAbort?.abort(); this.issueBoardGeneration++;
    this.mergeRequestAbort?.abort(); this.mergeRequestGeneration++;
    this.cancelMergeRequestSectionReads();
    if (this.issueGraphPublishTimer) clearTimeout(this.issueGraphPublishTimer);
    this.issueGraphPublishTimer = undefined; this.issueGraph = undefined; this.snapshotGraphScope = undefined;
    this.issueGraphRequestedScope = undefined; this.issueGraphVisible = false; this.issueGraphStale = false;
    this.graphBoardMemberships?.clear(); this.graphBoardLoads?.clear(); this.graphRelationLoads?.clear();
  }

  private loadWorkspaceSection(section: 'projects' | 'issues' | 'mergeRequests' | 'milestones' | 'boards', forceNetwork = false, mode?: 'next' | 'all' | 'history' | 'current', reason = forceNetwork ? 'manual' : mode ?? 'entry'): Promise<void> {
    if (section !== 'boards' && section !== 'milestones') return this.loadWorkspaceSectionNow(section, forceNetwork, mode, reason);
    const scope = this.connectedScopeKey();
    if (!scope || this.disposed || this.panel?.visible === false) return Promise.resolve();
    this.workspaceSectionReads ??= new Map();
    const pending = this.workspaceSectionReads.get(section);
    if (!forceNetwork && pending?.scope === scope && !pending.controller?.signal.aborted) return pending.task;
    if (scope && this.activeMode === 'developer' && (section === 'boards' || section === 'milestones')) {
      (this.requestedWorkspaceSections ??= new Set()).add(section);
    }
    const task = this.loadWorkspaceSectionNow(section, forceNetwork, mode, reason);
    const read = { scope, task, controller: this.workspaceSectionAborts.get(section) };
    this.workspaceSectionReads.set(section, read);
    return task.finally(() => { if (this.workspaceSectionReads.get(section) === read) this.workspaceSectionReads.delete(section); });
  }

  private async loadWorkspaceSectionNow(section: 'projects' | 'issues' | 'mergeRequests' | 'milestones' | 'boards', forceNetwork = false, mode?: 'next' | 'all' | 'history' | 'current', reason = forceNetwork ? 'manual' : mode ?? 'entry'): Promise<void> {
    if (this.disposed || this.panel?.visible === false) return;
    const group = this.session.selectedGroup;
    const connectedScope = this.connectedScopeKey();
    if (!group || !connectedScope || !this.session.baseUrl || !this.currentUser) return;
    if (section === 'issues' && !this.groupProjectScopeReady()) return;
    const previous = this.workspaceSections[section];
    if (!forceNetwork && (previous?.refreshing || previous?.status === 'loading')) return;
    const key = section === 'projects' ? `group/${group.id}/projects` : groupWorkspaceReadKey(group.id, section) +
      (section === 'mergeRequests' ? `/query/${this.mergeRequestFilter ?? 'all'}-${this.currentUser.id}` : '');
    const expired = previous?.updatedAt !== undefined && Date.now() - previous.updatedAt >= gitLabReadLifetimeMs(key);
    this.workspaceSectionPages ??= new Map();
    let progress = this.workspaceSectionPages.get(section);
    const projectRevision = section === 'projects' ? this.session.getGroupProjectsRevision?.(group.id) : undefined;
    const revisionChanged = progress?.projectRevision !== undefined && progress.projectRevision !== projectRevision;
    if (!forceNetwork && !mode && previous?.status === 'ready' && !previous.error && !expired && !revisionChanged) {
      this.workspaceSections[section] = { ...previous, dataSource: 'cache', transportStage: undefined, retryAt: undefined };
      this.session.log?.record({ feature: 'api-cache', action: 'read', result: 'success', cacheResult: 'hit', network: false,
        requestReason: reason, pageIdentity: `cursor:${createHash('sha256').update(key).digest('hex').slice(0, 16)}`, groupId: group.id });
      return;
    }
    const reset = forceNetwork || revisionChanged || mode === 'history' || mode === 'current' || !progress || progress.scope !== connectedScope || !mode && expired;
    if (reset) {
      progress = { scope: connectedScope, complete: false, includeClosed: mode === 'history' || mode !== 'current' && progress?.includeClosed === true, seen: new Set() };
      this.workspaceSectionPages.set(section, progress);
    }
    if (!progress || progress.complete && mode) return;
    const generation = (this.workspaceSectionGenerations.get(section) ?? 0) + 1;
    this.workspaceSectionGenerations.set(section, generation);
    this.setWorkspaceSectionState(section, 'loading');
    this.workspaceSectionAborts.get(section)?.abort();
    const controller = new AbortController();
    this.workspaceSectionAborts.set(section, controller);
    const current = () => !controller.signal.aborted && !this.disposed && generation === this.workspaceSectionGenerations.get(section) && connectedScope === this.connectedScopeKey();
    const started = Date.now(); let requests = 0, bytes = 0;
    let provenance: ReadObservation = reset ? {} : { dataSource: previous?.dataSource, fetchedAt: previous?.fetchedAt, expiresAt: previous?.expiresAt };
    const budget = new GitLabRequestBudget({ requests: 20, bytes: 16 * 1024 * 1024, timeoutMs: 30_000 });
    type Item = GitLabProject | GitLabIssue | GitLabMergeRequest | GitLabMilestone | GitLabIssueBoard;
    const rows = (): Item[] => section === 'projects' ? this.projects : section === 'issues' ? this.issues : section === 'mergeRequests' ? this.mergeRequests : section === 'milestones' ? this.groupMilestones : this.groupIssueBoards;
    try {
      do {
        const cursor = progress.cursor;
        const pageKey = `${key}/pages/${progress.includeClosed ? 'all' : 'opened'}/${cursor ? createHash('sha256').update(cursor).digest('hex') : 'first'}`;
        const pendingPage = this.session.cachedRead<GitLabPage<Item> | Item[]>(pageKey, (client) => {
          client = client.withRequestBudget?.(budget) ?? client;
          // Legacy adapters remain supported for installed integrations. Production
          // uses a single page and never downloads a complete collection on entry.
          if (section === 'projects') return client.listGroupProjectsPage?.(group.id, cursor) ?? client.listGroupProjects(group.id);
          if (section === 'issues') return client.listAssignedGroupIssuesPage?.(group.id, cursor, progress!.includeClosed ? 'all' : 'opened') ?? client.listAssignedGroupIssues(group.id);
          if (section === 'mergeRequests') return client.listGroupMergeRequestsPage?.(group.id, cursor, { filter: this.mergeRequestFilter ?? 'all', userId: this.currentUser!.id }) ?? client.listGroupMergeRequests(group.id);
          if (section === 'milestones') return client.listGroupMilestonesPage?.(group.id, cursor) ?? client.listGroupMilestones(group.id);
          return client.listGroupIssueBoardsPage?.(group.id, cursor) ?? client.listGroupIssueBoards(group.id);
        }, { force: forceNetwork, signal: controller.signal, reason, onState: event => {
          if (!current()) return;
          if (event.dataSource) provenance.dataSource = provenance.dataSource && provenance.dataSource !== event.dataSource ? 'mixed' : event.dataSource;
          if (event.fetchedAt !== undefined) provenance.fetchedAt = Math.min(provenance.fetchedAt ?? event.fetchedAt, event.fetchedAt);
          if (event.expiresAt !== undefined) provenance.expiresAt = Math.min(provenance.expiresAt ?? event.expiresAt, event.expiresAt);
          if (event.transportStage && (this.workspaceSections[section]?.transportStage !== event.transportStage || this.workspaceSections[section]?.retryAt !== event.retryAt)) {
            this.workspaceSections[section] = { ...this.workspaceSections[section]!, transportStage: event.transportStage, retryAt: event.retryAt };
            this.sendSnapshot();
          }
        } });
        // The shared page store advances synchronously when a new first-page
        // snapshot starts. Never append its continuations to older UI rows.
        const pageRevision = section === 'projects' ? this.session.getGroupProjectsRevision?.(group.id) : undefined;
        const value = await pendingPage;
        if (!current()) return;
        if (section === 'projects' && pageRevision !== this.session.getGroupProjectsRevision?.(group.id)) {
          this.workspaceSectionPages.delete(section);
          this.workspaceSections.projects = { status: 'idle', complete: false, loadedCount: this.projects.length,
            pausedReason: '專案清單已更新，請重新載入。' };
          return;
        }
        const page: GitLabPage<Item> = Array.isArray(value) ? { items: value, complete: true, updatedAt: new Date().toISOString() } : value;
        if (!page || !Array.isArray(page.items) || typeof page.complete !== 'boolean' || !page.complete && !page.nextCursor) throw new Error('GitLab 回傳不完整的分頁狀態，已保留先前資料。');
        if (page.nextCursor && (progress.seen.has(page.nextCursor) || page.nextCursor === cursor)) throw new Error('GitLab 回傳重複的下一頁，已停止載入。');
        requests++; bytes += Buffer.byteLength(JSON.stringify(page.items), 'utf8');
        const merged = new Map<string, Item>();
        for (const item of requests === 1 && reset ? [] : rows()) merged.set('project_id' in item && 'iid' in item ? `${item.project_id}:${item.iid}` : String(item.id), item);
        for (const item of page.items) merged.set('project_id' in item && 'iid' in item ? `${item.project_id}:${item.iid}` : String(item.id), item);
        const items = [...merged.values()];
        if (section === 'projects') {
          this.projects = items as GitLabProject[];
          if (page.complete) {
            const ids = new Set(this.projects.map(project => project.id));
            this.issues = this.issues.filter(issue => ids.has(issue.project_id));
            if (this.selectedProjectId !== undefined && !ids.has(this.selectedProjectId)) this.selectedProjectId = undefined;
          }
        } else if (section === 'issues') {
          if (reset && requests === 1) {
            this.issueGraphAbort?.abort(); this.issueGraphGeneration++;
            this.issueGraphRead = undefined; this.issueGraph = undefined;
            this.snapshotGraphScope = undefined; this.issueGraphVersion++;
          }
          const ids = new Set(this.projects.map(project => project.id));
          this.issues = this.workspaceSections.projects?.complete === false ? items as GitLabIssue[] : (items as GitLabIssue[]).filter(issue => ids.has(issue.project_id));
          this.issueGraphStale = true;
        } else if (section === 'mergeRequests') this.mergeRequests = items as GitLabMergeRequest[];
        else if (section === 'milestones') { this.groupMilestones = items as GitLabMilestone[]; this.groupMilestonesError = undefined; }
        else { this.groupIssueBoards = items as GitLabIssueBoard[]; this.groupIssueBoardsError = undefined; }
        progress.cursor = page.nextCursor; progress.complete = page.complete;
        if (section === 'projects') progress.projectRevision = pageRevision;
        if (cursor) progress.seen.add(cursor);
        this.workspaceSections[section] = { status: 'ready', ...provenance, updatedAt: provenance.fetchedAt ?? (Date.parse(page.updatedAt) || Date.now()), complete: page.complete, loadedCount: rows().length,
          includeClosed: section === 'issues' ? progress.includeClosed : undefined, refreshing: mode === 'all' && !page.complete };
        this.sendSnapshot();
        if (page.complete || mode !== 'all') break;
      } while (current() && requests < 20 && bytes < 16 * 1024 * 1024 && Date.now() - started < 30_000);
      const state = this.workspaceSections[section];
      if (state) this.workspaceSections[section] = { ...state, refreshing: false, ...(!progress.complete && mode === 'all' ? { pausedReason: '本批已達載入預算，已保留位置；可繼續完整載入。' } : {}) };
      if (section === 'issues' && this.issueGraphVisible && !this.refreshTask && current()) await this.loadIssueGraph(connectedScope, reset);
    } catch (error) {
      if (!current()) return;
      if (error instanceof GitLabBudgetExceededError) {
        this.workspaceSections[section] = { ...this.workspaceSections[section], status: 'ready', complete: false, loadedCount: rows().length, refreshing: false, error: undefined, pausedReason: error.message };
        return;
      }
      const message = readableError(error);
      const state = this.workspaceSections[section], transport = readFailureTransport(state, error);
      if (section === 'milestones') { this.groupMilestonesError = message; }
      if (section === 'boards') { this.groupIssueBoardsError = message; }
      if (state?.status === 'ready') this.workspaceSections[section] = { ...state, ...transport, error: message, pausedReason: '已保留已載入資料與下一頁位置，可重試繼續。', refreshing: false };
      else this.workspaceSections[section] = { ...state, ...transport, status: 'error', error: message, refreshing: false };
      this.noteOutcome({ status: 'failed', error: message });
    } finally {
      budget.dispose();
      if (this.workspaceSectionAborts.get(section) === controller) {
        this.workspaceSectionAborts.delete(section);
        if (controller.signal.aborted) {
          const state = this.workspaceSections[section];
          this.workspaceSections[section] = { ...state, status: rows().length ? 'ready' : 'idle', refreshing: false, complete: progress.complete, loadedCount: rows().length, pausedReason: '已取消，已取得的資料與下一頁位置保留。' };
        }
        this.sendSnapshot();
      }
    }
  }

  private isRemotePage(): boolean {
    return this.activeMode === 'developer' || this.activeMode === 'reviewer' ||
      this.activeMode === 'clone' && this.projectSource !== 'local' && !!this.session.baseUrl && !!this.session.selectedGroup;
  }

  private changeMergeRequestFilter(filter: 'all' | 'reviewer' | 'assigned'): void {
    if (filter === (this.mergeRequestFilter ?? 'all')) return;
    this.workspaceSectionAborts.get('mergeRequests')?.abort();
    this.mergeRequestFilter = filter;
    this.workspaceSectionPages.delete('mergeRequests');
    this.workspaceSections.mergeRequests = { status: 'idle' };
    this.mergeRequests = [];
  }

  private refresh(options: WorkspaceRefreshOptions = {}): Promise<void> {
    if (this.panel?.visible === false && !options.forceNetwork) { this.workspaceRefreshPending = true; return Promise.resolve(); }
    this.workspaceRefreshPending = false;
    const scope = JSON.stringify([this.activeMode, this.projectSource, this.developerView, this.mergeRequestFilter ?? 'all',
      this.isRemotePage() ? this.connectedScopeKey() : this.getLocalOperationScope(), this.session.connectionEpoch]);
    // ready, reveal and navigation can describe the same entry while it is loading.
    if (this.refreshTask && this.refreshScopeKey === scope && !this.refreshAbort?.signal.aborted) {
      // A manual refresh arriving during a cache-backed entry must still force
      // its own revalidation; concurrent manual requests then join that pass.
      if (options.forceNetwork && !this.refreshForceNetwork) return this.refreshTask.then(() => this.refresh(options));
      return this.refreshTask;
    }
    this.refreshAbort?.abort();
    const abort = new AbortController();
    this.refreshAbort = abort;
    this.refreshScopeKey = scope;
    this.refreshForceNetwork = options.forceNetwork === true;
    const generation = ++this.requestGeneration;
    const task = this.refreshWorkspace(generation, abort.signal, options);
    this.refreshTask = task;
    return task.finally(() => {
      if (this.refreshTask === task) { this.refreshTask = undefined; this.refreshScopeKey = undefined; }
    });
  }

  private async refreshWorkspace(
    generation: number,
    signal: AbortSignal,
    options: WorkspaceRefreshOptions
  ): Promise<void> {
    const mode = this.activeMode, source = this.projectSource;
    if (options.forceRepositories) this.projectEnvironmentSnapshots?.clear();
    const current = () => !signal.aborted && !this.disposed && generation === this.requestGeneration &&
      mode === this.activeMode && (mode !== 'clone' || source === this.projectSource);
    const busyOwner = `refresh:${generation}`;
    this.busy = true;
    this.setBusyOwner(busyOwner, '正在更新目前頁面');
    this.pendingWorkspaceRefresh = false;
    try {
      if (!this.isRemotePage()) {
        if (mode === 'sa') {
          await this.refreshWorkflowKit(true, signal);
          if (current()) await this.refreshInventory();
        } else if (mode === 'bmad') {
          await this.refreshBmadWorkflow(true);
        } else if (mode === 'git') {
          await this.gitRepositories?.refresh();
          if (current()) {
            await this.sendGitRepositories();
            if (options.refreshGitSnapshot && this.selectedGitRepositoryId) {
              const snapshot = await this.gitRepositories?.handleAction(this.selectedGitRepositoryId, { type: 'refresh' });
              if (current() && snapshot) this.post({ type: 'gitSnapshot', snapshot });
            }
          }
        } else if (mode === 'clone') {
          const context = await this.resolveProjectContext();
          if (!current()) return;
          this.projectContext = context;
          this.groupRoot = context.root; this.cloneRoot = context.root;
          this.workspaceRootError = context.error; this.cloneRootError = context.error;
          await this.refreshInventory();
        }
        return;
      }
      if (!this.session.baseUrl) {
        this.clearRemoteGroupData(); this.currentUser = undefined; this.groups = [];
        return;
      }
      if (!this.currentUser) {
        const user = await this.session.cachedRead('current-user', client => client.getCurrentUser(), { signal, reason: options.reason ?? 'entry' });
        if (!current()) return;
        this.currentUser = user;
        await this.session.updateCurrentUser(user);
        await this.timer.setScope(this.session.baseUrl, user.id);
        this.syncTimerPolling();
      }
      if (!this.groups.length) {
        const groups = await this.session.cachedRead('groups', client => client.listGroups(), { signal, reason: options.reason ?? 'entry' });
        if (!current()) return;
        this.groups = groups;
      }
      void this.session.ensureMetadataChecked().then(() => { if (current()) this.sendSnapshot(); }).catch(() => undefined);
      const group = this.session.selectedGroup;
      if (!group) { this.clearRemoteGroupData(); return; }
      if (!this.groups.some(item => item.id === group.id)) {
        await this.session.setSelectedGroup(undefined);
        this.clearRemoteGroupData();
        this.post({ type: 'message', message: '上次選取的 Group 已無法存取，請重新選擇。' });
        return;
      }
      const scope = `${this.session.baseUrl}|${this.currentUser!.id}|${group.id}` as LoadedWorkspaceIdentity;
      if (scope !== this.loadedScopeKey) {
        this.clearRemoteGroupData();
        this.loadedScopeKey = scope;
        this.projectLocalRepositoryStates = {}; this.projectRepositoriesKey = undefined;
        this.localRepositoryStates = {}; this.localRepositoriesKey = undefined;
      }
      // Projects validate the remote scope; they do not inspect the local disk.
      await this.loadWorkspaceSection('projects', options.forceNetwork === true, undefined, options.reason ?? 'entry');
      if (!current()) return;
      if (mode === 'clone') {
        await this.refreshProjectRoot(true, signal);
      } else {
        await this.loadActiveModeSections(mode, options.forceNetwork === true, options.reason ?? 'entry');
        if (!current()) return;
        if (mode === 'developer') {
          if (this.developerView === 'graph') {
            const connectedScope = this.connectedScopeKey();
            if (connectedScope) { this.issueGraphVisible = true; await this.loadIssueGraph(connectedScope, options.forceNetwork === true); }
          } else if (this.selectedIssueBoardId !== undefined && this.groupIssueBoards.some(board => board.id === this.selectedIssueBoardId)) {
            await this.loadIssueBoardContent(group.full_path, this.selectedIssueBoardId, ++this.issueBoardGeneration, this.connectedScopeKey(), options.forceNetwork === true);
          }
        } else if (mode === 'reviewer' && options.forceNetwork && this.selectedMergeRequest) {
          const { project_id: projectId, iid } = this.selectedMergeRequest.request;
          if (Number.isSafeInteger(projectId) && Number.isSafeInteger(iid)) await this.refreshMergeRequestData(projectId, iid, 'used');
        } else if (mode === 'reviewer' && this.selectedMergeRequest) {
          const { project_id: projectId, iid } = this.selectedMergeRequest.request;
          await this.loadMergeRequest(projectId, iid);
        }
      }
    } catch (error) {
      if (current()) throw error;
    } finally {
      this.setBusyOwner(busyOwner);
      if (generation === this.requestGeneration) { this.busy = false; this.sendSnapshot(); }
    }
  }

  private groupProjectScopeReady(): boolean {
    return !!this.session.baseUrl && !!this.currentUser && !!this.session.selectedGroup &&
      this.loadedScopeKey === `${this.session.baseUrl}|${this.currentUser.id}|${this.session.selectedGroup.id}` &&
      this.workspaceSections?.projects?.status === 'ready';
  }

  private projectFolders(): ProjectFolder[] {
    return (vscode.workspace.workspaceFolders ?? []).filter(folder => folder.uri.scheme === 'file')
      .map(folder => ({ uri: folder.uri.toString(), name: folder.name ?? path.basename(folder.uri.fsPath), path: folder.uri.fsPath }));
  }

  private projectContextSignature(): string {
    const folders = this.projectFolders();
    const folder = selectedProjectFolder(folders, this.context.workspaceState.get<string>(PROJECT_FOLDER_KEY));
    const resource = vscode.workspace.workspaceFolders?.find(item => item.uri.toString() === folder?.uri)?.uri;
    const configured = folder ? vscode.workspace.getConfiguration('gitlabWorkspace', resource).get<string>(PROJECT_ROOT_SETTING, '') : '';
    return JSON.stringify([folders, folder?.uri, configured]);
  }

  private async resolveProjectContext(): Promise<ProjectRootContext> {
    const folders = this.projectFolders();
    const selected = this.context.workspaceState.get<string>(PROJECT_FOLDER_KEY);
    const folder = selectedProjectFolder(folders, selected);
    const resource = vscode.workspace.workspaceFolders?.find(item => item.uri.toString() === folder?.uri)?.uri;
    const configured = folder ? vscode.workspace.getConfiguration('gitlabWorkspace', resource).get<string>(PROJECT_ROOT_SETTING, '') : '';
    return resolveProjectRootContext(folders, selected, typeof configured === 'string' ? configured : '');
  }

  private async inspectEnvironment(projects: readonly GitLabProject[] = [], signal?: AbortSignal): Promise<GroupWorkspaceMatch> {
    const context = await this.resolveProjectContext();
    if (!context.root || context.error) return { status: 'unverified', reason: context.error, repositories: [] };
    return this.inspectEnvironmentSnapshot(context.root, projects, signal);
  }

  private inspectEnvironmentSnapshot(root: string, projects: readonly GitLabProject[], signal?: AbortSignal): Promise<GroupWorkspaceMatch> {
    this.projectEnvironmentSnapshots ??= new ProjectEnvironmentSnapshotCache();
    return this.projectEnvironmentSnapshots.inspect(root, projects, projectRemoteMatches, {
      scopeKey: JSON.stringify([this.session.baseUrl, this.session.activeAccountId, this.session.connectionEpoch, this.projectContextSignature()]),
      signal
    });
  }

  private async resolveWorkspaceRoot(projects: readonly GitLabProject[], signal?: AbortSignal): Promise<{ root?: string; error?: string; match: GroupWorkspaceMatch }> {
    const match = await this.inspectEnvironment(projects, signal);
    return { root: match.root, error: match.reason, match };
  }

  private invalidateProjectRoot(reason?: string): void {
    this.cloneRootGeneration = (this.cloneRootGeneration ?? 0) + 1;
    this.projectRepositoryScanGeneration = (this.projectRepositoryScanGeneration ?? 0) + 1;
    this.cloneRoot = undefined; this.cloneRootScope = undefined; this.cloneRootError = reason;
    this.cloneRootManual = false; this.projectLocalRepositoryStates = {}; this.projectRepositoriesKey = undefined;
  }

  private async resolveProjectRoot(): Promise<WorkspaceRootResolution & { manual: boolean; revision: string }> {
    const context = await this.resolveProjectContext();
    return { root: context.root, error: context.error, manual: context.manual, revision: context.revision };
  }

  private async refreshProjectRoot(forceRepositories = false, signal?: AbortSignal): Promise<void> {
    const generation = this.cloneRootGeneration = (this.cloneRootGeneration ?? 0) + 1;
    const signature = this.projectContextSignature();
    const scope = this.connectedScopeKey();
    const projects = this.projects;
    const context = await this.resolveProjectContext();
    if (signal?.aborted || this.disposed || generation !== this.cloneRootGeneration || signature !== this.projectContextSignature()) return;
    this.projectContext = context;
    this.syncBmadVisibility();
    this.cloneRoot = context.root; this.cloneRootError = context.error;
    this.cloneRootManual = context.manual; this.cloneRootScope = scope;
    const repositoryKey = scope && this.repositoryStateKey(scope, context.root, projects);
    if (scope && context.root && repositoryKey && (forceRepositories || this.projectRepositoriesKey !== repositoryKey)) {
      await this.refreshLocalRepositoryStates(context.root, projects, scope, repositoryKey, true, signal);
    } else if (!context.root || !scope) {
      this.projectLocalRepositoryStates = {}; this.projectRepositoriesKey = undefined;
    }
    this.sendSnapshot();
  }

  private assertProjectContextMutable(): void {
    if (this.busy && !this.refreshTask || this.writesInFlight || this.gitRepositories?.hasActiveOperations || this.session.hasActiveWrites ||
        this.repositoryOperationInProgress || this.cloneRootSelecting || this.workflowKitSelectingRoot || this.accountTransitionBusy ||
        this.workflowKitInstallation || this.workflowKitCheckingRelease) {
      throw new Error('請等候目前專案操作完成後再變更根目錄。');
    }
  }

  private async selectProjectFolder(folderUri: string): Promise<void> {
    this.assertProjectContextMutable();
    if (!this.projectFolders().some(folder => folder.uri === folderUri)) throw new Error('請選擇目前 VS Code 開啟的專案資料夾。');
    this.workflowKitSelectingRoot = true; this.sendSnapshot();
    try {
      await this.context.workspaceState.update(PROJECT_FOLDER_KEY, folderUri);
      this.onWorkspaceFoldersChanged();
      await this.refresh({ reason: 'entry' });
    } finally { this.workflowKitSelectingRoot = false; this.sendSnapshot(); }
  }

  private async selectProjectRoot(reset = false): Promise<void> {
    this.assertProjectContextMutable();
    this.workflowKitSelectingRoot = true; this.sendSnapshot();
    try {
      const signature = this.projectContextSignature();
      const context = await this.resolveProjectContext();
      const folder = vscode.workspace.workspaceFolders?.find(item => item.uri.toString() === context.selectedFolderUri);
      if (!folder) throw new Error(context.error ?? '請先選擇 VS Code 專案資料夾。');
      let root: string | undefined;
      if (!reset) {
        const selection = await vscode.window.showOpenDialog({ title: '選擇共用專案根目錄',
          canSelectFiles: false, canSelectFolders: true, canSelectMany: false, openLabel: '選擇資料夾',
          defaultUri: vscode.Uri.file(context.root ?? folder.uri.fsPath) });
        if (!selection?.[0]) { this.noteOutcome({ status: 'cancelled', effect: 'none' }); return; }
        if (selection[0].scheme !== 'file') throw new Error('請選擇本機資料夾。');
        const checked = await resolveProjectRootContext(context.folders, context.selectedFolderUri, selection[0].fsPath);
        if (!checked.root || checked.error) throw new Error(checked.error ?? '請選擇有效的專案根目錄。');
        root = checked.root;
      }
      if (signature !== this.projectContextSignature()) throw new Error('專案資料夾或設定已變更，請重新選擇。');
      const target = vscode.workspace.workspaceFile || (vscode.workspace.workspaceFolders?.length ?? 0) > 1
        ? vscode.ConfigurationTarget.WorkspaceFolder : vscode.ConfigurationTarget.Workspace;
      await vscode.workspace.getConfiguration('gitlabWorkspace', folder.uri).update(PROJECT_ROOT_SETTING, root ?? '', target);
      this.projectContext = undefined;
      if (this.activeMode === 'sa') await this.refreshWorkflowKit();
      else if (this.activeMode === 'bmad') await this.refreshBmadWorkflow(true);
      else await this.refreshProjectRoot(this.activeMode === 'clone' && this.projectSource !== 'local');
    } finally { this.workflowKitSelectingRoot = false; this.sendSnapshot(); }
  }

  private async watchRepositoryRemotes(signal?: AbortSignal): Promise<void> {
    if (signal?.aborted || !vscode.workspace.createFileSystemWatcher) return;
    const generation = this.skillsEnvironmentGeneration;
    const roots = this.workspaceMatch.repositories.map(repo => repo.path);
    const folders = (vscode.workspace.workspaceFolders ?? []).filter(folder => folder.uri.scheme === 'file').map(folder => folder.uri.fsPath);
    const projectRoot = this.projectContext?.root;
    if (projectRoot && !folders.some(folder => sameLocalPath(folder, projectRoot))) folders.push(projectRoot);
    const signature = JSON.stringify([roots, folders]);
    if (signature === this.remoteWatchSignature) return;
    const patterns = await Promise.all(roots.map(async root => {
      try {
        const result = await execFileAsync('git', ['-C', root, 'rev-parse', '--path-format=absolute', '--git-path', 'config'], { windowsHide: true, timeout: 5000, signal });
        const config = result.stdout.trim();
        return new vscode.RelativePattern(path.dirname(config), `${path.basename(config)}{,.worktree}`);
      } catch { return new vscode.RelativePattern(root, '.git/config'); }
    }));
    patterns.push(...folders.map(root => new vscode.RelativePattern(root, '{.git,*/.git,*/.git/config}')));
    if (signal?.aborted || this.disposed || generation !== this.skillsEnvironmentGeneration) return;
    this.remoteWatchers.forEach(watcher => watcher.dispose());
    this.remoteWatchSignature = signature;
    this.remoteWatchers = patterns.map(pattern => {
      const watcher = vscode.workspace.createFileSystemWatcher(pattern);
      const refresh = () => this.scheduleSkillsEnvironmentRefresh();
      watcher.onDidChange(refresh); watcher.onDidCreate(refresh); watcher.onDidDelete(refresh);
      return watcher;
    });
  }

  private scheduleSkillsEnvironmentRefresh(): void {
    if (this.disposed) return;
    this.projectEnvironmentSnapshots?.clear();
    this.skillBranchReads?.clear();
    this.workspaceRefreshPending = true;
    // Keep the displayed environment until the next explicit entry/refresh.
    this.sendSnapshot();
  }

  private async invalidateReviewAuthObservations(): Promise<void> {
    const skills = this.getSkillsContext();
    const roots = [skills.reviewRuntimeRoot, skills.releaseReviewRuntimeRoot].filter((root): root is string => !!root);
    await invalidateReviewAuth(roots);
  }

  private getSkillsContext(): SkillsContext {
    const current = this.workspaceMatch ?? { status: 'unverified' as const, repositories: [] };
    const workspaceFile = vscode.workspace.workspaceFile?.scheme === 'file' ? vscode.workspace.workspaceFile.fsPath : undefined;
    const openedFolders = (vscode.workspace.workspaceFolders ?? []).filter(folder => folder.uri.scheme === 'file').map(folder => folder.uri.fsPath);
    const folders = this.reviewerWorkspaceFolders?.signature === JSON.stringify(openedFolders)
      ? this.reviewerWorkspaceFolders.folders : openedFolders;
    const reviewRoot = vscode.workspace.getConfiguration?.('gitlabWorkspace').get<string>('reviewRuntimePath', '').trim()
      || process.env.MERGE_REVIEW_RUNTIME_DIR || undefined;
    const reviewWorkspace = workspaceFile ? path.dirname(workspaceFile) : folders.length === 1 ? folders[0] : undefined;
    const reviewRuntimeRoot = reviewRoot ? path.resolve(reviewRoot)
      : reviewWorkspace ? defaultReviewRuntime(reviewWorkspace, 'merge-reviewer') : undefined;
    const releaseReviewRuntimeRoot = process.env.RELEASE_REVIEW_RUNTIME_DIR ? path.resolve(process.env.RELEASE_REVIEW_RUNTIME_DIR)
      : reviewRoot ? path.join(path.resolve(reviewRoot), 'release-reviewer')
        : reviewWorkspace ? defaultReviewRuntime(reviewWorkspace, 'release-reviewer') : undefined;
    const reviewAuthScope = reviewerAuthScope(this.reviewAuthHostNonce ??= randomUUID(), this.session.baseUrl,
      this.session.activeAccountId, this.currentUser?.id, this.session.connectionEpoch);
    let reviewerExecution: ReviewerExecutionOverrides | undefined, reviewerExecutionError: string | undefined;
    try {
      // Reviewer settings are workspace-local. Never inherit user/global model settings.
      const configured = vscode.workspace.getConfiguration?.('gitlabWorkspace', vscode.workspace.workspaceFolders?.[0]?.uri)
        .inspect?.<ReviewerExecutionOverrides>('reviewer.execution');
      reviewerExecution = reviewerExecutionFromConfiguration(configured);
    } catch { reviewerExecutionError = 'Reviewer 工作區執行設定無效，請檢查模式、模型識別碼與推理強度。'; }
    const signature = JSON.stringify([this.projectContextSignature(), workspaceFile, this.skillsWorkflowKitStateRoot, reviewRuntimeRoot, releaseReviewRuntimeRoot, reviewAuthScope, reviewerExecution, reviewerExecutionError,
      folders, this.reviewerNativeRepositories ?? []]);
    const cached = this.skillsContextCache;
    if (cached?.signature === signature && cached.context === this.projectContext && cached.match === current &&
      cached.installed === this.skillsWorkflowKitState && cached.projects === this.projects) return cached.value;
    const projectById = new Map(this.projects.map(project => [project.id, project]));
    const match = { ...current, root: this.projectContext?.root ?? current.root, repositories: current.repositories.map(repo => ({ ...repo,
      defaultBranch: repo.projectId === undefined ? undefined : projectById.get(repo.projectId)?.default_branch?.trim() || undefined })) };
    const nativeRepositories = (this.reviewerNativeRepositories ?? []).map(repo => {
      const associated = this.projects.filter(project => (repo.remotes ?? []).some(remote => projectRemoteMatches(remote, project)));
      return { name: repo.name, path: repo.path,
        defaultBranch: associated.length === 1 ? associated[0].default_branch?.trim() || undefined : undefined };
    });
    const reviewerRepositories = collectReviewerRepositories(nativeRepositories,
      current.status === 'matched' ? match.repositories : [], folders);
    const installed = match.root && this.skillsWorkflowKitStateRoot && sameLocalPath(match.root, this.skillsWorkflowKitStateRoot)
      ? this.skillsWorkflowKitState : { status: 'missing' as const };
    const localRepositories = current.repositories.map(({ name, path: repoPath, remoteFingerprint }) => ({ name, path: repoPath, remoteFingerprint }));
    const revision = createHash('sha256').update(JSON.stringify([this.projectContextSignature(), this.projectContext?.revision,
      current.status, current.profile, localRepositories, installed, workspaceFile,
      reviewerRepositories.map(({ name, path: repoPath }) => ({ name, path: repoPath })), reviewRuntimeRoot, releaseReviewRuntimeRoot, reviewAuthScope, reviewerExecution, reviewerExecutionError])).digest('hex');
    const value = { ...resolveSkillsContext({ match, installed, revision }),
      reviewerRepositories, workspaceFile, workspaceRoot: workspaceFile ? path.dirname(workspaceFile)
        : vscode.workspace.workspaceFolders?.length === 1 ? vscode.workspace.workspaceFolders[0].uri.fsPath : undefined,
      workspaceRootAmbiguous: (vscode.workspace.workspaceFolders?.length ?? 0) > 1 && !workspaceFile,
      reviewRuntimeRoot, releaseReviewRuntimeRoot, reviewAuthScope, reviewerExecution, reviewerExecutionError };
    this.skillsContextCache = { signature, context: this.projectContext, match: current, installed: this.skillsWorkflowKitState, projects: this.projects, value };
    return value;
  }

  private operationScope(): string {
    return `${this.connectedScopeKey() ?? 'offline'}:${this.projectContext?.revision ?? this.groupRoot ?? 'none'}:${this.session.connectionEpoch ?? 0}`;
  }

  private operationPhase(action: string, phase: string): void {
    const requestId = this.operationContext.getStore();
    if (requestId) { this.operations.update(requestId, { phase }); return; }
    for (const operation of this.operations.list(this.operationScope())) {
      if (operation.action === action && operation.status === 'running') this.operations.update(operation.requestId, { phase });
    }
  }

  private async copySkillGuidePrompt(request: Extract<WorkspaceRequest, { type: 'copySkillGuidePrompt' }>): Promise<void> {
    this.operationPhase('copySkillGuidePrompt', '核對目前環境與 Skills…');
    const previous = this.getSkillsContext();
    if (request.revision !== previous.revision) throw new Error('Skills 環境已變更，請重新確認提示詞。');
    await this.refreshWorkflowKit();
    if (request.featureId === 'merge-repo' || request.featureId === 'release-review') await this.refreshInventory();
    const current = this.getSkillsContext();
    if (request.revision !== current.revision) throw new Error('工作區或 Skills 安裝狀態已變更，請重新確認提示詞。');
    const card = getSkillGuideCards(current.mode === 'group' ? 'group' : 'repository').find(item => item.id === request.featureId);
    if (!card || !current.availableFeatures.includes(card.id) || !canCopySkillPrompt(card, request.inputs)) throw new Error(current.reason ?? '此功能目前無法使用。');
    const reviewer = card.tool === 'merge-reviewer' || card.tool === 'release-reviewer';
    const repositories = reviewer ? current.reviewerRepositories ?? [] : current.repositories;
    const selectedRepository = reviewer ? resolveReviewerRepository(request.inputs[`${card.id}.repo`] ?? '', repositories) : undefined;
    if (reviewer && !selectedRepository) throw new Error('請從目前 VS Code 工作區選擇唯一的本機 Repo。');
    const reviewerBinding = reviewer && current.root ? await readInstalledReviewerBinding(current.root, card.tool as ReviewerToolId) : undefined;
    const reviewerCapabilities = reviewerBinding ? await readReviewerCapabilities(reviewerBinding,
      await resolvePythonRuntime(vscode.workspace.getConfiguration('gitlabWorkspace').get<string>('pythonPath', 'python')),
      current.workspaceRoot ?? current.root!) : undefined;
    if (reviewer && this.getSkillsContext().revision !== current.revision) throw new Error('工作區或 Skills 安裝狀態已變更，請重新確認提示詞。');
    const inputs = selectedRepository ? { ...request.inputs, [`${card.id}.repo`]: selectedRepository.path } : request.inputs;
    const context = { profile: current.mode === 'group' ? 'group' as const : 'repository' as const, root: current.root,
      reviewRuntimeRoot: current.reviewRuntimeRoot, releaseReviewRuntimeRoot: current.releaseReviewRuntimeRoot, reviewAuthScope: current.reviewAuthScope,
      reviewerExecution: current.reviewerExecution, reviewerExecutionError: current.reviewerExecutionError, reviewerBinding, reviewerCapabilities,
      groupRoot: current.mode === 'group' ? current.root : undefined, workflowKitVersion: current.installed.version,
      workspaceFile: vscode.workspace.workspaceFile?.scheme === 'file' ? vscode.workspace.workspaceFile.fsPath : undefined,
      workspaceRoot: vscode.workspace.workspaceFile?.scheme === 'file'
        ? path.dirname(vscode.workspace.workspaceFile.fsPath)
        : vscode.workspace.workspaceFolders?.length === 1 ? vscode.workspace.workspaceFolders[0].uri.fsPath : undefined,
      workspaceRootAmbiguous: (vscode.workspace.workspaceFolders?.length ?? 0) > 1
        && vscode.workspace.workspaceFile?.scheme !== 'file',
      repositories, repositoryScanStatus: 'ready' as const };
    this.operationPhase('copySkillGuidePrompt', '寫入剪貼簿…');
    await vscode.env.clipboard.writeText(`${buildSkillGuideContext(card, context)}\n\n${buildSkillGuidePrompt(card, inputs, context)}`);
    this.post({ type: 'message', message: '已複製目前環境的 Skills 提示詞。' });
  }

  private refreshActualRepositories(root: string, connectedScope: string): Promise<void> {
    const key = `${localPathKey(root)}:${connectedScope}:${this.workspaceFoldersGeneration}:${this.skillsEnvironmentGeneration}`;
    if (this.actualRepositoryScanTask?.key === key) return this.actualRepositoryScanTask.task;
    const task = this.refreshActualRepositoriesNow(root, connectedScope);
    const entry = { key, task }; this.actualRepositoryScanTask = entry;
    void task.finally(() => { if (this.actualRepositoryScanTask === entry) this.actualRepositoryScanTask = undefined; }).catch(() => undefined);
    return task;
  }

  private async refreshActualRepositoriesNow(root: string, _connectedScope: string): Promise<void> {
    const generation = ++this.actualRepositoryScanGeneration;
    this.actualRepositoryScanAbort?.abort();
    const controller = new AbortController(); this.actualRepositoryScanAbort = controller;
    const workspaceGeneration = this.workspaceFoldersGeneration;
    const current = async (): Promise<boolean> => {
      const currentRoot = this.groupRoot;
      const matches = !!currentRoot && await sameRealLocalPathAsync(root, currentRoot);
      return !this.disposed && generation === this.actualRepositoryScanGeneration && workspaceGeneration === this.workspaceFoldersGeneration &&
        currentRoot === this.groupRoot && matches;
    };
    if (!this.actualRepositoriesRoot || !sameLocalPath(root, this.actualRepositoriesRoot)) this.actualRepositories = [];
    this.actualRepositoriesRoot = root;
    this.actualRepositoryScanStatus = 'scanning';
    this.actualRepositoryScanError = undefined;
    this.sendSnapshot();
    try {
      const repositories = await scanLocalGroupRepositories(root, false, controller.signal);
      if (!await current()) return;
      this.actualRepositories = repositories;
      this.actualRepositoryScanStatus = 'ready';
    } catch (error) {
      if (controller.signal.aborted) return;
      if (!await current()) return;
      this.actualRepositoryScanStatus = 'error';
      this.actualRepositoryScanError = readableError(error);
    } finally { if (this.actualRepositoryScanAbort === controller) this.actualRepositoryScanAbort = undefined; }
    this.sendSnapshot();
  }

  private onWorkspaceFoldersChanged(): void {
    this.reviewWatcher?.dispose(); this.reviewWatcherRoot = undefined;
    if (this.reviewRefreshTimer) clearTimeout(this.reviewRefreshTimer);
    this.projectEnvironmentSnapshots?.clear();
    this.actualRepositoryScanAbort?.abort();
    this.skillBranchReads?.clear();
    this.reviewerNativeRepositories = [];
    this.reviewerWorkspaceFolders = undefined;
    this.bmad?.setContext(undefined, undefined, false);
    this.projectContext = undefined;
    this.invalidateProjectRoot('正在辨識專案下載／更新位置…');
    this.skillsEnvironmentGeneration++;
    this.workspaceMatch = { status: 'checking', repositories: [] };
    this.workflowKitRefreshGeneration++;
    this.workflowKitInstallRefreshGeneration = (this.workflowKitInstallRefreshGeneration ?? 0) + 1;
    this.repositoryScanAbort?.abort();
    this.repositoryScanAbort = undefined;
    this.repositoryScan = { status: 'idle', checkedDirectories: 0, repositories: [], errors: [], excludes: DEFAULT_SCAN_EXCLUDES };
    this.inventoryGeneration++;
    this.workspaceFoldersGeneration++;
    this.localRepositoryScanGeneration++;
    this.actualRepositoryScanGeneration++;
    this.pendingWorkspaceRefresh = true;
    this.refreshAbort?.abort(); this.requestGeneration++;
    if (this.busy || this.repositoryOperationInProgress) { this.sendSnapshot(); return; }
    this.groupRoot = undefined;
    this.workspaceRootError = '正在辨識目前 VSCode 工作區…';
    this.localRepositoryStates = {};
    this.localRepositoriesKey = undefined;
    this.actualRepositories = [];
    this.actualRepositoriesRoot = undefined;
    this.actualRepositoryScanStatus = 'idle';
    this.actualRepositoryScanError = undefined;
    this.sendSnapshot();
    this.schedulePendingWorkspaceRefresh();
  }

  private schedulePendingWorkspaceRefresh(): void {
    // Workspace/config events only invalidate. Entry/manual refresh consumes it.
    if (this.pendingWorkspaceRefresh) this.workspaceRefreshPending = true;
  }

  private async refreshInventory(): Promise<void> {
    if (this.disposed) return;
    const generation = this.inventoryGeneration = (this.inventoryGeneration ?? 0) + 1;
    const openedFolders = (vscode.workspace.workspaceFolders ?? []).filter(folder => folder.uri.scheme === 'file').map(folder => folder.uri.fsPath);
    try {
      const [inventory, folders] = await Promise.all([
        this.gitRepositories?.getInventory().then(repositories => ({ repositories }), error => ({ repositories: [] as ScannedRepository[], error }))
          ?? Promise.resolve({ repositories: [] as ScannedRepository[] }),
        Promise.all(openedFolders.map(folder => realpath(folder).catch(() => folder)))
      ]);
      if (generation !== this.inventoryGeneration || this.disposed) return;
      this.reviewerWorkspaceFolders = { signature: JSON.stringify(openedFolders), folders };
      const registered = inventory.repositories;
      this.reviewerNativeRepositories = registered;
      const localInventory = new Map((this.repositoryScan?.repositories ?? []).map(repository => [localPathKey(repository.path), repository]));
      for (const repository of registered) localInventory.set(localPathKey(repository.path), repository);
      this.localWorkspaceRepositories = [...localInventory.values()].sort((a, b) => a.path.localeCompare(b.path));
      if ('error' in inventory) this.session.log?.record({ feature: 'projects', action: 'repositoryInventory', result: 'error', message: readableError(inventory.error) });
      this.sendSnapshot();
    } catch (error) {
      if (generation !== this.inventoryGeneration || this.disposed) return;
      this.reviewerNativeRepositories = [];
      this.sendSnapshot();
      this.session.log?.record({ feature: 'projects', action: 'repositoryInventory', result: 'error', message: readableError(error) });
    }
  }

  private async scanRepositories(resume = false): Promise<void> {
    if (!this.gitRepositories) throw new Error('Git 版控服務尚未載入。');
    const root = this.projectContext?.root;
    if (!root) throw new Error(this.projectContext?.error ?? '請先開啟或選擇專案資料夾。');
    if (this.repositoryScanAbort && !this.repositoryScanAbort.signal.aborted && this.repositoryScan.status === 'scanning') return;
    const controller = new AbortController();
    this.repositoryScanAbort = controller;
    const workspaceGeneration = this.workspaceFoldersGeneration;
    let lastProgress = 0;
    this.repositoryScan = resume ? { ...this.repositoryScan, status: 'scanning', canResume: false } : { status: 'scanning', checkedDirectories: 0, repositories: [], errors: [], excludes: DEFAULT_SCAN_EXCLUDES };
    this.sendSnapshot();
    try {
      const result = await this.gitRepositories.scanWorkspace(controller.signal, state => {
        if (this.disposed || this.repositoryScanAbort !== controller || workspaceGeneration !== this.workspaceFoldersGeneration) return;
        this.repositoryScan = state;
        if (Date.now() - lastProgress > 200 || state.status !== 'scanning') { lastProgress = Date.now(); this.sendSnapshot(); }
      }, [root], resume);
      if (this.disposed || this.repositoryScanAbort !== controller || workspaceGeneration !== this.workspaceFoldersGeneration) return;
      this.repositoryScan = result;
      await this.refreshInventory();
      await this.syncSidebarState?.();
      this.session.log?.record({ feature: 'projects', action: 'repositoryScanResult', result: result.status === 'cancelled' ? 'cancelled' : result.status === 'error' ? 'error' : 'success', message: `找到 ${result.repositories.length} 個 Repo，${result.errors.length} 個掃描錯誤。` });
    } catch (error) {
      if (this.repositoryScanAbort !== controller || workspaceGeneration !== this.workspaceFoldersGeneration) return;
      this.repositoryScan = { ...this.repositoryScan, status: controller.signal.aborted ? 'cancelled' : 'error', errors: [...this.repositoryScan.errors, { path: '', message: readableError(error) }] };
    } finally { if (this.repositoryScanAbort === controller) { this.repositoryScanAbort = undefined; this.sendSnapshot(); } }
  }

  private repositoryStateKey(
    connectedScope: ConnectedScope | '',
    root: string | undefined,
    projects: readonly GitLabProject[]
  ): string | undefined {
    if (!root) return undefined;
    return `${connectedScope}\0${root}\0${projects.map((project) => `${project.id}:${project.path}`).join('\0')}`;
  }

  private async refreshLocalRepositoryStates(
    root: string,
    projects: readonly GitLabProject[],
    connectedScope: ConnectedScope,
    repositoryKey: string,
    projectOperations = false,
    signal?: AbortSignal
  ): Promise<void> {
    if (signal?.aborted) return;
    // Project downloads and the Group summary inspect the same selected root.
    // Reuse the already verified scan instead of issuing another set of stats.
    if (!projectOperations && repositoryKey === this.projectRepositoriesKey && this.cloneRoot && sameLocalPath(root, this.cloneRoot)) {
      this.localRepositoryStates = this.projectLocalRepositoryStates;
      this.localRepositoriesKey = repositoryKey;
      this.sendSnapshot();
      return;
    }
    const generation = projectOperations
      ? this.projectRepositoryScanGeneration = (this.projectRepositoryScanGeneration ?? 0) + 1 : ++this.localRepositoryScanGeneration;
    let layout: Awaited<ReturnType<typeof resolveLocalRepositoryLayout>> | undefined;
    try { layout = await resolveLocalRepositoryLayout(root, projects, projectRemoteMatches, signal); }
    catch { if (signal?.aborted) return; }
    const states = await mapWithConcurrency(projects, 4, async (project) => {
      try {
        if (signal?.aborted) return [project.id, { path: '', state: 'unsafe' as const }] as const;
        if (!layout) return [project.id, { path: '', state: 'unsafe' as const }] as const;
        const localPath = layout.destinations.get(project.id)!;
        return [project.id, { path: localPath, state: await localRepositoryStateAsync(root, localPath, project.id === layout.rootProjectId) }] as const;
      } catch {
        return [project.id, { path: '', state: 'unsafe' as const }] as const;
      }
    });
    const currentRoot = projectOperations ? this.cloneRoot : this.groupRoot;
    if (signal?.aborted || this.disposed || generation !== (projectOperations ? this.projectRepositoryScanGeneration : this.localRepositoryScanGeneration) || connectedScope !== this.connectedScopeKey() ||
      repositoryKey !== this.repositoryStateKey(connectedScope, currentRoot, this.projects)) return;
    if (projectOperations) {
      this.projectLocalRepositoryStates = Object.fromEntries(states); this.projectRepositoriesKey = repositoryKey;
    } else {
      this.localRepositoryStates = Object.fromEntries(states); this.localRepositoriesKey = repositoryKey;
    }
    this.sendSnapshot();
  }

  private async selectIssueBoard(boardId: number, connectedScope: string, mode?: 'continue' | 'cancel'): Promise<void> {
    const group = this.session.selectedGroup;
    const currentScope = this.connectedScopeKey();
    if (!group || !currentScope || connectedScope !== currentScope || !Number.isSafeInteger(boardId) || boardId <= 0) return;
    if (mode === 'cancel') {
      if (this.selectedIssueBoardId !== boardId || this.issueBoardContent?.connectedScope !== currentScope) return;
      this.issueBoardAbort?.abort();
      this.issueBoardContent = { ...this.issueBoardContent, status: this.issueBoardContent.complete ? 'ready' : 'partial', pausedReason: '已取消；已確認的 Issue 與續傳位置保留。' };
      this.sendSnapshot(); return;
    }
    if (!this.groupIssueBoards.some((board) => board.id === boardId)) return;
    this.issueBoardAbort?.abort();
    this.selectedIssueBoardId = boardId;
    if (this.refreshTask) return;
    const generation = ++this.issueBoardGeneration;
    await this.loadIssueBoardContent(group.full_path, boardId, generation, currentScope);
  }

  private async loadIssueBoardContent(groupPath: string, boardId: number, generation: number, connectedScope?: string, forceNetwork = false): Promise<void> {
    if (!connectedScope) return;
    this.issueBoardAbort?.abort();
    const controller = new AbortController();
    this.issueBoardAbort = controller;
    const connectionEpoch = this.session.connectionEpoch;
    const matchesCurrentSelection = (): boolean => !this.disposed && generation === this.issueBoardGeneration &&
      connectionEpoch === this.session.connectionEpoch && connectedScope === this.connectedScopeKey() && this.session.selectedGroup?.full_path === groupPath &&
      this.selectedIssueBoardId === boardId && !controller.signal.aborted;
    if (!matchesCurrentSelection()) return;
    const username = this.currentUser?.username ?? '';
    if (!username) return;
    const fresh = () => ({ connectedScope, connectionEpoch, groupPath, boardId, username, issueIds: new Set<number>(), complete: false, updatedAt: Date.now(), cursor: undefined as GitLabBoardMembershipCursor | undefined });
    let progress = this.issueBoardLoad;
    if (!progress || forceNetwork || progress.connectedScope !== connectedScope || progress.connectionEpoch !== connectionEpoch || progress.groupPath !== groupPath || progress.boardId !== boardId || progress.username !== username || progress.complete && Date.now() - progress.updatedAt >= 60_000) progress = fresh();
    this.issueBoardLoad = progress;
    const publish = (status: NonNullable<WorkspaceSnapshot['issueBoardContent']>['status'], pausedReason?: string, error?: string): void => {
      if (!matchesCurrentSelection()) return;
      this.issueBoardContent = { boardId, connectedScope, issueIds: [...progress!.issueIds], loadedCount: progress!.issueIds.size, complete: progress!.complete, status, ...(pausedReason ? { pausedReason } : {}), ...(error ? { error } : {}) };
      this.sendSnapshot();
    };
    publish('loading');
    const budget = new GitLabRequestBudget({ requests: 20, bytes: 16 * 1024 * 1024, timeoutMs: 30_000 });
    try {
      const issueIds = await this.session.cachedRead<number[]>(
        groupBoardReadKey(this.session.selectedGroup!.id, boardId, 'assigned', username),
        async (readClient, cacheSignal = controller.signal) => {
          const client = readClient.withRequestBudget?.(budget) ?? readClient;
          // Keep the existing complete-result cache contract for older adapters.
          // Partial batches throw and remain solely in this selection checkpoint.
          if (!client.listGroupBoardIssueMembershipsPage) return client.listAssignedGroupBoardIssueIds(groupPath, boardId, username);
          if (progress!.complete) { progress = fresh(); if (matchesCurrentSelection()) this.issueBoardLoad = progress; publish('loading'); }
          for (let pages = 0; pages < 20; pages++) {
            const page = await client.listGroupBoardIssueMembershipsPage(groupPath, boardId, progress!.cursor, username);
            if (cacheSignal.aborted) throw cacheSignal.reason ?? Object.assign(new Error('Read cancelled.'), { name: 'AbortError' });
            if (!page.complete && !page.nextCursor) throw new Error('GitLab Board 回傳不完整的續傳位置。');
            for (const item of page.items) progress!.issueIds.add(item.issueId);
            progress!.cursor = page.nextCursor; progress!.complete = page.complete; progress!.updatedAt = Date.now();
            publish(page.complete ? 'ready' : 'loading');
            if (page.complete) return [...progress!.issueIds];
          }
          throw new GitLabBudgetExceededError('requests');
        },
        // SWR can retain an older complete value after a forced refresh pauses.
        // A saved cursor must continue that new snapshot rather than read it.
        { signal: controller.signal, force: forceNetwork || progress.cursor !== undefined }
      );
      if (!matchesCurrentSelection()) return;
      progress.issueIds = new Set(issueIds); progress.cursor = undefined; progress.complete = true; progress.updatedAt = Date.now();
      publish('ready');
    } catch (error) {
      if (!matchesCurrentSelection()) return;
      if (error instanceof GitLabBudgetExceededError || budget.signal.aborted) publish('partial', error instanceof GitLabBudgetExceededError ? error.message : '本批已達時間上限；已確認的 Issue 與續傳位置保留。');
      else {
        const message = readableError(error);
        publish(progress.issueIds.size || progress.cursor ? 'partial' : 'error', '已保留載入位置，可繼續重試。', message);
        this.noteOutcome({ status: 'failed', error: message });
      }
    } finally {
      budget.dispose();
      if (this.issueBoardAbort === controller) this.issueBoardAbort = undefined;
    }
  }

  private loadIssueGraph(connectedScope: string, forceNetwork = false, nodeIds?: string[], loadBoards = false): Promise<void> {
    if (this.issueGraphRead?.scope === connectedScope && !this.issueGraphAbort?.signal.aborted) {
      if (nodeIds?.length || loadBoards) {
        const cancellation = this.graphReadCancellation;
        return this.issueGraphRead.task.then(() => cancellation === this.graphReadCancellation ? this.loadIssueGraph(connectedScope, false, nodeIds, loadBoards) : undefined);
      }
      return this.issueGraphRead.task;
    }
    if (!forceNetwork && !nodeIds?.length && !loadBoards && !this.issueGraphStale && this.issueGraph?.connectedScope === connectedScope && this.issueGraph.status === 'ready' && this.issueGraph.roots.length >= Math.min(this.issues.length, this.issueGraphRootLimit ?? 100)) return Promise.resolve();
    const task = this.loadIssueGraphNow(connectedScope, forceNetwork, nodeIds, loadBoards);
    const read = { scope: connectedScope, task }; this.issueGraphRead = read;
    return task.finally(() => { if (this.issueGraphRead === read) this.issueGraphRead = undefined; });
  }

  private async loadIssueGraphNow(connectedScope: string, forceNetwork = false, requestedNodeIds: string[] = [], loadBoards = false): Promise<void> {
    const group = this.session.selectedGroup;
    const currentScope = this.connectedScopeKey();
    if (this.disposed || !group || !this.session.baseUrl || connectedScope !== currentScope || !this.currentUser) return;
    this.issueGraphVisible = true;
    const priorGraph = !forceNetwork && this.issueGraph?.connectedScope === connectedScope ? this.issueGraph : undefined;
    if (!priorGraph) { this.graphBoardMemberships = new Map(); this.graphBoardLoads = new Map(); this.graphRelationLoads = new Map(); if (forceNetwork) this.issueGraphRootLimit = 100; }
    this.graphBoardMemberships ??= new Map();
    this.graphBoardLoads ??= new Map();
    this.graphRelationLoads ??= new Map();
    const budget = new GitLabRequestBudget({ requests: 20, bytes: 16 * 1024 * 1024, timeoutMs: 30_000 });
    try {
    const requested = new Set(requestedNodeIds.filter(id => typeof id === 'string' && id.length < 2048 && priorGraph?.nodes.find(node => node.id === id)?.relationsStatus !== 'ready').slice(0, 20));
    this.issueGraphStale = false;
    this.issueGraphAbort?.abort();
    if (this.issueGraphPublishTimer) clearTimeout(this.issueGraphPublishTimer);
    this.issueGraphPublishTimer = undefined;
    const controller = new AbortController();
    this.issueGraphAbort = controller;
    this.issueGraphRequestedScope = connectedScope;
    const generation = ++this.issueGraphGeneration;
    const loadingGraph = priorGraph ? { ...priorGraph } : this.emptyIssueGraph(connectedScope);
    loadingGraph.status = 'loading';
    this.issueGraph = loadingGraph;
    this.issueGraphVersion++;
    this.snapshotGraphScope = undefined;
    this.sendSnapshot();
    this.snapshotGraphScope = connectedScope;
    this.post({ type: 'issueGraphChanged', connectedScope, version: this.issueGraphVersion, graph: loadingGraph });
    const isCurrent = (): boolean => !this.disposed && generation === this.issueGraphGeneration &&
      connectedScope === this.connectedScopeKey() && this.session.selectedGroup?.id === group.id && !controller.signal.aborted;
    if (loadBoards) {
      const existingBoardRead = this.workspaceSectionReads?.get('boards');
      const boardRead = this.ensureWorkspaceSection('boards', connectedScope);
      const boardController = this.workspaceSectionAborts.get('boards');
      const cancelBoardRead = (): void => {
        if (boardController && this.workspaceSectionAborts.get('boards') === boardController) boardController.abort();
      };
      const ownsBoardRead = boardController && existingBoardRead?.controller !== boardController;
      if (ownsBoardRead) controller.signal.addEventListener('abort', cancelBoardRead, { once: true });
      try { await boardRead; }
      finally { controller.signal.removeEventListener('abort', cancelBoardRead); }
      if (!isCurrent()) return;
    }
    let client: GitLabClient;
    try {
      client = await this.session.getClient();
      client = client.withReadSignal?.(controller.signal) ?? client;
      client = client.withRequestBudget?.(budget) ?? client;
    } catch (error) {
      if (!isCurrent()) return;
      const graph = this.emptyIssueGraph(connectedScope);
      graph.status = 'error';
      graph.errors = [readableError(error)];
      this.issueGraph = graph;
      this.issueGraphVersion++;
      this.post({ type: 'issueGraphChanged', connectedScope, version: this.issueGraphVersion, graph });
      return;
    }
    if (!isCurrent()) return;

    const projectById = new Map(this.projects.map((project) => [project.id, project]));
    // A page of assigned Issues can reference projects outside the first project
    // page. Keep those roots visible without downloading the whole Group first.
    for (const issue of this.issues) if (!projectById.has(issue.project_id)) {
      let namespace = `project-${issue.project_id}`;
      try {
        const target = new URL(issue.web_url), base = new URL(this.session.baseUrl!);
        if (target.origin === base.origin) namespace = target.pathname.split('/-/issues/')[0].slice(base.pathname.replace(/\/$/, '').length).replace(/^\/+/, '') || namespace;
      } catch { /* The project ID remains a stable root identity. */ }
      projectById.set(issue.project_id, { id: issue.project_id, name: namespace.split('/').at(-1)!, path: namespace.split('/').at(-1)!, path_with_namespace: namespace, web_url: '', http_url_to_repo: '' });
    }
    const boardIdsByGraphNodeId = new Map<string, Set<number>>();
    const graph = this.emptyIssueGraph(connectedScope);
    const nodeById = new Map<string, IssueGraphNode>((priorGraph?.nodes ?? []).map(node => [node.id, { ...node, labels: [...node.labels], boardIds: [...node.boardIds] }]));
    const edgeById = new Map<string, NonNullable<IssueGraphSnapshot['edges'][number]>>((priorGraph?.edges ?? []).map(edge => [edge.id, edge]));
    graph.boardIssueIds = { ...priorGraph?.boardIssueIds };
    for (const [boardId, memberships] of this.graphBoardMemberships) for (const membership of memberships) {
      if (membership.projectId === undefined || membership.iid === undefined) continue;
      const projectPath = projectById.get(membership.projectId)?.path_with_namespace ?? `project-${membership.projectId}`;
      const nodeId = issueGraphNodeKey(membership.projectId, projectPath, membership.iid);
      const ids = boardIdsByGraphNodeId.get(nodeId) ?? new Set<number>(); ids.add(boardId); boardIdsByGraphNodeId.set(nodeId, ids);
    }
    const errors = new Set<string>();
    let budgetReached = false;
    const reachedBudget = (error: unknown): boolean => {
      if (!(error instanceof GitLabBudgetExceededError) && !budget.signal.aborted) return false;
      budgetReached = true;
      errors.add(error instanceof GitLabBudgetExceededError ? error.message : '本批圖譜載入已達時間上限，已保留資料與可續傳位置。');
      return true;
    };
    const budgeted = (readClient: GitLabClient): GitLabClient => readClient.withRequestBudget?.(budget) ?? readClient;
    const publishedNodeSignatures = new Map<string, string>();
    const publishedEdgeSignatures = new Map<string, string>();
    const publishedRoots = new Set<string>();
    const publishedBoardIssues = new Map<number, string>();
    const publishedBoardStatuses = new Map<number, string>();
    const publishNow = (): void => {
      if (!isCurrent()) return;
      graph.roots = [...graph.roots];
      graph.nodes = [...nodeById.values()];
      graph.edges = [...edgeById.values()];
      graph.errors = [...errors];
      graph.updatedAt = Date.now();
      const upsertNodes: IssueGraphNode[] = [];
      for (const node of graph.nodes) {
        const signature = JSON.stringify(node);
        if (publishedNodeSignatures.get(node.id) !== signature) upsertNodes.push({ ...node, sourceIds: [...node.sourceIds], labels: [...node.labels], assignees: [...node.assignees], boardIds: [...node.boardIds] });
        publishedNodeSignatures.set(node.id, signature);
      }
      const removeNodeIds = [...publishedNodeSignatures.keys()].filter((id) => !nodeById.has(id));
      for (const id of removeNodeIds) publishedNodeSignatures.delete(id);
      const upsertEdges: NonNullable<IssueGraphSnapshot['edges']> = [];
      for (const edge of graph.edges) {
        const signature = JSON.stringify(edge);
        if (publishedEdgeSignatures.get(edge.id) !== signature) upsertEdges.push({ ...edge });
        publishedEdgeSignatures.set(edge.id, signature);
      }
      const removeEdgeIds = [...publishedEdgeSignatures.keys()].filter((id) => !edgeById.has(id));
      for (const id of removeEdgeIds) publishedEdgeSignatures.delete(id);
      const addRootIds = graph.roots.filter((id) => !publishedRoots.has(id));
      const currentRoots = new Set(graph.roots);
      const removeRootIds = [...publishedRoots].filter((id) => !currentRoots.has(id));
      for (const id of removeRootIds) publishedRoots.delete(id);
      for (const id of addRootIds) publishedRoots.add(id);
      const boardIssueIds: Record<number, number[]> = {};
      for (const [idText, ids] of Object.entries(graph.boardIssueIds)) {
        const id = Number(idText);
        const signature = JSON.stringify(ids);
        if (publishedBoardIssues.get(id) !== signature) boardIssueIds[id] = [...ids];
        publishedBoardIssues.set(id, signature);
      }
      const removeBoardIds = [...publishedBoardIssues.keys()].filter((id) => !Object.hasOwn(graph.boardIssueIds, id));
      for (const id of removeBoardIds) publishedBoardIssues.delete(id);
      const boardStatus: typeof graph.boardStatus = {};
      for (const [idText, status] of Object.entries(graph.boardStatus)) {
        const id = Number(idText);
        const signature = JSON.stringify(status);
        if (publishedBoardStatuses.get(id) !== signature) boardStatus[id] = { ...status };
        publishedBoardStatuses.set(id, signature);
      }
      const removeBoardStatusIds = [...publishedBoardStatuses.keys()].filter((id) => !Object.hasOwn(graph.boardStatus, id));
      for (const id of removeBoardStatusIds) publishedBoardStatuses.delete(id);
      this.issueGraph = graph;
      this.issueGraphVersion++;
      this.post({ type: 'issueGraphPatch', connectedScope, version: this.issueGraphVersion, upsertNodes, removeNodeIds,
        upsertEdges, removeEdgeIds, addRootIds, removeRootIds, boardIssueIds, removeBoardIds,
        boardStatus, removeBoardStatusIds, status: graph.status, errors: [...graph.errors], updatedAt: graph.updatedAt });
    };
    const publish = (status = graph.status, immediate = false): void => {
      if (!isCurrent()) return;
      graph.status = status;
      if (immediate) {
        if (this.issueGraphPublishTimer) clearTimeout(this.issueGraphPublishTimer);
        this.issueGraphPublishTimer = undefined;
        publishNow();
      } else if (!this.issueGraphPublishTimer) {
        this.issueGraphPublishTimer = setTimeout(() => {
          this.issueGraphPublishTimer = undefined;
          publishNow();
        }, 100);
      }
    };
    const addNode = (incoming: IssueGraphNode): IssueGraphNode => {
      const previous = nodeById.get(incoming.id);
      const labels = new Map((previous?.labels ?? []).map((label) => [label.name, label]));
      for (const label of incoming.labels) {
        const old = labels.get(label.name);
        labels.set(label.name, old ? { ...old, ...label, color: label.color ?? old.color, textColor: label.textColor ?? old.textColor } : label);
      }
      const merged: IssueGraphNode = {
        ...previous,
        ...incoming,
        kind: incoming.kind,
        sourceIds: [...new Set([...(previous?.sourceIds ?? []), ...incoming.sourceIds])],
        isRoot: !!previous?.isRoot || incoming.isRoot,
        assignedToMe: !!previous?.assignedToMe || incoming.assignedToMe,
        labels: [...labels.values()],
        assignees: incoming.assignees.length ? incoming.assignees : previous?.assignees ?? [],
        boardIds: [...new Set([...(previous?.boardIds ?? []), ...incoming.boardIds, ...(boardIdsByGraphNodeId.get(incoming.id) ?? [])])],
        relationsStatus: incoming.relationsStatus === 'idle' && previous?.relationsStatus === 'ready' ? 'ready' : incoming.relationsStatus ?? previous?.relationsStatus
      };
      nodeById.set(merged.id, merged);
      return merged;
    };
    const addEdge = (source: string, target: string, type: 'parent' | 'relates_to' | 'blocks'): void => {
      const edge = issueGraphEdge(source, target, type);
      if (edge) edgeById.set(edge.id, edge);
    };
    const projectPathFor = (projectId: number | undefined, workItem: GitLabGraphWorkItem): string =>
      workItem.project?.fullPath ?? workItem.namespace?.fullPath ??
      (projectId !== undefined ? projectById.get(projectId)?.path_with_namespace : undefined) ?? group.full_path;
    const materializeWorkItem = (
      item: GitLabGraphWorkItem,
      relation: 'parent' | 'child' | 'linked'
    ): IssueGraphNode => {
      const projectId = gitLabGlobalIdNumber(item.project?.id);
      const namespacePath = projectPathFor(projectId, item);
      const typeName = item.workItemType?.name?.toLocaleLowerCase();
      const kind = !projectId || typeName?.includes('epic') ? 'epic' :
        typeName?.includes('task') || (relation === 'child' && !typeName?.includes('issue')) ? 'task' : 'issue';
      const assignees = item.widgets?.flatMap((widget) => widget.assignees?.nodes ?? []) ?? [];
      return {
        id: issueGraphNodeKey(projectId, namespacePath, item.iid),
        sourceIds: [`GraphQL:WorkItem:${item.id}`],
        kind,
        namespacePath,
        iid: String(item.iid),
        title: item.title ?? item.name ?? `Work Item #${item.iid}`,
        state: item.state?.toLocaleLowerCase().includes('closed') ? 'closed' : item.state?.toLocaleLowerCase() ?? 'unknown',
        projectId,
        projectPath: projectId !== undefined ? namespacePath : undefined,
        webUrl: item.webUrl ?? undefined,
        labels: item.widgets?.flatMap((widget) => widget.labels?.nodes ?? []) ?? [],
        assignees,
        boardIds: [],
        assignedToMe: assignees.some((assignee) => gitLabGlobalIdNumber(assignee.id) === this.currentUser?.id),
        isRoot: false,
        relationsStatus: 'idle'
      };
    };

    for (const issue of this.issues.slice(0, this.issueGraphRootLimit ?? 100)) {
      const project = projectById.get(issue.project_id);
      if (!project || !Number.isSafeInteger(issue.iid) || issue.iid <= 0) continue;
      const node = addNode({
        id: issueGraphNodeKey(issue.project_id, project.path_with_namespace, issue.iid),
        sourceIds: [`REST:Issue:${issue.id}`],
        kind: 'issue',
        namespacePath: project.path_with_namespace,
        iid: String(issue.iid),
        title: issue.title,
        state: issue.state,
        projectId: issue.project_id,
        projectPath: project.path_with_namespace,
        webUrl: issue.web_url,
        labels: (issue.labels ?? []).map((name) => ({ name })),
        assignees: issue.assignees ?? (issue.assignee ? [issue.assignee] : []),
        boardIds: [],
        assignedToMe: true,
        isRoot: true,
        relationsStatus: requested.has(issueGraphNodeKey(issue.project_id, project.path_with_namespace, issue.iid)) ? 'loading' : nodeById.get(issueGraphNodeKey(issue.project_id, project.path_with_namespace, issue.iid))?.relationsStatus ?? 'idle'
      });
      if (!graph.roots.includes(node.id)) graph.roots.push(node.id);
    }

    const boardsToLoad = loadBoards ? this.groupIssueBoards.filter(board => !this.graphBoardLoads.get(board.id)?.complete)
      .sort((first, second) => Number(!this.graphBoardLoads.get(first.id)?.cursor) - Number(!this.graphBoardLoads.get(second.id)?.cursor)
        || Number(priorGraph?.boardStatus[first.id]?.status === 'error') - Number(priorGraph?.boardStatus[second.id]?.status === 'error')) : [];
    graph.boardStatus = Object.fromEntries(this.groupIssueBoards.map(board => [board.id, priorGraph?.boardStatus[board.id] ?? { status: boardsToLoad.some(item => item.id === board.id) ? 'loading' : 'idle' }]));
    if (!graph.roots.length) {
      publish('ready', true);
      return;
    }
    publish('loading');

    const jobs: Array<() => Promise<void>> = [];
    if (boardsToLoad.length) jobs.push(async () => {
      let pages = 0;
      for (const board of boardsToLoad) {
        if (!isCurrent() || budgetReached || pages >= 20) break;
        do {
          try {
            const progress = this.graphBoardLoads.get(board.id);
            // Board checkpoints belong to this graph snapshot. Keep the completed
            // prefix here rather than caching cursors as separate read entries.
            const page = client.listGroupBoardIssueMembershipsPage
              ? await client.listGroupBoardIssueMembershipsPage(group.full_path, board.id, progress?.cursor)
              : { items: await client.listGroupBoardIssueMemberships(group.full_path, board.id), complete: true, updatedAt: new Date().toISOString() };
            if (!isCurrent()) return;
            if (!page.complete && !page.nextCursor) throw new Error('GitLab Board 回傳不完整的續傳位置。');
            pages++;
            const merged = new Map((this.graphBoardMemberships.get(board.id) ?? []).map(item => [item.issueId, item]));
            for (const item of page.items) merged.set(item.issueId, item);
            const memberships = [...merged.values()];
            this.graphBoardMemberships.set(board.id, memberships);
            this.graphBoardLoads.set(board.id, { cursor: page.nextCursor, complete: page.complete });
            graph.boardIssueIds[board.id] = memberships.map((item) => item.issueId);
            graph.boardStatus[board.id] = { status: page.complete ? 'ready' : 'partial' };
            for (const membership of page.items) {
            if (membership.projectId === undefined || membership.iid === undefined) continue;
            const projectPath = projectById.get(membership.projectId)?.path_with_namespace ?? `project-${membership.projectId}`;
            const nodeId = issueGraphNodeKey(membership.projectId, projectPath, membership.iid);
            const boardIds = boardIdsByGraphNodeId.get(nodeId) ?? new Set<number>();
            boardIds.add(board.id);
            boardIdsByGraphNodeId.set(nodeId, boardIds);
            const node = nodeById.get(nodeId);
            if (node && !node.boardIds.includes(board.id)) node.boardIds.push(board.id);
            }
            publish('loading');
            if (page.complete) break;
          } catch (error) {
            if (!isCurrent()) return;
            if (reachedBudget(error)) break;
            const message = readableError(error);
            graph.boardStatus[board.id] = { status: 'error', error: message };
            errors.add(`${board.name}: ${message}`);
            break;
          }
        } while (isCurrent() && !budgetReached && pages < 20);
      }
      if (pages >= 20 && boardsToLoad.some(board => !this.graphBoardLoads.get(board.id)?.complete)) {
        budgetReached = true;
        errors.add('本批已保留 20 頁 Board 資料；可繼續載入看板色彩。');
      }
    });

    const userId = this.currentUser.id;
    const capabilities = this.session.issueCapabilities;
    const relationIssues = this.issues.filter(issue => requested.has(issueGraphNodeKey(issue.project_id, projectById.get(issue.project_id)?.path_with_namespace ?? '', issue.iid)));
    for (const node of priorGraph?.nodes ?? []) {
      if (!requested.has(node.id) || node.projectId === undefined || node.kind !== 'issue' || relationIssues.some(issue => issue.project_id === node.projectId && String(issue.iid) === node.iid)) continue;
      relationIssues.push({ id: 0, project_id: node.projectId, iid: Number(node.iid), title: node.title, state: node.state, labels: node.labels.map(label => label.name), web_url: node.webUrl ?? '' } as GitLabIssue);
      if (!projectById.has(node.projectId)) projectById.set(node.projectId, { id: node.projectId, name: node.namespacePath, path: node.namespacePath.split('/').at(-1)!, path_with_namespace: node.namespacePath, web_url: '', http_url_to_repo: '' });
    }
    const fallbackLabels = new Set(relationIssues.map((issue) => issue.project_id));
    for (const projectId of fallbackLabels) {
      const project = projectById.get(projectId);
      if (!project) continue;
      jobs.push(async () => {
        try {
          if (budgetReached || !isCurrent()) return;
          const labels = await this.session.cachedRead(`project/${projectId}/labels`, (readClient) => budgeted(readClient).listProjectLabels(projectId), { signal: controller.signal, force: forceNetwork });
          if (!isCurrent()) return;
          const byName = new Map(labels.map((label) => [label.name, label]));
          for (const issue of this.issues.filter((item) => item.project_id === projectId)) {
            const key = issueGraphNodeKey(issue.project_id, project.path_with_namespace, issue.iid);
            const node = nodeById.get(key);
            if (!node) continue;
            node.labels = node.labels.map((label) => {
              const detail = byName.get(label.name);
              return detail ? { name: detail.name, color: detail.color, textColor: detail.text_color } : label;
            });
          }
        } catch (error) {
          if (isCurrent() && !reachedBudget(error)) errors.add(`無法載入 ${project.path_with_namespace} 的 Label 色彩：${readableError(error)}`);
        }
        publish('loading');
      });
    }

    for (const issue of relationIssues) {
      let project = projectById.get(issue.project_id);
      if (!project) continue;
      jobs.push(async () => {
        if (!isCurrent() || budgetReached) return;
        if (!project!.http_url_to_repo) {
          try { project = await this.session.cachedRead(`project/${issue.project_id}/details`, readClient => budgeted(readClient).getProject(issue.project_id), { signal: controller.signal }); projectById.set(issue.project_id, project); }
          catch (error) { if (!reachedBudget(error)) errors.add(`Project #${issue.project_id} 無法載入：${readableError(error)}`); return; }
        }
        const relationProject = project!;
        const rootId = issueGraphNodeKey(issue.project_id, relationProject.path_with_namespace, issue.iid);
        let progress = this.graphRelationLoads.get(rootId);
        if (!progress) {
          progress = { workItemsComplete: !capabilities?.graphWorkItems, linksComplete: !!capabilities?.graphLinkedItems };
          this.graphRelationLoads.set(rootId, progress);
        } else if (progress.workItemsFailed) {
          progress.workItemsComplete = false; progress.workItemsFailed = false;
        }
        const root = addNode({
          id: rootId, sourceIds: [`REST:Issue:${issue.id}`], kind: 'issue', namespacePath: relationProject.path_with_namespace,
          iid: String(issue.iid), title: issue.title, state: issue.state, projectId: issue.project_id,
          projectPath: relationProject.path_with_namespace, webUrl: issue.web_url, labels: [], assignees: [], boardIds: [],
          assignedToMe: true, isRoot: graph.roots.includes(rootId), relationsStatus: 'loading'
        });
        let pages = 0;
        try {
          while (!progress.workItemsComplete && isCurrent() && !budgetReached && pages < 20) {
            const page = client.loadIssueGraphRelationsPage
              ? await client.loadIssueGraphRelationsPage(relationProject.path_with_namespace, issue.iid, capabilities!, progress.workItemsCursor)
              : { ...await client.loadIssueGraphRelations(relationProject.path_with_namespace, issue.iid, capabilities!), complete: true, nextCursor: undefined };
            if (!isCurrent()) return;
            if (!page.complete && !page.nextCursor) throw new Error('GitLab WorkItem 回傳不完整的續傳位置。');
            pages++;
            // Commit a checkpoint only after its entire page has been received.
            // The graph itself retains the deduplicated nodes and edges.
            progress.workItemsCursor = page.nextCursor; progress.workItemsComplete = page.complete;
            if (page.root?.id && !root.sourceIds.includes(`GraphQL:WorkItem:${page.root.id}`)) root.sourceIds.push(`GraphQL:WorkItem:${page.root.id}`);
            for (const parent of page.parents) { const node = addNode(materializeWorkItem(parent, 'parent')); addEdge(node.id, root.id, 'parent'); }
            for (const child of page.children) { const node = addNode(materializeWorkItem(child, 'child')); addEdge(root.id, node.id, 'parent'); }
            for (const relation of page.links) {
              const node = addNode(materializeWorkItem(relation.item, 'linked'));
              const type = relation.type.toLocaleLowerCase().replaceAll('-', '_');
              if (type === 'blocks') addEdge(root.id, node.id, 'blocks');
              else if (type === 'blocked_by' || type === 'is_blocked_by') addEdge(node.id, root.id, 'blocks');
              else addEdge(root.id, node.id, 'relates_to');
            }
            root.relationsStatus = page.complete && progress.linksComplete ? 'ready' : 'partial';
            publish('loading');
          }
        } catch (error) {
          if (!isCurrent()) return;
          root.relationsStatus = 'partial';
          if (reachedBudget(error)) return;
          progress.workItemsFailed = true; progress.workItemsComplete = true; progress.linksComplete = false;
          errors.add(`Issue #${issue.iid} 的 WorkItem 關聯無法載入：${readableError(error)}`);
        }
        try {
          while (progress.workItemsComplete && !progress.linksComplete && isCurrent() && !budgetReached && pages < 20) {
            const page = client.listIssueLinksPage ? await client.listIssueLinksPage(issue.project_id, issue.iid, progress.linksCursor)
              : { items: await client.listIssueLinks(issue.project_id, issue.iid), complete: true, nextCursor: undefined };
            if (!isCurrent()) return;
            if (!page.complete && !page.nextCursor) throw new Error('GitLab Linked Items 回傳不完整的續傳位置。');
            pages++; progress.linksCursor = page.nextCursor; progress.linksComplete = page.complete;
            for (const relatedIssue of page.items) {
              const relatedProject = projectById.get(relatedIssue.project_id);
              const namespacePath = relatedProject?.path_with_namespace ?? `project-${relatedIssue.project_id}`;
              const node = addNode({
                id: issueGraphNodeKey(relatedIssue.project_id, namespacePath, relatedIssue.iid), sourceIds: [`REST:Issue:${relatedIssue.id}`],
                kind: 'issue', namespacePath, iid: String(relatedIssue.iid), title: relatedIssue.title, state: relatedIssue.state,
                projectId: relatedIssue.project_id, projectPath: relatedProject?.path_with_namespace, webUrl: relatedIssue.web_url,
                labels: (relatedIssue.labels ?? []).map((name) => ({ name })), assignees: relatedIssue.assignees ?? (relatedIssue.assignee ? [relatedIssue.assignee] : []),
                boardIds: [], assignedToMe: !!relatedIssue.assignees?.some((assignee) => assignee.id === userId) || relatedIssue.assignee?.id === userId,
                isRoot: false, relationsStatus: 'idle'
              });
              const type = relatedIssue.link_type?.toLocaleLowerCase();
              if (type === 'blocks') addEdge(root.id, node.id, 'blocks');
              else if (type === 'is_blocked_by') addEdge(node.id, root.id, 'blocks');
              else addEdge(root.id, node.id, 'relates_to');
            }
            publish('loading');
          }
        } catch (error) {
          if (!isCurrent()) return;
          root.relationsStatus = 'partial';
          if (reachedBudget(error)) return;
          errors.add(`Issue #${issue.iid} 的 Linked Items 無法載入：${readableError(error)}`);
          root.relationsStatus = 'error';
        }
        if (root.relationsStatus !== 'error') root.relationsStatus = progress.workItemsFailed ? 'error' : progress.workItemsComplete && progress.linksComplete ? 'ready' : 'partial';
        if (pages >= 20 && root.relationsStatus === 'partial') {
          budgetReached = true; errors.add('本批已保留 20 頁關聯；可繼續展開尚未完整的 Issue。');
        }
        publish('loading');
      });
    }

    await mapWithConcurrency(jobs, 4, async (job) => job());
    if (!isCurrent()) return;
    const relationLabelProjectIds = requested.size ? [...new Set([...nodeById.values()].filter(node => !node.isRoot && node.labels.some(label => !label.color))
      .map((node) => node.projectId)
      .filter((projectId): projectId is number => projectId !== undefined && !fallbackLabels.has(projectId)))].slice(0, 20) : [];
    await mapWithConcurrency(relationLabelProjectIds, 4, async (projectId) => {
      try {
        if (budgetReached || !isCurrent()) return;
        const labels = await this.session.cachedRead(`project/${projectId}/labels`, (readClient) => budgeted(readClient).listProjectLabels(projectId), { signal: controller.signal, force: forceNetwork });
        if (!isCurrent()) return;
        const byName = new Map(labels.map((label) => [label.name, label]));
        for (const node of nodeById.values()) {
          if (node.projectId !== projectId) continue;
          node.labels = node.labels.map((label) => {
            const detail = byName.get(label.name);
            return detail ? { name: detail.name, color: detail.color, textColor: detail.text_color } : label;
          });
        }
      } catch (error) {
        if (isCurrent() && !reachedBudget(error)) errors.add(`無法載入專案 #${projectId} 的 Label 色彩：${readableError(error)}`);
      }
      publish('loading');
    });
    if (!isCurrent()) return;
    for (const node of nodeById.values()) {
      node.boardIds = [...new Set([...node.boardIds, ...(boardIdsByGraphNodeId.get(node.id) ?? [])])];
      if (node.relationsStatus === 'loading') node.relationsStatus = this.graphRelationLoads.has(node.id) ? 'partial' : 'idle';
    }
    for (const board of this.groupIssueBoards) if (graph.boardStatus[board.id]?.status === 'loading') graph.boardStatus[board.id] = { status: this.graphBoardLoads.has(board.id) ? 'partial' : 'idle' };
    publish(errors.size ? 'partial' : 'ready', true);
    } finally { budget.dispose(); }
  }

  private hideIssueGraph(): void {
    if (!this.issueGraphVisible && !this.issueGraphAbort && !this.issueGraphPublishTimer) return;
    this.issueGraphVisible = false;
    this.graphReadCancellation = (this.graphReadCancellation ?? 0) + 1;
    this.issueGraphStale = true;
    this.issueGraphGeneration++;
    this.issueGraphAbort?.abort();
    this.issueGraphAbort = undefined;
    this.issueGraphRead = undefined;
    if (this.issueGraphPublishTimer) clearTimeout(this.issueGraphPublishTimer);
    this.issueGraphPublishTimer = undefined;
  }

  private emptyIssueGraph(connectedScope: string): IssueGraphSnapshot {
    return {
      connectedScope,
      status: 'loading',
      roots: [],
      nodes: [],
      edges: [],
      boardIssueIds: {},
      boardStatus: {},
      errors: [],
      updatedAt: Date.now()
    };
  }

  private sendSnapshot(): void {
    if (!this.panel || this.panel.visible === false || !this.webviewReady || this.disposed) return;
    const group = this.session.selectedGroup;
    const root = this.projectContext?.root;
    const currentGraph = this.issueGraph?.connectedScope === this.connectedScopeKey() ? this.issueGraph : undefined;
    const includeGraphSnapshot = !!currentGraph && this.snapshotGraphScope !== currentGraph.connectedScope;
    if (includeGraphSnapshot) this.snapshotGraphScope = currentGraph.connectedScope;
    const localRepositoryKey = this.repositoryStateKey(this.connectedScopeKey() ?? '', root, this.projects);
    const localRepositories = localRepositoryKey === this.localRepositoriesKey ? this.localRepositoryStates : {};
    const cloneRoot = this.projectContext?.root;
    const projectRepositoryKey = this.repositoryStateKey(this.connectedScopeKey() ?? '', cloneRoot, this.projects);
    const snapshot: WorkspaceSnapshot = {
      notifications: this.notifications.snapshot(),
      operationScope: this.operationScope(),
      localOperationScope: this.getLocalOperationScope(),
      operations: [...this.operations.list(this.operationScope()), ...this.operations.list(this.getLocalOperationScope())],
      operationSnapshot: this.operations.snapshot(),
      projectOperationBusy: !!(this.writesInFlight || this.repositoryOperationInProgress || this.gitRepositories?.hasActiveOperations || this.session.hasActiveWrites ||
        this.accountTransitionBusy || this.cloneRootSelecting || this.workflowKitSelectingRoot || this.workflowKitInstallation || this.workflowKitCheckingRelease),
      projectContext: this.projectContext,
      bmad: this.bmad?.snapshot?.root === root ? this.bmad?.snapshot : undefined,
      bmadEnvironment: this.bmadEnvironment?.root === root ? this.bmadEnvironment : undefined,
      connected: !!this.session.baseUrl,
      accounts: this.session.accounts,
      activeAccountId: this.session.activeAccountId,
      accountOperation: this.accountOperation,
      issuePreview: this.issuePreview,
      repositoryScan: this.repositoryScan,
      localWorkspaceRepositories: this.associatedRepositories(),
      baseUrl: this.session.baseUrl,
      instance: this.session.baseUrl ? {
        version: this.session.metadata?.version,
        enterprise: this.session.metadata?.enterprise,
        warnings: [...this.session.instanceWarnings],
        capabilities: [...this.session.capabilityDiagnostics]
      } : undefined,
      currentUser: this.currentUser,
      group,
      groups: this.groups,
      groupRoot: root,
      cloneRoot,
      cloneRootError: this.projectContext?.error,
      cloneRootManual: this.projectContext?.manual,
      projectLocalRepositories: projectRepositoryKey && projectRepositoryKey === this.projectRepositoriesKey ? this.projectLocalRepositoryStates : {},
      skillsContext: this.getSkillsContext(),
      workspaceRootError: this.workspaceRootError,
      groupRepositories: this.actualRepositoryScanStatus === 'ready' && this.actualRepositoriesRoot && root && sameLocalPath(this.actualRepositoriesRoot, root)
        ? this.actualRepositories : [],
      groupRepositoryScanStatus: root && this.actualRepositoriesRoot && sameLocalPath(this.actualRepositoriesRoot, root)
        ? this.actualRepositoryScanStatus : 'idle',
      groupRepositoryScanError: root && this.actualRepositoriesRoot && sameLocalPath(this.actualRepositoriesRoot, root) && this.actualRepositoryScanStatus === 'error'
        ? this.actualRepositoryScanError : undefined,
      projects: this.projects,
      sections: {
        ...this.workspaceSections,
        repositories: { status: this.actualRepositoryScanStatus === 'scanning' ? 'loading' : this.actualRepositoryScanStatus },
        graph: this.issueGraphStale ? { status: 'idle' }
          : this.issueGraph?.connectedScope === this.connectedScopeKey()
          ? { status: this.issueGraph?.status === 'loading' ? 'loading' : this.issueGraph?.status === 'ready' || this.issueGraph?.status === 'partial' ? 'ready' : 'error',
            ...(this.issueGraph?.errors?.length ? { error: this.issueGraph?.errors?.join('\n') } : {}) }
          : { status: 'idle' }
      },
      groupMilestones: this.groupMilestones,
      groupMilestonesError: this.groupMilestonesError,
      groupIssueBoards: this.groupIssueBoards,
      groupIssueBoardsError: this.groupIssueBoardsError,
      issueBoardContent: this.issueBoardContent?.connectedScope === this.connectedScopeKey() ? this.issueBoardContent : undefined,
      issueGraph: currentGraph,
      issueGraphVersion: this.issueGraphVersion,
      localRepositories,
      issues: this.issues,
      mergeRequests: this.mergeRequests,
      mergeRequestFilter: this.mergeRequestFilter ?? 'all',
      activeMode: this.activeMode,
      instanceUserScope: this.session.baseUrl && this.currentUser
        ? createHash('sha256').update(`${this.session.baseUrl}\0${this.currentUser.id}`).digest('hex').slice(0, 24)
        : undefined,
      connectedScope: this.connectedScopeKey(),
      selectedProjectId: this.selectedProjectId,
      selectedIssue: this.selectedIssue,
      selectedMergeRequest: this.selectedMergeRequest,
      timers: this.timer.list(),
      timerVersion: this.timerVersion,
      scopeEpoch: this.session.connectionEpoch,
      projectMembers: this.projectMembers,
      workflowKit: root && this.workflowKitStateRoot === root ? this.workflowKitState : { status: 'missing' },
      workflowKitInstallTarget: this.workflowKitInstallTarget,
      workflowKitPolicy: this.getWorkflowKitPolicy(),
      workflowKitOperationBusy: this.workflowKitSelectingRoot || this.workflowKitCheckingRelease || !!this.workflowKitInstallation,
      workflowKitSource: this.workflowKitSource(),
      workflowKitReleases: this.workflowKitReleases.map(({ id, version, source, assetName, format, entryRoot, available, error, skillCount, cached }) =>
        ({ id, version, source, assetName, format, entryRoot, available, error, skillCount, cached })),
      cloneOperation: this.cloneOperation,
      busy: this.busy || this.repositoryOperationInProgress || this.accountTransitionBusy || this.cloneRootSelecting || this.workflowKitSelectingRoot,
      instanceChecking: this.instanceCheckBusy
    };
    collectWorkspaceFeedback(this.notifications, { type: 'snapshot', snapshot }, this.getNotificationOrigin(), this.operationContext.getStore(), id => this.operations.get(id)?.requestId);
    const message = (this.snapshotTransport ??= new SnapshotTransport()).next(snapshot, this.operationScope());
    if (message) this.post(message);
  }

  private associatedRepositories(): ScannedRepository[] {
    const cached = this.associatedRepositoryCache;
    if (cached?.repositories === this.localWorkspaceRepositories && cached.projects === this.projects) return cached.value;
    const projectIdsByRemote = new Map<string, Set<number>>();
    for (const project of this.projects) for (const url of [project.http_url_to_repo, project.ssh_url_to_repo]) {
      const key = url && projectRemoteIdentity(url);
      if (!key) continue;
      const ids = projectIdsByRemote.get(key) ?? new Set<number>(); ids.add(project.id); projectIdsByRemote.set(key, ids);
    }
    const value = this.localWorkspaceRepositories.map(repository => ({ ...repository,
      projectIds: [...new Set(repository.remotes.flatMap(remote => {
        const key = projectRemoteIdentity(remote); return key ? [...(projectIdsByRemote.get(key) ?? [])] : [];
      }))] }));
    this.associatedRepositoryCache = { repositories: this.localWorkspaceRepositories, projects: this.projects, value };
    return value;
  }

  private connectedScopeKey(): ConnectedScope | undefined {
    const baseUrl = this.session.baseUrl;
    const userId = this.currentUser?.id;
    const groupId = this.session.selectedGroup?.id;
    if (!baseUrl || !userId || !groupId) return undefined;
    return createHash('sha256').update(`${baseUrl}\0${userId}\0${groupId}`).digest('hex').slice(0, 24) as ConnectedScope;
  }

  private async connect(accountId?: string): Promise<void> {
    await this.openAccountManager(accountId, true);
  }

  private async submitAccountLogin(request: Extract<WorkspaceRequest, { type: 'submitAccountLogin' }>): Promise<void> {
    if (typeof request.requestId !== 'string' || !/^[a-zA-Z0-9-]{1,128}$/.test(request.requestId)) return;
    const receipt = this.accountLoginReceipts.get(request.requestId);
    if (receipt) { this.post(receipt); return; }
    if (this.accountLoginRequestId === request.requestId) return;
    let ownsTransition = false;
    const reply = (result: Omit<Extract<WorkspaceResponse, { type: 'accountLoginResult' }>, 'type' | 'requestId'>) => {
      const message = { type: 'accountLoginResult' as const, requestId: request.requestId, ...result };
      this.accountLoginReceipts.set(request.requestId, message);
      while (this.accountLoginReceipts.size > 32) this.accountLoginReceipts.delete(this.accountLoginReceipts.keys().next().value!);
      if (!this.disposed) this.post(message);
    };
    const token = typeof request.token === 'string' ? request.token.trim() : '';
    if (token) this.session.log?.addSecret(token);
    try {
      if (this.accountTransitionBusy) throw new Error('帳號正在驗證或切換，請稍後再試。');
      this.assertAccountTransitionAllowed();
      if (!token || token.length > 8192 || /[\r\n\0]/.test(token)) throw new Error('請輸入有效的 Personal Access Token。');
      let baseUrl: string;
      try {
        if (typeof request.baseUrl !== 'string' || request.baseUrl.length > 2048) throw new Error();
        baseUrl = normalizeGitLabBaseUrl(request.baseUrl);
      } catch { throw new Error('GitLab 網址無效，請輸入完整 HTTP 或 HTTPS 網址，不可包含帳密、查詢參數或片段。'); }
      if (request.accountId !== undefined) {
        const saved = this.session.accounts.find(account => account.id === request.accountId);
        if (!saved) throw new Error('找不到此 GitLab 帳號。');
        if (saved.baseUrl !== baseUrl) throw new Error('重新登入須使用此帳號原有的 GitLab 站台；其他站台請使用新增帳號。');
      }
      ownsTransition = true;
      this.accountLoginRequestId = request.requestId;
      this.accountTransitionBusy = true; this.accountOperation = 'login';
      this.sendSnapshot(); await this.syncSidebarState?.();
      await this.runLogged('connectAccount', async () => {
        const user = await this.session.connect(baseUrl, token, request.accountId);
        await this.connectedUserChanged(user);
        reply({ name: user.name || user.username });
      });
    } catch (error) {
      const status = error && typeof error === 'object' && 'status' in error ? error.status : undefined;
      const message = status === 401 ? 'Token 無效或已過期，請重新產生具有 api 權限的 Token。'
        : status === 403 ? 'GitLab 拒絕存取，請確認帳號權限與 Token 的 api 範圍。'
        : error instanceof TypeError || error instanceof Error && /fetch failed|network|timeout|timed out|ECONN|ENOTFOUND|certificate/i.test(error.message)
          ? '無法連線 GitLab，請檢查網址、網路或憑證後重試。'
          : readableError(error);
      const safeMessage = token ? message.split(token).join('[redacted]') : message;
      if (request.operationId) this.operations.noteError(request.operationId, safeMessage);
      reply({ error: safeMessage });
    } finally {
      if (ownsTransition) {
        this.accountLoginRequestId = undefined;
        this.accountTransitionBusy = false; this.accountOperation = undefined;
        this.sendSnapshot(); await this.syncSidebarState?.();
      }
    }
  }

  private async switchAccount(accountId?: string): Promise<void> {
    this.assertAccountTransitionAllowed();
    if (this.accountTransitionBusy) throw new Error('帳號正在切換，請稍後再試。');
    if (!accountId) return this.openAccountManager();
    const selected = accountId;
    const account = this.session.accounts.find(item => item.id === selected);
    if (!account) throw new Error('找不到此 GitLab 帳號。');
    if (account.needsLogin) return this.connect(account.id);
    this.accountTransitionBusy = true; this.accountOperation = 'switch'; this.sendSnapshot(); await this.syncSidebarState?.();
    try { await this.connectedUserChanged(await this.session.switchAccount(selected)); }
    finally { this.accountTransitionBusy = false; this.accountOperation = undefined; this.sendSnapshot(); await this.syncSidebarState?.(); }
  }

  private async connectedUserChanged(user: GitLabUser): Promise<void> {
    this.projectEnvironmentSnapshots?.clear();
    this.noteOutcome({ effect: 'applied' });
    this.refreshAbort?.abort();
    this.requestGeneration++;
    this.previewAbort?.abort(); this.previewGeneration++; this.issuePreview = undefined;
    this.issueGraphAbort?.abort();
    this.issueBoardAbort?.abort();
    this.mergeRequestAbort?.abort();
    this.cancelMergeRequestSectionReads();
    this.issueOpenAbort?.abort();
    this.currentUser = user;
    if (this.session.baseUrl) await this.timer.setScope(this.session.baseUrl, user.id);
    this.syncTimerPolling();
    this.resetWorkspaceSections();
    this.loadedScopeKey = undefined;
    this.groupMilestones = []; this.groupMilestonesError = undefined;
    this.groupIssueBoards = []; this.groupIssueBoardsError = undefined;
    this.projectMembers = []; this.selectedIssueBoardId = undefined; this.issueBoardContent = undefined; this.issueBoardLoad = undefined;
    this.issueGraph = undefined; this.snapshotGraphScope = undefined; this.issueGraphRequestedScope = undefined;
    this.issueGraphVisible = false; this.issueGraphStale = false;
    this.issueOpenGeneration++;
    this.issuePanels.close();
    this.groups = []; this.projects = []; this.issues = []; this.mergeRequests = [];
    this.selectedIssue = undefined; this.selectedMergeRequest = undefined;
    this.sendSnapshot();
    const epoch = this.session.connectionEpoch;
    if (this.isRemotePage()) void this.refresh({ forceNetwork: true }).catch(error => {
      if (this.disposed || epoch !== this.session.connectionEpoch) return;
      const refreshError = `帳號已登入，工作區資料載入失敗：${readableError(error)}`;
      this.noteOutcome({ status: 'succeeded', effect: 'applied', refreshError });
      this.sendSnapshot(); this.post({ type: 'message', message: refreshError });
    });
    void Promise.resolve(this.syncSidebarState?.()).catch(() => undefined);
    this.post({ type: 'message', message: `已連線：${user.name}` });
  }

  private async disconnect(accountId?: string): Promise<void> {
    this.assertAccountTransitionAllowed();
    if (this.accountTransitionBusy) throw new Error('帳號正在切換，請稍後再試。');
    const account = this.session.accounts.find(item => item.id === (accountId ?? this.session.activeAccountId));
    if (!account) return;
    const confirm = await vscode.window.showWarningMessage(`登出 ${account.name || account.username}（${account.baseUrl}）？將清除 Token 並保留帳號名單、草稿及工時。`, { modal: true }, '登出');
    if (confirm !== '登出') { this.noteOutcome({ status: 'cancelled', effect: 'none' }); return; }
    this.assertAccountTransitionAllowed();
    if (this.accountTransitionBusy) throw new Error('帳號正在切換，請稍後再試。');
    const active = this.session.activeAccountId === account.id;
    this.accountTransitionBusy = true; this.accountOperation = 'logout'; this.sendSnapshot(); await this.syncSidebarState?.();
    try { await this.session.logoutAccount(account.id); if (active) await this.disconnectedView(); }
    finally { this.accountTransitionBusy = false; this.accountOperation = undefined; this.sendSnapshot(); await this.syncSidebarState?.(); }
  }

  private async removeAccount(accountId?: string): Promise<void> {
    if (!accountId) return this.openAccountManager();
    const id = accountId;
    const account = this.session.accounts.find(item => item.id === id);
    if (!account) return;
    this.assertAccountTransitionAllowed();
    if (this.accountTransitionBusy) throw new Error('帳號正在切換，請稍後再試。');
    const choice = await vscode.window.showWarningMessage(`移除 ${account.name || account.username}（${account.baseUrl}）？草稿與工時仍保留。`, { modal: true }, '移除帳號');
    if (choice !== '移除帳號') { this.noteOutcome({ status: 'cancelled', effect: 'none' }); return; }
    this.assertAccountTransitionAllowed();
    if (this.accountTransitionBusy) throw new Error('帳號正在切換，請稍後再試。');
    const active = this.session.activeAccountId === account.id;
    this.accountTransitionBusy = true; this.accountOperation = 'remove'; this.sendSnapshot(); await this.syncSidebarState?.();
    try { await this.session.removeAccount(account.id); if (active) await this.disconnectedView(); }
    finally { this.accountTransitionBusy = false; this.accountOperation = undefined; this.sendSnapshot(); await this.syncSidebarState?.(); }
  }

  private async disconnectedView(): Promise<void> {
    this.refreshAbort?.abort();
    this.requestGeneration++;
    this.issueOpenGeneration++;
    this.issueBoardGeneration++;
    this.issueGraphAbort?.abort();
    this.issueBoardAbort?.abort();
    this.mergeRequestAbort?.abort();
    this.cancelMergeRequestSectionReads();
    this.issueOpenAbort?.abort();
    this.issuePanels.close();
    this.previewAbort?.abort(); this.previewGeneration++; this.issuePreview = undefined;
    await this.timer.detachScope(); this.syncTimerPolling();
    this.groups = []; this.projects = []; this.issues = []; this.mergeRequests = [];
    this.groupIssueBoards = []; this.groupIssueBoardsError = undefined;
    this.selectedIssueBoardId = undefined; this.issueBoardContent = undefined; this.issueBoardLoad = undefined;
    this.currentUser = undefined; this.selectedIssue = undefined; this.selectedMergeRequest = undefined;
    this.sendSnapshot();
    await this.syncSidebarState?.();
  }

  private async selectGroup(groupId?: number): Promise<boolean> {
    if (this.accountTransitionBusy) throw new Error('帳號正在驗證或切換，請稍後再選擇 Group。');
    const epoch = this.session.connectionEpoch;
    if (this.repositoryOperationInProgress) throw new Error('Repo 操作完成後才能切換連線或 Group。');
    if (groupId && groupId === this.session.selectedGroup?.id) { this.noteOutcome({ effect: 'none' }); return true; }
    const groups = this.session.baseUrl ? await this.session.cachedRead('groups', (client) => client.listGroups()) : [];
    const selected = groupId ? groups.find((item) => item.id === groupId) : await vscode.window.showQuickPick(
      groups.map((group) => ({ label: group.full_path, description: group.name, group })),
      { title: '選擇 GitLab Group', placeHolder: '選取工作群組' }
    ).then((item) => item?.group);
    if (!selected) { this.noteOutcome({ status: 'cancelled', effect: 'none' }); return false; }
    if (this.accountTransitionBusy || epoch !== this.session.connectionEpoch) throw new Error('帳號已變更，請重新選擇 Group。');
    if (selected.id === this.session.selectedGroup?.id) { this.noteOutcome({ effect: 'none' }); return true; }
    this.sendSnapshot();
    this.issueOpenGeneration++;
    this.issuePanels.close();
    this.previewAbort?.abort(); this.previewGeneration++; this.issuePreview = undefined;
    this.issueGraphAbort?.abort();
    this.issueBoardAbort?.abort();
    this.mergeRequestAbort?.abort();
    this.cancelMergeRequestSectionReads();
    this.issueOpenAbort?.abort();
    if (this.isRemotePage()) { this.refreshAbort?.abort(); this.requestGeneration++; }
    this.clearRemoteGroupData(); this.loadedScopeKey = undefined;
    this.sendSnapshot();
    await this.session.setSelectedGroup(selected);
    this.noteOutcome({ effect: 'applied' });
    this.selectedIssue = undefined; this.selectedMergeRequest = undefined; this.projects = [];
    this.projectMembers = [];
    await this.reconcileAfterWrite(async () => { if (this.isRemotePage()) await this.refresh({ reason: 'entry' });
      this.sendSnapshot(); await this.syncSidebarState?.(); });
    return true;
  }

  private async openLocalWorkspace(): Promise<void> {
    const epoch = this.session.connectionEpoch, workspaceGeneration = this.workspaceFoldersGeneration;
    const { root, error } = await this.resolveProjectRoot();
    if (epoch !== this.session.connectionEpoch || workspaceGeneration !== this.workspaceFoldersGeneration) {
      throw new Error('Group、帳號或工作區已變更，請重新開啟工作區。');
    }
    if (!root) throw new Error(error ?? '請先選擇工作區。');
    await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(root), false);
  }

  private syncBmadVisibility(): void {
    this.bmad?.setContext(this.projectContext?.root, this.projectContext?.revision,
      this.activeMode === 'bmad' && this.webviewReady && this.panel?.visible !== false);
  }

  private async refreshBmadWorkflow(recheckEnvironment = false): Promise<void> {
    if (this.disposed || this.activeMode !== 'bmad' || !this.webviewReady || this.panel?.visible === false) return;
    const signature = this.projectContextSignature();
    await this.refreshWorkflowKitInstallState();
    const context = await this.resolveProjectContext();
    if (this.disposed || signature !== this.projectContextSignature() || this.activeMode !== 'bmad' || !this.webviewReady) return;
    this.projectContext = context;
    if (!this.bmad) this.bmad = new BmadWorkflowController({
      bundledCatalog: () => readFile(vscode.Uri.joinPath(this.context.extensionUri, 'resources', 'bmad', 'bmad-help.csv').fsPath, 'utf8'),
      watch: (directory, changed) => {
        if (!vscode.workspace.createFileSystemWatcher) return { dispose: () => undefined };
        // Observe discovered directories individually. VS Code coalesces
        // overlapping recursive watches, which can hide newly created subtrees.
        const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(vscode.Uri.file(directory), '*'));
        const onEvent = (uri: vscode.Uri) => changed(uri.fsPath);
        const subscriptions = [watcher.onDidCreate(onEvent), watcher.onDidChange(onEvent), watcher.onDidDelete(onEvent)];
        return { dispose: () => { subscriptions.forEach(subscription => subscription.dispose()); watcher.dispose(); } };
      },
      changed: () => this.sendSnapshot(),
      error: message => this.post({ type: 'error', message })
    });
    this.bmad.setContext(context.root, context.revision, true);
    void this.refreshBmadEnvironment(context.root, recheckEnvironment);
    await this.bmad.refresh();
  }

  private async refreshBmadEnvironment(root?: string, force = false): Promise<void> {
    if (this.bmadEnvironmentRead && this.bmadEnvironmentRead.root === root) return this.bmadEnvironmentRead.task;
    if (!force && this.bmadEnvironment && this.bmadEnvironment.root === root && Date.now() - Date.parse(this.bmadEnvironment.checkedAt) < 30_000) return;
    const task = inspectBmadEnvironment(root, { probeVersions: vscode.workspace.isTrusted }).then(environment => {
      if (!this.disposed && this.projectContext?.root === root) { this.bmadEnvironment = environment; this.sendSnapshot(); }
    }).catch(() => undefined);
    const entry = { root, task }; this.bmadEnvironmentRead = entry;
    await task;
    if (this.bmadEnvironmentRead === entry) this.bmadEnvironmentRead = undefined;
  }

  private async requireBmadSnapshot(revision: string, guidanceOnly = false) {
    const signature = this.projectContextSignature();
    await this.refreshBmadWorkflow();
    const snapshot = guidanceOnly ? this.bmad?.snapshot : await this.bmad?.requireSnapshot(revision);
    if (signature !== this.projectContextSignature() || snapshot?.root !== this.projectContext?.root ||
      this.activeMode !== 'bmad' || !this.webviewReady || this.panel?.visible === false) throw new Error('專案或頁面已變更，請重新確認 BMAD 步驟。');
    if (!snapshot || snapshot.revision !== revision) throw new Error('BMAD 狀態已變更，請重新偵測。');
    return snapshot;
  }

  private async requireBmadStep(revision: string, stepId: string) {
    if (typeof stepId !== 'string' || stepId.length > 300) throw new Error('BMAD 步驟無效。');
    const snapshot = await this.requireBmadSnapshot(revision);
    const node = snapshot?.nodes.find(item => item.id === stepId);
    if (!snapshot || !node) throw new Error('找不到此 BMAD 步驟，請重新整理。');
    return { snapshot, node };
  }

  private async copyBmadCommand(request: BmadCommandRequest): Promise<void> {
    const snapshot = await this.requireBmadSnapshot(request.revision, request.command !== 'task' && !request.artifactId && !request.storyId);
    if (request.command === 'task') {
      const installed = this.workflowKitStateRoot && snapshot.root && sameLocalPath(this.workflowKitStateRoot, snapshot.root)
        ? this.workflowKitState : undefined;
      const issue = bmadKitTaskIssue(installed);
      if (issue) throw new Error(issue);
    }
    await vscode.env.clipboard.writeText(buildBmadCommand(snapshot, request));
    this.noteOutcome({ effect: 'applied' });
  }

  private async openBmadTerminal(revision: string): Promise<void> {
    const snapshot = await this.requireBmadSnapshot(revision, true);
    if (!snapshot.root) throw new Error('請先開啟或選擇本機專案資料夾。');
    const terminal = vscode.window.createTerminal({ name: 'BMAD 專案終端', cwd: snapshot.root });
    terminal.show();
  }

  private async openBmadArtifact(revision: string, stepId: string, filename: string): Promise<void> {
    const { snapshot } = await this.requireBmadStep(revision, stepId);
    const artifact = snapshot.steps.find(step => step.id === stepId)?.artifacts.find(item => item.path === filename);
    if (!artifact) throw new Error('找不到此步驟的產物，請重新整理。');
    await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(vscode.Uri.file(artifact.path)));
  }

  private async clone(projectIds: number[], cloneAll: boolean): Promise<void> {
    const group = this.session.selectedGroup;
    const epoch = this.session.connectionEpoch;
    if (!group || !this.session.baseUrl) throw new Error('請先連線 GitLab 並選擇 Group。');
    if (this.busy || this.repositoryOperationInProgress || this.cloneRootSelecting || this.workflowKitSelectingRoot || this.accountTransitionBusy) throw new Error('目前有工作正在處理，完成後再開始 Repo 操作。');
    const workspaceGeneration = this.workspaceFoldersGeneration;
    const checkProject = this.captureWorkflowKitAccess(true);
    const match = await this.resolveProjectRoot();
    if (this.busy || this.repositoryOperationInProgress || this.cloneRootSelecting || this.workflowKitSelectingRoot || this.accountTransitionBusy || epoch !== this.session.connectionEpoch ||
      this.session.selectedGroup?.id !== group.id || workspaceGeneration !== this.workspaceFoldersGeneration) throw new Error('工作區或帳號已變更，請重新確認下載。');
    const root = match.root;
    if (!root) throw new Error(match.error ?? '無法確認下載位置。');
    const repositoryAbort = new AbortController();
    this.repositoryOperationAbort = repositoryAbort;
    this.repositoryOperationInProgress = true;
    this.sendSnapshot();
    let operation: CloneOperationState | undefined;
    let progressPublisher: ReturnType<WorkspacePanel['cloneProgressPublisher']> | undefined;
    try {
      if (this.session.selectedGroup?.id !== group.id) throw new Error('Group 已變更，請重新選取專案。');
      const client = (await this.session.getClient()).withReadSignal(repositoryAbort.signal);
      const projects = !cloneAll || this.projects.length && this.workspaceSections.projects?.complete !== false ? this.projects : await this.session.cachedRead(
        `group/${group.id}/projects`, (readClient) => readClient.listGroupProjects(group.id), { signal: repositoryAbort.signal }
      );
      const wantedIds = new Set(projectIds.filter((id) => Number.isSafeInteger(id)));
      let chosen = cloneAll ? projects : projects.filter((project) => wantedIds.has(project.id));
      if (!chosen.length) throw new Error('請先在專案清單勾選要下載或更新的 Repo。');
      if (!cloneAll && chosen.length !== wantedIds.size) throw new Error('選取專案不在已載入的 Group 清單，請重新選取。');
      if (chosen.some(project => !project.path_with_namespace.startsWith(`${group.full_path}/`))) throw new Error('選取專案不屬於目前 Group，請重新載入清單。');
      const preparedLayout = await prepareOperationLayout(root, chosen, project => client.getProject(project.id), repositoryAbort.signal);
      chosen = preparedLayout.projects;
      if (chosen.some(project => !project.path_with_namespace.startsWith(`${group.full_path}/`))) throw new Error('專案已不屬於目前 Group，請重新載入清單。');
      const layout = preparedLayout.layout;
      const scopeKey = this.connectedScopeKey();
      operation = {
        id: randomUUID(), scopeKey, projectRevision: match.revision, phase: 'running', label: '下載／更新進度',
        items: chosen.map((project) => ({ projectId: project.id, projectPath: project.path_with_namespace, state: 'waiting' }))
      };
      progressPublisher = this.cloneProgressPublisher(operation);
      const publishOperation = (immediate = true): void => progressPublisher?.publish(immediate);
      publishOperation();
      const folderNames = layout.folders;
      const rootProjectId = layout.rootProjectId;
      const localStates = await mapWithConcurrency(chosen, 4, async (project) => {
        repositoryAbort.signal.throwIfAborted();
        const target = groupRepositoryPath(root!, project, projects, folderNames, rootProjectId);
        return [project.id, await localRepositoryStateAsync(root!, target, project.id === rootProjectId)] as const;
      });
      const localStatesById = new Map(localStates);
      const destinations = chosen.map((project) => {
        const target = groupRepositoryPath(root!, project, projects, folderNames, rootProjectId);
        return `${localStatesById.get(project.id) === 'ready' ? '更新' : 'Clone'}　${project.path_with_namespace} → ${target}`;
      });
      this.operationPhase('clone', '等待確認下載／更新 Repo…');
      const confirm = await vscode.window.showInformationMessage(`即將在 ${root} 處理 ${chosen.length} 個 Repo：\n${destinations.join('\n')}`, { modal: true }, '開始');
      if (confirm !== '開始') {
        this.noteOutcome({ status: 'cancelled', effect: 'none' });
        operation.phase = 'cancelled';
        operation.label = '已取消，選取仍保留';
        publishOperation();
        this.post({ type: 'message', message: '下載已取消；勾選項目仍保留。' });
        return;
      }
      const checked = await this.resolveProjectRoot();
      if (!checked.root || !sameLocalPath(checked.root, root) || this.session.selectedGroup?.id !== group.id ||
        epoch !== this.session.connectionEpoch || workspaceGeneration !== this.workspaceFoldersGeneration) throw new Error('Group 或下載工作區已變更。');
      const credentials = await this.session.getCloneCredentials();
      checkProject();
      const updateItem = (projectId: number, update: Partial<CloneOperationState['items'][number]>, immediate = true): void => {
        if (!operation) return;
        operation.items = operation.items.map((item) => item.projectId === projectId ? { ...item, ...update } : item);
        publishOperation(immediate);
      };
      const result = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: '下載／更新 GitLab Repo', cancellable: true }, async (progress, cancellation) => {
        const subscription = cancellation.onCancellationRequested(() => repositoryAbort.abort());
        try { return await cloneProjects(root!, chosen, credentials.baseUrl, credentials.token, (event) => {
          const state = event.state === 'completed' ? (event.action === 'clone' ? 'completed' : 'updated') : event.state;
          updateItem(event.project.id, { state, percent: event.percent, message: event.message }, event.state !== 'progress');
          const label = state === 'starting' ? '準備中' : state === 'progress' ? '下載中' : state === 'completed' ? '已下載' : state === 'updated' ? '已更新' : state === 'skipped' ? '略過' : state === 'failed' ? '失敗' : state;
          progress.report({ message: `${event.project.path_with_namespace}：${label}${event.percent === undefined ? '' : ` ${event.percent}%`}`, increment: 0 });
        }, { resolveProject: (project) => client.getProject(project.id), groupProjects: chosen, layout, signal: repositoryAbort.signal }); }
        finally { subscription.dispose(); }
      });
      operation.phase = result.cancelled ? 'cancelled' : result.failed ? 'failed' : 'completed';
      operation.label = 'Repo 操作結果';
      operation.items = operation.items.map((item) => item.state === 'waiting' || item.state === 'starting' || item.state === 'progress'
        ? { ...item, state: 'skipped', message: '此次操作未完成，請重新勾選後重試。' }
        : item);
      const results = new Map<number, Partial<CloneOperationState['items'][number]>>();
      for (const project of result.cloned) results.set(project.id, { state: 'completed', percent: undefined, message: '已下載' });
      for (const project of result.updated) results.set(project.id, { state: 'updated', percent: undefined, message: '已更新' });
      for (const item of result.skipped) results.set(item.project.id, { state: 'skipped', percent: undefined, message: item.reason });
      if (result.failed) results.set(result.failed.id, { state: 'failed', percent: undefined, message: result.failureReason ?? '操作失敗' });
      operation.items = operation.items.map(item => ({ ...item, ...results.get(item.projectId) }));
      publishOperation();
      this.noteOutcome(result.effect === 'unknown' ? { status: 'failed', effect: 'unknown', error: 'Repo 更新結果未能確認，請先核對本機狀態再重新操作。' } : this.repositoryOutcome());
      this.post({ type: 'message', message: `下載／更新完成：${result.cloned.length} 個已下載、${result.updated.length} 個已更新、${result.skipped.length} 個略過${result.failed ? `、${result.failed.path_with_namespace} 失敗` : ''}。` });
    } catch (error) {
      if (operation) {
        const reason = readableError(error);
        operation.phase = repositoryAbort.signal.aborted ? 'cancelled' : 'failed';
        operation.label = repositoryAbort.signal.aborted ? '下載／更新已取消' : '下載／更新失敗';
        operation.items = operation.items.map((item) => item.state === 'waiting' || item.state === 'starting' || item.state === 'progress'
          ? { ...item, state: 'failed', percent: undefined, message: reason }
          : item);
        this.cloneOperation = { ...operation, items: operation.items.map((item) => ({ ...item })) };
        this.post({ type: 'cloneOperation', ...this.cloneOperation });
      }
      if (repositoryAbort.signal.aborted) { this.noteOutcome(this.repositoryOutcome()); return; }
      throw error;
    } finally {
      progressPublisher?.dispose();
      if (this.repositoryOperationAbort === repositoryAbort) this.repositoryOperationAbort = undefined;
      this.repositoryOperationInProgress = false;
      this.projectEnvironmentSnapshots?.invalidate(root);
      try { await this.reconcileAfterWrite(async () => { await this.refreshProjectRoot(true); await this.refreshInventory(); }); }
      finally { this.sendSnapshot(); this.schedulePendingWorkspaceRefresh(); }
    }
  }

  private async syncRepos(projectIds?: number[]): Promise<void> {
    if (projectIds !== undefined && (!Array.isArray(projectIds) || projectIds.some(id => !Number.isSafeInteger(id) || id <= 0))) {
      throw new Error('選取專案識別資料無效，請重新選取 Repo。');
    }
    if (projectIds?.length === 0) {
      this.post({ type: 'message', message: '請先在專案清單勾選要同步的 Repo。' });
      return;
    }
    const wantedIds = projectIds === undefined ? undefined : new Set(projectIds);
    const group = this.session.selectedGroup;
    if (!group || !this.session.baseUrl) throw new Error('請先連線 GitLab 並選擇 Group。');
    if (wantedIds) {
      const selected = this.projects.filter(project => wantedIds.has(project.id));
      if (selected.length !== wantedIds.size) throw new Error('選取專案不在已載入的 Group 清單，請重新選取。');
      if (selected.some(project => !project.path_with_namespace.startsWith(`${group.full_path}/`))) throw new Error('選取專案不屬於目前 Group，請重新載入清單。');
    }
    if (this.busy || this.repositoryOperationInProgress || this.cloneRootSelecting || this.workflowKitSelectingRoot || this.accountTransitionBusy) throw new Error('目前有工作正在處理，完成後再開始 Repo 操作。');
    const epoch = this.session.connectionEpoch, workspaceGeneration = this.workspaceFoldersGeneration;
    const checkProject = this.captureWorkflowKitAccess(true);
    const resolution = await this.resolveProjectRoot();
    if (this.busy || this.repositoryOperationInProgress || this.cloneRootSelecting || this.workflowKitSelectingRoot || this.accountTransitionBusy || epoch !== this.session.connectionEpoch || group.id !== this.session.selectedGroup?.id ||
      workspaceGeneration !== this.workspaceFoldersGeneration) throw new Error('Group、帳號或工作區已變更，請重新確認更新。');
    const root = resolution.root;
    if (!root) throw new Error(resolution.error ?? '請選擇專案下載／更新位置。');
    const repositoryAbort = new AbortController();
    this.repositoryOperationAbort = repositoryAbort;
    this.repositoryOperationInProgress = true;
    this.sendSnapshot();
    let operation: CloneOperationState | undefined;
    let progressPublisher: ReturnType<WorkspacePanel['cloneProgressPublisher']> | undefined;
    const publishOperation = (immediate = true): void => progressPublisher?.publish(immediate);
    try {
      let groupProjects = this.workspaceSections.projects?.complete === false
        ? await this.session.cachedRead(`group/${group.id}/projects`, readClient => readClient.listGroupProjects(group.id), { signal: repositoryAbort.signal }) : this.projects;
      const client = (await this.session.getClient()).withReadSignal(repositoryAbort.signal);
      const preparedLayout = await prepareOperationLayout(root, groupProjects, project => client.getProject(project.id), repositoryAbort.signal);
      groupProjects = preparedLayout.projects;
      const layout = preparedLayout.layout;
      const folderNames = layout.folders;
      const rootProjectId = layout.rootProjectId;
      const candidates = wantedIds ? groupProjects.filter(project => wantedIds.has(project.id)) : groupProjects;
      if (wantedIds && candidates.some(project => !project.path_with_namespace.startsWith(`${group.full_path}/`))) throw new Error('專案已不屬於目前 Group，請重新載入清單。');
      const localStates = await mapWithConcurrency(candidates, 4, async (project) => {
        repositoryAbort.signal.throwIfAborted();
        try {
          const targetPath = groupRepositoryPath(root!, project, groupProjects, folderNames, rootProjectId);
          return [project.id, await localRepositoryStateAsync(root!, targetPath, project.id === rootProjectId)] as const;
        } catch { return [project.id, 'unsafe' as const] as const; }
      });
      const existingIds = new Set(localStates.filter(([, state]) => state === 'ready').map(([id]) => id));
      const existingProjects = candidates.filter((project) => existingIds.has(project.id));
      if (!existingProjects.length) {
        this.post({ type: 'message', message: wantedIds ? '選取專案尚無已存在且路徑安全的本機 Repo 可同步。' : `${group.full_path} 尚無已存在且路徑安全的本機 Repo 可更新。` });
        return;
      }
      const activeOperation: CloneOperationState = {
        id: randomUUID(), scopeKey: this.connectedScopeKey(), projectRevision: resolution.revision, phase: 'running', label: '預設分支同步結果',
        items: existingProjects.map((project) => ({ projectId: project.id, projectPath: project.path_with_namespace, state: 'waiting' }))
      };
      operation = activeOperation;
      progressPublisher = this.cloneProgressPublisher(activeOperation);
      publishOperation();
      this.operationPhase('syncRepos', '等待確認更新本機預設分支…');
      const confirm = await vscode.window.showWarningMessage(`Fetch 並 Pull ${group.full_path} 下${wantedIds ? '選取的' : '全部'} ${existingProjects.length} 個已存在 Repo 的預設分支？本機分支不會刪除。`, { modal: true }, '更新預設分支');
      if (confirm !== '更新預設分支') {
        this.noteOutcome({ status: 'cancelled', effect: 'none' });
        activeOperation.phase = 'cancelled';
        activeOperation.label = '已取消';
        publishOperation();
        return;
      }
      const checked = await this.resolveProjectRoot();
      if (!checked.root || !sameLocalPath(checked.root, root) || epoch !== this.session.connectionEpoch || group.id !== this.session.selectedGroup?.id ||
        workspaceGeneration !== this.workspaceFoldersGeneration) throw new Error('Group 或更新工作區已變更。');
      const hasCompleteSyncMetadata = (project: GitLabProject): boolean => Number.isSafeInteger(project.id) && project.id > 0 &&
        [project.path, project.path_with_namespace, project.http_url_to_repo].every(value => typeof value === 'string' && value.trim().length > 0) &&
        (project.ssh_url_to_repo === null || typeof project.ssh_url_to_repo === 'string' && project.ssh_url_to_repo.trim().length > 0) &&
        Object.prototype.hasOwnProperty.call(project, 'default_branch') && (project.default_branch === null || typeof project.default_branch === 'string') &&
        typeof project.empty_repo === 'boolean';
      let freshProjectsById: Map<number, GitLabProject> | undefined;
      let syncProjects = existingProjects;
      const removedProjects: Array<{ project: GitLabProject; reason: string }> = [];
      // Servers that already omit required metadata keep the per-project path,
      // avoiding a full collection read followed by the same detail requests.
      if (existingProjects.every(hasCompleteSyncMetadata)) {
        const freshProjects = await this.session.cachedRead(`group/${group.id}/projects`, readClient => readClient.listGroupProjects(group.id),
          { force: true, reason: 'sync-repos', signal: repositoryAbort.signal });
        repositoryAbort.signal.throwIfAborted();
        const refreshed = await this.resolveProjectRoot();
        if (!refreshed.root || !sameLocalPath(refreshed.root, root) || epoch !== this.session.connectionEpoch || group.id !== this.session.selectedGroup?.id ||
          workspaceGeneration !== this.workspaceFoldersGeneration) throw new Error('Group 或更新工作區已變更。');
        checkProject();
        freshProjectsById = new Map(freshProjects.map(project => [project.id, project]));
        syncProjects = existingProjects.filter(project => {
          if (freshProjectsById!.has(project.id)) return true;
          removedProjects.push({ project, reason: 'Repo 已不在目前 Group 的可存取清單，略過同步。' });
          return false;
        });
      }
      const credentials = await this.session.getCloneCredentials();
      repositoryAbort.signal.throwIfAborted();
      checkProject();
      const results: Awaited<ReturnType<typeof syncLocalDefaultBranches>> = syncProjects.length ? await syncLocalDefaultBranches(root!, syncProjects, credentials.baseUrl, credentials.token, (event) => {
        const state = event.state === 'up-to-date' ? 'upToDate' : event.state;
        activeOperation.items = activeOperation.items.map((item) => item.projectId === event.project.id
          ? { ...item, state, percent: event.percent, message: event.message }
          : item);
        publishOperation(event.state !== 'progress');
      }, { groupProjects, layout, resolveProject: async (project) => {
        if (!freshProjectsById) return client.getProject(project.id);
        const fresh = freshProjectsById.get(project.id);
        if (!fresh) throw new Error('Repo 已不在目前 Group 的可存取清單，略過同步。');
        return hasCompleteSyncMetadata(fresh) ? fresh : client.getProject(project.id);
      }, signal: repositoryAbort.signal }) : { found: 0, updated: [], upToDate: [], failed: [], skipped: [] };
      results.skipped.push(...removedProjects);
      const touched = new Set([...results.updated, ...results.upToDate, ...results.skipped.map((item) => item.project), ...results.failed.map((item) => item.project)].map((project) => project.id));
      activeOperation.items = activeOperation.items.map((item) => touched.has(item.projectId) ? item : { ...item, state: 'skipped', message: '同步前本機 Repo 已不存在，略過更新' });
      for (const project of results.updated) activeOperation.items = activeOperation.items.map((item) => item.projectId === project.id ? { ...item, state: 'updated', percent: undefined, message: '預設分支已更新' } : item);
      for (const project of results.upToDate) activeOperation.items = activeOperation.items.map((item) => item.projectId === project.id ? { ...item, state: 'upToDate', percent: undefined, message: '已是最新版本' } : item);
      for (const item of results.skipped) activeOperation.items = activeOperation.items.map((entry) => entry.projectId === item.project.id ? { ...entry, state: 'skipped', percent: undefined, message: item.reason } : entry);
      for (const item of results.failed) activeOperation.items = activeOperation.items.map((entry) => entry.projectId === item.project.id ? { ...entry, state: 'failed', percent: undefined, message: item.reason } : entry);
      activeOperation.phase = results.cancelled ? 'cancelled' : results.failed.length ? 'failed' : 'completed';
      activeOperation.label = '預設分支同步結果';
      publishOperation();
      this.noteOutcome(results.effect === 'unknown' ? { status: 'failed', effect: 'unknown', error: 'Repo 同步結果未能確認，請先核對本機狀態再重新操作。' } : this.repositoryOutcome());
      this.post({ type: 'message', message: `已更新 ${results.updated.length} 個預設分支；${results.upToDate.length} 個已是最新、${results.skipped.length + results.failed.length} 個需處理。` });
    } catch (error) {
      const reason = readableError(error);
      if (operation) {
        operation.phase = repositoryAbort.signal.aborted ? 'cancelled' : 'failed';
        operation.items = operation.items.map((item) => item.state === 'waiting' || item.state === 'starting' || item.state === 'progress'
          ? { ...item, state: 'failed', percent: undefined, message: reason }
          : item);
        publishOperation();
      }
      if (repositoryAbort.signal.aborted) { this.noteOutcome(this.repositoryOutcome()); return; }
      throw error;
    } finally {
      progressPublisher?.dispose();
      if (this.repositoryOperationAbort === repositoryAbort) this.repositoryOperationAbort = undefined;
      this.projectEnvironmentSnapshots?.invalidate(root);
      try { await this.reconcileAfterWrite(async () => { await this.refreshProjectRoot(true); await this.refreshInventory(); }); }
      finally { this.repositoryOperationInProgress = false; this.sendSnapshot(); this.schedulePendingWorkspaceRefresh(); }
    }
  }

  private async selectIssue(projectId: number, issueIid: number): Promise<void> {
    requireIssueIid(issueIid);
    this.previewAbort?.abort();
    this.issueOpenAbort?.abort(); this.issueOpenGeneration++;
    const controller = new AbortController();
    this.previewAbort = controller;
    const generation = ++this.previewGeneration;
    const scope = this.connectedScopeKey();
    const current = (): boolean => !this.disposed && !controller.signal.aborted && generation === this.previewGeneration && scope === this.connectedScopeKey();
    const project = await this.resolveGroupProject(projectId, controller.signal);
    if (!current()) return;
    const listed = this.issues.find(issue => issue.project_id === projectId && issue.iid === issueIid);
    this.selectedIssue = listed ? { project, issue: listed } : undefined;
    this.selectedProjectId = projectId;
    this.issuePreview = { projectId, issueIid, status: 'loading' };
    this.sendSnapshot();
    try {
      const issue = await this.session.cachedRead(`project/${projectId}/issue/${issueIid}`, client => client.getIssue(projectId, issueIid), { signal: controller.signal });
      if (!current()) return;
      this.selectedIssue = { project, issue };
      this.issuePreview = { projectId, issueIid, status: 'ready' };
      await this.context.globalState.update(this.selectedIssueKey(), { projectId, issueIid });
    } catch (error) {
      if (!current()) return;
      this.issuePreview = { projectId, issueIid, status: 'error', error: readableError(error) };
      this.noteOutcome({ status: 'failed', error: readableError(error) });
      this.session.log?.record({ feature: 'issue', action: 'selectIssue', result: 'error', projectId, issueIid, message: readableError(error) });
    }
    if (current()) this.sendSnapshot();
  }

  private async openIssue(projectId: number, issueIid: number, tab?: IssueDetailTab): Promise<void> {
    this.previewAbort?.abort(); this.previewGeneration++;
    this.issueOpenAbort?.abort();
    const controller = new AbortController();
    this.issueOpenAbort = controller;
    const generation = ++this.issueOpenGeneration;
    const baseUrl = this.session.baseUrl;
    const groupId = this.session.selectedGroup?.id;
    requireIssueIid(issueIid);
    const project = await this.resolveGroupProject(projectId, controller.signal);
    if (controller.signal.aborted || generation !== this.issueOpenGeneration || baseUrl !== this.session.baseUrl || groupId !== this.session.selectedGroup?.id) return;
    const issue = await this.session.cachedRead(`project/${projectId}/issue/${issueIid}`, readClient => readClient.getIssue(projectId, issueIid), { signal: controller.signal });
    if (controller.signal.aborted || generation !== this.issueOpenGeneration || baseUrl !== this.session.baseUrl || groupId !== this.session.selectedGroup?.id) return;
    const fullProject = project;
    this.selectedIssue = { project: fullProject, issue };
    this.projectMembers = [];
    await this.context.globalState.update(this.selectedIssueKey(), { projectId, issueIid });
    if (controller.signal.aborted || generation !== this.issueOpenGeneration || baseUrl !== this.session.baseUrl || groupId !== this.session.selectedGroup?.id) return;
    this.sendSnapshot();
    await this.issuePanels.showIssue(issue, tab);
  }

  private async loadDraftOptions(projectId: number): Promise<void> {
    const project = this.projects.find((item) => item.id === projectId);
    if (!project) throw new Error('找不到 Issue 專案。');
    const client = await this.session.getClient();
    const [members, labels, milestones, templates, canCreateIssue] = await Promise.all([
      this.session.cachedRead(`project/${projectId}/members`, (readClient) => readClient.listProjectMembers(projectId)),
      this.session.cachedRead(`project/${projectId}/labels`, (readClient) => readClient.listProjectLabels(projectId)),
      this.session.cachedRead(`project/${projectId}/milestones`, (readClient) => readClient.listProjectMilestones(projectId)),
      this.session.cachedRead(`project/${projectId}/templates`, (readClient) => readClient.listProjectIssueTemplates(projectId)),
      client.canCreateIssue(project.path_with_namespace)
    ]);
    const options: IssueFormOptions = { members: [...members], labels: [...labels], milestones: [...milestones], templates: [...templates] };
    this.post({ type: 'draftOptions', projectId, options, canCreateIssue });
  }

  private createDrafts(analysisId: string, drafts: IssueDraft[], options: Record<string, { assigneeId?: number; labels: string[]; milestoneId?: number }>): Promise<void> {
    const publish = () => this.publishDrafts(analysisId, drafts, options);
    const operation = this.issuePublishQueue.then(publish, publish);
    this.issuePublishQueue = operation.then(() => undefined, () => undefined);
    return operation;
  }

  private async publishDrafts(analysisId: string, drafts: IssueDraft[], options: Record<string, { assigneeId?: number; labels: string[]; milestoneId?: number }>): Promise<void> {
    const group = this.session.selectedGroup;
    const userId = this.currentUser?.id;
    if (!group || !userId || !Array.isArray(drafts) || drafts.length > 100) throw new Error('Issue 草稿資料超出可處理範圍。');
    const bundle = parseIssueDraftBundle(JSON.stringify({ schema: 'IssueDraftBundle/v1', analysisId, drafts }));
    const client = await this.session.getClient();
    const results: DraftIssueResult[] = [];
    const optionCache = new Map<number, { members: Set<number>; labels: Set<string>; milestones: Set<number>; canCreate: boolean }>();
    for (const draft of bundle.drafts) {
      try {
        const project = matchDraftProject(draft.projectPath, this.projects);
        let allowed = optionCache.get(project.id);
        if (!allowed) {
          const [members, labels, milestones, canCreate] = await Promise.all([
            client.listProjectMembers(project.id), client.listProjectLabels(project.id), client.listProjectMilestones(project.id), client.canCreateIssue(project.path_with_namespace)
          ]);
          allowed = { members: new Set(members.map((item) => item.id)), labels: new Set(labels.map((item) => item.name)), milestones: new Set(milestones.map((item) => item.id)), canCreate };
          optionCache.set(project.id, allowed);
        }
        if (!allowed.canCreate) throw new Error('目前沒有在此專案建立 Issue 的權限。');
        const description = buildIssueDraftDescription(bundle.analysisId, draft);
        const matches = await client.searchProjectIssues(project.id, `${bundle.analysisId}:${draft.id}`);
        const existing = matches.find((item) => containsIssueDraftMarker(item.description, bundle.analysisId, draft.id));
        if (existing) {
          results.push({ draftId: draft.id, projectPath: project.path_with_namespace, issueIid: existing.iid, url: existing.web_url, state: 'already-created' });
          continue;
        }
        const setting = options[draft.id] ?? { labels: draft.labels ?? [] };
        if (setting.assigneeId !== undefined && !allowed.members.has(setting.assigneeId)) throw new Error('所選負責人不屬於此專案。');
        if (setting.milestoneId !== undefined && !allowed.milestones.has(setting.milestoneId)) throw new Error('所選 Milestone 已不存在或不屬於此專案。');
        if (setting.labels.some((label) => !allowed!.labels.has(label))) throw new Error('草稿包含此專案不存在的 Label。');
        const issue = await client.createIssue(project.id, { title: draft.title, description, assigneeId: setting.assigneeId, labels: setting.labels, milestoneId: setting.milestoneId });
        results.push({ draftId: draft.id, projectPath: project.path_with_namespace, issueIid: issue.iid, url: issue.web_url, state: 'created' });
      } catch (error) {
        results.push({ draftId: draft.id, projectPath: draft.projectPath, state: 'failed', message: readableError(error) });
        if (error && typeof error === 'object' && (error as { effect?: unknown }).effect === 'unknown') {
          this.noteOutcome({ status: 'failed', effect: 'unknown', error: `Issue 建立結果未確認：${readableError(error)}。請先到 GitLab 核對，勿直接重送。` });
          break;
        }
      }
    }
    this.post({ type: 'draftResults', analysisId: bundle.analysisId, results });
    if (this.activeMode === 'developer') await this.loadWorkspaceSection('issues', true);
  }

  private async checkSimilarIssues(drafts: IssueDraft[]): Promise<void> {
    if (!Array.isArray(drafts) || drafts.length > 100) throw new Error('相似 Issue 檢查資料超出範圍。');
    const client = await this.session.getClient();
    const items = await Promise.all(drafts.map(async (draft) => {
      const project = matchDraftProject(draft.projectPath, this.projects);
      const found = await client.searchProjectIssues(project.id, draft.title.slice(0, 100));
      return { draftId: draft.id, projectPath: project.path_with_namespace, issues: found.filter((issue) => issue.state === 'opened').slice(0, 8).map((issue) => ({ iid: issue.iid, title: issue.title, webUrl: issue.web_url })) };
    }));
    this.post({ type: 'similarIssues', items });
  }

  private async openExternal(raw: string): Promise<void> {
    const url = new URL(raw);
    const baseUrl = this.session.baseUrl ? new URL(this.session.baseUrl) : undefined;
    const releaseHosts = ['github.com', 'tech-sharing.cathaysec.com.tw'];
    if (url.protocol !== 'https:' && (!baseUrl || url.origin !== baseUrl.origin || url.protocol !== 'http:')) throw new Error('只允許開啟 GitLab、GitHub 或內網 Gitea 的 HTTPS 網址。');
    if (url.protocol === 'https:' && !releaseHosts.includes(url.hostname) && baseUrl?.origin !== url.origin) throw new Error('只允許開啟已設定 GitLab 與工具 Release 的網址。');
    await vscode.env.openExternal(vscode.Uri.parse(url.toString()));
  }

  private async startTimer(projectId: number, issueIid: number): Promise<void> {
    requireIssueIid(issueIid);
    await this.resolveGroupProject(projectId);
    const issue = await (await this.session.getClient()).getIssue(projectId, issueIid);
    const project = this.projects.find((item) => item.id === projectId) ?? await (await this.session.getClient()).getProject(projectId);
    await this.enqueueTimer(() => this.timer.start(project, issue));
    this.syncTimerPolling();
    this.post({ type: 'message', message: `開始計時：${project.path_with_namespace}#${issue.iid}` });
    this.publishTimers();
  }

  private async addManualTime(projectId: number, issueIid: number, duration: string, summary: string, spentAt?: string): Promise<void> {
    requireIssueIid(issueIid);
    await this.resolveGroupProject(projectId);
    const client = await this.session.getClient();
    const [issue, project] = await Promise.all([client.getIssue(projectId, issueIid), client.getProject(projectId)]);
    await this.enqueueTimer(() => this.timer.addManual(project, issue, duration, summary, spentAt));
    this.publishTimers();
  }

  private async updateTimer(action: () => Promise<WorkspaceTimerEntry | void>): Promise<void> {
    await this.enqueueTimer(action);
    this.syncTimerPolling();
    this.publishTimers();
  }

  private async updateTimeEntry(id: string, duration: string, summary: string, spentAt: string): Promise<void> {
    const entry = this.timer.list().find((item) => item.id === id);
    if (!entry) throw new Error('找不到這筆工時。');
    if (entry.phase === 'uncertain') {
      const confirm = await vscode.window.showWarningMessage(`請先在 GitLab 檢查 ${entry.projectPath}#${entry.issueIid} 是否已有這筆工時。只有確認不存在後，才可重新排入送出。`, { modal: true }, '已確認不存在，重新排入');
      if (confirm !== '已確認不存在，重新排入') { this.noteOutcome({ status: 'cancelled', effect: 'none' }); return; }
    }
    await this.updateTimer(() => this.timer.updateEntry(id, duration, summary, spentAt));
    this.resolveUnknownFor(`time:${id}`, 'none');
  }

  private async acknowledgeTimeEntry(id: string): Promise<void> {
    const entry = this.timer.list().find((item) => item.id === id);
    if (!entry) throw new Error('找不到這筆工時。');
    const confirm = await vscode.window.showWarningMessage(`請先確認 GitLab 的 ${entry.projectPath}#${entry.issueIid} 已經有這筆 ${gitLabDuration(entry.elapsedSeconds)} 工時；系統不會替你重新送出。`, { modal: true }, '已在 GitLab 確認');
    if (confirm !== '已在 GitLab 確認') { this.noteOutcome({ status: 'cancelled', effect: 'none' }); return; }
    await this.updateTimer(() => this.timer.acknowledge(id));
    this.resolveUnknownFor(`time:${id}`, 'applied');
  }

  private async submitTime(id: string): Promise<void> {
    const entry = this.timer.list().find((item) => item.id === id);
    if (!entry) throw new Error('找不到待送出的工時。');
    const client = await this.session.getClient();
    const issue = await client.getIssue(entry.projectId, entry.issueIid);
    await this.session.ensureInstanceChecked();
    const permissionFields = this.session.issueCapabilities?.issuePermissionFields ?? [];
    if (!permissionFields.length) throw new Error('GitLab did not expose Issue permissions, so the time entry was not sent.');
    const permissions = await client.getIssuePermissions(entry.projectPath, entry.issueIid, permissionFields);
    if (permissions.updateIssue !== true && permissions.adminIssue !== true) throw new Error('GitLab reports that this account cannot log time on this Issue.');
    timeEntryTimestamp(entry.spentAt);
    gitLabDuration(entry.elapsedSeconds);
    const capabilities = this.session.issueCapabilities;
    const useGraphql = capabilities?.timelogCreate === true && capabilities.timelogCreateDated === true && capabilities.timelogCreateSummary === true;
    if (entry.spentAt && !useGraphql) throw new Error('此 GitLab 版本不支援指定日期的工時紀錄。');
    let submitting: WorkspaceTimerEntry;
    try { submitting = await this.enqueueTimer(() => this.timer.beginSubmit(id)); }
    catch (error) { this.publishTimers(); throw error; }
    this.publishTimers();
    let writeStarted = false;
    try {
      const timestamp = timeEntryTimestamp(submitting.spentAt);
      const duration = gitLabDuration(submitting.elapsedSeconds);
      if (submitting.spentAt && (!useGraphql || !issue.id)) throw new Error('此 GitLab 版本不支援指定日期的工時紀錄。');
      if (useGraphql && issue.id) {
        const scopedClient = client.withWriteScope?.({ projectId: issue.project_id, issueIid: issue.iid, resource: 'issues' }) ?? client;
        writeStarted = true;
        await scopedClient.createIssueTimelog(issue.id, duration, submitting.summary, timestamp);
      } else {
        writeStarted = true;
        await client.addSpentTime(entry.projectId, entry.issueIid, duration, submitting.summary);
      }
    } catch (error) {
      const effect = writeStarted ? gitLabWriteFailureEffect(error) : 'none';
      const message = effect === 'none' ? `工時未送出：${readableError(error)}`
        : `工時送出結果尚未確認，請先到 GitLab 對帳；系統不會自動重送。${readableError(error)}`;
      let persistenceWarning = '';
      try { await this.enqueueTimer(() => this.timer.finishSubmit(id, effect, message)); }
      catch { persistenceWarning = ' 工時狀態無法保存，重新啟動後請先核對。'; }
      this.publishTimers();
      this.noteOutcome({ status: 'failed', effect });
      throw Object.assign(new Error(message + persistenceWarning, { cause: error }), { effect });
    }
    this.noteOutcome({ effect: 'applied' });
    try {
      await this.enqueueTimer(() => this.timer.finishSubmit(id, 'applied'));
      this.post({ type: 'message', message: '工時已送至 GitLab。' });
    } catch (error) {
      this.noteOutcome({ status: 'succeeded', effect: 'applied', refreshError: `工時已送至 GitLab，但本機狀態無法保存：${readableError(error)}` });
    } finally { this.publishTimers(); }
  }

  private loadMergeRequest(projectId: number, iid: number, options: { force?: boolean } = {}): Promise<void> {
    requireIssueIid(iid);
    const scope = this.connectedScopeKey(), epoch = this.session.connectionEpoch;
    this.pendingMergeRequestRead = { projectId, iid };
    if (!scope || this.panel?.visible === false || this.disposed) return Promise.resolve();
    const key = `${epoch}:${scope}:${projectId}:${iid}`;
    const pending = this.mergeRequestRead;
    if (pending?.key === key && !pending.controller.signal.aborted) {
      if (options.force && !pending.force) return pending.task.then(() => {
        const target = this.pendingMergeRequestRead ?? (this.selectedMergeRequest && { projectId: this.selectedMergeRequest.request.project_id, iid: this.selectedMergeRequest.request.iid });
        if (scope === this.connectedScopeKey() && epoch === this.session.connectionEpoch && target?.projectId === projectId && target.iid === iid) return this.loadMergeRequest(projectId, iid, options);
      });
      return pending.task;
    }
    const controller = new AbortController();
    const task = this.loadMergeRequestNow(projectId, iid, scope, epoch, controller, options.force === true);
    const read = { key, force: options.force === true, controller, task };
    this.mergeRequestRead = read;
    return task.finally(() => { if (this.mergeRequestRead === read) this.mergeRequestRead = undefined; });
  }

  private async loadMergeRequestNow(projectId: number, iid: number, scope: string, epoch: number, controller: AbortController, force: boolean): Promise<void> {
    const sameSelection = this.selectedMergeRequest?.request.project_id === projectId && this.selectedMergeRequest.request.iid === iid;
    this.mergeRequestAbort?.abort();
    this.mergeRequestAbort = controller;
    if (!sameSelection) {
      this.cancelMergeRequestSectionReads();
      this.selectedMergeRequest = undefined;
      this.mergeRequestGeneration++;
      this.sendSnapshot();
    }
    const generation = this.mergeRequestSummaryGeneration = (this.mergeRequestSummaryGeneration ?? 0) + 1;
    const connectionGeneration = this.requestGeneration;
    const current = (): boolean => !this.disposed && !controller.signal.aborted && generation === this.mergeRequestSummaryGeneration &&
      connectionGeneration === this.requestGeneration && scope === this.connectedScopeKey() && epoch === this.session.connectionEpoch;
    const busyOwner = `mr-summary:${generation}`;
    this.setBusyOwner(busyOwner, '正在讀取 MR');
    try {
      await this.resolveGroupProject(projectId, controller.signal);
      if (!current()) return;
      const request = await this.session.cachedRead(`project/${projectId}/merge-request/${iid}`,
        client => client.getMergeRequest(projectId, iid), { signal: controller.signal, force, reason: force ? 'manual' : 'selection' });
      if (!current()) return;
      const previous = this.selectedMergeRequest;
      const same = previous?.request.project_id === projectId && previous.request.iid === iid;
      const sameDiff = same && this.mergeRequestDiffIdentity(previous.request) === this.mergeRequestDiffIdentity(request);
      if (same && !sameDiff) {
        this.mergeRequestSectionAborts.diffs?.abort(); delete this.mergeRequestSectionAborts.diffs;
        this.mergeRequestSectionGenerations.diffs++;
      }
      this.selectedMergeRequest = this.getMergeRequestDetail(request, same ? previous : undefined, sameDiff);
      this.pendingMergeRequestRead = undefined;
      await this.context.globalState.update(this.selectedMergeRequestKey(), { projectId, iid });
    } catch (error) {
      if (current()) {
        const selected = this.selectedMergeRequest;
        if (selected?.request.project_id === projectId && selected.request.iid === iid) {
          this.selectedMergeRequest = { ...selected, mergeAvailability: { status: 'unknown', reason: '無法重新確認 MR 合併條件，請重試。' } };
        }
        throw error;
      }
    } finally {
      this.setBusyOwner(busyOwner);
      if (current()) this.sendSnapshot();
    }
  }

  private cancelMergeRequestSectionReads(): void {
    this.mergeRequestBranchRead?.controller.abort();
    this.mergeRequestBranchRead = undefined;
    if (this.selectedMergeRequest?.freshness?.state === 'checking') this.selectedMergeRequest = { ...this.selectedMergeRequest, freshness: { state: 'not_checked' } };
    for (const section of ['diffs', 'discussions'] as const) {
      this.mergeRequestSectionAborts[section]?.abort();
      delete this.mergeRequestSectionAborts[section];
      this.mergeRequestSectionGenerations[section]++;
      const state = this.selectedMergeRequest?.sections?.[section];
      if (state?.status === 'loading' || state?.refreshing) this.selectedMergeRequest = { ...this.selectedMergeRequest!, sections: {
        ...this.selectedMergeRequest!.sections, [section]: state.status === 'ready' ? { ...state, refreshing: false } : { status: 'idle' }
      } };
    }
  }

  private async loadMergeRequestSection(section: 'diffs' | 'discussions', projectId: number, iid: number, forceNetwork = false): Promise<void> {
    if (this.panel?.visible === false || this.disposed) return;
    if (this.selectedMergeRequest?.request.project_id !== projectId || this.selectedMergeRequest.request.iid !== iid) return;
    // A tab entry revalidates the summary through its own 60-second cache first.
    const entryGeneration = this.mergeRequestGeneration, entryConnectionGeneration = this.requestGeneration;
    const entryEpoch = this.session.connectionEpoch, entryScope = this.connectedScopeKey();
    const entrySectionGeneration = this.mergeRequestSectionGenerations[section];
    const entryCurrent = () => !this.disposed && this.panel?.visible !== false && entryGeneration === this.mergeRequestGeneration &&
      entryConnectionGeneration === this.requestGeneration && entryEpoch === this.session.connectionEpoch && entryScope === this.connectedScopeKey() &&
      this.selectedMergeRequest?.request.project_id === projectId && this.selectedMergeRequest.request.iid === iid;
    let summaryTransport: ReadObservation = {};
    try {
      await withReadObservation(event => {
        if (entryCurrent() && event.transportStage) summaryTransport = { transportStage: event.transportStage, retryAt: event.retryAt };
      }, () => this.loadMergeRequest(projectId, iid));
    } catch (error) {
      if (!entryCurrent() || entrySectionGeneration !== this.mergeRequestSectionGenerations[section]) return;
      const previous = this.selectedMergeRequest!.sections[section];
      this.selectedMergeRequest = { ...this.selectedMergeRequest!, sections: { ...this.selectedMergeRequest!.sections,
        [section]: { ...previous, ...readFailureTransport({ ...previous, ...summaryTransport }, error), status: 'error', refreshing: false, error: readableError(error) } } };
      this.noteOutcome({ status: 'failed', error: readableError(error) });
      this.sendSnapshot();
      return;
    }
    if (!entryCurrent()) return;
    const selected = this.selectedMergeRequest;
    if (!selected || selected.request.project_id !== projectId || selected.request.iid !== iid) return;
    const previousState = selected.sections[section];
    if (previousState.status === 'loading' || previousState.refreshing) return;
    const expired = previousState.updatedAt !== undefined && Date.now() - previousState.updatedAt >= (section === 'diffs' ? 300_000 : 60_000);
    if (!forceNetwork && previousState.status === 'ready' && !expired) return;
    forceNetwork ||= previousState.status === 'error';
    this.mergeRequestSectionAborts[section]?.abort();
    const controller = new AbortController();
    this.mergeRequestSectionAborts[section] = controller;
    const sectionGeneration = ++this.mergeRequestSectionGenerations[section];
    const detailGeneration = this.mergeRequestGeneration;
    const connectionGeneration = this.requestGeneration;
    this.selectedMergeRequest = { ...selected, sections: { ...selected.sections, [section]: previousState.status === 'ready'
      ? { ...previousState, error: undefined, refreshing: true } : { status: 'loading' } } };
    this.sendSnapshot();
    const isCurrent = (): boolean => !controller.signal.aborted && detailGeneration === this.mergeRequestGeneration &&
      connectionGeneration === this.requestGeneration && sectionGeneration === this.mergeRequestSectionGenerations[section] &&
      this.selectedMergeRequest?.request.project_id === projectId && this.selectedMergeRequest.request.iid === iid;
    try {
      const client = (await this.session.getClient()).withReadSignal(controller.signal);
      if (!isCurrent()) return;
      if (section === 'diffs') {
        const verified = await readVerifiedMergeRequestDiff(this.session, this.session.selectedGroup?.id ?? 0, selected.request,
          { signal: controller.signal, force: forceNetwork, onState: event => {
            if (isCurrent()) {
              const previous = this.selectedMergeRequest!.sections.diffs;
              this.selectedMergeRequest = { ...this.selectedMergeRequest!, sections: { ...this.selectedMergeRequest!.sections,
                diffs: { ...previous, ...event } } };
              if (event.transportStage && (event.transportStage !== previous.transportStage || event.retryAt !== previous.retryAt)) this.sendSnapshot();
            }
          } });
        const result = verified.result;
        if (!isCurrent()) return;
        this.selectedMergeRequest = { ...this.selectedMergeRequest!, request: verified.request,
          mergeAvailability: mergeAvailability(verified.request, verified.request.diff_refs?.head_sha), sourceSha: verified.request.diff_refs?.head_sha,
          targetSha: verified.request.diff_refs?.start_sha, diffVersionId: result.versionId, diffs: result.diffs, warnings: result.warnings,
          freshness: this.mergeRequestDiffIdentity(verified.request) === this.mergeRequestDiffIdentity(selected.request)
            ? this.selectedMergeRequest!.freshness : { state: 'not_checked' },
          sections: { ...this.selectedMergeRequest!.sections, diffs: { ...this.selectedMergeRequest!.sections.diffs,
            status: 'ready', updatedAt: this.selectedMergeRequest!.sections.diffs.fetchedAt ?? Date.now(), refreshing: false,
            transportStage: undefined, retryAt: undefined, complete: !result.truncated } } };
        for (const message of result.warnings) this.notifications.publish({ level: 'warn', title: 'MR 差異', message, origin: this.getNotificationOrigin() });
      } else {
        const discussions = await this.session.cachedRead(`project/${projectId}/merge-request/${iid}/discussions`,
          readClient => readClient.listMergeRequestDiscussions(projectId, iid), { signal: controller.signal, force: forceNetwork, reason: forceNetwork ? 'manual' : 'section' });
        if (!isCurrent()) return;
        const visibleDiscussions = discussions.map((discussion) => ({
          ...discussion,
          notes: discussion.notes.map((note) => ({ ...note, body: note.body.replace(/\n?\n?<!-- gitlab-workspace:mr-write:[a-f0-9]{64} -->/g, '') }))
        }));
        this.selectedMergeRequest = { ...this.selectedMergeRequest!, discussions: visibleDiscussions,
          sections: { ...this.selectedMergeRequest!.sections, discussions: { status: 'ready', updatedAt: Date.now() } } };
      }
    } catch (error) {
      if (isCurrent()) {
        this.noteOutcome({ status: 'failed', error: readableError(error) });
        if (!this.operationContext.getStore()) this.notifications.publish({ level: 'error', title: section === 'diffs' ? 'MR 差異' : 'MR 討論串', message: readableError(error), origin: this.getNotificationOrigin() });
        this.selectedMergeRequest = { ...this.selectedMergeRequest!, sections: {
          ...this.selectedMergeRequest!.sections, [section]: { ...this.selectedMergeRequest!.sections[section],
            ...readFailureTransport(this.selectedMergeRequest!.sections[section], error), status: 'error', refreshing: false, error: readableError(error) }
        } };
      }
    } finally {
      if (isCurrent()) this.sendSnapshot();
      if (this.mergeRequestSectionAborts[section] === controller) delete this.mergeRequestSectionAborts[section];
    }
  }

  private mergeRequestDiffIdentity(request: GitLabMergeRequest): string {
    return JSON.stringify([request.project_id, request.iid, request.source_project_id ?? request.project_id,
      request.target_project_id ?? request.project_id, request.source_branch, request.target_branch,
      request.diff_refs?.base_sha ?? null, request.diff_refs?.start_sha ?? null, request.diff_refs?.head_sha ?? request.sha ?? null]);
  }

  private getMergeRequestDetail(request: GitLabMergeRequest, previous?: MergeRequestDetail, sameDiff = false): MergeRequestDetail {
    const discussions = previous?.sections?.discussions;
    const expired = discussions?.updatedAt !== undefined && Date.now() - discussions.updatedAt >= 60_000;
    return { request, mergeAvailability: mergeAvailability(request, request.diff_refs?.head_sha), diffVersionId: sameDiff ? previous?.diffVersionId : undefined,
      diffs: sameDiff && previous ? previous.diffs ?? [] : [], discussions: previous?.discussions ?? [], sections: {
      diffs: sameDiff && previous ? previous.sections?.diffs ?? { status: 'idle' } : { status: 'idle' },
      discussions: discussions && !expired ? discussions : { status: 'idle' }
    }, freshness: sameDiff && previous ? previous.freshness : { state: 'not_checked' },
    sourceSha: request.diff_refs?.head_sha ?? request.sha, targetSha: request.diff_refs?.start_sha,
    warnings: sameDiff && previous ? previous.warnings ?? [] : [] };
  }

  private async refreshMergeRequestData(projectId: number, iid: number, sections: 'used' | 'discussions' | 'summary'): Promise<void> {
    const scope = this.connectedScopeKey(), epoch = this.session.connectionEpoch;
    const selected = this.selectedMergeRequest;
    if (!selected || selected.request.project_id !== projectId || selected.request.iid !== iid) return;
    const requested = (['diffs', 'discussions'] as const).filter(section => sections !== 'summary' &&
      (sections === 'used' || section === 'discussions') && selected.sections?.[section] && selected.sections[section].status !== 'idle');
    await this.loadMergeRequest(projectId, iid, { force: true });
    if (scope !== this.connectedScopeKey() || epoch !== this.session.connectionEpoch ||
      this.selectedMergeRequest?.request.project_id !== projectId || this.selectedMergeRequest.request.iid !== iid) return;
    for (const section of requested) {
      this.mergeRequestSectionAborts[section]?.abort(); delete this.mergeRequestSectionAborts[section];
      this.mergeRequestSectionGenerations[section]++;
      const previous: MergeRequestDetail['sections']['diffs'] = this.selectedMergeRequest.sections[section];
      this.selectedMergeRequest = { ...this.selectedMergeRequest, sections: { ...this.selectedMergeRequest.sections,
        [section]: previous.status === 'ready' ? { ...previous, refreshing: false } : { status: 'idle' } } };
    }
    await Promise.all(requested.map(section => this.loadMergeRequestSection(section, projectId, iid, true)));
  }

  private refreshMergeRequestBranches(projectId: number, iid: number): Promise<void> {
    const scope = this.connectedScopeKey(), epoch = this.session.connectionEpoch;
    if (!scope || this.disposed || this.panel?.visible === false || this.selectedMergeRequest?.request.project_id !== projectId || this.selectedMergeRequest.request.iid !== iid) return Promise.resolve();
    const key = `${epoch}:${scope}:${projectId}:${iid}`;
    if (this.mergeRequestBranchRead?.key === key && !this.mergeRequestBranchRead.controller.signal.aborted) return this.mergeRequestBranchRead.task;
    this.mergeRequestBranchRead?.controller.abort();
    const controller = new AbortController();
    const task = this.refreshMergeRequestBranchesNow(projectId, iid, scope, epoch, controller);
    const read = { key, controller, task }; this.mergeRequestBranchRead = read;
    return task.finally(() => { if (this.mergeRequestBranchRead === read) this.mergeRequestBranchRead = undefined; });
  }

  private async refreshMergeRequestBranchesNow(projectId: number, iid: number, scope: string, epoch: number, controller: AbortController): Promise<void> {
    await this.loadMergeRequest(projectId, iid, { force: true });
    const current = (): boolean => !this.disposed && !controller.signal.aborted && scope === this.connectedScopeKey() && epoch === this.session.connectionEpoch &&
      this.selectedMergeRequest?.request.project_id === projectId && this.selectedMergeRequest.request.iid === iid;
    if (!current()) return;
    const request = this.selectedMergeRequest!.request, identity = this.mergeRequestDiffIdentity(request);
    this.selectedMergeRequest = { ...this.selectedMergeRequest!, freshness: { state: 'checking' } }; this.sendSnapshot();
    const now = Date.now();
    let freshness: BranchFreshness = { state: 'unknown', reason: '無法比較 GitLab commit ancestry。', checkedAt: now };
    const targetProjectId = request.target_project_id ?? request.project_id;
    const sourceProjectId = request.source_project_id ?? request.project_id;
    try {
      const client = (await this.session.getClient()).withReadSignal(controller.signal);
      const [target, source] = await Promise.all([
        client.getRepositoryBranch(targetProjectId, request.target_branch),
        client.getRepositoryBranch(sourceProjectId, request.source_branch)
      ]);
      if (!current() || identity !== this.mergeRequestDiffIdentity(this.selectedMergeRequest!.request)) return;
      const targetSha = target.commit.id, sourceSha = source.commit.id;
      const comparison = await client.compareRepository(targetProjectId, sourceSha, targetSha);
      if (comparison.compare_timeout) freshness = { state: 'unknown', reason: 'GitLab compare API 逾時，無法判定分支是否已同步。', checkedAt: now };
      else if (!comparison.commits.length) freshness = { state: 'current', sourceSha, targetSha, checkedAt: now };
      else freshness = { state: 'behind', behindBy: comparison.commits.length, sourceSha, targetSha, checkedAt: now };
    } catch (error) {
      freshness = { state: 'unknown', reason: readableError(error), checkedAt: now };
    }
    if (!current() || identity !== this.mergeRequestDiffIdentity(this.selectedMergeRequest!.request)) return;
    this.selectedMergeRequest = { ...this.selectedMergeRequest!, freshness }; this.sendSnapshot();
  }

  private async postMergeRequestNote(projectId: number, iid: number, body: string): Promise<void> {
    await this.publishMergeRequestText(projectId, iid, body);
  }

  private async openBranchReview(projectId: number, iid: number): Promise<void> {
    await this.resolveGroupProject(projectId);
    const epoch = this.session.connectionEpoch;
    const connectedScope = this.connectedScopeKey();
    const client = await this.session.getClient();
    const request = await client.getMergeRequest(projectId, iid);
    if (epoch !== this.session.connectionEpoch || connectedScope !== this.connectedScopeKey()) return;
    const skills = this.getSkillsContext();
    if (!skills.root) throw new Error('請先選擇本機專案資料夾，再準備分支審查。');
    const project = this.projects.find(item => item.id === request.target_project_id || item.id === projectId);
    const matched = await this.inspectEnvironment(this.projects);
    if (epoch !== this.session.connectionEpoch || connectedScope !== this.connectedScopeKey()) return;
    const repositories = matched.repositories.filter(repo => repo.projectId === project?.id);
    const fork = request.source_project_id !== request.target_project_id;
    const unique = !fork && repositories.length === 1;
    const inputs = {
      'merge-repo.repo': unique ? repositories[0].path : '',
      'merge-repo.base': unique ? `origin/${request.target_branch}` : '',
      'merge-repo.head': unique ? `origin/${request.source_branch}` : '',
    };
    await this.navigateTo('sa');
    if (epoch !== this.session.connectionEpoch) return;
    this.post({ type: 'branchReviewReady', revision: this.getSkillsContext().revision, inputs,
      notice: unique ? undefined : '此 MR 為 fork 或無法唯一對應本機 Repo。請選擇含兩個明確分支的 Repo，再準備審查。' });
  }

  private async loadSkillBranches(repo: string, revision: string, requestId: string): Promise<void> {
    if (typeof requestId !== 'string' || !requestId.trim()) return;
    const skills = this.getSkillsContext();
    if (revision !== skills.revision) return;
    const selected = resolveReviewerRepository(repo, skills.reviewerRepositories ?? []);
    if (!selected) { this.post({ type: 'skillBranches', revision, repo, requestId, branches: [], error: '請從目前 VS Code 工作區選擇唯一的本機 Repo。' }); return; }
    const key = `${revision}:${selected.path}`;
    let task = this.skillBranchReads.get(key);
    if (!task) {
      task = readReviewerBranches(selected.path, this.gitRepositories?.gitExecutable ?? 'git');
      this.skillBranchReads.set(key, task);
    }
    try {
      const branches = await task;
      if (!this.disposed && revision === this.getSkillsContext().revision) this.post({ type: 'skillBranches', revision, repo, requestId, branches });
    } catch (error) {
      if (!this.disposed && revision === this.getSkillsContext().revision) this.post({ type: 'skillBranches', revision, repo, requestId, branches: [], error: readableError(error) });
    } finally { if (this.skillBranchReads.get(key) === task) this.skillBranchReads.delete(key); }
  }

  private async loadReviewerCapabilities(revision: string, requestId: string, tool: ReviewerToolId): Promise<void> {
    if (!isReviewerTool(tool) || typeof requestId !== 'string' || !requestId.trim()) return;
    const skills = this.getSkillsContext();
    if (revision !== skills.revision) return;
    try {
      const workspace = skills.workspaceRoot ?? skills.root;
      const binding = skills.root ? await readInstalledReviewerBinding(skills.root, tool) : undefined;
      const capabilities = binding && workspace ? await readReviewerCapabilities(binding,
        await resolvePythonRuntime(vscode.workspace.getConfiguration('gitlabWorkspace').get<string>('pythonPath', 'python')),
        workspace) : undefined;
      if (!this.disposed && revision === this.getSkillsContext().revision) {
        this.post({ type: 'reviewerCapabilities', revision, requestId, tool, capabilities });
      }
    } catch (error) {
      if (!this.disposed && revision === this.getSkillsContext().revision) {
        this.post({ type: 'reviewerCapabilities', revision, requestId, tool, error: readableError(error) });
      }
    }
  }

  private async loadReviewSessions(revision: string, tool: ReviewerToolId): Promise<void> {
    if (!isReviewerTool(tool)) throw new Error('無效的審查工具。');
    const skills = this.getSkillsContext();
    if (revision !== skills.revision) return;
    const root = tool === 'merge-reviewer' ? skills.reviewRuntimeRoot : skills.releaseReviewRuntimeRoot;
    const workspace = skills.workspaceRoot ?? skills.root;
    if (!root || !workspace) {
      this.post({ type: 'reviewSessions', revision, tool, sessions: [],
        error: '單 Repo 工作區請設定 gitlabWorkspace.reviewRuntimePath，路徑須位於各 Git Repo 外。' });
      return;
    }
    if (this.reviewWatcherRoot !== root + '\0' + revision + '\0' + tool && vscode.workspace.createFileSystemWatcher) {
      this.reviewWatcher?.dispose();
      this.reviewWatcherRoot = root + '\0' + revision + '\0' + tool;
      this.reviewWatcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(
        vscode.Uri.file(path.dirname(root)), path.basename(root) + '/jobs/*.json'));
      const refresh = (): void => {
        if (this.reviewRefreshTimer) clearTimeout(this.reviewRefreshTimer);
        this.reviewRefreshTimer = setTimeout(() => {
          if (!this.disposed) void this.loadReviewSessions(revision, tool);
        }, 150);
      };
      this.reviewWatcher.onDidCreate(refresh); this.reviewWatcher.onDidChange(refresh); this.reviewWatcher.onDidDelete(refresh);
    }
    try {
      const sessions = (await Promise.all(reviewRuntimeCandidates(root, workspace, tool).map(runtime =>
        readReviewSessions(runtime, workspace, (skills.reviewerRepositories ?? []).map(repo => repo.path), tool)))).flat().sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
      if (!this.disposed && revision === this.getSkillsContext().revision) this.post({ type: 'reviewSessions', revision, tool, sessions });
    } catch (error) {
      if (!this.disposed && revision === this.getSkillsContext().revision) this.post({ type: 'reviewSessions', revision, tool, sessions: [], error: readableError(error) });
    }
  }

  private async controlReviewSession(request: { revision: string; requestId: string; tool: ReviewerToolId }, action: 'cancel' | 'refresh' | 'resume' | 'report'): Promise<void> {
    if (!isReviewerTool(request.tool)) throw new Error('無效的審查工具。');
    const skills = this.getSkillsContext();
    const preferred = request.tool === 'merge-reviewer' ? skills.reviewRuntimeRoot : skills.releaseReviewRuntimeRoot;
    if (skills.revision !== request.revision || !preferred || !(skills.workspaceRoot ?? skills.root)) throw new Error('目前審查環境已變更，請重新讀取。');
    const workspace = (skills.workspaceRoot ?? skills.root)!;
    const repositories = skills.reviewerRepositories ?? [];
    const paths = repositories.map(repo => repo.path);
    const root = await resolveReviewRuntime(preferred, request.requestId, workspace, paths, request.tool);
    const job = await readReviewJob(root, request.requestId, workspace, paths, request.tool);
    if (action === 'cancel') {
      if (skills.installed.status !== 'installed' || !skills.root) throw new Error('請先安裝目前工作區的工作流程包。');
      const python = await resolvePythonRuntime(vscode.workspace.getConfiguration('gitlabWorkspace').get<string>('pythonPath', 'python'));
      await cancelReviewSession(root, request.requestId, workspace, paths, python,
        path.join(skills.root, '.agents', 'skills'), request.tool);
      await this.loadReviewSessions(request.revision, request.tool);
    } else if (action === 'report') {
      if (!job.report_path) throw new Error('這份審查尚未產生報告。');
      await access(job.report_path);
      await vscode.commands.executeCommand('markdown.showPreview', vscode.Uri.file(job.report_path));
    } else if (action === 'resume') {
      if (skills.installed.status !== 'installed' || !skills.root) throw new Error('請先安裝目前工作區的工作流程包。');
      const script = reviewSessionScript(path.join(skills.root, '.agents', 'skills'), request.tool);
      const binding = await readInstalledReviewerBinding(skills.root, request.tool);
      await vscode.env.clipboard.writeText(`使用 $${request.tool} 恢復同一份固定版本審查。\n` +
        `目前已安裝入口：${JSON.stringify(binding)}。先核對工具身分與目前安裝 hashes，再由該 helper 驗證原 context 的相容性；保留原 capture 身分、固定 SHA 與執行政策，不重新 capture。不相容時停止。\n` +
        `先執行已安裝 helper：python ${JSON.stringify(script)} status --runtime-root ${JSON.stringify(root)} --request-id ${request.requestId}。\n` +
        '依 status 回傳的草稿、artifact、diagnostics 與 remaining 繼續必要 step → finish；維持原 request_id，不重新 capture。' +
        'input-repair／draft-repair 須依 status/errors 實際指向修正操作檔、operation 欄位或草稿的讀取／JSON 錯誤，再沿用同一 request_id 與成功的 operation IDs 繼續；依 recoverable/terminal 與 job.state 判斷 exit 3。' +
        'owned evidence 損壞須遵守 helper 的終止判斷，不得從業務 Repo 補回或重新 capture 掩蓋。' +
        '已發布時依 review_outcome 區分發布成功與審查完整性；摘要缺失應明示未知，不推測報告內容。若 cleanup_pending，使用 finish 重試清理並回傳既有報告；其他已發布狀態回傳收據中的報告連結及原有審查缺口，不把發布成功視為審查完整。');
      this.post({ type: 'message', message: '已複製恢復審查指令；貼入 Codex 後沿用同份固定證據。' });
    } else {
      const cardId = request.tool === 'merge-reviewer' ? 'merge-repo' : 'release-review';
      const card = getSkillGuideCards(skills.mode === 'group' ? 'group' : 'repository').find(item => item.id === cardId)!;
      const binding = skills.root ? await readInstalledReviewerBinding(skills.root, request.tool) : undefined;
      const reviewerCapabilities = binding ? await readReviewerCapabilities(binding,
        await resolvePythonRuntime(vscode.workspace.getConfiguration('gitlabWorkspace').get<string>('pythonPath', 'python')), workspace) : undefined;
      const prompt = buildSkillGuidePrompt(card, {
        [`${cardId}.repo`]: job.inputs.project, [`${cardId}.base`]: job.inputs.base, [`${cardId}.head`]: job.inputs.head,
      }, { profile: skills.mode === 'group' ? 'group' : 'repository', root: skills.root,
        workspaceRoot: workspace, workspaceFile: skills.workspaceFile, repositories,
        reviewRuntimeRoot: skills.reviewRuntimeRoot, releaseReviewRuntimeRoot: skills.releaseReviewRuntimeRoot, reviewAuthScope: skills.reviewAuthScope,
        reviewerExecution: skills.reviewerExecution, reviewerExecutionError: skills.reviewerExecutionError,
        reviewerBinding: binding, reviewerCapabilities });
      await vscode.env.clipboard.writeText(prompt.replace(' start ', ' start --refresh ') +
        '\n建立新的 request_id，保留既有審查的固定版本與報告。');
      this.post({ type: 'message', message: '已複製重新同步審查指令；貼入 Codex 執行後才會取得新版本。' });
    }
  }

  private async replyMergeRequest(projectId: number, iid: number, discussionId: string, body: string): Promise<void> {
    const detail = this.selectedMergeRequest;
    if (detail?.request.project_id !== projectId || detail.request.iid !== iid || !detail.discussions.some((item) => item.id === discussionId)) throw new Error('找不到這則 MR 討論，請重新整理。');
    await this.publishMergeRequestText(projectId, iid, body, discussionId);
  }

  private async publishMergeRequestText(projectId: number, iid: number, body: string, discussionId?: string, beforePublish?: () => Promise<void>): Promise<void> {
    await this.resolveGroupProject(projectId);
    if (!body.trim() || body.length > 50_000) throw new Error('請輸入 1 到 50,000 字的 MR 評論。');
    const client = await this.session.getClient();
    const latest = await client.getMergeRequest(projectId, iid);
    const detail = this.selectedMergeRequest;
    if (!detail || detail.request.project_id !== projectId || detail.request.iid !== iid || latest.diff_refs?.head_sha !== detail.request.diff_refs?.head_sha) {
      throw new Error('MR head SHA 已變更或審查內容已切換，請先重新整理。');
    }
    if (discussionId && !detail.discussions.some((item) => item.id === discussionId)) throw new Error('找不到這則 MR 討論，請重新整理。');
    const groupId = this.session.selectedGroup!.id;
    const userId = this.currentUser!.id;
    const key = createHash('sha256').update([this.session.baseUrl, userId, projectId, iid, latest.diff_refs?.head_sha ?? '', discussionId ?? '', body.trim()].join('\0')).digest('hex');
    const marker = `<!-- gitlab-workspace:mr-write:${key} -->`;
    if (this.mrWritesInFlight.has(key)) throw new Error('此 MR 評論正在處理中。');
    this.mrWritesInFlight.add(key);
    try {
    const pending = this.pendingMrWrites().find((item) => item.key === key && item.groupId === groupId && item.userId === userId);
    const hasMarker = async (): Promise<boolean> => {
      const discussions = await client.listMergeRequestDiscussions(projectId, iid);
      return discussions.some((discussion) => discussion.notes.some((note) => note.body.includes(marker)));
    };
    if (await hasMarker()) {
      await this.savePendingMrWrite(undefined, key);
      this.post({ type: 'message', message: '已在 GitLab 找到這筆評論，已完成對帳。' });
      await this.refreshMergeRequestData(projectId, iid, 'discussions');
      return;
    }
    if (pending) {
      const confirm = await vscode.window.showWarningMessage('先前的評論送出結果仍不確定。已查詢 GitLab 但尚未找到標記；請先人工確認此 MR，確認不存在後才可重試。', { modal: true }, '我已確認不存在，重試');
      if (confirm !== '我已確認不存在，重試') { this.noteOutcome({ status: 'cancelled', effect: 'none' }); return; }
    }
    await this.savePendingMrWrite({ key, marker, groupId, userId, projectId, iid, discussionId, state: 'sending' }, key);
    const markedBody = `${body.trim()}\n\n${marker}`;
    try {
      await beforePublish?.();
    } catch (error) {
      await this.savePendingMrWrite(undefined, key);
      throw error;
    }
    try {
      if (discussionId) await client.replyToMergeRequestDiscussion(projectId, iid, discussionId, markedBody);
      else await client.createMergeRequestNote(projectId, iid, markedBody);
    } catch (error) {
      const found = await hasMarker().catch(() => false);
      if (!found) {
        await this.savePendingMrWrite({ key, marker, groupId, userId, projectId, iid, discussionId, state: 'uncertain' }, key);
        this.noteOutcome({ effect: 'unknown' });
        throw new Error(`評論送出結果尚未確認；已保留對帳標記，請先檢查 GitLab，不會自動重送。${readableError(error)}`);
      }
    }
    await this.savePendingMrWrite(undefined, key);
    this.post({ type: 'message', message: discussionId ? '已回覆 MR 討論。' : '已發布 MR 評論。' });
    this.noteOutcome({ effect: 'applied' });
    await this.reconcileAfterWrite(() => this.refreshMergeRequestData(projectId, iid, 'discussions'));
    } finally { this.mrWritesInFlight.delete(key); }
  }

  private async confirmOperationResult(targetOperationId: string, recovery?: OperationRecoveryMetadata): Promise<void> {
    if (typeof targetOperationId !== 'string' || !/^[a-z0-9-]{1,100}$/i.test(targetOperationId)) throw new Error('待核對的操作識別碼無效。');
    const target = this.operations.get(targetOperationId);
    if (target && isActiveOperation(target)) throw new Error('操作仍在執行，請等候結束後再核對結果。');
    const scopeRequest = { type: 'confirmOperationResult', targetOperationId, recovery };
    const currentScope = this.actionScope(scopeRequest);
    let recovered: WorkspaceOperationState | undefined;
    if (recovery) {
      const validString = (value: unknown, max: number) => typeof value === 'string' && value.length > 0 && value.length <= max && !/[\r\n\0]/.test(value);
      if (recovery.requestId !== targetOperationId || recovery.kind !== 'write' || !validString(recovery.resourceKey, 500) ||
          !validString(recovery.action, 100) || !validString(recovery.label, 200) ||
          recovery.correlationId !== undefined && !validString(recovery.correlationId, 128) ||
          recovery.lockKey !== undefined && !validString(recovery.lockKey, 1000)) throw new Error('先前操作的恢復資料無效，請保留草稿並到 GitLab 或 Repo 核對。');
      // Recovery imports only a receipt after explicit confirmation. It never imports a request body or runs an action.
      recovered = { requestId: targetOperationId, resourceKey: recovery.resourceKey, action: recovery.action, label: recovery.label,
        correlationId: recovery.correlationId, lockKey: recovery.lockKey, kind: 'write', scopeRevision: currentScope,
        phase: '等待人工核對先前操作', status: 'failed', effect: 'unknown', startedAt: Date.now() };
    }
    if (target && target.effect !== 'unknown') throw new Error('這筆操作已經取得明確結果，無需再次核對。');
    if (!target && !recovered) throw new Error('找不到目前連線的待確認操作；請先到 GitLab 或 Repo 人工核對結果。');
    const previousContext = !target || target.hostSessionId !== this.operations.sessionId || target.scopeRevision !== currentScope;
    if (previousContext && !recovered) throw new Error('這筆操作屬於其他帳號或工作區，請切回原工作區後核對。');
    const identity = target ?? recovered!;
    if (!previousContext && (identity.resourceKey.startsWith('mr:') || identity.resourceKey.startsWith('time:'))) throw new Error('請使用此 MR 或工時紀錄的專用結果核對操作。');
    this.operationPhase('confirmOperationResult', '等待人工確認操作結果…');
    const notice = previousContext ? '這筆操作來自先前的工作階段或其他工作區，系統無法代為確認結果。請先切至原 GitLab 或 Repo 人工核對。\n' : '';
    const choice = await vscode.window.showWarningMessage(`${notice}請先在 GitLab 或本機 Repo 核對「${identity.label}」（${identity.resourceKey}）的結果。只有確認結果後，才選擇下列項目解除待確認狀態；系統不會重新執行或重送操作。`,
      { modal: true }, '已確認完成', '已確認未執行');
    if (choice !== '已確認完成' && choice !== '已確認未執行') { this.noteOutcome({ status: 'cancelled', effect: 'none' }); return; }
    if (currentScope !== this.actionScope(scopeRequest)) throw new Error('帳號或工作區已變更，請重新核對。');
    const latest = this.operations.get(targetOperationId);
    if (latest && isActiveOperation(latest)) throw new Error('操作仍在執行，請等候結束後再核對結果。');
    if (latest && latest.effect !== 'unknown') throw new Error('操作結果已更新，請重新確認目前狀態。');
    const outcome = { status: 'succeeded' as const, effect: choice === '已確認完成' ? 'applied' as const : 'none' as const, error: undefined,
      phase: choice === '已確認完成' ? '已人工核對，操作已完成' : '已確認未執行，可重新操作' };
    if (target) this.operations.resolveUnknown(targetOperationId, outcome);
    else this.operations.recoverConfirmed(recovered!, outcome);
  }

  private async reconcileMergeRequestWrite(projectId: number, iid: number): Promise<void> {
    await this.resolveGroupProject(projectId); requireIssueIid(iid);
    const scope = this.operationScope();
    const resourceKey = `mr:${projectId}:${iid}`;
    const pending = this.pendingMrWrites().filter(item => item.projectId === projectId && item.iid === iid &&
      item.groupId === this.session.selectedGroup?.id && item.userId === this.currentUser?.id);
    const client = await this.session.getClient();
    this.operationPhase('reconcileMergeRequestWrite', '正在 GitLab 核對評論標記…');
    const discussions = await client.listMergeRequestDiscussions(projectId, iid);
    if (scope !== this.operationScope()) { this.noteOutcome({ status: 'cancelled', effect: 'none' }); return; }
    if (!pending.length) throw new Error('找不到待核對的評論標記，請先在 GitLab 人工確認。');
    const found = pending.filter(item => discussions.some(discussion => discussion.notes.some(note => note.body.includes(item.marker))));
    if (found.length !== pending.length) {
      this.operationPhase('reconcileMergeRequestWrite', '等待人工確認 GitLab 寫入結果…');
      const confirmed = await vscode.window.showWarningMessage('已成功查詢 GitLab，尚未找到待確認評論的標記。請先檢查 MR，只有確認評論不存在後，才能解除待確認狀態；這次核對不會重新送出評論。',
        { modal: true }, '已確認評論不存在');
      if (confirmed !== '已確認評論不存在') { this.noteOutcome({ status: 'cancelled', effect: 'none' }); return; }
      if (scope !== this.operationScope()) throw new Error('帳號或工作區已變更，請重新核對。');
    }
    for (const item of pending) await this.savePendingMrWrite(undefined, item.key);
    this.resolveUnknownFor(resourceKey, found.length ? 'applied' : 'none');
    await this.refreshMergeRequestData(projectId, iid, 'discussions');
    this.post({ type: 'message', message: found.length ? '已在 GitLab 找到評論，完成寫入結果核對。' : '已確認評論不存在，現在可重新送出。' });
  }

  private async approveMergeRequest(projectId: number, iid: number, sha: string): Promise<void> {
    if (this.session.metadata?.enterprise !== true) throw new Error(this.session.metadata?.enterprise === false
      ? 'GitLab Community Edition 不支援 MR 核准 API。' : 'GitLab 版別尚未確認，請先重新檢查站台資料。');
    await this.resolveGroupProject(projectId);
    requireIssueIid(iid);
    const client = await this.session.getClient();
    const latest = await client.getMergeRequest(projectId, iid);
    if (!sha || latest.diff_refs?.head_sha !== sha) throw new Error('MR head SHA 已變更，請重新整理審查結果。');
    const confirm = await vscode.window.showInformationMessage(`核准 ${latest.references?.full ?? `!${iid}`}，SHA ${sha.slice(0, 12)}？`, { modal: true }, '核准');
    if (confirm !== '核准') { this.noteOutcome({ status: 'cancelled', effect: 'none' }); return; }
    await client.approveMergeRequest(projectId, iid, sha);
    this.post({ type: 'message', message: '已送出 MR 核准。' });
    this.noteOutcome({ effect: 'applied' });
    await this.reconcileAfterWrite(() => this.refreshMergeRequestData(projectId, iid, 'summary'));
  }

  private async mergeMergeRequest(projectId: number, iid: number, sha: string): Promise<void> {
    const epoch = this.session.connectionEpoch, groupId = this.session.selectedGroup?.id;
    const sameMergeScope = () => epoch === this.session.connectionEpoch && groupId === this.session.selectedGroup?.id;
    const requireMergeScope = () => { if (!sameMergeScope()) throw new Error('帳號或 Group 已變更，請重新確認。'); };
    await this.resolveGroupProject(projectId);
    requireMergeScope();
    requireIssueIid(iid);
    const client = await this.session.getClient();
    const updateAvailability = (request: GitLabMergeRequest | undefined, availability: import('../api/actionAvailability').ActionAvailability): void => {
      if (!sameMergeScope()) return;
      const selected = this.selectedMergeRequest;
      if (!selected || selected.request.project_id !== projectId || selected.request.iid !== iid) return;
      const next = request ?? selected.request;
      const sameDiff = this.mergeRequestDiffIdentity(selected.request) === this.mergeRequestDiffIdentity(next);
      this.selectedMergeRequest = { ...this.getMergeRequestDetail(next, selected, sameDiff), mergeAvailability: availability };
      this.sendSnapshot();
    };
    const readLatest = async (): Promise<GitLabMergeRequest> => {
      try { return await client.getMergeRequest(projectId, iid); }
      catch (error) { updateAvailability(undefined, { status: 'unknown', reason: '無法重新確認 MR 合併條件，請重試。' }); throw error; }
    };
    const latest = await readLatest();
    requireMergeScope();
    const availability = mergeAvailability(latest, sha);
    if (availability.status !== 'allowed') { updateAvailability(latest, availability); throw new Error(availability.reason ?? '合併條件尚未確認。'); }
    let target: Awaited<ReturnType<typeof client.getRepositoryBranch>>;
    try { target = await client.getRepositoryBranch(latest.target_project_id ?? projectId, latest.target_branch); }
    catch (error) { updateAvailability(latest, { status: 'unknown', reason: '無法確認目標分支，請重新檢查。' }); throw error; }
    requireMergeScope();
    const confirm = await vscode.window.showWarningMessage(
      `確認合併 ${latest.references?.full ?? `!${iid}`}？\n來源：${latest.source_branch}\n目標：${latest.target_branch}\n來源 SHA：${sha}\n目標最新 SHA：${target.commit.id}\nGitLab 專案規則仍會檢查 Pipeline 與合併權限。`,
      { modal: true }, '合併 MR'
    );
    if (confirm !== '合併 MR') { this.noteOutcome({ status: 'cancelled', effect: 'none' }); return; }
    requireMergeScope();
    const confirmed = await readLatest();
    requireMergeScope();
    const confirmedAvailability = mergeAvailability(confirmed, sha);
    if (confirmedAvailability.status !== 'allowed') { updateAvailability(confirmed, confirmedAvailability); throw new Error(confirmedAvailability.reason ?? '合併條件尚未確認。'); }
    if (confirmed.source_branch !== latest.source_branch || confirmed.target_branch !== latest.target_branch ||
        confirmed.source_project_id !== latest.source_project_id || confirmed.target_project_id !== latest.target_project_id) {
      updateAvailability(confirmed, { status: 'unknown', reason: 'MR 來源或目標已變更，請重新整理後再合併。' });
      throw new Error('MR 來源或目標已變更，請重新整理後再合併。');
    }
    requireMergeScope();
    await client.mergeMergeRequest(projectId, iid, sha);
    this.post({ type: 'message', message: 'GitLab 已接受 MR 合併要求。' });
    this.noteOutcome({ effect: 'applied' });
    await this.reconcileAfterWrite(() => this.refreshMergeRequestData(projectId, iid, 'summary'));
  }


  private requireGroupRoot(): string {
    if (this.projectContext?.root) return this.projectContext.root;
    if (this.groupRoot) return this.groupRoot;
    throw new Error(this.projectContext?.error ?? this.workspaceRootError ?? '請在 VS Code 開啟或選擇專案資料夾。');
  }

  private matchedGroupRepository(projectId: number, relativePath?: string): string {
    const root = this.requireGroupRoot();
    const match = this.getSkillsContext().groupMatch;
    const candidates = match.status === 'matched' && match.root && sameLocalPath(match.root, root)
      ? match.repositories.filter(repo => repo.matched && repo.projectId === projectId &&
        (relativePath === undefined || sameLocalPath(repo.path, path.join(root, relativePath)))) : [];
    if (candidates.length !== 1) throw new Error('無法唯一對應已核對的本機 Repo；請確認 project ID、remote 與實際路徑。');
    return candidates[0].path;
  }









  private pendingMrWrites(): PendingMrWrite[] {
    const entries = this.context.globalState.get<PendingMrWrite[]>(MR_WRITES_KEY, []) ?? [];
    return Array.isArray(entries) ? entries.filter((item) => item && typeof item.key === 'string' && typeof item.marker === 'string' &&
      Number.isSafeInteger(item.groupId) && Number.isSafeInteger(item.userId) && Number.isSafeInteger(item.projectId) &&
      Number.isSafeInteger(item.iid) && (item.state === 'sending' || item.state === 'uncertain')) : [];
  }

  private async savePendingMrWrite(entry: PendingMrWrite | undefined, key: string): Promise<void> {
    const groupId = this.session.selectedGroup?.id;
    const userId = this.currentUser?.id;
    const entries = this.pendingMrWrites().filter((item) => item.key !== key || item.groupId !== groupId || item.userId !== userId);
    if (entry && entries.length >= 250) throw new Error('待核對的 MR 寫入已達 250 筆，請先核對既有結果後再發布。');
    if (entry) entries.unshift(entry);
    await this.context.globalState.update(MR_WRITES_KEY, entries);
  }

  private workflowKitSource(): ToolSource {
    const source = this.context.globalState?.get<unknown>(TOOL_SOURCE_KEY);
    return source === 'gitea' ? 'gitea' : 'github';
  }

  private async assertWorkflowKitReady(): Promise<void> {
    await this.refreshWorkflowKit();
    const skills = this.getSkillsContext();
    if (!skills.root || skills.mode === 'unavailable') throw new Error(skills.reason ?? '請先選擇專案資料夾。');
    if (this.workflowKitInstallation?.root && sameLocalPath(skills.root, this.workflowKitInstallation.root)) {
      throw new Error('此專案的技能包正在安裝中，請等候完成後再執行操作。');
    }
    if (skills.installed.profile !== skills.mode || skills.installed.workspaceContract !== 2 || skills.installed.installerApi !== 1 ||
        !['installed', 'update-available'].includes(skills.installed.status)) {
      throw new Error(skills.reason ?? '請先在設定中安裝或更新目前專案的工作流程包。');
    }
  }

  private async confirmSkillsContext(revision: string, featureId: string): Promise<void> {
    await this.refreshWorkflowKit();
    const current = this.getSkillsContext();
    if (current.revision !== revision || !current.availableFeatures.includes(featureId)) {
      throw new Error('Skills 環境或版本已變更，請重新確認任務。');
    }
  }

  private async setWorkflowKitSource(source: ToolSource): Promise<void> {
    if (!['gitea', 'github'].includes(source)) throw new Error('Invalid workflow kit source.');
    await this.context.globalState.update(TOOL_SOURCE_KEY, source);
    await this.refreshWorkflowKitInstallState();
  }

  private async workflowKitHelper(root?: string): Promise<{ path: string; version: string }> {
    const identity = root ? await installedKitIdentity(root) : undefined;
    return (identity ? await this.packages.statusHelper(identity) : undefined) ?? {
      path: vscode.Uri.joinPath(this.context.extensionUri, 'resources', 'workflow-kit-status.py').fsPath,
      version: '1.0.0'
    };
  }

  private async refreshWorkflowKitReleases(source: RemoteToolSource = this.workflowKitSource()): Promise<void> {
    if (this.workflowKitCheckingRelease || this.workflowKitInstallation) throw new Error('請等候目前 WorkflowKit 操作完成。');
    const check = this.captureWorkflowKitAccess();
    this.workflowKitCheckingRelease = true;
    this.workflowKitReleases = this.workflowKitReleases.filter(item => item.source !== source);
    this.sendSnapshot();
    try {
      this.operationPhase('checkWorkflowKitReleases', '正在查詢最新正式版…');
      let releases: WorkflowKitRelease[];
      const identity = this.workflowKitInstallTarget.root ? await installedKitIdentity(this.workflowKitInstallTarget.root) : undefined;
      try {
        releases = await this.packages.refresh(source, undefined, identity?.source === source ? identity.version : undefined);
        const installedRelease = identity?.source === source ? releases.find(item => item.version === identity.version && item.descriptor.statusApi === 1 && item.descriptor.installerApi === 1) : undefined;
        if (installedRelease) await this.packages.prepareStatusVerifier(installedRelease.id, check);
      }
      catch (error) {
        if (error instanceof PackageIntegrityError) throw error;
        releases = await this.packages.useCached(source);
        if (!releases.length) throw error;
        this.post({ type: 'message', message: `無法查詢線上 Release（${readableError(error)}），顯示同一來源已驗證的完整快取。` });
      }
      check();
      // Release discovery must not change the verifier for the installed kit.
      if (this.projectContext?.root) await this.workflowKitStatusReads.get(localPathKey(this.projectContext.root));
      check();
      this.workflowKitInstallRefreshGeneration++;
      this.workflowKitInstallRefreshTask = undefined;
      await this.refreshWorkflowKitInstallState();
      if (!releases.length) this.post({ type: 'message', message: `${source === 'github' ? 'GitHub' : 'Gitea'} 目前沒有正式 WorkflowKit Release。` });
    } finally { this.workflowKitCheckingRelease = false; this.sendSnapshot(); }
  }

  private getWorkflowKitPolicy(): WorkflowKitPolicy {
    return workflowKitPolicy({ profile: this.workflowKitInstallTarget?.root && this.workflowKitInstallTarget.root === this.projectContext?.root
      ? this.workflowKitInstallTarget.profile : this.workspaceMatch?.profile,
      workspaceChanging: this.pendingWorkspaceRefresh,
      hasWorkspace: !!vscode.workspace.workspaceFolders?.length });
  }

  /** Pin the selected project and its settings across dialogs and queued helpers. */
  private captureWorkflowKitAccess(groupScoped = false): () => void {
    const signature = () => JSON.stringify([this.projectContextSignature(), this.workspaceFoldersGeneration,
      this.session.connectionEpoch, groupScoped ? this.session.selectedGroup?.id : undefined]);
    const expected = signature();
    const check = () => {
      if (this.accountTransitionBusy) throw new Error('帳號正在驗證或切換，請稍後再操作。');
      if (signature() !== expected) throw new Error('專案根目錄或帳號已變更，請重新執行操作。');
    };
    check(); return check;
  }

  private async runWorkflowKitHelper(args: string[], timeout = 10 * 60_000, beforeLaunch?: () => void | Promise<void>, installerPath?: string): Promise<Record<string, unknown>> {
    const previous = this.workflowKitHelperQueue;
    let release!: () => void;
    this.workflowKitHelperQueue = new Promise<void>(resolve => { release = resolve; });
    try {
      if (previous) this.operationPhase('', '等待目前 Skills 檢查完成…');
      await previous;
      this.operationPhase('', '正在準備 Skills 執行環境…');
      const pythonPath = vscode.workspace.getConfiguration('gitlabWorkspace').get<string>('pythonPath', 'python');
      const python = await resolvePythonRuntime(pythonPath);
      await beforeLaunch?.();
      this.operationPhase('', args[0] === 'install' ? '正在安裝 Skills…' : args[0] === 'inspect' ? '正在驗證工作流程包…' : '正在檢查 Skills 安裝狀態…');
      const helper = installerPath ? { path: installerPath, version: '' } : await this.workflowKitHelper(args[0] === 'status' ? args[1] : undefined);
      if (args[0] === 'status') {
        const index = args.indexOf('--expected-version');
        args = index >= 0 ? [...args.slice(0, index + 1), helper.version, ...args.slice(index + 2)]
          : [...args, '--expected-version', helper.version];
      }
      const result = await execFileAsync(python.executable, [...python.args, helper.path, ...args], {
        cwd: this.context.extensionUri.fsPath, env: python.env, timeout, maxBuffer: 1024 * 1024, windowsHide: true
      }).catch((error: unknown) => {
        const stdout = error && typeof error === 'object' && 'stdout' in error && typeof error.stdout === 'string' ? error.stdout : '';
        const stderr = error && typeof error === 'object' && 'stderr' in error && typeof error.stderr === 'string' ? error.stderr : '';
        throw workflowKitFailure(stdout) ?? workflowKitFailure(stderr) ?? error;
      });
      const value = parseLastJsonLine(result.stdout) as Record<string, unknown>;
      if (value.ok !== true) throw workflowKitFailure(result.stdout) ?? new Error('Workflow kit operation was not confirmed.');
      return value;
    } finally { release(); }
  }

  private readWorkflowKitState(root: string): Promise<InstalledWorkflowKitState> {
    if (this.workflowKitInstallation?.root && sameLocalPath(root, this.workflowKitInstallation.root)) {
      return Promise.resolve({ status: 'installing' });
    }
    const key = localPathKey(root);
    const pending = this.workflowKitStatusReads.get(key);
    if (pending) return pending;
    const task = (async (): Promise<InstalledWorkflowKitState> => {
      try {
        const response = await this.runWorkflowKitHelper(['status', root], 60_000);
        const identity = await installedKitIdentity(root);
        if (identity && (response.status === 'installed' || response.status === 'update-available') &&
            (response.version !== identity.version || response.source !== identity.source)) throw new Error('安裝紀錄在檢查期間已變更，請重新檢查。');
        const valid = ['installed', 'missing', 'update-available', 'needs-cleanup', 'error'].includes(String(response.status));
        return valid ? {
          status: response.status === 'update-available' ? 'installed' : response.status as InstalledWorkflowKitState['status'],
          profile: response.profile === 'group' || response.profile === 'repository' ? response.profile : undefined,
          upstreamVersions: response.upstreamVersions && typeof response.upstreamVersions === 'object' ? response.upstreamVersions as Record<string, string> : undefined,
          capabilities: Array.isArray(response.capabilities) ? response.capabilities.filter((item): item is string => typeof item === 'string') : [],
          bmadMode: response.bmadMode === 'bundled' || response.bmadMode === 'external' ? response.bmadMode : undefined,
          warnings: workflowKitWarnings(response.warnings),

          workspaceContract: typeof response.workspaceContract === 'number' ? response.workspaceContract : undefined,
          installerApi: typeof response.installerApi === 'number' ? response.installerApi : undefined,
          statusContract: typeof response.statusContract === 'number' ? response.statusContract : undefined,
          integrity: response.integrity === 'verified' || response.integrity === 'missing' || response.integrity === 'unknown' || response.integrity === 'unverified'
            ? response.integrity : ['installed', 'update-available'].includes(String(response.status)) ? 'verified' : 'unverified',
          interfaceCompatibility: response.workspaceContract === 2 && response.installerApi === 1 ? 'compatible' :
            typeof response.workspaceContract === 'number' && typeof response.installerApi === 'number' ? 'incompatible' : 'unknown',
          version: typeof response.version === 'string' ? response.version : undefined,
          source: response.source === 'bundled' || response.source === 'gitea' || response.source === 'github' ? response.source : undefined,
          message: typeof response.message === 'string' ? response.message : undefined,
          legacyPaths: Array.isArray(response.legacyPaths) ? response.legacyPaths.filter((item): item is string => typeof item === 'string') : undefined
        } : { status: 'error', message: 'Workflow kit status response is invalid.' };
      } catch (error) {
        return { status: 'error', message: readableError(error) };
      }
    })();
    this.workflowKitStatusReads.set(key, task);
    void task.finally(() => {
      if (this.workflowKitStatusReads.get(key) === task) this.workflowKitStatusReads.delete(key);
    });
    return task;
  }

  private refreshWorkflowKit(publish = true, signal?: AbortSignal): Promise<void> {
    const signature = this.projectContextSignature(), projects = this.projects, installation = this.workflowKitInstallation;
    const pending = this.workflowKitRefreshTask;
    if (pending && pending.signature === signature && pending.installation === installation && !pending.signal?.aborted) return pending.task;
    const task = this.refreshWorkflowKitNow(publish, signal);
    const entry = { signature, projects, installation, signal, task };
    this.workflowKitRefreshTask = entry;
    void task.finally(() => { if (this.workflowKitRefreshTask === entry) this.workflowKitRefreshTask = undefined; }).catch(() => undefined);
    return task;
  }

  private async refreshWorkflowKitNow(publish = true, signal?: AbortSignal): Promise<void> {
    const generation = ++this.workflowKitRefreshGeneration;
    const environmentGeneration = ++this.skillsEnvironmentGeneration;
    const signature = this.projectContextSignature();
    const installation = this.workflowKitInstallation;
    const current = () => !signal?.aborted && !this.disposed && generation === this.workflowKitRefreshGeneration && environmentGeneration === this.skillsEnvironmentGeneration &&
      signature === this.projectContextSignature() && installation === this.workflowKitInstallation;
    const context = await this.resolveProjectContext();
    const match = context.root ? await this.inspectEnvironmentSnapshot(context.root, [], signal)
      : { status: 'unverified' as const, reason: context.error, repositories: [] };
    if (!current()) return;
    this.projectContext = context; this.workspaceMatch = match;
    this.groupRoot = context.root; this.workspaceRootError = context.error ?? match.reason;
    this.cloneRoot = context.root; this.cloneRootError = context.error; this.cloneRootManual = context.manual;
    this.cloneRootScope = this.connectedScopeKey();
    void this.watchRepositoryRemotes(signal);
    await this.refreshWorkflowKitInstallState(publish, signal, { context, checked: context.root ? {
      root: context.root, profile: match.profile, error: context.error ?? (match.status === 'error' ? match.reason : undefined),
      remoteFingerprint: match.repositories.find(repo => sameLocalPath(repo.path, context.root!))?.remoteFingerprint
    } : undefined });
    if (!current()) return;
    if (this.activeMode === 'bmad' && this.panel?.visible !== false && this.webviewReady) {
      void this.refreshBmadWorkflow().catch(error => this.post({ type: 'error', message: readableError(error) }));
    }
  }

  /** Settings and installation need only the selected target, never its child repositories. */
  private refreshWorkflowKitInstallState(publish = true, signal?: AbortSignal,
    prepared?: { context: ProjectRootContext; checked: Awaited<ReturnType<typeof inspectWorkflowKitInstallRoot>> | undefined }): Promise<void> {
    const signature = this.projectContextSignature(), installation = this.workflowKitInstallation;
    const pending = this.workflowKitInstallRefreshTask;
    // Unowned settings/install reads can serve a view; a view-owned abort cannot own them.
    if (pending && pending.signature === signature && pending.installation === installation &&
        (!pending.signal || pending.signal === signal) && !pending.signal?.aborted) return pending.task;
    const task = this.refreshWorkflowKitInstallStateNow(publish, signal, prepared);
    const entry = { signature, installation, signal, task };
    this.workflowKitInstallRefreshTask = entry;
    void task.finally(() => { if (this.workflowKitInstallRefreshTask === entry) this.workflowKitInstallRefreshTask = undefined; }).catch(() => undefined);
    return task;
  }

  private async refreshWorkflowKitInstallStateNow(publish = true, signal?: AbortSignal,
    prepared?: { context: ProjectRootContext; checked: Awaited<ReturnType<typeof inspectWorkflowKitInstallRoot>> | undefined }): Promise<void> {
    const generation = this.workflowKitInstallRefreshGeneration = (this.workflowKitInstallRefreshGeneration ?? 0) + 1;
    const signature = this.projectContextSignature(), installation = this.workflowKitInstallation;
    const current = () => !signal?.aborted && !this.disposed && generation === this.workflowKitInstallRefreshGeneration &&
      signature === this.projectContextSignature() && installation === this.workflowKitInstallation;
    const context = prepared?.context ?? await this.resolveProjectContext();
    const checked = prepared ? prepared.checked
      : context.root && !context.error ? await inspectWorkflowKitInstallRoot(context.root, signal) : undefined;
    if (!current()) return;
    if (context.folders.length === 1 && this.context.workspaceState.get<string>(PROJECT_FOLDER_KEY) !== context.selectedFolderUri) {
      await this.context.workspaceState.update(PROJECT_FOLDER_KEY, context.selectedFolderUri);
      if (!current()) return;
    }
    // Never combine a previous project's repository mapping with a newly selected root/profile.
    if (this.projectContext?.revision !== context.revision ||
        this.workspaceMatch?.root && (!context.root || !sameLocalPath(this.workspaceMatch.root, context.root)) ||
        this.workspaceMatch?.profile && this.workspaceMatch.profile !== checked?.profile) {
      this.workspaceMatch = { status: 'unverified', root: context.root, repositories: [], reason: context.error ?? checked?.error };
    }
    this.projectContext = context;
    this.groupRoot = context.root; this.workspaceRootError = context.error ?? checked?.error;
    this.cloneRoot = context.root; this.cloneRootError = context.error; this.cloneRootManual = context.manual;
    this.cloneRootScope = this.connectedScopeKey();
    const target: WorkflowKitInstallTarget = installation ?? { root: context.root, manual: context.manual,
      profile: checked?.profile, error: context.error ?? checked?.error,
      state: { status: context.root ? 'checking' : 'missing' } };
    this.workflowKitInstallIdentity = { revision: context.revision, root: context.root,
      profile: checked?.profile, remoteFingerprint: checked?.remoteFingerprint };
    const sameRoot = this.skillsWorkflowKitStateRoot === context.root;
    this.workflowKitInstallTarget = target;
    this.workflowKitStateRoot = context.root; this.skillsWorkflowKitStateRoot = context.root;
    if (!sameRoot || !this.skillsWorkflowKitState || this.skillsWorkflowKitState.status === 'missing') this.workflowKitState = this.skillsWorkflowKitState = { status: context.root ? 'checking' : 'missing' };
    if (publish) this.sendSnapshot();
    const [packages, checkedState] = await Promise.all([this.packages.listReleases(),
      context.root && !target.error ? this.readWorkflowKitState(context.root) : Promise.resolve<InstalledWorkflowKitState>({ status: 'missing' })]);
    if (!current()) return;
    const latestCompatible = packages.find(item => item.source === this.workflowKitSource() && item.available);
    const installWarnings = this.workflowKitInstallWarnings;
    const state: InstalledWorkflowKitState = { ...checkedState,
      warnings: installWarnings && context.root && sameLocalPath(installWarnings.root, context.root) && installWarnings.version === checkedState.version
        ? [...new Set([...(checkedState.warnings ?? []), ...installWarnings.warnings])] : checkedState.warnings,
      updateAvailable: checkedState.version && latestCompatible
      ? compareVersions(latestCompatible.version, checkedState.version) > 0 : undefined };
    this.workflowKitReleases = packages;
    this.workflowKitState = this.skillsWorkflowKitState = state;
    const requestId = this.operationContext.getStore();
    const operation = requestId ? this.operations.get(requestId) : undefined;
    if (state.status === 'error' && operation?.action === 'refreshWorkflowKit') this.noteOutcome({ status: 'failed', error: state.message ?? 'Skills 狀態檢查失敗。' });
    else if (state.status === 'error' && operation?.effect === 'applied') this.noteOutcome({ refreshError: state.message ?? 'Skills 已更新，但狀態檢查失敗。' });
    this.workflowKitInstallTarget = { ...target, state };
    if (!current()) return;
    if (publish) this.sendSnapshot();
    if (context.root && state.bmadMode) void this.refreshBmadEnvironment(context.root);
  }

  private async selectWorkflowKitInstallRoot(): Promise<void> {
    await this.selectProjectRoot();
  }

  private async resetWorkflowKitInstallRoot(): Promise<void> {
    await this.selectProjectRoot(true);
  }

  private async openWorkflowKitDownload(source: RemoteToolSource): Promise<void> {
    if (source !== 'gitea' && source !== 'github') throw new Error('Invalid download source.');
    this.captureWorkflowKitAccess()();
    await vscode.env.openExternal(vscode.Uri.parse(WORKFLOW_KIT_RELEASES[source]));
  }

  private async installWorkflowKit(releaseId: string): Promise<void> {
    if (typeof releaseId !== 'string' || !releaseId) throw new Error('Select a workflow kit version first.');
    if (this.repositoryOperationInProgress || this.workflowKitInstallation || this.workflowKitSelectingRoot || this.workflowKitCheckingRelease) throw new Error('目前有技能包操作正在進行，請等候完成。');
    this.operationPhase('installWorkflowKit', '正在核對安裝位置與 Skills…');
    await this.refreshWorkflowKitInstallState();
    const checkAccess = this.captureWorkflowKitAccess();
    if (this.repositoryOperationInProgress || this.workflowKitInstallation || this.workflowKitSelectingRoot || this.workflowKitCheckingRelease) throw new Error('目前有技能包操作正在進行，請等候完成。');
    const target = this.workflowKitInstallTarget;
    if (!target.root || target.error) throw new Error(target.error ?? '請先選擇技能包安裝資料夾。');
    if (this.busy && !this.refreshTask || ['checking', 'installing', 'needs-cleanup'].includes(target.state.status)) {
      throw new Error(target.state.message ?? '請等候檢查完成，或先處理目前安裝位置的工作與衝突。');
    }
    const root = target.root;
    const profile = target.profile ?? 'repository';
    const identity = this.workflowKitInstallIdentity;
    this.workflowKitInstallation = { ...target, state: { ...target.state, status: 'installing' } };
    this.workflowKitRefreshGeneration++;
    this.workflowKitInstallRefreshGeneration = (this.workflowKitInstallRefreshGeneration ?? 0) + 1;
    this.workflowKitInstallTarget = this.workflowKitInstallation;
    if (this.groupRoot && sameLocalPath(root, this.groupRoot)) this.workflowKitState = { status: 'installing' };
    this.sendSnapshot();
    try {
      // A status check may hold the same filesystem lock; let it finish before installing.
      this.operationPhase('installWorkflowKit', '等待目前 Skills 檢查完成…');
      await this.workflowKitStatusReads.get(localPathKey(root));
      this.operationPhase('installWorkflowKit', '正在驗證安裝目錄與工作流程包…');
      const validation = await resolveWorkflowKitInstallRoot(root, undefined, []);
      if (validation.error) throw new Error(validation.error);
      if (!validation.root || !sameLocalPath(root, validation.root)) throw new Error('安裝位置已變更，請重新檢查或選擇資料夾。');
      const selected = await this.packages.getRelease(releaseId, checkAccess, message => this.operationPhase('installWorkflowKit', message));
      checkAccess();
      if (target.state.version && compareVersions(selected.version, target.state.version) < 0) throw new Error('已安裝版本較新，不會降級 WorkflowKit。');
      const beforeLaunch = async () => {
        checkAccess();
        const context = await this.resolveProjectContext();
        if (context.error || context.revision !== identity?.revision || !context.root || !sameLocalPath(context.root, root)) {
          throw new Error(context.error ?? '工作區或安裝位置已變更，請重新確認安裝。');
        }
        const location = await resolveWorkflowKitInstallRoot(root, undefined, []);
        if (location.error || !location.root || !sameLocalPath(location.root, root)) throw new Error(location.error ?? '安裝位置已變更，請重新選擇資料夾。');
        const checked = await inspectWorkflowKitInstallRoot(root);
        if (checked.error || !checked.root || !sameLocalPath(checked.root, root) || checked.profile !== profile) {
          throw new Error(checked.error ?? '安裝資料夾位置或類型已變更，請重新檢查安裝。');
        }
        if (profile === 'repository' && checked.remoteFingerprint !== identity?.remoteFingerprint) {
          throw new Error('Repo remote 已變更，請重新確認安裝。');
        }
        checkAccess();
      };
      try {
        const result = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification,
          title: `Install GitLab Workspace kit v${selected.version}`, cancellable: false }, async () =>
          this.runWorkflowKitHelper(['install', selected.archivePath, root, selected.version, selected.source,
            '--format', selected.format, '--entry-root', selected.entryRoot, '--archive-sha256', selected.sha256, '--profile', profile], undefined, beforeLaunch, selected.installerPath));
        if (result.package !== 'gitlab-workspace-kit' || result.version !== selected.version || result.profile !== profile) throw new Error('安裝工具回傳的套件資訊不符。');
        const warnings = workflowKitWarnings(result.warnings);
        this.workflowKitInstallWarnings = { root, version: selected.version, warnings };
        if (warnings.length) this.post({ type: 'message', message: `WorkflowKit 安裝成功：${warnings.join(' ')}` });
      } catch (error) {
        const source = selected.source === 'github' ? 'GitHub' : selected.source === 'gitea' ? 'Gitea' : 'WorkflowKit';
        throw new Error(`${source} Release v${selected.version}：${readableError(error)}`, { cause: error });
      }
      this.noteOutcome({ effect: 'applied' });
      this.post({ type: 'message', message: `GitLab Workspace kit v${selected.version} installed in ${root}.` });
    } catch (error) {
      this.workflowKitInstallTarget = { ...target, state: { status: 'error', message: readableError(error) } };
      this.sendSnapshot();
      throw error;
    } finally {
      this.workflowKitInstallation = undefined;
      await this.reconcileAfterWrite(() => this.refreshWorkflowKitInstallState());
      if (this.activeMode === 'bmad') await this.refreshBmadWorkflow(true);
    }
  }

  private instanceUserScope(): string | undefined {
    return this.session.baseUrl && this.currentUser
      ? createHash('sha256').update(`${this.session.baseUrl}\0${this.currentUser.id}`).digest('hex').slice(0, 24)
      : undefined;
  }

  private publishTimers(): void {
    const instanceUserScope = this.instanceUserScope();
    if (!instanceUserScope) return;
    this.timerVersion++;
    this.post({ type: 'timersChanged', instanceUserScope, version: this.timerVersion, timers: this.timer.list() });
  }

  private syncTimerPolling(): void {
    const running = this.timer.list().some((entry) => entry.phase === 'running');
    if (running && !this.interval) {
      this.interval = setInterval(() => { void this.onTick(); }, 1000);
    } else if (!running && this.interval) {
      clearInterval(this.interval);
      this.interval = undefined;
    }
  }

  private async onTick(): Promise<void> {
    if (this.timerTickInFlight) return;
    this.timerTickInFlight = true;
    try {
      const changed = await this.enqueueTimer(() => this.timer.tick());
      if (changed) this.publishTimers();
    } catch (error) { this.post({ type: 'error', message: readableError(error) }); }
    finally {
      this.timerTickInFlight = false;
      this.syncTimerPolling();
    }
  }

  private enqueueTimer<T>(action: () => Promise<T>): Promise<T> {
    const operation = this.timerQueue.then(action, action);
    this.timerQueue = operation.then(() => undefined, () => undefined);
    return operation;
  }

  private selectedIssueKey(): string {
    const scope = `${this.session.baseUrl ?? ''}\0${this.currentUser?.id ?? 0}\0${this.session.selectedGroup?.id ?? 0}`;
    return `gitlabWorkspace.selectedIssue.${createHash('sha256').update(scope).digest('hex').slice(0, 24)}`;
  }

  private selectedMergeRequestKey(): string {
    const scope = `${this.session.baseUrl ?? ''}\0${this.currentUser?.id ?? 0}\0${this.session.selectedGroup?.id ?? 0}`;
    return `gitlabWorkspace.selectedMergeRequest.${createHash('sha256').update(scope).digest('hex').slice(0, 24)}`;
  }

  private requireGroupProject(projectId: number): GitLabProject {
    const project = this.projects.find((item) => item.id === projectId);
    if (!project) throw new Error('此 Project 不屬於目前選取的 GitLab Group。');
    return project;
  }

  /** An explicit selection may refer to a project beyond the loaded inventory page. */
  private async resolveGroupProject(projectId: number, signal?: AbortSignal): Promise<GitLabProject> {
    const existing = this.projects.find(project => project.id === projectId);
    if (existing) return existing;
    const group = this.session.selectedGroup, scope = this.connectedScopeKey();
    const referenced = this.issues.some(issue => issue.project_id === projectId) || this.mergeRequests.some(request => request.project_id === projectId) ||
      this.issueGraph?.nodes.some(node => node.projectId === projectId && node.namespacePath.startsWith(`${group?.full_path}/`));
    if (!group || !scope || !Number.isSafeInteger(projectId) || !referenced) return this.requireGroupProject(projectId);
    const project = await this.session.cachedRead(`project/${projectId}/details`, client => client.getProject(projectId), { signal });
    if (signal?.aborted || scope !== this.connectedScopeKey()) throw Object.assign(new Error('工作區已變更，請重新選擇。'), { name: 'AbortError' });
    if (project.id !== projectId || !project.path_with_namespace.startsWith(`${group.full_path}/`)) throw new Error('此 Project 不屬於目前選取的 GitLab Group。');
    if (!this.projects.some(item => item.id === project.id)) this.projects = [...this.projects, project];
    return project;
  }
}

function gitLabGlobalIdNumber(value: string | number | null | undefined): number | undefined {
  if (typeof value === 'number') return Number.isSafeInteger(value) && value > 0 ? value : undefined;
  const match = typeof value === 'string' ? value.match(/(?:^|\/)(\d+)$/) : undefined;
  const id = match ? Number(match[1]) : NaN;
  return Number.isSafeInteger(id) && id > 0 ? id : undefined;
}

async function exists(target: string): Promise<boolean> {
  try { await access(target); return true; } catch { return false; }
}

function requireIssueIid(value: number): void {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error('Issue／MR IID 格式無效。');
}

async function git(cwd: string, args: string[], options: { maxBuffer?: number; env?: NodeJS.ProcessEnv } = {}): Promise<string> {
  const result = await logGitCommand(args, cwd, () => execFileAsync('git', args, { cwd, env: options.env, windowsHide: true, timeout: 60_000, maxBuffer: options.maxBuffer ?? 2 * 1024 * 1024, encoding: 'utf8' }));
  return result.stdout;
}



function checkedText(value: string, label: string, max: number): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\0\r]/.test(value)) throw new Error(`${label} 請填寫 1 到 ${max} 個字元。`);
  return value.trim();
}

function readableError(error: unknown): string {
  if (error instanceof Error) return error.message.replace(/https?:\/\/\S+/g, '[網址]').slice(0, 2000);
  return '操作失敗，請稍後重試。';
}

function parseLastJsonLine(output: string): Record<string, unknown> {
  for (const line of output.trim().split(/\r?\n/).reverse()) {
    try {
      const value: unknown = JSON.parse(line);
      if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
    } catch { /* skip non-JSON installer output */ }
  }
  throw new Error('工具檢查器沒有回傳可驗證的 JSON 結果。');
}
