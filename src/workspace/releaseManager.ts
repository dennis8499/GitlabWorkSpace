import type { SecretStorage } from 'vscode';
import { createHash } from 'node:crypto';
import { lstat, readdir, readFile } from 'node:fs/promises';
import { isIP } from 'node:net';
import path from 'node:path';
import type { InstalledToolState, ToolId, ToolSource } from './workspaceProtocol';

export interface ToolReleaseAsset {
  name: string;
  downloadUrl: string;
  sha256?: string;
}

export interface ToolRelease {
  tool: ToolId;
  version: string;
  tag: string;
  source: Exclude<ToolSource, 'auto'>;
  releaseUrl: string;
  asset: ToolReleaseAsset;
  fallbackFrom?: Exclude<ToolSource, 'auto'>;
}

export class ReleaseDownloadError extends Error {
  constructor(message: string, options?: ErrorOptions) { super(message, options); this.name = 'ReleaseDownloadError'; }
}

export class ReleaseIntegrityError extends Error {
  constructor(message: string) { super(message); this.name = 'ReleaseIntegrityError'; }
}

interface ReleaseDefinition {
  repository: string;
  folder: string;
  asset: (name: string) => boolean;
}

export interface ProviderRelease {
  tag_name?: string;
  tagName?: string;
  name?: string;
  html_url?: string;
  htmlUrl?: string;
  draft?: boolean;
  prerelease?: boolean;
  pre_release?: boolean;
  assets?: Array<{ name?: string; browser_download_url?: string; browserDownloadUrl?: string; digest?: string }>;
}

const GITEA_ROOT = 'https://tech-sharing.cathaysec.com.tw';
const GITEA_OWNER = '01002903';
const GITEA_TOKEN_KEY = 'gitlabWorkspace.release.gitea-token';
export const TOOL_SOURCE_KEY = 'gitlabWorkspace.release.source';

export const TOOL_DEFINITIONS: Record<ToolId, ReleaseDefinition> = {
  'codebase-wiki': { repository: 'code-base-llm-wiki', folder: 'codebase-wiki-codex', asset: (name) => name === 'codebase-llm-wiki-codex.zip' },
  megin: { repository: 'Megin', folder: 'megin-skills', asset: (name) => name === 'megin-skills.zip' },
  'merge-reviewer': { repository: 'MergeReviewer', folder: 'merge-reviewer', asset: (name) => /^merge-reviewer-\d+\.\d+\.\d+\.zip$/i.test(name) }
};

export function releaseAssetSelection(tool: ToolId, release: ProviderRelease): ToolReleaseAsset | undefined {
  const asset = release.assets?.find((candidate) => typeof candidate.name === 'string' && TOOL_DEFINITIONS[tool].asset(candidate.name) &&
    typeof (candidate.browser_download_url ?? candidate.browserDownloadUrl) === 'string');
  const downloadUrl = asset?.browser_download_url ?? asset?.browserDownloadUrl;
  if (!asset?.name || !downloadUrl) return undefined;
  return { name: asset.name, downloadUrl, sha256: typeof asset.digest === 'string' ? asset.digest.match(/^sha256:([a-f0-9]{64})$/i)?.[1] : undefined };
}

export function parseReleaseVersion(tag: string, name?: string): string | undefined {
  const match = /(?:^|[^0-9])v?(\d+\.\d+\.\d+)(?:[-+][0-9A-Za-z.-]+)?(?:$|[^0-9])/i.exec(tag) ??
    (name ? /(?:^|[^0-9])v?(\d+\.\d+\.\d+)(?:[-+][0-9A-Za-z.-]+)?(?:$|[^0-9])/i.exec(name) : undefined);
  return match?.[1];
}

export class ToolReleaseManager {
  constructor(private readonly secrets: SecretStorage, private readonly fetcher: typeof fetch = fetch) {}

