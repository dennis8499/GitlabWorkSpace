import type { ActionAvailability } from '../api/actionAvailability';

export interface WorkspaceCapabilities {
  isVirtualWorkspace: boolean;
  localProjectOperations: ActionAvailability;
}

export const VIRTUAL_WORKSPACE_REASON = '此工作區僅提供雲端檔案；本機 Repo、Git、Clone／同步、Skills、審查與 Codex 需要磁碟上的專案資料夾。請先 Clone 並開啟本機資料夾。';

/** Empty windows retain existing behavior; mixed workspaces use only file folders. */
export function getWorkspaceCapabilities(folders: readonly { uri: { scheme: string } }[] = []): WorkspaceCapabilities {
  const isVirtualWorkspace = folders.length > 0 && folders.every(folder => folder.uri.scheme !== 'file');
  return { isVirtualWorkspace, localProjectOperations: isVirtualWorkspace
    ? { status: 'denied', reason: VIRTUAL_WORKSPACE_REASON } : { status: 'allowed' } };
}

// This is a filesystem capability, independent of read/write classification and
// operation scopes. Clipboard, logs, navigation and remote writes remain usable.
const localProjectActions = new Set([
  'scanRepositories', 'repositoryDetails', 'refreshRepositories', 'clone', 'syncRepos',
  'selectProjectFolder', 'selectProjectRoot', 'resetProjectRoot', 'selectCloneRoot', 'resetCloneRoot',
  'selectWorkflowKitInstallRoot', 'resetWorkflowKitInstallRoot', 'openLocalWorkspace',
  'gitReady', 'gitOpenRepository', 'gitOpenFile', 'gitOpenDiff', 'gitOpenMergeEditor', 'gitAction',
  'refreshWorkflowKit', 'checkWorkflowKitReleases', 'setWorkflowKitSource', 'installWorkflowKit',
  'prepareCommitReview', 'loadSkillBranches', 'copySkillGuidePrompt', 'openBranchReview', 'loadReviewerCapabilities',
  'loadReviewSessions', 'cancelReviewSession', 'copyReviewRefresh', 'copyReviewResume', 'openReviewReport',
  'refreshBmad', 'copyBmadCommand', 'openBmadTerminal', 'openBmadArtifact',
  'startCodexTask', 'listCodexTasks', 'codexHistory', 'sendCodexMessage', 'cancelCodexTask',
  'showCodexTask', 'readCodexResult', 'openCodexOrigin', 'openCodexChanges', 'previewProjectWiki', 'cancelProjectWikiPreview', 'publishProjectWiki', 'publishCodexReview',
  'resumeCodexTask', 'pauseCodexTask', 'deleteCodexTask', 'setCodexAutoAccept', 'answerCodex', 'checkCodex', 'configureCodex'
]);

export function requiresLocalProject(request: { type: string; [key: string]: unknown }): boolean {
  if (request.type === 'perform') return request.action === 'openRepository';
  if (request.type === 'refresh') return ['sa', 'bmad', 'git', 'codex'].includes(String(request.mode)) ||
    request.mode === 'clone' && request.projectSource === 'local';
  return localProjectActions.has(request.type);
}

export function assertWorkspaceAction(capabilities: WorkspaceCapabilities, request: { type: string; [key: string]: unknown }): void {
  if (capabilities.localProjectOperations.status !== 'allowed' && requiresLocalProject(request)) {
    throw new Error(capabilities.localProjectOperations.reason ?? VIRTUAL_WORKSPACE_REASON);
  }
}
