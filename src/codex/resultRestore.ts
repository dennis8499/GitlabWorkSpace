import { createHash, randomUUID } from 'node:crypto';
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { captureGitProcess } from '../git/gitProcess';
import { insideStorage, missingFile, ownedStoragePath, removeOwnedStorage } from '../storage/ownedStorage';
import { resultGit, resultGitEnvironment } from './resultExporter';
import { CODEX_RESULT_MAX_FILES, resultPathKey, safeResultPath, type CodexArtifact, type CodexChangeInventory, type CodexResultManifest } from './resultProtocol';

interface ResultReader {
  read(id: string): Promise<CodexResultManifest>;
  readArtifact(id: string, artifactId: string): Promise<{ artifact: CodexArtifact; bytes: Buffer }>;
}
export interface CodexManualWorkspace { path: string; branch: string; baseSha: string; }
const same = (a: string, b: string) => process.platform === 'win32' ? path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase() : path.resolve(a) === path.resolve(b);
const digest = (value: Buffer) => createHash('sha256').update(value).digest('hex');

/** A successful destination becomes user-owned. It is never added to task cleanup. */
export async function restoreCodexResultChanges(reader: ResultReader, taskId: string, repository: string, destination: string): Promise<CodexManualWorkspace> {
  const manifest = await reader.read(taskId), restore = manifest.restore;
  if (!restore) throw new Error('這份成果沒有可還原的程式變更。');
  const original = await realpath(repository), expectedOriginal = await realpath(restore.originalRepository), target = path.resolve(destination), parent = path.dirname(target);
  if (!same(original, expectedOriginal)) throw new Error('請使用成果綁定且保留的原 Repo。');
  if (!same(await realpath(parent), parent) || same(target, original) || insideStorage(original, target) || insideStorage(target, original)) throw new Error('請選擇原 Repo 以外、沒有重新導向的新工作目錄。');
  try { await lstat(target); throw new Error('手動還原只接受尚未存在的新工作目錄。'); } catch (error) { if (!missingFile(error)) throw error; }
  const { bytes: inventoryBytes } = await reader.readArtifact(taskId, restore.inventoryArtifactId);
  const inventory = JSON.parse(inventoryBytes.toString('utf8')) as CodexChangeInventory;
  if (inventory.schema !== 'GitLabWorkspaceCodexChangeInventory/v1' || inventory.baseSha !== restore.baseSha || !Array.isArray(inventory.entries) || inventory.entries.length > CODEX_RESULT_MAX_FILES) throw new Error('成果還原清單無效。');
  const names = new Map<string, string>(), entryKeys = new Set<string>();
  for (const entry of inventory.entries) {
    if (!entry || typeof entry.path !== 'string' || typeof entry.tracked !== 'boolean' || !['write', 'delete'].includes(entry.action) ||
      !['000000', '100644', '100755'].includes(entry.mode) || entry.action === 'delete' && (entry.mode !== '000000' || !entry.tracked) ||
      entry.action === 'write' && (!entry.artifactId || !/^[a-f0-9]{64}$/.test(entry.sha256 ?? '') || entry.mode === '000000')) throw new Error('成果含不支援的還原項目。');
    const key = resultPathKey(entry.path), prior = names.get(key), entryKey = key + ':' + entry.tracked;
    if (prior && prior !== entry.path || entryKeys.has(entryKey)) throw new Error('成果還原路徑衝突。');
    names.set(key, entry.path); entryKeys.add(entryKey);
  }
  const temporaryParent = await realpath(os.tmpdir()), temporary = await mkdtemp(path.join(temporaryParent, 'glw-restore-'));
  const emptyConfig = path.join(temporary, 'config'); await writeFile(emptyConfig, '', { flag: 'wx' });
  let created = false, succeeded = false;
  const branch = 'manual/' + manifest.id.slice(0, 16) + '-' + randomUUID().slice(0, 8);
  const rollback = async (): Promise<void> => {
    // Only this new, exact worktree is eligible for rollback. Never guess at moved paths.
    if (!same(await realpath(target), target) || (await resultGit(target, ['symbolic-ref', '--quiet', '--short', 'HEAD'], emptyConfig)).trim() !== branch ||
      (await resultGit(target, ['rev-parse', 'HEAD'], emptyConfig)).trim() !== restore.baseSha) throw new Error('手動還原失敗且目錄所屬已變更；保留新目錄供核對。');
    await ownedStoragePath(parent, target);
    const inspect = async (directory: string): Promise<void> => {
      for (const item of await readdir(directory, { withFileTypes: true })) {
        if (item.isSymbolicLink()) throw new Error('手動還原目錄含重新導向；保留新目錄供核對。');
        if (item.isDirectory()) await inspect(path.join(directory, item.name));
      }
    };
    await inspect(target);
    await resultGit(original, ['worktree', 'remove', '--force', '--', target], emptyConfig);
    await resultGit(original, ['update-ref', '-d', 'refs/heads/' + branch, restore.baseSha], emptyConfig);
  };
  try {
    if (!same((await resultGit(original, ['rev-parse', '--show-toplevel'], emptyConfig)).trim(), original)) throw new Error('原 Repo 根目錄已變更。');
    await resultGit(original, ['cat-file', '-e', restore.baseSha + '^{commit}'], emptyConfig);
    if ((await resultGit(original, ['rev-parse', '--show-object-format'], emptyConfig)).trim() !== restore.objectFormat) throw new Error('原 Repo object format 與成果不符。');
    const common = await realpath((await resultGit(original, ['rev-parse', '--path-format=absolute', '--git-common-dir'], emptyConfig)).trim());
    const filterProbe = await captureGitProcess('git', ['config', '--name-only', '--get-regexp', '^filter\\.'],
      { cwd: original, env: resultGitEnvironment(emptyConfig), network: false, timeoutMs: 5000 });
    if (![0, 1].includes(filterProbe.code) || filterProbe.truncated) throw new Error('無法核對手動工作目錄的 Git filters。');
    const filters = [...new Set(filterProbe.stdout.split(/\r?\n/).filter(Boolean).map(name => name.slice(0, name.lastIndexOf('.'))))];
    const overrides = filters.flatMap(name => ['-c', name + '.clean=', '-c', name + '.smudge=', '-c', name + '.process=', '-c', name + '.required=false']);
    const patch = await reader.readArtifact(taskId, restore.patchArtifactId), patchFile = path.join(temporary, 'changes.patch');
    await writeFile(patchFile, patch.bytes, { flag: 'wx' });
    await resultGit(original, ['worktree', 'add', '--no-checkout', '-b', branch, target, restore.baseSha], emptyConfig, overrides); created = true;
    if (!same(await realpath(target), target) || !same(await realpath((await resultGit(target, ['rev-parse', '--path-format=absolute', '--git-common-dir'], emptyConfig)).trim()), common)) throw new Error('新工作目錄的 Git 所屬無法驗證。');
    await resultGit(target, ['read-tree', restore.baseSha], emptyConfig, overrides);
    // No hooks, submodule recursion, LFS smudge or configured filter programs run.
    await resultGit(target, ['checkout-index', '--all', '--force', '-u'], emptyConfig, overrides);
    if (patch.bytes.length) {
      await resultGit(target, ['apply', '--index', '--binary', '--check', '--whitespace=nowarn', patchFile], emptyConfig, overrides);
      await resultGit(target, ['apply', '--index', '--binary', '--whitespace=nowarn', patchFile], emptyConfig, overrides);
    }
    for (const entry of inventory.entries) {
      const relative = safeResultPath(entry.path), file = path.join(target, ...relative.split('/'));
      if (entry.action === 'delete') {
        try { await lstat(file); if (!inventory.entries.some(other => other.path === entry.path && !other.tracked && other.action === 'write')) throw new Error('刪除的成果檔案仍然存在。'); }
        catch (error) { if (!missingFile(error)) throw error; }
        continue;
      }
      const { artifact, bytes } = await reader.readArtifact(taskId, entry.artifactId!);
      if (artifact.sha256 !== entry.sha256 || digest(bytes) !== entry.sha256 || artifact.path !== 'code/' + (entry.tracked ? 'tracked/' : 'untracked/') + relative) throw new Error('成果 bytes 與還原清單不符。');
      // This validates existing ancestors before creating missing leaf directories.
      await ownedStoragePath(target, file);
      await mkdir(path.dirname(file), { recursive: true });
      if (path.dirname(file) !== target) await ownedStoragePath(target, path.dirname(file));
      try { const info = await lstat(file); if (!info.isFile() || info.isSymbolicLink()) throw new Error('還原目的檔案不是一般檔案。'); } catch (error) { if (!missingFile(error)) throw error; }
      await writeFile(file, bytes);
      if (process.platform !== 'win32') await chmod(file, entry.mode === '100755' ? 0o755 : 0o644);
      if (entry.tracked) await resultGit(target, ['update-index', '--chmod=' + (entry.mode === '100755' ? '+x' : '-x'), '--', relative], emptyConfig, overrides);
      if (digest(await readFile(file)) !== entry.sha256) throw new Error('手動工作目錄的成果 hash 不符。');
    }
    if ((await resultGit(target, ['symbolic-ref', '--quiet', '--short', 'HEAD'], emptyConfig)).trim() !== branch ||
      (await resultGit(target, ['rev-parse', 'HEAD'], emptyConfig)).trim() !== restore.baseSha) throw new Error('手動工作分支在還原期間變更。');
    succeeded = true;
    return { path: target, branch, baseSha: restore.baseSha };
  } finally {
    try {
      if (created && !succeeded) await rollback();
    } finally { await removeOwnedStorage(temporaryParent, temporary); }
  }
}
