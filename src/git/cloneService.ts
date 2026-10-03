import { spawn } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readdirSync, realpathSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';
import { isAllowedGitRemote } from '../api/urlPolicy';
import type { GitLabProject } from '../api/types';
import { groupRepositoryPath, projectFolderNames, sameLocalPath } from '../workspace/workspacePaths';

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
}

export type CloneRunner = (plan: ClonePlan, baseUrl: string, token: string, onPercent: (percent: number) => void) => Promise<void>;
export type UpdateOutcome =
  | { state: 'updated' | 'up-to-date' }
  | { state: 'skipped'; reason: string };
export type UpdateRunner = (plan: ClonePlan, token: string, onPercent: (percent: number) => void) => Promise<UpdateOutcome>;
export type LocalSyncRunner = UpdateRunner;
export type ProjectResolver = (project: GitLabProject) => Promise<GitLabProject>;

export interface CloneDependencies {
  cloneRunner?: CloneRunner;
  updateRunner?: UpdateRunner;
  resolveProject?: ProjectResolver;
  /** Complete selected Group inventory, used to make same-named child Repos deterministic. */
  groupProjects?: readonly GitLabProject[];
}

export interface LocalSyncDependencies {
  syncRunner?: LocalSyncRunner;
  resolveProject?: ProjectResolver;
  /** Complete Group inventory, used to resolve stable paths when syncing only local repositories. */
  groupProjects?: readonly GitLabProject[];
}

export class ClonePreflightError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ClonePreflightError';
  }
}

