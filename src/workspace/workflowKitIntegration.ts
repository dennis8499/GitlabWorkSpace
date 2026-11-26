import { createHash } from 'node:crypto';
import { lstat, readFile, readdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import { missingFile, ownedStoragePath } from '../storage/ownedStorage';
import type { RemoteToolSource } from './workspaceProtocol';

const manifestPath = (root: string) => path.join(root, '.gitlab-workspace', 'tool-manifests', 'workflow-kit.json');
const managedStart = '<!-- gitlab-workspace-kit:managed:start -->';
const managedEnd = '<!-- gitlab-workspace-kit:managed:end -->';
const digest = (bytes: Buffer | string): string => createHash('sha256').update(bytes).digest('hex');

export interface WorkflowKitManifest {
  root: string;
  sha256: string;
  version: string;
  files: Readonly<Record<string, unknown>>;
  capabilities?: unknown;
  agentBlockSha256?: unknown;
}

export interface WorkflowKitStatusProof {
  root: string;
  sha256: string;
  transactions: string;
}

export type VerifiedWorkflowKitManifest = WorkflowKitManifest & WorkflowKitStatusProof;

export async function readWorkflowKitManifest(root: string): Promise<WorkflowKitManifest> {
  const file = manifestPath(root);
  if (!await ownedStoragePath(root, file)) throw new Error('找不到 WorkflowKit 安裝紀錄，請重新檢查安裝。');
  const bytes = await readManifestBytes(file);
  if (!bytes) throw new Error('找不到 WorkflowKit 安裝紀錄，請重新檢查安裝。');
  const value = JSON.parse(bytes.toString('utf8')) as { version?: unknown; files?: unknown; capabilities?: unknown; agentBlockSha256?: unknown } | null;
  if (!value || typeof value.version !== 'string' || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value.version) ||
      !value.files || typeof value.files !== 'object' || Array.isArray(value.files)) {
    throw new Error('WorkflowKit 安裝紀錄格式無效。');
  }
  return { root: await realpath(root), sha256: digest(bytes), version: value.version,
    files: value.files as Record<string, unknown>, capabilities: value.capabilities, agentBlockSha256: value.agentBlockSha256 };
}

/** A complete status read may allow a committed stage. Its exact journal must still match at handoff. */
export async function workflowKitTransactions(root: string): Promise<string> {
  const parent = path.join(root, '.gitlab-workspace', 'tool-installs');
  if (!await ownedStoragePath(root, parent)) return '';
  const names = (await readdir(parent)).filter(name => name.startsWith('kit-')).sort();
  if (!names.length) return '';
  return JSON.stringify(await Promise.all(names.map(async name => {
    const stage = path.join(parent, name);
    if (!await ownedStoragePath(root, stage) || !(await lstat(stage)).isDirectory()) throw new Error('WorkflowKit 安裝交易位置無效。');
    const files = await Promise.all(['owner.json', 'transaction.json'].map(async name => {
      const file = path.join(stage, name);
      if (!await ownedStoragePath(root, file)) return null;
      const bytes = await readManifestBytes(file);
      return bytes ? digest(bytes) : null;
    }));
    return [name, ...files];
  })));
}

export async function assertWorkflowKitManifestCurrent(verified: WorkflowKitStatusProof): Promise<WorkflowKitManifest> {
  const current = await readWorkflowKitManifest(verified.root);
  if (path.relative(current.root, verified.root) || current.sha256 !== verified.sha256 ||
      await workflowKitTransactions(current.root) !== verified.transactions) {
    throw new Error('WorkflowKit 安裝紀錄或交易狀態在準備指令時已變更。');
  }
  return current;
}

export async function assertWorkflowKitManagedInstructions(marker: WorkflowKitManifest): Promise<void> {
  const file = path.join(marker.root, 'AGENTS.md');
  if (!await ownedStoragePath(marker.root, file)) throw new Error('WorkflowKit 的 AGENTS.md 管理區塊遺失。');
  const text = (await readManifestBytes(file))?.toString('utf8') ?? '';
  const start = text.indexOf(managedStart), end = text.indexOf(managedEnd);
  if (start < 0 || end < start + managedStart.length || text.lastIndexOf(managedStart) !== start || text.lastIndexOf(managedEnd) !== end ||
    digest(text.slice(start + managedStart.length, end).replace(/^\r?\n/, '').replace(/\r?\n$/, '')) !== marker.agentBlockSha256) {
    throw new Error('WorkflowKit 的 AGENTS.md 管理區塊已變更。');
  }
}

export async function assertWorkflowKitManagedSkill(marker: WorkflowKitManifest, skill: string): Promise<void> {
  const relative = `.agents/skills/${skill}/SKILL.md`;
  const file = path.join(marker.root, relative);
  const bytes = await ownedStoragePath(marker.root, file) ? await readManifestBytes(file) : undefined;
  if (!bytes || digest(bytes) !== marker.files[relative]) throw new Error('Skill 來源已變更，請重新檢查 WorkflowKit 安裝。');
}

async function readManifestBytes(marker: string): Promise<Buffer | undefined> {
  try {
    const info = await lstat(marker);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 16 * 1024 * 1024) throw new Error('WorkflowKit 安裝紀錄不是安全的檔案。');
    const bytes = await readFile(marker);
    if (bytes.length > 16 * 1024 * 1024) throw new Error('WorkflowKit 安裝紀錄超過大小限制。');
    return bytes;
  } catch (error) {
    if (missingFile(error)) return undefined;
    throw error;
  }
}

/** The marker only selects an already authenticated cache entry; it never supplies executable code. */
export async function installedKitIdentity(root: string): Promise<{ source: RemoteToolSource; version: string; sha256: string } | undefined> {
  const bytes = await readManifestBytes(manifestPath(root));
  if (!bytes) return undefined;
  const value: unknown = JSON.parse(bytes.toString('utf8'));
  if (!value || typeof value !== 'object') throw new Error('WorkflowKit 安裝紀錄格式無效。');
  const { source, version } = value as { source?: unknown; version?: unknown };
  if (source !== 'github' && source !== 'gitea') return undefined;
  if (typeof version !== 'string' || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version)) throw new Error('WorkflowKit 安裝版本無效。');
  return { source, version, sha256: digest(bytes) };
}
