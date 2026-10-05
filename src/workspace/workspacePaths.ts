import { execFile } from 'node:child_process';
import { lstatSync, realpathSync } from 'node:fs';
import { lstat, readdir, realpath } from 'node:fs/promises';
import { resolve, relative, isAbsolute, sep } from 'node:path';
import path from 'node:path';
import type { GitLabProject } from '../api/types';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface LocalGroupRepository {
  name: string;
  path: string;
}

export type WorkspaceFolderInspection =
  | { kind: 'directory'; path: string }
  | { kind: 'group-repository'; path: string; groupRoot: string }
  | { kind: 'repository' | 'nested-repository'; path: string }
  | { kind: 'unavailable'; path: string; error: string };

export interface WorkspaceRootResolution {
  root?: string;
  error?: string;
}

/** Pick one Group root from VS Code's already-resolved workspace folders. */
export function resolveGroupWorkspaceRoot(
  inspections: readonly WorkspaceFolderInspection[],
  platform = process.platform
): WorkspaceRootResolution {
  const unavailable = inspections.find((inspection) => inspection.kind === 'unavailable');
  if (unavailable?.kind === 'unavailable') return { error: unavailable.error };

  const matchingRepositoryRoots = uniquePaths(inspections.flatMap((inspection) =>
    inspection.kind === 'group-repository' ? [inspection.groupRoot] : []), platform);
  if (matchingRepositoryRoots.length === 1) return { root: matchingRepositoryRoots[0] };
  if (matchingRepositoryRoots.length > 1) return { error: '目前 VSCode 工作區包含多個 Group Repo 目錄，無法唯一辨識工作區。' };

  const directories = uniquePaths(inspections.flatMap((inspection) =>
    inspection.kind === 'directory' ? [inspection.path] : []), platform);
  if (directories.length === 1) return { root: directories[0] };
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
export async function scanLocalGroupRepositories(root: string): Promise<LocalGroupRepository[]> {
  const rootPath = await realpath(root);
  const entries = await readdir(rootPath, { withFileTypes: true });
  const repositories: LocalGroupRepository[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    const repositoryPath = path.join(rootPath, entry.name);
    let marker;
    try { marker = await lstat(path.join(repositoryPath, '.git')); }
    catch (error) {
      if (error && typeof error === 'object' && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw error;
    }
    if (marker.isSymbolicLink() || (!marker.isDirectory() && !marker.isFile())) continue;

    try {
      const result = await execFileAsync('git', ['-C', repositoryPath, 'rev-parse', '--show-toplevel'], {
        windowsHide: true, timeout: 5000, maxBuffer: 1024 * 1024
      });
      const gitRoot = await realpath(result.stdout.trim());
      const actualPath = await realpath(repositoryPath);
      if (sameLocalPath(gitRoot, actualPath)) repositories.push({ name: entry.name, path: actualPath });
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === 'ENOENT') throw new Error('找不到 Git，無法確認本機 Repo。');
        if (typeof code === 'number') continue;
      }
      throw new Error(`無法確認本機 Repo「${entry.name}」。`);
    }
  }
  return repositories.sort((first, second) => first.name.localeCompare(second.name, 'en-US', { sensitivity: 'base' }));
}

export async function inspectWorkspaceFolder(
  folderPath: string,
  projects: readonly GitLabProject[],
  matchesRemote: (remoteUrl: string, project: GitLabProject) => boolean
): Promise<WorkspaceFolderInspection> {
  const absolutePath = await realpath(folderPath);
  const stat = await lstat(absolutePath);
  if (!stat.isDirectory()) return { kind: 'unavailable', path: absolutePath, error: 'VSCode 工作區項目不是資料夾。' };

  let topLevel: string;
  try {
    const result = await execFileAsync('git', ['-C', absolutePath, 'rev-parse', '--show-toplevel'], {
      windowsHide: true, timeout: 5000, maxBuffer: 1024 * 1024
    });
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

  if (!sameLocalPath(topLevel, absolutePath)) return { kind: 'nested-repository', path: absolutePath };
  const parent = path.dirname(absolutePath);
  let parentIsRepository = false;
  try {
    const result = await execFileAsync('git', ['-C', parent, 'rev-parse', '--show-toplevel'], {
      windowsHide: true, timeout: 5000, maxBuffer: 1024 * 1024
    });
    parentIsRepository = !!result.stdout.trim();
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { kind: 'unavailable', path: absolutePath, error: '找不到 Git，無法辨識 Group Repo。' };
    }
  }
  if (parentIsRepository) return { kind: 'unavailable', path: absolutePath, error: 'Group Repo 的上層資料夾仍位於另一個 Git Repo 內。' };

  let remotes: string[];
  try {
    const result = await execFileAsync('git', ['-C', absolutePath, 'remote'], {
      windowsHide: true, timeout: 5000, maxBuffer: 1024 * 1024
    });
    remotes = result.stdout.split(/\r?\n/).filter(Boolean);
  } catch {
    return { kind: 'unavailable', path: absolutePath, error: '無法讀取 Group Repo 的 remote。' };
  }
  for (const remote of remotes) {
    try {
      const result = await execFileAsync('git', ['-C', absolutePath, 'remote', 'get-url', remote], {
        windowsHide: true, timeout: 5000, maxBuffer: 1024 * 1024
      });
      if (projects.some((project) => matchesRemote(result.stdout.trim(), project))) {
        return { kind: 'group-repository', path: absolutePath, groupRoot: parent };
      }
    } catch { /* Ignore inaccessible or malformed remotes; another remote may identify this Repo. */ }
  }
  return { kind: 'repository', path: absolutePath };
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
  folders: ReadonlyMap<number, string> = projectFolderNames(projects)
): string {
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

export function localRepositoryState(root: string, target: string): 'missing' | 'ready' | 'unsafe' {
  try {
    const rel = relative(resolve(root), resolve(target));
    if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return 'unsafe';
    const stat = lstatSync(target);
    if (!stat.isDirectory() || stat.isSymbolicLink()) return 'unsafe';
    return 'ready';
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT') return 'missing';
    return 'unsafe';
  }
}

export async function localRepositoryStateAsync(root: string, target: string): Promise<'missing' | 'ready' | 'unsafe'> {
  try {
    const rel = relative(resolve(root), resolve(target));
    if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return 'unsafe';
    const stat = await lstat(target);
    if (!stat.isDirectory() || stat.isSymbolicLink()) return 'unsafe';
    return 'ready';
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT') return 'missing';
    return 'unsafe';
  }
}
