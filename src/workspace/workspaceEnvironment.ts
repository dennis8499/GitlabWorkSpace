import path from 'node:path';
import { lstat, readdir } from 'node:fs/promises';
import type { GitLabProject } from '../api/types';
import { inspectWorkspaceFolder, resolveGroupWorkspaceRoot, sameLocalPath, type WorkspaceFolderInspection } from './workspacePaths';

import type { GroupWorkspaceMatch, WorkspaceRepositoryMatch } from './workspaceEnvironmentProtocol';
export type { GroupWorkspaceMatch } from './workspaceEnvironmentProtocol';

/** Inspect current VS Code folders only. Local discovery also works without GitLab. */
export async function inspectWorkspaceEnvironment(
  folders: readonly { path: string; local: boolean }[],
  projects: readonly GitLabProject[],
  matchesRemote: (remote: string, project: GitLabProject) => boolean,
  scope: { connected: boolean; groupSelected: boolean; projectsReady: boolean }
): Promise<GroupWorkspaceMatch> {
  const inspections: WorkspaceFolderInspection[] = [];
  const directories: string[] = [];
  for (const folder of folders) {
    try {
      if (!folder.local) throw new Error('Group 核對需要 VS Code 本機資料夾。');
      const inspected = await inspectWorkspaceFolder(folder.path, projects, matchesRemote);
      if (inspected.kind === 'directory') {
        directories.push(inspected.path);
        const children = (await readdir(inspected.path, { withFileTypes: true })).filter(entry => entry.isDirectory() && !entry.isSymbolicLink());
        // Keep verified native candidates even if another child Repo is broken.
        // Bound Git processes when a Group has many direct children.
        for (let offset = 0; offset < children.length; offset += 4) {
          const results = await Promise.all(children.slice(offset, offset + 4).map(async child => {
            const childPath = path.join(inspected.path, child.name);
            try {
              let marker;
              try { marker = await lstat(path.join(childPath, '.git')); }
              catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
              if (marker.isSymbolicLink() || !marker.isDirectory() && !marker.isFile()) throw new Error(`無法驗證 Git Repo：${childPath}`);
              return await inspectWorkspaceFolder(childPath, projects, matchesRemote);
            } catch (error) {
              return { kind: 'unavailable' as const, path: childPath, error: `${childPath}：${error instanceof Error ? error.message : String(error)}` };
            }
          }));
          inspections.push(...results.filter((item): item is WorkspaceFolderInspection => !!item));
        }
      } else inspections.push(inspected);
    } catch (error) {
      inspections.push({ kind: 'unavailable', path: folder.path, error: error instanceof Error ? error.message : String(error) });
    }
  }
  const repositories: WorkspaceRepositoryMatch[] = [];
  for (const item of inspections) {
    if (item.kind === 'directory' || item.kind === 'unavailable' || repositories.some(repo => sameLocalPath(repo.path, item.path))) continue;
    repositories.push({ name: path.basename(item.path), path: item.path, matched: item.kind === 'group-repository',
      projectId: item.kind === 'group-repository' ? item.projectId : undefined, remoteFingerprint: item.remoteFingerprint,
      reason: item.kind === 'group-repository' ? undefined : 'origin 未唯一對應所選 Group 的專案，或不符合 Group 直屬 Repo 結構。' });
  }
  repositories.sort((a, b) => a.path.localeCompare(b.path));
  const failed = inspections.find(item => item.kind === 'unavailable');
  if (failed?.kind === 'unavailable') return { status: 'error', reason: failed.error, repositories };
  const uniqueDirectories = directories.filter((directory, index) => directories.findIndex(other => sameLocalPath(directory, other)) === index);
  const ready = scope.connected && scope.groupSelected && scope.projectsReady;
  if (!repositories.length) return { status: 'unverified', repositories,
    cloneRoot: ready && uniqueDirectories.length === 1 ? uniqueDirectories[0] : undefined,
    reason: !scope.connected ? '尚未登入 GitLab；可使用原生單 Repo Skills。' : !scope.groupSelected ? '尚未選擇 GitLab Group。'
      : !scope.projectsReady ? 'GitLab 專案清單尚未完成核對。' : '尚無 Repo 可驗證；可先下載所選 Group 的 Repo。' };
  if (!ready) return { status: 'unverified', repositories, reason: !scope.connected ? '尚未登入 GitLab；使用原生單 Repo 流程。'
    : !scope.groupSelected ? '尚未選擇 Group；使用原生單 Repo 流程。' : '無法驗證 GitLab 專案清單；使用單 Repo 流程。' };
  if (repositories.some(repo => !repo.matched)) return { status: 'mismatched', repositories, reason: '所有 Repo 都須對應所選 GitLab Group。' };
  const resolution = resolveGroupWorkspaceRoot([...inspections, ...uniqueDirectories.map(directory => ({ kind: 'directory' as const, path: directory }))]);
  if (!resolution.root) return { status: 'ambiguous', repositories, reason: resolution.error };
  return { status: 'matched', root: resolution.root, cloneRoot: resolution.root, repositories };
}
