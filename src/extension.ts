import * as vscode from 'vscode';
import { GitLabApiError } from './api/gitLabClient';
import type { GitLabGroup, GitLabIssue } from './api/types';
import { GitLabSession } from './connection/session';
import { IssuePanels } from './issues/issuePanel';
import { WorkspacePanel } from './workspace/workspacePanel';
import { QuickActionsViewProvider, type QuickAction } from './quickActionsView';
import { GitRepositoryService } from './git/gitRepositoryService';
import { OperationLog } from './logging/operationLog';

const QUICK_ACTION_COMMANDS: Record<QuickAction, string> = {
  openWorkspace: 'gitlabWorkspace.openWorkspace',
  openMyWork: 'gitlabWorkspace.openDeveloperMode',
  openProjects: 'gitlabWorkspace.openCloneMode',
  openAnalysis: 'gitlabWorkspace.openSaMode',
  openReviewer: 'gitlabWorkspace.openReviewerMode',
  openGit: 'gitlabWorkspace.openGitMode',
  openAdmin: 'gitlabWorkspace.openAdmin',
  addAccount: 'gitlabWorkspace.addAccount',
  switchAccount: 'gitlabWorkspace.switchAccount',
  logoutAccount: 'gitlabWorkspace.disconnect',
  removeAccount: 'gitlabWorkspace.removeAccount',
  openRepository: 'gitlabWorkspace.openGitMode'
};
let activeLog: OperationLog | undefined;

