import * as vscode from 'vscode';
import { GitLabApiError } from './api/gitLabClient';
import type { GitLabGroup, GitLabIssue, GitLabProject } from './api/types';
import { GitLabSession } from './connection/session';
import {
  cloneProjects,
  syncLocalDefaultBranches,
  type CloneProgress,
  type LocalSyncProgress
} from './git/cloneService';
import { normalizeGitLabBaseUrl } from './api/urlPolicy';
import { IssuePanels } from './issues/issuePanel';
import { WorkspacePanel } from './workspace/workspacePanel';
import { QuickActionsViewProvider, type QuickAction } from './quickActionsView';

const QUICK_ACTION_COMMANDS: Record<QuickAction, string> = {
  openWorkspace: 'gitlabWorkspace.openWorkspace',
  selectGroup: 'gitlabWorkspace.selectGroup',
  refresh: 'gitlabWorkspace.refresh',
  connect: 'gitlabWorkspace.connect'
};

class ProjectItem extends vscode.TreeItem {
  readonly project: GitLabProject;
  readonly groupId: number;

  constructor(project: GitLabProject, groupId: number, checked: boolean) {
    super(project.name, vscode.TreeItemCollapsibleState.None);
    this.project = project;
    this.groupId = groupId;
    this.id = `gitlabProject:${groupId}:${project.id}`;
    this.description = project.namespace?.full_path ?? project.path_with_namespace;
    this.tooltip = `${project.path_with_namespace}\n${project.web_url}`;
    this.contextValue = 'gitlabProject';
    this.iconPath = new vscode.ThemeIcon('repo');
    this.checkboxState = checked ? vscode.TreeItemCheckboxState.Checked : vscode.TreeItemCheckboxState.Unchecked;
  }
}

class GroupItem extends vscode.TreeItem {
  constructor(readonly group: GitLabGroup, selected: boolean, collapsible = true) {
    super(
      group.full_path,
      collapsible
        ? (selected ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed)
        : vscode.TreeItemCollapsibleState.None
    );
    this.contextValue = 'gitlabGroup';
    this.iconPath = new vscode.ThemeIcon('organization');
    this.description = selected ? '目前選取' : undefined;
    this.command = { command: 'gitlabWorkspace.selectGroup', title: '選擇 Group', arguments: [group] };
  }
}

class IssueItem extends vscode.TreeItem {
  readonly issue: GitLabIssue;

  constructor(issue: GitLabIssue) {
    super(`#${issue.iid} ${issue.title}`, vscode.TreeItemCollapsibleState.None);
    this.issue = issue;
    this.description = issue.state === 'opened' ? '未結案' : '已結案';
    this.tooltip = `${issue.title}\n${issue.web_url}`;
    this.contextValue = 'gitlabIssue';
    this.iconPath = new vscode.ThemeIcon(issue.state === 'opened' ? 'issues' : 'pass');
    this.command = {
      command: 'gitlabWorkspace.openIssue',
      title: 'Open Issue Details',
      arguments: [this]
    };
  }
}

class IssueStateGroupItem extends vscode.TreeItem {
  constructor(readonly state: 'opened' | 'closed', readonly issues: GitLabIssue[]) {
    const label = state === 'opened' ? '未結案' : '已結案';
    super(`${label} (${issues.length})`, vscode.TreeItemCollapsibleState.Collapsed);
    this.contextValue = 'gitlabIssueStateGroup';
    this.description = label;
    this.iconPath = new vscode.ThemeIcon(state === 'opened' ? 'issues' : 'pass');
  }
}

class PlaceholderItem extends vscode.TreeItem {
  constructor(label: string, command?: string) {
    super(label, vscode.TreeItemCollapsibleState.None);
    if (command) this.command = { command, title: label };
    this.contextValue = 'gitlabPlaceholder';
  }
}

