import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import { describeAction } from '../../out/src/workspace/actionPolicy.js';

const html = await readFile(new URL('../../resources/sidebar-webview/sidebar.html', import.meta.url), 'utf8');
const script = await readFile(new URL('../../resources/sidebar-webview/sidebar.js', import.meta.url), 'utf8');
const hostValues = (value) => JSON.parse(JSON.stringify(value));
const requestShape = ({ operationId, operationScope, hostSessionId, scopeEpoch, ...request }) => hostValues(request);

async function mount() {
  const dom = new JSDOM(html, { url: 'https://sidebar.example.test/', runScripts: 'outside-only', pretendToBeVisual: true });
  const requests = [];
  const operations = new Map();
  const sessionId = 'sidebar-host';
  let revision = 0;
  const emit = message => dom.window.dispatchEvent(new dom.window.MessageEvent('message', { data: message }));
  const receipt = (request, patch = {}) => ({
    ...describeAction(request, { scopeRevision: request.operationScope }), requestId: request.operationId,
    scopeRevision: request.operationScope ?? 'sidebar-scope',
    hostSessionId: sessionId, revision: ++revision, startedAt: Date.now(),
    status: 'running', phase: '正在處理…', effect: 'none', ...patch
  });
  const finish = (request, patch = {}) => {
    if (!request?.operationId) return;
    const operation = { ...(operations.get(request.operationId) ?? receipt(request)),
      status: 'succeeded', phase: '已完成', finishedAt: Date.now(), ...patch, revision: ++revision };
    operations.set(operation.requestId, operation);
    emit({ type: 'operationChanged', operation });
  };
  dom.window.acquireVsCodeApi = () => ({ postMessage: (message) => {
    requests.push(message);
    if (message.operationId) operations.set(message.operationId, receipt(message));
  } });
  dom.window.eval(script);
  for (let attempt = 0; attempt < 50 && requests.length === 0; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return {
    dom,
    requests,
    finish,
    buttons: () => [...dom.window.document.querySelectorAll('.workspace-link, .workspace-shortcuts .action-button')],
    repoButtons: () => [...dom.window.document.querySelectorAll('.repo-link')],
    sendState(state) {
      emit({ type: 'state', state: { operationScope: 'sidebar-scope', scopeEpoch: 1,
        operationSnapshot: { sessionId, revision, operations: [...operations.values()] }, ...state } });
    },
    send(message) {
      if (message.type === 'operationChanged') {
        revision = Math.max(revision, message.operation.revision ?? 0);
        operations.set(message.operation.requestId, message.operation);
      }
      if (message.type === 'repositoryDetails') finish(requests.find(request => request.requestId === message.requestId),
        message.error ? { status: 'failed', error: message.error, phase: '載入失敗' } : {});
      emit(message);
    }
  };
}

test('renders workspace navigation and keeps destinations available before connecting', async (t) => {
  const view = await mount();
  t.after(() => view.dom.window.close());

  assert.deepEqual(view.requests.map(requestShape), [{ type: 'ready' }]);
  assert.deepEqual(view.buttons().map((button) => button.textContent.trim()), ['⌂工作台', '◷我的工作', '▣專案', '⌕分析', '⑂待審查', '⑂版控']);
  assert.equal(view.buttons().every((button) => !button.disabled), true);
  assert.equal(view.buttons()[0].classList.contains('workspace-link'), true);
  assert.equal(view.buttons().every((button) => button.type === 'button'), true);

  view.buttons()[1].click();
  assert.deepEqual(requestShape(view.requests.at(-1)), { type: 'perform', action: 'openMyWork' });
  assert.match(view.requests.at(-1).operationId, /^[a-z0-9-]+$/i);
  assert.equal(typeof view.requests.at(-1).operationScope, 'string');
});

test('shows connection scope, progress and the shared unread message-center entry', async (t) => {
  const view = await mount();
  t.after(() => view.dom.window.close());
  const repositoryId = 'a'.repeat(32);
  view.sendState({ connected: true, groupLabel: 'team/dotnet', gitAvailable: true, activeMode: 'git', selectedRepositoryId: repositoryId, repositories: [{
    id: repositoryId, name: 'project', path: 'C:\\workspace\\project', branch: 'main', tracking: 'origin/main',
    stagedCount: 1, unstagedCount: 2, conflictCount: 0, revision: 1
  }] });
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(view.dom.window.document.querySelector('.connection-status').textContent, 'team/dotnet');
  assert.equal(view.buttons()[0].classList.contains('active'), true);
  assert.deepEqual(view.buttons().slice(1).map((button) => button.textContent.trim().slice(1)), ['我的工作', '專案', '分析', '待審查', '版控']);
  assert.equal(view.buttons()[5].getAttribute('aria-current'), 'page');

  for (const [index, action] of ['openWorkspace', 'openMyWork', 'openProjects', 'openAnalysis', 'openReviewer', 'openGit'].entries()) {
    view.buttons()[index].click();
    view.finish(view.requests.at(-1));
  }
  assert.deepEqual(view.requests.filter(request => request.type === 'perform').map(requestShape), ['openWorkspace', 'openMyWork', 'openProjects', 'openAnalysis', 'openReviewer', 'openGit'].map((action) => ({ type: 'perform', action })));

  assert.equal(view.repoButtons().length, 1);
  assert.match(view.repoButtons()[0].textContent, /project.*main.*origin\/main/s);
  assert.match(view.repoButtons()[0].textContent, /3/);
  view.dom.window.document.querySelector('.repo-disclosure').click();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(view.dom.window.document.querySelector('.repo-disclosure').getAttribute('aria-expanded'), 'true');
  await waitFor(() => view.requests.some(request => request.type === 'repositoryDetails'));
  view.send({ ...view.requests.at(-1), details: { id: repositoryId, revision: 1,
    branches: [{ name: 'main', kind: 'local', current: true }],
    stashes: [{ oid: 'b'.repeat(40), message: 'stash@{0} · before refactor' }], recoveryRefs: [] } });
  await waitFor(() => view.dom.window.document.querySelector('.ref-link'));
  assert.match(view.dom.window.document.querySelector('.repo-details').textContent, /main/);
  view.repoButtons()[0].click();
  assert.deepEqual(requestShape(view.requests.at(-1)), { type: 'perform', action: 'openRepository', repositoryId });
  view.finish(view.requests.at(-1));

  const search = view.dom.window.document.querySelector('[aria-label="搜尋 Repo"]');
  search.value = 'missing';
  search.dispatchEvent(new view.dom.window.Event('input', { bubbles: true }));
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(view.repoButtons().length, 0);
  assert.match(view.dom.window.document.querySelector('.git-availability').textContent, /找不到符合的 Repo/);

  view.buttons()[2].click();
  const projectRequest = view.requests.at(-1);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(view.buttons().every((button) => !button.disabled), true, 'navigation remains available while another destination opens');
  assert.equal(view.buttons()[2].getAttribute('aria-busy'), 'true');
  assert.match(view.dom.window.document.querySelector('.action-message').textContent, /正在|處理/);

  view.finish(projectRequest);
  view.sendState({ connected: true, groupLabel: 'team/dotnet', notificationUnreadCount: 4 });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(view.dom.window.document.querySelector('.action-message').textContent, '');
  assert.equal(view.buttons().every((button) => !button.disabled), true);
  const messages = view.dom.window.document.querySelector('.notification-link');
  assert.match(messages.getAttribute('aria-label'), /4 筆未讀/);
  messages.click();
  assert.deepEqual(requestShape(view.requests.at(-1)), { type: 'perform', action: 'openNotifications' });
});

async function waitFor(predicate) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.ok(predicate(), 'the sidebar update settled');
}

