import { lstat, readFile } from 'node:fs/promises';
import path from 'node:path';
import type { RemoteToolSource } from './workspaceProtocol';

/** The marker only selects an already authenticated cache entry; it never supplies executable code. */
export async function installedKitIdentity(root: string): Promise<{ source: RemoteToolSource; version: string } | undefined> {
  const marker = path.join(root, '.gitlab-workspace', 'tool-manifests', 'workflow-kit.json');
  try {
    const info = await lstat(marker);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 16 * 1024 * 1024) throw new Error('WorkflowKit 安裝紀錄不是安全的檔案。');
    const value: unknown = JSON.parse(await readFile(marker, 'utf8'));
    if (!value || typeof value !== 'object') throw new Error('WorkflowKit 安裝紀錄格式無效。');
    const { source, version } = value as { source?: unknown; version?: unknown };
    if (source !== 'github' && source !== 'gitea') return undefined;
    if (typeof version !== 'string' || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version)) throw new Error('WorkflowKit 安裝版本無效。');
    return { source, version };
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return undefined;
    throw error;
  }
}
