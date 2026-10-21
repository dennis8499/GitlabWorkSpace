import { captureGitProcess } from './gitProcess';
import { AsyncLocalStorage } from 'node:async_hooks';
import { currentOperationLog } from '../logging/operationLog';
import type { LogContext } from '../logging/logProtocol';
import { logGitCommand } from './gitCommandLog';
import { existsSync, lstatSync, statSync } from 'node:fs';
import { lstat, mkdir, readdir, realpath, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { isAllowedGitRemote } from '../api/urlPolicy';
import type { GitLabProject } from '../api/types';
import { groupRepositoryPath, sameLocalPath } from '../workspace/workspacePaths';
import { withGitDirectoryLock } from './repositoryOperationLock';
import { assertSameLocalRepositoryLayout, LocalRepositoryMetadataError, resolveLocalRepositoryLayout, type LocalRepositoryLayout } from '../workspace/localRepositoryLayout';

export type CloneAction = 'clone' | 'update';

export interface ClonePlan {
  project: GitLabProject;
  targetPath: string;
  action: CloneAction;
  defaultBranch?: string;
  skipReason?: string;
}

export interface CloneProgress {
  project: GitLabProject;
  action: CloneAction;
  state: 'starting' | 'progress' | 'completed' | 'failed' | 'skipped';
  percent?: number;
  message?: string;
}

export interface CloneSkip {
  project: GitLabProject;
  reason: string;
}

export interface CloneBatchResult {
  plans: ClonePlan[];
  /** Projects successfully cloned or synchronized. */
  completed: GitLabProject[];
  cloned: GitLabProject[];
  updated: GitLabProject[];
  failed?: GitLabProject;
  failureReason?: string;
  skipped: CloneSkip[];
  cancelled?: boolean;
  effect?: 'unknown';
}

export interface LocalSyncProgress {
  project: GitLabProject;
  state: 'starting' | 'progress' | 'updated' | 'up-to-date' | 'failed' | 'skipped';
  percent?: number;
  message?: string;
}

export interface LocalSyncBatchResult {
  /** Existing local destinations considered for synchronization. */
  found: number;
  updated: GitLabProject[];
  upToDate: GitLabProject[];
  failed: CloneSkip[];
  skipped: CloneSkip[];
  cancelled?: boolean;
  effect?: 'unknown';
}

interface GitProcessOptions { signal?: AbortSignal; timeoutMs?: number; }
const gitProcessOptions = new AsyncLocalStorage<GitProcessOptions>();

async function mapPreflight<T, R>(items: readonly T[], read: (item: T) => Promise<R>): Promise<R[]> {
  const result = new Array<R>(items.length);
  let next = 0, failure: unknown;
  await Promise.all(Array.from({ length: Math.min(4, items.length) }, async () => {
    while (failure === undefined && next < items.length) {
      const index = next++;
      try { gitProcessOptions.getStore()?.signal?.throwIfAborted(); result[index] = await read(items[index]); }
      catch (error) { failure ??= error; }
    }
  }));
  if (failure !== undefined) throw failure;
  return result;
}

export type CloneRunner = (plan: ClonePlan, baseUrl: string, token: string, onPercent: (percent: number) => void) => Promise<void>;
export type UpdateOutcome =
  | { state: 'updated' | 'up-to-date' }
  | { state: 'skipped'; reason: string };
export type UpdateRunner = (plan: ClonePlan, token: string, onPercent: (percent: number) => void) => Promise<UpdateOutcome>;
export type LocalSyncRunner = UpdateRunner;
export type ProjectResolver = (project: GitLabProject, signal?: AbortSignal) => Promise<GitLabProject>;

export interface CloneDependencies extends GitProcessOptions {
  cloneRunner?: CloneRunner;
  updateRunner?: UpdateRunner;
  resolveProject?: ProjectResolver;
  /** Complete selected Group inventory, used to make same-named child Repos deterministic. */
  groupProjects?: readonly GitLabProject[];
  /** Destinations reviewed by the user; execution must revalidate without changing them. */
  layout?: LocalRepositoryLayout;
}

export interface LocalSyncDependencies extends GitProcessOptions {
  syncRunner?: LocalSyncRunner;
  resolveProject?: ProjectResolver;
  /** Complete Group inventory, used to resolve stable paths when syncing only local repositories. */
  groupProjects?: readonly GitLabProject[];
  layout?: LocalRepositoryLayout;
}

export class ClonePreflightError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ClonePreflightError';
  }
}

