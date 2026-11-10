import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { JSDOM, VirtualConsole } from 'jsdom';
import { build } from 'vite';

// Exercise the production IssueView with durable drafts, without writing shared
// extension bundles or depending on a previously generated test entry.
const result = await build({ configFile: fileURLToPath(new URL('../../vite.issue-test.config.mjs', import.meta.url)), logLevel: 'silent',
  plugins: [{ name: 'child-task-draft-test-entry', enforce: 'pre', load(id) {
    if (!id.replaceAll('\\', '/').endsWith('/src/webview/issue-test.tsx')) return;
    return `/** @jsxImportSource preact */
      import { render } from 'preact';
      import { useEffect, useRef, useState } from 'preact/hooks';
      import { IssueView } from './main';
      function TestApp() {
        const [snapshot, setSnapshot] = useState(window.initialSnapshot);
        const saved = useRef(window.initialDrafts || {});
        const scope = snapshot.instanceUserScope;
        useEffect(() => {
          const receive = event => {
            if (event.data.type === 'snapshot') setSnapshot(event.data.snapshot);
            else window.dispatchEvent(new CustomEvent('workspaceIssueResponse', { detail: event.data }));
          };
          window.addEventListener('message', receive);
          return () => window.removeEventListener('message', receive);
        }, []);
        return <IssueView key={scope} snapshot={snapshot} draftState={saved.current[scope]}
          onDraftStateChange={next => { saved.current = { ...saved.current, [scope]: next }; window.savedDrafts = saved.current; }}
          onWorkspaceRequest={request => window.requests.push(request)}
          onWorkspaceAction={request => window.workspaceRequests.push(request)} />;
      }
      render(<TestApp />, document.getElementById('app'));`;
  } }], build: { write: false, emptyOutDir: false } });
const script = result.output.find(item => item.type === 'chunk' && item.isEntry).code.replaceAll('import.meta.url', 'document.baseURI');

const project = { id: 1, path_with_namespace: 'team/service', web_url: 'https://gitlab.test/team/service' };
const user = { id: 7, name: 'Tester', username: 'tester' };
const task = (id = 'task-a') => ({ id, iid: id === 'task-a' ? '2' : '3', title: id, description: `Server ${id}`, state: 'OPEN', canEdit: true });
const snapshot = (account = 'account-a') => ({ instanceUserScope: account, operationScope: account, issues: [], projects: [], timers: [] });
const detail = (issueId = 101, tasks = [task(), task('task-b')], status = 'ready') => ({
  issue: { id: issueId, iid: issueId, project_id: 1, title: `Issue ${issueId}`, state: 'opened', labels: [], assignees: [] },
  project, projects: [project], user, options: { members: [], labels: [], milestones: [], templates: [] },
  discussions: [], links: [], tasks, todos: [], timelogs: [], mergeRequests: [], reactions: [], noteReactions: {},
  sections: { tasks: status, options: 'ready', activity: 'ready' }, warnings: [], startDate: null,
  canEdit: true, canManageChildren: true, parentWorkItemId: `parent-${issueId}`
});

async function mount(t, initialDrafts = {}, account = 'account-a') {
  const errors = [], virtualConsole = new VirtualConsole();
  virtualConsole.on('jsdomError', error => errors.push(error.stack ?? error.message));
  const dom = new JSDOM('<!doctype html><div id="app"></div>', { url: 'https://webview.test/', runScripts: 'outside-only', pretendToBeVisual: true, virtualConsole });
  const { window } = dom;
  window.initialSnapshot = snapshot(account); window.initialDrafts = structuredClone(initialDrafts);
  window.requests = []; window.workspaceRequests = [];
  t.after(() => { dom.window.close(); assert.deepEqual(errors, []); });
  window.eval(script);
  const tick = async () => { await new Promise(resolve => window.requestAnimationFrame(() => window.requestAnimationFrame(resolve))); await new Promise(resolve => setTimeout(resolve, 0)); };
  const sendNow = data => window.dispatchEvent(new window.MessageEvent('message', { data }));
  const send = async data => { sendNow(data); await tick(); };
  const inputNow = (element, value) => { element.value = value; element.dispatchEvent(new window.Event('input', { bubbles: true })); };
  const input = async (element, value) => { inputNow(element, value); await tick(); };
  const button = (label, root = window.document) => [...root.querySelectorAll('button')].find(element => element.textContent.trim() === label);
  const selectTask = async id => { [...window.document.querySelectorAll('.task-group .text-link')].find(element => element.textContent.endsWith(id)).click(); await tick(); };
  const editTask = async (id = 'task-a') => { await selectTask(id); button('編輯子工作').click(); await tick(); };
  await tick();
  return { window, document: window.document, tick, sendNow, send, inputNow, input, button, selectTask, editTask,
    get saved() { return structuredClone(window.savedDrafts); },
    get drafts() { return window.savedDrafts?.[window.initialSnapshot.instanceUserScope]?.childTasks; } };
}

