import path from 'node:path';

export interface ReviewerRepository {
  name: string;
  path: string;
  defaultBranch?: string;
}

/** Reviewer inputs follow all open VS Code folders, independently of the Skills install root. */
export function collectReviewerRepositories(
  nativeRepositories: readonly ReviewerRepository[],
  verifiedRepositories: readonly ReviewerRepository[],
  workspaceFolders: readonly string[],
  platform = process.platform,
  canonicalize: (value: string) => string = value => value
): ReviewerRepository[] {
  const paths = platform === 'win32' ? path.win32 : path.posix;
  const normalize = (value: string): string => paths.resolve(canonicalize(value));
  const key = (value: string): string => platform === 'win32' ? value.toLocaleLowerCase('en-US') : value;
  const contains = (parent: string, child: string): boolean => {
    const relative = paths.relative(key(parent), key(child));
    return !relative || relative !== '..' && !relative.startsWith('..' + paths.sep) && !paths.isAbsolute(relative);
  };
  const folders = workspaceFolders.map(normalize);
  const candidates = new Map<string, ReviewerRepository>();
  // Native entries take precedence, while verified metadata supplies a known default branch.
  for (const repository of [...verifiedRepositories, ...nativeRepositories]) {
    const repositoryPath = normalize(repository.path);
    if (!folders.some(folder => contains(folder, repositoryPath) || contains(repositoryPath, folder))) continue;
    const previous = candidates.get(key(repositoryPath));
    const defaultBranch = repository.defaultBranch ?? previous?.defaultBranch;
    candidates.set(key(repositoryPath), { name: repository.name, path: repositoryPath,
      ...(defaultBranch ? { defaultBranch } : {}) });
  }
  return [...candidates.values()].sort((first, second) =>
    first.name.localeCompare(second.name, 'en-US', { sensitivity: 'base' }) || first.path.localeCompare(second.path));
}
