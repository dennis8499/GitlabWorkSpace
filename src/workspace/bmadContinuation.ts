import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { BmadCommandRequest, BmadWorkflowSnapshot } from './bmadProtocol';
import type { BmadArtifactCapture } from './bmadArtifactStore';
import { atomicNetworkJson } from '../api/localNetworkLease';
import { acquireStorageControl } from '../storage/controlLease';
import { missingFile, ownedStoragePath } from '../storage/ownedStorage';

const hash = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex');
const same = (a: string, b: string): boolean => process.platform === 'win32' ? path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase() : path.resolve(a) === path.resolve(b);
const within = (root: string, target: string): boolean => { const relative = path.relative(root, target); return !path.isAbsolute(relative) && relative !== '..' && !relative.startsWith('..' + path.sep); };
const uuid = (value: string): boolean => /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(value);
const digest = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const MAX_FILES = 2000, MAX_BYTES = 32 * 1024 * 1024, MAX_FILE_BYTES = 2 * 1024 * 1024;

export interface BmadContinuationSeed { sourceRoot: string; targetRoot: string; }

/** Select only the record explicitly chosen by the user. This step performs no filesystem writes. */
export function prepareBmadContinuation(options: {
  snapshot: BmadWorkflowSnapshot; request: BmadCommandRequest; outputRoot: string; prompt: string;
}): { prompt: string; seed?: BmadContinuationSeed } {
  const { snapshot, request, outputRoot } = options;
  if (!path.isAbsolute(outputRoot)) throw new Error('BMAD 接續工作目錄必須是絕對路徑。');
  if (request.artifactId && request.storyId) throw new Error('請一次選擇一份工作紀錄。');
  const artifact = request.artifactId ? snapshot.steps.flatMap(step => step.artifacts).find(item => item.id === request.artifactId) : undefined;
  const story = request.storyId ? snapshot.stories.find(item => item.id === request.storyId) : undefined;
  if (request.artifactId && !artifact || request.storyId && !story) throw new Error('接續工作紀錄已不存在，請重新偵測。');
  if (story && (story.status === 'conflict' || ['ambiguous', 'unconfirmed'].includes(story.association ?? ''))) throw new Error('Story 對應尚未確認，請先核對原工作紀錄。');
  const selected = artifact?.path ?? story?.inventoryPath ?? story?.path;
  if (!selected) return { prompt: options.prompt + (request.operation === 'resume'
    ? '\n\n尚未綁定要接續的保存成果。請先讓使用者選擇工作紀錄；不要自行選擇其他任務、Repo 或提交基準。' : '') };
  if (!path.isAbsolute(selected)) throw new Error('接續工作紀錄路徑無效。');
  const captures = [...new Set(snapshot.persistedArtifactRoots ?? [])].filter(root => path.isAbsolute(root) && within(root, selected));
  if (captures.length > 1) throw new Error('工作紀錄對應到多份保存成果，請重新選擇。');
  if (!captures.length) {
    if (!snapshot.root || !within(snapshot.root, selected)) throw new Error('工作紀錄不屬於目前專案或已驗證成果。');
    return { prompt: options.prompt };
  }
  if (story && !within(captures[0], story.path)) throw new Error('Story 與工作清單不屬於同一份保存成果。');
  if (request.operation === 'status') return { prompt: options.prompt + '\n\n這次只查閱保存成果的進度；原件保持唯讀，不建立可寫副本或自動接續實作。' };
  const sourceRoot = path.join(captures[0], '_bmad-output');
  if (!within(sourceRoot, selected)) {
    if (request.entry === 'project' || ['bmad-project-context', 'bmad-customize'].includes(request.nativeSkill ?? request.skill ?? '')) {
      return { prompt: options.prompt + '\n\n所選專案規則是唯讀參考；原件保持不變，修改只產生在本次專案規則提案目錄，待人工確認後套用。' };
    }
    throw new Error('此紀錄不是可複製續作的 BMAD 工作文件。');
  }
  if (within(sourceRoot, outputRoot) || within(outputRoot, sourceRoot)) throw new Error('接續工作副本必須與保存成果分開。');
  let prompt = relocate(options.prompt, sourceRoot, outputRoot);
  prompt += `\n\nHost 會在模型開始前，將本次明確選定成果的工作文件複製至 ${JSON.stringify(outputRoot)}。只接續這份可寫副本，保存成果保持唯讀。` +
    '\n文件內記錄的原執行 Repo、基準 SHA 與工作分支仍是來源證據，不代表目前可直接寫入。實作前先核對其位置、Repo 身分與固定基準；原 Repo／基準不存在或有歧義時先提問並保留受阻狀態，不把舊 patch 套用至其他 Repo，也不自行選擇替代來源。';
  return { prompt, seed: { sourceRoot, targetRoot: outputRoot } };
}

