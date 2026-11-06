import type { WorkspaceRequest } from './workspaceProtocol';
import { workspaceSettingIds } from './workspaceProtocol';
import type { IssueAction, IssuePanelRequest } from '../issues/protocol';
import type { GitAction } from '../git/gitProtocol';
import { isGitPanelRequest } from '../git/gitProtocol';

type Check = (value: unknown) => boolean;
type Shape = Record<string, Check>;
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const string = (max = 2048, min = 0): Check => value => typeof value === 'string' && value.length >= min && value.length <= max && !value.includes('\0');
const text = string(32000), key = string(2048, 1), identity = string(160, 1), path = string(32767, 1);
const boolean: Check = value => typeof value === 'boolean';
const integer: Check = value => Number.isSafeInteger(value) && Number(value) >= 0;
const id: Check = value => Number.isSafeInteger(value) && Number(value) > 0;
const optional = (check: Check): Check => value => value === undefined || check(value);
const nullable = (check: Check): Check => value => value === null || check(value);
const one = (...values: unknown[]): Check => value => values.includes(value);
const array = (check: Check, max = 1000): Check => value => Array.isArray(value) && value.length <= max && value.every(check);
const object = (shape: Shape): Check => value => record(value) && Object.keys(value).every(name => Object.hasOwn(shape, name))
  && Object.entries(shape).every(([name, check]) => check(value[name]));
const dictionary = (check: Check, max = 1000): Check => value => record(value) && Object.keys(value).length <= max
  && Object.entries(value).every(([name, item]) => identity(name) && !['__proto__', 'constructor', 'prototype'].includes(name) && check(item));
const strings = array(key), ids = array(id, 10000), tool = one('merge-reviewer', 'release-reviewer');
const source = one('gitea', 'github'), mode = one('dashboard', 'clone', 'sa', 'bmad', 'developer', 'reviewer', 'git', 'codex');
const metadata: Shape = { operationId: optional(value => identity(value) && /^[a-z0-9-]{1,100}$/i.test(String(value))),
  operationScope: optional(string(500)), hostSessionId: optional(identity), scopeEpoch: optional(integer), projectRevision: optional(key) };
const issueMetadata: Shape = { requestId: optional(identity), operationId: optional(identity), operationScope: optional(string(500)),
  projectId: optional(id), issueIid: optional(id) };

const issueFields: Shape = { title: optional(string(1024)), description: optional(string(1_100_000)), assigneeId: optional(nullable(id)),
  labels: optional(array(string(255), 1000)), milestoneId: optional(nullable(id)), dueDate: optional(nullable(string(32))),
  startDate: optional(nullable(string(32))), confidential: optional(boolean), discussionLocked: optional(boolean), stateEvent: optional(one('close', 'reopen')) };
const relationSchemas = {
  createChild: { title: string(1024, 1) }, addChild: { taskIid: id },
  link: { targetProjectId: id, targetIssueIid: id, linkType: one('relates_to', 'blocks', 'is_blocked_by') }, unlink: { linkId: id }
};
const variant = (schemas: Record<string, Shape>, common: Shape = {}): Check => value => record(value) && typeof value.type === 'string'
  && Object.hasOwn(schemas, value.type) && object({ ...common, ...schemas[value.type], type: one(value.type) })(value);
const relation = variant(relationSchemas);
const invokeSchemas = {
  close: {}, reopen: {}, subscribe: {}, unsubscribe: {}, todo: {}, todoDone: { todoId: id },
  note: { body: string(1_100_000, 1), internal: optional(boolean) }, thread: { body: string(1_100_000, 1), internal: optional(boolean) },
  editNote: { discussionId: key, noteId: id, body: string(1_100_000, 1) }, deleteNote: { discussionId: key, noteId: id },
  reply: { discussionId: key, body: string(1_100_000, 1) }, resolveThread: { discussionId: key, resolved: boolean },
  react: { name: string(100, 1) }, unreact: { reactionId: id }, reactNote: { noteId: id, name: string(100, 1) }, unreactNote: { noteId: id, reactionId: id },
  link: relationSchemas.link, unlink: relationSchemas.unlink, estimate: { duration: string(100, 1) },
  spend: { duration: string(100, 1), spentDate: optional(string(32)), summary: optional(text) },
  resetEstimate: {}, resetSpent: {}, deleteTimelog: { timelogId: key }, move: { toProjectId: id }, clone: { toProjectId: id, withNotes: optional(boolean) }, delete: {},
  createChild: { title: string(1024, 1), description: optional(text) }, addChild: { taskIid: id }, removeChild: { taskId: key },
  setChildState: { taskId: key, stateEvent: one('close', 'reopen') }, updateChild: { taskId: key, title: string(1024, 1), description: optional(text) }
} satisfies Record<IssueAction, Shape>;
const invoke: Check = value => record(value) && typeof value.action === 'string' && Object.hasOwn(invokeSchemas, value.action)
  && object({ ...issueMetadata, type: one('invoke'), issueId: id, action: one(value.action),
    payload: item => object(invokeSchemas[value.action as IssueAction])(item ?? {}) })(value);
