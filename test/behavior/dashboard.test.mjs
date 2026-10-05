import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { JSDOM, VirtualConsole } from 'jsdom';

const html = await readFile(new URL('../../resources/issue-webview/dashboard.html', import.meta.url), 'utf8');
const script = await readFile(new URL('../../resources/issue-webview/dashboard.js', import.meta.url), 'utf8');
const dashboardCss = await readFile(new URL('../../src/webview/dashboard.css', import.meta.url), 'utf8');

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
    workspaceRootError: undefined,
    groupRepositories: [{ name: 'alpha', path: 'C:/workspace/team/alpha' }],
    groupRepositoryScanStatus: 'ready',
    groupRepositoryScanError: undefined,
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

function issueDetailData(issue, project) {
  return {
    issue, project, projects: [project], user: { id: 7, username: 'test-user', name: 'Test User' },
    options: { members: [], labels: [], milestones: [], templates: [], warnings: [] }, discussions: [], links: [], mergeRequests: [],
    reactions: [], noteReactions: {}, todos: [], tasks: [], timelogs: [], startDate: null, warnings: [],
    canEdit: false, canDelete: false, canMove: false, canClone: false, canComment: false, canInternalComment: false,
    canTrackTime: false, canResolveThreads: false, canSetStartDate: false, hasStartDate: false, canLogTime: false,
    canDeleteTimelog: false, canLink: false, canManageChildren: false
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
    },
    send(value) {
      dom.window.dispatchEvent(new dom.window.MessageEvent('message', { data: value }));
    }
  };
}

test('bounds the dashboard to the VS Code viewport and sends the full-display toggle', async (t) => {
  const data = snapshot('developer');
  data.instance = { version: '16.11.10', enterprise: false, warnings: ['Community Edition feature note'] };
  const view = await mount({ mode: 'developer' }, data);
  t.after(() => view.dom.window.close());
  const document = view.dom.window.document;
  const shell = document.querySelector('.app-shell');
  const fullDisplayButton = [...document.querySelectorAll('button')].find((button) => button.textContent.trim() === '完整顯示');
  assert.ok(shell);
  assert.ok(fullDisplayButton);
  assert.match(document.querySelector('.page > .alert[role="status"]').textContent, /16\.11\.10.*Community Edition feature note/s);
  fullDisplayButton.click();
  await view.tick();
  assert.ok(view.requests.some((request) => request.type === 'toggleFullDisplay'));
  assert.equal(document.querySelector('.app-shell'), shell, 'the click leaves the mounted workbench and its local view state in place');
  assert.match(dashboardCss, /\.app-shell\s*\{[^}]*height:\s*100dvh/s);
  assert.match(dashboardCss, /\.topbar\s*\{[^}]*flex:\s*0\s+0\s+auto/s);
  assert.match(dashboardCss, /\.page\s*\{[^}]*overflow:\s*auto/s);
  assert.match(dashboardCss, /\.issue-list-panel\s*\{[^}]*overflow:\s*auto/s);
  assert.match(dashboardCss, /\.tool-drawer\s*\{[^}]*overflow:\s*auto/s);
  assert.match(dashboardCss, /\.statusbar\s*\{[^}]*flex:\s*0\s+0\s+auto/s);
});

