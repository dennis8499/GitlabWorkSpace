import * as vscode from 'vscode';
import { createHash, randomUUID } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import type { GitLabProject } from '../api/types';
import type { GitLabSession } from '../connection/session';
import { projectRemoteMatches, createScopedGitEnvironment } from './cloneService';
import { isAllowedGitRemote } from '../api/urlPolicy';
import { gitDirectoryForRepository, withGitDirectoryLock } from './repositoryOperationLock';
import { makeSelectedPatch } from './gitDiffSelection';
import { isGitWriteAction } from './gitProtocol';
import { GitRefreshScheduler } from './gitRefreshScheduler';
import { GitStateFingerprint } from './gitStateFingerprint';
import { logGitCommand } from './gitCommandLog';
import { scanWorkspaceRepositories, DEFAULT_SCAN_EXCLUDES, type RepositoryScanState, type ScannedRepository } from './repositoryScanner';
import type {
  GitAction, GitBranchSummary, GitChange, GitCommitSummary, GitPanelMessage, GitPullStrategy,
  GitRefKind, GitRecoveryRefSummary, GitRepositorySnapshot, GitRepositorySummary, GitStashSummary
  , GitRebasePlan, GitRebaseTodoEntry
} from './gitProtocol';

const execFileAsync = promisify(execFile);
const MAX_DIFF_BYTES = 1_048_576;
const HISTORY_PAGE_SIZE = 200;
const API_EXTENSION_ID = 'vscode.git';

interface GitBranch {
  name?: string;
  commit?: string;
  remote?: string;
  ahead?: number;
  behind?: number;
  upstream?: { remote: string; name: string; commit?: string };
}

async function mapWithConcurrency<T, R>(items: readonly T[], concurrency: number, operation: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await operation(items[index], index);
    }
  }));
  return results;
}

interface GitRef {
  name?: string;
  commit?: string;
  type: number;
  remote?: string;
}

function gitRefName(ref: GitRef): string | undefined {
  if (!ref.name) return undefined;
  if (ref.type !== 1 || !ref.remote || ref.name.startsWith(ref.remote + '/')) return ref.name;
  return ref.remote + '/' + ref.name;
}

interface GitChangeEntry {
  uri: vscode.Uri;
  originalUri?: vscode.Uri;
  renameUri?: vscode.Uri;
  status: number;
}

interface GitRepository {
  readonly rootUri: vscode.Uri;
  readonly state: {
    readonly HEAD?: GitBranch;
    readonly refs: GitRef[];
    readonly remotes: Array<{ name: string; fetchUrl?: string; pushUrl?: string; isReadOnly: boolean }>;
    readonly indexChanges: GitChangeEntry[];
    readonly workingTreeChanges: GitChangeEntry[];
    readonly mergeChanges: GitChangeEntry[];
    readonly rebaseCommit?: { hash: string; message?: string };
    readonly onDidChange: vscode.Event<void>;
  };
  status(): Promise<void>;
  getConfig(key: string): Promise<string>;
  diffWithHEAD(path?: string): Promise<GitChangeEntry[] | string>;
  diffWith(ref: string, path?: string): Promise<GitChangeEntry[] | string>;
  diffIndexWithHEAD(path?: string): Promise<GitChangeEntry[] | string>;
  createBranch(name: string, checkout: boolean, ref?: string): Promise<void>;
  deleteBranch(name: string, force?: boolean): Promise<void>;
  getBranches(query: { remote?: boolean; count?: number }): Promise<GitRef[]>;
  checkout(treeish: string): Promise<void>;
  add(paths: string[]): Promise<void>;
  revert(paths: string[]): Promise<void>;
  apply(patch: string, reverse?: boolean): Promise<void>;
  commit(message: string, options?: { all?: boolean; amend?: boolean; signoff?: boolean; signCommit?: boolean; noVerify?: boolean; useEditor?: boolean }): Promise<void>;
  fetch(options?: { remote?: string; ref?: string; all?: boolean; prune?: boolean }): Promise<void>;
  pull(unshallow?: boolean): Promise<void>;
  push(remoteName?: string, branchName?: string, setUpstream?: boolean, force?: 0 | 1 | 2 | 3): Promise<void>;
  merge(ref: string): Promise<void>;
  mergeAbort(): Promise<void>;
  log(options?: { maxEntries?: number; sortByAuthorDate?: boolean }): Promise<Array<{ hash: string; parents: string[]; message: string; authorName?: string; authorEmail?: string; authorDate?: Date }>>;
}

interface GitApi {
  readonly state: 'uninitialized' | 'initialized';
  readonly onDidChangeState: vscode.Event<'uninitialized' | 'initialized'>;
  readonly git: { path: string };
  readonly repositories: GitRepository[];
  readonly onDidOpenRepository: vscode.Event<GitRepository>;
  readonly onDidCloseRepository: vscode.Event<GitRepository>;
  openRepository(root: vscode.Uri): Promise<GitRepository | null>;
}

interface GitExtension {
  readonly enabled: boolean;
  readonly onDidChangeEnablement: vscode.Event<boolean>;
  getAPI(version: 1): GitApi;
}

interface GitCommandOutput { stdout: string; stderr: string; }
type GitWarningPromptHandler = (message: string, options: vscode.MessageOptions, ...items: string[]) => Thenable<string | undefined>;
type GitActionTraceHandler = (event: { phase: 'start' | 'complete' | 'error'; repositoryId: string; action: string; error?: string }) => void;

export class GitRepositoryService implements vscode.Disposable {
  private pendingActions = 0;
  get hasActiveOperations(): boolean { return this.activeOperations.size > 0 || this.pendingActions > 0; }

  async getInventory(): Promise<ScannedRepository[]> {
    await this.initialization;
    return (this.api?.repositories ?? []).map(repository => {
      const remotes = repository.state.remotes.flatMap(remote => [remote.fetchUrl, remote.pushUrl]).filter((url): url is string => !!url)
        .map(remote => { try { const url = new URL(remote); url.username = ''; url.password = ''; url.search = ''; url.hash = ''; return url.toString(); } catch { return remote; } });
      let canonical = repository.rootUri.fsPath;
      try { canonical = realpathSync(canonical); } catch { /* Retain an unavailable native Repo for its error state. */ }
      return { path: canonical, name: path.basename(canonical), remotes,
        repositoryId: this.repositoryId(repository.rootUri.fsPath) };
    });
  }

  async scanWorkspace(signal: AbortSignal, onProgress: (state: RepositoryScanState) => void): Promise<RepositoryScanState> {
    const task = () => this.scanWorkspaceInternal(signal, onProgress);
    return this.gitlabSession.log?.run('projects', 'scanWorkspace', {}, task) ?? task();
  }

  private async scanWorkspaceInternal(signal: AbortSignal, onProgress: (state: RepositoryScanState) => void): Promise<RepositoryScanState> {
    await this.initialization;
    const folders = vscode.workspace.workspaceFolders ?? [];
    const state = await scanWorkspaceRepositories(folders.filter(folder => folder.uri.scheme === 'file').map(folder => folder.uri.fsPath), {
      signal, onProgress: progress => onProgress({ ...progress, status: progress.status === 'completed' ? 'scanning' : progress.status }), gitPath: this.api?.git.path,
      excludes: vscode.workspace.getConfiguration('gitlabWorkspace').get<string[]>('repositoryScan.excludeDirectories', DEFAULT_SCAN_EXCLUDES),
      log: this.gitlabSession.log
    });
    for (const folder of folders.filter(folder => folder.uri.scheme !== 'file')) state.errors.push({ path: folder.uri.toString(), message: '此工作區不是本機檔案資料夾，無法掃描。' });
    for (const repository of state.repositories) {
      if (signal.aborted) { state.status = 'cancelled'; break; }
      const started = Date.now();
      try {
        if (!this.api || !this.enabled) throw new Error('請啟用 VS Code 內建 Git。');
        const opened = this.api.repositories.find(item => this.pathKey(item.rootUri.fsPath) === this.pathKey(repository.path)) ??
          await this.api.openRepository(vscode.Uri.file(repository.path));
        if (!opened) throw new Error('VS Code Git 未登錄此 Repo；請檢查工作區信任、Git 權限或忽略設定。');
        repository.repositoryId = this.repositoryId(opened.rootUri.fsPath);
        this.reconcileRepositorySubscription(opened);
        this.gitlabSession.log?.record({ feature: 'projects', action: 'registerRepository', result: 'success', repositoryPath: repository.path, durationMs: Date.now() - started });
      } catch (error) {
        repository.registrationError = readableGitError(error);
        state.errors.push({ path: repository.path, message: repository.registrationError });
        this.gitlabSession.log?.record({ feature: 'projects', action: 'registerRepository', result: 'error', repositoryPath: repository.path, durationMs: Date.now() - started, message: repository.registrationError });
      }
      onProgress({ ...state, status: 'scanning', repositories: state.repositories.map(item => ({ ...item })) });
    }
    if (!signal.aborted) { this.cachedSummariesListRevision = -1; await this.refresh(); }
    onProgress(state);
    return state;
  }
  private api?: GitApi;
  private repositoryExtension?: vscode.Extension<GitExtension>;
  private readonly subscriptions: vscode.Disposable[] = [];
  private readonly repositorySubscriptions = new Map<string, vscode.Disposable>();
  private readonly activeOperations = new Set<string>();
  private readonly revisionByRepository = new Map<string, number>();
  private readonly selectedCommits = new Map<string, { commit: GitCommitSummary; files: string[]; parent?: string }>();
  private readonly rebasePlans = new Map<string, GitRebasePlan>();
  private readonly emitter = new vscode.EventEmitter<void>();
  private readonly repositoryListEmitter = new vscode.EventEmitter<void>();
  private readonly panelEmitter = new vscode.EventEmitter<GitPanelMessage>();
  private disposed = false;
  private activePanelGeneration = 0;
  private readonly managedRefreshes = new Map<string, number>();
  private readonly dataEpochs = new Map<string, number>();
  private readonly summaryCache = new Map<string, { epoch: number; value: GitRepositorySummary }>();
  private readonly pullStrategyCache = new Map<string, { epoch: number; value: GitPullStrategy | 'interactive' }>();
  private readonly historyCache = new Map<string, { epoch: number; pages: Map<string, { history: GitCommitSummary[]; hasMore: boolean }> }>();
  private readonly snapshotTasks = new Map<string, Promise<GitRepositorySnapshot>>();
  private readonly readTasks = new Map<string, Promise<GitRepositorySnapshot | undefined>>();
  private readonly readGenerations = new Map<string, number>();
  private nextSelectionGeneration = 0;
  private readonly selectionGenerations = new Map<string, number>();
  private readonly commitCache = new Map<string, { commit: GitCommitSummary; files: string[]; parent?: string }>();
  private readonly refreshScheduler = new GitRefreshScheduler((id) => this.sendRepositoryUpdate(id));
  private readonly fingerprint = new GitStateFingerprint();
  private readonly stateFingerprints = new Map<string, string>();
  private repositoriesRevision = 0;
  private repositoryListRevision = 0;
  private cachedSummaries: GitRepositorySummary[] = [];
  private cachedSummariesListRevision = -1;
  private summaryRefresh?: Promise<GitRepositorySummary[]>;
  private dirtySummaryRefresh?: Promise<void>;
  private readonly dirtySummaryIds = new Set<string>();
  private warningPromptHandler?: GitWarningPromptHandler;
  private actionTraceHandler?: GitActionTraceHandler;
  private projectSource: () => readonly GitLabProject[] = () => [];
  private readonly gitlabSession: GitLabSession;
  private activePanelRepositoryId?: string;
  private initialization: Promise<void>;
  private enabled = false;
  private error?: string;
  private executedGitCommandCount = 0;
  private auxiliaryGitCommandCount = 0;
  private nativeGitApiCalls = 0;
  private nativeStatusEvents = 0;
  private readonly trackedRepositories = new WeakMap<GitRepository, GitRepository>();