  async saveGiteaToken(token: string): Promise<void> {
    const value = token.trim();
    if (!value || value.length > 4096 || /[\r\n\0]/.test(value)) throw new Error('請輸入有效的內網 Gitea Token。');
    await this.secrets.store(GITEA_TOKEN_KEY, value);
  }

  async listReleases(tool: ToolId, preference: ToolSource): Promise<ToolRelease[]> {
    if (preference === 'github') return this.listFrom(tool, 'github');
    if (preference === 'gitea') return this.listFrom(tool, 'gitea');
    try {
      const github = await this.listFrom(tool, 'github');
      if (github.length) return github;
      return (await this.listFrom(tool, 'gitea')).map((release) => ({ ...release, fallbackFrom: 'github' }));
    } catch (error) {
      try {
        const releases = await this.listFrom(tool, 'gitea');
        return releases.map((release) => ({ ...release, fallbackFrom: 'github' }));
      } catch (fallbackError) {
        throw new Error(`GitHub 無可用 Release，內網 Gitea 亦無法讀取：${safeProviderError(fallbackError, 'gitea')}`,
          { cause: new AggregateError([error, fallbackError]) });
      }
    }
  }

  async latestCompatible(tool: ToolId, preference: ToolSource): Promise<ToolRelease> {
    const releases = await this.listReleases(tool, preference);
    const latest = [...releases].sort((a, b) => compareVersion(b.version, a.version))[0];
    if (!latest) throw new Error(`${TOOL_DEFINITIONS[tool].repository} 沒有符合格式的正式 Release 資產。`);
    return latest;
  }

  async getVersion(tool: ToolId, version: string, preference: ToolSource): Promise<ToolRelease> {
    if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error('Release 版本格式無效。');
    if (preference === 'auto') {
      let githubError: unknown;
      try {
        const githubRelease = (await this.listFrom(tool, 'github')).find((release) => release.version === version);
        if (githubRelease) return githubRelease;
      } catch (error) {
        githubError = error;
      }
      const giteaRelease = (await this.listFrom(tool, 'gitea')).find((release) => release.version === version);
      if (giteaRelease) return { ...giteaRelease, fallbackFrom: 'github' };
      if (githubError) throw new Error(`GitHub ${version} Release unavailable; Gitea did not provide the same version.`, { cause: githubError });
      throw new Error(`${TOOL_DEFINITIONS[tool].repository} v${version} is unavailable from both Release sources.`);
    }
    const releases = await this.listReleases(tool, preference);
    const selected = releases.find((release) => release.version === version);
    if (!selected) throw new Error(`來源中找不到 ${TOOL_DEFINITIONS[tool].repository} v${version} 的相容資產。`);
    return selected;
  }

