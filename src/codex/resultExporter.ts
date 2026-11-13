import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { captureGitProcess } from '../git/gitProcess';
import { ownedStoragePath, removeOwnedStorage } from '../storage/ownedStorage';
import type { CodexTaskRecord } from './protocol';
import { CODEX_RESULT_MAX_BYTES, CODEX_RESULT_MAX_FILES, resultPathKey, safeResultPath,
  type CodexArtifact, type CodexChangeInventory, type CodexResultRestore } from './resultProtocol';

export type AddResultArtifact = (relative: string, bytes: Buffer, mediaType: string, name?: string) => Promise<CodexArtifact>;
const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const same = (a: string, b: string) => process.platform === 'win32' ? path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase() : path.resolve(a) === path.resolve(b);
const oid = (value: string) => /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(value);
/** Remove caller Git overrides; local reads must not accidentally address a different repository. */
function gitEnvironment(emptyConfig: string): NodeJS.ProcessEnv {
  return { ...Object.fromEntries(Object.keys(process.env).filter(name => /^GIT_/i.test(name)).map(name => [name, undefined])),
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: emptyConfig, GIT_CONFIG_SYSTEM: emptyConfig, GIT_CONFIG_COUNT: '0',
    GIT_NO_REPLACE_OBJECTS: '1', GIT_NO_LAZY_FETCH: '1', GIT_ALLOW_PROTOCOL: '', GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0', GIT_LFS_SKIP_SMUDGE: '1' };
}
async function git(root: string, args: string[], emptyConfig: string, overrides: string[] = []): Promise<string> {
  const result = await captureGitProcess('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'core.longpaths=true', '-c', 'core.fsmonitor=false', '-c', 'submodule.recurse=false',
    ...overrides, ...args], { cwd: root, env: gitEnvironment(emptyConfig), network: false, timeoutMs: 60_000, maxStdoutBytes: 16 * 1024 * 1024 });
  if (result.code !== 0 || result.truncated) throw new Error(`成果還原驗證的 Git ${args[0]} 未完成；保留原工作目錄。`);
  return result.stdout;
}
async function regularFile(root: string, relative: string): Promise<Buffer> {
  safeResultPath(relative);
  const file = path.join(root, ...relative.split('/'));
  if (!await ownedStoragePath(root, file)) throw new Error('成果檔案已遺失；保留原工作目錄。');
  const info = await lstat(file);
  if (!info.isFile() || info.isSymbolicLink() || info.size > CODEX_RESULT_MAX_BYTES) throw new Error('成果包含不支援的類型或超過容量；保留原工作目錄。');
  const bytes = await readFile(file);
  if (bytes.length !== info.size) throw new Error('成果檔案在保存期間變更，請重試。');
  return bytes;
}
function entriesFromRaw(raw: string): Array<{ path: string; oldMode: string; mode: string }> {
  const parts = raw.split('\0'); if (parts.pop() !== '') throw new Error('Git 變更清單不完整。');
  const entries: Array<{ path: string; oldMode: string; mode: string }> = [];
  for (let index = 0; index < parts.length; index += 2) {
    const match = /^:(\d{6}) (\d{6}) [a-f0-9]+ [a-f0-9]+ ([AMDT])$/.exec(parts[index]);
    if (!match || parts[index + 1] === undefined) throw new Error('Git 變更清單含衝突或不支援的內容。');
    entries.push({ path: safeResultPath(parts[index + 1]), oldMode: match[1], mode: match[2] });
  }
  return entries;
}
function indexEntries(raw: string): Map<string, { mode: string; oid: string }> {
  const entries = new Map<string, { mode: string; oid: string }>();
  for (const line of raw.split('\0').filter(Boolean)) {
    const match = /^(\d{6}) ([a-f0-9]+) (\d)\t([\s\S]+)$/.exec(line);
    if (!match || match[3] !== '0' || !oid(match[2])) throw new Error('Git index 含未解決衝突，保留原工作目錄。');
    entries.set(safeResultPath(match[4]), { mode: match[1], oid: match[2] });
  }
  return entries;
}

