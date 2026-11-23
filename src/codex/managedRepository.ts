import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, realpath, rename } from 'node:fs/promises';
import path from 'node:path';
import type { GitLabProject } from '../api/types';
import { atomicNetworkJson } from '../api/localNetworkLease';
import { withWindowsExecutionLeases } from '../api/windowsLocalLease';
import { projectRemoteMatches } from '../git/cloneService';
import { captureGitProcess } from '../git/gitProcess';
import { acquireStorageControl } from '../storage/controlLease';
import { missingFile, ownedStoragePath, removeOwnedStorage } from '../storage/ownedStorage';

const same = (a: string, b: string): boolean => process.platform === 'win32' ? path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase() : path.resolve(a) === path.resolve(b);
const oid = (value: string): boolean => /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(value);
async function git(root: string, args: string[], options: { signal?: AbortSignal; network?: boolean; networkEnvironment?: NodeJS.ProcessEnv } = {}): Promise<string> {
  options.signal?.throwIfAborted();
  const result = await captureGitProcess('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'submodule.recurse=false',
    ...(process.platform === 'win32' ? ['-c', 'core.longpaths=true'] : []), ...args], {
    cwd: root, signal: options.signal, network: options.network ?? false, localRepositoryTransport: args[0] === 'clone' && !options.network,
    timeoutMs: 90_000, maxStdoutBytes: 8 * 1024 * 1024,
    env: { ...process.env, ...options.networkEnvironment, GIT_NO_REPLACE_OBJECTS: '1', GIT_TERMINAL_PROMPT: '0', GIT_NO_LAZY_FETCH: '1', GIT_LFS_SKIP_SMUDGE: '1' }
  });
  if (result.code !== 0 || result.truncated) throw new Error(`管理 Repo 的 Git ${args[0]} 未完成，原 Repo 保持不變。`);
  return result.stdout;
}
async function configureManagedLongPaths(root: string): Promise<void> {
  // Model/CLI Git commands also need this setting; never copy or change the source configuration.
  if (process.platform === 'win32') await git(root, ['config', '--local', 'core.longpaths', 'true']);
}
async function exists(file: string): Promise<boolean> { try { await lstat(file); return true; } catch (error) { if (missingFile(error)) return false; throw error; } }
async function independentRepository(root: string): Promise<void> {
  const actual = await realpath(root), info = await lstat(root);
  if (!info.isDirectory() || info.isSymbolicLink() || !same(actual, root) || !same((await git(root, ['rev-parse', '--show-toplevel'])).trim(), root)) throw new Error('管理 Repo 根目錄無法驗證。');
  const directory = await lstat(path.join(root, '.git'));
  if (!directory.isDirectory() || directory.isSymbolicLink() || !same((await git(root, ['rev-parse', '--path-format=absolute', '--git-common-dir'])).trim(), path.join(root, '.git'))) throw new Error('管理 Repo 必須擁有獨立的 Git metadata。');
  if (await exists(path.join(root, '.git', 'objects', 'info', 'alternates'))) throw new Error('管理 Repo 仍借用其他 Repo 的 Git objects。');
}