test('shows one selected Wiki feature and builds prompts from the actual local Repo inventory', async (t) => {
  const selectedGroup = snapshot('sa');
  selectedGroup.groupRepositories = [
    { name: 'renamed-alpha', path: 'C:/workspace/team/renamed-alpha' },
    { name: 'unmapped-tools', path: 'C:/workspace/team/unmapped-tools' }
  ];
  const view = await mount({ mode: 'sa' }, selectedGroup);
  t.after(() => view.dom.window.close());
  const document = view.dom.window.document;
  assert.equal(document.querySelector('.page-heading h1').textContent, 'Codebase LLM Wiki');
  assert.equal(document.querySelectorAll('.wiki-guide-card').length, 1);
  assert.equal(document.querySelector('.wiki-guide-card h2').id, 'wiki-card-title-development-spec');
  assert.equal(document.querySelector('.wiki-guide-intro'), null);
  assert.equal(document.querySelectorAll('.wiki-guide-selector option').length, 13);

  const selector = document.querySelector('.wiki-guide-selector select');
  assert.equal(selector.value, 'development-spec');
  const devPreview = document.querySelector('.wiki-prompt-preview');
  assert.ok(devPreview.textContent.includes('renamed-alpha → C:/workspace/team/renamed-alpha'));
  assert.ok(devPreview.textContent.includes('unmapped-tools → C:/workspace/team/unmapped-tools'));
  assert.equal(devPreview.textContent.includes('team/alpha'), false);

  selector.value = 'query';
  selector.dispatchEvent(new view.dom.window.Event('change', { bubbles: true }));
  await view.tick();
  assert.equal(document.querySelectorAll('.wiki-guide-card').length, 1);
  assert.equal(document.querySelector('.wiki-guide-card h2').id, 'wiki-card-title-query');
  const query = document.querySelector('[id="wiki-input-query.question"]');
  const copy = document.querySelector('.wiki-copy-button');
  assert.ok(query);
  assert.equal(copy.disabled, true);

  query.value = ['How does retry work?', 'Which Repo owns the retry policy?'].join(String.fromCharCode(10));
  query.dispatchEvent(new view.dom.window.Event('input', { bubbles: true }));
  await view.tick();
  assert.equal(copy.disabled, false);
  const preview = document.querySelector('.wiki-prompt-preview');
  assert.ok(preview.textContent.includes(query.value));
  assert.ok(preview.textContent.includes('renamed-alpha → C:/workspace/team/renamed-alpha'));
  assert.ok(preview.textContent.includes('unmapped-tools → C:/workspace/team/unmapped-tools'));

  copy.click();
  await view.tick();
  const request = view.requests.at(-1);
  assert.equal(request.type, 'copy');
  assert.ok(request.text.includes(query.value));
  assert.ok(request.text.includes('renamed-alpha → C:/workspace/team/renamed-alpha'));
  view.send({ type: 'message', message: 'Prompt copied' });
  await view.tick();
  assert.match(document.querySelector('.toast').textContent, /Prompt copied/);

  selector.value = 'audit';
  selector.dispatchEvent(new view.dom.window.Event('change', { bubbles: true }));
  await view.tick();
  const auditScope = document.querySelector('[id="wiki-input-audit.scope"]');
  auditScope.value = 'src/payments';
  auditScope.dispatchEvent(new view.dom.window.Event('input', { bubbles: true }));
  await view.tick();
  selector.value = 'query';
  selector.dispatchEvent(new view.dom.window.Event('change', { bubbles: true }));
  await view.tick();
  assert.equal(document.querySelector('[id="wiki-input-query.question"]').value, query.value);
  assert.equal(view.savedState.wikiGuideSelectionsByScope['team-scope'], 'query');
  assert.equal(view.savedState.wikiGuideInputsByScope['team-scope']['query.question'], query.value);
  assert.equal(view.savedState.wikiGuideInputsByScope['team-scope']['audit.scope'], 'src/payments');

  const reopened = await mount(view.savedState, selectedGroup);
  t.after(() => reopened.dom.window.close());
  assert.equal(reopened.dom.window.document.querySelector('.wiki-guide-selector select').value, 'query');
  assert.equal(reopened.dom.window.document.querySelector('[id="wiki-input-query.question"]').value, query.value);

  selector.value = 'install';
  selector.dispatchEvent(new view.dom.window.Event('change', { bubbles: true }));
  await view.tick();
  document.querySelector('.wiki-guide-fields button').click();
  await view.tick();
  assert.ok(document.querySelector('[role="dialog"]'));
});

