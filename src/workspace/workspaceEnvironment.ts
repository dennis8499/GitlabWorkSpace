import path from 'node:path';
import { lstat, readdir } from 'node:fs/promises';
import type { GitLabProject } from '../api/types';
import { inspectWorkspaceFolder, sameLocalPath, type WorkspaceFolderInspection } from './workspacePaths';
import type { GroupWorkspaceMatch, WorkspaceRepositoryMatch } from './workspaceEnvironmentProtocol';
export type { GroupWorkspaceMatch } from './workspaceEnvironmentProtocol';

/** Local structure chooses the workflow; remote association is per repository only. */
export async function inspectProjectEnvironment(root: string, projects: readonly GitLabProject[],
  matchesRemote: (remote: string, project: GitLabProject) => boolean): Promise<GroupWorkspaceMatch> {
  const repositories: WorkspaceRepositoryMatch[] = [];
  try {
    const inspected = await inspectWorkspaceFolder(root, projects, matchesRemote);
    if (inspected.kind === 'unavailable') return { status: 'error', root, reason: inspected.error, repositories };
    if (!sameLocalPath(inspected.path, root)) return { status: 'error', root,
      reason: '此資料夾位於 Git Repo 內；請開啟或設定 Git 根目錄：' + inspected.path, repositories };
    const profile = inspected.kind === 'directory' ? 'group' : 'repository';
    const add = (item: WorkspaceFolderInspection): void => {
      if (item.kind === 'directory' || item.kind === 'unavailable' || repositories.some(repo => sameLocalPath(repo.path, item.path))) return;
      repositories.push({ name: path.basename(item.path), path: item.path, matched: item.kind === 'group-repository',
        projectId: item.kind === 'group-repository' ? item.projectId : undefined, remoteFingerprint: item.remoteFingerprint });
    };
    add(inspected);
    const children = (await readdir(root, { withFileTypes: true })).filter(child => child.isDirectory() && !child.isSymbolicLink());
    for (let offset = 0; offset < children.length; offset += 4) {
      const results = await Promise.all(children.slice(offset, offset + 4).map(async child => {
        const childPath = path.join(root, child.name);
        try {
          const marker = await lstat(path.join(childPath, '.git'));
          if (marker.isSymbolicLink() || !marker.isDirectory() && !marker.isFile()) return undefined;
          return await inspectWorkspaceFolder(childPath, projects, matchesRemote);
        } catch { return undefined; }
      }));
      for (const result of results) if (result) add(result);
    }
    repositories.sort((a, b) => a.path.localeCompare(b.path));
    return { status: 'matched', root, cloneRoot: root, profile, repositories };
  } catch (error) {
    return { status: 'error', root, reason: error instanceof Error ? error.message : String(error), repositories };
  }
}

/** Compatibility entry point: multiple workspace roots must be selected explicitly. */
export async function inspectWorkspaceEnvironment(folders: readonly { path: string; local: boolean }[],
  projects: readonly GitLabProject[], matchesRemote: (remote: string, project: GitLabProject) => boolean,
  _scope?: { connected: boolean; groupSelected: boolean; projectsReady: boolean }): Promise<GroupWorkspaceMatch> {
  if (folders.length !== 1) return { status: 'ambiguous', repositories: [],
    reason: folders.length ? '請選擇本次操作的專案資料夾。' : '請先在 VS Code 開啟本機專案資料夾。' };
  if (!folders[0].local) return { status: 'error', repositories: [], reason: '請開啟本機專案資料夾。' };
  return inspectProjectEnvironment(folders[0].path, projects, matchesRemote);
}
