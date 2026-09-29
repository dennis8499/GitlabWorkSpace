import * as vscode from 'vscode';
import { GitLabApiError } from './api/gitLabClient';
import type { GitLabGroup, GitLabIssue, GitLabProject } from './api/types';
import { GitLabSession } from './connection/session';
import { cloneProjects, type CloneProgress } from './git/cloneService';
import { normalizeGitLabBaseUrl } from './api/urlPolicy';
import { IssuePanels } from './issues/issuePanel';

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
    this.description = selected ? 'selected' : undefined;
    this.command = { command: 'gitlabWorkspace.selectGroup', title: 'Select GitLab Group', arguments: [group] };
  }
}

class IssueItem extends vscode.TreeItem {
  readonly issue: GitLabIssue;

  constructor(issue: GitLabIssue) {
    super(`#${issue.iid} ${issue.title}`, vscode.TreeItemCollapsibleState.None);
    this.issue = issue;
    this.description = issue.state;
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
    const label = state === 'opened' ? 'Opened' : 'Closed';
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
          return [new PlaceholderItem('Select this group to browse its repositories')];
        }
        const projects = await client.listGroupProjects(element.group.id);
        if (this.session.selectedGroup?.id !== element.group.id) {
          this.syncCheckedGroup(this.session.selectedGroup?.id);
          return [new PlaceholderItem('Select this group to browse its repositories')];
        }
        this.reconcileCheckedProjects(element.group.id, projects);
        return projects.length
          ? projects.map((project) => new ProjectItem(project, element.group.id, this.checkedProjectIds.has(project.id)))
          : [new PlaceholderItem('No repositories in this group')];
      }
      const groups = await client.listGroups();
      this.syncCheckedGroup(this.session.selectedGroup?.id);
      const selectedId = this.session.selectedGroup?.id;
      return groups.length
        ? groups.map((group) => new GroupItem(group, group.id === selectedId))
        : [new PlaceholderItem('No GitLab groups are available')];
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
        : [new PlaceholderItem(`No ${element.state} issues assigned to you in this group`)];
    }
    const group = this.session.selectedGroup;
    if (!group) return [new PlaceholderItem('Select a GitLab group', 'gitlabWorkspace.selectGroup')];
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
  const repoTree = vscode.window.createTreeView('gitlabWorkspace.repositories', {
    treeDataProvider: repositories,
    showCollapseAll: false
  });
  const issueTree = vscode.window.createTreeView('gitlabWorkspace.myIssues', {
    treeDataProvider: issues,
    showCollapseAll: false
  });
  const cloneState = new CloneOperationGate();
  await updateCloneCommandContexts(session, cloneState);
  context.subscriptions.push(repoTree.onDidChangeCheckboxState((event) => repositories.updateCheckboxState(event.items)));
  context.subscriptions.push(repoTree, issueTree, issuePanels, repositories, issues);
  context.subscriptions.push(
    vscode.commands.registerCommand('gitlabWorkspace.connect', () => connectToGitLab(session, repositories, issues, issuePanels, cloneState)),
    vscode.commands.registerCommand('gitlabWorkspace.selectGroup', (group?: GitLabGroup) => selectGroup(session, repositories, issues, group, cloneState)),
    vscode.commands.registerCommand('gitlabWorkspace.refresh', () => refreshTrees(repositories, issues)),
    vscode.commands.registerCommand('gitlabWorkspace.disconnect', async () => {
      issuePanels.close();
      await session.disconnect();
      repositories.setSelectedGroup(undefined);
      issues.refresh();
      await updateCloneCommandContexts(session, cloneState);
      await vscode.window.showInformationMessage('Disconnected from GitLab.');
    }),
    vscode.commands.registerCommand('gitlabWorkspace.cloneRepositories', () => cloneRepositories(session, repositories, 'pick', cloneState)),
    vscode.commands.registerCommand('gitlabWorkspace.cloneAllRepositories', () => cloneRepositories(session, repositories, 'all', cloneState)),
    vscode.commands.registerCommand('gitlabWorkspace.cloneSelectedRepositories', () => cloneRepositories(session, repositories, 'selected', cloneState)),
    vscode.commands.registerCommand('gitlabWorkspace.createIssue', () => issuePanels.showCreate()),
    vscode.commands.registerCommand('gitlabWorkspace.openIssue', async (item: IssueItem) => {
      if (item?.issue) await issuePanels.showIssue(item.issue);
    })
  );
}

export function deactivate(): void {}