const issueSchemas = {
  ready: {}, reconcileOperations: { pendingIds: optional(array(identity, 200)) }, confirmOperationResult: { targetOperationId: identity },
  cancelUpload: { targetRequestId: identity }, refresh: {},
  loadSection: { sections: array(one('options', 'activity', 'links', 'mergeRequests', 'reactions', 'todos', 'tasks', 'permissions', 'projects', 'dates', 'timelogs'), 12) },
  loadFormOptions: { projectId: id, section: one('fields', 'members', 'labels', 'milestones', 'templates'), mode: optional(one('next')) },
  loadCreateProjects: { query: optional(string(200)), mode: optional(one('next')), queryIdentity: optional(key) },
  loadNoteReactions: { noteId: id }, loadTemplate: { requestId: identity, projectId: id, key }, copyDescription: { requestId: identity, issueId: id },
  selectProject: { projectId: id }, create: { projectId: id, input: object({ ...issueFields, title: string(1024, 1) }) },
  update: { issueId: id, input: object(issueFields), expectedUpdatedAt: optional(key) },
  preview: { requestId: identity, projectId: id, markdown: string(1_100_000), target: optional(key) },
  search: { requestId: identity, projectId: id, query: string(200), mode: optional(one('next')), queryIdentity: optional(key) },
  searchProjects: { requestId: identity, query: string(200), mode: optional(one('next')), queryIdentity: optional(key) },
  upload: { requestId: identity, projectId: id, target: optional(key) }, image: { requestId: identity, url: string(8192, 1) },
  invoke: {}, openIssueInGitLab: { issueId: id }, openLink: { url: string(8192, 1) }
} satisfies Record<IssuePanelRequest['type'], Shape>;
const issueRequest: Check = value => record(value) && value.type === 'invoke' ? invoke(value) : variant(issueSchemas, issueMetadata)(value);

const pullSource = object({ remote: string(500, 1), branch: string(240, 1) });
const gitSchemas = {
  refresh: {}, open: { repoId: identity, refresh: optional(boolean) },
  readDiff: { path, staged: boolean, ref: optional(key), parent: optional(key) }, readCommit: { hash: key, parent: optional(key) },
  rebasePreview: { ref: key, pullSource: optional(pullSource) }, stageFile: { path, staged: boolean },
  stagePatch: { path, lines: array(integer, 100000), basedOnDiff: string(1_100_000), reverse: optional(boolean) },
  history: { ref: optional(key), skip: optional(integer) }, commit: { message: string(100000), amend: optional(boolean) },
  branch: { name: key }, checkout: { name: key }, deleteBranch: { name: key }, fetch: { remote: key },
  pull: { remote: key, branch: key, strategy: one('configured', 'merge', 'rebase', 'rebase-merges', 'ff-only', 'interactive') },
  push: { remote: key, branch: key, force: optional(boolean), setUpstream: optional(boolean) }, merge: { ref: key },
  rebase: { ref: key, interactive: optional(boolean), expectedTargetHash: optional(key), pullSource: optional(pullSource),
    todo: optional(array(object({ hash: key, action: one('pick', 'squash', 'fixup', 'reword', 'edit', 'drop'), message: optional(string(100000)) }), 10000)) },
  cherryPick: { hash: key, mainline: optional(id) }, revert: { hash: key, mainline: optional(id) },
  stashSave: { message: string(1000), includeUntracked: boolean }, stashApply: { hash: key, pop: optional(boolean) }, stashDrop: { hash: key },
  reset: { hash: key, mode: one('soft', 'mixed', 'hard') }, discard: { path }, abort: {}, continue: {}, skip: {}
} satisfies Record<GitAction['type'], Shape>;
const bmad: Shape = { revision: key, command: one('task', 'codex', 'skill'), skill: optional(key), stepId: optional(key),
  artifactId: optional(path), storyId: optional(path), requirement: optional(string(8000)) };
const draft = object({ id: identity, projectPath: key, title: string(1024, 1), description: string(1_100_000),
  acceptanceCriteria: array(text), sourceEvidence: array(object({ path, claim: text })), labels: optional(array(string(255))) });
