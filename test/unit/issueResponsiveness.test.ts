import assert from 'node:assert/strict';
import test from 'node:test';
import type { ExtensionContext } from 'vscode';
import type { GitLabSession } from '../../src/connection/session';
import type { IssuePanelResponse } from '../../src/issues/protocol';

async function fixture(startDate = false) {
  const loader = require('node:module'), original = loader._load;
  loader._load = (name: string, ...args: unknown[]) => name === 'vscode' ? {} : original(name, ...args);
  let Panels: typeof import('../../src/issues/issuePanel').IssuePanels;
  try { Panels = require('../../src/issues/issuePanel').IssuePanels; } finally { loader._load = original; }
  const issue = { id: 7, iid: 2, project_id: 1, title: 'Test', state: 'opened' };
  const project = { id: 1, path_with_namespace: 'g/p' };
  let release!: () => void;
  const delayed = new Promise<void>(resolve => { release = resolve; });
  let permissions = 0;
  const client = { withReadSignal: () => client, getIssue: async () => issue, getProject: async () => project,
    getCurrentUser: async () => ({ id: 1 }), listGroupProjects: async () => [project],
    listProjectMembers: async () => [], listProjectLabels: async () => { await delayed; return []; },
    listProjectMilestones: async () => [], listProjectIssueTemplates: async () => [], canCreateIssue: async () => true,
    listIssueDiscussions: async () => [],
    getIssueStartDateDetails: async () => { await delayed; return { supported: true, startDate: null }; },
    getIssuePermissions: async () => { permissions++; return { updateIssue: true, createNote: true }; } };
  const session = { selectedGroup: { id: 1 }, getClient: async () => client, ensureInstanceChecked: async () => {},
    cachedRead: async (_key: string, task: (client: unknown) => Promise<unknown>) => task(client),
    issueCapabilities: { createPermission: true, startDate, issuePermissionSource: 'issue', issuePermissionFields: ['updateIssue', 'createNote'] } };
  const panels = new Panels!({} as ExtensionContext, session as unknown as GitLabSession, () => {});
  const messages: IssuePanelResponse[] = [];
  panels.setWorkspace({ post: message => { if (message.type === 'issueResponse') messages.push(message.response); }, navigate: () => {}, show: async () => {} });
  Object.assign(panels, { ready: true });
  return { panels, issue, client, messages, release, permissions: () => permissions };
}

test('create form and permissions are published before optional fields are requested', async () => {
  const f = await fixture();
  try {
    const pending = f.panels.showCreate();
    await new Promise(resolve => setImmediate(resolve));
    assert.ok(f.messages.some(message => message.type === 'createData'), 'the form must not wait for optional labels');
    await pending;
    assert.ok(f.messages.some(message => message.type === 'projectData'));
    const fields = f.panels.handle({ type: 'loadFormOptions', projectId: 1, section: 'fields' });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(f.messages.filter(message => message.type === 'projectData').at(-1)?.type, 'projectData');
    f.release(); await fields;
  } finally { f.release(); f.panels.dispose(); }
});

test('creating an issue loads template names and fetches only the selected template body', async () => {
  const f = await fixture(); let bodies = 0;
  Object.assign(f.client, { listProjectIssueTemplateNames: async () => [{ key: 'bug.md', name: 'Bug report' }, { key: 'feature.md', name: 'Feature' }],
    getProjectIssueTemplate: async (_projectId: number, key: string) => { bodies++; return { name: key, content: 'Selected body' }; } });
  try {
    f.release(); await f.panels.showCreate();
    assert.equal(f.messages.some(message => message.type === 'projectData' && message.options.templates.length), false);
    await f.panels.handle({ type: 'loadFormOptions', projectId: 1, section: 'templates' });
    const options = f.messages.filter(message => message.type === 'projectData').at(-1);
    assert.equal(bodies, 0);
    assert.equal(options?.type === 'projectData' ? options.options.templates[0].loaded : undefined, false);
    await f.panels.handle({ type: 'loadTemplate', requestId: 'selected-template', projectId: 1, key: 'bug.md' });
    assert.equal(bodies, 1);
    assert.ok(f.messages.some(message => message.type === 'reply' && message.requestId === 'selected-template' && (message.result as { content?: string })?.content === 'Selected body'));
  } finally { f.panels.dispose(); }
});

test('issue permissions do not wait for the start-date query', async () => {
  const f = await fixture(true);
  try {
    await f.panels.showIssue(f.issue as never);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(f.permissions(), 1, 'comment/edit permissions must start before dates finish');
    assert.ok(f.messages.some(message => message.type === 'detailPatch' && message.patch.canComment));
    f.release(); await new Promise(resolve => setImmediate(resolve));
    assert.ok(f.messages.some(message => message.type === 'detailPatch' && message.patch.canSetStartDate));
  } finally { f.release(); f.panels.dispose(); }
});
