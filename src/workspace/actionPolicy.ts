import type { WorkspaceRequest } from './workspaceProtocol';
import type { GitAction } from '../git/gitProtocol';
import type { IssueAction, IssuePanelRequest } from '../issues/protocol';
import type { QuickAction } from './quickActionsProtocol';

export type ActionKind = 'local' | 'read' | 'write' | 'control';
export type ActionConcurrency = 'latest' | 'join' | 'exclusive' | 'parallel';
export interface ActionContext { scopeRevision?: string; accountKey?: string; rootKey?: string; hostSessionId?: string; scopeEpoch?: number; }
export interface ActionPolicy {
  action: string; kind: ActionKind; concurrency: ActionConcurrency;
  resourceKey: string; lockKey: string; label: string;
  retryable: boolean; cancellable: boolean; notify: boolean;
}

// These exhaustive tables also classify control traffic, which must never
// produce further lifecycle messages or notifications.
export const workspaceActionKinds = {
  ready: 'control',
  reconcileOperations: 'control',
  gitReady: 'control',
  gitAcknowledgeResult: 'control',
  publishNotification: 'control',
  markNotificationsRead: 'control',
  markAllNotificationsRead: 'control',
  removeNotification: 'control',
  clearNotifications: 'control',
  cloneSelection: 'control',
  setLogVisibility: 'control',
  setIssueGraphVisibility: 'control',
  cancelRepositoryScan: 'control',
  setMode: 'local',
  closeIssue: 'local',
  openAccountManager: 'local',
  addAccount: 'local',
  openLocalWorkspace: 'local',
  openExternal: 'local',
  openWorkflowKitDownload: 'local',
  openWorkspaceFolder: 'local',
  gitOpenMergeEditor: 'local',
  gitOpenFile: 'local',
  gitOpenDiff: 'local',
  refresh: 'read',
  retryInstanceCheck: 'read',
  queryLogs: 'read',
  exportLogs: 'read',
  scanRepositories: 'read',
  selectIssueBoard: 'read',
  loadIssueGraph: 'read',
  retryWorkspaceSection: 'read',
  loadIssueRelations: 'read',
  selectProject: 'read',
  selectIssue: 'read',
  openIssue: 'read',
  createIssue: 'read',
  importIssueDrafts: 'read',
  loadDraftOptions: 'read',
  checkSimilarIssues: 'read',
  selectMergeRequest: 'read',
  refreshMergeRequest: 'read',
  loadMergeRequestSection: 'read',
  reconcileMergeRequestWrite: 'read',
  confirmOperationResult: 'read',
  openBranchReview: 'read',
  loadSkillBranches: 'read',
  setWorkflowKitSource: 'read',
  refreshWorkflowKit: 'read',
  gitOpenRepository: 'read',
  gitAction: 'read',
  issueRequest: 'read',
  connect: 'write',
  submitAccountLogin: 'write',
  disconnect: 'write',
  switchAccount: 'write',
  removeAccount: 'write',
  clearLogs: 'write',
  selectGroup: 'write',
  mutateIssueRelations: 'write',
  selectProjectFolder: 'write',
  selectProjectRoot: 'write',
  resetProjectRoot: 'write',
  selectCloneRoot: 'write',
  resetCloneRoot: 'write',
  openCodexTerminal: 'write',
  refreshBmad: 'read',
  launchBmadStep: 'write',
  copyBmadPrompt: 'write',
  openBmadArtifact: 'local',
  confirmBmadArtifact: 'write',
  revokeBmadConfirmation: 'write',
  clone: 'write',
  syncRepos: 'write',
  copy: 'write',
  createIssueDrafts: 'write',
  startTimer: 'write',
  pauseTimer: 'write',
  resumeTimer: 'write',
  stopTimer: 'write',
  addManualTime: 'write',
  updateTimeEntry: 'write',
  submitTimeEntry: 'write',
  acknowledgeTimeEntry: 'write',
  postMergeRequestNote: 'write',
  replyMergeRequest: 'write',
  approveMergeRequest: 'write',
  mergeMergeRequest: 'write',
  importWorkflowKitPackage: 'write',
  copySkillGuidePrompt: 'write',
  selectWorkflowKitInstallRoot: 'write',
  resetWorkflowKitInstallRoot: 'write',
  installWorkflowKit: 'write',
} satisfies Record<WorkspaceRequest['type'], ActionKind>;
export const gitActionKinds = {
  refresh: 'read',
  open: 'read',
  readDiff: 'read',
  readCommit: 'read',
  history: 'read',
  rebasePreview: 'read',
  stageFile: 'write',
  stagePatch: 'write',
  commit: 'write',
  branch: 'write',
  checkout: 'write',
  deleteBranch: 'write',
  fetch: 'write',
  pull: 'write',
  push: 'write',
  merge: 'write',
  rebase: 'write',
  cherryPick: 'write',
  revert: 'write',
  stashSave: 'write',
  stashApply: 'write',
  stashDrop: 'write',
  reset: 'write',
  discard: 'write',
  abort: 'write',
  continue: 'write',
  skip: 'write',
} satisfies Record<GitAction['type'], ActionKind>;
export const issueActionKinds = {
  reconcileOperations: 'control',
  confirmOperationResult: 'control',
  ready: 'control',
  refresh: 'read',
  loadSection: 'read',
  selectProject: 'read',
  preview: 'read',
  search: 'read',
  searchProjects: 'read',
  image: 'read',
  copyDescription: 'write',
  create: 'write',
  update: 'write',
  upload: 'write',
  invoke: 'write',
  openIssueInGitLab: 'local',
  openLink: 'local',
} satisfies Record<IssuePanelRequest['type'], ActionKind>;
export const issueInvokeKinds = {
  close: 'write',
  reopen: 'write',
  subscribe: 'write',
  unsubscribe: 'write',
  todo: 'write',
  todoDone: 'write',
  note: 'write',
  editNote: 'write',
  deleteNote: 'write',
  thread: 'write',
  reply: 'write',
  resolveThread: 'write',
  react: 'write',
  unreact: 'write',
  reactNote: 'write',
  unreactNote: 'write',
  link: 'write',
  unlink: 'write',
  estimate: 'write',
  spend: 'write',
  resetEstimate: 'write',
  resetSpent: 'write',
  deleteTimelog: 'write',
  move: 'write',
  clone: 'write',
  delete: 'write',
  createChild: 'write',
  addChild: 'write',
  removeChild: 'write',
  setChildState: 'write',
  updateChild: 'write',
} satisfies Record<IssueAction, ActionKind>;
export const quickActionKinds = {
  openWorkspace: 'read',
  openMyWork: 'read',
  openProjects: 'read',
  openAnalysis: 'read',
  openBmad: 'read',
  openReviewer: 'read',
  openGit: 'read',
  openAdmin: 'read',
  openRepository: 'read',
  openNotifications: 'read',
  addAccount: 'read',
  manageAccounts: 'read',
  switchAccount: 'write',
  logoutAccount: 'write',
  removeAccount: 'write',
} satisfies Record<QuickAction, ActionKind>;