export class RepositoryProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.changed.event;
  private checkedProjectIds = new Set<number>();
  private checkedGroupId: number | undefined;

  constructor(private readonly session: GitLabSession) {
    this.checkedGroupId = session.selectedGroup?.id;
  }

  refresh(): void { this.changed.fire(); }
  getTreeItem(item: vscode.TreeItem): vscode.TreeItem { return item; }
  dispose(): void { this.changed.dispose(); }

  setSelectedGroup(groupId: number | undefined): void {
    this.syncCheckedGroup(groupId);
    this.refresh();
  }

  clearCheckedProjects(): void {
    this.syncCheckedGroup(this.session.selectedGroup?.id);
    this.checkedProjectIds.clear();
    this.refresh();
  }

  updateCheckboxState(items: ReadonlyArray<[vscode.TreeItem, vscode.TreeItemCheckboxState]>): void {
    const groupId = this.syncCheckedGroup(this.session.selectedGroup?.id);
    for (const [item, state] of items) {
      if (!(item instanceof ProjectItem) || item.groupId !== groupId) continue;
      item.checkboxState = state;
      if (state === vscode.TreeItemCheckboxState.Checked) this.checkedProjectIds.add(item.project.id);
      else this.checkedProjectIds.delete(item.project.id);
    }
  }

  getCheckedProjects(groupId: number, projects: readonly GitLabProject[]): GitLabProject[] {
    if (this.syncCheckedGroup(this.session.selectedGroup?.id) !== groupId) return [];
    const availableIds = new Set(projects.map((project) => project.id));
    for (const projectId of this.checkedProjectIds) {
      if (!availableIds.has(projectId)) this.checkedProjectIds.delete(projectId);
    }
    return projects.filter((project) => this.checkedProjectIds.has(project.id));
  }

  ensureCheckedProjects(groupId: number, projects: readonly GitLabProject[]): void {
    if (this.syncCheckedGroup(this.session.selectedGroup?.id) !== groupId) return;
    for (const project of projects) this.checkedProjectIds.add(project.id);
    this.refresh();
  }

  removeCheckedProjects(groupId: number, projects: readonly GitLabProject[]): void {
    if (this.syncCheckedGroup(this.session.selectedGroup?.id) !== groupId) return;
    for (const project of projects) this.checkedProjectIds.delete(project.id);
    this.refresh();
  }

  async getChildren(element?: vscode.TreeItem): Promise<vscode.TreeItem[]> {
    try {
      const client = await this.session.getClient();
      if (element instanceof GroupItem) {
        if (this.syncCheckedGroup(this.session.selectedGroup?.id) !== element.group.id) {
          return [new PlaceholderItem('選擇此 Group 以瀏覽專案')];
        }
        const projects = await client.listGroupProjects(element.group.id);
        if (this.session.selectedGroup?.id !== element.group.id) {
          this.syncCheckedGroup(this.session.selectedGroup?.id);
          return [new PlaceholderItem('選擇此 Group 以瀏覽專案')];
        }
        this.reconcileCheckedProjects(element.group.id, projects);
        return projects.length
          ? projects.map((project) => new ProjectItem(project, element.group.id, this.checkedProjectIds.has(project.id)))
          : [new PlaceholderItem('此 Group 沒有專案')];
      }
      const groups = await client.listGroups();
      this.syncCheckedGroup(this.session.selectedGroup?.id);
      const selectedId = this.session.selectedGroup?.id;
      return groups.length
        ? groups.map((group) => new GroupItem(group, group.id === selectedId))
        : [new PlaceholderItem('目前帳號沒有可用的 GitLab Group')];
    } catch (error) {
      return [new PlaceholderItem(readableError(error))];
    }
  }

  private syncCheckedGroup(groupId: number | undefined): number | undefined {
    if (this.checkedGroupId !== groupId) {
      this.checkedProjectIds.clear();
      this.checkedGroupId = groupId;
    }
    return groupId;
  }

  private reconcileCheckedProjects(groupId: number, projects: readonly GitLabProject[]): void {
    if (this.syncCheckedGroup(this.session.selectedGroup?.id) !== groupId) return;
    const availableIds = new Set(projects.map((project) => project.id));
    for (const projectId of this.checkedProjectIds) {
      if (!availableIds.has(projectId)) this.checkedProjectIds.delete(projectId);
    }
  }
}

