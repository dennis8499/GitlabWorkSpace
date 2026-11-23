import { createHash, randomUUID } from 'node:crypto';
import { link, lstat, mkdir, open, readFile, readdir, realpath, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { atomicNetworkJson } from '../api/localNetworkLease';
import { acquireStorageControl } from '../storage/controlLease';
import { insideStorage, missingFile, ownedStoragePath } from '../storage/ownedStorage';

const digest = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex');
const sameArtifactPath = (stored: string, expected: string): boolean => typeof stored === 'string' &&
  (process.platform === 'win32' ? stored.toLowerCase() === expected.toLowerCase() : stored === expected);
const MAX_BYTES = 32 * 1024 * 1024, MAX_FILES = 2000;
interface ArtifactFile { path: string; sha256: string; bytes: number; }
export interface BmadProjectChange { path: string; beforeHash: string | null; afterHash: string; }
export interface BmadArtifactCapture {
  schema: 'GitLabWorkspaceBmadArtifacts/v1'; id: string; taskId: string; sourceRoot: string;
  capturedAt: string; root: string; digest: string; files: ArtifactFile[]; projectChanges: BmadProjectChange[];
}

class ProjectRuleConflict extends Error {
  constructor() { super('原專案規則已變更，請重新產生並確認差異。'); }
}

export class BmadProjectApplyError extends Error {
  constructor(message: string, readonly detail: string, cause: unknown) { super(message, { cause }); }
}

/** Immutable task output plus a Group/Repo index. Source trees remain untouched until applyProjectChanges. */
export class BmadArtifactStore {
  constructor(private readonly storage: string) {}
  private directory(sourceRoot: string): string { return path.join(this.storage, 'bmad-artifacts', digest(path.resolve(sourceRoot))); }

  async capture(options: { sourceRoot: string; taskId: string; outputRoot?: string; outputPrefix?: string; projectChangesRoot?: string }): Promise<BmadArtifactCapture | undefined> {
    if (!/^[a-zA-Z0-9_-]{1,128}$/.test(options.taskId)) throw new Error('BMAD 任務識別無效。');
    const sourceRoot = await realpath(options.sourceRoot), files = new Map<string, Buffer>();
    const prefix = options.outputPrefix ?? '';
    if (prefix && (path.posix.isAbsolute(prefix) || path.win32.isAbsolute(prefix) || prefix.includes('\\') ||
        prefix.split('/').some(part => !part || part === '.' || part === '..' || !/^[a-zA-Z0-9_.-]+$/.test(part)))) throw new Error('BMAD 成果輸出前綴無效。');
    const changes: BmadProjectChange[] = []; let total = 0;
    const add = (relative: string, content: Buffer): void => {
      if (files.size >= MAX_FILES || content.length > 2 * 1024 * 1024 || total + content.length > MAX_BYTES) throw new Error('BMAD 成果超過保存上限，原始成果已保留。');
      files.set(relative, content); total += content.length;
    };
    if (options.outputRoot) await walk(options.outputRoot, async (relative, content) => add(path.posix.join('_bmad-output', prefix, relative), content));
    if (options.projectChangesRoot) {
      const proposalRoot = await realpath(options.projectChangesRoot);
      const candidate = async (relative: string, content: Buffer): Promise<void> => {
        if (!projectPath(relative)) throw new Error('BMAD 專案規則路徑無效。');
        const before = await readProjectFile(sourceRoot, relative);
        const afterHash = digest(content);
        if (before && digest(before) === afterHash) return;
        add(relative, content); changes.push({ path: relative, beforeHash: before ? digest(before) : null, afterHash });
      };
      const agents = await readProjectFile(proposalRoot, 'AGENTS.md');
      if (agents) await candidate('AGENTS.md', agents);
      await walk(path.join(proposalRoot, '_bmad', 'custom'), (relative, content) => candidate(path.posix.join('_bmad/custom', relative), content));
    }
    if (!files.size) return undefined;
    const inventory = [...files].sort(([a], [b]) => a.localeCompare(b)).map(([filename, content]) => ({ path: filename, sha256: digest(content), bytes: content.length }));
    const captureDigest = digest(JSON.stringify([sourceRoot, options.taskId, inventory, changes]));
    const id = `${options.taskId}-${captureDigest.slice(0, 16)}`, directory = this.directory(sourceRoot), root = path.join(directory, id);
    await mkdir(directory, { recursive: true }); await ownedStoragePath(this.storage, directory);
    const gate = await acquireStorageControl(path.join(directory, options.taskId + '.control'), 'bmad-artifacts', { recoverable: true });
    try {
      const manifestFile = path.join(root, 'manifest.json');
      let capture: BmadArtifactCapture;
      try { capture = await this.readCapture(manifestFile, sourceRoot); }
      catch (error) {
        if (!missingFile(error)) throw error;
        await mkdir(root, { recursive: true }); await ownedStoragePath(this.storage, root);
        for (const file of inventory) {
          const target = path.join(root, file.path); await mkdir(path.dirname(target), { recursive: true });
          await ownedStoragePath(this.storage, path.dirname(target));
          try { await writeFile(target, files.get(file.path)!, { flag: 'wx', mode: 0o600 }); }
          catch (writeError) {
            if ((writeError as NodeJS.ErrnoException).code !== 'EEXIST') throw writeError;
            await ownedStoragePath(this.storage, target);
            if (digest(await readFile(target)) !== file.sha256) throw new Error('未完成保存的成果與本次內容不同，原始成果已保留。', { cause: writeError });
          }
        }
        capture = { schema: 'GitLabWorkspaceBmadArtifacts/v1', id, taskId: options.taskId, sourceRoot, root,
          capturedAt: new Date().toISOString(), digest: captureDigest, files: inventory, projectChanges: changes };
        await atomicNetworkJson(manifestFile, capture);
      }
      const indexFile = path.join(directory, options.taskId + '.json');
      const index = { id: capture.id };
      if (await ownedStoragePath(this.storage, indexFile)) {
        const info = await lstat(indexFile);
        if (info.isFile() && info.size <= 4096 && await readFile(indexFile, 'utf8') === JSON.stringify(index)) return capture;
      }
      await atomicNetworkJson(indexFile, index);
      return capture;
    } finally { await gate.release(); }
  }

  async list(source: string): Promise<BmadArtifactCapture[]> {
    const sourceRoot = await realpath(source), directory = this.directory(sourceRoot);
    let names: string[]; try { names = await readdir(directory); } catch (error) { if (missingFile(error)) return []; throw error; }
    await ownedStoragePath(this.storage, directory);
    const captures: BmadArtifactCapture[] = [];
    for (const filename of names.filter(name => /^[a-zA-Z0-9_-]{1,128}\.json$/.test(name))) {
      const indexFile = path.join(directory, filename); await ownedStoragePath(this.storage, indexFile);
      const info = await lstat(indexFile); if (!info.isFile() || info.size > 4096) throw new Error('BMAD 成果索引無效。');
      const index = JSON.parse(await readFile(indexFile, 'utf8')) as { id?: string };
      if (!index.id || !/^[a-zA-Z0-9_-]{1,160}$/.test(index.id)) throw new Error('BMAD 成果索引識別無效。');
      captures.push(await this.readCapture(path.join(directory, index.id, 'manifest.json'), sourceRoot));
    }
    return captures.sort((a, b) => b.capturedAt.localeCompare(a.capturedAt));
  }
  async roots(sourceRoot: string): Promise<string[]> { return (await this.list(sourceRoot)).map(capture => capture.root); }

  /** Caller presents the diff and passes the digest from that exact confirmation. */
  async applyProjectChanges(source: string, id: string, confirmedDigest: string): Promise<void> {
    const sourceRoot = await realpath(source);
    if (!/^[a-zA-Z0-9_-]{1,160}$/.test(id)) throw new Error('BMAD 成果識別無效。');
    const directory = this.directory(sourceRoot), capture = await this.readCapture(path.join(directory, id, 'manifest.json'), sourceRoot);
    if (capture.digest !== confirmedDigest || !capture.projectChanges.length) throw new Error('專案規則尚未取得此版本的人工確認。');
    const gate = await acquireStorageControl(path.join(directory, 'project-apply.control'), 'bmad-project-apply', { recoverable: true });
    const journal = path.join(directory, id + '.apply.json');
    const applied = new Set<string>();
    const remaining = () => capture.projectChanges.filter(change => !applied.has(change.path)).map(change => change.path);
    let currentPath: string | undefined;
    const record = (state: 'applying' | 'confirmed' | 'conflict' | 'failed', error?: string) => atomicNetworkJson(journal, {
      schema: 'GitLabWorkspaceBmadProjectApply/v1', digest: confirmedDigest, state, applied: [...applied], pending: remaining(),
      ...(error ? { path: currentPath, error } : {})
    });
    try {
      const pending: Array<{ change: BmadProjectChange; content: Buffer }> = [];
      for (const change of capture.projectChanges) {
        currentPath = change.path;
        if (!projectPath(change.path)) throw new Error('專案規則路徑無效。');
        if (!await projectRuleNeedsApply(sourceRoot, change)) { applied.add(change.path); continue; }
        const content = await readFile(path.join(capture.root, change.path));
        if (digest(content) !== change.afterHash) throw new Error('保存的專案規則已變更。');
        pending.push({ change, content });
      }
      currentPath = undefined;
      await record('applying');
      for (const { change, content } of pending) {
        currentPath = change.path;
        const file = path.join(sourceRoot, change.path);
        await safeProjectTarget(sourceRoot, file);
        await mkdir(path.dirname(file), { recursive: true }); await safeProjectTarget(sourceRoot, file);
        const temporary = file + '.' + randomUUID() + '.tmp';
        const handle = await open(temporary, 'wx');
        try {
          try { await handle.writeFile(content); } finally { await handle.close(); }
          if (await projectRuleNeedsApply(sourceRoot, change)) {
            if (change.beforeHash === null) {
              try { await link(temporary, file); }
              catch (error) {
                if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new ProjectRuleConflict();
                throw error;
              }
            } else await rename(temporary, file);
          }
          applied.add(change.path);
        } finally {
          await unlink(temporary).catch(error => { if (!missingFile(error)) throw error; });
        }
      }
      currentPath = undefined;
      await record('confirmed');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const detail = [currentPath ? '檔案：' + currentPath : '', '已套用：' + ([...applied].join('、') || '無'), '待套用：' + (remaining().join('、') || '無')];
      try { await record(error instanceof ProjectRuleConflict ? 'conflict' : 'failed', message); }
      catch (journalError) { detail.push('無法保存套用日誌：' + (journalError instanceof Error ? journalError.message : String(journalError))); }
      throw new BmadProjectApplyError(message, detail.filter(Boolean).join('\n'), error);
    } finally { await gate.release(); }
  }

  private async readCapture(file: string, sourceRoot: string): Promise<BmadArtifactCapture> {
    await ownedStoragePath(this.storage, file);
    const info = await lstat(file); if (!info.isFile() || info.size > 512 * 1024) throw new Error('BMAD 成果 manifest 無效。');
    const capture = JSON.parse(await readFile(file, 'utf8')) as BmadArtifactCapture;
    if (capture.schema !== 'GitLabWorkspaceBmadArtifacts/v1' || !sameArtifactPath(capture.sourceRoot, sourceRoot) || !sameArtifactPath(capture.root, path.dirname(file)) || !Array.isArray(capture.files) ||
        !Array.isArray(capture.projectChanges) || capture.files.length > MAX_FILES || !/^[a-f0-9]{64}$/.test(capture.digest) ||
        capture.id !== path.basename(capture.root) || digest(JSON.stringify([capture.sourceRoot, capture.taskId, capture.files, capture.projectChanges])) !== capture.digest) throw new Error('BMAD 成果與原專案綁定不符。');
    for (const artifact of capture.files) {
      const target = path.join(capture.root, artifact.path);
      if (!insideStorage(capture.root, target) || !/^[a-f0-9]{64}$/.test(artifact.sha256)) throw new Error('BMAD 成果路徑無效。');
      await ownedStoragePath(this.storage, target);
      const stat = await lstat(target);
      if (!stat.isFile() || stat.size !== artifact.bytes || stat.size > 2 * 1024 * 1024 || digest(await readFile(target)) !== artifact.sha256) throw new Error('BMAD 保存成果內容已變更。');
    }
    return capture;
  }
}

async function projectRuleNeedsApply(root: string, change: BmadProjectChange): Promise<boolean> {
  const before = await readProjectFile(root, change.path);
  const currentHash = before ? digest(before) : null;
  if (currentHash === change.afterHash) return false;
  if (currentHash !== change.beforeHash) throw new ProjectRuleConflict();
  return true;
}

function projectPath(relative: string): boolean {
  return relative === 'AGENTS.md' || /^_bmad\/custom\/(?:[a-zA-Z0-9_.-]+\/)*[a-zA-Z0-9_.-]+$/.test(relative) && !relative.split('/').includes('..');
}
async function safeProjectTarget(root: string, file: string): Promise<void> {
  if (!insideStorage(root, file)) throw new Error('專案規則路徑超出原專案。');
  let current = root;
  for (const component of path.relative(root, file).split(path.sep)) {
    current = path.join(current, component);
    try { const info = await lstat(current); if (info.isSymbolicLink() || !insideStorage(root, await realpath(current))) throw new Error('專案規則路徑不可重新導向。'); }
    catch (error) { if (!missingFile(error)) throw error; }
  }
}
async function readProjectFile(root: string, relative: string): Promise<Buffer | undefined> {
  const target = path.join(root, relative); await safeProjectTarget(root, target);
  try { const info = await lstat(target); if (!info.isFile() || info.size > 2 * 1024 * 1024) throw new Error('專案規則檔案無效。'); return await readFile(target); }
  catch (error) { if (missingFile(error)) return undefined; throw error; }
}
async function walk(root: string, visit: (relative: string, content: Buffer) => Promise<void> | void): Promise<void> {
  let physical: string;
  try { const info = await lstat(root); if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('BMAD 輸出不可重新導向。'); physical = await realpath(root); }
  catch (error) { if (missingFile(error)) return; throw error; }
  let files = 0, bytes = 0;
  const scan = async (directory: string, depth: number): Promise<void> => {
    if (depth > 12) throw new Error('BMAD 輸出目錄過深，原始成果已保留。');
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name), info = await lstat(file);
      if (info.isSymbolicLink() || !insideStorage(physical, await realpath(file))) throw new Error('BMAD 輸出包含重新導向，原始成果已保留。');
      if (info.isDirectory()) { if (!['.git', 'node_modules', '__pycache__'].includes(entry.name)) await scan(file, depth + 1); }
      else if (info.isFile()) {
        if (++files > MAX_FILES || info.size > 2 * 1024 * 1024 || (bytes += info.size) > MAX_BYTES) throw new Error('BMAD 輸出超過保存上限，原始成果已保留。');
        await visit(path.relative(root, file).split(path.sep).join('/'), await readFile(file));
      }
    }
  };
  await scan(physical, 0);
}
