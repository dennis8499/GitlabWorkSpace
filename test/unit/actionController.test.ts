import assert from 'node:assert/strict';
import test from 'node:test';
import { ActionController } from '../../src/workspace/actionController';
import { describeAction, effectiveOperationScope, gitActionKinds, isLocalWorkspaceAction, issueActionKinds, issueInvokeKinds, workspaceActionKinds } from '../../src/workspace/actionPolicy';
import { OperationTracker, type WorkspaceOperationState } from '../../src/workspace/operations';

function setup() {
  const sent: any[] = [], actions = new ActionController(request => sent.push(request));
  actions.setContext({ scopeRevision: 'a', accountKey: 'account', rootKey: 'C:/repo' });
  return { actions, sent };
}
const remote = (value: WorkspaceOperationState, revision: number, patch: Partial<WorkspaceOperationState> = {}): WorkspaceOperationState => ({ ...value, hostSessionId: 'host', revision, ...patch });

test('all transport and nested action policies are explicit and control traffic has no lifecycle', () => {
  assert.ok(Object.keys(workspaceActionKinds).length > 80);
  assert.equal(gitActionKinds.commit, 'write'); assert.equal(gitActionKinds.readDiff, 'read');
  assert.equal(issueActionKinds.image, 'read'); assert.equal(issueInvokeKinds.delete, 'write');
  const { actions, sent } = setup();
  for (const type of ['ready', 'reconcileOperations', 'gitAcknowledgeResult', 'publishNotification']) actions.dispatch({ type });
  assert.equal(actions.getSnapshot().length, 0); assert.equal(sent.length, 4);
  assert.equal(describeAction({ type: 'gitAction', action: { type: 'rebasePreview', pullSource: { remote: 'origin', branch: 'main' } } } as any).kind, 'write');
});

test('pagination cancellation bypasses pending reads and distinct sections and graph expansions never join each other', () => {
  const { actions, sent } = setup();
  actions.dispatch({ type: 'retryWorkspaceSection', section: 'projects', mode: 'all', connectedScope: 'scope' });
  actions.dispatch({ type: 'retryWorkspaceSection', section: 'issues', mode: 'all', connectedScope: 'scope' });
  actions.dispatch({ type: 'retryWorkspaceSection', section: 'projects', mode: 'all', connectedScope: 'scope' });
  assert.equal(sent.length, 2, 'only identical section reads join');
  actions.dispatch({ type: 'retryWorkspaceSection', section: 'projects', mode: 'cancel', connectedScope: 'scope' });
  assert.equal(sent.length, 3); assert.equal(actions.getSnapshot().length, 2, 'cancellation is immediate control traffic');
  actions.dispatch({ type: 'loadIssueGraph', connectedScope: 'scope', nodeIds: ['a'] });
  actions.dispatch({ type: 'loadIssueGraph', connectedScope: 'scope', nodeIds: ['b'] });
  actions.dispatch({ type: 'loadIssueGraph', connectedScope: 'scope', cancel: true });
  assert.equal(sent.length, 6);
});

test('Issue Board cancel is immediate control traffic and selections retain latest-wins ordering', () => {
  const { actions, sent } = setup();
  actions.dispatch({ type: 'selectIssueBoard', boardId: 9, connectedScope: 'scope' });
  actions.dispatch({ type: 'selectIssueBoard', boardId: 9, connectedScope: 'scope', mode: 'cancel' });
  assert.equal(sent.length, 2); assert.equal(actions.getSnapshot().length, 1);
  assert.equal(describeAction({ type: 'selectIssueBoard', boardId: 9, mode: 'cancel' } as any).kind, 'control');
  actions.dispatch({ type: 'selectIssueBoard', boardId: 10, connectedScope: 'scope' });
  assert.equal(actions.getSnapshot().filter(value => value.status === 'queued').length, 1);
});

test('on-demand filter reads join identical sections while keeping boards, milestones and scopes independent', () => {
  const { actions, sent } = setup();
  const boards = { type: 'ensureWorkspaceSection', section: 'boards', connectedScope: 'group:a' };
  const first = actions.dispatch(boards);
  assert.equal(first.status, 'started');
  const duplicate = actions.dispatch(boards);
  assert.equal(duplicate.status, 'joined');
  assert.equal(duplicate.operationId, first.operationId);
  assert.equal(actions.dispatch({ ...boards, section: 'milestones' }).status, 'started');
  assert.equal(sent.length, 2);

  const policy = describeAction(boards, { scopeRevision: 'a', accountKey: 'account' });
  assert.equal(policy.kind, 'read');
  assert.equal(policy.concurrency, 'join');
  assert.equal(policy.resourceKey, 'workspace-section:boards');
  assert.equal(policy.label, '載入篩選選項');
  assert.equal(policy.retryable, true);
  assert.equal(policy.notify, false);
  const anotherScope = { ...boards, connectedScope: 'group:b' };
  const refresh = { type: 'retryWorkspaceSection', section: 'boards', connectedScope: 'group:a' };
  assert.notEqual(policy.lockKey, describeAction(anotherScope, { scopeRevision: 'b', accountKey: 'account' }).lockKey);
  assert.notEqual(policy.lockKey, describeAction(refresh, { scopeRevision: 'a', accountKey: 'account' }).lockKey);
  actions.dispose();
});

