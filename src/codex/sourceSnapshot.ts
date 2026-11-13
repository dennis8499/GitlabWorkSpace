import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { atomicNetworkJson } from '../api/localNetworkLease';
import { ownedStoragePath } from '../storage/ownedStorage';
import { workflowGit } from './projectWorkflows';

export interface CodexSourceSnapshotRepository { root: string; sha: string; projectId?: number; projectPath?: string; }
export interface CodexSourceSnapshot {
  schema: 'GitLabWorkspaceSourceSnapshot/v1'; id: string; createdAt: string;
  repositories: CodexSourceSnapshotRepository[]; metadataVersion?: string;
}
export interface CodexSourceSnapshotInput {
  repositories: Array<{ root: string; sha?: string; projectId?: number; projectPath?: string }>;
  metadataVersion?: string;
}
/** Captures local immutable commit identities. Neither capture nor read contacts a server. */
export class CodexSourceSnapshotService {
  private readonly snapshots = new Map<string, CodexSourceSnapshot>();
  constructor(private readonly directory?: string) {}
  async capture(input: CodexSourceSnapshotInput, signal?: AbortSignal): Promise<CodexSourceSnapshot> {
    if (!input.repositories.length || input.repositories.length > 100) throw new Error('來源快照需包含 1 到 100 個 Repo。');
    if (input.metadataVersion !== undefined && (typeof input.metadataVersion !== 'string' || input.metadataVersion.length > 4096)) throw new Error('來源中繼資料版本無效。');
    const repositories: CodexSourceSnapshotRepository[] = [];
    for (const item of input.repositories) {
      signal?.throwIfAborted();
      const root = await realpath(item.root);
      if (item.projectId !== undefined && (!Number.isSafeInteger(item.projectId) || item.projectId < 1) || item.projectPath !== undefined &&
        (typeof item.projectPath !== 'string' || !item.projectPath.trim() || item.projectPath.length > 500)) throw new Error('來源專案身分無效。');
      if (repositories.some(row => pathKey(row.root) === pathKey(root))) throw new Error('來源 Repo 不可重複。');
      const ref = item.sha ?? 'HEAD';
      if (item.sha && !/^[a-f0-9]{40,64}$/i.test(item.sha)) throw new Error('來源 SHA 無效。');
      const sha = (await workflowGit(root, ['rev-parse', '--verify', `${ref}^{commit}`])).trim();
      if (!/^[a-f0-9]{40,64}$/i.test(sha)) throw new Error('無法核對本機來源版本。');
      repositories.push({ root, sha, projectId: item.projectId, projectPath: item.projectPath });
    }
    repositories.sort((a, b) => pathKey(a.root).localeCompare(pathKey(b.root)));
    const id = createHash('sha256').update(JSON.stringify([repositories, input.metadataVersion ?? ''])).digest('hex');
    const previous = await this.read(id);
    if (previous) return previous;
    const snapshot: CodexSourceSnapshot = { schema: 'GitLabWorkspaceSourceSnapshot/v1', id,
      createdAt: new Date().toISOString(), repositories, metadataVersion: input.metadataVersion };
    signal?.throwIfAborted();
    if (this.directory) {
      await mkdir(this.directory, { recursive: true }); await ownedStoragePath(path.dirname(this.directory), this.directory);
      await atomicNetworkJson(path.join(this.directory, id + '.json'), snapshot);
    }
    this.remember(snapshot); return structuredClone(snapshot);
  }
  async read(id: string): Promise<CodexSourceSnapshot | undefined> {
    if (!/^[a-f0-9]{64}$/.test(id)) throw new Error('來源快照識別無效。');
    const cached = this.snapshots.get(id); if (cached) return structuredClone(cached);
    if (!this.directory) return undefined;
    const file = path.join(this.directory, id + '.json');
    if (!await ownedStoragePath(path.dirname(this.directory), file)) return undefined;
    let info;
    try { info = await lstat(file); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
    if (!info.isFile() || info.isSymbolicLink() || info.size > 256 * 1024) throw new Error('來源快照格式無效。');
    const value = JSON.parse(await readFile(file, 'utf8')) as CodexSourceSnapshot;
    if (value.schema !== 'GitLabWorkspaceSourceSnapshot/v1' || value.id !== id || typeof value.createdAt !== 'string' || !Number.isFinite(Date.parse(value.createdAt)) ||
      value.metadataVersion !== undefined && (typeof value.metadataVersion !== 'string' || value.metadataVersion.length > 4096) || !Array.isArray(value.repositories) || !value.repositories.length ||
      value.repositories.length > 100 || value.repositories.some(row => !row || !path.isAbsolute(row.root) || !/^[a-f0-9]{40,64}$/i.test(row.sha)) ||
      createHash('sha256').update(JSON.stringify([value.repositories, value.metadataVersion ?? ''])).digest('hex') !== id) throw new Error('來源快照身分無法驗證。');
    this.remember(value); return structuredClone(value);
  }
  clear(): void { this.snapshots.clear(); }
  private remember(value: CodexSourceSnapshot): void {
    this.snapshots.delete(value.id); this.snapshots.set(value.id, structuredClone(value));
    while (this.snapshots.size > 32) this.snapshots.delete(this.snapshots.keys().next().value!);
  }
}
const pathKey = (value: string): string => process.platform === 'win32' ? value.toLowerCase() : value;