  readonly onDidChangeRepositories = this.emitter.event;
  readonly onDidChangeRepositoryList = this.repositoryListEmitter.event;
  readonly onDidMessage = this.panelEmitter.event;

  constructor(private readonly extensionUri: vscode.Uri, private readonly storageUri: vscode.Uri, session: GitLabSession) {
    this.gitlabSession = session;
    this.initialization = this.initialize();
  }

  setGitLabProjects(source: () => readonly GitLabProject[]): void { this.projectSource = source; }

  setWarningPromptHandlerForTesting(handler: GitWarningPromptHandler): void { this.warningPromptHandler = handler; }
  setActionTraceHandlerForTesting(handler: GitActionTraceHandler): void { this.actionTraceHandler = handler; }
  getCommandCountForTesting(): number { return this.executedGitCommandCount; }
  getActivityForTesting(): { commands: number; auxiliaryCommands: number; nativeApiCalls: number; nativeStatusEvents: number } {
    return { commands: this.executedGitCommandCount, auxiliaryCommands: this.auxiliaryGitCommandCount,
      nativeApiCalls: this.nativeGitApiCalls, nativeStatusEvents: this.nativeStatusEvents };
  }

  private trackRepository(repository: GitRepository): GitRepository {
    const existing = this.trackedRepositories.get(repository);
    if (existing) return existing;
    const tracked = new Proxy(repository, {
      get: (target, key) => {
        const value = Reflect.get(target, key);
        if (typeof value !== 'function') return value;
        return (...args: unknown[]) => { this.nativeGitApiCalls++; return value.apply(target, args); };
      }
    });
    this.trackedRepositories.set(repository, tracked);
    return tracked;
  }

  setActivePanelRepository(repositoryId?: string, refresh = true): void {
    const changed = this.activePanelRepositoryId !== repositoryId;
    if (changed) { this.activePanelGeneration++; this.refreshScheduler.cancel(); }
    this.activePanelRepositoryId = repositoryId;
    if (changed && repositoryId && refresh) this.refreshScheduler.notify(repositoryId);
  }

  private showWarningMessage(message: string, options: vscode.MessageOptions, ...items: string[]): Thenable<string | undefined> {
    return this.warningPromptHandler
      ? this.warningPromptHandler(message, options, ...items)
      : vscode.window.showWarningMessage(message, options, ...items);
  }

  async refresh(): Promise<GitRepositorySummary[]> {
    await this.initialization;
    if (!this.api || !this.enabled) {
      this.cachedSummaries = [];
      this.cachedSummariesListRevision = this.repositoryListRevision;
      this.dirtySummaryIds.clear();
      return [];
    }
    if (this.summaryRefresh) {
      const pending = this.summaryRefresh;
      await pending;
      if (this.cachedSummariesListRevision !== this.repositoryListRevision) {
        if (this.summaryRefresh === pending) this.summaryRefresh = undefined;
        return this.refresh();
      }
      return this.cachedSummaries;
    }
    const listRevision = this.repositoryListRevision;
    const task = mapWithConcurrency([...this.api.repositories], 4, async (nativeRepository) => {
      const repository = this.trackRepository(nativeRepository);
      const id = this.repositoryId(repository.rootUri.fsPath);
      try {
        return await withGitDirectoryLock(repository.rootUri.fsPath, async () => {
          this.reconcileRepositorySubscription(repository, id);
          const stateRevision = this.revisionByRepository.get(id) ?? 0;
          return { id, stateRevision, summary: await this.buildSummary(repository, id) };
        });
      } catch {
        const stateRevision = this.revisionByRepository.get(id) ?? 0;
        return { id, stateRevision, summary: await this.buildSummary(repository, id) };
      }
    }).then((summaries) => {
      const values = summaries.map((item) => item.summary);
      values.sort((first, second) =>
        first.name.localeCompare(second.name, 'en-US', { sensitivity: 'base' }) || first.path.localeCompare(second.path));
      if (listRevision === this.repositoryListRevision) {
        this.cachedSummaries = values;
        this.cachedSummariesListRevision = listRevision;
        const currentIds = new Set(summaries.map((item) => item.id));
        for (const id of this.dirtySummaryIds) if (!currentIds.has(id)) this.dirtySummaryIds.delete(id);
        for (const item of summaries) {
          if ((this.revisionByRepository.get(item.id) ?? 0) === item.stateRevision) this.dirtySummaryIds.delete(item.id);
        }
      }
      return values;
    });
    this.summaryRefresh = task;
    return task.finally(() => { if (this.summaryRefresh === task) this.summaryRefresh = undefined; });
  }

  async getSummaryState(): Promise<{ repositories: GitRepositorySummary[]; available: boolean; message?: string; revision: number }> {
    await this.initialization;
    while (this.cachedSummariesListRevision !== this.repositoryListRevision) await this.refresh();
    if (this.dirtySummaryIds.size) await this.refreshDirtySummaries();
    return {
      repositories: this.cachedSummaries.map((summary) => ({ ...summary, busy: this.activeOperations.has(summary.id) })),
      available: this.enabled,
      message: this.error,
      revision: this.repositoriesRevision
    };
  }

  async openRepositoryPath(candidate: string): Promise<string | undefined> {
    const requested = path.resolve(candidate);
    const repository = this.api?.repositories.find((item) => {
      try { return this.pathKey(item.rootUri.fsPath) === this.pathKey(requested); }
      catch { return false; }
    });
    return repository ? this.repositoryId(repository.rootUri.fsPath) : undefined;
  }

  async openRepositoryFile(repositoryId: string, candidate: string, mergeEditor: boolean): Promise<void> {
    const repository = await this.requireRepository(repositoryId);
    const relative = this.safeRelativePath(repository, candidate);
    if (mergeEditor && !this.changes(repository).some((change) => change.path === relative && change.section === 'conflict')) {
      throw new Error('這個檔案目前不在衝突清單中，請先重新整理 Repo 狀態。');
    }
    const uri = vscode.Uri.file(path.join(repository.rootUri.fsPath, relative));
    const openDocument = vscode.workspace.textDocuments.find((document) => this.pathKey(document.uri.fsPath) === this.pathKey(uri.fsPath));
    if (openDocument?.isDirty) {
      const choice = await this.showWarningMessage('檔案有尚未儲存的編輯內容。先儲存後開啟？', { modal: true }, '儲存並開啟', '取消');
      if (choice !== '儲存並開啟') return;
      if (!await openDocument.save()) throw new Error('檔案尚未儲存，已取消開啟。');
    }
    if (mergeEditor) {
      try {
        await vscode.commands.executeCommand('git.openMergeEditor', uri);
        return;
      } catch {
        await vscode.window.showInformationMessage('無法開啟 VS Code Merge Editor，改用文字編輯器顯示衝突檔案。');
      }
    }
    const document = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(document, { preview: false, preserveFocus: false });
  }

  async openNativeDiff(repositoryId: string, candidate: string, staged: boolean, ref?: string, parent?: string): Promise<void> {
    const repository = await this.requireRepository(repositoryId);
    return withGitDirectoryLock(repository.rootUri.fsPath, async () => {
    const relative = this.safeRelativePath(repository, candidate);
    if (!await this.confirmSavedEditors(repository, [relative])) return;
    let before: Buffer;
    let after: Buffer;
    if (ref) {
      await this.assertRef(repository, ref);
      await this.assertObjectId(repository, ref);
      const parents = (await this.runGit(repository, ['show', '-s', '--format=%P', ref])).stdout.trim().split(/\s+/).filter(Boolean);
      if (parent && !parents.includes(parent)) throw new Error('選擇的比較 parent 不屬於這筆提交。');
      const selectedParent = parent ?? parents[0];
      before = selectedParent ? await this.readBlob(repository, selectedParent + ':./' + relative).catch(() => Buffer.alloc(0)) : Buffer.alloc(0);
      after = await this.readBlob(repository, ref + ':./' + relative).catch(() => Buffer.alloc(0));
    } else if (staged) {
      before = repository.state.HEAD?.commit
        ? await this.readBlob(repository, 'HEAD:./' + relative).catch(() => Buffer.alloc(0))
        : Buffer.alloc(0);
      after = await this.readBlob(repository, ':./' + relative).catch(() => Buffer.alloc(0));
    } else {
      before = await this.readBlob(repository, ':./' + relative).catch(() => Buffer.alloc(0));
      after = await readFile(path.join(repository.rootUri.fsPath, relative)).catch(() => Buffer.alloc(0));
    }
    const folder = path.join(this.storageUri.fsPath, 'git-diffs');
    await mkdir(folder, { recursive: true });
    const key = createHash('sha256').update(repositoryId + '\0' + relative + '\0' + randomUUID()).digest('hex');
    const beforePath = path.join(folder, key + '.before');
    const afterPath = path.join(folder, key + '.after');
    await Promise.all([writeFile(beforePath, before), writeFile(afterPath, after)]);
    await vscode.commands.executeCommand('vscode.diff', vscode.Uri.file(beforePath), vscode.Uri.file(afterPath),
      relative + (ref ? ' · Commit Diff' : staged ? ' · HEAD / 暫存' : ' · 暫存 / 工作目錄'), { preview: false });
    });
  }

  async getSnapshot(repositoryId: string, refreshStatus = false, panelGeneration?: number): Promise<GitRepositorySnapshot> {
    const key = repositoryId + ':' + (refreshStatus ? 'refresh' : 'read') + ':' + (this.dataEpochs.get(repositoryId) ?? 0) + ':' + (panelGeneration ?? 'request');
    const existing = this.snapshotTasks.get(key);
    if (existing) return existing;
    const task = (async () => {
      const repository = this.findRepository(repositoryId);
      if (!repository) throw new Error('找不到這個 VS Code 工作區 Repo。');
      return withGitDirectoryLock(repository.rootUri.fsPath, async () => {
        if (this.disposed || panelGeneration !== undefined && (panelGeneration !== this.activePanelGeneration || this.activePanelRepositoryId !== repositoryId)) throw new Error('版控畫面已離開。');
        if (refreshStatus) { await this.requireRepository(repositoryId); await repository.status(); this.invalidateRepository(repositoryId); this.bump(repositoryId); }
        const snapshot = await this.readSnapshot(repository, repositoryId);
        this.rememberSummary(snapshot);
        return snapshot;
      });
    })();
    this.snapshotTasks.set(key, task);
    try { return await task; } finally { if (this.snapshotTasks.get(key) === task) this.snapshotTasks.delete(key); }
  }

  private async readSnapshot(repository: GitRepository, repositoryId: string): Promise<GitRepositorySnapshot> {
    const epoch = this.dataEpochs.get(repositoryId) ?? 0;
    this.stateFingerprints.set(repositoryId, this.repositoryFingerprint(repository));
    const summary = await this.buildSummary(repository, repositoryId);
    const page = await this.historyPage(repository, repositoryId);
    const diff = await this.lastDiffFor(repositoryId);
    let strategy = this.pullStrategyCache.get(repositoryId);
    if (!strategy || strategy.epoch !== epoch) {
      strategy = { epoch, value: await this.configuredPullStrategy(repository) };
      this.pullStrategyCache.set(repositoryId, strategy);
    }
    if (diff && !diff.ref && diff.epoch !== epoch) {
      if (this.changes(repository).some((change) => change.path === diff.path && (change.section === 'staged') === diff.staged)) {
        await this.loadDiff(repository, repositoryId, { type: 'readDiff', path: diff.path, staged: diff.staged });
      } else this.lastDiffs.delete(repositoryId);
    }
    const currentDiff = await this.lastDiffFor(repositoryId);
    if (epoch !== (this.dataEpochs.get(repositoryId) ?? 0) && this.activePanelRepositoryId === repositoryId) this.refreshScheduler.notify(repositoryId);
    return {
      ...summary,
      remotes: repository.state.remotes.map((remote) => remote.name),
      changes: this.changes(repository),
      history: page.history,
      historyHasMore: page.hasMore,
      selectedCommit: this.selectedCommits.get(repositoryId)?.commit,
      selectedCommitParent: this.selectedCommits.get(repositoryId)?.parent,
      commitFiles: this.selectedCommits.get(repositoryId)?.files,
      configuredPullStrategy: strategy.value,
      rebasePlan: this.rebasePlans.get(repositoryId),
      diffPath: currentDiff?.path,
      diffStaged: currentDiff?.staged,
      diffRef: currentDiff?.ref,
      diffParent: currentDiff?.parent,
      diffText: currentDiff?.text,
      operation: this.operationFor(repository),
      revision: this.revisionByRepository.get(repositoryId) ?? 0
    };
  }