/** Explicit operations may fill missing SSH metadata only for their selected projects. */
export async function prepareOperationLayout(root: string, projects: readonly GitLabProject[], resolveProject?: ProjectResolver,
  signal?: AbortSignal): Promise<{ projects: GitLabProject[]; layout: LocalRepositoryLayout }> {
  let prepared = [...projects];
  const completeProject = async (project: GitLabProject): Promise<GitLabProject> => {
    const details = await resolveProject!(project, signal);
    if (details.id !== project.id) throw new ClonePreflightError('GitLab returned a different project identity; no repository operation was started.');
    return { ...project, ...details };
  };
  if (resolveProject) prepared = await mapPreflight(prepared, project =>
    [project.path, project.path_with_namespace, project.http_url_to_repo].some(value => typeof value !== 'string' || !value.trim())
      ? completeProject(project) : Promise.resolve(project));
  try { return { projects: prepared, layout: await resolveLocalRepositoryLayout(root, prepared, projectRemoteMatches, signal) }; }
  catch (error) {
    if (!(error instanceof LocalRepositoryMetadataError) || !resolveProject) throw error;
    const required = new Set(error.projectIds);
    prepared = await mapPreflight(prepared, async project => required.has(project.id) ? completeProject(project) : project);
    signal?.throwIfAborted();
    return { projects: prepared, layout: await resolveLocalRepositoryLayout(root, prepared, projectRemoteMatches, signal) };
  }
}

export function planClones(
  workspacePath: string,
  projects: readonly GitLabProject[],
  gitLabBaseUrl: string,
  exists: (target: string) => boolean = existsSync,
  groupProjects: readonly GitLabProject[] = projects,
  folders: ReadonlyMap<number, string> = new Map(groupProjects.map(project => [project.id, `${project.path}--${project.id}`]))
): ClonePlan[] {
  const root = path.resolve(workspacePath);
  if (!exists(root) || !statSync(root).isDirectory()) {
    throw new ClonePreflightError('Choose an existing local folder for the cloned repositories.');
  }

  return buildClonePlans(root, projects, gitLabBaseUrl, groupProjects, folders, target => isPathPresent(target, exists));
}

async function planClonesAsync(workspacePath: string, projects: readonly GitLabProject[], gitLabBaseUrl: string,
  groupProjects: readonly GitLabProject[] = projects, folders?: ReadonlyMap<number, string>, knownRoot?: { id?: number }, layout?: LocalRepositoryLayout): Promise<ClonePlan[]> {
  const root = path.resolve(workspacePath);
  try { if (!(await stat(root)).isDirectory()) throw new Error('not a directory'); }
  catch { throw new ClonePreflightError('Choose an existing local folder for the cloned repositories.'); }
  const resolved = layout ?? await resolveLocalRepositoryLayout(root, groupProjects, projectRemoteMatches, gitProcessOptions.getStore()?.signal);
  const rootProjectId = knownRoot ? knownRoot.id : resolved.rootProjectId;
  const plans = buildClonePlans(root, projects, gitLabBaseUrl, groupProjects, folders ?? resolved.folders, () => false, rootProjectId);
  for (let offset = 0; offset < plans.length; offset += 4) await Promise.all(plans.slice(offset, offset + 4).map(async plan => {
    plan.action = await isPathPresentAsync(plan.targetPath) ? 'update' : 'clone';
  }));
  return plans;
}

function buildClonePlans(root: string, projects: readonly GitLabProject[], gitLabBaseUrl: string,
  groupProjects: readonly GitLabProject[], folders: ReadonlyMap<number, string>, present: (target: string) => boolean, rootProjectId?: number): ClonePlan[] {
  const foldedPaths = new Set<string>();
  return projects.map((project) => {
    let targetPath: string;
    try {
      targetPath = groupRepositoryPath(root, project, groupProjects, folders, rootProjectId);
    } catch (error) {
      throw new ClonePreflightError(error instanceof Error ? error.message : 'The repository path is unsafe.');
    }
    if (!isAllowedGitRemote(gitLabBaseUrl, project.http_url_to_repo)) {
      throw new ClonePreflightError('Repository ' + project.path_with_namespace + ' has a clone URL outside the configured GitLab server.');
    }

    const folded = targetPath.toLocaleLowerCase('en-US');
    if (foldedPaths.has(folded)) {
      throw new ClonePreflightError('The selection contains repositories with the same local folder name ' + project.path + '.');
    }
    foldedPaths.add(folded);
    return {
      project,
      targetPath,
      action: present(targetPath) ? 'update' : 'clone'
    };
  });
}

export async function cloneProjects(
  workspacePath: string,
  projects: readonly GitLabProject[],
  gitLabBaseUrl: string,
  token: string,
  onProgress: (progress: CloneProgress) => void = () => undefined,
  dependencies: CloneDependencies = {}
): Promise<CloneBatchResult> {
  return gitProcessOptions.run(dependencies, () => cloneProjectsInternal(workspacePath, projects, gitLabBaseUrl, token, onProgress, dependencies));
}

