import { gitLabApiRoot, normalizeGitLabBaseUrl } from './urlPolicy';
import { GitLabReadGate } from './gitLabReadGate';
import { GitLabNetworkGate, parseRetryAfter } from './gitLabNetworkGate';
import { AsyncLocalStorage } from 'node:async_hooks';
import { GitLabRequestBudget, type GitLabRequestBudgetOptions } from './gitLabRequestBudget';
import { buildCapabilityQuery, buildFollowupTypeNames, buildInitialTypeNames, detectIssueCapabilities, mergeCapabilityTypes, parseCapabilityTypes, type GraphQLSchemaType } from './graphqlCapabilities';
import type {
  GitLabEmojiReaction, GitLabGroup, GitLabIssue, GitLabIssueDiscussion, GitLabIssueNote,
  GitLabIssueTemplate, GitLabLabel, GitLabMember, GitLabMergeRequestSummary, GitLabMetadata, GitLabMilestone,
  GitLabProject, GitLabTimeStats, GitLabTodo, GitLabUpload, GitLabUser, GitLabIssueBoard, GitLabPage,
  GitLabCommitSummary, GitLabCompareResult, GitLabGraphWorkItem, GitLabMergeRequest, GitLabMergeRequestDiff, GitLabMergeRequestDiffResult
} from './types';

export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
const writeRequestState = new AsyncLocalStorage<{ sent: boolean }>();

async function mapReads<T, R>(items: readonly T[], load: (item: T, index: number) => Promise<R>): Promise<R[]> {
  let next = 0, failed = false;
  const result = new Array<R>(items.length);
  await Promise.all(Array.from({ length: Math.min(4, items.length) }, async () => {
    while (!failed && next < items.length) {
      const index = next++;
      try { result[index] = await load(items[index], index); }
      catch (error) { failed = true; throw error; }
    }
  }));
  return result;
}

export interface GitLabWriteScope {
  projectId: number;
  issueIid?: number;
  resource: 'issues' | 'mergeRequests';
}

export interface GitLabWriteContext {
  url: string;
  method: string;
  /** Optional GraphQL mutation scope; REST writes retain their URL-based policy. */
  scope?: GitLabWriteScope;
  /** Quick actions in a comment can affect resources outside the URL's Project. */
  invalidateAll?: true;
}

export class GitLabApiError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = 'GitLabApiError';
  }
}

/** Transport interruption cannot establish whether GitLab applied a write. Never retry automatically. */
export class GitLabWriteUnknownError extends Error {
  readonly effect = 'unknown' as const;
  constructor(message = 'GitLab 寫入結果未能確認，請重新載入並核對後再決定是否重試。', options?: ErrorOptions) {
    super(message, options); this.name = 'GitLabWriteUnknownError';
  }
}

import type { IssueCreateInput, IssueUpdateInput, GitLabIssueCapabilities, GitLabWorkItemScope, GitLabMergeRequestCreateInput } from './requestTypes';
export type { IssueCreateInput, IssueUpdateInput, GitLabIssueCapabilities, GitLabWorkItemScope, GitLabMergeRequestCreateInput } from './requestTypes';

export class GitLabConflictError extends Error {
  constructor() {
    super('This issue changed in GitLab. Reload it before saving your edits.');
    this.name = 'GitLabConflictError';
  }
}

function isGraphqlComplexityError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /complexity.{0,120}(?:exceed|maximum|\blimit\b)|(?:exceed|maximum|\blimit\b).{0,120}complexity/i.test(message);
}

function mergeRequestDiffResult(values: unknown[], source: GitLabMergeRequestDiffResult['source'], warnings: string[] = [], overflow = false): GitLabMergeRequestDiffResult {
  const diffs = values.map((value) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new GitLabApiError('GitLab returned an invalid Merge Request diff entry.');
    const entry = value as Record<string, unknown>;
    const flags = ['new_file', 'renamed_file', 'deleted_file', 'generated_file', 'collapsed', 'too_large'];
    if (typeof entry.old_path !== 'string' || !entry.old_path || typeof entry.new_path !== 'string' || !entry.new_path
      || flags.some((flag) => entry[flag] !== undefined && typeof entry[flag] !== 'boolean')
      || typeof entry.diff !== 'string' && !((entry.diff === undefined || entry.diff === null) && (entry.collapsed === true || entry.too_large === true))) {
      throw new GitLabApiError('GitLab returned an invalid Merge Request diff entry.');
    }
    return { ...entry, diff: entry.diff ?? '' } as unknown as GitLabMergeRequestDiff;
  });
  if (overflow) warnings.push('GitLab 已限制差異回傳量，目前顯示的變更可能不完整；請在 GitLab 核對完整差異。');
  if (diffs.some((diff) => diff.collapsed)) warnings.push('部分檔案差異已由 GitLab 折疊，尚未取得完整內容；請在 GitLab 展開檢視。');
  if (diffs.some((diff) => diff.too_large)) warnings.push('部分檔案差異超過 GitLab 顯示上限，無法取得完整內容；請在 GitLab 核對。');
  return { diffs, source, warnings, truncated: overflow || diffs.some((diff) => diff.collapsed || diff.too_large) };
}

export class GitLabClient {
  readonly baseUrl: string;
  private readonly apiRoot: URL;

  constructor(
    baseUrl: string,
    private readonly token: string,
    private readonly fetcher: FetchLike = fetch,
    private readonly readSignal?: AbortSignal | readonly (AbortSignal | undefined)[],
    private readonly onSuccessfulWrite?: (context: GitLabWriteContext) => void,
    private readonly readGate = new GitLabReadGate(),
    private readonly runWrite?: <T>(task: () => Promise<T>) => Promise<T>,
    private readonly writeTimeoutMs = 30_000,
    private readonly networkGate = new GitLabNetworkGate(),
    private readonly requestBudgets: readonly GitLabRequestBudget[] = [],
    private readonly writeScope?: GitLabWriteScope
  ) {
    this.baseUrl = normalizeGitLabBaseUrl(baseUrl);
    this.apiRoot = gitLabApiRoot(this.baseUrl);
    if (!token.trim()) {
      throw new Error('A GitLab access token is required.');
    }
    if (!Number.isSafeInteger(writeTimeoutMs) || writeTimeoutMs < 1) throw new RangeError('Write timeout must be positive.');
  }

  withReadSignal(signal: AbortSignal): GitLabClient {
    const inherited = this.readSignal ? (Array.isArray(this.readSignal) ? [...this.readSignal] : [this.readSignal]) : [];
    return new GitLabClient(this.baseUrl, this.token, this.fetcher, [...inherited, signal], this.onSuccessfulWrite, this.readGate, this.runWrite, this.writeTimeoutMs, this.networkGate, this.requestBudgets, this.writeScope);
  }

  withRequestBudget(options: GitLabRequestBudgetOptions | GitLabRequestBudget = {}): GitLabClient {
    const budget = options instanceof GitLabRequestBudget ? options : new GitLabRequestBudget(options);
    const inherited = this.readSignal ? (Array.isArray(this.readSignal) ? [...this.readSignal] : [this.readSignal]) : [];
    return new GitLabClient(this.baseUrl, this.token, this.fetcher, [...inherited, budget.signal], this.onSuccessfulWrite, this.readGate, this.runWrite, this.writeTimeoutMs, this.networkGate, [...this.requestBudgets, budget], this.writeScope);
  }

  withWriteScope(scope: GitLabWriteScope): GitLabClient {
    if (!Number.isSafeInteger(scope.projectId) || scope.projectId <= 0 ||
      scope.issueIid !== undefined && (!Number.isSafeInteger(scope.issueIid) || scope.issueIid <= 0) ||
      !['issues', 'mergeRequests'].includes(scope.resource)) throw new RangeError('Invalid GitLab write scope.');
    return new GitLabClient(this.baseUrl, this.token, this.fetcher, this.readSignal, this.onSuccessfulWrite, this.readGate,
      this.runWrite, this.writeTimeoutMs, this.networkGate, this.requestBudgets, Object.freeze({ ...scope }));
  }

  async getCurrentUser(): Promise<GitLabUser> {
    return this.getJson<GitLabUser>('user');
  }

  getMetadata(): Promise<GitLabMetadata> {
    return this.getJson<GitLabMetadata>('metadata');
  }

  getVersion(): Promise<GitLabMetadata> {
    return this.getJson<GitLabMetadata>('version');
  }

  async getIssueCapabilities(): Promise<GitLabIssueCapabilities> {
    let returnedFullSchema = false;
    let complexityLimitObserved = false;
    const readTypes = async (names: readonly string[], requireAll = false): Promise<GraphQLSchemaType[]> => {
      if (!names.length) return [];
      const readBatch = async (batch: readonly string[]): Promise<GraphQLSchemaType[]> => {
        const response = await this.graphql<Record<string, unknown>>(
          buildCapabilityQuery(batch), {}
        );
        if ('__schema' in response) returnedFullSchema = true;
        if (!('__schema' in response) && batch.some((_name, index) => {
          const alias = `type${index}`;
          const value = response[alias];
          return !(alias in response) || (value !== null && (!value || typeof value !== 'object' || typeof (value as { name?: unknown }).name !== 'string')) || (requireAll && value === null);
        })) throw new GitLabApiError('GitLab returned an incomplete GraphQL capability response.');
        return parseCapabilityTypes(response);
      };
      const readInSmallBatches = async (): Promise<GraphQLSchemaType[]> => {
        const batches: string[][] = [];
        for (let offset = 0; offset < names.length; offset += 3) batches.push(names.slice(offset, offset + 3));
        return (await Promise.all(batches.map((batch) => readBatch(batch)))).flat();
      };

      if (complexityLimitObserved && names.length > 3) return readInSmallBatches();
      try {
        return await readBatch(names);
      } catch (error) {
        if (names.length <= 3 || !isGraphqlComplexityError(error)) throw error;
        complexityLimitObserved = true;

        // GitLab 16.11 enforces its complexity limit even for introspection. Keep
        // the common GitLab 19 path to one request: it returns its full cached
        // __schema for any __type query, so parallel probing would transfer and
        // parse that multi-megabyte response repeatedly.
        return readInSmallBatches();
      }
    };

    const base = await readTypes(buildInitialTypeNames());
    let schema = mergeCapabilityTypes(base);
    // Some GitLab deployments and intermediaries return a complete __schema for a
    // selective __type query. Reuse it in full instead of querying its types again.
    if (returnedFullSchema) {
      const rootsAreComplete = ['Query', 'Mutation', 'Issue'].every((name) => (schema.get(name)?.fields?.length ?? 0) > 0);
      if (!rootsAreComplete || !schema.has('Project')) {
        throw new GitLabApiError('GitLab returned an incomplete GraphQL schema introspection response.');
      }
      const missing = buildFollowupTypeNames(schema).filter((name) => !schema.has(name));
      if (missing.length) throw new GitLabApiError('GitLab returned an incomplete GraphQL schema introspection response.');
      return detectIssueCapabilities(schema);
    }
    for (let pass = 0; pass < 8; pass++) {
      const missing = buildFollowupTypeNames(schema).filter((name) => !schema.has(name));
      if (!missing.length) break;
      schema = mergeCapabilityTypes([...schema.values()], await readTypes(missing, true));
    }
    if (buildFollowupTypeNames(schema).some((name) => !schema.has(name))) throw new GitLabApiError('GitLab returned an incomplete GraphQL schema capability response.');
    return detectIssueCapabilities(schema);
  }

