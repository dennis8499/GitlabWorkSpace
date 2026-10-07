import type { Memento, SecretStorage } from 'vscode';
import { GitLabClient, type FetchLike, type GitLabIssueCapabilities, type GitLabWriteContext } from '../api/gitLabClient';
import { GitLabReadCache } from '../api/gitLabReadCache';
import type { GitLabGroup, GitLabMetadata, GitLabUser } from '../api/types';
import type { GitLabCapabilityDiagnostic } from '../api/graphqlCapabilities';
import { normalizeGitLabBaseUrl } from '../api/urlPolicy';
import { AccountStore, accountId, type GitLabAccount } from './accountStore';
import type { OperationLog } from '../logging/operationLog';

const TOKEN_SECRET_KEY = 'gitlabWorkspace.accessToken';
const BASE_URL_KEY = 'gitlabWorkspace.baseUrl';
const CURRENT_USER_ID_KEY = 'gitlabWorkspace.currentUserId';
const GROUP_ID_KEY = 'gitlabWorkspace.selectedGroupId';
const GROUP_LABEL_KEY = 'gitlabWorkspace.selectedGroupLabel';
const ISSUE_CAPABILITIES_CACHE_KEY = 'gitlabWorkspace.issueCapabilities.v1';
const ISSUE_CAPABILITIES_CACHE_TTL_MS = 60 * 60 * 1000;

interface CachedIssueCapabilities {
  scope: string;
  expiresAt: number;
  capabilities: GitLabIssueCapabilities;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function isCachedIssueCapabilities(value: unknown): value is CachedIssueCapabilities {
  if (!isRecord(value) || typeof value.scope !== 'string' || value.scope.length > 2048 || typeof value.expiresAt !== 'number' || !Number.isFinite(value.expiresAt) || !isRecord(value.capabilities)) return false;
  const capabilities = value.capabilities;
  const booleanFields = [
    'hierarchy', 'childMutations', 'graphWorkItems', 'graphHierarchy', 'graphLinkedItems', 'graphLabels',
    'graphAssignees', 'graphWorkItemTypes', 'discussionResolve', 'startDate', 'timelogReport',
    'timelogCreate', 'timelogCreateDated', 'timelogCreateSummary', 'timelogAdminPermission', 'timelogDelete', 'createPermission'
  ];
  if (!booleanFields.every((field) => typeof capabilities[field] === 'boolean')) return false;
  const optionalBooleanFields = ['workItemTypeList', 'timelogSummary'];
  if (!optionalBooleanFields.every((field) => capabilities[field] === undefined || typeof capabilities[field] === 'boolean')) return false;
  const stringLists = ['issuePermissionFields', 'workItemPermissionFields', 'workItemFields', 'workItemGraphFields', 'timelogUserFields'];
  const validLists = stringLists.every((field) => {
    const item = capabilities[field];
    return item === undefined || Array.isArray(item) && item.length <= 128 && item.every((entry) => typeof entry === 'string' && entry.length <= 256);
  });
  return validLists &&
    (capabilities.workItemScope === undefined || capabilities.workItemScope === 'namespace' || capabilities.workItemScope === 'project') &&
    (capabilities.workItemCreatePathField === undefined || capabilities.workItemCreatePathField === 'projectPath' || capabilities.workItemCreatePathField === 'namespacePath') &&
    (capabilities.issuePermissionSource === undefined || capabilities.issuePermissionSource === 'issue' || capabilities.issuePermissionSource === 'workItem') &&
    (capabilities.timelogSource === undefined || capabilities.timelogSource === 'workItem' || capabilities.timelogSource === 'issue');
}

export class GitLabSession {
  private readonly readCache = new GitLabReadCache(60_000, 256);
  private connectionEpochValue = 0;
  private connectionAttempt = 0;
  private connectionTransition = false;
  private cachedClient?: GitLabClient;
  private clientCheck?: Promise<GitLabClient>;
  private connectionAbort = new AbortController();
  private currentUserIdValue?: number;
  private currentMetadata?: GitLabMetadata;
  private currentIssueCapabilities?: GitLabIssueCapabilities;
  private currentInstanceWarnings: string[] = [];
  private instanceProbeRevision = 0;
  private capabilityProbeError?: string;
  private testFetcher?: FetchLike;
  private metadataCheck?: Promise<void>;
  private capabilitiesCheck?: Promise<void>;
  private metadataRetryAt = 0;
  private capabilitiesRetryAt = 0;
  private readonly groupProjectIds = new Map<number, Set<number>>();

