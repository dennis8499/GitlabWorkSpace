import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { JSDOM, VirtualConsole } from 'jsdom';

const html = await readFile(new URL('../../resources/issue-webview/dashboard.html', import.meta.url), 'utf8');
const script = await readFile(new URL('../../resources/issue-webview/dashboard.js', import.meta.url), 'utf8');
const dashboardCss = await readFile(new URL('../../src/webview/dashboard.css', import.meta.url), 'utf8');

const gitHead = 'a'.repeat(40), gitParent = 'b'.repeat(40), gitSide = 'c'.repeat(40);
function gitSnapshot(id = 'repo-a', patch = {}) {
  return {
    id, name: id === 'repo-a' ? 'service' : 'tools', path: `C:/workspace/${id}`, branch: 'main', headCommit: gitHead,
    tracking: 'origin/main', ahead: 1, behind: 0, stagedCount: 1, unstagedCount: 1, conflictCount: 0,
    branches: [{ name: 'main', kind: 'local', current: true, commit: gitHead }, { name: 'feature', kind: 'local', current: false, commit: gitSide }, { name: 'origin/main', kind: 'remote', current: false, commit: gitParent }],
    stashes: [], recoveryRefs: [], remotes: ['origin'],
    changes: [{ path: 'service.ts', section: 'unstaged', kind: '已修改' }, { path: 'service.ts', section: 'staged', kind: '已修改' }],
    history: [{ hash: gitHead, parents: [gitParent, gitSide], subject: 'Merge feature', author: 'Dennis', date: '2026-10-08T00:00:00Z' }, { hash: gitSide, parents: [gitParent], subject: 'Add feature', author: 'Tester', date: '2026-10-07T00:00:00Z' }, { hash: gitParent, parents: [], subject: 'Initial commit', author: 'Dennis', date: '2026-10-06T00:00:00Z' }],
    historyHasMore: false, configuredPullStrategy: 'merge', revision: 1, ...patch
  };
}
async function mountGit(t, storage = {}, data = gitSnapshot()) {
  const view = await mount({ mode: 'git', scopeKey: 'team-scope' }, snapshot('git'), storage);
  t.after(() => view.dom.window.close());
  for (let attempt = 0; attempt < 40 && !view.requests.some((request) => request.type === 'gitReady'); attempt++) await view.tick();
  assert.ok(view.requests.some((request) => request.type === 'gitReady'));
  view.send({ type: 'gitRepositories', available: true, revision: 1, repositories: [data, gitSnapshot('repo-b')] });
  for (let attempt = 0; attempt < 40 && !gitActions(view, 'open').length; attempt++) await view.tick();
  const open = view.requests.findLast((request) => request.type === 'gitAction' && request.action.type === 'open');
  assert.ok(open);
  view.send({ type: 'gitSnapshot', requestId: open.requestId, snapshot: data });
  view.send({ type: 'gitActionResult', requestId: open.requestId });
  await view.tick();
  return view;
}
function gitActions(view, type) { return view.requests.filter((request) => request.type === 'gitAction' && (!type || request.action.type === type)); }
async function finishGit(view, request, patch = {}) {
  view.send({ type: 'gitSnapshot', requestId: request.requestId, snapshot: gitSnapshot(request.repoId, patch) });
  view.send({ type: 'gitActionResult', requestId: request.requestId, commitCompleted: patch.commitCompleted });
  await view.tick();
}

test('Git refs read commit details; historical files open central Diff and merge parents remain explicit', async (t) => {
  const view = await mountGit(t);
  const document = view.dom.window.document;
  [...document.querySelectorAll('.git-ref-name')].find((button) => button.textContent.includes('feature')).click();
  await view.tick();
  assert.equal(gitActions(view).at(-1).action.type, 'readCommit');
  assert.equal(gitActions(view, 'checkout').length, 0);
  const selected = gitSnapshot().history[1];
  await finishGit(view, gitActions(view).at(-1), { revision: 2, selectedCommit: selected, selectedCommitParent: gitParent, commitFiles: ['service.ts'] });
  assert.ok(document.querySelector('.git-commit-list'));
  document.querySelector('.git-commit-files button').click();
  await view.tick();
  const diffRequest = gitActions(view, 'readDiff').at(-1);
  assert.equal(diffRequest.action.ref, gitSide);
  await finishGit(view, diffRequest, { revision: 3, selectedCommit: selected, selectedCommitParent: gitParent, commitFiles: ['service.ts'], diffPath: 'service.ts', diffStaged: false, diffRef: gitSide, diffParent: gitParent, diffText: 'diff --git a/service.ts b/service.ts\n+feature' });
  assert.ok(document.querySelector('.git-center .git-diff-view'));
  assert.equal(document.querySelector('.git-commit-list'), null);
  assert.equal(document.querySelectorAll('.git-diff-line input').length, 0, 'historical Diff cannot be staged');
  document.querySelector('.git-back-graph').click(); await view.tick();
  document.querySelector('.git-commit-row:not(.git-wip-row)').click(); await view.tick();
  await finishGit(view, gitActions(view, 'readCommit').at(-1), { revision: 4, selectedCommit: gitSnapshot().history[0], selectedCommitParent: gitParent, commitFiles: ['service.ts'] });
  const parent = document.querySelector('select[aria-label="比較 Parent"]');
  parent.value = gitSide; parent.dispatchEvent(new view.dom.window.Event('change', { bubbles: true }));
  await view.tick();
  assert.equal(gitActions(view, 'readCommit').at(-1).action.parent, gitSide);
  assert.equal(parent.value, gitSide, 'the chosen Parent stays visible while its comparison loads');
  assert.equal(document.querySelectorAll('.git-commit-files button').length, 0, 'stale comparison files cannot be selected');
  await finishGit(view, gitActions(view, 'readCommit').at(-1), { revision: 5, selectedCommit: gitSnapshot().history[0], selectedCommitParent: gitSide, commitFiles: ['README.md'] });
  assert.equal(document.querySelector('.git-commit-files button').title, 'README.md');
  const search = document.querySelector('.git-graph-search input');
  search.value = 'feature'; search.dispatchEvent(new view.dom.window.Event('input', { bubbles: true })); await view.tick();
  assert.equal(document.querySelectorAll('.git-commit-row').length, 4, 'search keeps the full topology');
  assert.equal(document.querySelectorAll('.search-hit').length, 2);
});

