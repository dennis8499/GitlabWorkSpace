import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, realpath } from 'node:fs/promises';
import type { CodexTaskSource, CodexTaskSpec } from './protocol';
import { atomicNetworkJson } from '../api/localNetworkLease';
import { acquireStorageControl } from '../storage/controlLease';
import { ownedStoragePath } from '../storage/ownedStorage';
import { validCodexGroupAnalysis } from './recordValidation';
import type { CodexTaskWorkspaceBinding, CodexTaskWorkspaceManifest } from './taskWorkspaceProtocol';
export type { CodexTaskWorkspaceBinding, CodexTaskWorkspaceManifest } from './taskWorkspaceProtocol';

export const TASK_WORKSPACE_MARKER = '.gitlab-workspace-task.json';
const same = (a: string, b: string): boolean => process.platform === 'win32'
  ? path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase() : path.resolve(a) === path.resolve(b);
const validId = (id: unknown): id is string => typeof id === 'string' && /^[a-z0-9-]{1,100}$/i.test(id);
const ownerAlive = (pid: number): boolean => { try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code !== 'ESRCH'; } };

export function validateTaskWorkspaceBinding(storage: string, value: CodexTaskWorkspaceBinding): void {
  if (!value || value.schema !== 'GitLabWorkspaceTaskWorkspace/v1' || !validId(value.taskId) ||
    !path.isAbsolute(value.originRoot) || !same(value.directory, path.join(storage, 'codex-workspaces', value.taskId)) ||
    !same(value.workspaceFile, path.join(value.directory, 'task.code-workspace')) ||
    value.accountId !== undefined && (typeof value.accountId !== 'string' || !value.accountId || value.accountId.length > 256)) {
    throw new Error('Codex 任務工作區綁定無效。');
  }
}
function validateSource(value: unknown): asserts value is CodexTaskSource {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !('kind' in value) ||
    !['free', 'skill', 'bmad', 'group-analysis', 'issue', 'project-wiki', 'merge-request', 'review'].includes(String(value.kind))) throw new Error('Codex 任務來源無效。');
  const inspect = (item: unknown): void => {
    if (!item || typeof item !== 'object') return;
    for (const [key, entry] of Object.entries(item)) {
      if (/^(?:token|accessToken|privateToken|authorization|password|secret)$/i.test(key)) throw new Error('任務啟動檔不得保存認證資料。');
      inspect(entry);
    }
  };
  inspect(value);
}

/** Caller holds the launch gate and has excluded claimed, retired and recorded tasks. */
async function preparePendingGroupOutput(storage: string, originRoot: string, spec?: CodexTaskSpec): Promise<void> {
  const group = spec?.groupAnalysis;
  if (spec?.source.kind !== 'group-analysis' || group?.issueDrafts !== true) return;
  const runtime = path.join(storage, 'codex-group-analysis', group.id), output = path.join(runtime, 'artifacts');
  if (!validCodexGroupAnalysis(group, originRoot) || !same(group.runtimeRoot, runtime) || !same(group.outputRoot, output) ||
      !spec.executionRoot || !same(spec.executionRoot, output) || !spec.writableRoots.some(root => same(root, output))) {
    throw new Error('Group 成果目錄不符合此任務的受管理綁定。');
  }
  await ownedStoragePath(storage, output);
  await mkdir(output, { recursive: true, mode: 0o700 });
  if (!await ownedStoragePath(storage, output)) throw new Error('Group 成果目錄無法驗證。');
}

