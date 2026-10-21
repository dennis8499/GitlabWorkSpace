import { execFile } from 'node:child_process';
import { readdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import type { GitLabProject } from '../api/types';
import { logGitCommand } from '../git/gitCommandLog';
import { inspectProjectEnvironment } from './workspaceEnvironment';
import { groupRepositoryPath, sameLocalPath } from './workspacePaths';

const execFileAsync = promisify(execFile);
type RemoteMatcher = (remote: string, project: GitLabProject) => boolean;

export interface LocalRepositoryLayout {
  /** Canonical identity; destinations retain the caller's usable root alias. */
  root: string;
  rootProjectId?: number;
  folders: ReadonlyMap<number, string>;
  destinations: ReadonlyMap<number, string>;
  existingProjectIds: ReadonlySet<number>;
}

export class LocalRepositoryMetadataError extends Error {
  constructor(readonly projectIds: readonly number[]) {
    super('本機 SSH Repo 缺少可驗證的專案遠端資訊，請重新取得選取專案後重試。');
    this.name = 'LocalRepositoryMetadataError';
  }
}

/** Discover only the root and its direct children. This function never reads a server. */
export async function resolveLocalRepositoryLayout(root: string, projects: readonly GitLabProject[],
  matchesRemote: RemoteMatcher, signal?: AbortSignal): Promise<LocalRepositoryLayout> {
  signal?.throwIfAborted();
  const canonicalRoot = await realpath(root);
  const byId = new Map<number, GitLabProject>();
  for (const project of projects) {
    if (!Number.isSafeInteger(project.id) || project.id <= 0 || byId.has(project.id)) throw new Error('專案識別資料不完整或重複，請重新載入清單。');
    byId.set(project.id, project);
  }
  const inventory = await inspectProjectEnvironment(root, projects, matchesRemote, signal);
  if (inventory.status !== 'matched') throw new Error(inventory.reason ?? '無法安全辨識本機 Repo 目錄。');
  const rootMatch = inventory.repositories.find(repo => sameLocalPath(repo.path, canonicalRoot) && repo.matched);
  const rootProjectId = rootMatch?.projectId;
  const matches = new Map<number, string[]>();
  const missingMetadata = new Set<number>();
  for (const repo of inventory.repositories) {
    signal?.throwIfAborted();
    if (repo.matched && repo.projectId !== undefined) {
      if (sameLocalPath(repo.path, canonicalRoot)) continue;
      if (!sameLocalPath(path.dirname(repo.path), canonicalRoot)) throw new Error('本機 Repo 不在選取目錄的直接子目錄，已停止操作。');
      const names = matches.get(repo.projectId) ?? [];
      names.push(path.basename(repo.path)); matches.set(repo.projectId, names);
      continue;
    }
    // An SSH path is only a hint to obtain missing metadata after an explicit
    // user operation. It is never accepted as proof of repository identity.
    if (!projects.some(project => !project.ssh_url_to_repo)) continue;
    const origin = await readSingleOrigin(repo.path, signal);
    const namespace = origin && sshNamespace(origin);
    if (namespace) for (const project of projects) {
      if (!project.ssh_url_to_repo && namespace === project.path_with_namespace) missingMetadata.add(project.id);
    }
  }
  for (const projectId of [...missingMetadata]) if (projectId === rootProjectId || matches.has(projectId)) missingMetadata.delete(projectId);
  if (missingMetadata.size) throw new LocalRepositoryMetadataError([...missingMetadata]);

  const occupied = new Map((await readdir(canonicalRoot)).map(name => [name.toLocaleLowerCase('en-US'), name]));
  const folders = new Map<number, string>(), destinations = new Map<number, string>(), existingProjectIds = new Set<number>();
  const used = new Set<string>();
  for (const project of projects) {
    signal?.throwIfAborted();
    const names = project.id === rootProjectId ? [] : matches.get(project.id) ?? [];
    if (names.length > 1) throw new Error(`專案 ${project.path_with_namespace} 有多份本機副本；請開啟要更新的 Repo 作為操作根目錄。`);
    const name = names[0] ?? `${project.path}--${project.id}`;
    folders.set(project.id, name);
    const destination = groupRepositoryPath(root, project, projects, folders, rootProjectId);
    const folded = destination.toLocaleLowerCase('en-US');
    if (used.has(folded)) throw new Error('選取專案的本機目錄重複，已停止操作。');
    used.add(folded);
    if (project.id === rootProjectId || names.length) existingProjectIds.add(project.id);
    else if (occupied.has(name.toLocaleLowerCase('en-US'))) throw new Error(`下載目錄 ${name} 已被其他項目占用；不會覆蓋或改名。`);
    destinations.set(project.id, destination);
  }
  return { root: canonicalRoot, rootProjectId, folders, destinations, existingProjectIds };
}

/** A confirmation must never turn into an update/clone at a different destination. */
export function assertSameLocalRepositoryLayout(reviewed: LocalRepositoryLayout, current: LocalRepositoryLayout): void {
  if (!sameLocalPath(reviewed.root, current.root) || reviewed.destinations.size !== current.destinations.size ||
    [...reviewed.destinations].some(([id, destination]) => !current.destinations.has(id) ||
      !sameLocalPath(destination, current.destinations.get(id)!) || reviewed.existingProjectIds.has(id) !== current.existingProjectIds.has(id))) {
    throw new Error('本機 Repo 位置已在確認後變更，請重新確認下載／更新目的地。');
  }
}

async function readSingleOrigin(repository: string, signal?: AbortSignal): Promise<string | undefined> {
  try {
    const result = await logGitCommand(['config'], repository, () => execFileAsync('git', ['-C', repository, 'config', '--null', '--get-all', 'remote.origin.url'], {
      windowsHide: true, timeout: 5000, maxBuffer: 1024 * 1024, signal
    }));
    const origins = result.stdout.split('\0').filter(Boolean);
    return origins.length === 1 ? origins[0] : undefined;
  } catch { signal?.throwIfAborted(); return undefined; }
}

function sshNamespace(origin: string): string | undefined {
  try {
    if (/^ssh:\/\//i.test(origin)) return new URL(origin).pathname.replace(/^\/+/, '').replace(/\/+$/, '').replace(/\.git$/i, '');
    if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(origin)) return undefined;
    return /^(?:[^@/:]+@)?(?:\[[^\]]+\]|[^/:]+):(.+)$/.exec(origin)?.[1].replace(/^\/+/, '').replace(/\/+$/, '').replace(/\.git$/i, '');
  } catch { return undefined; }
}