async function cloneProjectsInternal(workspacePath: string, projects: readonly GitLabProject[], gitLabBaseUrl: string, token: string,
  onProgress: (progress: CloneProgress) => void, dependencies: CloneDependencies): Promise<CloneBatchResult> {
  dependencies.signal?.throwIfAborted();
  if (projects[0]) onProgress({ project: projects[0], action: 'clone', state: 'starting', message: '正在檢查本機目的地與遠端資訊…' });
  const layoutProjects = dependencies.layout ? (dependencies.groupProjects ?? projects).filter(project => dependencies.layout!.destinations.has(project.id)) : projects;
  let prepared: Awaited<ReturnType<typeof prepareOperationLayout>>;
  try { prepared = await prepareOperationLayout(workspacePath, layoutProjects, dependencies.resolveProject, dependencies.signal); }
  catch (error) {
    dependencies.signal?.throwIfAborted();
    throw new ClonePreflightError((error instanceof Error ? error.message : 'Cannot verify local destinations.') + ' No repositories were changed.');
  }
  if (dependencies.layout) assertSameLocalRepositoryLayout(dependencies.layout, prepared.layout);
  const preparedById = new Map(prepared.projects.map(project => [project.id, project]));
  const selected = projects.map(project => preparedById.get(project.id) ?? project);
  // Validate every existing destination and remote before the first clone or fetch.
  const plans = await preflightExistingPlans(
    await planClonesAsync(workspacePath, selected, gitLabBaseUrl, dependencies.groupProjects ?? selected, undefined, undefined, prepared.layout),
    workspacePath,
    gitLabBaseUrl,
    dependencies.resolveProject ?? (async (project) => project)
  );
  const completed: GitLabProject[] = [];
  const cloned: GitLabProject[] = [];
  const updated: GitLabProject[] = [];
  const skipped: CloneSkip[] = [];
  let failed: GitLabProject | undefined;
  let failureReason: string | undefined;
  let cancelled = false;
  let effect: 'unknown' | undefined;
  const cloneRunner = dependencies.cloneRunner ?? runGitClone;
  const updateRunner = dependencies.updateRunner ?? runGitUpdate;

  for (const plan of plans) {
    if (dependencies.signal?.aborted || cancelled) {
      cancelled = true;
      const reason = 'Operation cancelled before this repository started.';
      skipped.push({ project: plan.project, reason }); onProgress({ project: plan.project, action: plan.action, state: 'skipped', message: reason }); continue;
    }
    if (failed) {
      const reason = 'Skipped after an earlier repository operation failed.';
      skipped.push({ project: plan.project, reason });
      onProgress({ project: plan.project, action: plan.action, state: 'skipped', message: reason });
      continue;
    }
    if (plan.skipReason) {
      skipped.push({ project: plan.project, reason: plan.skipReason });
      onProgress({ project: plan.project, action: plan.action, state: 'skipped', message: plan.skipReason });
      continue;
    }

    onProgress({ project: plan.project, action: plan.action, state: 'starting' });
    let ownedCloneDirectory: { dev: number; ino: number; birthtimeMs: number } | undefined;
    let updating = false;
    try {
      await withGitDirectoryLock(plan.targetPath, async () => {
        dependencies.signal?.throwIfAborted();
        if (plan.action === 'clone') {
          // Reserve the previously absent path atomically so cleanup can never remove a
          // destination created by another process after preflight.
          await mkdir(plan.targetPath);
          const createdStat = await lstat(plan.targetPath);
          ownedCloneDirectory = { dev: createdStat.dev, ino: createdStat.ino, birthtimeMs: createdStat.birthtimeMs };
          await cloneRunner(plan, gitLabBaseUrl, token, (percent) =>
            onProgress({ project: plan.project, action: plan.action, state: 'progress', percent }));
          cloned.push(plan.project);
        } else {
          if (!await isPathPresentAsync(plan.targetPath)) throw new Error('The repository disappeared before synchronization started.');
          updating = true;
          const outcome = await updateRunner(plan, token, (percent) =>
            onProgress({ project: plan.project, action: plan.action, state: 'progress', percent }));
          if (outcome.state === 'skipped') {
            skipped.push({ project: plan.project, reason: outcome.reason });
            onProgress({ project: plan.project, action: plan.action, state: 'skipped', message: outcome.reason });
            return;
          }
          updated.push(plan.project);
        }
      });
      if (skipped.some((item) => item.project.id === plan.project.id)) continue;
      completed.push(plan.project);
      onProgress({ project: plan.project, action: plan.action, state: 'completed' });
    } catch (error) {
      if (dependencies.signal?.aborted) {
        cancelled = true;
        if (updating) effect = 'unknown';
        const reason = 'Repository operation cancelled.';
        skipped.push({ project: plan.project, reason });
        onProgress({ project: plan.project, action: plan.action, state: 'skipped', message: reason });
        if (plan.action === 'clone' && ownedCloneDirectory) await removeFailedCloneDirectory(plan.targetPath, workspacePath, ownedCloneDirectory);
        continue;
      }
      failed = plan.project;
      if (updating && error instanceof Error && error.name === 'TimeoutError') effect = 'unknown';
      const fallback = plan.action === 'clone'
        ? 'Git could not complete this clone.'
        : 'Git could not update this repository.';
      failureReason = formatGitFailure(error, fallback, token);
      onProgress({ project: plan.project, action: plan.action, state: 'failed', message: failureReason });
      // Existing repositories are never removed after an update failure.
      if (plan.action === 'clone' && ownedCloneDirectory) {
        await removeFailedCloneDirectory(plan.targetPath, workspacePath, ownedCloneDirectory);
      }
    }
  }

  return { plans, completed, cloned, updated, failed, failureReason, skipped, ...(cancelled ? { cancelled } : {}), ...(effect ? { effect } : {}) };
}