export const operationLabels: Record<string, string> = {
  openBmad: '開啟 BMAD 開發流程', refreshBmad: '更新 BMAD 流程', launchBmadStep: '啟動 BMAD 步驟',
  copyBmadPrompt: '複製 BMAD 提示詞', openBmadArtifact: '查看 BMAD 產物', confirmBmadArtifact: '確認 BMAD 產物完成', revokeBmadConfirmation: '撤銷 BMAD 完成確認',
  gitAction: '執行版控操作', issueRequest: '處理 Issue 操作',
  openWorkspace: '開啟工作台', openProjects: '開啟專案', openAnalysis: '開啟分析', openMyWork: '開啟我的工作', openReviewer: '開啟待審查', openGit: '開啟版控', openAdmin: '開啟後台管理', openRepository: '開啟 Repo', manageAccounts: '開啟帳號管理',
  refresh: '更新目前頁面', retryInstanceCheck: '偵測 GitLab 功能', connect: '連線 GitLab', addAccount: '登入 GitLab', submitAccountLogin: '驗證帳號', switchAccount: '切換帳號', removeAccount: '移除帳號', disconnect: '登出', logoutAccount: '登出',
  selectGroup: '切換 Group', selectProjectFolder: '辨識專案資料夾', selectProjectRoot: '選擇專案目錄', resetProjectRoot: '重新辨識專案目錄', scanRepositories: '掃描本機 Repo', clone: '下載／更新 Repo', syncRepos: '更新預設分支',
  refreshWorkflowKit: '檢查 Skills', installWorkflowKit: '安裝／更新 Skills', importWorkflowKitPackage: '匯入工作流程包', copySkillGuidePrompt: '複製提示詞', copy: '複製內容', openCodexTerminal: '開啟 Codex CLI',
  selectIssue: '載入 Issue', openIssue: '開啟 Issue', createIssue: '開啟新增 Issue', createIssueDrafts: '建立 Issue', selectMergeRequest: '載入 MR', refreshMergeRequest: '檢查 MR 分支', loadMergeRequestSection: '載入 MR 內容', openBranchReview: '準備分支審查', loadSkillBranches: '讀取分支候選',
  postMergeRequestNote: '發布 MR 留言', replyMergeRequest: '回覆 MR', approveMergeRequest: '核准 MR', mergeMergeRequest: '合併 MR', submitTimeEntry: '送出工時',
  queryLogs: '讀取操作紀錄', loadIssueRelations: '載入 Issue 關聯', loadIssueGraph: '載入工作圖', loadDraftOptions: '載入欄位選項', gitOpenRepository: '開啟 Repo', selectProject: '載入專案', selectIssueBoard: '載入看板'
};

