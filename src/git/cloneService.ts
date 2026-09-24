import { spawn } from 'node:child_process';
import { existsSync, lstatSync, realpathSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';
import { isAllowedGitRemote } from '../api/urlPolicy';
import type { GitLabProject } from '../api/types';

export interface ClonePlan {
  project: GitLabProject;
  targetPath: string;
}

export interface CloneProgress {
  project: GitLabProject;
  state: 'starting' | 'progress' | 'completed' | 'failed' | 'skipped';
  percent?: number;
  message?: string;
}

export interface CloneBatchResult {
  plans: ClonePlan[];
  completed: GitLabProject[];
  failed?: GitLabProject;
  skipped: GitLabProject[];
}

export type CloneRunner = (plan: ClonePlan, baseUrl: string, token: string, onPercent: (percent: number) => void) => Promise<void>;

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
  const plans = projects.map((project) => {
    if (!/^[A-Za-z0-9_.-]+$/.test(project.path) || project.path === '.' || project.path === '..' ||
        /[. ]$/.test(project.path) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i.test(project.path)) {
      throw new ClonePreflightError(`Repository “${project.path_with_namespace}” has an unsafe local folder name.`);
    }
    if (!isAllowedGitRemote(gitLabBaseUrl, project.http_url_to_repo)) {
      throw new ClonePreflightError(`Repository “${project.path_with_namespace}” has a clone URL outside the configured GitLab server.`);
    }

    const targetPath = path.resolve(root, project.path);
    if (path.dirname(targetPath) !== root) {
      throw new ClonePreflightError(`Repository “${project.path_with_namespace}” would escape the selected folder.`);
    }
    const folded = targetPath.toLocaleLowerCase('en-US');
    if (foldedPaths.has(folded)) {
      throw new ClonePreflightError(`The selection contains repositories with the same local folder name “${project.path}”.`);
    }
    foldedPaths.add(folded);
    if (exists(targetPath)) {
      throw new ClonePreflightError(`The destination “${project.path}” already exists. No repositories were cloned.`);
    }
    return { project, targetPath };
  });
  return plans;
}

export async function cloneProjects(
  workspacePath: string,
  projects: readonly GitLabProject[],
  gitLabBaseUrl: string,
  token: string,
  onProgress: (progress: CloneProgress) => void = () => undefined,
  runner: CloneRunner = runGitClone
): Promise<CloneBatchResult> {
  // Complete the entire preflight before creating a destination or launching Git.
  const plans = planClones(workspacePath, projects, gitLabBaseUrl);
  const completed: GitLabProject[] = [];
  const skipped: GitLabProject[] = [];
  let failed: GitLabProject | undefined;

  for (const [index, plan] of plans.entries()) {
    if (failed) {
      skipped.push(plan.project);
      onProgress({ project: plan.project, state: 'skipped', message: 'Skipped after an earlier clone failed.' });
      continue;
    }

    onProgress({ project: plan.project, state: 'starting' });
    try {
      await runner(plan, gitLabBaseUrl, token, (percent) => onProgress({ project: plan.project, state: 'progress', percent }));
      completed.push(plan.project);
      onProgress({ project: plan.project, state: 'completed' });
    } catch {
      failed = plan.project;
      onProgress({ project: plan.project, state: 'failed', message: 'Git could not complete this clone.' });
      // The destination was absent in preflight. Remove only a plain directory whose resolved
      // parent is still the selected workspace; leave unexpected paths for the user to inspect.
      removeFailedCloneDirectory(plan.targetPath, workspacePath);
    }
  }

  return { plans, completed, failed, skipped };
}

function buildGitEnvironment(remoteUrl: string, token: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  const count = Number.parseInt(env.GIT_CONFIG_COUNT ?? '0', 10);
  const first = Number.isFinite(count) && count >= 0 ? count : 0;
  const remote = new URL(remoteUrl);
  const scopedKey = `http.${remote.origin}${remote.pathname}/.extraheader`;
  env.GIT_CONFIG_COUNT = String(first + 2);
  env[`GIT_CONFIG_KEY_${first}`] = scopedKey;
  env[`GIT_CONFIG_VALUE_${first}`] = `AUTHORIZATION: Basic ${Buffer.from(`oauth2:${token}`, 'utf8').toString('base64')}`;
  env[`GIT_CONFIG_KEY_${first + 1}`] = 'credential.helper';
  env[`GIT_CONFIG_VALUE_${first + 1}`] = '';
  env.GIT_TERMINAL_PROMPT = '0';
  env.GCM_INTERACTIVE = 'Never';
  return env;
}

function runGitClone(plan: ClonePlan, baseUrl: string, token: string, onPercent: (percent: number) => void): Promise<void> {
  if (!isAllowedGitRemote(baseUrl, plan.project.http_url_to_repo)) {
    return Promise.reject(new Error('Clone URL is outside the configured GitLab server.'));
  }
  const env = buildGitEnvironment(plan.project.http_url_to_repo, token);
  return new Promise((resolve, reject) => {
    let settled = false;
    const child = spawn('git', ['clone', '--progress', '--', plan.project.http_url_to_repo, plan.targetPath], {
      cwd: path.dirname(plan.targetPath),
      env,
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'ignore', 'pipe']
    });
    child.stderr?.on('data', (chunk: Buffer | string) => {
      const text = String(chunk);
      for (const match of text.matchAll(/(?:Receiving|Resolving|Updating|Compressing) objects:\s*(\d+)%/g)) {
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
      if (code === 0) {
        resolve();
      } else {
        // Keep Git output out of logs and UI; it can contain server-controlled strings.
        reject(new Error('Git clone failed.'));
      }
    });
  });
}

function removeFailedCloneDirectory(targetPath: string, workspacePath: string): void {
  try {
    if (!existsSync(targetPath)) return;
    const root = realpathSync(workspacePath);
    const stat = lstatSync(targetPath);
    if (stat.isSymbolicLink()) return;
    if (!stat.isDirectory()) return;
    const realTarget = realpathSync(targetPath);
    if (path.dirname(realTarget) !== root) return;
    // Git creates the directory during this call; a directory without .git may have been
    // created by another process after preflight, so preserve it.
    if (!existsSync(path.join(realTarget, '.git'))) return;
    rmSync(realTarget, { recursive: true, force: true });
  } catch {
    // Cleanup is best effort; clone failure must remain visible even if cleanup is not safe.
  }
}

export function createCloneEnvironmentForTest(remoteUrl: string, token: string): NodeJS.ProcessEnv {
  return buildGitEnvironment(remoteUrl, token);
}