  async download(release: ToolRelease): Promise<Uint8Array> {
    const sourceOrigin = release.source === 'github' ? 'https://github.com' : GITEA_ROOT;
    const url = new URL(release.asset.downloadUrl);
    if (url.origin !== sourceOrigin || !isSafeReleaseUrl(url) || url.search.length > 2048) {
      throw new Error('Release 的附件網址不安全。');
    }
    const token = release.source === 'gitea' ? await this.secrets.get(GITEA_TOKEN_KEY) : undefined;
    let response: Response;
    try { response = await fetchWithSafeRedirects(url, new URL(sourceOrigin), token, 6, this.fetcher); }
    catch (error) {
      if (error instanceof TypeError || (error instanceof Error && ['AbortError', 'TimeoutError'].includes(error.name))) {
        throw new ReleaseDownloadError(`Release 附件連線失敗：${safeProviderError(error, release.source)}。`, { cause: error });
      }
      throw error;
    }
    if (!response.ok) throw new ReleaseDownloadError(`Release 附件下載失敗（HTTP ${response.status}）。`);
    const statedLength = Number(response.headers.get('content-length'));
    const maximum = 80 * 1024 * 1024;
    if (Number.isFinite(statedLength) && statedLength > maximum) throw new Error('Release 封裝超過 80 MB 限制。');
    if (!response.body) throw new Error('Release 附件沒有內容。');
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const next = await reader.read();
        if (next.done) break;
        size += next.value.byteLength;
        if (size > maximum) { await reader.cancel(); throw new Error('Release 封裝超過 80 MB 限制。'); }
        chunks.push(next.value);
      }
    } catch (error) {
      await reader.cancel().catch(() => undefined);
      if (error instanceof Error && error.message.includes('80 MB')) throw error;
      if (error instanceof TypeError || (error instanceof Error && ['AbortError', 'TimeoutError'].includes(error.name))) throw new ReleaseDownloadError('Release 附件下載中斷。', { cause: error });
      throw error;
    }
    const result = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.byteLength; }
    if (release.asset.sha256) {
      const { createHash } = await import('node:crypto');
      const digest = createHash('sha256').update(result).digest('hex');
      if (digest.toLowerCase() !== release.asset.sha256.toLowerCase()) throw new ReleaseIntegrityError('Release 的 SHA-256 與來源資產摘要不符。');
    }
    return result;
  }

  async installedStates(groupRoot: string | undefined, preference: ToolSource): Promise<InstalledToolState[]> {
    const tokens = await Promise.all((Object.keys(TOOL_DEFINITIONS) as ToolId[]).map(async (tool) => {
      let status: InstalledToolState['status'] = 'missing';
      let version: string | undefined;
      let source: 'github' | 'gitea' | undefined;
      let message: string | undefined;
      if (groupRoot) {
        try {
          const marker = path.join(groupRoot, '.gitlab-workspace', 'tool-manifests', `${tool}.json`);
          await assertSafeManagedPath(path.resolve(groupRoot), marker);
          const markerStat = await lstat(marker);
          if (!markerStat.isFile() || markerStat.isSymbolicLink()) throw new Error('Tool installation marker is not a regular file.');
          const record = JSON.parse(await readFile(marker, 'utf8')) as { version?: unknown; source?: unknown };
          if (typeof record.version === 'string') version = record.version;
          if (record.source === 'github' || record.source === 'gitea') source = record.source;
          await verifyInstalledContents(groupRoot, tool, record as Record<string, unknown>);
          status = 'installed';
        } catch (error) {
          if (!(error && typeof error === 'object' && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT')) {
            status = 'error';
            message = safeProviderError(error, preference === 'auto' ? 'github' : preference);
          }
        }
      }
      if (status !== 'error') {
        try {
          const latest = await this.latestCompatible(tool, preference);
          if (latest.version !== version) status = version ? 'update-available' : 'missing';
          if (latest.fallbackFrom) message = 'GitHub 無可用資產，已切換內網 Gitea。';
        } catch (error) {
          message = safeProviderError(error, preference === 'auto' ? 'github' : preference);
          if (version) status = 'installed';
          else status = 'missing';
        }
      }
      return { tool, version, source, status, message } satisfies InstalledToolState;
    }));
    return tokens;
  }

  private async listFrom(tool: ToolId, source: 'github' | 'gitea'): Promise<ToolRelease[]> {
    const definition = TOOL_DEFINITIONS[tool];
    const apiUrl = source === 'github'
      ? `https://api.github.com/repos/dennis8499/${definition.repository}/releases?per_page=20`
      : `${GITEA_ROOT}/api/v1/repos/${GITEA_OWNER}/${definition.repository}/releases?limit=20`;
    const url = new URL(apiUrl);
    const token = source === 'gitea' ? await this.secrets.get(GITEA_TOKEN_KEY) : undefined;
    const headers: Record<string, string> = { Accept: 'application/json', 'User-Agent': 'GitLab-Workspace' };
    if (source === 'github') headers['X-GitHub-Api-Version'] = '2022-11-28';
    if (token) headers.Authorization = `token ${token}`;
    const response = await this.fetcher(url, { headers, redirect: 'manual', signal: AbortSignal.timeout(20_000) });
    if (!response.ok) {
      if (source === 'gitea' && (response.status === 401 || response.status === 403)) throw new Error('內網 Gitea 需要有效的 Release 讀取 Token。');
      throw new Error(`${source === 'github' ? 'GitHub' : '內網 Gitea'} Release API 連線失敗（HTTP ${response.status}）。`);
    }
    const text = await response.text();
    if (text.length > 5 * 1024 * 1024) throw new Error('Release API 回應超過 5 MB 限制。');
    let payload: unknown;
    try { payload = JSON.parse(text) as unknown; } catch { throw new Error('Release API 回傳的內容不是有效 JSON。'); }
    if (!Array.isArray(payload)) throw new Error('Release API 回傳的資料格式不相容。');
    const releases: ToolRelease[] = [];
    for (const value of payload) {
      if (!value || typeof value !== 'object') continue;
      const raw = value as ProviderRelease;
      if (raw.draft || raw.prerelease || raw.pre_release) continue;
      const tag = raw.tag_name ?? raw.tagName;
      if (!tag) continue;
      const version = parseReleaseVersion(tag, raw.name);
      const asset = releaseAssetSelection(tool, raw);
      if (!version || !asset) continue;
      const releaseUrl = raw.html_url ?? raw.htmlUrl;
      const download = new URL(asset.downloadUrl);
      if (!isSafeReleaseUrl(download) || download.origin !== (source === 'github' ? 'https://github.com' : GITEA_ROOT)) continue;
      if (source === 'gitea' && download.origin !== GITEA_ROOT) continue;
      releases.push({ tool, version, tag, source, releaseUrl: releaseUrl ?? `${source === 'github' ? 'https://github.com/dennis8499' : `${GITEA_ROOT}/${GITEA_OWNER}`}/${definition.repository}/releases/tag/${encodeURIComponent(tag)}`, asset });
    }
    return releases;
  }
}