  async canCreateIssue(projectPath: string): Promise<boolean> {
    const data = await this.graphql<{ project?: { userPermissions?: { createIssue: boolean } } }>(
      'query CanCreateIssue($path: ID!) { project(fullPath: $path) { userPermissions { createIssue } } }',
      { path: projectPath }
    );
    return data.project?.userPermissions?.createIssue === true;
  }

  async getIssuePermissions(projectPath: string, issueIid: number, fields: string[]): Promise<Record<string, boolean>> {
    const requested = [...new Set(fields)].filter((field) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(field));
    if (!requested.length) return {};
    const selection = requested.join(' ');
    const data = await this.graphql<{ project?: { issue?: { userPermissions?: Record<string, boolean | null> | null } | null } | null }>(
      `query IssuePermissions($path: ID!, $iid: String!) { project(fullPath: $path) { issue(iid: $iid) { userPermissions { ${selection} } } } }`,
      { path: projectPath, iid: String(issueIid) }
    );
    const userPermissions = data.project?.issue?.userPermissions;
    if (!userPermissions) throw new GitLabApiError('GitLab did not return Issue user permissions.');
    return Object.fromEntries(requested.map((field) => [field, userPermissions[field] === true]));
  }

  async getWorkItemPermissions(projectPath: string, issueIid: number, fields: string[], scope: GitLabWorkItemScope): Promise<Record<string, boolean>> {
    const requested = [...new Set(fields)].filter((field) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(field));
    if (!requested.length) return {};
    const selection = requested.join(' ');
    const data = await this.graphql<{ namespace?: { workItem?: { userPermissions?: Record<string, boolean | null> | null } | null } | null; project?: { workItem?: { userPermissions?: Record<string, boolean | null> | null } | null } | null }>(
      `query WorkItemIssuePermissions($path: ID!, $iid: String!) { ${scope}(fullPath: $path) { workItem(iid: $iid) { userPermissions { ${selection} } } } }`,
      { path: projectPath, iid: String(issueIid) }
    );
    const userPermissions = (scope === 'namespace' ? data.namespace?.workItem : data.project?.workItem)?.userPermissions;
    if (!userPermissions) throw new GitLabApiError('GitLab did not return Work Item user permissions.');
    return Object.fromEntries(requested.map((field) => [field, userPermissions[field] === true]));
  }

  listGroups(): Promise<GitLabGroup[]> {
    return this.getPages<GitLabGroup>('groups?all_available=false&per_page=100');
  }

  listGroupsPage(cursor?: string): Promise<GitLabPage<GitLabGroup>> {
    return this.getPage<GitLabGroup>('groups?all_available=false&per_page=100', cursor);
  }

  listGroupProjectsPage(groupId: number, cursor?: string): Promise<GitLabPage<GitLabProject>> {
    return this.getPage<GitLabProject>(`groups/${encodeURIComponent(String(groupId))}/projects?include_subgroups=true&with_shared=false&per_page=100`, cursor);
  }

  listAssignedGroupIssuesPage(groupId: number, cursor?: string, state: 'opened' | 'all' = 'opened'): Promise<GitLabPage<GitLabIssue>> {
    return this.getPage<GitLabIssue>(`groups/${encodeURIComponent(String(groupId))}/issues?scope=assigned_to_me&state=${state}&per_page=100`, cursor);
  }

  listGroupIssueBoardsPage(groupId: number, cursor?: string): Promise<GitLabPage<GitLabIssueBoard>> {
    return this.getPage<GitLabIssueBoard>(`groups/${encodeURIComponent(String(groupId))}/boards?per_page=100`, cursor);
  }

  listGroupProjects(groupId: number): Promise<GitLabProject[]> {
    return this.getPages<GitLabProject>(
      `groups/${encodeURIComponent(String(groupId))}/projects?include_subgroups=true&with_shared=false&per_page=100`
    );
  }

  async listAssignedGroupIssues(groupId: number, projectIds?: ReadonlySet<number>): Promise<GitLabIssue[]> {
    const issues = await this.getPages<GitLabIssue>(
      `groups/${encodeURIComponent(String(groupId))}/issues?scope=assigned_to_me&state=all&per_page=100`
    );
    return projectIds ? issues.filter((issue) => projectIds.has(issue.project_id)) : issues;
  }

  listGroupIssueBoards(groupId: number): Promise<GitLabIssueBoard[]> {
    return this.getPages<GitLabIssueBoard>(`groups/${encodeURIComponent(String(groupId))}/boards?per_page=100`);
  }

  listGroupBoardIssueIds(groupPath: string, boardId: number): Promise<number[]> {
    return this.fetchGroupBoardIssueIds(groupPath, boardId);
  }

  listGroupBoardIssueMemberships(groupPath: string, boardId: number): Promise<Array<{ issueId: number; projectId?: number; iid?: number }>> {
    return this.fetchGroupBoardIssueMemberships(groupPath, boardId);
  }

  /** Exactly one GraphQL page. A failed request leaves the caller's checkpoint unchanged. */
  async listGroupBoardIssueMembershipsPage(groupPath: string, boardId: number,
    cursor?: import('./types').GitLabBoardMembershipCursor, username?: string): Promise<import('./types').GitLabBoardMembershipPage> {
    if (!groupPath || !Number.isSafeInteger(boardId) || boardId <= 0) throw new GitLabApiError('Invalid Issue Board scope.');
    if (cursor && (cursor.schema !== 'GitLabBoardMembershipCursor/v1' || cursor.groupPath !== groupPath || cursor.boardId !== boardId
      || cursor.username !== username || !['lists', 'issues'].includes(cursor.phase) || !Array.isArray(cursor.lists)
      || !Array.isArray(cursor.seenListCursors) || !Array.isArray(cursor.seenIssueCursors) || !Number.isSafeInteger(cursor.listIndex)
      || cursor.listIndex < 0 || cursor.listIndex > cursor.lists.length)) throw new GitLabApiError('Issue Board checkpoint belongs to a different or invalid scope.');
    const state: import('./types').GitLabBoardMembershipCursor = cursor ? structuredClone(cursor) : {
      schema: 'GitLabBoardMembershipCursor/v1', groupPath, boardId, username, phase: 'lists', lists: [], listAfter: null, listIndex: 0,
      issueAfter: null, seenListCursors: [], seenIssueCursors: [], hideBacklogList: false, hideClosedList: false
    };
    const skipHidden = (): void => {
      while (state.listIndex < state.lists.length) {
        const kind = state.lists[state.listIndex].listType.toLowerCase();
        if (!(state.hideBacklogList && kind === 'backlog') && !(state.hideClosedList && kind === 'closed')) break;
        state.listIndex++; state.issueAfter = null; state.seenIssueCursors = [];
      }
    };
    const finish = (items: import('./types').GitLabBoardIssueMembership[]): import('./types').GitLabBoardMembershipPage => {
      if (state.phase === 'issues') skipHidden();
      const complete = state.phase === 'issues' && state.listIndex >= state.lists.length;
      return { items, complete, ...(complete ? {} : { nextCursor: state }), updatedAt: new Date().toISOString() };
    };
    if (state.phase === 'lists') {
      type Page = { group?: { board?: { hideBacklogList: boolean; hideClosedList: boolean; lists?: {
        nodes?: Array<{ id: string; listType: string }>; pageInfo?: { hasNextPage?: boolean; endCursor?: string | null }
      } } } };
      const page = await this.graphql<Page>(
        'query AssignedGroupIssueBoardLists($groupPath: ID!, $boardId: BoardID!, $after: String) { group(fullPath: $groupPath) { board(id: $boardId) { hideBacklogList hideClosedList lists(first: 100, after: $after) { nodes { id listType } pageInfo { hasNextPage endCursor } } } } }',
        { groupPath, boardId: `gid://gitlab/Board/${boardId}`, after: state.listAfter });
      const board = page.group?.board;
      if (!board?.lists || !Array.isArray(board.lists.nodes)) throw new GitLabApiError('Issue Board lists could not be loaded.');
      state.hideBacklogList = board.hideBacklogList === true; state.hideClosedList = board.hideClosedList === true;
      const known = new Set(state.lists.map(list => list.id));
      for (const list of board.lists.nodes) {
        if (!/^gid:\/\/gitlab\/List\/\d+$/.test(list.id) || typeof list.listType !== 'string') throw new GitLabApiError('Invalid Issue Board list.');
        if (!known.has(list.id)) { state.lists.push(list); known.add(list.id); }
      }
      const info = board.lists.pageInfo;
      if (info?.hasNextPage) {
        if (!info.endCursor || state.seenListCursors.includes(info.endCursor)) throw new GitLabApiError('Repeated or incomplete Board list cursor.');
        state.seenListCursors.push(info.endCursor); state.listAfter = info.endCursor;
      } else { state.phase = 'issues'; state.listAfter = null; }
      return finish([]);
    }
    skipHidden();
    if (state.listIndex >= state.lists.length) return finish([]);
    const list = state.lists[state.listIndex];
    if (!/^gid:\/\/gitlab\/List\/\d+$/.test(list.id)) throw new GitLabApiError('Invalid Issue Board checkpoint list.');
    type Page = { boardList?: { issues?: { nodes?: Array<{ id: string; projectId?: number | string; iid?: number | string }>;
      pageInfo?: { hasNextPage?: boolean; endCursor?: string | null } } } };
    const variables: Record<string, unknown> = { listId: list.id, after: state.issueAfter };
    if (username !== undefined) variables.username = [username];
    const page = await this.graphql<Page>(
      `query ${username === undefined ? 'Group' : 'AssignedGroup'}IssueBoardListIssues($listId: ListID!${username === undefined ? '' : ', $username: [String!]'}, $after: String) { boardList(id: $listId) { issues(first: 100, after: $after${username === undefined ? '' : ', filters: { assigneeUsername: $username }'}) { nodes { id iid projectId } pageInfo { hasNextPage endCursor } } } }`, variables);
    const issues = page.boardList?.issues;
    if (!issues || !Array.isArray(issues.nodes)) throw new GitLabApiError('Issue Board membership page could not be loaded.');
    const items = new Map<number, import('./types').GitLabBoardIssueMembership>();
    for (const issue of issues.nodes) {
      const match = /^gid:\/\/gitlab\/Issue\/(\d+)$/.exec(issue.id), issueId = match ? Number(match[1]) : NaN;
      if (!Number.isSafeInteger(issueId) || issueId < 1) continue;
      const projectId = Number(issue.projectId), iid = Number(issue.iid);
      items.set(issueId, { issueId, ...(Number.isSafeInteger(projectId) && projectId > 0 ? { projectId } : {}), ...(Number.isSafeInteger(iid) && iid > 0 ? { iid } : {}) });
    }
    const info = issues.pageInfo;
    if (info?.hasNextPage) {
      if (!info.endCursor || state.seenIssueCursors.includes(info.endCursor)) throw new GitLabApiError('Repeated or incomplete Board membership cursor.');
      state.seenIssueCursors.push(info.endCursor); state.issueAfter = info.endCursor;
    } else { state.listIndex++; state.issueAfter = null; state.seenIssueCursors = []; }
    return finish([...items.values()]);
  }

