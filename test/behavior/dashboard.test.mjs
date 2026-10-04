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
    groupIssueBoards: [
      { id: 31, name: 'Delivery', hide_backlog_list: false, hide_closed_list: false },
      { id: 32, name: 'Triage', hide_backlog_list: true, hide_closed_list: false },
      { id: 33, name: 'Triage', hide_backlog_list: false, hide_closed_list: true }
    ],
    issueBoardContent: { boardId: 31, connectedScope: 'team-scope', issueIds: [101, 102, 103], status: 'ready' },
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
    workflowKit: { status: 'installed', version: '0.9.0', source: 'bundled' },
    workflowKitPackages: [{ id: 'bundled-0.9.0', version: '0.9.0', source: 'bundled', assetName: 'workflow-kit.tar.xz', format: 'tar.xz', entryRoot: 'workflow-kit', available: true }],
    workflowKitSource: 'bundled',
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

test('renders and uses the installed Group Wiki guide with validated prompts and saved inputs', async (t) => {
  const selectedGroup = snapshot('sa');
  selectedGroup.localRepositories = { 1: { state: 'ready', path: 'C:/workspace/team/alpha' } };
  const view = await mount({ mode: 'sa' }, selectedGroup);
  t.after(() => view.dom.window.close());
  const document = view.dom.window.document;
  assert.equal(document.querySelector('.page-heading h1').textContent, 'Codebase LLM Wiki');
  assert.equal(document.querySelectorAll('.wiki-guide-card').length, 13);
  assert.ok(document.querySelector('.wiki-guide-notice'));
  assert.equal(document.querySelector('[aria-label="複製安裝／設定提示詞"]'), null);
  assert.match(document.querySelector('[id="wiki-card-title-install"]').closest('.wiki-guide-card').textContent, /開啟整包安裝與更新/);

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
  assert.match(preview.textContent, /實際 Group 工作區：C:\/workspace\/team/);
  assert.match(preview.textContent, /工作流程包版本：0\.9\.0/);
  assert.match(preview.textContent, /team\/alpha → C:\/workspace\/team\/alpha/);

  document.querySelector('.wiki-guide-intro button').click();
  await view.tick();
  assert.ok(document.querySelector('[role="dialog"]'));

  copy.click();
  await view.tick();
  const request = view.requests.at(-1);
  assert.equal(request.type, 'copy');
  assert.ok(request.text.includes(query.value));
  assert.match(request.text, /team\/alpha → C:\/workspace\/team\/alpha/);
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
  assert.equal(view.savedState.wikiGuideInputsByScope['team-scope']['query.question'], query.value);

  const reopened = await mount(view.savedState, selectedGroup);
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

test('blocks copied Wiki tasks until the Group directory and complete workflow kit are ready', async (t) => {
  const state = snapshot('sa');
  state.groupRoot = undefined;
  state.workflowKit = { status: 'missing' };
  const view = await mount({ mode: 'sa' }, state);
  t.after(() => view.dom.window.close());
  const document = view.dom.window.document;
  const query = document.querySelector('[id="wiki-input-query.question"]');
  query.value = 'How does retry work?';
  query.dispatchEvent(new view.dom.window.Event('input', { bubbles: true }));
  await view.tick();
  assert.equal(document.querySelector('[aria-label="複製查詢 Wiki提示詞"]').disabled, true);
  assert.match(document.querySelector('.wiki-guide-intro').textContent, /檢查完整工作流程包已安裝/);
});

test('filters by the selected Issue Board, saves its ID, and hides previous Board content during a switch', async (t) => {
  const view = await mount({ mode: 'developer', scopeKey: 'team-scope', issueBoardId: 31 }, snapshot());
  t.after(() => view.dom.window.close());
  const document = view.dom.window.document;
  const boardFilter = document.querySelector('select[aria-label="Issue Board"]');
  assert.ok(boardFilter);
  assert.equal(boardFilter.value, '31');
  assert.deepEqual([...boardFilter.options].map((option) => option.textContent), [
    '選擇 Issue Board', 'Delivery', 'Triage (#32)', 'Triage (#33)'
  ]);
  assert.equal(document.querySelectorAll('.work-row').length, 3);

  boardFilter.value = '32';
  boardFilter.dispatchEvent(new view.dom.window.Event('change', { bubbles: true }));
  await view.tick();
  const selection = view.requests.filter((request) => request.type === 'selectIssueBoard').at(-1);
  assert.equal(selection?.type, 'selectIssueBoard');
  assert.equal(selection?.boardId, 32);
  assert.equal(selection?.connectedScope, 'team-scope');
  assert.equal(document.querySelectorAll('.work-row').length, 0);
  assert.equal(document.querySelector('.work-list .empty-inline strong').textContent, '正在載入 Board 內容');

  const stale = snapshot();
  stale.issueBoardContent = { boardId: 31, connectedScope: 'team-scope', issueIds: [101], status: 'ready' };
  view.sendSnapshot(stale);
  await view.tick();
  assert.equal(document.querySelectorAll('.work-row').length, 0);

  const loaded = snapshot();
  loaded.issueBoardContent = { boardId: 32, connectedScope: 'team-scope', issueIds: [102], status: 'ready' };
  view.sendSnapshot(loaded);
  await view.tick();
  assert.deepEqual([...document.querySelectorAll('.work-row .row-title')].map((item) => item.textContent), ['Beta milestone issue']);
  assert.equal(view.savedState.scopedData['team-scope'].issueBoardId, 32);
});

test('opens the Issue graph on demand, applies shared filters with one-hop context, and keeps its Board separate from the list', async (t) => {
  const view = await mount({ mode: 'developer', scopeKey: 'team-scope', issueBoardId: 31 }, snapshot());
  t.after(() => view.dom.window.close());
  const document = view.dom.window.document;
  assert.equal(document.querySelector('.developer-view-switch button.active')?.textContent, '清單');
  assert.equal(document.querySelectorAll('.issue-graph-workspace').length, 0);
  assert.equal(view.requests.some((request) => request.type === 'loadIssueGraph'), false);

  document.querySelector('.developer-view-switch button[aria-pressed="false"]:last-child')?.click();
  await view.tick();
  assert.equal(document.querySelector('.developer-view-switch button.active')?.textContent, '圖譜');
  const graphRequest = view.requests.filter((request) => request.type === 'loadIssueGraph').at(-1);
  assert.equal(graphRequest?.type, 'loadIssueGraph');
  assert.equal(graphRequest?.connectedScope, 'team-scope');
  assert.match(document.querySelector('.graph-loading-placeholder').textContent, /正在準備/);

  const graphSnapshot = snapshot();
  graphSnapshot.issueGraph = {
    connectedScope: 'team-scope', status: 'ready', roots: ['project:1:issue:1', 'project:2:issue:2'],
    nodes: [
      { id: 'project:1:issue:1', sourceIds: ['REST:Issue:101', 'GraphQL:WorkItem:gid-a'], kind: 'issue', namespacePath: 'team/alpha', projectPath: 'team/alpha', projectId: 1, iid: '1', title: 'Alpha milestone issue', state: 'opened', webUrl: 'https://gitlab.example.test/team/alpha/-/issues/1', labels: [{ name: 'bug', color: '#cc3300', textColor: '#ffffff' }], assignees: [], boardIds: [31], assignedToMe: true, isRoot: true, relationsStatus: 'ready' },
      { id: 'project:2:issue:2', sourceIds: ['REST:Issue:102'], kind: 'issue', namespacePath: 'team/beta', projectPath: 'team/beta', projectId: 2, iid: '2', title: 'Beta milestone issue', state: 'opened', webUrl: 'https://gitlab.example.test/team/beta/-/issues/2', labels: [{ name: 'feature', color: '#2266cc', textColor: '#ffffff' }], assignees: [], boardIds: [32], assignedToMe: true, isRoot: true, relationsStatus: 'ready' },
      { id: 'project:2:issue:4', sourceIds: ['GraphQL:WorkItem:gid-c'], kind: 'issue', namespacePath: 'team/beta', projectPath: 'team/beta', projectId: 2, iid: '4', title: 'Beta context', state: 'closed', labels: [], assignees: [], boardIds: [], assignedToMe: false, isRoot: false, relationsStatus: 'ready' }
    ],
    edges: [
      { id: 'relates_to:project:1:issue:1\0project:2:issue:2', source: 'project:1:issue:1', target: 'project:2:issue:2', type: 'relates_to' },
      { id: 'parent:project:2:issue:2\0project:2:issue:4', source: 'project:2:issue:2', target: 'project:2:issue:4', type: 'parent' }
    ],
    boardIssueIds: { 31: [101], 32: [102] }, boardStatus: { 31: { status: 'ready' }, 32: { status: 'ready' }, 33: { status: 'ready' } }, errors: [], updatedAt: Date.now()
  };
  view.sendSnapshot(graphSnapshot);
  await view.tick();
  assert.equal(document.querySelectorAll('.graph-node').length, 3);
  assert.equal(document.querySelectorAll('.graph-edge').length, 2);

  const labelFilter = document.querySelector('select[aria-label="Issue Label"]');
  labelFilter.value = 'bug';
  labelFilter.dispatchEvent(new view.dom.window.Event('change', { bubbles: true }));
  await view.tick();
  assert.equal(document.querySelectorAll('.graph-node').length, 2, 'the matching Issue and its direct context remain; the context’s own child is excluded');
  assert.equal(document.querySelectorAll('.graph-edge').length, 1);
  assert.ok(document.querySelector('.graph-node.primary'));
  assert.ok(document.querySelector('.graph-node.context'));

  document.querySelector('.graph-node.primary').dispatchEvent(new view.dom.window.MouseEvent('click', { bubbles: true }));
  await view.tick();
  assert.equal(document.querySelector('.graph-selected-detail h2')?.textContent, 'Alpha milestone issue');
  assert.match(document.querySelector('.graph-related-list').textContent, /Beta milestone issue/);
  document.querySelector('.graph-selected-detail button.primary').click();
  await view.tick();
  const openIssueRequest = view.requests.filter((request) => request.type === 'openIssue').at(-1);
  assert.equal(openIssueRequest?.type, 'openIssue');
  assert.equal(openIssueRequest?.projectId, 1);
  assert.equal(openIssueRequest?.issueIid, 1);

  const graphBoard = document.querySelector('select[aria-label="圖譜 Issue Board"]');
  graphBoard.value = '32';
  graphBoard.dispatchEvent(new view.dom.window.Event('change', { bubbles: true }));
  await view.tick();
  assert.equal(view.savedState.scopedData['team-scope'].graphBoardId, 32);
  document.querySelector('.developer-view-switch button[aria-pressed="false"]:first-child').click();
  await view.tick();
  assert.equal(document.querySelector('select[aria-label="Issue Board"]').value, '31');
  assert.equal(document.querySelector('select[aria-label="Issue Label"]').value, 'bug');
  document.querySelector('.developer-view-switch button[aria-pressed="false"]:last-child').click();
  await view.tick();
  assert.equal(document.querySelector('select[aria-label="圖譜 Issue Board"]').value, '32');
});

test('restores the first Board after a saved Board is removed and shows Board API failures without stale Issues', async (t) => {
  const view = await mount({ mode: 'developer', scopeKey: 'team-scope', issueBoardId: 31 }, snapshot());
  t.after(() => view.dom.window.close());
  const document = view.dom.window.document;

  const deleted = snapshot();
  deleted.groupIssueBoards = deleted.groupIssueBoards.filter((board) => board.id !== 31);
  view.sendSnapshot(deleted);
  await view.tick();
  assert.equal(document.querySelector('select[aria-label="Issue Board"]').value, '32', `scope=${view.savedState.scopeKey}; saved=${JSON.stringify(view.savedState.scopedData?.['team-scope']?.issueBoardId)}; options=${JSON.stringify([...document.querySelectorAll('select[aria-label="Issue Board"] option')].map((option) => option.value))}`);
  assert.equal(document.querySelectorAll('.work-row').length, 0);
  assert.equal(view.savedState.scopedData['team-scope'].issueBoardId, 32);

  const failed = snapshot();
  failed.groupIssueBoards = [];
  failed.groupIssueBoardsError = 'Board API unavailable';
  failed.issueBoardContent = undefined;
  view.sendSnapshot(failed);
  await view.tick();
  assert.equal(document.querySelector('select[aria-label="Issue Board"]').disabled, true);
  assert.match(document.querySelector('.work-list .empty-inline').textContent, /Board API unavailable/);
  assert.equal(document.querySelectorAll('.work-row').length, 0);

  const noBoards = snapshot();
  noBoards.groupIssueBoards = [];
  noBoards.issueBoardContent = undefined;
  view.sendSnapshot(noBoards);
  await view.tick();
  assert.equal(document.querySelector('select[aria-label="Issue Board"]').disabled, true);
  assert.match(document.querySelector('.work-list .empty-inline').textContent, /此 Group 沒有可用的 Issue Board/);
});

test('does not display Issue IDs returned for another Group or connected account', async (t) => {
  const view = await mount({ mode: 'developer', scopeKey: 'team-scope', issueBoardId: 31 }, snapshot());
  t.after(() => view.dom.window.close());
  const document = view.dom.window.document;

  const changedScope = snapshot();
  changedScope.connectedScope = 'another-scope';
  view.sendSnapshot(changedScope);
  await view.tick();
  assert.equal(document.querySelectorAll('.work-row').length, 0);
  const selection = view.requests.filter((request) => request.type === 'selectIssueBoard').at(-1);
  assert.equal(selection?.type, 'selectIssueBoard');
  assert.equal(selection?.boardId, 31);
  assert.equal(selection?.connectedScope, 'another-scope');

  const loaded = snapshot();
  loaded.connectedScope = 'another-scope';
  loaded.issueBoardContent = { boardId: 31, connectedScope: 'another-scope', issueIds: [103], status: 'ready' };
  view.sendSnapshot(loaded);
  await view.tick();
  assert.deepEqual([...document.querySelectorAll('.work-row .row-title')].map((item) => item.textContent), ['Beta unassigned issue']);
});

test('applies scoped timer and Issue graph deltas while rejecting stale versions', async (t) => {
  const view = await mount({ mode: 'developer', scopeKey: 'team-scope', developerView: 'graph' }, snapshot());
  t.after(() => view.dom.window.close());
  const document = view.dom.window.document;
  const timer = {
    id: 'timer-1', projectId: 1, projectPath: 'team/alpha', issueIid: 1, title: 'Alpha milestone issue',
    elapsedSeconds: 42, phase: 'running', summary: '', updatedAt: Date.now()
  };
  const send = (data) => view.dom.window.dispatchEvent(new view.dom.window.MessageEvent('message', { data }));
  send({ type: 'timersChanged', instanceUserScope: 'instance-user', version: 1, timers: [timer] });
  await view.tick();
  assert.match(document.querySelector('.statusbar').textContent, /team\/alpha #1/);

  const graph = {
    connectedScope: 'team-scope', status: 'ready', roots: ['project:1:issue:1'],
    nodes: [{ id: 'project:1:issue:1', sourceIds: ['REST:Issue:101'], kind: 'issue', namespacePath: 'team/alpha', projectPath: 'team/alpha', projectId: 1, iid: '1', title: 'Graph title v2', state: 'opened', labels: [], assignees: [], boardIds: [31], assignedToMe: true, isRoot: true, relationsStatus: 'ready' }],
    edges: [], boardIssueIds: { 31: [101] }, boardStatus: { 31: { status: 'ready' } }, errors: [], updatedAt: Date.now()
  };
  send({ type: 'issueGraphChanged', connectedScope: 'team-scope', version: 2, graph });
  await view.tick();
  assert.equal(document.querySelector('.graph-node title')?.textContent, 'Graph title v2');
  send({ type: 'issueGraphChanged', connectedScope: 'team-scope', version: 1, graph: { ...graph, nodes: [{ ...graph.nodes[0], title: 'Stale title' }] } });
  send({ type: 'timersChanged', instanceUserScope: 'another-user', version: 2, timers: [] });
  await view.tick();
  assert.equal(document.querySelector('.graph-node title')?.textContent, 'Graph title v2');
  assert.match(document.querySelector('.statusbar').textContent, /team\/alpha #1/);
});

test('filters selected Board Issues by Repo and Group Milestone IDs while retaining unmatched and duplicate-title options', async (t) => {
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
  assert.equal(document.querySelectorAll('.work-row').length, 3);

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
  assert.equal(view.dom.window.document.querySelectorAll('.work-row').length, 3);

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

test('binds imported reports to both SHAs without adding approval or merge gates', async (t) => {
  const current = snapshot('reviewer');
  const sourceSha = 'a'.repeat(40), targetSha = 'b'.repeat(40);
  const request = { id: 41, iid: 4, project_id: 1, source_project_id: 2, target_project_id: 1,
    title: 'Fork change', state: 'opened', source_branch: 'feature', target_branch: 'main',
    web_url: 'https://gitlab.example.test/team/alpha/-/merge_requests/4', diff_refs: { head_sha: sourceSha } };
  current.mergeRequests = [request];
  current.selectedMergeRequest = { request, diffs: [], discussions: [], warnings: [],
    freshness: { state: 'current', checkedAt: new Date().toISOString() }, sourceSha, targetSha };
  const view = await mount({ mode: 'reviewer', scopeKey: 'team-scope' }, current);
  t.after(() => view.dom.window.close());
  const document = view.dom.window.document;
  const button = (label) => [...document.querySelectorAll('button')].find((node) => node.textContent === label);
  button('審查報告').click();
  await view.tick();
  assert.equal(button('發布審查報告').disabled, true);
  assert.equal(button('核准').disabled, false);
  assert.equal(button('合併 MR').disabled, false);
  button('複製審查任務並開啟 Codex CLI').click();
  await view.tick();
  assert.equal(view.requests.at(-1).type, 'openMergeReviewTask');
  const textarea = document.querySelector('.reviewer-detail textarea');
  textarea.value = 'Legacy plain text';
  textarea.dispatchEvent(new view.dom.window.Event('input', { bubbles: true }));
  await view.tick();
  assert.equal(button('發布審查報告').disabled, true);
  button('作一般留言發布').click();
  await view.tick();
  assert.equal(view.requests.at(-1).type, 'postMergeRequestNote');
  view.dom.window.dispatchEvent(new view.dom.window.MessageEvent('message', { data: {
    type: 'mergeReviewReportImported', projectId: 1, iid: 4, text: 'Incomplete P1 report', sourceSha, targetSha
  } }));
  await view.tick();
  assert.equal(button('發布審查報告').disabled, false);
  button('發布審查報告').click();
  await view.tick();
  assert.equal(view.requests.at(-1).type, 'publishMergeReviewReport');
  view.sendSnapshot({ ...current, selectedMergeRequest: { ...current.selectedMergeRequest, targetSha: 'c'.repeat(40) } });
  await view.tick();
  assert.equal(button('發布審查報告').disabled, true);
  assert.equal(button('核准').disabled, false);
  button('核准').click();
  await view.tick();
  assert.equal(view.requests.at(-1).type, 'approveMergeRequest');
  assert.equal(view.requests.at(-1).sha, sourceSha);
  button('合併 MR').click();
  await view.tick();
  assert.equal(view.requests.at(-1).type, 'mergeMergeRequest');
});
