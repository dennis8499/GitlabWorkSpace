import path from 'node:path';
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';

const queues = new Map<string, Promise<void>>();

function directoryKey(candidate: string): string {
  let normalized = path.resolve(candidate);
  const gitDirectory = gitDirectoryForRepository(normalized);
  if (gitDirectory) {
    normalized = gitDirectory;
    const commonDirectoryFile = path.join(gitDirectory, 'commondir');
    try {
      if (existsSync(commonDirectoryFile)) normalized = path.resolve(gitDirectory, readFileSync(commonDirectoryFile, 'utf8').trim());
    } catch { /* A malformed worktree marker falls back to its own Git directory. */ }
  }
  try { normalized = realpathSync.native(normalized); } catch { /* A clone target may not exist yet. */ }
  return process.platform === 'win32' ? normalized.toLocaleLowerCase('en-US') : normalized;
}

export function gitDirectoryForRepository(repositoryPath: string): string | undefined {
  const dotGit = path.join(path.resolve(repositoryPath), '.git');
  try {
    if (statSync(dotGit).isDirectory()) return realpathSync.native(dotGit);
  } catch { /* A worktree or submodule has a .git file, not a directory. */ }
  try {
    const marker = readFileSync(dotGit, 'utf8');
    const match = /^gitdir:\s*(.+)\s*$/im.exec(marker);
    return match ? path.resolve(path.dirname(dotGit), match[1]) : undefined;
  } catch { return undefined; }
}

export async function withGitDirectoryLock<T>(repositoryPath: string, operation: () => Promise<T>): Promise<T> {
  const key = directoryKey(repositoryPath);
  const previous = queues.get(key) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => { release = resolve; });
  queues.set(key, current);
  await previous;
  try { return await operation(); }
  finally {
    release();
    if (queues.get(key) === current) queues.delete(key);
  }
}

export async function withGitDirectoryLocks<T>(repositoryPaths: readonly string[], operation: () => Promise<T>): Promise<T> {
  const paths = [...new Map(repositoryPaths.map((candidate) => [directoryKey(candidate), candidate])).values()]
    .sort((first, second) => directoryKey(first).localeCompare(directoryKey(second)));
  const acquire = (index: number): Promise<T> => index >= paths.length
    ? operation()
    : withGitDirectoryLock(paths[index], () => acquire(index + 1));
  return acquire(0);
}
