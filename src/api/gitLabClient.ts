import { gitLabApiRoot, normalizeGitLabBaseUrl } from './urlPolicy';
import type {
  GitLabEmojiReaction, GitLabGroup, GitLabIssue, GitLabIssueDiscussion, GitLabIssueNote,
  GitLabIssueTemplate, GitLabLabel, GitLabMember, GitLabMergeRequestSummary, GitLabMetadata, GitLabMilestone,
  GitLabProject, GitLabTimeStats, GitLabTodo, GitLabUpload, GitLabUser, GitLabIssueBoard,
  GitLabCommitSummary, GitLabCompareResult, GitLabGraphWorkItem, GitLabMergeRequest, GitLabMergeRequestDiff
} from './types';

export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export class GitLabApiError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = 'GitLabApiError';
  }
}

export interface IssueCreateInput {
  title: string;
  description?: string;
  assigneeId?: number;
  labels?: string[];
  milestoneId?: number;
  dueDate?: string;
  startDate?: string;
  confidential?: boolean;
}

export interface IssueUpdateInput {
  title?: string;
  description?: string;
  assigneeId?: number | null;
  labels?: string[];
  milestoneId?: number | null;
  dueDate?: string | null;
  startDate?: string | null;
  confidential?: boolean;
  discussionLocked?: boolean;
  stateEvent?: 'close' | 'reopen';
}

export interface GitLabIssueCapabilities {
  hierarchy: boolean;
  childMutations: boolean;
  graphWorkItems: boolean;
  graphHierarchy: boolean;
  graphLinkedItems: boolean;
  graphLabels: boolean;
  graphAssignees: boolean;
  graphWorkItemTypes: boolean;
  discussionResolve: boolean;
  startDate: boolean;
  timelogReport: boolean;
  timelogCreate: boolean;
  timelogDelete: boolean;
  createPermission: boolean;
}

export interface GitLabMergeRequestCreateInput {
  title: string;
  description?: string;
  sourceBranch: string;
  targetBranch: string;
  reviewerIds?: number[];
  assigneeId?: number;
}