  async listAssignedGroupBoardIssueIds(groupPath: string, boardId: number, username: string): Promise<number[]> {
    return (await this.fetchGroupBoardIssueMemberships(groupPath, boardId, username)).map((item) => item.issueId);
  }

  private async fetchGroupBoardIssueIds(groupPath: string, boardId: number, username?: string): Promise<number[]> {
    return (await this.fetchGroupBoardIssueMemberships(groupPath, boardId, username)).map((item) => item.issueId);
  }

  private async fetchGroupBoardIssueMemberships(groupPath: string, boardId: number, username?: string): Promise<Array<{ issueId: number; projectId?: number; iid?: number }>> {
    if (!groupPath.trim() || groupPath.length > 255 || (username !== undefined && !username.trim()) || !Number.isSafeInteger(boardId) || boardId <= 0) {
      throw new GitLabApiError('A valid Group, Issue Board, and username are required.');
    }

    type BoardListPage = {
      group?: {
        board?: {
          hideBacklogList: boolean;
          hideClosedList: boolean;
          lists?: {
            nodes?: Array<{ id: string; listType: string }>;
            pageInfo?: { hasNextPage?: boolean; endCursor?: string | null };
          };
        } | null;
      } | null;
    };
    type BoardIssuePage = {
      boardList?: {
        issues?: {
          nodes?: Array<{ id: string; iid?: string | number; projectId?: number | null }>;
          pageInfo?: { hasNextPage?: boolean; endCursor?: string | null };
        } | null;
      } | null;
    };

    const started = Date.now(); let requests = 0, bytes = 0;
    const readBoardPage = async <T>(query: string, variables: Record<string, unknown>): Promise<T> => {
      if (requests >= 100 || Date.now() - started >= 120_000) throw new GitLabApiError('Issue Board membership is incomplete: the request/time budget was reached. Narrow the Board or retry explicitly.');
      requests++;
      const value = await this.graphql<T>(query, variables);
      bytes += new TextEncoder().encode(JSON.stringify(value)).byteLength;
      if (bytes > 32 * 1024 * 1024) throw new GitLabApiError('Issue Board membership is incomplete: the response byte budget was reached.');
      return value;
    };

    const lists: Array<{ id: string; listType: string }> = [];
    const seenListCursors = new Set<string>();
    let after: string | null = null;
    let boardFound = false;
    let hideBacklogList = false;
    let hideClosedList = false;

    do {
      const page: BoardListPage = await readBoardPage<BoardListPage>(
        'query AssignedGroupIssueBoardLists($groupPath: ID!, $boardId: BoardID!, $after: String) { group(fullPath: $groupPath) { board(id: $boardId) { hideBacklogList hideClosedList lists(first: 100, after: $after) { nodes { id listType } pageInfo { hasNextPage endCursor } } } } }',
        { groupPath, boardId: `gid://gitlab/Board/${boardId}`, after }
      );
      const board = page.group?.board;
      if (!board?.lists) throw new GitLabApiError('GitLab Issue Board was not found or its lists could not be loaded.');
      boardFound = true;
      hideBacklogList = board.hideBacklogList;
      hideClosedList = board.hideClosedList;
      lists.push(...(board.lists.nodes ?? []));
      const pageInfo = board.lists.pageInfo;
      after = pageInfo?.hasNextPage ? pageInfo.endCursor ?? null : null;
      if (pageInfo?.hasNextPage && (!after || seenListCursors.has(after))) {
        throw new GitLabApiError('GitLab returned incomplete or repeated Issue Board pagination data.');
      }
      if (after) seenListCursors.add(after);
    } while (after);

    if (!boardFound) throw new GitLabApiError('GitLab Issue Board could not be loaded.');

    const listPages = await mapReads(lists, async list => {
      const issuesById = new Map<number, { issueId: number; projectId?: number; iid?: number }>();
      const listType = list.listType.toLocaleLowerCase();
      if ((hideBacklogList && listType === 'backlog') || (hideClosedList && listType === 'closed')) return [];
      if (!list.id) throw new GitLabApiError('GitLab returned an invalid Issue Board list.');

      const seenIssueCursors = new Set<string>();
      let issueAfter: string | null = null;
      do {
        const filter = username === undefined ? '' : ', filters: { assigneeUsername: $username }';
        const variables: Record<string, unknown> = { listId: list.id, after: issueAfter };
        if (username !== undefined) variables.username = [username];
        const page: BoardIssuePage = await readBoardPage<BoardIssuePage>(
          `query ${username === undefined ? 'Group' : 'AssignedGroup'}IssueBoardListIssues($listId: ListID!${username === undefined ? '' : ', $username: [String!]'}, $after: String) { boardList(id: $listId) { issues(first: 100, after: $after${filter}) { nodes { id iid projectId } pageInfo { hasNextPage endCursor } } } }`,
          variables
        );
        const issues = page.boardList?.issues;
        if (!issues) throw new GitLabApiError('GitLab could not load the selected Issue Board list.');
        for (const issue of issues.nodes ?? []) {
          const match = issue.id.match(/^gid:\/\/gitlab\/Issue\/(\d+)$/);
          const id = match ? Number(match[1]) : NaN;
          if (Number.isSafeInteger(id) && id > 0) {
            const projectId = Number(issue.projectId);
            const iid = Number(issue.iid);
            issuesById.set(id, {
              issueId: id,
              ...(Number.isSafeInteger(projectId) && projectId > 0 ? { projectId } : {}),
              ...(Number.isSafeInteger(iid) && iid > 0 ? { iid } : {})
            });
          }
        }
        const pageInfo = issues.pageInfo;
        issueAfter = pageInfo?.hasNextPage ? pageInfo.endCursor ?? null : null;
        if (pageInfo?.hasNextPage && (!issueAfter || seenIssueCursors.has(issueAfter))) {
          throw new GitLabApiError('GitLab returned incomplete or repeated Issue Board issue pagination data.');
        }
        if (issueAfter) seenIssueCursors.add(issueAfter);
      } while (issueAfter);
      return [...issuesById.values()];
    });
    const issuesById = new Map<number, { issueId: number; projectId?: number; iid?: number }>();
    for (const page of listPages) for (const issue of page) issuesById.set(issue.issueId, issue);
    return [...issuesById.values()];
  }

  listGroupMilestones(groupId: number): Promise<GitLabMilestone[]> {
    return this.getPages<GitLabMilestone>(
      `groups/${encodeURIComponent(String(groupId))}/milestones?include_descendants=true&per_page=100`
    );
  }

  listGroupMilestonesPage(groupId: number, cursor?: string): Promise<GitLabPage<GitLabMilestone>> {
    return this.getPage<GitLabMilestone>(`groups/${encodeURIComponent(String(groupId))}/milestones?include_descendants=true&per_page=100`, cursor);
  }

  async listGroupMergeRequestsPage(groupId: number, cursor?: string): Promise<GitLabPage<GitLabMergeRequest>> {
    const page = await this.getPage<GitLabMergeRequest>(`groups/${encodeURIComponent(String(groupId))}/merge_requests?scope=all&state=opened&per_page=100`, cursor);
    return { ...page, items: page.items.filter(request => request.state === 'opened' && Number.isSafeInteger(request.project_id) && Number.isSafeInteger(request.iid)) };
  }

  async listGroupMergeRequests(groupId: number): Promise<GitLabMergeRequest[]> {
    const requests = await this.getPages<GitLabMergeRequest>(
      `groups/${encodeURIComponent(String(groupId))}/merge_requests?scope=all&state=opened&per_page=100`
    );
    const byId = new Map<string, GitLabMergeRequest>();
    for (const request of requests) {
      if (request.state !== 'opened' || !Number.isSafeInteger(request.project_id) || !Number.isSafeInteger(request.iid)) continue;
      byId.set(`${request.project_id}:${request.iid}`, request);
    }
    return [...byId.values()];
  }

  findOpenMergeRequestsBySourceBranch(projectId: number, sourceBranch: string): Promise<GitLabMergeRequest[]> {
    if (!sourceBranch.trim() || sourceBranch.length > 255) throw new GitLabApiError('A valid source branch is required.');
    return this.getPages<GitLabMergeRequest>(
      `${this.projectPath(projectId)}/merge_requests?state=opened&source_branch=${encodeURIComponent(sourceBranch)}&per_page=100`
    );
  }

  getMergeRequest(projectId: number, iid: number): Promise<GitLabMergeRequest> {
    return this.getJson<GitLabMergeRequest>(`${this.projectPath(projectId)}/merge_requests/${iid}`);
  }

  async listMergeRequestDiffs(projectId: number, iid: number): Promise<GitLabMergeRequestDiffResult> {
    const requestPath = `${this.projectPath(projectId)}/merge_requests/${iid}`;
    const cancelled = (error: unknown): boolean => error instanceof Error && error.name === 'AbortError'
      || (Array.isArray(this.readSignal) ? this.readSignal : [this.readSignal]).some((signal) => signal?.aborted);
    try {
      return mergeRequestDiffResult(await this.getPages<unknown>(`${requestPath}/diffs?per_page=100`), 'diffs');
    } catch (primaryError) {
      if (cancelled(primaryError) || !(primaryError instanceof GitLabApiError)
        || ![404, 405, 500, 501, 502, 503, 504].includes(primaryError.status ?? 0)) throw primaryError;
      try {
        const result = await this.getJson<unknown>(`${requestPath}/changes`);
        if (!result || typeof result !== 'object' || Array.isArray(result)
          || !Array.isArray((result as Record<string, unknown>).changes)
          || 'overflow' in result && typeof result.overflow !== 'boolean') {
          throw new GitLabApiError('GitLab returned an invalid Merge Request changes response.');
        }
        const changes = result as { changes: unknown[]; overflow?: boolean };
        return mergeRequestDiffResult(changes.changes, 'changes', [
          `GitLab 差異 API 暫時無法使用（HTTP ${primaryError.status}），已改用相容差異 API。`
        ], changes.overflow);
      } catch (fallbackError) {
        if (cancelled(fallbackError)) throw fallbackError;
        const errorMessage = (error: unknown): string => error instanceof Error ? error.message : String(error);
        const error = new GitLabApiError(`MR 差異載入失敗：/diffs：${errorMessage(primaryError)}；/changes：${errorMessage(fallbackError)}`,
          fallbackError instanceof GitLabApiError ? fallbackError.status : undefined);
        error.cause = new AggregateError([primaryError, fallbackError]);
        throw error;
      }
    }
  }

