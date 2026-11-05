import * as vscode from 'vscode';
import type { GitRepositoryService } from './git/gitRepositoryService';
import type { GitRepositorySummary } from './git/gitProtocol';
import type { NavigationSnapshot } from './workspace/navigationProtocol';
import type { GitLabIssue, GitLabMergeRequest } from './api/types';
import type { WorkspacePanel } from './workspace/workspacePanel';

export type RepositoryNode = { kind: 'folder'; folder: vscode.WorkspaceFolder; repositories: readonly GitRepositorySummary[] }
  | { kind: 'repository'; repository: GitRepositorySummary };
export type WorkNode = { kind: 'section'; section: 'issues' | 'mergeRequests' }
  | { kind: 'issue'; issue: GitLabIssue; scope: string }
  | { kind: 'mergeRequest'; mergeRequest: GitLabMergeRequest; scope: string };

export class RepositoryViewProvider implements vscode.TreeDataProvider<RepositoryNode>, vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<RepositoryNode | undefined>();
  readonly onDidChangeTreeData = this.emitter.event;
  private readonly subscription: vscode.Disposable;
  constructor(private readonly repositories: Pick<GitRepositoryService, 'getCachedSummaryState' | 'onDidChangeRepositories'>) {
    this.subscription = repositories.onDidChangeRepositories(() => this.refresh());
  }
  refresh(): void { this.emitter.fire(undefined); }
  getChildren(node?: RepositoryNode): RepositoryNode[] {
    if (node?.kind === 'repository') return [];
    if (node?.kind === 'folder') return node.repositories.map(repository => ({ kind: 'repository', repository }));
    const repositories = this.repositories.getCachedSummaryState().repositories;
    const folders = vscode.workspace.workspaceFolders ?? [];
    if (folders.length < 2) return repositories.map(repository => ({ kind: 'repository', repository }));
    const groups = new Map<string, GitRepositorySummary[]>(), outside: RepositoryNode[] = [];
    for (const repository of repositories) {
      const folder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(repository.path));
      if (!folder) { outside.push({ kind: 'repository', repository }); continue; }
      const key = folder.uri.toString(), group = groups.get(key) ?? []; group.push(repository); groups.set(key, group);
    }
    return [...folders.filter(folder => groups.has(folder.uri.toString())).map(folder => ({ kind: 'folder' as const, folder,
      repositories: groups.get(folder.uri.toString())! })), ...outside];
  }
  getTreeItem(node: RepositoryNode): vscode.TreeItem {
    if (node.kind === 'folder') {
      const item = new vscode.TreeItem(node.folder.name, vscode.TreeItemCollapsibleState.Expanded);
      item.id = `folder:${node.folder.uri.toString()}`; item.resourceUri = node.folder.uri;
      item.tooltip = node.folder.uri.fsPath; item.iconPath = new vscode.ThemeIcon('folder'); return item;
    }
    const repository = node.repository, item = new vscode.TreeItem(repository.name, vscode.TreeItemCollapsibleState.None);
    item.id = `repository:${repository.id}`; item.contextValue = 'gitlabWorkspace.repository';
    item.description = [repository.branch ?? '未建立分支', repository.conflictCount ? `衝突 ${repository.conflictCount}` : '',
      `暫存 ${repository.stagedCount} · 變更 ${repository.unstagedCount}`, repository.busy ? '處理中' : ''].filter(Boolean).join(' · ');
    item.tooltip = `${repository.name}\n${repository.path}\n${item.description}`;
    item.resourceUri = vscode.Uri.file(repository.path); item.iconPath = new vscode.ThemeIcon('repo');
    item.accessibilityInformation = { label: `${repository.name}，${item.description}，${repository.path}` };
    item.command = { command: 'gitlabWorkspace.openRepository', title: '開啟 Repo 版控', arguments: [repository.id] };
    return item;
  }
  dispose(): void { this.subscription.dispose(); this.emitter.dispose(); }
}