async function verifyInstalledContents(groupRoot: string, tool: ToolId, raw: Record<string, unknown>): Promise<void> {
  const resolvedRoot = path.resolve(groupRoot);
  const schema = 'gitlab-workspace-managed-tools/v1';
  if (raw.schema !== schema || raw.tool !== tool || typeof raw.version !== 'string' || !/^\d+\.\d+\.\d+$/.test(raw.version) || (raw.source !== 'github' && raw.source !== 'gitea')) {
    throw new Error('Tool installation manifest is invalid.');
  }
  if (tool === 'codebase-wiki') {
    if (typeof raw.installer_state_sha256 !== 'string' || !/^[a-f0-9]{64}$/i.test(raw.installer_state_sha256)) throw new Error('Wiki installer state hash is missing.');
    const statePath = path.join(resolvedRoot, '.agents', 'skills', 'codebase-wiki', 'install-state.json');
    await assertSafeManagedPath(resolvedRoot, statePath);
    const bytes = await readFile(statePath);
    const stateHash = createHash('sha256').update(bytes).digest('hex');
    if (stateHash !== raw.installer_state_sha256.toLowerCase()) throw new Error('Codebase LLM Wiki installer state changed; verify it before use.');
    const state = JSON.parse(bytes.toString('utf8')) as { files?: unknown };
    if (!state.files || typeof state.files !== 'object' || Array.isArray(state.files)) throw new Error('Wiki installer state has no file manifest.');
    const files = state.files as Record<string, unknown>;
    for (const [relative, value] of Object.entries(files)) {
      if (!value || typeof value !== 'object' || typeof (value as Record<string, unknown>).sha256 !== 'string') throw new Error('Wiki installer file manifest is invalid.');
      const expected = (value as { sha256: string }).sha256;
      if (!/^[a-f0-9]{64}$/i.test(expected)) throw new Error('Wiki installer file hash is invalid.');
      const target = safeManifestPath(resolvedRoot, relative);
      await assertSafeManagedPath(resolvedRoot, target);
      const actual = createHash('sha256').update(await readFile(target)).digest('hex');
      if (actual !== expected.toLowerCase()) throw new Error(`Installed Codebase LLM Wiki file was changed: ${relative}`);
    }
    return;
  }

  if (!raw.skills || typeof raw.skills !== 'object' || Array.isArray(raw.skills)) throw new Error('Installed skill manifest is missing.');
  const skills = raw.skills as Record<string, unknown>;
  const names = Object.keys(skills);
  const expectedCount = tool === 'megin' ? names.length : 1;
  if (names.length !== expectedCount || names.length === 0) throw new Error(`Installed ${tool} skill count is invalid.`);
  for (const [name, entry] of Object.entries(skills)) {
    if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/.test(name) || (tool === 'merge-reviewer' && name !== 'merge-reviewer') || (tool === 'megin' && !name.startsWith('megin'))) {
      throw new Error('Installed skill path is invalid.');
    }
    if (!entry || typeof entry !== 'object' || !('files' in entry) || !entry.files || typeof entry.files !== 'object' || Array.isArray(entry.files)) throw new Error('Installed skill file map is invalid.');
    const expected = entry.files as Record<string, unknown>;
    const root = path.join(resolvedRoot, '.agents', 'skills', name);
    const actual = await hashTree(resolvedRoot, root);
    if (JSON.stringify(sortedRecord(actual)) !== JSON.stringify(sortedRecord(expected as Record<string, string>))) {
      throw new Error(`Installed ${name} Skill changed; inspect local edits before updating.`);
    }
  }
}

