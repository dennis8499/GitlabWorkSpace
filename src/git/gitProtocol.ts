export type GitRefKind = 'local' | 'remote' | 'tag';

export interface GitBranchSummary {
  name: string;
  kind: GitRefKind;
  current: boolean;
  commit?: string;
}

export interface GitStashSummary {
  oid: string;
  message: string;
}

export interface GitRecoveryRefSummary {
  name: string;
  hash: string;
  date: string;
  subject: string;
}

export interface GitRepositorySummary {
  id: string;
  name: string;
  path: string;
  branch?: string;
  headCommit?: string;
  tracking?: string;
  ahead?: number;
  behind?: number;
  stagedCount: number;
  unstagedCount: number;
  conflictCount: number;
  busy?: boolean;
  branches: GitBranchSummary[];
  stashes: GitStashSummary[];
  recoveryRefs: GitRecoveryRefSummary[];
}

export interface GitChange {
  path: string;
  originalPath?: string;
  section: 'staged' | 'unstaged' | 'conflict';
  kind: string;
}

export interface GitCommitSummary {
  hash: string;
  parents: string[];
  subject: string;
  author: string;
  date: string;
}

export type GitRebaseTodoAction = 'pick' | 'squash' | 'fixup' | 'reword' | 'edit' | 'drop';
export interface GitRebaseTodoEntry {
  hash: string;
  action: GitRebaseTodoAction;
  message?: string;
}
export interface GitRebasePlan {
  target: string;
  targetHash: string;
  commits: GitCommitSummary[];
  containsMerge: boolean;
}

export interface GitRepositorySnapshot extends GitRepositorySummary {
  /** Present only on a Commit action response; cancelling must not clear the draft. */
  commitCompleted?: boolean;
  remotes: string[];
  changes: GitChange[];
  history: GitCommitSummary[];
  historyHasMore: boolean;
  historyOffset?: number;
  selectedCommit?: GitCommitSummary;
  selectedCommitParent?: string;
  commitFiles?: string[];
  configuredPullStrategy?: GitPullStrategy | 'interactive';
  rebasePlan?: GitRebasePlan;
  diffPath?: string;
  diffStaged?: boolean;
  diffRef?: string;
  diffParent?: string;
  diffText?: string;
  operation?: string;
  error?: string;
  revision: number;
}

export type GitPullStrategy = 'configured' | 'merge' | 'rebase' | 'rebase-merges' | 'ff-only' | 'interactive';

export type GitAction =
  | { type: 'refresh' }
  | { type: 'open'; repoId: string; refresh?: boolean }
  | { type: 'readDiff'; path: string; staged: boolean; ref?: string; parent?: string }
  | { type: 'readCommit'; hash: string; parent?: string }
  | { type: 'rebasePreview'; ref: string; pullSource?: { remote: string; branch: string } }
  | { type: 'stageFile'; path: string; staged: boolean }
  | { type: 'stagePatch'; path: string; lines: number[]; basedOnDiff: string; reverse?: boolean }
  | { type: 'history'; ref?: string; skip?: number }
  | { type: 'commit'; message: string; amend?: boolean }
  | { type: 'branch'; name: string }
  | { type: 'checkout'; name: string }
  | { type: 'deleteBranch'; name: string }
  | { type: 'fetch'; remote: string }
  | { type: 'pull'; remote: string; branch: string; strategy: GitPullStrategy }
  | { type: 'push'; remote: string; branch: string; force?: boolean; setUpstream?: boolean }
  | { type: 'merge'; ref: string }
  | { type: 'rebase'; ref: string; interactive?: boolean; expectedTargetHash?: string; todo?: GitRebaseTodoEntry[]; pullSource?: { remote: string; branch: string } }
  | { type: 'cherryPick'; hash: string; mainline?: number }
  | { type: 'revert'; hash: string; mainline?: number }
  | { type: 'stashSave'; message: string; includeUntracked: boolean }
  | { type: 'stashApply'; hash: string; pop?: boolean }
  | { type: 'stashDrop'; hash: string }
  | { type: 'reset'; hash: string; mode: 'soft' | 'mixed' | 'hard' }
  | { type: 'discard'; path: string }
  | { type: 'abort' | 'continue' | 'skip' };

