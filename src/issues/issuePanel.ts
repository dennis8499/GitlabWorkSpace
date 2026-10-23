import * as vscode from 'vscode';
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { GitLabApiError, GitLabConflictError, type GitLabWorkItemScope, type IssueCreateInput, type IssueUpdateInput } from '../api/gitLabClient';
import type { GitLabIssue, GitLabLabel, GitLabMember, GitLabMilestone, GitLabProject } from '../api/types';
import { groupProjectsPageReadKey } from '../api/gitLabReadKeys';
import { IssuePageStore, issueQueryDigest } from './issuePageStore';
import type { GitLabSession } from '../connection/session';
import type { IssueDetailData, IssueDetailSection, IssueDetailSectionStatus, IssueFormOptions, IssueFormOptionSection, IssueReadState, IssuePanelRequest, IssuePanelResponse, IssueRelationAction, IssueRelationsData, IssueTask, IssueTimelog } from './protocol';
import type { IssueDetailTab, IssueNavigation, WorkspaceResponse } from '../workspace/workspaceProtocol';
import { operationResource, type OperationTracker, type WorkspaceOperationState } from '../workspace/operations';
import { describeAction } from '../workspace/actionPolicy';

interface IssueActionContext {
  request: IssuePanelRequest;
  writeStarted: boolean;
  status: 'succeeded' | 'failed' | 'cancelled';
  effect: 'none' | 'applied' | 'partial' | 'unknown';
  error?: string;
  refreshError?: string;
}

class IssueValidationError extends Error {
  constructor(message: string) { super(message); this.name = 'IssueValidationError'; }
}

function safeError(error: unknown): string {
  if (error instanceof GitLabConflictError || error instanceof GitLabApiError) return error.message;
  if (error instanceof Error && !/token|authorization|private-token/i.test(error.message)) return error.message;
  return 'The GitLab operation could not be completed.';
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new IssueValidationError(`${label} is required.`);
  return value;
}

function requiredId(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) throw new IssueValidationError(`${label} is invalid.`);
  return value;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function emptyFormOptions(): IssueFormOptions {
  return { members: [], labels: [], milestones: [], templates: [], states: { fields: { status: 'idle' }, members: { status: 'idle' }, labels: { status: 'idle' }, milestones: { status: 'idle' }, templates: { status: 'idle' } } };
}

function optionalId(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

function optionalDate(value: unknown): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new IssueValidationError('Date must use YYYY-MM-DD.');
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) throw new IssueValidationError('Enter a valid calendar date in YYYY-MM-DD format.');
  return value;
}

function quickActionDuration(value: string): string {
  const duration = requiredString(value, 'Duration').trim();
  if (duration.length > 80 || !/^(?:\d+(?:\.\d+)?\s*(?:mo|w|d|h|m|s)\s*)+$/i.test(duration)) {
    throw new IssueValidationError('Use a GitLab time duration such as 45m, 1h, or 1h 30m.');
  }
  const amounts = [...duration.matchAll(/(\d+(?:\.\d+)?)\s*(?:mo|w|d|h|m|s)/gi)].map((match) => Number(match[1]));
  if (!amounts.some((amount) => amount > 0)) throw new IssueValidationError('Time duration must be greater than zero.');
  return duration;
}

function safeLinkUrl(value: unknown, baseUrl: string): URL {
  let url: URL;
  try { url = new URL(requiredString(value, 'URL')); }
  catch { throw new IssueValidationError('This link is not safe to open.'); }
  const base = new URL(baseUrl);
  if (url.username || url.password || (url.protocol !== 'https:' && url.origin !== base.origin)) {
    throw new IssueValidationError('This link is not safe to open.');
  }
  return url;
}