async function hashTree(groupRoot: string, root: string): Promise<Record<string, string>> {
  await assertSafeManagedPath(groupRoot, root);
  const result: Record<string, string> = {};
  const walk = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name);
      const stat = await lstat(target);
      if (stat.isSymbolicLink()) throw new Error('Installed Skills cannot contain symbolic links.');
      if (stat.isDirectory()) await walk(target);
      else if (stat.isFile()) result[path.relative(root, target).split(path.sep).join('/')] = createHash('sha256').update(await readFile(target)).digest('hex');
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

function sortedRecord(value: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)));
}

async function fetchWithSafeRedirects(url: URL, source: URL, token: string | undefined, maxRedirects: number, fetcher: typeof fetch): Promise<Response> {
  let current = new URL(url);
  for (let redirects = 0; redirects <= maxRedirects; redirects++) {
    const headers = new Headers({ Accept: 'application/zip' });
    if (token && current.origin === source.origin) headers.set('Authorization', `token ${token}`);
    const response = await fetcher(current, { headers, redirect: 'manual', signal: AbortSignal.timeout(60_000) });
    if (response.status < 300 || response.status >= 400) return response;
    const location = response.headers.get('location');
    await response.body?.cancel();
    if (!location || redirects === maxRedirects) throw new Error('Release 附件重新導向次數過多或缺少位置。');
    const next = new URL(location, current);
    if (!isSafeReleaseUrl(next)) throw new Error('Release 附件重新導向至不安全網址。');
    current = next;
  }
  throw new Error('Release 附件網址無法安全解析。');
}

function isSafeReleaseUrl(url: URL): boolean {
  const host = url.hostname.toLocaleLowerCase('en-US');
  return url.protocol === 'https:' && !url.username && !url.password && !url.hash && !isIP(host) &&
    host.includes('.') && !/(^|\.)(localhost|local|internal|test|invalid|example)$/.test(host);
}

function compareVersion(a: string, b: string): number {
  const first = a.split('.').map(Number);
  const second = b.split('.').map(Number);
  for (let index = 0; index < 3; index++) {
    const difference = (first[index] ?? 0) - (second[index] ?? 0);
    if (difference) return difference;
  }
  return 0;
}

function safeProviderError(error: unknown, source: ToolSource): string {
  if (!(error instanceof Error)) return 'Release 服務目前無法使用。';
  const message = error.message.replace(/https?:\/\/\S+/gi, 'Release URL').replace(/(?:token|authorization)[^\s]*/gi, '憑證');
  return source === 'github' ? message : message || '內網 Gitea 目前無法使用。';
}