const latestActions = new Set(['selectIssue', 'selectMergeRequest', 'selectProject', 'selectIssueBoard', 'loadSkillBranches', 'queryLogs', 'gitOpenRepository']);
const connectionActions = new Set(['connect', 'disconnect', 'submitAccountLogin', 'switchAccount', 'removeAccount', 'logoutAccount', 'selectGroup']);
const rootActions = new Set(['selectProjectFolder', 'selectProjectRoot', 'resetProjectRoot', 'selectCloneRoot', 'resetCloneRoot', 'selectWorkflowKitInstallRoot', 'resetWorkflowKitInstallRoot', 'clone', 'syncRepos', 'scanRepositories']);
const skillsActions = new Set(['installWorkflowKit', 'refreshWorkflowKit', 'importWorkflowKitPackage', 'setWorkflowKitSource', 'openCodexTerminal', 'refreshBmad', 'launchBmadStep', 'confirmBmadArtifact', 'revokeBmadConfirmation']);
const canonicalRoot = (value?: string): string => (value ?? 'workspace').replace(/\\/g, '/').replace(/\/$/, '').toLocaleLowerCase('en-US');
export function writeResourceLock(resourceKey: string, context: ActionContext = {}): string {
  const global = resourceKey === 'clipboard' || resourceKey === 'connection' || resourceKey.startsWith('git:') || resourceKey.startsWith('git-path:');
  const local = resourceKey === 'repositories' || resourceKey === 'skills';
  return (global ? 'global' : local ? 'local:' + canonicalRoot(context.rootKey) : 'remote:' + (context.accountKey ?? context.scopeRevision ?? 'offline')) + ':' + resourceKey;
}

