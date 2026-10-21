import assert from 'node:assert/strict';
import test from 'node:test';
import type { ExtensionContext } from 'vscode';
import type { GitLabClient } from '../../src/api/gitLabClient';
import { GitLabReadCache } from '../../src/api/gitLabReadCache';
import type { GitLabSession } from '../../src/connection/session';
import type { GitLabEmojiReaction } from '../../src/api/types';
import type { IssueDetailData, IssuePanelResponse } from '../../src/issues/protocol';
import { describeAction } from '../../src/workspace/actionPolicy';

const tick = () => new Promise<void>(resolve => setImmediate(resolve));

async function fixture() {
  const loader = require('node:module'), original = loader._load;
  loader._load = (name: string, ...args: unknown[]) => name === 'vscode' ? {} : original(name, ...args);
  let Panels: typeof import('../../src/issues/issuePanel').IssuePanels;
  try { Panels = require('../../src/issues/issuePanel').IssuePanels; } finally { loader._load = original; }
  const issue = { id: 100, iid: 1, project_id: 1, title: 'Demand loading', state: 'opened', updated_at: '2026-10-21T01:00:00Z' };
  const projects = [{ id: 1, path_with_namespace: 'team/one' }, { id: 2, path_with_namespace: 'team/two' }];
  const reads: string[] = [], writes: string[] = [], messages: IssuePanelResponse[] = [];
  let now = 0, refreshes = 0;
  const cache = new GitLabReadCache(60_000, 256, () => now);
  const reactions = new Map<number, GitLabEmojiReaction[]>();
  const client = {
    withReadSignal: (_signal: AbortSignal) => client,
    getIssue: async () => { reads.push('issue'); return issue; },
    getProject: async (id: number) => { reads.push('project'); return projects.find(project => project.id === id)!; },
    getCurrentUser: async () => { reads.push('user'); return { id: 9 }; },
    listGroupProjects: async () => projects,
    canCreateIssue: async () => { reads.push('create-permission'); return true; },
    getIssuePermissions: async () => { reads.push('permissions'); return { updateIssue: true, createNote: true }; },
    listProjectMembers: async () => { reads.push('members'); return [{ id: 9, name: 'Tester' }]; },
    listProjectLabels: async () => { reads.push('labels'); return [{ id: 4, name: 'bug' }]; },
    listProjectMilestones: async () => { reads.push('milestones'); return [{ id: 5, title: 'Release' }]; },
    listProjectIssueTemplateNames: async () => { reads.push('templates'); return [{ key: 'bug', name: 'Bug' }]; },
    listIssueDiscussions: async () => { reads.push('activity'); return [{ id: 'thread', notes: Array.from({ length: 200 }, (_, index) => ({ id: index + 1, system: index === 199 })) }]; },
    listIssueReactions: async () => { reads.push('issue-reactions'); return []; },
    listIssueNoteReactions: async (_project: number, _iid: number, note: number) => { reads.push('note:' + note); return reactions.get(note) ?? []; },
    addIssueReaction: async () => { writes.push('issue'); return {}; },
    removeIssueReaction: async () => { writes.push('issue-delete'); },
    addIssueNoteReaction: async (_project: number, _iid: number, note: number) => {
      writes.push('note:' + note); const reaction = { id: 50 + note, name: 'thumbsup', user: { id: 9 } } as GitLabEmojiReaction;
      reactions.set(note, [reaction]); return reaction;
    },
    removeIssueNoteReaction: async (_project: number, _iid: number, note: number) => { writes.push('note-delete:' + note); reactions.set(note, []); }
  };
  const session = { selectedGroup: { id: 3 }, getClient: async () => client, ensureInstanceChecked: async () => {},
    issueCapabilities: { issuePermissionSource: 'issue', issuePermissionFields: ['updateIssue', 'createNote'], createPermission: true },
    cachedRead: <T>(key: string, load: (client: GitLabClient, signal: AbortSignal) => Promise<T>, options: { signal?: AbortSignal; force?: boolean } = {}) =>
      cache.get(key, signal => load(client as unknown as GitLabClient, signal), options)
  } as unknown as GitLabSession;
  const panels = new Panels!({} as ExtensionContext, session, () => { refreshes++; });
  panels.setWorkspace({ post: message => { if (message.type === 'issueResponse') messages.push(message.response); }, navigate: () => {}, show: async () => {} });
  Object.assign(panels, { ready: true });
  const detail = () => (panels as unknown as { lastSnapshot: { data: IssueDetailData } }).lastSnapshot.data;
  const options = () => (panels as unknown as { lastSnapshot: Extract<IssuePanelResponse, { type: 'createData' }> }).lastSnapshot.options!;
  return { panels, client, reads, writes, messages, issue, detail, options, cache, advance: (ms: number) => { now += ms; }, refreshes: () => refreshes };
}

