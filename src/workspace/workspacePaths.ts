import { createHash } from 'node:crypto';
import { lstatSync } from 'node:fs';
import { resolve, relative, isAbsolute, sep } from 'node:path';
import type { Memento } from 'vscode';
import type { GitLabProject } from '../api/types';

const ROOTS_KEY = 'gitlabWorkspace.groupRoots.v1';

export function projectFolderNames(projects: readonly GitLabProject[]): Map<number, string> {
  const foldedCounts = new Map<string, number>();
  for (const project of projects) {
    const key = project.path.toLocaleLowerCase('en-US');
    foldedCounts.set(key, (foldedCounts.get(key) ?? 0) + 1);
  }
  const fixed = new Set(projects.filter((project) => (foldedCounts.get(project.path.toLocaleLowerCase('en-US')) ?? 0) === 1)
    .map((project) => project.path.toLocaleLowerCase('en-US')));
  const result = new Map<number, string>();
  for (const project of projects) {
    let candidate = project.path;
    if ((foldedCounts.get(project.path.toLocaleLowerCase('en-US')) ?? 0) > 1) candidate = `${project.path}--${project.id}`;
    const key = candidate.toLocaleLowerCase('en-US');
    if (fixed.has(key) && candidate !== project.path) candidate = `${candidate}--${project.id}`;
    let unique = candidate;
    let suffix = 2;
    while ([...result.values()].some((existing) => existing.toLocaleLowerCase('en-US') === unique.toLocaleLowerCase('en-US'))) {
      unique = `${candidate}--${suffix++}`;
    }
    result.set(project.id, unique);
  }
  return result;
}

export function groupRepositoryPath(root: string, project: GitLabProject, projects: readonly GitLabProject[]): string {
  const folder = projectFolderNames(projects).get(project.id);
  if (!folder || !/^[A-Za-z0-9_.-]+$/.test(folder) || folder === '.' || folder === '..' || /[. ]$/.test(folder) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i.test(folder)) {
    throw new Error(`無法安全建立 Repo 路徑：${project.path_with_namespace}`);
  }
  const base = resolve(root);
  const target = resolve(base, folder);
  const rel = relative(base, target);
  if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error('Repo 路徑超出 Group 工作區。');
  return target;
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

export class GroupWorkspaceRegistry {
  constructor(private readonly state: Memento) {}

  getRoot(baseUrl: string | undefined, groupId: number): string | undefined {
    if (!baseUrl || !Number.isSafeInteger(groupId) || groupId <= 0) return undefined;
    return this.roots()[this.key(baseUrl, groupId)];
  }

  async setRoot(baseUrl: string, groupId: number, root: string): Promise<void> {
    const normalized = resolve(root);
    const roots = this.roots();
    roots[this.key(baseUrl, groupId)] = normalized;
    await this.state.update(ROOTS_KEY, roots);
  }

  private roots(): Record<string, string> {
    const stored = this.state.get<Record<string, string>>(ROOTS_KEY, {});
    return stored && typeof stored === 'object' && !Array.isArray(stored) ? stored : {};
  }

  private key(baseUrl: string, groupId: number): string {
    return createHash('sha256').update(`${baseUrl}\0${groupId}`).digest('hex').slice(0, 24);
  }
}
