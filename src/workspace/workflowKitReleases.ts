import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { WorkflowKitReleaseSummary, RemoteToolSource } from './workspaceProtocol';
import { compareVersions } from './workflowKitVersion';
export { compareVersions } from './workflowKitVersion';

export const TOOL_SOURCE_KEY = 'gitlabWorkspace.workflowKit.source';
export const MAX_PACKAGE_BYTES = 80 * 1024 * 1024;
const META = 1024 * 1024;
export const WORKFLOW_KIT_RELEASES: Record<RemoteToolSource, string> = {
  github: 'https://github.com/dennis8499/WorkflowKit/releases',
  gitea: 'https://tech-sharing.cathaysec.com.tw/01002903/WorkflowKit/releases'
};
const API: Record<RemoteToolSource, string> = {
  github: 'https://api.github.com/repos/dennis8499/WorkflowKit/releases',
  gitea: 'https://tech-sharing.cathaysec.com.tw/api/v1/repos/01002903/WorkflowKit/releases'
};
interface Asset { name: string; size: number; sha256: string; }
export interface ReleaseDescriptor {
  schema: 'workflowkit-release/v1'; package: 'gitlab-workspace-kit'; version: string;
  workspaceContract: number; installerApi: number; statusApi?: number; minimumExtensionVersion?: unknown;
  profiles: string[]; skills: string[]; assets: { package: Asset; installer: Asset };
}
export interface WorkflowKitRelease extends WorkflowKitReleaseSummary {
  descriptor: ReleaseDescriptor; descriptorSha256: string; sha256: string;
  assetUrls: { package: string; installer: string };
  archivePath?: string; installerPath?: string;
}
interface Cached { source: RemoteToolSource; descriptor: ReleaseDescriptor; descriptorSha256: string; }
interface ApiAsset { name: string; size: number; browser_download_url: string; digest?: string; }
interface ApiRelease { tag_name: string; draft: boolean; prerelease: boolean; assets: ApiAsset[]; }
export class PackageIntegrityError extends Error {
  constructor(message: string) { super(message); this.name = 'PackageIntegrityError'; }
}

export class WorkflowKitReleaseManager {
  private releases: WorkflowKitRelease[] = [];
  constructor(private readonly storagePath: string, private readonly fetcher: typeof fetch = globalThis.fetch) {}

  async listReleases(): Promise<WorkflowKitRelease[]> { return [...this.releases]; }

  /** Restore only complete, reverified assets from the explicitly selected source. */
  async useCached(source: RemoteToolSource): Promise<WorkflowKitRelease[]> {
    assertSource(source);
    const results: WorkflowKitRelease[] = [];
    for (const item of (await this.readCache()).filter(record => record.source === source)
      .sort((a, b) => compareVersions(b.descriptor.version, a.descriptor.version))) {
      const descriptor = item.descriptor;
      if (descriptor.installerApi !== 1 || descriptor.workspaceContract !== 2) continue;
      try {
        await verifiedFile(this.assetPath(descriptor.assets.installer), descriptor.assets.installer);
        await verifiedFile(this.assetPath(descriptor.assets.package), descriptor.assets.package);
      } catch (error) { if (isMissing(error)) continue; throw releaseError(source, `v${descriptor.version}`, error); }
      results.push({ id: `workflowkit:${source}:${descriptor.version}:${item.descriptorSha256}`, version: descriptor.version, source,
        assetName: descriptor.assets.package.name, format: 'zip', entryRoot: 'workflow-kit', available: true, cached: true,
        skillCount: descriptor.skills.length, descriptor, descriptorSha256: item.descriptorSha256, sha256: descriptor.assets.package.sha256,
        assetUrls: { package: '', installer: '' } });
    }
    this.releases = [...this.releases.filter(item => item.source !== source), ...results];
    return results;
  }

