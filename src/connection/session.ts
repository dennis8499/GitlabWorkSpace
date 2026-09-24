import type { Memento, SecretStorage } from 'vscode';
import { GitLabClient } from '../api/gitLabClient';
import type { GitLabGroup, GitLabUser } from '../api/types';
import { normalizeGitLabBaseUrl } from '../api/urlPolicy';

const TOKEN_SECRET_KEY = 'gitlabWorkspace.accessToken';
const BASE_URL_KEY = 'gitlabWorkspace.baseUrl';
const GROUP_ID_KEY = 'gitlabWorkspace.selectedGroupId';
const GROUP_LABEL_KEY = 'gitlabWorkspace.selectedGroupLabel';

export class GitLabSession {
  private cachedClient?: GitLabClient;

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
    return user;
  }

  async setSelectedGroup(group: GitLabGroup | undefined): Promise<void> {
    await this.state.update(GROUP_ID_KEY, group?.id);
    await this.state.update(GROUP_LABEL_KEY, group?.full_path);
  }

  async disconnect(): Promise<void> {
    await this.secrets.delete(TOKEN_SECRET_KEY);
    this.cachedClient = undefined;
    await this.state.update(BASE_URL_KEY, undefined);
    await this.setSelectedGroup(undefined);
  }
}