test('Group changes cancel on-demand filter reads and prevent retrying the old scope', () => {
  const { actions, sent } = setup();
  actions.setContext({ scopeRevision: 'group:a', localOperationScope: 'local:root' });
  const first = actions.dispatch({ type: 'ensureWorkspaceSection', section: 'boards', connectedScope: 'group:a' }).operationId!;
  assert.equal(sent[0].operationScope, 'group:a');
  actions.setContext({ scopeRevision: 'group:b' });
  assert.equal(actions.get(first)?.status, 'cancelled');
  assert.equal(actions.retry(first).status, 'blocked');
  assert.equal(actions.dispatch({ type: 'ensureWorkspaceSection', section: 'boards', connectedScope: 'group:b' }).status, 'started');
  assert.equal(sent[1].operationScope, 'group:b');
  actions.dispose();
});

test('dispatch sets pending synchronously, joins identical reads and separates MR sections', () => {
  const { actions, sent } = setup();
  const read = { type: 'loadMergeRequestSection', projectId: 1, iid: 2, section: 'diffs' };
  const first = actions.dispatch(read), second = actions.dispatch(read);
  assert.equal(first.status, 'started'); assert.equal(second.status, 'joined'); assert.equal(second.operationId, first.operationId);
  assert.equal(actions.isPending('mr:1:2'), true); assert.equal(sent.length, 1);
  assert.equal(actions.dispatch({ ...read, section: 'discussions' }).status, 'started'); assert.equal(sent.length, 2);
});

test('opening Output is a local action without pending operations or notifications', () => {
  const { actions, sent } = setup();
  assert.equal(describeAction({ type: 'openLogs' }).kind, 'local');
  const legacyAction = { type: 'perform', action: 'openAdmin' };
  assert.equal(describeAction(legacyAction).kind, 'local');
  assert.equal(actions.dispatch({ type: 'openLogs' }).status, 'started');
  assert.deepEqual(sent, [{ type: 'openLogs' }]);
  assert.deepEqual(actions.getSnapshot(), []);
});

test('latest selection wins and old receipts cannot release the newer owner', () => {
  const { actions } = setup();
  const first = actions.dispatch({ type: 'selectIssue', projectId: 1, issueIid: 1 }).operationId!;
  const old = actions.get(first)!;
  const second = actions.dispatch({ type: 'selectIssue', projectId: 1, issueIid: 2 }).operationId!;
  assert.equal(actions.get(first)?.status, 'cancelled');
  actions.receive(remote(old, 1, { status: 'succeeded', finishedAt: 2 }));
  assert.equal(actions.get(second)?.status, 'queued'); assert.equal(actions.isPending('issue:1:2'), true);
  actions.receive(remote(actions.get(second)!, 3, { status: 'succeeded', finishedAt: 4 }));
  actions.receive(remote(actions.get(second)!, 2, { status: 'running', finishedAt: undefined }));
  assert.equal(actions.isPending('issue:1:2'), false);
});

test('writes on the same canonical Repo stay exclusive across account scope changes', () => {
  const { actions, sent } = setup();
  const write = { type: 'gitAction', repoId: 'canonical', requestId: 'git-1', action: { type: 'commit', message: 'draft' } };
  actions.dispatch(write);
  actions.setContext({ scopeRevision: 'b', accountKey: 'another', rootKey: 'C:/elsewhere' });
  assert.equal(actions.dispatch({ ...write, requestId: 'git-2', action: { type: 'checkout', name: 'main' } }).status, 'blocked');
  assert.equal(sent.length, 1);
  assert.equal(JSON.stringify(actions.getSnapshot()).includes('draft'), false);
});