export async function syncLocalDefaultBranches(
  workspacePath: string,
  projects: readonly GitLabProject[],
  gitLabBaseUrl: string,
  token: string,
  onProgress: (progress: LocalSyncProgress) => void = () => undefined,
  dependencies: LocalSyncDependencies = {}
): Promise<LocalSyncBatchResult> {
  return gitProcessOptions.run(dependencies, () => syncLocalDefaultBranchesInternal(workspacePath, projects, gitLabBaseUrl, token, onProgress, dependencies));
}

async function syncLocalDefaultBranchesInternal(workspacePath: string, projects: readonly GitLabProject[], gitLabBaseUrl: string, token: string,
  onProgress: (progress: LocalSyncProgress) => void, dependencies: LocalSyncDependencies): Promise<LocalSyncBatchResult> {
  dependencies.signal?.throwIfAborted();
  // Validate the chosen workspace once, including when the group has no projects.
  await planClonesAsync(workspacePath, [], gitLabBaseUrl);
  const result: LocalSyncBatchResult = { found: 0, updated: [], upToDate: [], failed: [], skipped: [] };
  const resolveProject = dependencies.resolveProject ?? (async (project) => project);
  const syncRunner = dependencies.syncRunner ?? runGitDefaultBranchSync;
  const groupProjects = dependencies.groupProjects ?? projects;
  const layoutProjects = dependencies.layout ? groupProjects.filter(project => dependencies.layout!.destinations.has(project.id)) : groupProjects;
  const layoutPreparation = await prepareOperationLayout(workspacePath, layoutProjects, dependencies.resolveProject, dependencies.signal);
  if (dependencies.layout) assertSameLocalRepositoryLayout(dependencies.layout, layoutPreparation.layout);
  const folders = layoutPreparation.layout.folders;
  const handledPaths = new Set<string>();
  const preparedById = new Map(layoutPreparation.projects.map(project => [project.id, project]));
  const localProjects = projects.filter(project => layoutPreparation.layout.existingProjectIds.has(project.id))
    .map(project => preparedById.get(project.id) ?? project);
  // Finish the entire local/metadata preflight before any repository can fetch.
  const localPlans = await planClonesAsync(workspacePath, localProjects, gitLabBaseUrl, groupProjects, folders, undefined, layoutPreparation.layout);
  const checked = await mapPreflight(localPlans, async plan => {
    try { return (await preflightExistingPlans([plan], workspacePath, gitLabBaseUrl, resolveProject, false, true))[0]; }
    catch (error) {
      dependencies.signal?.throwIfAborted();
      if (error instanceof ClonePreflightError) throw error;
      const reason = error instanceof Error ? error.message : 'The project metadata could not be read.';
      result.skipped.push({ project: plan.project, reason }); onProgress({ project: plan.project, state: 'skipped', message: reason });
      return undefined;
    }
  });
  const plans = checked.filter((plan): plan is ClonePlan => plan !== undefined);
  result.found = localPlans.length;

  for (const prepared of plans) {
    const project = prepared.project;
    if (dependencies.signal?.aborted) { result.cancelled = true; break; }
    onProgress({ project, state: 'starting', message: '正在檢查本機目的地與遠端資訊…' });

    const foldedPath = path.resolve(prepared.targetPath).toLocaleLowerCase('en-US');
    if (handledPaths.has(foldedPath)) {
      const reason = 'Another GitLab project already uses this local folder.';
      result.skipped.push({ project: prepared.project, reason });
      onProgress({ project: prepared.project, state: 'skipped', message: reason });
      continue;
    }
    handledPaths.add(foldedPath);

    if (prepared.project.empty_repo === true) {
      const reason = 'GitLab 遠端 Repo 尚無任何提交，請先初始化遠端預設分支。';
      result.skipped.push({ project: prepared.project, reason });
      onProgress({ project: prepared.project, state: 'skipped', message: reason });
      continue;
    }

    if (prepared.skipReason) {
      result.skipped.push({ project: prepared.project, reason: prepared.skipReason });
      onProgress({ project: prepared.project, state: 'skipped', message: prepared.skipReason });
      continue;
    }

    onProgress({ project: prepared.project, state: 'starting' });
    let updating = false;
    try {
      const outcome = await withGitDirectoryLock(prepared.targetPath, () => {
        dependencies.signal?.throwIfAborted();
        updating = true;
        return syncRunner(prepared, token, (percent) => onProgress({ project: prepared.project, state: 'progress', percent }));
      });
      if (outcome.state === 'skipped') {
        result.skipped.push({ project: prepared.project, reason: outcome.reason });
        onProgress({ project: prepared.project, state: 'skipped', message: outcome.reason });
      } else if (outcome.state === 'updated') {
        result.updated.push(prepared.project);
        onProgress({ project: prepared.project, state: 'updated' });
      } else {
        result.upToDate.push(prepared.project);
        onProgress({ project: prepared.project, state: 'up-to-date' });
      }
    } catch (error) {
      if (dependencies.signal?.aborted) {
        result.cancelled = true;
        if (updating) result.effect = 'unknown';
        result.failed.push({ project: prepared.project, reason: 'Synchronization cancelled after starting; verify repository state before retrying.' });
        break;
      }
      if (updating && error instanceof Error && error.name === 'TimeoutError') result.effect = 'unknown';
      const reason = formatGitFailure(error, 'Git could not synchronize this repository.', token);
      result.failed.push({ project: prepared.project, reason });
      onProgress({ project: prepared.project, state: 'failed', message: reason });
    }
  }

  if (dependencies.signal?.aborted) result.cancelled = true;
  return result;
}

