import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstatSync, realpathSync } from 'node:fs';
import { lstat, readdir, realpath } from 'node:fs/promises';
import { resolve, relative, isAbsolute, sep } from 'node:path';
import path from 'node:path';
import type { GitLabProject } from '../api/types';
import { promisify } from 'node:util';
import { logGitCommand } from '../git/gitCommandLog';

const execFileAsync = promisify(execFile);

export interface LocalGroupRepository {
  name: string;
  path: string;
}

export type WorkspaceFolderInspection =
  | { kind: 'directory'; path: string }
  | { kind: 'group-repository'; path: string; groupRoot: string; projectId?: number; remoteFingerprint?: string }
  | { kind: 'repository' | 'nested-repository'; path: string; containerRoot?: string; remoteFingerprint?: string }
  | { kind: 'unavailable'; path: string; error: string };

export interface WorkspaceRootResolution {
  root?: string;
  error?: string;
}

/** Installation is local to a chosen directory and does not require a GitLab Group. */
export async function resolveWorkflowKitInstallRoot(
  manualRoot: string | undefined,
  groupRoot: string | undefined,
  workspaceRoots: readonly string[]
): Promise<WorkspaceRootResolution> {
  const folders = uniquePaths(workspaceRoots, process.platform);
  const candidate = manualRoot ?? groupRoot ?? (folders.length === 1 ? folders[0] : undefined);
  if (!candidate) return { error: folders.length > 1
    ? '目前開啟多個工作區資料夾，請選擇技能包安裝位置。'
    : '請選擇技能包安裝資料夾。' };
  try {
    const root = await realpath(candidate);
    if (!(await lstat(root)).isDirectory()) return { root: candidate, error: '安裝位置不是資料夾，請重新選擇。' };
    return { root };
  } catch {
    return { root: candidate, error: '安裝位置不存在或無法讀取，請重新選擇資料夾。' };
  }
}

/** Project downloads need a container, independently of strict Skills Group matching. */
export function resolveProjectWorkspaceRoot(
  inspections: readonly WorkspaceFolderInspection[],
  platform = process.platform
): WorkspaceRootResolution {
  const directories = uniquePaths(inspections.flatMap(item => item.kind === 'directory' ? [item.path] : []), platform);
  if (directories.length === 1) return { root: directories[0] };
  if (directories.length > 1) return { error: '目前有多個工作區資料夾，請選擇專案下載／更新位置。' };
  const matching = inspections.flatMap(item => item.kind === 'group-repository' ? [item.groupRoot] : []);
  const candidates = uniquePaths(matching.length ? matching : inspections.flatMap(item =>
    item.kind === 'repository' && item.containerRoot ? [item.containerRoot] : []), platform);
  if (candidates.length === 1) return { root: candidates[0] };
  return { error: candidates.length > 1 ? 'Repo 位於不同目錄，請選擇專案下載／更新位置。'
    : '請選擇專案下載／更新資料夾，或在 VS Code 開啟本機工作區。' };
}

/** Installation profile follows the target folder, not the current Skills context. */
export async function inspectWorkflowKitInstallRoot(root: string): Promise<WorkspaceRootResolution & { profile?: 'group' | 'repository' }> {
  const inspected = await inspectWorkspaceFolder(root, [], () => false);
  if (inspected.kind === 'unavailable') return { root, error: inspected.error };
  if (inspected.kind === 'directory') return { root: inspected.path, profile: 'group' };
  if (!sameLocalPath(root, inspected.path)) return { root, error: `請選擇 Git 根目錄：${inspected.path}；不能安裝於 Repo 子目錄。` };
  return { root: inspected.path, profile: 'repository' };
}