  listMergeRequestDiscussions(projectId: number, iid: number): Promise<GitLabIssueDiscussion[]> {
    return this.getPages<GitLabIssueDiscussion>(`${this.projectPath(projectId)}/merge_requests/${iid}/discussions?per_page=100`);
  }

  createMergeRequestNote(projectId: number, iid: number, body: string): Promise<GitLabIssueNote> {
    return this.postJson<GitLabIssueNote>(`${this.projectPath(projectId)}/merge_requests/${iid}/notes`, { body });
  }

  replyToMergeRequestDiscussion(projectId: number, iid: number, discussionId: string, body: string): Promise<GitLabIssueNote> {
    return this.postJson<GitLabIssueNote>(`${this.projectPath(projectId)}/merge_requests/${iid}/discussions/${encodeURIComponent(discussionId)}/notes`, { body });
  }

  createMergeRequest(projectId: number, input: GitLabMergeRequestCreateInput): Promise<GitLabMergeRequest> {
    const payload: Record<string, string | number | number[]> = {
      title: input.title,
      source_branch: input.sourceBranch,
      target_branch: input.targetBranch
    };
    if (input.description?.trim()) payload.description = input.description;
    if (input.reviewerIds?.length) payload.reviewer_ids = input.reviewerIds;
    if (input.assigneeId !== undefined) payload.assignee_id = input.assigneeId;
    return this.postJson<GitLabMergeRequest>(`${this.projectPath(projectId)}/merge_requests`, payload);
  }

  async approveMergeRequest(projectId: number, iid: number, sha: string): Promise<void> {
    await this.postJson<unknown>(`${this.projectPath(projectId)}/merge_requests/${iid}/approve`, { sha });
  }

  mergeMergeRequest(projectId: number, iid: number, sha: string): Promise<GitLabMergeRequest> {
    return this.putJson<GitLabMergeRequest>(`${this.projectPath(projectId)}/merge_requests/${iid}/merge`, { sha });
  }

  getRepositoryBranch(projectId: number, branch: string): Promise<{ name: string; commit: GitLabCommitSummary }> {
    return this.getJson(`${this.projectPath(projectId)}/repository/branches/${encodeURIComponent(branch)}`);
  }

  compareRepository(projectId: number, from: string, to: string): Promise<GitLabCompareResult> {
    const query = new URLSearchParams({ from, to, straight: 'false' });
    return this.getJson(`${this.projectPath(projectId)}/repository/compare?${query.toString()}`);
  }

  listProjectMembers(projectId: number): Promise<GitLabMember[]> {
    return this.getPages<GitLabMember>(`projects/${encodeURIComponent(String(projectId))}/members/all?per_page=100`);
  }

  searchMemberProjects(query: string): Promise<GitLabProject[]> {
    return this.getPages<GitLabProject>(`projects?membership=true&simple=true&search=${encodeURIComponent(query)}&per_page=100`);
  }

  getProject(projectId: number): Promise<GitLabProject> {
    return this.getJson<GitLabProject>(this.projectPath(projectId));
  }

  getProjectByPath(fullPath: string): Promise<GitLabProject> {
    return this.getJson<GitLabProject>(`projects/${encodeURIComponent(fullPath)}`);
  }

  listProjectLabels(projectId: number): Promise<GitLabLabel[]> {
    return this.getPages<GitLabLabel>(`${this.projectPath(projectId)}/labels?per_page=100&include_ancestor_groups=true`);
  }

  listProjectMilestones(projectId: number): Promise<GitLabMilestone[]> {
    return this.getPages<GitLabMilestone>(`${this.projectPath(projectId)}/milestones?state=active&include_ancestors=true&per_page=100`);
  }

  async listProjectIssueTemplates(projectId: number): Promise<GitLabIssueTemplate[]> {
    const entries = await this.listProjectIssueTemplateNames(projectId);
    return mapReads(entries, async entry => ({ ...await this.getProjectIssueTemplate(projectId, entry.key), name: entry.name }));
  }

  listProjectIssueTemplateNames(projectId: number): Promise<Array<{ key: string; name: string }>> {
    return this.getPages<{ key: string; name: string }>(`${this.projectPath(projectId)}/templates/issues?per_page=100`);
  }

  async getProjectIssueTemplate(projectId: number, key: string): Promise<GitLabIssueTemplate> {
    const template = await this.getJson<{ content: string }>(`${this.projectPath(projectId)}/templates/issues/${encodeURIComponent(key)}`);
    return { name: key, content: template.content };
  }

  searchProjectIssues(projectId: number, query: string): Promise<GitLabIssue[]> {
    return this.getPages<GitLabIssue>(`${this.projectPath(projectId)}/issues?scope=all&state=all&search=${encodeURIComponent(query)}&per_page=20`);
  }

  getIssue(projectId: number, issueIid: number): Promise<GitLabIssue> {
    return this.getJson<GitLabIssue>(this.issuePath(projectId, issueIid));
  }

  createIssue(
    projectId: number,
    input: IssueCreateInput
  ): Promise<GitLabIssue> {
    const body: Record<string, string | number | boolean> = { title: input.title };
    if (input.description?.trim()) {
      body.description = input.description;
    }
    if (input.assigneeId !== undefined) {
      body.assignee_id = input.assigneeId;
    }
    if (input.labels?.length) body.labels = input.labels.join(',');
    if (input.milestoneId !== undefined) body.milestone_id = input.milestoneId;
    if (input.dueDate) body.due_date = input.dueDate;
    if (input.confidential !== undefined) body.confidential = input.confidential;
    return this.postJson<GitLabIssue>(`${this.projectPath(projectId)}/issues`, body);
  }

  updateIssue(projectId: number, issueIid: number, input: IssueUpdateInput): Promise<GitLabIssue> {
    const body: Record<string, string | number | boolean | null | number[]> = {};
    if (input.title !== undefined) body.title = input.title;
    if (input.description !== undefined) body.description = input.description;
    if (input.assigneeId !== undefined) body.assignee_ids = input.assigneeId === null ? [] : [input.assigneeId];
    if (input.labels !== undefined) body.labels = input.labels.join(',');
    if (input.milestoneId !== undefined) body.milestone_id = input.milestoneId ?? 0;
    if (input.dueDate !== undefined) body.due_date = input.dueDate ?? '';
    if (input.confidential !== undefined) body.confidential = input.confidential;
    if (input.discussionLocked !== undefined) body.discussion_locked = input.discussionLocked;
    if (input.stateEvent !== undefined) body.state_event = input.stateEvent;
    return this.putJson<GitLabIssue>(this.issuePath(projectId, issueIid), body);
  }

  async updateIssueIfUnchanged(projectId: number, issueIid: number, expectedUpdatedAt: string | undefined, input: IssueUpdateInput): Promise<GitLabIssue> {
    const current = await this.getIssue(projectId, issueIid);
    if (expectedUpdatedAt && current.updated_at !== expectedUpdatedAt) throw new GitLabConflictError();
    return this.updateIssue(projectId, issueIid, input);
  }

  listIssueDiscussions(projectId: number, issueIid: number): Promise<GitLabIssueDiscussion[]> {
    return this.getPages<GitLabIssueDiscussion>(`${this.issuePath(projectId, issueIid)}/discussions?per_page=100`);
  }

  async loadIssueGraphRelations(
    projectPath: string, issueIid: number,
    capabilities: Pick<GitLabIssueCapabilities, 'graphWorkItems' | 'graphHierarchy' | 'graphLinkedItems' | 'graphLabels' | 'graphAssignees' | 'graphWorkItemTypes'> & Partial<Pick<GitLabIssueCapabilities, 'workItemScope' | 'workItemGraphFields'>>
  ): Promise<import('./types').GitLabIssueGraphRelations> {
    const parents = new Map<string, GitLabGraphWorkItem>(), children = new Map<string, GitLabGraphWorkItem>();
    const links = new Map<string, { type: string; item: GitLabGraphWorkItem }>();
    const budget = new GitLabRequestBudget({ requests: 100, bytes: 32 * 1024 * 1024, timeoutMs: 120_000 });
    const bounded = this.withRequestBudget(budget);
    try {
    let cursor: import('./types').GitLabIssueGraphCursor | undefined;
    for (let index = 0; index < 100; index++) {
      const page = await bounded.loadIssueGraphRelationsPage(projectPath, issueIid, capabilities, cursor);
      for (const item of page.parents) parents.set(item.id, item);
      for (const item of page.children) children.set(item.id, item);
      for (const item of page.links) links.set(`${item.type}:${item.item.id}`, item);
      if (page.complete) return { root: page.root, parents: [...parents.values()], children: [...children.values()], links: [...links.values()] };
      cursor = page.nextCursor;
    }
    throw new GitLabApiError('GitLab returned too many Issue graph pages to load safely.');
    } finally { budget.dispose(); }
  }

