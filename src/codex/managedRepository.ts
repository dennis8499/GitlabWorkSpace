import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, realpath, rename } from 'node:fs/promises';
import path from 'node:path';
import type { GitLabProject } from '../api/types';
import { atomicNetworkJson } from '../api/localNetworkLease';
import { projectRemoteMatches } from '../git/cloneService';
import { captureGitProcess } from '../git/gitProcess';
import { acquireStorageControl } from '../storage/controlLease';
import { insideStorage, missingFile, ownedStoragePath, removeOwnedStorage } from '../storage/ownedStorage';
import type { CodexTaskSpec } from './protocol';

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
}
/** Read-only ownership check used when a task's cache is outside the visible VS Code folders. */
export async function verifyManagedRepositoryCacheBinding(storage: string, repository: string, origin: { accountKey: string; baseUrl: string; projectId: number }): Promise<boolean> {
  const server = new URL(origin.baseUrl), key = createHash('sha256').update(JSON.stringify([origin.accountKey, server.href.replace(/\/$/, ''), origin.projectId])).digest('hex');
  if (!same(repository, path.join(storage, 'codex-repositories', key))) return false;
  if (!await ownedStoragePath(storage, repository)) return false;
  const receipt = path.join(repository, '.git', 'gitlab-workspace-cache.json'); await ownedStoragePath(storage, receipt);
  const info = await lstat(receipt);
  if (!info.isFile() || info.isSymbolicLink() || info.size > 16_384) throw new Error('管理 Repo 收據無法驗證。');
  const saved = JSON.parse(await readFile(receipt, 'utf8'));
  if (saved.schema !== 'GitLabWorkspaceRepositoryCache/v1' || saved.key !== key || saved.projectId !== origin.projectId ||
    typeof saved.remoteUrl !== 'string' || new URL(saved.remoteUrl).origin !== server.origin) throw new Error('管理 Repo 收據的專案不符。');
  await independentRepository(repository);
  if ((await git(repository, ['remote', 'get-url', 'origin'])).trim() !== saved.remoteUrl) throw new Error('管理 Repo 的 remote 已變更。');
  return true;
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
  const lease = await acquireStorageControl(root + '.control', 'codex-repository-cache', { signal });
  try {
    let local: string | undefined;
    if (options.localRepository) {
      local = await realpath(options.localRepository);
      if (!same((await git(local, ['rev-parse', '--show-toplevel'])).trim(), local)) throw new Error('本機來源不是 Repo 根目錄。');
      const remotes = (await git(local, ['remote'])).split(/\r?\n/).filter(Boolean);
      if (!(await Promise.all(remotes.map(async name => projectRemoteMatches((await git(local!, ['remote', 'get-url', name])).trim(), project)))).some(Boolean)) throw new Error('本機來源 Repo 不符合所選專案。');
    }
    if (await exists(root)) {
      const saved = JSON.parse(await readFile(await exists(receipt) ? receipt : path.join(root, '.git', 'gitlab-workspace-cache.json'), 'utf8'));
      if (saved.schema !== 'GitLabWorkspaceRepositoryCache/v1' || saved.key !== key || saved.projectId !== project.id || saved.remoteUrl !== project.http_url_to_repo) throw new Error('管理 Repo 快取的專案身分不符。');
      await independentRepository(root);
      if (!projectRemoteMatches((await git(root, ['remote', 'get-url', 'origin'])).trim(), project)) throw new Error('管理 Repo 的 remote 已變更。');
    } else {
      const stage = path.join(parent, '.seed-' + key.slice(0, 16) + '-' + randomUUID());
      try {
        await git(parent, ['clone', '--no-hardlinks', '--dissociate', '--no-checkout', '--no-recurse-submodules', '--', local ?? project.http_url_to_repo, stage], { signal, network: !local, networkEnvironment: options.networkEnvironment });
        await independentRepository(stage);
        await git(stage, ['remote', 'set-url', 'origin', project.http_url_to_repo]);
        const manifest = { schema: 'GitLabWorkspaceRepositoryCache/v1', key, projectId: project.id, remoteUrl: project.http_url_to_repo };
        await atomicNetworkJson(path.join(stage, '.git', 'gitlab-workspace-cache.json'), manifest);
        await rename(stage, root);
        await atomicNetworkJson(receipt, manifest);
      } finally { if (await exists(stage)) await removeOwnedStorage(parent, stage); }
    }
    await configureManagedLongPaths(root);
    // Refresh only this whitelist when the user fixes source identity/signing
    // settings; a previously seeded cache must not retain stale values forever.
    if (local) await copyCommitConfiguration(local, root, false);
    let present = false;
    try { present = (await git(root, ['rev-parse', '--verify', options.sourceSha + '^{commit}'])).trim() === options.sourceSha; } catch { /* Fetch only the missing fixed source. */ }
    if (!present) {
      const ref = options.sourceRef ?? options.sourceSha;
      if (!oid(ref)) await git(root, ['check-ref-format', ref]);
      await git(root, ['fetch', '--no-tags', '--no-recurse-submodules', 'origin', ref], { signal, network: true, networkEnvironment: options.networkEnvironment });
      if ((await git(root, ['rev-parse', '--verify', options.sourceSha + '^{commit}'])).trim() !== options.sourceSha) throw new Error('同步後仍缺少固定來源 SHA。');
    }
    // Retained baselines remain available to archives, result restore and later
    // tasks even when a future fetch replaces FETCH_HEAD or Git runs maintenance.
    await git(root, ['update-ref', `refs/gitlab-workspace/cache/${options.sourceSha}`, options.sourceSha]);
    return { root, remote: 'origin', key };
  } finally { await lease.release(); }
}

