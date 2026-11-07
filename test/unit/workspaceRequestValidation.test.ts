import assert from 'node:assert/strict';
import test from 'node:test';
import { isWorkspaceRequest, parseWorkspaceRequest } from '../../src/workspace/workspaceRequestValidation';
import type { WorkspaceRequest } from '../../src/workspace/workspaceProtocol';

const repo = 'a'.repeat(32), sha = 'b'.repeat(40);
const issue = { projectId: 1, issueIid: 2 }, mr = { projectId: 1, iid: 2 };
const review = { revision: 'root:1', requestId: 'review-1', tool: 'merge-reviewer' as const };
/** Public UI contract examples, independent of validator implementation. */
const requests = {
  codexCommand: { type: 'codexCommand', command: { action: 'reconcile', taskId: 'task-1' } },
  showCodexTask: { type: 'showCodexTask', taskId: 'task-1' }, readCodexResult: { type: 'readCodexResult', taskId: 'task-1' },
  openCodexOrigin: { type: 'openCodexOrigin', taskId: 'task-1' }, openCodexChanges: { type: 'openCodexChanges', taskId: 'task-1' },
  previewProjectWiki: { type: 'previewProjectWiki', taskId: 'task-1' }, publishProjectWiki: { type: 'publishProjectWiki', taskId: 'task-1', revision: 'revision-1' },
  cancelProjectWikiPreview: { type: 'cancelProjectWikiPreview', taskId: 'task-1' },
  publishCodexReview: { type: 'publishCodexReview', taskId: 'task-1', body: 'Review summary' },
  startCodexTask: { type: 'startCodexTask', source: { kind: 'skill', featureId: 'query', inputs: { question: 'Explain' }, revision: 'root:1' } },
  listCodexTasks: { type: 'listCodexTasks' }, codexHistory: { type: 'codexHistory', taskId: 'task-1' },
  sendCodexMessage: { type: 'sendCodexMessage', taskId: 'task-1', text: 'Continue' }, cancelCodexTask: { type: 'cancelCodexTask', taskId: 'task-1' },
  pauseCodexTask: { type: 'pauseCodexTask', taskId: 'task-1' }, deleteCodexTask: { type: 'deleteCodexTask', taskId: 'task-1' },
  setCodexAutoAccept: { type: 'setCodexAutoAccept', taskId: 'task-1', enabled: true },
  resumeCodexTask: { type: 'resumeCodexTask', taskId: 'task-1' }, answerCodex: { type: 'answerCodex', taskId: 'task-1', interactionId: 'approval-1', answer: { decision: 'accept', content: { files: ['a.ts'], limit: 2 } } },
  checkCodex: { type: 'checkCodex' }, configureCodex: { type: 'configureCodex', action: 'executable' },
  ready: { type: 'ready', developerView: 'list', projectSource: 'local' }, reconcileOperations: { type: 'reconcileOperations', pendingIds: ['operation-1'] },
  confirmOperationResult: { type: 'confirmOperationResult', targetOperationId: 'operation-1' }, refresh: { type: 'refresh', mode: 'developer' },
  retryInstanceCheck: { type: 'retryInstanceCheck' }, setMode: { type: 'setMode', mode: 'clone' },
  setMergeRequestFilter: { type: 'setMergeRequestFilter', filter: 'reviewer', connectedScope: 'scope:1' }, setProjectSource: { type: 'setProjectSource', source: 'local' },
  issueRequest: { type: 'issueRequest', request: { type: 'create', projectId: 1, input: { title: 'New Issue', labels: ['bug'] } }, revision: 1 }, closeIssue: { type: 'closeIssue' },
  connect: { type: 'connect' }, openAccountManager: { type: 'openAccountManager' },
  openConfiguration: { type: 'openConfiguration', setting: 'gitlabWorkspace.projectRoot' },
  disconnect: { type: 'disconnect' }, addAccount: { type: 'addAccount' }, switchAccount: { type: 'switchAccount', accountId: 'account-1' }, removeAccount: { type: 'removeAccount', accountId: 'account-1' },
  openLogs: { type: 'openLogs' }, scanRepositories: { type: 'scanRepositories', resume: true }, cancelRepositoryScan: { type: 'cancelRepositoryScan' },
  cancelRepositoryOperation: { type: 'cancelRepositoryOperation' }, resyncWorkspace: { type: 'resyncWorkspace' }, selectGroup: { type: 'selectGroup', groupId: 1 },
  selectIssueBoard: { type: 'selectIssueBoard', boardId: 1, connectedScope: 'scope:1' }, loadIssueGraph: { type: 'loadIssueGraph', connectedScope: 'scope:1', nodeIds: ['project:1:issue:2'] },
  setIssueGraphVisibility: { type: 'setIssueGraphVisibility', visible: true, connectedScope: 'scope:1' },
  retryWorkspaceSection: { type: 'retryWorkspaceSection', section: 'issues', connectedScope: 'scope:1', mode: 'next' }, ensureWorkspaceSection: { type: 'ensureWorkspaceSection', section: 'boards', connectedScope: 'scope:1' },
  loadIssueRelations: { type: 'loadIssueRelations', requestId: 'relations-1', connectedScope: 'scope:1', ...issue },
  mutateIssueRelations: { type: 'mutateIssueRelations', requestId: 'relations-1', connectedScope: 'scope:1', ...issue, action: { type: 'link', targetProjectId: 2, targetIssueIid: 3, linkType: 'blocks' } },
  openLocalWorkspace: { type: 'openLocalWorkspace' }, selectProjectFolder: { type: 'selectProjectFolder', folderUri: 'file:///workspace' },
  selectProjectRoot: { type: 'selectProjectRoot' }, resetProjectRoot: { type: 'resetProjectRoot' }, selectCloneRoot: { type: 'selectCloneRoot' }, resetCloneRoot: { type: 'resetCloneRoot' },
  refreshBmad: { type: 'refreshBmad' }, copyBmadCommand: { type: 'copyBmadCommand', revision: 'root:1', command: 'task', requirement: 'Build' },
  openBmadTerminal: { type: 'openBmadTerminal', revision: 'root:1' }, openBmadArtifact: { type: 'openBmadArtifact', revision: 'root:1', stepId: 'build', path: 'C:/workspace/story.md' },
  clone: { type: 'clone', projectIds: [1, 2] }, cloneSelection: { type: 'cloneSelection', requestId: 'clone-1', projectIds: [1] }, syncRepos: { type: 'syncRepos', projectIds: [1] },
  selectProject: { type: 'selectProject', projectId: 1 }, selectIssue: { type: 'selectIssue', ...issue }, openIssue: { type: 'openIssue', ...issue, tab: 'time' }, createIssue: { type: 'createIssue' },
  copy: { type: 'copy', text: 'Text' }, importIssueDrafts: { type: 'importIssueDrafts', json: '{}' }, createIssueDrafts: { type: 'createIssueDrafts', analysisId: 'analysis-1', drafts: [], options: {} },
  loadDraftOptions: { type: 'loadDraftOptions', projectId: 1 }, checkSimilarIssues: { type: 'checkSimilarIssues', drafts: [] }, openExternal: { type: 'openExternal', url: 'https://gitlab.example.test' },
  startTimer: { type: 'startTimer', ...issue }, pauseTimer: { type: 'pauseTimer', id: 'timer-1' }, resumeTimer: { type: 'resumeTimer', id: 'timer-1' }, stopTimer: { type: 'stopTimer', id: 'timer-1' },
  addManualTime: { type: 'addManualTime', ...issue, duration: '10m', summary: 'Review' }, updateTimeEntry: { type: 'updateTimeEntry', id: 'timer-1', duration: '20m', summary: 'Review', spentAt: '2026-11-05' },
  submitTimeEntry: { type: 'submitTimeEntry', id: 'timer-1' }, acknowledgeTimeEntry: { type: 'acknowledgeTimeEntry', id: 'timer-1' },
  selectMergeRequest: { type: 'selectMergeRequest', ...mr }, refreshMergeRequest: { type: 'refreshMergeRequest', ...mr }, reconcileMergeRequestWrite: { type: 'reconcileMergeRequestWrite', ...mr },
  loadMergeRequestSection: { type: 'loadMergeRequestSection', ...mr, section: 'diffs' }, postMergeRequestNote: { type: 'postMergeRequestNote', ...mr, body: 'Review' }, openBranchReview: { type: 'openBranchReview', ...mr },
  prepareCommitReview: { type: 'prepareCommitReview', mode: 'commit', revision: 'root:1', repo: 'C:/workspace' },
  loadSkillBranches: { type: 'loadSkillBranches', repo: 'C:/workspace', revision: 'root:1', requestId: 'branches-1' }, loadReviewerCapabilities: { type: 'loadReviewerCapabilities', ...review },
  loadReviewSessions: { type: 'loadReviewSessions', revision: 'root:1', tool: 'merge-reviewer' }, cancelReviewSession: { type: 'cancelReviewSession', ...review },
  copyReviewRefresh: { type: 'copyReviewRefresh', ...review }, copyReviewResume: { type: 'copyReviewResume', ...review }, openReviewReport: { type: 'openReviewReport', ...review },
  replyMergeRequest: { type: 'replyMergeRequest', ...mr, discussionId: 'discussion-1', body: 'Reply' }, approveMergeRequest: { type: 'approveMergeRequest', ...mr, sha }, mergeMergeRequest: { type: 'mergeMergeRequest', ...mr, sha },
  setWorkflowKitSource: { type: 'setWorkflowKitSource', source: 'github' }, openWorkflowKitDownload: { type: 'openWorkflowKitDownload', source: 'gitea' }, refreshWorkflowKit: { type: 'refreshWorkflowKit' },
  checkWorkflowKitReleases: { type: 'checkWorkflowKitReleases', source: 'github' }, copySkillGuidePrompt: { type: 'copySkillGuidePrompt', featureId: 'query', inputs: { question: 'Explain' }, revision: 'root:1' },
  openWorkspaceFolder: { type: 'openWorkspaceFolder' }, selectWorkflowKitInstallRoot: { type: 'selectWorkflowKitInstallRoot' }, resetWorkflowKitInstallRoot: { type: 'resetWorkflowKitInstallRoot' }, installWorkflowKit: { type: 'installWorkflowKit', releaseId: 'github-1.0.0' },
  publishNotification: { type: 'publishNotification', level: 'info', message: 'Complete' }, markNotificationsRead: { type: 'markNotificationsRead', ids: ['notice-1'], revision: 1 },
  markAllNotificationsRead: { type: 'markAllNotificationsRead', revision: 1 }, removeNotification: { type: 'removeNotification', id: 'notice-1' }, clearNotifications: { type: 'clearNotifications', revision: 1 },
  gitReady: { type: 'gitReady' }, gitAcknowledgeResult: { type: 'gitAcknowledgeResult', requestId: 'git-1' }, gitOpenRepository: { type: 'gitOpenRepository', path: 'C:/workspace' },
  gitOpenMergeEditor: { type: 'gitOpenMergeEditor', repositoryId: repo, path: 'src/a.ts' }, gitOpenFile: { type: 'gitOpenFile', repositoryId: repo, path: 'src/a.ts' },
  gitOpenDiff: { type: 'gitOpenDiff', repositoryId: repo, path: 'src/a.ts', staged: false }, gitAction: { type: 'gitAction', requestId: 'git-1', repoId: repo, action: { type: 'open', repoId: repo } }
} satisfies { [Type in WorkspaceRequest['type']]: Extract<WorkspaceRequest, { type: Type }> };