export class CloneOperationGate {
  private active = false;

  get inProgress(): boolean { return this.active; }

  tryStart(): boolean {
    if (this.active) return false;
    this.active = true;
    return true;
  }

  finish(): void { this.active = false; }
}

export class IssueProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.changed.event;

  constructor(private readonly session: GitLabSession) {}

  refresh(): void { this.changed.fire(); }
  getTreeItem(item: vscode.TreeItem): vscode.TreeItem { return item; }
  dispose(): void { this.changed.dispose(); }

  async getChildren(element?: vscode.TreeItem): Promise<vscode.TreeItem[]> {
    if (element instanceof IssueStateGroupItem) {
      return element.issues.length
        ? element.issues.map((issue) => new IssueItem(issue))
        : [new PlaceholderItem(`目前沒有指派給你的${element.state === 'opened' ? '未結案' : '已結案'} Issue`)];
    }
    const group = this.session.selectedGroup;
    if (!group) return [new PlaceholderItem('選擇 GitLab Group', 'gitlabWorkspace.selectGroup')];
    try {
      const client = await this.session.getClient();
      const projects = await client.listGroupProjects(group.id);
      const issues = await client.listAssignedGroupIssues(group.id, new Set(projects.map((project) => project.id)));
      const opened = issues.filter((issue) => issue.state === 'opened');
      const closed = issues.filter((issue) => issue.state === 'closed');
      return [
        new GroupItem(group, true, false),
        new IssueStateGroupItem('opened', opened),
        new IssueStateGroupItem('closed', closed)
      ];
    } catch (error) {
      return [new PlaceholderItem(readableError(error))];
    }
  }
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const session = new GitLabSession(context.secrets, context.globalState);
  const repositories = new RepositoryProvider(session);
  const issues = new IssueProvider(session);
  const issuePanels = new IssuePanels(context, session, () => issues.refresh());
  const cloneOutput = vscode.window.createOutputChannel('GitLab Workspace Repositories');
  const cloneState = new CloneOperationGate();
  const quickActions = new QuickActionsViewProvider(context.extensionUri, session, (action) =>
    vscode.commands.executeCommand(QUICK_ACTION_COMMANDS[action])
  );
  const workspacePanel = new WorkspacePanel(context, session, issuePanels, async () => {
    repositories.setSelectedGroup(session.selectedGroup?.id);
    issues.refresh();
    await updateCloneCommandContexts(session, cloneState);
    quickActions.refresh();
  });
  const repoTree = vscode.window.createTreeView('gitlabWorkspace.repositories', {
    treeDataProvider: repositories,
    showCollapseAll: false
  });
  const issueTree = vscode.window.createTreeView('gitlabWorkspace.myIssues', {
    treeDataProvider: issues,
    showCollapseAll: false
  });
  await updateCloneCommandContexts(session, cloneState);
  context.subscriptions.push(repoTree.onDidChangeCheckboxState((event) => repositories.updateCheckboxState(event.items)));
  context.subscriptions.push(quickActions, repoTree, issueTree, issuePanels, workspacePanel, repositories, issues, cloneOutput);
  context.subscriptions.push(vscode.window.registerWebviewViewProvider('gitlabWorkspace.quickActions', quickActions));
  context.subscriptions.push(
    vscode.commands.registerCommand('gitlabWorkspace.openWorkspace', () => workspacePanel.show()),
    vscode.commands.registerCommand('gitlabWorkspace.connect', async () => {
      try {
        const connected = await connectToGitLab(session, repositories, issues, issuePanels, cloneState);
        await workspacePanel.refreshFromSidebar();
        return connected;
      } finally {
        quickActions.refresh();
      }
    }),
    vscode.commands.registerCommand('gitlabWorkspace.selectGroup', (group?: GitLabGroup) => workspacePanel.selectGroupFromSidebar(group)),
    vscode.commands.registerCommand('gitlabWorkspace.refresh', async () => {
      try {
        refreshTrees(repositories, issues);
        await workspacePanel.refreshFromSidebar();
      } finally {
        quickActions.refresh();
      }
    }),
    vscode.commands.registerCommand('gitlabWorkspace.disconnect', () => workspacePanel.disconnectFromSidebar()),
    vscode.commands.registerCommand('gitlabWorkspace.cloneRepositories', () => workspacePanel.cloneFromSidebar('pick')),
    vscode.commands.registerCommand('gitlabWorkspace.cloneAllRepositories', () => workspacePanel.cloneFromSidebar('all')),
    vscode.commands.registerCommand('gitlabWorkspace.cloneSelectedRepositories', () => workspacePanel.cloneFromSidebar('selected', (projects, groupId) => resolveCloneCandidates('selected', groupId, projects, repositories).map((project) => project.id))),
    vscode.commands.registerCommand('gitlabWorkspace.syncLocalDefaultBranches', () => workspacePanel.syncFromSidebar()),
    vscode.commands.registerCommand('gitlabWorkspace.createIssue', () => issuePanels.showCreate()),
    vscode.commands.registerCommand('gitlabWorkspace.openIssue', async (item: IssueItem) => {
      if (item?.issue) await issuePanels.showIssue(item.issue);
    }),
    vscode.commands.registerCommand('gitlabWorkspace.openCloneMode', () => workspacePanel.show('clone')),
    vscode.commands.registerCommand('gitlabWorkspace.openSaMode', () => workspacePanel.show('sa')),
    vscode.commands.registerCommand('gitlabWorkspace.openDeveloperMode', () => workspacePanel.show('developer')),
    vscode.commands.registerCommand('gitlabWorkspace.openReviewerMode', () => workspacePanel.show('reviewer'))
  );
}