async function connectToGitLab(
  session: GitLabSession,
  repositories: RepositoryProvider,
  issues: IssueProvider,
  issuePanels: IssuePanels,
  cloneState: CloneOperationGate
): Promise<void> {
  const currentUrl = session.baseUrl ?? '';
  const baseUrl = await vscode.window.showInputBox({
    title: 'Connect to GitLab',
    prompt: 'Enter the full GitLab base URL (HTTP or HTTPS). HTTP sends your token without encryption.',
    value: currentUrl,
    placeHolder: 'https://gitlab.example.com or http://gitlab.local:8929',
    ignoreFocusOut: true,
    validateInput: (value) => {
      try { normalizeUrlForPrompt(value); return undefined; }
      catch (error) { return readableError(error); }
    }
  });
  if (!baseUrl) return;
  const token = await vscode.window.showInputBox({
    title: 'GitLab Personal Access Token',
    prompt: 'Token must be able to call the GitLab API and clone private repositories.',
    password: true,
    ignoreFocusOut: true,
    validateInput: (value) => value.trim() ? undefined : 'Enter an access token.'
  });
  if (!token) return;

  await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Connecting to GitLab…', cancellable: false }, async () => {
    try {
      const user = await session.connect(baseUrl, token);
      issuePanels.close();
      repositories.clearCheckedProjects();
      issues.refresh();
      await updateCloneCommandContexts(session, cloneState);
      await vscode.window.showInformationMessage(`Connected to GitLab as ${user.name} (@${user.username}).`);
    } catch (error) {
      await vscode.window.showErrorMessage(readableError(error));
    }
  });
}

function normalizeUrlForPrompt(value: string): string {
  return normalizeGitLabBaseUrl(value);
}

async function selectGroup(
  session: GitLabSession,
  repositories: RepositoryProvider,
  issues: IssueProvider,
  requestedGroup: GitLabGroup | undefined,
  cloneState: CloneOperationGate
): Promise<void> {
  try {
    if (requestedGroup) {
      await session.setSelectedGroup(requestedGroup);
      repositories.setSelectedGroup(requestedGroup.id);
      issues.refresh();
      await updateCloneCommandContexts(session, cloneState);
      return;
    }
    const client = await session.getClient();
    const groups = await client.listGroups();
    if (!groups.length) {
      await vscode.window.showInformationMessage('No GitLab groups are available for this account.');
      return;
    }
    const selected = await vscode.window.showQuickPick(groups.map((group) => ({ label: group.full_path, description: group.name, group })), {
      title: 'Select GitLab Group',
      placeHolder: 'Groups where you are a member',
      ignoreFocusOut: true
    });
    if (!selected) return;
    await session.setSelectedGroup(selected.group);
    repositories.setSelectedGroup(selected.group.id);
    issues.refresh();
    await updateCloneCommandContexts(session, cloneState);
  } catch (error) {
    await vscode.window.showErrorMessage(readableError(error));
  }
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
  cloneState: CloneOperationGate
): Promise<void> {
  if (!cloneState.tryStart()) {
    await vscode.window.showWarningMessage('A repository clone is already in progress.');
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
        title: 'Clone Repositories',
        placeHolder: 'Select one or more repositories',
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
      title: 'Cloning GitLab repositories',
      cancellable: false
    }, async (progress) => cloneProjects(destination, chosen, credentials.baseUrl, credentials.token, (event) => updateCloneProgress(progress, event)));
    repositories.removeCheckedProjects(group.id, result.completed);

    if (result.failed) {
      await vscode.window.showErrorMessage(
        `Cloned ${result.completed.length} repository(ies). “${result.failed.path_with_namespace}” failed; ${result.skipped.length} remaining repository(ies) were skipped.`
      );
    } else {
      await vscode.window.showInformationMessage(`Cloned ${result.completed.length} repository(ies) to ${destination}.`);
    }
  } catch (error) {
    await vscode.window.showErrorMessage(readableError(error));
  } finally {
    cloneState.finish();
    await updateCloneCommandContexts(session, cloneState);
  }
}

async function updateCloneCommandContexts(session: GitLabSession, cloneState: CloneOperationGate): Promise<void> {
  await vscode.commands.executeCommand('setContext', 'gitlabWorkspace.groupSelected', Boolean(session.selectedGroup));
  await vscode.commands.executeCommand('setContext', 'gitlabWorkspace.cloneInProgress', cloneState.inProgress);
}

async function chooseDestination(): Promise<string | undefined> {
  const folders = vscode.workspace.workspaceFolders ?? [];
  if (folders.length === 1) return folders[0].uri.fsPath;
  if (folders.length > 1) {
    const selected = await vscode.window.showQuickPick(folders.map((folder) => ({
      label: folder.name,
      description: folder.uri.fsPath,
      path: folder.uri.fsPath
    })), { title: 'Clone into Workspace Folder', placeHolder: 'Choose a local workspace folder' });
    return selected?.path;
  }
  const selected = await vscode.window.showOpenDialog({
    canSelectFiles: false,
    canSelectFolders: true,
    canSelectMany: false,
    openLabel: 'Clone Here',
    title: 'Choose a local destination folder'
  });
  return selected?.[0].scheme === 'file' ? selected[0].fsPath : undefined;
}

function updateCloneProgress(progress: vscode.Progress<{ message?: string; increment?: number }>, event: CloneProgress): void {
  const name = event.project.path_with_namespace;
  if (event.state === 'progress') {
    progress.report({ message: `${name}: ${event.percent ?? 0}%` });
  } else if (event.state === 'starting') {
    progress.report({ message: `${name}: starting` });
  } else if (event.state === 'completed') {
    progress.report({ message: `${name}: complete` });
  } else {
    progress.report({ message: `${name}: ${event.message ?? event.state}` });
  }
}

function readableError(error: unknown): string {
  if (error instanceof GitLabApiError) return error.message;
  if (error instanceof Error && error.message && !/token|authorization|private-token/i.test(error.message)) return error.message;
  return 'The GitLab operation could not be completed.';
}
