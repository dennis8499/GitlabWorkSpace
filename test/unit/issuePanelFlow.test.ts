import assert from 'node:assert/strict';
import test from 'node:test';
import type { ExtensionContext } from 'vscode';
import type { GitLabClient } from '../../src/api/gitLabClient';
import type { GitLabSession } from '../../src/connection/session';
import type { IssuePanelResponse } from '../../src/issues/protocol';
import type { WorkspaceResponse } from '../../src/workspace/workspaceProtocol';

test('an unassigned creation opens detail and a later issue selection wins a pending load', async () => {
  const issue = { id: 401, iid: 7, project_id: 42, title: 'New unassigned issue', description: '', state: 'opened', web_url: 'https://gitlab.example.test/group/project/-/issues/7', updated_at: '2026-09-24T00:00:00Z', assignees: [] };
  const project = { id: 42, name: 'Project', path: 'project', path_with_namespace: 'group/project', web_url: 'https://gitlab.example.test/group/project' };
  let releaseDiscussions: (() => void) | undefined;
  const discussionGate = new Promise<void>((resolve) => { releaseDiscussions = resolve; });
  let internalIssueNavigations = 0;
  let optionReads = 0;
  let issueLinkReads = 0;
  let relatedMergeRequestReads = 0;
  let todoReads = 0;
  const client = {
    baseUrl: 'http://gitlab.internal.test:8929/gitlab',
    listGroupProjects: async () => [project], canCreateIssue: async () => true, createIssue: async () => issue,
    getIssue: async () => issue, getProject: async () => project,
    getIssuePermissions: async () => ({ updateIssue: true, adminIssue: false, deleteIssue: true, createNote: true }),
    getProjectByPath: async () => { internalIssueNavigations++; return project; },
    getCurrentUser: async () => ({ id: 9, username: 'tester', name: 'Tester' }),
    listProjectMembers: async () => { optionReads++; return []; }, listProjectLabels: async () => [],
    listProjectMilestones: async () => [], listProjectIssueTemplates: async () => [],
    listIssueDiscussions: async (_projectId: number, iid: number) => { if (iid === 9) await discussionGate; return []; },
    listIssueNoteReactions: async (_projectId: number, _iid: number, _noteId: number) => [], listIssueLinks: async () => { issueLinkReads++; return []; },
    listRelatedMergeRequests: async () => { relatedMergeRequestReads++; return []; }, listIssueReactions: async () => [],
    listTodos: async () => { todoReads++; return []; }, graphql: async (_query: string, _variables: Record<string, unknown>): Promise<unknown> => ({}),
    updateIssueIfUnchanged: async (_projectId: number, _iid: number) => issue,
    deleteIssue: async (_projectId: number, _iid: number) => undefined
  };
  const signalClient = client as unknown as GitLabClient;
  Object.assign(signalClient, { withReadSignal: (_signal: AbortSignal) => signalClient });
  const session = {
    baseUrl: 'http://gitlab.internal.test:8929/gitlab',
    selectedGroup: { id: 1, full_path: 'group' }, metadata: { version: '18.4.0' },
    instanceWarnings: [], issueCapabilities: { hierarchy: false, childMutations: false, discussionResolve: false, createPermission: true, issuePermissionFields: ['updateIssue', 'adminIssue', 'createNote'] },
    getClient: async () => signalClient, ensureInstanceChecked: async () => undefined,
    cachedRead: async (_key: string, load: (readClient: GitLabClient, signal: AbortSignal) => Promise<unknown>) => load(signalClient, new AbortController().signal)
  } as unknown as GitLabSession;
  const messages: IssuePanelResponse[] = [];
  const externalUrls: string[] = [];
  let externalOpenResult = true;
  const vscode = {
    Uri: { joinPath: (...parts: unknown[]) => parts.join('/'), parse: (href: string) => ({ href }) }, ViewColumn: { Active: 1 },
    env: { openExternal: async (uri: { href: string }) => { externalUrls.push(uri.href); return externalOpenResult; } },
    window: { showWarningMessage: async () => undefined }
  };
  const moduleLoader = require('node:module') as { _load: (request: string, parent: unknown, isMain: boolean) => unknown };
  const originalLoad = moduleLoader._load;
  moduleLoader._load = (request, parent, isMain) => request === 'vscode' ? vscode : originalLoad(request, parent, isMain);
  let IssuePanels: typeof import('../../src/issues/issuePanel').IssuePanels;
  try { ({ IssuePanels } = require('../../src/issues/issuePanel') as typeof import('../../src/issues/issuePanel')); }
  finally { moduleLoader._load = originalLoad; }

  let treeRefreshes = 0;
  const panels = new IssuePanels!({ extensionUri: 'extension' } as unknown as ExtensionContext, session, () => { treeRefreshes++; });
  const host = panels as unknown as { handle(message: unknown, revision?: number): Promise<void> };
  const navigations: Array<import('../../src/workspace/workspaceProtocol').IssueNavigation | null> = [];
  const workspaceResponses: WorkspaceResponse[] = [];
  panels.setWorkspace({
    post: (message) => { workspaceResponses.push(message); if (message.type === 'issueResponse') messages.push(message.response); },
    navigate: (navigation) => navigations.push(navigation), show: async () => undefined
  });
  try {
    await panels.showCreate();
    assert.equal(navigations.at(-1)?.mode, 'create');
    await (panels as unknown as { handle(message: unknown): Promise<void> }).handle({ type: 'ready' });
    await (panels as unknown as { handle(message: unknown): Promise<void> }).handle({ type: 'create', projectId: 42, input: { title: issue.title } });
    const optionsAfterCreate = optionReads;
    const detail = [...messages].reverse().find((message) => message.type === 'detailData');
    assert.equal(detail?.type, 'detailData');
    if (detail?.type === 'detailData') {
      assert.equal(detail.data.issue.iid, 7);
      assert.deepEqual(detail.data.issue.assignees, []);
    }
    assert.equal(treeRefreshes, 1);
    assert.equal(messages.filter((message) => message.type === 'createData').length, 1);
    assert.deepEqual(navigations.at(-1), { mode: 'detail', projectId: 42, issueIid: 7, revision: navigations.at(-1)?.revision });
    const slowIssue = { ...issue, id: 402, iid: 8, title: 'Slow issue' };
    const selectedIssue = { ...issue, id: 403, iid: 9, title: 'Selected issue' };
    let releaseSlow: (() => void) | undefined;
    const slow = new Promise<void>((resolve) => { releaseSlow = resolve; });
    let reads = 0;
    client.getIssue = async () => {
      reads++;
      if (reads === 1) { await slow; return slowIssue; }
      return selectedIssue;
    };
    const first = panels.showIssue(slowIssue);
    await new Promise((resolve) => setTimeout(resolve, 0));
    const second = panels.showIssue(selectedIssue, 'time');
    releaseSlow?.();
    await Promise.all([first, second]);
    const selectedNavigation = navigations.at(-1);
    assert.equal(selectedNavigation?.mode, 'detail');
    assert.equal(selectedNavigation?.mode === 'detail' ? selectedNavigation.tab : undefined, 'time');
    const latest = [...messages].reverse().find((message) => message.type === 'detailData');
    assert.equal(latest?.type === 'detailData' ? latest.data.issue.iid : undefined, 9);
    assert.equal(latest?.type === 'detailData' ? latest.data.sections?.activity : undefined, 'idle', 'the Issue body is sent before optional section reads start');
    assert.equal(optionReads, optionsAfterCreate, 'Issue edit options are not loaded until editing is opened');
    assert.equal(issueLinkReads, 0, 'Issue relations remain idle until the relations tab opens');
    assert.equal(relatedMergeRequestReads, 0, 'related Merge Requests remain idle until the development tab opens');
    assert.equal(todoReads, 0, 'to-dos remain idle until their tab opens');
    releaseDiscussions?.();
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.ok(messages.some((message) => message.type === 'detailPatch' && message.issueId === selectedIssue.id && message.patch.sections?.activity === 'ready'));
    assert.ok(messages.some((message) => message.type === 'detailPatch' && message.issueId === selectedIssue.id && message.patch.canEdit === true && message.patch.canComment === true), 'Issue edit and comment permissions load independently of unavailable child tasks');
    assert.equal(reads, 2);
    await host.handle({ type: 'loadSection', sections: ['options', 'links', 'mergeRequests', 'todos'] });
    assert.equal(optionReads, optionsAfterCreate + 1);
    assert.equal(issueLinkReads, 1);
    assert.equal(relatedMergeRequestReads, 1);
    assert.equal(todoReads, 1);
    assert.ok(messages.some((message) => message.type === 'detailPatch' && message.issueId === selectedIssue.id && message.patch.sections?.links === 'ready'));
    let taskPages = 0;
    client.graphql = async (_query, variables) => {
      taskPages++;
      return { namespace: { workItem: { id: 'gid://gitlab/WorkItem/403', userPermissions: { updateWorkItem: true }, widgets: [{ children: { nodes: [{ id: `task-${taskPages}`, iid: String(taskPages), title: `Task ${taskPages}`, state: 'OPEN', userPermissions: { updateWorkItem: true } }], pageInfo: { hasNextPage: taskPages === 1, endCursor: taskPages === 1 ? 'next-task' : null } } }] }, workItemTypes: { nodes: [{ id: 'task-type' }] } } };
    };
    const tasks = await (panels as unknown as { loadTasks(client: GitLabClient, projectPath: string, iid: number): Promise<{ tasks: Array<{ id: string }> }> }).loadTasks(signalClient, 'group/project', 9);
    assert.deepEqual(tasks.tasks.map((task) => task.id), ['task-1', 'task-2']);
    assert.equal(taskPages, 2);

    let activeReactions = 0;
    let maxReactionConcurrency = 0;
    client.listIssueNoteReactions = async () => {
      activeReactions++;
      maxReactionConcurrency = Math.max(maxReactionConcurrency, activeReactions);
      await new Promise((resolve) => setTimeout(resolve, 1));
      activeReactions--;
      return [];
    };
    const loadNoteReactions = (panels as unknown as { loadNoteReactions(client: GitLabClient, projectId: number, iid: number, discussions: Array<{ notes: Array<{ id: number; system?: boolean }> }>, signal: AbortSignal): Promise<{ reactions: Record<number, unknown[]>; failed: number }> }).loadNoteReactions.bind(panels);
    const reactionResult = await loadNoteReactions(signalClient, 42, 9, Array.from({ length: 100 }, (_, index) => ({ notes: [{ id: index + 1, system: false }] })), new AbortController().signal);
    assert.equal(Object.keys(reactionResult.reactions).length, 100);
    assert.equal(reactionResult.failed, 0);
    assert.equal(maxReactionConcurrency, 8);

    const nextIssue = { ...issue, id: 404, iid: 10, title: 'Next issue' };
    const staleRevision = navigations.at(-1)?.revision;
    let releaseNext: (() => void) | undefined;
    const nextRead = new Promise<void>((resolve) => { releaseNext = resolve; });
    client.getIssue = async () => { await nextRead; return nextIssue; };
    const writes: number[] = [];
    client.updateIssueIfUnchanged = async (_projectId, iid) => { writes.push(iid); return nextIssue; };
    const nextLoad = panels.showIssue(nextIssue);
    await new Promise((resolve) => setTimeout(resolve, 0));
    const responseCount = messages.length;
    await host.handle({ type: 'refresh' }, staleRevision);
    assert.equal(messages.length, responseCount, 'a request from the previous navigation is ignored');
    const currentNavigation = navigations.at(-1);
    assert.equal(currentNavigation?.mode === 'detail' ? currentNavigation.issueIid : undefined, 10);
    const staleUpdate = host.handle({ type: 'update', issueId: selectedIssue.id, expectedUpdatedAt: selectedIssue.updated_at, input: { title: 'Wrong target' } });
    const staleClose = host.handle({ type: 'invoke', issueId: selectedIssue.id, action: 'close', payload: {} });
    releaseNext?.();
    await Promise.all([
      assert.rejects(staleUpdate, /issue.*changed|stale/i),
      assert.rejects(staleClose, /issue.*changed|stale/i),
      nextLoad
    ]);
    assert.deepEqual(writes, []);
    let deletions = 0;
    client.deleteIssue = async () => { deletions++; };
    await host.handle({ type: 'invoke', issueId: nextIssue.id, action: 'delete', payload: {} });
    assert.equal(deletions, 0);
    assert.equal(messages.at(-1)?.type, 'cancelled');

    await host.handle({ type: 'openIssueInGitLab', issueId: nextIssue.id });
    assert.deepEqual(externalUrls, [nextIssue.web_url]);
    assert.equal(internalIssueNavigations, 0);
    await assert.rejects(host.handle({ type: 'openIssueInGitLab', issueId: selectedIssue.id }), /displayed issue changed/i);
    assert.deepEqual(externalUrls, [nextIssue.web_url]);

    client.getIssue = async () => issue;
    await host.handle({ type: 'openLink', url: 'http://gitlab.internal.test:8929/gitlab/group/project/-/issues/7' });
    assert.equal(internalIssueNavigations, 1);
    assert.equal((panels as unknown as { issue: typeof issue }).issue?.id, issue.id);
    assert.equal(externalUrls.length, 1);

    (panels as unknown as { issue: typeof issue }).issue = { ...issue, web_url: 'javascript:alert(1)' };
    await assert.rejects(host.handle({ type: 'openIssueInGitLab', issueId: issue.id }), /not safe to open/i);
    assert.equal(externalUrls.length, 1);
    (panels as unknown as { issue: typeof issue }).issue = issue;

    externalOpenResult = false;
    await assert.rejects(host.handle({ type: 'openIssueInGitLab', issueId: issue.id }), /could not open.*browser/i);
    assert.equal(externalUrls.at(-1), issue.web_url);

    const permissionFailureIssue = { ...issue, id: 406, iid: 11, title: 'Issue with permission lookup failure' };
    client.getIssue = async () => permissionFailureIssue;
    client.getIssuePermissions = async () => { throw new Error('GitLab API request failed (HTTP 403).'); };
    await panels.showIssue(permissionFailureIssue);
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.ok(messages.some((message) => message.type === 'detailData' && message.data.issue.iid === 11), 'the Issue body remains visible when the permissions query is forbidden');
    assert.ok(messages.some((message) => message.type === 'detailPatch' && message.issueId === permissionFailureIssue.id && message.patch.sections?.permissions === 'error'));
    let deniedWrites = 0;
    client.updateIssueIfUnchanged = async () => { deniedWrites++; return permissionFailureIssue; };
    await assert.rejects(host.handle({ type: 'update', issueId: permissionFailureIssue.id, input: { title: 'Denied' } }), /permission to edit/i);
    assert.equal(deniedWrites, 0, 'a failed permission lookup never sends an Issue write');

    const childLoadFailureIssue = { ...issue, id: 407, iid: 12, title: 'Issue with unavailable child tasks' };
    session.issueCapabilities!.hierarchy = true;
    client.getIssue = async () => childLoadFailureIssue;
    client.getIssuePermissions = async () => ({ updateIssue: true, adminIssue: false, deleteIssue: false, createNote: true });
    client.graphql = async () => { throw new Error('GitLab API request failed (HTTP 403).'); };
    await panels.showIssue(childLoadFailureIssue);
    await host.handle({ type: 'loadSection', sections: ['tasks'] });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const childFailurePatches = messages.filter((message) => message.type === 'detailPatch' && message.issueId === childLoadFailureIssue.id);
    assert.ok(childFailurePatches.some((message) => message.type === 'detailPatch' && message.patch.sections?.tasks === 'error'));
    assert.ok(childFailurePatches.some((message) => message.type === 'detailPatch' && message.patch.sections?.permissions === 'ready' && message.patch.canEdit === true));
    assert.ok(!childFailurePatches.some((message) => message.type === 'detailPatch' && message.patch.sections?.permissions === 'error'), 'a child task API failure never changes Issue permission state');
  } finally { panels.dispose(); }
});