const review: Shape = { revision: key, requestId: identity, tool };
const projectIssue: Shape = { projectId: id, issueIid: id }, projectMr: Shape = { projectId: id, iid: id };
const time: Shape = { duration: string(100, 1), summary: text, spentAt: optional(string(64)) };
const recovery = object({ requestId: identity, resourceKey: key, action: identity, label: string(200, 1),
  correlationId: optional(identity), lockKey: optional(key), kind: optional(one('local', 'control', 'read', 'write')) });
// MCP form answers can contain bounded JSON primitives/arrays. Authorization and
// the tool's actual schema remain validated against the pending Host interaction.
const json: Check = value => {
  let nodes = 0, chars = 0;
  const visit = (item: unknown, depth: number): boolean => {
    if (++nodes > 10000 || depth > 8) return false;
    if (typeof item === 'string') { chars += item.length; return item.length <= 32000 && chars <= 256000; }
    if (item === null || typeof item === 'boolean') return true;
    if (typeof item === 'number') return Number.isFinite(item);
    if (Array.isArray(item)) return item.length <= 1000 && item.every(child => visit(child, depth + 1));
    return record(item) && Object.keys(item).length <= 1000 && Object.entries(item).every(([name, child]) => identity(name)
      && !['__proto__', 'constructor', 'prototype'].includes(name) && visit(child, depth + 1));
  };
  return record(value) && visit(value, 0);
};
const taskSource: Check = value => record(value) && (
  value.kind === 'skill' ? object({ kind: one('skill'), featureId: identity, inputs: dictionary(text, 100), revision: key })(value)
    : value.kind === 'bmad' ? object({ kind: one('bmad'), request: object(bmad) })(value)
      : value.kind === 'review' && object({ kind: one('review'), action: one('resume', 'refresh'), tool, requestId: identity, revision: key })(value));

