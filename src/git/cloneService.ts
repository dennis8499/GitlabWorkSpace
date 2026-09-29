import { spawn } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readdirSync, realpathSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';
import { isAllowedGitRemote } from '../api/urlPolicy';
import type { GitLabProject } from '../api/types';

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

export type CloneRunner = (plan: ClonePlan, baseUrl: string, token: string, onPercent: (percent: number) => void) => Promise<void>;
export type UpdateOutcome =
  | { state: 'updated' | 'up-to-date' }
  | { state: 'skipped'; reason: string };
export type UpdateRunner = (plan: ClonePlan, token: string, onPercent: (percent: number) => void) => Promise<UpdateOutcome>;
export type ProjectResolver = (project: GitLabProject) => Promise<GitLabProject>;

export interface CloneDependencies {
  cloneRunner?: CloneRunner;
  updateRunner?: UpdateRunner;
  resolveProject?: ProjectResolver;
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
  exists: (target: string) => boolean = existsSync
): ClonePlan[] {
  const root = path.resolve(workspacePath);
  if (!exists(root) || !statSync(root).isDirectory()) {
    throw new ClonePreflightError('Choose an existing local folder for the cloned repositories.');
  }

  const foldedPaths = new Set<string>();
  return projects.map((project) => {
    if (!/^[A-Za-z0-9_.-]+$/.test(project.path) || project.path === '.' || project.path === '..' ||
        /[. ]$/.test(project.path) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i.test(project.path)) {
      throw new ClonePreflightError('Repository ' + project.path_with_namespace + ' has an unsafe local folder name.');
    }
    if (!isAllowedGitRemote(gitLabBaseUrl, project.http_url_to_repo)) {
      throw new ClonePreflightError('Repository ' + project.path_with_namespace + ' has a clone URL outside the configured GitLab server.');
    }

    const targetPath = path.resolve(root, project.path);
    if (path.dirname(targetPath) !== root) {
      throw new ClonePreflightError('Repository ' + project.path_with_namespace + ' would escape the selected folder.');
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
    planClones(workspacePath, projects, gitLabBaseUrl),
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
    } catch {
      failed = plan.project;
      failureReason = plan.action === 'clone'
        ? 'Git could not complete this clone.'
        : 'Git could not update this repository.';
      onProgress({ project: plan.project, action: plan.action, state: 'failed', message: failureReason });
      // Existing repositories are never removed after an update failure.
      if (plan.action === 'clone' && ownedCloneDirectory) {
        removeFailedCloneDirectory(plan.targetPath, workspacePath, ownedCloneDirectory);
      }
    }
  }

  return { plans, completed, cloned, updated, failed, failureReason, skipped };
}

async function preflightExistingPlans(
  plans: ClonePlan[],
  workspacePath: string,
  gitLabBaseUrl: string,
  resolveProject: ProjectResolver
): Promise<ClonePlan[]> {
  const inspected: Array<{ plan: ClonePlan; originUrl?: string }> = [];
  for (const plan of plans) {
    inspected.push({
      plan,
      originUrl: plan.action === 'update'
        ? await inspectExistingRepository(plan.targetPath, workspacePath)
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
    if (!project.default_branch || needsSshUrl) {
      project = { ...project, ...(await resolveProject(project)) };
    }
    if (!isAllowedGitRemote(gitLabBaseUrl, project.http_url_to_repo)) {
      throw new ClonePreflightError(
        'Repository ' + project.path_with_namespace + ' has a clone URL outside the configured GitLab server. No repositories were changed.'
      );
    }
    if (!remoteMatchesProject(originUrl, project)) {
      throw new ClonePreflightError(
        'The existing folder ' + project.path + ' is not a Git repository for ' + project.path_with_namespace + '. No repositories were changed.'
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

async function inspectExistingRepository(targetPath: string, workspacePath: string): Promise<string> {
  try {
    const stat = lstatSync(targetPath);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error('not a plain directory');
    }
    const workspaceRealPath = realpathSync(workspacePath);
    const targetRealPath = realpathSync(targetPath);
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
      ' is not a safe repository for this selection. No repositories were changed.'
    );
  }
}

function remoteMatchesProject(originUrl: string, project: GitLabProject): boolean {
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

function samePath(first: string, second: string): boolean {
  const a = path.resolve(first);
  const b = path.resolve(second);
  return process.platform === 'win32'
    ? a.toLocaleLowerCase('en-US') === b.toLocaleLowerCase('en-US')
    : a === b;
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
    onPercent
  ).then((code) => {
    if (code !== 0) throw new Error('Git clone failed.');
  });
}

async function runGitUpdate(plan: ClonePlan, token: string, onPercent: (percent: number) => void): Promise<UpdateOutcome> {
  const branch = plan.defaultBranch;
  if (!branch) return { state: 'skipped', reason: 'GitLab has not configured a default branch for this project.' };

  const status = await runGitCapture([
    '-C', plan.targetPath, 'status', '--porcelain=v1', '--untracked-files=normal', '--ignore-submodules=none'
  ]);
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
    onPercent
  );
  if (fetchCode !== 0) throw new Error('Git fetch failed.');

  const remoteCommit = await readRef(plan.targetPath, remoteRef);
  if (!remoteCommit) throw new Error('Git did not provide the configured default branch.');
  const localCommit = await readRef(plan.targetPath, localRef);
  if (!localCommit) {
    const switchCode = await runGitProcess(
      ['switch', '--no-guess', '--no-overwrite-ignore', '--track', '-c', branch, remoteRef],
      plan.targetPath,
      process.env
    );
    if (switchCode !== 0) {
      return { state: 'skipped', reason: 'Could not switch to the default branch safely.' };
    }
    return { state: 'updated' };
  }

  let shouldFastForward = false;
  if (localCommit !== remoteCommit) {
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

  const switchCode = await runGitProcess(
    ['switch', '--no-guess', '--no-overwrite-ignore', branch],
    plan.targetPath,
    process.env
  );
  if (switchCode !== 0) {
    return { state: 'skipped', reason: 'Could not switch to the default branch safely.' };
  }
  if (shouldFastForward) {
    const mergeCode = await runGitProcess(
      ['merge', '--ff-only', '--no-edit', '--no-overwrite-ignore', remoteRef],
      plan.targetPath,
      process.env
    );
    if (mergeCode !== 0) throw new Error('Git could not fast-forward the default branch.');
    return { state: 'updated' };
  }
  return { state: 'up-to-date' };
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

function runGitProcess(
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  onPercent?: (percent: number) => void
): Promise<number> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const child = spawn('git', args, {
      cwd,
      env,
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'ignore', 'pipe']
    });
    child.stderr?.on('data', (chunk: Buffer | string) => {
      if (!onPercent) return;
      const text = String(chunk);
      for (const match of text.matchAll(/(?:Receiving|Resolving|Updating|Compressing) objects:\\s*(\\d+)%/g)) {
        onPercent(Number(match[1]));
      }
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
      resolve(code ?? -1);
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
    const root = realpathSync(workspacePath);
    const stat = lstatSync(targetPath);
    if (stat.isSymbolicLink()) return;
    if (!stat.isDirectory()) return;
    if (stat.dev !== identity.dev || stat.ino !== identity.ino || stat.birthtimeMs !== identity.birthtimeMs) return;
    const realTarget = realpathSync(targetPath);
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