test('local actions use the project scope while Clone, MR and Issues retain the selected Group', () => {
  const context = { scopeRevision: 'group:42:epoch:1', localOperationScope: 'project:root:epoch:1' };
  for (const action of ['gitAction', 'scanRepositories', 'loadSkillBranches', 'refreshWorkflowKit', 'installWorkflowKit',
    'copySkillGuidePrompt', 'refreshBmad', 'copyBmadCommand', 'openLogs', 'selectProjectRoot', 'refreshRepositories']) {
    assert.equal(isLocalWorkspaceAction(action), true, action);
    assert.equal(effectiveOperationScope(action, context), context.localOperationScope, action);
  }
  for (const action of ['clone', 'syncRepos', 'selectIssue', 'loadIssueGraph', 'selectMergeRequest', 'issueRequest', 'selectGroup']) {
    assert.equal(isLocalWorkspaceAction(action), false, action);
    assert.equal(effectiveOperationScope(action, context), context.scopeRevision, action);
  }
  assert.equal(isLocalWorkspaceAction({ type: 'perform', action: 'openAnalysis' }), true);
  assert.equal(isLocalWorkspaceAction({ type: 'perform', action: 'openProjects' }), false);
  for (const mode of ['sa', 'bmad', 'git']) {
    assert.equal(effectiveOperationScope({ type: 'refresh', mode }, context), context.localOperationScope);
  }
  assert.equal(effectiveOperationScope({ type: 'refresh', mode: 'clone', projectSource: 'local' }, context), context.localOperationScope);
  assert.equal(effectiveOperationScope({ type: 'refresh', mode: 'clone', projectSource: 'gitlab' }, context), context.scopeRevision);
  assert.equal(effectiveOperationScope({ type: 'refresh', mode: 'developer' }, context), context.scopeRevision);
  assert.equal(effectiveOperationScope('refreshWorkflowKit', { scopeRevision: 'legacy' }), 'legacy');
});

test('switching Group keeps local reads and retries current while cancelling remote reads', () => {
  const { actions, sent } = setup();
  actions.setContext({ scopeRevision: 'group:a', localOperationScope: 'local:root:epoch:1' });
  const local = actions.dispatch({ type: 'loadSkillBranches', repo: 'C:/repo', revision: 'local-revision', requestId: 'branches' }).operationId!;
  const remoteRead = actions.dispatch({ type: 'selectMergeRequest', projectId: 1, iid: 2 }).operationId!;
  const refresh = actions.dispatch({ type: 'refresh', mode: 'git' }).operationId!;
  assert.equal(sent[0].operationScope, 'local:root:epoch:1');
  assert.equal(sent[1].operationScope, 'group:a');
  assert.equal(sent[2].operationScope, 'local:root:epoch:1');
  actions.setContext({ scopeRevision: 'group:b', localOperationScope: 'local:root:epoch:1' });
  assert.equal(actions.get(local)?.status, 'queued');
  assert.equal(actions.get(refresh)?.status, 'queued', 'a refresh retains its dispatched local scope without storing its mode in receipts');
  assert.equal(actions.get(remoteRead)?.status, 'cancelled');
  assert.equal(actions.isCurrentContext(actions.get(local)!), true);
  assert.equal(actions.isCurrentContext(actions.get(remoteRead)!), false);
  assert.equal(actions.isPending('loadSkillBranches'), true);
  actions.complete(local, { status: 'failed', effect: 'none' });
  assert.equal(actions.retry(local).status, 'started');
  assert.equal(sent.at(-1).operationScope, 'local:root:epoch:1');
  assert.equal(actions.retry(remoteRead).status, 'blocked');
  actions.dispose();
});

test('local root and account epoch changes still cancel local reads and preserve canonical write locks', () => {
  const { actions } = setup();
  actions.setContext({ scopeRevision: 'group:a:epoch:1', localOperationScope: 'local:root:epoch:1' });
  const read = actions.dispatch({ type: 'gitAction', repoId: 'canonical', requestId: 'read', action: { type: 'history' } }).operationId!;
  const write = actions.dispatch({ type: 'gitAction', repoId: 'canonical', requestId: 'write', action: { type: 'commit', message: 'retained draft' } }).operationId!;
  actions.setContext({ scopeRevision: 'group:a:epoch:2', localOperationScope: 'local:root:epoch:2' });
  assert.equal(actions.get(read)?.status, 'cancelled');
  assert.equal(actions.get(write)?.status, 'queued');
  assert.equal(actions.isCurrentContext(actions.get(write)!), false);
  assert.equal(actions.dispatch({ type: 'gitAction', repoId: 'canonical', requestId: 'second-write', action: { type: 'checkout', name: 'main' } }).status, 'blocked');
  const nextRead = actions.dispatch({ type: 'refreshWorkflowKit' }).operationId!;
  actions.setContext({ localOperationScope: 'local:different-root:epoch:2', rootKey: 'C:/different-root' });
  assert.equal(actions.get(nextRead)?.status, 'cancelled');
  assert.equal(actions.retry(nextRead).status, 'blocked');
  actions.dispose();
});

