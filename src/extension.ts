import * as vscode from 'vscode';
import { GitLabApiError } from './api/gitLabClient';
import type { GitLabGroup, GitLabIssue } from './api/types';
import { GitLabSession } from './connection/session';
import { IssuePanels } from './issues/issuePanel';
import { WorkspacePanel } from './workspace/workspacePanel';
import { QuickActionsViewProvider, type QuickAction } from './quickActionsView';
import { GitRepositoryService } from './git/gitRepositoryService';
import { OperationLog } from './logging/operationLog';
import { NotificationCenter } from './notifications/notificationCenter';
import { randomUUID } from 'node:crypto';
import { OperationTracker, operationLabels } from './workspace/operations';
import { OperationReceiptFileStore } from './workspace/operationReceiptStore';

const QUICK_ACTION_COMMANDS: Record<QuickAction, string> = {
  openWorkspace: 'gitlabWorkspace.openWorkspace',
  openMyWork: 'gitlabWorkspace.openDeveloperMode',
  openProjects: 'gitlabWorkspace.openCloneMode',
  openAnalysis: 'gitlabWorkspace.openSaMode',
  openBmad: 'gitlabWorkspace.openBmadMode',
  openReviewer: 'gitlabWorkspace.openReviewerMode',
  openGit: 'gitlabWorkspace.openGitMode',
  openAdmin: 'gitlabWorkspace.openAdmin',
  openNotifications: 'gitlabWorkspace.openNotifications',
  addAccount: 'gitlabWorkspace.addAccount',
  manageAccounts: 'gitlabWorkspace.manageAccounts',
  switchAccount: 'gitlabWorkspace.switchAccount',
  logoutAccount: 'gitlabWorkspace.disconnect',
  removeAccount: 'gitlabWorkspace.removeAccount',
  openRepository: 'gitlabWorkspace.openGitMode'
};
let activeOperations: OperationTracker | undefined;