export class MyWorkViewProvider implements vscode.TreeDataProvider<WorkNode>, vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<WorkNode | undefined>();
  readonly onDidChangeTreeData = this.emitter.event;
  constructor(private readonly snapshot: () => NavigationSnapshot) {}
  refresh(): void { this.emitter.fire(undefined); }
  getChildren(node?: WorkNode): WorkNode[] {
    const state = this.snapshot();
    if (!state.connected || !state.group) return [];
    if (!node) return [{ kind: 'section', section: 'issues' }, { kind: 'section', section: 'mergeRequests' }];
    if (node.kind !== 'section' || !state.connectedScope) return [];
    return node.section === 'issues' ? state.issues.map(issue => ({ kind: 'issue', issue, scope: state.scope }))
      : state.mergeRequests.map(mergeRequest => ({ kind: 'mergeRequest', mergeRequest, scope: state.scope }));
  }
  getTreeItem(node: WorkNode): vscode.TreeItem {
    const state = this.snapshot();
    if (node.kind === 'section') {
      const section = state.sections[node.section], count = state[node.section].length;
      const item = new vscode.TreeItem(node.section === 'issues' ? '指派給我的 Issue' : 'Merge Request', vscode.TreeItemCollapsibleState.Expanded);
      item.id = `${state.scope}:${node.section}`; item.contextValue = 'gitlabWorkspace.workSection';
      const status = !section || section.status === 'idle' ? '尚未載入' : section.status === 'loading' || section.refreshing ? '載入中'
        : section.status === 'error' ? '載入失敗；可重新整理' : section.status === 'unsupported' ? '站台不支援' : section.complete === false ? '部分結果；更多請開啟工作台' : count ? '已載入' : '沒有項目';
      item.description = `${count} · ${status}`; item.tooltip = section?.error ?? section?.pausedReason ?? status;
      item.iconPath = new vscode.ThemeIcon(node.section === 'issues' ? 'issues' : 'git-pull-request');
      item.accessibilityInformation = { label: `${item.label}，${item.description}` }; return item;
    }
    const data = node.kind === 'issue' ? node.issue : node.mergeRequest;
    const item = new vscode.TreeItem(`${node.kind === 'issue' ? '#' : '!'}${data.iid} ${data.title}`, vscode.TreeItemCollapsibleState.None);
    const project = state.projects.find(project => project.id === data.project_id)?.path_with_namespace ?? `專案 ${data.project_id}`;
    item.id = `${node.scope}:${node.kind}:${data.project_id}:${data.iid}`;
    item.description = project; item.tooltip = `${data.title}\n${project}\n${data.state}`;
    item.contextValue = `gitlabWorkspace.${node.kind}`;
    item.iconPath = new vscode.ThemeIcon(node.kind === 'issue' ? 'issues' : 'git-pull-request');
    item.command = { command: node.kind === 'issue' ? 'gitlabWorkspace.openIssue' : 'gitlabWorkspace.openMergeRequest',
      title: '開啟詳情', arguments: [node] };
    item.accessibilityInformation = { label: `${item.label}，${project}，${data.state}` }; return item;
  }
  dispose(): void { this.emitter.dispose(); }
}