/** Pick one Group root from VS Code's already-resolved workspace folders. */
export function resolveGroupWorkspaceRoot(
  inspections: readonly WorkspaceFolderInspection[],
  platform = process.platform
): WorkspaceRootResolution {
  const unavailable = inspections.find((inspection) => inspection.kind === 'unavailable');
  if (unavailable?.kind === 'unavailable') return { error: unavailable.error };
  if (inspections.some(item => item.kind === 'repository' || item.kind === 'nested-repository')) {
    return { error: '目前 VSCode 工作區包含未對應所選 GitLab Group 的 Repo。' };
  }

  const matchingRepositoryRoots = uniquePaths(inspections.flatMap((inspection) =>
    inspection.kind === 'group-repository' ? [inspection.groupRoot] : []), platform);
  if (matchingRepositoryRoots.length === 1 && inspections.every(item => item.kind !== 'directory' || sameLocalPath(item.path, matchingRepositoryRoots[0], platform))) return { root: matchingRepositoryRoots[0] };
  if (matchingRepositoryRoots.length > 1) return { error: '目前 VSCode 工作區包含多個 Group Repo 目錄，無法唯一辨識工作區。' };

  const directories = uniquePaths(inspections.flatMap((inspection) =>
    inspection.kind === 'directory' ? [inspection.path] : []), platform);
  if (directories.length === 1) return { error: '此資料夾尚無可驗證的 Group Repo。' };
  if (directories.length > 1) return { error: '目前 VSCode 工作區包含多個可能的 Group 資料夾，請調整工作區 folders。' };
  if (!inspections.length) return { error: '請在 VSCode 開啟 Group 資料夾或該 Group 的 Repo。' };
  return { error: '目前 VSCode 工作區無法對應所選 GitLab Group；請調整工作區 folders。' };
}

function uniquePaths(paths: readonly string[], platform: NodeJS.Platform): string[] {
  const result: string[] = [];
  for (const candidate of paths) {
    const normalized = resolve(candidate);
    if (!result.some((existing) => sameLocalPath(existing, normalized, platform))) result.push(normalized);
  }
  return result;
}

