import * as vscode from 'vscode';
import { GitLabApiError } from './api/gitLabClient';
import type { GitLabGroup, GitLabIssue } from './api/types';
import { GitLabSession } from './connection/session';
import { IssuePanels } from './issues/issuePanel';
import { WorkspacePanel } from './workspace/workspacePanel';
import { NavigationViews, type RepositoryNode, type WorkNode } from './navigationViews';
import { GitRepositoryService } from './git/gitRepositoryService';
import { OperationLog } from './logging/operationLog';
import { NotificationCenter } from './notifications/notificationCenter';
import { randomUUID } from 'node:crypto';
import { OperationTracker, operationLabels } from './workspace/operations';
import { OperationReceiptFileStore } from './workspace/operationReceiptStore';

let activeOperations: OperationTracker | undefined;
let shutdownCodex: (() => Promise<void>) | undefined;

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
  const gitRepositories = new GitRepositoryService(context.extensionUri, context.globalStorageUri, session, notifications);
  let navigation: NavigationViews | undefined;
  const workspacePanel = new WorkspacePanel(context, session, issuePanels, () => navigation?.refresh(), gitRepositories, notifications, operations);
  navigation = new NavigationViews(gitRepositories, workspacePanel, error => notifications.publish({ level: 'error', title: '側欄資料', message: readableError(error), origin: workspacePanel?.getNotificationOrigin() }));
  shutdownCodex = () => workspacePanel!.shutdownCodex();
  gitRepositories.setGitLabProjects(() => workspacePanel?.getGitLabProjects() ?? []);

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
      if (!metadata.repositoryId && ['openRepository', 'openGitMode'].includes(action)) {
        const value = args[0];
        metadata.repositoryId = typeof value === 'string' ? value : value && typeof value === 'object' && 'kind' in value && value.kind === 'repository' ? (value as RepositoryNode & { kind: 'repository' }).repository.id : undefined;
      }
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
  context.subscriptions.push(gitRepositories, navigation, issuePanels, workspacePanel);

  context.subscriptions.push(
    registerLoggedCommand('gitlabWorkspace.openWorkspace', () => getWorkspace().navigateTo()),
    registerLoggedCommand('gitlabWorkspace.openNotifications', () => getWorkspace().openNotifications()),
    registerLoggedCommand('gitlabWorkspace.openSettings', () => getWorkspace().openConfiguration()),
    registerLoggedCommand('gitlabWorkspace.openTools', () => getWorkspace().openSettings()),
    registerLoggedCommand('gitlabWorkspace.connect', async () => {
      try {
        await getWorkspace().connectFromSidebar();
        return true;
      } finally { navigation?.refresh(); }
    }),
    registerLoggedCommand('gitlabWorkspace.selectGroup', (group?: GitLabGroup) => getWorkspace().selectGroupFromSidebar(group)),
    registerLoggedCommand('gitlabWorkspace.refresh', async () => {
      try { await getWorkspace().refreshFromSidebar(); }
      finally { navigation?.refresh(); }
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
    registerLoggedCommand('gitlabWorkspace.openIssue', (item?: { issue?: GitLabIssue; scope?: string }) => getWorkspace().openIssueFromCommand(item?.issue, item?.scope)),
    registerLoggedCommand('gitlabWorkspace.openCloneMode', () => getWorkspace().navigateTo('clone')),
    registerLoggedCommand('gitlabWorkspace.openSaMode', () => getWorkspace().navigateTo('sa')),
    registerLoggedCommand('gitlabWorkspace.openBmadMode', () => getWorkspace().navigateTo('bmad')),
    registerLoggedCommand('gitlabWorkspace.openDeveloperMode', () => getWorkspace().navigateTo('developer')),
    registerLoggedCommand('gitlabWorkspace.openReviewerMode', () => getWorkspace().navigateTo('reviewer')),
    registerLoggedCommand('gitlabWorkspace.openGitMode', (repoId?: string) => getWorkspace().navigateTo('git', repoId)),
    registerLoggedCommand('gitlabWorkspace.openRepository', async (value?: string | RepositoryNode) => {
      const id = typeof value === 'string' ? value : value?.kind === 'repository' ? value.repository.id : await navigation?.findRepository();
      if (id) await getWorkspace().navigateTo('git', id);
    }),
    registerLoggedCommand('gitlabWorkspace.refreshRepositories', () => navigation?.refreshRepositories()),
    registerLoggedCommand('gitlabWorkspace.refreshMyWork', () => navigation?.refreshMyWork()),
    registerLoggedCommand('gitlabWorkspace.findRepositories', async () => {
      const id = await navigation?.findRepository(); if (id) await getWorkspace().navigateTo('git', id);
    }),
    registerLoggedCommand('gitlabWorkspace.findMyWork', async () => {
      const node = await navigation?.findWork();
      if (node?.kind === 'issue') await getWorkspace().openIssueFromCommand(node.issue, node.scope);
      else if (node?.kind === 'mergeRequest') await getWorkspace().openMergeRequestFromCommand(node.mergeRequest, node.scope);
    }),
    registerLoggedCommand('gitlabWorkspace.openMergeRequest', (node: WorkNode) => node?.kind === 'mergeRequest' ? getWorkspace().openMergeRequestFromCommand(node.mergeRequest, node.scope) : undefined),
    registerLoggedCommand('gitlabWorkspace.selectWorkflow', async () => {
      const choices = [
        ['工作台總覽', 'openWorkspace'], ['專案與批次操作', 'openCloneMode'], ['我的工作', 'openDeveloperMode'],
        ['待審查', 'openReviewerMode'], ['Skills 功能指引與分析', 'openSaMode'], ['BMAD 開發流程', 'openBmadMode'],
        ['Git 工作台', 'openGitMode'], ['工具與環境', 'openTools'], ['帳號與連線', 'manageAccounts'], ['設定', 'openSettings']
      ].map(([label, command]) => ({ label, command }));
      const selected = await vscode.window.showQuickPick(choices, { title: '切換工作流程', placeHolder: '選擇要開啟的工作流程' });
      if (selected) await vscode.commands.executeCommand('gitlabWorkspace.' + selected.command);
    })
  );
  if (testMode) return {
    getWorkspaceForTesting: () => getWorkspace(),
    getNavigationForTesting: () => navigation,
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
  await shutdownCodex?.(); shutdownCodex = undefined;
  await activeOperations?.flush(); activeOperations = undefined;
}

function readableError(error: unknown): string {
  if (error instanceof GitLabApiError) return error.message;
  if (error instanceof Error && error.message && !/token|authorization|private-token/i.test(error.message)) return error.message;
  return 'The GitLab operation could not be completed.';
}