export async function activate(context: vscode.ExtensionContext): Promise<unknown> {
  const testMode = context.extensionMode === vscode.ExtensionMode.Test;
  const notifications = new NotificationCenter();
  const operations = new OperationTracker(operation => notifications.recordOperation(operation), {
    store: new OperationReceiptFileStore(vscode.Uri.joinPath(context.globalStorageUri, 'operation-receipts').fsPath),
    historyLimit: 1000,
    onStoreError: () => notifications.publish({ level: 'warn', title: '操作紀錄', message: '操作收據尚未保存，已保留於目前工作階段；請先核對結果再重試。' })
  });
  try { await operations.initialize(); }
  catch { notifications.publish({ level: 'warn', title: '操作紀錄', message: '操作收據儲存空間無法使用；讀取功能仍可使用，寫入前須先核對歷史操作。' }); }
  activeOperations = operations;
  const logChannel = vscode.window.createOutputChannel('GitLab Workspace', { log: true });
  const log = new OperationLog(logChannel);
  notifications.setSanitizer(message => log.sanitize(message));
  const session = new GitLabSession(context.secrets, context.globalState, testMode, context.workspaceState, log);
  log.setContextSource(() => ({ accountId: session.activeAccountId, baseUrl: session.baseUrl, groupId: session.selectedGroup?.id }));
  context.subscriptions.push({ dispose: () => { log.dispose(); logChannel.dispose(); } }, notifications, operations);
  try { await session.initialize({ allowNetwork: false }); } catch { notifications.publish({ level: 'warn', message: '既有 GitLab 帳號尚未完成遷移；設定與 Token 已保留，連線時會重試。' }); }
  log.record({ feature: 'workspace', action: 'activate', result: 'success' });
  let refreshWorkspaceAfterIssueChange = (): void => undefined;
  const issuePanels = new IssuePanels(context, session, () => refreshWorkspaceAfterIssueChange(), operations);
  let workspacePanel: WorkspacePanel | undefined;
  const gitRepositories = new GitRepositoryService(context.extensionUri, context.globalStorageUri, session, notifications);
  const quickActions = new QuickActionsViewProvider(context.extensionUri, session, (action, repositoryId, metadata) =>
    vscode.commands.executeCommand(
      QUICK_ACTION_COMMANDS[action],
      action === 'openRepository' ? repositoryId : undefined,
      { ...metadata, action, repositoryId, workspaceActionMetadata: true }
    ),
    async () => {
      const state = gitRepositories.getCachedSummaryState();
      return {
        ...workspacePanel?.getAccountUiState(),
        activeMode: workspacePanel?.getActiveMode() ?? 'developer',
        selectedRepositoryId: workspacePanel?.getSelectedGitRepositoryId(),
        repositories: state.repositories,
        gitAvailable: state.available,
        gitMessage: state.message
      };
    },
    repositoryId => gitRepositories.getRepositoryDetails(repositoryId), notifications, operations,
    () => workspacePanel?.getOperationScope() ?? `offline:none:${session.connectionEpoch}`,
    () => workspacePanel?.getNotificationOrigin() ?? { accountId: session.activeAccountId, baseUrl: session.baseUrl, groupId: session.selectedGroup?.id },
    () => gitRepositories.refresh(),
    () => workspacePanel?.getLocalOperationScope() ?? `local:none:${session.connectionEpoch}`
  );
  workspacePanel = new WorkspacePanel(context, session, issuePanels, () => quickActions.refresh(), gitRepositories, notifications, operations);
  gitRepositories.setGitLabProjects(() => workspacePanel?.getGitLabProjects() ?? []);
  context.subscriptions.push(gitRepositories.onDidChangeRepositories(() => quickActions.refresh()));
  refreshWorkspaceAfterIssueChange = () => {
    const refresh = workspacePanel?.refreshAfterIssueChange();
    if (refresh) void refresh.catch((error: unknown) => notifications.publish({ level: 'error', title: '更新 Issue', message: readableError(error), origin: workspacePanel?.getNotificationOrigin() }));
  };

  const getWorkspace = (): WorkspacePanel => {
    if (!workspacePanel) throw new Error('The GitLab Workspace is not available.');
    return workspacePanel;
  };

  const registerLoggedCommand: typeof vscode.commands.registerCommand = (command, callback, thisArg) =>
    vscode.commands.registerCommand(command, (...args: unknown[]) => {
      const action = command.replace('gitlabWorkspace.', '');
      const candidate = args.at(-1);
      const metadata = candidate && typeof candidate === 'object' && 'workspaceActionMetadata' in candidate
        ? args.pop() as { operationId?: string; operationScope?: string; hostSessionId?: string; scopeEpoch?: number; action?: string; repositoryId?: string } : {};
      const operationId = metadata.operationId ?? randomUUID();
      const aliases: Record<string, string> = {
        openCloneMode: 'openProjects', openSaMode: 'openAnalysis', openBmadMode: 'openBmad', openDeveloperMode: 'openMyWork',
        openReviewerMode: 'openReviewer', openGitMode: 'openGit', openRepository: 'openRepository',
        cloneRepositories: 'clone', cloneAllRepositories: 'clone', cloneSelectedRepositories: 'clone', syncLocalDefaultBranches: 'syncRepos'
      };
      const task = () => getWorkspace().runCommandAction(metadata.action ?? aliases[action] ?? action, () => Promise.resolve(callback.apply(thisArg, args)), { ...metadata, operationId });
      return notifications.runCommand({ operationId, title: operationLabels[aliases[action] ?? action] ?? 'GitLab Workspace',
        origin: workspacePanel?.getNotificationOrigin() }, task, false);
    });
  context.subscriptions.push(gitRepositories, quickActions, issuePanels, workspacePanel);
  context.subscriptions.push(vscode.window.registerWebviewViewProvider('gitlabWorkspace.quickActions', quickActions));
  context.subscriptions.push(
    registerLoggedCommand('gitlabWorkspace.openWorkspace', () => getWorkspace().navigateTo()),
    registerLoggedCommand('gitlabWorkspace.openNotifications', () => getWorkspace().openNotifications()),
    registerLoggedCommand('gitlabWorkspace.connect', async () => {
      try {
        await getWorkspace().connectFromSidebar();
        return true;
      } finally { quickActions.refresh(); }
    }),
    registerLoggedCommand('gitlabWorkspace.selectGroup', (group?: GitLabGroup) => getWorkspace().selectGroupFromSidebar(group)),
    registerLoggedCommand('gitlabWorkspace.refresh', async () => {
      try { await getWorkspace().refreshFromSidebar(); }
      finally { quickActions.refresh(); }
    }),
    registerLoggedCommand('gitlabWorkspace.disconnect', () => getWorkspace().disconnectFromSidebar()),
    registerLoggedCommand('gitlabWorkspace.addAccount', (id?: string) => getWorkspace().accountFromSidebar('addAccount', id)),
    registerLoggedCommand('gitlabWorkspace.manageAccounts', () => getWorkspace().openAccountManager()),
    registerLoggedCommand('gitlabWorkspace.switchAccount', (id?: string) => getWorkspace().accountFromSidebar('switchAccount', id)),
    registerLoggedCommand('gitlabWorkspace.removeAccount', (id?: string) => getWorkspace().accountFromSidebar('removeAccount', id)),
    vscode.commands.registerCommand('gitlabWorkspace.showLogs', () => logChannel.show(false)),
    vscode.commands.registerCommand('gitlabWorkspace.openAdmin', () => logChannel.show(false)),
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
    registerLoggedCommand('gitlabWorkspace.openBmadMode', () => getWorkspace().navigateTo('bmad')),
    registerLoggedCommand('gitlabWorkspace.openDeveloperMode', () => getWorkspace().navigateTo('developer')),
    registerLoggedCommand('gitlabWorkspace.openReviewerMode', () => getWorkspace().navigateTo('reviewer')),
    registerLoggedCommand('gitlabWorkspace.openGitMode', (repoId?: string) => getWorkspace().navigateTo('git', repoId)),
    registerLoggedCommand('gitlabWorkspace.openRepository', (repoId?: string) => getWorkspace().navigateTo('git', repoId))
  );
  if (testMode) return {
    session,
    getNotificationsForTesting: () => notifications.snapshot(),
    setFetchForTesting: (fetcher: typeof fetch) => session.setFetchForTesting(fetcher),
    getGitRepositoryState: () => gitRepositories.getSummaryState(),
    getGitRepositoryDetails: (repositoryId: string) => gitRepositories.getRepositoryDetails(repositoryId),
    openNativeGitDiffForTesting: (repositoryId: string, filename: string, staged = false) => gitRepositories.openNativeDiff(repositoryId, filename, staged),
    getRepositoryInventoryForTesting: () => gitRepositories.getInventory(),
    scanWorkspaceForTesting: (signal: AbortSignal, onProgress: (state: import('./git/repositoryScanProtocol').RepositoryScanState) => void) =>
      gitRepositories.scanWorkspace(signal, onProgress),
    getLogFileUriForTesting: () => vscode.Uri.joinPath(context.logUri, 'GitLab Workspace.log'),
    getLogOutputForTesting: () => logChannel,
    getGitCommandCountForTesting: () => gitRepositories.getCommandCountForTesting(),
    getGitActivityForTesting: () => gitRepositories.getActivityForTesting(),
    getWebviewMessageCountsForTesting: () => getWorkspace().getWebviewMessageCountsForTesting(),
    setGitWarningPromptHandlerForTesting: (handler: (message: string, options: vscode.MessageOptions, ...items: string[]) => Thenable<string | undefined>) =>
      gitRepositories.setWarningPromptHandlerForTesting(handler),
    setGitActionTraceHandlerForTesting: (handler: (event: { phase: 'start' | 'complete' | 'error'; repositoryId: string; action: string; error?: string }) => void) =>
      gitRepositories.setActionTraceHandlerForTesting(handler)
  };
}

export async function deactivate(): Promise<void> {
  await activeOperations?.flush(); activeOperations = undefined;
}

function readableError(error: unknown): string {
  if (error instanceof GitLabApiError) return error.message;
  if (error instanceof Error && error.message && !/token|authorization|private-token/i.test(error.message)) return error.message;
  return 'The GitLab operation could not be completed.';
}
