import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/** Read local branches and already available remote-tracking refs without fetching. */
export async function readReviewerBranches(repositoryPath: string, gitExecutable = 'git'): Promise<string[]> {
  const result = await execFileAsync(gitExecutable,
    ['for-each-ref', '--format=%(refname)%00%(symref)', 'refs/heads', 'refs/remotes'],
    { cwd: repositoryPath, timeout: 15_000, maxBuffer: 16 * 1024 * 1024, windowsHide: true,
      env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' } });
  const branches = result.stdout.split(/\r?\n/).flatMap(line => {
    const [ref, symbolicTarget] = line.split('\0');
    if (!ref || symbolicTarget) return [];
    return [ref.replace(/^refs\/(?:heads|remotes)\//, '')];
  });
  return [...new Set(branches)].sort((first, second) => first.localeCompare(second));
}