test('child task editors retain the latest input through incomplete and failed same-Issue refreshes', async t => {
  const v = await mount(t); await v.send({ type: 'detailData', data: detail() }); await v.editTask();
  const title = () => v.document.querySelector('.task-detail input');
  v.inputNow(title(), 'Typed before snapshot');
  v.sendNow({ type: 'detailData', data: detail(101, [], 'idle') }); await v.tick();
  assert.equal(title().value, 'Typed before snapshot');
  for (const status of ['loading', 'error', 'unsupported']) {
    await v.send({ type: 'detailPatch', issueId: 101, patch: { tasks: [], sections: { tasks: status } } });
    assert.equal(title().value, 'Typed before snapshot');
    assert.equal(v.button('儲存子工作').disabled, true);
    assert.equal(v.document.querySelector('.child-task-orphan-draft'), null);
  }
  await v.send({ type: 'detailPatch', issueId: 101, patch: { tasks: detail().tasks, sections: { tasks: 'ready' } } });
  assert.equal(title().value, 'Typed before snapshot'); assert.equal(v.button('儲存子工作').disabled, false);
  assert.equal(v.saved['account-a'].childTasks[101].drafts['task-a'].title, 'Typed before snapshot');
});

test('task drafts survive collapse, task and Issue switches, reconstruction, and account isolation', async t => {
  const v = await mount(t); await v.send({ type: 'detailData', data: detail() }); await v.editTask();
  await v.input(v.document.querySelector('.task-detail input'), 'Draft A');
  await v.selectTask('task-a'); assert.equal(v.document.querySelector('.task-detail'), null);
  await v.selectTask('task-a'); assert.equal(v.document.querySelector('.task-detail input').value, 'Draft A');
  await v.editTask('task-b'); await v.input(v.document.querySelector('.task-detail input'), 'Draft B');
  await v.selectTask('task-a'); assert.equal(v.document.querySelector('.task-detail input').value, 'Draft A');
  await v.send({ type: 'detailData', data: detail(102) }); assert.equal(v.document.querySelector('.task-detail'), null);
  await v.send({ type: 'detailData', data: detail() }); assert.equal(v.document.querySelector('.task-detail input').value, 'Draft A');
  const reopened = await mount(t, v.saved); await reopened.send({ type: 'detailData', data: detail() });
  assert.equal(reopened.document.querySelector('.task-detail input').value, 'Draft A');
  await reopened.send({ type: 'snapshot', snapshot: snapshot('account-b') });
  await reopened.send({ type: 'detailData', data: detail() }); assert.equal(reopened.document.querySelector('.task-detail'), null);
  await reopened.send({ type: 'snapshot', snapshot: snapshot('account-a') });
  await reopened.send({ type: 'detailData', data: detail() });
  assert.equal(reopened.document.querySelector('.task-detail input').value, 'Draft A');
  reopened.button('取消', reopened.document.querySelector('.task-detail')).click(); await reopened.tick();
  assert.equal(reopened.saved['account-a'].childTasks[101].drafts['task-a'], undefined);
  assert.equal(reopened.saved['account-a'].childTasks[101].drafts['task-b'].title, 'Draft B');
});

test('authoritatively missing tasks retain recoverable drafts with copy and explicit discard', async t => {
  const v = await mount(t); await v.send({ type: 'detailData', data: detail() }); await v.editTask();
  await v.input(v.document.querySelector('.task-detail input'), 'Recover this title');
  await v.send({ type: 'detailPatch', issueId: 101, patch: { tasks: [], sections: { tasks: 'ready' } } });
  assert.equal(v.document.querySelector('.task-detail'), null);
  assert.match(v.document.querySelector('.child-task-orphan-draft').textContent, /Recover this title/);
  v.button('複製子工作草稿').click(); await v.tick();
  assert.equal(v.window.workspaceRequests.findLast(request => request.type === 'copy').text, '# Recover this title\n\nServer task-a');
  v.button('丟棄子工作草稿').click(); await v.tick();
  assert.equal(v.document.querySelector('.child-task-orphan-draft'), null);
  assert.equal(v.saved['account-a'].childTasks[101].drafts['task-a'], undefined);
});

