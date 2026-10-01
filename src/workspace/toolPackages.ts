import { copyFile, lstat, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { InstalledToolState, RemoteToolSource, ToolId, ToolPackageSummary, ToolSource } from './workspaceProtocol';

export const TOOL_SOURCE_KEY = 'gitlabWorkspace.release.source';
export const MAX_PACKAGE_BYTES = 80 * 1024 * 1024;
const CATALOG_SCHEMA = 'gitlab-workspace-tool-packages/v1';
const BUNDLE_SCHEMA = 'gitlab-workspace-offline-tools/v1';

export const TOOL_DEFINITIONS: Record<ToolId, { repository: string; githubReleaseUrl: string; giteaReleaseUrl: string }> = {
  'codebase-wiki': {
    repository: 'code-base-llm-wiki',
    githubReleaseUrl: 'https://github.com/dennis8499/code-base-llm-wiki/releases',
    giteaReleaseUrl: 'https://tech-sharing.cathaysec.com.tw/01002903/code-base-llm-wiki/releases'
  },
  megin: {
    repository: 'Megin',
    githubReleaseUrl: 'https://github.com/dennis8499/Megin/releases',
    giteaReleaseUrl: 'https://tech-sharing.cathaysec.com.tw/01002903/Megin/releases'
  },
  'merge-reviewer': {
    repository: 'MergeReviewer',
    githubReleaseUrl: 'https://github.com/dennis8499/MergeReviewer/releases',
    giteaReleaseUrl: 'https://tech-sharing.cathaysec.com.tw/01002903/MergeReviewer/releases'
  }
};

interface ImportedRecord {
  tool: ToolId;
  version: string;
  source: RemoteToolSource;
  assetName: string;
  entryRoot: '';
  sha256: string;
}

interface PackageManifest {
  schema: typeof CATALOG_SCHEMA;
  packages: ImportedRecord[];
}

interface BundledToolRecord {
  version: string;
  entryRoot: string;
  assetName: string;
  releaseUrl: string;
  upstreamZipSha256: string;
}

interface BundledManifest {
  schema: typeof BUNDLE_SCHEMA;
  archive: string;
  format: 'tar.xz';
  archiveSha256: string;
  tools: Record<ToolId, BundledToolRecord>;
}

export interface ToolPackage extends ToolPackageSummary {
  archivePath: string;
  sha256: string;
}

export class PackageIntegrityError extends Error {
  constructor(message: string) { super(message); this.name = 'PackageIntegrityError'; }
}

export class ToolPackageManager {
  private readonly catalogPath: string;
  private readonly archivesDirectory: string;

  constructor(
    private readonly storagePath: string,
    private readonly bundledArchivePath: string,
    private readonly bundledManifestPath: string
  ) {
    this.catalogPath = path.join(storagePath, 'tool-packages.json');
    this.archivesDirectory = path.join(storagePath, 'tool-packages');
  }

  async listPackages(): Promise<ToolPackage[]> {
    const packages: ToolPackage[] = [];
    for (const record of await this.readImportedRecords()) {
      const archivePath = this.importedArchivePath(record.sha256);
      packages.push(await this.withAvailability({
        id: packageId(record.tool, record.version, record.source, record.sha256),
        tool: record.tool,
        version: record.version,
        source: record.source,
        assetName: record.assetName,
        format: 'zip',
        entryRoot: record.entryRoot,
        available: false,
        archivePath,
        sha256: record.sha256
      }));
    }

    const manifest = await this.readBundledManifest();
    if (manifest) {
      for (const tool of Object.keys(TOOL_DEFINITIONS) as ToolId[]) {
        const bundled = manifest.tools[tool];
        const record: ToolPackage = {
          id: packageId(tool, bundled.version, 'bundled', manifest.archiveSha256),
          tool,
          version: bundled.version,
          source: 'bundled',
          assetName: manifest.archive,
          format: manifest.format,
          entryRoot: bundled.entryRoot,
          available: false,
          archivePath: this.bundledArchivePath,
          sha256: manifest.archiveSha256
        };
        packages.push(await this.withAvailability(record));
      }
    }

    return packages.sort((a, b) => sourceRank(a.source) - sourceRank(b.source) ||
      a.tool.localeCompare(b.tool) || compareVersions(b.version, a.version));
  }

  async importPackage(input: {
    tool: ToolId;
    version: string;
    source: RemoteToolSource;
    assetName: string;
    archivePath: string;
    verifiedSha256: string;
  }): Promise<ToolPackage> {
    if (!isTool(input.tool) || (input.source !== 'gitea' && input.source !== 'github')) throw new Error('匯入來源無效。');
    if (!isVersion(input.version)) throw new Error('套件版本需使用 x.y.z 格式。');
    if (!/^[a-f0-9]{64}$/i.test(input.verifiedSha256)) throw new Error('套件 SHA-256 無效。');
    if (path.extname(input.archivePath).toLocaleLowerCase('en-US') !== '.zip') throw new Error('請選擇該工具的 ZIP 檔。');
    const assetName = path.basename(input.assetName).replace(/[\x00-\x1f\x7f]/g, '').slice(0, 180);
    if (!assetName || assetName === '.' || assetName === '..') throw new Error('套件檔名無效。');

    const sourceStat = await lstat(input.archivePath);
    if (!sourceStat.isFile() || sourceStat.isSymbolicLink() || sourceStat.size === 0 || sourceStat.size > MAX_PACKAGE_BYTES) {
      throw new Error('套件不存在、不是一般檔案或超過 80 MB。');
    }

    await mkdir(this.archivesDirectory, { recursive: true });
    const archivePath = this.importedArchivePath(input.verifiedSha256);
    const temporaryPath = path.join(this.archivesDirectory, `${randomUUID()}.tmp`);
    try {
      await copyFile(input.archivePath, temporaryPath);
      const actualSha256 = await sha256File(temporaryPath);
      if (actualSha256 !== input.verifiedSha256.toLowerCase()) throw new PackageIntegrityError('ZIP 內容在匯入期間變更，已取消保存。');

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
      const duplicate = records.find((record) => record.tool === input.tool && record.version === input.version &&
        record.source === input.source && record.sha256 === actualSha256);
      if (!duplicate) {
        records.push({ tool: input.tool, version: input.version, source: input.source, assetName, entryRoot: '', sha256: actualSha256 });
        await this.writeImportedRecords(records);
      }
    } finally {
      await rm(temporaryPath, { force: true });
    }

    const packages = await this.listPackages();
    const imported = packages.find((item) => item.id === packageId(input.tool, input.version, input.source, input.verifiedSha256.toLowerCase()));
    if (!imported) throw new Error('套件匯入後無法在本機套件清單中找到。');
    return imported;
  }

  async getPackage(tool: ToolId, id: string): Promise<ToolPackage> {
    if (!isTool(tool) || typeof id !== 'string' || id.length > 256) throw new Error('套件選擇無效。');
    const selected = (await this.listPackages()).find((item) => item.tool === tool && item.id === id);
    if (!selected) throw new Error('找不到所選套件，請重新整理清單。');
    if (!selected.available) throw new Error(selected.error ?? '套件檔案目前無法讀取。');
    await assertRegularArchive(selected.archivePath);
    if (await sha256File(selected.archivePath) !== selected.sha256) throw new PackageIntegrityError('套件 SHA-256 與保存時的摘要不符，已停止安裝。');
    return selected;
  }

  async installedStates(groupRoot: string | undefined, packages: ToolPackage[]): Promise<InstalledToolState[]> {
    return Promise.all((Object.keys(TOOL_DEFINITIONS) as ToolId[]).map(async (tool) => {
      let status: InstalledToolState['status'] = 'missing';
      let version: string | undefined;
      let source: ToolSource | undefined;
      let message: string | undefined;
      if (groupRoot) {
        try {
          const marker = path.join(groupRoot, '.gitlab-workspace', 'tool-manifests', `${tool}.json`);
          await assertSafeManagedPath(path.resolve(groupRoot), marker);
          const markerStat = await lstat(marker);
          if (!markerStat.isFile() || markerStat.isSymbolicLink()) throw new Error('安裝記錄不是安全的一般檔案。');
          const record = JSON.parse(await readFile(marker, 'utf8')) as { version?: unknown; source?: unknown };
          await verifyInstalledContents(groupRoot, tool, record as Record<string, unknown>);
          version = record.version as string;
          source = record.source as ToolSource;
          status = 'installed';
        } catch (error) {
          if (!(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')) {
            status = 'error';
            message = error instanceof Error ? error.message : '安裝記錄無法讀取。';
          }
        }
      }
      if (status === 'installed' && version && packages.some((item) => item.tool === tool && item.available && compareVersions(item.version, version!) > 0)) {
        status = 'update-available';
      }
      return { tool, version, source, status, message } satisfies InstalledToolState;
    }));
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
      if (!record || !isTool(record.tool) || !isVersion(record.version) ||
        (record.source !== 'github' && record.source !== 'gitea') || !/^([a-f0-9]{64})$/i.test(record.sha256) ||
        record.entryRoot !== '' || typeof record.assetName !== 'string' || !record.assetName || record.assetName.length > 180 ||
        path.basename(record.assetName) !== record.assetName) throw new Error('本機套件清單包含無效項目。');
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
    if (manifest.schema !== BUNDLE_SCHEMA || manifest.archive !== 'offline-tools.tar.xz' || manifest.format !== 'tar.xz' ||
      !/^[a-f0-9]{64}$/i.test(manifest.archiveSha256) || !manifest.tools || typeof manifest.tools !== 'object') {
      throw new Error('內附離線套件索引無效。');
    }
    for (const tool of Object.keys(TOOL_DEFINITIONS) as ToolId[]) {
      const item = manifest.tools[tool];
      if (!item || !isVersion(item.version) || item.entryRoot !== tool || !isReleaseUrl(item.releaseUrl) ||
        !/^[a-f0-9]{64}$/i.test(item.upstreamZipSha256)) throw new Error(`內附 ${tool} 離線套件索引無效。`);
      item.upstreamZipSha256 = item.upstreamZipSha256.toLowerCase();
    }
    manifest.archiveSha256 = manifest.archiveSha256.toLowerCase();
    return manifest;
  }

  private async withAvailability(item: ToolPackage): Promise<ToolPackage> {
    try {
      await assertRegularArchive(item.archivePath);
      return { ...item, available: true };
    } catch (error) {
      return { ...item, available: false, error: error instanceof Error ? error.message : '套件檔案無法讀取。' };
    }
  }

  private importedArchivePath(digest: string): string { return path.join(this.archivesDirectory, `${digest}.zip`); }
}

export function packageId(tool: ToolId, version: string, source: ToolSource, digest: string): string {
  return `${tool}:${version}:${source}:${digest}`;
}

export function compareVersions(first: string, second: string): number {
  const a = first.split('.').map(Number);
  const b = second.split('.').map(Number);
  for (let index = 0; index < 3; index++) if ((a[index] ?? 0) !== (b[index] ?? 0)) return (a[index] ?? 0) - (b[index] ?? 0);
  return 0;
}

export function isVersion(value: unknown): value is string { return typeof value === 'string' && /^\d+\.\d+\.\d+$/.test(value); }

export function isTool(value: unknown): value is ToolId { return value === 'codebase-wiki' || value === 'megin' || value === 'merge-reviewer'; }

function sourceRank(source: ToolSource): number { return source === 'gitea' ? 0 : source === 'github' ? 1 : 2; }

function sha256(bytes: Uint8Array): string { return createHash('sha256').update(bytes).digest('hex'); }

async function assertRegularArchive(filePath: string): Promise<void> {
  const info = await lstat(filePath);
  if (!info.isFile() || info.isSymbolicLink() || info.size === 0 || info.size > MAX_PACKAGE_BYTES) {
    throw new Error('套件不存在、不是一般檔案或超過 80 MB。');
  }
}

async function sha256File(filePath: string): Promise<string> {
  const digest = createHash('sha256');
  for await (const chunk of createReadStream(filePath)) digest.update(chunk as Uint8Array);
  return digest.digest('hex');
}

function isReleaseUrl(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && (url.origin === 'https://github.com' || url.origin === 'https://tech-sharing.cathaysec.com.tw') &&
      !url.username && !url.password && !url.hash;
  } catch { return false; }
}

async function verifyInstalledContents(groupRoot: string, tool: ToolId, raw: Record<string, unknown>): Promise<void> {
  if (raw.schema !== 'gitlab-workspace-managed-tools/v1' || raw.tool !== tool || !isVersion(raw.version) ||
    (raw.source !== 'github' && raw.source !== 'gitea' && raw.source !== 'bundled')) throw new Error('工具安裝記錄格式無效。');
  const resolvedRoot = path.resolve(groupRoot);
  if (tool === 'codebase-wiki') {
    if (typeof raw.installer_state_sha256 !== 'string' || !/^[a-f0-9]{64}$/i.test(raw.installer_state_sha256)) throw new Error('Wiki installer state hash is missing.');
    const statePath = path.join(resolvedRoot, '.agents', 'skills', 'codebase-wiki', 'install-state.json');
    await assertSafeManagedPath(resolvedRoot, statePath);
    const bytes = await readFile(statePath);
    if (sha256(bytes) !== raw.installer_state_sha256.toLowerCase()) throw new Error('Codebase LLM Wiki 安裝記錄已變更，請先檢查。');
    const state = JSON.parse(bytes.toString('utf8')) as { files?: unknown };
    if (!state.files || typeof state.files !== 'object' || Array.isArray(state.files)) throw new Error('Wiki installer state has no file manifest.');
    for (const [relative, value] of Object.entries(state.files as Record<string, unknown>)) {
      if (!value || typeof value !== 'object' || typeof (value as Record<string, unknown>).sha256 !== 'string') throw new Error('Wiki installer file manifest is invalid.');
      const expected = (value as { sha256: string }).sha256;
      if (!/^[a-f0-9]{64}$/i.test(expected)) throw new Error('Wiki installer file hash is invalid.');
      const target = safeManifestPath(resolvedRoot, relative);
      await assertSafeManagedPath(resolvedRoot, target);
      if (sha256(await readFile(target)) !== expected.toLowerCase()) throw new Error(`已安裝的 Codebase LLM Wiki 檔案已變更：${relative}`);
    }
    return;
  }

  if (!raw.skills || typeof raw.skills !== 'object' || Array.isArray(raw.skills)) throw new Error('已安裝的 Skill 清單不存在。');
  const skills = raw.skills as Record<string, unknown>;
  if (Object.keys(skills).length === 0 || (tool === 'merge-reviewer' && Object.keys(skills).length !== 1)) throw new Error(`Installed ${tool} skill count is invalid.`);
  for (const [name, entry] of Object.entries(skills)) {
    if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/.test(name) || (tool === 'merge-reviewer' && name !== 'merge-reviewer') ||
      (tool === 'megin' && !name.startsWith('megin'))) throw new Error('Installed tool Skill path is invalid.');
    if (!entry || typeof entry !== 'object' || !('files' in entry) || !entry.files || typeof entry.files !== 'object' || Array.isArray(entry.files)) throw new Error('Installed skill file map is invalid.');
    const root = path.join(resolvedRoot, '.agents', 'skills', name);
    const actual = await hashTree(resolvedRoot, root);
    const expected = entry.files as Record<string, string>;
    if (JSON.stringify(sortedRecord(actual)) !== JSON.stringify(sortedRecord(expected))) throw new Error(`Installed ${name} Skill changed; inspect local edits before updating.`);
  }
}

