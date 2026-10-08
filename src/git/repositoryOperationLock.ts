import path from 'node:path';
import { readFile, realpath, stat } from 'node:fs/promises';

const queues = new Map<string, Promise<void>>();

async function directoryKey(candidate: string): Promise<string> {
  let normalized = path.resolve(candidate);
  const gitDirectory = await gitDirectoryForRepository(normalized);
  if (gitDirectory) {
    normalized = gitDirectory;
    const commonDirectoryFile = path.join(gitDirectory, 'commondir');
    try {
      normalized = path.resolve(gitDirectory, (await readFile(commonDirectoryFile, 'utf8')).trim());
    } catch { /* A malformed worktree marker falls back to its own Git directory. */ }
  }
  try { normalized = await realpath(normalized); } catch { /* A clone target may not exist yet. */ }
  return process.platform === 'win32' ? normalized.toLocaleLowerCase('en-US') : normalized;
}

export async function gitDirectoryForRepository(repositoryPath: string): Promise<string | undefined> {
  const dotGit = path.join(path.resolve(repositoryPath), '.git');
  try {
    if ((await stat(dotGit)).isDirectory()) return await realpath(dotGit);
  } catch { /* A worktree or submodule has a .git file, not a directory. */ }
  try {
    const marker = await readFile(dotGit, 'utf8');
    const match = /^gitdir:\s*(.+)\s*$/im.exec(marker);
    return match ? path.resolve(path.dirname(dotGit), match[1]) : undefined;
  } catch { return undefined; }
}

export async function withGitDirectoryLock<T>(repositoryPath: string, operation: () => Promise<T>): Promise<T> {
  return withDirectoryKeyLock(await directoryKey(repositoryPath), operation);
}

async function withDirectoryKeyLock<T>(key: string, operation: () => Promise<T>): Promise<T> {
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
  const entries = await Promise.all(repositoryPaths.map(async candidate => [await directoryKey(candidate), candidate] as const));
  const keys = [...new Map(entries).keys()].sort((first, second) => first.localeCompare(second));
  const acquire = (index: number): Promise<T> => index >= keys.length
    ? operation()
    : withDirectoryKeyLock(keys[index], () => acquire(index + 1));
  return acquire(0);
}
