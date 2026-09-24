import { gitLabApiRoot, normalizeGitLabBaseUrl } from './urlPolicy';
import type { GitLabGroup, GitLabIssue, GitLabMember, GitLabProject, GitLabUser } from './types';

export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export class GitLabApiError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = 'GitLabApiError';
  }
}

export class GitLabClient {
  readonly baseUrl: string;
  private readonly apiRoot: URL;

  constructor(
    baseUrl: string,
    private readonly token: string,
    private readonly fetcher: FetchLike = fetch
  ) {
    this.baseUrl = normalizeGitLabBaseUrl(baseUrl);
    this.apiRoot = gitLabApiRoot(this.baseUrl);
    if (!token.trim()) {
      throw new Error('A GitLab access token is required.');
    }
  }

  async getCurrentUser(): Promise<GitLabUser> {
    return this.getJson<GitLabUser>('user');
  }

  listGroups(): Promise<GitLabGroup[]> {
    return this.getPages<GitLabGroup>('groups?all_available=false&per_page=100');
  }

  listGroupProjects(groupId: number): Promise<GitLabProject[]> {
    return this.getPages<GitLabProject>(
      `groups/${encodeURIComponent(String(groupId))}/projects?include_subgroups=true&with_shared=false&per_page=100`
    );
  }

  async listAssignedGroupIssues(groupId: number, projectIds: ReadonlySet<number>): Promise<GitLabIssue[]> {
    const issues = await this.getPages<GitLabIssue>(
      `groups/${encodeURIComponent(String(groupId))}/issues?scope=assigned_to_me&state=all&per_page=100`
    );
    return issues.filter((issue) => projectIds.has(issue.project_id));
  }

  listProjectMembers(projectId: number): Promise<GitLabMember[]> {
    return this.getPages<GitLabMember>(`projects/${encodeURIComponent(String(projectId))}/members/all?per_page=100`);
  }

  createIssue(
    projectId: number,
    input: { title: string; description?: string; assigneeId?: number }
  ): Promise<GitLabIssue> {
    const body: Record<string, string | number> = { title: input.title };
    if (input.description?.trim()) {
      body.description = input.description.trim();
    }
    if (input.assigneeId !== undefined) {
      body.assignee_id = input.assigneeId;
    }
    return this.getJson<GitLabIssue>(`projects/${encodeURIComponent(String(projectId))}/issues`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
  }

  private async getJson<T>(path: string, init: RequestInit = {}): Promise<T> {
    const url = new URL(path.replace(/^\/+/, ''), this.apiRoot);
    return this.fetchJson<T>(url, init);
  }

  private async getPages<T>(path: string): Promise<T[]> {
    let next: URL | undefined = new URL(path.replace(/^\/+/, ''), this.apiRoot);
    const values: T[] = [];
    const seen = new Set<string>();

    while (next) {
      if (!this.isSafeApiUrl(next)) {
        throw new GitLabApiError('GitLab returned a pagination link outside the configured API.');
      }
      if (seen.has(next.href)) {
        throw new GitLabApiError('GitLab returned a repeated pagination link.');
      }
      seen.add(next.href);
      const response = await this.fetcher(next, {
        method: 'GET',
        headers: { 'PRIVATE-TOKEN': this.token, Accept: 'application/json' },
        redirect: 'manual'
      });
      const page = await this.readJson<T[]>(response);
      if (!Array.isArray(page)) {
        throw new GitLabApiError('GitLab returned an unexpected list response.', response.status);
      }
      values.push(...page);
      next = this.getNextPage(response, next);
    }

    return values;
  }

  private async fetchJson<T>(url: URL, init: RequestInit): Promise<T> {
    if (!this.isSafeApiUrl(url)) {
      throw new GitLabApiError('The request is outside the configured GitLab API.');
    }
    const response = await this.fetcher(url, {
      ...init,
      headers: {
        Accept: 'application/json',
        ...init.headers,
        'PRIVATE-TOKEN': this.token
      },
      redirect: 'manual'
    });
    return this.readJson<T>(response);
  }

  private async readJson<T>(response: Response): Promise<T> {
    if (response.status >= 300 && response.status < 400) {
      throw new GitLabApiError('GitLab redirected the API request. Check the configured base URL.', response.status);
    }
    if (!response.ok) {
      const message = response.status === 401 || response.status === 403
        ? 'GitLab rejected the access token or its permissions.'
        : `GitLab API request failed (HTTP ${response.status}).`;
      throw new GitLabApiError(message, response.status);
    }
    try {
      return await response.json() as T;
    } catch {
      throw new GitLabApiError('GitLab returned invalid JSON.', response.status);
    }
  }

  private getNextPage(response: Response, current: URL): URL | undefined {
    const link = response.headers.get('link');
    if (link) {
      for (const entry of link.split(',')) {
        const match = entry.match(/<([^>]+)>\s*;\s*rel="?([^";]+)"?/i);
        if (match?.[2].trim() === 'next') {
          try {
            return new URL(match[1], current);
          } catch {
            throw new GitLabApiError('GitLab returned an invalid pagination link.');
          }
        }
      }
    }

    const nextPage = response.headers.get('x-next-page');
    if (!nextPage) {
      return undefined;
    }
    const next = new URL(current);
    next.searchParams.set('page', nextPage);
    return next;
  }

  private isSafeApiUrl(url: URL): boolean {
    return url.origin === this.apiRoot.origin && url.pathname.startsWith(this.apiRoot.pathname) &&
      !url.username && !url.password;
  }
}