const repoId = 'c'.repeat(32);
const summary = revision => ({ id: repoId, revision, name: 'service', path: 'C:\\workspace\\service', branch: 'main', stagedCount: 0, unstagedCount: 1, conflictCount: 0 });
const stateFor = revision => ({ connected: false, gitAvailable: true, repositories: [summary(revision)] });
const detailsFor = revision => ({ id: repoId, revision, branches: [{ name: `branch-${revision}`, kind: 'local', current: true }], stashes: [], recoveryRefs: [] });
const detailsRequests = view => view.requests.filter(request => request.type === 'repositoryDetails');

test('loads expanded Repo details only, with retry and correlated stale-response protection', async t => {
  const view = await mount(); t.after(() => view.dom.window.close());
  view.sendState(stateFor(1));
  await waitFor(() => view.repoButtons().length === 1);
  assert.equal(detailsRequests(view).length, 0, 'collapsed Repos do not request refs or Stash');
  view.dom.window.document.querySelector('.repo-disclosure').click();
  await waitFor(() => detailsRequests(view).length === 1);
  const first = detailsRequests(view).at(-1);
  view.sendState(stateFor(1));
  await new Promise(resolve => setTimeout(resolve, 60));
  assert.equal(detailsRequests(view).length, 1, 'ordinary state updates share the in-flight read');
  view.send({ ...first, error: 'Unable to read refs' });
  await waitFor(() => view.dom.window.document.querySelector('.repo-details button')?.textContent === '重試載入');
  view.dom.window.document.querySelector('.repo-details button').click();
  await waitFor(() => detailsRequests(view).length === 2);
  const second = detailsRequests(view).at(-1);
  view.send({ ...first, details: detailsFor(1) });
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(view.dom.window.document.querySelector('.ref-link'), null, 'superseded request cannot replace the retry');
  view.send({ ...second, details: detailsFor(1) });
  await waitFor(() => view.dom.window.document.querySelector('.ref-link')?.textContent.includes('branch-1'));
  view.sendState(stateFor(2));
  await waitFor(() => detailsRequests(view).length === 3);
  view.send({ ...detailsRequests(view).at(-1), details: detailsFor(2) });
  await waitFor(() => view.dom.window.document.querySelector('.ref-link')?.textContent.includes('branch-2'));
});

