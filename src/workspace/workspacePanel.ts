import * as vscode from 'vscode';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { access, readFile, writeFile, mkdir, mkdtemp, unlink, rmdir, readdir, lstat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { GitLabApiError, type GitLabClient } from '../api/gitLabClient';
import type { GitLabGraphWorkItem, GitLabGroup, GitLabIssue, GitLabIssueBoard, GitLabMergeRequest, GitLabMilestone, GitLabProject, GitLabUser } from '../api/types';
import type { IssueFormOptions } from '../issues/protocol';
import type { IssuePanels } from '../issues/issuePanel';
import { cloneProjects, createScopedGitEnvironment, projectRemoteMatches, syncLocalDefaultBranches } from '../git/cloneService';
import { GroupWorkspaceRegistry, groupRepositoryPath, localRepositoryState, localRepositoryStateAsync, projectFolderNames, sameRealLocalPath } from './workspacePaths';
import { resolvePythonRuntime } from './pythonRuntime';
import { windowsCodexTerminalOptions } from './windowsTerminal';
import { IssueTimeTracker, gitLabDuration } from './timeTracker';
import { parseMeginHandoff, type MeginHandoff } from './meginHandoff';
import { parseMergeReviewReport, validateReportIdentity, type MergeReviewIdentity } from './mergeReviewReport';
import { issueGraphEdge, issueGraphNodeKey, mapWithConcurrency, type IssueGraphNode, type IssueGraphSnapshot } from './issueGraph';
import { buildIssueDraftDescription, buildPostDeliveryWikiUpdatePrompt, buildReviewerPrompt, containsIssueDraftMarker, matchDraftProject, parseIssueDraftBundle } from './issueDrafts';
import { WorkflowKitPackageManager, WORKFLOW_KIT_RELEASES, TOOL_SOURCE_KEY } from './toolPackages';
import type {
  BranchFreshness, DeliveryPreview, DraftIssueResult, InstalledWorkflowKitState, IssueDetailTab, IssueDraft,
  CloneOperationState, IssueNavigation, MergeRequestDetail, MeginWorkSummary, RemoteToolSource, ToolSource, WorkspaceMode, WorkspaceRequest, WorkspaceSnapshot, WorkspaceTimerEntry
} from './workspaceProtocol';
import type { WorkflowKitPackage } from './toolPackages';
import type { GitLabSession } from '../connection/session';
import { isAllowedGitRemote } from '../api/urlPolicy';

const execFileAsync = promisify(execFile);
const SELECTED_MODE_KEY = 'gitlabWorkspace.workspace.mode';
const DELIVERIES_KEY = 'gitlabWorkspace.deliveryRecords.v1';
const MR_WRITES_KEY = 'gitlabWorkspace.pendingMrWrites.v1';
const MAX_DIFF_BYTES = 320_000;
const ALLOWED_MODES = new Set<WorkspaceMode>(['clone', 'sa', 'developer', 'reviewer']);

interface DeliveryRecord extends DeliveryPreview { groupId: number; userId: number; instanceScope?: string; }
interface PendingMrWrite { key: string; marker: string; groupId: number; userId: number; projectId: number; iid: number; discussionId?: string; state: 'sending' | 'uncertain'; }

export class WorkspacePanel implements vscode.Disposable {
  private panel?: vscode.WebviewPanel;
  private readonly roots: GroupWorkspaceRegistry;
  private readonly timer: IssueTimeTracker;
  private readonly packages: WorkflowKitPackageManager;
  private interval?: NodeJS.Timeout;
  private timerVersion = 0;
  private issueGraphVersion = 0;
  private timerTickInFlight = false;
  private localRepositoryStates: WorkspaceSnapshot['localRepositories'] = {};
  private localRepositoriesKey?: string;
  private localRepositoryScanGeneration = 0;
  private groups: WorkspaceSnapshot['groups'] = [];
  private projects: GitLabProject[] = [];
  private groupMilestones: GitLabMilestone[] = [];
  private groupMilestonesError?: string;
  private groupIssueBoards: GitLabIssueBoard[] = [];
  private groupIssueBoardsError?: string;
  private selectedIssueBoardId?: number;
  private issueBoardContent?: WorkspaceSnapshot['issueBoardContent'];
  private issueBoardGeneration = 0;
  private issueBoardAbort?: AbortController;
  private issueGraph?: IssueGraphSnapshot;
  private issueGraphGeneration = 0;
  private issueGraphAbort?: AbortController;
  private issueGraphPublishTimer?: NodeJS.Timeout;
  private issueGraphRequestedScope?: string;
  private issues: GitLabIssue[] = [];
  private mergeRequests: GitLabMergeRequest[] = [];
  private selectedIssue?: WorkspaceSnapshot['selectedIssue'];
  private projectMembers: WorkspaceSnapshot['projectMembers'] = [];
  private selectedMergeRequest?: MergeRequestDetail;
  private mergeRequestGeneration = 0;
  private mergeRequestAbort?: AbortController;
  private readonly mrWritesInFlight = new Set<string>();
  private selectedProjectId?: number;
  private activeMode: WorkspaceMode;
  private currentUser?: GitLabUser;
  private workflowKitState: InstalledWorkflowKitState = { status: 'missing' };
  private workflowKitPackages: WorkflowKitPackage[] = [];
  private meginWorkItems: MeginWorkSummary[] = [];
  private busy = false;
  private repositoryOperationInProgress = false;
  private workspaceSelectionInProgress = false;
  private cloneOperation?: CloneOperationState;
  private webviewReady = false;
  private readonly cloneSelectionWaiters = new Map<string, { resolve: (projectIds: number[]) => void; timeout: NodeJS.Timeout }>();
  private requestGeneration = 0;
  private refreshScopeKey?: string;
  private refreshTask?: Promise<void>;
  private refreshAbort?: AbortController;
  private issueOpenGeneration = 0;
  private issueOpenAbort?: AbortController;
  private loadedScopeKey?: string;
  private disposed = false;
  private timerQueue: Promise<unknown> = Promise.resolve();
  private issuePublishQueue: Promise<unknown> = Promise.resolve();
  private readonly issueRelationWritesInFlight = new Set<string>();

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly session: GitLabSession,
    private readonly issuePanels: IssuePanels,
    private readonly syncSidebarState?: () => void | Promise<void>
  ) {
    this.roots = new GroupWorkspaceRegistry(context.globalState);
    this.timer = new IssueTimeTracker(context.globalState);
    const savedToolSource = context.globalState.get<unknown>(TOOL_SOURCE_KEY);
    if (savedToolSource !== 'gitea' && savedToolSource !== 'github' && savedToolSource !== 'bundled') {
      void Promise.resolve(context.globalState.update(TOOL_SOURCE_KEY, 'bundled')).catch(() => undefined);
    }
    const offlineRoot = vscode.Uri.joinPath(context.extensionUri, 'resources', 'offline-tools');
    this.packages = new WorkflowKitPackageManager(
      context.globalStorageUri.fsPath,
      vscode.Uri.joinPath(offlineRoot, 'workflow-kit.tar.xz').fsPath,
      vscode.Uri.joinPath(offlineRoot, 'manifest.json').fsPath,
      String(context.extension.packageJSON.version)
    );
    this.activeMode = context.globalState.get<WorkspaceMode>(SELECTED_MODE_KEY, 'developer');
    this.issuePanels.setWorkspace({
      post: (message) => this.post(message),
      show: () => this.show('developer'),
      navigate: (navigation) => { if (navigation) this.activeMode = 'developer'; this.post({ type: 'issueNavigation', navigation }); }
    });
  }

  dispose(): void {
    this.disposed = true;
    this.issueGraphGeneration++;
    this.issueGraphAbort?.abort();
    this.issueBoardAbort?.abort();
    this.mergeRequestAbort?.abort();
    this.issueOpenAbort?.abort();
    if (this.issueGraphPublishTimer) clearTimeout(this.issueGraphPublishTimer);
    this.localRepositoryScanGeneration++;
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

  async show(mode?: WorkspaceMode): Promise<void> {
    if (mode && ALLOWED_MODES.has(mode)) this.activeMode = mode;
    const assetRoot = vscode.Uri.joinPath(this.context.extensionUri, 'resources', 'issue-webview');
    if (!this.panel) {
      const panel = vscode.window.createWebviewPanel('gitlabWorkspace.dashboard', 'GitLab Workspace', vscode.ViewColumn.Active, {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [assetRoot]
      });
      this.panel = panel;
      this.webviewReady = false;
      const nonce = randomBytes(16).toString('base64');
      const htmlPath = vscode.Uri.joinPath(assetRoot, 'dashboard.html');
      let html = await readFile(htmlPath.fsPath, 'utf8');
      const base = panel.webview.asWebviewUri(assetRoot).toString().replace(/\/$/, '') + '/';
      html = html.replace('<head>', `<head><base href="${base}"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${panel.webview.cspSource} data: https:; style-src ${panel.webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}' ${panel.webview.cspSource}; font-src ${panel.webview.cspSource};">`);
      html = html.replace(/<script([^>]*)>/, `<script nonce="${nonce}"$1>`);
      panel.webview.html = html;
      const messageListener = panel.webview.onDidReceiveMessage((message: unknown) => {
        void this.handleMessage(message).catch((error: unknown) => this.post({ type: 'error', message: readableError(error) }));
      });
      panel.onDidDispose(() => { messageListener.dispose(); if (this.panel === panel) { this.panel = undefined; this.webviewReady = false; } });
    } else {
      this.panel.reveal(vscode.ViewColumn.Active);
    }
    if (this.webviewReady) await this.refresh({ forceRepositories: true });
  }

  async navigateTo(mode?: WorkspaceMode): Promise<void> {
    this.issueOpenGeneration++;
    this.issuePanels.close();
    if (mode && ALLOWED_MODES.has(mode)) {
      this.activeMode = mode;
      await this.context.globalState.update(SELECTED_MODE_KEY, mode);
    }
    await this.show();
  }

  async refreshFromSidebar(): Promise<void> {
    this.issueOpenGeneration++;
    await this.refresh({ forceNetwork: true, forceRepositories: true });
    await this.syncSidebarState?.();
  }

  async selectGroupFromSidebar(group?: GitLabGroup): Promise<void> {
    await this.selectGroup(group?.id);
  }

  async disconnectFromSidebar(): Promise<void> {
    await this.disconnect();
  }

  async connectFromSidebar(): Promise<void> {
    await this.connect();
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
        if (!picks?.length) return;
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
    if (this.panel) void this.panel.webview.postMessage(message);
  }

  private async handleMessage(value: unknown): Promise<void> {
    if (!value || typeof value !== 'object' || !('type' in value) || typeof value.type !== 'string') return;
    const request = value as WorkspaceRequest;
    switch (request.type) {
      case 'ready': this.webviewReady = true; await this.refresh({ forceRepositories: true }); break;
      case 'refresh': await this.refresh({ forceNetwork: true, forceRepositories: true }); break;
      case 'setMode':
        if (!ALLOWED_MODES.has(request.mode)) return;
        this.activeMode = request.mode;
        await this.context.globalState.update(SELECTED_MODE_KEY, request.mode);
        this.sendSnapshot();
        break;
      case 'issueRequest':
        try { await this.issuePanels.handle(request.request, request.revision); }
        catch (error) { this.post({ type: 'issueResponse', revision: request.revision, response: { type: 'error', message: readableError(error) } }); }
        break;
      case 'closeIssue': this.issueOpenGeneration++; this.issueOpenAbort?.abort(); this.issuePanels.close(); break;
      case 'connect': await this.connect(); break;
      case 'disconnect': await this.disconnect(); break;
      case 'selectGroup': await this.selectGroup(request.groupId); break;
      case 'selectIssueBoard': await this.selectIssueBoard(request.boardId, request.connectedScope); break;
      case 'loadIssueGraph': await this.loadIssueGraph(request.connectedScope); break;
      case 'loadIssueRelations': {
        const connectedScope = request.connectedScope;
        try {
          const data = await this.issuePanels.loadIssueRelations(request.projectId, request.issueIid);
          if (connectedScope === this.connectedScopeKey()) this.post({ type: 'issueRelations', requestId: request.requestId, connectedScope, projectId: request.projectId, issueIid: request.issueIid, data });
        } catch (error) {
          if (connectedScope === this.connectedScopeKey()) this.post({ type: 'issueRelations', requestId: request.requestId, connectedScope, projectId: request.projectId, issueIid: request.issueIid, error: readableError(error) });
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
          if (this.issueGraphRequestedScope === connectedScope) void this.loadIssueGraph(connectedScope, true);
        } catch (error) {
          if (connectedScope === this.connectedScopeKey()) {
            this.post({ type: 'issueRelations', requestId: request.requestId, connectedScope, projectId: request.projectId, issueIid: request.issueIid, mutationApplied, error: mutationApplied
              ? `關係已更新，但重新載入失敗：${readableError(error)}`
              : readableError(error) });
            if (mutationApplied && this.issueGraphRequestedScope === connectedScope) void this.loadIssueGraph(connectedScope, true);
          }
        } finally {
          this.issueRelationWritesInFlight.delete(writeKey);
        }
        break;
      }
      case 'selectWorkspace': await this.selectWorkspace(); break;
      case 'openLocalWorkspace': await this.openLocalWorkspace(); break;
      case 'openCodexTerminal': await this.openCodexTerminal(); break;
      case 'copyAndOpenCodex':
        await this.assertWorkflowKitReady();
        await vscode.env.clipboard.writeText(request.text);
        await this.openCodexTerminal();
        this.post({ type: 'message', message: `提示詞已複製，Codex CLI 已開啟。請貼上提示詞執行，完成後將結果貼回「${request.returnTo}」。` });
        break;
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
      case 'syncRepos': await this.syncRepos(); break;
      case 'selectProject': this.selectedProjectId = request.projectId; await this.context.globalState.update('gitlabWorkspace.selectedProjectId', request.projectId); this.sendSnapshot(); break;
      case 'selectIssue': await this.selectIssue(request.projectId, request.issueIid); break;
      case 'openIssue': await this.openIssue(request.projectId, request.issueIid, request.tab); break;
      case 'createIssue': this.issueOpenGeneration++; await this.issuePanels.showCreate(); break;
      case 'copy': await this.assertWorkflowKitReady(); await vscode.env.clipboard.writeText(request.text); this.post({ type: 'message', message: '已複製到剪貼簿，可貼入 Codex CLI。' }); break;
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
      case 'refreshMergeRequest': await this.loadMergeRequest(request.projectId, request.iid); break;
      case 'postMergeRequestNote': await this.postMergeRequestNote(request.projectId, request.iid, request.body); break;
      case 'openMergeReviewTask': await this.openMergeReviewTask(request.projectId, request.iid); break;
      case 'openGroupQuickReview': await this.openGroupQuickReview(); break;
      case 'importMergeReviewReport': await this.importMergeReviewReport(request.projectId, request.iid, request.text); break;
      case 'publishMergeReviewReport': await this.publishMergeReviewReport(request.projectId, request.iid, request.text); break;
      case 'replyMergeRequest': await this.replyMergeRequest(request.projectId, request.iid, request.discussionId, request.body); break;
      case 'approveMergeRequest': await this.approveMergeRequest(request.projectId, request.iid, request.sha); break;
      case 'mergeMergeRequest': await this.mergeMergeRequest(request.projectId, request.iid, request.sha); break;
      case 'prepareDelivery': await this.prepareDelivery(request); break;
      case 'commitDelivery': await this.commitDelivery(request.deliveryId); break;
      case 'copyWikiUpdatePrompt': await this.copyWikiUpdatePrompt(request.deliveryId); break;
      case 'pushDelivery': await this.pushDelivery(request.deliveryId); break;
      case 'createDeliveryMergeRequest': await this.createDeliveryMergeRequest(request.deliveryId); break;
      case 'setWorkflowKitSource': await this.setWorkflowKitSource(request.source); break;
      case 'openWorkflowKitDownload': await this.openWorkflowKitDownload(request.source); break;
      case 'importWorkflowKitPackage': await this.importWorkflowKitPackage(request.source); break;
      case 'refreshWorkflowKit': await this.refreshWorkflowKit(); break;
      case 'installWorkflowKit': await this.installWorkflowKit(request.packageId); break;
      default: break;
    }
  }

  private refresh(options: { forceNetwork?: boolean; forceRepositories?: boolean } = {}): Promise<void> {
    const scope = `${this.session.baseUrl ?? ''}|${this.session.selectedGroup?.id ?? 'none'}`;
    if (this.refreshTask && this.refreshScopeKey === scope && !this.refreshAbort?.signal.aborted && !options.forceNetwork) {
      const currentTask = this.refreshTask;
      if (!options.forceRepositories) return currentTask;
      return currentTask.then(async () => {
        const group = this.session.selectedGroup;
        const root = this.session.baseUrl && group ? this.roots.getRoot(this.session.baseUrl, group.id) : undefined;
        const connectedScope = this.connectedScopeKey();
        const repositoryKey = connectedScope && root ? this.repositoryStateKey(connectedScope, root, this.projects) : undefined;
        if (root && connectedScope && repositoryKey) await this.refreshLocalRepositoryStates(root, this.projects, connectedScope, repositoryKey);
      });
    }
    this.refreshAbort?.abort();
    const abort = new AbortController();
    this.refreshAbort = abort;
    this.refreshScopeKey = scope;
    const generation = ++this.requestGeneration;
    const task = this.refreshWorkspace(generation, abort.signal, options);
    this.refreshTask = task;
    return task.finally(() => {
      if (this.refreshTask === task) {
        this.refreshTask = undefined;
        this.refreshScopeKey = undefined;
      }
    });
  }

  private async refreshWorkspace(
    generation: number,
    signal: AbortSignal,
    options: { forceNetwork?: boolean; forceRepositories?: boolean }
  ): Promise<void> {
    const issueBoardGeneration = ++this.issueBoardGeneration;
    const reloadIssueGraphScope = this.issueGraphRequestedScope;
    if (reloadIssueGraphScope === this.connectedScopeKey() && this.issueGraph) {
      this.issueGraphGeneration++;
      this.issueGraph = { ...this.issueGraph, status: 'loading', updatedAt: Date.now() };
    }
    this.busy = true;
    this.post({ type: 'busy', value: true, label: '正在更新工作台' });
    try {
      if (!this.session.baseUrl) {
        this.groups = []; this.projects = []; this.issues = []; this.mergeRequests = []; this.currentUser = undefined;
        this.meginWorkItems = [];
        this.groupMilestones = []; this.groupMilestonesError = undefined;
        this.groupIssueBoards = []; this.groupIssueBoardsError = undefined;
        this.selectedIssueBoardId = undefined; this.issueBoardContent = undefined;
        this.localRepositoryStates = {}; this.localRepositoriesKey = undefined;
        this.localRepositoryScanGeneration++;
        await this.refreshWorkflowKit(false);
        this.sendSnapshot();
        return;
      }
      const client = (await this.session.getClient()).withReadSignal(signal);
      const readOptions = { force: options.forceNetwork === true, signal };
      const [user, groups] = await Promise.all([
        this.session.cachedRead('current-user', (readClient) => readClient.getCurrentUser(), readOptions),
        this.session.cachedRead('groups', (readClient) => readClient.listGroups(), readOptions)
      ]);
      if (generation !== this.requestGeneration) return;
      this.currentUser = user;
      this.groups = groups;
      await this.timer.setScope(this.session.baseUrl, user.id);
      this.syncTimerPolling();
      const group = this.session.selectedGroup;
      const scopeKey = `${this.session.baseUrl}|${user.id}|${group?.id ?? 'none'}`;
      if (scopeKey !== this.loadedScopeKey) {
        this.loadedScopeKey = scopeKey;
        this.localRepositoryStates = {};
        this.localRepositoriesKey = undefined;
        this.localRepositoryScanGeneration++;
        this.issueGraphGeneration++;
        this.issueGraphAbort?.abort();
        this.issueBoardAbort?.abort();
        this.mergeRequestAbort?.abort();
        if (this.issueGraphPublishTimer) clearTimeout(this.issueGraphPublishTimer);
        this.issueGraphPublishTimer = undefined;
        this.issueGraph = undefined;
        this.selectedIssue = undefined; this.selectedMergeRequest = undefined;
        this.projectMembers = []; this.selectedProjectId = undefined;
        this.groupMilestones = []; this.groupMilestonesError = undefined;
        this.groupIssueBoards = []; this.groupIssueBoardsError = undefined;
        this.selectedIssueBoardId = undefined; this.issueBoardContent = undefined;
      }
      if (!group) {
        this.projects = []; this.issues = []; this.mergeRequests = [];
        this.meginWorkItems = [];
        this.groupMilestones = []; this.groupMilestonesError = undefined;
        this.groupIssueBoards = []; this.groupIssueBoardsError = undefined;
        this.selectedIssueBoardId = undefined; this.issueBoardContent = undefined;
        this.localRepositoryStates = {}; this.localRepositoriesKey = undefined;
        this.localRepositoryScanGeneration++;
        await this.refreshWorkflowKit(false);
        return;
      }
      const root = this.roots.getRoot(this.session.baseUrl, group.id);
      const groupMilestonesPromise = this.session.cachedRead(
        `group/${group.id}/milestones`, (readClient) => readClient.listGroupMilestones(group.id), readOptions
      )
        .then((milestones) => ({ milestones, error: undefined as string | undefined }))
        .catch((error: unknown) => ({ milestones: [] as GitLabMilestone[], error: readableError(error) }));
      const groupIssueBoardsPromise = this.session.cachedRead(
        `group/${group.id}/boards`, (readClient) => readClient.listGroupIssueBoards(group.id), readOptions
      )
        .then((boards) => ({ boards, error: undefined as string | undefined }))
        .catch((error: unknown) => ({ boards: [] as GitLabIssueBoard[], error: readableError(error) }));
      const [projects, mergeRequests, milestoneResult, boardResult] = await Promise.all([
        this.session.cachedRead(
          `group/${group.id}/projects`, (readClient) => readClient.listGroupProjects(group.id), readOptions
        ),
        this.session.cachedRead(
          `group/${group.id}/merge-requests`, (readClient) => readClient.listGroupMergeRequests(group.id), readOptions
        ).catch(() => []),
        groupMilestonesPromise,
        groupIssueBoardsPromise
      ]);
      if (generation !== this.requestGeneration || this.session.selectedGroup?.id !== group.id) return;
      this.projects = projects;
      this.mergeRequests = mergeRequests;
      this.groupMilestones = milestoneResult.milestones;
      this.groupMilestonesError = milestoneResult.error;
      this.groupIssueBoards = boardResult.boards;
      this.groupIssueBoardsError = boardResult.error;
      const repositoryKey = this.repositoryStateKey(scopeKey, root, projects);
      if (root && repositoryKey && (options.forceRepositories || repositoryKey !== this.localRepositoriesKey)) {
        void this.refreshLocalRepositoryStates(root, projects, scopeKey, repositoryKey);
      }
      const projectIds = new Set(projects.map((project) => project.id));
      this.issues = await this.session.cachedRead(
        `group/${group.id}/assigned-issues/${[...projectIds].sort((a, b) => a - b).join(',')}`,
        (readClient) => readClient.listAssignedGroupIssues(group.id, projectIds), readOptions
      );
      if (generation !== this.requestGeneration || this.session.selectedGroup?.id !== group.id) return;
      if (this.selectedIssueBoardId !== undefined && !boardResult.error) {
        if (!boardResult.boards.some((board) => board.id === this.selectedIssueBoardId)) {
          this.selectedIssueBoardId = undefined;
          this.issueBoardContent = undefined;
          this.issueBoardGeneration++;
        } else {
          const currentBoardGeneration = ++this.issueBoardGeneration;
          await this.loadIssueBoardContent(group.full_path, this.selectedIssueBoardId, currentBoardGeneration, this.connectedScopeKey(), options.forceNetwork === true);
        }
      } else if (boardResult.error) {
        this.issueBoardContent = this.selectedIssueBoardId === undefined || !this.connectedScopeKey()
          ? undefined
          : { boardId: this.selectedIssueBoardId, connectedScope: this.connectedScopeKey()!, issueIds: [], status: 'error', error: boardResult.error };
      }
      if (generation !== this.requestGeneration || this.session.selectedGroup?.id !== group.id) return;
      if (this.currentUser && !this.selectedIssue) {
        const previous = this.context.globalState.get<{ projectId: number; issueIid: number }>(this.selectedIssueKey());
        if (previous && projectIds.has(previous.projectId)) {
          try {
            const [project, issue] = await Promise.all([client.getProject(previous.projectId), client.getIssue(previous.projectId, previous.issueIid)]);
            this.selectedIssue = { project, issue };
            this.projectMembers = await client.listProjectMembers(project.id).catch(() => []);
          } catch { await this.context.globalState.update(this.selectedIssueKey(), undefined); }
        }
      }
      this.selectedProjectId ??= this.context.globalState.get<number>('gitlabWorkspace.selectedProjectId');
      if (!this.selectedMergeRequest) {
        const previous = this.context.globalState.get<{ projectId: number; iid: number }>(this.selectedMergeRequestKey());
        if (previous && projectIds.has(previous.projectId)) {
          try {
            const request = await client.getMergeRequest(previous.projectId, previous.iid);
            const [diffs, discussions] = await Promise.all([
              client.listMergeRequestDiffs(previous.projectId, previous.iid).catch(() => []),
              client.listMergeRequestDiscussions(previous.projectId, previous.iid).catch(() => [])
            ]);
            this.selectedMergeRequest = await this.getMergeRequestDetail(client, request, diffs, discussions);
          } catch { await this.context.globalState.update(this.selectedMergeRequestKey(), undefined); }
        }
      }
      this.meginWorkItems = root ? await readMeginWorkItems(root) : [];
      await this.refreshWorkflowKit(false, root);
    } catch (error) {
      if (!signal.aborted) throw error;
    } finally {
      if (generation === this.requestGeneration) {
        this.busy = false;
        this.post({ type: 'busy', value: false });
        this.sendSnapshot();
        if (reloadIssueGraphScope && reloadIssueGraphScope === this.connectedScopeKey()) {
          const scope = this.connectedScopeKey();
          if (scope) void this.loadIssueGraph(scope, options.forceNetwork === true);
        }
      }
    }
  }

  private repositoryStateKey(
    connectedScope: string,
    root: string | undefined,
    projects: readonly GitLabProject[]
  ): string | undefined {
    if (!root) return undefined;
    return `${connectedScope}\0${root}\0${projects.map((project) => `${project.id}:${project.path}`).join('\0')}`;
  }

  private async refreshLocalRepositoryStates(
    root: string,
    projects: readonly GitLabProject[],
    connectedScope: string,
    repositoryKey: string
  ): Promise<void> {
    const generation = ++this.localRepositoryScanGeneration;
    const folders = projectFolderNames(projects);
    const states = await mapWithConcurrency(projects, 8, async (project) => {
      try {
        const localPath = groupRepositoryPath(root, project, projects, folders);
        return [project.id, { path: localPath, state: await localRepositoryStateAsync(root, localPath) }] as const;
      } catch {
        return [project.id, { path: '', state: 'unsafe' as const }] as const;
      }
    });
    const group = this.session.selectedGroup;
    const currentRoot = this.session.baseUrl && group ? this.roots.getRoot(this.session.baseUrl, group.id) : undefined;
    if (this.disposed || generation !== this.localRepositoryScanGeneration || connectedScope !== this.connectedScopeKey() ||
      repositoryKey !== this.repositoryStateKey(connectedScope, currentRoot, this.projects)) return;
    this.localRepositoryStates = Object.fromEntries(states);
    this.localRepositoriesKey = repositoryKey;
    this.sendSnapshot();
  }

  private async selectIssueBoard(boardId: number, connectedScope: string): Promise<void> {
    const group = this.session.selectedGroup;
    const currentScope = this.connectedScopeKey();
    if (!group || !currentScope || connectedScope !== currentScope || !Number.isSafeInteger(boardId) || boardId <= 0 ||
      !this.groupIssueBoards.some((board) => board.id === boardId)) return;

    this.issueBoardAbort?.abort();
    this.selectedIssueBoardId = boardId;
    const generation = ++this.issueBoardGeneration;
    await this.loadIssueBoardContent(group.full_path, boardId, generation, currentScope);
  }

  private async loadIssueBoardContent(groupPath: string, boardId: number, generation: number, connectedScope?: string, forceNetwork = false): Promise<void> {
    if (!connectedScope) return;
    this.issueBoardAbort?.abort();
    const controller = new AbortController();
    this.issueBoardAbort = controller;
    const matchesCurrentSelection = (): boolean => !this.disposed && generation === this.issueBoardGeneration &&
      connectedScope === this.connectedScopeKey() && this.session.selectedGroup?.full_path === groupPath &&
      this.selectedIssueBoardId === boardId && !controller.signal.aborted;

    if (!matchesCurrentSelection()) return;
    this.issueBoardContent = { boardId, connectedScope, issueIds: [], status: 'loading' };
    this.sendSnapshot();
    try {
      const username = this.currentUser?.username ?? '';
      const issueIds = await this.session.cachedRead(
        `group-board/${groupPath}/${boardId}/assigned/${username}`,
        (client) => client.listAssignedGroupBoardIssueIds(groupPath, boardId, username),
        { signal: controller.signal, force: forceNetwork }
      );
      if (!matchesCurrentSelection()) return;
      this.issueBoardContent = { boardId, connectedScope, issueIds, status: 'ready' };
    } catch (error) {
      if (!matchesCurrentSelection()) return;
      this.issueBoardContent = { boardId, connectedScope, issueIds: [], status: 'error', error: readableError(error) };
    }
    this.sendSnapshot();
  }

  private async loadIssueGraph(connectedScope: string, forceNetwork = false): Promise<void> {
    const group = this.session.selectedGroup;
    const currentScope = this.connectedScopeKey();
    if (this.disposed || !group || !this.session.baseUrl || connectedScope !== currentScope || !this.currentUser) return;
    this.issueGraphAbort?.abort();
    if (this.issueGraphPublishTimer) clearTimeout(this.issueGraphPublishTimer);
    this.issueGraphPublishTimer = undefined;
    const controller = new AbortController();
    this.issueGraphAbort = controller;
    this.issueGraphRequestedScope = connectedScope;
    const generation = ++this.issueGraphGeneration;
    const isCurrent = (): boolean => !this.disposed && generation === this.issueGraphGeneration &&
      connectedScope === this.connectedScopeKey() && this.session.selectedGroup?.id === group.id && !controller.signal.aborted;
    let client: GitLabClient;
    try {
      client = await this.session.getClient();
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
    const boardIdsByGraphNodeId = new Map<string, Set<number>>();
    const graph = this.emptyIssueGraph(connectedScope);
    const nodeById = new Map<string, IssueGraphNode>();
    const edgeById = new Map<string, NonNullable<IssueGraphSnapshot['edges'][number]>>();
    const errors = new Set<string>();
    const publishNow = (): void => {
      if (!isCurrent()) return;
      graph.roots = [...graph.roots];
      graph.nodes = [...nodeById.values()];
      graph.edges = [...edgeById.values()];
      graph.errors = [...errors];
      graph.updatedAt = Date.now();
      this.issueGraph = graph;
      this.issueGraphVersion++;
      this.post({ type: 'issueGraphChanged', connectedScope, version: this.issueGraphVersion, graph: { ...graph,
        roots: [...graph.roots], nodes: graph.nodes.map((node) => ({ ...node, sourceIds: [...node.sourceIds], labels: [...node.labels], assignees: [...node.assignees], boardIds: [...node.boardIds] })),
        edges: graph.edges.map((edge) => ({ ...edge })), errors: [...graph.errors],
        boardIssueIds: Object.fromEntries(Object.entries(graph.boardIssueIds).map(([id, ids]) => [id, [...ids]])),
        boardStatus: Object.fromEntries(Object.entries(graph.boardStatus).map(([id, status]) => [id, { ...status }])) } });
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
        }, 250);
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
        boardIds: [...new Set([...(previous?.boardIds ?? []), ...incoming.boardIds])],
        relationsStatus: incoming.relationsStatus ?? previous?.relationsStatus
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
        relationsStatus: 'ready'
      };
    };

    for (const issue of this.issues) {
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
        relationsStatus: 'loading'
      });
      if (!graph.roots.includes(node.id)) graph.roots.push(node.id);
    }

    graph.boardStatus = Object.fromEntries(this.groupIssueBoards.map((board) => [board.id, { status: 'loading' }]));
    if (!graph.roots.length) {
      for (const board of this.groupIssueBoards) graph.boardStatus[board.id] = { status: 'ready' };
      publish('ready', true);
      return;
    }
    publish('loading');

    const jobs: Array<() => Promise<void>> = [];
    for (const board of this.groupIssueBoards) {
      jobs.push(async () => {
        try {
          const memberships = await this.session.cachedRead(
            `group-board/${group.id}/${board.id}/memberships`,
            (readClient) => readClient.withReadSignal(controller.signal).listGroupBoardIssueMemberships(group.full_path, board.id),
            { signal: controller.signal, force: forceNetwork }
          );
          if (!isCurrent()) return;
          graph.boardIssueIds[board.id] = memberships.map((item) => item.issueId);
          graph.boardStatus[board.id] = { status: 'ready' };
          for (const membership of memberships) {
            if (membership.projectId === undefined || membership.iid === undefined) continue;
            const projectPath = projectById.get(membership.projectId)?.path_with_namespace ?? `project-${membership.projectId}`;
            const nodeId = issueGraphNodeKey(membership.projectId, projectPath, membership.iid);
            const boardIds = boardIdsByGraphNodeId.get(nodeId) ?? new Set<number>();
            boardIds.add(board.id);
            boardIdsByGraphNodeId.set(nodeId, boardIds);
            const node = nodeById.get(nodeId);
            if (node && !node.boardIds.includes(board.id)) node.boardIds.push(board.id);
          }
        } catch (error) {
          if (!isCurrent()) return;
          const message = readableError(error);
          graph.boardStatus[board.id] = { status: 'error', error: message };
          errors.add(`${board.name}: ${message}`);
        }
        publish('loading');
      });
    }

    const userId = this.currentUser.id;
    const capabilities = this.session.issueCapabilities;
    const fallbackLabels = new Set(this.issues.map((issue) => issue.project_id));
    for (const projectId of fallbackLabels) {
      const project = projectById.get(projectId);
      if (!project) continue;
      jobs.push(async () => {
        try {
          const labels = await this.session.cachedRead(`project/${projectId}/labels`, (readClient) => readClient.listProjectLabels(projectId), { signal: controller.signal, force: forceNetwork });
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
          if (isCurrent()) errors.add(`無法載入 ${project.path_with_namespace} 的 Label 色彩：${readableError(error)}`);
        }
        publish('loading');
      });
    }

    for (const issue of this.issues) {
      const project = projectById.get(issue.project_id);
      if (!project) continue;
      jobs.push(async () => {
        if (!isCurrent()) return;
        let parents: GitLabGraphWorkItem[] = [];
        let children: GitLabGraphWorkItem[] = [];
        let workItemLinks: Array<{ type: string; item: GitLabGraphWorkItem }> = [];
        let workItemRelationsFailed = false;
        let workItemRootId: string | undefined;
        try {
          if (capabilities?.graphWorkItems) {
            const relations = await client.withReadSignal(controller.signal).loadIssueGraphRelations(project.path_with_namespace, issue.iid, capabilities);
            parents = relations.parents;
            children = relations.children;
            workItemLinks = relations.links;
            workItemRootId = relations.root?.id;
          }
        } catch (error) {
          workItemRelationsFailed = true;
          if (capabilities?.graphWorkItems) errors.add(`Issue #${issue.iid} 的 WorkItem 關聯無法載入：${readableError(error)}`);
        }

        const root = addNode({
          id: issueGraphNodeKey(issue.project_id, project.path_with_namespace, issue.iid),
          sourceIds: [`REST:Issue:${issue.id}`, ...(workItemRootId ? [`GraphQL:WorkItem:${workItemRootId}`] : [])],
          kind: 'issue',
          namespacePath: project.path_with_namespace,
          iid: String(issue.iid),
          title: issue.title,
          state: issue.state,
          projectId: issue.project_id,
          projectPath: project.path_with_namespace,
          webUrl: issue.web_url,
          labels: [],
          assignees: [],
          boardIds: [],
          assignedToMe: true,
          isRoot: true,
          relationsStatus: workItemRelationsFailed ? 'error' : 'ready'
        });

        for (const parent of parents) {
          const node = addNode(materializeWorkItem(parent, 'parent'));
          addEdge(node.id, root.id, 'parent');
        }
        for (const child of children) {
          const node = addNode(materializeWorkItem(child, 'child'));
          addEdge(root.id, node.id, 'parent');
        }
        for (const relation of workItemLinks) {
          const node = addNode(materializeWorkItem(relation.item, 'linked'));
          const type = relation.type.toLocaleLowerCase().replaceAll('-', '_');
          if (type === 'blocks') addEdge(root.id, node.id, 'blocks');
          else if (type === 'blocked_by' || type === 'is_blocked_by') addEdge(node.id, root.id, 'blocks');
          else addEdge(root.id, node.id, 'relates_to');
        }

        if (!capabilities?.graphLinkedItems || workItemRelationsFailed) {
          try {
            const links = await client.withReadSignal(controller.signal).listIssueLinks(issue.project_id, issue.iid);
            for (const relatedIssue of links) {
              const relatedProject = projectById.get(relatedIssue.project_id);
              const namespacePath = relatedProject?.path_with_namespace ?? `project-${relatedIssue.project_id}`;
              const node = addNode({
                id: issueGraphNodeKey(relatedIssue.project_id, namespacePath, relatedIssue.iid),
                sourceIds: [`REST:Issue:${relatedIssue.id}`],
                kind: 'issue',
                namespacePath,
                iid: String(relatedIssue.iid),
                title: relatedIssue.title,
                state: relatedIssue.state,
                projectId: relatedIssue.project_id,
                projectPath: relatedProject?.path_with_namespace,
                webUrl: relatedIssue.web_url,
                labels: (relatedIssue.labels ?? []).map((name) => ({ name })),
                assignees: relatedIssue.assignees ?? (relatedIssue.assignee ? [relatedIssue.assignee] : []),
                boardIds: [],
                assignedToMe: !!relatedIssue.assignees?.some((assignee) => assignee.id === userId) || relatedIssue.assignee?.id === userId,
                isRoot: false,
                relationsStatus: 'ready'
              });
              const type = relatedIssue.link_type?.toLocaleLowerCase();
              if (type === 'blocks') addEdge(root.id, node.id, 'blocks');
              else if (type === 'is_blocked_by') addEdge(node.id, root.id, 'blocks');
              else addEdge(root.id, node.id, 'relates_to');
            }
          } catch (error) {
            root.relationsStatus = 'error';
            errors.add(`Issue #${issue.iid} 的 Linked Items 無法載入：${readableError(error)}`);
          }
        }
        publish('loading');
      });
    }

    await mapWithConcurrency(jobs, 4, async (job) => job());
    if (!isCurrent()) return;
    const relationLabelProjectIds = [...new Set([...nodeById.values()]
      .map((node) => node.projectId)
      .filter((projectId): projectId is number => projectId !== undefined && !fallbackLabels.has(projectId)))];
    await mapWithConcurrency(relationLabelProjectIds, 4, async (projectId) => {
      try {
        const labels = await this.session.cachedRead(`project/${projectId}/labels`, (readClient) => readClient.listProjectLabels(projectId), { signal: controller.signal, force: forceNetwork });
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
        if (isCurrent()) errors.add(`無法載入專案 #${projectId} 的 Label 色彩：${readableError(error)}`);
      }
      publish('loading');
    });
    if (!isCurrent()) return;
    for (const node of nodeById.values()) {
      node.boardIds = [...new Set([...node.boardIds, ...(boardIdsByGraphNodeId.get(node.id) ?? [])])];
    }
    publish(errors.size ? 'partial' : 'ready', true);
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
    if (!this.panel || this.disposed) return;
    const group = this.session.selectedGroup;
    const root = this.session.baseUrl && group ? this.roots.getRoot(this.session.baseUrl, group.id) : undefined;
    const deliveryScope = this.deliveryInstanceScope();
    const localRepositoryKey = this.repositoryStateKey(this.connectedScopeKey() ?? '', root, this.projects);
    const localRepositories = localRepositoryKey === this.localRepositoriesKey ? this.localRepositoryStates : {};
    const snapshot: WorkspaceSnapshot = {
      connected: !!this.session.baseUrl,
      baseUrl: this.session.baseUrl,
      currentUser: this.currentUser,
      group,
      groups: this.groups,
      groupRoot: root,
      projects: this.projects,
      groupMilestones: this.groupMilestones,
      groupMilestonesError: this.groupMilestonesError,
      groupIssueBoards: this.groupIssueBoards,
      groupIssueBoardsError: this.groupIssueBoardsError,
      issueBoardContent: this.issueBoardContent?.connectedScope === this.connectedScopeKey() ? this.issueBoardContent : undefined,
      issueGraph: this.issueGraph?.connectedScope === this.connectedScopeKey() ? this.issueGraph : undefined,
      issueGraphVersion: this.issueGraphVersion,
      localRepositories,
      issues: this.issues,
      mergeRequests: this.mergeRequests,
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
      workflowKit: this.workflowKitState,
      workflowKitSource: this.workflowKitSource(),
      workflowKitPackages: this.workflowKitPackages.map(({ id, version, source, assetName, format, entryRoot, available, error }) =>
        ({ id, version, source, assetName, format, entryRoot, available, error })),
      meginWorkItems: this.meginWorkItems,
      deliveryRecords: this.deliveryRecords()
        .filter((item) => item.groupId === group?.id && item.userId === this.currentUser?.id)
        .map((item) => ({ ...item, instanceVerified: !!deliveryScope && item.instanceScope === deliveryScope, ...(item.handoffSha256 ? {} : { gate: { ok: false, reasons: ['舊紀錄缺少 Megin 原生驗收交接證據。'] } }) })),
      cloneOperation: this.cloneOperation,
      busy: this.busy || this.repositoryOperationInProgress || this.workspaceSelectionInProgress
    };
    this.post({ type: 'snapshot', snapshot });
  }

  private connectedScopeKey(): string | undefined {
    const baseUrl = this.session.baseUrl;
    const userId = this.currentUser?.id;
    const groupId = this.session.selectedGroup?.id;
    if (!baseUrl || !userId || !groupId) return undefined;
    return createHash('sha256').update(`${baseUrl}\0${userId}\0${groupId}`).digest('hex').slice(0, 24);
  }

  private async connect(): Promise<void> {
    if (this.repositoryOperationInProgress || this.workspaceSelectionInProgress) throw new Error('Repo 操作或工作目錄選擇完成後才能切換連線或 Group。');
    const baseUrl = await vscode.window.showInputBox({ title: '連線至 GitLab', prompt: '輸入 GitLab 網址', value: this.session.baseUrl, placeHolder: 'https://gitlab.example.com', ignoreFocusOut: true });
    if (!baseUrl) return;
    const token = await vscode.window.showInputBox({ title: 'GitLab Personal Access Token', prompt: 'Token 儲存在 VS Code SecretStorage。', password: true, ignoreFocusOut: true });
    if (!token) return;
    const previousBaseUrl = this.session.baseUrl;
    const previousUserId = this.currentUser?.id;
    const user = await this.session.connect(baseUrl, token);
    this.refreshAbort?.abort();
    this.issueGraphAbort?.abort();
    this.issueBoardAbort?.abort();
    this.mergeRequestAbort?.abort();
    this.issueOpenAbort?.abort();
    this.currentUser = user;
    if (previousBaseUrl !== this.session.baseUrl || previousUserId !== user.id) {
      this.issueOpenGeneration++;
      this.issuePanels.close();
    }
    const selected = await this.selectGroup();
    if (!selected) {
      await this.refresh();
      await this.syncSidebarState?.();
    }
    this.post({ type: 'message', message: `已連線：${user.name}` });
  }

  private async disconnect(): Promise<void> {
    if (this.repositoryOperationInProgress || this.workspaceSelectionInProgress) throw new Error('Repo 操作或工作目錄選擇完成後才能切換連線或 Group。');
    const confirm = await vscode.window.showWarningMessage('中斷 GitLab 連線？本機 Repo、草稿及計時紀錄會保留。', { modal: true }, '中斷連線');
    if (confirm !== '中斷連線') return;
    this.refreshAbort?.abort();
    this.requestGeneration++;
    this.issueOpenGeneration++;
    this.issueBoardGeneration++;
    this.issueGraphAbort?.abort();
    this.issueBoardAbort?.abort();
    this.mergeRequestAbort?.abort();
    this.issueOpenAbort?.abort();
    this.issuePanels.close();
    await this.session.disconnect();
    this.groups = []; this.projects = []; this.issues = []; this.mergeRequests = [];
    this.groupIssueBoards = []; this.groupIssueBoardsError = undefined;
    this.selectedIssueBoardId = undefined; this.issueBoardContent = undefined;
    this.currentUser = undefined; this.selectedIssue = undefined; this.selectedMergeRequest = undefined;
    this.sendSnapshot();
    await this.syncSidebarState?.();
  }

  private async selectGroup(groupId?: number): Promise<boolean> {
    if (this.repositoryOperationInProgress || this.workspaceSelectionInProgress) throw new Error('Repo 操作或工作目錄選擇完成後才能切換連線或 Group。');
    const groups = this.session.baseUrl ? await this.session.cachedRead('groups', (client) => client.listGroups()) : [];
    const selected = groupId ? groups.find((item) => item.id === groupId) : await vscode.window.showQuickPick(
      groups.map((group) => ({ label: group.full_path, description: group.name, group })),
      { title: '選擇 GitLab Group', placeHolder: '選取工作群組' }
    ).then((item) => item?.group);
    if (!selected) return false;
    this.issueOpenGeneration++;
    this.issuePanels.close();
    this.issueGraphAbort?.abort();
    this.issueBoardAbort?.abort();
    this.mergeRequestAbort?.abort();
    this.issueOpenAbort?.abort();
    await this.session.setSelectedGroup(selected);
    this.selectedIssue = undefined; this.selectedMergeRequest = undefined; this.projects = [];
    this.projectMembers = [];
    await this.refresh();
    await this.syncSidebarState?.();
    return true;
  }

  private async selectWorkspace(allowDuringRepositoryOperation = false): Promise<void> {
    if (this.workspaceSelectionInProgress || this.busy || (this.repositoryOperationInProgress && !allowDuringRepositoryOperation)) {
      throw new Error('目前有操作進行中，完成後才能變更工作目錄。');
    }
    this.workspaceSelectionInProgress = true;
    this.sendSnapshot();
    try {
      const selected = await vscode.window.showOpenDialog({
        canSelectFiles: false, canSelectFolders: true, canSelectMany: false,
        openLabel: '選擇 Group 工作目錄',
        defaultUri: vscode.workspace.workspaceFolders?.[0]?.uri
      });
      const group = this.session.selectedGroup;
      if (!selected?.[0] || !group || !this.session.baseUrl) return;
      const root = selected[0].fsPath;
      if (await exists(path.join(root, '.git'))) throw new Error('Group 工作目錄不可直接選擇 Git Repo；請選擇上層資料夾。');
      await this.roots.setRoot(this.session.baseUrl, group.id, root);
      await this.refresh();
    } finally {
      this.workspaceSelectionInProgress = false;
      this.sendSnapshot();
    }
  }

  private async openLocalWorkspace(): Promise<void> {
    const group = this.session.selectedGroup;
    const root = this.session.baseUrl && group ? this.roots.getRoot(this.session.baseUrl, group.id) : undefined;
    if (!root) throw new Error('請先選擇 Group 工作目錄。');
    await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(root), false);
  }

  private async openCodexTerminal(): Promise<void> {
    const group = this.session.selectedGroup;
    const root = this.session.baseUrl && group ? this.roots.getRoot(this.session.baseUrl, group.id) : undefined;
    if (!root) throw new Error('請先選擇 Group 工作目錄。');
    if (process.platform === 'win32') {
      const options = windowsCodexTerminalOptions();
      if (!options) {
        await vscode.window.showErrorMessage('找不到 Windows Codex CLI。請安裝 codex.exe 或 codex.cmd，將所在資料夾加入 PATH，然後重新啟動 VS Code。');
        return;
      }
      const windowsTerminal = vscode.window.createTerminal({ name: 'Codex CLI', cwd: root, ...options });
      windowsTerminal.show();
      return;
    }
    const terminal = vscode.window.createTerminal({ name: 'Codex CLI', cwd: root });
    terminal.show();
    terminal.sendText('codex');
  }

  private async clone(projectIds: number[], cloneAll: boolean): Promise<void> {
    const group = this.session.selectedGroup;
    let root = this.session.baseUrl && group ? this.roots.getRoot(this.session.baseUrl, group.id) : undefined;
    if (!group || !this.session.baseUrl) throw new Error('請先連線 GitLab 並選擇 Group。');
    if (this.busy || this.repositoryOperationInProgress || this.workspaceSelectionInProgress) throw new Error('目前有工作正在處理，完成後再開始 Repo 操作。');
    this.repositoryOperationInProgress = true;
    this.sendSnapshot();
    let operation: CloneOperationState | undefined;
    try {
      if (!root) {
        this.post({ type: 'message', message: '請選擇這個 Group 的下載位置，完成後即可繼續。' });
        await this.selectWorkspace(true);
        root = this.session.baseUrl ? this.roots.getRoot(this.session.baseUrl, group.id) : undefined;
        if (!root) return;
      }
      if (this.session.selectedGroup?.id !== group.id) throw new Error('Group 已變更，請重新選取專案。');
      const client = await this.session.getClient();
      const projects = this.projects.length ? this.projects : await this.session.cachedRead(
        `group/${group.id}/projects`, (readClient) => readClient.listGroupProjects(group.id)
      );
      const wantedIds = new Set(projectIds.filter((id) => Number.isSafeInteger(id)));
      const chosen = cloneAll ? projects : projects.filter((project) => wantedIds.has(project.id));
      if (!chosen.length) throw new Error('請先在專案清單勾選要下載或更新的 Repo。');
      const scopeKey = this.connectedScopeKey();
      operation = {
        id: randomUUID(), scopeKey, phase: 'running', label: '下載／更新進度',
        items: chosen.map((project) => ({ projectId: project.id, projectPath: project.path_with_namespace, state: 'waiting' }))
      };
      const publishOperation = (): void => {
        if (!operation) return;
        this.cloneOperation = { ...operation, items: operation.items.map((item) => ({ ...item })) };
        this.post({ type: 'cloneOperation', ...this.cloneOperation });
      };
      publishOperation();
      const folderNames = projectFolderNames(projects);
      const localStates = await mapWithConcurrency(chosen, 8, async (project) => {
        const target = groupRepositoryPath(root!, project, projects, folderNames);
        return [project.id, await localRepositoryStateAsync(root!, target)] as const;
      });
      const localStatesById = new Map(localStates);
      const destinations = chosen.map((project) => {
        const target = groupRepositoryPath(root!, project, projects, folderNames);
        return `${localStatesById.get(project.id) === 'ready' ? '更新' : 'Clone'}　${project.path_with_namespace} → ${target}`;
      });
      const confirm = await vscode.window.showInformationMessage(`即將在 ${root} 處理 ${chosen.length} 個 Repo：\n${destinations.join('\n')}`, { modal: true }, '開始');
      if (confirm !== '開始') {
        operation.phase = 'cancelled';
        operation.label = '已取消，選取仍保留';
        publishOperation();
        this.post({ type: 'message', message: '下載已取消；勾選項目仍保留。' });
        return;
      }
      const credentials = await this.session.getCloneCredentials();
      const updateItem = (projectId: number, update: Partial<CloneOperationState['items'][number]>): void => {
        if (!operation) return;
        operation.items = operation.items.map((item) => item.projectId === projectId ? { ...item, ...update } : item);
        publishOperation();
      };
      const result = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: '下載／更新 GitLab Repo', cancellable: false }, async (progress) =>
        cloneProjects(root!, chosen, credentials.baseUrl, credentials.token, (event) => {
          const state = event.state === 'completed' ? (event.action === 'clone' ? 'completed' : 'updated') : event.state;
          updateItem(event.project.id, { state, percent: event.percent, message: event.message });
          const label = state === 'starting' ? '準備中' : state === 'progress' ? '下載中' : state === 'completed' ? '已下載' : state === 'updated' ? '已更新' : state === 'skipped' ? '略過' : state === 'failed' ? '失敗' : state;
          progress.report({ message: `${event.project.path_with_namespace}：${label}${event.percent === undefined ? '' : ` ${event.percent}%`}`, increment: 0 });
        }, { resolveProject: (project) => client.getProject(project.id), groupProjects: projects })
      );
      operation.phase = 'completed';
      operation.label = 'Repo 操作結果';
      operation.items = operation.items.map((item) => item.state === 'waiting' || item.state === 'starting' || item.state === 'progress'
        ? { ...item, state: 'skipped', message: '此次操作未完成，請重新勾選後重試。' }
        : item);
      for (const project of result.cloned) updateItem(project.id, { state: 'completed', percent: undefined, message: '已下載' });
      for (const project of result.updated) updateItem(project.id, { state: 'updated', percent: undefined, message: '已更新' });
      for (const item of result.skipped) updateItem(item.project.id, { state: 'skipped', percent: undefined, message: item.reason });
      if (result.failed) updateItem(result.failed.id, { state: 'failed', percent: undefined, message: result.failureReason ?? '操作失敗' });
      publishOperation();
      this.post({ type: 'message', message: `下載／更新完成：${result.cloned.length} 個已下載、${result.updated.length} 個已更新、${result.skipped.length} 個略過${result.failed ? `、${result.failed.path_with_namespace} 失敗` : ''}。` });
    } catch (error) {
      if (operation) {
        const reason = readableError(error);
        operation.phase = 'failed';
        operation.label = '下載／更新失敗';
        operation.items = operation.items.map((item) => item.state === 'waiting' || item.state === 'starting' || item.state === 'progress'
          ? { ...item, state: 'failed', percent: undefined, message: reason }
          : item);
        this.cloneOperation = { ...operation, items: operation.items.map((item) => ({ ...item })) };
        this.post({ type: 'cloneOperation', ...this.cloneOperation });
      }
      throw error;
    } finally {
      try { await this.refresh({ forceRepositories: true }); }
      finally { this.repositoryOperationInProgress = false; this.sendSnapshot(); }
    }
  }

  private async syncRepos(): Promise<void> {
    const group = this.session.selectedGroup;
    let root = this.session.baseUrl && group ? this.roots.getRoot(this.session.baseUrl, group.id) : undefined;
    if (!group || !this.session.baseUrl) throw new Error('請先連線 GitLab 並選擇 Group。');
    if (this.busy || this.repositoryOperationInProgress || this.workspaceSelectionInProgress) throw new Error('目前有工作正在處理，完成後再開始 Repo 操作。');
    this.repositoryOperationInProgress = true;
    this.sendSnapshot();
    let operation: CloneOperationState | undefined;
    const publishOperation = (): void => {
      if (!operation) return;
      this.cloneOperation = { ...operation, items: operation.items.map((item) => ({ ...item })) };
      this.post({ type: 'cloneOperation', ...this.cloneOperation });
    };
    try {
      if (!root) {
        this.post({ type: 'message', message: '請選擇這個 Group 的工作目錄，才能更新本機預設分支。' });
        await this.selectWorkspace(true);
        root = this.session.baseUrl ? this.roots.getRoot(this.session.baseUrl, group.id) : undefined;
        if (!root) return;
      }
      const groupProjects = this.projects;
      const folderNames = projectFolderNames(groupProjects);
      const localStates = await mapWithConcurrency(groupProjects, 8, async (project) => {
        try {
          const targetPath = groupRepositoryPath(root!, project, groupProjects, folderNames);
          return [project.id, await localRepositoryStateAsync(root!, targetPath)] as const;
        } catch { return [project.id, 'unsafe' as const] as const; }
      });
      const existingIds = new Set(localStates.filter(([, state]) => state === 'ready').map(([id]) => id));
      const existingProjects = groupProjects.filter((project) => existingIds.has(project.id));
      if (!existingProjects.length) {
        this.post({ type: 'message', message: `${group.full_path} 尚無已存在且路徑安全的本機 Repo 可更新。` });
        return;
      }
      const activeOperation: CloneOperationState = {
        id: randomUUID(), scopeKey: this.connectedScopeKey(), phase: 'running', label: '預設分支同步結果',
        items: existingProjects.map((project) => ({ projectId: project.id, projectPath: project.path_with_namespace, state: 'waiting' }))
      };
      operation = activeOperation;
      publishOperation();
      const confirm = await vscode.window.showWarningMessage(`Fetch 並 Pull ${group.full_path} 下 ${existingProjects.length} 個已存在 Repo 的預設分支？本機分支不會刪除。`, { modal: true }, '更新預設分支');
      if (confirm !== '更新預設分支') {
        activeOperation.phase = 'cancelled';
        activeOperation.label = '已取消';
        publishOperation();
        return;
      }
      const client = await this.session.getClient();
      const credentials = await this.session.getCloneCredentials();
      const results = await syncLocalDefaultBranches(root!, existingProjects, credentials.baseUrl, credentials.token, (event) => {
        const state = event.state === 'up-to-date' ? 'upToDate' : event.state;
        activeOperation.items = activeOperation.items.map((item) => item.projectId === event.project.id
          ? { ...item, state, percent: event.percent, message: event.message }
          : item);
        publishOperation();
      }, { groupProjects, resolveProject: (project) => client.getProject(project.id) });
      const touched = new Set([...results.updated, ...results.upToDate, ...results.skipped.map((item) => item.project), ...results.failed.map((item) => item.project)].map((project) => project.id));
      activeOperation.items = activeOperation.items.map((item) => touched.has(item.projectId) ? item : { ...item, state: 'skipped', message: '同步前本機 Repo 已不存在，略過更新' });
      for (const project of results.updated) activeOperation.items = activeOperation.items.map((item) => item.projectId === project.id ? { ...item, state: 'updated', percent: undefined, message: '預設分支已更新' } : item);
      for (const project of results.upToDate) activeOperation.items = activeOperation.items.map((item) => item.projectId === project.id ? { ...item, state: 'upToDate', percent: undefined, message: '已是最新版本' } : item);
      for (const item of results.skipped) activeOperation.items = activeOperation.items.map((entry) => entry.projectId === item.project.id ? { ...entry, state: 'skipped', percent: undefined, message: item.reason } : entry);
      for (const item of results.failed) activeOperation.items = activeOperation.items.map((entry) => entry.projectId === item.project.id ? { ...entry, state: 'failed', percent: undefined, message: item.reason } : entry);
      activeOperation.phase = 'completed';
      activeOperation.label = '預設分支同步結果';
      publishOperation();
      this.post({ type: 'message', message: `已更新 ${results.updated.length} 個預設分支；${results.upToDate.length} 個已是最新、${results.skipped.length + results.failed.length} 個需處理。` });
    } catch (error) {
      const reason = readableError(error);
      if (operation) {
        operation.phase = 'failed';
        operation.items = operation.items.map((item) => item.state === 'waiting' || item.state === 'starting' || item.state === 'progress'
          ? { ...item, state: 'failed', percent: undefined, message: reason }
          : item);
        publishOperation();
      }
      throw error;
    } finally {
      try { await this.refresh({ forceRepositories: true }); }
      finally { this.repositoryOperationInProgress = false; this.sendSnapshot(); }
    }
  }

  private async selectIssue(projectId: number, issueIid: number): Promise<void> {
    requireIssueIid(issueIid);
    const project = this.requireGroupProject(projectId);
    const client = await this.session.getClient();
    const [issue, projectMembers] = await Promise.all([
      client.getIssue(projectId, issueIid),
      this.session.cachedRead(`project/${projectId}/members`, (readClient) => readClient.listProjectMembers(projectId)).catch(() => [])
    ]);
    this.selectedIssue = { project, issue };
    this.selectedProjectId = projectId;
    this.projectMembers = projectMembers;
    await this.context.globalState.update(this.selectedIssueKey(), { projectId, issueIid });
    this.sendSnapshot();
  }

  private async openIssue(projectId: number, issueIid: number, tab?: IssueDetailTab): Promise<void> {
    this.issueOpenAbort?.abort();
    const controller = new AbortController();
    this.issueOpenAbort = controller;
    const generation = ++this.issueOpenGeneration;
    const baseUrl = this.session.baseUrl;
    const groupId = this.session.selectedGroup?.id;
    requireIssueIid(issueIid);
    const project = this.requireGroupProject(projectId);
    const client = (await this.session.getClient()).withReadSignal(controller.signal);
    const [issue, projectMembers] = await Promise.all([
      client.getIssue(projectId, issueIid), this.session.cachedRead(`project/${projectId}/members`, (readClient) => readClient.listProjectMembers(projectId), { signal: controller.signal }).catch(() => [])
    ]);
    if (controller.signal.aborted || generation !== this.issueOpenGeneration || baseUrl !== this.session.baseUrl || groupId !== this.session.selectedGroup?.id) return;
    const fullProject = project;
    this.selectedIssue = { project: fullProject, issue };
    this.projectMembers = projectMembers;
    await this.context.globalState.update(this.selectedIssueKey(), { projectId, issueIid });
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
      }
    }
    this.post({ type: 'draftResults', analysisId: bundle.analysisId, results });
    await this.refresh();
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
    this.requireGroupProject(projectId);
    const issue = await (await this.session.getClient()).getIssue(projectId, issueIid);
    const project = this.projects.find((item) => item.id === projectId) ?? await (await this.session.getClient()).getProject(projectId);
    await this.enqueueTimer(() => this.timer.start(project, issue));
    this.syncTimerPolling();
    this.post({ type: 'message', message: `開始計時：${project.path_with_namespace}#${issue.iid}` });
    this.publishTimers();
  }

  private async addManualTime(projectId: number, issueIid: number, duration: string, summary: string, spentAt?: string): Promise<void> {
    requireIssueIid(issueIid);
    this.requireGroupProject(projectId);
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
      if (confirm !== '已確認不存在，重新排入') return;
    }
    await this.updateTimer(() => this.timer.updateEntry(id, duration, summary, spentAt));
  }

  private async acknowledgeTimeEntry(id: string): Promise<void> {
    const entry = this.timer.list().find((item) => item.id === id);
    if (!entry) throw new Error('找不到這筆工時。');
    const confirm = await vscode.window.showWarningMessage(`請先確認 GitLab 的 ${entry.projectPath}#${entry.issueIid} 已經有這筆 ${gitLabDuration(entry.elapsedSeconds)} 工時；系統不會替你重新送出。`, { modal: true }, '已在 GitLab 確認');
    if (confirm !== '已在 GitLab 確認') return;
    await this.updateTimer(() => this.timer.acknowledge(id));
  }

  private async submitTime(id: string): Promise<void> {
    const entry = this.timer.list().find((item) => item.id === id);
    if (!entry) throw new Error('找不到待送出的工時。');
    const client = await this.session.getClient();
    const issue = await client.getIssue(entry.projectId, entry.issueIid);
    const submitting = await this.enqueueTimer(() => this.timer.beginSubmit(id));
    this.publishTimers();
    try {
      if (this.session.issueCapabilities?.timelogCreate && issue.id) {
        const spentAt = submitting.spentAt ? new Date(`${submitting.spentAt}T12:00:00`).toISOString() : undefined;
        await client.createIssueTimelog(issue.id, gitLabDuration(submitting.elapsedSeconds), submitting.summary, spentAt);
      } else if (submitting.spentAt) {
        throw new Error('此 GitLab 版本不支援指定日期的工時紀錄。');
      } else {
        await client.addSpentTime(entry.projectId, entry.issueIid, gitLabDuration(submitting.elapsedSeconds), submitting.summary);
      }
      await this.enqueueTimer(() => this.timer.finishSubmit(id, true));
      this.post({ type: 'message', message: '工時已送至 GitLab。' });
    } catch (error) {
      await this.enqueueTimer(() => this.timer.finishSubmit(id, false));
      throw new Error(`工時送出結果尚未確認，請先到 GitLab 對帳；系統不會自動重送。${readableError(error)}`);
    } finally { this.publishTimers(); }
  }

  private async loadMergeRequest(projectId: number, iid: number): Promise<void> {
    this.requireGroupProject(projectId);
    this.mergeRequestAbort?.abort();
    const controller = new AbortController();
    this.mergeRequestAbort = controller;
    const generation = ++this.mergeRequestGeneration;
    const connectionGeneration = this.requestGeneration;
    this.post({ type: 'busy', value: true, label: '正在讀取 MR' });
    try {
      const client = (await this.session.getClient()).withReadSignal(controller.signal);
      const request = await client.getMergeRequest(projectId, iid);
      const [diffs, discussions] = await Promise.all([
        client.listMergeRequestDiffs(projectId, iid).catch(() => []),
        client.listMergeRequestDiscussions(projectId, iid).catch(() => [])
      ]);
      const detail = await this.getMergeRequestDetail(client, request, diffs, discussions);
      if (controller.signal.aborted || generation !== this.mergeRequestGeneration || connectionGeneration !== this.requestGeneration) return;
      this.selectedMergeRequest = detail;
      await this.context.globalState.update(this.selectedMergeRequestKey(), { projectId, iid });
    } catch (error) {
      if (!controller.signal.aborted) throw error;
    } finally {
      if (generation === this.mergeRequestGeneration) {
        this.post({ type: 'busy', value: false });
        this.sendSnapshot();
      }
    }
  }

  private async getMergeRequestDetail(client: GitLabClient, request: GitLabMergeRequest, diffs: MergeRequestDetail['diffs'], discussions: MergeRequestDetail['discussions']): Promise<MergeRequestDetail> {
    const visibleDiscussions = discussions.map((discussion) => ({
      ...discussion,
      notes: discussion.notes.map((note) => ({ ...note, body: note.body.replace(/\n?\n?<!-- gitlab-workspace:mr-write:[a-f0-9]{64} -->/g, '') }))
    }));
    const now = Date.now();
    let freshness: BranchFreshness = { state: 'unknown', reason: '無法比較 GitLab commit ancestry。', checkedAt: now };
    let targetSha: string | undefined;
    let sourceSha = request.diff_refs?.head_sha ?? request.sha;
    const targetProjectId = request.target_project_id ?? request.project_id;
    const sourceProjectId = request.source_project_id ?? request.project_id;
    const sourceProject = sourceProjectId === targetProjectId ? undefined : await client.getProject(sourceProjectId).catch(() => undefined);
    try {
      const [target, source] = await Promise.all([
        client.getRepositoryBranch(targetProjectId, request.target_branch),
        client.getRepositoryBranch(sourceProjectId, request.source_branch)
      ]);
      targetSha = target.commit.id;
      sourceSha = source.commit.id;
      const comparison = await client.compareRepository(targetProjectId, sourceSha, targetSha);
      if (comparison.compare_timeout) freshness = { state: 'unknown', reason: 'GitLab compare API 逾時，無法判定分支是否已同步。', checkedAt: now };
      else if (!comparison.commits.length) freshness = { state: 'current', sourceSha, targetSha, checkedAt: now };
      else freshness = { state: 'behind', behindBy: comparison.commits.length, sourceSha, targetSha, checkedAt: now };
    } catch (error) {
      freshness = { state: 'unknown', reason: readableError(error), checkedAt: now };
    }
    return { request, sourceProject, diffs, discussions: visibleDiscussions, freshness, sourceSha, targetSha, warnings: [] };
  }

  private async postMergeRequestNote(projectId: number, iid: number, body: string): Promise<void> {
    await this.publishMergeRequestText(projectId, iid, body);
  }

  private async liveReviewIdentity(projectId: number, iid: number): Promise<{ identity: MergeReviewIdentity; request: GitLabMergeRequest }> {
    this.requireGroupProject(projectId);
    requireIssueIid(iid);
    const client = await this.session.getClient();
    const request = await client.getMergeRequest(projectId, iid);
    const sourceProjectId = request.source_project_id ?? projectId;
    const targetProjectId = request.target_project_id ?? projectId;
    if (targetProjectId !== projectId) throw new Error('MR 目標專案與目前專案不一致。');
    const [source, target] = await Promise.all([
      client.getRepositoryBranch(sourceProjectId, request.source_branch),
      client.getRepositoryBranch(targetProjectId, request.target_branch)
    ]);
    const head = request.diff_refs?.head_sha ?? request.sha;
    if (!head || head !== source.commit.id) throw new Error('MR 與來源分支版本尚未一致，請重新整理後審查。');
    return { request, identity: {
      origin: this.session.baseUrl!.replace(/\/$/, ''), projectId, mrIid: iid,
      sourceProjectId, targetProjectId, sourceBranch: request.source_branch, targetBranch: request.target_branch,
      sourceSha: head, targetSha: target.commit.id
    } };
  }

  private async openMergeReviewTask(projectId: number, iid: number): Promise<void> {
    await this.assertWorkflowKitReady();
    const root = this.meginGroupRoot();
    const { identity, request } = await this.liveReviewIdentity(projectId, iid);
    const client = await this.session.getClient();
    const [target, source] = await Promise.all([client.getProject(identity.targetProjectId), client.getProject(identity.sourceProjectId)]);
    const repoPath = groupRepositoryPath(root, target, this.projects);
    if (await localRepositoryStateAsync(root, repoPath) !== 'ready') throw new Error('MR 的目標 Repo 尚未下載，或本機路徑不安全。');
    const remotes = (await git(repoPath, ['remote'])).split(/\r?\n/).filter(Boolean);
    const urls = await Promise.all(remotes.map((remote) => git(repoPath, ['remote', 'get-url', remote])));
    if (!urls.some((url) => projectRemoteMatches(url.trim(), target))) throw new Error('本機 Repo remote 與 MR 目標專案不一致。');
    if (!isAllowedGitRemote(identity.origin, source.http_url_to_repo) || !isAllowedGitRemote(identity.origin, target.http_url_to_repo)) throw new Error('MR remote 不屬於目前 GitLab。');
    const directory = path.join(root, 'review-reports', 'tasks');
    await mkdir(directory, { recursive: true });
    const taskFile = path.join(directory, `mr-${projectId}-${iid}-${randomUUID()}.json`);
    await writeFile(taskFile, JSON.stringify({ schema: 'MergeReviewTask/v1', ...identity, repoPath,
      sourceRemoteUrl: source.http_url_to_repo, targetRemoteUrl: target.http_url_to_repo, mode: 'merge' }, null, 2) + '\n', 'utf8');
    const prompt = buildReviewerPrompt(target, request, root, source, { repoPath, taskFile, sourceSha: identity.sourceSha, targetSha: identity.targetSha });
    await vscode.env.clipboard.writeText(prompt);
    await this.openCodexTerminal();
    this.post({ type: 'message', message: '已固定實際 Repo 與來源／目標 SHA。請貼上任務審查，完成後匯入報告。' });
  }

  private async openGroupQuickReview(): Promise<void> {
    await this.assertWorkflowKitReady();
    const root = this.meginGroupRoot();
    const script = path.join(root, '.agents', 'skills', 'merge-reviewer', 'scripts', 'git_review_context.py');
    if (!await exists(script) || !(await readFile(script, 'utf8')).includes('--group-root')) throw new Error('請先安裝支援 Group 審查的 MergeReviewer 0.5.0 以上。');
    const prompt = `$merge-reviewer 請審查 Group「${root}」下一層所有 Repo 的未提交內容。使用 git_review_context.py --group-root "${root}" --quick，分別審查固定的暫存區與工作檔快照，保留版本證據，輸出 Group 總覽與各 Repo 報告。`;
    await vscode.env.clipboard.writeText(prompt);
    await this.openCodexTerminal();
    this.post({ type: 'message', message: '已複製整個 Group 的未提交內容審查任務。' });
  }

  private async importMergeReviewReport(projectId: number, iid: number, text?: string): Promise<void> {
    if (text === undefined) {
      const picked = await vscode.window.showOpenDialog({ canSelectMany: false, filters: { '審查報告': ['md', 'json'] }, openLabel: '匯入審查報告' });
      if (!picked?.[0]) return;
      text = await readFile(picked[0].fsPath, 'utf8');
    }
    const report = parseMergeReviewReport(text);
    const { identity } = await this.liveReviewIdentity(projectId, iid);
    validateReportIdentity(report, identity);
    this.post({ type: 'mergeReviewReportImported', projectId, iid, text: report.text,
      sourceSha: report.metadata.sourceSha, targetSha: report.metadata.targetSha });
    this.post({ type: 'message', message: '已核對報告正文、MR 身分及來源／目標版本。' });
  }

  private async publishMergeReviewReport(projectId: number, iid: number, text: string): Promise<void> {
    const report = parseMergeReviewReport(text);
    const { identity } = await this.liveReviewIdentity(projectId, iid);
    validateReportIdentity(report, identity);
    await this.publishMergeRequestText(projectId, iid, report.text, undefined, async () => {
      const current = await this.liveReviewIdentity(projectId, iid);
      validateReportIdentity(report, current.identity);
    });
  }

  private async replyMergeRequest(projectId: number, iid: number, discussionId: string, body: string): Promise<void> {
    const detail = this.selectedMergeRequest;
    if (detail?.request.project_id !== projectId || detail.request.iid !== iid || !detail.discussions.some((item) => item.id === discussionId)) throw new Error('找不到這則 MR 討論，請重新整理。');
    await this.publishMergeRequestText(projectId, iid, body, discussionId);
  }

  private async publishMergeRequestText(projectId: number, iid: number, body: string, discussionId?: string, beforePublish?: () => Promise<void>): Promise<void> {
    this.requireGroupProject(projectId);
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
      await this.loadMergeRequest(projectId, iid);
      return;
    }
    if (pending) {
      const confirm = await vscode.window.showWarningMessage('先前的評論送出結果仍不確定。已查詢 GitLab 但尚未找到標記；請先人工確認此 MR，確認不存在後才可重試。', { modal: true }, '我已確認不存在，重試');
      if (confirm !== '我已確認不存在，重試') return;
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
        throw new Error(`評論送出結果尚未確認；已保留對帳標記，請先檢查 GitLab，不會自動重送。${readableError(error)}`);
      }
    }
    await this.savePendingMrWrite(undefined, key);
    this.post({ type: 'message', message: discussionId ? '已回覆 MR 討論。' : '已發布 MR 評論。' });
    await this.loadMergeRequest(projectId, iid);
    } finally { this.mrWritesInFlight.delete(key); }
  }

  private async approveMergeRequest(projectId: number, iid: number, sha: string): Promise<void> {
    this.requireGroupProject(projectId);
    requireIssueIid(iid);
    const client = await this.session.getClient();
    const latest = await client.getMergeRequest(projectId, iid);
    if (!sha || latest.diff_refs?.head_sha !== sha) throw new Error('MR head SHA 已變更，請重新整理審查結果。');
    const confirm = await vscode.window.showInformationMessage(`核准 ${latest.references?.full ?? `!${iid}`}，SHA ${sha.slice(0, 12)}？`, { modal: true }, '核准');
    if (confirm !== '核准') return;
    await client.approveMergeRequest(projectId, iid, sha);
    this.post({ type: 'message', message: '已送出 MR 核准。' });
    await this.loadMergeRequest(projectId, iid);
  }

  private async mergeMergeRequest(projectId: number, iid: number, sha: string): Promise<void> {
    this.requireGroupProject(projectId);
    requireIssueIid(iid);
    const client = await this.session.getClient();
    const latest = await client.getMergeRequest(projectId, iid);
    if (!sha || latest.diff_refs?.head_sha !== sha) throw new Error('MR head SHA 已變更，請重新整理後再合併。');
    const target = await client.getRepositoryBranch(latest.target_project_id ?? projectId, latest.target_branch);
    const confirm = await vscode.window.showWarningMessage(
      `確認合併 ${latest.references?.full ?? `!${iid}`}？\n來源：${latest.source_branch}\n目標：${latest.target_branch}\n來源 SHA：${sha}\n目標最新 SHA：${target.commit.id}\nGitLab 專案規則仍會檢查 Pipeline 與合併權限。`,
      { modal: true }, '合併 MR'
    );
    if (confirm !== '合併 MR') return;
    await client.mergeMergeRequest(projectId, iid, sha);
    this.post({ type: 'message', message: 'GitLab 已接受 MR 合併要求。' });
    await this.loadMergeRequest(projectId, iid);
    await this.refresh();
  }

  private meginGroupRoot(): string {
    const group = this.session.selectedGroup;
    const root = this.session.baseUrl && group ? this.roots.getRoot(this.session.baseUrl, group.id) : undefined;
    if (!root) throw new Error('請先選擇 Group 工作目錄。');
    return root;
  }

  private async runMeginHandoff(action: 'inspect' | 'commit' | 'completed', workId: string, digest?: string, messageFile?: string): Promise<MeginHandoff> {
    if (!/^work-\d{8}-[a-z0-9-]+$/.test(workId)) throw new Error('請輸入 Megin Work ID：work-YYYYMMDD-slug。');
    const root = this.meginGroupRoot();
    const script = path.join(root, '.agents', 'skills', 'megin', 'scripts', 'gitlab_delivery.py');
    if (!await exists(script)) throw new Error('請先安裝 Megin 0.2.0 以上，並完成 gitlab_mr 驗收交接。');
    const configured = vscode.workspace.getConfiguration('gitlabWorkspace').get<string>('pythonPath', 'python');
    const python = await resolvePythonRuntime(configured);
    const args = [...python.args, '-X', 'utf8', '-B', script, action, '--group-root', root, '--work-id', workId];
    if (digest) args.push('--handoff-sha256', digest);
    if (action === 'commit') {
      let writer = this.context.globalState.get<string>('gitlabWorkspace.meginWriter');
      if (!writer) { writer = `gitlab-workspace-${randomUUID()}`; await this.context.globalState.update('gitlabWorkspace.meginWriter', writer); }
      args.push('--writer', writer, '--message-file', messageFile!);
    }
    try {
      const result = await execFileAsync(python.executable, args, { cwd: root, env: { ...python.env, GIT_TERMINAL_PROMPT: '0' }, timeout: 3 * 60_000, maxBuffer: 12 * 1024 * 1024, windowsHide: true });
      return parseMeginHandoff(JSON.parse(result.stdout), workId);
    } catch (error) { throw new Error(`Megin 交接檢查未通過；已保留工作現場。${readableError(error)}`); }
  }

  private async validateWorkspaceHandoff(value: MeginHandoff): Promise<void> {
    const root = this.meginGroupRoot();
    if (!sameRealLocalPath(value.group_root, root) || value.gitlab.origin !== this.session.baseUrl?.replace(/\/$/, '')) throw new Error('交接證據不屬於目前 Group 或 GitLab。');
    const client = await this.session.getClient();
    for (const item of value.repositories) {
      const project = this.requireGroupProject(item.gitlab_project_id);
      const repoPath = groupRepositoryPath(root, project, this.projects);
      if (project.path_with_namespace !== item.gitlab_namespace || !sameRealLocalPath(repoPath, path.join(root, item.repo_path)) ||
          !projectRemoteMatches(item.remote_url, project)) throw new Error('交接 Repo 路徑、GitLab project ID 或 remote 身分不一致。');
      if (value.state !== 'complete') {
        const target = await client.getRepositoryBranch(project.id, item.base_branch);
        if (target.commit.id !== item.base_commit) throw new Error(`${project.path_with_namespace} 目標分支已更新，請重新規劃、驗證與驗收。`);
      }
    }
  }

  private async prepareDelivery(request: Extract<WorkspaceRequest, { type: 'prepareDelivery' }>): Promise<void> {
    requireIssueIid(request.issueIid);
    const group = this.session.selectedGroup;
    const userId = this.currentUser?.id;
    const root = this.meginGroupRoot();
    if (!group || !userId) throw new Error('請先選擇 GitLab Group。');
    this.requireGroupProject(request.projectId);
    const value = await this.runMeginHandoff('inspect', request.workId);
    await this.validateWorkspaceHandoff(value);
    if (value.gitlab.issue_project_id !== request.projectId || value.gitlab.issue_iid !== request.issueIid) throw new Error('Work ID 的核准 Issue 與目前 Issue 不同。');
    const summary = checkedText(request.summary, 'Commit 摘要', 200);
    if (/[\r\n]/.test(summary)) throw new Error('Commit 摘要必須是一行文字。');
    const changes = request.changes.trim() ? checkedText(request.changes, '修改內容', 12_000) : summary;
    const evidenceText = value.checks.map((check) => `${check.id}: ${check.status}${check.executed === undefined ? '' : ` (${check.executed} tests)`}`).join('\n');
    const tests = request.tests.trim() ? checkedText(request.tests, '驗證摘要', 8_000) : evidenceText;
    const approvedRepositories = value.repositories.map((item) => ({ repoPath: item.repo_path, projectId: item.gitlab_project_id,
      branch: item.feature_branch, baseSha: item.base_commit, allowedPaths: item.allowed_paths,
      commit: value.delivery?.repositories.find((r) => r.repo_path === item.repo_path)?.feature_commit }));
    for (const item of value.repositories) {
      const project = this.requireGroupProject(item.gitlab_project_id);
      const repoPath = groupRepositoryPath(root, project, this.projects);
      const commit = value.delivery?.repositories.find((r) => r.repo_path === item.repo_path)?.feature_commit;
      const ref = value.state === 'complete' ? commit! : undefined;
      const diffArgs = ['diff', '--no-ext-diff', '--binary', ...(ref ? [item.base_commit, ref] : ['--cached', item.base_commit]), '--'];
      const rawDiff = await git(repoPath, diffArgs, { maxBuffer: 12 * 1024 * 1024 });
      const id = createHash('sha256').update(`${this.deliveryInstanceScope()}:${request.workId}:${project.id}:${value.handoff_sha256}`).digest('hex');
      const previous = this.deliveryRecords().find((r) => r.id === id);
      const delivery: DeliveryRecord = {
        id, groupId: group.id, userId, instanceScope: this.deliveryInstanceScope(), projectId: project.id,
        issueIid: request.issueIid, issueProjectId: request.projectId, repoPath, groupRoot: root,
        branch: item.feature_branch, targetBranch: item.base_branch, remote: item.remote, remoteUrl: item.remote_url,
        workId: request.workId, summary, changes, tests, acceptanceConfirmed: true,
        handoffSha256: value.handoff_sha256, planVersion: value.plan_version,
        acceptanceVersion: value.acceptance.version, acceptedSnapshot: value.snapshot, approvedRepositories,
        reviewResult: { verdict: value.review.verdict, context: value.review.context, snapshot: value.review.snapshot },
        verificationResults: value.checks.map(({ id, status, executed }) => ({ id, status, executed })),
        reviewerIds: (Array.isArray(request.reviewerIds) ? request.reviewerIds : []).filter((id) => Number.isSafeInteger(id) && id > 0).slice(0, 50),
        headSha: commit ?? item.snapshot.head, baseSha: item.base_commit, baseTargetSha: item.base_commit,
        diffSha256: createHash('sha256').update(rawDiff).digest('hex'), statusSnapshot: '',
        diffStat: `${item.staged.staged_paths.length} accepted changed paths`, diff: rawDiff.slice(0, MAX_DIFF_BYTES),
        changedFiles: item.staged.staged_paths, gate: { ok: true, reasons: [] },
        state: value.state === 'complete' ? previous?.state === 'pushed' || previous?.state === 'mr-created' ? previous.state : 'committed' : 'preview',
        mergeRequestUrl: previous?.mergeRequestUrl, updatedAt: Date.now()
      };
      await this.saveDelivery(delivery);
      this.post({ type: 'deliveryPreview', delivery });
    }
    this.sendSnapshot();
    this.post({ type: 'message', message: `已核對 ${value.acceptance.version} 的交接證據，共 ${value.repositories.length} 個核准 Repo。` });
  }

  private async commitDelivery(id: string): Promise<void> {
    const record = this.requireDelivery(id);
    if (!record.handoffSha256) throw new Error('舊交付紀錄沒有原生驗收證據，請重新載入 Megin 交接。');
    if (record.state !== 'preview') throw new Error('本機交付已完成，請從 Push／MR 步驟繼續。');
    const value = await this.runMeginHandoff('inspect', record.workId, record.handoffSha256);
    await this.validateWorkspaceHandoff(value);
    const temporary = await mkdtemp(path.join(os.tmpdir(), 'gitlab-workspace-commit-'));
    const messageFile = path.join(temporary, 'message.txt');
    try {
      await writeFile(messageFile, `${record.summary}\n\n${record.changes}\n\n驗證：\n${record.tests}`, 'utf8');
      const result = await this.runMeginHandoff('commit', record.workId, record.handoffSha256, messageFile);
      for (const entry of this.deliveryRecords().filter((r) => r.workId === record.workId && r.handoffSha256 === record.handoffSha256 && r.instanceScope === record.instanceScope)) {
        const commit = result.delivery?.repositories.find((r) => r.repo_path === path.basename(entry.repoPath))?.feature_commit;
        if (!commit) throw new Error('完成證據缺少 Repo commit；請重新載入交接。');
        const updated: DeliveryRecord = { ...entry, headSha: commit, state: 'committed', updatedAt: Date.now(),
          approvedRepositories: entry.approvedRepositories?.map((r) => ({ ...r, commit: result.delivery?.repositories.find((item) => item.repo_path === r.repoPath)?.feature_commit })) };
        await this.saveDelivery(updated); this.post({ type: 'deliveryProgress', delivery: updated });
      }
      this.sendSnapshot();
      this.post({ type: 'message', message: '所有核准 Repo 本機提交已驗證，Group 鎖已釋放；可依序 Push 與建立 MR。' });
    } finally { await unlink(messageFile).catch(() => undefined); await rmdir(temporary).catch(() => undefined); }
  }

  private async copyWikiUpdatePrompt(id: string): Promise<void> {
    await this.assertWorkflowKitReady();
    const record = this.requireDelivery(id);
    if (!record.handoffSha256) throw new Error('交付紀錄缺少 Megin handoff 證據。');
    const related = this.deliveryRecords().filter((item) => item.workId === record.workId && item.handoffSha256 === record.handoffSha256 && item.instanceScope === record.instanceScope);
    if (!related.length || related.some((item) => item.state === 'preview' || item.instanceVerified === false)) {
      throw new Error('所有核准 Repo 的本機交付都完成並保存後，才能建立 Wiki 更新任務。');
    }
    const handoff = await this.runMeginHandoff('inspect', record.workId, record.handoffSha256);
    await this.validateWorkspaceHandoff(handoff);
    if (handoff.state !== 'complete' || handoff.delivery?.completion_ok !== true) throw new Error('Megin 尚未確認所有核准 Repo 的本機交付完成。');
    const commits = handoff.delivery.repositories;
    if (commits.length !== handoff.repositories.length || commits.some((item) => !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(item.feature_commit))) {
      throw new Error('完成交接缺少有效的 Repo commit SHA。');
    }
    const evidence: Array<{ projectPath: string; repoPath: string; commit: string; changedPaths: string[] }> = [];
    for (const item of handoff.repositories) {
      const delivery = commits.find((entry) => entry.repo_path === item.repo_path);
      if (!delivery) throw new Error(`Megin 完成交付缺少 Repo：${item.repo_path}`);
      const project = this.requireGroupProject(item.gitlab_project_id);
      evidence.push({ projectPath: project.path_with_namespace, repoPath: item.repo_path,
        commit: delivery.feature_commit, changedPaths: item.staged.staged_paths });
    }
    const client = await this.session.getClient();
    const issueProject = this.requireGroupProject(handoff.gitlab.issue_project_id);
    const issue = await client.getIssue(handoff.gitlab.issue_project_id, handoff.gitlab.issue_iid);
    const groupRoot = this.meginGroupRoot();
    const prompt = buildPostDeliveryWikiUpdatePrompt({
      groupRoot,
      wikiPath: path.join(groupRoot, 'wiki'),
      issue: { projectPath: issueProject.path_with_namespace, iid: issue.iid, webUrl: issue.web_url },
      workId: handoff.work_id,
      planVersion: handoff.plan_version,
      acceptanceVersion: handoff.acceptance.version,
      handoffSha256: handoff.handoff_sha256,
      repositories: evidence,
      changes: record.changes,
      verification: record.tests,
      checks: handoff.checks,
      mergeStates: related.map((item) => ({ repoPath: item.repoPath, state: item.state, mergeRequestUrl: item.mergeRequestUrl }))
    });
    await vscode.env.clipboard.writeText(prompt);
    this.post({ type: 'message', message: '已複製交付後 Wiki 更新任務；內容已包含 Work ID、Repo commit 與驗證證據。' });
  }

  private async pushDelivery(id: string): Promise<void> {
    const record = this.requireDelivery(id);
    if (record.state !== 'committed') throw new Error('Commit 尚未完成，不能 Push。');
    await this.verifyDeliveredCommit(record);
    const client = await this.session.getClient();
    const project = await client.getProject(record.projectId);
    const existingBranch = await client.getRepositoryBranch(project.id, record.branch).catch((error: unknown) => {
      if (error instanceof GitLabApiError && error.status === 404) return undefined;
      throw error;
    });
    if (existingBranch) {
      if (existingBranch.commit.id !== record.headSha) throw new Error('遠端交付分支已有不同版本；請先檢查衝突，工作台不會覆寫或 force push。');
      const updated = { ...record, state: 'pushed' as const, updatedAt: Date.now() };
      await this.saveDelivery(updated);
      this.post({ type: 'deliveryProgress', delivery: updated });
      return;
    }
    const credentials = await this.session.getCloneCredentials();
    const remote = await git(record.repoPath, ['remote', 'get-url', record.remote!]);
    if (!isAllowedGitRemote(credentials.baseUrl, project.http_url_to_repo) || !projectRemoteMatches(remote.trim(), project)) {
      throw new Error('已核准 remote 不屬於目前 GitLab Project，已停止 Push。');
    }
    const confirm = await vscode.window.showWarningMessage(`將 ${record.headSha.slice(0, 12)} Push 至 ${project.path_with_namespace}:${record.branch}。`, { modal: true }, 'Push');
    if (confirm !== 'Push') return;
    let pushEnv: NodeJS.ProcessEnv | undefined;
    try {
      const remoteUrl = new URL(remote.trim());
      if (remoteUrl.protocol === 'https:' || remoteUrl.protocol === 'http:') pushEnv = createScopedGitEnvironment(remote.trim(), credentials.token);
    } catch { /* SSH remotes use the user's configured SSH agent. */ }
    try { await git(record.repoPath, ['push', record.remote!, `${record.headSha}:refs/heads/${record.branch}`], { env: pushEnv }); }
    catch (error) {
      const observed = await client.getRepositoryBranch(project.id, record.branch).catch(() => undefined);
      if (observed?.commit.id !== record.headSha) throw new Error(`Push 結果尚未確認；請先檢查 GitLab 分支 ${record.branch}，系統不會自動重送。${readableError(error)}`);
    }
    const pushedBranch = await client.getRepositoryBranch(project.id, record.branch);
    if (pushedBranch.commit.id !== record.headSha) throw new Error('GitLab 遠端分支 SHA 與本機交付 SHA 不同；已 Push，請重新整理 GitLab 後再建立 MR。');
    const updated = { ...record, state: 'pushed' as const, updatedAt: Date.now() };
    await this.saveDelivery(updated);
    this.post({ type: 'deliveryProgress', delivery: updated });
  }

  private async createDeliveryMergeRequest(id: string): Promise<void> {
    const record = this.requireDelivery(id);
    if (record.state !== 'pushed') throw new Error('Push 尚未完成；已 Push 的內容可從此步驟重試建立 MR。');
    await this.verifyDeliveredCommit(record);
    const client = await this.session.getClient();
    const issue = await client.getIssue(record.issueProjectId ?? record.projectId, record.issueIid);
    const project = await client.getProject(record.projectId);
    const found = await client.findOpenMergeRequestsBySourceBranch(record.projectId, record.branch);
    const matchingBranch = found.filter((item) => item.project_id === record.projectId && item.source_branch === record.branch && item.state === 'opened');
    const duplicate = matchingBranch.find((item) => item.target_branch === record.targetBranch && (item.diff_refs?.head_sha ?? item.sha) === record.headSha);
    if (duplicate) {
      const updated = { ...record, state: 'mr-created' as const, mergeRequestUrl: duplicate.web_url, updatedAt: Date.now() };
      await this.saveDelivery(updated); this.post({ type: 'deliveryProgress', delivery: updated }); return;
    }
    if (matchingBranch.length) throw new Error('此來源分支已有其他內容或目標分支的 MR；請先檢查 GitLab，工作台不會重複建立。');
    const description = [
      `## Issue\nRelates to ${issue.web_url}\nMegin Work ID: ${record.workId}\n驗收版本: ${record.acceptanceVersion}`,
      `## 修改摘要\n${record.changes}`,
      `## 測試與驗收\n${record.tests}`,
      `## 來源與目標\n${record.branch} → ${record.targetBranch}`,
      `\n<!-- gitlab-workspace-head-sha:${record.headSha} -->`
    ].join('\n\n');
    try {
      const latestBranch = await client.getRepositoryBranch(record.projectId, record.branch);
      if (latestBranch.commit.id !== record.headSha) throw new Error('遠端來源分支 SHA 已變動；請先重新審查此分支。');
      const reviewers = record.reviewerIds.length ? await client.listProjectMembers(record.projectId) : [];
      const eligibleReviewers = new Set(reviewers.map((member) => member.id));
      if (record.reviewerIds.some((id) => !eligibleReviewers.has(id))) throw new Error('部分 Reviewer 已不屬於此專案，請重新選擇。');
      const mr = await client.createMergeRequest(record.projectId, { title: record.summary.startsWith(`[${project.path_with_namespace}#${issue.iid}]`) ? record.summary : `[${project.path_with_namespace}#${issue.iid}] ${record.summary}`, description, sourceBranch: record.branch, targetBranch: record.targetBranch, reviewerIds: record.reviewerIds });
      const updated = { ...record, state: 'mr-created' as const, mergeRequestUrl: mr.web_url, updatedAt: Date.now() };
      await this.saveDelivery(updated); this.post({ type: 'deliveryProgress', delivery: updated });
    } catch (error) {
      const rechecked = await client.findOpenMergeRequestsBySourceBranch(record.projectId, record.branch).catch(() => []);
      const created = rechecked.find((item) => item.project_id === record.projectId && item.source_branch === record.branch && item.target_branch === record.targetBranch && item.state === 'opened' && (item.diff_refs?.head_sha ?? item.sha) === record.headSha);
      if (created) {
        const updated = { ...record, state: 'mr-created' as const, mergeRequestUrl: created.web_url, updatedAt: Date.now() };
        await this.saveDelivery(updated); this.post({ type: 'deliveryProgress', delivery: updated }); return;
      }
      throw new Error(`MR 建立結果尚未確認，請重新整理 GitLab 後檢查來源分支 ${record.branch}，不要重新 Commit 或 Push。${readableError(error)}`);
    }
  }

  private deliveryRecords(): DeliveryRecord[] {
    const value = this.context.globalState.get<DeliveryRecord[]>(DELIVERIES_KEY, []);
    return Array.isArray(value) ? value.filter((record) => !!record && typeof record.id === 'string') : [];
  }
  private async verifyDeliveredCommit(record: DeliveryRecord): Promise<void> {
    const value = await this.runMeginHandoff('completed', record.workId, record.handoffSha256);
    await this.validateWorkspaceHandoff(value);
    const commit = value.delivery?.repositories.find((repo) => repo.repo_path === path.basename(record.repoPath))?.feature_commit;
    if (commit !== record.headSha) throw new Error('交付 commit 與已驗證的本機完成證據不符。');
  }
  private deliveryInstanceScope(): string | undefined {
    return this.session.baseUrl ? createHash('sha256').update(this.session.baseUrl).digest('hex') : undefined;
  }
  private requireDelivery(id: string): DeliveryRecord {
    const instanceScope = this.deliveryInstanceScope();
    const record = this.deliveryRecords().find((item) => item.id === id && item.groupId === this.session.selectedGroup?.id &&
      item.userId === this.currentUser?.id && instanceScope !== undefined && item.instanceScope === instanceScope);
    if (!record) throw new Error('找不到已確認屬於目前 GitLab、Group 與使用者的交付紀錄。');
    if (!record.handoffSha256 || !record.groupRoot || !sameRealLocalPath(record.groupRoot, this.meginGroupRoot())) throw new Error('此紀錄沒有有效的 Megin 交接證據，請重新載入 Work ID。');
    return record;
  }
  private async saveDelivery(record: DeliveryRecord): Promise<void> {
    const entries = this.deliveryRecords().filter((item) => item.id !== record.id || item.instanceScope !== record.instanceScope);
    entries.unshift(record);
    await this.context.globalState.update(DELIVERIES_KEY, entries.slice(0, 100));
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
    if (entry) entries.unshift(entry);
    await this.context.globalState.update(MR_WRITES_KEY, entries.slice(0, 250));
  }

  private workflowKitSource(): ToolSource {
    const source = this.context.globalState.get<unknown>(TOOL_SOURCE_KEY);
    return source === 'github' || source === 'gitea' || source === 'bundled' ? source : 'bundled';
  }

  private async assertWorkflowKitReady(): Promise<void> {
    const root = this.meginGroupRoot();
    await this.refreshWorkflowKit(false, root);
    if (this.workflowKitState.status !== 'installed' && this.workflowKitState.status !== 'work-in-progress') {
      throw new Error(this.workflowKitState.message ?? '請先從工具設定安裝或更新 GitLab Workspace 完整工作流程包。');
    }
  }

  private async setWorkflowKitSource(source: ToolSource): Promise<void> {
    if (!['gitea', 'github', 'bundled'].includes(source)) throw new Error('Invalid workflow kit source.');
    await this.context.globalState.update(TOOL_SOURCE_KEY, source);
    await this.refreshWorkflowKit();
  }

  private workflowKitHelper(): string {
    return vscode.Uri.joinPath(this.context.extensionUri, 'resources', 'workflow-kit-installer.py').fsPath;
  }

  private async runWorkflowKitHelper(args: string[], timeout = 10 * 60_000): Promise<Record<string, unknown>> {
    const pythonPath = vscode.workspace.getConfiguration('gitlabWorkspace').get<string>('pythonPath', 'python');
    const python = await resolvePythonRuntime(pythonPath);
    const result = await execFileAsync(python.executable, [...python.args, this.workflowKitHelper(), ...args], {
      cwd: this.context.extensionUri.fsPath, env: python.env, timeout, maxBuffer: 1024 * 1024, windowsHide: true
    });
    const value = parseLastJsonLine(result.stdout) as Record<string, unknown>;
    if (value.ok !== true) throw new Error(typeof value.error === 'string' ? value.error : 'Workflow kit operation was not confirmed.');
    return value;
  }

  private async refreshWorkflowKit(publish = true, selectedRoot?: string): Promise<void> {
    const group = this.session.selectedGroup;
    const root = selectedRoot ?? (this.session.baseUrl && group ? this.roots.getRoot(this.session.baseUrl, group.id) : undefined);
    this.workflowKitPackages = await this.packages.listPackages();
    if (!root) {
      this.workflowKitState = { status: 'missing' };
    } else {
      try {
        const response = await this.runWorkflowKitHelper(['status', root, '--expected-version', String(this.context.extension.packageJSON.version)], 60_000);
        const valid = ['installed', 'missing', 'update-available', 'work-in-progress', 'needs-cleanup', 'error'].includes(String(response.status));
        this.workflowKitState = valid ? {
          status: response.status as InstalledWorkflowKitState['status'],
          version: typeof response.version === 'string' ? response.version : undefined,
          source: response.source === 'bundled' || response.source === 'gitea' || response.source === 'github' ? response.source : undefined,
          message: typeof response.message === 'string' ? response.message : undefined,
          legacyPaths: Array.isArray(response.legacyPaths) ? response.legacyPaths.filter((item): item is string => typeof item === 'string') : undefined
        } : { status: 'error', message: 'Workflow kit status response is invalid.' };
      } catch (error) {
        this.workflowKitState = { status: 'error', message: readableError(error) };
      }
    }
    if (publish) this.sendSnapshot();
  }

  private async openWorkflowKitDownload(source: RemoteToolSource): Promise<void> {
    if (source !== 'gitea' && source !== 'github') throw new Error('Invalid download source.');
    await vscode.env.openExternal(vscode.Uri.parse(WORKFLOW_KIT_RELEASES[source]));
  }

  private async importWorkflowKitPackage(source: RemoteToolSource): Promise<void> {
    if (source !== 'gitea' && source !== 'github') throw new Error('Invalid import source.');
    const selection = await vscode.window.showOpenDialog({
      canSelectFiles: true, canSelectFolders: false, canSelectMany: false,
      openLabel: 'Import workflow kit ZIP', filters: { 'Workflow kit ZIP': ['zip'] }
    });
    const archive = selection?.[0];
    if (!archive) return;
    const inspected = await this.runWorkflowKitHelper(['inspect', archive.fsPath, '--format', 'zip', '--expected-version', String(this.context.extension.packageJSON.version)], 3 * 60_000);
    if (inspected.package !== 'gitlab-workspace-kit' || inspected.version !== this.context.extension.packageJSON.version ||
      typeof inspected.sha256 !== 'string' || !/^[a-f0-9]{64}$/i.test(inspected.sha256)) {
      throw new Error(typeof inspected.error === 'string' ? inspected.error : 'The ZIP does not match this workflow kit version.');
    }
    const selected = await this.packages.importPackage({
      version: String(inspected.version), source, assetName: path.basename(archive.fsPath), archivePath: archive.fsPath,
      verifiedSha256: inspected.sha256.toLowerCase()
    });
    await this.refreshWorkflowKit();
    this.post({ type: 'message', message: `GitLab Workspace kit v${selected.version} saved for offline installation.` });
  }

  private async installWorkflowKit(packageId: string): Promise<void> {
    if (typeof packageId !== 'string' || !packageId) throw new Error('Select a workflow kit version first.');
    const group = this.session.selectedGroup;
    const root = this.session.baseUrl && group ? this.roots.getRoot(this.session.baseUrl, group.id) : undefined;
    if (!root) throw new Error('Select a non-Git Group workspace first.');
    this.workflowKitState = { ...this.workflowKitState, status: 'installing' };
    this.sendSnapshot();
    try {
      const selected = await this.packages.getPackage(packageId);
      const result = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification,
        title: `Install GitLab Workspace kit v${selected.version}`, cancellable: false }, () =>
        this.runWorkflowKitHelper(['install', selected.archivePath, root, selected.version, selected.source,
          '--format', selected.format, '--entry-root', selected.entryRoot, '--archive-sha256', selected.sha256]));
      if (result.package !== 'gitlab-workspace-kit' || result.version !== selected.version) throw new Error('The installer returned an unexpected package identity.');
      this.post({ type: 'message', message: `GitLab Workspace kit v${selected.version} installed in ${root}.` });
    } catch (error) {
      this.workflowKitState = { status: 'error', message: readableError(error) };
      this.sendSnapshot();
      throw error;
    } finally {
      await this.refreshWorkflowKit();
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
  const result = await execFileAsync('git', args, { cwd, env: options.env, windowsHide: true, timeout: 60_000, maxBuffer: options.maxBuffer ?? 2 * 1024 * 1024, encoding: 'utf8' });
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

async function readMeginWorkItems(groupRoot: string): Promise<MeginWorkSummary[]> {
  const workRoot = path.join(groupRoot, 'docs', 'work');
  let entries: import('node:fs').Dirent[];
  try { entries = await readdir(workRoot, { withFileTypes: true }); }
  catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return [];
    throw error;
  }
  if (entries.length > 5000) return [];
  const result: MeginWorkSummary[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^work-[A-Za-z0-9._-]{1,120}$/.test(entry.name)) continue;
    const directory = path.join(workRoot, entry.name);
    const workflow = path.join(directory, 'workflow.md');
    try {
      const directoryInfo = await lstat(directory);
      const fileInfo = await lstat(workflow);
      if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink() || !fileInfo.isFile() || fileInfo.isSymbolicLink() || fileInfo.size > 1024 * 1024) continue;
      const text = await readFile(workflow, 'utf8');
      const field = (names: string[]): string | undefined => {
        const match = text.match(new RegExp(`^\\s*-?\\s*(?:${names.join('|')})\\s*:\\s*(.*?)\\s*$`, 'im'));
        return match?.[1]?.trim().replace(/^([`"'])(.*)\1$/, '$2');
      };
      const status = field(['status'])?.toLocaleLowerCase('en-US') ?? 'unknown';
      const issueProjectId = Number(field(['issue_project_id', 'gitlab_project_id', 'project_id']));
      const issueIid = Number(field(['issue_iid', 'gitlab_issue_iid', 'issue_number']));
      const issue = field(['issue_url', 'gitlab_issue_url', 'issue']);
      const issueMatch = issue?.match(/https?:\/\/[^/]+\/(.+)\/(?:-\/)?issues\/([1-9]\d*)$/i);
      const parsed: MeginWorkSummary = {
        workId: entry.name,
        status,
        planVersion: field(['plan_version']),
        issueProjectId: Number.isSafeInteger(issueProjectId) && issueProjectId > 0 ? issueProjectId : undefined,
        issueIid: Number.isSafeInteger(issueIid) && issueIid > 0 ? issueIid : issueMatch ? Number(issueMatch[2]) : undefined,
        projectPath: field(['issue_project_path', 'gitlab_project_path', 'project_path']) ?? issueMatch?.[1]
      };
      result.push(parsed);
    } catch (error) {
      if (!(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')) throw error;
    }
  }
  return result.sort((a, b) => (a.status === 'complete' ? 1 : 0) - (b.status === 'complete' ? 1 : 0) || a.workId.localeCompare(b.workId));
}