test('only a matching applied save receipt clears a task draft, even when detail arrives first', async t => {
  const v = await mount(t); await v.send({ type: 'detailData', data: detail() }); await v.editTask();
  await v.input(v.document.querySelector('.task-detail input'), 'Submitted title');
  v.button('儲存子工作').click(); await v.tick();
  const request = v.window.requests.findLast(request => request.type === 'invoke' && request.action === 'updateChild');
  assert.equal(v.saved['account-a'].pending[request.requestId].submission.taskId, 'task-a');
  await v.send({ type: 'detailData', data: detail(101, [], 'idle') });
  assert.equal(v.saved['account-a'].childTasks[101].drafts['task-a'].title, 'Submitted title');
  await v.send({ type: 'detailPatch', issueId: 101, patch: { tasks: detail().tasks, sections: { tasks: 'ready' } } });
  await v.send({ type: 'actionResult', requestId: request.requestId, status: 'succeeded', effect: 'applied' });
  assert.equal(v.saved['account-a'].childTasks[101].drafts['task-a'], undefined);
  assert.equal(v.document.querySelector('.task-detail input'), null);
});

test('a later edit and another task draft survive an older successful save receipt', async t => {
  const v = await mount(t); await v.send({ type: 'detailData', data: detail() }); await v.editTask();
  await v.input(v.document.querySelector('.task-detail input'), 'Submitted title');
  v.button('儲存子工作').click(); await v.tick();
  const request = v.window.requests.findLast(request => request.type === 'invoke');
  await v.input(v.document.querySelector('.task-detail input'), 'Newer title');
  await v.send({ type: 'actionResult', requestId: request.requestId, status: 'succeeded', effect: 'applied' });
  assert.equal(v.saved['account-a'].childTasks[101].drafts['task-a'].title, 'Newer title');
  assert.equal(v.document.querySelector('.task-detail input').value, 'Newer title');
});

for (const includeTaskId of [true, false]) test(`reconstructed task submissions ${includeTaskId ? 'settle their own draft' : 'without task identity preserve drafts'}`, async t => {
  const requestId = 'before-reconstruction', operationId = 'saved-child-save';
  const saved = { 'account-a': { create: {}, issues: {}, conversations: {},
    childTasks: { 101: { selectedId: 'task-a', drafts: { 'task-a': { title: 'Saved title', description: 'Saved description' }, 'task-b': { title: 'Other draft', description: '' } } } },
    uncertain: { [requestId]: { issueId: 101, projectId: 1, issueIid: 101, operationId, resourceKey: 'issue:1:101', scopeRevision: 'account-a', action: 'updateChild', replyId: null,
      submission: { ...(includeTaskId ? { taskId: 'task-a' } : {}), taskTitle: 'Saved title', taskDescription: 'Saved description' }, form: null, creating: false } } } };
  const v = await mount(t, saved); await v.send({ type: 'detailData', data: detail() });
  await v.send({ type: 'operationsSnapshot', snapshot: { sessionId: 'restored-host', revision: 1,
    operations: [{ requestId: operationId, correlationId: requestId, resourceKey: 'issue:1:101', action: 'issueRequest', kind: 'write',
      scopeRevision: 'account-a', status: 'succeeded', effect: 'applied', label: 'Confirmed', phase: 'Confirmed', hostSessionId: 'restored-host', revision: 1, startedAt: 1, finishedAt: 2 }] } });
  assert.equal(v.saved['account-a'].childTasks[101].drafts['task-a']?.title, includeTaskId ? undefined : 'Saved title');
  assert.equal(v.saved['account-a'].childTasks[101].drafts['task-b'].title, 'Other draft');
  assert.equal(v.window.requests.some(request => request.type === 'invoke'), false, 'reconstruction never resubmits the write');
});

for (const [status, effect, refreshError] of [['failed', 'none'], ['cancelled', 'none'], ['failed', 'unknown'], ['succeeded', 'partial'], ['succeeded', 'applied', 'Refresh failed']]) {
  test(`task drafts survive ${status}/${effect}${refreshError ? ' with refresh failure' : ''}`, async t => {
    const v = await mount(t); await v.send({ type: 'detailData', data: detail() }); await v.editTask();
    await v.input(v.document.querySelector('.task-detail input'), 'Keep unsaved title');
    v.button('儲存子工作').click(); await v.tick();
    const request = v.window.requests.findLast(request => request.type === 'invoke');
    await v.send({ type: 'actionResult', requestId: request.requestId, status, effect, refreshError });
    assert.equal(v.saved['account-a'].childTasks[101].drafts['task-a'].title, 'Keep unsaved title');
  });
}