/** Copy only commit-relevant settings; clone never inherits the source's config or hooks wholesale. */
async function copyCommitConfiguration(source: string, target: string, requireIdentity = true): Promise<void> {
  for (const name of ['user.name', 'user.email', 'user.signingkey', 'commit.gpgsign', 'gpg.format', 'gpg.program', 'gpg.openpgp.program', 'gpg.x509.program', 'gpg.ssh.program', 'gpg.ssh.defaultKeyCommand', 'core.autocrlf', 'core.eol']) {
    const response = await captureGitProcess('git', ['config', '--get', name], { cwd: source, network: false, timeoutMs: 5000, maxStdoutBytes: 64_000 });
    if (![0, 1].includes(response.code) || response.truncated) throw new Error('無法核對 Git 提交設定。');
    const value = response.stdout.trim();
    if (response.code === 0 && value) { if (/[\r\n\0]/.test(value)) throw new Error('Git 提交設定格式無效。'); await git(target, ['config', '--local', name, value]); }
    else {
      const removed = await captureGitProcess('git', ['config', '--local', '--unset-all', name], { cwd: target, network: false, timeoutMs: 5000, maxStdoutBytes: 1000 });
      if (![0, 5].includes(removed.code) || removed.truncated) throw new Error('無法更新 Git 提交設定。');
    }
  }
  if (requireIdentity) await verifyCommitConfiguration(target);
}

/** Read-only preflight: never invokes a signing program, key command or hardware. */
export async function verifyCommitConfiguration(root: string): Promise<void> {
  const read = async (args: string[], absent = false): Promise<string | undefined> => {
    const result = await captureGitProcess('git', args, { cwd: root, network: false, timeoutMs: 5000, maxStdoutBytes: 64_000,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_NO_LAZY_FETCH: '1' } });
    if (absent && result.code === 1 && !result.truncated) return undefined;
    if (result.code !== 0 || result.truncated) throw new Error('Git 提交身分或簽章設定無法使用，請修正此專案設定後重試；準備階段不會啟動簽章程式。');
    return result.stdout.trim();
  };
  for (const name of ['user.name', 'user.email']) if (!await read(['config', '--get', name], true)) throw new Error('請先設定此專案的 Git user.name 與 user.email。');
  for (const variable of ['GIT_AUTHOR_IDENT', 'GIT_COMMITTER_IDENT']) if (!await read(['var', variable])) throw new Error('Git 提交身分無效。');
  const signing = await read(['config', '--type=bool', '--get', 'commit.gpgsign'], true);
  const format = await read(['config', '--get', 'gpg.format'], true) ?? 'openpgp';
  if (!['openpgp', 'x509', 'ssh'].includes(format)) throw new Error('Git gpg.format 必須為 openpgp、x509 或 ssh。');
  if (signing === 'true' && format === 'ssh' && !await read(['config', '--get', 'user.signingkey'], true) &&
    !await read(['config', '--get', 'gpg.ssh.defaultKeyCommand'], true)) throw new Error('SSH 提交簽章需要 user.signingkey 或 gpg.ssh.defaultKeyCommand；準備階段不會啟動金鑰或簽章程式。');
}

