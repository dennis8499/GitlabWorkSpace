import assert from 'node:assert/strict';
import test from 'node:test';
import type { ExtensionContext } from 'vscode';
import type { GitLabSession } from '../../src/connection/session';
import type { IssuePanelResponse } from '../../src/issues/protocol';

test('an unassigned creation opens detail and a later issue selection wins a pending load', async () => {
  const issue = { id: 401, iid: 7, project_id: 42, title: 'New unassigned issue', description: '', state: 'opened', web_url: 'https://gitlab.example.test/group/project/-/issues/7', updated_at: '2026-09-24T00:00:00Z', assignees: [] };
  const project = { id: 42, name: 'Project', path: 'project', path_with_namespace: 'group/project', web_url: 'https://gitlab.example.test/group/project' };
  const client = {
    listGroupProjects: async () => [project], canCreateIssue: async () => true, createIssue: async () => issue,
    getIssue: async () => issue, getProject: async () => project,
    getCurrentUser: async () => ({ id: 9, username: 'tester', name: 'Tester' }),
    listProjectMembers: async () => [], listProjectLabels: async () => [],
    listProjectMilestones: async () => [], listProjectIssueTemplates: async () => [],
    listIssueDiscussions: async () => [], listIssueLinks: async () => [],
    listRelatedMergeRequests: async () => [], listIssueReactions: async () => [],
    listTodos: async () => [], graphql: async (_query: string, _variables: Record<string, unknown>): Promise<unknown> => ({}),
    updateIssueIfUnchanged: async (_projectId: number, _iid: number) => issue,
    deleteIssue: async (_projectId: number, _iid: number) => undefined
  };
  const session = {
    selectedGroup: { id: 1, full_path: 'group' }, metadata: { version: '18.4.0' },
    instanceWarnings: [], issueCapabilities: { hierarchy: false, childMutations: false, discussionResolve: false, createPermission: true },
    getClient: async () => client, ensureInstanceChecked: async () => undefined
  } as unknown as GitLabSession;
  const messages: IssuePanelResponse[] = [];
  const webview = {
    cspSource: 'vscode-resource:', asWebviewUri: (uri: unknown) => String(uri),
    onDidReceiveMessage: () => ({ dispose() {} }), postMessage: async (message: IssuePanelResponse) => { messages.push(message); return true; }, html: ''
  };
  const vscode = {
    Uri: { joinPath: (...parts: unknown[]) => parts.join('/') }, ViewColumn: { Active: 1 },
    window: {
      createWebviewPanel: () => ({ webview, reveal() {}, onDidDispose: () => ({ dispose() {} }), dispose() {}, title: '' }),
      showWarningMessage: async () => undefined
    }
  };
  const moduleLoader = require('node:module') as { _load: (request: string, parent: unknown, isMain: boolean) => unknown };
  const originalLoad = moduleLoader._load;
  moduleLoader._load = (request, parent, isMain) => request === 'vscode' ? vscode : originalLoad(request, parent, isMain);
  let IssuePanels: typeof import('../../src/issues/issuePanel').IssuePanels;
  try { ({ IssuePanels } = require('../../src/issues/issuePanel') as typeof import('../../src/issues/issuePanel')); }
  finally { moduleLoader._load = originalLoad; }

  let treeRefreshes = 0;
  const panels = new IssuePanels!({ extensionUri: 'extension' } as unknown as ExtensionContext, session, () => { treeRefreshes++; });
  try {
    await panels.showCreate();
    await (panels as unknown as { handle(message: unknown): Promise<void> }).handle({ type: 'ready' });
    await (panels as unknown as { handle(message: unknown): Promise<void> }).handle({ type: 'create', projectId: 42, input: { title: issue.title } });
    const detail = [...messages].reverse().find((message) => message.type === 'detailData');
    assert.equal(detail?.type, 'detailData');
    if (detail?.type === 'detailData') {
      assert.equal(detail.data.issue.iid, 7);
      assert.deepEqual(detail.data.issue.assignees, []);
    }
    assert.equal(treeRefreshes, 1);
    assert.equal(messages.filter((message) => message.type === 'createData').length, 1);
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
    const second = panels.showIssue(selectedIssue);
    releaseSlow?.();
    await Promise.all([first, second]);
    const latest = [...messages].reverse().find((message) => message.type === 'detailData');
    assert.equal(latest?.type === 'detailData' ? latest.data.issue.iid : undefined, 9);
    assert.equal(reads, 2);
    let taskPages = 0;
    client.graphql = async (_query, variables) => {
      taskPages++;
      return { namespace: { workItem: { id: 'gid://gitlab/WorkItem/403', userPermissions: { updateWorkItem: true }, widgets: [{ children: { nodes: [{ id: `task-${taskPages}`, iid: String(taskPages), title: `Task ${taskPages}`, state: 'OPEN', userPermissions: { updateWorkItem: true } }], pageInfo: { hasNextPage: taskPages === 1, endCursor: taskPages === 1 ? 'next-task' : null } } }] }, workItemTypes: { nodes: [{ id: 'task-type' }] } } };
    };
    const tasks = await (panels as unknown as { loadTasks(projectPath: string, iid: number): Promise<{ tasks: Array<{ id: string }> }> }).loadTasks('group/project', 9);
    assert.deepEqual(tasks.tasks.map((task) => task.id), ['task-1', 'task-2']);
    assert.equal(taskPages, 2);

    const nextIssue = { ...issue, id: 404, iid: 10, title: 'Next issue' };
    let releaseNext: (() => void) | undefined;
    const nextRead = new Promise<void>((resolve) => { releaseNext = resolve; });
    client.getIssue = async () => { await nextRead; return nextIssue; };
    const writes: number[] = [];
    client.updateIssueIfUnchanged = async (_projectId, iid) => { writes.push(iid); return nextIssue; };
    const nextLoad = panels.showIssue(nextIssue);
    const host = panels as unknown as { handle(message: unknown): Promise<void> };
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
  } finally { panels.dispose(); }
});