  async refresh(source: RemoteToolSource, signal?: AbortSignal, installedVersion?: string): Promise<WorkflowKitRelease[]> {
    assertSource(source);
    this.releases = this.releases.filter(item => item.source !== source);
    const candidates: ApiRelease[] = [];
    const pageSize = source === 'github' ? 100 : 50;
    for (let page = 1; ; page++) {
      if (page > 100) throw new Error('Release 清單超過查詢上限。');
      const query = source === 'github' ? `per_page=${pageSize}&page=${page}` : `limit=${pageSize}&page=${page}`;
      let nextPage: boolean | undefined;
      const items = JSON.parse((await this.download(`${API[source]}?${query}`, source, 4 * META, signal, headers => {
        const link = headers.get('link');
        if (link !== null) nextPage = /;\s*rel="?next"?(?:\s|,|$)/.test(link);
      })).toString('utf8'));
      if (!Array.isArray(items)) throw new Error('Release 清單格式無效。');
      candidates.push(...items.filter(item => item && !item.draft && !item.prerelease && /^v\d+\.\d+\.\d+$/.test(item.tag_name)));
      if (nextPage === false || nextPage === undefined && items.length < pageSize) break;
    }
    candidates.sort((a, b) => compareVersions(b.tag_name.slice(1), a.tag_name.slice(1)));
    if (!candidates.length) return [];
    const results: WorkflowKitRelease[] = [];
    let compatibleFound = false, installedFound = !installedVersion;
    for (const [index, candidate] of candidates.slice(0, 100).entries()) try {
      if (!Array.isArray(candidate.assets)) throw new PackageIntegrityError('Release 附件清單無效。');
      const metadata = candidate.assets.find(asset => asset.name === 'release.json');
      if (!metadata) throw new PackageIntegrityError('Release 缺少 release.json 索引。');
      assertAssetUrl(metadata.browser_download_url, source, candidate.tag_name, metadata.name);
      const bytes = await this.download(metadata.browser_download_url, source, META, signal);
      if (metadata.size !== bytes.length || metadata.digest && metadata.digest !== `sha256:${digest(bytes)}`) throw new PackageIntegrityError('Release 索引摘要或大小不符。');
      let metadataValue: unknown;
      try { metadataValue = JSON.parse(bytes.toString('utf8')); }
      catch { throw new PackageIntegrityError('Release 索引不是有效的 JSON。'); }
      if (!metadataValue || typeof metadataValue !== 'object' || (metadataValue as { schema?: unknown }).schema !== 'workflowkit-release/v1') {
        throw new PackageIntegrityError('Release 索引格式不受支援。');
      }
      const descriptor = parseDescriptor(metadataValue);
      if (descriptor.version !== candidate.tag_name.slice(1)) throw new PackageIntegrityError('Release tag 與套件版本不符。');
      for (const asset of Object.values(descriptor.assets)) {
        const published = candidate.assets.find(item => item.name === asset.name);
        if (!published || published.size !== asset.size || published.digest && published.digest !== `sha256:${asset.sha256}`) throw new PackageIntegrityError('Release 缺少完整且摘要一致的附件。');
        assertAssetUrl(published.browser_download_url, source, candidate.tag_name, asset.name);
      }
      const compatible = descriptor.installerApi === 1 && descriptor.workspaceContract === 2;
      const selected: WorkflowKitRelease = { id: `workflowkit:${source}:${descriptor.version}:${digest(bytes)}`, version: descriptor.version, source,
        assetName: descriptor.assets.package.name, format: 'zip', entryRoot: 'workflow-kit', available: compatible,
        ...(!compatible ? { error: '此 Release 的工作台契約或安裝介面不受支援。' } : {}),
        skillCount: descriptor.skills.length, descriptor, descriptorSha256: digest(bytes), sha256: descriptor.assets.package.sha256,
        assetUrls: { package: candidate.assets.find(item => item.name === descriptor.assets.package.name)!.browser_download_url,
          installer: candidate.assets.find(item => item.name === descriptor.assets.installer.name)!.browser_download_url } };
      if (index === 0 || compatible && !compatibleFound || descriptor.version === installedVersion) results.push(selected);
      if (compatible) compatibleFound = true;
      if (descriptor.version === installedVersion) installedFound = true;
      if (compatibleFound && installedFound) break;
    } catch (error) {
      if (signal?.aborted) throw error;
      // A transport failure is not evidence that an older release is the
      // latest compatible one. Let the caller offer the verified same-source cache.
      if (!(error instanceof PackageIntegrityError)) throw releaseError(source, candidate.tag_name, error);
      if (index === 0) {
        const version = candidate.tag_name.slice(1);
        const asset = { name: 'unavailable.zip', size: 1, sha256: '0'.repeat(64) };
        const descriptor: ReleaseDescriptor = { schema: 'workflowkit-release/v1', package: 'gitlab-workspace-kit', version,
          workspaceContract: 0, installerApi: 0, profiles: [], skills: [], assets: { package: asset, installer: { ...asset, name: 'unavailable.py' } } };
        results.push({ id: `workflowkit:${source}:${version}:unavailable`, version, source, assetName: asset.name, format: 'zip', entryRoot: 'workflow-kit', available: false,
          error: releaseError(source, candidate.tag_name, error).message, descriptor, descriptorSha256: '', sha256: '', assetUrls: { package: '', installer: '' } });
      }
    }
    this.releases = [...this.releases.filter(item => item.source !== source), ...results];
    return results;
  }