async function preflightExistingPlans(
  plans: ClonePlan[],
  workspacePath: string,
  gitLabBaseUrl: string,
  resolveProject: ProjectResolver,
  includeBatchContext = true,
  refreshProjectDetails = false
): Promise<ClonePlan[]> {
  const inspected = await mapPreflight(plans, async plan => ({
      plan,
      originUrl: plan.action === 'update'
        ? await inspectExistingRepository(plan.targetPath, workspacePath, includeBatchContext)
        : undefined
  }));

  return mapPreflight(inspected, async ({ plan, originUrl }) => {
    gitProcessOptions.getStore()?.signal?.throwIfAborted();
    if (plan.action !== 'update' || !originUrl) {
      return plan;
    }
    const needsSshUrl = isSshCloneUrl(originUrl) && !plan.project.ssh_url_to_repo;
    let project = plan.project;
    if (refreshProjectDetails || !project.default_branch || needsSshUrl) {
      project = { ...project, ...(await resolveProject(project, gitProcessOptions.getStore()?.signal)) };
    }
    if (!isAllowedGitRemote(gitLabBaseUrl, project.http_url_to_repo)) {
      throw new ClonePreflightError(
        'Repository ' + project.path_with_namespace + ' has a clone URL outside the configured GitLab server.' +
        (includeBatchContext ? ' No repositories were changed.' : '')
      );
    }
    if (!remoteMatchesProject(originUrl, project)) {
      throw new ClonePreflightError(
        'The existing folder ' + project.path + ' is not a Git repository for ' + project.path_with_namespace + '.' +
        (includeBatchContext ? ' No repositories were changed.' : '')
      );
    }

    const defaultBranch = project.default_branch?.trim() || undefined;
    if (!defaultBranch) {
      return { ...plan, project, skipReason: 'GitLab has not configured a default branch for this project.' };
    }
    if (!await isValidBranchName(defaultBranch, plan.targetPath)) {
      return { ...plan, project, skipReason: 'The GitLab default branch name could not be verified safely.' };
    }
    return { ...plan, project, defaultBranch };
  });
}

async function inspectExistingRepository(
  targetPath: string,
  workspacePath: string,
  includeBatchContext = true
): Promise<string> {
  try {
    const info = await lstat(targetPath);
    if (!info.isDirectory() || info.isSymbolicLink()) {
      throw new Error('not a plain directory');
    }
    const [workspaceRealPath, targetRealPath] = await Promise.all([realpath(workspacePath), realpath(targetPath)]);
    if (!samePath(targetRealPath, workspaceRealPath) && !samePath(path.dirname(targetRealPath), workspaceRealPath)) {
      throw new Error('outside the selected folder');
    }

    const topLevel = await runGitCapture(['-C', targetPath, 'rev-parse', '--show-toplevel']);
    if (topLevel.code !== 0 || !samePath(topLevel.stdout.trim(), targetRealPath)) {
      throw new Error('not a repository root');
    }
    const origin = await runGitCapture(['-C', targetPath, 'config', '--null', '--get-all', 'remote.origin.url']);
    if (origin.code !== 0) throw new Error('origin is missing');
    const origins = origin.stdout.split('\0').filter(Boolean);
    if (origins.length !== 1) throw new Error('origin is ambiguous');
    return origins[0];
  } catch {
    throw new ClonePreflightError(
      'The existing destination ' + path.basename(targetPath) +
      ' is not a safe repository for this selection.' +
      (includeBatchContext ? ' No repositories were changed.' : '')
    );
  }
}

export function projectRemoteIdentity(url: string): string | undefined {
  return normalizeHttpCloneUrl(url) ?? normalizeSshCloneUrl(url);
}

export function projectRemoteMatches(originUrl: string, project: GitLabProject): boolean {
  const originHttp = normalizeHttpCloneUrl(originUrl);
  const expectedHttp = normalizeHttpCloneUrl(project.http_url_to_repo);
  if (originHttp && expectedHttp && originHttp === expectedHttp) return true;
  const originSsh = normalizeSshCloneUrl(originUrl);
  const expectedSsh = project.ssh_url_to_repo ? normalizeSshCloneUrl(project.ssh_url_to_repo) : undefined;
  return Boolean(originSsh && expectedSsh && originSsh === expectedSsh);
}

function normalizeHttpCloneUrl(value: string): string | undefined {
  try {
    const url = new URL(value);
    if ((url.protocol !== 'http:' && url.protocol !== 'https:') ||
        url.username || url.password || url.search || url.hash) return undefined;
    const repoPath = url.pathname.replace(/\/+$/, '').replace(/\.git$/i, '');
    return url.protocol + '//' + url.host.toLocaleLowerCase('en-US') + repoPath;
  } catch {
    return undefined;
  }
}

function isSshCloneUrl(value: string): boolean {
  return normalizeSshCloneUrl(value) !== undefined;
}