export function planClones(
  workspacePath: string,
  projects: readonly GitLabProject[],
  gitLabBaseUrl: string,
  exists: (target: string) => boolean = existsSync,
  groupProjects: readonly GitLabProject[] = projects,
  folders: ReadonlyMap<number, string> = projectFolderNames(groupProjects)
): ClonePlan[] {
  const root = path.resolve(workspacePath);
  if (!exists(root) || !statSync(root).isDirectory()) {
    throw new ClonePreflightError('Choose an existing local folder for the cloned repositories.');
  }

  const foldedPaths = new Set<string>();
  return projects.map((project) => {
    let targetPath: string;
    try {
      targetPath = groupRepositoryPath(root, project, groupProjects, folders);
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
      action: isPathPresent(targetPath, exists) ? 'update' : 'clone'
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
  // Validate every existing destination and remote before the first clone or fetch.
  const plans = await preflightExistingPlans(
    planClones(workspacePath, projects, gitLabBaseUrl, existsSync, dependencies.groupProjects ?? projects),
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
  const cloneRunner = dependencies.cloneRunner ?? runGitClone;
  const updateRunner = dependencies.updateRunner ?? runGitUpdate;

  for (const plan of plans) {
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
    try {
      if (plan.action === 'clone') {
        // Reserve the previously absent path atomically so cleanup can never remove a
        // destination created by another process after preflight.
        mkdirSync(plan.targetPath);
        const createdStat = lstatSync(plan.targetPath);
        ownedCloneDirectory = { dev: createdStat.dev, ino: createdStat.ino, birthtimeMs: createdStat.birthtimeMs };
        await cloneRunner(plan, gitLabBaseUrl, token, (percent) =>
          onProgress({ project: plan.project, action: plan.action, state: 'progress', percent }));
        cloned.push(plan.project);
      } else {
        const outcome = await updateRunner(plan, token, (percent) =>
          onProgress({ project: plan.project, action: plan.action, state: 'progress', percent }));
        if (outcome.state === 'skipped') {
          skipped.push({ project: plan.project, reason: outcome.reason });
          onProgress({ project: plan.project, action: plan.action, state: 'skipped', message: outcome.reason });
          continue;
        }
        updated.push(plan.project);
      }
      completed.push(plan.project);
      onProgress({ project: plan.project, action: plan.action, state: 'completed' });
    } catch (error) {
      failed = plan.project;
      const fallback = plan.action === 'clone'
        ? 'Git could not complete this clone.'
        : 'Git could not update this repository.';
      failureReason = formatGitFailure(error, fallback, token);
      onProgress({ project: plan.project, action: plan.action, state: 'failed', message: failureReason });
      // Existing repositories are never removed after an update failure.
      if (plan.action === 'clone' && ownedCloneDirectory) {
        removeFailedCloneDirectory(plan.targetPath, workspacePath, ownedCloneDirectory);
      }
    }
  }

  return { plans, completed, cloned, updated, failed, failureReason, skipped };
}

export async function syncLocalDefaultBranches(
  workspacePath: string,
  projects: readonly GitLabProject[],
  gitLabBaseUrl: string,
  token: string,
  onProgress: (progress: LocalSyncProgress) => void = () => undefined,
  dependencies: LocalSyncDependencies = {}
): Promise<LocalSyncBatchResult> {
  // Validate the chosen workspace once, including when the group has no projects.
  planClones(workspacePath, [], gitLabBaseUrl);
  const result: LocalSyncBatchResult = { found: 0, updated: [], upToDate: [], failed: [], skipped: [] };
  const resolveProject = dependencies.resolveProject ?? (async (project) => project);
  const syncRunner = dependencies.syncRunner ?? runGitDefaultBranchSync;
  const groupProjects = dependencies.groupProjects ?? projects;
  const folders = projectFolderNames(groupProjects);
  const handledPaths = new Set<string>();
  const root = path.resolve(workspacePath);

  for (const project of projects) {
    let targetPath: string;
    try {
      targetPath = groupRepositoryPath(root, project, groupProjects, folders);
    } catch (error) {
      const reason = error instanceof Error ? error.message : 'The local repository path could not be verified.';
      result.skipped.push({ project, reason });
      onProgress({ project, state: 'skipped', message: reason });
      continue;
    }

    // Missing repositories are outside this command's scope, so their clone URLs
    // do not need to be inspected.
    if (!isPathPresent(targetPath, existsSync)) continue;

    let plan: ClonePlan;
    try {
      plan = planClones(workspacePath, [project], gitLabBaseUrl, existsSync, groupProjects, folders)[0];
    } catch (error) {
      const reason = error instanceof Error ? error.message : 'The local repository path could not be verified.';
      result.skipped.push({ project, reason });
      onProgress({ project, state: 'skipped', message: reason });
      continue;
    }

    // Synchronization only considers destinations that already exist locally.
    if (plan.action === 'clone') continue;
    result.found += 1;

    let prepared: ClonePlan;
    try {
      prepared = (await preflightExistingPlans([plan], workspacePath, gitLabBaseUrl, resolveProject, false, true))[0];
    } catch (error) {
      const reason = error instanceof Error
        ? error.message.replace(/ No repositories were changed\.$/, '')
        : 'The existing repository could not be verified.';
      result.skipped.push({ project, reason });
      onProgress({ project, state: 'skipped', message: reason });
      continue;
    }

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
    try {
      const outcome = await syncRunner(prepared, token, (percent) =>
        onProgress({ project: prepared.project, state: 'progress', percent }));
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
      const reason = formatGitFailure(error, 'Git could not synchronize this repository.', token);
      result.failed.push({ project: prepared.project, reason });
      onProgress({ project: prepared.project, state: 'failed', message: reason });
    }
  }

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
  const inspected: Array<{ plan: ClonePlan; originUrl?: string }> = [];
  for (const plan of plans) {
    inspected.push({
      plan,
      originUrl: plan.action === 'update'
        ? await inspectExistingRepository(plan.targetPath, workspacePath, includeBatchContext)
        : undefined
    });
  }

  const resolved: ClonePlan[] = [];
  for (const { plan, originUrl } of inspected) {
    if (plan.action !== 'update' || !originUrl) {
      resolved.push(plan);
      continue;
    }
    const needsSshUrl = isSshCloneUrl(originUrl) && !plan.project.ssh_url_to_repo;
    let project = plan.project;
    if (refreshProjectDetails || !project.default_branch || needsSshUrl) {
      project = { ...project, ...(await resolveProject(project)) };
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
      resolved.push({ ...plan, project, skipReason: 'GitLab has not configured a default branch for this project.' });
      continue;
    }
    if (!await isValidBranchName(defaultBranch, plan.targetPath)) {
      resolved.push({ ...plan, project, skipReason: 'The GitLab default branch name could not be verified safely.' });
      continue;
    }
    resolved.push({ ...plan, project, defaultBranch });
  }
  return resolved;
}

async function inspectExistingRepository(
  targetPath: string,
  workspacePath: string,
  includeBatchContext = true
): Promise<string> {
  try {
    const stat = lstatSync(targetPath);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error('not a plain directory');
    }
    const workspaceRealPath = realpathSync.native(workspacePath);
    const targetRealPath = realpathSync.native(targetPath);
    if (!samePath(path.dirname(targetRealPath), workspaceRealPath)) {
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

function runGitCapture(args: string[], cwd?: string, env: NodeJS.ProcessEnv = process.env): Promise<GitCaptureResult> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let stdout = '';
    let child;
    try {
      child = spawn('git', args, {
        cwd,
        env,
        shell: false,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'ignore']
      });
    } catch {
      reject(new Error('Unable to start Git.'));
      return;
    }
    child.stdout?.on('data', (chunk: Buffer | string) => {
      if (stdout.length < 65536) stdout += String(chunk);
    });
    child.once('error', () => {
      if (!settled) {
        settled = true;
        reject(new Error('Unable to start Git.'));
      }
    });
    child.once('close', (code) => {
      if (settled) return;
      settled = true;
      resolve({ code: code ?? -1, stdout });
    });
  });
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

function buildGitEnvironment(remoteUrl: string, token: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  const count = Number.parseInt(env.GIT_CONFIG_COUNT ?? '0', 10);
  const first = Number.isFinite(count) && count >= 0 ? count : 0;
  const remote = new URL(remoteUrl);
  const scopedKey = 'http.' + remote.origin + remote.pathname + '/.extraheader';
  env.GIT_CONFIG_COUNT = String(first + 2);
  env['GIT_CONFIG_KEY_' + first] = scopedKey;
  env['GIT_CONFIG_VALUE_' + first] = 'AUTHORIZATION: Basic ' +
    Buffer.from('oauth2:' + token, 'utf8').toString('base64');
  env['GIT_CONFIG_KEY_' + (first + 1)] = 'credential.helper';
  env['GIT_CONFIG_VALUE_' + (first + 1)] = '';
  env.GIT_TERMINAL_PROMPT = '0';
  env.GCM_INTERACTIVE = 'Never';
  return env;
}

function runGitClone(plan: ClonePlan, baseUrl: string, token: string, onPercent: (percent: number) => void): Promise<void> {
  if (!isAllowedGitRemote(baseUrl, plan.project.http_url_to_repo)) {
    return Promise.reject(new Error('Clone URL is outside the configured GitLab server.'));
  }
  const env = buildGitEnvironment(plan.project.http_url_to_repo, token);
  return runGitProcess(
    ['clone', '--progress', '--', plan.project.http_url_to_repo, plan.targetPath],
    path.dirname(plan.targetPath),
    env,
    onPercent,
    'clone'
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
    ['fetch', '--no-tags', '--no-recurse-submodules', '--progress', plan.project.http_url_to_repo, refspec],
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
  ]);
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

function runGitProcess(
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  onPercent?: (percent: number) => void,
  operation: GitCommandFailure['command'] = 'fetch'
): Promise<GitProcessResult> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let stderr = '';
    const child = spawn('git', args, {
      cwd,
      env,
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'ignore', 'pipe']
    });
    child.stderr?.on('data', (chunk: Buffer | string) => {
      const text = String(chunk);
      if (stderr.length < 65536) stderr += text.slice(0, 65536 - stderr.length);
      if (onPercent) {
        for (const match of text.matchAll(/(?:Receiving|Resolving|Updating|Compressing) objects:\s*(\d+)%/g)) {
          onPercent(Number(match[1]));
        }
      }
    });
    child.once('error', () => {
      if (!settled) {
        settled = true;
        reject(new GitCommandFailure(operation, { code: -1, stderr: 'Unable to start Git.' }));
      }
    });
    child.once('close', (code) => {
      if (settled) return;
      settled = true;
      resolve({ code: code ?? -1, stderr });
    });
  });
}

function removeFailedCloneDirectory(
  targetPath: string,
  workspacePath: string,
  identity: { dev: number; ino: number; birthtimeMs: number }
): void {
  try {
    if (!existsSync(targetPath)) return;
    const root = realpathSync.native(workspacePath);
    const stat = lstatSync(targetPath);
    if (stat.isSymbolicLink()) return;
    if (!stat.isDirectory()) return;
    if (stat.dev !== identity.dev || stat.ino !== identity.ino || stat.birthtimeMs !== identity.birthtimeMs) return;
    const realTarget = realpathSync.native(targetPath);
    if (!samePath(path.dirname(realTarget), root)) return;
    if (!existsSync(path.join(realTarget, '.git')) && readdirSync(realTarget).length > 0) return;
    rmSync(realTarget, { recursive: true, force: true });
  } catch {
    // Cleanup is best effort; clone failure must remain visible even if cleanup is not safe.
  }
}

export function createCloneEnvironmentForTest(remoteUrl: string, token: string): NodeJS.ProcessEnv {
  return buildGitEnvironment(remoteUrl, token);
}

export function createScopedGitEnvironment(remoteUrl: string, token: string): NodeJS.ProcessEnv {
  return buildGitEnvironment(remoteUrl, token);
}