export async function startManagedClone(spec: CodexTaskSpec): Promise<string> {
  const workflow = spec.workflow, binding = workflow?.managedClone;
  if (!workflow || !binding || !spec.origin || !same(binding.path, path.join(workflow.runtimeRoot, 'repository')) ||
    !same(binding.cacheRepository, spec.origin.repositoryRoot) || binding.sourceSha !== spec.origin.sourceSha || binding.branch !== spec.origin.branch || !oid(binding.sourceSha)) throw new Error('任務 Clone 綁定無效。');
  await mkdir(workflow.runtimeRoot, { recursive: true });
  const receipt = path.join(workflow.runtimeRoot, 'managed-clone.json'), intent = path.join(workflow.runtimeRoot, 'managed-clone-intent.json');
  if (await exists(receipt)) {
    if (JSON.stringify(JSON.parse(await readFile(receipt, 'utf8'))) !== JSON.stringify(binding)) throw new Error('任務 Clone 收據不符。');
    const root = await verifyManagedClone(spec); await configureManagedLongPaths(root); await verifyCommitConfiguration(root); return root;
  }
  await git(binding.cacheRepository, ['check-ref-format', 'refs/heads/' + binding.branch]);
  if (await exists(binding.path)) {
    if (JSON.stringify(JSON.parse(await readFile(intent, 'utf8'))) !== JSON.stringify(binding)) throw new Error('任務 Clone 目錄已被其他工作占用。');
    await verifyManagedClone(spec, false);
    await configureManagedLongPaths(binding.path);
    await verifyCommitConfiguration(binding.path);
  } else {
    await atomicNetworkJson(intent, binding);
    const stage = path.join(workflow.runtimeRoot, '.repository-' + randomUUID());
    try {
      await git(workflow.runtimeRoot, ['clone', '--no-hardlinks', '--dissociate', '--no-checkout', '--no-recurse-submodules', '--', binding.cacheRepository, stage]);
      await independentRepository(stage);
      await configureManagedLongPaths(stage);
      await git(stage, ['remote', 'set-url', 'origin', binding.remoteUrl]);
      await copyCommitConfiguration(binding.cacheRepository, stage);
      await git(stage, ['checkout', '-b', binding.branch, binding.sourceSha]);
      await rename(stage, binding.path);
    } finally { if (await exists(stage)) await removeOwnedStorage(workflow.runtimeRoot, stage); }
  }
  await atomicNetworkJson(receipt, binding);
  return verifyManagedClone(spec);
}

export async function verifyManagedClone(spec: CodexTaskSpec, requireReceipt = true): Promise<string> {
  const workflow = spec.workflow, binding = workflow?.managedClone;
  if (!workflow || !binding || !spec.origin || !same(binding.path, path.join(workflow.runtimeRoot, 'repository')) ||
    !same(binding.cacheRepository, spec.origin.repositoryRoot) || binding.sourceSha !== spec.origin.sourceSha || binding.branch !== spec.origin.branch) throw new Error('任務 Clone 綁定無效。');
  if (!insideStorage(workflow.runtimeRoot, binding.path) || same(binding.cacheRepository, binding.path)) throw new Error('任務 Clone 不在受管理目錄內。');
  await independentRepository(binding.path);
  if (requireReceipt && JSON.stringify(JSON.parse(await readFile(path.join(workflow.runtimeRoot, 'managed-clone.json'), 'utf8'))) !== JSON.stringify(binding)) throw new Error('任務 Clone 收據不符。');
  if ((await git(binding.path, ['symbolic-ref', '--quiet', '--short', 'HEAD'])).trim() !== binding.branch ||
    (await git(binding.path, ['remote', 'get-url', 'origin'])).trim() !== binding.remoteUrl) throw new Error('任務 Clone 的分支或 remote 已變更。');
  await git(binding.path, ['merge-base', '--is-ancestor', binding.sourceSha, 'HEAD']);
  return binding.path;
}