function normalizeSshCloneUrl(value: string): string | undefined {
  try {
    if (/^ssh:\/\//i.test(value)) {
      const url = new URL(value);
      if (url.protocol !== 'ssh:' || url.password || url.search || url.hash) return undefined;
      const repoPath = url.pathname.replace(/^\/+/, '').replace(/\/+$/, '').replace(/\.git$/i, '');
      const host = url.hostname.replace(/^\[|\]$/g, '').toLocaleLowerCase('en-US');
      return (url.username || '') + '@' + host + ':' +
        (url.port || '22') + '/' + repoPath;
    }
    if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(value)) return undefined;
    const match = value.match(/^(?:([^@/:]+)@)?(\[[^\]]+\]|[^/:]+):(.+)$/);
    if (!match) return undefined;
    const host = match[2].replace(/^\[|\]$/g, '').toLocaleLowerCase('en-US');
    const repoPath = match[3].replace(/^\/+/, '').replace(/\/+$/, '').replace(/\.git$/i, '');
    return (match[1] || '') + '@' + host + ':22/' + repoPath;
  } catch {
    return undefined;
  }
}

async function isValidBranchName(branch: string, cwd: string): Promise<boolean> {
  try {
    const result = await runGitCapture(['-C', cwd, 'check-ref-format', '--branch', branch]);
    return result.code === 0 && result.stdout.trim() === branch;
  } catch {
    return false;
  }
}

function remoteMatchesProject(originUrl: string, project: GitLabProject): boolean {
  return projectRemoteMatches(originUrl, project);
}

function samePath(first: string, second: string): boolean {
  return sameLocalPath(first, second);
}

interface GitCaptureResult {
  code: number;
  stdout: string;
}

async function runGitCapture(args: string[], cwd?: string, env: NodeJS.ProcessEnv = process.env, allowTruncated = false): Promise<GitCaptureResult> {
  const repositoryPath = cwd ?? (args[0] === '-C' ? args[1] : undefined);
  const options = gitProcessOptions.getStore();
  const result = await logGitCommand(args, repositoryPath, () => captureGitProcess('git', args, { cwd, env, signal: options?.signal,
    timeoutMs: Math.min(options?.timeoutMs ?? 30_000, 30_000), maxStdoutBytes: 64 * 1024, allowTruncated }), undefined,
    { outcome: value => ({ result: value.code === 0 || value.truncated && allowTruncated ? 'success' : 'error', exitCode: value.code }) });
  return result.truncated && allowTruncated ? { ...result, code: 0 } : result;
}

async function isPathPresentAsync(target: string): Promise<boolean> {
  try { await lstat(target); return true; }
  catch (error) { return !error || typeof error !== 'object' || !('code' in error) || error.code !== 'ENOENT'; }
}

function isPathPresent(target: string, exists: (target: string) => boolean): boolean {
  if (exists(target)) return true;
  try {
    lstatSync(target);
    return true;
  } catch {
    return false;
  }
}

function buildGitEnvironment(remoteUrl: string, token: string, preserveCredentialHelpers = false): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  const count = Number.parseInt(env.GIT_CONFIG_COUNT ?? '0', 10);
  const first = Number.isFinite(count) && count >= 0 ? count : 0;
  const remote = new URL(remoteUrl);
  const scopedKey = 'http.' + remote.origin + remote.pathname + '/.extraheader';
  env.GIT_CONFIG_COUNT = String(first + (preserveCredentialHelpers ? 1 : 2));
  env['GIT_CONFIG_KEY_' + first] = scopedKey;
  env['GIT_CONFIG_VALUE_' + first] = 'AUTHORIZATION: Basic ' +
    Buffer.from('oauth2:' + token, 'utf8').toString('base64');
  if (!preserveCredentialHelpers) {
    env['GIT_CONFIG_KEY_' + (first + 1)] = 'credential.helper';
    env['GIT_CONFIG_VALUE_' + (first + 1)] = '';
    env.GCM_INTERACTIVE = 'Never';
  }
  env.GIT_TERMINAL_PROMPT = '0';
  return env;
}

function runGitClone(plan: ClonePlan, baseUrl: string, token: string, onPercent: (percent: number) => void): Promise<void> {
  if (!isAllowedGitRemote(baseUrl, plan.project.http_url_to_repo)) {
    return Promise.reject(new Error('Clone URL is outside the configured GitLab server.'));
  }
  const env = buildGitEnvironment(plan.project.http_url_to_repo, token);
  return runGitProcess(
    ['clone', '--no-recurse-submodules', '--progress', '--', plan.project.http_url_to_repo, plan.targetPath],
    path.dirname(plan.targetPath),
    env,
    onPercent,
    'clone',
    { targetPath: plan.targetPath, projectId: plan.project.id }
  ).then((result) => {
    if (result.code !== 0) throw new GitCommandFailure('clone', result);
  });
}

async function runGitUpdate(
  plan: ClonePlan,
  token: string,
  onPercent: (percent: number) => void,
  options: { requireCurrentDefault?: boolean } = {}
): Promise<UpdateOutcome> {
  const task = () => runGitUpdateInternal(plan, token, onPercent, options);
  return currentOperationLog()?.withContext({ projectId: plan.project.id, targetPath: plan.targetPath }, task) ?? task();
}