/** Scan only direct Group children; Git itself validates normal repos and linked worktrees. */
export async function scanLocalGroupRepositories(root: string, strict = false): Promise<LocalGroupRepository[]> {
  const rootPath = await realpath(root);
  const entries = await readdir(rootPath, { withFileTypes: true });
  const candidates: Array<{ name: string; path: string }> = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    const repositoryPath = path.join(rootPath, entry.name);
    let marker;
    try { marker = await lstat(path.join(repositoryPath, ".git")); }
    catch (error) {
      if (error && typeof error === "object" && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    if (marker.isSymbolicLink() || (!marker.isDirectory() && !marker.isFile())) {
      if (strict) throw new Error(`無法驗證 Git Repo：${entry.name}`);
      continue;
    }
    candidates.push({ name: entry.name, path: repositoryPath });
  }
  const repositories = new Array<LocalGroupRepository | undefined>(candidates.length);
  let nextCandidate = 0;
  await Promise.all(Array.from({ length: Math.min(4, candidates.length) }, async () => {
    while (nextCandidate < candidates.length) {
      const index = nextCandidate++;
      const candidate = candidates[index];
      try {
        const result = await logGitCommand(['rev-parse'], candidate.path, () => execFileAsync("git", ["-C", candidate.path, "rev-parse", "--show-toplevel"], {
          windowsHide: true, timeout: 5000, maxBuffer: 1024 * 1024
        }));
        const gitRoot = await realpath(result.stdout.trim());
        const actualPath = await realpath(candidate.path);
        if (sameLocalPath(gitRoot, actualPath)) repositories[index] = { name: candidate.name, path: actualPath };
        else if (strict) throw new Error('Git root differs from the repository directory.');
      } catch (error) {
        if (error && typeof error === "object" && "code" in error) {
          const code = (error as NodeJS.ErrnoException).code;
          if (code === "ENOENT") throw new Error("Git could not be found while scanning local Repos.");
          if (typeof code === "number" && !strict) continue;
        }
        throw new Error("Could not inspect local Repo: " + candidate.name);
      }
    }
  }));
  return repositories.filter((repository): repository is LocalGroupRepository => !!repository)
    .sort((first, second) => first.name.localeCompare(second.name, "en-US", { sensitivity: "base" }));
}
export async function inspectWorkspaceFolder(
  folderPath: string,
  projects: readonly GitLabProject[],
  matchesRemote: (remoteUrl: string, project: GitLabProject) => boolean
): Promise<WorkspaceFolderInspection> {
  let absolutePath = await realpath(folderPath);
  const stat = await lstat(absolutePath);
  if (!stat.isDirectory()) return { kind: 'unavailable', path: absolutePath, error: 'VSCode 工作區項目不是資料夾。' };

  let topLevel: string;
  try {
    const result = await logGitCommand(['rev-parse'], absolutePath, () => execFileAsync('git', ['-C', absolutePath, 'rev-parse', '--show-toplevel'], {
      windowsHide: true, timeout: 5000, maxBuffer: 1024 * 1024
    }));
    topLevel = await realpath(result.stdout.trim());
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') return { kind: 'unavailable', path: absolutePath, error: '找不到 Git，無法辨識 VSCode 工作區。' };
      if (typeof code !== 'number') return { kind: 'unavailable', path: absolutePath, error: '無法讀取 VSCode 工作區的 Git 狀態。' };
    } else {
      return { kind: 'unavailable', path: absolutePath, error: '無法讀取 VSCode 工作區的 Git 狀態。' };
    }
    try {
      const marker = await lstat(path.join(absolutePath, '.git'));
      if (marker.isFile() || marker.isDirectory()) {
        return { kind: 'unavailable', path: absolutePath, error: 'VSCode 工作區包含無法驗證的 Git Repo。' };
      }
    } catch (markerError) {
      if (!markerError || typeof markerError !== 'object' || !('code' in markerError) || (markerError as NodeJS.ErrnoException).code !== 'ENOENT') {
        return { kind: 'unavailable', path: absolutePath, error: '無法檢查 VSCode 工作區。' };
      }
    }
    return { kind: 'directory', path: absolutePath };
  }

  absolutePath = topLevel;
  const parent = path.dirname(absolutePath);
  let remotes: string[];
  try {
    const result = await logGitCommand(['config'], absolutePath, () => execFileAsync('git', ['-C', absolutePath, 'config', '--null', '--get-all', 'remote.origin.url'], {
      windowsHide: true, timeout: 5000, maxBuffer: 1024 * 1024
    }));
    remotes = result.stdout.split('\0').filter(Boolean);
  } catch (error) {
    if ((error as { code?: number }).code === 1) return { kind: 'repository', path: absolutePath, containerRoot: parent };
    return { kind: 'unavailable', path: absolutePath, error: '無法讀取 Group Repo 的 remote。' };
  }
  const remoteFingerprint = createHash('sha256').update(JSON.stringify(remotes)).digest('hex');
  const matches = remotes.length === 1 ? projects.filter(project => matchesRemote(remotes[0], project)) : [];
  const matched = matches.length === 1 ? matches[0] : undefined;
  if (matched) {
    return { kind: 'group-repository', path: absolutePath, groupRoot: parent, projectId: matched.id, remoteFingerprint };
  }
  return { kind: 'repository', path: absolutePath, containerRoot: parent, remoteFingerprint };
}