test('keeps Wiki guide selection and inputs separate for each selected Group', async (t) => {
  const view = await mount({ mode: 'sa', scopeKey: 'team-scope' }, snapshot('sa'));
  t.after(() => view.dom.window.close());
  const document = view.dom.window.document;
  const selector = document.querySelector('.wiki-guide-selector select');
  selector.value = 'query';
  selector.dispatchEvent(new view.dom.window.Event('change', { bubbles: true }));
  await view.tick();
  const query = document.querySelector('[id="wiki-input-query.question"]');
  query.value = 'Team A query';
  query.dispatchEvent(new view.dom.window.Event('input', { bubbles: true }));
  await view.tick();

  const groupB = snapshot('sa');
  groupB.connectedScope = 'another-group-scope';
  groupB.group = { ...groupB.group, id: 9, full_path: 'another-team' };
  view.sendSnapshot(groupB);
  await view.tick();
  assert.equal(document.querySelector('.wiki-guide-selector select').value, 'development-spec');
  selector.value = 'query';
  selector.dispatchEvent(new view.dom.window.Event('change', { bubbles: true }));
  await view.tick();
  query.value = 'Team B query';
  query.dispatchEvent(new view.dom.window.Event('input', { bubbles: true }));
  await view.tick();

  view.sendSnapshot(snapshot('sa'));
  await view.tick();
  assert.equal(document.querySelector('.wiki-guide-selector select').value, 'query');
  assert.equal(document.querySelector('[id="wiki-input-query.question"]').value, 'Team A query');
  assert.equal(view.savedState.wikiGuideSelectionsByScope['team-scope'], 'query');
  assert.equal(view.savedState.wikiGuideSelectionsByScope['another-group-scope'], 'query');
  assert.equal(view.savedState.wikiGuideInputsByScope['team-scope']['query.question'], 'Team A query');
  assert.equal(view.savedState.wikiGuideInputsByScope['another-group-scope']['query.question'], 'Team B query');
});