export const workspaceRequestSchemas = {
  startCodexTask: { source: taskSource }, listCodexTasks: {}, codexHistory: { taskId: identity, cursor: optional(key) },
  sendCodexMessage: { taskId: identity, text }, cancelCodexTask: { taskId: identity }, resumeCodexTask: { taskId: identity },
  pauseCodexTask: { taskId: identity }, deleteCodexTask: { taskId: identity }, setCodexAutoAccept: { taskId: identity, enabled: boolean },
  answerCodex: { taskId: identity, interactionId: identity, answer: object({ decision: one('accept', 'decline', 'cancel'), answers: optional(dictionary(string(8000), 100)), content: optional(json) }) },
  checkCodex: {}, configureCodex: { action: one('login', 'sandbox', 'executable') },
  ready: { projectSource: optional(one('gitlab', 'local')), developerView: optional(one('list', 'graph')), mergeRequestFilter: optional(one('all', 'reviewer', 'assigned')) },
  reconcileOperations: { pendingIds: optional(array(identity, 200)) }, confirmOperationResult: { targetOperationId: identity, recovery: optional(recovery) },
  refresh: { mode: optional(mode), projectSource: optional(one('gitlab', 'local')) }, retryInstanceCheck: {},
  setMode: { mode, projectSource: optional(one('gitlab', 'local')), mergeRequestFilter: optional(one('all', 'reviewer', 'assigned')) },
  setMergeRequestFilter: { filter: one('all', 'reviewer', 'assigned'), connectedScope: key }, setProjectSource: { source: one('gitlab', 'local') },
  issueRequest: { request: issueRequest, revision: optional(integer) }, closeIssue: {}, connect: {}, openAccountManager: {},
  openConfiguration: { setting: optional(one(...workspaceSettingIds)) },
  disconnect: { accountId: optional(identity) }, addAccount: { accountId: optional(identity) }, switchAccount: { accountId: identity }, removeAccount: { accountId: identity },
  openLogs: {}, scanRepositories: { resume: optional(boolean) }, cancelRepositoryScan: {}, cancelRepositoryOperation: {}, resyncWorkspace: {},
  selectGroup: { groupId: optional(id) }, selectIssueBoard: { boardId: id, connectedScope: key, mode: optional(one('continue', 'cancel')) },
  loadIssueGraph: { connectedScope: key, forceNetwork: optional(boolean), nodeIds: optional(strings), loadBoards: optional(boolean), moreRoots: optional(boolean), cancel: optional(boolean) },
  setIssueGraphVisibility: { visible: boolean, connectedScope: key },
  retryWorkspaceSection: { section: one('projects', 'issues', 'mergeRequests', 'milestones', 'boards'), connectedScope: key, mode: optional(one('next', 'all', 'history', 'current', 'cancel')) },
  ensureWorkspaceSection: { section: one('milestones', 'boards'), connectedScope: key },
  loadIssueRelations: { requestId: identity, connectedScope: key, ...projectIssue }, mutateIssueRelations: { requestId: identity, connectedScope: key, ...projectIssue, action: relation },
  openLocalWorkspace: {}, selectProjectFolder: { folderUri: path }, selectProjectRoot: {}, resetProjectRoot: {}, selectCloneRoot: {}, resetCloneRoot: {},
  refreshBmad: {}, copyBmadCommand: bmad, openBmadTerminal: { revision: key }, openBmadArtifact: { revision: key, stepId: key, path },
  clone: { projectIds: ids, cloneAll: optional(boolean) }, cloneSelection: { requestId: identity, scopeKey: optional(key), projectIds: ids }, syncRepos: { projectIds: optional(ids) },
  selectProject: { projectId: id }, selectIssue: projectIssue, openIssue: { ...projectIssue, tab: optional(one('content', 'relations', 'time')) }, createIssue: {},
  copy: { text: string(1_100_000) }, importIssueDrafts: { json: string(2_000_000) },
  createIssueDrafts: { analysisId: identity, drafts: array(draft, 1000), options: dictionary(object({ assigneeId: optional(id), labels: array(string(255)), milestoneId: optional(id) })) },
  loadDraftOptions: { projectId: id }, checkSimilarIssues: { drafts: array(draft, 1000) }, openExternal: { url: string(8192, 1) },
  startTimer: projectIssue, pauseTimer: { id: identity }, resumeTimer: { id: identity }, stopTimer: { id: identity },
  addManualTime: { ...projectIssue, ...time }, updateTimeEntry: { id: identity, ...time, spentAt: string(64) }, submitTimeEntry: { id: identity }, acknowledgeTimeEntry: { id: identity },
  selectMergeRequest: projectMr, refreshMergeRequest: projectMr, reconcileMergeRequestWrite: projectMr,
  loadMergeRequestSection: { ...projectMr, section: one('diffs', 'discussions') }, postMergeRequestNote: { ...projectMr, body: string(1_100_000, 1) }, openBranchReview: projectMr,
  loadSkillBranches: { repo: path, revision: key, requestId: identity }, loadReviewerCapabilities: review, loadReviewSessions: { revision: key, tool },
  cancelReviewSession: review, copyReviewRefresh: review, copyReviewResume: review, openReviewReport: review,
  replyMergeRequest: { ...projectMr, discussionId: key, body: string(1_100_000, 1) }, approveMergeRequest: { ...projectMr, sha: string(64, 40) }, mergeMergeRequest: { ...projectMr, sha: string(64, 40) },
  setWorkflowKitSource: { source }, openWorkflowKitDownload: { source }, refreshWorkflowKit: {}, checkWorkflowKitReleases: { source },
  copySkillGuidePrompt: { featureId: identity, inputs: dictionary(text, 100), revision: key }, openWorkspaceFolder: {}, selectWorkflowKitInstallRoot: {}, resetWorkflowKitInstallRoot: {}, installWorkflowKit: { releaseId: key },
  publishNotification: { level: one('info', 'warn', 'error'), message: string(4096), title: optional(string(200)) },
  markNotificationsRead: { ids: array(identity, 500), revision: integer }, markAllNotificationsRead: { revision: integer }, removeNotification: { id: identity }, clearNotifications: { revision: integer },
  gitReady: {}, gitAcknowledgeResult: { requestId: identity }, gitOpenRepository: { path }, gitOpenMergeEditor: { repositoryId: identity, path }, gitOpenFile: { repositoryId: identity, path },
  gitOpenDiff: { repositoryId: identity, path, staged: boolean, ref: optional(key), parent: optional(key) }, gitAction: { requestId: identity, repoId: identity, action: variant(gitSchemas) }
} satisfies Record<WorkspaceRequest['type'], Shape>;

export class WorkspaceProtocolError extends Error {
  constructor() { super('此操作已移除或工作台訊息格式無效，請重新開啟工作台。'); }
}
export function isWorkspaceRequest(value: unknown): value is WorkspaceRequest {
  if (!variant(workspaceRequestSchemas, metadata)(value)) return false;
  const request = value as WorkspaceRequest;
  if (!request.type.startsWith('git')) return true;
  const payload = Object.fromEntries(Object.entries(request).filter(([name]) => !Object.hasOwn(metadata, name)));
  return isGitPanelRequest(payload);
}
export function parseWorkspaceRequest(value: unknown): WorkspaceRequest {
  if (!isWorkspaceRequest(value)) throw new WorkspaceProtocolError();
  return value;
}