async function runGitUpdateInternal(
  plan: ClonePlan,
  token: string,
  onPercent: (percent: number) => void,
  options: { requireCurrentDefault?: boolean } = {}
): Promise<UpdateOutcome> {
  const branch = plan.defaultBranch;
  if (!branch) return { state: 'skipped', reason: 'GitLab has not configured a default branch for this project.' };

  if (options.requireCurrentDefault) {
    const currentBranch = await readCurrentBranch(plan.targetPath);
    if (currentBranch !== branch) {
      return { state: 'skipped', reason: 'The repository is not currently on its GitLab default branch.' };
    }
  }

  const status = await readWorkingTreeStatus(plan.targetPath);
  if (status.code !== 0) {
    return { state: 'skipped', reason: 'Could not verify that the working tree is clean.' };
  }
  if (status.stdout.length > 0) {
    return { state: 'skipped', reason: 'The repository has local changes or untracked files.' };
  }

  const remoteRef = 'refs/remotes/origin/' + branch;
  const localRef = 'refs/heads/' + branch;
  const refspec = '+refs/heads/' + branch + ':' + remoteRef;
  const env = buildGitEnvironment(plan.project.http_url_to_repo, token);
  const fetchCode = await runGitProcess(
    ['fetch', '--atomic', '--no-tags', '--no-prune', '--no-recurse-submodules', '--no-auto-maintenance', '--no-write-fetch-head', '--jobs=1', '--progress', plan.project.http_url_to_repo, refspec],
    plan.targetPath,
    env,
    onPercent,
    'fetch'
  );
  if (fetchCode.code !== 0) throw new GitCommandFailure('fetch', fetchCode);

  const remoteCommit = await readRef(plan.targetPath, remoteRef);
  if (!remoteCommit) {
    throw new GitCommandFailure('fetch', { code: -1, stderr: 'Git did not provide the configured default branch.' });
  }
  const localCommit = await readRef(plan.targetPath, localRef);
  if (!localCommit && !options.requireCurrentDefault) {
    const switchCode = await runGitProcess(
      ['switch', '--no-guess', '--no-overwrite-ignore', '--track', '-c', branch, remoteRef],
      plan.targetPath,
      process.env,
      undefined,
      'switch'
    );
    if (switchCode.code !== 0) {
      return { state: 'skipped', reason: formatGitFailure(new GitCommandFailure('switch', switchCode), 'Could not switch to the default branch safely.', token) };
    }
    return { state: 'updated' };
  }

  let shouldFastForward = !localCommit;
  if (localCommit && localCommit !== remoteCommit) {
    const localIsAncestor = await isAncestor(plan.targetPath, localRef, remoteRef);
    if (localIsAncestor === true) {
      shouldFastForward = true;
    } else {
      const remoteIsAncestor = await isAncestor(plan.targetPath, remoteRef, localRef);
      if (remoteIsAncestor === true) {
        // Local default branch already contains the fetched commit.
      } else if (localIsAncestor === false && remoteIsAncestor === false) {
        return { state: 'skipped', reason: 'The local and GitLab default branches have diverged.' };
      } else {
        return { state: 'skipped', reason: 'Could not verify that the default branch can be fast-forwarded.' };
      }
    }
  }

  if (options.requireCurrentDefault) {
    const currentBranch = await readCurrentBranch(plan.targetPath);
    if (currentBranch !== branch) {
      return { state: 'skipped', reason: 'The current branch changed during synchronization.' };
    }
    const currentStatus = await readWorkingTreeStatus(plan.targetPath);
    if (currentStatus.code !== 0) {
      return { state: 'skipped', reason: 'Could not verify that the working tree is clean.' };
    }
    if (currentStatus.stdout.length > 0) {
      return { state: 'skipped', reason: 'The repository has local changes or untracked files.' };
    }
  } else {
    const switchCode = await runGitProcess(
      ['switch', '--no-guess', '--no-overwrite-ignore', branch],
      plan.targetPath,
      process.env,
      undefined,
      'switch'
    );
    if (switchCode.code !== 0) {
      return { state: 'skipped', reason: formatGitFailure(new GitCommandFailure('switch', switchCode), 'Could not switch to the default branch safely.', token) };
    }
  }
  if (shouldFastForward) {
    const mergeCode = await runGitProcess(
      ['merge', '--ff-only', '--no-edit', '--no-overwrite-ignore', remoteRef],
      plan.targetPath,
      process.env,
      undefined,
      'merge'
    );
    if (mergeCode.code !== 0) throw new GitCommandFailure('merge', mergeCode);
    return { state: 'updated' };
  }
  return { state: 'up-to-date' };
}

function runGitDefaultBranchSync(
  plan: ClonePlan,
  token: string,
  onPercent: (percent: number) => void
): Promise<UpdateOutcome> {
  return runGitUpdate(plan, token, onPercent, { requireCurrentDefault: true });
}

async function readCurrentBranch(cwd: string): Promise<string | undefined> {
  const result = await runGitCapture(['-C', cwd, 'symbolic-ref', '--quiet', '--short', 'HEAD']);
  return result.code === 0 ? result.stdout.trim() || undefined : undefined;
}