export function projectFolderNames(projects: readonly GitLabProject[]): Map<number, string> {
  const foldedCounts = new Map<string, number>();
  const foldedPaths = projects.map((project) => project.path.toLocaleLowerCase('en-US'));
  for (const key of foldedPaths) {
    foldedCounts.set(key, (foldedCounts.get(key) ?? 0) + 1);
  }

  const fixed = new Set<string>();
  for (const project of projects) {
    const key = project.path.toLocaleLowerCase('en-US');
    if (foldedCounts.get(key) === 1) fixed.add(key);
  }
  const result = new Map<number, string>();
  const used = new Set<string>();
  for (const project of projects) {
    let candidate = project.path;
    if (foldedCounts.get(project.path.toLocaleLowerCase('en-US'))! > 1) candidate = `${project.path}--${project.id}`;
    const key = candidate.toLocaleLowerCase('en-US');
    if (fixed.has(key) && candidate !== project.path) candidate = `${candidate}--${project.id}`;
    let unique = candidate;
    let suffix = 2;
    while (used.has(unique.toLocaleLowerCase('en-US'))) {
      unique = `${candidate}--${suffix++}`;
    }
    result.set(project.id, unique);
    used.add(unique.toLocaleLowerCase('en-US'));
  }
  return result;
}

export function groupRepositoryPath(
  root: string,
  project: GitLabProject,
  projects: readonly GitLabProject[],
  folders: ReadonlyMap<number, string> = projectFolderNames(projects),
  rootProjectId?: number
): string {
  if (project.id === rootProjectId) return resolve(root);
  const folder = folders.get(project.id);
  if (!folder || !/^[A-Za-z0-9_.-]+$/.test(folder) || folder === '.' || folder === '..' || /[. ]$/.test(folder) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i.test(folder)) {
    throw new Error(`無法安全建立 Repo 路徑：${project.path_with_namespace}`);
  }
  const base = resolve(root);
  const target = resolve(base, folder);
  const rel = relative(base, target);
  if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error('Repo 路徑超出 Group 工作區。');
  return target;
}

export function sameLocalPath(first: string, second: string, platform = process.platform): boolean {
  if (platform === 'win32') {
    return path.win32.resolve(first).toLocaleLowerCase('en-US') === path.win32.resolve(second).toLocaleLowerCase('en-US');
  }
  return resolve(first) === resolve(second);
}

export function sameRealLocalPath(first: string, second: string, platform = process.platform): boolean {
  try {
    return sameLocalPath(realpathSync.native(first), realpathSync.native(second), platform);
  } catch {
    return sameLocalPath(first, second, platform);
  }
}

export async function sameRealLocalPathAsync(first: string, second: string, platform = process.platform): Promise<boolean> {
  try { const [firstPath, secondPath] = await Promise.all([realpath(first), realpath(second)]); return sameLocalPath(firstPath, secondPath, platform); }
  catch { return sameLocalPath(first, second, platform); }
}

export function localRepositoryState(root: string, target: string, allowRoot = false): 'missing' | 'ready' | 'unsafe' {
  try {
    const rel = relative(resolve(root), resolve(target));
    if ((!rel && !allowRoot) || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return 'unsafe';
    const stat = lstatSync(target);
    if (!stat.isDirectory() || stat.isSymbolicLink()) return 'unsafe';
    return 'ready';
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT') return 'missing';
    return 'unsafe';
  }
}

export async function localRepositoryStateAsync(root: string, target: string, allowRoot = false): Promise<'missing' | 'ready' | 'unsafe'> {
  try {
    const rel = relative(resolve(root), resolve(target));
    if ((!rel && !allowRoot) || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return 'unsafe';
    const stat = await lstat(target);
    if (!stat.isDirectory() || stat.isSymbolicLink()) return 'unsafe';
    return 'ready';
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT') return 'missing';
    return 'unsafe';
  }
}

/** Only a uniquely associated repository may use the shared root itself. */
export async function projectRootRepositoryId(root: string, projects: readonly GitLabProject[],
  matchesRemote: (remote: string, project: GitLabProject) => boolean): Promise<number | undefined> {
  if (!projects.length) return undefined;
  const inspected = await inspectWorkspaceFolder(root, projects, matchesRemote);
  return inspected.kind === 'group-repository' && sameLocalPath(inspected.path, root) ? inspected.projectId : undefined;
}