test('blocks Wiki prompt copying until the VS Code Group workspace, Repo scan, and workflow kit are ready', async (t) => {
  const state = snapshot('sa');
  state.groupRoot = undefined;
  state.groupRepositoryScanStatus = 'idle';
  state.workflowKit = { status: 'missing' };
  const view = await mount({ mode: 'sa' }, state);
  t.after(() => view.dom.window.close());
  const document = view.dom.window.document;
  const query = document.querySelector('[id="wiki-input-development-spec.scope"]');
  query.value = 'Retry behavior';
  query.dispatchEvent(new view.dom.window.Event('input', { bubbles: true }));
  await view.tick();
  assert.equal(document.querySelector('.wiki-copy-button').disabled, true);
  assert.ok(document.querySelector('.wiki-guide-selector select'));
  assert.equal(document.querySelector('.wiki-guide-intro'), null);
});
test('copies the loaded Issue Markdown for read-only accounts and ignores replies after navigation changes', async (t) => {
  const view = await mount({ mode: 'developer', scopeKey: 'team-scope' }, snapshot());
  t.after(() => view.dom.window.close());
  const document = view.dom.window.document;
  const issue = {
    ...snapshot().issues[0],
    description: '## Reproduction\n\n![trace](https://gitlab.example.test/uploads/trace.png)\n\n- preserve this line'
  };
  const project = snapshot().projects[0];
  const openIssue = async (currentIssue, revision) => {
    view.send({ type: 'issueNavigation', navigation: { mode: 'detail', projectId: currentIssue.project_id, issueIid: currentIssue.iid, revision } });
    await view.tick();
    view.send({ type: 'issueResponse', revision, response: { type: 'detailData', data: issueDetailData(currentIssue, project) } });
    await view.tick();
  };

  await openIssue(issue, 10);
  const copy = document.querySelector('button[aria-label="複製 Issue 描述"]');
  assert.ok(copy);
  assert.equal(copy.disabled, false, 'copy remains available when editing permissions are false');
  copy.click();
  await view.tick();
  const request = view.requests.filter((item) => item.type === 'issueRequest').at(-1);
  assert.equal(request.revision, 10);
  assert.equal(request.request.type, 'copyDescription');
  assert.equal(request.request.issueId, issue.id);
  assert.match(request.request.requestId, /^copy-description-/);
  assert.equal(Object.hasOwn(request.request, 'description'), false);

  const emptyIssue = { ...snapshot().issues[1], description: [' ', String.fromCharCode(10), String.fromCharCode(9), ' '].join('') };
  await openIssue(emptyIssue, 11);
  assert.equal(document.querySelector('button[aria-label="複製 Issue 描述"]').disabled, true);
  view.send({ type: 'issueResponse', revision: 10, response: { type: 'reply', requestId: request.request.requestId, error: 'stale failure' } });
  await view.tick();
  assert.equal(document.querySelector('[role="alert"]'), null, 'a delayed response from the prior Issue is discarded');

  await openIssue(issue, 12);
  const copyAgain = document.querySelector('button[aria-label="複製 Issue 描述"]');
  copyAgain.click();
  await view.tick();
  const failedRequest = view.requests.filter((item) => item.type === 'issueRequest').at(-1);
  view.send({ type: 'issueResponse', revision: 12, response: { type: 'reply', requestId: failedRequest.request.requestId, error: 'Clipboard denied' } });
  await view.tick();
  assert.match(document.querySelector('[role="alert"]').textContent, /Clipboard denied/);
});
test('uses only the VS Code workspace for clone destinations and disables local Repo actions when unresolved', async (t) => {
  const state = snapshot('clone');
  state.groupRoot = undefined;
  state.workspaceRootError = 'Open a matching VS Code Group folder';
  const view = await mount({ mode: 'clone' }, state);
  t.after(() => view.dom.window.close());
  const document = view.dom.window.document;
  assert.equal(document.querySelector('.clone-submit').disabled, true);
  assert.match(document.querySelector('.clone-root-line').textContent, /Open a matching VS Code Group folder/);
  assert.equal([...document.querySelectorAll('button')].some((button) => /選擇工作目錄|設定工作目錄|變更工作目錄/.test(button.textContent)), false);
  assert.equal(view.requests.some((request) => request.type === 'selectWorkspace'), false);
});

test('shows every assigned Issue by default and keeps the list usable when Board loading fails', async (t) => {
  const initialSnapshot = snapshot();
  initialSnapshot.issueBoardContent = undefined;
  initialSnapshot.groupIssueBoardsError = 'Board API unavailable';
  const view = await mount({ mode: 'developer', scopeKey: 'team-scope' }, initialSnapshot);
  t.after(() => view.dom.window.close());
  const document = view.dom.window.document;
  const boardFilter = document.querySelector('select[aria-label="Issue Board"]');
  assert.equal(boardFilter.value, 'all');
  assert.equal(boardFilter.disabled, false);
  assert.match(boardFilter.options[0].textContent, /全部指派給我的 Issue.*Board 載入失敗/);
  assert.deepEqual([...document.querySelectorAll('.work-row .row-title')].map((item) => item.textContent), [
    'Alpha milestone issue', 'Beta milestone issue', 'Beta unassigned issue'
  ]);

  const projectFilter = document.querySelector('select[aria-label="Issue 專案"]');
  projectFilter.value = '2';
  projectFilter.dispatchEvent(new view.dom.window.Event('change', { bubbles: true }));
  await view.tick();
  assert.deepEqual([...document.querySelectorAll('.work-row .row-title')].map((item) => item.textContent), ['Beta milestone issue', 'Beta unassigned issue']);
  assert.equal(view.savedState.scopedData['team-scope'].issueBoardId, 'all');
});

