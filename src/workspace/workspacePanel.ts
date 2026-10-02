import * as vscode from 'vscode';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { access, readFile } from 'node:fs/promises';
import path from 'node:path';
import type { GitLabClient } from '../api/gitLabClient';
import type { GitLabGroup, GitLabIssue, GitLabIssueBoard, GitLabMergeRequest, GitLabMilestone, GitLabProject, GitLabUser } from '../api/types';
import type { IssueFormOptions } from '../issues/protocol';
import type { IssuePanels } from '../issues/issuePanel';
import { cloneProjects, createScopedGitEnvironment, projectRemoteMatches, syncLocalDefaultBranches } from '../git/cloneService';
import { GroupWorkspaceRegistry, groupRepositoryPath, localRepositoryState, sameRealLocalPath } from './workspacePaths';
import { resolvePythonRuntime } from './pythonRuntime';
import { windowsCodexTerminalOptions } from './windowsTerminal';
import { IssueTimeTracker, gitLabDuration } from './timeTracker';
import { evaluateMeginDeliveryGate } from './deliveryGate';
import { buildIssueDraftDescription, containsIssueDraftMarker, matchDraftProject, parseIssueDraftBundle } from './issueDrafts';
import { isTool, isVersion, ToolPackageManager, TOOL_DEFINITIONS, TOOL_SOURCE_KEY } from './toolPackages';
import type {
  BranchFreshness, DeliveryPreview, DraftIssueResult, InstalledToolState, IssueDetailTab, IssueDraft,
  CloneOperationState, IssueNavigation, MergeRequestDetail, RemoteToolSource, ToolId, ToolSource, WorkspaceMode, WorkspaceRequest, WorkspaceSnapshot, WorkspaceTimerEntry
} from './workspaceProtocol';
import type { ToolPackage } from './toolPackages';
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
  private readonly packages: ToolPackageManager;
  private interval?: NodeJS.Timeout;
  private groups: WorkspaceSnapshot['groups'] = [];
  private projects: GitLabProject[] = [];
  private groupMilestones: GitLabMilestone[] = [];
  private groupMilestonesError?: string;
  private groupIssueBoards: GitLabIssueBoard[] = [];
  private groupIssueBoardsError?: string;
  private selectedIssueBoardId?: number;
  private issueBoardContent?: WorkspaceSnapshot['issueBoardContent'];
  private issueBoardGeneration = 0;
  private issues: GitLabIssue[] = [];
  private mergeRequests: GitLabMergeRequest[] = [];
  private selectedIssue?: WorkspaceSnapshot['selectedIssue'];
  private projectMembers: WorkspaceSnapshot['projectMembers'] = [];
  private selectedMergeRequest?: MergeRequestDetail;
  private mergeRequestGeneration = 0;
  private readonly mrWritesInFlight = new Set<string>();
  private selectedProjectId?: number;
  private activeMode: WorkspaceMode;
  private currentUser?: GitLabUser;
  private toolStates: InstalledToolState[] = [];
  private toolPackages: ToolPackage[] = [];
  private busy = false;
  private repositoryOperationInProgress = false;
  private workspaceSelectionInProgress = false;
  private cloneOperation?: CloneOperationState;
  private webviewReady = false;
  private readonly cloneSelectionWaiters = new Map<string, { resolve: (projectIds: number[]) => void; timeout: NodeJS.Timeout }>();
  private requestGeneration = 0;
  private issueOpenGeneration = 0;
  private loadedScopeKey?: string;
  private disposed = false;
  private timerQueue: Promise<unknown> = Promise.resolve();
  private issuePublishQueue: Promise<unknown> = Promise.resolve();

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
      void Promise.resolve(context.globalState.update(TOOL_SOURCE_KEY, 'gitea')).catch(() => undefined);
    }
    const offlineRoot = vscode.Uri.joinPath(context.extensionUri, 'resources', 'offline-tools');
    this.packages = new ToolPackageManager(
      context.globalStorageUri.fsPath,
      vscode.Uri.joinPath(offlineRoot, 'offline-tools.tar.xz').fsPath,
      vscode.Uri.joinPath(offlineRoot, 'manifest.json').fsPath
    );
    this.activeMode = context.globalState.get<WorkspaceMode>(SELECTED_MODE_KEY, 'developer');
    this.issuePanels.setWorkspace({
      post: (message) => this.post(message),
      show: () => this.show('developer'),
      navigate: (navigation) => { if (navigation) this.activeMode = 'developer'; this.post({ type: 'issueNavigation', navigation }); }
    });
    this.interval = setInterval(() => { void this.onTick(); }, 1000);
  }

  dispose(): void {
    this.disposed = true;
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
    await this.refresh();
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
    await this.refresh();
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
      case 'ready': this.webviewReady = true; await this.refresh(); break;
      case 'refresh': await this.refresh(); break;
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
      case 'closeIssue': this.issueOpenGeneration++; this.issuePanels.close(); break;
      case 'connect': await this.connect(); break;
      case 'disconnect': await this.disconnect(); break;
      case 'selectGroup': await this.selectGroup(request.groupId); break;
      case 'selectIssueBoard': await this.selectIssueBoard(request.boardId, request.connectedScope); break;
      case 'selectWorkspace': await this.selectWorkspace(); break;
      case 'openLocalWorkspace': await this.openLocalWorkspace(); break;
      case 'openCodexTerminal': await this.openCodexTerminal(); break;
      case 'copyAndOpenCodex':
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
      case 'copy': await vscode.env.clipboard.writeText(request.text); this.post({ type: 'message', message: '已複製到剪貼簿，可貼入 Codex CLI。' }); break;
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
      case 'replyMergeRequest': await this.replyMergeRequest(request.projectId, request.iid, request.discussionId, request.body); break;
      case 'approveMergeRequest': await this.approveMergeRequest(request.projectId, request.iid, request.sha); break;
      case 'mergeMergeRequest': await this.mergeMergeRequest(request.projectId, request.iid, request.sha); break;
      case 'prepareDelivery': await this.prepareDelivery(request); break;
      case 'commitDelivery': await this.commitDelivery(request.deliveryId); break;
      case 'pushDelivery': await this.pushDelivery(request.deliveryId); break;
      case 'createDeliveryMergeRequest': await this.createDeliveryMergeRequest(request.deliveryId); break;
      case 'setToolSource': await this.setToolSource(request.source); break;
      case 'openToolDownload': await this.openToolDownload(request.tool, request.source); break;
      case 'importToolPackage': await this.importToolPackage(request.tool, request.source); break;
      case 'refreshTools': await this.refreshTools(); break;
      case 'installTool': await this.installTool(request.tool, request.packageId); break;
      default: break;
    }
  }

  private async refresh(): Promise<void> {
    const generation = ++this.requestGeneration;
    const issueBoardGeneration = ++this.issueBoardGeneration;
    this.busy = true;
    this.post({ type: 'busy', value: true, label: '正在更新工作台' });
    try {
      if (!this.session.baseUrl) {
        this.groups = []; this.projects = []; this.issues = []; this.mergeRequests = []; this.currentUser = undefined;
        this.groupMilestones = []; this.groupMilestonesError = undefined;
        this.groupIssueBoards = []; this.groupIssueBoardsError = undefined;
        this.selectedIssueBoardId = undefined; this.issueBoardContent = undefined;
        this.toolPackages = await this.packages.listPackages();
        this.toolStates = await this.packages.installedStates(undefined, this.toolPackages);
        this.sendSnapshot();
        return;
      }
      const client = await this.session.getClient();
      const [user, groups] = await Promise.all([client.getCurrentUser(), client.listGroups()]);
      if (generation !== this.requestGeneration) return;
      this.currentUser = user;
      this.groups = groups;
      await this.timer.setScope(this.session.baseUrl, user.id);
      const group = this.session.selectedGroup;
      const scopeKey = `${this.session.baseUrl}|${user.id}|${group?.id ?? 'none'}`;
      if (scopeKey !== this.loadedScopeKey) {
        this.loadedScopeKey = scopeKey;
        this.selectedIssue = undefined; this.selectedMergeRequest = undefined;
        this.projectMembers = []; this.selectedProjectId = undefined;
        this.groupMilestones = []; this.groupMilestonesError = undefined;
        this.groupIssueBoards = []; this.groupIssueBoardsError = undefined;
        this.selectedIssueBoardId = undefined; this.issueBoardContent = undefined;
      }
      if (!group) {
        this.projects = []; this.issues = []; this.mergeRequests = [];
        this.groupMilestones = []; this.groupMilestonesError = undefined;
        this.groupIssueBoards = []; this.groupIssueBoardsError = undefined;
        this.selectedIssueBoardId = undefined; this.issueBoardContent = undefined;
        this.toolPackages = await this.packages.listPackages();
        this.toolStates = await this.packages.installedStates(undefined, this.toolPackages);
        return;
      }
      const root = this.roots.getRoot(this.session.baseUrl, group.id);
      const groupMilestonesPromise = client.listGroupMilestones(group.id)
        .then((milestones) => ({ milestones, error: undefined as string | undefined }))
        .catch((error: unknown) => ({ milestones: [] as GitLabMilestone[], error: readableError(error) }));
      const groupIssueBoardsPromise = client.listGroupIssueBoards(group.id)
        .then((boards) => ({ boards, error: undefined as string | undefined }))
        .catch((error: unknown) => ({ boards: [] as GitLabIssueBoard[], error: readableError(error) }));
      const [projects, mergeRequests, milestoneResult, boardResult] = await Promise.all([
        client.listGroupProjects(group.id),
        client.listGroupMergeRequests(group.id).catch(() => []),
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
      const projectIds = new Set(projects.map((project) => project.id));
      this.issues = await client.listAssignedGroupIssues(group.id, projectIds);
      if (generation !== this.requestGeneration || this.session.selectedGroup?.id !== group.id) return;
      if (this.selectedIssueBoardId !== undefined && !boardResult.error) {
        if (!boardResult.boards.some((board) => board.id === this.selectedIssueBoardId)) {
          this.selectedIssueBoardId = undefined;
          this.issueBoardContent = undefined;
          this.issueBoardGeneration++;
        } else {
          const currentBoardGeneration = ++this.issueBoardGeneration;
          await this.loadIssueBoardContent(group.full_path, this.selectedIssueBoardId, currentBoardGeneration, this.connectedScopeKey());
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
      this.toolPackages = await this.packages.listPackages();
      this.toolStates = await this.packages.installedStates(root, this.toolPackages);
    } finally {
      this.busy = false;
      this.post({ type: 'busy', value: false });
      this.sendSnapshot();
    }
  }

  private async selectIssueBoard(boardId: number, connectedScope: string): Promise<void> {
    const group = this.session.selectedGroup;
    const currentScope = this.connectedScopeKey();
    if (!group || !currentScope || connectedScope !== currentScope || !Number.isSafeInteger(boardId) || boardId <= 0 ||
      !this.groupIssueBoards.some((board) => board.id === boardId)) return;

    this.selectedIssueBoardId = boardId;
    const generation = ++this.issueBoardGeneration;
    await this.loadIssueBoardContent(group.full_path, boardId, generation, currentScope);
  }

  private async loadIssueBoardContent(groupPath: string, boardId: number, generation: number, connectedScope?: string): Promise<void> {
    if (!connectedScope) return;
    const matchesCurrentSelection = (): boolean => !this.disposed && generation === this.issueBoardGeneration &&
      connectedScope === this.connectedScopeKey() && this.session.selectedGroup?.full_path === groupPath &&
      this.selectedIssueBoardId === boardId;

    if (!matchesCurrentSelection()) return;
    this.issueBoardContent = { boardId, connectedScope, issueIds: [], status: 'loading' };
    this.sendSnapshot();
    try {
      const client = await this.session.getClient();
      const issueIds = await client.listAssignedGroupBoardIssueIds(groupPath, boardId, this.currentUser?.username ?? '');
      if (!matchesCurrentSelection()) return;
      this.issueBoardContent = { boardId, connectedScope, issueIds, status: 'ready' };
    } catch (error) {
      if (!matchesCurrentSelection()) return;
      this.issueBoardContent = { boardId, connectedScope, issueIds: [], status: 'error', error: readableError(error) };
    }
    this.sendSnapshot();
  }

  private sendSnapshot(): void {
    if (!this.panel || this.disposed) return;
    const group = this.session.selectedGroup;
    const root = this.session.baseUrl && group ? this.roots.getRoot(this.session.baseUrl, group.id) : undefined;
    const deliveryScope = this.deliveryInstanceScope();
    const localRepositories: WorkspaceSnapshot['localRepositories'] = {};
    if (root && group) {
      const names = new Map(this.projects.map((project) => {
        try { return [project.id, groupRepositoryPath(root, project, this.projects)] as const; }
        catch { return [project.id, ''] as const; }
      }));
      for (const [projectId, projectPath] of names) {
        if (!projectPath) { localRepositories[projectId] = { path: '', state: 'unsafe' }; continue; }
        const project = this.projects.find((item) => item.id === projectId)!;
        localRepositories[projectId] = { path: projectPath, state: localRepositoryState(root, projectPath) };
      }
    }
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
      projectMembers: this.projectMembers,
      tools: this.toolStates,
      toolSource: this.toolSource(),
      toolPackages: this.toolPackages.map(({ id, tool, version, source, assetName, format, entryRoot, available, error }) =>
        ({ id, tool, version, source, assetName, format, entryRoot, available, error })),
      deliveryRecords: this.deliveryRecords()
        .filter((item) => item.groupId === group?.id && item.userId === this.currentUser?.id)
        .map((item) => ({ ...item, instanceVerified: !!deliveryScope && item.instanceScope === deliveryScope })),
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
    this.issueOpenGeneration++;
    this.issueBoardGeneration++;
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
    const groups = this.session.baseUrl ? await (await this.session.getClient()).listGroups() : [];
    const selected = groupId ? groups.find((item) => item.id === groupId) : await vscode.window.showQuickPick(
      groups.map((group) => ({ label: group.full_path, description: group.name, group })),
      { title: '選擇 GitLab Group', placeHolder: '選取工作群組' }
    ).then((item) => item?.group);
    if (!selected) return false;
    this.issueOpenGeneration++;
    if (this.issuePanels.activeNavigationMode === 'create') this.issuePanels.close();
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
      const projects = this.projects.length ? this.projects : await client.listGroupProjects(group.id);
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
      const destinations = chosen.map((project) => `${localRepositoryState(root!, groupRepositoryPath(root!, project, projects)) === 'ready' ? '更新' : 'Clone'}　${project.path_with_namespace} → ${groupRepositoryPath(root!, project, projects)}`);
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
      try { await this.refresh(); }
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
      const existingProjects = groupProjects.filter((project) => {
        try {
          const targetPath = groupRepositoryPath(root!, project, groupProjects);
          return localRepositoryState(root!, targetPath) === 'ready';
        } catch {
          return false;
        }
      });
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
      try { await this.refresh(); }
      finally { this.repositoryOperationInProgress = false; this.sendSnapshot(); }
    }
  }

  private async selectIssue(projectId: number, issueIid: number): Promise<void> {
    requireIssueIid(issueIid);
    const project = this.requireGroupProject(projectId);
    const issue = await (await this.session.getClient()).getIssue(projectId, issueIid);
    this.selectedIssue = { project, issue };
    this.selectedProjectId = projectId;
    this.projectMembers = await (await this.session.getClient()).listProjectMembers(projectId).catch(() => []);
    await this.context.globalState.update(this.selectedIssueKey(), { projectId, issueIid });
    this.sendSnapshot();
  }

  private async openIssue(projectId: number, issueIid: number, tab?: IssueDetailTab): Promise<void> {
    const generation = ++this.issueOpenGeneration;
    const baseUrl = this.session.baseUrl;
    const groupId = this.session.selectedGroup?.id;
    requireIssueIid(issueIid);
    const project = this.requireGroupProject(projectId);
    const client = await this.session.getClient();
    const [issue, projectMembers] = await Promise.all([
      client.getIssue(projectId, issueIid), client.listProjectMembers(projectId).catch(() => [])
    ]);
    if (generation !== this.issueOpenGeneration || baseUrl !== this.session.baseUrl || groupId !== this.session.selectedGroup?.id) return;
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
      client.listProjectMembers(projectId), client.listProjectLabels(projectId), client.listProjectMilestones(projectId),
      client.listProjectIssueTemplates(projectId), client.canCreateIssue(project.path_with_namespace)
    ]);
    const options: IssueFormOptions = { members, labels, milestones, templates };
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
    this.post({ type: 'message', message: `開始計時：${project.path_with_namespace}#${issue.iid}` });
    this.sendSnapshot();
  }

  private async addManualTime(projectId: number, issueIid: number, duration: string, summary: string, spentAt?: string): Promise<void> {
    requireIssueIid(issueIid);
    this.requireGroupProject(projectId);
    const client = await this.session.getClient();
    const [issue, project] = await Promise.all([client.getIssue(projectId, issueIid), client.getProject(projectId)]);
    await this.enqueueTimer(() => this.timer.addManual(project, issue, duration, summary, spentAt));
    this.sendSnapshot();
  }

  private async updateTimer(action: () => Promise<WorkspaceTimerEntry | void>): Promise<void> { await this.enqueueTimer(action); this.sendSnapshot(); }

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
    this.sendSnapshot();
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
    } finally { this.sendSnapshot(); }
  }

  private async loadMergeRequest(projectId: number, iid: number): Promise<void> {
    this.requireGroupProject(projectId);
    const generation = ++this.mergeRequestGeneration;
    const connectionGeneration = this.requestGeneration;
    this.post({ type: 'busy', value: true, label: '正在讀取 MR' });
    try {
      const client = await this.session.getClient();
      const request = await client.getMergeRequest(projectId, iid);
      const [diffs, discussions] = await Promise.all([
        client.listMergeRequestDiffs(projectId, iid).catch(() => []),
        client.listMergeRequestDiscussions(projectId, iid).catch(() => [])
      ]);
      const detail = await this.getMergeRequestDetail(client, request, diffs, discussions);
      if (generation !== this.mergeRequestGeneration || connectionGeneration !== this.requestGeneration) return;
      this.selectedMergeRequest = detail;
      await this.context.globalState.update(this.selectedMergeRequestKey(), { projectId, iid });
    } finally { this.post({ type: 'busy', value: false }); this.sendSnapshot(); }
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

  private async replyMergeRequest(projectId: number, iid: number, discussionId: string, body: string): Promise<void> {
    const detail = this.selectedMergeRequest;
    if (detail?.request.project_id !== projectId || detail.request.iid !== iid || !detail.discussions.some((item) => item.id === discussionId)) throw new Error('找不到這則 MR 討論，請重新整理。');
    await this.publishMergeRequestText(projectId, iid, body, discussionId);
  }

  private async publishMergeRequestText(projectId: number, iid: number, body: string, discussionId?: string): Promise<void> {
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

  private async prepareDelivery(request: Extract<WorkspaceRequest, { type: 'prepareDelivery' }>): Promise<void> {
    requireIssueIid(request.issueIid);
    const group = this.session.selectedGroup;
    const userId = this.currentUser?.id;
    const root = this.session.baseUrl && group ? this.roots.getRoot(this.session.baseUrl, group.id) : undefined;
    const project = this.requireGroupProject(request.projectId);
    if (!group || !userId || !root || !project) throw new Error('請先選擇 Group 工作目錄與有效 Repo。');
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(request.workId)) throw new Error('Megin Work ID 僅能使用英數字、句點、底線與連字號。');
    if (request.acceptanceConfirmed !== true) throw new Error('請先確認已完成 Megin 人工驗收。');
    const summary = checkedText(request.summary, 'Commit 摘要', 200);
    if (/[\r\n]/.test(summary)) throw new Error('Commit 摘要必須是一行文字。');
    const changes = checkedText(request.changes, '修改內容', 12_000);
    const tests = checkedText(request.tests, '驗收證據', 8_000);
    const targetBranch = checkedText(request.targetBranch, '目標分支', 255);
    await git(path.resolve(root), ['check-ref-format', '--branch', targetBranch]);
    const repoPath = groupRepositoryPath(root, project, this.projects);
    if (localRepositoryState(root, repoPath) !== 'ready') throw new Error('本機 Repo 不存在或路徑不安全。');
    const repoTop = await git(repoPath, ['rev-parse', '--show-toplevel']);
    if (!sameRealLocalPath(repoTop.trim(), repoPath)) throw new Error('本機路徑不是 Repo 根目錄。');
    const branch = (await git(repoPath, ['branch', '--show-current'])).trim();
    if (!branch || branch === targetBranch || branch === project.default_branch) throw new Error('Megin 交付必須留在非預設分支，不能提交到目標分支。');
    await git(repoPath, ['check-ref-format', '--branch', branch]);
    const headSha = (await git(repoPath, ['rev-parse', 'HEAD'])).trim();
    const targetRef = `refs/remotes/origin/${targetBranch}`;
    const baseTargetSha = (await git(repoPath, ['rev-parse', '--verify', `${targetRef}^{commit}`])).trim();
    const client = await this.session.getClient();
    const [target, latestIssue] = await Promise.all([client.getRepositoryBranch(project.id, targetBranch), client.getIssue(project.id, request.issueIid)]);
    const baseSha = (await git(repoPath, ['merge-base', 'HEAD', targetRef])).trim();
    if (latestIssue.state !== 'opened') throw new Error('Issue 已關閉，請先重新確認工作範圍。');
    const status = await git(repoPath, ['status', '--porcelain=v1', '--untracked-files=all']);
    const rawDiff = await git(repoPath, ['diff', '--no-ext-diff', '--binary', 'HEAD', '--'], { maxBuffer: MAX_DIFF_BYTES + 16_384 });
    const diffSha256 = createHash('sha256').update(rawDiff).digest('hex');
    const gate = evaluateMeginDeliveryGate({ workId: request.workId, headSha, baseSha, localTargetSha: baseTargetSha, cloudTargetSha: target.commit.id, status, diffSha256, acceptanceConfirmed: request.acceptanceConfirmed });
    const diff = rawDiff.slice(0, MAX_DIFF_BYTES);
    const diffStat = (await git(repoPath, ['diff', '--stat', 'HEAD'])).trim();
    const changedFiles = (await git(repoPath, ['diff', '--name-only', 'HEAD'])).split(/\r?\n/).filter(Boolean).slice(0, 500);
    const delivery: DeliveryRecord = {
      id: randomUUID(), groupId: group.id, userId, instanceScope: this.deliveryInstanceScope(), projectId: project.id, issueIid: request.issueIid,
      repoPath, branch, targetBranch, workId: request.workId, summary, changes, tests,
      acceptanceConfirmed: request.acceptanceConfirmed,
      reviewerIds: (Array.isArray(request.reviewerIds) ? request.reviewerIds : []).filter((id) => Number.isSafeInteger(id) && id > 0).slice(0, 50),
      headSha, baseSha, baseTargetSha, diffSha256, statusSnapshot: status,
      diffStat: rawDiff.length > MAX_DIFF_BYTES ? `${diffStat}\n(diff 顯示截斷)` : diffStat,
      diff, changedFiles, gate, state: 'preview', updatedAt: Date.now()
    };
    await this.saveDelivery(delivery);
    this.post({ type: 'deliveryPreview', delivery });
    this.post({ type: 'message', message: gate.ok ? '交付預覽已建立，可檢查差異後 Commit。' : '交付檢查未通過，已保留工作現場。' });
  }

  private async commitDelivery(id: string): Promise<void> {
    const record = this.requireDelivery(id);
    if (record.state !== 'preview') throw new Error('這筆交付已 Commit；請從目前步驟繼續。');
    const state = await this.recheckDeliveryGate(record);
    if (!state.ok) { await this.saveDelivery({ ...record, gate: state, error: state.reasons.join('；'), updatedAt: Date.now() }); throw new Error(state.reasons.join('\n')); }
    const diff = await hasCachedChanges(record.repoPath);
    if (diff) throw new Error('暫存區已有內容。已保留現場；請檢查是否與 Megin 驗收快照一致，再重新預覽。');
    const currentHead = (await git(record.repoPath, ['rev-parse', 'HEAD'])).trim();
    if (currentHead !== record.headSha) throw new Error('分支 HEAD 已漂移，請重新執行交付預覽。');
    const changedNow = await git(record.repoPath, ['status', '--porcelain=v1', '--untracked-files=all']);
    if (changedNow !== record.statusSnapshot) throw new Error('工作樹狀態與驗收預覽不同；已保留現場，請重新確認 Megin 驗收內容。');
    const diffNow = await git(record.repoPath, ['diff', '--no-ext-diff', '--binary', 'HEAD', '--'], { maxBuffer: MAX_DIFF_BYTES + 16_384 });
    if (createHash('sha256').update(diffNow).digest('hex') !== record.diffSha256) throw new Error('差異內容與驗收預覽不同；已保留現場，請重新確認 Megin 驗收內容。');
    const projectPath = this.projects.find((project) => project.id === record.projectId)?.path_with_namespace ?? 'project';
    const message = `[${projectPath}#${record.issueIid}] ${record.summary}`;
    await git(record.repoPath, ['add', '--all']);
    try {
      await git(record.repoPath, ['commit', '-m', message, '-m', `${record.changes}\n\n驗證：\n${record.tests}\n\nMegin Work ID: ${record.workId}`]);
    } catch (error) { throw error; }
    const committedHead = (await git(record.repoPath, ['rev-parse', 'HEAD'])).trim();
    const updated = { ...record, headSha: committedHead, state: 'committed' as const, updatedAt: Date.now() };
    await this.saveDelivery(updated);
    this.post({ type: 'deliveryProgress', delivery: updated });
  }

  private async pushDelivery(id: string): Promise<void> {
    const record = this.requireDelivery(id);
    if (record.state !== 'committed') throw new Error('Commit 尚未完成，不能 Push。');
    if ((await git(record.repoPath, ['rev-parse', 'HEAD'])).trim() !== record.headSha) throw new Error('Commit SHA 已變動，請先檢查工作樹。');
    const client = await this.session.getClient();
    const project = await client.getProject(record.projectId);
    const credentials = await this.session.getCloneCredentials();
    const remote = await git(record.repoPath, ['remote', 'get-url', 'origin']);
    if (!isAllowedGitRemote(credentials.baseUrl, project.http_url_to_repo) || !projectRemoteMatches(remote.trim(), project)) {
      throw new Error('origin 不屬於目前 GitLab Project 的 HTTPS 或 SSH Repo，已停止 Push。');
    }
    const confirm = await vscode.window.showWarningMessage(`將 ${record.headSha.slice(0, 12)} Push 至 ${project.path_with_namespace}:${record.branch}。`, { modal: true }, 'Push');
    if (confirm !== 'Push') return;
    let pushEnv: NodeJS.ProcessEnv | undefined;
    try {
      const remoteUrl = new URL(remote.trim());
      if (remoteUrl.protocol === 'https:' || remoteUrl.protocol === 'http:') pushEnv = createScopedGitEnvironment(remote.trim(), credentials.token);
    } catch { /* SSH remotes use the user's configured SSH agent. */ }
    try { await git(record.repoPath, ['push', '--set-upstream', 'origin', record.branch], { env: pushEnv }); }
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
    const client = await this.session.getClient();
    const issue = await client.getIssue(record.projectId, record.issueIid);
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
      `## Issue\nRelates to ${project.path_with_namespace}#${issue.iid}\n${issue.web_url}`,
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

  private async recheckDeliveryGate(record: DeliveryRecord): Promise<DeliveryPreview['gate']> {
    const head = (await git(record.repoPath, ['rev-parse', 'HEAD'])).trim();
    const branch = (await git(record.repoPath, ['branch', '--show-current'])).trim();
    const targetRef = `refs/remotes/origin/${record.targetBranch}`;
    const baseTargetSha = (await git(record.repoPath, ['rev-parse', '--verify', `${targetRef}^{commit}`])).trim();
    const client = await this.session.getClient();
    const target = await client.getRepositoryBranch(record.projectId, record.targetBranch);
    const baseSha = (await git(record.repoPath, ['merge-base', 'HEAD', targetRef])).trim();
    const status = await git(record.repoPath, ['status', '--porcelain=v1', '--untracked-files=all']);
    const rawDiff = await git(record.repoPath, ['diff', '--no-ext-diff', '--binary', 'HEAD', '--'], { maxBuffer: MAX_DIFF_BYTES + 16_384 });
    const diffSha256 = createHash('sha256').update(rawDiff).digest('hex');
    const gate = evaluateMeginDeliveryGate({ workId: record.workId, headSha: head, baseSha, localTargetSha: baseTargetSha, cloudTargetSha: target.commit.id, status, diffSha256, acceptanceConfirmed: record.acceptanceConfirmed });
    const reasons = [...gate.reasons];
    if (branch !== record.branch) reasons.push('目前分支已變更；請回到 Megin 驗收時使用的工作分支。');
    if (head !== record.headSha) reasons.push('分支 HEAD 已漂移；請重新執行交付預覽。');
    if (baseSha !== record.baseSha) reasons.push('目標分支的共同基底已變更；請重新確認 Megin 驗收。');
    if (baseTargetSha !== record.baseTargetSha) reasons.push('本機遠端追蹤分支已變更；請重新確認 Megin 驗收。');
    if (target.commit.id !== record.baseTargetSha) reasons.push('GitLab 目標分支已更新；請先同步並重新確認 Megin 驗收。');
    if (status !== record.statusSnapshot) reasons.push('工作樹狀態已變更；請重新確認 Megin 驗收。');
    if (diffSha256 !== record.diffSha256) reasons.push('程式差異內容已變更；請重新確認 Megin 驗收。');
    return { ok: reasons.length === 0, reasons };
  }

  private deliveryRecords(): DeliveryRecord[] {
    const value = this.context.globalState.get<DeliveryRecord[]>(DELIVERIES_KEY, []);
    return Array.isArray(value) ? value.filter((record) => !!record && typeof record.id === 'string') : [];
  }
  private deliveryInstanceScope(): string | undefined {
    return this.session.baseUrl ? createHash('sha256').update(this.session.baseUrl).digest('hex') : undefined;
  }
  private requireDelivery(id: string): DeliveryRecord {
    const instanceScope = this.deliveryInstanceScope();
    const record = this.deliveryRecords().find((item) => item.id === id && item.groupId === this.session.selectedGroup?.id &&
      item.userId === this.currentUser?.id && instanceScope !== undefined && item.instanceScope === instanceScope);
    if (!record) throw new Error('找不到已確認屬於目前 GitLab、Group 與使用者的交付紀錄。');
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

  private toolSource(): ToolSource {
    const source = this.context.globalState.get<unknown>(TOOL_SOURCE_KEY);
    return source === 'github' || source === 'bundled' || source === 'gitea' ? source : 'gitea';
  }

  private async setToolSource(source: ToolSource): Promise<void> {
    if (!['gitea', 'github', 'bundled'].includes(source)) throw new Error('套件來源設定無效。');
    await this.context.globalState.update(TOOL_SOURCE_KEY, source);
    await this.refreshTools();
  }

  private async refreshTools(): Promise<void> {
    const group = this.session.selectedGroup;
    const root = this.session.baseUrl && group ? this.roots.getRoot(this.session.baseUrl, group.id) : undefined;
    this.toolPackages = await this.packages.listPackages();
    this.toolStates = await this.packages.installedStates(root, this.toolPackages);
    this.sendSnapshot();
  }

  private async openToolDownload(tool: ToolId, source: RemoteToolSource): Promise<void> {
    if (!isTool(tool) || (source !== 'gitea' && source !== 'github')) throw new Error('下載來源無效。');
    const definition = TOOL_DEFINITIONS[tool];
    const url = source === 'gitea' ? definition.giteaReleaseUrl : definition.githubReleaseUrl;
    await vscode.env.openExternal(vscode.Uri.parse(url));
  }

  private async importToolPackage(tool: ToolId, source: RemoteToolSource): Promise<void> {
    if (!isTool(tool) || (source !== 'gitea' && source !== 'github')) throw new Error('匯入來源無效。');
    const selection = await vscode.window.showOpenDialog({
      canSelectFiles: true, canSelectFolders: false, canSelectMany: false,
      openLabel: '匯入 Release ZIP',
      filters: { 'ZIP 封裝': ['zip'] }
    });
    const archive = selection?.[0];
    if (!archive) return;
    const pythonPath = vscode.workspace.getConfiguration('gitlabWorkspace').get<string>('pythonPath', 'python');
    const python = await resolvePythonRuntime(pythonPath);
    const helper = vscode.Uri.joinPath(this.context.extensionUri, 'resources', 'tool-installer.py').fsPath;
    let inspected: { ok?: boolean; tool?: string; detected_version?: string | null; sha256?: string; error?: string };
    try {
      const result = await execFileAsync(python.executable, [...python.args, helper, 'inspect', tool, archive.fsPath], {
        cwd: this.context.extensionUri.fsPath, env: python.env, timeout: 3 * 60_000, maxBuffer: 1024 * 1024, windowsHide: true
      });
      inspected = parseLastJsonLine(result.stdout) as typeof inspected;
    } catch (error) {
      throw new Error(`ZIP 驗證失敗：${readableError(error)}`);
    }
    if (inspected.ok !== true || inspected.tool !== tool || typeof inspected.sha256 !== 'string' || !/^[a-f0-9]{64}$/i.test(inspected.sha256)) {
      throw new Error(typeof inspected.error === 'string' ? inspected.error : 'ZIP 驗證器未確認套件內容。');
    }
    let version = isVersion(inspected.detected_version) ? inspected.detected_version : undefined;
    if (!version) {
      version = await vscode.window.showInputBox({
        title: `輸入 ${tool} 套件版本`,
        prompt: '此 ZIP 沒有可辨識的版本資訊，請依 Release 標籤輸入 x.y.z。',
        placeHolder: '1.2.3',
        ignoreFocusOut: true,
        validateInput: (value) => isVersion(value) ? undefined : '版本需使用 x.y.z 格式。'
      });
      if (!version) return;
    }
    await this.packages.importPackage({
      tool, version, source, assetName: path.basename(archive.fsPath), archivePath: archive.fsPath, verifiedSha256: inspected.sha256.toLowerCase()
    });
    await this.refreshTools();
    this.post({ type: 'message', message: `${tool} v${version} ZIP 已保存至 VS Code 持久套件庫，可離線安裝。` });
  }

  private async installTool(tool: ToolId, packageId: string): Promise<void> {
    if (!isTool(tool)) throw new Error('不支援此工具。');
    if (typeof packageId !== 'string' || !packageId) throw new Error('請先從套件選單選擇要安裝的版本。');
    const group = this.session.selectedGroup;
    const root = this.session.baseUrl && group ? this.roots.getRoot(this.session.baseUrl, group.id) : undefined;
    if (!root) throw new Error('請先選擇非 Git Group 工作目錄。');
    this.toolStates = [...this.toolStates.filter((item) => item.tool !== tool), { tool, status: 'installing' }];
    this.sendSnapshot();
    try {
      const picked = await this.packages.getPackage(tool, packageId);
      const pythonPath = vscode.workspace.getConfiguration('gitlabWorkspace').get<string>('pythonPath', 'python');
      const python = await resolvePythonRuntime(pythonPath);
      const helper = vscode.Uri.joinPath(this.context.extensionUri, 'resources', 'tool-installer.py').fsPath;
      const args = [python.executable, ...python.args, helper, tool, picked.archivePath, root, picked.version, picked.source,
        '--format', picked.format, '--entry-root', picked.entryRoot, '--archive-sha256', picked.sha256];
      const progress = vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `安裝 ${tool} v${picked.version}`, cancellable: false }, async () => {
        const result = await execFileAsync(args[0], args.slice(1), { cwd: root, env: python.env, timeout: 10 * 60_000, maxBuffer: 1024 * 1024, windowsHide: true })
          .catch((error: unknown) => { throw new Error(`工具安裝失敗：${readableError(error)}`); });
        const payload = parseLastJsonLine(result.stdout);
        if (payload.ok !== true) throw new Error(typeof payload.error === 'string' ? payload.error : '工具安裝器未確認安裝結果。');
      });
      await progress;
      this.post({ type: 'message', message: `${tool} v${picked.version} 已安裝於 ${root}。` });
      await this.refreshTools();
    } catch (error) {
      this.toolStates = [...this.toolStates.filter((item) => item.tool !== tool), { tool, status: 'error', message: readableError(error) }];
      this.sendSnapshot();
      throw error;
    }
  }

  private async onTick(): Promise<void> {
    try {
      await this.enqueueTimer(() => this.timer.tick());
      const active = this.timer.list().some((entry) => entry.phase === 'running');
      if (active) this.sendSnapshot();
    } catch (error) { this.post({ type: 'error', message: readableError(error) }); }
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

async function hasCachedChanges(repo: string): Promise<boolean> {
  try {
    await git(repo, ['diff', '--cached', '--quiet', '--exit-code']);
    return false;
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && (error as { code?: string | number }).code === 1) return true;
    throw error;
  }
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