export function deactivate(): void {}

async function connectToGitLab(
  session: GitLabSession,
  repositories: RepositoryProvider,
  issues: IssueProvider,
  issuePanels: IssuePanels,
  cloneState: CloneOperationGate
): Promise<boolean | undefined> {
  const currentUrl = session.baseUrl ?? '';
  const baseUrl = await vscode.window.showInputBox({
    title: '連線至 GitLab',
    prompt: '輸入完整 GitLab 網址（HTTP 或 HTTPS）。HTTP 不會加密 Token 傳輸。',
    value: currentUrl,
    placeHolder: 'https://gitlab.example.com or http://gitlab.local:8929',
    ignoreFocusOut: true,
    validateInput: (value) => {
      try { normalizeUrlForPrompt(value); return undefined; }
      catch (error) { return readableError(error); }
    }
  });
  if (!baseUrl) return undefined;
  const token = await vscode.window.showInputBox({
    title: 'GitLab Personal Access Token',
    prompt: 'Token 需具備呼叫 GitLab API 的 api 範圍，並有權下載目標私有專案。',
    password: true,
    ignoreFocusOut: true,
    validateInput: (value) => value.trim() ? undefined : 'Enter an access token.'
  });
  if (!token) return undefined;

  return vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: '正在連線 GitLab…', cancellable: false }, async () => {
    try {
      const user = await session.connect(baseUrl, token);
      issuePanels.close();
      repositories.clearCheckedProjects();
      issues.refresh();
      await updateCloneCommandContexts(session, cloneState);
      await vscode.window.showInformationMessage(`已連線至 GitLab：${user.name} (@${user.username})`);
      return true;
    } catch (error) {
      await vscode.window.showErrorMessage(readableError(error));
      return false;
    }
  });
}

function normalizeUrlForPrompt(value: string): string {
  return normalizeGitLabBaseUrl(value);
}