  async handleAction(repositoryId: string, action: GitAction): Promise<GitRepositorySnapshot | undefined> {
    const write = isGitWriteAction(action);
    const panelGeneration = this.activePanelRepositoryId === repositoryId ? this.activePanelGeneration : undefined;
    const readKey = repositoryId + ':' + (this.dataEpochs.get(repositoryId) ?? 0) + ':' + (panelGeneration ?? 'external') + ':' + JSON.stringify(action);
    const selection = action.type === 'readDiff' || action.type === 'readCommit';
    if (!write && this.readTasks.has(readKey)) {
      const sharedGeneration = this.readGenerations.get(readKey);
      if (sharedGeneration !== undefined) this.selectionGenerations.set(repositoryId, sharedGeneration);
      return this.readTasks.get(readKey);
    }
    const generation = selection ? ++this.nextSelectionGeneration : undefined;
    if (generation !== undefined) this.selectionGenerations.set(repositoryId, generation);
    if (generation !== undefined) this.readGenerations.set(readKey, generation);
    if (write && this.gitlabSession.isTransitioning) throw new Error('帳號正在切換，請稍後再執行版控操作。');
    if (write) this.pendingActions++;
    const managed = write || action.type === 'open' || action.type === 'refresh';
    if (managed) this.managedRefreshes.set(repositoryId, (this.managedRefreshes.get(repositoryId) ?? 0) + 1);
    const repositoryPath = this.api?.repositories.find(repository => this.repositoryId(repository.rootUri.fsPath) === repositoryId)?.rootUri.fsPath;
    const task = async () => {
      const started = Date.now();
      try {
        const result = await this.handleActionInternal(repositoryId, action, generation, panelGeneration);
        if (result) { result.busy = this.activeOperations.has(repositoryId); result.revision = this.revisionByRepository.get(repositoryId) ?? 0; this.rememberSummary(result); }
        if (write) this.gitlabSession.log?.record({ feature: 'git', action: action.type, result: 'success', repositoryPath, exitCode: 0, durationMs: Date.now() - started });
        return result;
      } catch (error) {
        const exitCode = error && typeof error === 'object' && 'exitCode' in error && typeof error.exitCode === 'number' ? error.exitCode : undefined;
        this.gitlabSession.log?.record({ feature: 'git', action: action.type, result: 'error', repositoryPath, exitCode, durationMs: Date.now() - started, message: '版控操作未完成。' });
        throw error;
      }
    };
    const operation = this.gitlabSession.log?.run('git', action.type, { repositoryPath }, task) ?? task();
    if (!write) this.readTasks.set(readKey, operation);
    try { return await operation; }
    finally {
      if (!write && this.readTasks.get(readKey) === operation) this.readTasks.delete(readKey);
      if (generation !== undefined && this.readGenerations.get(readKey) === generation) this.readGenerations.delete(readKey);
      if (write) this.pendingActions--;
      if (managed) {
        const remaining = (this.managedRefreshes.get(repositoryId) ?? 1) - 1;
        if (remaining) this.managedRefreshes.set(repositoryId, remaining);
        else this.managedRefreshes.delete(repositoryId);
        this.emitter.fire();
      }
    }
  }

  private async handleActionInternal(repositoryId: string, action: GitAction, selectionGeneration?: number, panelGeneration?: number): Promise<GitRepositorySnapshot | undefined> {
    await this.initialization;
    const selected = () => !this.disposed && (selectionGeneration === undefined || this.selectionGenerations.get(repositoryId) === selectionGeneration) &&
      (panelGeneration === undefined || panelGeneration === this.activePanelGeneration && this.activePanelRepositoryId === repositoryId);
    if (!isGitWriteAction(action) && !selected()) return undefined;
    const repository = this.findRepository(repositoryId);
    if (!repository) throw new Error('找不到這個 VS Code 工作區 Repo。');
    this.actionTraceHandler?.({ phase: 'start', repositoryId, action: action.type });
    const read = (task: () => Promise<GitRepositorySnapshot>) => withGitDirectoryLock(repository.rootUri.fsPath, async () => {
      if (!selected()) return undefined;
      await this.requireRepository(repositoryId);
      return task();
    });
    if (action.type === 'readDiff') return read(() => this.readDiff(repository, repositoryId, action));
    if (action.type === 'history') return read(() => this.loadHistory(repository, repositoryId, action));
    if (action.type === 'readCommit') return read(() => this.readCommit(repository, repositoryId, action));
    if (action.type === 'rebasePreview' && !action.pullSource) return read(() => this.loadRebasePlan(repository, repositoryId, action.ref));
    if (action.type === 'rebasePreview') return withGitDirectoryLock(repository.rootUri.fsPath, async () => {
      await this.requireRepository(repositoryId);
      if (action.pullSource) {
        const source = { remote: this.checkedRemoteName(repository, action.pullSource.remote), branch: checkedGitRef(action.pullSource.branch) };
        await repository.fetch({ remote: source.remote, ref: 'refs/heads/' + source.branch });
        await repository.status();
        this.invalidateRepository(repositoryId);
      }
      return this.loadRebasePlan(repository, repositoryId, action.ref);
    });
    if (action.type === 'open' && action.repoId !== repositoryId) {
      throw new Error('所選 Repo 已變更，請從側欄重新選擇。');
    }
    if (action.type === 'refresh' || action.type === 'open') return this.getSnapshot(repositoryId, true, panelGeneration);
    await this.requireRepository(repositoryId);
    const affectedPaths = 'path' in action ? [action.path] : undefined;
    return withGitDirectoryLock(repository.rootUri.fsPath, async () => {
      await repository.status();
      if (this.activeOperations.has(repositoryId)) throw new Error('此 Repo 正在執行版控操作，請稍後再試。');
      const ongoing = this.operationFor(repository);
      if (ongoing && !['stageFile', 'stagePatch', 'abort', 'continue', 'skip'].includes(action.type)) {
        throw new Error('此 Repo 有尚未完成的 ' + ongoing + ' 操作。請先解決衝突，再繼續、中止或略過。');
      }
      if (ongoing === 'stash-conflict' && ['abort', 'continue', 'skip'].includes(action.type)) {
        throw new Error('Stash 套用衝突已保留原 Stash；請解決檔案後標記為已暫存。');
      }
      if (this.needsSavedEditorCheck(action) && !await this.confirmSavedEditors(repository, affectedPaths)) return this.readSnapshot(repository, repositoryId);
      this.activeOperations.add(repositoryId);
      this.bump(repositoryId);
      this.publishRepositoryState(repositoryId);
      try {
        const completed = await this.performAction(repository, repositoryId, action);
        await repository.status();
        this.invalidateRepository(repositoryId);
        const snapshot = await this.readSnapshot(repository, repositoryId);
        if (action.type === 'commit') snapshot.commitCompleted = completed === true;
        this.actionTraceHandler?.({ phase: 'complete', repositoryId, action: action.type });
        return snapshot;
      } catch (error) {
        this.actionTraceHandler?.({ phase: 'error', repositoryId, action: action.type, error: readableGitError(error) });
        throw error;
      } finally {
        this.activeOperations.delete(repositoryId);
        this.bump(repositoryId);
        this.publishRepositoryState(repositoryId);
      }
    });
  }

  async listRepositories(): Promise<GitRepositorySummary[]> { return this.refresh(); }

  dispose(): void {
    this.disposed = true;
    this.activePanelRepositoryId = undefined;
    this.activePanelGeneration++;
    this.refreshScheduler.dispose();
    for (const subscription of this.subscriptions.splice(0)) subscription.dispose();
    for (const subscription of this.repositorySubscriptions.values()) subscription.dispose();
    this.repositorySubscriptions.clear();
    this.emitter.dispose();
    this.repositoryListEmitter.dispose();
    this.panelEmitter.dispose();
  }

  private async initialize(): Promise<void> {
    this.repositoryExtension = vscode.extensions.getExtension<GitExtension>(API_EXTENSION_ID);
    if (!this.repositoryExtension) {
      this.error = '請安裝或啟用 VS Code 內建 Git 擴充功能。';
      this.enabled = false;
      return;
    }
    try {
      const extension = this.repositoryExtension.isActive
        ? this.repositoryExtension.exports
        : await this.repositoryExtension.activate();
      if (!extension?.enabled) {
        this.error = '請在 VS Code 擴充功能中啟用內建 Git。';
        this.enabled = false;
        this.subscriptions.push(extension.onDidChangeEnablement((enabled) => {
          this.enabled = enabled;
          if (enabled) void this.initializeApi();
          this.publishRepositories();
        }));
        return;
      }
      await this.attachApi(extension);
    } catch (error) {
      this.error = readableGitError(error);
      this.enabled = false;
    }
  }

  private async initializeApi(): Promise<void> {
    try {
      if (!this.repositoryExtension) return;
      const extension = this.repositoryExtension.isActive
        ? this.repositoryExtension.exports
        : await this.repositoryExtension.activate();
      if (extension?.enabled) await this.attachApi(extension);
    } catch (error) {
      this.enabled = false;
      this.error = readableGitError(error);
    }
    this.publishRepositories();
  }

  private async attachApi(extension: GitExtension): Promise<void> {
    const api = extension.getAPI(1);
    this.api = api;
    this.enabled = true;
    this.error = undefined;
    this.subscriptions.push(
      api.onDidOpenRepository((repository) => {
        this.reconcileRepositorySubscription(repository);
        void this.trackRepository(repository).status().then(() => this.publishRepositories()).catch(() => this.publishRepositories());
      }),
      api.onDidCloseRepository((repository) => {
        const id = this.repositoryId(repository.rootUri.fsPath);
        this.repositorySubscriptions.get(id)?.dispose();
        this.repositorySubscriptions.delete(id);
        this.refreshScheduler.cancel(id);
        this.invalidateRepository(id);
        this.publishRepositories();
      }),
      api.onDidChangeState((state) => {
        this.enabled = state === 'initialized';
        if (this.enabled) {
          for (const repository of api.repositories) this.reconcileRepositorySubscription(repository);
          this.publishRepositories();
        }
      }),
      extension.onDidChangeEnablement((enabled) => {
        this.enabled = enabled && api.state === 'initialized';
        this.publishRepositories();
      })
    );
    if (api.state === 'uninitialized') {
      await new Promise<void>((resolve) => {
        const subscription = api.onDidChangeState((state) => {
          if (state !== 'initialized') return;
          subscription.dispose();
          resolve();
        });
        this.subscriptions.push(subscription);
        setTimeout(() => { subscription.dispose(); resolve(); }, 10_000).unref?.();
      });
    }
    this.enabled = api.state === 'initialized';
    for (const repository of api.repositories) this.reconcileRepositorySubscription(repository);
    this.publishRepositories();
  }