  async prepareInstaller(id: string, beforeWrite: () => void = () => undefined, signal?: AbortSignal): Promise<string> {
    return this.cacheInstaller(id, false, beforeWrite, signal);
  }

  async prepareStatusVerifier(id: string, beforeWrite: () => void = () => undefined, signal?: AbortSignal): Promise<string> {
    return this.cacheInstaller(id, true, beforeWrite, signal);
  }

  private async cacheInstaller(id: string, statusOnly: boolean, beforeWrite: () => void, signal?: AbortSignal): Promise<string> {
    const selected = this.selected(id, statusOnly);
    const filename = await this.cacheAsset(selected, selected.descriptor.assets.installer, beforeWrite, signal);
    const records = await this.readCache();
    const existing = records.find(item => item.source === selected.source && item.descriptor.version === selected.version);
    if (existing && existing.descriptorSha256 !== selected.descriptorSha256) {
      throw releaseError(selected.source, `v${selected.version}`, new PackageIntegrityError('相同來源的同版本 Release 已有不同摘要。'));
    }
    if (!existing) {
      beforeWrite(); await mkdir(this.storagePath, { recursive: true });
      const catalog = path.join(this.storagePath, 'workflow-kit-release-cache.json');
      const temporary = `${catalog}.${randomUUID()}.tmp`;
      try {
        await writeFile(temporary, JSON.stringify({ schema: 'workflowkit-release-cache/v1', releases: [...records,
          { source: selected.source, descriptor: selected.descriptor, descriptorSha256: selected.descriptorSha256 }] }), { flag: 'wx' });
        beforeWrite(); await rename(temporary, catalog);
      } finally { await rm(temporary, { force: true }); }
    }
    return filename;
  }

  async getRelease(id: string, beforeWrite: () => void = () => undefined,
    phase: (message: string) => void = () => undefined, signal?: AbortSignal): Promise<WorkflowKitRelease & { archivePath: string; installerPath: string }> {
    const selected = this.selected(id);
    phase('正在下載與驗證安裝工具…');
    const installerPath = await this.prepareInstaller(id, beforeWrite, signal);
    phase('正在下載與驗證 WorkflowKit…');
    const archivePath = await this.cacheAsset(selected, selected.descriptor.assets.package, beforeWrite, signal);
    beforeWrite(); return { ...selected, archivePath, installerPath };
  }

  async statusHelper(identity: { source: RemoteToolSource; version: string }): Promise<{ path: string; version: string } | undefined> {
    for (const item of await this.readCache()) {
      // Never run a newer verifier, an unverified executable, or a historical
      // installer whose status command may repair transactions as a side effect.
      if (item.source !== identity.source || item.descriptor.version !== identity.version ||
          item.descriptor.installerApi !== 1 || item.descriptor.statusApi !== 1) continue;
      const filename = this.assetPath(item.descriptor.assets.installer);
      try { await verifiedFile(filename, item.descriptor.assets.installer); return { path: filename, version: item.descriptor.version }; }
      catch (error) { if (!isMissing(error)) throw releaseError(item.source, `v${item.descriptor.version}`, error); }
    }
    return undefined;
  }

