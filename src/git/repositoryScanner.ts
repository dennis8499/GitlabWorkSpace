import { execFile } from 'node:child_process';
import { lstat, readdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import type { OperationLog } from '../logging/operationLog';

const exec = promisify(execFile);
export const DEFAULT_SCAN_EXCLUDES = ['.git', 'node_modules', '.venv'];
import type { RepositoryScanState } from './repositoryScanProtocol';
export type { RepositoryScanState, ScannedRepository } from './repositoryScanProtocol';
export const localPathKey = (value: string): string => process.platform === 'win32' ? value.toLocaleLowerCase('en-US') : value;

/** Read-only discovery; VS Code registration is handled separately by the Git service. */
export async function scanWorkspaceRepositories(roots: readonly string[], options: {
  signal?: AbortSignal;
  excludes?: string[];
  gitPath?: string;
  onProgress?: (state: RepositoryScanState) => void;
  log?: OperationLog;
} = {}): Promise<RepositoryScanState> {
  const excludes = [...new Set(['.git', ...(options.excludes ?? DEFAULT_SCAN_EXCLUDES)])];
  const directoryName = (value: string): string => process.platform === 'win32' ? value.toLocaleLowerCase('en-US') : value;
  const excludedNames = new Set(excludes.map(directoryName));
  const state: RepositoryScanState = { status: 'scanning', checkedDirectories: 0, repositories: [], errors: [], excludes };
  const directories = new Set<string>();
  const repositories = new Set<string>();
  const queue: string[] = [];
  let missingGit = false;
  const isCancelled = (): boolean => options.signal?.aborted === true;
  const notify = (): void => options.onProgress?.({ ...state, repositories: [...state.repositories], errors: [...state.errors] });
  const command = async (cwd: string, args: string[]): Promise<string> => {
    const task = async (): Promise<string> => {
      const start = Date.now();
      try {
        const output = await exec(options.gitPath ?? 'git', ['-C', cwd, ...args], {
          windowsHide: true, timeout: 5000, maxBuffer: 1024 * 1024, signal: options.signal
        });
        options.log?.record({ feature: 'git', action: args[0], result: 'success', exitCode: 0, durationMs: Date.now() - start, repositoryPath: cwd });
        return output.stdout;
      } catch (error) {
        const code = error && typeof error === 'object' && 'code' in error && typeof error.code === 'number' ? error.code : undefined;
        options.log?.record({ feature: 'git', action: args[0], result: options.signal?.aborted ? 'cancelled' : 'error', exitCode: code,
          durationMs: Date.now() - start, repositoryPath: cwd, message: 'Git 檢查未完成。' });
        throw error;
      }
    };
    return options.log ? options.log.run('git', args[0], { repositoryPath: cwd }, task) : task();
  };
  const inspect = async (candidate: string, allowParent: boolean): Promise<void> => {
    try {
      const root = await realpath((await command(candidate, ['rev-parse', '--show-toplevel'])).trim());
      if (!allowParent && localPathKey(root) !== localPathKey(candidate)) return;
      const key = localPathKey(root);
      if (repositories.has(key) || isCancelled()) return;
      repositories.add(key);
      const repository = { path: root, name: path.basename(root), remotes: [] as string[] };
      state.repositories.push(repository);
      const remoteText = await command(root, ['remote', '-v']);
      const remotes = [...new Set(remoteText.split(/\r?\n/).flatMap(line => {
        const remote = /^\S+\s+(.+?)\s+\((?:fetch|push)\)$/.exec(line);
        return remote ? [remote[1]] : [];
      }))];
      // Never send credential-bearing remote URLs to a Webview.
      repository.remotes = remotes.map(remote => {
        try { const url = new URL(remote); url.username = ''; url.password = ''; url.search = ''; url.hash = ''; return url.toString(); }
        catch { return remote; } // SCP-style SSH URLs carry a username, not a password.
      });
    } catch (error) {
      if (isCancelled()) return;
      const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
      if (code === 'ENOENT') missingGit = true;
      if (allowParent && typeof code === 'number' && error && typeof error === 'object' && 'stderr' in error && /not a git repository/i.test(String(error.stderr))) return;
      state.errors.push({ path: candidate, message: code === 'ENOENT' ? '找不到 Git 執行檔。' : '無法驗證 Repo，請檢查 Git 狀態與存取權限。' });
    }
  };
  for (let offset = 0; offset < roots.length && !isCancelled(); offset += 4) {
    await Promise.all(roots.slice(offset, offset + 4).map(async root => {
      try {
        const canonical = await realpath(root);
        const marker = await lstat(canonical);
        if (!marker.isDirectory()) throw new Error('Not a directory');
        queue.push(canonical);
        await inspect(canonical, true);
      } catch { state.errors.push({ path: root, message: '無法讀取此工作區資料夾。' }); }
    }));
  }
  let next = 0;
  while (next < queue.length && !isCancelled() && !missingGit) {
    const batch = queue.slice(next, next + 4); next += batch.length;
    await Promise.all(batch.map(async directory => {
      const key = localPathKey(directory);
      if (directories.has(key) || isCancelled()) return;
      directories.add(key);
      try {
        const entries = await readdir(directory, { withFileTypes: true });
        const marker = entries.find(entry => directoryName(entry.name) === '.git');
        if (marker && !marker.isSymbolicLink() && (marker.isFile() || marker.isDirectory())) await inspect(directory, false);
        if (isCancelled()) return;
        for (const entry of entries) {
          if (!entry.isDirectory() || entry.isSymbolicLink() || excludedNames.has(directoryName(entry.name))) continue;
          queue.push(path.join(directory, entry.name));
        }
      } catch { if (!isCancelled()) state.errors.push({ path: directory, message: '無法讀取資料夾，已繼續掃描其他位置。' }); }
      state.checkedDirectories++;
    }));
    notify();
  }
  state.repositories.sort((a, b) => a.path.localeCompare(b.path));
  state.status = isCancelled() ? 'cancelled' : missingGit || !roots.length ? 'error' : 'completed';
  if (!roots.length) state.errors.push({ path: '', message: '請先在 VS Code 開啟本機工作區資料夾。' });
  notify();
  return state;
}