export async function activate(context: vscode.ExtensionContext): Promise<unknown> {
  const testMode = context.extensionMode === vscode.ExtensionMode.Test;
  const log = new OperationLog(vscode.Uri.joinPath(context.globalStorageUri, 'logs').fsPath, message => { void vscode.window.showWarningMessage(message); });
  activeLog = log;
  const session = new GitLabSession(context.secrets, context.globalState, testMode, context.workspaceState, log);
  log.setContextSource(() => ({ accountId: session.activeAccountId, baseUrl: session.baseUrl, groupId: session.selectedGroup?.id }));
  context.subscriptions.push(log);
  try { await session.initialize(); } catch { void vscode.window.showWarningMessage('既有 GitLab 帳號尚未完成遷移；設定與 Token 已保留，連線時會重試。'); }
  log.record({ feature: 'workspace', action: 'activate', result: 'success' });
  let refreshWorkspaceAfterIssueChange = (): void => undefined;
  const issuePanels = new IssuePanels(context, session, () => refreshWorkspaceAfterIssueChange());
  let workspacePanel: WorkspacePanel | undefined;
  const gitRepositories = new GitRepositoryService(context.extensionUri, context.globalStorageUri, session);
  const quickActions = new QuickActionsViewProvider(context.extensionUri, session, (action, repositoryId) =>
    vscode.commands.executeCommand(
      QUICK_ACTION_COMMANDS[action],
      action === 'openRepository' ? repositoryId : undefined
    ),
    async () => {
      const state = await gitRepositories.getSummaryState();
      return {
        activeMode: workspacePanel?.getActiveMode() ?? 'developer',
        selectedRepositoryId: workspacePanel?.getSelectedGitRepositoryId(),
        repositories: state.repositories,
        gitAvailable: state.available,
        gitMessage: state.message
      };
    }
  );
  workspacePanel = new WorkspacePanel(context, session, issuePanels, () => quickActions.refresh(), gitRepositories);
  gitRepositories.setGitLabProjects(() => workspacePanel?.getGitLabProjects() ?? []);
  context.subscriptions.push(gitRepositories.onDidChangeRepositories(() => quickActions.refresh()));
  refreshWorkspaceAfterIssueChange = () => {
    const refresh = workspacePanel?.refreshFromSidebar();
    if (refresh) void refresh.catch((error: unknown) => vscode.window.showErrorMessage(error instanceof Error ? error.message : String(error)));
  };

  const getWorkspace = (): WorkspacePanel => {
    if (!workspacePanel) throw new Error('The GitLab Workspace is not available.');
    return workspacePanel;
  };

  const registerLoggedCommand: typeof vscode.commands.registerCommand = (command, callback, thisArg) =>
    vscode.commands.registerCommand(command, (...args: unknown[]) => {
      const action = command.replace('gitlabWorkspace.', '');
      const feature = /Account|connect|disconnect/i.test(action) ? 'account' : /Issue/i.test(action) ? 'issue'
        : /clone|sync|scan/i.test(action) ? 'projects' : /Git|Repository/i.test(action) ? 'git' : /Group/i.test(action) ? 'group' : 'workspace';
      return log.run(feature, action, {}, () => Promise.resolve(callback.apply(thisArg, args)));
    });
  context.subscriptions.push(gitRepositories, quickActions, issuePanels, workspacePanel);
  context.subscriptions.push(vscode.window.registerWebviewViewProvider('gitlabWorkspace.quickActions', quickActions));
  context.subscriptions.push(
    registerLoggedCommand('gitlabWorkspace.openWorkspace', () => getWorkspace().navigateTo()),
    registerLoggedCommand('gitlabWorkspace.connect', async () => {
      try {
        await getWorkspace().connectFromSidebar();
        return true;
      } catch (error) {
        await vscode.window.showErrorMessage(readableError(error));
        return false;
      } finally { quickActions.refresh(); }
    }),
    registerLoggedCommand('gitlabWorkspace.selectGroup', (group?: GitLabGroup) => getWorkspace().selectGroupFromSidebar(group)),
    registerLoggedCommand('gitlabWorkspace.refresh', async () => {
      try { await getWorkspace().refreshFromSidebar(); }
      finally { quickActions.refresh(); }
    }),
    registerLoggedCommand('gitlabWorkspace.disconnect', () => getWorkspace().disconnectFromSidebar()),
    registerLoggedCommand('gitlabWorkspace.addAccount', (id?: string) => getWorkspace().accountFromSidebar('addAccount', id)),
    registerLoggedCommand('gitlabWorkspace.switchAccount', (id?: string) => getWorkspace().accountFromSidebar('switchAccount', id)),
    registerLoggedCommand('gitlabWorkspace.removeAccount', (id?: string) => getWorkspace().accountFromSidebar('removeAccount', id)),
    registerLoggedCommand('gitlabWorkspace.openAdmin', () => getWorkspace().navigateTo('admin')),
    registerLoggedCommand('gitlabWorkspace.scanRepositories', () => getWorkspace().scanFromSidebar()),
    registerLoggedCommand('gitlabWorkspace.cloneRepositories', () => getWorkspace().cloneFromSidebar('pick')),
    registerLoggedCommand('gitlabWorkspace.cloneAllRepositories', () => getWorkspace().cloneFromSidebar('all')),
    registerLoggedCommand('gitlabWorkspace.cloneSelectedRepositories', () => getWorkspace().cloneFromSidebar('selected')),
    registerLoggedCommand('gitlabWorkspace.syncLocalDefaultBranches', () => getWorkspace().syncFromSidebar()),
    registerLoggedCommand('gitlabWorkspace.createIssue', () => issuePanels.showCreate()),
    registerLoggedCommand('gitlabWorkspace.openIssue', async (item?: { issue?: GitLabIssue }) => {
      if (item?.issue) await issuePanels.showIssue(item.issue);
    }),
    registerLoggedCommand('gitlabWorkspace.openCloneMode', () => getWorkspace().navigateTo('clone')),
    registerLoggedCommand('gitlabWorkspace.openSaMode', () => getWorkspace().navigateTo('sa')),
    registerLoggedCommand('gitlabWorkspace.openDeveloperMode', () => getWorkspace().navigateTo('developer')),
    registerLoggedCommand('gitlabWorkspace.openReviewerMode', () => getWorkspace().navigateTo('reviewer')),
    registerLoggedCommand('gitlabWorkspace.openGitMode', (repoId?: string) => getWorkspace().navigateTo('git', repoId)),
    registerLoggedCommand('gitlabWorkspace.openRepository', (repoId?: string) => getWorkspace().navigateTo('git', repoId))
  );
  if (testMode) return {
    session,
    setFetchForTesting: (fetcher: typeof fetch) => session.setFetchForTesting(fetcher),
    getGitRepositoryState: () => gitRepositories.getSummaryState(),
    getRepositoryInventoryForTesting: () => gitRepositories.getInventory(),
    scanWorkspaceForTesting: (signal: AbortSignal, onProgress: (state: import('./git/repositoryScanProtocol').RepositoryScanState) => void) =>
      gitRepositories.scanWorkspace(signal, onProgress),
    queryLogsForTesting: (query?: import('./logging/logProtocol').LogQuery) => log.query(query),
    getLogQueryCountForTesting: () => getWorkspace().getLogQueryCountForTesting(),
    getGitCommandCountForTesting: () => gitRepositories.getCommandCountForTesting(),
    getWebviewMessageCountsForTesting: () => getWorkspace().getWebviewMessageCountsForTesting(),
    setGitWarningPromptHandlerForTesting: (handler: (message: string, options: vscode.MessageOptions, ...items: string[]) => Thenable<string | undefined>) =>
      gitRepositories.setWarningPromptHandlerForTesting(handler),
    setGitActionTraceHandlerForTesting: (handler: (event: { phase: 'start' | 'complete' | 'error'; repositoryId: string; action: string; error?: string }) => void) =>
      gitRepositories.setActionTraceHandlerForTesting(handler)
  };
}

export async function deactivate(): Promise<void> { await activeLog?.flush(); activeLog = undefined; }

function readableError(error: unknown): string {
  if (error instanceof GitLabApiError) return error.message;
  if (error instanceof Error && error.message && !/token|authorization|private-token/i.test(error.message)) return error.message;
  return 'The GitLab operation could not be completed.';
}