  private reconcileRepositorySubscription(repository: GitRepository, knownId?: string): void {
    const id = knownId ?? this.repositoryId(repository.rootUri.fsPath);
    if (this.repositorySubscriptions.has(id)) return;
    this.repositorySubscriptions.set(id, repository.state.onDidChange(() => {
      if (this.disposed) return;
      this.nativeStatusEvents++;
      const fingerprint = this.repositoryFingerprint(repository);
      if (this.stateFingerprints.get(id) === fingerprint) return;
      this.stateFingerprints.set(id, fingerprint);
      this.invalidateRepository(id);
      this.bump(id);
      this.publishRepositoryState(id);
      if (this.activePanelRepositoryId === id && !this.managedRefreshes.has(id)) this.refreshScheduler.notify(id);
    }));
  }

  private async sendRepositoryUpdate(repositoryId: string): Promise<void> {
    if (this.disposed || this.activePanelRepositoryId !== repositoryId || this.managedRefreshes.has(repositoryId)) return;
    const generation = this.activePanelGeneration;
    try {
      const snapshot = await this.getSnapshot(repositoryId, false, generation);
      if (!this.disposed && this.activePanelRepositoryId === repositoryId && this.activePanelGeneration === generation) this.panelEmitter.fire({ type: 'gitSnapshot', snapshot });
    } catch {
      // A repository can disappear while a filesystem watcher reports a change.
    }
  }

  private async refreshDirtySummaries(): Promise<void> {
    if (this.dirtySummaryRefresh) return this.dirtySummaryRefresh;
    const listRevision = this.repositoryListRevision;
    const ids = [...this.dirtySummaryIds].filter((id) => !this.managedRefreshes.has(id));
    const task = mapWithConcurrency(ids, 4, async (id) => {
      const stateRevision = this.revisionByRepository.get(id) ?? 0;
      const repository = this.findRepository(id);
      if (!repository) return { id, stateRevision, summary: undefined };
      try { return { id, stateRevision, summary: await withGitDirectoryLock(repository.rootUri.fsPath, () => this.buildSummary(repository, id)) }; }
      catch { return { id, stateRevision, summary: undefined }; }
    }).then((updates) => {
      if (listRevision !== this.repositoryListRevision) return;
      for (const update of updates) {
        if ((this.revisionByRepository.get(update.id) ?? 0) !== update.stateRevision) continue;
        if (update.summary) {
          const index = this.cachedSummaries.findIndex((summary) => summary.id === update.id);
          if (index >= 0) this.cachedSummaries[index] = update.summary;
          else this.cachedSummaries.push(update.summary);
        }
        this.dirtySummaryIds.delete(update.id);
      }
      this.cachedSummaries.sort((first, second) =>
        first.name.localeCompare(second.name, 'en-US', { sensitivity: 'base' }) || first.path.localeCompare(second.path));
    });
    this.dirtySummaryRefresh = task;
    try { await task; }
    finally {
      if (this.dirtySummaryRefresh === task) {
        this.dirtySummaryRefresh = undefined;
      }
    }
  }

  private publishRepositories(): void {
    this.repositoriesRevision++;
    this.repositoryListRevision++;
    this.repositoryListEmitter.fire();
    this.emitter.fire();
  }
  private publishRepositoryState(repositoryId: string): void {
    this.repositoriesRevision++;
    this.dirtySummaryIds.add(repositoryId);
    if (!this.managedRefreshes.has(repositoryId)) this.emitter.fire();
  }
  private bump(repositoryId: string): void {
    this.revisionByRepository.set(repositoryId, (this.revisionByRepository.get(repositoryId) ?? 0) + 1);
  }

  private invalidateRepository(id: string): void {
    this.dataEpochs.set(id, (this.dataEpochs.get(id) ?? 0) + 1);
    this.summaryCache.delete(id);
    this.historyCache.delete(id);
    this.pullStrategyCache.delete(id);
    this.dirtySummaryIds.add(id);
  }

  private repositoryFingerprint(repository: GitRepository): string {
    const state = repository.state, head = state.HEAD;
    const changes = (entries: GitChangeEntry[]) => entries.map((change) => [change.uri.fsPath, change.status, change.originalUri?.fsPath, change.renameUri?.fsPath]).sort((a, b) => String(a[0]).localeCompare(String(b[0])));
    const refs = state.refs.map((ref) => [ref.name, ref.type, ref.remote, ref.commit]).sort((a, b) => String(a[0]).localeCompare(String(b[0])));
    return this.fingerprint.read(repository.rootUri.fsPath, {
      head: head && { name: head.name, commit: head.commit, ahead: head.ahead ?? 0, behind: head.behind ?? 0, upstream: head.upstream }, refs,
      remotes: state.remotes, index: changes(state.indexChanges), working: changes(state.workingTreeChanges), conflicts: changes(state.mergeChanges), rebase: state.rebaseCommit
    }, [...state.indexChanges, ...state.workingTreeChanges, ...state.mergeChanges].map((change) => change.uri.fsPath), head?.commit?.length === 64 ? 32 : 20);
  }

  private rememberSummary(snapshot: GitRepositorySnapshot): void {
    const index = this.cachedSummaries.findIndex((summary) => summary.id === snapshot.id);
    if (index >= 0) this.cachedSummaries[index] = snapshot;
    this.dirtySummaryIds.delete(snapshot.id);
  }

  private async historyPage(repository: GitRepository, id: string, ref?: string, skip = 0): Promise<{ history: GitCommitSummary[]; hasMore: boolean }> {
    const epoch = this.dataEpochs.get(id) ?? 0;
    let cache = this.historyCache.get(id);
    if (!cache || cache.epoch !== epoch) { cache = { epoch, pages: new Map() }; this.historyCache.set(id, cache); }
    const key = (ref ?? '--all') + ':' + skip;
    const existing = cache.pages.get(key);
    if (existing) return existing;
    const args = ['log', '--topo-order', ...(ref ? [ref] : ['--all']), '--date=iso-strict', '--format=%H%x00%P%x00%an%x00%aI%x00%s', '-n', String(HISTORY_PAGE_SIZE + 1)];
    if (skip) args.push('--skip=' + skip);
    const hasCommits = !!repository.state.HEAD?.commit || repository.state.refs.some((item) => !!item.commit);
    const commits = hasCommits ? parseGitHistory((await this.runGit(repository, args)).stdout) : [];
    const value = { history: commits.slice(0, HISTORY_PAGE_SIZE), hasMore: commits.length > HISTORY_PAGE_SIZE };
    cache.pages.set(key, value);
    return value;
  }

  private async requireRepository(repositoryId: string): Promise<GitRepository> {
    const api = this.api;
    if (!api || !this.enabled) throw new Error(this.error ?? 'VS Code 內建 Git 尚未準備完成。');
    if (!repositoryId || repositoryId.length > 128) throw new Error('版控 Repo 識別碼無效。');
    const repository = this.findRepository(repositoryId);
    if (!repository) throw new Error('找不到這個 VS Code 工作區 Repo，請重新整理清單。');
    const realRoot = this.pathKey(repository.rootUri.fsPath);
    this.auxiliaryGitCommandCount++;
    const verifiedRoot = this.pathKey(await logGitCommand(['rev-parse'], realRoot, () => execFileAsync(api.git.path, ['-C', realRoot, 'rev-parse', '--show-toplevel'], {
      windowsHide: true, timeout: 5000, maxBuffer: 1024 * 1024
    }), this.gitlabSession.log).then(({ stdout }) => stdout.trim()));
    if (realRoot !== verifiedRoot) throw new Error('Repo 路徑已變更，請重新整理清單。');
    return repository;
  }

  private findRepository(repositoryId: string): GitRepository | undefined {
    const repository = this.api?.repositories.find((repository) => this.repositoryId(repository.rootUri.fsPath) === repositoryId);
    return repository ? this.trackRepository(repository) : undefined;
  }

  private repositoryId(repositoryPath: string): string {
    return createHash('sha256').update(this.pathKey(repositoryPath)).digest('hex').slice(0, 32);
  }

  private pathKey(repositoryPath: string): string {
    const normalized = realpathSync.native(repositoryPath);
    return process.platform === 'win32' ? normalized.toLocaleLowerCase('en-US') : normalized;
  }

  private async buildSummary(repository: GitRepository, id: string): Promise<GitRepositorySummary> {
    const epoch = this.dataEpochs.get(id) ?? 0;
    const cached = this.summaryCache.get(id);
    if (cached?.epoch === epoch) return { ...cached.value, busy: this.activeOperations.has(id) };
    const value = await this.readSummary(repository, id);
    if ((this.dataEpochs.get(id) ?? 0) === epoch) this.summaryCache.set(id, { epoch, value });
    return value;
  }

  private async readSummary(repository: GitRepository, id: string): Promise<GitRepositorySummary> {
    const head = repository.state.HEAD;
    const currentName = await this.runGit(repository, ['symbolic-ref', '--quiet', '--short', 'HEAD'])
      .then(({ stdout }) => stdout.trim() || undefined, () => undefined);
    const [rawBranches, tagOutput] = await Promise.all([
      repository.getBranches({ remote: true, count: 1200 }),
      this.runGit(repository, ['for-each-ref', '--format=%(refname:short)%00%(*objectname)%00%(objectname)', 'refs/tags'])
    ]);
    const tagRefs: GitRef[] = tagOutput.stdout.split(/\r?\n/).flatMap((line) => {
      const [name, peeled, object] = line.split('\0');
      return name ? [{ name, commit: peeled || object, type: 2 }] : [];
    });
    const branches: GitBranchSummary[] = [...rawBranches, ...tagRefs].flatMap<GitBranchSummary>((ref) => {
      const name = gitRefName(ref);
      if (!name) return [];
      if (ref.type === 0) return [{ name, kind: 'local' as const, current: !!currentName && name === currentName, commit: ref.commit }];
      if (ref.type === 1) {
        if (ref.remote && name === ref.remote + '/HEAD') return [];
        return [{ name, kind: 'remote' as const, current: false, commit: ref.commit }];
      }
      if (ref.type === 2) return [{ name, kind: 'tag' as const, current: false, commit: ref.commit }];
      return [];
    }).slice(0, 1200);
    const changes = this.changes(repository);
    const tracked = head?.upstream ?? undefined;
    const status = repository.state;
    let error: undefined | string;
    let stashes: GitStashSummary[] = [];
    try { stashes = parseStashes((await this.runGit(repository, ['stash', 'list', '--format=%H%x00%gd%x00%s'])).stdout).slice(0, 100); }
    catch (caught) { error = readableGitError(caught); }
    const recoveryRefs = parseRecoveryRefs((await this.runGit(repository, ['for-each-ref', '--format=%(refname:short)%00%(objectname)%00%(committerdate:iso-strict)%00%(subject)', 'refs/gitlab-workspace/backups'])).stdout).slice(0, 100);
    void error;
    return {
      id,
      name: path.basename(repository.rootUri.fsPath) || repository.rootUri.fsPath,
      path: repository.rootUri.fsPath,
      branch: currentName,
      headCommit: head?.commit,
      tracking: tracked ? tracked.remote + '/' + tracked.name : undefined,
      ahead: head?.ahead,
      behind: head?.behind,
      stagedCount: status.indexChanges.length,
      unstagedCount: status.workingTreeChanges.length,
      conflictCount: status.mergeChanges.length,
      busy: this.activeOperations.has(id),
      branches,
      stashes,
      recoveryRefs
    };
  }