function refreshTrees(repositories: RepositoryProvider, issues: IssueProvider): void {
  repositories.refresh();
  issues.refresh();
}

type CloneMode = 'all' | 'selected' | 'pick';

export function resolveCloneCandidates(
  mode: 'all' | 'selected',
  groupId: number,
  projects: readonly GitLabProject[],
  repositories: RepositoryProvider
): GitLabProject[] {
  return mode === 'all' ? [...projects] : repositories.getCheckedProjects(groupId, projects);
}

async function cloneRepositories(
  session: GitLabSession,
  repositories: RepositoryProvider,
  mode: CloneMode,
  cloneState: CloneOperationGate,
  cloneOutput: vscode.OutputChannel
): Promise<void> {
  if (!cloneState.tryStart()) {
    await vscode.window.showWarningMessage('A repository operation is already in progress.');
    return;
  }

  try {
    await updateCloneCommandContexts(session, cloneState);
    const group = session.selectedGroup;
    if (!group) {
      await vscode.window.showWarningMessage('Select a GitLab group first.');
      return;
    }
    const client = await session.getClient();
    const projects = await client.listGroupProjects(group.id);
    if (session.selectedGroup?.id !== group.id) {
      await vscode.window.showInformationMessage('The selected group changed. Start the clone again for the current group.');
      return;
    }
    if (!projects.length) {
      await vscode.window.showInformationMessage(`No repositories are available in ${group.full_path}.`);
      return;
    }

    let chosen: GitLabProject[];
    if (mode === 'all') {
      chosen = resolveCloneCandidates('all', group.id, projects, repositories);
    } else if (mode === 'selected') {
      chosen = resolveCloneCandidates('selected', group.id, projects, repositories);
      if (!chosen.length) {
        await vscode.window.showInformationMessage('Check at least one repository before cloning.');
        return;
      }
    } else {
      const picks = await vscode.window.showQuickPick(projects.map((project) => ({
        label: project.name,
        description: project.namespace?.full_path ?? project.path_with_namespace,
        detail: project.path,
        project
      })), {
        title: 'Clone or Update Repositories',
        placeHolder: 'Select repositories to clone or update',
        canPickMany: true,
        ignoreFocusOut: true
      });
      if (!picks?.length) return;
      chosen = picks.map((pick) => pick.project);
    }

    if (session.selectedGroup?.id !== group.id) {
      await vscode.window.showInformationMessage('The selected group changed. Start the clone again for the current group.');
      return;
    }
    const destination = await chooseDestination();
    if (!destination) return;
    if (session.selectedGroup?.id !== group.id) {
      await vscode.window.showInformationMessage('The selected group changed. Start the clone again for the current group.');
      return;
    }
    const credentials = await session.getCloneCredentials();
    if (session.selectedGroup?.id !== group.id) {
      await vscode.window.showInformationMessage('The selected group changed. Start the clone again for the current group.');
      return;
    }
    repositories.ensureCheckedProjects(group.id, chosen);
    const result = await vscode.window.withProgress({
      location: vscode.ProgressLocation.Notification,
      title: 'Cloning or updating GitLab repositories',
      cancellable: false
    }, async (progress) => cloneProjects(
      destination,
      chosen,
      credentials.baseUrl,
      credentials.token,
      (event) => updateCloneProgress(progress, event),
      { resolveProject: (project) => client.getProject(project.id) }
    ));
    repositories.removeCheckedProjects(group.id, result.completed);
    await showCloneResult(result, destination, cloneOutput);
  } catch (error) {
    await vscode.window.showErrorMessage(readableError(error));
  } finally {
    cloneState.finish();
    await updateCloneCommandContexts(session, cloneState);
  }
}

