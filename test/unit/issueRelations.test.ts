import assert from 'node:assert/strict';
import test from 'node:test';
import type { ExtensionContext } from 'vscode';
import type { GitLabClient } from '../../src/api/gitLabClient';
import type { GitLabProject } from '../../src/api/types';
import type { GitLabSession } from '../../src/connection/session';
import type { IssueRelationAction } from '../../src/issues/protocol';

test('Issue relationship actions validate permissions, Group scope, Task type, and existing parents', async () => {
  const project: GitLabProject = { id: 42, name: 'Project', path: 'project', path_with_namespace: 'group/project', web_url: 'https://gitlab.example.test/group/project', http_url_to_repo: 'https://gitlab.example.test/group/project.git' };
  const issue = { id: 401, iid: 7, project_id: 42, title: 'Parent issue', state: 'opened', web_url: 'https://gitlab.example.test/group/project/-/issues/7' };
  let canLink = true;
  let issueCanLink = true;
  let canManageChildren = true;
  let links: Array<Record<string, unknown>> = [];
  const children = [{ id: 'gid://gitlab/WorkItem/412', iid: '12', title: 'Existing Task', state: 'OPEN' }];
  const verifiedItems = new Map<number, { id: string; type?: string; parentId?: string }>([
    [13, { id: 'gid://gitlab/WorkItem/413', type: 'Issue' }],
    [14, { id: 'gid://gitlab/WorkItem/414', type: 'Task', parentId: 'gid://gitlab/WorkItem/other' }],
    [15, { id: 'gid://gitlab/WorkItem/415', type: 'Task', parentId: 'gid://gitlab/WorkItem/401' }],
    [16, { id: 'gid://gitlab/WorkItem/416', type: 'Task' }]
  ]);
  const createdChildren: unknown[][] = [];
  const assignedParents: unknown[][] = [];
  const createdLinks: unknown[][] = [];
  const removedLinks: unknown[][] = [];
  const client = {
    listGroupProjects: async () => [project],
    getIssue: async (_projectId: number, iid: number) => ({ ...issue, iid, id: 400 + iid }),
    listIssueLinks: async () => links,
    getIssuePermissions: async () => ({ updateIssue: issueCanLink, adminIssue: false }),
    graphql: async () => ({ namespace: { workItem: {
      id: 'gid://gitlab/WorkItem/401',
      userPermissions: { adminWorkItemLink: canLink, adminParentLink: canManageChildren },
      widgets: [{ children: { nodes: children, pageInfo: { hasNextPage: false } } }]
    }, workItemTypes: { nodes: [{ id: 'gid://gitlab/WorkItems::Type/5', name: 'Task' }] } } }),
    getWorkItemTypeAndParent: async (_path: string, iid: number, canReadHierarchy: boolean, canReadType: boolean) => {
      assert.equal(canReadHierarchy, true);
      assert.equal(canReadType, true);
      return verifiedItems.get(iid);
    },
    createChildTask: async (...args: unknown[]) => { createdChildren.push(args); },
    setChildParent: async (...args: unknown[]) => { assignedParents.push(args); },
    addIssueLink: async (...args: unknown[]) => { createdLinks.push(args); },
    removeIssueLink: async (...args: unknown[]) => { removedLinks.push(args); }
  } as unknown as GitLabClient;
  const session = {
    selectedGroup: { id: 1, full_path: 'group' },
    metadata: { version: '16.11.10', enterprise: true },
    issueCapabilities: { hierarchy: true, childMutations: true, graphHierarchy: true, graphWorkItemTypes: true, issuePermissionFields: ['updateIssue', 'adminIssue'], workItemCreatePathField: 'namespacePath', workItemScope: 'namespace' },
    ensureInstanceChecked: async () => undefined,
    getClient: async () => client,
    cachedRead: async (_key: string, load: (readClient: GitLabClient, signal: AbortSignal) => Promise<unknown>) => load(client, new AbortController().signal)
  } as unknown as GitLabSession;
  const moduleLoader = require('node:module') as { _load: (request: string, parent: unknown, isMain: boolean) => unknown };
  const originalLoad = moduleLoader._load;
  moduleLoader._load = (request, parent, isMain) => request === 'vscode' ? {
    Uri: { joinPath: (...parts: unknown[]) => parts.join('/'), parse: (value: string) => ({ value }) },
    ViewColumn: { Active: 1 }, env: { openExternal: async () => true }, window: { showWarningMessage: async () => undefined }
  } : originalLoad(request, parent, isMain);
  let IssuePanels: typeof import('../../src/issues/issuePanel').IssuePanels;
  try { ({ IssuePanels } = require('../../src/issues/issuePanel') as typeof import('../../src/issues/issuePanel')); }
  finally { moduleLoader._load = originalLoad; }
  const panels = new IssuePanels!({ extensionUri: 'extension' } as unknown as ExtensionContext, session, () => undefined);
  const source = { projectId: 42, iid: 7 };
  try {
    const relations = await panels.loadIssueRelations(source.projectId, source.iid);
    assert.equal(relations.canLink, true);
    assert.equal(relations.canManageChildren, true);
    assert.equal(relations.parentWorkItemId, 'gid://gitlab/WorkItem/401');

    await panels.mutateIssueRelations(source.projectId, source.iid, { type: 'createChild', title: '  New Task  ' });
    assert.deepEqual(createdChildren, [['group/project', 'gid://gitlab/WorkItem/401', 'gid://gitlab/WorkItems::Type/5', 'New Task', 'namespacePath']]);
    await assert.rejects(panels.mutateIssueRelations(source.projectId, source.iid, { type: 'addChild', taskIid: 12 }), /already a child/i);
    await assert.rejects(panels.mutateIssueRelations(source.projectId, source.iid, { type: 'addChild', taskIid: 13 }), /not a Task/i);
    await assert.rejects(panels.mutateIssueRelations(source.projectId, source.iid, { type: 'addChild', taskIid: 14 }), /another parent/i);
    await assert.rejects(panels.mutateIssueRelations(source.projectId, source.iid, { type: 'addChild', taskIid: 15 }), /already a child/i);
    await panels.mutateIssueRelations(source.projectId, source.iid, { type: 'addChild', taskIid: 16 });
    assert.deepEqual(assignedParents, [['gid://gitlab/WorkItem/416', 'gid://gitlab/WorkItem/401']]);

    await assert.rejects(panels.mutateIssueRelations(source.projectId, source.iid, { type: 'link', targetProjectId: 42, targetIssueIid: 7, linkType: 'relates_to' }), /itself/i);
    await assert.rejects(panels.mutateIssueRelations(source.projectId, source.iid, { type: 'link', targetProjectId: 99, targetIssueIid: 8, linkType: 'relates_to' }), /selected Group/i);
    const duplicate = { id: 409, iid: 9, project_id: 42, issue_link_id: 55, link_type: 'relates_to', title: 'Already linked', state: 'opened', web_url: 'https://gitlab.example.test/group/project/-/issues/9' };
    links = [duplicate];
    await assert.rejects(panels.mutateIssueRelations(source.projectId, source.iid, { type: 'link', targetProjectId: 42, targetIssueIid: 9, linkType: 'relates_to' }), /already linked/i);
    await panels.mutateIssueRelations(source.projectId, source.iid, { type: 'link', targetProjectId: 42, targetIssueIid: 10, linkType: 'blocks' });
    assert.equal(createdLinks.at(-1)?.[4], 'blocks');
    (session as unknown as { metadata: { enterprise: boolean } }).metadata.enterprise = false;
    const beforeBlockedLink = createdLinks.length;
    await assert.rejects(panels.mutateIssueRelations(source.projectId, source.iid, { type: 'link', targetProjectId: 42, targetIssueIid: 11, linkType: 'blocks' }), /unavailable on Community Edition/i);
    assert.equal(createdLinks.length, beforeBlockedLink, 'unsupported CE blocking relationships never send a write request');
    (session as unknown as { metadata: { enterprise: boolean } }).metadata.enterprise = true;
    await assert.rejects(panels.mutateIssueRelations(source.projectId, source.iid, { type: 'link', targetProjectId: 42, targetIssueIid: 10, linkType: 'invalid' } as unknown as IssueRelationAction), /unsupported issue link type/i);
    await assert.rejects(panels.mutateIssueRelations(source.projectId, source.iid, { type: 'unlink', linkId: 99 }), /does not belong/i);
    await panels.mutateIssueRelations(source.projectId, source.iid, { type: 'unlink', linkId: 55 });
    assert.deepEqual(removedLinks, [[42, 7, 55]]);

    canManageChildren = false;
    await assert.rejects(panels.mutateIssueRelations(source.projectId, source.iid, { type: 'createChild', title: 'Denied' }), /cannot create child/i);
    issueCanLink = false;
    await assert.rejects(panels.mutateIssueRelations(source.projectId, source.iid, { type: 'link', targetProjectId: 42, targetIssueIid: 11, linkType: 'relates_to' }), /permission/i);
  } finally { panels.dispose(); }
});
