import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import type { ExtensionContext, Memento } from 'vscode';
import { GitLabClient, GitLabWriteRejectedError, GitLabWriteUnknownError, gitLabWriteFailureEffect, type FetchLike } from '../../src/api/gitLabClient';
import type { GitLabNetworkGate } from '../../src/api/gitLabNetworkGate';
import { issueDeleteAvailability, mergeAvailability } from '../../src/api/actionAvailability';
import { timeEntryTimestamp } from '../../src/api/timeEntry';
import type { GitLabMergeRequest, GitLabProject, GitLabUser } from '../../src/api/types';
import { IssueTimeTracker } from '../../src/workspace/timeTracker';
import { OperationTracker, type WorkspaceOperationState } from '../../src/workspace/operations';

const sha = 'a'.repeat(40);
const project: GitLabProject = { id: 4, name: 'Project', path: 'project', path_with_namespace: 'group/project', web_url: 'https://gitlab.test/group/project', http_url_to_repo: 'https://gitlab.test/group/project.git' };
const user: GitLabUser = { id: 7, name: 'User', username: 'user', is_admin: false };
const issue = { id: 42, iid: 2, project_id: 4, title: 'Issue', state: 'opened', web_url: 'https://gitlab.test/group/project/-/issues/2' };
const mr: GitLabMergeRequest = { id: 9, iid: 1, project_id: 4, title: 'MR', state: 'opened', web_url: 'https://gitlab.test/group/project/-/merge_requests/1', source_branch: 'feature', target_branch: 'main',
  user: { can_merge: true }, draft: false, has_conflicts: false, rebase_in_progress: false, detailed_merge_status: 'mergeable', diff_refs: { head_sha: sha } };

const vscode = { window: { showWarningMessage: async (_message: string, _options: unknown, action: string) => action } };
const loader = require('node:module') as { _load: (name: string, parent: unknown, main: boolean) => unknown };
const originalLoad = loader._load;
loader._load = (name, parent, main) => name === 'vscode' ? vscode : originalLoad(name, parent, main);
let WorkspacePanel: typeof import('../../src/workspace/workspacePanel').WorkspacePanel;
let IssuePanels: typeof import('../../src/issues/issuePanel').IssuePanels;
try {
  ({ WorkspacePanel } = require('../../src/workspace/workspacePanel'));
  ({ IssuePanels } = require('../../src/issues/issuePanel'));
} finally { loader._load = originalLoad; }

const gate = { fetch: async (fetcher: FetchLike, input: URL, init: RequestInit, _read: unknown, _limit: unknown, onStart: () => void) => {
  onStart(); return fetcher(input, init);
} } as unknown as GitLabNetworkGate;

function apiFixture(initial: unknown) {
  let response: unknown = initial;
  const calls: Array<{ url: URL; body: any }> = [], writes: unknown[] = [];
  const fetcher: FetchLike = async (input, init) => {
    calls.push({ url: new URL(String(input)), body: JSON.parse(String(init?.body)) });
    if (response instanceof Error) throw response;
    if (response instanceof Response) return response.clone();
    return new Response(JSON.stringify(response), { headers: { 'content-type': 'application/json' } });
  };
  const client = new GitLabClient('https://gitlab.test', 'test-token', fetcher, undefined, context => writes.push(context), undefined, undefined, 30_000, gate);
  return { client, calls, writes, setResponse: (next: unknown) => { response = next; } };
}

const success = { data: { timelogCreate: { timelog: { id: 'gid://gitlab/Timelog/3' }, errors: [] } } };