async function syncLocalRepositories(
  session: GitLabSession,
  cloneState: CloneOperationGate,
  cloneOutput: vscode.OutputChannel
): Promise<void> {
  if (!cloneState.tryStart()) {
    await vscode.window.showWarningMessage('A repository operation is already in progress.');
    return;
  }

  try {
    await updateCloneCommandContexts(session, cloneState);
    const group = session.selectedGroup;
    if (!group) {
      await vscode.window.showWarningMessage('Select a GitLab group first.');
      return;
    }
    const client = await session.getClient();
    const projects = await client.listGroupProjects(group.id);
    if (session.selectedGroup?.id !== group.id) {
      await vscode.window.showInformationMessage('The selected group changed. Start synchronization again for the current group.');
      return;
    }
    if (!projects.length) {
      await vscode.window.showInformationMessage(`No repositories are available in ${group.full_path}.`);
      return;
    }

    const destination = await chooseDestination('Choose Repository Folder', 'Select Folder');
    if (!destination) return;
    if (session.selectedGroup?.id !== group.id) {
      await vscode.window.showInformationMessage('The selected group changed. Start synchronization again for the current group.');
      return;
    }
    const credentials = await session.getCloneCredentials();
    if (session.selectedGroup?.id !== group.id) {
      await vscode.window.showInformationMessage('The selected group changed. Start synchronization again for the current group.');
      return;
    }

    const result = await vscode.window.withProgress({
      location: vscode.ProgressLocation.Notification,
      title: 'Fetching and pulling local GitLab default branches',
      cancellable: false
    }, async (progress) => syncLocalDefaultBranches(
      destination,
      projects,
      credentials.baseUrl,
      credentials.token,
      (event) => updateLocalSyncProgress(progress, event),
      { resolveProject: (project) => client.getProject(project.id) }
    ));
    await showLocalSyncResult(result, destination, cloneOutput);
  } catch (error) {
    await vscode.window.showErrorMessage(readableError(error));
  } finally {
    cloneState.finish();
    await updateCloneCommandContexts(session, cloneState);
  }
}

async function showCloneResult(
  result: Awaited<ReturnType<typeof cloneProjects>>,
  destination: string,
  output: vscode.OutputChannel
): Promise<void> {
  const summary = 'Cloned ' + result.cloned.length + ', synchronized ' + result.updated.length +
    ', skipped ' + result.skipped.length + ' repository(ies) to ' + destination + '.';
  if (result.failed || result.skipped.length > 0) {
    output.clear();
    output.appendLine('Repository operation details');
    output.appendLine('');
    for (const project of result.cloned) output.appendLine('Cloned: ' + project.path_with_namespace);
    for (const project of result.updated) output.appendLine('Synchronized: ' + project.path_with_namespace);
    if (result.failed) {
      output.appendLine('Failed: ' + result.failed.path_with_namespace + ': ' + (result.failureReason ?? 'Git operation failed.'));
    }
    for (const skipped of result.skipped) {
      output.appendLine('Skipped: ' + skipped.project.path_with_namespace + ': ' + skipped.reason);
    }
    const action = 'Show Details';
    const message = result.failed
      ? summary + ' The batch stopped after a Git operation failed.'
      : summary + ' Review the skipped repositories for details.';
    const selected = result.failed
      ? await vscode.window.showErrorMessage(message, action)
      : await vscode.window.showWarningMessage(message, action);
    if (selected === action) output.show(true);
    return;
  }
  await vscode.window.showInformationMessage(summary);
}