test('collapse, hidden views and removed Repos discard late details and reload on return', async t => {
  const view = await mount(); t.after(() => view.dom.window.close());
  view.sendState(stateFor(1)); await waitFor(() => view.repoButtons().length);
  const disclosure = () => view.dom.window.document.querySelector('.repo-disclosure');
  disclosure().click(); await waitFor(() => detailsRequests(view).length === 1);
  const collapsed = detailsRequests(view).at(-1);
  disclosure().click();
  await waitFor(() => view.requests.some(request => request.type === 'cancelRepositoryDetails'));
  view.send({ ...collapsed, details: detailsFor(1) });
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(view.dom.window.document.querySelector('.repo-details'), null);
  disclosure().click(); await waitFor(() => detailsRequests(view).length === 2);
  const hidden = detailsRequests(view).at(-1);
  view.send({ type: 'visibility', visible: false });
  view.send({ ...hidden, details: detailsFor(1) });
  await new Promise(resolve => setTimeout(resolve, 60));
  assert.equal(view.dom.window.document.querySelector('.ref-link'), null);
  assert.equal(detailsRequests(view).length, 2);
  view.send({ type: 'visibility', visible: true });
  await waitFor(() => detailsRequests(view).length === 3);
  const removed = detailsRequests(view).at(-1);
  view.sendState({ connected: false, gitAvailable: true, repositories: [] });
  await waitFor(() => !view.repoButtons().length);
  view.send({ ...removed, details: detailsFor(1) });
  view.sendState(stateFor(2));
  await waitFor(() => detailsRequests(view).length === 4);
  view.send({ ...detailsRequests(view).at(-1), details: detailsFor(2) });
  await waitFor(() => view.dom.window.document.querySelector('.ref-link')?.textContent.includes('branch-2'));
});

test('shows saved account summaries and dispatches supported account management actions', async t => {
  const view = await mount();
  t.after(() => view.dom.window.close());
  view.sendState({ connected: true, activeAccountId: 'a'.repeat(32), accounts: [
    { id: 'a'.repeat(32), baseUrl: 'https://gitlab.example.test', userId: 7, username: 'tester', name: 'Test User', needsLogin: false },
    { id: 'b'.repeat(32), baseUrl: 'https://other.example.test', userId: 8, username: 'other', name: 'Other User', needsLogin: true }
  ] });
  await new Promise(resolve => setTimeout(resolve, 0));
  const menu = view.dom.window.document.querySelector('.sidebar-account-menu');
  assert.match(menu.textContent, /tester.*gitlab.example.test.*目前使用/s);
  assert.match(menu.textContent, /管理帳號（2）/);
  for (const [index, action] of ['manageAccounts', 'addAccount'].entries()) {
    menu.querySelectorAll('button')[index].click();
    assert.deepEqual(requestShape(view.requests.at(-1)), { type: 'perform', action });
    view.finish(view.requests.at(-1));
  }
  view.sendState({ connected: false, accounts: [{ id: 'b'.repeat(32), baseUrl: 'https://other.example.test', userId: 8, username: 'other', name: 'Other User', needsLogin: true }] });
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.match(menu.textContent, /尚未登入.*已保存 1 個帳號/s);
  menu.querySelectorAll('button')[1].click();
  assert.deepEqual(requestShape(view.requests.at(-1)), { type: 'perform', action: 'manageAccounts' });
});

