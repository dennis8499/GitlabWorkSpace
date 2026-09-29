import * as vscode from 'vscode';
import { randomBytes } from 'node:crypto';
import { GitLabApiError, GitLabConflictError, type IssueCreateInput, type IssueUpdateInput } from '../api/gitLabClient';
import type { GitLabEmojiReaction, GitLabIssue, GitLabIssueDiscussion, GitLabProject } from '../api/types';
import type { GitLabSession } from '../connection/session';
import type { IssueDetailData, IssueFormOptions, IssuePanelRequest, IssuePanelResponse, IssueTask, IssueTimelog } from './protocol';

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
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(`${value}T12:00:00Z`))) throw new Error('Date must use YYYY-MM-DD.');
  return value;
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
  private panel?: vscode.WebviewPanel;
  private issue?: GitLabIssue;
  private loadingTask?: Promise<void>;
  private ready = false;
  private lastSnapshot?: IssuePanelResponse;
  private operationWarning?: string;
  private navigationVersion = 0;
  private mode: 'create' | 'detail' = 'create';
  private readonly disposables: vscode.Disposable[] = [];

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly session: GitLabSession,
    private readonly refreshIssues: () => void
  ) {}

  dispose(): void {
    this.close();
  }

  close(): void {
    this.navigationVersion++;
    this.panel?.dispose();
    this.panel = undefined;
    this.issue = undefined;
    this.ready = false;
    this.lastSnapshot = undefined;
    for (const disposable of this.disposables.splice(0)) disposable.dispose();
  }

  async showCreate(): Promise<void> {
    this.navigationVersion++;
    this.issue = undefined;
    this.mode = 'create';
    this.ensurePanel('Create GitLab Issue');
    await this.load();
  }

  async showIssue(issue: GitLabIssue): Promise<void> {
    this.navigationVersion++;
    this.issue = issue;
    this.mode = 'detail';
    this.ensurePanel(`Issue #${issue.iid}`);
    await this.load();
  }

  private ensurePanel(title: string): void {
    if (this.panel) {
      this.panel.title = title;
      this.panel.reveal();
      return;
    }
    const assetRoot = vscode.Uri.joinPath(this.context.extensionUri, 'resources', 'issue-webview');
    const panel = vscode.window.createWebviewPanel('gitlabWorkspace.issue', title, vscode.ViewColumn.Active, {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [assetRoot]
    });
    this.panel = panel;
    this.ready = false;
    this.lastSnapshot = undefined;
    const nonce = randomBytes(16).toString('base64');
    const script = panel.webview.asWebviewUri(vscode.Uri.joinPath(assetRoot, 'issue.js'));
    const style = panel.webview.asWebviewUri(vscode.Uri.joinPath(assetRoot, 'issue.css'));
    const baseUrl = this.session.baseUrl;
    const configuredUrl = baseUrl ? new URL(baseUrl) : undefined;
    const httpImageOrigin = configuredUrl?.protocol === 'http:' ? ` ${configuredUrl.origin}` : '';
    panel.webview.html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${panel.webview.cspSource} data: https:${httpImageOrigin}; style-src ${panel.webview.cspSource}; script-src 'nonce-${nonce}';"><link rel="stylesheet" href="${style}"></head><body><div id="app"></div><script nonce="${nonce}" type="module" src="${script}"></script></body></html>`;
    this.disposables.push(panel.webview.onDidReceiveMessage((message: unknown) => {
      void this.handle(message).catch((error: unknown) => this.post({ type: 'error', message: safeError(error) }));
    }));
    this.disposables.push(panel.onDidDispose(() => { if (this.panel === panel) { this.panel = undefined; this.ready = false; this.lastSnapshot = undefined; } }));
  }

  private post(message: IssuePanelResponse): void {
    if (!this.panel) return;
    if (message.type === 'createData' || message.type === 'detailData') this.lastSnapshot = message;
    if (!this.ready) return;
    void this.panel?.webview.postMessage(message);
  }

  private async load(): Promise<void> {
    if (this.loadingTask) {
      await this.loadingTask;
      return this.load();
    }
    const task = this.loadOnce();
    this.loadingTask = task;
    try { await task; }
    finally { this.loadingTask = undefined; }
  }

  private async loadOnce(): Promise<void> {
    const version = this.navigationVersion;
    this.post({ type: 'busy', value: true });
    try {
      if (this.mode === 'create') await this.loadCreate(version);
      else await this.loadDetail(version);
    } catch (error) {
      if (version === this.navigationVersion) this.post({ type: 'error', message: safeError(error) });
    } finally {
      if (version === this.navigationVersion) this.post({ type: 'busy', value: false });
    }
  }

  private async loadCreate(version: number): Promise<void> {
    const group = this.session.selectedGroup;
    if (!group) throw new Error('Select a GitLab group first.');
    const client = await this.session.getClient();
    await this.session.ensureInstanceChecked();
    const projects = await client.listGroupProjects(group.id);
    const first = projects[0];
    const options = first ? await this.formOptions(first.id) : undefined;
    const canCreateIssue = first && this.session.issueCapabilities?.createPermission ? await client.canCreateIssue(first.path_with_namespace).catch(() => false) : false;
    if (version !== this.navigationVersion) return;
    if (options) options.warnings = [...this.session.instanceWarnings, ...(options.warnings ?? [])];
    if (options && !canCreateIssue) options.warnings?.push('This account cannot create issues in the selected project, or its permission could not be verified.');
    this.post({ type: 'createData', projects, selectedProjectId: first?.id, options, metadata: this.session.metadata, canSetStartDate: this.session.issueCapabilities?.startDate === true, canCreateIssue });
  }

  private async formOptions(projectId: number): Promise<IssueFormOptions> {
    const client = await this.session.getClient();
    const results = await Promise.allSettled([
      client.listProjectMembers(projectId), client.listProjectLabels(projectId),
      client.listProjectMilestones(projectId), client.listProjectIssueTemplates(projectId)
    ] as const);
    const labels = ['members', 'labels', 'milestones', 'templates'];
    const warnings = results.flatMap((result, index) => result.status === 'rejected' ? [`Could not load ${labels[index]}: ${safeError(result.reason)}`] : []);
    const value = <T,>(index: number): T[] => results[index].status === 'fulfilled' ? results[index].value as T[] : [];
    return { members: value(0), labels: value(1), milestones: value(2), templates: value(3), warnings };
  }

  private async loadNoteReactions(projectId: number, iid: number, discussions: GitLabIssueDiscussion[]): Promise<{ reactions: Record<number, GitLabEmojiReaction[]>; failed: number }> {
    const client = await this.session.getClient();
    const ids = discussions.flatMap((discussion) => discussion.notes.filter((note) => !note.system).map((note) => note.id));
    const reactions: Record<number, GitLabEmojiReaction[]> = {};
    let failed = 0;
    for (let offset = 0; offset < ids.length; offset += 8) {
      const batch = ids.slice(offset, offset + 8);
      const results = await Promise.allSettled(batch.map((id) => client.listIssueNoteReactions(projectId, iid, id)));
      results.forEach((result, index) => {
        if (result.status === 'fulfilled') reactions[batch[index]] = result.value;
        else failed++;
      });
    }
    return { reactions, failed };
  }

  private async loadTasks(projectPath: string, iid: number): Promise<{ tasks: IssueTask[]; parentWorkItemId?: string; taskTypeId?: string; permissions?: { updateWorkItem: boolean; deleteWorkItem: boolean; moveWorkItem: boolean; cloneWorkItem: boolean; createNote: boolean; markNoteAsInternal: boolean; adminWorkItemLink: boolean; adminParentLink: boolean; setWorkItemMetadata: boolean } }> {
    const client = await this.session.getClient();
    const query = `query IssueTasks($path: ID!, $iid: String!, $after: String) { namespace(fullPath: $path) { workItem(iid: $iid) { id userPermissions { updateWorkItem deleteWorkItem moveWorkItem cloneWorkItem createNote markNoteAsInternal adminWorkItemLink adminParentLink setWorkItemMetadata } widgets { ... on WorkItemWidgetHierarchy { children(first: 100, after: $after) { nodes { id iid title description descriptionHtml state webUrl userPermissions { updateWorkItem } } pageInfo { hasNextPage endCursor } } } } } workItemTypes(name: TASK) { nodes { id name } } } }`;
    type TaskPage = { namespace?: { workItem?: { id: string; userPermissions?: { updateWorkItem: boolean; deleteWorkItem: boolean; moveWorkItem: boolean; cloneWorkItem: boolean; createNote: boolean; markNoteAsInternal: boolean; adminWorkItemLink: boolean; adminParentLink: boolean; setWorkItemMetadata: boolean }; widgets?: Array<{ children?: { nodes?: Array<IssueTask & { userPermissions?: { updateWorkItem: boolean } }>; pageInfo?: { hasNextPage: boolean; endCursor?: string | null } } }> }; workItemTypes?: { nodes?: Array<{ id: string; name: string }> } } };
    const tasks: IssueTask[] = [];
    const seen = new Set<string>();
    let after: string | null = null;
    let parentWorkItemId: string | undefined;
    let taskTypeId: string | undefined;
    let permissions: NonNullable<NonNullable<TaskPage['namespace']>['workItem']>['userPermissions'];
    for (let page = 0; page < 100; page++) {
      const data: TaskPage = await client.graphql<TaskPage>(query, { path: projectPath, iid: String(iid), after });
      const workItem: NonNullable<NonNullable<TaskPage['namespace']>['workItem']> | undefined = data.namespace?.workItem;
      parentWorkItemId = workItem?.id;
      taskTypeId = data.namespace?.workItemTypes?.nodes?.[0]?.id;
      permissions = workItem?.userPermissions;
      const connection: { nodes?: Array<IssueTask & { userPermissions?: { updateWorkItem: boolean } }>; pageInfo?: { hasNextPage: boolean; endCursor?: string | null } } | undefined = workItem?.widgets?.find((widget) => widget.children)?.children;
      for (const task of connection?.nodes ?? []) {
        tasks.push({ ...task, canEdit: this.session.issueCapabilities?.childMutations === true && task.userPermissions?.updateWorkItem === true });
      }
      if (!connection?.pageInfo?.hasNextPage) return { tasks, parentWorkItemId, taskTypeId, permissions };
      const cursor: string | null | undefined = connection.pageInfo.endCursor;
      if (!cursor || seen.has(cursor)) throw new Error('GitLab returned a repeated child task cursor.');
      seen.add(cursor);
      after = cursor;
    }
    throw new Error('GitLab returned too many child task pages to load safely.');
  }

  private async loadDetail(version: number): Promise<void> {
    const seed = this.issue;
    if (!seed) return;
    const client = await this.session.getClient();
    await this.session.ensureInstanceChecked();
    const [issue, project, user] = await Promise.all([
      client.getIssue(seed.project_id, seed.iid), client.getProject(seed.project_id), client.getCurrentUser()
    ]);
    if (version !== this.navigationVersion) return;
    this.issue = issue;
    const group = this.session.selectedGroup;
    const optional = await Promise.allSettled([
      this.formOptions(issue.project_id),
      client.listIssueDiscussions(issue.project_id, issue.iid),
      client.listIssueLinks(issue.project_id, issue.iid),
      client.listRelatedMergeRequests(issue.project_id, issue.iid),
      client.listIssueReactions(issue.project_id, issue.iid),
      client.listTodos(),
      this.session.issueCapabilities?.hierarchy ? this.loadTasks(project.path_with_namespace, issue.iid) : Promise.resolve({ tasks: [] as IssueTask[] }),
      group ? client.listGroupProjects(group.id) : Promise.resolve([project]),
      this.session.issueCapabilities?.startDate ? client.getIssueStartDate(project.path_with_namespace, issue.iid) : Promise.resolve(null),
      this.session.issueCapabilities?.timelogReport ? client.listIssueTimelogs(project.path_with_namespace, issue.iid) : Promise.resolve([] as IssueTimelog[])
    ] as const);
    if (version !== this.navigationVersion) return;
    const names = ['fields', 'activity', 'links', 'merge requests', 'reactions', 'to-dos', 'tasks', 'projects', 'start date', 'time entries'];
    const warnings = [...this.session.instanceWarnings, ...optional.flatMap((result, index) => result.status === 'rejected' ? [`Could not load ${names[index]}: ${safeError(result.reason)}`] : [])];
    if (this.operationWarning) { warnings.push(this.operationWarning); this.operationWarning = undefined; }
    const value = <T,>(index: number, fallback: T): T => optional[index].status === 'fulfilled' ? optional[index].value as T : fallback;
    const discussions = value<GitLabIssueDiscussion[]>(1, []);
    const noteResults = await this.loadNoteReactions(issue.project_id, issue.iid, discussions);
    if (version !== this.navigationVersion) return;
    if (noteResults.failed) warnings.push(`Could not load reactions for ${noteResults.failed} comment(s).`);
    const hierarchy = value<Awaited<ReturnType<IssuePanels['loadTasks']>>>(6, { tasks: [] });
    if (!hierarchy.permissions) warnings.push('GitLab did not expose Issue permissions; editing controls are hidden.');
    const fields = value<IssueFormOptions>(0, { members: [], labels: [], milestones: [], templates: [] });
    warnings.push(...(fields.warnings ?? []));
    for (const assignee of issue.assignees ?? []) {
      if (!fields.members.some((member) => member.id === assignee.id)) fields.members.push(assignee);
    }
    if (issue.milestone && !fields.milestones.some((milestone) => milestone.id === issue.milestone?.id)) fields.milestones.push(issue.milestone);
    for (const label of issue.labels ?? []) {
      if (!fields.labels.some((item) => item.name === label)) fields.labels.push({ id: -fields.labels.length - 1, name: label, color: '#888888' });
    }
    const data: IssueDetailData = {
      issue, project, projects: value(7, [project]), user, metadata: this.session.metadata,
      options: fields,
      discussions, links: value(2, []), mergeRequests: value(3, []),
      reactions: value(4, []), noteReactions: noteResults.reactions, todos: value(5, []), tasks: hierarchy.tasks,
      startDate: value(8, issue.start_date ?? null), timelogs: value(9, []),
      parentWorkItemId: hierarchy.parentWorkItemId,
      taskTypeId: hierarchy.taskTypeId,
      warnings,
      canEdit: hierarchy.permissions?.updateWorkItem === true,
      canDelete: hierarchy.permissions?.deleteWorkItem === true,
      canMove: hierarchy.permissions?.moveWorkItem === true,
      canClone: hierarchy.permissions?.cloneWorkItem === true,
      canComment: hierarchy.permissions?.createNote === true,
      canInternalComment: hierarchy.permissions?.markNoteAsInternal === true,
      canLink: hierarchy.permissions?.adminWorkItemLink === true,
      canManageChildren: this.session.issueCapabilities?.childMutations === true && hierarchy.permissions?.adminParentLink === true,
      canTrackTime: hierarchy.permissions?.setWorkItemMetadata === true,
      canResolveThreads: this.session.issueCapabilities?.discussionResolve === true,
      canSetStartDate: this.session.issueCapabilities?.startDate === true && hierarchy.permissions?.updateWorkItem === true,
      hasStartDate: this.session.issueCapabilities?.startDate === true || !!issue.start_date,
      canLogTime: this.session.issueCapabilities?.timelogCreate === true && hierarchy.permissions?.setWorkItemMetadata === true,
      canDeleteTimelog: this.session.issueCapabilities?.timelogDelete === true
    };
    this.post({ type: 'detailData', data });
  }

  private async handle(raw: unknown): Promise<void> {
    if (!raw || typeof raw !== 'object') return;
    const request = raw as IssuePanelRequest;
    if (request.type === 'ready') {
      this.ready = true;
      if (this.loadingTask) {
        await this.loadingTask;
        if (this.lastSnapshot) return;
      }
      if (this.lastSnapshot) {
        void this.panel?.webview.postMessage(this.lastSnapshot);
        return;
      }
      return this.load();
    }
    if (request.type === 'refresh') return this.load();
    const client = await this.session.getClient();
    if (request.type === 'selectProject') {
      const version = this.navigationVersion;
      const projectId = requiredId(request.projectId, 'Project');
      const group = this.session.selectedGroup;
      const project = group ? (await client.listGroupProjects(group.id)).find((item) => item.id === projectId) : undefined;
      if (!project) throw new Error('Project is outside the selected group.');
      const options = await this.formOptions(projectId);
      const canCreateIssue = this.session.issueCapabilities?.createPermission ? await client.canCreateIssue(project.path_with_namespace).catch(() => false) : false;
      if (version !== this.navigationVersion || this.mode !== 'create') return;
      options.warnings = [...this.session.instanceWarnings, ...(options.warnings ?? [])];
      if (!canCreateIssue) options.warnings.push('This account cannot create issues in the selected project, or its permission could not be verified.');
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
        if (!this.session.issueCapabilities?.startDate) this.operationWarning = 'Issue created, but this GitLab version does not support editing its start date.';
        else {
          try {
            const project = await client.getProject(projectId);
            const workItemId = await client.getWorkItemId(project.path_with_namespace, created.iid);
            if (!workItemId) throw new Error('GitLab did not return the new Work Item ID.');
            await client.setIssueStartDate(workItemId, startDate);
          } catch (error) { this.operationWarning = `Issue created, but the start date was not saved: ${safeError(error)}`; }
        }
      }
      this.refreshIssues();
      this.navigationVersion++;
      this.mode = 'detail';
      this.issue = created;
      if (this.panel) this.panel.title = `Issue #${created.iid}`;
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
      const url = new URL(requiredString(request.url, 'URL'));
      const base = new URL(client.baseUrl);
      if (url.username || url.password || (url.protocol !== 'https:' && url.origin !== base.origin)) throw new Error('This link is not safe to open.');
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
          const project = await client.getProjectByPath(decodeURIComponent(match[1]));
          const nextIssue = await client.getIssue(project.id, Number(match[2]));
          this.navigationVersion++;
          this.issue = nextIssue;
          this.mode = 'detail';
          if (this.panel) this.panel.title = `Issue #${this.issue.iid}`;
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
    if (request.type === 'update') {
      const input = updateInput(request.input);
      await client.updateIssueIfUnchanged(projectId, iid, request.expectedUpdatedAt, input);
      const currentDate = this.lastSnapshot?.type === 'detailData' ? this.lastSnapshot.data.startDate : undefined;
      if (input.startDate !== undefined && input.startDate !== currentDate) {
        if (!this.session.issueCapabilities?.startDate) this.operationWarning = 'Issue fields saved, but this GitLab version does not support editing its start date.';
        else {
          try {
            const project = await client.getProject(projectId);
            const workItemId = await client.getWorkItemId(project.path_with_namespace, iid);
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
    const snapshot = this.lastSnapshot?.type === 'detailData' && this.lastSnapshot.data.issue.id === issue.id ? this.lastSnapshot.data : undefined;
    switch (request.action) {
      case 'close': case 'reopen':
        await client.updateIssueIfUnchanged(projectId, iid, issue.updated_at, { stateEvent: request.action }); break;
      case 'subscribe': await client.subscribeToIssue(projectId, iid); break;
      case 'unsubscribe': await client.unsubscribeFromIssue(projectId, iid); break;
      case 'todo': await client.createIssueTodo(projectId, iid); break;
      case 'todoDone': await client.markTodoDone(requiredId(payload.todoId, 'To-do')); break;
      case 'note':
        if (payload.internal === true && !snapshot?.canInternalComment) throw new Error('You cannot post internal comments on this issue.');
        await client.addIssueNote(projectId, iid, requiredString(payload.body, 'Comment'), payload.internal === true); break;
      case 'editNote': await client.updateIssueNote(projectId, iid, requiredString(payload.discussionId, 'Thread'), requiredId(payload.noteId, 'Comment'), requiredString(payload.body, 'Comment')); break;
      case 'deleteNote': await client.deleteIssueNote(projectId, iid, requiredString(payload.discussionId, 'Thread'), requiredId(payload.noteId, 'Comment')); break;
      case 'thread':
        if (payload.internal === true) throw new Error('GitLab cannot create an internal issue thread. Use an internal comment.');
        await client.createIssueThread(projectId, iid, requiredString(payload.body, 'Thread')); break;
      case 'reply': await client.replyToIssueThread(projectId, iid, requiredString(payload.discussionId, 'Thread'), requiredString(payload.body, 'Reply')); break;
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
      case 'link': await client.addIssueLink(projectId, iid, requiredId(payload.targetProjectId, 'Project'), requiredId(payload.targetIssueIid, 'Issue'), payload.linkType === 'blocks' || payload.linkType === 'is_blocked_by' ? payload.linkType : 'relates_to'); break;
      case 'unlink': await client.removeIssueLink(projectId, iid, requiredId(payload.linkId, 'Link')); break;
      case 'estimate': await client.setTimeEstimate(projectId, iid, requiredString(payload.duration, 'Duration')); break;
      case 'spend': {
        const duration = requiredString(payload.duration, 'Duration');
        const spentDate = optionalDate(payload.spentDate);
        if (this.session.issueCapabilities?.timelogCreate) {
          const spentAt = spentDate ? new Date(`${spentDate}T12:00:00`).toISOString() : undefined;
          await client.createIssueTimelog(issue.id, duration, optionalString(payload.summary), spentAt);
        } else if (spentDate) throw new Error('This GitLab instance does not support dated time entries.');
        else await client.addSpentTime(projectId, iid, duration, optionalString(payload.summary));
        break;
      }
      case 'deleteTimelog': {
        const id = requiredString(payload.timelogId, 'Time entry');
        if (!this.session.issueCapabilities?.timelogDelete || !snapshot?.timelogs.some((entry) => entry.id === id && entry.userPermissions?.adminTimelog)) throw new Error('You cannot delete this time entry.');
        const confirm = await vscode.window.showWarningMessage('Delete this time entry?', { modal: true }, 'Delete time entry');
        if (confirm !== 'Delete time entry') { this.post({ type: 'cancelled' }); return; }
        await client.deleteIssueTimelog(id);
        break;
      }
      case 'resetEstimate': {
        const confirm = await vscode.window.showWarningMessage('Reset this issue’s entire time estimate?', { modal: true }, 'Reset estimate');
        if (confirm !== 'Reset estimate') { this.post({ type: 'cancelled' }); return; }
        await client.resetTimeEstimate(projectId, iid); break;
      }
      case 'resetSpent': {
        const confirm = await vscode.window.showWarningMessage('Delete all time spent on this issue?', { modal: true }, 'Reset spent');
        if (confirm !== 'Reset spent') { this.post({ type: 'cancelled' }); return; }
        await client.resetSpentTime(projectId, iid); break;
      }
      case 'createChild': {
        if (!snapshot?.parentWorkItemId || !snapshot.taskTypeId) throw new Error('This GitLab instance did not expose child task creation.');
        await client.createChildTask(snapshot.project.path_with_namespace, snapshot.parentWorkItemId, snapshot.taskTypeId, requiredString(payload.title, 'Task title'));
        break;
      }
      case 'addChild': {
        if (!snapshot?.parentWorkItemId) throw new Error('This GitLab instance did not expose child tasks.');
        const id = await client.getWorkItemId(snapshot.project.path_with_namespace, requiredId(payload.taskIid, 'Task'));
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
        const target = requiredId(payload.toProjectId, 'Target project');
        const confirm = await vscode.window.showWarningMessage(`Move issue #${iid} to project ${target}? GitLab closes the original issue.`, { modal: true }, 'Move');
        if (confirm !== 'Move') { this.post({ type: 'cancelled' }); return; }
        this.issue = await client.moveIssue(projectId, iid, target);
        this.navigationVersion++;
        this.refreshIssues();
        return this.load();
      }
      case 'clone': {
        const target = requiredId(payload.toProjectId, 'Target project');
        this.issue = await client.cloneIssue(projectId, iid, target, payload.withNotes === true);
        this.navigationVersion++;
        this.refreshIssues();
        return this.load();
      }
      case 'delete': {
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
