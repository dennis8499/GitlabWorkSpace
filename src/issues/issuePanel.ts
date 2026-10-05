import * as vscode from 'vscode';
import { GitLabApiError, GitLabConflictError, type GitLabWorkItemScope, type IssueCreateInput, type IssueUpdateInput } from '../api/gitLabClient';
import type { GitLabEmojiReaction, GitLabIssue, GitLabIssueDiscussion, GitLabIssueTemplate, GitLabLabel, GitLabMember, GitLabMilestone, GitLabProject } from '../api/types';
import type { GitLabSession } from '../connection/session';
import type { IssueDetailData, IssueDetailSection, IssueDetailSectionStatus, IssueFormOptions, IssuePanelRequest, IssuePanelResponse, IssueRelationAction, IssueRelationsData, IssueTask, IssueTimelog } from './protocol';
import type { IssueDetailTab, IssueNavigation, WorkspaceResponse } from '../workspace/workspaceProtocol';
import { mapWithConcurrency } from '../workspace/issueGraph';

function safeError(error: unknown): string {
  if (error instanceof GitLabConflictError || error instanceof GitLabApiError) return error.message;
  if (error instanceof Error && !/token|authorization|private-token/i.test(error.message)) return error.message;
  return 'The GitLab operation could not be completed.';
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} is required.`);
  return value;
}

function requiredId(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) throw new Error(`${label} is invalid.`);
  return value;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function optionalId(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

function optionalDate(value: unknown): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error('Date must use YYYY-MM-DD.');
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) throw new Error('Enter a valid calendar date in YYYY-MM-DD format.');
  return value;
}

function quickActionDuration(value: string): string {
  const duration = requiredString(value, 'Duration').trim();
  if (duration.length > 80 || !/^(?:\d+(?:\.\d+)?\s*(?:mo|w|d|h|m|s)\s*)+$/i.test(duration)) {
    throw new Error('Use a GitLab time duration such as 45m, 1h, or 1h 30m.');
  }
  const amounts = [...duration.matchAll(/(\d+(?:\.\d+)?)\s*(?:mo|w|d|h|m|s)/gi)].map((match) => Number(match[1]));
  if (!amounts.some((amount) => amount > 0)) throw new Error('Time duration must be greater than zero.');
  return duration;
}

function safeLinkUrl(value: unknown, baseUrl: string): URL {
  let url: URL;
  try { url = new URL(requiredString(value, 'URL')); }
  catch { throw new Error('This link is not safe to open.'); }
  const base = new URL(baseUrl);
  if (url.username || url.password || (url.protocol !== 'https:' && url.origin !== base.origin)) {
    throw new Error('This link is not safe to open.');
  }
  return url;
}

function createInput(raw: unknown): IssueCreateInput {
  if (!raw || typeof raw !== 'object') throw new Error('Invalid issue form.');
  const input = raw as Record<string, unknown>;
  const title = requiredString(input.title, 'Title').trim();
  if (title.length > 1024) throw new Error('Title is too long.');
  if (input.labels !== undefined && (!Array.isArray(input.labels) || !input.labels.every((label) => typeof label === 'string'))) {
    throw new Error('Invalid labels.');
  }
  return {
    title,
    description: optionalString(input.description),
    assigneeId: optionalId(input.assigneeId),
    labels: input.labels as string[] | undefined,
    milestoneId: optionalId(input.milestoneId),
    dueDate: optionalString(input.dueDate),
    startDate: optionalDate(input.startDate),
    confidential: typeof input.confidential === 'boolean' ? input.confidential : undefined
  };
}

function updateInput(raw: unknown): IssueUpdateInput {
  if (!raw || typeof raw !== 'object') throw new Error('Invalid issue update.');
  const input = raw as Record<string, unknown>;
  if (input.labels !== undefined && (!Array.isArray(input.labels) || !input.labels.every((label) => typeof label === 'string'))) {
    throw new Error('Invalid labels.');
  }
  const result: IssueUpdateInput = {};
  if (typeof input.title === 'string') result.title = requiredString(input.title, 'Title').trim();
  if (typeof input.description === 'string') result.description = input.description;
  if (input.assigneeId === null || optionalId(input.assigneeId)) result.assigneeId = input.assigneeId as number | null;
  if (input.labels !== undefined) result.labels = input.labels as string[];
  if (input.milestoneId === null || optionalId(input.milestoneId)) result.milestoneId = input.milestoneId as number | null;
  if (input.dueDate === null || typeof input.dueDate === 'string') result.dueDate = input.dueDate as string | null;
  if (input.startDate === null || typeof input.startDate === 'string') result.startDate = optionalDate(input.startDate) ?? null;
  if (typeof input.confidential === 'boolean') result.confidential = input.confidential;
  if (typeof input.discussionLocked === 'boolean') result.discussionLocked = input.discussionLocked;
  return result;
}

export class IssuePanels implements vscode.Disposable {
  private issue?: GitLabIssue;
  private loadingTask?: Promise<void>;
  private loadingVersion?: number;
  private navigationReadController?: AbortController;
  private ready = false;
  private lastSnapshot?: IssuePanelResponse;
  private operationWarning?: string;
  private navigationVersion = 0;
  private detailSectionLoader?: (sections: IssueDetailSection[], forceNetwork?: boolean) => Promise<void>;
  private hasNavigation = false;
  private mode: 'create' | 'detail' = 'create';
  private revision = 0;
  private workspace?: {
    post: (message: WorkspaceResponse) => void;
    navigate: (navigation: IssueNavigation | null) => void;
    show: () => Promise<void>;
  };

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly session: GitLabSession,
    private readonly refreshIssues: () => void
  ) {}

  setWorkspace(workspace: {
    post: (message: WorkspaceResponse) => void;
    navigate: (navigation: IssueNavigation | null) => void;
    show: () => Promise<void>;
  }): void {
    this.workspace = workspace;
  }

  async loadIssueRelations(projectId: number, iid: number): Promise<IssueRelationsData> {
    const group = this.session.selectedGroup;
    if (!group) throw new Error('Choose a GitLab Group first.');
    await this.session.ensureInstanceChecked();
    const projects = await this.session.cachedRead(`group/${group.id}/projects`, (readClient) => readClient.listGroupProjects(group.id));
    const project = projects.find((item) => item.id === requiredId(projectId, 'Project'));
    if (!project) throw new Error('The Issue is outside the selected Group.');
    const client = await this.session.getClient();
    const capabilities = this.session.issueCapabilities;
    const [issue, links, hierarchy] = await Promise.all([
      client.getIssue(projectId, requiredId(iid, 'Issue')),
      client.listIssueLinks(projectId, iid),
      capabilities?.hierarchy ? this.loadTasks(client, project.path_with_namespace, iid) : Promise.resolve({ tasks: [] as IssueTask[], parentWorkItemId: undefined, taskTypeId: undefined, permissions: undefined })
    ]);
    const issuePermissions = await this.readIssuePermissions(client, project.path_with_namespace, iid);
    return {
      issue, project, links, tasks: hierarchy.tasks, parentWorkItemId: hierarchy.parentWorkItemId, taskTypeId: hierarchy.taskTypeId,
      canLink: issuePermissions.updateIssue === true || issuePermissions.adminIssue === true,
      canManageChildren: capabilities?.childMutations === true && hierarchy.permissions?.adminParentLink === true
    };
  }

  private async readIssuePermissions(client: import('../api/gitLabClient').GitLabClient, projectPath: string, iid: number): Promise<Record<string, boolean>> {
    const capabilities = this.session.issueCapabilities;
    if (capabilities?.issuePermissionFields?.length) {
      return client.getIssuePermissions(projectPath, iid, capabilities.issuePermissionFields);
    }
    if (capabilities?.issuePermissionSource !== 'workItem' || !capabilities.workItemScope || !capabilities.workItemPermissionFields?.length) return {};
    const fields = new Set(capabilities.workItemPermissionFields);
    const workItem = await client.getWorkItemPermissions(projectPath, iid, capabilities.workItemPermissionFields, capabilities.workItemScope);
    const mapped: Record<string, boolean> = {};
    if (fields.has('updateWorkItem') || fields.has('adminWorkItem')) {
      mapped.updateIssue = workItem.updateWorkItem === true || workItem.adminWorkItem === true;
      mapped.adminIssue = workItem.adminWorkItem === true;
    }
    if (fields.has('deleteWorkItem') || fields.has('adminWorkItem')) mapped.deleteIssue = workItem.deleteWorkItem === true || workItem.adminWorkItem === true;
    if (fields.has('createNote')) mapped.createNote = workItem.createNote === true;
    return mapped;
  }

  async mutateIssueRelations(projectId: number, iid: number, action: IssueRelationAction): Promise<void> {
    const relations = await this.loadIssueRelations(projectId, iid);
    const client = await this.session.getClient();
    switch (action.type) {
      case 'createChild': {
        if (!relations.canManageChildren || !relations.parentWorkItemId || !relations.taskTypeId) throw new Error('You cannot create child tasks on this issue.');
        const title = requiredString(action.title, 'Task title').trim();
        if (title.length > 1024) throw new Error('Task title is too long.');
        await client.createChildTask(relations.project.path_with_namespace, relations.parentWorkItemId, relations.taskTypeId, title, this.session.issueCapabilities?.workItemCreatePathField);
        break;
      }
      case 'addChild': {
        if (!relations.canManageChildren || !relations.parentWorkItemId) throw new Error('You cannot add child tasks to this issue.');
        const taskIid = requiredId(action.taskIid, 'Task');
        if (taskIid === iid) throw new Error('An issue cannot be its own child task.');
        if (relations.tasks.some((task) => Number(task.iid) === taskIid)) throw new Error('This Task is already a child of the current issue.');
        const capabilities = this.session.issueCapabilities;
        const item = await client.getWorkItemTypeAndParent(relations.project.path_with_namespace, taskIid, capabilities?.graphHierarchy === true, capabilities?.graphWorkItemTypes === true, capabilities?.workItemScope);
        if (!item) throw new Error('The selected Task was not found in this project.');
        if (item.type?.toLocaleLowerCase() !== 'task') throw new Error('The selected work item is not a Task.');
        if (item.parentId === relations.parentWorkItemId) throw new Error('This Task is already a child of the current issue.');
        if (item.parentId) throw new Error('This Task already has another parent. Remove its existing parent in GitLab before adding it here.');
        await client.setChildParent(item.id, relations.parentWorkItemId);
        break;
      }
      case 'link': {
        if (!relations.canLink) throw new Error('You do not have permission to link issues from this issue.');
        if ((action.linkType === 'blocks' || action.linkType === 'is_blocked_by') && this.session.capabilityDiagnostics.find((item) => item.id === 'blockingLinks')?.status !== 'supported') {
          throw new Error(this.session.capabilityDiagnostics.find((item) => item.id === 'blockingLinks')?.reason ?? '尚未確認此 GitLab 方案是否支援阻擋關聯。');
        }
        const targetProjectId = requiredId(action.targetProjectId, 'Target project');
        const targetIssueIid = requiredId(action.targetIssueIid, 'Target issue');
        if (!this.session.selectedGroup || !await this.session.cachedRead(`group/${this.session.selectedGroup.id}/projects`, (readClient) => readClient.listGroupProjects(this.session.selectedGroup!.id)).then((items) => items.some((item) => item.id === targetProjectId))) {
          throw new Error('The target issue must belong to the selected Group.');
        }
        if (targetProjectId === projectId && targetIssueIid === iid) throw new Error('An issue cannot link to itself.');
        if (relations.links.some((item) => item.project_id === targetProjectId && item.iid === targetIssueIid)) throw new Error('These issues are already linked.');
        if (!['relates_to', 'blocks', 'is_blocked_by'].includes(action.linkType)) throw new Error('Unsupported issue link type.');
        await client.getIssue(targetProjectId, targetIssueIid);
        await client.addIssueLink(projectId, iid, targetProjectId, targetIssueIid, action.linkType);
        break;
      }
      case 'unlink': {
        if (!relations.canLink) throw new Error('You do not have permission to remove issue links.');
        const linkId = requiredId(action.linkId, 'Issue link');
        if (!relations.links.some((item) => item.issue_link_id === linkId)) throw new Error('This link does not belong to the current issue.');
        await client.removeIssueLink(projectId, iid, linkId);
        break;
      }
      default: throw new Error('Unsupported issue relationship action.');
    }
  }

  get activeNavigationMode(): 'create' | 'detail' | undefined {
    return this.hasNavigation ? this.mode : undefined;
  }

  dispose(): void {
    this.close();
  }

  private cancelNavigationReads(): void {
    this.navigationReadController?.abort();
    this.navigationReadController = undefined;
    this.detailSectionLoader = undefined;
  }

  close(): void {
    this.cancelNavigationReads();
    this.navigationVersion++;
    this.revision++;
    this.hasNavigation = false;
    this.issue = undefined;
    this.lastSnapshot = undefined;
    this.workspace?.navigate(null);
  }

  async showCreate(): Promise<void> {
    this.cancelNavigationReads();
    const navigationVersion = ++this.navigationVersion;
    this.issue = undefined;
    this.mode = 'create';
    this.hasNavigation = true;
    await this.openWorkspace(undefined, navigationVersion);
    if (navigationVersion !== this.navigationVersion) return;
    await this.load();
  }

  async showIssue(issue: GitLabIssue, tab?: IssueDetailTab): Promise<void> {
    this.cancelNavigationReads();
    const navigationVersion = ++this.navigationVersion;
    this.issue = issue;
    this.mode = 'detail';
    this.hasNavigation = true;
    await this.openWorkspace(issue, navigationVersion, tab);
    if (navigationVersion !== this.navigationVersion) return;
    await this.load();
  }

  async refreshActive(): Promise<void> {
    if (this.hasNavigation) await this.load(true);
  }

  private async openWorkspace(issue: GitLabIssue | undefined, navigationVersion: number, tab?: IssueDetailTab): Promise<void> {
    const revision = ++this.revision;
    await this.workspace?.show();
    if (navigationVersion !== this.navigationVersion) return;
    this.workspace?.navigate(issue
      ? { mode: 'detail', projectId: issue.project_id, issueIid: issue.iid, tab, revision }
      : { mode: 'create', revision });
  }

  private post(message: IssuePanelResponse): void {
    if (message.type === 'createData' || message.type === 'detailData') this.lastSnapshot = message;
    else if (message.type === 'detailPatch' && this.lastSnapshot?.type === 'detailData' && this.lastSnapshot.data.issue.id === message.issueId) {
      const previous = this.lastSnapshot.data;
      this.lastSnapshot = { type: 'detailData', data: {
        ...previous, ...message.patch,
        options: message.patch.options ? { ...previous.options, ...message.patch.options } : previous.options,
        sections: { ...(previous.sections ?? {}), ...(message.patch.sections ?? {}) }
      } };
    }
    if (!this.ready) return;
    this.workspace?.post({ type: 'issueResponse', revision: this.revision, response: message });
  }

  async handle(raw: unknown, revision?: number): Promise<void> { return this.handleRequest(raw, revision); }

  private async handleRequest(raw: unknown, revision?: number): Promise<void> {
    if (!raw || typeof raw !== 'object') return;
    const request = raw as IssuePanelRequest;
    if (revision !== undefined && revision !== this.revision) {
      if (request.type === 'copyDescription' && typeof request.requestId === 'string') {
        this.post({ type: 'reply', requestId: request.requestId, error: 'The displayed issue changed. Try copying the current issue again.' });
      }
      return;
    }
    if (request.type === 'ready') {
      this.ready = true;
      if (this.loadingTask) {
        await this.loadingTask;
        if (this.lastSnapshot) return;
      }
      if (this.lastSnapshot) {
        this.workspace?.post({ type: 'issueResponse', revision: this.revision, response: this.lastSnapshot });
        return;
      }
      return this.load();
    }
    return this.handleReadyRequest(request);
  }

  private async handleReadyRequest(request: IssuePanelRequest): Promise<void> {
    return this.handleRequestBody(request);
  }

  private async load(forceNetwork = false): Promise<void> {
    const version = this.navigationVersion;
    if (this.loadingTask && this.loadingVersion === version && !forceNetwork) return this.loadingTask;
    this.cancelNavigationReads();
    const controller = new AbortController();
    this.navigationReadController = controller;
    const task = this.loadOnce(version, controller.signal, forceNetwork);
    this.loadingTask = task;
    this.loadingVersion = version;
    try { await task; }
    finally {
      if (this.loadingTask === task) {
        this.loadingTask = undefined;
        this.loadingVersion = undefined;
      }
    }
  }

  private async loadOnce(version: number, signal: AbortSignal, forceNetwork: boolean): Promise<void> {
    this.post({ type: 'busy', value: true });
    try {
      if (this.mode === 'create') await this.loadCreate(version, signal, forceNetwork);
      else await this.loadDetail(version, signal, forceNetwork);
    } catch (error) {
      if (version === this.navigationVersion && !signal.aborted) this.post({ type: 'error', message: safeError(error) });
    } finally {
      if (version === this.navigationVersion && !signal.aborted) this.post({ type: 'busy', value: false });
    }
  }

  private async loadCreate(version: number, signal: AbortSignal, forceNetwork: boolean): Promise<void> {
    const group = this.session.selectedGroup;
    if (!group) throw new Error('Select a GitLab group first.');
    const client = (await this.session.getClient()).withReadSignal(signal);
    const capabilitiesTask = this.session.ensureInstanceChecked();
    const projects = await this.session.cachedRead(`group/${group.id}/projects`, (readClient) => readClient.listGroupProjects(group.id), { signal, force: forceNetwork });
    const first = projects[0];
    const options = first ? await this.formOptions(first.id, signal, forceNetwork) : undefined;
    await capabilitiesTask;
    const canCreateIssue = first && this.session.issueCapabilities?.createPermission ? await client.canCreateIssue(first.path_with_namespace).catch(() => false) : false;
    if (version !== this.navigationVersion || signal.aborted) return;
    this.post({ type: 'createData', projects, selectedProjectId: first?.id, options, metadata: this.session.metadata, canSetStartDate: this.session.issueCapabilities?.startDate === true, canCreateIssue });
  }

  private async formOptions(projectId: number, signal?: AbortSignal, forceNetwork = false): Promise<IssueFormOptions> {
    const results = await Promise.allSettled([
      this.session.cachedRead(`project/${projectId}/members`, (client) => client.listProjectMembers(projectId), { signal, force: forceNetwork }),
      this.session.cachedRead(`project/${projectId}/labels`, (client) => client.listProjectLabels(projectId), { signal, force: forceNetwork }),
      this.session.cachedRead(`project/${projectId}/milestones`, (client) => client.listProjectMilestones(projectId), { signal, force: forceNetwork }),
      this.session.cachedRead(`project/${projectId}/templates`, (client) => client.listProjectIssueTemplates(projectId), { signal, force: forceNetwork })
    ] as const);
    const labels = ['members', 'labels', 'milestones', 'templates'];
    const warnings = results.flatMap((result, index) => result.status === 'rejected' ? [`Could not load ${labels[index]}: ${safeError(result.reason)}`] : []);
    const value = <T,>(index: number): T[] => results[index].status === 'fulfilled' ? results[index].value as T[] : [];
    return {
      members: [...value<GitLabMember>(0)], labels: [...value<GitLabLabel>(1)],
      milestones: [...value<GitLabMilestone>(2)], templates: [...value<GitLabIssueTemplate>(3)], warnings
    };
  }

  private async loadNoteReactions(client: import('../api/gitLabClient').GitLabClient, projectId: number, iid: number, discussions: GitLabIssueDiscussion[], signal: AbortSignal): Promise<{ reactions: Record<number, GitLabEmojiReaction[]>; failed: number }> {
    const ids = discussions.flatMap((discussion) => discussion.notes.filter((note) => !note.system).map((note) => note.id));
    const reactions: Record<number, GitLabEmojiReaction[]> = {};
    let failed = 0;
    await mapWithConcurrency(ids, 8, async (id) => {
      if (signal.aborted) throw new Error('The Issue view request was cancelled.');
      try { reactions[id] = await client.listIssueNoteReactions(projectId, iid, id); }
      catch (error) { if (signal.aborted) throw error; failed++; }
    });
    return { reactions, failed };
  }

  private async loadTasks(client: import('../api/gitLabClient').GitLabClient, projectPath: string, iid: number): Promise<{ tasks: IssueTask[]; parentWorkItemId?: string; taskTypeId?: string; permissions?: Record<string, boolean> }> {
    const capabilities = this.session.issueCapabilities;
    const scope: GitLabWorkItemScope = capabilities?.workItemScope ?? 'namespace';
    const fields = new Set(capabilities?.workItemFields ?? ['id', 'iid', 'title', 'description', 'descriptionHtml', 'state', 'webUrl', 'userPermissions', 'widgets']);
    const itemFields = ['id', 'iid', 'title', 'description', 'descriptionHtml', 'state', 'webUrl'].filter((field) => fields.has(field));
    const permissionFields = (capabilities?.workItemPermissionFields ?? []).filter((field) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(field));
    const permissionSelection = fields.has('userPermissions') && permissionFields.length ? `userPermissions { ${permissionFields.join(' ')} }` : '';
    const childPermissionSelection = permissionFields.includes('updateWorkItem') ? 'userPermissions { updateWorkItem }' : '';
    const typeListSelection = capabilities?.workItemTypeList ? 'workItemTypes(name: TASK) { nodes { id name } }' : '';
    const query = `query IssueTasks($path: ID!, $iid: String!, $after: String) { ${scope}(fullPath: $path) { workItem(iid: $iid) { id ${permissionSelection} widgets { ... on WorkItemWidgetHierarchy { children(first: 100, after: $after) { nodes { ${itemFields.join(' ')} ${childPermissionSelection} } pageInfo { hasNextPage endCursor } } } } } ${typeListSelection} } }`;
    type TaskItem = IssueTask & { userPermissions?: { updateWorkItem?: boolean } };
    type TaskPage = { namespace?: { workItem?: { id: string; userPermissions?: Record<string, boolean>; widgets?: Array<{ children?: { nodes?: TaskItem[]; pageInfo?: { hasNextPage: boolean; endCursor?: string | null } } }> }; workItemTypes?: { nodes?: Array<{ id: string; name: string }> } } | null; project?: { workItem?: { id: string; userPermissions?: Record<string, boolean>; widgets?: Array<{ children?: { nodes?: TaskItem[]; pageInfo?: { hasNextPage: boolean; endCursor?: string | null } } }> }; workItemTypes?: { nodes?: Array<{ id: string; name: string }> } } | null };
    const tasks: IssueTask[] = [];
    const seen = new Set<string>();
    let after: string | null = null;
    let parentWorkItemId: string | undefined;
    let taskTypeId: string | undefined;
    let permissions: Record<string, boolean> | undefined;
    for (let page = 0; page < 100; page++) {
      const data: TaskPage = await client.graphql<TaskPage>(query, { path: projectPath, iid: String(iid), after });
      const connectionRoot = scope === 'namespace' ? data.namespace : data.project;
      const workItem = connectionRoot?.workItem;
      parentWorkItemId = workItem?.id;
      taskTypeId = connectionRoot?.workItemTypes?.nodes?.[0]?.id;
      permissions = workItem?.userPermissions;
      const connection = workItem?.widgets?.find((widget) => widget.children)?.children;
      for (const task of connection?.nodes ?? []) {
        tasks.push({ ...task, title: task.title ?? '', state: task.state ?? 'OPEN', canEdit: capabilities?.childMutations === true && task.userPermissions?.updateWorkItem === true });
      }
      if (!connection?.pageInfo?.hasNextPage) return { tasks, parentWorkItemId, taskTypeId, permissions };
      const cursor: string | null | undefined = connection.pageInfo.endCursor;
      if (!cursor || seen.has(cursor)) throw new Error('GitLab returned a repeated child task cursor.');
      seen.add(cursor);
      after = cursor;
    }
    throw new Error('GitLab returned too many child task pages to load safely.');
  }

  private async loadDetail(version: number, signal: AbortSignal, forceNetwork: boolean): Promise<void> {
    const seed = this.issue;
    if (!seed) return;
    const client = (await this.session.getClient()).withReadSignal(signal);
    const [issue, project, user] = await Promise.all([
      client.getIssue(seed.project_id, seed.iid), client.getProject(seed.project_id), client.getCurrentUser()
    ]);
    if (version !== this.navigationVersion || signal.aborted) return;
    this.issue = issue;
    const group = this.session.selectedGroup;
    const sectionNames: IssueDetailSection[] = ['options', 'activity', 'links', 'mergeRequests', 'reactions', 'todos', 'tasks', 'permissions', 'projects', 'dates', 'timelogs'];
    const sections = Object.fromEntries(sectionNames.map((name) => [name, 'idle'])) as Record<IssueDetailSection, IssueDetailSectionStatus>;
    let data: IssueDetailData = {
      issue, project, projects: [project], user, metadata: this.session.metadata,
      options: { members: [], labels: [], milestones: [], templates: [] },
      discussions: [], links: [], mergeRequests: [], reactions: [], noteReactions: {}, todos: [], tasks: [], timelogs: [],
      startDate: issue.start_date ?? null, startDateSupported: false,
      warnings: [], notices: [], loadErrors: {}, sections,
      canEdit: false, canDelete: false, canMove: false, canClone: false, canComment: false, canInternalComment: false,
      canLink: false, canManageChildren: false, canTrackTime: false, canResolveThreads: false, canSetStartDate: false,
      hasStartDate: !!issue.start_date, canLogTime: false, canDeleteTimelog: false
    };
    if (this.operationWarning) { data.notices?.push(this.operationWarning); this.operationWarning = undefined; }
    this.post({ type: 'detailData', data });
    const capabilitiesTask = this.session.ensureInstanceChecked();
    const current = (): boolean => version === this.navigationVersion && !signal.aborted && this.navigationReadController?.signal === signal;
    const patch = (section: IssueDetailSection, value: Partial<IssueDetailData>, status: IssueDetailSectionStatus = value.sections?.[section] ?? 'ready', warning?: string): void => {
      if (!current()) return;
      const nextSections = { ...(data.sections ?? {}), ...(value.sections ?? {}), [section]: status };
      const loadErrors = { ...(data.loadErrors ?? {}), ...(value.loadErrors ?? {}) };
      if (warning) loadErrors[section] = warning;
      else if (status === 'ready') delete loadErrors[section];
      const next: Partial<IssueDetailData> = { ...value, sections: nextSections, loadErrors };
      data = { ...data, ...value, sections: nextSections, loadErrors };
      this.post({ type: 'detailPatch', issueId: issue.id, patch: next });
    };
    const loaders: Partial<Record<IssueDetailSection, () => Promise<Partial<IssueDetailData>>>> = {};
    const running = new Map<IssueDetailSection, Promise<void>>();
    loaders.options = async () => {
      const fields = await this.formOptions(issue.project_id, signal, forceNetwork);
      fields.members = [...fields.members]; fields.labels = [...fields.labels]; fields.milestones = [...fields.milestones];
      for (const assignee of issue.assignees ?? []) if (!fields.members.some((member) => member.id === assignee.id)) fields.members.push(assignee);
      if (issue.milestone && !fields.milestones.some((milestone) => milestone.id === issue.milestone?.id)) fields.milestones.push(issue.milestone);
      for (const label of issue.labels ?? []) if (!fields.labels.some((item) => item.name === label)) fields.labels.push({ id: -fields.labels.length - 1, name: label, color: '#888888' });
      return { options: fields };
    };
    loaders.activity = async () => ({ discussions: await client.listIssueDiscussions(issue.project_id, issue.iid) });
    loaders.reactions = async () => {
      await runSection('activity');
      if (signal.aborted) throw new Error('The Issue view request was cancelled.');
      if (data.sections?.activity !== 'ready') throw new Error('Issue discussion activity must load before its reactions.');
      const [reactions, noteResults] = await Promise.all([
        client.listIssueReactions(issue.project_id, issue.iid),
        this.loadNoteReactions(client, issue.project_id, issue.iid, data.discussions, signal)
      ]);
      return { reactions, noteReactions: noteResults.reactions, ...(noteResults.failed ? {
        sections: { reactions: 'error' as const },
        loadErrors: { reactions: `無法載入 ${noteResults.failed} 則留言的反應。` }
      } : {}) };
    };
    loaders.links = async () => ({ links: await client.listIssueLinks(issue.project_id, issue.iid) });
    loaders.mergeRequests = async () => ({ mergeRequests: await client.listRelatedMergeRequests(issue.project_id, issue.iid) });
    loaders.todos = async () => ({ todos: await client.listTodos() });
    loaders.projects = async () => ({
      projects: group ? await this.session.cachedRead(`group/${group.id}/projects`, (readClient) => readClient.listGroupProjects(group.id), { signal, force: forceNetwork }) : [project]
    });
    loaders.dates = async () => {
      await capabilitiesTask;
      const details = this.session.issueCapabilities?.startDate
        ? await client.getIssueStartDateDetails(project.path_with_namespace, issue.iid, this.session.issueCapabilities.workItemScope)
        : { supported: false, startDate: issue.start_date ?? null };
      return {
        startDate: details.startDate, startDateSupported: details.supported,
        hasStartDate: details.supported || !!issue.start_date,
        canSetStartDate: details.supported && data.canEdit === true && this.session.issueCapabilities?.startDate === true
      };
    };
    loaders.timelogs = async () => {
      await capabilitiesTask;
      const capabilities = this.session.issueCapabilities;
      const supported = capabilities?.timelogReport === true;
      const timelogs: IssueTimelog[] = supported
        ? await client.listIssueTimelogs(project.path_with_namespace, issue.iid, capabilities.workItemScope, capabilities.timelogAdminPermission === true, capabilities.timelogSource, capabilities.timelogSummary === true, capabilities.timelogUserFields) : [];
      if (!supported) return { timelogs, sections: { timelogs: 'unsupported' } };
      return { timelogs };
    };
    loaders.tasks = async () => {
      await capabilitiesTask;
      const capabilities = this.session.issueCapabilities;
      if (!capabilities?.hierarchy) return { tasks: [], sections: { tasks: 'unsupported' } };
      const hierarchy = await this.loadTasks(client, project.path_with_namespace, issue.iid);
      return { tasks: hierarchy.tasks, parentWorkItemId: hierarchy.parentWorkItemId, taskTypeId: hierarchy.taskTypeId,
        canManageChildren: capabilities?.childMutations === true && hierarchy.permissions?.adminParentLink === true };
    };
    loaders.permissions = async () => {
      await capabilitiesTask;
      const capabilities = this.session.issueCapabilities;
      if (capabilities?.startDate) await runSection('dates');
      const fields = capabilities?.issuePermissionFields ?? [];
      const workItemFields = capabilities?.workItemPermissionFields ?? [];
      const permissionSource = capabilities?.issuePermissionSource;
      if (!permissionSource) return {
        metadata: this.session.metadata,
        sections: { permissions: 'unsupported' },
        permissionNotice: '此 GitLab Schema 未提供 Issue 權限資料，因此不能確認這個帳號可執行哪些操作。'
      };
      const hasEditField = permissionSource === 'issue'
        ? fields.includes('updateIssue') || fields.includes('adminIssue')
        : workItemFields.includes('updateWorkItem') || workItemFields.includes('adminWorkItem');
      const hasCommentField = permissionSource === 'issue' ? fields.includes('createNote') : workItemFields.includes('createNote');
      const permissions = await this.readIssuePermissions(client, project.path_with_namespace, issue.iid);
      const editable = permissions.updateIssue === true || permissions.adminIssue === true;
      const canComment = permissions.createNote === true;
      const permissionWarnings = [] as string[];
      if (!hasEditField) permissionWarnings.push('此 GitLab Schema 未提供 Issue 編輯權限欄位，因此編輯、關聯與工時寫入已停用。');
      else if (!editable) permissionWarnings.push('GitLab 回報目前帳號沒有編輯此 Issue 的權限。');
      if (!hasCommentField) permissionWarnings.push('此 GitLab Schema 未提供 Issue 留言權限欄位，因此留言功能已停用。');
      else if (!canComment) permissionWarnings.push('GitLab 回報目前帳號沒有在此 Issue 留言的權限。');
      return {
        metadata: this.session.metadata,
        permissionNotice: permissionWarnings.join(' '),
        canEdit: editable,
        canDelete: permissions.deleteIssue === true || permissions.adminIssue === true,
        canMove: editable,
        canClone: editable,
        canComment,
        canInternalComment: canComment && editable,
        canLink: editable,
        canTrackTime: editable,
        canResolveThreads: capabilities?.discussionResolve === true,
        canSetStartDate: capabilities?.startDate === true && data.startDateSupported === true && editable,
        canLogTime: editable,
        canLogDatedTime: editable,
        canDeleteTimelog: capabilities?.timelogDelete === true && capabilities.timelogAdminPermission === true
      };
    };
    const runSection = async (section: IssueDetailSection): Promise<void> => {
      if (!current()) return;
      const status = data.sections?.[section];
      if (status === 'ready' || status === 'unsupported') return;
      const active = running.get(section);
      if (active) return active;
      const loader = loaders[section];
      if (!loader) return;
      data = { ...data, sections: { ...(data.sections ?? {}), [section]: 'loading' } };
      this.post({ type: 'detailPatch', issueId: issue.id, patch: { sections: data.sections } });
      const task = (async (): Promise<void> => {
        try {
          const value = await loader();
          if (!current()) return;
          const optionErrors = section === 'options' ? value.options?.warnings : undefined;
          const loadWarning = value.loadErrors?.[section] ?? (optionErrors?.length ? optionErrors.join(' ') : undefined);
          const status = value.sections?.[section] ?? (loadWarning ? 'error' : 'ready');
          patch(section, value, status, loadWarning);
        } catch (error) {
          if (!current()) return;
          patch(section, {}, 'error', `Could not load ${section === 'options' ? 'fields' : section === 'mergeRequests' ? 'merge requests' : section === 'timelogs' ? 'time entries' : section === 'dates' ? 'start date' : section === 'tasks' ? 'child tasks' : section === 'todos' ? 'to-dos' : section}` + `: ${safeError(error)}`);
        } finally {
          running.delete(section);
        }
      })();
      running.set(section, task);
      return task;
    };
    this.detailSectionLoader = async (requested, force = false) => {
      if (!current()) return;
      if (force) for (const section of requested) if (data.sections?.[section] === 'error') {
        const loadErrors = { ...(data.loadErrors ?? {}) }; delete loadErrors[section];
        data = { ...data, loadErrors, sections: { ...(data.sections ?? {}), [section]: 'idle' } };
      }
      await Promise.all(requested.map((section) => runSection(section)));
    };
    void this.detailSectionLoader(['activity', 'permissions']);
  }

  private async handleRequestBody(request: IssuePanelRequest): Promise<void> {
    if (request.type === 'refresh') return this.load(true);
    if (request.type === 'loadSection') {
      const valid = (Array.isArray(request.sections) ? request.sections : []).filter((section): section is IssueDetailSection =>
        ['options', 'activity', 'links', 'mergeRequests', 'reactions', 'todos', 'tasks', 'permissions', 'projects', 'dates', 'timelogs'].includes(section));
      await this.detailSectionLoader?.([...new Set(valid)]);
      return;
    }
    if (request.type === 'copyDescription') {
      const requestId = requiredString(request.requestId, 'Request ID');
      const issue = this.issue;
      const revision = this.revision;
      try {
        if (!issue || this.mode !== 'detail') throw new Error('Open an issue first.');
        if (requiredId(request.issueId, 'Issue') !== issue.id) throw new Error('The displayed issue changed. Refresh before trying this action.');
        const description = issue.description ?? '';
        if (!description.trim()) throw new Error('此 Issue 沒有可複製的描述。');
        await vscode.env.clipboard.writeText(description);
        if (revision === this.revision && this.mode === 'detail' && this.issue?.id === issue.id) {
          this.workspace?.post({ type: 'message', message: 'Issue 描述已複製到剪貼簿。' });
        }
        this.post({ type: 'reply', requestId, result: true });
      } catch (error) {
        this.post({ type: 'reply', requestId, error: safeError(error) });
      }
      return;
    }
    if (request.type === 'openIssueInGitLab') {
      const issue = this.issue;
      if (!issue || this.mode !== 'detail') throw new Error('Open an issue first.');
      if (requiredId(request.issueId, 'Issue') !== issue.id) throw new Error('The displayed issue changed. Refresh before trying this action.');
      const baseUrl = this.session.baseUrl;
      if (!baseUrl) throw new Error('Connect to GitLab first.');
      const url = safeLinkUrl(issue.web_url, baseUrl);
      const opened = await vscode.env.openExternal(vscode.Uri.parse(url.href));
      if (!opened) throw new Error('Could not open the GitLab issue in your browser.');
      return;
    }
    const client = await this.session.getClient();
    if (request.type === 'selectProject') {
      const version = this.navigationVersion;
      const projectId = requiredId(request.projectId, 'Project');
      const group = this.session.selectedGroup;
      const project = group ? (await this.session.cachedRead(`group/${group.id}/projects`, (readClient) => readClient.listGroupProjects(group.id))).find((item) => item.id === projectId) : undefined;
      if (!project) throw new Error('Project is outside the selected group.');
      const options = await this.formOptions(projectId);
      const canCreateIssue = this.session.issueCapabilities?.createPermission ? await client.canCreateIssue(project.path_with_namespace).catch(() => false) : false;
      if (version !== this.navigationVersion || this.mode !== 'create') return;
      this.post({ type: 'projectData', projectId, options, canCreateIssue });
      return;
    }
    if (request.type === 'create') {
      const projectId = requiredId(request.projectId, 'Project');
      const group = this.session.selectedGroup;
      const project = group ? (await client.listGroupProjects(group.id)).find((item) => item.id === projectId) : undefined;
      if (!project) throw new Error('Project is outside the selected group.');
      if (!this.session.issueCapabilities?.createPermission || !await client.canCreateIssue(project.path_with_namespace)) throw new Error('You cannot create issues in this project.');
      const created = await client.createIssue(projectId, createInput(request.input));
      const startDate = optionalDate(request.input.startDate);
      if (startDate) {
        if (!this.session.issueCapabilities?.startDate) this.operationWarning = 'Issue 已建立，但此 GitLab 版本沒有原生 Issue 開始日期欄位。';
        else {
          try {
            const project = await client.getProject(projectId);
            const details = await client.getIssueStartDateDetails(project.path_with_namespace, created.iid, this.session.issueCapabilities?.workItemScope);
            if (!details.supported) throw new Error('這個 Issue 類型沒有可用的開始日期 Widget。');
            const workItemId = await client.getWorkItemId(project.path_with_namespace, created.iid, this.session.issueCapabilities?.workItemScope);
            if (!workItemId) throw new Error('GitLab did not return the new Work Item ID.');
            await client.setIssueStartDate(workItemId, startDate);
          } catch (error) { this.operationWarning = `Issue created, but the start date was not saved: ${safeError(error)}`; }
        }
      }
      this.refreshIssues();
      this.navigationVersion++;
      this.mode = 'detail';
      this.issue = created;
      this.workspace?.navigate({ mode: 'detail', projectId: created.project_id, issueIid: created.iid, revision: ++this.revision });
      return this.load();
    }
    if (request.type === 'searchProjects') {
      const requestId = requiredString(request.requestId, 'Request ID');
      if (this.mode !== 'detail' || !this.issue) throw new Error('Open an issue first.');
      try {
        const query = requiredString(request.query, 'Project search').trim();
        this.post({ type: 'reply', requestId, result: await client.searchMemberProjects(query) });
      } catch (error) {
        this.post({ type: 'reply', requestId, error: safeError(error) });
      }
      return;
    }
    if (request.type === 'preview' || request.type === 'search' || request.type === 'upload') {
      const projectId = requiredId(request.projectId, 'Project');
      const requestId = requiredString(request.requestId, 'Request ID');
      const group = this.session.selectedGroup;
      const allowed = this.issue?.project_id === projectId || (group && (await client.listGroupProjects(group.id)).some((project) => project.id === projectId));
      if (!allowed) throw new Error('Project is outside the selected group.');
      try {
        let result: unknown;
        if (request.type === 'preview') {
          const project = await client.getProject(projectId);
          result = await client.renderMarkdown(project.path_with_namespace, request.markdown);
        } else if (request.type === 'search') {
          result = request.query.trim() ? await client.searchProjectIssues(projectId, request.query.trim()) : [];
        } else {
          const file = await vscode.window.showOpenDialog({ canSelectMany: false, canSelectFolders: false, openLabel: 'Attach to GitLab Issue' });
          if (!file?.[0] || file[0].scheme !== 'file') result = null;
          else {
            const bytes = await vscode.workspace.fs.readFile(file[0]);
            const name = file[0].path.split('/').at(-1) ?? 'attachment';
            const type = /\.png$/i.test(name) ? 'image/png' : /\.jpe?g$/i.test(name) ? 'image/jpeg' : /\.gif$/i.test(name) ? 'image/gif' : 'application/octet-stream';
            result = await client.uploadProjectFile(projectId, name, bytes, type);
          }
        }
        this.post({ type: 'reply', requestId, result });
      } catch (error) {
        this.post({ type: 'reply', requestId, error: safeError(error) });
      }
      return;
    }
    if (request.type === 'image') {
      const requestId = requiredString(request.requestId, 'Request ID');
      try {
        const { bytes, contentType } = await client.downloadUpload(requiredString(request.url, 'Image URL'), 8 * 1024 * 1024);
        if (!/^image\/(png|jpeg|gif|webp)$/i.test(contentType)) throw new Error('This attachment is not a supported image.');
        this.post({ type: 'reply', requestId, result: { dataUrl: `data:${contentType};base64,${Buffer.from(bytes).toString('base64')}` } });
      } catch (error) {
        this.post({ type: 'reply', requestId, error: safeError(error) });
      }
      return;
    }
    if (request.type === 'openLink') {
      const url = safeLinkUrl(request.url, client.baseUrl);
      const base = new URL(client.baseUrl);
      if (url.origin === base.origin && url.pathname.includes('/uploads/')) {
        const name = decodeURIComponent(url.pathname.split('/').at(-1) || 'attachment').replace(/[\\/:*?"<>|]/g, '_');
        const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri;
        const destination = await vscode.window.showSaveDialog({ defaultUri: workspaceRoot ? vscode.Uri.joinPath(workspaceRoot, name) : undefined, saveLabel: 'Save GitLab Attachment' });
        if (!destination) return;
        const { bytes } = await client.downloadUpload(url.href);
        await vscode.workspace.fs.writeFile(destination, bytes);
        await vscode.commands.executeCommand('vscode.open', destination);
        return;
      }
      if (url.origin === base.origin && url.pathname.startsWith(`${base.pathname.replace(/\/$/, '')}/`)) {
        const relative = url.pathname.slice(base.pathname.replace(/\/$/, '').length + 1);
        const match = relative.match(/^(.+?)\/-\/issues\/(\d+)(?:\/.*)?$/);
        if (match) {
          const navigationVersion = this.navigationVersion;
          const project = await client.getProjectByPath(decodeURIComponent(match[1]));
          if (navigationVersion !== this.navigationVersion) return;
          const nextIssue = await client.getIssue(project.id, Number(match[2]));
          if (navigationVersion !== this.navigationVersion) return;
          this.navigationVersion++;
          this.issue = nextIssue;
          this.mode = 'detail';
          this.hasNavigation = true;
          this.workspace?.navigate({ mode: 'detail', projectId: nextIssue.project_id, issueIid: nextIssue.iid, revision: ++this.revision });
          return this.load();
        }
      }
      await vscode.env.openExternal(vscode.Uri.parse(url.href));
      return;
    }
    const issue = this.issue;
    if (!issue || this.mode !== 'detail') throw new Error('Open an issue first.');
    if ((request.type === 'update' || request.type === 'invoke') && requiredId(request.issueId, 'Issue') !== issue.id) {
      throw new Error('The displayed issue changed. Refresh before trying this action.');
    }
    const projectId = issue.project_id;
    const iid = issue.iid;
    const snapshot = this.lastSnapshot?.type === 'detailData' && this.lastSnapshot.data.issue.id === issue.id ? this.lastSnapshot.data : undefined;
    if (request.type === 'update') {
      if (!snapshot?.canEdit) throw new Error('GitLab does not report permission to edit this Issue.');
      const input = updateInput(request.input);
      await client.updateIssueIfUnchanged(projectId, iid, request.expectedUpdatedAt, input);
      const currentDate = this.lastSnapshot?.type === 'detailData' ? this.lastSnapshot.data.startDate : undefined;
      if (input.startDate !== undefined && input.startDate !== currentDate) {
        if (!this.session.issueCapabilities?.startDate) this.operationWarning = 'Issue 欄位已儲存，但此 GitLab 版本沒有原生 Issue 開始日期欄位。';
        else if (snapshot?.startDateSupported !== true) this.operationWarning = 'Issue 欄位已儲存，但這個 Issue 類型沒有可用的開始日期 Widget。';
        else {
          try {
            const project = await client.getProject(projectId);
            const workItemId = await client.getWorkItemId(project.path_with_namespace, iid, this.session.issueCapabilities?.workItemScope);
            if (!workItemId) throw new Error('GitLab did not return the Work Item ID.');
            await client.setIssueStartDate(workItemId, input.startDate ?? null);
          } catch (error) { this.operationWarning = `Issue fields saved, but the start date was not saved: ${safeError(error)}`; }
        }
      }
      this.refreshIssues();
      return this.load();
    }
    if (request.type !== 'invoke') return;
    const payload = request.payload ?? {};
    switch (request.action) {
      case 'close': case 'reopen':
        if (!snapshot?.canEdit) throw new Error('GitLab does not report permission to edit this Issue.');
        await client.updateIssueIfUnchanged(projectId, iid, issue.updated_at, { stateEvent: request.action }); break;
      case 'subscribe': await client.subscribeToIssue(projectId, iid); break;
      case 'unsubscribe': await client.unsubscribeFromIssue(projectId, iid); break;
      case 'todo': await client.createIssueTodo(projectId, iid); break;
      case 'todoDone': await client.markTodoDone(requiredId(payload.todoId, 'To-do')); break;
      case 'note':
        if (!snapshot?.canComment) throw new Error('GitLab does not report permission to comment on this Issue.');
        if (payload.internal === true && !snapshot?.canInternalComment) throw new Error('You cannot post internal comments on this issue.');
        await client.addIssueNote(projectId, iid, requiredString(payload.body, 'Comment'), payload.internal === true); break;
      case 'editNote': await client.updateIssueNote(projectId, iid, requiredString(payload.discussionId, 'Thread'), requiredId(payload.noteId, 'Comment'), requiredString(payload.body, 'Comment')); break;
      case 'deleteNote': await client.deleteIssueNote(projectId, iid, requiredString(payload.discussionId, 'Thread'), requiredId(payload.noteId, 'Comment')); break;
      case 'thread':
        if (!snapshot?.canComment) throw new Error('GitLab does not report permission to comment on this Issue.');
        if (payload.internal === true) throw new Error('GitLab cannot create an internal issue thread. Use an internal comment.');
        await client.createIssueThread(projectId, iid, requiredString(payload.body, 'Thread')); break;
      case 'reply':
        if (!snapshot?.canComment) throw new Error('GitLab does not report permission to comment on this Issue.');
        await client.replyToIssueThread(projectId, iid, requiredString(payload.discussionId, 'Thread'), requiredString(payload.body, 'Reply')); break;
      case 'resolveThread':
        if (!this.session.issueCapabilities?.discussionResolve) throw new Error('This GitLab instance does not expose discussion resolution.');
        await client.resolveIssueThread(requiredString(payload.discussionId, 'Thread'), payload.resolved === true); break;
      case 'react': await client.addIssueReaction(projectId, iid, requiredString(payload.name, 'Emoji')); break;
      case 'unreact': await client.removeIssueReaction(projectId, iid, requiredId(payload.reactionId, 'Reaction')); break;
      case 'reactNote': case 'unreactNote': {
        const noteId = requiredId(payload.noteId, 'Comment');
        if (!snapshot?.discussions.some((discussion) => discussion.notes.some((note) => note.id === noteId && !note.system))) throw new Error('Comment is not part of this issue.');
        if (request.action === 'reactNote') await client.addIssueNoteReaction(projectId, iid, noteId, requiredString(payload.name, 'Emoji'));
        else {
          const reactionId = requiredId(payload.reactionId, 'Reaction');
          if (!snapshot.noteReactions[noteId]?.some((reaction) => reaction.id === reactionId && reaction.user.id === snapshot.user.id)) throw new Error('Reaction is not yours.');
          await client.removeIssueNoteReaction(projectId, iid, noteId, reactionId);
        }
        break;
      }
      case 'link': {
        if (!snapshot?.canLink) throw new Error('GitLab does not report permission to link Issues.');
        const linkType = payload.linkType === 'blocks' || payload.linkType === 'is_blocked_by' ? payload.linkType : 'relates_to';
        if (linkType !== 'relates_to' && this.session.capabilityDiagnostics.find((item) => item.id === 'blockingLinks')?.status !== 'supported') {
          throw new Error(this.session.capabilityDiagnostics.find((item) => item.id === 'blockingLinks')?.reason ?? '尚未確認此 GitLab 方案是否支援阻擋關聯。');
        }
        await client.addIssueLink(projectId, iid, requiredId(payload.targetProjectId, 'Project'), requiredId(payload.targetIssueIid, 'Issue'), linkType);
        break;
      }
      case 'unlink':
        if (!snapshot?.canLink) throw new Error('GitLab does not report permission to remove Issue links.');
        await client.removeIssueLink(projectId, iid, requiredId(payload.linkId, 'Link')); break;
      case 'estimate':
        if (!snapshot?.canTrackTime) throw new Error('GitLab does not report permission to update this Issue time estimate.');
        await client.setTimeEstimate(projectId, iid, requiredString(payload.duration, 'Duration')); break;
      case 'spend': {
        if (!snapshot?.canLogTime) throw new Error('GitLab does not report permission to log time on this Issue.');
        const duration = requiredString(payload.duration, 'Duration');
        const spentDate = optionalDate(payload.spentDate);
        const summary = optionalString(payload.summary);
        const capabilities = this.session.issueCapabilities;
        const datedQuickAction = !!spentDate && (!capabilities?.timelogCreateDated || (!!summary?.trim() && !capabilities.timelogCreateSummary));
        if (datedQuickAction) {
          if (summary && summary.length > 1000) throw new Error('Time entry summary is too long (maximum 1,000 characters).');
          const safeDuration = quickActionDuration(duration);
          const safeSummary = summary?.trim().replace(/[\r\n]+/g, ' ').replace(/^\s*\/[A-Za-z][A-Za-z0-9_-]*(?:\s|$)/, ' ').trim();
          const body = [safeSummary, `/spend ${safeDuration} ${spentDate}`].filter(Boolean).join('\n\n');
          await client.addIssueNote(projectId, iid, body);
        } else if (capabilities?.timelogCreate && (!summary?.trim() || capabilities.timelogCreateSummary === true)) {
          const spentAt = spentDate ? new Date(`${spentDate}T12:00:00`).toISOString() : undefined;
          await client.createIssueTimelog(issue.id, duration, summary, spentAt, capabilities.timelogCreateDated === true, capabilities.timelogCreateSummary === true);
        } else await client.addSpentTime(projectId, iid, duration, summary);
        break;
      }
      case 'deleteTimelog': {
        const id = requiredString(payload.timelogId, 'Time entry');
        if (!snapshot?.canDeleteTimelog || !this.session.issueCapabilities?.timelogDelete || !snapshot.timelogs.some((entry) => entry.id === id && entry.userPermissions?.adminTimelog)) throw new Error('You cannot delete this time entry.');
        const confirm = await vscode.window.showWarningMessage('Delete this time entry?', { modal: true }, 'Delete time entry');
        if (confirm !== 'Delete time entry') { this.post({ type: 'cancelled' }); return; }
        await client.deleteIssueTimelog(id);
        break;
      }
      case 'resetEstimate': {
        if (!snapshot?.canTrackTime) throw new Error('GitLab does not report permission to reset this Issue time estimate.');
        const confirm = await vscode.window.showWarningMessage('Reset this issue’s entire time estimate?', { modal: true }, 'Reset estimate');
        if (confirm !== 'Reset estimate') { this.post({ type: 'cancelled' }); return; }
        await client.resetTimeEstimate(projectId, iid); break;
      }
      case 'resetSpent': {
        if (!snapshot?.canTrackTime) throw new Error('GitLab does not report permission to reset this Issue time.');
        const confirm = await vscode.window.showWarningMessage('Delete all time spent on this issue?', { modal: true }, 'Reset spent');
        if (confirm !== 'Reset spent') { this.post({ type: 'cancelled' }); return; }
        await client.resetSpentTime(projectId, iid); break;
      }
      case 'createChild': {
        if (!snapshot?.canManageChildren) throw new Error('GitLab does not report permission to manage child tasks.');
        if (!snapshot?.parentWorkItemId || !snapshot.taskTypeId) throw new Error('This GitLab instance did not expose child task creation.');
        await client.createChildTask(snapshot.project.path_with_namespace, snapshot.parentWorkItemId, snapshot.taskTypeId, requiredString(payload.title, 'Task title'), this.session.issueCapabilities?.workItemCreatePathField);
        break;
      }
      case 'addChild': {
        if (!snapshot?.canManageChildren) throw new Error('GitLab does not report permission to manage child tasks.');
        if (!snapshot?.parentWorkItemId) throw new Error('This GitLab instance did not expose child tasks.');
        const id = await client.getWorkItemId(snapshot.project.path_with_namespace, requiredId(payload.taskIid, 'Task'), this.session.issueCapabilities?.workItemScope);
        if (!id) throw new Error('Task was not found in this project.');
        await client.setChildParent(id, snapshot.parentWorkItemId);
        break;
      }
      case 'removeChild': case 'setChildState': {
        const id = requiredString(payload.taskId, 'Task');
        if (!snapshot?.tasks.some((task) => task.id === id)) throw new Error('Task is not a child of this issue.');
        if (request.action === 'removeChild') await client.setChildParent(id, null);
        else await client.setChildState(id, payload.stateEvent === 'reopen' ? 'reopen' : 'close');
        break;
      }
      case 'updateChild': {
        const id = requiredString(payload.taskId, 'Task');
        if (!snapshot?.tasks.some((task) => task.id === id && task.canEdit)) throw new Error('You cannot edit this child task.');
        await client.updateChildTask(id, requiredString(payload.title, 'Task title').trim(), optionalString(payload.description) ?? '');
        break;
      }
      case 'move': {
        if (!snapshot?.canMove) throw new Error('GitLab does not report permission to move this Issue.');
        const target = requiredId(payload.toProjectId, 'Target project');
        const confirm = await vscode.window.showWarningMessage(`Move issue #${iid} to project ${target}? GitLab closes the original issue.`, { modal: true }, 'Move');
        if (confirm !== 'Move') { this.post({ type: 'cancelled' }); return; }
        this.issue = await client.moveIssue(projectId, iid, target);
        this.navigationVersion++;
        this.refreshIssues();
        return this.load();
      }
      case 'clone': {
        if (!snapshot?.canClone) throw new Error('GitLab does not report permission to clone this Issue.');
        const target = requiredId(payload.toProjectId, 'Target project');
        this.issue = await client.cloneIssue(projectId, iid, target, payload.withNotes === true);
        this.navigationVersion++;
        this.refreshIssues();
        return this.load();
      }
      case 'delete': {
        if (!snapshot?.canDelete) throw new Error('GitLab does not report permission to delete this Issue.');
        const confirm = await vscode.window.showWarningMessage(`Permanently delete issue #${iid}?`, { modal: true }, 'Delete Issue');
        if (confirm !== 'Delete Issue') { this.post({ type: 'cancelled' }); return; }
        await client.deleteIssue(projectId, iid);
        this.refreshIssues();
        this.post({ type: 'deleted' });
        return;
      }
      default: throw new Error('Unsupported issue action.');
    }
    this.refreshIssues();
    await this.load();
  }
}