function createInput(raw: unknown): IssueCreateInput {
  if (!raw || typeof raw !== 'object') throw new IssueValidationError('Invalid issue form.');
  const input = raw as Record<string, unknown>;
  const title = requiredString(input.title, 'Title').trim();
  if (title.length > 1024) throw new IssueValidationError('Title is too long.');
  if (input.labels !== undefined && (!Array.isArray(input.labels) || !input.labels.every((label) => typeof label === 'string'))) {
    throw new IssueValidationError('Invalid labels.');
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
  if (!raw || typeof raw !== 'object') throw new IssueValidationError('Invalid issue update.');
  const input = raw as Record<string, unknown>;
  if (input.labels !== undefined && (!Array.isArray(input.labels) || !input.labels.every((label) => typeof label === 'string'))) {
    throw new IssueValidationError('Invalid labels.');
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
  private suspended = false;
  private refreshAfterWrite = false;
  private lastSnapshot?: IssuePanelResponse;
  private operationWarning?: string;
  private navigationVersion = 0;
  private projectOptionsVersion = 0;
  private templateAbort?: AbortController;
  private createOptionsAbort?: AbortController;
  private readonly formOptionsReads = new Map<string, Promise<void>>();
  private readonly pageStore: IssuePageStore;
  private readonly creationProjects = new Map<number, GitLabProject>();
  private creationProjectScope?: string;
  private operationSnapshotAbort?: AbortController;
  private readonly uploads = new Map<string, AbortController>();
  private detailSectionLoader?: (sections: IssueDetailSection[], forceNetwork?: boolean) => Promise<void>;
  private noteReactionLoader?: (noteId: number, forceNetwork?: boolean) => Promise<void>;
  private hasNavigation = false;
  private mode: 'create' | 'detail' = 'create';
  private revision = 0;
  private readonly actionContext = new AsyncLocalStorage<IssueActionContext>();
  private workspace?: {
    post: (message: WorkspaceResponse) => void;
    navigate: (navigation: IssueNavigation | null) => void;
    show: () => Promise<void>;
  };

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly session: GitLabSession,
    private readonly refreshIssues: () => void,
    private readonly operations?: OperationTracker
  ) { this.pageStore = new IssuePageStore(session); }

  setWorkspace(workspace: {
    post: (message: WorkspaceResponse) => void;
    navigate: (navigation: IssueNavigation | null) => void;
    show: () => Promise<void>;
  }): void {
    this.workspace = workspace;
  }

  async loadIssueRelations(projectId: number, iid: number, signal?: AbortSignal): Promise<IssueRelationsData> {
    const group = this.session.selectedGroup;
    if (!group) throw new Error('Choose a GitLab Group first.');
    await this.session.ensureInstanceChecked();
    const projects = await this.session.cachedRead(`group/${group.id}/projects`, (readClient) => readClient.listGroupProjects(group.id), { signal });
    const project = projects.find((item) => item.id === requiredId(projectId, 'Project'));
    if (!project) throw new Error('The Issue is outside the selected Group.');
    const baseClient = await this.session.getClient();
    const client = signal ? baseClient.withReadSignal(signal) : baseClient;
    if (signal?.aborted) throw new Error('The Issue view request was cancelled.');
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
    const baseClient = await this.session.getClient();
    const client = baseClient.withWriteScope?.({ projectId, issueIid: iid, resource: 'issues' }) ?? baseClient;
    switch (action.type) {
      case 'createChild': {
        if (!relations.canManageChildren || !relations.parentWorkItemId || !relations.taskTypeId) throw new Error('You cannot create child tasks on this issue.');
        const title = requiredString(action.title, 'Task title').trim();
        if (title.length > 1024) throw new Error('Task title is too long.');
        const parentWorkItemId = relations.parentWorkItemId, taskTypeId = relations.taskTypeId;
        await this.write(() => client.createChildTask(relations.project.path_with_namespace, parentWorkItemId, taskTypeId, title, this.session.issueCapabilities?.workItemCreatePathField));
        break;
      }
      case 'addChild': {
        if (!relations.canManageChildren || !relations.parentWorkItemId) throw new Error('You cannot add child tasks to this issue.');
        await this.addChild(client, relations.project.path_with_namespace, iid, action.taskIid, relations.parentWorkItemId, relations.tasks);
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
        await this.write(() => client.addIssueLink(projectId, iid, targetProjectId, targetIssueIid, action.linkType));
        break;
      }
      case 'unlink': {
        if (!relations.canLink) throw new Error('You do not have permission to remove issue links.');
        const linkId = requiredId(action.linkId, 'Issue link');
        if (!relations.links.some((item) => item.issue_link_id === linkId)) throw new Error('This link does not belong to the current issue.');
        await this.write(() => client.removeIssueLink(projectId, iid, linkId));
        break;
      }
      default: throw new Error('Unsupported issue relationship action.');
    }
  }

  get activeNavigationMode(): 'create' | 'detail' | undefined {
    return this.hasNavigation ? this.mode : undefined;
  }

  dispose(): void {
    for (const controller of this.uploads.values()) controller.abort();
    this.uploads.clear();
    this.close();
  }

  private async addChild(client: import('../api/gitLabClient').GitLabClient, projectPath: string, iid: number,
    rawTaskIid: unknown, parentId: string, tasks: IssueTask[]): Promise<void> {
    const taskIid = requiredId(rawTaskIid, 'Task');
    if (taskIid === iid) throw new IssueValidationError('An issue cannot be its own child task.');
    if (tasks.some(task => Number(task.iid) === taskIid)) throw new IssueValidationError('This Task is already a child of the current issue.');
    const capabilities = this.session.issueCapabilities;
    const item = await client.getWorkItemTypeAndParent(projectPath, taskIid, capabilities?.graphHierarchy === true,
      capabilities?.graphWorkItemTypes === true, capabilities?.workItemScope);
    if (!item) throw new IssueValidationError('The selected Task was not found in this project.');
    if (item.type?.toLowerCase() !== 'task') throw new IssueValidationError('The selected work item is not a Task.');
    if (item.parentId === parentId) throw new IssueValidationError('This Task is already a child of the current issue.');
    if (item.parentId) throw new IssueValidationError('This Task already has another parent. Remove its existing parent in GitLab before adding it here.');
    await this.write(() => client.setChildParent(item.id, parentId));
  }

  suspendReads(): void {
    this.suspended = true;
    this.ready = false;
    this.cancelNavigationReads();
    const resetOptions = (options: IssueFormOptions): IssueFormOptions => ({ ...options, states: Object.fromEntries(
      Object.entries(options.states ?? {}).map(([section, state]) => [section, state.status === 'loading' ? { status: 'idle' } : state])
    ) });
    if (this.lastSnapshot?.type === 'detailData') {
      const sections = { ...this.lastSnapshot.data.sections };
      for (const section of Object.keys(sections) as IssueDetailSection[]) if (sections[section] === 'loading') sections[section] = 'idle';
      const noteReactionStates = Object.fromEntries(Object.entries(this.lastSnapshot.data.noteReactionStates ?? {})
        .map(([id, state]) => [id, state.status === 'loading' ? { status: 'idle' as const } : state]));
      this.lastSnapshot = { ...this.lastSnapshot, data: { ...this.lastSnapshot.data, sections, noteReactionStates, options: resetOptions(this.lastSnapshot.data.options) } };
    } else if (this.lastSnapshot?.type === 'createData' && this.lastSnapshot.options) {
      this.lastSnapshot = { ...this.lastSnapshot, options: resetOptions(this.lastSnapshot.options) };
    }
  }

  private cancelNavigationReads(): void {
    this.pageStore.cancel();
    this.operationSnapshotAbort?.abort(); this.operationSnapshotAbort = undefined;
    this.templateAbort?.abort(); this.templateAbort = undefined;
    this.createOptionsAbort?.abort(); this.createOptionsAbort = undefined; this.formOptionsReads.clear();
    this.navigationReadController?.abort();
    this.navigationReadController = undefined;
    this.detailSectionLoader = undefined;
    this.noteReactionLoader = undefined;
  }

  close(): void {
    this.cancelNavigationReads();
    this.pageStore.cancel(true); this.creationProjects.clear(); this.creationProjectScope = undefined;
    this.navigationVersion++;
    this.revision++;
    this.hasNavigation = false;
    this.issue = undefined;
    this.lastSnapshot = undefined;
    this.workspace?.navigate(null);
  }

  async showCreate(): Promise<void> {
    this.suspended = false; this.refreshAfterWrite = false;
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
    this.suspended = false; this.refreshAfterWrite = false;
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
    const action = this.actionContext.getStore();
    if (action && message.type !== 'actionResult') {
      if (message.type === 'error' || message.type === 'reply' && message.error) {
        const error = message.type === 'error' ? message.message : message.error!;
        if (action.effect === 'applied' || action.effect === 'partial') {
          action.refreshError = error;
          return;
        }
        action.status = 'failed'; action.error = error;
      } else if (message.type === 'cancelled') action.status = 'cancelled';
      message = { ...message, operationId: action.request.operationId, effect: action.effect };
    }
    if (message.type === 'error' || message.type === 'reply' && message.error) {
      this.session.log?.record({ feature: 'issue', action: 'issueError', result: 'error',
        projectId: this.issue?.project_id, issueIid: this.issue?.iid, message: message.type === 'error' ? message.message : message.error });
    }
    if (message.type === 'createData' || message.type === 'detailData') this.lastSnapshot = message;
    else if (message.type === 'createProjectsPage' && this.lastSnapshot?.type === 'createData') {
      const selected = this.creationProjects.get(this.lastSnapshot.selectedProjectId ?? 0);
      this.lastSnapshot = { ...this.lastSnapshot, projectsState: message.page,
        projects: selected && !message.page.items.some(project => project.id === selected.id) ? [selected, ...message.page.items] : message.page.items };
    }
    else if (message.type === 'projectData' && this.lastSnapshot?.type === 'createData') this.lastSnapshot = {
      ...this.lastSnapshot, selectedProjectId: message.projectId, options: message.options, optionsLoading: message.optionsLoading,
      canCreateIssue: message.canCreateIssue, canSetStartDate: message.canSetStartDate ?? this.lastSnapshot.canSetStartDate
    };
    else if (message.type === 'detailPatch' && this.lastSnapshot?.type === 'detailData' && this.lastSnapshot.data.issue.id === message.issueId) {
      const previous = this.lastSnapshot.data;
      this.lastSnapshot = { type: 'detailData', data: {
        ...previous, ...message.patch,
        options: message.patch.options ? { ...previous.options, ...message.patch.options } : previous.options,
        noteReactions: { ...previous.noteReactions, ...message.patch.noteReactions },
        noteReactionStates: { ...previous.noteReactionStates, ...message.patch.noteReactionStates },
        sections: { ...(previous.sections ?? {}), ...(message.patch.sections ?? {}) }
      } };
    }
    if (!this.ready && message.type !== 'reply' && message.type !== 'error' && message.type !== 'operationsSnapshot') return;
    this.workspace?.post({ type: 'issueResponse', revision: this.revision, response: message });
  }

  async handle(raw: unknown, revision?: number, alreadyTracked = false): Promise<void> { return this.handleRequest(raw, revision, alreadyTracked); }

  /** Bind locks to the Host's loaded Issue rather than client-supplied IDs. */
  normalizeOperationRequest(request: IssuePanelRequest): IssuePanelRequest {
    const current = this.mode === 'detail' ? this.issue : undefined;
    if ('issueId' in request && (!current || request.issueId !== current.id)) throw new IssueValidationError('The displayed issue changed. Refresh before trying this action.');
    const creation = request.type === 'create' || request.type === 'selectProject';
    const control = request.type === 'ready' || request.type === 'reconcileOperations' || request.type === 'confirmOperationResult' || request.type === 'cancelUpload';
    if (!current || creation || control) {
      const normalized = { ...request }; delete normalized.issueIid;
      return normalized;
    }
    if (request.projectId !== undefined && request.projectId !== current.project_id || request.issueIid !== undefined && request.issueIid !== current.iid) {
      throw new IssueValidationError('The displayed issue changed. Refresh before trying this action.');
    }
    return { ...request, projectId: current.project_id, issueIid: current.iid };
  }

  private async handleRequest(raw: unknown, revision?: number, alreadyTracked = false): Promise<void> {
    if (!raw || typeof raw !== 'object') return;
    const request = raw as IssuePanelRequest;
    if (request.type === 'cancelUpload') {
      if (typeof request.targetRequestId === 'string') this.uploads.get(request.targetRequestId)?.abort();
      return;
    }
    if (request.type === 'reconcileOperations') {
      if (this.operations) {
        this.operationSnapshotAbort?.abort(); const controller = new AbortController(); this.operationSnapshotAbort = controller;
        const revision = this.revision, navigation = this.navigationVersion;
        try {
          const snapshot = await this.operations.snapshotWithStored(undefined, request.pendingIds, controller.signal);
          if (!controller.signal.aborted && revision === this.revision && navigation === this.navigationVersion) this.post({ type: 'operationsSnapshot', snapshot });
        } catch (error) { if (!controller.signal.aborted) throw error; }
        finally { if (this.operationSnapshotAbort === controller) this.operationSnapshotAbort = undefined; }
      }
      return;
    }
    if (request.type === 'confirmOperationResult') {
      const operation = this.operations?.get(request.targetOperationId);
      if (!operation || operation.effect !== 'unknown' || operation.hostSessionId !== this.operations?.sessionId || !operation.resourceKey.startsWith('issue:')) return;
      const selected = await vscode.window.showWarningMessage('請先在 GitLab 核對這項 Issue 操作的實際結果，再選擇已確認的狀態。', { modal: true }, '已確認完成', '已確認未執行');
      if (selected === '已確認完成' || selected === '已確認未執行') {
        this.operations!.resolveUnknown(operation.requestId, { status: 'succeeded', effect: selected === '已確認完成' ? 'applied' : 'none', phase: '已核對操作結果', error: undefined, refreshError: undefined });
        this.post({ type: 'operationsSnapshot', snapshot: this.operations!.snapshot(undefined, [operation.requestId]) });
      }
      return;
    }
    if (revision !== undefined && revision !== this.revision) {
      if (request.type === 'copyDescription' && typeof request.requestId === 'string') {
        this.post({ type: 'reply', requestId: request.requestId, error: 'The displayed issue changed. Try copying the current issue again.' });
      }
      return;
    }
    if (request.type === 'ready') {
      if (!this.hasNavigation) return;
      this.ready = true;
      this.suspended = false;
      if (this.refreshAfterWrite) { this.refreshAfterWrite = false; return this.load(true); }
      if (this.loadingTask) {
        await this.loadingTask;
        if (this.lastSnapshot && this.navigationReadController && !this.navigationReadController.signal.aborted) return;
      }
      if (this.lastSnapshot) {
        if (this.lastSnapshot.type === 'createData') {
          this.createOptionsAbort ??= new AbortController();
          this.navigationReadController ??= new AbortController();
        }
        if (this.lastSnapshot.type === 'detailData' && !this.navigationReadController) {
          const controller = new AbortController();
          this.navigationReadController = controller;
          await this.loadDetail(this.navigationVersion, controller.signal, false, this.lastSnapshot.data);
        } else this.workspace?.post({ type: 'issueResponse', revision: this.revision, response: this.lastSnapshot });
        return;
      }
      return this.load();
    }
    return this.handleReadyRequest(request, alreadyTracked);
  }

  private async handleReadyRequest(request: IssuePanelRequest, alreadyTracked: boolean): Promise<void> {
    let normalizationError: unknown;
    try { request = this.normalizeOperationRequest(request); }
    catch (error) { normalizationError = error; }
    const operationId = request.operationId ?? `issue-host-${randomUUID()}`;
    const context: IssueActionContext = { request: { ...request, operationId }, writeStarted: false, status: 'succeeded', effect: 'none' };
    const task = () => this.actionContext.run(context, async () => {
      try {
        const body = () => { if (normalizationError) throw normalizationError; return this.handleRequestBody(request); };
        await (this.session.log?.run('issue', request.type === 'invoke' ? request.action : request.type,
          { projectId: this.issue?.project_id, issueIid: this.issue?.iid }, body, () => ({
            result: context.status === 'failed' ? 'error' : context.status === 'cancelled' ? 'cancelled' : 'success',
            ...(context.refreshError || context.effect === 'partial' ? { level: 'warn' as const } : {}),
            message: context.refreshError ?? context.error
          })) ?? body());
      } catch (error) {
        if (error instanceof Error && error.name === 'AbortError' && !context.writeStarted) {
          context.status = 'cancelled'; context.effect = 'none'; return;
        }
        context.status = 'failed'; context.error = safeError(error);
        const definitive = error instanceof IssueValidationError || error instanceof GitLabConflictError ||
          error instanceof GitLabApiError && error.status !== undefined && error.status >= 400 && error.status < 500;
        if (context.effect === 'applied' || context.effect === 'partial') {
          context.status = 'succeeded'; context.refreshError = context.error; context.error = undefined;
          return;
        }
        if (context.writeStarted && context.effect === 'none' && !definitive) context.effect = 'unknown';
        if (error && typeof error === 'object' && Object.isExtensible(error)) Object.assign(error, { effect: context.effect });
        throw error;
      } finally {
        this.operations?.noteOutcome(operationId, { status: context.status, effect: context.effect, error: context.error, refreshError: context.refreshError });
        if (request.requestId) this.post({ type: 'actionResult', requestId: request.requestId, operationId,
          status: context.status, effect: context.effect, error: context.error, refreshError: context.refreshError });
      }
    });
    if (!this.operations || alreadyTracked) return task();
    const scopeRevision = request.operationScope ?? `${this.session.baseUrl ?? 'offline'}:${this.session.selectedGroup?.id ?? 'none'}`;
    const state: WorkspaceOperationState = {
      ...describeAction({ type: 'issueRequest', request } as { type: string }, { scopeRevision }),
      requestId: operationId, scopeRevision,
      resourceKey: operationResource({ type: 'issueRequest', request }), action: 'issueRequest', label: '處理 Issue 操作',
      phase: '正在處理…', status: 'queued', startedAt: Date.now(), correlationId: request.requestId
    };
    return this.operations.run(state, async () => {
      await task();
      return context.status === 'cancelled' ? 'cancelled' : context.status === 'failed' ? 'failed' : undefined;
    });
  }

  /** Mark the effect only after GitLab confirms the mutation; reads never change it. */
  private async write<T>(task: () => Promise<T>): Promise<T> {
    const context = this.actionContext.getStore();
    if (context) context.writeStarted = true;
    try {
      const result = await task();
      if (context) context.effect = 'applied';
      return result;
    } catch (error) {
      const definitive = error instanceof IssueValidationError || error instanceof GitLabConflictError ||
        error instanceof GitLabApiError && error.status !== undefined && error.status >= 400 && error.status < 500;
      if (context && context.effect === 'none' && !definitive) context.effect = 'unknown';
      if (error && typeof error === 'object' && Object.isExtensible(error)) Object.assign(error, { effect: context?.effect ?? (definitive ? 'none' : 'unknown') });
      throw error;
    }
  }

  private async load(forceNetwork = false): Promise<void> {
    if (this.suspended) { this.refreshAfterWrite ||= forceNetwork; return; }
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
    void capabilitiesTask.catch(() => {});
    const page = await this.readCreationProjects('', undefined, undefined, forceNetwork);
    const projects = page.items;
    const first = projects[0];
    if (version !== this.navigationVersion || signal.aborted) return;
    this.createOptionsAbort = new AbortController();
    this.post({ type: 'createData', projects, projectsState: page, selectedProjectId: first?.id, options: emptyFormOptions(), optionsLoading: false,
      metadata: this.session.metadata, canSetStartDate: this.session.issueCapabilities?.startDate === true, canCreateIssue: false });
    if (!first) { await capabilitiesTask; return; }
    const optionsVersion = ++this.projectOptionsVersion;
    await capabilitiesTask;
    const canCreateIssue = this.session.issueCapabilities?.createPermission ? await client.canCreateIssue(first.path_with_namespace).catch(() => false) : false;
    if (version !== this.navigationVersion || signal.aborted || optionsVersion !== this.projectOptionsVersion || this.mode !== 'create') return;
    const options = this.lastSnapshot?.type === 'createData' ? this.lastSnapshot.options ?? emptyFormOptions() : emptyFormOptions();
    this.post({ type: 'projectData', projectId: first.id, options, optionsLoading: false, preserveDraft: true,
      canSetStartDate: this.session.issueCapabilities?.startDate === true, canCreateIssue });
  }

  private async readCreationProjects(query: string, mode?: 'next', queryIdentity?: string, force = false) {
    const group = this.session.selectedGroup;
    if (!group || this.mode !== 'create') throw new IssueValidationError('Select a GitLab group first.');
    query = query.trim();
    if (query.length > 200) throw new IssueValidationError('搜尋內容不可超過 200 個字元。');
    const scope = JSON.stringify([this.session.connectionEpoch, this.session.baseUrl, group.id]);
    if (scope !== this.creationProjectScope) { this.creationProjects.clear(); this.creationProjectScope = scope; }
    const page = await this.pageStore.load('create-projects', `group/${group.id}/project-search/${issueQueryDigest(query)}`, query,
      (client, cursor) => query ? typeof client.searchGroupProjectsPage === 'function' ? client.searchGroupProjectsPage(group.id, query, cursor) : client.listGroupProjects(group.id)
        : typeof client.listGroupProjectsPage === 'function' ? client.listGroupProjectsPage(group.id, cursor) : client.listGroupProjects(group.id),
      { signal: this.navigationReadController?.signal, next: mode === 'next', queryIdentity, force,
        ...(!query ? { firstKey: groupProjectsPageReadKey(group.id) } : {}) });
    const selected = this.lastSnapshot?.type === 'createData' ? this.creationProjects.get(this.lastSnapshot.selectedProjectId ?? 0) : undefined;
    this.creationProjects.clear();
    if (selected) this.creationProjects.set(selected.id, selected);
    for (const project of page.items) this.creationProjects.set(project.id, project);
    return page;
  }

  /** Only a project returned by this Group's Host-owned picker can be selected. */
  private async resolveCreationProject(projectId: number, signal?: AbortSignal, fresh = false): Promise<GitLabProject> {
    const group = this.session.selectedGroup;
    const scope = JSON.stringify([this.session.connectionEpoch, this.session.baseUrl, group?.id]);
    const known = scope === this.creationProjectScope ? this.creationProjects.get(projectId) : undefined;
    if (!group || !known) throw new IssueValidationError('Project is outside the selected group.');
    if (!fresh) return known;
    const client = (await this.session.getClient());
    const project = await (signal ? client.withReadSignal(signal) : client).getProject(projectId);
    if (signal?.aborted || scope !== JSON.stringify([this.session.connectionEpoch, this.session.baseUrl, this.session.selectedGroup?.id])) {
      throw Object.assign(new Error('The creation project changed.'), { name: 'AbortError' });
    }
    if (project.id !== projectId || !group.full_path || !project.path_with_namespace.startsWith(group.full_path + '/')) {
      throw new IssueValidationError('Project is outside the selected group.');
    }
    this.creationProjects.set(projectId, project);
    return project;
  }

  private async searchPage(request: Extract<IssuePanelRequest, { type: 'search' | 'searchProjects' }>): Promise<void> {
    const requestId = requiredString(request.requestId, 'Request ID');
    const query = typeof request.query === 'string' ? request.query.trim() : '';
    if (query.length > 200) throw new IssueValidationError('搜尋內容不可超過 200 個字元。');
    const signal = this.navigationReadController?.signal;
    const version = this.navigationVersion, epoch = this.session.connectionEpoch;
    try {
      if (request.type === 'searchProjects' && (this.mode !== 'detail' || !this.issue)) throw new IssueValidationError('Open an issue first.');
      const projectId = request.type === 'search' ? requiredId(request.projectId, 'Project') : undefined;
      const prefix = projectId !== undefined ? `project/${projectId}/issue-search/${issueQueryDigest(query)}` : `member-project-search/${issueQueryDigest(query)}`;
      if (!query) {
        this.post({ type: 'reply', requestId, result: { items: [], query, queryIdentity: issueQueryDigest(prefix), complete: true, updatedAt: new Date().toISOString() } });
        return;
      }
      if (projectId !== undefined && this.issue?.project_id !== projectId) await this.resolveCreationProject(projectId, signal);
      const page = await this.pageStore.load<GitLabIssue | GitLabProject>(request.type, prefix, query, (client, cursor) => projectId !== undefined
        ? typeof client.searchProjectIssuesPage === 'function' ? client.searchProjectIssuesPage(projectId, query, cursor) : client.searchProjectIssues(projectId, query)
        : typeof client.searchMemberProjectsPage === 'function' ? client.searchMemberProjectsPage(query, cursor) : client.searchMemberProjects(query),
      { signal, next: request.mode === 'next', queryIdentity: request.queryIdentity });
      if (signal?.aborted || version !== this.navigationVersion || epoch !== this.session.connectionEpoch || this.suspended) {
        throw Object.assign(new Error('The Issue search is no longer visible.'), { name: 'AbortError' });
      }
      this.post({ type: 'reply', requestId, result: page });
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') throw error;
      if (!signal?.aborted && version === this.navigationVersion && epoch === this.session.connectionEpoch && !this.suspended) this.post({ type: 'reply', requestId, error: safeError(error) });
    }
  }

  private async formOptions(projectId: number, signal?: AbortSignal, forceNetwork = false): Promise<IssueFormOptions> {
    const results = await Promise.allSettled([
      this.session.cachedRead(`project/${projectId}/members`, (client) => client.listProjectMembers(projectId), { signal, force: forceNetwork }),
      this.session.cachedRead(`project/${projectId}/labels`, (client) => client.listProjectLabels(projectId), { signal, force: forceNetwork }),
      this.session.cachedRead(`project/${projectId}/milestones`, (client) => client.listProjectMilestones(projectId), { signal, force: forceNetwork })
    ] as const);
    const labels = ['members', 'labels', 'milestones'];
    const warnings = results.flatMap((result, index) => result.status === 'rejected' ? [`Could not load ${labels[index]}: ${safeError(result.reason)}`] : []);
    const value = <T,>(index: number): T[] => results[index].status === 'fulfilled' ? results[index].value as T[] : [];
    return {
      members: [...value<GitLabMember>(0)], labels: [...value<GitLabLabel>(1)],
      milestones: [...value<GitLabMilestone>(2)], templates: [], warnings,
      states: { fields: { status: warnings.length ? 'error' : 'ready', error: warnings.length ? warnings.join(' ') : undefined }, templates: { status: 'idle' } }
    };
  }

  private async loadCreateFormOptions(projectId: number, section: IssueFormOptionSection, mode?: 'next'): Promise<void> {
    const creation = this.mode === 'create' && this.lastSnapshot?.type === 'createData' && this.lastSnapshot.selectedProjectId === projectId;
    const detail = this.mode === 'detail' && this.lastSnapshot?.type === 'detailData' && this.lastSnapshot.data.issue.project_id === projectId;
    if (!creation && !detail) {
      throw new IssueValidationError('The selected creation project changed.');
    }
    if (!['fields', 'members', 'labels', 'milestones', 'templates'].includes(section) || detail && section === 'templates') throw new IssueValidationError('Invalid form options section.');
    const version = this.navigationVersion, optionsVersion = this.projectOptionsVersion;
    const signal = creation ? this.createOptionsAbort?.signal : this.navigationReadController?.signal;
    const key = `${version}:${optionsVersion}:${projectId}:${section}:${mode ?? 'first'}`;
    const pending = this.formOptionsReads.get(key);
    if (pending) return pending;
    const getOptions = (): IssueFormOptions => this.lastSnapshot?.type === 'createData' ? this.lastSnapshot.options ?? emptyFormOptions()
      : this.lastSnapshot?.type === 'detailData' ? this.lastSnapshot.data.options : emptyFormOptions();
    const force = getOptions().states?.[section]?.status === 'error';
    const current = () => !signal?.aborted && version === this.navigationVersion && optionsVersion === this.projectOptionsVersion &&
      (creation ? this.mode === 'create' && this.lastSnapshot?.type === 'createData' && this.lastSnapshot.selectedProjectId === projectId
        : this.mode === 'detail' && this.lastSnapshot?.type === 'detailData' && this.lastSnapshot.data.issue.project_id === projectId);
    const publish = (state: IssueReadState, value?: Partial<IssueFormOptions>): void => {
      if (!current()) return;
      const previous = getOptions();
      const options = { ...previous, ...value, states: { ...previous.states, [section]: state } };
      if (this.lastSnapshot?.type === 'createData') this.post({ type: 'projectData', projectId, preserveDraft: true,
        canCreateIssue: this.lastSnapshot.canCreateIssue, options, optionsLoading: false });
      else if (this.lastSnapshot?.type === 'detailData') this.post({ type: 'detailPatch', issueId: this.lastSnapshot.data.issue.id, patch: { options } });
    };
    publish({ ...getOptions().states?.[section], status: 'loading', error: undefined });
    const task = (async () => {
      try {
        if (section === 'members' || section === 'labels' || section === 'milestones') {
          const page = await this.pageStore.load<GitLabMember | GitLabLabel | GitLabMilestone>(`options:${projectId}:${section}`, `project/${projectId}/${section}`, '',
            (client, cursor) => section === 'members'
              ? typeof client.listProjectMembersPage === 'function' ? client.listProjectMembersPage(projectId, cursor) : client.listProjectMembers(projectId)
              : section === 'labels'
                ? typeof client.listProjectLabelsPage === 'function' ? client.listProjectLabelsPage(projectId, cursor) : client.listProjectLabels(projectId)
                : typeof client.listProjectMilestonesPage === 'function' ? client.listProjectMilestonesPage(projectId, cursor) : client.listProjectMilestones(projectId),
            { signal, force, next: mode === 'next' });
          publish({ status: 'ready', complete: page.complete, loadedCount: page.items.length, updatedAt: page.updatedAt }, { [section]: page.items });
          return;
        }
        const options = section === 'fields' ? await this.formOptions(projectId, signal, force) : {
          templates: await this.session.cachedRead(`project/${projectId}/template-names`, async client => typeof client.listProjectIssueTemplateNames === 'function'
            ? (await client.listProjectIssueTemplateNames(projectId)).map(template => ({ ...template, content: '', loaded: false }))
            : client.listProjectIssueTemplates(projectId), { signal, force })
        };
        const warnings = section === 'fields' ? (options as IssueFormOptions).warnings : undefined;
        if (warnings?.length) {
          const action = this.actionContext.getStore(); if (action) { action.status = 'failed'; action.error = warnings.join(' '); }
        }
        const value: Partial<IssueFormOptions> = section === 'fields'
          ? { members: (options as IssueFormOptions).members, labels: (options as IssueFormOptions).labels,
            milestones: (options as IssueFormOptions).milestones, warnings }
          : { templates: options.templates };
        publish(warnings?.length ? { status: 'error', error: warnings.join(' ') } : { status: 'ready' }, value);
      } catch (error) {
        if (!current()) return;
        const message = safeError(error), action = this.actionContext.getStore();
        if (action) { action.status = 'failed'; action.error = message; }
        publish({ status: 'error', error: message });
      }
    })();
    this.formOptionsReads.set(key, task);
    void task.finally(() => { if (this.formOptionsReads.get(key) === task) this.formOptionsReads.delete(key); }).catch(() => undefined);
    return task;
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

  private async loadDetail(version: number, signal: AbortSignal, forceNetwork: boolean, restoredData?: IssueDetailData): Promise<void> {
    const seed = this.issue;
    if (!seed) return;
    const client = (await this.session.getClient()).withReadSignal(signal);
    const [issue, project, user] = await Promise.all([
      this.session.cachedRead(`project/${seed.project_id}/issue/${seed.iid}`, readClient => readClient.getIssue(seed.project_id, seed.iid), { signal, force: forceNetwork }),
      this.session.cachedRead(`project/${seed.project_id}/details`, readClient => readClient.getProject(seed.project_id), { signal, force: forceNetwork }),
      this.session.cachedRead('current-user', readClient => readClient.getCurrentUser(), { signal, force: forceNetwork })
    ]);
    if (version !== this.navigationVersion || signal.aborted) return;
    this.issue = issue;
    const group = this.session.selectedGroup;
    const sectionNames: IssueDetailSection[] = ['options', 'activity', 'links', 'mergeRequests', 'reactions', 'todos', 'tasks', 'permissions', 'projects', 'dates', 'timelogs'];
    const sections = Object.fromEntries(sectionNames.map((name) => [name, 'idle'])) as Record<IssueDetailSection, IssueDetailSectionStatus>;
    let data: IssueDetailData = restoredData ? { ...restoredData, issue, project, user } : {
      issue, project, projects: [project], user, metadata: this.session.metadata,
      options: emptyFormOptions(),
      discussions: [], links: [], mergeRequests: [], reactions: [], noteReactions: {}, noteReactionStates: {}, todos: [], tasks: [], timelogs: [],
      startDate: issue.start_date ?? null, startDateSupported: false,
      warnings: [], notices: [], loadErrors: {}, sections,
      canEdit: false, canDelete: false, canMove: false, canClone: false, canComment: false, canInternalComment: false,
      canLink: false, canManageChildren: false, canTrackTime: false, canResolveThreads: false, canSetStartDate: false,
      hasStartDate: !!issue.start_date, canLogTime: false, canDeleteTimelog: false
    };
    if (this.operationWarning) { data.notices?.push(this.operationWarning); this.operationWarning = undefined; }
    this.post({ type: 'detailData', data });
    const capabilitiesTask = this.session.ensureInstanceChecked();
    void capabilitiesTask.catch(() => {});
    const current = (): boolean => version === this.navigationVersion && !signal.aborted && this.navigationReadController?.signal === signal;
    const patch = (section: IssueDetailSection, value: Partial<IssueDetailData>, status: IssueDetailSectionStatus = value.sections?.[section] ?? 'ready', warning?: string): void => {
      if (!current()) return;
      const nextSections = { ...(data.sections ?? {}), ...(value.sections ?? {}), [section]: status };
      const loadErrors = { ...(data.loadErrors ?? {}), ...(value.loadErrors ?? {}) };
      if (warning) loadErrors[section] = warning;
      else if (status === 'ready') delete loadErrors[section];
      const next: Partial<IssueDetailData> = { ...value, sections: nextSections, loadErrors };
      data = { ...data, ...next, noteReactions: { ...data.noteReactions, ...next.noteReactions },
        noteReactionStates: { ...data.noteReactionStates, ...next.noteReactionStates } };
      if (section === 'permissions' || section === 'dates') {
        next.canSetStartDate = this.session.issueCapabilities?.startDate === true && data.startDateSupported === true && data.canEdit;
        data = { ...data, canSetStartDate: next.canSetStartDate };
      }
      this.post({ type: 'detailPatch', issueId: issue.id, patch: next });
    };
    const loaders: Partial<Record<IssueDetailSection, (force?: boolean) => Promise<Partial<IssueDetailData>>>> = {};
    const running = new Map<IssueDetailSection, Promise<void>>();
    const noteReads = new Map<number, Promise<void>>();
    loaders.options = async () => {
      const fields = await this.formOptions(issue.project_id, signal, forceNetwork);
      fields.members = [...fields.members]; fields.labels = [...fields.labels]; fields.milestones = [...fields.milestones];
      for (const assignee of issue.assignees ?? []) if (!fields.members.some((member) => member.id === assignee.id)) fields.members.push(assignee);
      if (issue.milestone && !fields.milestones.some((milestone) => milestone.id === issue.milestone?.id)) fields.milestones.push(issue.milestone);
      for (const label of issue.labels ?? []) if (!fields.labels.some((item) => item.name === label)) fields.labels.push({ id: -fields.labels.length - 1, name: label, color: '#888888' });
      return { options: fields };
    };
    loaders.activity = async () => ({ discussions: await client.listIssueDiscussions(issue.project_id, issue.iid) });
    loaders.reactions = async force => ({ reactions: await this.session.cachedRead(
      `project/${issue.project_id}/issue/${issue.iid}/reactions`, readClient => readClient.listIssueReactions(issue.project_id, issue.iid),
      { signal, force: forceNetwork || force }) });
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
    const runSection = async (section: IssueDetailSection, force = false): Promise<void> => {
      if (!current()) return;
      const status = data.sections?.[section];
      if (!force && (status === 'ready' || status === 'unsupported')) return;
      const active = running.get(section);
      if (active) { if (!force) return active; await active; if (!current()) return; }
      const loader = loaders[section];
      if (!loader) return;
      const action = this.actionContext.getStore();
      const failed = (message: string): void => {
        if (!action) return;
        if (action.effect === 'applied' || action.effect === 'partial') action.refreshError = message;
        else { action.status = 'failed'; action.error = message; }
      };
      data = { ...data, sections: { ...(data.sections ?? {}), [section]: 'loading' } };
      this.post({ type: 'detailPatch', issueId: issue.id, patch: { sections: data.sections } });
      const task = (async (): Promise<void> => {
        try {
          const value = await loader(force || status === 'error');
          if (!current()) return;
          const optionErrors = section === 'options' ? value.options?.warnings : undefined;
          const loadWarning = value.loadErrors?.[section] ?? (optionErrors?.length ? optionErrors.join(' ') : undefined);
          const nextStatus = value.sections?.[section] ?? (loadWarning ? 'error' : 'ready');
          if (nextStatus === 'error' && loadWarning) failed(loadWarning);
          patch(section, value, nextStatus, loadWarning);
        } catch (error) {
          if (!current()) return;
          const message = `Could not load ${section === 'options' ? 'fields' : section === 'mergeRequests' ? 'merge requests' : section === 'timelogs' ? 'time entries' : section === 'dates' ? 'start date' : section === 'tasks' ? 'child tasks' : section === 'todos' ? 'to-dos' : section}` + `: ${safeError(error)}`;
          failed(message);
          patch(section, {}, 'error', message);
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
      await Promise.all(requested.map((section) => runSection(section, force)));
    };
    this.noteReactionLoader = async (noteId, force = false) => {
      if (!current()) return;
      if (!data.discussions.some(discussion => discussion.notes.some(note => note.id === noteId && !note.system))) {
        throw new IssueValidationError('Comment is not part of this issue.');
      }
      const pending = noteReads.get(noteId);
      if (pending) { if (!force) return pending; await pending; if (!current()) return; }
      const retry = data.noteReactionStates?.[noteId]?.status === 'error';
      patch('activity', { noteReactionStates: { [noteId]: { status: 'loading' } } }, data.sections?.activity ?? 'ready');
      const task = (async () => {
        try {
          const reactions = await this.session.cachedRead(`project/${issue.project_id}/issue/${issue.iid}/notes/${noteId}/reactions`,
            readClient => readClient.listIssueNoteReactions(issue.project_id, issue.iid, noteId), { signal, force: forceNetwork || force || retry });
          if (current()) patch('activity', { noteReactions: { [noteId]: reactions }, noteReactionStates: { [noteId]: { status: 'ready' } } }, data.sections?.activity ?? 'ready');
        } catch (error) {
          if (!current()) return;
          const message = safeError(error), action = this.actionContext.getStore();
          if (action?.effect === 'applied') action.refreshError = message;
          else if (action) { action.status = 'failed'; action.error = message; }
          patch('activity', { noteReactionStates: { [noteId]: { status: 'error', error: message } } }, data.sections?.activity ?? 'ready');
        }
      })();
      noteReads.set(noteId, task);
      void task.finally(() => { if (noteReads.get(noteId) === task) noteReads.delete(noteId); }).catch(() => undefined);
      return task;
    };
    void this.detailSectionLoader(['activity', 'permissions', 'dates']);
  }

  private async handleRequestBody(request: IssuePanelRequest): Promise<void> {
    if (request.type === 'loadTemplate') {
      const requestId = requiredString(request.requestId, 'Request ID');
      const projectId = requiredId(request.projectId, 'Project');
      const key = requiredString(request.key, 'Template key');
      const version = this.navigationVersion;
      this.templateAbort?.abort(); const controller = new AbortController(); this.templateAbort = controller;
      try {
        const group = this.session.selectedGroup;
        if (!group) throw new IssueValidationError('Select a GitLab group first.');
        await this.resolveCreationProject(projectId, controller.signal);
        const result = await this.session.cachedRead(`project/${projectId}/template/${encodeURIComponent(key)}`,
          client => client.getProjectIssueTemplate(projectId, key), { signal: controller.signal });
        if (version === this.navigationVersion && !controller.signal.aborted) this.post({ type: 'reply', requestId, result });
      } catch (error) {
        if (controller.signal.aborted) { const action = this.actionContext.getStore(); if (action) action.status = 'cancelled'; }
        else this.post({ type: 'reply', requestId, error: safeError(error) });
      } finally { if (this.templateAbort === controller) this.templateAbort = undefined; }
      return;
    }
    if (request.type === 'refresh') return this.load(true);
    if (request.type === 'loadSection') {
      const valid = (Array.isArray(request.sections) ? request.sections : []).filter((section): section is IssueDetailSection =>
        ['options', 'activity', 'links', 'mergeRequests', 'reactions', 'todos', 'tasks', 'permissions', 'projects', 'dates', 'timelogs'].includes(section));
      await this.detailSectionLoader?.([...new Set(valid)]);
      return;
    }
    if (request.type === 'loadFormOptions') return this.loadCreateFormOptions(requiredId(request.projectId, 'Project'), request.section, request.mode);
    if (request.type === 'loadCreateProjects') {
      const page = await this.readCreationProjects(request.query ?? '', request.mode, request.queryIdentity);
      this.post({ type: 'createProjectsPage', page });
      return;
    }
    if (request.type === 'loadNoteReactions') {
      if (!this.noteReactionLoader || this.mode !== 'detail') throw new IssueValidationError('Open an issue first.');
      return this.noteReactionLoader(requiredId(request.noteId, 'Comment'));
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
        this.post({ type: 'reply', requestId, error: safeError(error), notificationOnly: true });
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
    if (request.type === 'search' || request.type === 'searchProjects') return this.searchPage(request);
    const readVersion = this.navigationVersion, readEpoch = this.session.connectionEpoch;
    const readGroup = this.session.selectedGroup;
    const readSignal = this.navigationReadController?.signal;
    const cachedPreviewRead = request.type === 'preview';
    const currentRead = () => {
      const current = readVersion === this.navigationVersion && readEpoch === this.session.connectionEpoch &&
        readGroup?.id === this.session.selectedGroup?.id && !readSignal?.aborted && !this.suspended;
      if (!current) { const action = this.actionContext.getStore(); if (action) action.status = 'cancelled'; }
      return current;
    };
    const baseClient = await this.session.getClient();
    if (cachedPreviewRead && !currentRead()) return;
    let client = ['selectProject', 'searchProjects', 'preview', 'search', 'image'].includes(request.type) && readSignal
      ? baseClient.withReadSignal(readSignal) : baseClient;
    if (request.type === 'selectProject') {
      this.pageStore.cancel();
      this.templateAbort?.abort();
      this.createOptionsAbort?.abort(); this.createOptionsAbort = new AbortController(); this.formOptionsReads.clear();
      const version = this.navigationVersion;
      const optionsVersion = ++this.projectOptionsVersion;
      const projectId = requiredId(request.projectId, 'Project');
      const group = this.session.selectedGroup;
      const project = group ? await this.resolveCreationProject(projectId, readSignal) : undefined;
      if (!project) throw new Error('Project is outside the selected group.');
      if (version !== this.navigationVersion || this.mode !== 'create' || optionsVersion !== this.projectOptionsVersion) return;
      this.post({ type: 'projectData', projectId, options: emptyFormOptions(), optionsLoading: false, canCreateIssue: false });
      const permissionClient = this.createOptionsAbort ? client.withReadSignal(this.createOptionsAbort.signal) : client;
      const canCreateIssue = this.session.issueCapabilities?.createPermission ? await permissionClient.canCreateIssue(project.path_with_namespace).catch(() => false) : false;
      if (version !== this.navigationVersion || this.mode !== 'create' || optionsVersion !== this.projectOptionsVersion) return;
      const options = this.lastSnapshot?.type === 'createData' ? this.lastSnapshot.options ?? emptyFormOptions() : emptyFormOptions();
      this.post({ type: 'projectData', projectId, options, preserveDraft: true, canCreateIssue });
      return;
    }
    if (request.type === 'create') {
      const projectId = requiredId(request.projectId, 'Project');
      const group = this.session.selectedGroup;
      const project = group ? await this.resolveCreationProject(projectId, undefined, true) : undefined;
      if (!project) throw new Error('Project is outside the selected group.');
      if (!this.session.issueCapabilities?.createPermission || !await client.canCreateIssue(project.path_with_namespace)) throw new Error('You cannot create issues in this project.');
      const created = await this.write(() => client.createIssue(projectId, createInput(request.input)));
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
            const scopedClient = client.withWriteScope?.({ projectId, issueIid: created.iid, resource: 'issues' }) ?? client;
            await this.write(() => scopedClient.setIssueStartDate(workItemId, startDate));
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
    if (request.type === 'preview' || request.type === 'upload') {
      const projectId = requiredId(request.projectId, 'Project');
      const requestId = requiredString(request.requestId, 'Request ID');
      const group = cachedPreviewRead ? readGroup : this.session.selectedGroup;
      const allowed = this.issue?.project_id === projectId || (group && this.mode === 'create' && !!await this.resolveCreationProject(projectId, readSignal, request.type === 'upload'));
      if (cachedPreviewRead && !currentRead()) return;
      if (!allowed) throw new Error('Project is outside the selected group.');
      try {
        let result: unknown;
        if (request.type === 'preview') {
          const project = await this.session.cachedRead(`project/${projectId}/details`, readClient => readClient.getProject(projectId), { signal: readSignal });
          if (!currentRead()) return;
          result = await client.renderMarkdown(project.path_with_namespace, request.markdown);
        } else {
          const file = await vscode.window.showOpenDialog({ canSelectMany: false, canSelectFolders: false, openLabel: 'Attach to GitLab Issue' });
          if (!file?.[0] || file[0].scheme !== 'file') { result = null; const context = this.actionContext.getStore(); if (context) context.status = 'cancelled'; }
          else {
            const controller = new AbortController();
            this.uploads.set(requestId, controller);
            const info = await stat(file[0].fsPath);
            if (!info.isFile() || info.size > 50 * 1024 * 1024) throw new IssueValidationError('附件必須是一般檔案，且不可超過 50 MB。');
            controller.signal.throwIfAborted();
            const name = file[0].path.split('/').at(-1) ?? 'attachment';
            const type = /\.png$/i.test(name) ? 'image/png' : /\.jpe?g$/i.test(name) ? 'image/jpeg' : /\.gif$/i.test(name) ? 'image/gif' : 'application/octet-stream';
            const stream = createReadStream(file[0].fsPath, { signal: controller.signal });
            try { result = await this.write(() => client.uploadProjectFileStream(projectId, name, stream, type, info.size, controller.signal)); }
            finally { stream.destroy(); this.uploads.delete(requestId); }
          }
        }
        if (!cachedPreviewRead || currentRead()) this.post({ type: 'reply', requestId, result });
      } catch (error) {
        if (cachedPreviewRead && !currentRead()) return;
        this.uploads.delete(requestId);
        if (error instanceof Error && error.name === 'AbortError') {
          const context = this.actionContext.getStore();
          if (context && !context.writeStarted) {
            context.status = 'cancelled'; this.post({ type: 'reply', requestId, result: null }); return;
          }
        }
        this.post({ type: 'reply', requestId, error: safeError(error), notificationOnly: request.type === 'upload' });
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
    client = baseClient.withWriteScope?.({ projectId, issueIid: iid, resource: 'issues' }) ?? baseClient;
    const snapshot = this.lastSnapshot?.type === 'detailData' && this.lastSnapshot.data.issue.id === issue.id ? this.lastSnapshot.data : undefined;
    if (request.type === 'update') {
      if (!snapshot?.canEdit) throw new Error('GitLab does not report permission to edit this Issue.');
      const input = updateInput(request.input);
      await this.write(() => client.updateIssueIfUnchanged(projectId, iid, request.expectedUpdatedAt, input));
      const currentDate = this.lastSnapshot?.type === 'detailData' ? this.lastSnapshot.data.startDate : undefined;
      if (input.startDate !== undefined && input.startDate !== currentDate) {
        if (!this.session.issueCapabilities?.startDate) this.operationWarning = 'Issue 欄位已儲存，但此 GitLab 版本沒有原生 Issue 開始日期欄位。';
        else if (snapshot?.startDateSupported !== true) this.operationWarning = 'Issue 欄位已儲存，但這個 Issue 類型沒有可用的開始日期 Widget。';
        else {
          try {
            const project = await client.getProject(projectId);
            const workItemId = await client.getWorkItemId(project.path_with_namespace, iid, this.session.issueCapabilities?.workItemScope);
            if (!workItemId) throw new Error('GitLab did not return the Work Item ID.');
            await this.write(() => client.setIssueStartDate(workItemId, input.startDate ?? null));
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
        await this.write(() => client.updateIssueIfUnchanged(projectId, iid, issue.updated_at, { stateEvent: request.action as 'close' | 'reopen' })); break;
      case 'subscribe': await this.write(() => client.subscribeToIssue(projectId, iid)); break;
      case 'unsubscribe': await this.write(() => client.unsubscribeFromIssue(projectId, iid)); break;
      case 'todo': await this.write(() => client.createIssueTodo(projectId, iid)); break;
      case 'todoDone': await this.write(() => client.markTodoDone(requiredId(payload.todoId, 'To-do'))); break;
      case 'note':
        if (!snapshot?.canComment) throw new Error('GitLab does not report permission to comment on this Issue.');
        if (payload.internal === true && !snapshot?.canInternalComment) throw new Error('You cannot post internal comments on this issue.');
        await this.write(() => client.addIssueNote(projectId, iid, requiredString(payload.body, 'Comment'), payload.internal === true)); break;
      case 'editNote': await this.write(() => client.updateIssueNote(projectId, iid, requiredString(payload.discussionId, 'Thread'), requiredId(payload.noteId, 'Comment'), requiredString(payload.body, 'Comment'))); break;
      case 'deleteNote': await this.write(() => client.deleteIssueNote(projectId, iid, requiredString(payload.discussionId, 'Thread'), requiredId(payload.noteId, 'Comment'))); break;
      case 'thread':
        if (!snapshot?.canComment) throw new Error('GitLab does not report permission to comment on this Issue.');
        if (payload.internal === true) throw new Error('GitLab cannot create an internal issue thread. Use an internal comment.');
        await this.write(() => client.createIssueThread(projectId, iid, requiredString(payload.body, 'Thread'))); break;
      case 'reply':
        if (!snapshot?.canComment) throw new Error('GitLab does not report permission to comment on this Issue.');
        await this.write(() => client.replyToIssueThread(projectId, iid, requiredString(payload.discussionId, 'Thread'), requiredString(payload.body, 'Reply'))); break;
      case 'resolveThread': {
        if (!this.session.issueCapabilities?.discussionResolve) throw new Error('This GitLab instance does not expose discussion resolution.');
        const discussionId = requiredString(payload.discussionId, 'Thread');
        const discussionClient = snapshot?.discussions?.some(discussion => discussion.id === discussionId) ? client : baseClient;
        await this.write(() => discussionClient.resolveIssueThread(discussionId, payload.resolved === true)); break;
      }
      case 'react': case 'unreact': {
        const reload = this.detailSectionLoader;
        if (request.action === 'react') await this.write(() => client.addIssueReaction(projectId, iid, requiredString(payload.name, 'Emoji')));
        else await this.write(() => client.removeIssueReaction(projectId, iid, requiredId(payload.reactionId, 'Reaction')));
        await reload?.(['reactions'], true);
        return;
      }
      case 'reactNote': case 'unreactNote': {
        const noteId = requiredId(payload.noteId, 'Comment');
        if (!snapshot?.discussions.some((discussion) => discussion.notes.some((note) => note.id === noteId && !note.system))) throw new Error('Comment is not part of this issue.');
        const reload = this.noteReactionLoader;
        if (request.action === 'reactNote') await this.write(() => client.addIssueNoteReaction(projectId, iid, noteId, requiredString(payload.name, 'Emoji')));
        else {
          const reactionId = requiredId(payload.reactionId, 'Reaction');
          if (!snapshot.noteReactions[noteId]?.some((reaction) => reaction.id === reactionId && reaction.user.id === snapshot.user.id)) throw new Error('Reaction is not yours.');
          await this.write(() => client.removeIssueNoteReaction(projectId, iid, noteId, reactionId));
        }
        await reload?.(noteId, true);
        return;
      }
      case 'link': {
        if (!snapshot?.canLink) throw new Error('GitLab does not report permission to link Issues.');
        const linkType = payload.linkType === 'blocks' || payload.linkType === 'is_blocked_by' ? payload.linkType : 'relates_to';
        if (linkType !== 'relates_to' && this.session.capabilityDiagnostics.find((item) => item.id === 'blockingLinks')?.status !== 'supported') {
          throw new Error(this.session.capabilityDiagnostics.find((item) => item.id === 'blockingLinks')?.reason ?? '尚未確認此 GitLab 方案是否支援阻擋關聯。');
        }
        await this.write(() => client.addIssueLink(projectId, iid, requiredId(payload.targetProjectId, 'Project'), requiredId(payload.targetIssueIid, 'Issue'), linkType));
        break;
      }
      case 'unlink':
        if (!snapshot?.canLink) throw new Error('GitLab does not report permission to remove Issue links.');
        await this.write(() => client.removeIssueLink(projectId, iid, requiredId(payload.linkId, 'Link'))); break;
      case 'estimate':
        if (!snapshot?.canTrackTime) throw new Error('GitLab does not report permission to update this Issue time estimate.');
        await this.write(() => client.setTimeEstimate(projectId, iid, requiredString(payload.duration, 'Duration'))); break;
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
          await this.write(() => client.addIssueNote(projectId, iid, body));
        } else if (capabilities?.timelogCreate && (!summary?.trim() || capabilities.timelogCreateSummary === true)) {
          const spentAt = spentDate ? new Date(`${spentDate}T12:00:00`).toISOString() : undefined;
          await this.write(() => client.createIssueTimelog(issue.id, duration, summary, spentAt, capabilities.timelogCreateDated === true, capabilities.timelogCreateSummary === true));
        } else await this.write(() => client.addSpentTime(projectId, iid, duration, summary));
        break;
      }
      case 'deleteTimelog': {
        const id = requiredString(payload.timelogId, 'Time entry');
        if (!snapshot?.canDeleteTimelog || !this.session.issueCapabilities?.timelogDelete || !snapshot.timelogs.some((entry) => entry.id === id && entry.userPermissions?.adminTimelog)) throw new Error('You cannot delete this time entry.');
        const confirm = await vscode.window.showWarningMessage('Delete this time entry?', { modal: true }, 'Delete time entry');
        if (confirm !== 'Delete time entry') { this.post({ type: 'cancelled' }); return; }
        await this.write(() => client.deleteIssueTimelog(id));
        break;
      }
      case 'resetEstimate': {
        if (!snapshot?.canTrackTime) throw new Error('GitLab does not report permission to reset this Issue time estimate.');
        const confirm = await vscode.window.showWarningMessage('Reset this issue’s entire time estimate?', { modal: true }, 'Reset estimate');
        if (confirm !== 'Reset estimate') { this.post({ type: 'cancelled' }); return; }
        await this.write(() => client.resetTimeEstimate(projectId, iid)); break;
      }
      case 'resetSpent': {
        if (!snapshot?.canTrackTime) throw new Error('GitLab does not report permission to reset this Issue time.');
        const confirm = await vscode.window.showWarningMessage('Delete all time spent on this issue?', { modal: true }, 'Reset spent');
        if (confirm !== 'Reset spent') { this.post({ type: 'cancelled' }); return; }
        await this.write(() => client.resetSpentTime(projectId, iid)); break;
      }
      case 'createChild': {
        if (!snapshot?.canManageChildren) throw new Error('GitLab does not report permission to manage child tasks.');
        if (!snapshot?.parentWorkItemId || !snapshot.taskTypeId) throw new Error('This GitLab instance did not expose child task creation.');
        const parentWorkItemId = snapshot.parentWorkItemId, taskTypeId = snapshot.taskTypeId;
        await this.write(() => client.createChildTask(snapshot.project.path_with_namespace, parentWorkItemId, taskTypeId, requiredString(payload.title, 'Task title'), this.session.issueCapabilities?.workItemCreatePathField));
        break;
      }
      case 'addChild': {
        if (!snapshot?.canManageChildren) throw new Error('GitLab does not report permission to manage child tasks.');
        if (!snapshot?.parentWorkItemId) throw new Error('This GitLab instance did not expose child tasks.');
        await this.addChild(client, snapshot.project.path_with_namespace, iid, payload.taskIid, snapshot.parentWorkItemId, snapshot.tasks);
        break;
      }
      case 'removeChild': case 'setChildState': {
        const id = requiredString(payload.taskId, 'Task');
        if (!snapshot?.tasks.some((task) => task.id === id)) throw new Error('Task is not a child of this issue.');
        // Hierarchy children can belong to other projects; their opaque IDs do not establish a write scope.
        if (request.action === 'removeChild') await this.write(() => baseClient.setChildParent(id, null));
        else await this.write(() => baseClient.setChildState(id, payload.stateEvent === 'reopen' ? 'reopen' : 'close'));
        break;
      }
      case 'updateChild': {
        const id = requiredString(payload.taskId, 'Task');
        if (!snapshot?.tasks.some((task) => task.id === id && task.canEdit)) throw new Error('You cannot edit this child task.');
        await this.write(() => baseClient.updateChildTask(id, requiredString(payload.title, 'Task title').trim(), optionalString(payload.description) ?? ''));
        break;
      }
      case 'move': {
        if (!snapshot?.canMove) throw new Error('GitLab does not report permission to move this Issue.');
        const target = requiredId(payload.toProjectId, 'Target project');
        const confirm = await vscode.window.showWarningMessage(`Move issue #${iid} to project ${target}? GitLab closes the original issue.`, { modal: true }, 'Move');
        if (confirm !== 'Move') { this.post({ type: 'cancelled' }); return; }
        this.issue = await this.write(() => client.moveIssue(projectId, iid, target));
        this.navigationVersion++;
        this.refreshIssues();
        return this.load();
      }
      case 'clone': {
        if (!snapshot?.canClone) throw new Error('GitLab does not report permission to clone this Issue.');
        const target = requiredId(payload.toProjectId, 'Target project');
        this.issue = await this.write(() => client.cloneIssue(projectId, iid, target, payload.withNotes === true));
        this.navigationVersion++;
        this.refreshIssues();
        return this.load();
      }
      case 'delete': {
        if (!snapshot?.canDelete) throw new Error('GitLab does not report permission to delete this Issue.');
        const confirm = await vscode.window.showWarningMessage(`Permanently delete issue #${iid}?`, { modal: true }, 'Delete Issue');
        if (confirm !== 'Delete Issue') { this.post({ type: 'cancelled' }); return; }
        await this.write(() => client.deleteIssue(projectId, iid));
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
