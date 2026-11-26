import assert from 'node:assert/strict';
import test from 'node:test';
import { isWorkspaceRequest, parseWorkspaceRequest } from '../../src/workspace/workspaceRequestValidation';
import type { WorkspaceRequest } from '../../src/workspace/workspaceProtocol';

const repo = 'a'.repeat(32), sha = 'b'.repeat(40);
const issue = { projectId: 1, issueIid: 2 }, mr = { projectId: 1, iid: 2 };
const review = { revision: 'root:1', requestId: 'review-1', tool: 'merge-reviewer' as const };
/** Public UI contract examples, independent of validator implementation. */
const requests = {
  gitPickRepository: { type: 'gitPickRepository', requestId: 'repo-pick-1' },
  gitPickBranch: { type: 'gitPickBranch', repositoryId: repo, requestId: 'branch-pick-1' },
  gitPickRemote: { type: 'gitPickRemote', repositoryId: repo, requestId: 'remote-pick-1' },
  openMergeRequestDiff: { type: 'openMergeRequestDiff', ...mr, diffVersionId: 3, oldPath: 'before.ts', newPath: 'after.ts' },
  runCodexCli: { type: 'runCodexCli', source: { kind: 'skill', featureId: 'query', inputs: { 'query.question': 'Explain' }, revision: 'root:1' } },
  codexCliSettings: { type: 'codexCliSettings', action: 'check' },
  resetCodexCliRun: { type: 'resetCodexCliRun', runId: 'fixture-run' },
  showCodexCliTerminal: { type: 'showCodexCliTerminal', runId: 'fixture-run' },
  ready: { type: 'ready', developerView: 'list', projectSource: 'local' }, reconcileOperations: { type: 'reconcileOperations', pendingIds: ['operation-1'] },
  confirmOperationResult: { type: 'confirmOperationResult', targetOperationId: 'operation-1' }, refresh: { type: 'refresh', mode: 'developer' },
  retryInstanceCheck: { type: 'retryInstanceCheck' }, setMode: { type: 'setMode', mode: 'clone' },
  setMergeRequestFilter: { type: 'setMergeRequestFilter', filter: 'reviewer', connectedScope: 'scope:1' }, setProjectSource: { type: 'setProjectSource', source: 'local' },
  issueRequest: { type: 'issueRequest', request: { type: 'create', projectId: 1, input: { title: 'New Issue', labels: ['bug'] } }, revision: 1 }, closeIssue: { type: 'closeIssue' },
  connect: { type: 'connect' }, openAccountManager: { type: 'openAccountManager' },
  pickWorkbenchControl: { type: 'pickWorkbenchControl', kind: 'workflow' },
  openRelatedMergeRequest: { type: 'openRelatedMergeRequest', projectId: 1, issueIid: 2, iid: 3, mergeRequestProjectId: 4 },
  openNotificationTarget: { type: 'openNotificationTarget', id: 'notice-1', destination: 'origin' },
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
  copy: { type: 'copy', text: 'Text' }, importIssueDrafts: { type: 'importIssueDrafts', json: '{}' }, createIssueDrafts: { type: 'createIssueDrafts', analysisId: 'manual-drafts-1', drafts: [], options: {} },
  loadDraftOptions: { type: 'loadDraftOptions', projectId: 1 }, checkSimilarIssues: { type: 'checkSimilarIssues', drafts: [] }, openExternal: { type: 'openExternal', url: 'https://gitlab.example.test' },
  startTimer: { type: 'startTimer', ...issue }, pauseTimer: { type: 'pauseTimer', id: 'timer-1' }, resumeTimer: { type: 'resumeTimer', id: 'timer-1' }, stopTimer: { type: 'stopTimer', id: 'timer-1' },
  addManualTime: { type: 'addManualTime', ...issue, duration: '10m', summary: 'Review' }, updateTimeEntry: { type: 'updateTimeEntry', id: 'timer-1', duration: '20m', summary: 'Review', spentAt: '2026-11-05' },
  submitTimeEntry: { type: 'submitTimeEntry', id: 'timer-1' }, acknowledgeTimeEntry: { type: 'acknowledgeTimeEntry', id: 'timer-1' },
  selectMergeRequest: { type: 'selectMergeRequest', ...mr }, refreshMergeRequest: { type: 'refreshMergeRequest', ...mr }, reconcileMergeRequestWrite: { type: 'reconcileMergeRequestWrite', ...mr },
  loadMergeRequestSection: { type: 'loadMergeRequestSection', ...mr, section: 'diffs' }, postMergeRequestNote: { type: 'postMergeRequestNote', ...mr, body: 'Review' },
  loadSkillBranches: { type: 'loadSkillBranches', repo: 'C:/workspace', revision: 'root:1', requestId: 'branches-1' },
  pickSkillBranch: { type: 'pickSkillBranch', repo: 'C:/workspace', revision: 'root:1', requestId: 'branch-1', field: 'merge-repo.base' },
  loadReviewerCapabilities: { type: 'loadReviewerCapabilities', ...review },
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
    { type: 'clone', projectIds: new Array(10001).fill(1) },
    { type: 'issueRequest', request: { type: 'invoke', issueId: 1, action: 'delete', payload: { shell: 'rm' } } },
    { type: 'issueRequest', request: { type: 'create', projectId: 1, input: { title: 'Title', admin: true } } },
    { type: 'gitAction', requestId: 'g', repoId: repo, action: { type: 'discard', path: '../outside' } },
    { type: 'gitAction', requestId: 'g', repoId: repo, action: { type: 'open', repoId: repo, shell: 'anything' } },
    { type: 'copySkillGuidePrompt', featureId: 'query', revision: 'r', inputs: JSON.parse('{"__proto__":"bad"}') }];
  for (const request of invalid) { assert.equal(isWorkspaceRequest(request), false); assert.throws(() => parseWorkspaceRequest(request), /訊息格式無效/); }
});