async function showLocalSyncResult(
  result: Awaited<ReturnType<typeof syncLocalDefaultBranches>>,
  destination: string,
  output: vscode.OutputChannel
): Promise<void> {
  if (result.found === 0 && result.skipped.length === 0 && result.failed.length === 0) {
    await vscode.window.showInformationMessage('No local repositories from the selected group were found in ' + destination + '.');
    return;
  }

  const summary = 'Updated ' + result.updated.length + ', already up to date ' + result.upToDate.length +
    ', skipped ' + result.skipped.length + ', failed ' + result.failed.length +
    ' local repository(ies) in ' + destination + '.';
  if (result.failed.length > 0 || result.skipped.length > 0) {
    output.clear();
    output.appendLine('Local repository synchronization details');
    output.appendLine('');
    for (const project of result.updated) output.appendLine('Updated: ' + project.path_with_namespace);
    for (const project of result.upToDate) output.appendLine('Already up to date: ' + project.path_with_namespace);
    for (const skipped of result.skipped) {
      output.appendLine('Skipped: ' + skipped.project.path_with_namespace + ': ' + skipped.reason);
    }
    for (const failed of result.failed) {
      output.appendLine('Failed: ' + failed.project.path_with_namespace + ': ' + failed.reason);
    }
    const action = 'Show Details';
    const message = result.failed.length > 0
      ? summary + ' Review the failed repositories for details.'
      : summary + ' Review the skipped repositories for details.';
    const selected = result.failed.length > 0
      ? await vscode.window.showErrorMessage(message, action)
      : await vscode.window.showWarningMessage(message, action);
    if (selected === action) output.show(true);
    return;
  }
  await vscode.window.showInformationMessage(summary);
}

async function updateCloneCommandContexts(session: GitLabSession, cloneState: CloneOperationGate): Promise<void> {
  await vscode.commands.executeCommand('setContext', 'gitlabWorkspace.groupSelected', Boolean(session.selectedGroup));
  await vscode.commands.executeCommand('setContext', 'gitlabWorkspace.cloneInProgress', cloneState.inProgress);
}

async function chooseDestination(
  title = 'Clone into Workspace Folder',
  openLabel = 'Clone Here'
): Promise<string | undefined> {
  const folders = vscode.workspace.workspaceFolders ?? [];
  if (folders.length === 1) return folders[0].uri.fsPath;
  if (folders.length > 1) {
    const selected = await vscode.window.showQuickPick(folders.map((folder) => ({
      label: folder.name,
      description: folder.uri.fsPath,
      path: folder.uri.fsPath
    })), { title, placeHolder: 'Choose a local workspace folder' });
    return selected?.path;
  }
  const selected = await vscode.window.showOpenDialog({
    canSelectFiles: false,
    canSelectFolders: true,
    canSelectMany: false,
    openLabel,
    title: 'Choose a local destination folder'
  });
  return selected?.[0].scheme === 'file' ? selected[0].fsPath : undefined;
}

function updateCloneProgress(progress: vscode.Progress<{ message?: string; increment?: number }>, event: CloneProgress): void {
  const name = event.project.path_with_namespace;
  if (event.state === 'progress') {
    progress.report({ message: `${name}: ${event.percent ?? 0}%` });
  } else if (event.state === 'starting') {
    progress.report({ message: `${name}: ${event.action === 'clone' ? 'cloning' : 'checking and updating'}` });
  } else if (event.state === 'completed') {
    progress.report({ message: `${name}: ${event.action === 'clone' ? 'cloned' : 'synchronized'}` });
  } else {
    progress.report({ message: `${name}: ${event.message ?? event.state}` });
  }
}

function updateLocalSyncProgress(
  progress: vscode.Progress<{ message?: string; increment?: number }>,
  event: LocalSyncProgress
): void {
  const name = event.project.path_with_namespace;
  if (event.state === 'progress') {
    progress.report({ message: `${name}: ${event.percent ?? 0}%` });
  } else if (event.state === 'starting') {
    progress.report({ message: `${name}: fetching and checking` });
  } else if (event.state === 'updated') {
    progress.report({ message: `${name}: updated` });
  } else if (event.state === 'up-to-date') {
    progress.report({ message: `${name}: already up to date` });
  } else {
    progress.report({ message: `${name}: ${event.message ?? event.state}` });
  }
}

function readableError(error: unknown): string {
  if (error instanceof GitLabApiError) return error.message;
  if (error instanceof Error && error.message && !/token|authorization|private-token/i.test(error.message)) return error.message;
  return 'The GitLab operation could not be completed.';
}