export type GitPanelRequest =
  | { type: 'gitReady' }
  | { type: 'gitAcknowledgeResult'; requestId: string }
  | { type: 'gitOpenRepository'; path: string }
  | { type: 'gitOpenMergeEditor'; repositoryId: string; path: string }
  | { type: 'gitOpenFile'; repositoryId: string; path: string }
  | { type: 'gitOpenDiff'; repositoryId: string; path: string; staged: boolean; ref?: string; parent?: string }
  | { type: 'gitAction'; requestId: string; repoId: string; action: GitAction };

/** Rebase preview may fetch a remote; every other preview is read-only. */
export function isGitWriteAction(action: GitAction): boolean {
  switch (action.type) {
    case 'open': case 'refresh': case 'readDiff': case 'readCommit': case 'history': return false;
    case 'rebasePreview': return !!action.pullSource;
    default: return true;
  }
}

export type GitPanelMessage =
  | { type: 'gitRepositories'; repositories: GitRepositorySummary[]; available: boolean; message?: string; selectedRepositoryId?: string; revision: number }
  | { type: 'gitSnapshot'; snapshot: GitRepositorySnapshot; requestId?: string }
  | { type: 'gitActionResult'; requestId: string; error?: string; commitCompleted?: boolean; write?: boolean }
  | { type: 'gitError'; message: string };