export class GitLabConflictError extends Error {
  constructor() {
    super('This issue changed in GitLab. Reload it before saving your edits.');
    this.name = 'GitLabConflictError';
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

  getMetadata(): Promise<GitLabMetadata> {
    return this.getJson<GitLabMetadata>('metadata');
  }

  async getIssueCapabilities(): Promise<GitLabIssueCapabilities> {
    const query = 'query IssueCapabilities { __schema { types { name fields { name } inputFields { name } } } }';
    const result = await this.graphql<{ __schema?: { types?: Array<{ name: string; fields?: Array<{ name: string }>; inputFields?: Array<{ name: string }> }> } }>(query, {});
    const schema = new Map(result.__schema?.types?.map((type) => [type.name, type]) ?? []);
    const has = (type: string, fields: string[]) => {
      const value = schema.get(type);
      const available = new Set((value?.fields ?? value?.inputFields ?? []).map((field) => field.name));
      return fields.every((field) => available.has(field));
    };
    const hierarchy = has('Namespace', ['workItem', 'workItemTypes']) &&
      has('WorkItem', ['id', 'iid', 'userPermissions', 'widgets']) &&
      has('WorkItemWidgetHierarchy', ['children']) &&
      has('WorkItemPermissions', ['updateWorkItem', 'deleteWorkItem', 'moveWorkItem', 'cloneWorkItem', 'createNote', 'markNoteAsInternal', 'adminWorkItemLink', 'adminParentLink', 'setWorkItemMetadata']);
    const graphWorkItems = has('Namespace', ['workItem']) && has('WorkItem', ['id', 'iid', 'title', 'state', 'webUrl', 'namespace', 'project', 'widgets']);
    return {
      hierarchy,
      childMutations: hierarchy && has('Mutation', ['workItemCreate', 'workItemUpdate']),
      graphWorkItems,
      graphHierarchy: graphWorkItems && has('WorkItemWidgetHierarchy', ['parent', 'children']),
      graphLinkedItems: graphWorkItems && has('WorkItemWidgetLinkedItems', ['linkedItems']),
      graphLabels: graphWorkItems && has('WorkItemWidgetLabels', ['labels']),
      graphAssignees: graphWorkItems && has('WorkItemWidgetAssignees', ['assignees']),
      graphWorkItemTypes: graphWorkItems && has('WorkItem', ['workItemType']),
      discussionResolve: has('Mutation', ['discussionToggleResolve']),
      startDate: has('Mutation', ['workItemUpdate']) && has('WorkItemUpdateInput', ['startAndDueDateWidget']) && has('WorkItemWidgetStartAndDueDateUpdateInput', ['startDate']) && has('WorkItemWidgetStartAndDueDate', ['startDate']),
      timelogReport: has('WorkItemWidgetTimeTracking', ['timelogs']) && has('WorkItemTimelog', ['id', 'timeSpent', 'spentAt', 'summary', 'user', 'userPermissions']),
      timelogCreate: has('Mutation', ['timelogCreate']),
      timelogDelete: has('Mutation', ['timelogDelete']),
      createPermission: has('Project', ['userPermissions']) && has('ProjectPermissions', ['createIssue'])
    };
  }

  async canCreateIssue(projectPath: string): Promise<boolean> {
    const data = await this.graphql<{ project?: { userPermissions?: { createIssue: boolean } } }>(
      'query CanCreateIssue($path: ID!) { project(fullPath: $path) { userPermissions { createIssue } } }',
      { path: projectPath }
    );
    return data.project?.userPermissions?.createIssue === true;
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

  listGroupIssueBoards(groupId: number): Promise<GitLabIssueBoard[]> {
    return this.getPages<GitLabIssueBoard>(`groups/${encodeURIComponent(String(groupId))}/boards?per_page=100`);
  }

  listGroupBoardIssueIds(groupPath: string, boardId: number): Promise<number[]> {
    return this.fetchGroupBoardIssueIds(groupPath, boardId);
  }

  listGroupBoardIssueMemberships(groupPath: string, boardId: number): Promise<Array<{ issueId: number; projectId?: number; iid?: number }>> {
    return this.fetchGroupBoardIssueMemberships(groupPath, boardId);
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

    const lists: Array<{ id: string; listType: string }> = [];
    const seenListCursors = new Set<string>();
    let after: string | null = null;
    let boardFound = false;
    let hideBacklogList = false;
    let hideClosedList = false;

    do {
      const page: BoardListPage = await this.graphql<BoardListPage>(
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

    const issuesById = new Map<number, { issueId: number; projectId?: number; iid?: number }>();
    for (const list of lists) {
      const listType = list.listType.toLocaleLowerCase();
      if ((hideBacklogList && listType === 'backlog') || (hideClosedList && listType === 'closed')) continue;
      if (!list.id) throw new GitLabApiError('GitLab returned an invalid Issue Board list.');

      const seenIssueCursors = new Set<string>();
      let issueAfter: string | null = null;
      do {
        const filter = username === undefined ? '' : ', filters: { assigneeUsername: $username }';
        const variables: Record<string, unknown> = { listId: list.id, after: issueAfter };
        if (username !== undefined) variables.username = [username];
        const page: BoardIssuePage = await this.graphql<BoardIssuePage>(
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
    }

    return [...issuesById.values()];
  }

  listGroupMilestones(groupId: number): Promise<GitLabMilestone[]> {
    return this.getPages<GitLabMilestone>(
      `groups/${encodeURIComponent(String(groupId))}/milestones?include_descendants=true&per_page=100`
    );
  }

  async listGroupMergeRequests(groupId: number): Promise<GitLabMergeRequest[]> {
    const root = `groups/${encodeURIComponent(String(groupId))}/merge_requests?state=opened&per_page=100`;
    const [assignedResult, reviewResult] = await Promise.allSettled([
      this.getPages<GitLabMergeRequest>(`${root}&scope=assigned_to_me`),
      this.getPages<GitLabMergeRequest>(`${root}&scope=reviews_for_me`)
    ]);
    if (assignedResult.status === 'rejected' && reviewResult.status === 'rejected') throw assignedResult.reason;
    const assigned = assignedResult.status === 'fulfilled' ? assignedResult.value : [];
    const reviews = reviewResult.status === 'fulfilled' ? reviewResult.value : [];
    const byId = new Map<string, GitLabMergeRequest>();
    for (const request of [...assigned, ...reviews]) {
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

  async listMergeRequestDiffs(projectId: number, iid: number): Promise<GitLabMergeRequestDiff[]> {
    const response = await this.getJson<{ changes?: GitLabMergeRequestDiff[]; diffs?: GitLabMergeRequestDiff[] }>(
      `${this.projectPath(projectId)}/merge_requests/${iid}/changes`
    );
    return (response.changes ?? response.diffs ?? []).slice(0, 200);
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
    const entries = await this.getPages<{ key: string; name: string }>(`${this.projectPath(projectId)}/templates/issues?per_page=100`);
    return Promise.all(entries.map(async (entry) => {
      const template = await this.getJson<{ content: string }>(`${this.projectPath(projectId)}/templates/issues/${encodeURIComponent(entry.key)}`);
      return { name: entry.name, content: template.content };
    }));
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
    projectPath: string,
    issueIid: number,
    capabilities: Pick<GitLabIssueCapabilities, 'graphWorkItems' | 'graphHierarchy' | 'graphLinkedItems' | 'graphLabels' | 'graphAssignees' | 'graphWorkItemTypes'>
  ): Promise<{ root?: GitLabGraphWorkItem; parents: GitLabGraphWorkItem[]; children: GitLabGraphWorkItem[]; links: Array<{ type: string; item: GitLabGraphWorkItem }> }> {
    if (!projectPath.trim() || projectPath.length > 255 || !Number.isSafeInteger(issueIid) || issueIid <= 0) {
      throw new GitLabApiError('A valid project path and Issue IID are required.');
    }
    if (!capabilities.graphWorkItems) return { parents: [], children: [], links: [] };

    const hierarchy = capabilities.graphHierarchy
      ? '... on WorkItemWidgetHierarchy { parent { ...IssueGraphItem } children(first: 100, after: $childrenAfter) { nodes { ...IssueGraphItem } pageInfo { hasNextPage endCursor } } }'
      : '';
    const linked = capabilities.graphLinkedItems
      ? '... on WorkItemWidgetLinkedItems { linkedItems(first: 100, after: $linksAfter) { nodes { linkType workItem { ...IssueGraphItem } } pageInfo { hasNextPage endCursor } } }'
      : '';
    const labels = capabilities.graphLabels
      ? '... on WorkItemWidgetLabels { labels(first: 100) { nodes { name color textColor } } }'
      : '';
    const assignees = capabilities.graphAssignees
      ? '... on WorkItemWidgetAssignees { assignees(first: 100) { nodes { id name username } } }'
      : '';
    const type = capabilities.graphWorkItemTypes ? 'workItemType { name }' : '';
    const rootWidgets = [hierarchy, linked, labels, assignees].filter(Boolean).join(' ');
    const itemWidgets = [labels, assignees].filter(Boolean).join(' ');
    const rootWidgetsSelection = rootWidgets ? `widgets { ${rootWidgets} }` : '';
    const itemWidgetsSelection = itemWidgets ? `widgets { ${itemWidgets} }` : '';
    const paginationVariables = [
      capabilities.graphHierarchy ? '$childrenAfter: String' : '',
      capabilities.graphLinkedItems ? '$linksAfter: String' : ''
    ].filter(Boolean);
    const variableDefinitions = ['$path: ID!', '$iid: String!', ...paginationVariables].join(', ');
    const itemFragment = capabilities.graphHierarchy || capabilities.graphLinkedItems
      ? `fragment IssueGraphItem on WorkItem {
      id iid title state webUrl ${type} namespace { fullPath } project { id fullPath }
      ${itemWidgetsSelection}
    }`
      : '';
    const query = `query IssueGraphRelations(${variableDefinitions}) {
      namespace(fullPath: $path) { workItem(iid: $iid) { id iid title state webUrl ${type} namespace { fullPath } project { id fullPath }
        ${rootWidgetsSelection}
      } }
    } ${itemFragment}`;
    const parents = new Map<string, GitLabGraphWorkItem>();
    const children = new Map<string, GitLabGraphWorkItem>();
    const links = new Map<string, { type: string; item: GitLabGraphWorkItem }>();
    let graphRoot: GitLabGraphWorkItem | undefined;
    const cursors = { children: new Set<string>(), links: new Set<string>() };
    let after = { children: null as string | null, links: null as string | null };

    for (let pageIndex = 0; pageIndex < 100; pageIndex++) {
      const variables: Record<string, unknown> = { path: projectPath, iid: String(issueIid) };
      if (capabilities.graphHierarchy) variables.childrenAfter = after.children;
      if (capabilities.graphLinkedItems) variables.linksAfter = after.links;
      const data = await this.graphql<{ namespace?: { workItem?: GitLabGraphWorkItem | null } | null }>(query, variables);
      const root = data.namespace?.workItem;
      if (!root) throw new GitLabApiError('GitLab could not find the Issue hierarchy item.');
      graphRoot = root;
      let childInfo: { hasNextPage?: boolean; endCursor?: string | null } | undefined;
      let linkInfo: { hasNextPage?: boolean; endCursor?: string | null } | undefined;
      for (const widget of root.widgets ?? []) {
        if (widget.parent?.id) parents.set(widget.parent.id, widget.parent);
        for (const item of widget.children?.nodes ?? []) if (item.id) children.set(item.id, item);
        for (const item of widget.linkedItems?.nodes ?? []) {
          if (item.workItem?.id) links.set(`${item.linkType}:${item.workItem.id}`, { type: item.linkType, item: item.workItem });
        }
        childInfo ??= widget.children?.pageInfo;
        linkInfo ??= widget.linkedItems?.pageInfo;
      }
      const advance = (
        hasNext: boolean | undefined,
        cursor: string | null | undefined,
        seen: Set<string>,
        label: string
      ): string | null => {
        if (!hasNext) return null;
        if (!cursor || seen.has(cursor)) throw new GitLabApiError(`GitLab returned an incomplete or repeated Issue graph ${label} cursor.`);
        seen.add(cursor);
        return cursor;
      };
      const next = {
        children: advance(childInfo?.hasNextPage, childInfo?.endCursor, cursors.children, 'child'),
        links: advance(linkInfo?.hasNextPage, linkInfo?.endCursor, cursors.links, 'linked-item')
      };
      if (!next.children && !next.links) return { root: graphRoot, parents: [...parents.values()], children: [...children.values()], links: [...links.values()] };
      after = next;
    }
    throw new GitLabApiError('GitLab returned too many Issue graph pages to load safely.');
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

  async createChildTask(projectPath: string, parentId: string, taskTypeId: string, title: string): Promise<void> {
    const data = await this.graphql<{ workItemCreate?: { errors: string[] } }>(
      'mutation CreateChildTask($path: ID!, $parent: WorkItemID!, $type: WorkItemsTypeID!, $title: String!) { workItemCreate(input: { namespacePath: $path, workItemTypeId: $type, title: $title, hierarchyWidget: { parentId: $parent } }) { errors } }',
      { path: projectPath, parent: parentId, type: taskTypeId, title }
    );
    this.checkMutation(data.workItemCreate, 'GitLab could not create the child task.');
  }

  async getWorkItemId(projectPath: string, iid: number): Promise<string | undefined> {
    const data = await this.graphql<{ namespace?: { workItem?: { id: string } } }>(
      'query FindWorkItem($path: ID!, $iid: String!) { namespace(fullPath: $path) { workItem(iid: $iid) { id } } }',
      { path: projectPath, iid: String(iid) }
    );
    return data.namespace?.workItem?.id;
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

  async getIssueStartDate(projectPath: string, iid: number): Promise<string | null> {
    const data = await this.graphql<{ namespace?: { workItem?: { widgets?: Array<{ startDate?: string | null }> } } }>(
      'query IssueStartDate($path: ID!, $iid: String!) { namespace(fullPath: $path) { workItem(iid: $iid) { widgets { ... on WorkItemWidgetStartAndDueDate { startDate } } } } }',
      { path: projectPath, iid: String(iid) }
    );
    return data.namespace?.workItem?.widgets?.find((widget) => widget.startDate !== undefined)?.startDate ?? null;
  }

  async listIssueTimelogs(projectPath: string, iid: number): Promise<Array<{ id: string; timeSpent: number; spentAt: string; summary?: string | null; user: GitLabUser; userPermissions?: { adminTimelog: boolean } }>> {
    type Timelog = { id: string; timeSpent: number; spentAt: string; summary?: string | null; user: GitLabUser; userPermissions?: { adminTimelog: boolean } };
    type TimePage = { namespace?: { workItem?: { widgets?: Array<{ timelogs?: { nodes?: Timelog[]; pageInfo?: { hasNextPage: boolean; endCursor?: string | null } } }> } } };
    const query = 'query IssueTimelogs($path: ID!, $iid: String!, $after: String) { namespace(fullPath: $path) { workItem(iid: $iid) { widgets { ... on WorkItemWidgetTimeTracking { timelogs(first: 100, after: $after) { nodes { id timeSpent spentAt summary user { id name username } userPermissions { adminTimelog } } pageInfo { hasNextPage endCursor } } } } } } }';
    const entries: Timelog[] = [];
    const seen = new Set<string>();
    let after: string | null = null;
    for (let page = 0; page < 100; page++) {
      const data: TimePage = await this.graphql<TimePage>(query, { path: projectPath, iid: String(iid), after });
      const connection: { nodes?: Timelog[]; pageInfo?: { hasNextPage: boolean; endCursor?: string | null } } | undefined = data.namespace?.workItem?.widgets?.find((widget) => widget.timelogs)?.timelogs;
      entries.push(...(connection?.nodes ?? []));
      if (!connection?.pageInfo?.hasNextPage) return entries;
      const cursor: string | null | undefined = connection.pageInfo.endCursor;
      if (!cursor || seen.has(cursor)) throw new GitLabApiError('GitLab returned a repeated time entry cursor.');
      seen.add(cursor);
      after = cursor;
    }
    throw new GitLabApiError('GitLab returned too many time entry pages to load safely.');
  }

  async createIssueTimelog(issueId: number, duration: string, summary?: string, spentAt?: string): Promise<void> {
    const data = await this.graphql<{ timelogCreate?: { errors: string[] } }>(
      'mutation AddIssueTimelog($input: TimelogCreateInput!) { timelogCreate(input: $input) { errors } }',
      { input: { issuableId: `gid://gitlab/Issue/${issueId}`, timeSpent: duration, summary: summary ?? '', ...(spentAt ? { spentAt } : {}) } }
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
    return this.postJson<{ html: string }>('markdown', { text: markdown, gfm: true, project: projectPath });
  }

  async uploadProjectFile(projectId: number, filename: string, bytes: Uint8Array, contentType: string): Promise<GitLabUpload> {
    const form = new FormData();
    form.append('file', new Blob([Uint8Array.from(bytes)], { type: contentType }), filename);
    return this.getJson<GitLabUpload>(`${this.projectPath(projectId)}/uploads`, { method: 'POST', body: form });
  }

  async downloadUpload(rawUrl: string, maxBytes = 50 * 1024 * 1024): Promise<{ bytes: Uint8Array; contentType: string }> {
    const url = new URL(rawUrl, this.baseUrl);
    const base = new URL(this.baseUrl);
    const basePath = base.pathname.replace(/\/$/, '');
    const insideBase = !basePath || url.pathname === basePath || url.pathname.startsWith(`${basePath}/`);
    if (url.origin !== base.origin || url.username || url.password || !insideBase || !url.pathname.includes('/uploads/')) {
      throw new GitLabApiError('The attachment URL is outside this GitLab server.');
    }
    const response = await this.fetcher(url, { method: 'GET', headers: { 'PRIVATE-TOKEN': this.token }, redirect: 'manual' });
    if (response.status >= 300 && response.status < 400) throw new GitLabApiError('GitLab redirected the attachment request.', response.status);
    if (!response.ok) throw new GitLabApiError(`GitLab attachment request failed (HTTP ${response.status}).`, response.status);
    if (Number(response.headers.get('content-length') ?? 0) > maxBytes) throw new GitLabApiError('The attachment is too large to open in VS Code.');
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > maxBytes) throw new GitLabApiError('The attachment is too large to open in VS Code.');
    return { bytes, contentType: response.headers.get('content-type')?.split(';')[0] ?? 'application/octet-stream' };
  }

  async graphql<T>(query: string, variables: Record<string, unknown>): Promise<T> {
    const url = new URL('../graphql', this.apiRoot);
    if (url.origin !== this.apiRoot.origin || !url.pathname.startsWith(this.apiRoot.pathname.slice(0, -3))) {
      throw new GitLabApiError('The GraphQL request is outside the configured GitLab server.');
    }
    const response = await this.fetcher(url, {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'PRIVATE-TOKEN': this.token },
      body: JSON.stringify({ query, variables }),
      redirect: 'manual'
    });
    const result = await this.readJson<{ data?: T; errors?: Array<{ message?: string }> }>(response);
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
    const url = new URL(path.replace(/^\/+/, ''), this.apiRoot);
    if (!this.isSafeApiUrl(url)) throw new GitLabApiError('The request is outside the configured GitLab API.');
    const response = await this.fetcher(url, {
      ...init, headers: { Accept: 'application/json', 'PRIVATE-TOKEN': this.token }, redirect: 'manual'
    });
    if (response.status >= 300 && response.status < 400 && response.status !== 304) throw new GitLabApiError('GitLab redirected the API request.', response.status);
    if (!response.ok && response.status !== 304) throw new GitLabApiError(`GitLab API request failed (HTTP ${response.status}).`, response.status);
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