  private selected(id: string, statusOnly = false): WorkflowKitRelease {
    if (typeof id !== 'string' || id.length > 256) throw new Error('Release 選擇無效。');
    const selected = this.releases.find(item => item.id === id);
    if (!selected) throw new Error('請先檢查最新正式版，再選擇安裝。');
    if (!selected.available && !(statusOnly && selected.descriptor.installerApi === 1 && selected.descriptor.statusApi === 1 && selected.assetUrls.installer)) throw new Error(selected.error ?? '此 Release 不相容或驗證失敗。');
    return selected;
  }
  private assetPath(asset: Asset): string { return path.join(this.storagePath, 'workflow-kit-downloads', `${asset.sha256}${path.extname(asset.name)}`); }
  private async cacheAsset(release: WorkflowKitRelease, asset: Asset, check: () => void, signal?: AbortSignal): Promise<string> {
    check(); const filename = this.assetPath(asset);
    try { await verifiedFile(filename, asset); return filename; }
    catch (error) { if (!isMissing(error)) throw releaseError(release.source, `v${release.version}`, error); }
    const url = asset === release.descriptor.assets.installer ? release.assetUrls.installer : release.assetUrls.package;
    let data: Buffer;
    try {
      data = await this.download(url, release.source, asset === release.descriptor.assets.installer ? 4 * META : MAX_PACKAGE_BYTES, signal);
      if (data.length !== asset.size || digest(data) !== asset.sha256) throw new PackageIntegrityError('下載附件的 SHA-256 或大小與 Release 索引不符。');
    } catch (error) {
      if (signal?.aborted) throw error;
      throw releaseError(release.source, `v${release.version}`, error);
    }
    check(); await mkdir(path.dirname(filename), { recursive: true });
    const directory = await lstat(path.dirname(filename));
    if (!directory.isDirectory() || directory.isSymbolicLink()) throw new PackageIntegrityError('下載快取目錄不是安全目錄。');
    const temporary = `${filename}.${randomUUID()}.tmp`;
    try { await writeFile(temporary, data, { flag: 'wx' }); check(); await rename(temporary, filename); await verifiedFile(filename, asset); }
    finally { await rm(temporary, { force: true }); }
    return filename;
  }
  private async readCache(): Promise<Cached[]> {
    let text: string;
    try { text = await readFile(path.join(this.storagePath, 'workflow-kit-release-cache.json'), 'utf8'); }
    catch (error) { if (isMissing(error)) return []; throw error; }
    if (text.length > 8 * META) throw new PackageIntegrityError('Release 快取索引過大。');
    const value = JSON.parse(text);
    if (value.schema !== 'workflowkit-release-cache/v1' || !Array.isArray(value.releases)) throw new PackageIntegrityError('Release 快取索引格式無效。');
    return value.releases.map((record: Cached) => {
      assertSource(record.source);
      if (!/^[a-f0-9]{64}$/.test(record.descriptorSha256)) throw new PackageIntegrityError('快取索引摘要無效。');
      return { ...record, descriptor: parseDescriptor(record.descriptor) };
    });
  }
  private async download(raw: string, source: RemoteToolSource, limit: number, signal?: AbortSignal, headers?: (value: Headers) => void): Promise<Buffer> {
    let url = new URL(raw);
    const lifetime = AbortSignal.any([AbortSignal.timeout(limit > 4 * META ? 120_000 : 30_000), ...(signal ? [signal] : [])]);
    for (let redirect = 0; redirect <= 5; redirect++) {
      const hosts = source === 'github' ? ['github.com', 'api.github.com', 'release-assets.githubusercontent.com', 'objects.githubusercontent.com'] : ['tech-sharing.cathaysec.com.tw'];
      if (url.protocol !== 'https:' || url.username || url.password || url.port && url.port !== '443' || !hosts.includes(url.hostname)) throw new PackageIntegrityError('Release 下載位置不受信任。');
      const apiRequest = url.hostname === 'api.github.com' || url.pathname.startsWith('/api/v1/');
      const response = await this.fetcher(url.href, { signal: lifetime, redirect: 'manual', headers: {
        'User-Agent': 'GitLab-Workspace-WorkflowKit', Accept: apiRequest ? 'application/json' : 'application/octet-stream'
      } });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get('location'); await response.body?.cancel();
        if (!location) throw new Error('Release 下載重新導向缺少位置。');
        url = new URL(location, url); continue;
      }
      if (!response.ok) { await response.body?.cancel(); throw new Error(`無法取得 ${source} Release（HTTP ${response.status}）。請確認網路或 API 額度後重試。`); }
      headers?.(response.headers);
      if (Number(response.headers.get('content-length')) > limit) { await response.body?.cancel(); throw new PackageIntegrityError('下載附件超過容量限制。'); }
      const chunks: Uint8Array[] = []; let size = 0;
      if (response.body) {
        const reader = response.body.getReader();
        try {
          for (;;) {
            const item = await reader.read(); if (item.done) break;
            size += item.value.byteLength; if (size > limit) throw new PackageIntegrityError('下載附件超過容量限制。');
            lifetime.throwIfAborted(); chunks.push(item.value);
          }
        } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
      }
      return Buffer.concat(chunks);
    }
    throw new Error('Release 下載重新導向次數過多。');
  }
}