const REF_NAME = /^(?!-)(?!\/)(?!.*(?:\.\.|\/\/|@\{|\\|[\x00-\x20~^:?*[)\x7f]))(?!.*\/\.)(?!.*\/$)(?!.*\.lock$).+$/;
const OBJECT_ID = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i;
const REMOTE_NAME = /^(?!-)(?!.*[\x00-\x20\x7f]).{1,500}$/;

export function isGitRefName(value: string): boolean {
  return value.length > 0 && value.length <= 240 && REF_NAME.test(value);
}

export function isGitObjectId(value: string): boolean {
  return OBJECT_ID.test(value);
}

export function isGitRemoteName(value: string): boolean {
  return REMOTE_NAME.test(value);
}

export function isGitPanelRequest(value: unknown): value is GitPanelRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const request = value as Record<string, unknown>;
  if (request.type === 'gitReady') return Object.keys(request).length === 1;
  if (request.type === 'gitAcknowledgeResult') return typeof request.requestId === 'string' && request.requestId.length > 0 && request.requestId.length <= 128;
  if (request.type === 'gitOpenRepository') return typeof request.path === 'string' && request.path.length <= 32767;
  if (request.type === 'gitOpenMergeEditor' || request.type === 'gitOpenFile' || request.type === 'gitOpenDiff') {
    return typeof request.repositoryId === 'string' && /^[a-f0-9]{32}$/i.test(request.repositoryId) &&
      typeof request.path === 'string' && isSafeGitRelativePath(request.path) && request.path.length <= 32767 &&
      (request.type !== 'gitOpenDiff' || typeof request.staged === 'boolean' &&
        (request.ref === undefined || typeof request.ref === 'string' && isGitObjectId(request.ref)) &&
        (request.parent === undefined || typeof request.parent === 'string' && isGitObjectId(request.parent)));
  }
  if (request.type !== 'gitAction' || typeof request.repoId !== 'string' ||
      request.repoId.length > 128 || typeof request.requestId !== 'string' || request.requestId.length > 128 ||
      !request.action || typeof request.action !== 'object' || Array.isArray(request.action)) return false;
  const action = request.action as Record<string, unknown>;
  switch (action.type) {
    case 'refresh': case 'abort': case 'continue': case 'skip':
      return Object.keys(action).length === 1;
    case 'open':
      return typeof action.repoId === 'string' && action.repoId.length <= 128 &&
        (action.refresh === undefined || typeof action.refresh === 'boolean');
    case 'readDiff':
      return typeof action.path === 'string' && isSafeGitRelativePath(action.path) && typeof action.staged === 'boolean' &&
        (action.ref === undefined || typeof action.ref === 'string') &&
        (action.parent === undefined || typeof action.parent === 'string');
    case 'readCommit':
      return typeof action.hash === 'string' && isGitObjectId(action.hash) &&
        (action.parent === undefined || typeof action.parent === 'string' && isGitObjectId(action.parent));
    case 'rebasePreview':
      return typeof action.ref === 'string' && action.ref.length <= 1024 &&
        (action.pullSource === undefined || isRebasePullSource(action.pullSource));
    case 'stageFile': case 'discard':
      return typeof action.path === 'string' && isSafeGitRelativePath(action.path) && (action.type === 'discard' || typeof action.staged === 'boolean');
    case 'stagePatch':
      return typeof action.path === 'string' && isSafeGitRelativePath(action.path) && Array.isArray(action.lines) && action.lines.length > 0 &&
        action.lines.length <= 100_000 && action.lines.every((line) => typeof line === 'number' && Number.isSafeInteger(line) && line >= 0 && line <= 1_000_000) &&
        typeof action.basedOnDiff === 'string' && action.basedOnDiff.length <= 1_100_000 && !action.basedOnDiff.includes('\0') &&
        (action.reverse === undefined || typeof action.reverse === 'boolean');
    case 'history':
      return (action.ref === undefined || typeof action.ref === 'string') &&
        (action.skip === undefined || Number.isSafeInteger(action.skip) && Number(action.skip) >= 0 && Number(action.skip) <= 100_000);
    case 'commit':
      return typeof action.message === 'string' && action.message.length <= 100_000 &&
        (action.amend === undefined || typeof action.amend === 'boolean');
    case 'branch': case 'checkout': case 'deleteBranch': case 'merge': case 'rebase':
      return typeof (action.name ?? action.ref) === 'string' &&
        (action.type !== 'deleteBranch' && action.type !== 'branch' ||
          typeof action.name === 'string' && isGitRefName(action.name)) &&
        (action.type !== 'rebase' || action.interactive === undefined || typeof action.interactive === 'boolean') &&
        (action.type !== 'rebase' || action.expectedTargetHash === undefined || typeof action.expectedTargetHash === 'string' && isGitObjectId(action.expectedTargetHash)) &&
        (action.type !== 'rebase' || action.interactive !== true || typeof action.expectedTargetHash === 'string' && isGitObjectId(action.expectedTargetHash)) &&
        (action.type !== 'rebase' || action.todo === undefined || Array.isArray(action.todo) && action.todo.length <= 10000 && action.todo.every((entry) =>
          !!entry && typeof entry === 'object' && !Array.isArray(entry) && isGitObjectId(entry.hash) &&
          (entry.action === 'pick' || entry.action === 'squash' || entry.action === 'fixup' || entry.action === 'reword' || entry.action === 'edit' || entry.action === 'drop') &&
          (entry.message === undefined || typeof entry.message === 'string' && entry.message.length <= 100000))) &&
        (action.type !== 'rebase' || action.pullSource === undefined || isRebasePullSource(action.pullSource));
    case 'cherryPick': case 'revert':
      return typeof action.hash === 'string' && isGitObjectId(action.hash) &&
        (action.mainline === undefined || Number.isSafeInteger(action.mainline) && Number(action.mainline) > 0 && Number(action.mainline) <= 16);
    case 'fetch': case 'pull': case 'push':
      return typeof action.remote === 'string' && isGitRemoteName(action.remote) &&
        (action.type === 'fetch' || typeof action.branch === 'string' && isGitRefName(action.branch)) &&
        (action.type !== 'pull' || action.strategy === 'configured' || action.strategy === 'merge' ||
          action.strategy === 'rebase' || action.strategy === 'rebase-merges' || action.strategy === 'ff-only' || action.strategy === 'interactive') &&
        (action.type !== 'push' || (action.force === undefined || typeof action.force === 'boolean') &&
          (action.setUpstream === undefined || typeof action.setUpstream === 'boolean'));
    case 'stashSave':
      return typeof action.message === 'string' && action.message.length <= 1000 && typeof action.includeUntracked === 'boolean';
    case 'stashApply': case 'stashDrop':
      return typeof action.hash === 'string' && isGitObjectId(action.hash) &&
        (action.type === 'stashDrop' || action.pop === undefined || typeof action.pop === 'boolean');
    case 'reset':
      return typeof action.hash === 'string' && isGitObjectId(action.hash) &&
        (action.mode === 'soft' || action.mode === 'mixed' || action.mode === 'hard');
    default:
      return false;
  }
}

function isRebasePullSource(value: unknown): value is { remote: string; branch: string } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const source = value as Record<string, unknown>;
  return typeof source.remote === 'string' && isGitRemoteName(source.remote) &&
    typeof source.branch === 'string' && isGitRefName(source.branch);
}

function isSafeGitRelativePath(value: string): boolean {
  const normalized = value.replaceAll('\\', '/');
  return value.length > 0 && !value.includes('\0') && !/^(?:[a-z]:|\/|\\\\)/i.test(value) &&
    !normalized.split('/').some((part) => part === '..' || part === '.');
}