/** Visibility owns entry reads; rendering, expansion and change events use cached data. */
export class NavigationViews implements vscode.Disposable {
  private readonly subscriptions: vscode.Disposable[] = [];
  readonly repositories: RepositoryViewProvider;
  readonly work: MyWorkViewProvider;
  readonly repositoryView: vscode.TreeView<RepositoryNode>;
  readonly workView: vscode.TreeView<WorkNode>;
  private enteredWorkScope?: string;
  private workFailureScope?: string;
  private repositoryEntered = false;
  private contextKey = '';
  private disposed = false;
  constructor(private readonly git: GitRepositoryService,
    private readonly host: Pick<WorkspacePanel, 'getNavigationSnapshot' | 'onDidChangeNavigation' | 'loadNavigationData'>,
    private readonly onError: (error: unknown) => void) {
    this.repositories = new RepositoryViewProvider(git); this.work = new MyWorkViewProvider(() => host.getNavigationSnapshot());
    this.repositoryView = vscode.window.createTreeView('gitlabWorkspace.repositories', { treeDataProvider: this.repositories, showCollapseAll: true });
    this.workView = vscode.window.createTreeView('gitlabWorkspace.myWork', { treeDataProvider: this.work, showCollapseAll: true });
    this.subscriptions.push(this.repositories, this.work, this.repositoryView, this.workView,
      this.repositoryView.onDidChangeVisibility(event => { if (event.visible && !this.repositoryEntered) {
        this.repositoryEntered = true; void git.getSummaryState().then(() => this.refresh(), onError);
      } }),
      this.workView.onDidChangeVisibility(event => { if (event.visible) this.enterWork(); }),
      host.onDidChangeNavigation(() => this.refresh()),
      vscode.workspace.onDidChangeWorkspaceFolders(() => this.refresh()));
    this.refresh();
    if (this.repositoryView.visible) { this.repositoryEntered = true; void git.getSummaryState().then(() => this.refresh(), onError); }
  }
  refresh(): void {
    if (this.disposed) return;
    const state = this.host.getNavigationSnapshot();
    const key = `${state.connected}:${!!state.group}`;
    if (this.contextKey !== key) {
      this.contextKey = key;
      void vscode.commands.executeCommand('setContext', 'gitlabWorkspace.connected', state.connected);
      void vscode.commands.executeCommand('setContext', 'gitlabWorkspace.hasGroup', !!state.group);
    }
    this.workView.description = [state.account, state.group].filter(Boolean).join(' · ');
    const errors = Object.values(state.sections).filter(section => section?.status === 'error').length;
    this.workView.message = state.connected && state.group && this.workFailureScope === state.scope ? '無法載入目前帳號／Group。請重新整理，或開啟工作台查看訊息。'
      : errors ? '部分資料無法載入。可重新整理，或開啟工作台查看原因。' : undefined;
    this.repositoryView.message = this.git.getCachedSummaryState().message;
    this.repositories.refresh(); this.work.refresh();
    if (this.workView.visible) this.enterWork();
  }
  private enterWork(): void {
    const state = this.host.getNavigationSnapshot();
    if (!state.connected || !state.group || this.enteredWorkScope === state.scope) return;
    this.enteredWorkScope = state.scope;
    this.workFailureScope = undefined; this.workView.message = '正在載入目前帳號／Group…';
    const current = () => !this.disposed && state.scope === this.host.getNavigationSnapshot().scope;
    void this.host.loadNavigationData().then(() => { if (current()) this.refresh(); }, error => {
      if (!current()) return;
      this.workFailureScope = state.scope; this.refresh(); this.onError(error);
    });
  }
  async refreshRepositories(): Promise<void> { await this.git.refresh(); this.refresh(); }
  async refreshMyWork(): Promise<void> {
    const scope = this.host.getNavigationSnapshot().scope;
    this.workFailureScope = undefined;
    try { await this.host.loadNavigationData(true); }
    catch (error) { if (scope === this.host.getNavigationSnapshot().scope) this.workFailureScope = scope; throw error; }
    finally { this.refresh(); }
  }
  async findRepository(): Promise<string | undefined> {
    const state = await this.git.getSummaryState();
    const selected = await vscode.window.showQuickPick(state.repositories.map(repository => ({ label: repository.name,
      description: repository.branch, detail: repository.path, repository })), { title: '尋找儲存庫', matchOnDescription: true, matchOnDetail: true });
    return selected?.repository.id;
  }
  async findWork(): Promise<WorkNode | undefined> {
    await this.host.loadNavigationData();
    const nodes = this.work.getChildren().flatMap(section => this.work.getChildren(section));
    const selected = await vscode.window.showQuickPick(nodes.map(node => {
      const item = this.work.getTreeItem(node);
      return { label: String(item.label), description: String(item.description ?? ''), node };
    }), { title: '尋找 Issue 或 MR', matchOnDescription: true, placeHolder: '搜尋目前 Group 已載入的工作項目' });
    return selected?.node;
  }
  dispose(): void { this.disposed = true; this.subscriptions.forEach(subscription => subscription.dispose()); }
}
