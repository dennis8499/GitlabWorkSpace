import type { Memento, SecretStorage } from 'vscode';
import { GitLabClient, type GitLabIssueCapabilities } from '../api/gitLabClient';
import { GitLabReadCache } from '../api/gitLabReadCache';
import type { GitLabGroup, GitLabMetadata, GitLabUser } from '../api/types';
import { normalizeGitLabBaseUrl } from '../api/urlPolicy';

const TOKEN_SECRET_KEY = 'gitlabWorkspace.accessToken';
const BASE_URL_KEY = 'gitlabWorkspace.baseUrl';
const GROUP_ID_KEY = 'gitlabWorkspace.selectedGroupId';
const GROUP_LABEL_KEY = 'gitlabWorkspace.selectedGroupLabel';

export class GitLabSession {
  private readonly readCache = new GitLabReadCache(60_000, 256);
  private connectionEpochValue = 0;
  private cachedClient?: GitLabClient;
  private currentMetadata?: GitLabMetadata;
  private currentIssueCapabilities?: GitLabIssueCapabilities;
  private currentInstanceWarnings: string[] = [];
  private instanceCheck?: Promise<void>;

  constructor(private readonly secrets: SecretStorage, private readonly state: Memento) {}

  get baseUrl(): string | undefined {
    const value = this.state.get<string>(BASE_URL_KEY);
    return value ? normalizeGitLabBaseUrl(value) : undefined;
  }

  get connectionEpoch(): number { return this.connectionEpochValue; }

  get selectedGroup(): GitLabGroup | undefined {
    const id = this.state.get<number>(GROUP_ID_KEY);
    const fullPath = this.state.get<string>(GROUP_LABEL_KEY);
    if (id === undefined || !fullPath) return undefined;
    return { id, name: fullPath.split('/').at(-1) ?? fullPath, full_path: fullPath, web_url: '' };
  }

  get metadata(): GitLabMetadata | undefined { return this.currentMetadata; }
  get issueCapabilities(): GitLabIssueCapabilities | undefined { return this.currentIssueCapabilities; }
  get instanceWarnings(): readonly string[] { return this.currentInstanceWarnings; }

  cachedRead<T>(
    key: string,
    load: (client: GitLabClient, signal: AbortSignal) => Promise<T>,
    options: { force?: boolean; signal?: AbortSignal } = {}
  ): Promise<T> {
    const baseUrl = this.baseUrl;
    if (!baseUrl) return Promise.reject(new Error('Connect to GitLab first.'));
    const cacheKey = `${this.connectionEpochValue}\0${baseUrl}\0${key}`;
    return this.readCache.get(cacheKey, async (signal) => {
      const client = await this.getClient();
      return load(client.withReadSignal(signal), signal);
    }, options);
  }

  invalidateReadCache(): void { this.readCache.invalidate(); }