test('Codex CLI accepts only the retained workflows and keeps Merge and Release Reviewer identities', () => {
  const request = { type: 'runCodexCli' };
  const sources = [
    { kind: 'skill', featureId: 'query', revision: 'r', inputs: { 'query.question': 'Explain' } },
    { kind: 'bmad', request: { revision: 'r', command: 'skill', skill: 'bmad-build' } },
    { kind: 'review', action: 'resume', ...review },
    { kind: 'review', action: 'refresh', ...review, tool: 'release-reviewer' },
    ...['merge-reviewer', 'release-reviewer'].map(reviewerTool => ({ kind: 'merge-request', ...mr, reviewerTool, expectedScope: 'a'.repeat(24) }))
  ];
  for (const source of sources) {
    assert.equal(isWorkspaceRequest({ ...request, source }), true, JSON.stringify(source));
    assert.equal(isWorkspaceRequest({ ...request, source: { ...source, cwd: 'C:/outside' } }), false);
    assert.equal(isWorkspaceRequest({ ...request, source: { ...source, model: 'untrusted-webview-model' } }), false);
  }
  for (const expectedScope of ['', 'x'.repeat(10001), 'a\0b', 7]) {
    assert.equal(isWorkspaceRequest({ ...request, source: { kind: 'merge-request', ...mr, reviewerTool: 'merge-reviewer', expectedScope } }), false);
  }
  for (const source of [
    { kind: 'merge-request', ...mr },
    { kind: 'merge-request', ...mr, reviewerTool: 'commit-reviewer' },
    { kind: 'bmad', request: { command: 'task', revision: 'r', requirement: 'build', executable: 'arbitrary' } },
    { kind: 'review', action: 'publish', ...review },
    { kind: 'issue', ...issue }, { kind: 'project-wiki', projectId: 1 },
    { kind: 'free', prompt: 'Work' }, { kind: 'group-analysis' }
  ]) assert.equal(isWorkspaceRequest({ ...request, source }), false, JSON.stringify(source));
});

test('retired Codex task, history, delivery and Wiki publication messages fail validation', () => {
  for (const type of ['startCodexTask', 'createCodexLaunch', 'codexCommand', 'resumeCodexTask', 'answerCodex',
    'codexHistory', 'listCodexTasks', 'publishProjectWiki', 'publishCodexReview', 'prepareCommitReview', 'setCodexAutoAccept']) {
    assert.equal(isWorkspaceRequest({ type }), false, type);
  }
  assert.equal(isWorkspaceRequest({ type: 'setMode', mode: 'codex' }), false);
});

test('nested legitimate Issue actions and Git rebase retain their contract', () => {
  for (const request of [
    { type: 'issueRequest', request: { type: 'invoke', issueId: 1, action: 'note', payload: { body: 'Hello', internal: false } } },
    { type: 'issueRequest', request: { type: 'update', issueId: 1, input: { assigneeId: null, milestoneId: null, dueDate: null } } },
    { type: 'gitAction', requestId: 'g', repoId: repo, action: { type: 'rebase', ref: 'main', interactive: true, expectedTargetHash: sha, todo: [{ hash: sha, action: 'pick' }] } }
  ]) assert.equal(isWorkspaceRequest(request), true, JSON.stringify(request));
  assert.equal(isWorkspaceRequest({ type: 'gitOpenFile', repositoryId: '', path: 'file.ts' }), false);
});