function relocate(prompt: string, source: string, target: string): string {
  const pairs = [
    [JSON.stringify(source).slice(1, -1), JSON.stringify(target).slice(1, -1)],
    [source.split(path.sep).join('/'), target.split(path.sep).join('/')],
    [source, target]
  ].sort(([a], [b]) => b.length - a.length);
  const seen = new Set<string>();
  for (const [from, to] of pairs) if (!seen.has(from)) { seen.add(from); prompt = prompt.split(from).join(to); }
  return prompt;
}

/** Seeds one selected immutable capture. A Host-owned receipt makes retries preserve later edits. */
export async function seedBmadContinuation(options: { storage: string; sourceRoot: string; targetRoot: string; signal?: AbortSignal }): Promise<void> {
  const { storage, sourceRoot, targetRoot, signal } = options;
  const captureRoot = path.dirname(sourceRoot), groupKey = path.basename(path.dirname(captureRoot)), captureId = path.basename(captureRoot);
  if (!path.isAbsolute(sourceRoot) || path.basename(sourceRoot) !== '_bmad-output' || !digest(groupKey) || !/^[a-zA-Z0-9_-]{1,160}$/.test(captureId) ||
    !same(captureRoot, path.join(storage, 'bmad-artifacts', groupKey, captureId)) || !path.isAbsolute(targetRoot) || !uuid(path.basename(targetRoot)) ||
    !same(targetRoot, path.join(storage, 'codex-bmad-artifacts', path.basename(targetRoot)))) throw new Error('BMAD 接續來源或工作副本不在受管理儲存區。');
  signal?.throwIfAborted();
  await mkdir(path.dirname(targetRoot), { recursive: true }); await ownedStoragePath(storage, path.dirname(targetRoot));
  const receiptFile = targetRoot + '.continuation.json';
  const gate = await acquireStorageControl(targetRoot + '.continuation.control', 'bmad-continuation', { signal, recoverable: true });
  try {
    let receipt: { schema: string; sourceRoot: string; targetRoot: string; digest: string; state: string } | undefined;
    try {
      await ownedStoragePath(storage, receiptFile);
      const info = await lstat(receiptFile); if (!info.isFile() || info.size > 8192) throw new Error('BMAD 接續收據無效。');
      receipt = JSON.parse(await readFile(receiptFile, 'utf8'));
      if (!receipt || receipt.schema !== 'GitLabWorkspaceBmadContinuation/v1' || !same(receipt.sourceRoot, sourceRoot) || !same(receipt.targetRoot, targetRoot) ||
        !digest(receipt.digest) || !['prepared', 'complete'].includes(receipt.state)) throw new Error('BMAD 接續收據與本次工作不符。');
      if (receipt.state === 'complete') {
        await directory(storage, targetRoot); return;
      }
    } catch (error) { if (!missingFile(error)) throw error; }
    await directory(storage, captureRoot); await directory(storage, sourceRoot);
    const manifestFile = path.join(captureRoot, 'manifest.json'); await ownedStoragePath(storage, manifestFile);
    const manifestInfo = await lstat(manifestFile); if (!manifestInfo.isFile() || manifestInfo.size > 512 * 1024) throw new Error('BMAD 保存成果 manifest 無效。');
    const capture = JSON.parse(await readFile(manifestFile, 'utf8')) as BmadArtifactCapture;
    if (capture.schema !== 'GitLabWorkspaceBmadArtifacts/v1' || !same(capture.root, captureRoot) || capture.id !== captureId || !path.isAbsolute(capture.sourceRoot) ||
      hash(path.resolve(capture.sourceRoot)) !== groupKey || typeof capture.taskId !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(capture.taskId) ||
      !Array.isArray(capture.files) || capture.files.length > MAX_FILES || !Array.isArray(capture.projectChanges) || capture.projectChanges.length > MAX_FILES ||
      !digest(capture.digest) || hash(JSON.stringify([capture.sourceRoot, capture.taskId, capture.files, capture.projectChanges])) !== capture.digest ||
      receipt && receipt.digest !== capture.digest) throw new Error('BMAD 保存成果已改變或不屬於原專案。');
    const files = new Map<string, Buffer>(); let total = 0;
    for (const file of capture.files) {
      signal?.throwIfAborted();
      if (typeof file.path !== 'string' || !file.path || file.path.includes('\\') || file.path.includes('\0') || path.win32.isAbsolute(file.path) || path.posix.isAbsolute(file.path) || path.posix.normalize(file.path) !== file.path ||
        file.path.split('/').some(part => !part || part === '..' || part === '.') || !digest(file.sha256) || !Number.isSafeInteger(file.bytes) || file.bytes < 0 || file.bytes > MAX_FILE_BYTES) throw new Error('BMAD 保存成果 inventory 無效。');
      if (!file.path.startsWith('_bmad-output/')) continue;
      const relative = file.path.slice('_bmad-output/'.length);
      if (relative.split('/').some(part => ['.git', '.codex', '.agents', 'node_modules', '__pycache__'].includes(part))) throw new Error('BMAD 工作文件包含不可續作的執行或工具設定。');
      if (files.has(relative)) throw new Error('BMAD 保存成果包含重複檔案。');
      const source = path.join(sourceRoot, relative); await ownedStoragePath(storage, source);
      const info = await lstat(source);
      if (!info.isFile() || info.size !== file.bytes) throw new Error('BMAD 保存工作文件已變更。');
      const content = await readFile(source);
      total += content.length;
      if (content.length !== file.bytes || hash(content) !== file.sha256 || total > MAX_BYTES) throw new Error('BMAD 保存工作文件內容已變更或超出上限。');
      files.set(relative, content);
    }
    if (!files.size) throw new Error('所選保存成果沒有可接續的工作文件。');
    signal?.throwIfAborted();
    await mkdir(targetRoot, { recursive: true }); await directory(storage, targetRoot);
    const checkpoint = { schema: 'GitLabWorkspaceBmadContinuation/v1', sourceRoot, targetRoot, digest: capture.digest, state: 'prepared' };
    await atomicNetworkJson(receiptFile, checkpoint);
    for (const [relative, content] of files) {
      signal?.throwIfAborted();
      const target = path.join(targetRoot, relative);
      await safeParents(storage, targetRoot, path.dirname(target));
      try { await writeFile(target, content, { flag: 'wx', mode: 0o600 }); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        await ownedStoragePath(storage, target);
        const info = await lstat(target);
        if (!info.isFile() || info.size !== content.length || hash(await readFile(target)) !== hash(content)) throw new Error('工作副本已有不同內容，保留原檔案；請核對後再接續。', { cause: error });
      }
    }
    await atomicNetworkJson(receiptFile, { ...checkpoint, state: 'complete' });
  } finally { await gate.release(); }
}

async function directory(storage: string, target: string): Promise<void> {
  await ownedStoragePath(storage, target);
  const info = await lstat(target);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('BMAD 接續目錄不可重新導向。');
}
async function safeParents(storage: string, root: string, target: string): Promise<void> {
  if (!within(root, target)) throw new Error('BMAD 工作文件路徑超出工作副本。');
  let current = root;
  for (const part of path.relative(root, target).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    try { await lstat(current); } catch (error) { if (!missingFile(error)) throw error; await mkdir(current); }
    await directory(storage, current);
  }
}