/** Saves task changes only. The original user repository/base SHA remain prerequisites. */
export async function exportCodexTaskChanges(record: CodexTaskRecord, stage: string, add: AddResultArtifact): Promise<CodexResultRestore | undefined> {
  const source = record.spec.source;
  if (!(source.kind === 'issue' || source.kind === 'merge-request' && source.intent === 'fix-comments' || source.kind === 'free')) return;
  const original = record.spec.origin?.repositoryRoot ?? (source.kind === 'free' ? source.repository : record.root);
  const root = record.spec.executionRoot ?? original;
  const emptyConfig = path.join(stage, '.empty-git-config'); await writeFile(emptyConfig, '', { flag: 'wx', mode: 0o600 });
  const probe = await captureGitProcess('git', ['rev-parse', '--show-toplevel'], { cwd: root, env: gitEnvironment(emptyConfig), network: false, timeoutMs: 5000 });
  if (probe.code !== 0) {
    if (source.kind === 'free') return;
    throw new Error('成果來源 Repo 不存在，無法證明變更可還原；保留原工作目錄。');
  }
  if (!same(await realpath(root), probe.stdout.trim())) throw new Error('成果執行目錄不是已綁定的 Git 根目錄。');
  const originalRepository = await realpath(original), workingRoot = await realpath(root);
  const common = (await git(workingRoot, ['rev-parse', '--path-format=absolute', '--git-common-dir'], emptyConfig)).trim();
  const originalCommon = (await git(originalRepository, ['rev-parse', '--path-format=absolute', '--git-common-dir'], emptyConfig)).trim();
  if (!same(await realpath(common), await realpath(originalCommon))) throw new Error('成果工作目錄不屬於原 Repo。');
  const headSha = (await git(workingRoot, ['rev-parse', '--verify', 'HEAD^{commit}'], emptyConfig)).trim();
  const baseSha = record.spec.origin?.sourceSha ?? headSha;
  if (!oid(baseSha) || !oid(headSha)) throw new Error('成果缺少可核對的 base SHA。');
  await git(originalRepository, ['cat-file', '-e', baseSha + '^{commit}'], emptyConfig);
  const format = (await git(originalRepository, ['rev-parse', '--show-object-format'], emptyConfig)).trim();
  if (format !== 'sha1' && format !== 'sha256') throw new Error('不支援此 Git object format。');
  const indexBefore = await git(workingRoot, ['ls-files', '--stage', '-z'], emptyConfig); indexEntries(indexBefore);
  if ((await git(workingRoot, ['ls-files', '-v', '-z'], emptyConfig)).split('\0').some(entry => /^[a-zS] /.test(entry))) throw new Error('Git index 含隱藏變更旗標，無法證明完整成果；保留原工作目錄。');
  const configurationEnvironment = { ...Object.fromEntries(Object.keys(process.env).filter(name => /^GIT_/i.test(name)).map(name => [name, undefined])),
    GIT_TERMINAL_PROMPT: '0', GIT_NO_LAZY_FETCH: '1', GIT_ALLOW_PROTOCOL: '' };
  const normalization: string[] = [];
  for (const [name, accepted] of [['core.autocrlf', ['true', 'false', 'input']], ['core.eol', ['lf', 'crlf', 'native']]] as const) {
    const configured = await captureGitProcess('git', ['config', '--get', name], { cwd: workingRoot, env: configurationEnvironment, network: false, timeoutMs: 5000 });
    if (![0, 1].includes(configured.code)) throw new Error('無法核對 Git 換行設定。');
    const value = configured.stdout.trim(); if (value && (accepted as readonly string[]).includes(value)) normalization.push('-c', name + '=' + value);
  }
  // A configured clean/smudge program must not execute during a local-only export.
  const filterProbe = await captureGitProcess('git', ['config', '--name-only', '--get-regexp', '^filter\\.'],
    { cwd: workingRoot, env: gitEnvironment(emptyConfig), network: false, timeoutMs: 5000 });
  if (![0, 1].includes(filterProbe.code) || filterProbe.truncated) throw new Error('無法核對 Git filter 設定。');
  const filters = [...new Set(filterProbe.stdout.split(/\r?\n/).filter(Boolean).map(name => name.slice(0, name.lastIndexOf('.'))))];
  const overrides = [...normalization, ...filters.flatMap(name => ['-c', name + '.clean=', '-c', name + '.smudge=', '-c', name + '.process=', '-c', name + '.required=false'])];
  const rawArgs = ['diff', '--raw', '--no-abbrev', '--no-renames', '--no-ext-diff', '--no-textconv', '-z', baseSha, '--'];
  const raw = await git(workingRoot, rawArgs, emptyConfig, overrides), tracked = entriesFromRaw(raw);
  const untrackedRaw = await git(workingRoot, ['ls-files', '--others', '--exclude-standard', '-z'], emptyConfig);
  const untracked = untrackedRaw.split('\0'); if (untracked.pop() !== '') throw new Error('未追蹤成果清單不完整。');
  if (tracked.length + untracked.length > CODEX_RESULT_MAX_FILES) throw new Error('成果檔案數超過限制；保留原工作目錄。');
  const patchPath = path.join(stage, '.changes.patch');
  await git(workingRoot, ['diff', '--binary', '--full-index', '--no-renames', '--no-ext-diff', '--no-textconv', '--no-color',
    '--src-prefix=a/', '--dst-prefix=b/', '--output=' + patchPath, baseSha, '--'], emptyConfig, overrides);
  const patch = await regularFile(stage, '.changes.patch');
  const patchArtifact = await add('code/changes.patch', patch, 'text/x-diff', '本任務的完整 Git binary patch');
  const inventory: CodexChangeInventory = { schema: 'GitLabWorkspaceCodexChangeInventory/v1', baseSha, entries: [] };
  const physicalNames = new Map<string, string>();
  const addEntry = async (relative: string, mode: string, isTracked: boolean): Promise<void> => {
    safeResultPath(relative);
    if (!['100644', '100755', '000000'].includes(mode)) throw new Error('成果包含 symlink／submodule，無法完整還原；保留原工作目錄。');
    const key = resultPathKey(relative), previous = physicalNames.get(key);
    if (previous !== undefined && previous !== relative) throw new Error('成果檔名在不同平台會衝突；保留原工作目錄。');
    physicalNames.set(key, relative);
    if (mode === '000000') { inventory.entries.push({ path: relative, tracked: isTracked, action: 'delete', mode }); return; }
    const bytes = await regularFile(workingRoot, relative);
    const artifact = await add('code/' + (isTracked ? 'tracked/' : 'untracked/') + relative, bytes, 'application/octet-stream', relative);
    inventory.entries.push({ path: relative, tracked: isTracked, action: 'write', mode: mode as '100644' | '100755', artifactId: artifact.id, sha256: artifact.sha256 });
  };
  for (const entry of tracked) {
    if (![entry.oldMode, entry.mode].every(mode => ['000000', '100644', '100755'].includes(mode))) throw new Error('成果含不支援的 Git 檔案類型；保留原工作目錄。');
    await addEntry(entry.path, entry.mode, true);
  }
  for (const relative of untracked) {
    const info = await lstat(path.join(workingRoot, safeResultPath(relative)));
    await addEntry(relative, process.platform !== 'win32' && info.mode & 0o111 ? '100755' : '100644', false);
  }
  const verification = path.join(stage, '.v-' + randomUUID().slice(0, 8)); await mkdir(verification);
  try {
    await git(verification, ['init', '--quiet', '--object-format=' + format], emptyConfig);
    const objectDirectory = path.join(await realpath(originalCommon), 'objects');
    if (/[\r\n]/.test(objectDirectory)) throw new Error('原 Repo 路徑無法安全用於還原驗證。');
    await mkdir(path.join(verification, '.git', 'objects', 'info'), { recursive: true });
    await writeFile(path.join(verification, '.git', 'objects', 'info', 'alternates'), objectDirectory.replaceAll('\\', '/') + '\n');
    await git(verification, ['read-tree', baseSha], emptyConfig);
    if (patch.length) {
      await git(verification, ['apply', '--cached', '--binary', '--check', '--whitespace=nowarn', patchPath], emptyConfig);
      await git(verification, ['apply', '--cached', '--binary', '--whitespace=nowarn', patchPath], emptyConfig);
    }
    const restoredIndex = indexEntries(await git(verification, ['ls-files', '--stage', '-z'], emptyConfig));
    for (const entry of inventory.entries) {
      if (entry.tracked) {
        const restored = restoredIndex.get(entry.path);
        if (entry.action === 'delete' ? !!restored : !restored || restored.mode !== entry.mode) throw new Error('Git patch 未能還原成果檔案模式。');
      }
      if (entry.action === 'write') {
        const artifactBytes = await regularFile(stage, 'code/' + (entry.tracked ? 'tracked/' : 'untracked/') + entry.path);
        if (digest(artifactBytes) !== entry.sha256) throw new Error('成果 bytes 在還原驗證前已變更。');
        const destination = path.join(verification, 'restored', ...entry.path.split('/'));
        await mkdir(path.dirname(destination), { recursive: true }); await writeFile(destination, artifactBytes, { flag: 'wx' });
        if (digest(await regularFile(path.join(verification, 'restored'), entry.path)) !== entry.sha256) throw new Error('成果 bytes 未能完整還原。');
      }
    }
  } finally { await removeOwnedStorage(stage, verification); }
  // Detect concurrent source edits before authorizing destructive cleanup.
  if (await git(workingRoot, rawArgs, emptyConfig, overrides) !== raw || await git(workingRoot, ['ls-files', '--others', '--exclude-standard', '-z'], emptyConfig) !== untrackedRaw ||
    await git(workingRoot, ['ls-files', '--stage', '-z'], emptyConfig) !== indexBefore || (await git(workingRoot, ['rev-parse', 'HEAD'], emptyConfig)).trim() !== headSha) throw new Error('成果在保存期間變更，請重試；保留原工作目錄。');
  for (const entry of inventory.entries) if (entry.action === 'write' && digest(await regularFile(workingRoot, entry.path)) !== entry.sha256) throw new Error('成果在保存期間變更，請重試；保留原工作目錄。');
  const inventoryArtifact = await add('code/inventory.json', Buffer.from(JSON.stringify(inventory, null, 2) + '\n'), 'application/json', '檔案還原清單');
  return { schema: 'GitLabWorkspaceCodexChanges/v1', originalRepository, baseSha, headSha, objectFormat: format,
    patchArtifactId: patchArtifact.id, inventoryArtifactId: inventoryArtifact.id, validatedAt: new Date().toISOString() };
}

/** Shared only with the verified result restorer; always local and without hooks/filters. */
export { git as resultGit, gitEnvironment as resultGitEnvironment };