/** Policy contains metadata only; bodies, credentials and uploads stay in transport. */
export function describeAction(value: { type: string }, context: ActionContext = {}): ActionPolicy {
  if (['prepareDelivery', 'commitDelivery', 'pushDelivery', 'createDeliveryMergeRequest', 'copyWikiUpdatePrompt', 'copyAndOpenCodex'].includes(value.type)) {
    throw new Error('此操作已移除，請重新開啟工作台。');
  }
  const request = value as Record<string, any>;
  const action = request.type === 'perform' ? String(request.action) : request.type;
  let kind: ActionKind = request.type === 'perform' ? quickActionKinds[action as QuickAction] ?? 'control'
    : (workspaceActionKinds as Record<string, ActionKind>)[action] ?? 'control';
  let resourceKey = action;
  let slot = action;
  if (request.type === 'gitAction') {
    const nested = request.action as GitAction;
    kind = gitActionKinds[nested.type];
    if (nested.type === 'rebasePreview' && nested.pullSource) kind = 'write';
    resourceKey = 'git:' + request.repoId;
    slot = nested.type === 'open' ? 'git:selection' : resourceKey + ':' + nested.type;
  } else if (request.type === 'issueRequest') {
    const nested = request.request as IssuePanelRequest;
    kind = nested.type === 'invoke' ? issueInvokeKinds[nested.action] : issueActionKinds[nested.type];
    const identity = nested as IssuePanelRequest & { projectId?: number; issueIid?: number };
    resourceKey = identity.projectId && identity.issueIid ? 'issue:' + identity.projectId + ':' + identity.issueIid
      : 'issue:' + ('issueId' in nested ? nested.issueId : 'projectId' in nested ? nested.projectId : 'current');
    slot = resourceKey + ':' + nested.type;
    if ('target' in nested && nested.target) slot += ':' + nested.target;
    if (nested.type === 'image') slot += ':' + nested.url;
    if (nested.type === 'loadSection') slot += ':' + [...nested.sections].sort().join(',');
  } else if ('iid' in request) {
    resourceKey = 'mr:' + request.projectId + ':' + request.iid;
    if (request.section) slot = resourceKey + ':' + request.section;
  } else if ('issueIid' in request) resourceKey = 'issue:' + request.projectId + ':' + request.issueIid;
  else if (request.type === 'repositoryDetails') { kind = 'read'; resourceKey = 'git:' + request.repositoryId + ':details'; }
  else if (request.type === 'cancelRepositoryDetails' || request.type === 'reconcileOperations') kind = 'control';
  else if (action === 'openRepository') resourceKey = 'git:' + request.repositoryId;
  else if (action === 'gitOpenRepository') resourceKey = 'git-path:' + canonicalRoot(request.path);
  else if (action === 'copySkillGuidePrompt') resourceKey = 'skill:' + request.featureId;
  else if (connectionActions.has(action)) resourceKey = 'connection';
  else if (rootActions.has(action)) resourceKey = 'repositories';
  else if (skillsActions.has(action)) resourceKey = 'skills';
  else if (request.id && /Timer|TimeEntry/.test(action)) resourceKey = 'time:' + request.id;
  const clipboard = action === 'copy' || action === 'copySkillGuidePrompt' || action === 'copyBmadPrompt' || (request.type === 'issueRequest' && request.request.type === 'copyDescription');
  const nestedType = request.type === 'gitAction' ? request.action.type : request.type === 'issueRequest' ? request.request.type : undefined;
  const latest = latestActions.has(action) || (request.type === 'perform' && action.startsWith('open') && action !== 'openNotifications')
    || (request.type === 'gitAction' && ['open', 'readDiff', 'readCommit', 'rebasePreview'].includes(nestedType))
    || (request.type === 'issueRequest' && ['selectProject', 'preview', 'search', 'searchProjects'].includes(nestedType));
  const concurrency: ActionConcurrency = kind === 'write' ? 'exclusive' : latest ? 'latest' : kind === 'read' ? 'join' : 'parallel';
  const localResource = resourceKey.startsWith('git:') || resourceKey.startsWith('git-path:') || resourceKey === 'repositories' || resourceKey === 'skills';
  // Repo IDs are canonical service identities and must not be namespaced by
  // connection scope: switching accounts cannot permit a second local write.
  const namespace = clipboard || resourceKey === 'connection' || resourceKey.startsWith('git:') || resourceKey.startsWith('git-path:') ? 'global'
    : localResource ? 'local:' + canonicalRoot(context.rootKey) : 'remote:' + (context.accountKey ?? context.scopeRevision ?? 'offline');
  return { action, kind, concurrency, resourceKey,
    lockKey: namespace + ':' + (clipboard ? 'clipboard' : action === 'updateTimeEntry' || action === 'acknowledgeTimeEntry' ? resourceKey + ':confirmation' : kind === 'write' ? resourceKey : latest ? slot : resourceKey + ':' + slot),
    label: operationLabels[action] ?? (kind === 'read' ? '載入資料' : '處理操作'),
    retryable: kind === 'read', cancellable: action === 'scanRepositories', notify: kind === 'write' };
}