test('local receipt restoration and snapshot reconciliation survive a Group switch without replay', () => {
  const { actions, sent } = setup();
  actions.setContext({ scopeRevision: 'group:a', localOperationScope: 'local:root:epoch:1' });
  const restored = actions.restorePending({ requestId: 'old-local-write', resourceKey: 'git:repo', action: 'gitAction', label: 'Commit' });
  assert.equal(restored.scopeRevision, 'local:root:epoch:1');
  actions.reconcile({ sessionId: 'host', revision: 1, operations: [remote(restored, 1, { status: 'running' })] });
  actions.setContext({ scopeRevision: 'group:b' });
  assert.equal(actions.isCurrentContext(actions.get(restored.requestId)!), true);
  actions.reconcile({ sessionId: 'host', revision: 2, operations: [remote(restored, 2, { status: 'succeeded', effect: 'applied' })] });
  assert.equal(actions.get(restored.requestId)?.status, 'succeeded');
  assert.equal(actions.hasPendingWrite('git:repo'), false);
  assert.equal(sent.length, 0);
  const result = actions.dispatch({ type: 'confirmOperationResult', targetOperationId: 'previous-skill-copy',
    recovery: { action: 'copySkillGuidePrompt', resourceKey: 'skill:review' } });
  assert.equal(result.status, 'started'); assert.equal(sent[0].operationScope, 'local:root:epoch:1');
  actions.dispose();
});

test('confirmation without recovery metadata uses a known local target after a Group switch', () => {
  const { actions, sent } = setup();
  actions.setContext({ scopeRevision: 'group:a', localOperationScope: 'local:root:epoch:1' });
  const target = actions.dispatch({ type: 'gitAction', repoId: 'repo', requestId: 'git-write', action: { type: 'commit', message: 'draft' } }).operationId!;
  actions.complete(target, { status: 'failed', effect: 'unknown' });
  actions.setContext({ scopeRevision: 'group:b' });
  actions.dispatch({ type: 'confirmOperationResult', targetOperationId: target });
  assert.equal(sent.at(-1).operationScope, 'local:root:epoch:1');
  assert.equal(actions.get(target)?.effect, 'unknown', 'confirmation does not clear the lock before a host receipt');
  actions.dispose();
});

test('snapshot recovers missed terminal receipts and preserves newer streamed state', () => {
  const { actions } = setup();
  const id = actions.dispatch({ type: 'refresh' }).operationId!, original = actions.get(id)!;
  actions.receive(remote(original, 2, { status: 'running' }));
  actions.reconcile({ sessionId: 'host', revision: 4, operations: [remote(original, 4, { status: 'succeeded', finishedAt: 4 })] });
  assert.equal(actions.isPending(), false);
  actions.reconcile({ sessionId: 'host', revision: 3, operations: [remote(original, 3, { status: 'running' })] });
  assert.equal(actions.get(id)?.status, 'succeeded');
});

test('host restart marks unresolved writes unknown and never automatically resends them', () => {
  const { actions, sent } = setup();
  actions.reconcile({ sessionId: 'host', revision: 0, operations: [] });
  const id = actions.dispatch({ type: 'submitTimeEntry', id: 'time-1' }).operationId!;
  actions.receive(remote(actions.get(id)!, 2, { status: 'running' }));
  actions.reconcile({ sessionId: 'new-host', revision: 0, operations: [] });
  assert.equal(actions.get(id)?.effect, 'unknown');
  assert.equal(actions.dispatch({ type: 'submitTimeEntry', id: 'time-1' }).status, 'blocked');
  assert.equal(sent.length, 1);
  assert.equal(actions.dispatch({ type: 'updateTimeEntry', id: 'time-1', duration: '1h', summary: 'confirmed' }).status, 'started');
  actions.receive(remote(actions.get(id)!, 50, { status: 'succeeded', effect: 'applied' }));
  assert.equal(actions.get(id)?.effect, 'unknown', 'retired host cannot clear the unknown result');
});

test('manual read retry is allowed after failure, never during a running operation', () => {
  const { actions, sent } = setup();
  const id = actions.dispatch({ type: 'refreshWorkflowKit' }).operationId!;
  assert.equal(actions.retry(id).status, 'blocked');
  actions.complete(id, { status: 'failed', error: 'offline' });
  assert.equal(actions.retry(id).status, 'started'); assert.equal(sent.length, 2);
});

