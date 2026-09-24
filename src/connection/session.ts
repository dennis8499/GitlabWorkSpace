import type { Memento, SecretStorage } from 'vscode';
import { GitLabClient, type GitLabIssueCapabilities } from '../api/gitLabClient';
import type { GitLabGroup, GitLabMetadata, GitLabUser } from '../api/types';
import { normalizeGitLabBaseUrl } from '../api/urlPolicy';

const TOKEN_SECRET_KEY = 'gitlabWorkspace.accessToken';
const BASE_URL_KEY = 'gitlabWorkspace.baseUrl';
const GROUP_ID_KEY = 'gitlabWorkspace.selectedGroupId';
const GROUP_LABEL_KEY = 'gitlabWorkspace.selectedGroupLabel';

export class GitLabSession {
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

  get selectedGroup(): GitLabGroup | undefined {
    const id = this.state.get<number>(GROUP_ID_KEY);
    const fullPath = this.state.get<string>(GROUP_LABEL_KEY);
    if (id === undefined || !fullPath) return undefined;
    return { id, name: fullPath.split('/').at(-1) ?? fullPath, full_path: fullPath, web_url: '' };
  }

  get metadata(): GitLabMetadata | undefined { return this.currentMetadata; }
  get issueCapabilities(): GitLabIssueCapabilities | undefined { return this.currentIssueCapabilities; }
  get instanceWarnings(): readonly string[] { return this.currentInstanceWarnings; }

  async ensureInstanceChecked(): Promise<void> {
    if (!this.instanceCheck) {
      this.instanceCheck = (async () => {
        const client = await this.getClient();
        const [metadata, capabilities] = await Promise.allSettled([client.getMetadata(), client.getIssueCapabilities()]);
        this.currentMetadata = metadata.status === 'fulfilled' ? metadata.value : undefined;
        this.currentIssueCapabilities = capabilities.status === 'fulfilled' ? capabilities.value : undefined;
        this.currentInstanceWarnings = [];
        if (metadata.status === 'rejected') this.currentInstanceWarnings.push('GitLab did not provide its version metadata.');
        if (capabilities.status === 'rejected') this.currentInstanceWarnings.push('GitLab GraphQL capabilities could not be verified; child tasks and thread resolution are unavailable.');
        else {
          if (!capabilities.value.hierarchy) this.currentInstanceWarnings.push('This GitLab version does not expose the required child task hierarchy fields.');
          else if (!capabilities.value.childMutations) this.currentInstanceWarnings.push('This GitLab version does not expose child task mutations.');
          if (!capabilities.value.discussionResolve) this.currentInstanceWarnings.push('This GitLab version does not expose discussion resolution.');
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
    this.cachedClient = new GitLabClient(baseUrl, token);
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
    const client = new GitLabClient(normalizedUrl, token);
    const user = await client.getCurrentUser();
    await this.secrets.store(TOKEN_SECRET_KEY, token);
    await this.state.update(BASE_URL_KEY, normalizedUrl);
    if (serverChanged) {
      await this.setSelectedGroup(undefined);
    }
    this.cachedClient = client;
    this.instanceCheck = undefined;
    await this.ensureInstanceChecked();
    return user;
  }

  async setSelectedGroup(group: GitLabGroup | undefined): Promise<void> {
    await this.state.update(GROUP_ID_KEY, group?.id);
    await this.state.update(GROUP_LABEL_KEY, group?.full_path);
  }

  async disconnect(): Promise<void> {
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