for (const request of Object.values(requests)) test(`workspace message ${request.type} accepts its public contract and rejects extra fields`, () => {
  assert.equal(isWorkspaceRequest(request), true);
  assert.equal(isWorkspaceRequest({ ...request, operationId: 'ui-1', operationScope: 'scope:1', hostSessionId: 'host-1', scopeEpoch: 1, projectRevision: 'root:1' }), true);
  assert.equal(isWorkspaceRequest({ ...request, execute: 'arbitrary command' }), false);
  assert.equal(isWorkspaceRequest({ ...request, operationId: {} }), false);
  assert.equal(isWorkspaceRequest({ ...request, scopeEpoch: -1 }), false);
});

test('malformed identities, bodies, nested actions and prototype keys fail closed', () => {
  const invalid = [null, [], 'copy', {}, { type: 'arbitrary' }, { type: 'submitAccountLogin', token: 'forbidden-webview-secret' }, { type: 'openConfiguration', setting: 'arbitrary.setting' }, { type: 'copy', text: {} }, { type: 'selectProject', projectId: {} },
    { type: 'selectProject', projectId: Number.MAX_SAFE_INTEGER + 1 }, { type: 'selectProject', projectId: -1 },
    { type: 'sendCodexMessage', taskId: 'task-1', text: 'a'.repeat(32001) }, { type: 'clone', projectIds: new Array(10001).fill(1) },
    { type: 'codexHistory', taskId: 'task-1', force: 'true' }, { type: 'previewProjectWiki', taskId: 'task-1', cursor: 'x'.repeat(161) },
    { type: 'issueRequest', request: { type: 'invoke', issueId: 1, action: 'delete', payload: { shell: 'rm' } } },
    { type: 'issueRequest', request: { type: 'create', projectId: 1, input: { title: 'Title', admin: true } } },
    { type: 'gitAction', requestId: 'g', repoId: repo, action: { type: 'discard', path: '../outside' } },
    { type: 'gitAction', requestId: 'g', repoId: repo, action: { type: 'open', repoId: repo, shell: 'anything' } },
    { type: 'answerCodex', taskId: 't', interactionId: 'i', answer: { decision: 'always' } },
    { type: 'copySkillGuidePrompt', featureId: 'query', revision: 'r', inputs: JSON.parse('{"__proto__":"bad"}') }];
  for (const request of invalid) { assert.equal(isWorkspaceRequest(request), false); assert.throws(() => parseWorkspaceRequest(request), /訊息格式無效/); }
});

test('nested legitimate Issue actions, Git rebase and MCP forms retain their contract', () => {
  for (const request of [
    { type: 'codexHistory', taskId: 'task-1', force: true }, { type: 'previewProjectWiki', taskId: 'task-1', cursor: 'batch-1' },
    { type: 'issueRequest', request: { type: 'invoke', issueId: 1, action: 'note', payload: { body: 'Hello', internal: false } } },
    { type: 'issueRequest', request: { type: 'update', issueId: 1, input: { assigneeId: null, milestoneId: null, dueDate: null } } },
    { type: 'gitAction', requestId: 'g', repoId: repo, action: { type: 'rebase', ref: 'main', interactive: true, expectedTargetHash: sha, todo: [{ hash: sha, action: 'pick' }] } },
    { type: 'startCodexTask', source: { kind: 'bmad', request: { revision: 'r', command: 'skill', skill: 'bmad-build' } } },
    { type: 'startCodexTask', source: { kind: 'review', action: 'resume', ...review } }
  ]) assert.equal(isWorkspaceRequest(request), true, JSON.stringify(request));
});