  async loadIssueGraphRelationsPage(
    projectPath: string,
    issueIid: number,
    capabilities: Pick<GitLabIssueCapabilities, 'graphWorkItems' | 'graphHierarchy' | 'graphLinkedItems' | 'graphLabels' | 'graphAssignees' | 'graphWorkItemTypes'> & Partial<Pick<GitLabIssueCapabilities, 'workItemScope' | 'workItemGraphFields'>>,
    cursor?: import('./types').GitLabIssueGraphCursor
  ): Promise<import('./types').GitLabIssueGraphPage> {
    if (!projectPath.trim() || projectPath.length > 255 || !Number.isSafeInteger(issueIid) || issueIid <= 0) {
      throw new GitLabApiError('A valid project path and Issue IID are required.');
    }
    if (!capabilities.graphWorkItems) return { parents: [], children: [], links: [], complete: true, updatedAt: new Date().toISOString() };
    const capabilityKey = JSON.stringify([capabilities.graphHierarchy, capabilities.graphLinkedItems, capabilities.graphLabels,
      capabilities.graphAssignees, capabilities.graphWorkItemTypes, capabilities.workItemScope ?? 'namespace', capabilities.workItemGraphFields ?? null]);
    if (cursor && (cursor.schema !== 'GitLabIssueGraphCursor/v1' || cursor.projectPath !== projectPath || cursor.issueIid !== issueIid
      || cursor.capabilityKey !== capabilityKey || !Array.isArray(cursor.seenChildren) || !Array.isArray(cursor.seenLinks)
      || typeof cursor.childrenActive !== 'boolean' || typeof cursor.linksActive !== 'boolean'
      || cursor.childrenAfter !== null && typeof cursor.childrenAfter !== 'string' || cursor.linksAfter !== null && typeof cursor.linksAfter !== 'string')) {
      throw new GitLabApiError('Issue graph checkpoint belongs to a different or invalid scope.');
    }
    const state: import('./types').GitLabIssueGraphCursor = cursor ? structuredClone(cursor) : {
      schema: 'GitLabIssueGraphCursor/v1', projectPath, issueIid, capabilityKey, childrenAfter: null, linksAfter: null,
      childrenActive: capabilities.graphHierarchy, linksActive: capabilities.graphLinkedItems, seenChildren: [], seenLinks: []
    };

    const hierarchy = capabilities.graphHierarchy
      ? '... on WorkItemWidgetHierarchy { parent { ...IssueGraphItem } children(first: 100, after: $childrenAfter) @include(if: $includeChildren) { nodes { ...IssueGraphItem } pageInfo { hasNextPage endCursor } } }'
      : '';
    const linked = capabilities.graphLinkedItems
      ? '... on WorkItemWidgetLinkedItems { linkedItems(first: 100, after: $linksAfter) @include(if: $includeLinks) { nodes { linkType workItem { ...IssueGraphItem } } pageInfo { hasNextPage endCursor } } }'
      : '';
    const labels = capabilities.graphLabels
      ? '... on WorkItemWidgetLabels { labels(first: 100) { nodes { name: title color textColor } } }'
      : '';
    const assignees = capabilities.graphAssignees
      ? '... on WorkItemWidgetAssignees { assignees(first: 100) { nodes { id name username } } }'
      : '';
    const rootWidgets = [hierarchy, linked, labels, assignees].filter(Boolean).join(' ');
    const itemWidgets = [labels, assignees].filter(Boolean).join(' ');
    const rootWidgetsSelection = rootWidgets ? `widgets { ${rootWidgets} }` : '';
    const itemWidgetsSelection = itemWidgets ? `widgets { ${itemWidgets} }` : '';
    const paginationVariables = [
      capabilities.graphHierarchy ? '$childrenAfter: String, $includeChildren: Boolean!' : '',
      capabilities.graphLinkedItems ? '$linksAfter: String, $includeLinks: Boolean!' : ''
    ].filter(Boolean);
    const variableDefinitions = ['$path: ID!', '$iid: String!', ...paginationVariables].join(', ');
    const itemFields = new Set(capabilities.workItemGraphFields ?? ['title', 'state', 'webUrl', 'namespace', 'project', ...(capabilities.graphWorkItemTypes ? ['workItemType'] : [])]);
    const itemSelection = [
      'id', 'iid',
      itemFields.has('title') ? 'title' : itemFields.has('name') ? 'name' : '',
      ...['state', 'webUrl'].filter((field) => itemFields.has(field)),
      itemFields.has('namespace') ? 'namespace { fullPath }' : '',
      itemFields.has('project') ? 'project { id fullPath }' : '',
      capabilities.graphWorkItemTypes && itemFields.has('workItemType') ? 'workItemType { name }' : ''
    ].filter(Boolean).join(' ');
    const itemFragment = capabilities.graphHierarchy || capabilities.graphLinkedItems
      ? `fragment IssueGraphItem on WorkItem {
      ${itemSelection}
      ${itemWidgetsSelection}
    }`
      : '';
    const scope = capabilities.workItemScope ?? 'namespace';
    const query = `query IssueGraphRelations(${variableDefinitions}) {
      ${scope}(fullPath: $path) { workItem(iid: $iid) { ${itemSelection}
        ${rootWidgetsSelection}
      } }
    } ${itemFragment}`;
    const variables: Record<string, unknown> = { path: projectPath, iid: String(issueIid) };
    if (capabilities.graphHierarchy) { variables.childrenAfter = state.childrenAfter; variables.includeChildren = state.childrenActive; }
    if (capabilities.graphLinkedItems) { variables.linksAfter = state.linksAfter; variables.includeLinks = state.linksActive; }
    const data = await this.graphql<{ namespace?: { workItem?: GitLabGraphWorkItem | null } | null; project?: { workItem?: GitLabGraphWorkItem | null } | null }>(query, variables);
    const root = scope === 'namespace' ? data.namespace?.workItem : data.project?.workItem;
    if (!root) throw new GitLabApiError('GitLab could not find the Issue hierarchy item.');
    const parents = new Map<string, GitLabGraphWorkItem>(), children = new Map<string, GitLabGraphWorkItem>();
    const links = new Map<string, { type: string; item: GitLabGraphWorkItem }>();
    let childInfo: { hasNextPage?: boolean; endCursor?: string | null } | undefined;
    let linkInfo: { hasNextPage?: boolean; endCursor?: string | null } | undefined;
    for (const widget of root.widgets ?? []) {
      if (widget.parent?.id) parents.set(widget.parent.id, widget.parent);
      for (const item of widget.children?.nodes ?? []) if (item.id) children.set(item.id, item);
      for (const item of widget.linkedItems?.nodes ?? []) if (item.workItem?.id) links.set(`${item.linkType}:${item.workItem.id}`, { type: item.linkType, item: item.workItem });
      childInfo ??= widget.children?.pageInfo; linkInfo ??= widget.linkedItems?.pageInfo;
    }
    const advance = (active: boolean, info: typeof childInfo, seen: string[], label: string): string | null => {
      if (!active || !info?.hasNextPage) return null;
      if (!info.endCursor || seen.includes(info.endCursor)) throw new GitLabApiError(`GitLab returned an incomplete or repeated Issue graph ${label} cursor.`);
      seen.push(info.endCursor); return info.endCursor;
    };
    state.childrenAfter = advance(state.childrenActive, childInfo, state.seenChildren, 'child');
    state.linksAfter = advance(state.linksActive, linkInfo, state.seenLinks, 'linked-item');
    state.childrenActive = state.childrenAfter !== null; state.linksActive = state.linksAfter !== null;
    const complete = !state.childrenActive && !state.linksActive;
    return { root, parents: [...parents.values()], children: [...children.values()], links: [...links.values()], complete,
      ...(complete ? {} : { nextCursor: state }), updatedAt: new Date().toISOString() };
  }

  listIssueLinksPage(projectId: number, issueIid: number, cursor?: string): Promise<GitLabPage<GitLabIssue>> {
    return this.getPage<GitLabIssue>(`${this.issuePath(projectId, issueIid)}/links?per_page=100`, cursor);
  }

  listIssueLinks(projectId: number, issueIid: number): Promise<GitLabIssue[]> {
    return this.getPages<GitLabIssue>(`${this.issuePath(projectId, issueIid)}/links?per_page=100`);
  }

  listRelatedMergeRequests(projectId: number, issueIid: number): Promise<GitLabMergeRequestSummary[]> {
    return this.getPages<GitLabMergeRequestSummary>(`${this.issuePath(projectId, issueIid)}/related_merge_requests?per_page=100`);
  }

  listIssueReactions(projectId: number, issueIid: number): Promise<GitLabEmojiReaction[]> {
    return this.getPages<GitLabEmojiReaction>(`${this.issuePath(projectId, issueIid)}/award_emoji?per_page=100`);
  }

  addIssueReaction(projectId: number, issueIid: number, name: string): Promise<GitLabEmojiReaction> {
    return this.postJson<GitLabEmojiReaction>(`${this.issuePath(projectId, issueIid)}/award_emoji`, { name });
  }

  removeIssueReaction(projectId: number, issueIid: number, reactionId: number): Promise<void> {
    return this.deleteResource(`${this.issuePath(projectId, issueIid)}/award_emoji/${reactionId}`);
  }

  listIssueNoteReactions(projectId: number, issueIid: number, noteId: number): Promise<GitLabEmojiReaction[]> {
    return this.getPages<GitLabEmojiReaction>(`${this.issuePath(projectId, issueIid)}/notes/${noteId}/award_emoji?per_page=100`);
  }

  addIssueNoteReaction(projectId: number, issueIid: number, noteId: number, name: string): Promise<GitLabEmojiReaction> {
    return this.postJson<GitLabEmojiReaction>(`${this.issuePath(projectId, issueIid)}/notes/${noteId}/award_emoji`, { name });
  }

  removeIssueNoteReaction(projectId: number, issueIid: number, noteId: number, reactionId: number): Promise<void> {
    return this.deleteResource(`${this.issuePath(projectId, issueIid)}/notes/${noteId}/award_emoji/${reactionId}`);
  }

  addIssueNote(projectId: number, issueIid: number, body: string, internal = false): Promise<GitLabIssueNote> {
    return this.postJson<GitLabIssueNote>(`${this.issuePath(projectId, issueIid)}/notes`, { body, internal });
  }

  updateIssueNote(projectId: number, issueIid: number, discussionId: string, noteId: number, body: string): Promise<GitLabIssueNote> {
    return this.putJson<GitLabIssueNote>(`${this.issuePath(projectId, issueIid)}/discussions/${encodeURIComponent(discussionId)}/notes/${noteId}`, { body });
  }

  deleteIssueNote(projectId: number, issueIid: number, discussionId: string, noteId: number): Promise<void> {
    return this.deleteResource(`${this.issuePath(projectId, issueIid)}/discussions/${encodeURIComponent(discussionId)}/notes/${noteId}`);
  }

  createIssueThread(projectId: number, issueIid: number, body: string): Promise<GitLabIssueDiscussion> {
    return this.postJson<GitLabIssueDiscussion>(`${this.issuePath(projectId, issueIid)}/discussions`, { body });
  }

  replyToIssueThread(projectId: number, issueIid: number, discussionId: string, body: string): Promise<GitLabIssueNote> {
    return this.postJson<GitLabIssueNote>(`${this.issuePath(projectId, issueIid)}/discussions/${encodeURIComponent(discussionId)}/notes`, { body });
  }

  async resolveIssueThread(discussionId: string, resolved: boolean): Promise<void> {
    const data = await this.graphql<{ discussionToggleResolve?: { errors: string[] } }>(
      'mutation ResolveIssueDiscussion($id: DiscussionID!, $resolve: Boolean!) { discussionToggleResolve(input: { id: $id, resolve: $resolve }) { errors } }',
      { id: `gid://gitlab/Discussion/${discussionId}`, resolve: resolved }
    );
    this.checkMutation(data.discussionToggleResolve, 'GitLab could not update the discussion.');
  }