/** Creates launch metadata and an empty managed Group output folder; no model, Git sync or publication starts here. */
export async function createTaskWorkspace(storage: string, request: { source: CodexTaskSource; originRoot: string; accountId?: string; preparedSpec?: CodexTaskSpec; windowMode?: 'origin' | 'task' }, taskId: string = randomUUID()): Promise<CodexTaskWorkspaceManifest> {
  if (!validId(taskId)) throw new Error('Codex 任務識別無效。');
  validateSource(request.source);
  if (request.windowMode !== undefined && !['origin', 'task'].includes(request.windowMode)) throw new Error('Codex 任務視窗模式無效。');
  const originRoot = await realpath(request.originRoot);
  const directory = path.join(storage, 'codex-workspaces', taskId);
  const binding: CodexTaskWorkspaceBinding = { schema: 'GitLabWorkspaceTaskWorkspace/v1', taskId, directory,
    workspaceFile: path.join(directory, 'task.code-workspace'), originRoot, ...(request.accountId ? { accountId: request.accountId } : {}) };
  validateTaskWorkspaceBinding(storage, binding);
  if (request.preparedSpec && (!same(request.preparedSpec.root, originRoot) || JSON.stringify(request.preparedSpec.source) !== JSON.stringify(request.source))) throw new Error('已準備任務與啟動來源不符。');
  const preparedDigest = request.preparedSpec ? createHash('sha256').update(JSON.stringify(request.preparedSpec)).digest('hex') : undefined;
  await mkdir(path.dirname(directory), { recursive: true, mode: 0o700 });
  await ownedStoragePath(storage, path.dirname(directory));
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await ownedStoragePath(storage, directory);
  await mkdir(path.join(directory, 'workspace'), { recursive: true, mode: 0o700 });
  await ownedStoragePath(storage, path.join(directory, 'workspace'));
  const lease = await acquireStorageControl(directory + '.launch', 'codex-task-launch');
  try {
    const marker = path.join(directory, 'workspace', TASK_WORKSPACE_MARKER);
    let previous: CodexTaskWorkspaceManifest | undefined;
    try {
      previous = await readTaskWorkspace(storage, binding.workspaceFile);
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    if (previous) {
      if (!same(previous.binding.originRoot, originRoot) || previous.binding.accountId !== binding.accountId) throw new Error('任務啟動識別已用於其他工作。');
      if ((previous.windowMode ?? 'task') !== (request.windowMode ?? 'task')) throw new Error('既有任務的執行視窗不可變更。');
      if (JSON.stringify(previous.source) === JSON.stringify(request.source) && previous.preparedDigest === preparedDigest) {
        if (!previous.owner && !previous.retired && !await taskRecordExists(storage, taskId)) await preparePendingGroupOutput(storage, originRoot, request.preparedSpec);
        return previous;
      }
      if (previous.owner || previous.retired || await taskRecordExists(storage, taskId)) throw new Error('任務已接管、建立或封存，不能變更啟動來源；請建立新任務。');
      if (previous.preparedSpec && !request.preparedSpec) throw new Error('請重新準備此工作，不能移除已固定的任務內容。');
    } else if (await taskRecordExists(storage, taskId)) throw new Error('任務識別已有紀錄，不能建立另一份啟動來源。');
    const manifest: CodexTaskWorkspaceManifest = { schema: 'GitLabWorkspaceTaskLaunch/v1', binding, source: structuredClone(request.source), createdAt: previous?.createdAt ?? new Date().toISOString(),
      ...(request.windowMode ? { windowMode: request.windowMode } : {}),
      ...(request.preparedSpec ? { preparedSpec: structuredClone(request.preparedSpec), preparedDigest } : {}) };
    if (Buffer.byteLength(JSON.stringify(manifest)) > 1024 * 1024) throw new Error('任務啟動內容超過 1 MiB，請縮小輸入後重新準備。');
    await preparePendingGroupOutput(storage, originRoot, request.preparedSpec);
    await atomicNetworkJson(path.join(directory, 'launch.json'), manifest);
    await atomicNetworkJson(marker, { schema: 'GitLabWorkspaceTaskMarker/v1', taskId, workspaceFile: binding.workspaceFile });
    const folders = [{ path: 'workspace', name: '任務控制' }];
    if (request.preparedSpec) {
      const executionRoot = request.preparedSpec.executionRoot ?? request.preparedSpec.root;
      folders.push({ path: executionRoot, name: '工作目錄' });
      if (request.preparedSpec.bmadArtifacts && !same(request.preparedSpec.bmadArtifacts.outputRoot, executionRoot)) {
        folders.push({ path: request.preparedSpec.bmadArtifacts.outputRoot, name: '成果' });
      }
    }
    await atomicNetworkJson(binding.workspaceFile, { folders, settings: { 'gitlabWorkspace.projectRoot': originRoot } });
    return manifest;
  } finally { await lease.release(); }
}

export async function readTaskWorkspace(storage: string, workspaceFile: string): Promise<CodexTaskWorkspaceManifest> {
  const directory = path.dirname(workspaceFile), taskId = path.basename(directory);
  if (!validId(taskId) || !same(directory, path.join(storage, 'codex-workspaces', taskId)) || !same(workspaceFile, path.join(directory, 'task.code-workspace'))) throw new Error('只接受受管理的 Codex 任務工作區。');
  await ownedStoragePath(storage, directory);
  for (const filename of [workspaceFile, path.join(directory, 'launch.json'), path.join(directory, 'workspace', TASK_WORKSPACE_MARKER)]) {
    const info = await lstat(filename);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 1024 * 1024) throw new Error('Codex 任務啟動檔格式無效。');
    await ownedStoragePath(storage, filename);
  }
  const manifest = JSON.parse(await readFile(path.join(directory, 'launch.json'), 'utf8')) as CodexTaskWorkspaceManifest;
  validateTaskWorkspaceBinding(storage, manifest.binding);
  if (manifest.windowMode !== undefined && !['origin', 'task'].includes(manifest.windowMode)) throw new Error('Codex 任務視窗模式無效。');
  validateSource(manifest.source);
  if (manifest.schema !== 'GitLabWorkspaceTaskLaunch/v1' || !same(manifest.binding.workspaceFile, workspaceFile) || !Number.isFinite(Date.parse(manifest.createdAt))) throw new Error('Codex 任務啟動資料無效。');
  if (manifest.preparedSpec && (!same(manifest.preparedSpec.root, manifest.binding.originRoot) || JSON.stringify(manifest.preparedSpec.source) !== JSON.stringify(manifest.source) ||
    manifest.preparedDigest !== createHash('sha256').update(JSON.stringify(manifest.preparedSpec)).digest('hex'))) throw new Error('已準備任務內容已變更，請回原視窗重新準備。');
  const marker = JSON.parse(await readFile(path.join(directory, 'workspace', TASK_WORKSPACE_MARKER), 'utf8'));
  if (marker.schema !== 'GitLabWorkspaceTaskMarker/v1' || marker.taskId !== taskId || !same(marker.workspaceFile, workspaceFile)) throw new Error('Codex 任務工作區識別不符。');
  if (manifest.owner && (typeof manifest.owner.instance !== 'string' || !manifest.owner.instance || !Number.isSafeInteger(manifest.owner.pid) || manifest.owner.pid < 1 || !Number.isSafeInteger(manifest.owner.generation) || manifest.owner.generation < 1 ||
    manifest.owner.released !== undefined && typeof manifest.owner.released !== 'boolean')) throw new Error('Codex 任務視窗擁有者無效。');
  if (manifest.retired && (manifest.retired.resultId !== taskId || !Number.isFinite(Date.parse(manifest.retired.retiredAt)))) throw new Error('Codex 保留成果指標無效。');
  return manifest;
}