function readWorkingTreeStatus(cwd: string): Promise<GitCaptureResult> {
  return runGitCapture([
    '-C', cwd, 'status', '--porcelain=v1', '--untracked-files=normal', '--ignore-submodules=none'
  ], undefined, process.env, true);
}

async function readRef(cwd: string, ref: string): Promise<string | undefined> {
  const result = await runGitCapture(['-C', cwd, 'rev-parse', '--verify', '--quiet', ref]);
  return result.code === 0 ? result.stdout.trim() : undefined;
}

async function isAncestor(cwd: string, ancestor: string, descendant: string): Promise<boolean | undefined> {
  const result = await runGitCapture(['-C', cwd, 'merge-base', '--is-ancestor', ancestor, descendant]);
  if (result.code === 0) return true;
  if (result.code === 1) return false;
  return undefined;
}

interface GitProcessResult {
  code: number;
  stderr: string;
}

class GitCommandFailure extends Error {
  constructor(readonly command: 'clone' | 'fetch' | 'switch' | 'merge', readonly result: GitProcessResult) {
    super('Git command failed.');
    this.name = 'GitCommandFailure';
  }
}

function formatGitFailure(error: unknown, fallback: string, token: string): string {
  if (error instanceof Error && error.name === 'TimeoutError') return `${fallback} Git operation timed out; verify repository state before retrying.`;
  if (!(error instanceof GitCommandFailure)) return fallback;
  const stderr = sanitizeGitDiagnostic(error.result.stderr, [token]);
  return `${fallback} (git ${error.command}, exit ${error.result.code})${stderr ? `:\n${stderr}` : ''}`;
}

export function sanitizeGitDiagnostic(stderr: string, secrets: readonly string[] = []): string {
  let text = stderr;
  const redactions = secrets.flatMap((secret) => secret
    ? [secret, `oauth2:${secret}`, `Basic ${Buffer.from(`oauth2:${secret}`, 'utf8').toString('base64')}`]
    : []);
  for (const secret of [...new Set(redactions)].sort((left, right) => right.length - left.length)) {
    text = text.replaceAll(secret, '[REDACTED]');
  }
  text = text
    .replace(/(\bhttps?:\/\/)[^\s/@]*@/gi, '$1[redacted]@')
    .replace(/\b(authorization|private-token|job-token)\s*[:=]\s*[^\r\n]*/gi, '$1: [REDACTED]')
    .replace(/\b(?:basic|bearer)\s+[A-Za-z0-9+/_=-]+/gi, '[REDACTED]')
    .replace(/([?&](?:access_token|private_token|job_token|token|password)=)[^&#\s]*/gi, '$1[REDACTED]')
    .replace(/\0/g, '');
  const lines = text.replace(/\r\n?/g, '\n').split('\n')
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .slice(-10);
  return lines.join('\n').slice(0, 1600);
}

async function runGitProcess(
  args: string[], cwd: string, env: NodeJS.ProcessEnv, onPercent?: (percent: number) => void,
  operation: GitCommandFailure['command'] = 'fetch', context?: LogContext
): Promise<GitProcessResult> {
  const options = gitProcessOptions.getStore();
  try {
    return await logGitCommand(args, context?.targetPath ?? cwd, () => captureGitProcess('git', args, { cwd, env, signal: options?.signal,
      timeoutMs: options?.timeoutMs ?? 300_000, maxStdoutBytes: 64 * 1024,
      onStderr: text => { for (const match of text.matchAll(/(?:Receiving|Resolving|Updating|Compressing) objects:\s*(\d+)%/g)) onPercent?.(Number(match[1])); } }), undefined, { context });
  } catch (error) {
    if (error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError')) throw error;
    throw new GitCommandFailure(operation, { code: -1, stderr: 'Unable to complete Git.' });
  }
}

async function removeFailedCloneDirectory(
  targetPath: string,
  workspacePath: string,
  identity: { dev: number; ino: number; birthtimeMs: number }
): Promise<void> {
  try {
    if (!await isPathPresentAsync(targetPath)) return;
    const root = await realpath(workspacePath);
    const stat = await lstat(targetPath);
    if (stat.isSymbolicLink()) return;
    if (!stat.isDirectory()) return;
    if (stat.dev !== identity.dev || stat.ino !== identity.ino || stat.birthtimeMs !== identity.birthtimeMs) return;
    const realTarget = await realpath(targetPath);
    if (!samePath(path.dirname(realTarget), root)) return;
    if (!await isPathPresentAsync(path.join(realTarget, '.git')) && (await readdir(realTarget)).length > 0) return;
    await rm(realTarget, { recursive: true, force: true });
  } catch {
    // Cleanup is best effort; clone failure must remain visible even if cleanup is not safe.
  }
}

export function createCloneEnvironmentForTest(remoteUrl: string, token: string): NodeJS.ProcessEnv {
  return buildGitEnvironment(remoteUrl, token);
}

export function createScopedGitEnvironment(remoteUrl: string, token: string, options: { preserveCredentialHelpers?: boolean } = {}): NodeJS.ProcessEnv {
  return buildGitEnvironment(remoteUrl, token, options.preserveCredentialHelpers);
}