export interface ManagedRepositoryCacheOptions {
  storage: string; accountKey: string; baseUrl: string; project: GitLabProject;
  localRepository?: string; sourceSha: string; sourceRef?: string; signal?: AbortSignal; networkEnvironment?: NodeJS.ProcessEnv;
  beforeAccess?: (root: string) => Promise<void>;
}
/** Materializes only the requested project. Local seeds are never authoritative remote refs. */
export async function ensureManagedRepositoryCache(options: ManagedRepositoryCacheOptions): Promise<{ root: string; remote: 'origin'; key: string }> {
  const { project, signal } = options;
  if (!oid(options.sourceSha) || !Number.isSafeInteger(project.id) || !project.http_url_to_repo) throw new Error('管理 Repo 缺少已核對的專案與來源 SHA。');
  const remote = new URL(project.http_url_to_repo), server = new URL(options.baseUrl);
  if (!['https:', 'http:'].includes(remote.protocol) || remote.origin !== server.origin || remote.username || remote.password || remote.search || remote.hash) throw new Error('管理 Repo URL 不符合所選 GitLab 站台。');
  const key = createHash('sha256').update(JSON.stringify([options.accountKey, server.href.replace(/\/$/, ''), project.id])).digest('hex');
  const parent = path.join(options.storage, 'codex-repositories'); await mkdir(parent, { recursive: true });
  await ownedStoragePath(options.storage, parent);
  const root = path.join(parent, key), receipt = root + '.json';
  await ownedStoragePath(parent, root);
  await options.beforeAccess?.(root);
  const lease = await acquireStorageControl(root + '.control', 'codex-repository-cache', { signal, recoverable: true });
  const materialize = async () => {
    let local: string | undefined;
    if (options.localRepository) {
      local = await realpath(options.localRepository);
      if (!same((await git(local, ['rev-parse', '--show-toplevel'])).trim(), local)) throw new Error('本機來源不是 Repo 根目錄。');
      const remotes = (await git(local, ['remote'])).split(/\r?\n/).filter(Boolean);
      if (!(await Promise.all(remotes.map(async name => projectRemoteMatches((await git(local!, ['remote', 'get-url', name])).trim(), project)))).some(Boolean)) throw new Error('本機來源 Repo 不符合所選專案。');
    }
    if (await exists(root)) {
      const source = await exists(receipt) ? receipt : path.join(root, '.git', 'gitlab-workspace-cache.json');
      if (!await ownedStoragePath(parent, source)) throw new Error('找不到管理 Repo 的收據。');
      const info = await lstat(source);
      if (!info.isFile() || info.size > 16_384) throw new Error('管理 Repo 的收據無效。');
      const saved = JSON.parse(await readFile(source, 'utf8'));
      if (saved.schema !== 'GitLabWorkspaceRepositoryCache/v1' || saved.key !== key || saved.projectId !== project.id || saved.remoteUrl !== project.http_url_to_repo) throw new Error('管理 Repo 快取的專案身分不符。');
      await independentRepository(root);
      const url = (await git(root, ['remote', 'get-url', 'origin'])).trim();
      if (url !== project.http_url_to_repo) throw new Error('管理 Repo 的 remote 已變更。');
    } else {
      const stage = path.join(parent, '.seed-' + key.slice(0, 16) + '-' + randomUUID());
      try {
        if (local) await git(parent, ['clone', '--no-hardlinks', '--dissociate', '--no-checkout', '--no-recurse-submodules', '--', local, stage], { signal });
        else {
          await git(parent, ['init', '--template=', ...(options.sourceSha.length === 64 ? ['--object-format=sha256'] : []), '--', stage], { signal });
          await git(stage, ['remote', 'add', 'origin', project.http_url_to_repo], { signal });
        }
        await independentRepository(stage);
        await git(stage, ['remote', 'set-url', 'origin', project.http_url_to_repo]);
        const manifest = { schema: 'GitLabWorkspaceRepositoryCache/v1', key, projectId: project.id, remoteUrl: project.http_url_to_repo };
        await atomicNetworkJson(path.join(stage, '.git', 'gitlab-workspace-cache.json'), manifest);
        await rename(stage, root);
        await atomicNetworkJson(receipt, manifest);
      } finally { if (await exists(stage)) await removeOwnedStorage(parent, stage); }
    }
    await configureManagedLongPaths(root);
    let present = false;
    try { present = (await git(root, ['rev-parse', '--verify', options.sourceSha + '^{commit}'])).trim() === options.sourceSha; } catch { /* Fetch only the missing fixed source. */ }
    if (!present) {
      const ref = options.sourceRef ?? options.sourceSha;
      if (!oid(ref)) await git(root, ['check-ref-format', ref]);
      await git(root, ['fetch', '--no-tags', '--no-recurse-submodules', 'origin', ref], { signal, network: true, networkEnvironment: options.networkEnvironment });
      if ((await git(root, ['rev-parse', '--verify', options.sourceSha + '^{commit}'])).trim() !== options.sourceSha) throw new Error('同步後仍缺少固定來源 SHA。');
    }
    // Keep the verified object available when the next fetch replaces FETCH_HEAD.
    await git(root, ['update-ref', `refs/gitlab-workspace/cache/${options.sourceSha}`, options.sourceSha]);
    return { root, remote: 'origin' as const, key };
  };
  try { return await withWindowsExecutionLeases(lease.recovery ? [lease.recovery] : [], materialize); }
  finally { await lease.release(); }
}
