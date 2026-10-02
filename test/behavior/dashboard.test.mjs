import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { JSDOM, VirtualConsole } from 'jsdom';

const html = await readFile(new URL('../../resources/issue-webview/dashboard.html', import.meta.url), 'utf8');
const script = await readFile(new URL('../../resources/issue-webview/dashboard.js', import.meta.url), 'utf8');

function project(id, path) {
  return {
    id, name: path, path, path_with_namespace: `team/${path}`,
    web_url: `https://gitlab.example.test/team/${path}`,
    http_url_to_repo: `https://gitlab.example.test/team/${path}.git`,
    default_branch: 'main'
  };
}

function snapshot(activeMode = 'developer') {
  const group = { id: 3, name: 'Team', full_path: 'team', web_url: 'https://gitlab.example.test/groups/team' };
  return {
    connected: true,
    baseUrl: 'https://gitlab.example.test',
    currentUser: { id: 7, username: 'test-user', name: 'Test User' },
    group,
    groups: [
      group,
      { id: 8, name: 'Child', full_path: 'team/child', web_url: 'https://gitlab.example.test/groups/team/child' }
    ],
    groupRoot: 'C:/workspace/team',
    projects: [project(1, 'alpha'), project(2, 'beta'), project(3, 'gamma')],
    groupMilestones: [
      { id: 21, group_id: 3, title: 'Unused release', state: 'active' },
      { id: 22, group_id: 3, title: 'Duplicate name', state: 'active' },
      { id: 23, group_id: 8, title: 'Duplicate name', state: 'closed' }
    ],
    localRepositories: {},
    issues: [
      { id: 101, iid: 1, project_id: 1, title: 'Alpha milestone issue', state: 'opened', web_url: 'https://gitlab.example.test/team/alpha/-/issues/1', labels: ['bug'], milestone: { id: 22, title: 'Duplicate name' } },
      { id: 102, iid: 2, project_id: 2, title: 'Beta milestone issue', state: 'opened', web_url: 'https://gitlab.example.test/team/beta/-/issues/2', labels: ['feature'], milestone: { id: 23, title: 'Duplicate name' } },
      { id: 103, iid: 3, project_id: 2, title: 'Beta unassigned issue', state: 'closed', web_url: 'https://gitlab.example.test/team/beta/-/issues/3', labels: [] }
    ],
    mergeRequests: [],
    activeMode,
    instanceUserScope: 'instance-user',
    connectedScope: 'team-scope',
    projectMembers: [],
    timers: [],
    tools: [],
    toolSource: 'gitea',
    deliveryRecords: [],
    busy: false
  };
}