  private readonly accountStore: AccountStore;
  private initialization?: Promise<void>;
  private beforeTransition?: () => Promise<void>;
  private transitionQueue: Promise<void> = Promise.resolve();
  private activeWrites = 0;

  constructor(private readonly secrets: SecretStorage, private readonly state: Memento, private readonly testMode = false,
    workspaceState: Memento = state, readonly log?: OperationLog) {
    this.accountStore = new AccountStore(state, secrets, workspaceState);
  }

  get accounts(): GitLabAccount[] { return this.accountStore.list(); }
  get activeAccountId(): string | undefined { return this.accountStore.activeId; }
  get hasActiveWrites(): boolean { return this.activeWrites > 0; }
  get isTransitioning(): boolean { return this.connectionTransition; }
  setBeforeTransition(handler: () => Promise<void>): void { this.beforeTransition = handler; }
  initialize(): Promise<void> {
    if (this.accountStore.ready) return Promise.resolve();
    if (this.initialization) return this.initialization;
    const task = this.accountStore.initialize((url, token) => this.makeClient(url, token).getCurrentUser());
    this.initialization = task;
    return task.finally(() => { if (this.initialization === task) this.initialization = undefined; });
  }
  async updateCurrentUser(user: GitLabUser): Promise<void> { await this.accountStore.updateUser(user); }
  private makeClient(url: string, token: string, connected = false): GitLabClient {
    this.log?.addSecret(token);
    const fetcher = this.testFetcher ?? fetch;
    const epoch = this.connectionEpochValue;
    return new GitLabClient(url, token, this.log?.wrapFetch(fetcher) ?? fetcher,
      connected ? this.connectionAbort.signal : undefined, connected ? context => this.invalidateAfterWrite(context) : undefined, undefined,
      connected ? async task => {
        if (epoch !== this.connectionEpochValue || this.connectionTransition) throw staleConnectionError();
        this.activeWrites++;
        try { return await task(); } finally { this.activeWrites--; }
      } : undefined);
  }

  private enqueueTransition<T>(task: () => Promise<T>): Promise<T> {
    const next = this.transitionQueue.then(async () => {
      if (this.activeWrites) throw new Error('GitLab 寫入尚未完成，請稍後再切換帳號或登出。');
      this.connectionTransition = true;
      try { return await task(); } finally { this.connectionTransition = false; }
    });
    this.transitionQueue = next.then(() => undefined, () => undefined);
    return next;
  }

  setFetchForTesting(fetcher: FetchLike): void {
    if (!this.testMode) throw new Error('Test request instrumentation is available only in the VS Code Extension Host test mode.');
    this.testFetcher = fetcher;
    this.cachedClient = undefined;
  }

  get baseUrl(): string | undefined {
    const active = this.accountStore.active;
    if (active) return active.needsLogin ? undefined : active.baseUrl;
    if (this.accountStore.ready) return undefined;
    const value = this.state.get<string>(BASE_URL_KEY);
    return value ? normalizeGitLabBaseUrl(value) : undefined;
  }

  get connectionEpoch(): number { return this.connectionEpochValue; }