  private changes(repository: GitRepository): GitChange[] {
    const root = path.resolve(repository.rootUri.fsPath);
    const classify = (entries: GitChangeEntry[], section: GitChange['section']): GitChange[] =>
      entries.flatMap((entry) => {
        const absolute = path.resolve(entry.uri.fsPath);
        const relativePath = path.relative(root, absolute);
        if (!relativePath || relativePath === '..' || relativePath.startsWith('..' + path.sep) || path.isAbsolute(relativePath)) return [];
        const original = entry.originalUri?.fsPath ?? entry.renameUri?.fsPath;
        return [{
          path: relativePath.split(path.sep).join('/'),
          originalPath: original ? path.relative(root, original).split(path.sep).join('/') : undefined,
          section,
          kind: gitStatusLabel(entry.status)
        }];
      });
    return [
      ...classify(repository.state.mergeChanges, 'conflict'),
      ...classify(repository.state.indexChanges, 'staged'),
      ...classify(repository.state.workingTreeChanges, 'unstaged')
    ];
  }

  private operationFor(repository: GitRepository): string | undefined {
    const gitDirectory = gitDirectoryForRepository(repository.rootUri.fsPath);
    if (repository.state.rebaseCommit || gitDirectory &&
        (existsSync(path.join(gitDirectory, 'rebase-merge')) || existsSync(path.join(gitDirectory, 'rebase-apply')))) return 'rebase';
    if (gitDirectory && existsSync(path.join(gitDirectory, 'MERGE_HEAD'))) return 'merge';
    if (gitDirectory && existsSync(path.join(gitDirectory, 'CHERRY_PICK_HEAD'))) return 'cherry-pick';
    if (gitDirectory && (existsSync(path.join(gitDirectory, 'REVERT_HEAD')) || existsSync(path.join(gitDirectory, 'sequencer')))) return 'revert';
    if (repository.state.mergeChanges.length > 0) return 'stash-conflict';
    return undefined;
  }

  private async readDiff(
    repository: GitRepository,
    repositoryId: string,
    action: Extract<GitAction, { type: 'readDiff' }>
  ): Promise<GitRepositorySnapshot> {
    await this.loadDiff(repository, repositoryId, action);
    this.bump(repositoryId);
    return this.readSnapshot(repository, repositoryId);
  }

  private async loadDiff(repository: GitRepository, repositoryId: string, action: Extract<GitAction, { type: 'readDiff' }>): Promise<void> {
    const targetPath = this.safeRelativePath(repository, action.path);
    const epoch = this.dataEpochs.get(repositoryId) ?? 0;
    const cached = this.lastDiffs.get(repositoryId);
    if (cached && cached.path === targetPath && cached.staged === action.staged && cached.ref === action.ref && cached.parent === action.parent && (action.ref || cached.epoch === epoch)) return;
    let diff: string;
    if (action.ref) {
      await this.assertRef(repository, action.ref);
      await this.assertObjectId(repository, action.ref);
      const parentOutput = (await this.runGit(repository, ['show', '-s', '--format=%P', action.ref])).stdout.trim();
      const parents = parentOutput ? parentOutput.split(/\s+/) : [];
      if (action.parent && !parents.includes(action.parent)) throw new Error('選擇的比較 parent 不屬於這筆提交。');
      const baseRef = action.parent ?? parents[0];
      diff = baseRef
        ? (await this.runGit(repository, ['diff', '--no-ext-diff', baseRef, action.ref, '--', targetPath])).stdout
        : (await this.runGit(repository, ['show', '--format=', '--no-ext-diff', action.ref, '--', targetPath])).stdout;
    } else {
      const workingChange = this.changes(repository).find((change) => change.path === targetPath && change.section === 'unstaged');
      if (!action.staged && workingChange?.kind === '未追蹤') {
        diff = (await this.runGit(repository, ['diff', '--no-index', '--no-ext-diff', '--', process.platform === 'win32' ? 'NUL' : '/dev/null', targetPath], undefined, {}, [1])).stdout;
      } else {
        diff = (await this.runGit(repository, ['diff', ...(action.staged ? ['--cached'] : []), '--no-ext-diff', '--', targetPath])).stdout;
      }
    }
    const encodedLength = Buffer.byteLength(diff, 'utf8');
    const truncated = encodedLength > MAX_DIFF_BYTES;
    const text = truncated ? diff.slice(0, MAX_DIFF_BYTES) + '\n\n差異超過 1 MiB，請按「在編輯器檢視」開啟完整比較。' : diff;
    await this.setLastDiff(repositoryId, targetPath, action.staged, text, action.ref, action.parent, epoch);
  }

  private async loadHistory(
    repository: GitRepository,
    repositoryId: string,
    action: Extract<GitAction, { type: 'history' }>
  ): Promise<GitRepositorySnapshot> {
    if (action.ref) await this.assertRef(repository, action.ref);
    const page = await this.historyPage(repository, repositoryId, action.ref, action.skip);
    this.bump(repositoryId);
    const snapshot = await this.readSnapshot(repository, repositoryId);
    return { ...snapshot, history: page.history, historyHasMore: page.hasMore, historyOffset: action.skip ?? 0 };
  }

  private async readCommit(
    repository: GitRepository,
    repositoryId: string,
    action: Extract<GitAction, { type: 'readCommit' }>
  ): Promise<GitRepositorySnapshot> {
    const key = repositoryId + ':' + action.hash + ':' + (action.parent ?? 'first');
    const cached = this.commitCache.get(key);
    if (cached) {
      this.selectedCommits.set(repositoryId, cached);
      this.bump(repositoryId);
      return this.readSnapshot(repository, repositoryId);
    }
    await this.assertObjectId(repository, action.hash);
    if (action.parent) await this.assertObjectId(repository, action.parent);
    const output = await this.runGit(repository, ['show', '-s', '--date=iso-strict',
      '--format=%H%x00%P%x00%an%x00%aI%x00%s', action.hash]);
    const commit = parseGitHistory(output.stdout)[0];
    if (!commit) throw new Error('無法讀取這筆 Commit。');
    if (action.parent && !commit.parents.includes(action.parent)) throw new Error('選擇的比較 parent 不屬於這筆 Merge Commit。');
    const parent = action.parent ?? commit.parents[0];
    const fileArgs = parent
      ? ['diff-tree', '--no-commit-id', '--name-only', '-r', '-z', parent, action.hash]
      : ['diff-tree', '--root', '--no-commit-id', '--name-only', '-r', '-z', action.hash];
    const files = (await this.runGit(repository, fileArgs)).stdout.split('\0').filter(Boolean)
      .map((item) => this.safeRelativePath(repository, item));
    const value = { commit, files, parent };
    this.selectedCommits.set(repositoryId, value);
    if (this.commitCache.size >= 256) this.commitCache.delete(this.commitCache.keys().next().value!);
    this.commitCache.set(key, value);
    this.bump(repositoryId);
    return this.readSnapshot(repository, repositoryId);
  }

  private async loadRebasePlan(repository: GitRepository, repositoryId: string, target: string): Promise<GitRepositorySnapshot> {
    await this.assertRef(repository, target);
    if (!repository.state.HEAD?.commit) throw new Error('目前 Repo 尚無提交，無法建立 Rebase 預覽。');
    const targetHash = (await this.runGit(repository, ['rev-parse', '--verify', target])).stdout.trim();
    const output = await this.runGit(repository, ['log', '--reverse', '--date=iso-strict',
      '--format=%H%x00%P%x00%an%x00%aI%x00%s', target + '..HEAD']);
    const commits = parseGitHistory(output.stdout);
    if (!commits.length) throw new Error('目標分支與目前分支之間沒有可 Rebase 的提交。');
    const plan = { target, targetHash, commits, containsMerge: commits.some((commit) => commit.parents.length > 1) };
    this.rebasePlans.set(repositoryId, plan);
    this.bump(repositoryId);
    return this.readSnapshot(repository, repositoryId);
  }

  private async lastDiffFor(repositoryId: string): Promise<{ path: string; staged: boolean; ref?: string; parent?: string; text: string; epoch: number } | undefined> {
    return this.lastDiffs.get(repositoryId);
  }

  private readonly lastDiffs = new Map<string, { path: string; staged: boolean; ref?: string; parent?: string; text: string; epoch: number }>();

  private async setLastDiff(repositoryId: string, diffPath: string, staged: boolean, text: string, ref?: string, parent?: string, epoch = this.dataEpochs.get(repositoryId) ?? 0): Promise<void> {
    this.lastDiffs.set(repositoryId, { path: diffPath, staged, ref, parent, text, epoch });
  }