  async createChildTask(projectPath: string, parentId: string, taskTypeId: string, title: string, pathField: 'projectPath' | 'namespacePath' = 'namespacePath'): Promise<void> {
    const data = await this.graphql<{ workItemCreate?: { errors: string[] } }>(
      `mutation CreateChildTask($path: ID!, $parent: WorkItemID!, $type: WorkItemsTypeID!, $title: String!) { workItemCreate(input: { ${pathField}: $path, workItemTypeId: $type, title: $title, hierarchyWidget: { parentId: $parent } }) { errors } }`,
      { path: projectPath, parent: parentId, type: taskTypeId, title }
    );
    this.checkMutation(data.workItemCreate, 'GitLab could not create the child task.');
  }

  async getWorkItemId(projectPath: string, iid: number, scope: GitLabWorkItemScope = 'namespace'): Promise<string | undefined> {
    const data = await this.graphql<{ namespace?: { workItem?: { id: string } } | null; project?: { workItem?: { id: string } } | null }>(
      `query FindWorkItem($path: ID!, $iid: String!) { ${scope}(fullPath: $path) { workItem(iid: $iid) { id } } }`,
      { path: projectPath, iid: String(iid) }
    );
    return (scope === 'namespace' ? data.namespace?.workItem : data.project?.workItem)?.id;
  }

  async getWorkItemTypeAndParent(projectPath: string, iid: number, canReadHierarchy: boolean, canReadType: boolean, scope: GitLabWorkItemScope = 'namespace'): Promise<{ id: string; type?: string; parentId?: string } | undefined> {
    if (!canReadHierarchy || !canReadType) throw new GitLabApiError('This GitLab version cannot verify the selected child item.');
    const data = await this.graphql<{ namespace?: { workItem?: { id: string; workItemType?: { name: string } | null; widgets?: Array<{ parent?: { id: string } | null }> } } | null; project?: { workItem?: { id: string; workItemType?: { name: string } | null; widgets?: Array<{ parent?: { id: string } | null }> } } | null }>(
      `query VerifyIssueChildTask($path: ID!, $iid: String!) { ${scope}(fullPath: $path) { workItem(iid: $iid) { id workItemType { name } widgets { ... on WorkItemWidgetHierarchy { parent { id } } } } } }`,
      { path: projectPath, iid: String(iid) }
    );
    const item = (scope === 'namespace' ? data.namespace?.workItem : data.project?.workItem);
    return item ? { id: item.id, type: item.workItemType?.name, parentId: item.widgets?.find((widget) => widget.parent !== undefined)?.parent?.id } : undefined;
  }

  async setChildParent(taskId: string, parentId: string | null): Promise<void> {
    const data = await this.graphql<{ workItemUpdate?: { errors: string[] } }>(
      'mutation SetChildParent($id: WorkItemID!, $parent: WorkItemID) { workItemUpdate(input: { id: $id, hierarchyWidget: { parentId: $parent } }) { errors } }',
      { id: taskId, parent: parentId }
    );
    this.checkMutation(data.workItemUpdate, 'GitLab could not change the child task.');
  }

  async setChildState(taskId: string, stateEvent: 'close' | 'reopen'): Promise<void> {
    const data = await this.graphql<{ workItemUpdate?: { errors: string[] } }>(
      'mutation SetChildState($id: WorkItemID!, $event: WorkItemStateEvent!) { workItemUpdate(input: { id: $id, stateEvent: $event }) { errors } }',
      { id: taskId, event: stateEvent.toUpperCase() }
    );
    this.checkMutation(data.workItemUpdate, 'GitLab could not update the task state.');
  }

  async updateChildTask(taskId: string, title: string, description: string): Promise<void> {
    const data = await this.graphql<{ workItemUpdate?: { errors: string[] } }>(
      'mutation UpdateChildTask($id: WorkItemID!, $title: String!, $description: String!) { workItemUpdate(input: { id: $id, title: $title, descriptionWidget: { description: $description } }) { errors } }',
      { id: taskId, title, description }
    );
    this.checkMutation(data.workItemUpdate, 'GitLab could not update the child task.');
  }

  async setIssueStartDate(workItemId: string, startDate: string | null): Promise<void> {
    const data = await this.graphql<{ workItemUpdate?: { errors: string[] } }>(
      'mutation SetIssueStartDate($id: WorkItemID!, $startDate: Date) { workItemUpdate(input: { id: $id, startAndDueDateWidget: { startDate: $startDate } }) { errors } }',
      { id: workItemId, startDate }
    );
    this.checkMutation(data.workItemUpdate, 'GitLab could not update the start date.');
  }

  async getIssueStartDate(projectPath: string, iid: number, scope: GitLabWorkItemScope = 'namespace'): Promise<string | null> {
    return (await this.getIssueStartDateDetails(projectPath, iid, scope)).startDate;
  }

  async getIssueStartDateDetails(projectPath: string, iid: number, scope: GitLabWorkItemScope = 'namespace'): Promise<{ supported: boolean; startDate: string | null }> {
    const data = await this.graphql<{ namespace?: { workItem?: { widgets?: Array<{ startDate?: string | null }> } } | null; project?: { workItem?: { widgets?: Array<{ startDate?: string | null }> } } | null }>(
      `query IssueStartDate($path: ID!, $iid: String!) { ${scope}(fullPath: $path) { workItem(iid: $iid) { widgets { ... on WorkItemWidgetStartAndDueDate { startDate } } } } }`,
      { path: projectPath, iid: String(iid) }
    );
    const item = (scope === 'namespace' ? data.namespace?.workItem : data.project?.workItem);
    const dateWidget = item?.widgets?.find((widget) => widget.startDate !== undefined);
    return { supported: !!dateWidget, startDate: dateWidget?.startDate ?? null };
  }

  async listIssueTimelogs(projectPath: string, iid: number, scope: GitLabWorkItemScope = 'namespace', includeAdminPermission = true, source: 'workItem' | 'issue' = 'workItem', includeSummary = true, userFields: string[] = ['id', 'name', 'username']): Promise<Array<{ id: string; timeSpent: number; spentAt: string; summary?: string | null; user: { id: string | number; name: string; username?: string }; userPermissions?: { adminTimelog: boolean } }>> {
    type Timelog = { id: string; timeSpent: number; spentAt: string; summary?: string | null; user: { id: string | number; name: string; username?: string }; userPermissions?: { adminTimelog: boolean } };
    type Connection = { nodes?: Timelog[]; pageInfo?: { hasNextPage: boolean; endCursor?: string | null } };
    type IssueTimePage = TimePage & { project?: TimePage['project'] & { issue?: { timelogs?: Connection } | null } };
    type TimePage = { namespace?: { workItem?: { widgets?: Array<{ timelogs?: { nodes?: Timelog[]; pageInfo?: { hasNextPage: boolean; endCursor?: string | null } } }> } } | null; project?: { workItem?: { widgets?: Array<{ timelogs?: { nodes?: Timelog[]; pageInfo?: { hasNextPage: boolean; endCursor?: string | null } } }> } } | null };
    const permissionSelection = includeAdminPermission ? 'userPermissions { adminTimelog }' : '';
    const summarySelection = includeSummary ? 'summary' : '';
    const userSelection = [...new Set(userFields)].filter((field) => ['id', 'name', 'username'].includes(field)).join(' ');
    if (!userSelection.includes('name') || !userSelection.includes('id')) throw new GitLabApiError('GitLab did not expose the time entry user fields required for a report.');
    const query = source === 'issue'
      ? `query IssueTimelogs($path: ID!, $iid: String!, $after: String) { project(fullPath: $path) { issue(iid: $iid) { timelogs(first: 100, after: $after) { nodes { id timeSpent spentAt ${summarySelection} user { ${userSelection} } ${permissionSelection} } pageInfo { hasNextPage endCursor } } } } }`
      : `query IssueTimelogs($path: ID!, $iid: String!, $after: String) { ${scope}(fullPath: $path) { workItem(iid: $iid) { widgets { ... on WorkItemWidgetTimeTracking { timelogs(first: 100, after: $after) { nodes { id timeSpent spentAt ${summarySelection} user { ${userSelection} } ${permissionSelection} } pageInfo { hasNextPage endCursor } } } } } } }`;
    const entries: Timelog[] = [];
    const seen = new Set<string>();
    let after: string | null = null;
    for (let page = 0; page < 100; page++) {
      const data: IssueTimePage = await this.graphql<IssueTimePage>(query, { path: projectPath, iid: String(iid), after });
      const item = scope === 'namespace' ? data.namespace?.workItem : data.project?.workItem;
      const connection = source === 'issue' ? data.project?.issue?.timelogs : item?.widgets?.find((widget) => widget.timelogs)?.timelogs;
      entries.push(...(connection?.nodes ?? []));
      if (!connection?.pageInfo?.hasNextPage) return entries;
      const cursor: string | null | undefined = connection.pageInfo.endCursor;
      if (!cursor || seen.has(cursor)) throw new GitLabApiError('GitLab returned a repeated time entry cursor.');
      seen.add(cursor);
      after = cursor;
    }
    throw new GitLabApiError('GitLab returned too many time entry pages to load safely.');
  }

  async createIssueTimelog(issueId: number, duration: string, summary?: string, spentAt?: string, supportsSpentAt = true, supportsSummary = true): Promise<void> {
    if (spentAt && !supportsSpentAt) throw new GitLabApiError('This GitLab schema does not support dated time entries.');
    if (summary?.trim() && !supportsSummary) throw new GitLabApiError('This GitLab schema does not support time entry summaries.');
    const data = await this.graphql<{ timelogCreate?: { errors: string[] } }>(
      'mutation AddIssueTimelog($input: TimelogCreateInput!) { timelogCreate(input: $input) { errors } }',
      { input: { issuableId: `gid://gitlab/Issue/${issueId}`, timeSpent: duration, ...(supportsSummary ? { summary: summary ?? '' } : {}), ...(spentAt && supportsSpentAt ? { spentAt } : {}) } }
    );
    this.checkMutation(data.timelogCreate, 'GitLab could not log time.');
  }

  async deleteIssueTimelog(timelogId: string): Promise<void> {
    const data = await this.graphql<{ timelogDelete?: { errors: string[] } }>(
      'mutation DeleteIssueTimelog($id: TimelogID!) { timelogDelete(input: { id: $id }) { errors } }',
      { id: timelogId }
    );
    this.checkMutation(data.timelogDelete, 'GitLab could not delete the time entry.');
  }

  private checkMutation(result: { errors: string[] } | undefined, fallback: string): void {
    if (!result || result.errors.length) throw new GitLabApiError(result?.errors.join('; ') || fallback);
  }