async function hashTree(groupRoot: string, root: string): Promise<Record<string, string>> {
  await assertSafeManagedPath(groupRoot, root);
  const result: Record<string, string> = {};
  const walk = async (directory: string): Promise<void> => {
    for (const entry of await (await import('node:fs/promises')).readdir(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name);
      const stat = await lstat(target);
      if (stat.isSymbolicLink()) throw new Error('Installed Skills cannot contain symbolic links.');
      if (stat.isDirectory()) await walk(target);
      else if (stat.isFile()) result[path.relative(root, target).split(path.sep).join('/')] = sha256(await readFile(target));
      else throw new Error('Installed Skill contains a special file.');
    }
  };
  if (!(await lstat(root)).isDirectory()) throw new Error('Installed Skill folder is missing.');
  await walk(root);
  return result;
}

async function assertSafeManagedPath(root: string, target: string): Promise<void> {
  const rootStat = await lstat(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error('Group workspace root is not a safe directory.');
  const relative = path.relative(root, target);
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error('Installed tool path escapes the Group workspace.');
  let current = root;
  for (const part of relative.split(path.sep)) {
    current = path.join(current, part);
    const stat = await lstat(current);
    if (stat.isSymbolicLink()) throw new Error('Installed tool path contains a symbolic link.');
  }
}

function safeManifestPath(root: string, relative: string): string {
  const normalized = relative.replace(/\\/g, '/');
  if (!normalized || normalized.startsWith('/') || /^[A-Za-z]:/.test(normalized) || normalized.split('/').some((part) => part === '..' || part === '.')) throw new Error('Installed tool manifest path is unsafe.');
  const target = path.resolve(root, ...normalized.split('/'));
  const check = path.relative(root, target);
  if (!check || check === '..' || check.startsWith(`..${path.sep}`) || path.isAbsolute(check)) throw new Error('Installed tool manifest path escapes the Group workspace.');
  return target;
}

function sortedRecord(value: Record<string, string>): Record<string, string> { return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))); }