async function mount(initialState, initialSnapshot) {
  const runtimeErrors = [];
  const virtualConsole = new VirtualConsole();
  virtualConsole.on('jsdomError', (error) => runtimeErrors.push(error.stack ?? error.message));
  const dom = new JSDOM(html, {
    url: 'https://dashboard.example.test/',
    runScripts: 'outside-only',
    pretendToBeVisual: true,
    virtualConsole
  });
  dom.window.addEventListener('error', (event) => runtimeErrors.push(event.error?.stack ?? event.message));
  const requests = [];
  let state = initialState;
  dom.window.acquireVsCodeApi = () => ({
    postMessage: (message) => requests.push(message),
    getState: () => state,
    setState: (value) => { state = JSON.parse(JSON.stringify(value)); }
  });
  dom.window.eval(script);
  for (let attempt = 0; attempt < 50 && requests.length === 0; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  const tick = async () => {
    await new Promise((resolve) => setTimeout(resolve, 50));
  };
  await tick();
  assert.equal(requests[0]?.type, 'ready');
  dom.window.dispatchEvent(new dom.window.MessageEvent('message', { data: { type: 'snapshot', snapshot: initialSnapshot } }));
  await tick();
  assert.equal(runtimeErrors.length, 0, runtimeErrors.join('\n'));
  assert.ok(dom.window.document.querySelector('.app-shell'), `the dashboard is mounted: root=${dom.window.document.querySelector('#workspace')?.innerHTML ?? 'missing'}, requests=${JSON.stringify(requests)}, errors=${runtimeErrors.join('; ')}`);
  return {
    dom,
    requests,
    tick,
    get savedState() { return state; },
    sendSnapshot(value) {
      dom.window.dispatchEvent(new dom.window.MessageEvent('message', { data: { type: 'snapshot', snapshot: value } }));
    }
  };
}

test('renders and uses the Wiki guide offline with validated prompts, clipboard feedback, and saved inputs', async (t) => {
  const disconnected = snapshot('sa');
  Object.assign(disconnected, {
    connected: false, baseUrl: undefined, currentUser: undefined, group: undefined, groups: [], groupRoot: undefined,
    projects: [], issues: [], mergeRequests: [], instanceUserScope: undefined, connectedScope: undefined, activeMode: 'sa'
  });
  const view = await mount({ mode: 'sa' }, disconnected);
  t.after(() => view.dom.window.close());
  const document = view.dom.window.document;
  assert.equal(document.querySelector('.page-heading h1').textContent, 'Codebase LLM Wiki');
  assert.equal(document.querySelectorAll('.wiki-guide-card').length, 12);
  assert.ok(document.querySelector('.wiki-guide-notice'));

  const query = document.querySelector('[id="wiki-input-query.question"]');
  const copy = document.querySelector('[aria-label="複製查詢 Wiki提示詞"]');
  assert.ok(query);
  assert.ok(copy);
  assert.equal(copy.disabled, true);

  const ingestMode = document.querySelector('[id="wiki-input-ingest.mode"]');
  ingestMode.value = '批次';
  ingestMode.dispatchEvent(new view.dom.window.Event('change', { bubbles: true }));
  await view.tick();
  const ingestCard = document.querySelector('[id="wiki-card-title-ingest"]').closest('.wiki-guide-card');
  const ingestPreview = ingestCard.querySelector('details');
  ingestPreview.open = true;
  assert.match(ingestPreview.textContent, /Batch Ingest/);
  assert.doesNotMatch(ingestPreview.textContent, /等待我確認/);
  const lintOperation = document.querySelector('[id="wiki-input-lint.operation"]');
  lintOperation.value = '重建索引';
  lintOperation.dispatchEvent(new view.dom.window.Event('change', { bubbles: true }));
  await view.tick();
  const lintCard = document.querySelector('[id="wiki-card-title-lint"]').closest('.wiki-guide-card');
  assert.match(lintCard.querySelector('details').textContent, /重建 wiki\/index\.md/);

  query.value = '退款 API 如何處理逾時？\n請列出設定檔與呼叫路徑。';
  query.dispatchEvent(new view.dom.window.Event('input', { bubbles: true }));
  await view.tick();
  assert.equal(copy.disabled, false);
  const preview = document.querySelector('[id="wiki-card-title-query"]')?.closest('.wiki-guide-card')?.querySelector('details');
  assert.ok(preview);
  preview.open = true;
  assert.ok(preview.textContent.includes(query.value));

  document.querySelector('.wiki-guide-intro button').click();
  await view.tick();
  assert.ok(document.querySelector('[role="dialog"]'));

  copy.click();
  await view.tick();
  const request = view.requests.at(-1);
  assert.equal(request.type, 'copy');
  assert.ok(request.text.includes(query.value));
  view.dom.window.dispatchEvent(new view.dom.window.MessageEvent('message', { data: { type: 'message', message: '已複製到剪貼簿，可貼入 Codex CLI。' } }));
  await view.tick();
  assert.match(document.querySelector('.toast').textContent, /已複製到剪貼簿/);

  view.dom.window.dispatchEvent(new view.dom.window.MessageEvent('message', { data: { type: 'error', message: 'Clipboard unavailable' } }));
  await view.tick();
  assert.match(document.querySelector('[role="alert"]').textContent, /Clipboard unavailable/);

  document.querySelectorAll('.mode-button')[0].click();
  await view.tick();
  document.querySelectorAll('.mode-button')[2].click();
  await view.tick();
  assert.equal(document.querySelector('[id="wiki-input-query.question"]').value, query.value);
  assert.equal(view.savedState.wikiGuideInputsByScope.offline['query.question'], query.value);

  const reopened = await mount(view.savedState, disconnected);
  t.after(() => reopened.dom.window.close());
  assert.equal(reopened.dom.window.document.querySelector('[id="wiki-input-query.question"]').value, query.value);
});

test('keeps Wiki guide inputs separate for each selected Group', async (t) => {
  const view = await mount({ mode: 'sa', scopeKey: 'team-scope' }, snapshot('sa'));
  t.after(() => view.dom.window.close());
  const document = view.dom.window.document;
  const query = document.querySelector('[id="wiki-input-query.question"]');
  query.value = 'Team A 的問題';
  query.dispatchEvent(new view.dom.window.Event('input', { bubbles: true }));
  await view.tick();

  const groupB = snapshot('sa');
  groupB.connectedScope = 'another-group-scope';
  groupB.group = { ...groupB.group, id: 9, full_path: 'another-team' };
  view.sendSnapshot(groupB);
  await view.tick();
  assert.equal(document.querySelector('[id="wiki-input-query.question"]').value, '');
  query.value = 'Team B 的問題';
  query.dispatchEvent(new view.dom.window.Event('input', { bubbles: true }));
  await view.tick();

  view.sendSnapshot(snapshot('sa'));
  await view.tick();
  assert.equal(document.querySelector('[id="wiki-input-query.question"]').value, 'Team A 的問題');
  assert.equal(view.savedState.wikiGuideInputsByScope['team-scope']['query.question'], 'Team A 的問題');
  assert.equal(view.savedState.wikiGuideInputsByScope['another-group-scope']['query.question'], 'Team B 的問題');
});

test('filters assigned Issues by unassigned and Group Milestone IDs while retaining unmatched and duplicate-title options', async (t) => {
  const view = await mount(undefined, snapshot());
  t.after(() => view.dom.window.close());
  const document = view.dom.window.document;
  const milestoneFilter = document.querySelector('select[aria-label="Issue Milestone"]');
  assert.ok(milestoneFilter);
  assert.deepEqual([...milestoneFilter.options].map((option) => option.textContent), [
    '全部 Milestones',
    '未設定 Milestone',
    'Duplicate name · team (#22)',
    'Duplicate name · team/child (#23)',
    'Unused release'
  ]);
  assert.equal(document.querySelectorAll('.work-row').length, 2);

  milestoneFilter.value = '22';
  milestoneFilter.dispatchEvent(new view.dom.window.Event('change', { bubbles: true }));
  await view.tick();
  assert.deepEqual([...document.querySelectorAll('.work-row .row-title')].map((item) => item.textContent), ['Alpha milestone issue']);
  assert.equal(view.savedState.scopedData['team-scope'].issueMilestoneFilter, '22');

  document.querySelector('select[aria-label="Issue 專案"]').value = '2';
  document.querySelector('select[aria-label="Issue 專案"]').dispatchEvent(new view.dom.window.Event('change', { bubbles: true }));
  await view.tick();
  assert.equal(document.querySelectorAll('.work-row').length, 0);
  assert.equal(document.querySelector('.work-list .empty-inline strong').textContent, '沒有符合篩選條件的 Issue');

  const stateFilter = document.querySelector('select[aria-label="Issue 狀態"]');
  stateFilter.value = 'all';
  stateFilter.dispatchEvent(new view.dom.window.Event('change', { bubbles: true }));
  const projectFilter = document.querySelector('select[aria-label="Issue 專案"]');
  projectFilter.value = 'all';
  projectFilter.dispatchEvent(new view.dom.window.Event('change', { bubbles: true }));
  milestoneFilter.value = 'none';
  milestoneFilter.dispatchEvent(new view.dom.window.Event('change', { bubbles: true }));
  await view.tick();
  assert.deepEqual([...document.querySelectorAll('.work-row .row-title')].map((item) => item.textContent), ['Beta unassigned issue']);
});

test('restores a Group-scoped Milestone filter and resets it after the selected milestone is removed', async (t) => {
  const saved = {
    mode: 'developer',
    issueMilestoneFilter: '23',
    scopeKey: 'team-scope',
    scopedData: { 'team-scope': { issueMilestoneFilter: '23' } }
  };
  const view = await mount(saved, snapshot());
  t.after(() => view.dom.window.close());
  const filter = view.dom.window.document.querySelector('select[aria-label="Issue Milestone"]');
  assert.equal(filter.value, '23');
  assert.deepEqual([...view.dom.window.document.querySelectorAll('.work-row .row-title')].map((item) => item.textContent), ['Beta milestone issue']);

  const failedRefresh = snapshot();
  failedRefresh.groupMilestones = [];
  failedRefresh.groupMilestonesError = 'Milestone API unavailable';
  view.sendSnapshot(failedRefresh);
  await view.tick();
  assert.equal(view.dom.window.document.querySelector('select[aria-label="Issue Milestone"]').value, '23');
  assert.match(view.dom.window.document.querySelector('[role="alert"]').textContent, /Milestone API unavailable/);

  const updated = snapshot();
  updated.groupMilestones = updated.groupMilestones.filter((milestone) => milestone.id !== 23);
  view.sendSnapshot(updated);
  await view.tick();
  assert.equal(view.dom.window.document.querySelector('select[aria-label="Issue Milestone"]').value, 'all', `saved=${JSON.stringify(view.savedState?.scopedData?.['team-scope']?.issueMilestoneFilter)}`);
  assert.equal(view.savedState.scopedData['team-scope'].issueMilestoneFilter, 'all');
  assert.equal(view.dom.window.document.querySelectorAll('.work-row').length, 2);

});

test('selects only visible Repo search results, preserves hidden selections, and reports partial selection', async (t) => {
  const saved = { mode: 'clone', scopeKey: 'team-scope', selectedProjectIds: [3] };
  const view = await mount(saved, snapshot('clone'));
  t.after(() => view.dom.window.close());
  const document = view.dom.window.document;
  const search = document.querySelector('input[aria-label="搜尋 Repo"]');
  const selectAll = document.querySelector('input[aria-label="全選搜尋結果"]');
  assert.ok(selectAll);
  assert.equal(selectAll.checked, false);
  assert.equal(selectAll.indeterminate, true);

  search.value = 'no-such-repo';
  search.dispatchEvent(new view.dom.window.Event('input', { bubbles: true }));
  await view.tick();
  assert.equal(document.querySelector('input[aria-label="全選搜尋結果"]').disabled, true);

  search.value = 'alpha';
  search.dispatchEvent(new view.dom.window.Event('input', { bubbles: true }));
  await view.tick();
  const filteredSelectAll = document.querySelector('input[aria-label="全選搜尋結果"]');
  filteredSelectAll.click();
  await view.tick();
  assert.deepEqual(view.savedState.selectedProjectIds, [3, 1]);
  assert.match(document.querySelector('.clone-selection-summary').textContent, /1 個不在目前搜尋結果/);

  const cancelVisibleSelection = document.querySelector('input[aria-label="取消全選搜尋結果"]');
  assert.equal(cancelVisibleSelection.isConnected, true);
  cancelVisibleSelection.click();
  await view.tick();
  await view.tick();
  assert.deepEqual(view.savedState.selectedProjectIds, [3]);
  assert.equal(document.querySelector('.more-actions-panel').textContent.includes('下載／更新全部 Repo'), false);

  view.sendSnapshot({ ...snapshot('clone'), busy: true });
  await view.tick();
  assert.equal(document.querySelector('input[aria-label="全選搜尋結果"]').disabled, true);
});

test('shows the sanitized Git error details in the repository operation results', async (t) => {
  const view = await mount(undefined, snapshot('clone'));
  t.after(() => view.dom.window.close());
  const message = 'Git could not synchronize this repository. (git fetch, exit 128):\nfatal: Authentication failed';
  view.dom.window.dispatchEvent(new view.dom.window.MessageEvent('message', {
    data: {
      type: 'cloneOperation',
      id: 'sync-error',
      scopeKey: 'team-scope',
      phase: 'completed',
      label: '預設分支同步結果',
      items: [{ projectId: 1, projectPath: 'team/alpha', state: 'failed', message }]
    }
  }));
  await view.tick();
  assert.equal(view.dom.window.document.querySelector('.operation-state.failed')?.textContent, message);
});