  private async performAction(repository: GitRepository, repositoryId: string, action: GitAction): Promise<void | boolean> {
    switch (action.type) {
      case 'stageFile': {
        const file = this.safeRelativePath(repository, action.path);
        if (action.staged) await this.runGit(repository, ['add', '--', file]);
        else if (repository.state.HEAD?.commit) await this.runGit(repository, ['reset', '--quiet', 'HEAD', '--', file]);
        else await this.runGit(repository, ['rm', '--cached', '--force', '--', file]);
        return;
      }
      case 'stagePatch': {
        const file = this.safeRelativePath(repository, action.path);
        const currentDiff = (await this.runGit(repository, ['diff', ...(action.reverse ? ['--cached'] : []), '--no-ext-diff', '--', file])).stdout;
        if (currentDiff !== action.basedOnDiff) throw new Error('檔案差異已更新，請重新選取要暫存的行。');
        const patch = makeSelectedPatch(currentDiff, file, action.lines);
        if (!patch) throw new Error('選取的差異行已不存在，請重新開啟 Diff。');
        validatePartialPatch(patch, file);
        await this.runGit(repository, ['apply', '--cached', '--unidiff-zero', '--whitespace=nowarn'].concat(action.reverse ? ['--reverse'] : []), patch);
        return;
      }
      case 'commit': {
        const message = checkedGitText(action.message, 'Commit 訊息');
        if (!this.changes(repository).some((change) => change.section === 'staged')) throw new Error('請先在 GUI 選擇要 Commit 的暫存內容。');
        if (action.amend && !repository.state.HEAD?.commit) throw new Error('目前 Repo 尚無提交，無法 Amend。');
        const verb = action.amend ? 'Amend 最近一次 Commit' : 'Commit 已暫存的變更';
        const stagedPaths = this.changes(repository).filter((change) => change.section === 'staged').map((change) => change.path);
        const confirmed = await this.showWarningMessage(
          verb + ' 至 ' + repository.rootUri.fsPath + '？' +
          (action.amend ? '\n原提交：' + (repository.state.HEAD?.commit ?? '').slice(0, 12) + '\n這會改寫目前分支歷史。' : '') +
          '\n暫存檔案：\n' + stagedPaths.join('\n'),
          { modal: true },
          action.amend ? 'Amend Commit' : 'Commit'
        );
        if (!confirmed) return false;
        if (action.amend) await this.createRecoveryRef(repository, 'amend');
        await repository.commit(message, { all: false, amend: action.amend, useEditor: false });
        return true;
      }
      case 'branch': {
        const name = checkedGitRef(action.name);
        if (repository.state.HEAD && !this.changes(repository).every((change) => change.section === 'staged')) {
          // Creating a branch is safe while tracked working changes remain in the worktree.
        }
        await repository.createBranch(name, true);
        return;
      }
      case 'checkout': {
        await this.assertRef(repository, action.name);
        await repository.checkout(action.name);
        return;
      }
      case 'deleteBranch': {
        checkedGitRef(action.name);
        if (repository.state.HEAD?.name === action.name) throw new Error('無法刪除目前選取的分支。');
        const yes = await this.showWarningMessage('刪除本機分支 ' + action.name + '？', { modal: true }, '刪除分支');
        if (yes) await repository.deleteBranch(action.name, false);
        return;
      }
      case 'fetch': {
        await repository.fetch({ remote: this.checkedRemoteName(repository, action.remote), prune: false });
        return;
      }
      case 'pull': {
        const remote = this.checkedRemoteName(repository, action.remote);
        const branch = checkedGitRef(action.branch);
        const target = 'refs/remotes/' + remote + '/' + branch;
        const config = action.strategy === 'configured' ? await this.configuredPullStrategy(repository) : action.strategy;
        if (config === 'interactive') throw new Error('Repo 設定為 pull.rebase=interactive。請使用版控工作台的 Rebase 預覽、編輯提交 todo，再選擇 upstream 分支。');
        await repository.fetch({ remote, ref: 'refs/heads/' + branch });
        await repository.status();
        const pullTarget = (await this.runGit(repository, ['rev-parse', '--verify', target])).stdout.trim();
        const plan = describePull(repository.rootUri.fsPath, remote, branch, config, pullTarget);
        const yes = await this.showWarningMessage(plan, { modal: true }, 'Pull');
        if (!yes) return;
        if (config === 'rebase' || config === 'rebase-merges') {
          const flags = config === 'rebase-merges' ? ['--rebase-merges'] : [];
          await this.createRecoveryRef(repository, 'pull-rebase');
          await this.runGit(repository, ['rebase', ...flags, target]);
        } else {
          const mergeFlags = config === 'ff-only' ? ['--ff-only', '--no-edit'] : ['--no-edit'];
          await this.runGit(repository, ['merge', ...mergeFlags, target]);
        }
        return;
      }
      case 'push': {
        const remote = this.checkedRemoteName(repository, action.remote);
        const branch = checkedGitRef(action.branch);
        const target = 'refs/heads/' + branch;
        // Query the server directly: some VS Code Git API versions turn a missing new branch into an opaque fetch failure.
        const expected = await this.remoteBranchSha(repository, remote, target);
        const current = await this.runGit(repository, ['rev-parse', 'HEAD']);
        const outgoing = await this.runGit(repository, expected
          ? ['log', '--reverse', '--format=%h %s', expected + '..HEAD']
          : ['log', '--reverse', '--format=%h %s', 'HEAD']);
        const replaced = action.force && expected
          ? await this.runGit(repository, ['log', '--reverse', '--format=%h %s', 'HEAD..' + expected])
          : undefined;
        const yes = await this.showWarningMessage(
          (action.force ? 'Force Push' : 'Push') + ' ' + current.stdout.trim().slice(0, 12) +
          ' 至 ' + remote + ':' + branch + (expected ? '（遠端目前 ' + expected.slice(0, 12) + '）' : '（建立新遠端分支）') +
          '\nRepo：' + repository.rootUri.fsPath + '\n將傳送的提交：\n' + (outgoing.stdout.trim() || '沒有新提交。') +
          (replaced ? '\nForce Push 會移除遠端分支上的提交：\n' + (replaced.stdout.trim() || '沒有額外提交。') : ''),
          { modal: true }, action.force ? 'Force Push' : 'Push'
        );
        if (!yes) return;
        const args = ['push'];
        if (action.force) args.push('--force-with-lease=' + target + ':' + (expected ?? ''));
        if (action.setUpstream) args.push('--set-upstream');
        args.push(remote, 'HEAD:' + target);
        try {
          await this.runGit(repository, args);
        } catch (error) {
          let remoteCheckFailed = false;
          let confirmedRemoteSha: string | undefined;
          try { confirmedRemoteSha = await this.remoteBranchSha(repository, remote, target); }
          catch { remoteCheckFailed = true; }
          if (!remoteCheckFailed && confirmedRemoteSha === current.stdout.trim()) return;
          if (remoteCheckFailed) throw new Error('Push 結果未能確認；目前無法連線核對遠端分支。請先 Fetch 或檢查網路狀態，再決定是否重試。');
          if (confirmedRemoteSha !== expected) {
            throw new Error('Push 結果未能確認；遠端分支 SHA 已變更。請先 Fetch 並檢查遠端狀態，再決定是否重試。');
          }
          throw error;
        }
        return;
      }
      case 'merge': {
        await this.assertRef(repository, action.ref);
        await this.runGit(repository, ['merge', '--no-edit', action.ref]);
        return;
      }
      case 'rebase': {
        await this.assertRef(repository, action.ref);
        let plan: GitRebasePlan | undefined;
        if (action.interactive) {
          plan = await this.readRebasePlan(repository, action.ref);
          this.assertRebaseTodo(plan, action.todo);
          if (plan.targetHash !== action.expectedTargetHash) throw new Error('Rebase 目標已在預覽後變更，請重新 Fetch 並檢視提交範圍。');
        }
        const heads = await this.runGit(repository, ['rev-parse', 'HEAD']);
        const mergeNotice = plan?.containsMerge ? '\n預覽範圍含 Merge Commit；互動式 Rebase 會採標準線性歷史並展平合併結構。' : '';
        const pullNotice = action.pullSource ? '\n將先 Fetch ' + action.pullSource.remote + '/' + action.pullSource.branch + '。' : '';
        const yes = await this.showWarningMessage(
          '將 ' + (repository.state.HEAD?.name ?? '目前的 detached HEAD') + ' Rebase 到 ' + action.ref +
          '。新的提交 SHA 會取代原提交（目前 HEAD：' + heads.stdout.trim().slice(0, 12) + '）。' + mergeNotice + pullNotice,
          { modal: true }, action.interactive ? '開始互動式 Rebase' : 'Rebase'
        );
        if (!yes) return;
        if (action.pullSource) {
          const source = { remote: this.checkedRemoteName(repository, action.pullSource.remote), branch: checkedGitRef(action.pullSource.branch) };
          await repository.fetch({ remote: source.remote, ref: 'refs/heads/' + source.branch });
          await repository.status();
          const updatedPlan = await this.readRebasePlan(repository, action.ref);
          if (plan && !sameRebasePlan(plan, updatedPlan)) throw new Error('遠端分支在預覽後已更新；Fetch 已完成但尚未開始 Rebase，請重新檢視提交清單。');
          if (plan) plan = updatedPlan;
        }
        await this.createRecoveryRef(repository, action.interactive ? 'interactive-rebase' : 'rebase');
        if (action.interactive) {
          const editor = await this.prepareInteractiveRebase(repository, action.todo ?? []);
          await this.runGit(repository, ['rebase', '--interactive', '--no-autosquash', action.ref], undefined, editor);
          await repository.status();
          if (this.operationFor(repository) !== 'rebase') await this.clearInteractiveRebase(repository);
        } else {
          await this.runGit(repository, ['rebase', '--merge', action.ref]);
        }
        return;
      }
      case 'cherryPick': {
        await this.assertObjectId(repository, action.hash);
        await this.assertMainline(repository, action.hash, action.mainline);
        const yes = await this.showWarningMessage('Cherry-pick ' + action.hash.slice(0, 12) +
          (action.mainline ? '，保留 Parent ' + action.mainline : '') + ' 到目前分支？', { modal: true }, 'Cherry-pick');
        if (!yes) return;
        await this.runGit(repository, ['cherry-pick', '--no-edit', ...(action.mainline ? ['-m', String(action.mainline)] : []), action.hash]);
        return;
      }
      case 'revert': {
        await this.assertObjectId(repository, action.hash);
        await this.assertMainline(repository, action.hash, action.mainline);
        const yes = await this.showWarningMessage('Revert 提交 ' + action.hash.slice(0, 12) +
          (action.mainline ? '，保留 Parent ' + action.mainline : '') + '？', { modal: true }, 'Revert');
        if (!yes) return;
        await this.runGit(repository, ['revert', '--no-edit', ...(action.mainline ? ['-m', String(action.mainline)] : []), action.hash]);
        return;
      }
      case 'stashSave': {
        const message = checkedGitText(action.message, 'Stash 名稱');
        const args = ['stash', 'push', '--include-untracked', '--message', message];
        if (!action.includeUntracked) args.splice(2, 1);
        await this.runGit(repository, args);
        return;
      }
      case 'stashApply': {
        await this.assertObjectId(repository, action.hash);
        const stashes = parseStashes((await this.runGit(repository, ['stash', 'list', '--format=%H%x00%gd%x00%s'])).stdout);
        const selected = stashes.find((stash) => stash.oid === action.hash);
        if (!selected) throw new Error('這筆 Stash 已不存在，請重新整理清單。');
        await this.runGit(repository, ['stash', action.pop ? 'pop' : 'apply', stashReference(selected)]);
        return;
      }
      case 'stashDrop': {
        await this.assertObjectId(repository, action.hash);
        const stashes = parseStashes((await this.runGit(repository, ['stash', 'list', '--format=%H%x00%gd%x00%s'])).stdout);
        const selected = stashes.find((stash) => stash.oid === action.hash);
        if (!selected) throw new Error('這筆 Stash 已不存在，請重新整理清單。');
        const yes = await this.showWarningMessage('刪除 Stash ' + selected.message + '？', { modal: true }, '刪除 Stash');
        if (yes) await this.runGit(repository, ['stash', 'drop', stashReference(selected)]);
        return;
      }
      case 'reset': {
        await this.assertObjectId(repository, action.hash);
        const preview = await this.runGit(repository, ['diff', '--stat', 'HEAD', action.hash]);
        const workingChanges = this.changes(repository).map((change) => change.section.toLocaleUpperCase('en-US') + ' ' + change.path);
        const yes = await this.showWarningMessage(
          action.mode.toLocaleUpperCase('en-US') + ' Reset Repo ' + repository.rootUri.fsPath + '\n目標：' + action.hash.slice(0, 12) +
          '\n' + (preview.stdout.trim() || '提交與目前 HEAD 相同，或沒有檔案差異。') +
          (workingChanges.length ? '\n目前工作目錄變更：\n' + workingChanges.join('\n') : '') +
          (action.mode === 'hard' ? '\n會先建立復原 ref 和 Stash，保存目前未提交變更。' : ''),
          { modal: true }, 'Reset'
        );
        if (!yes) return;
        await this.createRecoveryRef(repository, 'reset');
        if (action.mode === 'hard' && this.changes(repository).length > 0) {
          await this.runGit(repository, ['stash', 'push', '--include-untracked', '--message',
            'GitLab Workspace 復原點 ' + new Date().toISOString()]);
        }
        await this.runGit(repository, ['reset', '--' + action.mode, action.hash]);
        return;
      }
      case 'discard': {
        const file = this.safeRelativePath(repository, action.path);
        const change = this.changes(repository).find((item) => item.path === file && item.section !== 'staged');
        if (!change) throw new Error('找不到這筆未暫存變更，請重新整理清單。');
        const yes = await this.showWarningMessage('將變更 ' + file + ' 存入復原 Stash，並還原目前檔案？', { modal: true }, '備份並還原');
        if (!yes) return;
        await this.runGit(repository, ['stash', 'push', '--include-untracked', '--keep-index', '--message',
          'GitLab Workspace 復原點 ' + new Date().toISOString(), '--', file]);
        return;
      }
      case 'abort':
        if (this.operationFor(repository) === 'rebase') await this.runGit(repository, ['rebase', '--abort']);
        else if (this.operationFor(repository) === 'merge') await repository.mergeAbort();
        else if (this.operationFor(repository) === 'cherry-pick') await this.runGit(repository, ['cherry-pick', '--abort']);
        else if (this.operationFor(repository) === 'revert') await this.runGit(repository, ['revert', '--abort']);
        else throw new Error('此 Repo 沒有可中止的 Git 操作。');
        await this.clearInteractiveRebase(repository);
        return;
      case 'continue':
        if (this.operationFor(repository) === 'rebase') {
          const editor = await this.interactiveRebaseEnvironment(repository);
          await this.runGit(repository, ['rebase', '--continue'], undefined,
            editor.GITLABWORKSPACE_REBASE_UI_FILE ? editor : { GIT_EDITOR: 'true' });
          await repository.status();
          if (!repository.state.rebaseCommit) await this.clearInteractiveRebase(repository);
        }
        else if (this.operationFor(repository) === 'merge') await this.runGit(repository, ['-c', 'core.editor=true', 'merge', '--continue']);
        else if (this.operationFor(repository) === 'cherry-pick') await this.runGit(repository, ['-c', 'core.editor=true', 'cherry-pick', '--continue']);
        else if (this.operationFor(repository) === 'revert') await this.runGit(repository, ['-c', 'core.editor=true', 'revert', '--continue']);
        else throw new Error('目前沒有可繼續的操作。');
        return;
      case 'skip':
        if (this.operationFor(repository) !== 'rebase' || !repository.state.rebaseCommit) throw new Error('Skip 僅適用於進行中的 Rebase。');
        await this.advanceInteractiveEditorQueueForSkippedCommit(repository, repository.state.rebaseCommit.hash);
        await this.runGit(repository, ['rebase', '--skip']);
        await repository.status();
        if (!repository.state.rebaseCommit) await this.clearInteractiveRebase(repository);
        return;
      default:
        throw new Error('這項版控操作尚未支援。');
    }
  }