  async ensureInstanceChecked(): Promise<void> {
    if (!this.instanceCheck) {
      this.instanceCheck = (async () => {
        const client = await this.getClient();
        const [metadata, capabilities] = await Promise.allSettled([client.getMetadata(), client.getIssueCapabilities()]);
        this.currentMetadata = metadata.status === 'fulfilled' ? metadata.value : undefined;
        this.currentIssueCapabilities = capabilities.status === 'fulfilled' ? capabilities.value : undefined;
        this.currentInstanceWarnings = [];
        if (metadata.status === 'rejected' || !this.currentMetadata?.version) this.currentInstanceWarnings.push('GitLab version metadata is unavailable. The 16.11.10 minimum cannot be verified; confirmed supported features will still load.');
        else {
          const version = this.currentMetadata.version.match(/^(\d+)\.(\d+)\.(\d+)/);
          if (!version) this.currentInstanceWarnings.push('GitLab returned an unrecognized version. The 16.11.10 minimum cannot be verified; confirmed supported features will still load.');
          else {
            const actual = version.slice(1).map(Number);
            if (actual[0] < 16 || (actual[0] === 16 && actual[1] < 11) || (actual[0] === 16 && actual[1] === 11 && actual[2] < 10)) {
              this.currentInstanceWarnings.push(`GitLab ${this.currentMetadata.version} is below the minimum supported version, Community Edition 16.11.10. Available APIs will still be loaded.`);
            }
          }
          if (this.currentMetadata.enterprise === false) {
            this.currentInstanceWarnings.push('Community Edition does not include Premium/Ultimate blocking issue links or merge request approval controls.');
          } else if (this.currentMetadata.enterprise !== true) this.currentInstanceWarnings.push('GitLab edition metadata is unavailable; edition-specific controls remain disabled until their support can be verified.');
        }
        if (capabilities.status === 'rejected') this.currentInstanceWarnings.push('GitLab GraphQL capabilities could not be verified; confirmed REST features will still load.');
        else {
          if (!capabilities.value.hierarchy) this.currentInstanceWarnings.push('Child tasks are unavailable because this GitLab GraphQL schema does not expose the required hierarchy fields.');
          else if (!capabilities.value.childMutations) this.currentInstanceWarnings.push('Child tasks are read-only because this GitLab GraphQL schema does not expose the required mutations.');
          if (!capabilities.value.discussionResolve) this.currentInstanceWarnings.push('Discussion resolution is unavailable on this GitLab GraphQL schema.');
          if (!capabilities.value.startDate) this.currentInstanceWarnings.push('Issue start-date editing is unavailable on this GitLab GraphQL schema.');
          if (!capabilities.value.timelogReport) this.currentInstanceWarnings.push('Individual time-entry reports are unavailable on this GitLab GraphQL schema; REST time totals and logging remain available.');
          if (!capabilities.value.timelogCreateDated) this.currentInstanceWarnings.push('Date-specific time entry logging is unavailable on this GitLab GraphQL schema; undated time logging remains available through REST.');
          if (capabilities.value.timelogReport && capabilities.value.timelogDelete && !capabilities.value.timelogAdminPermission) this.currentInstanceWarnings.push('Time-entry delete permissions are unavailable on this GitLab GraphQL schema; deletion is disabled.');
        }
      })();
    }
    await this.instanceCheck;
    if (!this.currentMetadata || !this.currentIssueCapabilities) this.instanceCheck = undefined;
  }

  async getClient(): Promise<GitLabClient> {
    if (this.cachedClient) return this.cachedClient;
    const baseUrl = this.baseUrl;
    const token = await this.secrets.get(TOKEN_SECRET_KEY);
    if (!baseUrl || !token) {
      throw new Error('Connect to GitLab first.');
    }
    this.cachedClient = new GitLabClient(baseUrl, token, undefined, undefined, () => this.invalidateReadCache());
    return this.cachedClient;
  }

  async getCloneCredentials(): Promise<{ baseUrl: string; token: string }> {
    const baseUrl = this.baseUrl;
    const token = await this.secrets.get(TOKEN_SECRET_KEY);
    if (!baseUrl || !token) throw new Error('Connect to GitLab first.');
    return { baseUrl, token };
  }

  async connect(baseUrl: string, token: string): Promise<GitLabUser> {
    const normalizedUrl = normalizeGitLabBaseUrl(baseUrl);
    const serverChanged = this.baseUrl !== normalizedUrl;
    const probeClient = new GitLabClient(normalizedUrl, token);
    const user = await probeClient.getCurrentUser();
    await this.secrets.store(TOKEN_SECRET_KEY, token);
    await this.state.update(BASE_URL_KEY, normalizedUrl);
    if (serverChanged) {
      await this.setSelectedGroup(undefined);
    }
    this.connectionEpochValue++;
    this.readCache.clear();
    this.cachedClient = new GitLabClient(normalizedUrl, token, undefined, undefined, () => this.invalidateReadCache());
    this.instanceCheck = undefined;
    await this.ensureInstanceChecked();
    return user;
  }

  async setSelectedGroup(group: GitLabGroup | undefined): Promise<void> {
    const current = this.selectedGroup;
    if (current?.id !== group?.id || current?.full_path !== group?.full_path) this.readCache.invalidate();
    await this.state.update(GROUP_ID_KEY, group?.id);
    await this.state.update(GROUP_LABEL_KEY, group?.full_path);
  }

  async disconnect(): Promise<void> {
    this.connectionEpochValue++;
    this.readCache.clear();
    await this.secrets.delete(TOKEN_SECRET_KEY);
    this.cachedClient = undefined;
    this.currentMetadata = undefined;
    this.currentIssueCapabilities = undefined;
    this.currentInstanceWarnings = [];
    this.instanceCheck = undefined;
    await this.state.update(BASE_URL_KEY, undefined);
    await this.setSelectedGroup(undefined);
  }
}
