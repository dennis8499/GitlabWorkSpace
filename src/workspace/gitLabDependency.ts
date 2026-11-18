import type { GitAction } from '../git/gitProtocol';
import type { CodexCliSource } from '../codex/cliProtocol';

export function gitActionRemote(action: GitAction): string | undefined {
  if (action.type === 'fetch' || action.type === 'pull' || action.type === 'push') return action.remote;
  if (action.type === 'rebase' || action.type === 'rebasePreview') return action.pullSource?.remote;
  return undefined;
}
const remoteActions = new Set([
  'connect', 'addAccount', 'switchAccount', 'disconnect', 'logoutAccount', 'removeAccount', 'selectGroup',
  'clone', 'syncRepos', 'refreshMyWork', 'findMyWork', 'loadMoreMyWork', 'retryMyWorkSection',
  'openIssue', 'createIssue', 'selectIssue', 'selectProject', 'selectMergeRequest', 'openMergeRequest',
  'refreshMergeRequest', 'loadMergeRequestSection', 'openMergeRequestDiff', 'openRelatedMergeRequest',
  'postMergeRequestNote', 'replyMergeRequest', 'approveMergeRequest', 'mergeMergeRequest',
  'loadIssueGraph', 'selectIssueBoard', 'loadIssueRelations', 'mutateIssueRelations', 'issueRequest',
  'retryInstanceCheck', 'retryWorkspaceSection', 'ensureWorkspaceSection', 'loadDraftOptions',
  'checkSimilarIssues', 'createIssueDrafts', 'submitTimeEntry', 'reconcileMergeRequestWrite',
]);
export function actionUsesGitLab(request: { type: string; [key: string]: unknown }): boolean {
  const type = request.type === 'perform' ? String(request.action) : request.type;
  if (remoteActions.has(type)) return true;
  if (type === 'refresh') return request.mode === 'dashboard' || request.mode === 'developer' || request.mode === 'reviewer' || request.mode === 'clone' && request.projectSource !== 'local';
  return type === 'runCodexCli' && (request.source as CodexCliSource | undefined)?.kind === 'merge-request';
}