test('shows immediate local progress, joins double clicks and retries a failed navigation explicitly', async t => {
  const view = await mount(); t.after(() => view.dom.window.close());
  view.sendState({ connected: false });
  await waitFor(() => view.dom.window.document.querySelector('.action-message'));
  const myWork = view.buttons()[1];
  myWork.click(); myWork.click();
  const dispatched = view.requests.filter(request => request.type === 'perform');
  assert.equal(dispatched.length, 1, 'the second click joins before a host busy state arrives');
  const first = dispatched[0];
  assert.equal(first.operationScope, 'sidebar-scope');
  assert.equal(first.hostSessionId, 'sidebar-host');
  assert.equal(first.scopeEpoch, 1);
  await waitFor(() => myWork.getAttribute('aria-busy') === 'true');
  assert.match(view.dom.window.document.querySelector('.action-message').textContent, /正在|處理/);
  assert.equal(view.buttons().every(button => !button.disabled), true);
  const running = { ...describeAction(first, { scopeRevision: first.operationScope }), requestId: first.operationId,
    scopeRevision: first.operationScope, hostSessionId: first.hostSessionId, status: 'running', startedAt: Date.now(), revision: 2, phase: '正在載入工作清單' };
  view.send({ type: 'operationChanged', operation: running });
  await waitFor(() => view.dom.window.document.querySelector('.action-message').textContent === '正在載入工作清單');
  view.send({ type: 'operationChanged', operation: { ...running, revision: 3, phase: '正在整理工作清單' } });
  await waitFor(() => view.dom.window.document.querySelector('.action-message').textContent === '正在整理工作清單');
  assert.equal(myWork.getAttribute('aria-busy'), 'true', 'phase-only updates preserve the active action');

  view.finish(first, { status: 'failed', phase: '開啟失敗', error: '暫時無法開啟工作台' });
  await waitFor(() => view.dom.window.document.querySelector('.action-message button')?.textContent === '重試');
  assert.match(view.dom.window.document.querySelector('.action-message').textContent, /暫時無法開啟工作台/);
  assert.equal(view.dom.window.document.querySelector('.action-message').getAttribute('role'), 'alert');
  await new Promise(resolve => setTimeout(resolve, 60));
  assert.equal(view.requests.filter(request => request.type === 'perform').length, 1, 'failure does not resend automatically');
  view.dom.window.document.querySelector('.action-message button').click();
  const retry = view.requests.at(-1);
  assert.equal(retry.action, 'openMyWork');
  assert.notEqual(retry.operationId, first.operationId, 'explicit retry has a fresh identity');
  view.finish(retry);
  await waitFor(() => !view.dom.window.document.querySelector('.action-message').textContent);
  assert.equal(myWork.getAttribute('aria-busy'), 'false');
});

test('scope changes ignore late receipts while retaining progress in the current scope', async t => {
  const view = await mount(); t.after(() => view.dom.window.close());
  view.sendState({ connected: true, operationScope: 'account-old', operationSnapshot: { sessionId: 'sidebar-host', revision: 0, operations: [] } });
  await new Promise(resolve => setTimeout(resolve, 0));
  view.buttons()[1].click();
  const old = view.requests.at(-1);
  view.sendState({ connected: true, operationScope: 'account-new', scopeEpoch: 2,
    operationSnapshot: { sessionId: 'sidebar-host', revision: 2, operations: [] } });
  await new Promise(resolve => setTimeout(resolve, 0));
  view.buttons()[1].click();
  const current = view.requests.at(-1);
  assert.notEqual(current.operationId, old.operationId);
  assert.equal(current.operationScope, 'account-new');
  assert.equal(current.scopeEpoch, 2);
  view.finish(old, { status: 'failed', error: 'old scope error' });
  await waitFor(() => view.buttons()[1].getAttribute('aria-busy') === 'true');
  assert.doesNotMatch(view.dom.window.document.querySelector('.action-message').textContent, /old scope error/);
  view.finish(current);
  await waitFor(() => !view.dom.window.document.querySelector('.action-message').textContent);
});

