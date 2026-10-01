import * as vscode from 'vscode';
import { GitLabApiError } from './api/gitLabClient';
import type { GitLabGroup, GitLabIssue } from './api/types';
import { GitLabSession } from './connection/session';
import { IssuePanels } from './issues/issuePanel';
import { WorkspacePanel } from './workspace/workspacePanel';
import { QuickActionsViewProvider, type QuickAction } from './quickActionsView';

const QUICK_ACTION_COMMANDS: Record<QuickAction, string> = {
  openWorkspace: 'gitlabWorkspace.openWorkspace',
  openMyWork: 'gitlabWorkspace.openDeveloperMode',
  openProjects: 'gitlabWorkspace.openCloneMode'
};

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const session = new GitLabSession(context.secrets, context.globalState);
  let refreshWorkspaceAfterIssueChange = (): void => undefined;
  const issuePanels = new IssuePanels(context, session, () => refreshWorkspaceAfterIssueChange());
  let workspacePanel: WorkspacePanel | undefined;
  const quickActions = new QuickActionsViewProvider(context.extensionUri, session, (action) =>
    vscode.commands.executeCommand(QUICK_ACTION_COMMANDS[action])
  );
  workspacePanel = new WorkspacePanel(context, session, issuePanels, () => quickActions.refresh());
  refreshWorkspaceAfterIssueChange = () => {
    const refresh = workspacePanel?.refreshFromSidebar();
    if (refresh) void refresh.catch((error: unknown) => vscode.window.showErrorMessage(error instanceof Error ? error.message : String(error)));
  };

  const getWorkspace = (): WorkspacePanel => {
    if (!workspacePanel) throw new Error('The GitLab Workspace is not available.');
    return workspacePanel;
  };

  context.subscriptions.push(quickActions, issuePanels, workspacePanel);
  context.subscriptions.push(vscode.window.registerWebviewViewProvider('gitlabWorkspace.quickActions', quickActions));
  context.subscriptions.push(
    vscode.commands.registerCommand('gitlabWorkspace.openWorkspace', () => getWorkspace().navigateTo()),
    vscode.commands.registerCommand('gitlabWorkspace.connect', async () => {
      try {
        await getWorkspace().connectFromSidebar();
        return true;
      } catch (error) {
        await vscode.window.showErrorMessage(readableError(error));
        return false;
      } finally { quickActions.refresh(); }
    }),
    vscode.commands.registerCommand('gitlabWorkspace.selectGroup', (group?: GitLabGroup) => getWorkspace().selectGroupFromSidebar(group)),
    vscode.commands.registerCommand('gitlabWorkspace.refresh', async () => {
      try { await getWorkspace().refreshFromSidebar(); }
      finally { quickActions.refresh(); }
    }),
    vscode.commands.registerCommand('gitlabWorkspace.disconnect', () => getWorkspace().disconnectFromSidebar()),
    vscode.commands.registerCommand('gitlabWorkspace.cloneRepositories', () => getWorkspace().cloneFromSidebar('pick')),
    vscode.commands.registerCommand('gitlabWorkspace.cloneAllRepositories', () => getWorkspace().cloneFromSidebar('all')),
    vscode.commands.registerCommand('gitlabWorkspace.cloneSelectedRepositories', () => getWorkspace().cloneFromSidebar('selected')),
    vscode.commands.registerCommand('gitlabWorkspace.syncLocalDefaultBranches', () => getWorkspace().syncFromSidebar()),
    vscode.commands.registerCommand('gitlabWorkspace.createIssue', () => issuePanels.showCreate()),
    vscode.commands.registerCommand('gitlabWorkspace.openIssue', async (item?: { issue?: GitLabIssue }) => {
      if (item?.issue) await issuePanels.showIssue(item.issue);
    }),
    vscode.commands.registerCommand('gitlabWorkspace.openCloneMode', () => getWorkspace().navigateTo('clone')),
    vscode.commands.registerCommand('gitlabWorkspace.openSaMode', () => getWorkspace().navigateTo('sa')),
    vscode.commands.registerCommand('gitlabWorkspace.openDeveloperMode', () => getWorkspace().navigateTo('developer')),
    vscode.commands.registerCommand('gitlabWorkspace.openReviewerMode', () => getWorkspace().navigateTo('reviewer'))
  );
}

export function deactivate(): void {}

function readableError(error: unknown): string {
  if (error instanceof GitLabApiError) return error.message;
  if (error instanceof Error && error.message && !/token|authorization|private-token/i.test(error.message)) return error.message;
  return 'The GitLab operation could not be completed.';
}