test('returning from Issue details preserves list filters and scroll, and drops delayed navigation responses', async (t) => {
  const view = await mount({ mode: 'developer', scopeKey: 'team-scope' }, snapshot());
  t.after(() => view.dom.window.close());
  const document = view.dom.window.document;
  const search = document.querySelector('input[aria-label="搜尋 Issue"]');
  search.value = 'Beta milestone';
  search.dispatchEvent(new view.dom.window.Event('input', { bubbles: true }));
  const projectFilter = document.querySelector('select[aria-label="Issue 專案"]');
  projectFilter.value = '2';
  projectFilter.dispatchEvent(new view.dom.window.Event('change', { bubbles: true }));
  await view.tick();
  const workList = document.querySelector('.work-list');
  workList.scrollTop = 88;
  assert.equal(document.querySelectorAll('.work-row').length, 1);
  document.querySelector('.work-row').click();
  await view.tick();
  assert.equal(view.requests.filter((request) => request.type === 'openIssue').at(-1)?.issueIid, 2);

  const navigation = { mode: 'detail', projectId: 2, issueIid: 2, revision: 10 };
  view.send({ type: 'issueNavigation', navigation });
  await view.tick();
  view.send({ type: 'issueResponse', revision: 10, response: { type: 'detailData', data: issueDetailData(snapshot().issues[1], snapshot().projects[1]) } });
  await view.tick();
  assert.equal(document.querySelector('.issue-embed').hidden, false);
  assert.match(document.querySelector('.issue-topbar h1').textContent, /#2 Beta milestone issue/);
  document.querySelector('.issue-topbar button').click();
  await view.tick();
  assert.equal(document.querySelector('.issue-embed').hidden, true);
  assert.equal(document.querySelector('.workbench').dataset.mobilePanel, 'list');
  assert.equal(document.querySelector('.work-list').scrollTop, 88);
  assert.equal(document.querySelector('input[aria-label="搜尋 Issue"]').value, 'Beta milestone');
  assert.equal(document.querySelector('select[aria-label="Issue 專案"]').value, '2');
  assert.equal(document.querySelectorAll('.work-row').length, 1);

  const staleIssue = { ...snapshot().issues[2], title: 'Late response must not reopen' };
  view.send({ type: 'issueResponse', revision: 10, response: { type: 'detailData', data: issueDetailData(staleIssue, snapshot().projects[1]) } });
  await view.tick();
  assert.equal(document.querySelector('.issue-embed').hidden, true);
  assert.equal(document.querySelectorAll('.work-row').length, 1);
});

test('filters by the selected Issue Board, saves its ID, and hides previous Board content during a switch', async (t) => {
  const view = await mount({ mode: 'developer', scopeKey: 'team-scope', issueBoardId: 31 }, snapshot());
  t.after(() => view.dom.window.close());
  const document = view.dom.window.document;
  const boardFilter = document.querySelector('select[aria-label="Issue Board"]');
  assert.ok(boardFilter);
  assert.equal(boardFilter.value, '31');
  assert.deepEqual([...boardFilter.options].map((option) => option.textContent), [
    '全部指派給我的 Issue', 'Delivery', 'Triage (#32)', 'Triage (#33)'
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
  assert.equal(document.querySelector('.empty-inline strong').textContent, '正在載入 Board 內容');

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

test('windows a long Issue list and moves keyboard focus across virtualized rows', async (t) => {
  const data = snapshot('developer');
  data.issues = Array.from({ length: 230 }, (_, index) => ({
    id: 1_000 + index, iid: index + 1, project_id: index % 3 + 1,
    title: `Virtualized Issue ${index + 1}`, state: 'opened', labels: []
  }));
  const view = await mount({ mode: 'developer' }, data);
  t.after(() => view.dom.window.close());
  const document = view.dom.window.document;
  const list = document.querySelector('.work-list');
  assert.ok(list);
  assert.ok(list.querySelectorAll('.work-row').length < data.issues.length);
  list.scrollTop = 9_200;
  list.dispatchEvent(new view.dom.window.Event('scroll'));
  await view.tick();
  const firstVisible = list.querySelector('.work-row');
  const currentIndex = Number(firstVisible.closest('[data-virtual-index]').dataset.virtualIndex);
  firstVisible.dispatchEvent(new view.dom.window.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
  await view.tick();
  const focusedIndex = Number(document.activeElement.closest('[data-virtual-index]').dataset.virtualIndex);
  assert.equal(focusedIndex, currentIndex + 1);
  const search = document.querySelector('input[aria-label="搜尋 Issue"]');
  search.value = 'Virtualized Issue 221';
  search.dispatchEvent(new view.dom.window.Event('input', { bubbles: true }));
  await view.tick();
  assert.deepEqual([...document.querySelectorAll('.work-row .row-title')].map((row) => row.textContent), ['Virtualized Issue 221']);
});

test('opens the Issue graph on demand, applies shared filters with one-hop context, and keeps its Board separate from the list', async (t) => {
  const initialCamera = { x: 84, y: -32, scale: 1.4 };
  const initialNodePosition = { x: 255, y: 190 };
  const view = await mount({ mode: 'developer', scopeKey: 'team-scope', issueBoardId: 31, graphCamera: initialCamera,
    graphNodePositions: { 'project:1:issue:1': initialNodePosition }, graphAnimationEnabled: false }, snapshot());
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
  document.querySelector('.developer-view-switch button[aria-pressed="false"]:first-child').click();
  await view.tick();
  assert.equal(document.querySelector('select[aria-label="Issue Board"]').value, '31');
  assert.equal(document.querySelector('select[aria-label="Issue Label"]').value, 'bug');
  document.querySelector('.developer-view-switch button[aria-pressed="false"]:last-child').click();
  await view.tick();
  assert.equal(document.querySelector('select[aria-label="圖譜 Issue Board"]').value, 'all');
  assert.deepEqual(view.savedState.graphCamera, initialCamera);
  assert.deepEqual(view.savedState.graphNodePositions['project:1:issue:1'], initialNodePosition);

  graphBoard.value = '32';
  graphBoard.dispatchEvent(new view.dom.window.Event('change', { bubbles: true }));
  await view.tick();
  assert.equal(view.savedState.scopedData['team-scope'].graphBoardId, 32);
  document.querySelector('.developer-view-switch button[aria-pressed="false"]:first-child').click();
  await view.tick();
  assert.equal(document.querySelector('select[aria-label="Issue Board"]').value, '31');
  document.querySelector('.developer-view-switch button[aria-pressed="false"]:last-child').click();
  await view.tick();
  assert.equal(document.querySelector('select[aria-label="圖譜 Issue Board"]').value, '32');
});

test('graph relation forms use scoped requests, retry reads without repeating writes, and ignore stale node responses', async (t) => {
  const graphSnapshot = snapshot();
  const assignedNodes = graphSnapshot.issues.map((issue) => ({
    id: `project:${issue.project_id}:issue:${issue.iid}`, sourceIds: [`REST:Issue:${issue.id}`], kind: 'issue',
    namespacePath: `team/${issue.project_id === 1 ? 'alpha' : 'beta'}`, projectPath: `team/${issue.project_id === 1 ? 'alpha' : 'beta'}`,
    projectId: issue.project_id, iid: String(issue.iid), title: issue.title, state: issue.state,
    webUrl: issue.web_url, labels: [], assignees: [], boardIds: [], assignedToMe: true, isRoot: true, relationsStatus: 'ready'
  }));
  graphSnapshot.issueGraph = {
    connectedScope: 'team-scope', status: 'ready', roots: assignedNodes.map((node) => node.id), nodes: assignedNodes, edges: [],
    boardIssueIds: {}, boardStatus: {}, errors: [], updatedAt: Date.now()
  };
  const view = await mount({ mode: 'developer', scopeKey: 'team-scope', developerView: 'graph', selectedGraphNodeId: 'project:1:issue:1' }, graphSnapshot);
  t.after(() => view.dom.window.close());
  const document = view.dom.window.document;
  const firstLoad = view.requests.filter((item) => item.type === 'loadIssueRelations').at(-1);
  assert.equal(firstLoad?.type, 'loadIssueRelations');
  assert.equal(firstLoad?.connectedScope, 'team-scope');
  assert.equal(firstLoad?.projectId, 1);
  assert.equal(firstLoad?.issueIid, 1);

  const firstData = {
    issue: { id: 101, project_id: 1, iid: 1, title: 'Alpha milestone issue', state: 'opened', web_url: 'https://gitlab.example.test/team/alpha/-/issues/1' },
    project: graphSnapshot.projects[0], links: [], tasks: [], parentWorkItemId: 'gid://gitlab/WorkItem/101', taskTypeId: 'gid://gitlab/WorkItems::Type/5', canLink: true, canManageChildren: true
  };
  view.send({ type: 'issueRelations', requestId: firstLoad.requestId, connectedScope: 'team-scope', projectId: 1, issueIid: 1, data: firstData });
  await view.tick();
  assert.ok(document.querySelector('input[aria-label="新子工作標題"]'));
  assert.ok(document.querySelector('input[aria-label="關聯 Issue 編號"]'));

  const childTitle = document.querySelector('input[aria-label="新子工作標題"]');
  childTitle.value = 'Graph child';
  childTitle.dispatchEvent(new view.dom.window.Event('input', { bubbles: true }));
  await view.tick();
  document.querySelector('.issue-relation-editor button[type="button"]')?.click();
  await view.tick();
  const mutation = view.requests.filter((item) => item.type === 'mutateIssueRelations').at(-1);
  assert.equal(mutation?.type, 'mutateIssueRelations');
  assert.equal(mutation?.connectedScope, 'team-scope');
  assert.equal(mutation?.projectId, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(mutation?.action)), { type: 'createChild', title: 'Graph child' });
  view.send({ type: 'issueRelations', requestId: mutation.requestId, connectedScope: 'team-scope', projectId: 1, issueIid: 1, mutationApplied: true, error: '關係已更新，但重新載入失敗：暫時無法讀取' });
  await view.tick();
  assert.ok([...document.querySelectorAll('.issue-relation-editor button')].some((button) => button.textContent === '重新載入關係'));
  const mutationCount = view.requests.filter((item) => item.type === 'mutateIssueRelations').length;
  document.querySelector('.issue-relation-editor button.quiet')?.click();
  await view.tick();
  const retry = view.requests.filter((item) => item.type === 'loadIssueRelations').at(-1);
  assert.equal(retry?.type, 'loadIssueRelations');
  assert.equal(view.requests.filter((item) => item.type === 'mutateIssueRelations').length, mutationCount, 'retry performs a read only');

  document.querySelector('[aria-label*="team/beta #2"]')?.dispatchEvent(new view.dom.window.MouseEvent('click', { bubbles: true }));
  await view.tick();
  const secondLoad = view.requests.filter((item) => item.type === 'loadIssueRelations').at(-1);
  assert.equal(secondLoad?.projectId, 2);
  assert.equal(secondLoad?.issueIid, 2);
  view.send({ type: 'issueRelations', requestId: retry.requestId, connectedScope: 'team-scope', projectId: 1, issueIid: 1, data: firstData });
  await view.tick();
  assert.equal(document.querySelector('input[aria-label="新子工作標題"]'), null, 'the previous Issue response cannot restore its form');
  view.send({ type: 'issueRelations', requestId: secondLoad.requestId, connectedScope: 'team-scope', projectId: 2, issueIid: 2, data: {
    issue: { id: 102, project_id: 2, iid: 2, title: 'Beta milestone issue', state: 'opened', web_url: 'https://gitlab.example.test/team/beta/-/issues/2' },
    project: graphSnapshot.projects[1], links: [], tasks: [], canLink: false, canManageChildren: false
  } });
  await view.tick();
  assert.equal(document.querySelector('input[aria-label="新子工作標題"]'), null);
  assert.match(document.querySelector('.graph-selected-detail h2').textContent, /Beta milestone issue/);
});

test('falls back to all assigned Issues after a saved Board is removed and survives Board API failures', async (t) => {
  const view = await mount({ mode: 'developer', scopeKey: 'team-scope', issueBoardId: 31 }, snapshot());
  t.after(() => view.dom.window.close());
  const document = view.dom.window.document;

  const deleted = snapshot();
  deleted.groupIssueBoards = deleted.groupIssueBoards.filter((board) => board.id !== 31);
  view.sendSnapshot(deleted);
  await view.tick();
  assert.equal(document.querySelector('select[aria-label="Issue Board"]').value, 'all');
  assert.equal(document.querySelectorAll('.work-row').length, 3);
  assert.equal(view.savedState.scopedData['team-scope'].issueBoardId, 'all');

  const failed = snapshot();
  failed.groupIssueBoards = [];
  failed.groupIssueBoardsError = 'Board API unavailable';
  failed.issueBoardContent = undefined;
  view.sendSnapshot(failed);
  await view.tick();
  assert.equal(document.querySelector('select[aria-label="Issue Board"]').disabled, false);
  assert.match(document.querySelector('select[aria-label="Issue Board"] option[value="all"]').textContent, /Board 載入失敗/);
  assert.equal(document.querySelectorAll('.work-row').length, 3);

  const noBoards = snapshot();
  noBoards.groupIssueBoards = [];
  noBoards.issueBoardContent = undefined;
  view.sendSnapshot(noBoards);
  await view.tick();
  assert.equal(document.querySelector('select[aria-label="Issue Board"]').disabled, true);
  assert.equal(document.querySelectorAll('.work-row').length, 3);
});

test('a new Group starts on all assigned Issues and ignores Board content for another scope', async (t) => {
  const view = await mount({ mode: 'developer', scopeKey: 'team-scope', issueBoardId: 31 }, snapshot());
  t.after(() => view.dom.window.close());
  const document = view.dom.window.document;

  const changedScope = snapshot();
  changedScope.connectedScope = 'another-scope';
  view.sendSnapshot(changedScope);
  await view.tick();
  assert.equal(document.querySelectorAll('.work-row').length, 3);
  const selection = view.requests.filter((request) => request.type === 'selectIssueBoard').at(-1);
  assert.equal(selection?.connectedScope, 'team-scope');

  const loaded = snapshot();
  loaded.connectedScope = 'another-scope';
  loaded.issueBoardContent = { boardId: 31, connectedScope: 'another-scope', issueIds: [103], status: 'ready' };
  view.sendSnapshot(loaded);
  await view.tick();
  assert.deepEqual([...document.querySelectorAll('.work-row .row-title')].map((item) => item.textContent), ['Alpha milestone issue', 'Beta milestone issue', 'Beta unassigned issue']);
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
  assert.equal(document.querySelector('.empty-inline strong').textContent, '沒有符合篩選條件的 Issue');

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
  current.instance = { enterprise: true, warnings: [] };
  const sourceSha = 'a'.repeat(40), targetSha = 'b'.repeat(40);
  const request = { id: 41, iid: 4, project_id: 1, source_project_id: 2, target_project_id: 1,
    title: 'Fork change', state: 'opened', source_branch: 'feature', target_branch: 'main',
    web_url: 'https://gitlab.example.test/team/alpha/-/merge_requests/4', diff_refs: { head_sha: sourceSha } };
  current.mergeRequests = [request];
  current.selectedMergeRequest = { request, diffs: [], discussions: [], sections: { diffs: { status: 'idle' }, discussions: { status: 'idle' } }, warnings: [],
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
