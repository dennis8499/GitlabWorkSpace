import { copyFile, lstat, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import type { WorkflowKitPackageSummary, ToolSource } from './workspaceProtocol';

export const TOOL_SOURCE_KEY = 'gitlabWorkspace.workflowKit.source';
export const MAX_PACKAGE_BYTES = 80 * 1024 * 1024;
const CATALOG_SCHEMA = 'gitlab-workspace-kit-packages/v1';
const BUNDLE_SCHEMA = 'gitlab-workspace-kit-bundle/v1';

export const WORKFLOW_KIT_RELEASES: Record<Exclude<ToolSource, 'bundled'>, string> = {
  gitea: 'https://tech-sharing.cathaysec.com.tw/01002903/GitlabWorkSpace/releases',
  github: 'https://github.com/dennis8499/GitlabWorkSpace/releases'
};

interface ImportedRecord {
  version: string;
  source: 'gitea' | 'github';
  assetName: string;
  sha256: string;
}

interface PackageManifest { schema: typeof CATALOG_SCHEMA; packages: ImportedRecord[]; }
interface BundledManifest {
  schema: typeof BUNDLE_SCHEMA;
  package: 'gitlab-workspace-kit';
  version: string;
  archive: string;
  format: 'tar.xz';
  archiveSha256: string;
  releaseZip: string;
  releaseZipSha256: string;
  workspaceContract: number;
  payloadFiles: number;
}

export interface WorkflowKitPackage extends WorkflowKitPackageSummary {
  archivePath: string;
  sha256: string;
}

export class PackageIntegrityError extends Error {
  constructor(message: string) { super(message); this.name = 'PackageIntegrityError'; }
}

export class WorkflowKitPackageManager {
  private readonly catalogPath: string;
  private readonly archivesDirectory: string;

  constructor(
    private readonly storagePath: string,
    private readonly bundledArchivePath: string,
    private readonly bundledManifestPath: string,
    private readonly expectedVersion: string
  ) {
    this.catalogPath = path.join(storagePath, 'workflow-kit-packages.json');
    this.archivesDirectory = path.join(storagePath, 'workflow-kit-packages');
  }

  async listPackages(): Promise<WorkflowKitPackage[]> {
    const packages: WorkflowKitPackage[] = [];
    for (const record of await this.readImportedRecords()) {
      packages.push(await this.withAvailability({
        id: packageId(record.version, record.source, record.sha256), version: record.version,
        source: record.source, assetName: record.assetName, format: 'zip', entryRoot: '', available: false,
        archivePath: this.importedArchivePath(record.sha256), sha256: record.sha256
      }));
    }
    const manifest = await this.readBundledManifest();
    if (manifest) {
      packages.push(await this.withAvailability({
        id: packageId(manifest.version, 'bundled', manifest.archiveSha256), version: manifest.version,
        source: 'bundled', assetName: manifest.archive, format: 'tar.xz', entryRoot: 'workflow-kit',
        available: false, archivePath: this.bundledArchivePath, sha256: manifest.archiveSha256
      }));
    }
    return packages.sort((a, b) => sourceRank(a.source) - sourceRank(b.source) || compareVersions(b.version, a.version));
  }

  async importPackage(input: {
    version: string; source: 'gitea' | 'github'; assetName: string; archivePath: string; verifiedSha256: string;
  }): Promise<WorkflowKitPackage> {
    if (input.source !== 'gitea' && input.source !== 'github') throw new Error('Release 來源無效。');
    if (input.version !== this.expectedVersion) throw new PackageIntegrityError(`套件版本必須與 GitLab Workspace ${this.expectedVersion} 相同。`);
    if (!/^[a-f0-9]{64}$/i.test(input.verifiedSha256)) throw new Error('套件 SHA-256 無效。');
    if (path.extname(input.archivePath).toLocaleLowerCase('en-US') !== '.zip') throw new Error('請選擇 GitLab Workspace 組合包 ZIP。');
    const claimedDigest = input.verifiedSha256.toLowerCase();
    const existingRecords = await this.readImportedRecords();
    const conflictingVersion = existingRecords.find((record) => record.version === input.version && record.source === input.source && record.sha256 !== claimedDigest);
    if (conflictingVersion) throw new PackageIntegrityError('相同來源已匯入不同摘要的同版本套件；請確認 Release ZIP 後再更新匯入。');
    const assetName = path.basename(input.assetName).replace(/[\x00-\x1f\x7f]/g, '').slice(0, 180);
    if (!assetName || assetName === '.' || assetName === '..') throw new Error('套件檔名無效。');
    const sourceStat = await lstat(input.archivePath);
    if (!sourceStat.isFile() || sourceStat.isSymbolicLink() || sourceStat.size === 0 || sourceStat.size > MAX_PACKAGE_BYTES) {
      throw new Error('套件不存在、不是一般檔案或超過 80 MB。');
    }
    await mkdir(this.archivesDirectory, { recursive: true });
    const archivePath = this.importedArchivePath(input.verifiedSha256.toLowerCase());
    const temporaryPath = path.join(this.archivesDirectory, `${randomUUID()}.tmp`);
    try {
      await copyFile(input.archivePath, temporaryPath);
      const actualSha256 = await sha256File(temporaryPath);
      if (actualSha256 !== input.verifiedSha256.toLowerCase()) throw new PackageIntegrityError('ZIP 內容在匯入期間變更，已取消保存。');
      const currentRecords = await this.readImportedRecords();
      const changedVersion = currentRecords.find((record) => record.version === input.version && record.source === input.source && record.sha256 !== actualSha256);
      if (changedVersion) throw new PackageIntegrityError('相同來源已匯入不同摘要的同版本套件；請確認 Release ZIP 後再更新匯入。');
      try {
        const existingStat = await lstat(archivePath);
        if (!existingStat.isFile() || existingStat.isSymbolicLink() || await sha256File(archivePath) !== actualSha256) {
          throw new PackageIntegrityError('套件快取已存在不同內容，已保留原檔。');
        }
      } catch (error) {
        if (!(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')) throw error;
        await rename(temporaryPath, archivePath);
      }
      const records = await this.readImportedRecords();
      if (!records.some((record) => record.version === input.version && record.source === input.source && record.sha256 === actualSha256)) {
        records.push({ version: input.version, source: input.source, assetName, sha256: actualSha256 });
        await this.writeImportedRecords(records);
      }
    } finally {
      await rm(temporaryPath, { force: true });
    }
    const selected = (await this.listPackages()).find((item) => item.id === packageId(input.version, input.source, input.verifiedSha256.toLowerCase()));
    if (!selected) throw new Error('套件匯入後無法在本機套件清單中找到。');
    return selected;
  }

  async getPackage(id: string): Promise<WorkflowKitPackage> {
    if (typeof id !== 'string' || id.length > 256) throw new Error('套件選擇無效。');
    const selected = (await this.listPackages()).find((item) => item.id === id);
    if (!selected) throw new Error('找不到所選套件，請重新整理清單。');
    if (!selected.available) throw new Error(selected.error ?? '套件檔案目前無法讀取。');
    await assertRegularArchive(selected.archivePath);
    if (await sha256File(selected.archivePath) !== selected.sha256) throw new PackageIntegrityError('套件 SHA-256 與保存時的摘要不符，已停止安裝。');
    return selected;
  }

  private async readImportedRecords(): Promise<ImportedRecord[]> {
    let text: string;
    try { text = await readFile(this.catalogPath, 'utf8'); }
    catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return [];
      throw error;
    }
    if (text.length > 12 * 1024 * 1024) throw new Error('本機套件清單超過 12 MB 限制。');
    let value: PackageManifest;
    try { value = JSON.parse(text) as PackageManifest; } catch { throw new Error('本機套件清單格式無效。'); }
    if (value.schema !== CATALOG_SCHEMA || !Array.isArray(value.packages)) throw new Error('本機套件清單版本不支援。');
    return value.packages.map((record) => {
      if (!record || !isVersion(record.version) || record.version !== this.expectedVersion ||
        (record.source !== 'github' && record.source !== 'gitea') || !/^[a-f0-9]{64}$/i.test(record.sha256) ||
        typeof record.assetName !== 'string' || !record.assetName || record.assetName.length > 180 || path.basename(record.assetName) !== record.assetName) {
        throw new Error('本機套件清單包含無效項目。');
      }
      return { ...record, sha256: record.sha256.toLowerCase() };
    });
  }

  private async writeImportedRecords(records: ImportedRecord[]): Promise<void> {
    const temporaryPath = `${this.catalogPath}.${randomUUID()}.tmp`;
    await writeFile(temporaryPath, `${JSON.stringify({ schema: CATALOG_SCHEMA, packages: records }, null, 2)}\n`, { flag: 'wx' });
    try { await rename(temporaryPath, this.catalogPath); }
    finally { await rm(temporaryPath, { force: true }); }
  }

  private async readBundledManifest(): Promise<BundledManifest | undefined> {
    let text: string;
    try { text = await readFile(this.bundledManifestPath, 'utf8'); }
    catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return undefined;
      throw error;
    }
    let manifest: BundledManifest;
    try { manifest = JSON.parse(text) as BundledManifest; } catch { throw new Error('內附離線套件索引格式無效。'); }
    if (manifest.schema !== BUNDLE_SCHEMA || manifest.package !== 'gitlab-workspace-kit' || manifest.version !== this.expectedVersion ||
      manifest.archive !== 'workflow-kit.tar.xz' || manifest.format !== 'tar.xz' || manifest.releaseZip !== `gitlab-workspace-kit-${this.expectedVersion}.zip` ||
      !/^[a-f0-9]{64}$/i.test(manifest.archiveSha256) || !/^[a-f0-9]{64}$/i.test(manifest.releaseZipSha256) ||
      manifest.workspaceContract !== 1 || !Number.isSafeInteger(manifest.payloadFiles)) throw new Error('內附組合包索引無效或版本不符。');
    manifest.archiveSha256 = manifest.archiveSha256.toLowerCase();
    return manifest;
  }

  private async withAvailability(item: WorkflowKitPackage): Promise<WorkflowKitPackage> {
    try { await assertRegularArchive(item.archivePath); return { ...item, available: true }; }
    catch (error) { return { ...item, available: false, error: error instanceof Error ? error.message : '套件檔案無法讀取。' }; }
  }

  private importedArchivePath(digest: string): string { return path.join(this.archivesDirectory, `${digest}.zip`); }
}

export function packageId(version: string, source: ToolSource, digest: string): string {
  return `gitlab-workspace-kit:${version}:${source}:${digest}`;
}

export function compareVersions(first: string, second: string): number {
  const a = first.split('.').map(Number); const b = second.split('.').map(Number);
  for (let index = 0; index < 3; index++) if ((a[index] ?? 0) !== (b[index] ?? 0)) return (a[index] ?? 0) - (b[index] ?? 0);
  return 0;
}

export function isVersion(value: unknown): value is string { return typeof value === 'string' && /^\d+\.\d+\.\d+$/.test(value); }
function sourceRank(source: ToolSource): number { return source === 'bundled' ? 0 : source === 'gitea' ? 1 : 2; }
async function assertRegularArchive(filePath: string): Promise<void> {
  const info = await lstat(filePath);
  if (!info.isFile() || info.isSymbolicLink() || info.size === 0 || info.size > MAX_PACKAGE_BYTES) throw new Error('套件不存在、不是一般檔案或超過 80 MB。');
}
async function sha256File(filePath: string): Promise<string> {
  const digest = createHash('sha256');
  for await (const chunk of createReadStream(filePath)) digest.update(chunk as Uint8Array);
  return digest.digest('hex');
}
