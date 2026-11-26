import { AsyncResource } from 'node:async_hooks';
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
async function git(root: string, args: string[], options: { signal: AbortSignal; network?: boolean; networkEnvironment?: NodeJS.ProcessEnv }): Promise<string> {
  options.signal.throwIfAborted();
  const result = await captureGitProcess('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'submodule.recurse=false',
    ...(process.platform === 'win32' ? ['-c', 'core.longpaths=true'] : []), ...args], {
    // Local writes need to finish their Git lock transactions before we release the cache.
    cwd: root, signal: options.network ? options.signal : undefined, network: options.network ?? false,
    localRepositoryTransport: args[0] === 'clone' && !options.network,
    timeoutMs: 90_000, maxStdoutBytes: 8 * 1024 * 1024,
    env: { ...process.env, ...options.networkEnvironment, GIT_NO_REPLACE_OBJECTS: '1', GIT_TERMINAL_PROMPT: '0', GIT_NO_LAZY_FETCH: '1', GIT_LFS_SKIP_SMUDGE: '1' }
  });
  if (result.code !== 0 || result.truncated) throw new Error(`管理 Repo 的 Git ${args[0]} 未完成，原 Repo 保持不變。`);
  return result.stdout;
}
async function configureManagedLongPaths(root: string, signal: AbortSignal): Promise<void> {
  // Model/CLI Git commands also need this setting; never copy or change the source configuration.
  if (process.platform === 'win32') await git(root, ['config', '--local', 'core.longpaths', 'true'], { signal });
}
async function exists(file: string): Promise<boolean> { try { await lstat(file); return true; } catch (error) { if (missingFile(error)) return false; throw error; } }
async function independentRepository(root: string, signal: AbortSignal): Promise<void> {
  const actual = await realpath(root), info = await lstat(root);
  if (!info.isDirectory() || info.isSymbolicLink() || !same(actual, root) || !same((await git(root, ['rev-parse', '--show-toplevel'], { signal })).trim(), root)) throw new Error('管理 Repo 根目錄無法驗證。');
  const directory = await lstat(path.join(root, '.git'));
  if (!directory.isDirectory() || directory.isSymbolicLink() || !same((await git(root, ['rev-parse', '--path-format=absolute', '--git-common-dir'], { signal })).trim(), path.join(root, '.git'))) throw new Error('管理 Repo 必須擁有獨立的 Git metadata。');
  if (await exists(path.join(root, '.git', 'objects', 'info', 'alternates'))) throw new Error('管理 Repo 仍借用其他 Repo 的 Git objects。');
}

export interface ManagedRepositoryCacheOptions {
  storage: string; accountKey: string; baseUrl: string; project: GitLabProject;
  localRepository?: string; sourceSha: string; sourceRef?: string; signal?: AbortSignal; networkEnvironment?: NodeJS.ProcessEnv;
  base?: { sha: string; ref: string };
  beforeAccess?: (root: string) => Promise<void>;
  assertCurrent?: () => void;
}

interface ManagedRepository { root: string; remote: 'origin'; key: string; }
interface PreparationCaller {
  check(): void;
  prepare(): Promise<ManagedRepository>;
  reject(reason: unknown): void;
}
interface Preparation {
  started: boolean;
  callers: Set<PreparationCaller>;
  controller: AbortController;
  discard(): void;
  task: Promise<ManagedRepository>;
}
interface PreparationQueue {
  entries: Map<string, Preparation>;
  tail?: Promise<ManagedRepository>;
}
const preparations = new Map<string, PreparationQueue>();