  private async remoteBranchSha(repository: GitRepository, remote: string, branch: string): Promise<string | undefined> {
    const output = await this.runGit(repository, ['ls-remote', '--heads', remote, branch]);
    const oid = output.stdout.trim().split(/\s+/, 1)[0];
    return /^[a-f0-9]{40,64}$/i.test(oid) ? oid : undefined;
  }

  private async readRebasePlan(repository: GitRepository, target: string): Promise<GitRebasePlan> {
    await this.assertRef(repository, target);
    const targetHash = (await this.runGit(repository, ['rev-parse', '--verify', target])).stdout.trim();
    const output = await this.runGit(repository, ['log', '--reverse', '--date=iso-strict',
      '--format=%H%x00%P%x00%an%x00%aI%x00%s', target + '..HEAD']);
    const commits = parseGitHistory(output.stdout);
    if (!commits.length) throw new Error('目標分支與目前分支之間沒有可 Rebase 的提交。');
    return { target, targetHash, commits, containsMerge: commits.some((commit) => commit.parents.length > 1) };
  }

  private assertRebaseTodo(plan: GitRebasePlan, todo?: GitRebaseTodoEntry[]): asserts todo is GitRebaseTodoEntry[] {
    if (!todo?.length || todo.length !== plan.commits.length) throw new Error('互動式 Rebase todo 必須包含預覽中的每筆提交。');
    const available = new Set(plan.commits.map((commit) => commit.hash.toLocaleLowerCase('en-US')));
    const selected = new Set<string>();
    for (const item of todo) {
      const hash = item.hash.toLocaleLowerCase('en-US');
      if (!available.has(hash) || selected.has(hash)) throw new Error('互動式 Rebase todo 含有重複或不屬於此範圍的提交。');
      selected.add(hash);
      if (item.action === 'reword' || item.action === 'squash') checkedGitText(item.message ?? '', item.action === 'reword' ? 'Reword 提交訊息' : 'Squash 後提交訊息');
    }
    const firstApplied = todo.find((item) => item.action !== 'drop');
    if (firstApplied?.action === 'squash' || firstApplied?.action === 'fixup') throw new Error('第一筆保留的提交需使用 Pick、Reword 或 Edit。');
    if (todo.every((item) => item.action === 'drop')) throw new Error('todo 不能丟棄全部提交。');
  }

  private async createRecoveryRef(repository: GitRepository, reason: string): Promise<void> {
    const head = await this.runGit(repository, ['rev-parse', '--verify', '--quiet', 'HEAD']).catch(() => undefined);
    const hash = head?.stdout.trim();
    if (!hash) return;
    const label = reason.replace(/[^a-z0-9-]/gi, '-').slice(0, 30);
    const name = 'refs/gitlab-workspace/backups/' + new Date().toISOString().replace(/[:.]/g, '-') + '-' + label + '-' + randomUUID().slice(0, 8);
    await this.runGit(repository, ['update-ref', name, hash]);
  }

  private async interactiveRebaseStatePath(repository: GitRepository): Promise<string> {
    const output = await this.runGit(repository, ['rev-parse', '--git-path', 'gitlab-workspace/rebase-ui.json']);
    return path.resolve(repository.rootUri.fsPath, output.stdout.trim());
  }

  private async prepareInteractiveRebase(repository: GitRepository, todo: GitRebaseTodoEntry[]): Promise<NodeJS.ProcessEnv> {
    const statePath = await this.interactiveRebaseStatePath(repository);
    await mkdir(path.dirname(statePath), { recursive: true });
    const state = {
      todo: todo.map((item) => ({ hash: item.hash, action: item.action })),
      editorMessages: todo.filter((item) => item.action === 'reword' || item.action === 'squash').map((item) =>
        checkedGitText(item.message ?? '', item.action === 'reword' ? 'Reword 提交訊息' : 'Squash 後提交訊息'))
    };
    await writeFile(statePath, JSON.stringify(state), { encoding: 'utf8', flag: 'w' });
    return this.interactiveRebaseEnvironment(repository);
  }