/** The stopped-process check is mandatory before a different, dead owner can be replaced. */
export async function claimTaskWorkspace(storage: string, binding: CodexTaskWorkspaceBinding, instance: string, verifyStopped: () => Promise<void>): Promise<CodexTaskWorkspaceManifest> {
  validateTaskWorkspaceBinding(storage, binding);
  const lease = await acquireStorageControl(binding.directory + '.launch', 'codex-task-launch');
  try {
    const manifest = await readTaskWorkspace(storage, binding.workspaceFile);
    if (manifest.retired) throw new Error('此任務已封存，請閱讀保留成果或以成果建立新任務。');
    if (manifest.owner?.instance === instance) return manifest;
    if (manifest.owner && !manifest.owner.released && ownerAlive(manifest.owner.pid)) throw new Error('此任務已由另一個 VS Code 視窗管理，請回該視窗操作。');
    await verifyStopped();
    manifest.owner = { instance, pid: process.pid, generation: (manifest.owner?.generation ?? 0) + 1 };
    await atomicNetworkJson(path.join(binding.directory, 'launch.json'), manifest);
    return manifest;
  } finally { await lease.release(); }
}

export async function releaseTaskWorkspace(storage: string, binding: CodexTaskWorkspaceBinding, instance: string, generation: number): Promise<void> {
  const lease = await acquireStorageControl(binding.directory + '.launch', 'codex-task-launch');
  try {
    const manifest = await readTaskWorkspace(storage, binding.workspaceFile);
    if (manifest.owner?.instance !== instance || manifest.owner.generation !== generation) throw new Error('任務視窗擁有者已改變。');
    manifest.owner.released = true;
    await atomicNetworkJson(path.join(binding.directory, 'launch.json'), manifest);
  } finally { await lease.release(); }
}

/** Keep the activation marker useful while removing the retired conversation's full launch input. */
export async function retireTaskWorkspace(storage: string, binding: CodexTaskWorkspaceBinding, instance: string, generation: number): Promise<void> {
  const lease = await acquireStorageControl(binding.directory + '.launch', 'codex-task-launch');
  try {
    const manifest = await readTaskWorkspace(storage, binding.workspaceFile);
    if (manifest.owner?.instance !== instance || manifest.owner.generation !== generation) throw new Error('任務視窗擁有者已改變。');
    delete manifest.preparedSpec; delete manifest.preparedDigest;
    manifest.source = { kind: 'free', repository: binding.originRoot, prompt: '成果已封存；請以保留成果建立新任務。' };
    manifest.retired = { resultId: binding.taskId, retiredAt: new Date().toISOString() };
    await atomicNetworkJson(path.join(binding.directory, 'launch.json'), manifest);
  } finally { await lease.release(); }
}

async function taskRecordExists(storage: string, taskId: string): Promise<boolean> {
  for (const suffix of ['.json', '.cleanup.json', '.deleted.json']) {
    try { await lstat(path.join(storage, 'codex-tasks', taskId + suffix)); return true; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  return false;
}