test('domain retry handlers replace only existing read retries and rebuild their correlations', () => {
  const { actions, sent } = setup();
  const id = actions.dispatch({ type: 'gitAction', repoId: 'repo', requestId: 'old-read', action: { type: 'refresh' } }).operationId!;
  actions.setRetryHandler(id, () => actions.dispatch({ type: 'gitAction', repoId: 'repo', requestId: 'fresh-read', action: { type: 'refresh' } }));
  assert.equal(actions.retry(id).status, 'blocked');
  actions.complete(id, { status: 'failed', effect: 'none' });
  const retry = actions.retry(id);
  assert.equal(retry.status, 'started'); assert.notEqual(retry.operationId, id);
  assert.equal(retry.correlationId, 'fresh-read'); assert.equal(sent.at(-1).requestId, 'fresh-read');
  const write = actions.dispatch({ type: 'gitAction', repoId: 'other', requestId: 'write', action: { type: 'push' } }).operationId!;
  let writeRetries = 0;
  actions.setRetryHandler(write, () => { writeRetries++; return { status: 'started' }; });
  actions.complete(write, { status: 'failed', effect: 'unknown' });
  assert.equal(actions.retry(write).status, 'blocked'); assert.equal(writeRetries, 0);
  actions.dispose();
});

test('missing acceptance reconciles exact pending IDs instead of leaving queued forever', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { actions, sent } = setup();
  const id = actions.dispatch({ type: 'refresh' }).operationId!;
  t.mock.timers.tick(5000);
  assert.deepEqual(sent.at(-1), { type: 'reconcileOperations', pendingIds: [id] });
  actions.reconcile({ sessionId: 'host', revision: 1, operations: [], requestedIds: [id], missingIds: [id] });
  assert.equal(actions.get(id)?.status, 'failed'); assert.equal(actions.isPending(), false);
  actions.dispose();
});

test('reconciliation can fetch receipts outside the recent history window without replaying writes', async () => {
  const tracker = new OperationTracker();
  const state: WorkspaceOperationState = { requestId: 'first', scopeRevision: 'a', resourceKey: 'x', kind: 'write', action: 'write', phase: '', label: 'write', status: 'queued', startedAt: 1 };
  let calls = 0;
  await tracker.run(state, async () => { calls++; });
  for (let index = 0; index < 110; index++) await tracker.run({ ...state, requestId: `next-${index}` }, async () => {});
  const snapshot = tracker.snapshot(undefined, ['first', 'missing']);
  assert.equal(snapshot.operations.find(item => item.requestId === 'first')?.status, 'succeeded');
  assert.deepEqual(snapshot.missingIds, ['missing']);
  await tracker.run(state, async () => { calls++; }); assert.equal(calls, 1);
});

test('manual confirmation after host restart clears unknown error and permits a new write', () => {
  const { actions } = setup();
  actions.reconcile({ sessionId: 'old', revision: 0, operations: [] });
  const id = actions.dispatch({ type: 'gitAction', requestId: 'git-1', repoId: 'repo', action: { type: 'push', remote: 'origin', branch: 'main' } }).operationId!;
  actions.receive({ ...actions.get(id)!, hostSessionId: 'old', revision: 1, status: 'running' });
  actions.reconcile({ sessionId: 'new', revision: 0, operations: [] });
  assert.equal(actions.get(id)?.effect, 'unknown');
  actions.receive({ ...actions.get(id)!, hostSessionId: 'new', revision: 1, status: 'succeeded', effect: 'applied', error: undefined });
  assert.equal(actions.get(id)?.error, undefined);
  assert.equal(actions.dispatch({ type: 'gitAction', requestId: 'git-2', repoId: 'repo', action: { type: 'push', remote: 'origin', branch: 'other' } }).status, 'started');
  actions.dispose();
});

test('nested Issue writes and workspace relation writes share canonical identity', () => {
  const { actions } = setup();
  const first = actions.dispatch({ type: 'issueRequest', request: { type: 'invoke', issueId: 101, projectId: 1, issueIid: 1, action: 'note' } }).operationId!;
  actions.complete(first, { status: 'failed', effect: 'unknown' });
  assert.equal(actions.dispatch({ type: 'mutateIssueRelations', projectId: 1, issueIid: 1, action: { type: 'createChild', title: 'child' } }).status, 'blocked');
  assert.equal(actions.dispatch({ type: 'mutateIssueRelations', projectId: 1, issueIid: 2, action: { type: 'createChild', title: 'child' } }).status, 'started');
  actions.dispose();
});