test('reconciles host operations after ready and confirms uncertain writes without resending them', async t => {
  const view = await mount(); t.after(() => view.dom.window.close());
  const restored = { requestId: 'restored-account-write', scopeRevision: 'sidebar-scope', resourceKey: 'connection',
    action: 'switchAccount', label: '切換帳號', phase: '正在切換帳號…', status: 'running', startedAt: 1,
    hostSessionId: 'sidebar-host', revision: 4, kind: 'write', concurrency: 'exclusive', lockKey: 'global:connection', effect: 'none' };
  view.sendState({ connected: true, operationSnapshot: { sessionId: 'sidebar-host', revision: 4, operations: [restored] } });
  const accountButtons = () => view.dom.window.document.querySelectorAll('.sidebar-account-actions button');
  await waitFor(() => accountButtons()[1].disabled);
  assert.equal(accountButtons()[0].disabled, false, 'account management navigation remains usable');
  assert.equal(view.buttons().every(button => !button.disabled), true, 'unrelated navigation is not globally blocked');
  assert.match(view.dom.window.document.querySelector('.action-message').textContent, /正在切換帳號/);

  view.send({ type: 'operationChanged', operation: { ...restored, status: 'failed', effect: 'unknown',
    phase: '需要確認操作結果', error: '連線中斷，請先確認切換結果', finishedAt: 2, revision: 5 } });
  await waitFor(() => view.dom.window.document.querySelector('.action-message button')?.textContent === '確認操作狀態');
  assert.equal(accountButtons()[1].disabled, true, 'an uncertain write keeps its resource unavailable');
  view.dom.window.document.querySelector('.action-message button').click();
  assert.equal(view.requests.at(-1).type, 'reconcileOperations');
  assert.equal(view.requests.some(request => request.type === 'perform'), false, 'confirmation never repeats the write');
  view.send({ type: 'operationsSnapshot', snapshot: { sessionId: 'sidebar-host', revision: 6,
    operations: [{ ...restored, status: 'succeeded', phase: '已完成', effect: 'applied', finishedAt: 3, revision: 6 }] } });
  await waitFor(() => !accountButtons()[1].disabled);
  assert.equal(view.dom.window.document.querySelector('.action-message').textContent, '');
  view.send({ type: 'operationChanged', operation: { ...restored, revision: 4 } });
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(accountButtons()[1].disabled, false, 'older receipts cannot resurrect completed progress');
});

test('updates Repo summaries even when the Host keeps the details revision unchanged', async t => {
  const view = await mount(); t.after(() => view.dom.window.close());
  const initial = stateFor(1);
  view.sendState(initial);
  await waitFor(() => view.repoButtons().length === 1);
  view.sendState({ ...initial, repositories: initial.repositories.map(repository => ({
    ...repository, name: 'renamed-service', branch: 'topic/new', unstagedCount: 4
  })) });
  await waitFor(() => view.repoButtons()[0].textContent.includes('renamed-service'));
  assert.match(view.repoButtons()[0].textContent, /topic\/new/);
  assert.match(view.repoButtons()[0].textContent, /4/);
});

test('a locally blocked sidebar action publishes one center warning while keeping inline feedback', async t => {
  const view = await mount(); t.after(() => view.dom.window.close());
  const uncertain = { requestId: 'uncertain-navigation', scopeRevision: 'sidebar-scope', resourceKey: 'openMyWork',
    action: 'openMyWork', label: '開啟我的工作', kind: 'read', concurrency: 'latest', lockKey: 'remote:sidebar-scope:openMyWork',
    status: 'failed', effect: 'unknown', error: '先核對結果', phase: '結果待確認', startedAt: 1,
    hostSessionId: 'sidebar-host', revision: 1 };
  view.sendState({ connected: true, operationSnapshot: { sessionId: 'sidebar-host', revision: 1, operations: [uncertain] } });
  await waitFor(() => view.dom.window.document.querySelector('.action-message')?.textContent.includes('先核對結果'));
  view.buttons()[1].click();
  await waitFor(() => view.requests.some(request => request.type === 'publishNotification'));
  const notices = view.requests.filter(request => request.type === 'publishNotification');
  assert.equal(notices.length, 1); assert.equal(notices[0].level, 'warn');
  assert.equal(notices[0].operationScope, 'sidebar-scope'); assert.equal(notices[0].scopeEpoch, 1);
  assert.match(view.dom.window.document.querySelector('.action-message').textContent, /上次操作結果待確認/);
  assert.equal(view.requests.some(request => request.type === 'perform'), false);
});