test('local calendar dates become midnight in each local timezone and reject invalid or future dates', () => {
  const modulePath = require.resolve('../../src/api/timeEntry');
  const program = `const {timeEntryTimestamp}=require(process.argv[1]); process.stdout.write(timeEntryTimestamp('2024-04-18',new Date('2024-04-18T11:30:00Z')))`;
  for (const [timezone, expected] of [['Asia/Taipei', '2024-04-17T16:00:00.000Z'], ['America/Los_Angeles', '2024-04-18T07:00:00.000Z']]) {
    const result = spawnSync(process.execPath, ['-e', program, modulePath], { env: { ...process.env, TZ: timezone }, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr); assert.equal(result.stdout, expected);
  }
  const now = new Date('2024-04-18T11:30:00Z');
  assert.equal(timeEntryTimestamp(undefined, now), now.toISOString());
  assert.throws(() => timeEntryTimestamp('2024-02-30', now), /日期/);
  assert.throws(() => timeEntryTimestamp('2025-01-01', now), /未來/);
});

test('time mutation includes required inputs and distinguishes rejected, ambiguous and successful writes', async () => {
  const f = apiFixture(success), before = Date.now();
  assert.equal(await f.client.createIssueTimelog(42, '30m'), 'gid://gitlab/Timelog/3');
  const input = f.calls[0].body.variables.input;
  assert.equal(input.summary, ''); assert.equal(input.timeSpent, '30m');
  assert.ok(Date.parse(input.spentAt) >= before && Date.parse(input.spentAt) <= Date.now());
  assert.match(f.calls[0].body.query, /timelog\s*\{\s*id\s*\}/);
  for (const [body, effect] of [
    [{ errors: [{ message: 'Invalid input' }] }, 'none'],
    [{ data: { timelogCreate: { timelog: null, errors: ['Rejected'] } } }, 'none'],
    [{ data: { timelogCreate: null }, errors: [{ message: 'Execution failed' }] }, 'unknown'],
    [{ data: { timelogCreate: { errors: [] } } }, 'unknown'],
    [new Response('{}', { status: 403 }), 'none'],
    [new Response('{}', { status: 408 }), 'unknown'],
    [new TypeError('Connection lost after send'), 'unknown']
  ] as const) {
    f.setResponse(body);
    await assert.rejects(f.client.createIssueTimelog(42, '30m'), (error: unknown) => gitLabWriteFailureEffect(error) === effect);
  }
  assert.equal(f.calls.length, 8, 'writes are never automatically retried');
});

test('Issue deletion distinguishes owner evidence from edit and Work Item permissions', () => {
  for (const level of [10, 20, 30, 40]) {
    assert.equal(issueDeleteAvailability({ ...project, permissions: { project_access: { access_level: level } } }, user).status, 'denied');
  }
  assert.equal(issueDeleteAvailability({ ...project, permissions: { group_access: { access_level: 50 } } }, user).status, 'allowed');
  assert.equal(issueDeleteAvailability({ ...project, owner: { id: user.id } }, user).status, 'allowed');
  assert.equal(issueDeleteAvailability({ ...project, permissions: { project_access: { access_level: 30 } } }, { ...user, is_admin: true }).status, 'unknown');
  assert.equal(issueDeleteAvailability({ ...project, permissions: { project_access: { access_level: 30 } } }, { ...user, is_admin: undefined }).status, 'unknown');
  assert.equal(issueDeleteAvailability(project, user).status, 'unknown');
});

test('MR availability requires explicit permission, complete conditions and the reviewed SHA', () => {
  assert.equal(mergeAvailability(mr, sha).status, 'allowed');
  for (const change of [
    { user: { can_merge: false } }, { state: 'closed' }, { merge_commit_sha: 'c'.repeat(40) }, { draft: true }, { has_conflicts: true }, { rebase_in_progress: true },
    { detailed_merge_status: 'ci_must_pass' }, { detailed_merge_status: 'discussions_not_resolved' }
  ]) assert.equal(mergeAvailability({ ...mr, ...change }, sha).status, 'denied');
  for (const change of [
    { user: undefined }, { draft: undefined }, { has_conflicts: undefined }, { rebase_in_progress: undefined },
    { detailed_merge_status: 'checking' }, { detailed_merge_status: 'unknown_new_status' }
  ]) assert.equal(mergeAvailability({ ...mr, ...change }, sha).status, 'unknown');
  assert.equal(mergeAvailability(mr, 'b'.repeat(40)).status, 'unknown');
  assert.match(mergeAvailability({ ...mr, detailed_merge_status: 'ci_must_pass' }, sha).reason ?? '', /Pipeline/);
  assert.match(mergeAvailability({ ...mr, detailed_merge_status: 'checking' }, sha).reason ?? '', /檢查/);
});

function memoryState() {
  const values = new Map<string, unknown>();
  let failPosted = false, failSending = false;
  const state: Memento = { keys: () => [...values.keys()], get: <T>(key: string, fallback?: T) => (values.get(key) ?? fallback) as T,
    update: async (key, value) => {
      if (failPosted && Array.isArray(value) && value.some(item => item.phase === 'posted')) throw new Error('disk unavailable');
      if (failSending && Array.isArray(value) && value.some(item => item.phase === 'sending')) throw new Error('disk unavailable');
      values.set(key, value);
    } };
  return { state, failPosted: () => { failPosted = true; }, failSending: () => { failSending = true; } };
}

async function timerFixture(response: unknown) {
  const storage = memoryState(), timer = new IssueTimeTracker(storage.state), wire = apiFixture(response);
  await timer.setScope('https://gitlab.test', user.id);
  const entry = await timer.addManual(project, issue, '30m', '');
  const client = Object.assign(wire.client, { getIssue: async () => issue, getIssuePermissions: async () => ({ updateIssue: true }) });
  const outcomes: any[] = [];
  const host: any = Object.create(WorkspacePanel.prototype);
  Object.assign(host, { timer, session: { getClient: async () => client, ensureInstanceChecked: async () => undefined,
    issueCapabilities: { issuePermissionFields: ['updateIssue'], timelogCreate: true, timelogCreateDated: true, timelogCreateSummary: true } },
  enqueueTimer: async (task: () => Promise<unknown>) => task(), publishTimers: () => undefined, post: () => undefined,
  noteOutcome: (outcome: unknown) => outcomes.push(outcome) });
  return { ...wire, host, timer, entry, storage, outcomes };
}

test('timer rejection becomes retryable while uncertain writes survive restart and remain locked', async () => {
  const rejected = await timerFixture({ errors: [{ message: 'Invalid input' }] });
  await assert.rejects(rejected.host.submitTime(rejected.entry.id), (error: unknown) => (error as any).effect === 'none');
  assert.equal(rejected.timer.list()[0].phase, 'ready'); assert.match(rejected.timer.list()[0].lastError ?? '', /Invalid input/);
  rejected.setResponse(success); await rejected.host.submitTime(rejected.entry.id);
  assert.equal(rejected.timer.list()[0].phase, 'posted'); assert.equal(rejected.calls.length, 2);

  const uncertain = await timerFixture(new TypeError('Disconnected'));
  await assert.rejects(uncertain.host.submitTime(uncertain.entry.id), (error: unknown) => (error as any).effect === 'unknown');
  assert.equal(uncertain.timer.list()[0].phase, 'uncertain');
  await assert.rejects(uncertain.host.submitTime(uncertain.entry.id)); assert.equal(uncertain.calls.length, 1);
  const restored = new IssueTimeTracker(uncertain.storage.state); await restored.setScope('https://gitlab.test', user.id);
  assert.equal(restored.list()[0].phase, 'uncertain');
});

test('time operations release their resource after rejection and retain it after an uncertain write', async () => {
  for (const [response, expectedEffect] of [[{ errors: [{ message: 'Invalid input' }] }, 'none'], [new TypeError('Disconnected'), 'unknown']] as const) {
    const f = await timerFixture(response), operations = new OperationTracker();
    let operationId = 'first';
    f.host.noteOutcome = (outcome: unknown) => operations.noteOutcome(operationId, outcome as never);
    const state = (id: string): WorkspaceOperationState => ({ requestId: id, scopeRevision: 'scope', resourceKey: `time:${f.entry.id}`,
      action: 'submitTimeEntry', label: 'Submit', phase: 'running', status: 'queued', startedAt: Date.now(), kind: 'write' });
    await assert.rejects(operations.run(state(operationId), () => f.host.submitTime(f.entry.id)));
    assert.equal(operations.get(operationId)?.effect, expectedEffect);
    operationId = 'second'; f.setResponse(success);
    await operations.run(state(operationId), () => f.host.submitTime(f.entry.id));
    assert.equal(operations.get(operationId)?.effect, expectedEffect === 'none' ? 'applied' : 'none');
    assert.equal(f.calls.length, expectedEffect === 'none' ? 2 : 1);
  }
});

test('Issue time entry sends local midnight and a blank date sends the current time', async () => {
  const calls: unknown[][] = [];
  const client = { createIssueTimelog: async (...args: unknown[]) => { calls.push(args); return 'gid://gitlab/Timelog/3'; } };
  const session: any = { getClient: async () => client, baseUrl: 'https://gitlab.test', selectedGroup: { id: 1 },
    issueCapabilities: { timelogCreate: true, timelogCreateDated: true, timelogCreateSummary: true } };
  const panels = new IssuePanels({} as ExtensionContext, session, () => undefined);
  Object.assign(panels, { ready: true, suspended: true, issue, mode: 'detail', lastSnapshot: { type: 'detailData', data: { issue, canLogTime: true } } });
  try {
    const action = (spentDate?: string) => ({ type: 'invoke', issueId: issue.id, action: 'spend', payload: { duration: '30m', spentDate } });
    await panels.handle(action('2024-04-18'));
    assert.equal(calls[0][3], new Date(2024, 3, 18, 0, 0, 0, 0).toISOString());
    const before = Date.now(); await panels.handle(action());
    assert.ok(Date.parse(String(calls[1][3])) >= before && Date.parse(String(calls[1][3])) <= Date.now());
    await assert.rejects(panels.handle(action('2999-01-01')), /未來/);
    assert.equal(calls.length, 2);
  } finally { panels.dispose(); }
});

test('confirmed timer write remains applied when local persistence fails', async () => {
  const f = await timerFixture(success); f.storage.failPosted();
  await f.host.submitTime(f.entry.id);
  assert.equal(f.timer.list()[0].phase, 'posted');
  assert.equal(f.outcomes.at(-1).effect, 'applied'); assert.match(f.outcomes.at(-1).refreshError, /disk unavailable/);
  await assert.rejects(f.timer.beginSubmit(f.entry.id)); assert.equal(f.calls.length, 1);
});

test('a failure to persist the sending phase leaves the timer ready and sends no request', async () => {
  const f = await timerFixture(success); f.storage.failSending();
  await assert.rejects(f.host.submitTime(f.entry.id), (error: unknown) => (error as any).effect === 'none');
  assert.equal(f.timer.list()[0].phase, 'ready'); assert.match(f.timer.list()[0].lastError ?? '', /尚未送出/);
  assert.equal(f.calls.length, 0);
});

test('MR Host rechecks permission and SHA after confirmation before writing', async () => {
  for (const [first, second, expectedWrites] of [
    [{ ...mr, user: { can_merge: false } }, mr, 0],
    [mr, { ...mr, draft: true }, 0],
    [mr, { ...mr, diff_refs: { head_sha: 'b'.repeat(40) } }, 0],
    [mr, mr, 1]
  ] as const) {
    let reads = 0, writes = 0;
    const client = { getMergeRequest: async () => reads++ === 0 ? first : second,
      getRepositoryBranch: async () => ({ commit: { id: 'b'.repeat(40) } }), mergeMergeRequest: async () => { writes++; } };
    const host: any = Object.create(WorkspacePanel.prototype);
    Object.assign(host, { session: { getClient: async () => client }, resolveGroupProject: async () => undefined,
      post: () => undefined, noteOutcome: () => undefined, reconcileAfterWrite: async () => undefined });
    if (expectedWrites) await host.mergeMergeRequest(4, 1, sha);
    else await assert.rejects(host.mergeMergeRequest(4, 1, sha));
    assert.equal(writes, expectedWrites);
    if (expectedWrites) assert.equal(reads, 2);
  }
});

test('Issue Host rechecks owner access after confirmation before deleting', async () => {
  for (const [level, expected] of [[50, 1], [30, 0]] as const) {
    let writes = 0;
    const client = { getProject: async () => ({ ...project, permissions: { group_access: { access_level: level } } }),
      getCurrentUser: async () => user, getIssue: async () => issue, deleteIssue: async () => { writes++; } };
    const session: any = { getClient: async () => client, baseUrl: 'https://gitlab.test', selectedGroup: { id: 1 } };
    const panels = new IssuePanels({} as ExtensionContext, session, () => undefined);
    Object.assign(panels, { ready: true, issue, mode: 'detail', lastSnapshot: { type: 'detailData', data: { issue, deleteAvailability: { status: 'allowed' } } } });
    try {
      const action = { type: 'invoke', issueId: issue.id, action: 'delete' };
      if (expected) await panels.handle(action); else await assert.rejects(panels.handle(action));
      assert.equal(writes, expected);
      if (!expected) assert.equal((panels as any).lastSnapshot.data.deleteAvailability.status, 'denied');
    } finally { panels.dispose(); }
  }
});

test('an MR recheck that discovers changed permissions updates the displayed action state', async () => {
  let reads = 0, writes = 0, snapshots = 0;
  const client = { getMergeRequest: async () => reads++ === 0 ? mr : { ...mr, user: { can_merge: false } },
    getRepositoryBranch: async () => ({ commit: { id: 'b'.repeat(40) } }), mergeMergeRequest: async () => { writes++; } };
  const host: any = Object.create(WorkspacePanel.prototype);
  Object.assign(host, { session: { getClient: async () => client }, resolveGroupProject: async () => undefined,
    selectedMergeRequest: { request: mr, diffs: [], discussions: [], sections: { diffs: { status: 'idle' }, discussions: { status: 'idle' } }, freshness: { state: 'not_checked' } },
    sendSnapshot: () => { snapshots++; }, post: () => undefined, noteOutcome: () => undefined });
  await assert.rejects(host.mergeMergeRequest(4, 1, sha));
  assert.equal(writes, 0); assert.equal(snapshots, 1);
  assert.equal(host.selectedMergeRequest.mergeAvailability.status, 'denied');
});

test('account changes during MR confirmation do not send a merge request', async () => {
  let writes = 0;
  const client = { getMergeRequest: async () => mr, getRepositoryBranch: async () => ({ commit: { id: 'b'.repeat(40) } }),
    mergeMergeRequest: async () => { writes++; } };
  const session = { connectionEpoch: 1, selectedGroup: { id: 1 }, getClient: async () => client };
  const host: any = Object.create(WorkspacePanel.prototype);
  Object.assign(host, { session, resolveGroupProject: async () => undefined, noteOutcome: () => undefined });
  const original = vscode.window.showWarningMessage;
  vscode.window.showWarningMessage = async (_message, _options, action) => { session.connectionEpoch++; return action; };
  try { await assert.rejects(host.mergeMergeRequest(4, 1, sha), /變更/); assert.equal(writes, 0); }
  finally { vscode.window.showWarningMessage = original; }
});

test('Issue navigation during delete confirmation does not delete the previously selected Issue', async () => {
  let writes = 0;
  const client = { getProject: async () => ({ ...project, permissions: { group_access: { access_level: 50 } } }),
    getCurrentUser: async () => user, getIssue: async () => issue, deleteIssue: async () => { writes++; } };
  const session: any = { getClient: async () => client, baseUrl: 'https://gitlab.test', selectedGroup: { id: 1 }, connectionEpoch: 1 };
  const panels = new IssuePanels({} as ExtensionContext, session, () => undefined);
  Object.assign(panels, { ready: true, issue, mode: 'detail', lastSnapshot: { type: 'detailData', data: { issue, deleteAvailability: { status: 'allowed' } } } });
  const original = vscode.window.showWarningMessage;
  vscode.window.showWarningMessage = async (_message, _options, action) => { (panels as any).navigationVersion++; return action; };
  try {
    await assert.rejects(panels.handle({ type: 'invoke', issueId: issue.id, action: 'delete' }), /變更/);
    assert.equal(writes, 0);
  } finally { vscode.window.showWarningMessage = original; panels.dispose(); }
});
