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
    stagedCount: 1, unstagedCount: 2, conflictCount: 0,
    branches: [{ name: 'main', kind: 'local', current: true }],
    stashes: [{ oid: 'b'.repeat(40), message: 'stash@{0} · before refactor' }], recoveryRefs: []
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
  assert.equal(view.dom.window.document.querySelector('[aria-live="polite"]').textContent, '正在開啟…');

  view.sendState({ connected: true, groupLabel: 'team/dotnet', errorMessage: '無法連線' });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(view.dom.window.document.querySelector('.action-message').textContent, '無法連線');
  assert.equal(view.buttons().every((button) => !button.disabled), true);
});