test('Git repeated selection shares reads, staged/unstaged paths differ, and stale replies cannot replace the latest selection', async (t) => {
  const view = await mountGit(t);
  const document = view.dom.window.document;
  for (let i = 0; i < 20; i++) document.querySelectorAll('.git-change-name')[0].click();
  await view.tick();
  assert.equal(gitActions(view, 'readDiff').length, 1);
  const first = gitActions(view, 'readDiff').at(-1);
  document.querySelectorAll('.git-change-name')[1].click(); await view.tick();
  const second = gitActions(view, 'readDiff').at(-1);
  assert.equal(second.action.staged, true);
  await finishGit(view, first, { revision: 2, diffPath: 'service.ts', diffStaged: false, diffText: '+obsolete' });
  assert.doesNotMatch(document.querySelector('.git-center').textContent, /obsolete/);
  await finishGit(view, second, { revision: 3, diffPath: 'service.ts', diffStaged: true, diffText: '+current' });
  assert.match(document.querySelector('.git-diff-view').textContent, /current/);
  for (let i = 0; i < 20; i++) document.querySelectorAll('.git-change-name')[1].click();
  await view.tick();
  assert.equal(gitActions(view, 'readDiff').length, 2, 'resolved same selection also uses its result');
  document.querySelector('.git-back-graph').click(); await view.tick();
  const commits = document.querySelectorAll('.git-commit-row:not(.git-wip-row)');
  commits[0].click(); await view.tick();
  const original = gitActions(view, 'readCommit').at(-1);
  commits[1].click(); await view.tick();
  const obsolete = gitActions(view, 'readCommit').at(-1);
  commits[0].click(); await view.tick();
  const current = gitActions(view, 'readCommit').at(-1);
  assert.notEqual(current.requestId, original.requestId, 'returning to a pending selection reclaims the shared read');
  await finishGit(view, original, { revision: 4, selectedCommit: gitSnapshot().history[0], commitFiles: [] });
  await finishGit(view, obsolete, { revision: 5, selectedCommit: gitSnapshot().history[1], commitFiles: [] });
  assert.equal(document.querySelector('.git-detail-subject'), null);
  await finishGit(view, current, { revision: 6, selectedCommit: gitSnapshot().history[0], commitFiles: ['service.ts'] });
  assert.match(document.querySelector('.git-detail-subject').textContent, /Merge feature/);
});

test('Git Repo reopening sends a fresh request after switching away from a pending open', async (t) => {
  const view = await mountGit(t);
  const document = view.dom.window.document;
  const picker = document.querySelector('.git-repo-picker select');
  const select = async (id) => { picker.value = id; picker.dispatchEvent(new view.dom.window.Event('change', { bubbles: true })); await view.tick(); };
  await select('repo-b');
  const cancelled = gitActions(view, 'open').at(-1);
  await select('repo-a'); await select('repo-b');
  const reopened = gitActions(view, 'open').filter((request) => request.repoId === 'repo-b').at(-1);
  assert.notEqual(reopened.requestId, cancelled.requestId, 'a pending open from an earlier panel lifetime must not suppress reopening');
  await finishGit(view, cancelled, { revision: 2, branch: 'obsolete' });
  await finishGit(view, reopened, { revision: 3, branch: 'fresh', branches: [{ name: 'fresh', kind: 'local', current: true, commit: gitHead }] });
  assert.equal(document.querySelector('.git-branch-picker select').value, 'fresh');
  assert.equal(document.querySelector('.git-progress'), null);
});