  get selectedGroup(): GitLabGroup | undefined {
    const active = this.accountStore.active;
    if (active) return active.group ? { id: active.group.id, name: active.group.fullPath.split('/').at(-1) ?? active.group.fullPath, full_path: active.group.fullPath, web_url: '' } : undefined;
    if (this.accountStore.ready) return undefined;
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
    await Promise.all([this.checkMetadata(epoch), this.checkCapabilities(epoch, options.force)]);
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

  private checkCapabilities(epoch: number, force = false): Promise<void> {
    if (this.currentIssueCapabilities) return Promise.resolve();
    if (this.capabilitiesCheck) return this.capabilitiesCheck;
    if (Date.now() < this.capabilitiesRetryAt) return Promise.resolve();
    const task = (async () => {
      const revision = this.instanceProbeRevision;
      try {
        await this.checkMetadata(epoch);
        const client = await this.getClient();
        const cacheScope = this.capabilityCacheScope();
        if (!force && cacheScope) {
          const cached = this.state.get<unknown>(ISSUE_CAPABILITIES_CACHE_KEY);
          if (isCachedIssueCapabilities(cached) && cached.scope === cacheScope && cached.expiresAt > Date.now() && cached.expiresAt - Date.now() <= ISSUE_CAPABILITIES_CACHE_TTL_MS) {
            if (epoch !== this.connectionEpochValue || revision !== this.instanceProbeRevision) return;
            this.currentIssueCapabilities = cached.capabilities;
            this.capabilityProbeError = undefined;
            this.capabilitiesRetryAt = 0;
            return;
          }
        }
        const capabilities = await client.getIssueCapabilities();
        if (epoch !== this.connectionEpochValue || revision !== this.instanceProbeRevision) return;
        this.currentIssueCapabilities = capabilities;
        this.capabilityProbeError = undefined;
        this.capabilitiesRetryAt = 0;
        const currentCacheScope = this.capabilityCacheScope();
        if (currentCacheScope) {
          const snapshot: CachedIssueCapabilities = { scope: currentCacheScope, expiresAt: Date.now() + ISSUE_CAPABILITIES_CACHE_TTL_MS, capabilities };
          if (isCachedIssueCapabilities(snapshot)) {
            try { await this.state.update(ISSUE_CAPABILITIES_CACHE_KEY, snapshot); } catch { /* capability detection remains usable when persistence is unavailable */ }
          }
        }
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

  private capabilityCacheScope(): string | undefined {
    const baseUrl = this.baseUrl;
    const metadata = this.currentMetadata;
    const currentUserId = this.currentUserIdValue ?? this.accountStore.active?.userId ?? this.state.get<number>(CURRENT_USER_ID_KEY);
    if (!baseUrl || !metadata?.version || !Number.isSafeInteger(currentUserId) || (currentUserId ?? 0) <= 0) return undefined;
    return JSON.stringify([
      baseUrl,
      currentUserId,
      metadata.version,
      metadata.revision ?? null,
      metadata.enterprise ?? null
    ]);
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
    await this.initialize();
    if (this.connectionTransition) throw new Error('The GitLab connection is being changed. Retry this read shortly.');
    if (this.cachedClient) return this.cachedClient;
    if (this.clientCheck) return this.clientCheck;
    const baseUrl = this.baseUrl;
    const epoch = this.connectionEpochValue;
    if (!baseUrl) throw new Error('Connect to GitLab first.');
    const task = (async () => {
      const token = this.activeAccountId ? await this.accountStore.token(this.activeAccountId) : await this.secrets.get(TOKEN_SECRET_KEY);
      if (!token) throw new Error('Connect to GitLab first.');
      if (epoch !== this.connectionEpochValue || this.connectionTransition || baseUrl !== this.baseUrl) throw staleConnectionError();
      const client = this.makeClient(baseUrl, token, true);
      this.cachedClient = client;
      return client;
    })();
    this.clientCheck = task;
    return task.finally(() => { if (this.clientCheck === task) this.clientCheck = undefined; });
  }

  async getCloneCredentials(): Promise<{ baseUrl: string; token: string }> {
    await this.initialize();
    const baseUrl = this.baseUrl;
    const epoch = this.connectionEpochValue;
    const token = this.activeAccountId ? await this.accountStore.token(this.activeAccountId) : undefined;
    if (!baseUrl || !token) throw new Error('Connect to GitLab first.');
    if (epoch !== this.connectionEpochValue || this.connectionTransition) throw staleConnectionError();
    this.log?.addSecret(token);
    return { baseUrl, token };
  }

  async connect(baseUrl: string, token: string, expectedAccountId?: string): Promise<GitLabUser> {
    const attempt = ++this.connectionAttempt;
    await this.initialize();
    const normalizedUrl = normalizeGitLabBaseUrl(baseUrl);
    const probeClient = this.makeClient(normalizedUrl, token);
    const user = await probeClient.getCurrentUser();
    if (expectedAccountId && accountId(normalizedUrl, user.id) !== expectedAccountId) throw new Error('Token 身分與儲存帳號不同，請使用新增帳號登入。');
    if (attempt !== this.connectionAttempt) throw staleConnectionError();
    await this.activateAccount(normalizedUrl, token, user, attempt);
    return user;
  }

  async switchAccount(id: string): Promise<GitLabUser> {
    const attempt = ++this.connectionAttempt;
    await this.initialize();
    const account = this.accounts.find(item => item.id === id);
    if (!account) throw new Error('找不到此 GitLab 帳號。');
    const token = await this.accountStore.token(id);
    if (!token) throw new Error('此帳號已登出，請重新登入。');
    let user: GitLabUser;
    try { user = await this.makeClient(account.baseUrl, token).getCurrentUser(); }
    catch (error) {
      if (error && typeof error === 'object' && 'status' in error && error.status === 401) await this.accountStore.markNeedsLogin(id);
      throw error;
    }
    if (user.id !== account.userId) throw new Error('Token 身分與儲存帳號不同，請使用新增帳號登入。');
    if (attempt !== this.connectionAttempt) throw staleConnectionError();
    await this.activateAccount(account.baseUrl, token, user, attempt);
    return user;
  }

  private async activateAccount(normalizedUrl: string, token: string, user: GitLabUser, attempt: number): Promise<void> {
    await this.enqueueTransition(() => this.commitAccount(normalizedUrl, token, user, attempt));
    if (attempt !== this.connectionAttempt) throw staleConnectionError();
    await this.ensureInstanceChecked();
  }

  private async commitAccount(normalizedUrl: string, token: string, user: GitLabUser, attempt: number): Promise<void> {
    if (attempt !== this.connectionAttempt) throw staleConnectionError();
    await this.beforeTransition?.();
    if (attempt !== this.connectionAttempt) throw staleConnectionError();
    // Persist first so a failed credential/state write leaves the previous client usable.
    await this.accountStore.save(normalizedUrl, user, token);
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
    this.currentUserIdValue = user.id;
    this.cachedClient = this.makeClient(normalizedUrl, token, true);
  }

  async setSelectedGroup(group: GitLabGroup | undefined): Promise<void> {
    if (this.accountStore.ready || this.accountStore.active) { await this.accountStore.setGroup(group); return; }
    await this.state.update(GROUP_ID_KEY, group?.id);
    await this.state.update(GROUP_LABEL_KEY, group?.full_path);
  }

  async disconnect(): Promise<void> {
    this.connectionAttempt++;
    await this.initialize();
    const id = this.activeAccountId;
    if (id) return this.logoutAccount(id);
    await this.enqueueTransition(() => this.resetConnection());
  }

  async logoutAccount(id: string): Promise<void> {
    await this.initialize();
    if (this.activeAccountId === id) this.connectionAttempt++;
    await this.enqueueTransition(async () => {
      const active = this.activeAccountId === id;
      if (active) await this.beforeTransition?.();
      await this.accountStore.logout(id);
      if (active) await this.resetConnection();
    });
  }

  async removeAccount(id: string): Promise<void> {
    await this.initialize();
    if (!this.accounts.some(account => account.id === id)) throw new Error('找不到此 GitLab 帳號。');
    await this.enqueueTransition(async () => {
      const active = this.activeAccountId === id;
      if (active) { this.connectionAttempt++; await this.beforeTransition?.(); }
      await this.accountStore.logout(id, true);
      if (active) await this.resetConnection();
    });
  }

  private async resetConnection(): Promise<void> {
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
    this.currentUserIdValue = undefined;
    this.metadataCheck = undefined;
    this.capabilitiesCheck = undefined;
    this.metadataRetryAt = 0;
    this.capabilitiesRetryAt = 0;
    this.groupProjectIds.clear();
    this.connectionTransition = false;
  }
}

function staleConnectionError(): Error {
  const error = new Error('The GitLab response belongs to an earlier connection.');
  error.name = 'AbortError';
  return error;
}
