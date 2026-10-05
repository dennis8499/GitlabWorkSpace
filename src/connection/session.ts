import type { Memento, SecretStorage } from 'vscode';
import { GitLabClient, type GitLabIssueCapabilities, type GitLabWriteContext } from '../api/gitLabClient';
import { GitLabReadCache } from '../api/gitLabReadCache';
import type { GitLabGroup, GitLabMetadata, GitLabUser } from '../api/types';
import type { GitLabCapabilityDiagnostic } from '../api/graphqlCapabilities';
import { normalizeGitLabBaseUrl } from '../api/urlPolicy';

const TOKEN_SECRET_KEY = 'gitlabWorkspace.accessToken';
const BASE_URL_KEY = 'gitlabWorkspace.baseUrl';
const GROUP_ID_KEY = 'gitlabWorkspace.selectedGroupId';
const GROUP_LABEL_KEY = 'gitlabWorkspace.selectedGroupLabel';

export class GitLabSession {
  private readonly readCache = new GitLabReadCache(60_000, 256);
  private connectionEpochValue = 0;
  private connectionAttempt = 0;
  private connectionTransition = false;
  private cachedClient?: GitLabClient;
  private clientCheck?: Promise<GitLabClient>;
  private connectionAbort = new AbortController();
  private currentMetadata?: GitLabMetadata;
  private currentIssueCapabilities?: GitLabIssueCapabilities;
  private currentInstanceWarnings: string[] = [];
  private instanceProbeRevision = 0;
  private capabilityProbeError?: string;
  private metadataCheck?: Promise<void>;
  private capabilitiesCheck?: Promise<void>;
  private metadataRetryAt = 0;
  private capabilitiesRetryAt = 0;
  private readonly groupProjectIds = new Map<number, Set<number>>();

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
  get capabilityDiagnostics(): readonly GitLabCapabilityDiagnostic[] {
    const capabilities = this.currentIssueCapabilities;
    const unknown = !capabilities;
    const reason = this.capabilityProbeError ? `無法讀取 GitLab GraphQL Schema：${this.capabilityProbeError}` : '尚未確認 GitLab GraphQL Schema。';
    const diagnostic = (id: string, label: string, supported: boolean, unsupportedReason: string, source: GitLabCapabilityDiagnostic['source'], supportedReason?: string): GitLabCapabilityDiagnostic => ({
      id, label, status: unknown ? 'unknown' : supported ? 'supported' : 'unsupported',
      reason: unknown ? reason : supported ? supportedReason : unsupportedReason, source
    });
    return [
      diagnostic('permissions', 'Issue 權限與操作', capabilities?.issuePermissionSource === 'issue'
        ? (capabilities.issuePermissionFields?.includes('updateIssue') || capabilities.issuePermissionFields?.includes('adminIssue') || false) && !!capabilities.issuePermissionFields?.includes('createNote')
        : capabilities?.issuePermissionSource === 'workItem' && !!capabilities.workItemScope && !!capabilities.workItemPermissionFields?.some((field) => field === 'updateWorkItem' || field === 'adminWorkItem') && !!capabilities.workItemPermissionFields?.includes('createNote'),
      '伺服器沒有提供可確認 Issue 編輯與留言權限的欄位。', 'GraphQL'),
      diagnostic('tasks', '子任務', !!capabilities?.hierarchy && !!capabilities?.childMutations, '此版本的 GraphQL Schema 未提供完整子任務操作。', 'GraphQL'),
      diagnostic('discussionResolve', '解決討論串', !!capabilities?.discussionResolve, '此版本的 GraphQL Schema 未提供討論串解決操作。', 'GraphQL'),
      diagnostic('startDate', 'Issue 開始日期', !!capabilities?.startDate, '此執行個體未提供 Issue 開始日期的原生 Schema 欄位。', 'GraphQL', 'Schema 有此欄位；仍會依每個 Issue 類型的日期 Widget 確認是否可編輯。'),
      diagnostic('timelogReport', '個別工時紀錄', !!capabilities?.timelogReport, '目前 Schema 未提供個別工時明細；工時總數仍由 REST 提供。', 'GraphQL / REST'),
      diagnostic('timelogCreateDated', '指定日期登錄工時', true, '', capabilities?.timelogCreateDated ? 'GraphQL' : 'GitLab /spend', capabilities?.timelogCreateDated ? undefined : '透過 GitLab /spend 快捷指令記錄；GitLab 會在 Issue 留下工時留言。'),
      {
        id: 'blockingLinks', label: '阻擋關聯',
        status: this.currentMetadata?.enterprise === false ? 'unsupported' : 'unknown',
        reason: this.currentMetadata?.enterprise === false ? 'GitLab Community Edition 不提供阻擋關聯。'
          : this.currentMetadata?.enterprise === true ? '阻擋關聯需 Premium 或 Ultimate；此執行個體的方案無法由版本資訊確認。'
            : '無法確認 GitLab Edition 或方案，因此阻擋關聯仍未確認。',
        source: 'REST'
      },
      diagnostic('mergeRequestApprovals', 'Merge Request 核准', true, '', 'REST')
    ];
  }

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
      const value = await load(client.withReadSignal(signal), signal);
      const match = /^group\/(\d+)\/projects$/.exec(key);
      if (match && Array.isArray(value)) {
        const ids = new Set(value.flatMap((item) => item && typeof item === 'object' && 'id' in item && Number.isSafeInteger(item.id) ? [item.id as number] : []));
        this.groupProjectIds.set(Number(match[1]), ids);
      }
      return value;
    }, options);
  }

  invalidateReadCache(): void { this.readCache.invalidate(); }

  private invalidateAfterWrite(context: GitLabWriteContext): void {
    const url = new URL(context.url);
    const project = /\/projects\/(\d+)(?:\/|$)/.exec(url.pathname);
    const group = /\/groups\/(\d+)(?:\/|$)/.exec(url.pathname);
    const projectId = project ? Number(project[1]) : undefined;
    const groupId = group ? Number(group[1]) : undefined;
    if (groupId !== undefined) {
      this.readCache.invalidateWhere((key) => key.includes(`\0group/${groupId}/`));
      return;
    }
    if (projectId !== undefined) {
      const groups = new Set([...this.groupProjectIds].filter(([, ids]) => ids.has(projectId)).map(([id]) => id));
      const currentGroupId = this.selectedGroup?.id;
      if (currentGroupId !== undefined) groups.add(currentGroupId);
      const issueWrite = /\/issues(?:\/|$)/.test(url.pathname);
      const mergeRequestWrite = /\/merge_requests(?:\/|$)/.test(url.pathname);
      this.readCache.invalidateWhere((key) => {
        const scoped = key.split('\0').at(-1) ?? key;
        if (scoped.startsWith(`project/${projectId}/`)) return true;
        if (issueWrite && [...groups].some((id) => scoped === `group/${id}/assigned-issues` || scoped.startsWith(`group/${id}/assigned-issues/`) || scoped.startsWith(`group/${id}/graph`))) return true;
        if (mergeRequestWrite && [...groups].some((id) => scoped === `group/${id}/merge-requests`)) return true;
        return false;
      });
      return;
    }
    this.readCache.invalidate();
  }

  async ensureInstanceChecked(options: { force?: boolean } = {}): Promise<void> {
    const epoch = this.connectionEpochValue;
    if (options.force) {
      this.instanceProbeRevision++;
      this.metadataRetryAt = 0;
      this.capabilitiesRetryAt = 0;
      this.currentMetadata = undefined;
      this.currentIssueCapabilities = undefined;
      this.capabilityProbeError = undefined;
      this.metadataCheck = undefined;
      this.capabilitiesCheck = undefined;
      this.currentInstanceWarnings = [];
    }
    await Promise.all([this.checkMetadata(epoch), this.checkCapabilities(epoch)]);
    if (epoch === this.connectionEpochValue) this.updateInstanceWarnings();
  }

  private checkMetadata(epoch: number): Promise<void> {
    if (this.currentMetadata) return Promise.resolve();
    if (this.metadataCheck) return this.metadataCheck;
    if (Date.now() < this.metadataRetryAt) return Promise.resolve();
    const task = (async () => {
      const revision = this.instanceProbeRevision;
      try {
        const client = await this.getClient();
        let metadata: GitLabMetadata;
        try {
          metadata = await client.getMetadata();
          if (!metadata.version) metadata = await client.getVersion();
        } catch { metadata = await client.getVersion(); }
        if (!metadata.version) throw new Error('GitLab returned no version metadata.');
        if (epoch !== this.connectionEpochValue || revision !== this.instanceProbeRevision) return;
        this.currentMetadata = metadata;
        this.metadataRetryAt = 0;
      } catch {
        if (epoch === this.connectionEpochValue && revision === this.instanceProbeRevision) this.metadataRetryAt = Date.now() + 60_000;
      }
    })();
    this.metadataCheck = task;
    return task.finally(() => { if (this.metadataCheck === task) this.metadataCheck = undefined; });
  }

  private checkCapabilities(epoch: number): Promise<void> {
    if (this.currentIssueCapabilities) return Promise.resolve();
    if (this.capabilitiesCheck) return this.capabilitiesCheck;
    if (Date.now() < this.capabilitiesRetryAt) return Promise.resolve();
    const task = (async () => {
      const revision = this.instanceProbeRevision;
      try {
        const capabilities = await (await this.getClient()).getIssueCapabilities();
        if (epoch !== this.connectionEpochValue || revision !== this.instanceProbeRevision) return;
        this.currentIssueCapabilities = capabilities;
        this.capabilityProbeError = undefined;
        this.capabilitiesRetryAt = 0;
      } catch (error) {
        if (epoch === this.connectionEpochValue && revision === this.instanceProbeRevision) {
          this.capabilityProbeError = error instanceof Error ? error.message : 'Schema 偵測失敗。';
          this.capabilitiesRetryAt = Date.now() + 60_000;
        }
      }
    })();
    this.capabilitiesCheck = task;
    return task.finally(() => { if (this.capabilitiesCheck === task) this.capabilitiesCheck = undefined; });
  }

  private updateInstanceWarnings(): void {
    const warnings: string[] = [];
    const metadata = this.currentMetadata;
    if (!metadata?.version) warnings.push('無法讀取 GitLab 版本資料，因此不能確認是否符合最低支援版本 16.11.10；已確認支援的功能仍可使用。');
    else {
      const version = metadata.version.match(/^(\d+)\.(\d+)\.(\d+)/);
      if (!version) warnings.push('GitLab 回傳的版本格式無法辨識，因此不能確認是否符合最低支援版本 16.11.10；已確認支援的功能仍可使用。');
      else {
        const actual = version.slice(1).map(Number);
        if (actual[0] < 16 || (actual[0] === 16 && actual[1] < 11) || (actual[0] === 16 && actual[1] === 11 && actual[2] < 10)) {
          warnings.push(`GitLab ${metadata.version} 低於最低支援版本 Community Edition 16.11.10；仍會依實際 API 能力載入功能。`);
        }
      }
    }
    this.currentInstanceWarnings = warnings;
  }

  async getClient(): Promise<GitLabClient> {
    if (this.connectionTransition) throw new Error('The GitLab connection is being changed. Retry this read shortly.');
    if (this.cachedClient) return this.cachedClient;
    if (this.clientCheck) return this.clientCheck;
    const baseUrl = this.baseUrl;
    const epoch = this.connectionEpochValue;
    if (!baseUrl) throw new Error('Connect to GitLab first.');
    const task = (async () => {
      const token = await this.secrets.get(TOKEN_SECRET_KEY);
      if (!token) throw new Error('Connect to GitLab first.');
      if (epoch !== this.connectionEpochValue || this.connectionTransition || baseUrl !== this.baseUrl) throw staleConnectionError();
      const client = new GitLabClient(baseUrl, token, undefined, this.connectionAbort.signal, (context) => this.invalidateAfterWrite(context));
      this.cachedClient = client;
      return client;
    })();
    this.clientCheck = task;
    return task.finally(() => { if (this.clientCheck === task) this.clientCheck = undefined; });
  }

  async getCloneCredentials(): Promise<{ baseUrl: string; token: string }> {
    const baseUrl = this.baseUrl;
    const token = await this.secrets.get(TOKEN_SECRET_KEY);
    if (!baseUrl || !token) throw new Error('Connect to GitLab first.');
    return { baseUrl, token };
  }

  async connect(baseUrl: string, token: string): Promise<GitLabUser> {
    const normalizedUrl = normalizeGitLabBaseUrl(baseUrl);
    const attempt = ++this.connectionAttempt;
    const probeClient = new GitLabClient(normalizedUrl, token);
    const user = await probeClient.getCurrentUser();
    if (attempt !== this.connectionAttempt) throw staleConnectionError();
    const serverChanged = this.baseUrl !== normalizedUrl;
    this.connectionTransition = true;
    this.connectionEpochValue++;
    this.connectionAbort.abort(staleConnectionError());
    this.connectionAbort = new AbortController();
    this.readCache.clear();
    this.cachedClient = undefined;
    this.clientCheck = undefined;
    this.currentMetadata = undefined;
    this.currentIssueCapabilities = undefined;
    this.capabilityProbeError = undefined;
    this.instanceProbeRevision++;
    this.currentInstanceWarnings = [];
    this.metadataCheck = undefined;
    this.capabilitiesCheck = undefined;
    this.metadataRetryAt = 0;
    this.capabilitiesRetryAt = 0;
    this.groupProjectIds.clear();
    try {
      await this.secrets.store(TOKEN_SECRET_KEY, token);
      if (attempt !== this.connectionAttempt) throw staleConnectionError();
      await this.state.update(BASE_URL_KEY, normalizedUrl);
      if (serverChanged) {
        await this.state.update(GROUP_ID_KEY, undefined);
        await this.state.update(GROUP_LABEL_KEY, undefined);
      }
      this.cachedClient = new GitLabClient(normalizedUrl, token, undefined, this.connectionAbort.signal, (context) => this.invalidateAfterWrite(context));
    } finally {
      if (attempt === this.connectionAttempt) this.connectionTransition = false;
    }
    await this.ensureInstanceChecked();
    return user;
  }

  async setSelectedGroup(group: GitLabGroup | undefined): Promise<void> {
    await this.state.update(GROUP_ID_KEY, group?.id);
    await this.state.update(GROUP_LABEL_KEY, group?.full_path);
  }

  async disconnect(): Promise<void> {
    this.connectionAttempt++;
    this.connectionTransition = true;
    this.connectionEpochValue++;
    this.connectionAbort.abort(staleConnectionError());
    this.connectionAbort = new AbortController();
    this.readCache.clear();
    this.cachedClient = undefined;
    this.clientCheck = undefined;
    this.currentMetadata = undefined;
    this.currentIssueCapabilities = undefined;
    this.currentInstanceWarnings = [];
    this.metadataCheck = undefined;
    this.capabilitiesCheck = undefined;
    this.metadataRetryAt = 0;
    this.capabilitiesRetryAt = 0;
    this.groupProjectIds.clear();
    await this.state.update(BASE_URL_KEY, undefined);
    await this.state.update(GROUP_ID_KEY, undefined);
    await this.state.update(GROUP_LABEL_KEY, undefined);
    await this.secrets.delete(TOKEN_SECRET_KEY);
    this.connectionTransition = false;
  }
}

function staleConnectionError(): Error {
  const error = new Error('The GitLab response belongs to an earlier connection.');
  error.name = 'AbortError';
  return error;
}