test('Git drafts migrate and remain per Repo; failed or cancelled commits preserve them and successful commits clear only submitted text', async (t) => {
  const view = await mountGit(t, { 'gitlab-workspace.git-ui.v1': { 'repo-a': { draft: 'Migrated draft', tab: 'changes' } } });
  const document = view.dom.window.document;
  const text = () => document.querySelector('.git-commit-composer textarea');
  assert.equal(text().value, 'Migrated draft');
  const submit = () => document.querySelector('.git-commit-composer').dispatchEvent(new view.dom.window.Event('submit', { bubbles: true, cancelable: true }));
  submit(); submit(); await view.tick();
  assert.equal(gitActions(view, 'commit').length, 1, 'repeated submission cannot enqueue writes');
  const failed = gitActions(view, 'commit').at(-1);
  view.send({ type: 'gitActionResult', requestId: failed.requestId, error: 'Commit failed' }); await view.tick();
  assert.equal(text().value, 'Migrated draft');
  submit(); await view.tick();
  await finishGit(view, gitActions(view, 'commit').at(-1), { revision: 2, headCommit: 'c'.repeat(40), commitCompleted: false });
  assert.equal(text().value, 'Migrated draft', 'cancelled confirmation preserves the draft even if another process changes HEAD');
  const picker = document.querySelector('.git-repo-picker select');
  picker.value = 'repo-b'; picker.dispatchEvent(new view.dom.window.Event('change', { bubbles: true })); await view.tick();
  await finishGit(view, gitActions(view, 'open').at(-1));
  text().value = 'Tools draft'; text().dispatchEvent(new view.dom.window.Event('input', { bubbles: true })); await view.tick();
  picker.value = 'repo-a'; picker.dispatchEvent(new view.dom.window.Event('change', { bubbles: true })); await view.tick();
  await finishGit(view, gitActions(view, 'open').at(-1), { revision: 3 });
  assert.equal(text().value, 'Migrated draft');
  submit(); await view.tick();
  text().value = 'Next draft'; text().dispatchEvent(new view.dom.window.Event('input', { bubbles: true })); await view.tick();
  await finishGit(view, gitActions(view, 'commit').at(-1), { revision: 4, headCommit: 'd'.repeat(40), commitCompleted: true });
  assert.equal(text().value, 'Next draft');
  submit(); await view.tick();
  await finishGit(view, gitActions(view, 'commit').at(-1), { revision: 5, headCommit: 'e'.repeat(40), commitCompleted: true });
  assert.equal(text().value, '');
  const saved = JSON.parse(view.dom.window.localStorage.getItem('gitlab-workspace.git-ui.v2'));
  assert.equal(saved['repo-b'].draft, 'Tools draft');
});

test('Git restores historical file context, paginates with bounded rows, and handles unborn and detached HEAD', async (t) => {
  const restored = { 'repo-a': { selection: 'commit', selectedCommit: gitHead, selectedPath: 'service.ts', view: 'diff', draft: '' } };
  const view = await mountGit(t, { 'gitlab-workspace.git-ui.v2': restored });
  const document = view.dom.window.document;
  assert.equal(gitActions(view, 'readCommit').length, 1);
  await finishGit(view, gitActions(view, 'readCommit').at(-1), { revision: 2, selectedCommit: gitSnapshot().history[0], selectedCommitParent: gitParent, commitFiles: ['service.ts'] });
  assert.equal(gitActions(view, 'readDiff').at(-1).action.ref, gitHead);
  await finishGit(view, gitActions(view, 'readDiff').at(-1), { revision: 3, selectedCommit: gitSnapshot().history[0], selectedCommitParent: gitParent, commitFiles: ['service.ts'], diffPath: 'service.ts', diffRef: gitHead, diffParent: gitParent, diffStaged: false, diffText: '+restored' });
  const renderedDeadline = Date.now() + 1500;
  while (!document.querySelector('.git-diff-view')?.textContent?.includes('restored') && Date.now() < renderedDeadline) await view.tick();
  assert.match(document.querySelector('.git-diff-view').textContent, /restored/);
  document.querySelector('.git-back-graph').click(); await view.tick();
  const many = Array.from({ length: 200 }, (_, i) => ({ hash: i.toString(16).padStart(40, '0'), parents: i < 199 ? [(i + 1).toString(16).padStart(40, '0')] : [], author: 'Tester', date: '2026-10-08T00:00:00Z', subject: `Commit ${i}` }));
  view.send({ type: 'gitSnapshot', snapshot: gitSnapshot('repo-a', { revision: 4, history: many, historyHasMore: true, branch: undefined, headCommit: many[0].hash, branches: [] }) }); await view.tick();
  assert.equal(document.querySelector('.git-branch-picker select').textContent, 'Detached HEAD');
  assert.match(document.querySelector('.git-commit-row:not(.git-wip-row) .git-commit-refs').textContent, /HEAD/);
  assert.ok(document.querySelectorAll('.git-commit-row').length < 40, 'history is virtualized');
  document.querySelector('.git-load-more').click(); await view.tick();
  assert.equal(gitActions(view, 'history').at(-1).action.skip, 200);
  await finishGit(view, gitActions(view, 'history').at(-1), { revision: 5, history: [{ ...many[199], hash: 'f'.repeat(40) }], historyOffset: 200, historyHasMore: false });
  assert.equal(document.querySelector('.git-load-more'), null);
  view.send({ type: 'gitSnapshot', snapshot: gitSnapshot('repo-a', { revision: 6, history: [], branches: [], headCommit: undefined, stagedCount: 0, unstagedCount: 0, changes: [] }) }); await view.tick();
  assert.match(document.querySelector('.git-center .git-empty-list').textContent, /尚無提交歷史/);
  assert.equal(document.querySelectorAll('.git-wip-row').length, 1);
});

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