  addIssueLink(projectId: number, issueIid: number, targetProjectId: number, targetIssueIid: number, linkType: 'relates_to' | 'blocks' | 'is_blocked_by'): Promise<unknown> {
    return this.postJson<unknown>(`${this.issuePath(projectId, issueIid)}/links`, {
      target_project_id: targetProjectId, target_issue_iid: targetIssueIid, link_type: linkType
    });
  }

  removeIssueLink(projectId: number, issueIid: number, linkId: number): Promise<void> {
    return this.deleteResource(`${this.issuePath(projectId, issueIid)}/links/${linkId}`);
  }

  setTimeEstimate(projectId: number, issueIid: number, duration: string): Promise<GitLabTimeStats> {
    return this.postJson<GitLabTimeStats>(`${this.issuePath(projectId, issueIid)}/time_estimate`, { duration });
  }

  addSpentTime(projectId: number, issueIid: number, duration: string, summary?: string): Promise<GitLabTimeStats> {
    return this.postJson<GitLabTimeStats>(`${this.issuePath(projectId, issueIid)}/add_spent_time`, { duration, ...(summary ? { summary } : {}) });
  }

  resetTimeEstimate(projectId: number, issueIid: number): Promise<GitLabTimeStats> {
    return this.postJson<GitLabTimeStats>(`${this.issuePath(projectId, issueIid)}/reset_time_estimate`, {});
  }

  resetSpentTime(projectId: number, issueIid: number): Promise<GitLabTimeStats> {
    return this.postJson<GitLabTimeStats>(`${this.issuePath(projectId, issueIid)}/reset_spent_time`, {});
  }

  subscribeToIssue(projectId: number, issueIid: number): Promise<void> {
    return this.postNoContent(`${this.issuePath(projectId, issueIid)}/subscribe`);
  }

  unsubscribeFromIssue(projectId: number, issueIid: number): Promise<void> {
    return this.postNoContent(`${this.issuePath(projectId, issueIid)}/unsubscribe`);
  }

  createIssueTodo(projectId: number, issueIid: number): Promise<GitLabTodo> {
    return this.postJson<GitLabTodo>(`${this.issuePath(projectId, issueIid)}/todo`, {});
  }

  listTodos(): Promise<GitLabTodo[]> {
    return this.getPages<GitLabTodo>('todos?state=pending&type=Issue&per_page=100');
  }

  markTodoDone(todoId: number): Promise<void> {
    return this.postNoContent(`todos/${todoId}/mark_as_done`);
  }

  moveIssue(projectId: number, issueIid: number, toProjectId: number): Promise<GitLabIssue> {
    return this.postJson<GitLabIssue>(`${this.issuePath(projectId, issueIid)}/move`, { to_project_id: toProjectId });
  }

  cloneIssue(projectId: number, issueIid: number, toProjectId: number, withNotes = false): Promise<GitLabIssue> {
    return this.postJson<GitLabIssue>(`${this.issuePath(projectId, issueIid)}/clone`, { to_project_id: toProjectId, with_notes: withNotes });
  }

  deleteIssue(projectId: number, issueIid: number): Promise<void> {
    return this.deleteResource(this.issuePath(projectId, issueIid));
  }