test('remote Issue waiting state stays account scoped while the same account keeps its resource lock', () => {
  const { actions } = setup();
  const id = actions.dispatch({ type: 'mutateIssueRelations', projectId: 1, issueIid: 1, action: { type: 'createChild', title: 'child' } }).operationId!;
  actions.complete(id, { status: 'failed', effect: 'unknown' });
  actions.setContext({ scopeRevision: 'another-group', accountKey: 'account' });
  assert.equal(actions.hasPendingWrite('issue:1:1'), true);
  actions.setContext({ scopeRevision: 'another-account', accountKey: 'second-account' });
  assert.equal(actions.hasPendingWrite('issue:1:1'), false);
  assert.equal(actions.dispatch({ type: 'mutateIssueRelations', projectId: 1, issueIid: 1, action: { type: 'createChild', title: 'child' } }).status, 'started');
  actions.dispose();
});

test('restored legacy write metadata reconciles by correlation without resending its payload', async () => {
  const { actions, sent } = setup(), tracker = new OperationTracker();
  const state = actions.restorePending({ requestId: 'legacy-git-request', correlationId: 'legacy-git-request', resourceKey: 'git:repo', action: 'gitAction', label: 'Commit' });
  await tracker.run({ ...state, requestId: 'host-operation' }, async () => ({ effect: 'applied' }));
  actions.dispatch({ type: 'reconcileOperations' });
  assert.deepEqual(sent.at(-1).pendingIds, ['legacy-git-request']);
  actions.reconcile(tracker.snapshot(undefined, ['legacy-git-request']));
  assert.equal(actions.get('legacy-git-request'), undefined);
  assert.equal(actions.findByCorrelation('legacy-git-request')?.status, 'succeeded');
  assert.equal(sent.some(request => request.type === 'gitAction'), false);
  assert.equal(actions.hasPendingWrite('git:repo'), false); actions.dispose();
});

test('restored write with no surviving host receipt becomes uncertain and can be manually reconciled', () => {
  const { actions, sent } = setup();
  actions.restorePending({ requestId: 'lost', correlationId: 'git-lost', resourceKey: 'git:repo', action: 'gitAction', label: 'Push' });
  actions.reconcile({ sessionId: 'new-host', revision: 0, operations: [], requestedIds: ['lost'], missingIds: ['lost'] });
  assert.equal(actions.get('lost')?.effect, 'unknown'); assert.equal(actions.hasPendingWrite('git:repo'), true);
  assert.equal(sent.length, 0);
  actions.receive({ ...actions.get('lost')!, effect: 'none', status: 'succeeded', hostSessionId: 'new-host', revision: 1, error: undefined });
  assert.equal(actions.hasPendingWrite('git:repo'), false); actions.dispose();
});

test('all active and uncertain host operations survive history limits; replay never reruns writes', async () => {
  const tracker = new OperationTracker(), pending: Array<() => void> = [], tasks: Promise<void>[] = [];
  for (let index = 0; index < 25; index++) tasks.push(tracker.run({ requestId: `active-${index}`, scopeRevision: 'a', resourceKey: String(index), action: 'read', kind: 'read', concurrency: 'parallel', phase: 'read', label: 'read', status: 'queued', startedAt: index }, () => new Promise<void>(resolve => pending.push(resolve))));
  assert.equal(tracker.list().length, 25);
  pending.forEach(resolve => resolve()); await Promise.all(tasks);
  let calls = 0;
  const state: WorkspaceOperationState = { requestId: 'write', scopeRevision: 'a', resourceKey: 'repo', lockKey: 'repo', action: 'commit', kind: 'write', phase: 'write', label: 'write', status: 'queued', startedAt: 30 };
  await tracker.run(state, async () => { calls++; return { status: 'failed', effect: 'unknown' }; });
  for (let index = 0; index < 110; index++) await tracker.run({ ...state, requestId: `later-${index}`, resourceKey: String(index), lockKey: String(index) }, async () => {});
  assert.ok(tracker.list().some(item => item.requestId === 'write' && item.effect === 'unknown'));
  await tracker.run(state, async () => { calls++; }); assert.equal(calls, 1);
  await tracker.run({ ...state, requestId: 'blocked' }, async () => { calls++; }); assert.equal(calls, 1);
  tracker.resolveUnknown('write', { effect: 'applied' });
  await tracker.run({ ...state, requestId: 'after-confirmation' }, async () => { calls++; }); assert.equal(calls, 2);
});

