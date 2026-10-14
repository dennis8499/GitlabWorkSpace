import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { JSDOM } from 'jsdom';

const html = await readFile(new URL('../../resources/sidebar-webview/sidebar.html', import.meta.url), 'utf8');
const script = await readFile(new URL('../../resources/sidebar-webview/sidebar.js', import.meta.url), 'utf8');
const hostValues = (value) => JSON.parse(JSON.stringify(value));

async function mount() {
  const dom = new JSDOM(html, { url: 'https://sidebar.example.test/', runScripts: 'outside-only', pretendToBeVisual: true });
  const requests = [];
  dom.window.acquireVsCodeApi = () => ({ postMessage: (message) => requests.push(message) });
  dom.window.eval(script);
  for (let attempt = 0; attempt < 50 && requests.length === 0; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return {
    dom,
    requests,
    buttons: () => [...dom.window.document.querySelectorAll('.workspace-link, .workspace-shortcuts .action-button')],
    repoButtons: () => [...dom.window.document.querySelectorAll('.repo-link')],
    sendState(state) {
      dom.window.dispatchEvent(new dom.window.MessageEvent('message', { data: { type: 'state', state } }));
    },
    send(message) {
      dom.window.dispatchEvent(new dom.window.MessageEvent('message', { data: message }));
    }
  };
}

test('renders workspace navigation and keeps destinations available before connecting', async (t) => {
  const view = await mount();
  t.after(() => view.dom.window.close());

  assert.deepEqual(hostValues(view.requests), [{ type: 'ready' }]);
  assert.deepEqual(view.buttons().map((button) => button.textContent.trim()), ['⌂工作台', '◷我的工作', '▣專案', '⌕分析', '⑂待審查', '⑂版控']);
  assert.equal(view.buttons().every((button) => !button.disabled), true);
  assert.equal(view.buttons()[0].classList.contains('workspace-link'), true);
  assert.equal(view.buttons().every((button) => button.type === 'button'), true);

  view.buttons()[1].click();
  assert.deepEqual(hostValues(view.requests.at(-1)), { type: 'perform', action: 'openMyWork' });
});

test('shows connection scope and dispatches each destination with accessible busy and error feedback', async (t) => {
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
  }
  assert.deepEqual(hostValues(view.requests.slice(1, 7)), ['openWorkspace', 'openMyWork', 'openProjects', 'openAnalysis', 'openReviewer', 'openGit'].map((action) => ({ type: 'perform', action })));

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
  assert.deepEqual(hostValues(view.requests.at(-1)), { type: 'perform', action: 'openRepository', repositoryId });

  const search = view.dom.window.document.querySelector('[aria-label="搜尋 Repo"]');
  search.value = 'missing';
  search.dispatchEvent(new view.dom.window.Event('input', { bubbles: true }));
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(view.repoButtons().length, 0);
  assert.match(view.dom.window.document.querySelector('.git-availability').textContent, /找不到符合的 Repo/);

  view.sendState({ connected: true, groupLabel: 'team/dotnet', busyAction: 'openProjects' });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(view.buttons().every((button) => button.disabled), true);
  assert.equal(view.dom.window.document.querySelector('[aria-live="polite"]').textContent, '正在開啟專案…');

  view.sendState({ connected: true, groupLabel: 'team/dotnet', errorMessage: '無法連線' });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(view.dom.window.document.querySelector('.action-message').textContent, '無法連線');
  assert.equal(view.buttons().every((button) => !button.disabled), true);
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
    assert.deepEqual(hostValues(view.requests.at(-1)), { type: 'perform', action });
  }
  view.sendState({ connected: false, accounts: [{ id: 'b'.repeat(32), baseUrl: 'https://other.example.test', userId: 8, username: 'other', name: 'Other User', needsLogin: true }] });
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.match(menu.textContent, /尚未登入.*已保存 1 個帳號/s);
  menu.querySelectorAll('button')[1].click();
  assert.deepEqual(hostValues(view.requests.at(-1)), { type: 'perform', action: 'manageAccounts' });
});