  renderMarkdown(projectPath: string, markdown: string): Promise<{ html: string }> {
    return this.withReadRequest(async signal => {
      const response = await this.send(new URL('markdown', this.apiRoot), { method: 'POST', signal, redirect: 'manual',
        headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'PRIVATE-TOKEN': this.token },
        body: JSON.stringify({ text: markdown, gfm: true, project: projectPath }) });
      return this.readJson<{ html: string }>(response);
    });
  }

  async uploadProjectFile(projectId: number, filename: string, bytes: Uint8Array, contentType: string): Promise<GitLabUpload> {
    const form = new FormData();
    form.append('file', new Blob([Uint8Array.from(bytes)], { type: contentType }), filename);
    return this.getJson<GitLabUpload>(`${this.projectPath(projectId)}/uploads`, { method: 'POST', body: form });
  }

  async uploadProjectFileStream(projectId: number, filename: string, stream: AsyncIterable<Uint8Array>, contentType: string,
    size: number, signal?: AbortSignal): Promise<GitLabUpload> {
    if (!Number.isSafeInteger(size) || size < 0 || size > 50 * 1024 * 1024) throw new GitLabApiError('The attachment is too large to upload.');
    if (/[\r\n\0]/.test(contentType)) throw new GitLabApiError('Invalid attachment content type.');
    const boundary = 'gitlab-workspace-' + crypto.randomUUID();
    const safeName = filename.replace(/["\r\n\0\\]/g, '_');
    const prefix = new TextEncoder().encode(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${safeName}"\r\nContent-Type: ${contentType}\r\n\r\n`);
    const suffix = new TextEncoder().encode(`\r\n--${boundary}--\r\n`);
    return this.withWriteRequest(async writeSignal => {
      const source = stream[Symbol.asyncIterator]();
      let sourceClosed = false;
      const closeSource = async (): Promise<void> => {
        if (sourceClosed) return;
        sourceClosed = true; await source.return?.();
      };
      const onAbort = (): void => { void closeSource().catch(() => undefined); };
      writeSignal.addEventListener('abort', onAbort, { once: true });
      async function* multipart(): AsyncGenerator<Uint8Array> {
        try {
          yield prefix;
          let sent = 0;
          for (;;) {
            writeSignal.throwIfAborted();
            const next = await source.next(); if (next.done) break;
            sent += next.value.byteLength;
            if (sent > size) throw new GitLabApiError('Attachment size changed during upload.');
            yield next.value;
          }
          if (sent !== size) throw new GitLabApiError('Attachment size changed during upload.');
          yield suffix;
        } finally { await closeSource(); }
      }
      const iterator = multipart();
      const requestBody = new ReadableStream<Uint8Array>({
        async pull(controller) { try { const next = await iterator.next(); if (next.done) controller.close(); else controller.enqueue(next.value); } catch (error) { controller.error(error); } },
        async cancel() { await iterator.return(undefined); }
      });
      const url = new URL(`${this.projectPath(projectId)}/uploads`, this.apiRoot);
      try {
        const response = await this.send(url, { method: 'POST', headers: { Accept: 'application/json', 'PRIVATE-TOKEN': this.token,
          'Content-Type': `multipart/form-data; boundary=${boundary}`, 'Content-Length': String(prefix.length + size + suffix.length) },
          body: requestBody, signal: writeSignal, redirect: 'manual', duplex: 'half' } as RequestInit);
        const value = await this.readJson<GitLabUpload>(response);
        this.onSuccessfulWrite?.({ url: url.toString(), method: 'POST' }); return value;
      } finally { writeSignal.removeEventListener('abort', onAbort); await closeSource(); }
    }, signal, Math.max(this.writeTimeoutMs, 300_000));
  }

  async downloadUpload(rawUrl: string, maxBytes = 50 * 1024 * 1024): Promise<{ bytes: Uint8Array; contentType: string }> {
    const url = new URL(rawUrl, this.baseUrl);
    const base = new URL(this.baseUrl);
    const basePath = base.pathname.replace(/\/$/, '');
    const insideBase = !basePath || url.pathname === basePath || url.pathname.startsWith(`${basePath}/`);
    if (url.origin !== base.origin || url.username || url.password || !insideBase || !url.pathname.includes('/uploads/')) {
      throw new GitLabApiError('The attachment URL is outside this GitLab server.');
    }
    return this.withReadRequest(async (signal) => {
      const response = await this.send(url, { method: 'GET', headers: { 'PRIVATE-TOKEN': this.token }, signal, redirect: 'manual' }, true, maxBytes);
      if (response.status >= 300 && response.status < 400) throw new GitLabApiError('GitLab redirected the attachment request.', response.status);
      if (!response.ok) throw new GitLabApiError(`GitLab attachment request failed (HTTP ${response.status}).`, response.status);
      if (Number(response.headers.get('content-length') ?? 0) > maxBytes) {
        await response.body?.cancel(); throw new GitLabApiError('The attachment is too large to open in VS Code.');
      }
      const chunks: Uint8Array[] = [];
      let length = 0;
      const reader = response.body?.getReader();
      if (reader) {
        try {
          for (;;) {
            signal.throwIfAborted();
            const next = await reader.read(); if (next.done) break;
            length += next.value.byteLength;
            if (length > maxBytes) { await reader.cancel(); throw new GitLabApiError('The attachment is too large to open in VS Code.'); }
            chunks.push(next.value);
          }
        } finally { reader.releaseLock(); }
      }
      const bytes = new Uint8Array(length);
      let offset = 0; for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
      return { bytes, contentType: response.headers.get('content-type')?.split(';')[0] ?? 'application/octet-stream' };
    });
  }

  async graphql<T>(query: string, variables: Record<string, unknown>): Promise<T> {
    const url = new URL('../graphql', this.apiRoot);
    if (url.origin !== this.apiRoot.origin || !url.pathname.startsWith(this.apiRoot.pathname.slice(0, -3))) {
      throw new GitLabApiError('The GraphQL request is outside the configured GitLab server.');
    }
    const readOnly = /^\s*(?:query(?:\s|\(|\{)|\{)/i.test(query);
    const request = async (signal?: AbortSignal) => {
      const response = await this.send(url, {
        method: 'POST',
        headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'PRIVATE-TOKEN': this.token },
        body: JSON.stringify({ query, variables }),
        ...(signal ? { signal } : {}),
        redirect: 'manual'
      }, readOnly);
      const result = await this.readJson<{ data?: T; errors?: Array<{ message?: string }> }>(response);
      if (!result || typeof result !== 'object' || Array.isArray(result)) {
        throw new GitLabApiError('GitLab returned an invalid GraphQL response.', response.status);
      }
      return { response, result };
    };
    const notifyWrite = (): void => this.onSuccessfulWrite?.({ url: url.toString(), method: 'POST', ...(this.writeScope ? { scope: this.writeScope } : {}) });
    let completed: Awaited<ReturnType<typeof request>>;
    try {
      completed = readOnly ? await this.withReadRequest((signal) => request(signal)) : await this.withWriteRequest(request);
    } catch (error) {
      // An interrupted/malformed response can follow an applied mutation. Expire
      // affected reads once without changing the unknown outcome or retrying it.
      if (!readOnly && error instanceof GitLabWriteUnknownError) notifyWrite();
      throw error;
    }
    const { response, result } = completed;
    // GraphQL execution may partially apply a mutation before returning errors,
    // including data:null. Only request errors with no data establish no execution.
    if (!readOnly && (result.data !== undefined || !result.errors?.length)) notifyWrite();
    if (result.errors?.length || !result.data) throw new GitLabApiError(result.errors?.[0]?.message ?? 'GitLab GraphQL request failed.', response.status);
    return result.data;
  }

  private projectPath(projectId: number): string {
    return `projects/${encodeURIComponent(String(projectId))}`;
  }

  private issuePath(projectId: number, issueIid: number): string {
    return `${this.projectPath(projectId)}/issues/${encodeURIComponent(String(issueIid))}`;
  }

  private postJson<T>(path: string, body: Record<string, unknown>): Promise<T> {
    return this.getJson<T>(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  }

  private putJson<T>(path: string, body: Record<string, unknown>): Promise<T> {
    return this.getJson<T>(path, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  }

  private async postNoContent(path: string): Promise<void> {
    await this.noContent(path, { method: 'POST' });
  }

  private async deleteResource(path: string): Promise<void> {
    await this.noContent(path, { method: 'DELETE' });
  }

  private async noContent(path: string, init: RequestInit): Promise<void> {
    return this.withWriteRequest(signal => this.sendNoContent(path, { ...init, signal }));
  }

  private async sendNoContent(path: string, init: RequestInit): Promise<void> {
    const url = new URL(path.replace(/^\/+/, ''), this.apiRoot);
    if (!this.isSafeApiUrl(url)) throw new GitLabApiError('The request is outside the configured GitLab API.');
    const response = await this.send(url, {
      ...init, headers: { Accept: 'application/json', 'PRIVATE-TOKEN': this.token }, redirect: 'manual'
    });
    if (response.status >= 300 && response.status < 400 && response.status !== 304) throw new GitLabApiError('GitLab redirected the API request.', response.status);
    if (!response.ok && response.status !== 304) throw new GitLabApiError(`GitLab API request failed (HTTP ${response.status}).`, response.status);
    if (response.ok) this.onSuccessfulWrite?.({ url: url.toString(), method: (init.method ?? 'GET').toUpperCase() });
  }

  private async getJson<T>(path: string, init: RequestInit = {}): Promise<T> {
    const url = new URL(path.replace(/^\/+/, ''), this.apiRoot);
    return this.fetchJson<T>(url, init);
  }

  /** One bounded page; the continuation remains scoped to the original endpoint and filters. */
  private async getPage<T>(path: string, cursor?: string): Promise<import('./types').GitLabPage<T>> {
    const initial = new URL(path.replace(/^\/+/, ''), this.apiRoot);
    const current = cursor ? new URL(cursor) : initial;
    if (!this.isSafeApiUrl(current) || current.pathname !== initial.pathname) throw new GitLabApiError('GitLab page cursor is outside the requested resource.');
    for (const [key, value] of initial.searchParams) {
      if (key === 'page') continue;
      if (current.searchParams.has(key) && current.searchParams.get(key) !== value) throw new GitLabApiError('GitLab page cursor changed the requested filters.');
      current.searchParams.set(key, value);
    }
    const { items, response } = await this.withReadRequest(async signal => {
      const response = await this.send(current, { method: 'GET', headers: { 'PRIVATE-TOKEN': this.token, Accept: 'application/json' }, signal, redirect: 'manual' });
      return { items: await this.readJson<T[]>(response), response };
    });
    if (!Array.isArray(items)) throw new GitLabApiError('GitLab returned an unexpected list response.', response.status);
    const next = this.getNextPage(response, current);
    if (next && (!this.isSafeApiUrl(next) || next.pathname !== initial.pathname || next.href === current.href)) throw new GitLabApiError('GitLab returned an unsafe or repeated page cursor.');
    return { items, nextCursor: next?.href, complete: !next, updatedAt: new Date().toISOString() };
  }

  private async getPages<T>(path: string): Promise<T[]> {
    let next: URL | undefined = new URL(path.replace(/^\/+/, ''), this.apiRoot);
    const values: T[] = [];
    const seen = new Set<string>();
    const deadline = Date.now() + 120_000;
    let bytes = 0;

    while (next) {
      if (seen.size >= 100 || bytes >= 32 * 1024 * 1024 || Date.now() >= deadline) {
        throw Object.assign(new GitLabApiError('GitLab list exceeded its page, byte or time budget; it was not treated as complete. Use paged loading to continue.'), { nextCursor: next.href, loadedCount: values.length, complete: false });
      }
      if (!this.isSafeApiUrl(next)) {
        throw new GitLabApiError('GitLab returned a pagination link outside the configured API.');
      }
      if (seen.has(next.href)) {
        throw new GitLabApiError('GitLab returned a repeated pagination link.');
      }
      seen.add(next.href);
      const { page, response } = await this.withReadRequest(async (signal) => {
        const response = await this.send(next!, {
          method: 'GET', headers: { 'PRIVATE-TOKEN': this.token, Accept: 'application/json' }, signal, redirect: 'manual'
        });
        return { response, page: await this.readJson<T[]>(response) };
      }, AbortSignal.timeout(Math.max(1, deadline - Date.now())));
      if (!Array.isArray(page)) {
        throw new GitLabApiError('GitLab returned an unexpected list response.', response.status);
      }
      bytes += Buffer.byteLength(JSON.stringify(page), 'utf8');
      if (bytes > 32 * 1024 * 1024) throw Object.assign(new GitLabApiError('GitLab list exceeded its 32 MiB budget; it was not treated as complete.'), { nextCursor: next.href, loadedCount: values.length, complete: false });
      values.push(...page);
      next = this.getNextPage(response, next);
    }

    return values;
  }

  private async fetchJson<T>(url: URL, init: RequestInit): Promise<T> {
    if (!this.isSafeApiUrl(url)) {
      throw new GitLabApiError('The request is outside the configured GitLab API.');
    }
    const method = (init.method ?? 'GET').toUpperCase();
    let notifiedWrite = false;
    const notifyWrite = (): void => {
      if (notifiedWrite) return;
      notifiedWrite = true;
      this.onSuccessfulWrite?.(this.restWriteContext(url, method, init));
    };
    const request = async (signal?: AbortSignal): Promise<T> => {
      const response = await this.send(url, {
        ...init,
        headers: { Accept: 'application/json', ...init.headers, 'PRIVATE-TOKEN': this.token },
        ...(signal ? { signal } : {}),
        redirect: 'manual'
      });
      const value = await this.readJson<T>(response);
      if (method !== 'GET' && method !== 'HEAD' && response.ok) notifyWrite();
      return value;
    };
    if (method === 'GET' || method === 'HEAD') return this.withReadRequest(request);
    try { return await this.withWriteRequest(request); }
    catch (error) {
      if (error instanceof GitLabWriteUnknownError) notifyWrite();
      throw error;
    }
  }

  private restWriteContext(url: URL, method: string, init: RequestInit): GitLabWriteContext {
    let invalidateAll = false;
    if (/\/(?:issues|merge_requests)\/\d+\/(?:notes|discussions)(?:\/|$)/.test(url.pathname) && typeof init.body === 'string') {
      try {
        const body = (JSON.parse(init.body) as { body?: unknown } | null)?.body;
        // Deliberately conservative inside Markdown too: commands can move an
        // Issue or change labels/time, and their full effects are not URL-scoped.
        invalidateAll = typeof body === 'string' && /(?:^|\r?\n)[ \t]*\/[a-z][a-z0-9_-]*(?=\s|$)/i.test(body);
      } catch { /* Non-JSON request bodies cannot contain JSON note quick actions. */ }
    }
    return { url: url.toString(), method, ...(invalidateAll ? { invalidateAll: true as const } : {}) };
  }

  private send(input: string | URL | Request, init: RequestInit = {}, safeRead?: boolean, responseLimit?: number): Promise<Response> {
    const url = input instanceof URL ? input : new URL(typeof input === 'string' ? input : input.url);
    if (this.requestBudgets.length) init = { ...init, signal: AbortSignal.any([...(init.signal ? [init.signal] : []), ...this.requestBudgets.map(budget => budget.signal)]) };
    return this.networkGate.fetch(this.fetcher, url, init, safeRead, responseLimit, () => {
      for (const budget of this.requestBudgets) budget.reserve();
      const state = writeRequestState.getStore(); if (state) state.sent = true;
    }, bytes => { for (const budget of this.requestBudgets) budget.consume(bytes); });
  }

  private withWriteRequest<T>(operation: (signal: AbortSignal) => Promise<T>, signal?: AbortSignal, timeoutMs = this.writeTimeoutMs): Promise<T> {
    const state = { sent: false };
    const task = async (): Promise<T> => {
      if (signal?.aborted) throw Object.assign(new Error('Upload cancelled before sending.'), { name: 'AbortError', effect: 'none' });
      const controller = new AbortController();
      const unknown = (): Error => state.sent ? new GitLabWriteUnknownError() : Object.assign(new Error('GitLab operation cancelled before sending; no request was sent.'), { name: 'AbortError', effect: 'none' });
      const onAbort = (): void => controller.abort(unknown());
      signal?.addEventListener('abort', onAbort, { once: true });
      let rejectDeadline!: (error: Error) => void;
      const interrupted = new Promise<never>((_resolve, reject) => { rejectDeadline = reject; });
      const onInterrupted = (): void => rejectDeadline(controller.signal.reason);
      controller.signal.addEventListener('abort', onInterrupted, { once: true });
      const timeout = setTimeout(onAbort, timeoutMs);
      try { return await Promise.race([writeRequestState.run(state, () => operation(controller.signal)), interrupted]); }
      catch (error) {
        if (error instanceof GitLabWriteUnknownError || error instanceof Error && 'effect' in error && error.effect === 'none' || error instanceof GitLabApiError && error.status !== undefined && error.status >= 400 && error.status < 500) throw error;
        throw new GitLabWriteUnknownError(undefined, { cause: error });
      } finally {
        clearTimeout(timeout); signal?.removeEventListener('abort', onAbort);
        controller.signal.removeEventListener('abort', onInterrupted);
      }
    };
    return this.runWrite ? this.runWrite(task) : task();
  }

  private withReadRequest<T>(operation: (signal: AbortSignal) => Promise<T>, extraSignal?: AbortSignal): Promise<T> {
    return this.readGate.run(extraSignal ? [...(Array.isArray(this.readSignal) ? this.readSignal : [this.readSignal]), extraSignal] : this.readSignal, operation);
  }

  private async readJson<T>(response: Response): Promise<T> {
    if (response.status >= 300 && response.status < 400) {
      throw new GitLabApiError('GitLab redirected the API request. Check the configured base URL.', response.status);
    }
    if (!response.ok) {
      const message = response.status === 401 || response.status === 403
        ? 'GitLab rejected the access token or its permissions.'
        : response.status === 429 ? 'GitLab 暫停請求（HTTP 429），請於 ' + new Date(parseRetryAfter(response.headers.get('retry-after')) ?? Date.now() + 30_000).toISOString() + ' 後繼續。'
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