  private async interactiveRebaseEnvironment(repository: GitRepository): Promise<NodeJS.ProcessEnv> {
    const statePath = await this.interactiveRebaseStatePath(repository);
    if (!existsSync(statePath)) return {};
    const helper = path.join(this.extensionUri.fsPath, 'resources', 'git-rebase-editor.cjs');
    const quote = (value: string): string => '"' + value.replace(/["\\$`]/g, '\\$&') + '"';
    const prefix = quote(process.execPath) + ' ' + quote(helper) + ' ';
    return {
      GITLABWORKSPACE_REBASE_UI_FILE: statePath,
      GIT_SEQUENCE_EDITOR: prefix + 'sequence',
      GIT_EDITOR: prefix + 'message'
    };
  }

  private async clearInteractiveRebase(repository: GitRepository): Promise<void> {
    const statePath = await this.interactiveRebaseStatePath(repository).catch(() => undefined);
    if (!statePath) return;
    await rm(path.dirname(statePath), { recursive: true, force: true });
  }

  private async advanceInteractiveEditorQueueForSkippedCommit(repository: GitRepository, commitHash: string): Promise<void> {
    const statePath = await this.interactiveRebaseStatePath(repository).catch(() => undefined);
    if (!statePath || !existsSync(statePath)) return;
    let state: { todo?: Array<{ hash?: string; action?: string }> };
    try { state = JSON.parse(await readFile(statePath, 'utf8')) as typeof state; }
    catch { throw new Error('Rebase 的 GUI 提交訊息狀態損壞；為避免套用錯誤訊息，已停止 Skip。'); }
    if (!Array.isArray(state.todo)) throw new Error('Rebase todo 狀態無效；已停止 Skip。');
    const skippedIndex = state.todo.findIndex((item) => item.hash?.toLocaleLowerCase('en-US') === commitHash.toLocaleLowerCase('en-US'));
    if (skippedIndex < 0) return;
    const nextIndex = state.todo.slice(0, skippedIndex + 1).filter((item) => item.action === 'reword' || item.action === 'squash').length;
    const indexPath = statePath + '.editor-index';
    const currentIndex = existsSync(indexPath) ? Number(await readFile(indexPath, 'utf8')) : 0;
    if (!Number.isSafeInteger(currentIndex) || currentIndex < 0) throw new Error('Rebase GUI 提交訊息位置無效；已停止 Skip。');
    if (nextIndex > currentIndex) await writeFile(indexPath, String(nextIndex), 'utf8');
  }

  private needsSavedEditorCheck(action: GitAction): boolean {
    switch (action.type) {
      case 'stageFile': case 'stagePatch': case 'discard':
      case 'checkout': case 'pull': case 'merge': case 'rebase': case 'cherryPick': case 'revert':
      case 'stashSave': case 'stashApply': case 'abort': case 'continue': case 'skip':
        return true;
      case 'reset': return action.mode === 'hard';
      default: return false;
    }
  }

  private async confirmSavedEditors(repository: GitRepository, affectedPaths?: string[]): Promise<boolean> {
    const root = path.resolve(repository.rootUri.fsPath);
    const allowed = affectedPaths ? new Set(affectedPaths.map((item) => this.pathKey(path.resolve(root, item)))) : undefined;
    const dirty = vscode.workspace.textDocuments.filter((document) => {
      if (!document.isDirty || document.uri.scheme !== 'file') return false;
      try {
        const file = path.resolve(document.uri.fsPath);
        const relative = path.relative(root, file);
        return relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative) &&
          (!allowed || allowed.has(this.pathKey(file)));
      } catch { return false; }
    });
    if (!dirty.length) return true;
    const names = dirty.map((document) => path.relative(root, document.uri.fsPath)).slice(0, 5).join(', ');
    const choice = await this.showWarningMessage(
      'Repo 有尚未儲存的編輯內容：' + names + (dirty.length > 5 ? ' 等 ' + dirty.length + ' 個檔案' : '') + '。',
      { modal: true }, '儲存並繼續', '取消操作'
    );
    if (choice !== '儲存並繼續') return false;
    for (const document of dirty) if (!await document.save()) throw new Error('有編輯器未能儲存；Git 操作已取消。');
    return true;
  }

  private async configuredPullStrategy(repository: GitRepository): Promise<GitPullStrategy | 'interactive'> {
    const branch = repository.state.HEAD?.name;
    let pullFf = '';
    let branchRebase = '';
    let defaultRebase = '';
    try { pullFf = await repository.getConfig('pull.ff'); } catch { /* Not configured. */ }
    if (branch) {
      try { branchRebase = await repository.getConfig('branch.' + branch + '.rebase'); } catch { /* Not configured. */ }
    }
    try { defaultRebase = await repository.getConfig('pull.rebase'); } catch { /* Not configured. */ }
    if (pullFf.trim().toLocaleLowerCase('en-US') === 'only') return 'ff-only';
    const selected = (branchRebase || defaultRebase).trim().toLocaleLowerCase('en-US');
    if (selected === 'true') return 'rebase';
    if (selected === 'merges' || selected === 'preserve') return 'rebase-merges';
    if (selected === 'interactive') return 'interactive';
    return 'merge';
  }

  private async getParent(repository: GitRepository, ref: string): Promise<string | undefined> {
    const result = await this.runGit(repository, ['rev-parse', '--verify', '--quiet', ref + '^']);
    return result.code === 0 ? result.stdout.trim() : undefined;
  }

  private async runGit(
    repository: GitRepository, arguments_: string[], input?: string,
    environmentOverrides: NodeJS.ProcessEnv = {}, acceptedExitCodes: number[] = []
  ): Promise<GitCommandOutput & { code: number }> {
    const task = () => this.runGitCommand(repository, arguments_, input, environmentOverrides, acceptedExitCodes);
    return this.gitlabSession.log?.run('git', arguments_[0] ?? 'git', { repositoryPath: repository.rootUri.fsPath }, task) ?? task();
  }

  private async runGitCommand(
    repository: GitRepository,
    arguments_: string[],
    input?: string,
    environmentOverrides: NodeJS.ProcessEnv = {},
    acceptedExitCodes: number[] = []
  ): Promise<GitCommandOutput & { code: number }> {
    const gitPath = this.api?.git.path;
    if (!gitPath) throw new Error('VS Code 內建 Git 尚未準備完成。');
    this.executedGitCommandCount++;
    const logStarted = Date.now();
    const child = spawn(gitPath, ['-c', 'core.quotepath=false', ...arguments_], {
      cwd: repository.rootUri.fsPath,
      env: { ...await this.environmentFor(repository), ...environmentOverrides },
      shell: false,
      windowsHide: true,
      stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe']
    });
    return new Promise((resolve, reject) => {
      let stdout = '';
      let stderr = '';
      let completed = false;
      const timeout = setTimeout(() => child.kill(), 120_000);
      const settle = (action: () => void): void => { if (completed) return; completed = true; clearTimeout(timeout); action(); };
      child.stdout?.setEncoding('utf8');
      child.stderr?.setEncoding('utf8');
      child.stdout?.on('data', (chunk: string) => { if (stdout.length < 8_000_000) stdout += chunk.slice(0, 8_000_000 - stdout.length); });
      child.stderr?.on('data', (chunk: string) => { if (stderr.length < 64_000) stderr += chunk.slice(0, 64_000 - stderr.length); });
      child.on('error', (error: Error) => settle(() => {
        this.gitlabSession.log?.record({ feature: 'git', action: arguments_[0] ?? 'git', result: 'error', repositoryPath: repository.rootUri.fsPath, durationMs: Date.now() - logStarted, message: '無法啟動 Git 指令。' });
        reject(error);
      }));
      child.on('close', (code: number | null) => {
        settle(() => {
          const result = { stdout, stderr, code: code ?? -1 };
          this.gitlabSession.log?.record({ feature: 'git', action: arguments_[0] ?? 'git', result: result.code === 0 || acceptedExitCodes.includes(result.code) ? 'success' : 'error', repositoryPath: repository.rootUri.fsPath, exitCode: result.code, durationMs: Date.now() - logStarted });
          if (result.code === 0 || acceptedExitCodes.includes(result.code)) resolve(result);
          else reject(new GitCommandError(result.code, sanitizeGitError(stderr)));
        });
      });
      if (input !== undefined) {
        child.stdin?.end(input);
      }
    });
  }

  private async environmentFor(repository: GitRepository): Promise<NodeJS.ProcessEnv> {
    const environment: NodeJS.ProcessEnv = { ...process.env, GIT_TERMINAL_PROMPT: '0' };
    const credentials = await this.gitlabSession.getCloneCredentials().catch(() => undefined);
    if (!credentials) return environment;
    const projects = this.projectSource();
    const url = repository.state.remotes.flatMap((remote) => [remote.fetchUrl, remote.pushUrl]).find((remote): remote is string =>
      !!remote && projects.some((project) => projectRemoteMatches(remote, project)));
    if (url && url.startsWith('https://') && isAllowedGitRemote(credentials.baseUrl, url)) {
      return createScopedGitEnvironment(url, credentials.token);
    }
    return environment;
  }

  private async readBlob(repository: GitRepository, objectPath: string): Promise<Buffer> {
    const gitPath = this.api?.git.path;
    if (!gitPath) throw new Error('VS Code 內建 Git 尚未準備完成。');
    this.auxiliaryGitCommandCount++;
    const result = await logGitCommand(['show'], repository.rootUri.fsPath, () => execFileAsync(gitPath, ['-C', repository.rootUri.fsPath, 'show', objectPath], {
      encoding: 'buffer', windowsHide: true, timeout: 10_000, maxBuffer: 128 * 1024 * 1024
    }), this.gitlabSession.log) as unknown as { stdout: Buffer };
    return Buffer.isBuffer(result.stdout) ? result.stdout : Buffer.from(result.stdout as unknown as string);
  }

  private checkedRemoteName(repository: GitRepository, remote: string): string {
    if (!remote || remote.length > 500 || remote.startsWith('-') || /[\x00-\x1f\x7f]/.test(remote) ||
        !repository.state.remotes.some((item) => item.name === remote)) {
      throw new Error('請從此 Repo 已設定的遠端清單選擇目標。');
    }
    return remote;
  }

  private safeRelativePath(repository: GitRepository, candidate: string): string {
    if (!candidate || candidate.length > 32767 || candidate.includes('\0')) throw new Error('檔案路徑無效。');
    const root = path.resolve(repository.rootUri.fsPath);
    let realRoot = root;
    try { realRoot = realpathSync.native(root); } catch { /* VS Code Git only registers existing roots. */ }
    const absolute = path.resolve(root, candidate);
    const relative = path.relative(root, absolute);
    if (!relative || relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) {
      throw new Error('檔案必須位於選取的 Repo 內。');
    }
    let existing = absolute;
    while (true) {
      try {
        const resolved = realpathSync.native(existing);
        const realRelative = path.relative(realRoot, resolved);
        if (realRelative === '..' || realRelative.startsWith('..' + path.sep) || path.isAbsolute(realRelative)) {
          throw new Error('Repo 內的連結目標位於工作區外，已停止操作。');
        }
        break;
      } catch (error) {
        if (error instanceof Error && error.message.includes('工作區外')) throw error;
        const parent = path.dirname(existing);
        if (parent === existing) break;
        existing = parent;
      }
    }
    return relative.split(path.sep).join('/');
  }

  private async assertRef(repository: GitRepository, reference: string): Promise<void> {
    if (!reference || reference.length > 1024 || /[\x00-\x20~^:?*[\\]/.test(reference)) {
      throw new Error('Git 分支或提交參照無效。');
    }
    if (reference.startsWith('-') || reference.includes('..')) throw new Error('Git 分支或提交參照無效。');
    if (/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(reference)) return;
    const id = this.repositoryId(repository.rootUri.fsPath);
    const cached = this.summaryCache.get(id);
    const listedBranch = cached?.epoch === (this.dataEpochs.get(id) ?? 0)
      ? cached.value.branches.some((ref) => ref.name === reference)
      : (await repository.getBranches({ remote: true, count: 1200 })).some((ref) => gitRefName(ref) === reference);
    const listedTag = !listedBranch && await this.runGit(repository, ['show-ref', '--verify', '--quiet', 'refs/tags/' + reference])
      .then(() => true, () => false);
    const listed = listedBranch || listedTag;
    if (!listed && !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(reference)) throw new Error('請從此 Repo 的分支或提交清單選擇目標。');
  }

  private async assertObjectId(repository: GitRepository, value: string): Promise<void> {
    if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(value)) throw new Error('Git 提交識別碼無效。');
    const head = repository.state.HEAD?.commit?.toLocaleLowerCase('en-US') === value.toLocaleLowerCase('en-US');
    if (!head) {
      this.auxiliaryGitCommandCount++;
      await logGitCommand(['cat-file'], repository.rootUri.fsPath, () => execFileAsync(this.api!.git.path, ['-C', repository.rootUri.fsPath, 'cat-file', '-e', value + '^{commit}'], {
        windowsHide: true, timeout: 5000, maxBuffer: 1024 * 1024
      }), this.gitlabSession.log).catch(() => { throw new Error('找不到這筆 Repo Commit，請重新載入歷史。'); });
    }
  }

  private async assertMainline(repository: GitRepository, hash: string, mainline?: number): Promise<void> {
    const output = await this.runGit(repository, ['show', '-s', '--format=%P', hash]);
    const parents = output.stdout.trim().split(/\s+/).filter(Boolean);
    if (parents.length > 1 && mainline === undefined) throw new Error('這是 Merge Commit；請回到提交操作視窗，選擇要保留的 mainline parent。');
    if (mainline !== undefined && (!Number.isSafeInteger(mainline) || mainline < 1 || mainline > parents.length)) {
      throw new Error('選取的 mainline parent 不屬於這筆提交。');
    }
  }
}

export class GitCommandError extends Error {
  constructor(readonly exitCode: number, message: string) {
    super(message || 'Git 無法完成這項操作。');
    this.name = 'GitCommandError';
  }
}

function parseGitHistory(output: string): GitCommitSummary[] {
  return output.split(/\r?\n/).filter(Boolean).flatMap((line) => {
    const [hash, parents, author, date, subject] = line.split('\0');
    if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(hash ?? '') || !subject) return [];
    return [{ hash, parents: parents.split(' ').filter(Boolean), author, date, subject }];
  });
}

function parseStashes(output: string): GitStashSummary[] {
  return output.split(/\r?\n/).filter(Boolean).flatMap((line) => {
    const [oid, ref, message] = line.split('\0');
    return oid && /^[a-f0-9]{40,64}$/i.test(oid) ? [{ oid, message: ref + ' · ' + (message ?? '') }] : [];
  });
}

function stashReference(stash: GitStashSummary): string {
  const reference = stash.message.split(' · ', 1)[0];
  if (!/^stash@\{\d+\}$/.test(reference)) throw new Error('無法識別這筆 Stash 的 Git 參照，請重新整理清單。');
  return reference;
}

function parseRecoveryRefs(output: string): GitRecoveryRefSummary[] {
  return output.split(/\r?\n/).filter(Boolean).flatMap((line) => {
    const [name, hash, date, subject] = line.split('\0');
    return name && /^[a-f0-9]{40,64}$/i.test(hash ?? '')
      ? [{ name, hash, date: date ?? '', subject: subject ?? '' }]
      : [];
  });
}

function gitStatusLabel(status: number): string {
  const labels: Record<number, string> = {
    0: '已修改', 1: '新增', 2: '已刪除', 3: '重新命名', 4: '複製',
    5: '已修改', 6: '已刪除', 7: '未追蹤', 8: '已忽略', 9: '待加入',
    10: '類型變更', 11: '合併衝突', 12: '合併衝突', 13: '合併衝突',
    14: '合併衝突', 15: '合併衝突', 16: '合併衝突', 17: '合併衝突'
  };
  return labels[status] ?? '已變更';
}

function checkedGitRef(name: string): string {
  if (!name || name.length > 240 || name.startsWith('-') ||
      /[\x00-\x20~^:?*[\\]|]|(?:\.\.|\/\/|@\{|\.lock$|\/\.|\/$)/.test(name)) {
    throw new Error('分支或 Git 參照名稱無效。');
  }
  return name;
}

function checkedGitText(value: string, label: string): string {
  const text = value.trim();
  if (!text) throw new Error(label + '不可為空。');
  if (text.length > 100_000 || text.includes('\0')) throw new Error(label + '長度無效。');
  return text;
}

function validatePartialPatch(patch: string, relativePath: string): void {
  if (!patch.startsWith('diff --git ') || Buffer.byteLength(patch, 'utf8') > 1_000_000 || patch.includes('\0')) {
    throw new Error('選取的差異 patch 無效，請重新開啟 Diff。');
  }
  const firstLines = patch.split(/\r?\n/).slice(0, 4).join('\n');
  const normalizedPath = relativePath.replaceAll('\\', '/');
  if (!firstLines.includes(' a/' + normalizedPath) || !firstLines.includes(' b/' + normalizedPath)) {
    throw new Error('部分暫存 patch 與目前選取的檔案不符。');
  }
}

function sameRebasePlan(first: GitRebasePlan, second: GitRebasePlan): boolean {
  return first.target === second.target && first.targetHash === second.targetHash && first.commits.length === second.commits.length &&
    first.commits.every((commit, index) => commit.hash === second.commits[index]?.hash);
}

function describePull(root: string, remote: string, branch: string, strategy: string, targetHash: string): string {
  return '從 ' + remote + '/' + branch + ' 更新 ' + root + '\n遠端目標：' + targetHash.slice(0, 12) + '\n整合方式：' +
    (strategy === 'ff-only' ? '只接受快轉' : strategy === 'rebase' ? 'Rebase' :
      strategy === 'rebase-merges' ? 'Rebase 並保留 Merge 結構' :
        strategy === 'interactive' ? '互動式 Rebase' : 'Merge');
}

function sanitizeGitError(stderr: string): string {
  const value = stderr
    .replace(/(https?:\/\/)[^/@\s]+@/gi, '$1[已遮蔽]@')
    .replace(/(authorization|private-token|job-token)\s*[:=]\s*[^\r\n]*/gi, '$1: [已遮蔽]')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '');
  return value.replace(/\r\n?/g, '\n').trim().split('\n').slice(-8).join('\n').slice(0, 1800);
}

function readableGitError(error: unknown): string {
  if (error instanceof GitCommandError) return error.message;
  if (error instanceof Error && error.message) {
    return sanitizeGitError(error.message.replace(/^(?:Command failed: |Git: )/i, '')) || 'Git 無法完成這項操作。';
  }
  return 'Git 無法完成這項操作。';
}
