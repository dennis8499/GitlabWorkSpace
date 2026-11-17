import type { GitAction } from '../git/gitProtocol';
import type { CodexTaskSource, CodexTaskSpec } from '../codex/protocol';

/** Storage/lock scope and read/write classification do not confer GitLab authority. */
export function sourceUsesGitLab(source?: CodexTaskSource): boolean {
  return !!source && (!!source.expectedScope || ['issue', 'merge-request', 'project-wiki'].includes(source.kind));
}
export function taskUsesGitLab(spec: Pick<CodexTaskSpec, 'source' | 'origin'>): boolean {
  return !!spec.origin || sourceUsesGitLab(spec.source);
}
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
  'publishProjectWiki', 'publishCodexReview', 'previewProjectWiki', 'openBranchReview', 'openCodexOrigin'
]);
const remoteCommands = new Set(['confirm-delivery', 'retry-delivery', 'publish-group-issues', 'handoff', 'handoff-review',
  'regenerate-wiki', 'mr-fix', 'reply']);
export function actionUsesGitLab(request: { type: string; [key: string]: unknown }, spec?: Pick<CodexTaskSpec, 'source' | 'origin'>): boolean {
  const type = request.type === 'perform' ? String(request.action) : request.type;
  if (['readCodexResult', 'showCodexTask', 'openProjectWikiDocument'].includes(type)) return false;
  if (remoteActions.has(type)) return true;
  if (type === 'refresh') return request.mode === 'dashboard' || request.mode === 'developer' || request.mode === 'reviewer' || request.mode === 'clone' && request.projectSource !== 'local';
  if (type === 'prepareCommitReview') return typeof request.repo !== 'string';
  if (type === 'codexCommand') {
    const command = request.command as { action?: string } | undefined;
    if (command?.action && ['export-result', 'copy-handoff', 'open-artifact', 'new-from-result', 'restore-result'].includes(command.action)) return false;
    if (command?.action && remoteCommands.has(command.action)) return true;
  }
  if (request.source && sourceUsesGitLab(request.source as CodexTaskSource)) return true;
  return !!spec && taskUsesGitLab(spec);
}