/** Materializes only the requested project. Local seeds are never authoritative remote refs. */
export async function ensureManagedRepositoryCache(options: ManagedRepositoryCacheOptions): Promise<ManagedRepository> {
  const { project, signal } = options;
  signal?.throwIfAborted();
  if (!oid(options.sourceSha) || options.base && !oid(options.base.sha) || !Number.isSafeInteger(project.id) || !project.http_url_to_repo) {
    throw new Error('管理 Repo 缺少已核對的專案與來源 SHA。');
  }
  const remote = new URL(project.http_url_to_repo), server = new URL(options.baseUrl);
  if (!['https:', 'http:'].includes(remote.protocol) || remote.origin !== server.origin || remote.username || remote.password || remote.search || remote.hash) throw new Error('管理 Repo URL 不符合所選 GitLab 站台。');
  const key = createHash('sha256').update(JSON.stringify([options.accountKey, server.href.replace(/\/$/, ''), project.id])).digest('hex');
  const parent = path.join(options.storage, 'codex-repositories'); await mkdir(parent, { recursive: true });
  await ownedStoragePath(options.storage, parent);
  const root = path.join(parent, key), receipt = root + '.json';
  await ownedStoragePath(parent, root);
  const local = options.localRepository ? await realpath(options.localRepository) : undefined;
  await options.beforeAccess?.(root);
  signal?.throwIfAborted();
  const commits = [{ sha: options.sourceSha, ref: options.sourceRef ?? options.sourceSha }, ...(options.base ? [options.base] : [])];
  const cacheKey = process.platform === 'win32' ? path.resolve(root).toLowerCase() : path.resolve(root);
  const input = JSON.stringify([project.http_url_to_repo, process.platform === 'win32' ? local?.toLowerCase() : local,
    commits.map(({ sha, ref }) => [sha, ref])]);
  let queue = preparations.get(cacheKey);
  if (!queue) { queue = { entries: new Map() }; preparations.set(cacheKey, queue); }
  const { entries } = queue;
  let pending = entries.get(input);
  if (!pending) {
    const start = () => startPreparation(entry);
    const discard = () => { if (entries.get(input) === entry) entries.delete(input); };
    const entry: Preparation = { started: false, callers: new Set(), controller: new AbortController(), discard,
      task: (queue.tail ?? Promise.resolve()).then(start, start) };
    const currentQueue = queue;
    currentQueue.tail = entry.task;
    entries.set(input, entry);
    void entry.task.finally(() => {
      entry.discard();
      if (currentQueue.tail === entry.task) preparations.delete(cacheKey);
    }).catch(() => undefined);
    pending = entry;
  }
  const entry = pending;
  let rejectCaller!: (reason: unknown) => void;
  const cancelled = new Promise<never>((_, reject) => { rejectCaller = reject; });
  const caller: PreparationCaller = {
    check: () => { options.assertCurrent?.(); signal?.throwIfAborted(); },
    // The queue may have been entered under a different caller's Windows leases.
    prepare: AsyncResource.bind(() => prepareManagedRepository(options, root, receipt, key, local, commits, entry)),
    reject: rejectCaller
  };
  entry.callers.add(caller);
  const abort = () => {
    entry.callers.delete(caller);
    cancelUnusedPreparation(entry);
    // A started job may still use this caller's Workbench leases.
    if (!entry.started) rejectCaller(signal?.reason);
  };
  signal?.addEventListener('abort', abort, { once: true });
  try {
    const prepared = await Promise.race([entry.task, cancelled]);
    caller.check();
    return prepared;
  } finally {
    signal?.removeEventListener('abort', abort);
    entry.callers.delete(caller);
  }
}

function startPreparation(entry: Preparation): Promise<ManagedRepository> {
  for (const caller of entry.callers) {
    try { caller.check(); }
    catch (error) { caller.reject(error); continue; }
    entry.started = true;
    return caller.prepare();
  }
  entry.discard();
  throw new Error('管理 Repo 準備已取消。');
}

function cancelUnusedPreparation(entry: Preparation): void {
  for (const caller of entry.callers) {
    try { caller.check(); return; }
    catch { /* This caller's environment or request is no longer current. */ }
  }
  entry.discard();
  entry.controller.abort();
}