test('preflight failure and adapter outcomes produce truthful terminal receipts', async () => {
  const events: WorkspaceOperationState[] = [], tracker = new OperationTracker(state => events.push(state));
  const state: WorkspaceOperationState = { requestId: 'preflight', scopeRevision: 'a', resourceKey: 'x', action: 'write', phase: '', label: '', status: 'queued', startedAt: 1 };
  await assert.rejects(tracker.run(state, async () => { throw new Error('account switching'); }));
  assert.equal(events.at(-1)?.status, 'failed');
  await tracker.run({ ...state, requestId: 'partial' }, async () => { tracker.noteOutcome('partial', { status: 'failed', effect: 'partial', error: 'one item failed' }); });
  assert.equal(events.at(-1)?.effect, 'partial'); assert.equal(events.at(-1)?.status, 'failed');
  await tracker.run({ ...state, requestId: 'applied' }, async () => ({ status: 'succeeded', effect: 'applied', refreshError: 'offline' }));
  assert.equal(events.at(-1)?.status, 'succeeded'); assert.match(events.at(-1)?.phase ?? '', /重新載入失敗/);
});

function historyReceipt(index: number, patch: Partial<WorkspaceOperationState> = {}): WorkspaceOperationState {
  return { requestId: `history-${index}`, scopeRevision: 'a', resourceKey: 'skills', action: 'refreshWorkflowKit',
    kind: 'read', concurrency: 'join', label: 'Skills', phase: 'Done', status: 'succeeded',
    startedAt: index * 10, finishedAt: index * 10 + 5, hostSessionId: 'host', revision: index + 1, ...patch };
}

test('snapshot reconciliation publishes one complete update and duplicate snapshots preserve identity', () => {
  const { actions } = setup(), observed: Array<readonly WorkspaceOperationState[]> = [];
  actions.subscribe(() => observed.push(actions.getSnapshot()));
  const operations = [historyReceipt(0), historyReceipt(1, { status: 'running', finishedAt: undefined })];
  actions.reconcile({ sessionId: 'host', revision: 2, operations });
  assert.equal(observed.length, 1); assert.equal(observed[0].length, 2);
  assert.equal(observed[0][1].status, 'running');
  const current = actions.getSnapshot();
  actions.reconcile({ sessionId: 'host', revision: 2, operations: operations.map(operation => ({ ...operation })).reverse() });
  assert.equal(observed.length, 1); assert.equal(actions.getSnapshot(), current);
  actions.dispose();
});

test('unversioned duplicate receipts do not notify or replace the visible operation snapshot', () => {
  const { actions } = setup();
  const operation = historyReceipt(0, { revision: undefined });
  actions.reconcile({ sessionId: 'host', revision: 1, operations: [operation] });
  const current = actions.getSnapshot(); let notifications = 0;
  actions.subscribe(() => notifications++);
  actions.reconcile({ sessionId: 'host', revision: 2, operations: [{ ...operation }] });
  actions.receive({ ...operation });
  assert.equal(notifications, 0); assert.equal(actions.getSnapshot(), current);
  actions.dispose();
});

test('thirty retained terminals and a stale running snapshot cannot evict or resurrect the latest completion', () => {
  const { actions } = setup(), history = Array.from({ length: 30 }, (_, index) => historyReceipt(index));
  actions.reconcile({ sessionId: 'host', revision: 30, operations: history });
  const running = historyReceipt(30, { requestId: 'current', status: 'running', finishedAt: undefined, revision: 31 });
  actions.receive(running);
  const stale = { sessionId: 'host', revision: 31, operations: [...history, running] };
  actions.receive({ ...running, status: 'succeeded', finishedAt: 400, revision: 32 });
  const current = actions.getSnapshot();
  assert.equal(actions.get(history[0].requestId), undefined);
  actions.reconcile(stale);
  for (const operation of stale.operations) actions.receive(operation);
  assert.equal(actions.get('current')?.status, 'succeeded'); assert.equal(actions.isPending(), false);
  assert.equal(actions.getSnapshot(), current); assert.equal(current.length, 30);
  // Even a later event revision cannot reopen an already completed operation ID.
  actions.receive({ ...history[0], status: 'running', finishedAt: undefined, revision: 100 });
  assert.equal(actions.get(history[0].requestId), undefined); assert.equal(actions.isPending(), false);
  actions.dispose();
});

