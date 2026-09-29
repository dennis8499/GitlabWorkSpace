import * as vscode from 'vscode';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { access, mkdir, readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import type { GitLabClient } from '../api/gitLabClient';
import type { GitLabIssue, GitLabMergeRequest, GitLabProject, GitLabUser } from '../api/types';
import type { IssueFormOptions } from '../issues/protocol';
import type { IssuePanels } from '../issues/issuePanel';
import { cloneProjects, createScopedGitEnvironment, syncLocalDefaultBranches } from '../git/cloneService';
import { GroupWorkspaceRegistry, groupRepositoryPath, localRepositoryState } from './workspacePaths';
import { IssueTimeTracker, gitLabDuration } from './timeTracker';
import { evaluateMeginDeliveryGate } from './deliveryGate';
import { buildIssueDraftDescription, containsIssueDraftMarker, matchDraftProject, parseIssueDraftBundle } from './issueDrafts';
import { ReleaseDownloadError, ToolReleaseManager, TOOL_SOURCE_KEY } from './releaseManager';
import type {
  BranchFreshness, DeliveryPreview, DraftIssueResult, InstalledToolState, IssueDraft,
  MergeRequestDetail, ToolId, ToolSource, WorkspaceMode, WorkspaceRequest, WorkspaceSnapshot, WorkspaceTimerEntry
} from './workspaceProtocol';
import type { GitLabSession } from '../connection/session';
import { isAllowedGitRemote } from '../api/urlPolicy';

const execFileAsync = promisify(execFile);
const SELECTED_MODE_KEY = 'gitlabWorkspace.workspace.mode';
const DELIVERIES_KEY = 'gitlabWorkspace.deliveryRecords.v1';
const MR_WRITES_KEY = 'gitlabWorkspace.pendingMrWrites.v1';
const MAX_DIFF_BYTES = 320_000;
const ALLOWED_MODES = new Set<WorkspaceMode>(['clone', 'sa', 'developer', 'reviewer']);

interface DeliveryRecord extends DeliveryPreview { groupId: number; userId: number; }
interface PendingMrWrite { key: string; marker: string; groupId: number; userId: number; projectId: number; iid: number; discussionId?: string; state: 'sending' | 'uncertain'; }

export class WorkspacePanel implements vscode.Disposable {
  private panel?: vscode.WebviewPanel;
  private readonly roots: GroupWorkspaceRegistry;
  private readonly timer: IssueTimeTracker;
  private readonly releases: ToolReleaseManager;
  private interval?: NodeJS.Timeout;
  private groups: WorkspaceSnapshot['groups'] = [];
  private projects: GitLabProject[] = [];
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
  private busy = false;
  private requestGeneration = 0;
  private disposed = false;
  private timerQueue: Promise<unknown> = Promise.resolve();
  private issuePublishQueue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly session: GitLabSession,
    private readonly issuePanels: IssuePanels
  ) {
    this.roots = new GroupWorkspaceRegistry(context.globalState);
    this.timer = new IssueTimeTracker(context.globalState);
    this.releases = new ToolReleaseManager(context.secrets);
    this.activeMode = context.globalState.get<WorkspaceMode>(SELECTED_MODE_KEY, 'clone');
    this.interval = setInterval(() => { void this.onTick(); }, 1000);
  }

  dispose(): void {
    this.disposed = true;
    if (this.interval) clearInterval(this.interval);
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
      panel.onDidDispose(() => { messageListener.dispose(); if (this.panel === panel) this.panel = undefined; });
    } else {
      this.panel.reveal(vscode.ViewColumn.Active);
    }
    await this.refresh();
  }

  private post(message: unknown): void {
    if (this.panel) void this.panel.webview.postMessage(message);
  }

  private async handleMessage(value: unknown): Promise<void> {
    if (!value || typeof value !== 'object' || !('type' in value) || typeof value.type !== 'string') return;
    const request = value as WorkspaceRequest;
    switch (request.type) {
      case 'ready': await this.refresh(); break;
      case 'refresh': await this.refresh(); break;
      case 'setMode':
        if (!ALLOWED_MODES.has(request.mode)) return;
        this.activeMode = request.mode;
        await this.context.globalState.update(SELECTED_MODE_KEY, request.mode);
        this.sendSnapshot();
        break;
      case 'connect': await this.connect(); break;
      case 'disconnect': await this.disconnect(); break;
      case 'selectGroup': await this.selectGroup(request.groupId); break;
      case 'selectWorkspace': await this.selectWorkspace(); break;
      case 'openLocalWorkspace': await this.openLocalWorkspace(); break;
      case 'openCodexTerminal': await this.openCodexTerminal(); break;
      case 'clone': await this.clone(request.projectIds, !!request.cloneAll); break;
      case 'syncRepos': await this.syncRepos(); break;
      case 'selectProject': this.selectedProjectId = request.projectId; await this.context.globalState.update('gitlabWorkspace.selectedProjectId', request.projectId); this.sendSnapshot(); break;
      case 'selectIssue': await this.selectIssue(request.projectId, request.issueIid); break;
      case 'openIssue': await this.openIssue(request.projectId, request.issueIid); break;
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
      case 'saveGiteaToken': await this.releases.saveGiteaToken(request.token); this.post({ type: 'message', message: '已安全保存 Gitea Release Token。' }); await this.refreshTools(); break;
      case 'refreshTools': await this.refreshTools(); break;
      case 'listToolReleases': await this.listToolReleases(request.tool); break;
      case 'installTool': await this.installTool(request.tool, request.version); break;
      default: break;
    }
  }

  private async refresh(): Promise<void> {
    const generation = ++this.requestGeneration;
    this.busy = true;
    this.post({ type: 'busy', value: true, label: '正在更新工作台' });
    try {
      if (!this.session.baseUrl) {
        this.groups = []; this.projects = []; this.issues = []; this.mergeRequests = []; this.currentUser = undefined;
        this.toolStates = await this.releases.installedStates(undefined, this.toolSource());
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
      if (!group) {
        this.projects = []; this.issues = []; this.mergeRequests = [];
        this.toolStates = await this.releases.installedStates(undefined, this.toolSource());
        return;
      }
      const root = this.roots.getRoot(this.session.baseUrl, group.id);
      const [projects, mergeRequests] = await Promise.all([
        client.listGroupProjects(group.id),
        client.listGroupMergeRequests(group.id).catch(() => [])
      ]);
      if (generation !== this.requestGeneration || this.session.selectedGroup?.id !== group.id) return;
      this.projects = projects;
      this.mergeRequests = mergeRequests;
      const projectIds = new Set(projects.map((project) => project.id));
      this.issues = await client.listAssignedGroupIssues(group.id, projectIds);
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
      this.toolStates = await this.releases.installedStates(root, this.toolSource());
    } finally {
      this.busy = false;
      this.post({ type: 'busy', value: false });
      this.sendSnapshot();
    }
  }

  private sendSnapshot(): void {
    if (!this.panel || this.disposed) return;
    const group = this.session.selectedGroup;
    const root = this.session.baseUrl && group ? this.roots.getRoot(this.session.baseUrl, group.id) : undefined;
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
      localRepositories,
      issues: this.issues,
      mergeRequests: this.mergeRequests,
      activeMode: this.activeMode,
      selectedProjectId: this.selectedProjectId,
      selectedIssue: this.selectedIssue,
      selectedMergeRequest: this.selectedMergeRequest,
      timers: this.timer.list(),
      projectMembers: this.projectMembers,
      tools: this.toolStates,
      toolSource: this.toolSource(),
      deliveryRecords: this.deliveryRecords().filter((item) => item.groupId === group?.id && item.userId === this.currentUser?.id),
      busy: this.busy
    };
    this.post({ type: 'snapshot', snapshot });
  }

  private async connect(): Promise<void> {
    const baseUrl = await vscode.window.showInputBox({ title: '連線至 GitLab', prompt: '輸入 GitLab 網址', value: this.session.baseUrl, placeHolder: 'https://gitlab.example.com', ignoreFocusOut: true });
    if (!baseUrl) return;
    const token = await vscode.window.showInputBox({ title: 'GitLab Personal Access Token', prompt: 'Token 儲存在 VS Code SecretStorage。', password: true, ignoreFocusOut: true });
    if (!token) return;
    const user = await this.session.connect(baseUrl, token);
    this.currentUser = user;
    await this.selectGroup();
    this.post({ type: 'message', message: `已連線：${user.name}` });
  }

  private async disconnect(): Promise<void> {
    const confirm = await vscode.window.showWarningMessage('中斷 GitLab 連線？本機 Repo、草稿及計時紀錄會保留。', { modal: true }, '中斷連線');
    if (confirm !== '中斷連線') return;
    await this.session.disconnect();
    this.groups = []; this.projects = []; this.issues = []; this.mergeRequests = [];
    this.currentUser = undefined; this.selectedIssue = undefined; this.selectedMergeRequest = undefined;
    this.sendSnapshot();
  }

  private async selectGroup(groupId?: number): Promise<void> {
    const groups = this.session.baseUrl ? await (await this.session.getClient()).listGroups() : [];
    const selected = groupId ? groups.find((item) => item.id === groupId) : await vscode.window.showQuickPick(
      groups.map((group) => ({ label: group.full_path, description: group.name, group })),
      { title: '選擇 GitLab Group', placeHolder: '選取工作群組' }
    ).then((item) => item?.group);
    if (!selected) return;
    await this.session.setSelectedGroup(selected);
    this.selectedIssue = undefined; this.selectedMergeRequest = undefined; this.projects = [];
    this.projectMembers = [];
    await this.refresh();
  }

  private async selectWorkspace(): Promise<void> {
    const selected = await vscode.window.showOpenDialog({
      canSelectFiles: false, canSelectFolders: true, canSelectMany: false,
      openLabel: '選擇 Group 工作目錄',
      defaultUri: vscode.workspace.workspaceFolders?.[0]?.uri
    });
    const group = this.session.selectedGroup;
    if (!selected?.[0] || !group || !this.session.baseUrl) return;
    const root = selected[0].fsPath;
    if (await exists(path.join(root, '.git'))) throw new Error('Group 工作目錄必須是非 Git Repo 的上層資料夾。');
    await this.roots.setRoot(this.session.baseUrl, group.id, root);
    await this.refresh();
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
    const terminal = vscode.window.createTerminal({ name: 'Codex CLI', cwd: root });
    terminal.show();
    terminal.sendText('codex');
  }

  private async clone(projectIds: number[], cloneAll: boolean): Promise<void> {
    const group = this.session.selectedGroup;
    const root = this.session.baseUrl && group ? this.roots.getRoot(this.session.baseUrl, group.id) : undefined;
    if (!group || !this.session.baseUrl) throw new Error('請先連線 GitLab 並選擇 Group。');
    if (!root) { await this.selectWorkspace(); return; }
    const client = await this.session.getClient();
    const projects = this.projects.length ? this.projects : await client.listGroupProjects(group.id);
    const chosen = cloneAll ? projects : projects.filter((project) => projectIds.includes(project.id));
    if (!chosen.length) throw new Error('請先選擇至少一個 Repo。');
    const destinations = chosen.map((project) => `${localRepositoryState(root, groupRepositoryPath(root, project, projects)) === 'ready' ? '更新' : 'Clone'}　${project.path_with_namespace} → ${groupRepositoryPath(root, project, projects)}`);
    const confirm = await vscode.window.showInformationMessage(`即將在 ${root} 執行 ${chosen.length} 個 Repo 操作：\n${destinations.join('\n')}`, { modal: true }, '開始');
    if (confirm !== '開始') return;
    const credentials = await this.session.getCloneCredentials();
    this.busy = true; this.sendSnapshot();
    try {
      const result = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'GitLab Repo Clone', cancellable: false }, async (progress) =>
        cloneProjects(root, chosen, credentials.baseUrl, credentials.token, (event) => {
          progress.report({ message: `${event.project.path_with_namespace}: ${event.state}${event.percent === undefined ? '' : ` ${event.percent}%`}`, increment: 0 });
        }, { resolveProject: (project) => client.getProject(project.id), groupProjects: projects })
      );
      this.post({ type: 'message', message: `完成 ${result.cloned.length} 個 Clone、${result.updated.length} 個更新，${result.skipped.length} 個略過${result.failed ? `；${result.failed.path_with_namespace} 失敗` : ''}。` });
      if (result.failed) await vscode.window.showErrorMessage(`${result.failed.path_with_namespace} Clone／更新失敗，可重新選取該 Repo 重試。`);
    } finally { this.busy = false; await this.refresh(); }
  }

  private async syncRepos(): Promise<void> {
    const group = this.session.selectedGroup;
    const root = this.session.baseUrl && group ? this.roots.getRoot(this.session.baseUrl, group.id) : undefined;
    if (!group || !root) throw new Error('請先選擇 Group 工作目錄。');
    const confirm = await vscode.window.showWarningMessage(`Fetch 並 Pull ${group.full_path} 下所有已 Clone Repo 的預設分支？本機分支不會刪除。`, { modal: true }, '更新預設分支');
    if (confirm !== '更新預設分支') return;
    const client = await this.session.getClient();
    const credentials = await this.session.getCloneCredentials();
    const results = await syncLocalDefaultBranches(root, this.projects, credentials.baseUrl, credentials.token, () => undefined,
      { resolveProject: (project) => client.getProject(project.id) });
    this.post({ type: 'message', message: `已更新 ${results.updated.length} 個預設分支；${results.upToDate.length} 個已是最新、${results.skipped.length + results.failed.length} 個需處理。` });
    await this.refresh();
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

  private async openIssue(projectId: number, issueIid: number): Promise<void> {
    requireIssueIid(issueIid);
    const project = this.requireGroupProject(projectId);
    const client = await this.session.getClient();
    const [issue, fullProject] = await Promise.all([client.getIssue(projectId, issueIid), Promise.resolve(project)]);
    this.selectedIssue = { project: fullProject, issue };
    this.projectMembers = await client.listProjectMembers(projectId).catch(() => []);
    await this.context.globalState.update(this.selectedIssueKey(), { projectId, issueIid });
    this.sendSnapshot();
    await this.issuePanels.showIssue(issue);
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
    if (path.resolve(repoTop.trim()) !== path.resolve(repoPath)) throw new Error('本機路徑不是 Repo 根目錄。');
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
      id: randomUUID(), groupId: group.id, userId, projectId: project.id, issueIid: request.issueIid,
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
    if (!isAllowedGitRemote(credentials.baseUrl, remote.trim())) throw new Error('origin 不在目前 GitLab instance，已停止 Push。');
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

  private deliveryRecords(): DeliveryRecord[] { return this.context.globalState.get<DeliveryRecord[]>(DELIVERIES_KEY, []) ?? []; }
  private requireDelivery(id: string): DeliveryRecord {
    const record = this.deliveryRecords().find((item) => item.id === id && item.groupId === this.session.selectedGroup?.id && item.userId === this.currentUser?.id);
    if (!record) throw new Error('找不到目前 Group／使用者的交付紀錄。');
    return record;
  }
  private async saveDelivery(record: DeliveryRecord): Promise<void> {
    const entries = this.deliveryRecords().filter((item) => item.id !== record.id);
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

  private toolSource(): ToolSource { return this.context.globalState.get<ToolSource>(TOOL_SOURCE_KEY, 'auto'); }
  private async setToolSource(source: ToolSource): Promise<void> {
    if (!['auto', 'github', 'gitea'].includes(source)) throw new Error('Release 來源設定無效。');
    await this.context.globalState.update(TOOL_SOURCE_KEY, source);
    await this.refreshTools();
  }

  private async refreshTools(): Promise<void> {
    const group = this.session.selectedGroup;
    const root = this.session.baseUrl && group ? this.roots.getRoot(this.session.baseUrl, group.id) : undefined;
    this.toolStates = await this.releases.installedStates(root, this.toolSource());
    this.sendSnapshot();
  }

  private async listToolReleases(tool: ToolId): Promise<void> {
    if (!['codebase-wiki', 'megin', 'merge-reviewer'].includes(tool)) throw new Error('不支援此工具。');
    const releases = await this.releases.listReleases(tool, this.toolSource());
    this.post({ type: 'toolReleases', tool, releases: releases.map((release) => ({ tag: release.tag, version: release.version, source: release.source, assetName: release.asset.name, releaseUrl: release.releaseUrl, sha256Verified: !!release.asset.sha256 })), fallbackMessage: releases.some((item) => item.fallbackFrom) ? 'GitHub 無相容 Release，已切換至 Gitea。' : undefined });
  }

  private async installTool(tool: ToolId, version?: string): Promise<void> {
    if (!['codebase-wiki', 'megin', 'merge-reviewer'].includes(tool)) throw new Error('不支援此工具。');
    const group = this.session.selectedGroup;
    const root = this.session.baseUrl && group ? this.roots.getRoot(this.session.baseUrl, group.id) : undefined;
    if (!root) throw new Error('請先選擇非 Git Group 工作目錄。');
    this.toolStates = [...this.toolStates.filter((item) => item.tool !== tool), { tool, status: 'installing' }];
    this.sendSnapshot();
    try {
    let picked = version ? await this.releases.getVersion(tool, version, this.toolSource()) : await this.releases.latestCompatible(tool, this.toolSource());
    const python = vscode.workspace.getConfiguration('gitlabWorkspace').get<string>('pythonPath', 'python');
    const pythonVersion = await execFileAsync(python, ['--version'], { timeout: 10_000 }).catch(() => { throw new Error('需要 Python 3.11+ 才能安裝工具 Release。'); });
    const versionText = `${pythonVersion.stdout} ${pythonVersion.stderr}`;
    const parsed = /Python\s+(\d+)\.(\d+)/.exec(versionText);
    if (!parsed || Number(parsed[1]) < 3 || (Number(parsed[1]) === 3 && Number(parsed[2]) < 11)) throw new Error('需要 Python 3.11+ 才能安裝工具 Release。');
    let archive: Uint8Array;
    try { archive = await this.releases.download(picked); }
    catch (error) {
      if (!(error instanceof ReleaseDownloadError) || this.toolSource() !== 'auto' || picked.source !== 'github') throw error;
      const githubError = error;
      try {
        const fallback = version ? await this.releases.getVersion(tool, picked.version, 'gitea') : await this.releases.latestCompatible(tool, 'gitea');
        archive = await this.releases.download(fallback);
        picked = { ...fallback, fallbackFrom: 'github' };
      } catch (fallbackError) {
        throw new Error(`GitHub Release 附件下載失敗，內網 Gitea 備援也無法提供可用封裝：${readableError(fallbackError)}`, { cause: new AggregateError([githubError, fallbackError]) });
      }
      this.post({ type: 'message', message: `GitHub Release 附件連線失敗，已切換至 Gitea v${picked.version}。` });
    }
    const helper = vscode.Uri.joinPath(this.context.extensionUri, 'resources', 'tool-installer.py').fsPath;
    await mkdir(this.context.globalStorageUri.fsPath, { recursive: true });
    const temporary = await mkdtemp(path.join(this.context.globalStorageUri.fsPath, 'release-'));
    const zipPath = path.join(temporary, 'release.zip');
    try {
      await mkdir(temporary, { recursive: true });
      await writeFile(zipPath, archive, { flag: 'wx' });
      const progress = vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `安裝 ${tool} v${picked.version}`, cancellable: false }, async () => {
        const result = await execFileAsync(python, [helper, tool, zipPath, root, picked.version, picked.source], { cwd: root, timeout: 10 * 60_000, maxBuffer: 1024 * 1024, windowsHide: true }).catch((error: unknown) => { throw new Error(`Release 安裝失敗：${readableError(error)}`); });
        const jsonLine = result.stdout.trim().split(/\r?\n/).at(-1);
        let payload: { ok?: boolean; error?: string } = {};
        try { payload = JSON.parse(jsonLine ?? '') as typeof payload; } catch { /* helper errors are checked below */ }
        if (!payload.ok) throw new Error(payload.error ?? '工具安裝器未確認安裝結果。');
      });
      await progress;
    } finally { await rm(temporary, { recursive: true, force: true }); }
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