export function parseDescriptor(value: unknown): ReleaseDescriptor {
  const data = value as ReleaseDescriptor;
  if (!data || data.schema !== 'workflowkit-release/v1' || data.package !== 'gitlab-workspace-kit' || !isVersion(data.version) ||
    !Number.isSafeInteger(data.workspaceContract) || !Number.isSafeInteger(data.installerApi) || !Array.isArray(data.profiles) ||
    !['group', 'repository'].every(profile => data.profiles.includes(profile)) || !Array.isArray(data.skills) || !data.skills.every(skill => typeof skill === 'string') ||
    !data.assets?.package || !data.assets?.installer || Object.keys(data.assets).length !== 2) throw new PackageIntegrityError('WorkflowKit Release 索引格式無效。');
  for (const [kind, asset] of Object.entries(data.assets)) {
    if (!asset || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(asset.name) || !/^[a-f0-9]{64}$/.test(asset.sha256) ||
      !Number.isSafeInteger(asset.size) || asset.size <= 0 || asset.size > (kind === 'installer' ? 4 * META : MAX_PACKAGE_BYTES)) throw new PackageIntegrityError('Release 附件索引無效。');
  }
  if (!data.assets.package.name.endsWith('.zip') || !data.assets.installer.name.endsWith('.py')) throw new PackageIntegrityError('Release 附件類型無效。');
  return data;
}
export function isVersion(value: unknown): value is string { return typeof value === 'string' && /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value); }
function releaseError(source: RemoteToolSource, tag: string, error: unknown): Error {
  const message = `${source === 'github' ? 'GitHub' : 'Gitea'} Release ${tag}：${error instanceof Error ? error.message : String(error)}`;
  return error instanceof PackageIntegrityError ? new PackageIntegrityError(message) : new Error(message, { cause: error });
}
function digest(bytes: Uint8Array): string { return createHash('sha256').update(bytes).digest('hex'); }
function isMissing(error: unknown): boolean { return !!error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT'; }
function assertSource(source: unknown): asserts source is RemoteToolSource { if (source !== 'github' && source !== 'gitea') throw new Error('Release 來源無效。'); }
function assertAssetUrl(url: string, source: RemoteToolSource, tag: string, name: string): void {
  if (url === `${WORKFLOW_KIT_RELEASES[source]}/download/${tag}/${encodeURIComponent(name)}`) return;
  // Gitea commonly exposes native release attachments by UUID on its own host.
  if (source === 'gitea' && /^https:\/\/tech-sharing\.cathaysec\.com\.tw\/attachments\/[a-zA-Z0-9-]+$/.test(url)) return;
  throw new PackageIntegrityError('Release 附件不在指定 Repo 的下載位置。');
}
async function verifiedFile(filename: string, asset: Asset): Promise<void> {
  const info = await lstat(filename);
  if (!info.isFile() || info.isSymbolicLink() || info.size !== asset.size || digest(await readFile(filename)) !== asset.sha256) throw new PackageIntegrityError('已下載附件的摘要或大小不符，已停止使用。');
}