async function mount(initialState, initialSnapshot, storage = {}, beforeMount = () => {}) {
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
  for (const [key, value] of Object.entries(storage)) dom.window.localStorage.setItem(key, JSON.stringify(value));
  let state = initialState;
  dom.window.acquireVsCodeApi = () => ({
    postMessage: (message) => requests.push(message),
    getState: () => state,
    setState: (value) => { state = JSON.parse(JSON.stringify(value)); }
  });
  beforeMount(dom.window);
  dom.window.eval(script);
  for (let attempt = 0; attempt < 50 && requests.length === 0; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  const tick = async () => {
    await new Promise((resolve) => dom.window.requestAnimationFrame(() => dom.window.requestAnimationFrame(resolve)));
    await new Promise((resolve) => setTimeout(resolve, 0));
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

test('Git defaults to VS Code when layout storage is missing, invalid or unavailable', async (t) => {
  const key = 'gitlab-workspace.git-layout.v1';
  const cases = [
    { name: 'missing layout' },
    { name: 'null layout', storage: { [key]: null } },
    { name: 'invalid theme', storage: { [key]: { theme: 'unknown', left: 230, right: 340 } } },
    { name: 'malformed JSON', setup: (window) => window.localStorage.setItem(key, '{broken') },
    { name: 'unavailable storage', setup: (window) => Object.defineProperty(window, 'localStorage', { get() { throw new Error('Storage unavailable'); } }) },
    { name: 'invalid restored theme', gitUi: { uiByRepo: {}, layout: { theme: 'unknown', left: 230, right: 340 } } },
    { name: 'invalid restored layout', gitUi: { uiByRepo: {}, layout: [] } }
  ];
  for (const item of cases) await t.test(item.name, async (t) => {
    const view = await mount({ mode: 'git', gitUi: item.gitUi }, snapshot('git'), item.storage, item.setup);
    t.after(() => view.dom.window.close());
    const document = view.dom.window.document;
    assert.equal(document.querySelector('.git-workbench').dataset.theme, 'vscode');
    assert.equal(document.querySelector('.git-theme-picker').value, 'vscode');
    await view.tick();
    assert.equal(view.savedState.gitUi.layout.theme, 'vscode');
    if (item.name === 'invalid restored theme') {
      assert.equal(view.savedState.gitUi.layout.left, 230);
      assert.equal(view.savedState.gitUi.layout.right, 340);
    }
  });
});

test('Git preserves saved themes and restores a manual choice after reopening', async (t) => {
  const key = 'gitlab-workspace.git-layout.v1';
  for (const theme of ['dark', 'vscode']) {
    const view = await mount({ mode: 'git' }, snapshot('git'), { [key]: { theme, left: 240, right: 350 } });
    t.after(() => view.dom.window.close());
    const document = view.dom.window.document;
    const picker = document.querySelector('.git-theme-picker');
    assert.equal(picker.value, theme);
    const next = theme === 'dark' ? 'vscode' : 'dark';
    picker.value = next;
    picker.dispatchEvent(new view.dom.window.Event('change', { bubbles: true }));
    await view.tick();
    assert.equal(document.querySelector('.git-workbench').dataset.theme, next);
    assert.equal(JSON.parse(view.dom.window.localStorage.getItem(key)).theme, next);
    const reopened = await mount(view.savedState, snapshot('git'), { [key]: { theme } });
    t.after(() => reopened.dom.window.close());
    assert.equal(reopened.dom.window.document.querySelector('.git-theme-picker').value, next, 'restored view state takes precedence over older local storage');
    assert.equal(reopened.savedState.gitUi.layout.left, 240);
    assert.equal(reopened.savedState.gitUi.layout.right, 350);
  }
});

test('settings opens the local admin screen with or without a GitLab connection', async (t) => {
  for (const connected of [true, false]) {
    const data = { ...snapshot(), connected, ...(connected ? {} : { currentUser: undefined, group: undefined, connectedScope: undefined }) };
    const view = await mount({ mode: 'developer' }, data);
    t.after(() => view.dom.window.close());
    const document = view.dom.window.document;
    document.querySelector('.settings-trigger').click();
    await view.tick();
    const open = [...document.querySelectorAll('.tool-drawer button')].find((button) => button.textContent === '開啟後臺管理');
    assert.ok(open);
    assert.equal(open.disabled, false);
    open.click();
    await view.tick();
    assert.equal(document.querySelector('.tool-drawer'), null);
    assert.equal(document.querySelector('.page-heading h1').textContent, '後臺管理');
    assert.ok(document.querySelector('.admin-log-panel'));
    assert.ok(view.requests.some((request) => request.type === 'setMode' && request.mode === 'admin'));
    assert.ok(view.requests.some((request) => request.type === 'queryLogs'));
    assert.equal(document.activeElement, document.querySelector('.page-heading h1'));
    [...document.querySelectorAll('.log-actions button')].find((button) => button.textContent === '匯出篩選結果').click();
    assert.equal(view.requests.at(-1).type, 'exportLogs');
  }
});

test('partial graphs expose escaped failure details, force both retry paths and clear recovered warnings', async (t) => {
  const root = { id: 'project:1:issue:1', sourceIds: [], kind: 'issue', namespacePath: 'team/alpha', projectPath: 'team/alpha', projectId: 1, iid: '1', title: 'Alpha milestone issue', state: 'opened', labels: [], assignees: [], boardIds: [], assignedToMe: true, isRoot: true, relationsStatus: 'ready' };
  const context = { ...root, id: 'project:2:issue:4', projectId: 2, iid: '4', title: 'Linked context', assignedToMe: false, isRoot: false };
  const graph = { connectedScope: 'team-scope', status: 'partial', roots: [root.id], nodes: [root, context], edges: [{ id: 'relation', source: root.id, target: context.id, type: 'relates_to' }], boardIssueIds: {}, boardStatus: {}, errors: ['Issue #2: <b>Permission denied</b>', 'Delivery: connection failed'], updatedAt: Date.now() };
  const data = { ...snapshot(), issueGraph: graph, issueGraphVersion: 1, sections: { graph: { status: 'ready' } } };
  const view = await mount({ mode: 'developer', scopeKey: 'team-scope', developerView: 'graph' }, data);
  t.after(() => view.dom.window.close());
  const document = view.dom.window.document;
  assert.equal(document.querySelectorAll('.graph-node').length, 2);
  assert.equal(document.querySelectorAll('.graph-edge').length, 1);
  assert.match(document.querySelector('.graph-load-message.warning').textContent, /2 項圖譜資料未能完整載入/);
  const details = document.querySelector('.graph-load-errors');
  details.querySelector('summary').click();
  assert.equal(details.open, true);
  assert.deepEqual([...details.querySelectorAll('li')].map((item) => item.textContent), graph.errors);
  assert.equal(details.querySelector('b'), null, 'GitLab error text is rendered as text');
  document.querySelector('.graph-load-message.warning button').click();
  assert.equal(view.requests.filter((request) => request.type === 'loadIssueGraph').at(-1).forceNetwork, true);
  view.sendSnapshot({ ...data, issueGraphVersion: 2, issueGraph: { ...graph, status: 'loading' } });
  await view.tick();
  assert.equal(document.querySelector('.graph-load-message.warning button').disabled, true);
  view.sendSnapshot({ ...data, issueGraphVersion: 3, sections: { graph: { status: 'error', error: 'Connection failed' } } });
  await view.tick();
  document.querySelector('.section-status.error button').click();
  assert.equal(view.requests.filter((request) => request.type === 'loadIssueGraph').at(-1).forceNetwork, true);
  view.sendSnapshot({ ...data, issueGraphVersion: 4, issueGraph: { ...graph, status: 'ready', errors: [] } });
  await view.tick();
  assert.equal(document.querySelector('.graph-load-message.warning'), null);
  assert.equal(document.querySelector('.graph-load-errors'), null);
  assert.equal(document.querySelectorAll('.graph-node').length, 2);
  assert.equal(document.querySelectorAll('.graph-edge').length, 1);
});

test('account menu supports selecting saved identities, logging in, adding and removing accounts', async (t) => {
  const data = snapshot();
  data.activeAccountId = 'first';
  data.accounts = [
    { id: 'first', baseUrl: data.baseUrl, userId: 7, username: 'first-user', name: 'First', needsLogin: false },
    { id: 'second', baseUrl: data.baseUrl, userId: 8, username: 'second-user', name: 'Second', needsLogin: false },
    { id: 'third', baseUrl: 'https://other.example.test', userId: 7, username: 'third-user', name: 'Third', needsLogin: true }
  ];
  const view = await mount({ mode: 'developer' }, data);
  t.after(() => view.dom.window.close());
  const document = view.dom.window.document;
  const buttons = [...document.querySelectorAll('.saved-account-select')];
  assert.equal(buttons[0].disabled, true);
  assert.match(buttons[1].textContent, /second-user.*gitlab.example.test.*切換帳號/s);
  assert.match(buttons[2].textContent, /other.example.test.*已登出/s);
  buttons[1].click();
  assert.equal(view.requests.at(-1).type, 'switchAccount');
  assert.equal(view.requests.at(-1).accountId, 'second');
  buttons[2].click();
  assert.equal(view.requests.at(-1).type, 'addAccount');
  assert.equal(view.requests.at(-1).accountId, 'third');
  document.querySelector('button[aria-label="移除 Second 帳號"]').click();
  assert.equal(view.requests.at(-1).type, 'removeAccount');
  [...document.querySelectorAll('.account-manager button')].find(button => button.textContent.includes('新增 GitLab 帳號')).click();
  assert.equal(view.requests.at(-1).type, 'addAccount');
  assert.equal(view.requests.at(-1).accountId, undefined);
  [...document.querySelectorAll('.account-manager button')].find(button => button.textContent === '登出目前帳號').click();
  assert.equal(view.requests.at(-1).type, 'disconnect');
});

test('offline Log administration filters and pages results, ignores stale replies, and exports the active query', async (t) => {
  const data = { ...snapshot('admin'), connected: false, baseUrl: undefined, group: undefined };
  const view = await mount({ mode: 'admin' }, data);
  t.after(() => view.dom.window.close());
  const document = view.dom.window.document;
  const first = view.requests.filter(request => request.type === 'queryLogs').at(-1);
  assert.ok(first);
  const search = document.querySelector('input[aria-label="搜尋 Log"]');
  search.value = 'scan'; search.dispatchEvent(new view.dom.window.Event('input', { bubbles: true }));
  await view.tick();
  const filtered = view.requests.filter(request => request.type === 'queryLogs').at(-1);
  assert.equal(filtered.query.search, 'scan');
  const entry = { id: 'entry', timestamp: '2026-10-07T01:00:00.000Z', operationId: 'operation', feature: 'projects', action: 'scanRepositories', result: 'success', level: 'info', durationMs: 42 };
  view.send({ type: 'logsPage', requestId: first.requestId, page: { entries: [{ ...entry, action: 'stale' }], total: 1, page: 0, pageSize: 100 } });
  await view.tick();
  assert.equal(document.querySelector('.log-table').textContent.includes('stale'), false);
  view.send({ type: 'logsPage', requestId: filtered.requestId, page: { entries: [entry], total: 101, page: 0, pageSize: 100 } });
  await view.tick();
  document.querySelector('.log-table .status-link').click();
  await view.tick();
  assert.match(document.querySelector('.log-detail').textContent, /operation/);
  [...document.querySelectorAll('.log-pagination button')].find(button => button.textContent === '下一頁').click();
  await view.tick();
  assert.equal(view.requests.filter(request => request.type === 'queryLogs').at(-1).query.page, 1);
  [...document.querySelectorAll('.log-actions button')].find(button => button.textContent === '匯出篩選結果').click();
  assert.equal(view.requests.at(-1).type, 'exportLogs');
  assert.equal(view.requests.at(-1).query.search, 'scan');
  [...document.querySelectorAll('.log-actions button')].find(button => button.textContent === '清除全部 Log').click();
  assert.equal(view.requests.at(-1).type, 'clearLogs');
  const before = view.requests.filter(request => request.type === 'queryLogs').length;
  document.querySelector('.log-actions input[type="checkbox"]').click();
  await view.tick();
  view.send({ type: 'logsChanged' });
  await view.tick();
  assert.equal(view.requests.filter(request => request.type === 'queryLogs').length, before + 1, 'disabling live refresh makes one query and ignores notifications');
});

test('offline local Repo inventory exposes every copy, scan progress, cancellation and registration errors', async (t) => {
  const data = { ...snapshot('clone'), connected: false, baseUrl: undefined, group: undefined,
    localWorkspaceRepositories: [
      { path: 'C:/workspace/alpha', name: 'alpha', remotes: [], repositoryId: 'registered' },
      { path: 'C:/workspace/other/alpha', name: 'alpha copy', remotes: [], registrationError: 'Git 未啟用' }
    ],
    repositoryScan: { status: 'scanning', checkedDirectories: 12, repositories: [], errors: [{ path: 'C:/private', message: '拒絕存取' }], excludes: ['.git', 'node_modules'] }
  };
  const view = await mount({ mode: 'clone' }, data);
  t.after(() => view.dom.window.close());
  const document = view.dom.window.document;
  assert.equal(document.querySelectorAll('.local-repo-row').length, 2);
  assert.match(document.querySelector('.local-repositories-panel').textContent, /12 個資料夾/);
  assert.match(document.querySelector('.local-repositories-panel').textContent, /Git 未啟用/);
  assert.equal(document.querySelectorAll('.local-repo-row button')[1].disabled, true);
  document.querySelector('.local-repo-row button').click();
  assert.equal(view.requests.at(-1).type, 'gitOpenRepository');
  assert.equal(view.requests.at(-1).path, 'C:/workspace/alpha');
  [...document.querySelectorAll('.local-repositories-panel button')].find(button => button.textContent === '取消掃描').click();
  assert.equal(view.requests.at(-1).type, 'cancelRepositoryScan');
  view.sendSnapshot({ ...data, repositoryScan: { ...data.repositoryScan, status: 'cancelled' } });
  await view.tick();
  [...document.querySelectorAll('.project-tabs button')].find(button => button.textContent === '一鍵掃描 Repo').click();
  assert.equal(view.requests.at(-1).type, 'scanRepositories');
});

test('Issue preview reports loading and retry states while the work list stays visible', async (t) => {
  const data = snapshot();
  const view = await mount({ mode: 'developer' }, data);
  t.after(() => view.dom.window.close());
  const document = view.dom.window.document;
  document.querySelectorAll('.work-row')[0].click();
  document.querySelectorAll('.work-row')[1].click();
  assert.equal(view.requests.filter(request => request.type === 'selectIssue').at(-1).issueIid, 2);
  assert.equal(view.requests.some(request => request.type === 'openIssue'), false);
  const selected = { issue: { ...data.issues[1], description: 'Preview body', assignees: [{ id: 7, name: 'Test User', username: 'test-user' }] }, project: data.projects[1] };
  view.sendSnapshot({ ...data, selectedIssue: selected, issuePreview: { projectId: 2, issueIid: 2, status: 'loading' } });
  await view.tick();
  assert.equal(document.querySelectorAll('.work-row').length, 3);
  assert.match(document.querySelector('.issue-detail').textContent, /Preview body/);
  assert.equal([...document.querySelectorAll('.issue-detail button')].find(button => button.textContent === '開啟 Issue 詳情').disabled, true);
  view.sendSnapshot({ ...data, selectedIssue: selected, issuePreview: { projectId: 2, issueIid: 2, status: 'error', error: '連線失敗' } });
  await view.tick();
  assert.match(document.querySelector('.issue-detail').textContent, /連線失敗/);
  [...document.querySelectorAll('.issue-detail button')].find(button => /重試/.test(button.textContent)).click();
  assert.equal(view.requests.at(-1).type, 'selectIssue');
  assert.equal(view.requests.at(-1).issueIid, 2);
});

test('Issue editing drafts remain separate across account changes and are restored when switching back', async (t) => {
  const first = { ...snapshot(), instanceUserScope: 'account-a' };
  const second = { ...snapshot(), instanceUserScope: 'account-b', connectedScope: 'second-scope', currentUser: { id: 8, username: 'second', name: 'Second' } };
  const view = await mount({ mode: 'developer' }, first);
  t.after(() => view.dom.window.close());
  const document = view.dom.window.document;
  const open = async (data, revision) => {
    view.send({ type: 'issueNavigation', navigation: { mode: 'detail', projectId: 1, issueIid: 1, revision } });
    await view.tick();
    view.send({ type: 'issueResponse', revision, response: { type: 'detailData', data: { ...issueDetailData(data.issues[0], data.projects[0]), canEdit: true } } });
    await view.tick();
  };
  const editor = () => document.querySelector('.issue-embed input[placeholder="簡要描述工作內容"]');
  const waitForDraft = async (scope, title) => {
    const deadline = Date.now() + 1500;
    while (view.savedState.issueEditorDrafts?.[scope]?.issues?.[101]?.title !== title && Date.now() < deadline) await view.tick();
    assert.equal(view.savedState.issueEditorDrafts?.[scope]?.issues?.[101]?.title, title);
  };
  const edit = async title => {
    if (!editor()) [...document.querySelectorAll('.issue-embed button')].find(button => button.textContent === '編輯需求').click();
    await view.tick();
    editor().value = title;
    editor().dispatchEvent(new view.dom.window.Event('input', { bubbles: true }));
    assert.equal(view.savedState.issueEditorDrafts[view.savedState.instanceUserScope].issues[101].title, title, 'the last keystroke is persisted before the next render');
    await view.tick();
  };
  await open(first, 1); await edit('First account draft');
  await waitForDraft('account-a', 'First account draft');
  view.sendSnapshot(second); await view.tick();
  await open(second, 2);
  assert.equal(editor(), null, 'another identity begins without the first account edit draft');
  await edit('Second account draft');
  await waitForDraft('account-b', 'Second account draft');
  view.sendSnapshot(first); await view.tick();
  await open(first, 3);
  assert.equal(editor().value, 'First account draft');
  assert.equal(view.savedState.issueEditorDrafts['account-b'].issues[101].title, 'Second account draft');
  [...document.querySelectorAll('.issue-embed button')].find(button => button.textContent === '儲存變更').click();
  await view.tick();
  view.send({ type: 'issueResponse', revision: 3, response: { type: 'detailData', data: { ...issueDetailData({ ...first.issues[0], title: 'First account draft' }, first.projects[0]), canEdit: true } } });
  await view.tick();
  assert.equal(editor(), null, 'a saved form leaves editing mode');
  await waitForDraft('account-a', undefined);
  assert.equal(view.savedState.issueEditorDrafts['account-a'].issues[101], undefined, 'a successfully submitted draft is removed');
});

test('bounds the dashboard, exposes the maximize icon, and keeps GitLab support details in settings', async (t) => {
  const data = snapshot('developer');
  data.instance = { version: '16.11.10', enterprise: false, warnings: ['Minimum version note'], capabilities: [{ id: 'timelogReport', label: '個別工時紀錄', status: 'supported', source: 'GraphQL' }] };
  const view = await mount({ mode: 'developer' }, data);
  t.after(() => view.dom.window.close());
  const document = view.dom.window.document;
  const shell = document.querySelector('.app-shell');
  const fullDisplayButton = document.querySelector('button[aria-label="放大／還原工作台"]');
  assert.ok(shell);
  assert.ok(fullDisplayButton);
  assert.equal(document.querySelector('.page > .alert[role="status"]'), null, 'instance diagnostics do not take space in the main dashboard');
  assert.match(fullDisplayButton.getAttribute('title'), /放大／還原工作台/);
  fullDisplayButton.click();
  await view.tick();
  assert.ok(view.requests.some((request) => request.type === 'toggleFullDisplay'));
  assert.equal(document.querySelector('.app-shell'), shell, 'the click leaves the mounted workbench and its local view state in place');
  document.querySelector('.settings-trigger').click();
  await view.tick();
  assert.match(document.querySelector('.instance-capabilities').textContent, /GitLab 16\.11\.10.*Minimum version note/s);
  assert.match(document.querySelector('.instance-capabilities').textContent, /個別工時紀錄.*支援.*GraphQL/s);
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
  const data = snapshot();
  const view = await mount({ mode: 'developer', scopeKey: 'team-scope' }, data);
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
  assert.equal(view.requests.filter((request) => request.type === 'selectIssue').at(-1)?.issueIid, 2);
  assert.equal(view.requests.filter((request) => request.type === 'openIssue').length, 0);
  view.sendSnapshot({ ...data, selectedIssue: { issue: data.issues[1], project: data.projects[1] }, issuePreview: { projectId: 2, issueIid: 2, status: 'ready' } });
  await view.tick();
  [...document.querySelectorAll('.issue-detail button')].find(button => button.textContent === '開啟 Issue 詳情').click();
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
  assert.equal(view.savedState.scopedData['team-scope'].reports['1!4'].text, 'Legacy plain text', 'the report draft is saved before the next render');
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


test('Webview reconstruction restores Git drafts and selections and acknowledges a completed write without resending it', async (t) => {
  const view = await mountGit(t);
  const document = view.dom.window.document;
  const textarea = document.querySelector('.git-commit-composer textarea');
  textarea.value = 'Saved commit draft';
  textarea.dispatchEvent(new view.dom.window.Event('input', { bubbles: true }));
  await view.tick();
  document.querySelector('.git-change-name').click(); await view.tick();
  const read = gitActions(view, 'readDiff').at(-1);
  await finishGit(view, read, { revision: 2, diffPath: 'service.ts', diffStaged: false, diffText: '+Large diff content' });
  document.querySelector('.git-commit-composer form')?.dispatchEvent(new view.dom.window.Event('submit', { bubbles: true, cancelable: true }));
  if (!gitActions(view, 'commit').length) document.querySelector('.git-commit-composer').dispatchEvent(new view.dom.window.Event('submit', { bubbles: true, cancelable: true }));
  await view.tick();
  const commit = gitActions(view, 'commit').at(-1); assert.ok(commit);
  const saved = view.savedState;
  assert.equal(saved.gitUi.uiByRepo['repo-a'].draft, 'Saved commit draft');
  assert.equal(saved.gitUi.uiByRepo['repo-a'].selectedPath, 'service.ts');
  assert.equal(saved.gitUi.pendingWrites[0].id, commit.requestId);
  assert.equal(JSON.stringify(saved).includes('diffText'), false, 'VS Code state contains UI state rather than snapshots');
  view.dom.window.close();
  const restored = await mount(saved, snapshot('git'));
  t.after(() => restored.dom.window.close());
  restored.send({ type: 'gitRepositories', available: true, revision: 2, repositories: [gitSnapshot()] });
  await restored.tick();
  const open = gitActions(restored, 'open').at(-1); assert.ok(open);
  assert.equal(open.action.refresh, false);
  restored.send({ type: 'gitSnapshot', requestId: open.requestId, snapshot: gitSnapshot('repo-a', { revision: 3, diffPath: 'service.ts', diffStaged: false, diffText: '+Restored diff' }) });
  restored.send({ type: 'gitActionResult', requestId: open.requestId });
  restored.send({ type: 'gitActionResult', requestId: commit.requestId, commitCompleted: true });
  await restored.tick();
  assert.equal(gitActions(restored, 'commit').length, 0, 'restoring never submits an authorized write again');
  assert.ok(restored.requests.some(request => request.type === 'gitAcknowledgeResult' && request.requestId === commit.requestId));
  assert.equal(restored.dom.window.document.querySelector('.git-commit-composer textarea').value, '');
  assert.equal(restored.savedState.gitUi.pendingWrites.length, 0);
  assert.match(restored.dom.window.document.querySelector('.git-diff-view').textContent, /Restored diff/);
});


test('MR discussion drafts and the selected tab survive Webview reconstruction and remain account scoped', async (t) => {
  const data = snapshot('reviewer');
  const request = { id: 41, iid: 4, project_id: 1, title: 'Review', state: 'opened', source_branch: 'feature', target_branch: 'main', diff_refs: { head_sha: gitHead } };
  data.mergeRequests = [request];
  data.selectedMergeRequest = { request, diffs: [], discussions: [{ id: 'thread-1', notes: [{ id: 1, body: 'Review comment', author: { name: 'Reviewer' } }] }], sections: { diffs: { status: 'ready' }, discussions: { status: 'ready' } }, warnings: [], freshness: { state: 'current', checkedAt: Date.now() }, sourceSha: gitHead, targetSha: gitParent };
  const view = await mount({ mode: 'reviewer', scopeKey: 'team-scope' }, data);
  t.after(() => view.dom.window.close());
  [...view.dom.window.document.querySelectorAll('button')].find(button => button.textContent === '討論').click();
  await view.tick();
  const input = view.dom.window.document.querySelector('input[aria-label="討論回覆"]');
  input.value = 'Unsubmitted discussion reply'; input.dispatchEvent(new view.dom.window.Event('input', { bubbles: true }));
  assert.equal(view.savedState.mrReplyDrafts['instance-user:1:4:thread-1'], input.value, 'the reply is saved before the next render');
  await view.tick();
  const restored = await mount(view.savedState, data); t.after(() => restored.dom.window.close());
  assert.equal(restored.dom.window.document.querySelector('input[aria-label="討論回覆"]').value, input.value);
  assert.equal(restored.dom.window.document.querySelector('[role="tab"][aria-selected="true"]').textContent, '討論');
  assert.equal(restored.requests.some(request => request.type === 'replyMergeRequest'), false);
  restored.sendSnapshot({ ...data, instanceUserScope: 'another-account', connectedScope: 'another-scope' });
  await restored.tick();
  assert.equal(restored.dom.window.document.querySelector('input[aria-label="討論回覆"]').value, '');
});

test('the selected Issue tab survives Webview reconstruction without changing its host navigation', async (t) => {
  const data = snapshot();
  const view = await mount({ mode: 'developer' }, data); t.after(() => view.dom.window.close());
  const navigation = { mode: 'detail', projectId: 1, issueIid: 1, tab: 'content', revision: 7 };
  view.send({ type: 'issueNavigation', navigation }); await view.tick();
  const response = { type: 'detailData', data: issueDetailData(data.issues[0], data.projects[0]) };
  view.send({ type: 'issueResponse', revision: 7, response }); await view.tick();
  const tab = [...view.dom.window.document.querySelectorAll('.issue-embed [role=tab]')].find(button => button.textContent === '工時');
  assert.ok(tab); tab.click();
  assert.equal(view.savedState.issueEditorDrafts['instance-user'].tabs['1:1'].tab, 'time');
  const restored = await mount(view.savedState, data); t.after(() => restored.dom.window.close());
  restored.send({ type: 'issueNavigation', navigation });
  restored.send({ type: 'issueResponse', revision: 7, response });
  await restored.tick();
  const deadline = Date.now() + 1500;
  while (restored.dom.window.document.querySelector('.issue-embed [role=tab][aria-selected=true]')?.textContent !== '工時' && Date.now() < deadline) await restored.tick();
  assert.equal(restored.dom.window.document.querySelector('.issue-embed [role=tab][aria-selected=true]').textContent, '工時');
  assert.equal(restored.savedState.issueNavigation.revision, 7);
});