test('creation defers independent fields/templates and editing never loads template names', async () => {
  const f = await fixture();
  try {
    await f.panels.showCreate();
    assert.deepEqual(f.reads, ['create-permission']);
    await f.panels.handle({ type: 'loadFormOptions', projectId: 1, section: 'templates' });
    await f.panels.handle({ type: 'loadFormOptions', projectId: 1, section: 'fields' });
    assert.equal(f.options().templates.length, 1, 'fields completion retains the independently loaded templates');
    assert.equal(f.options().states?.fields?.status, 'ready'); assert.equal(f.options().states?.templates?.status, 'ready');
    const patches = f.messages.filter(message => message.type === 'projectData');
    assert.ok(patches.every(message => message.preserveDraft === true));
    await f.panels.handle({ type: 'selectProject', projectId: 2 });
    assert.equal(f.options().states?.fields?.status, 'idle');
    assert.equal(f.reads.filter(read => ['members', 'labels', 'milestones', 'templates'].includes(read)).length, 4);
    await f.panels.showIssue(f.issue as never); await tick();
    await f.panels.handle({ type: 'loadSection', sections: ['options'] });
    assert.equal(f.reads.filter(read => read === 'templates').length, 1);
    assert.equal(f.detail().options.templates.length, 0);
  } finally { f.panels.dispose(); }
});

test('creation option reads join per group and stale project responses cannot replace the new selection', async () => {
  const f = await fixture(); let release!: () => void;
  const delayed = new Promise<void>(resolve => { release = resolve; });
  f.client.listProjectMembers = async () => { f.reads.push('members'); await delayed; return [{ id: 9, name: 'Tester' }]; };
  try {
    await f.panels.showCreate();
    const first = f.panels.handle({ type: 'loadFormOptions', projectId: 1, section: 'fields' });
    const duplicate = f.panels.handle({ type: 'loadFormOptions', projectId: 1, section: 'fields' });
    await tick(); assert.equal(f.reads.filter(read => read === 'members').length, 1);
    await f.panels.handle({ type: 'loadFormOptions', projectId: 1, section: 'templates' });
    assert.equal(f.options().states?.templates?.status, 'ready');
    await f.panels.handle({ type: 'selectProject', projectId: 2 });
    release(); await Promise.all([first, duplicate]);
    assert.equal(f.options().states?.fields?.status, 'idle'); assert.deepEqual(f.options().members, []);
    await assert.rejects(f.panels.handle({ type: 'loadFormOptions', projectId: 1, section: 'fields' }), /project changed/);
  } finally { release(); f.panels.dispose(); }
});

test('Issue metadata and note reactions reuse the 60-second read cache without caching permissions', async () => {
  const f = await fixture();
  try {
    await f.panels.showIssue(f.issue as never); await tick();
    await f.panels.handle({ type: 'loadNoteReactions', noteId: 1 });
    await f.panels.showIssue(f.issue as never); await tick();
    await f.panels.handle({ type: 'loadNoteReactions', noteId: 1 });
    for (const read of ['issue', 'project', 'user', 'note:1']) assert.equal(f.reads.filter(value => value === read).length, 1, read);
    assert.equal(f.reads.filter(read => read === 'permissions').length, 2);
    f.advance(60_001);
    await f.panels.showIssue(f.issue as never); await tick();
    await f.panels.handle({ type: 'loadNoteReactions', noteId: 1 });
    for (const read of ['issue', 'project', 'user', 'note:1']) assert.equal(f.reads.filter(value => value === read).length, 2, read);
  } finally { f.panels.dispose(); }
});

test('200 comments produce no reaction fanout until individual targets are requested', async () => {
  const f = await fixture();
  try {
    await f.panels.showIssue(f.issue as never); await tick();
    assert.equal(f.reads.some(read => read.startsWith('note:') || read === 'issue-reactions'), false);
    await f.panels.handle({ type: 'loadSection', sections: ['reactions'] });
    assert.equal(f.reads.filter(read => read.startsWith('note:')).length, 0);
    await Promise.all([f.panels.handle({ type: 'loadNoteReactions', noteId: 1 }), f.panels.handle({ type: 'loadNoteReactions', noteId: 1 }), f.panels.handle({ type: 'loadNoteReactions', noteId: 2 })]);
    assert.deepEqual(f.reads.filter(read => read.startsWith('note:')).sort(), ['note:1', 'note:2']);
    assert.deepEqual(Object.keys(f.detail().noteReactions).sort(), ['1', '2']);
    assert.equal(f.detail().noteReactionStates?.[1].status, 'ready'); assert.equal(f.detail().noteReactionStates?.[2].status, 'ready');
    await assert.rejects(f.panels.handle({ type: 'loadNoteReactions', noteId: 200 }), /not part of this issue/);
    await assert.rejects(f.panels.handle({ type: 'loadNoteReactions', noteId: 999 }), /not part of this issue/);
  } finally { f.panels.dispose(); }
});