test('out-of-order history retains the newest timestamps and revisions in stable display order', () => {
  const { actions } = setup();
  const history = Array.from({ length: 45 }, (_, index) => historyReceipt(index, {
    startedAt: Math.floor(index / 3), finishedAt: Math.floor(index / 3) + 1
  }));
  actions.reconcile({ sessionId: 'host', revision: 45, operations: [...history].reverse() });
  assert.deepEqual(actions.getSnapshot().map(operation => operation.requestId), history.slice(-30).map(operation => operation.requestId));
  assert.equal(actions.getSnapshot().at(-1)?.requestId, 'history-44');
  actions.dispose();
});

test('history trimming preserves every active read and unknown write together with its canonical lock', () => {
  const { actions, sent } = setup();
  const active = historyReceipt(0, { requestId: 'active', resourceKey: 'active-read', status: 'running', finishedAt: undefined });
  const unknown = historyReceipt(1, { requestId: 'unknown', resourceKey: 'git:canonical', action: 'gitAction',
    lockKey: 'global:git:canonical', kind: 'write', concurrency: 'exclusive', status: 'failed', effect: 'unknown' });
  const history = Array.from({ length: 70 }, (_, index) => historyReceipt(index + 2));
  let notifications = 0; actions.subscribe(() => notifications++);
  actions.reconcile({ sessionId: 'host', revision: 100, operations: [...history].reverse().concat(active, unknown) });
  assert.equal(notifications, 1); assert.equal(actions.getSnapshot().length, 32);
  assert.equal(actions.get(active.requestId)?.status, 'running'); assert.equal(actions.isPending('active-read'), true);
  assert.equal(actions.get(unknown.requestId)?.effect, 'unknown'); assert.equal(actions.hasPendingWrite('git:canonical'), true);
  assert.equal(actions.dispatch({ type: 'gitAction', repoId: 'canonical', requestId: 'next', action: { type: 'push' } }).status, 'blocked');
  assert.equal(sent.length, 0);
  actions.dispose();
});

test('an unchanged snapshot revision still reconciles restored correlations and exact missing receipts', () => {
  const { actions, sent } = setup();
  actions.reconcile({ sessionId: 'host', revision: 10, operations: [] });
  actions.restorePending({ requestId: 'restored', correlationId: 'git-previous', resourceKey: 'git:repo', action: 'gitAction', label: 'Commit' });
  actions.restorePending({ requestId: 'missing', correlationId: 'git-missing', resourceKey: 'git:other', action: 'gitAction', label: 'Push' });
  let notifications = 0; actions.subscribe(() => notifications++);
  actions.reconcile({ sessionId: 'host', revision: 10, requestedIds: ['restored', 'missing'], missingIds: ['missing'],
    operations: [historyReceipt(0, { requestId: 'host-previous', correlationId: 'git-previous',
      resourceKey: 'git:repo', action: 'gitAction', kind: 'write', effect: 'applied', revision: 5 })] });
  assert.equal(notifications, 1);
  assert.equal(actions.get('restored'), undefined); assert.equal(actions.findByCorrelation('git-previous')?.effect, 'applied');
  assert.equal(actions.hasPendingWrite('git:repo'), false);
  assert.equal(actions.get('missing')?.effect, 'unknown'); assert.equal(actions.hasPendingWrite('git:other'), true);
  assert.equal(sent.length, 0); actions.dispose();
});

test('a restored uncertain write survives an old running correlation alias until its terminal receipt arrives', () => {
  const { actions, sent } = setup();
  actions.reconcile({ sessionId: 'host', revision: 10, operations: [] });
  const restored = actions.restorePending({ requestId: 'legacy', correlationId: 'git-legacy', resourceKey: 'git:repo', action: 'gitAction', label: 'Push' });
  actions.complete(restored.requestId, { status: 'failed', effect: 'unknown' });
  const current = actions.getSnapshot(); let notifications = 0; actions.subscribe(() => notifications++);
  const running = historyReceipt(0, { requestId: 'host-operation', correlationId: 'git-legacy', resourceKey: 'git:repo',
    action: 'gitAction', kind: 'write', status: 'running', finishedAt: undefined, revision: 1 });
  actions.receive(running);
  assert.equal(actions.getSnapshot(), current); assert.equal(notifications, 0);
  assert.equal(actions.get('legacy')?.effect, 'unknown'); assert.equal(actions.hasPendingWrite('git:repo'), true);
  actions.receive({ ...running, status: 'succeeded', effect: 'applied', finishedAt: 2, revision: 2 });
  assert.equal(notifications, 1); assert.equal(actions.get('legacy'), undefined);
  assert.equal(actions.findByCorrelation('git-legacy')?.status, 'succeeded'); assert.equal(actions.hasPendingWrite('git:repo'), false);
  assert.equal(sent.length, 0); actions.dispose();
});