async function prepareManagedRepository(options: ManagedRepositoryCacheOptions, root: string, receipt: string, key: string,
  local: string | undefined, commits: readonly { sha: string; ref: string }[], entry: Preparation): Promise<ManagedRepository> {
  const { project } = options;
  const parent = path.dirname(root);
  const { signal } = entry.controller;
  const check = () => { cancelUnusedPreparation(entry); signal.throwIfAborted(); };
  const lease = await acquireStorageControl(root + '.control', 'codex-repository-cache', { recoverable: true, signal });
  const materialize = async () => {
    check();
    if (local) {
      if (!same(await realpath(local), local) || !same((await git(local, ['rev-parse', '--show-toplevel'], { signal })).trim(), local)) throw new Error('本機來源不是 Repo 根目錄。');
      const remotes = (await git(local, ['remote'], { signal })).split(/\r?\n/).filter(Boolean);
      const urls = await Promise.allSettled(remotes.map(name => git(local, ['remote', 'get-url', name], { signal })));
      const failure = urls.find(result => result.status === 'rejected');
      if (failure) throw failure.reason;
      if (!urls.some(result => result.status === 'fulfilled' && projectRemoteMatches(result.value.trim(), project))) {
        throw new Error('本機來源 Repo 不符合所選專案。');
      }
    }
    if (await exists(root)) {
      const source = await exists(receipt) ? receipt : path.join(root, '.git', 'gitlab-workspace-cache.json');
      if (!await ownedStoragePath(parent, source)) throw new Error('找不到管理 Repo 的收據。');
      const info = await lstat(source);
      if (!info.isFile() || info.size > 16_384) throw new Error('管理 Repo 的收據無效。');
      const saved = JSON.parse(await readFile(source, 'utf8'));
      if (saved.schema !== 'GitLabWorkspaceRepositoryCache/v1' || saved.key !== key || saved.projectId !== project.id || saved.remoteUrl !== project.http_url_to_repo) throw new Error('管理 Repo 快取的專案身分不符。');
      await independentRepository(root, signal);
      const url = (await git(root, ['remote', 'get-url', 'origin'], { signal })).trim();
      if (url !== project.http_url_to_repo) throw new Error('管理 Repo 的 remote 已變更。');
    } else {
      const stage = path.join(parent, '.seed-' + key.slice(0, 16) + '-' + randomUUID());
      try {
        if (local) await git(parent, ['clone', '--no-hardlinks', '--dissociate', '--no-checkout', '--no-recurse-submodules', '--', local, stage], { signal });
        else {
          await git(parent, ['init', '--template=', ...(options.sourceSha.length === 64 ? ['--object-format=sha256'] : []), '--', stage], { signal });
          await git(stage, ['remote', 'add', 'origin', project.http_url_to_repo], { signal });
        }
        await independentRepository(stage, signal);
        await git(stage, ['remote', 'set-url', 'origin', project.http_url_to_repo], { signal });
        check();
        const manifest = { schema: 'GitLabWorkspaceRepositoryCache/v1', key, projectId: project.id, remoteUrl: project.http_url_to_repo };
        await atomicNetworkJson(path.join(stage, '.git', 'gitlab-workspace-cache.json'), manifest);
        check();
        await rename(stage, root);
        await atomicNetworkJson(receipt, manifest);
      } finally { if (await exists(stage)) await removeOwnedStorage(parent, stage); }
    }
    await configureManagedLongPaths(root, signal);
    for (const { sha, ref } of commits) {
      check();
      const verify = async () => (await git(root, ['rev-parse', '--verify', sha + '^{commit}'], { signal })).trim() === sha;
      if (!await verify().catch(() => false)) {
        if (!oid(ref)) await git(root, ['check-ref-format', ref], { signal });
        check();
        await git(root, ['fetch', '--no-tags', '--no-recurse-submodules', 'origin', ref], { signal, network: true, networkEnvironment: options.networkEnvironment });
        if (!await verify()) throw new Error('同步後仍缺少固定來源 SHA。');
      }
      // Keep both fixed commits reachable when another fetch replaces FETCH_HEAD.
      await git(root, ['update-ref', `refs/gitlab-workspace/cache/${sha}`, sha], { signal });
    }
    check();
    return { root, remote: 'origin' as const, key };
  };
  try { return await withWindowsExecutionLeases(lease.recovery ? [lease.recovery] : [], materialize); }
  finally { await lease.release(); }
}