test('confirmed emoji writes refresh only their target and refresh failure retains the applied outcome', async () => {
  const f = await fixture();
  try {
    await f.panels.showIssue(f.issue as never); await tick();
    const baseline = f.reads.length;
    await f.panels.handle({ type: 'invoke', requestId: 'add-note', issueId: f.issue.id, action: 'reactNote', payload: { noteId: 1, name: 'thumbsup' } });
    assert.deepEqual(f.reads.slice(baseline), ['note:1']); assert.equal(f.refreshes(), 0);
    assert.equal(f.detail().noteReactions[1][0].user.id, 9);
    const afterNote = f.reads.length;
    await f.panels.handle({ type: 'invoke', requestId: 'add-issue', issueId: f.issue.id, action: 'react', payload: { name: 'thumbsup' } });
    assert.deepEqual(f.reads.slice(afterNote), ['issue-reactions']); assert.equal(f.refreshes(), 0);
    await assert.rejects(f.panels.handle({ type: 'invoke', issueId: f.issue.id, action: 'unreactNote', payload: { noteId: 1, reactionId: 999 } }), /not yours/);
    f.client.listIssueNoteReactions = async () => { throw new Error('Reaction refresh unavailable'); };
    await f.panels.handle({ type: 'invoke', requestId: 'confirmed-refresh-error', issueId: f.issue.id, action: 'reactNote', payload: { noteId: 1, name: 'thumbsup' } });
    const result = f.messages.filter(message => message.type === 'actionResult' && message.requestId === 'confirmed-refresh-error').at(-1);
    assert.equal(result?.effect, 'applied'); assert.match(result?.refreshError ?? '', /refresh unavailable/);
    assert.equal(f.writes.filter(write => write === 'note:1').length, 2, 'the confirmed mutation is never resent during reconciliation');
  } finally { f.panels.dispose(); }
});

test('form sections and note IDs have independent joined read identities', () => {
  const policy = (request: unknown) => describeAction({ type: 'issueRequest', request } as never, { scopeRevision: 'scope' });
  const fields = policy({ type: 'loadFormOptions', projectId: 1, section: 'fields' });
  const templates = policy({ type: 'loadFormOptions', projectId: 1, section: 'templates' });
  assert.equal(fields.kind, 'read'); assert.equal(fields.concurrency, 'join'); assert.notEqual(fields.lockKey, templates.lockKey);
  assert.notEqual(policy({ type: 'loadNoteReactions', projectId: 1, issueIid: 2, noteId: 3 }).lockKey,
    policy({ type: 'loadNoteReactions', projectId: 1, issueIid: 2, noteId: 4 }).lockKey);
});

test('suspending a loading form or note restores an idle entry and ignores its cancelled result', async () => {
  const f = await fixture(); let release!: () => void;
  const delayed = new Promise<void>(resolve => { release = resolve; });
  f.client.listProjectMembers = async () => { await delayed; return [{ id: 9, name: 'Tester' }]; };
  try {
    await f.panels.showCreate();
    const pending = f.panels.handle({ type: 'loadFormOptions', projectId: 1, section: 'fields' }); await tick();
    assert.equal(f.options().states?.fields?.status, 'loading');
    f.panels.suspendReads();
    assert.equal(f.options().states?.fields?.status, 'idle');
    release(); await pending;
    assert.equal(f.options().states?.fields?.status, 'idle');
    await f.panels.handle({ type: 'ready' });
    await f.panels.handle({ type: 'loadFormOptions', projectId: 1, section: 'fields' });
    assert.equal(f.options().states?.fields?.status, 'ready');
    await f.panels.showIssue(f.issue as never); await tick();
    Object.assign(f.detail(), { noteReactionStates: { 1: { status: 'loading' } } });
    f.panels.suspendReads();
    assert.equal(f.detail().noteReactionStates?.[1].status, 'idle');
  } finally { release(); f.panels.dispose(); }
});
