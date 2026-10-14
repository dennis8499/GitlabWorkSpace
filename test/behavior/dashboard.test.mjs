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

test('interactive Rebase preserves edited order, actions and messages until its source versions change', async (t) => {
  const view = await mountGit(t);
  const document = view.dom.window.document;
  [...document.querySelectorAll('button')].find(button => button.textContent === 'Rebase…').click(); await view.tick();
  document.querySelector('input[name="interactive"]').checked = true;
  document.querySelector('.git-dialog').dispatchEvent(new view.dom.window.Event('submit', { bubbles: true, cancelable: true })); await view.tick();
  const preview = gitActions(view, 'rebasePreview').at(-1);
  const plan = { target: preview.action.ref, targetHash: 'd'.repeat(40), containsMerge: false, commits: gitSnapshot().history.slice(1).reverse() };
  await finishGit(view, preview, { revision: 2, rebasePlan: plan });
  const titles = () => [...document.querySelectorAll('.git-rebase-commit strong')].map(item => item.textContent);
  document.querySelector('button[aria-label="下移提交"]').click(); await view.tick();
  const operation = document.querySelector('select[aria-label="Rebase 操作"]');
  operation.value = 'reword'; operation.dispatchEvent(new view.dom.window.Event('change', { bubbles: true })); await view.tick();
  const message = document.querySelector('textarea[aria-label="新的提交訊息"]');
  message.value = 'Retain this rewritten message'; message.dispatchEvent(new view.dom.window.Event('input', { bubbles: true })); await view.tick();
  view.send({ type: 'gitSnapshot', snapshot: gitSnapshot('repo-a', { revision: 3, rebasePlan: structuredClone(plan) }) }); await view.tick();
  assert.deepEqual(titles(), ['Add feature', 'Initial commit']);
  assert.deepEqual([...document.querySelectorAll('select[aria-label="Rebase 操作"]')].map(item => item.value), ['reword', 'pick']);
  assert.equal(document.querySelector('textarea[aria-label="新的提交訊息"]').value, 'Retain this rewritten message');
  assert.doesNotMatch(document.querySelector('.git-dialog').textContent, /來源版本已變更/);
  view.send({ type: 'gitSnapshot', snapshot: gitSnapshot('repo-a', { revision: 4, rebasePlan: { ...plan, targetHash: 'e'.repeat(40) } }) }); await view.tick();
  assert.deepEqual(titles(), ['Initial commit', 'Add feature']);
  assert.deepEqual([...document.querySelectorAll('select[aria-label="Rebase 操作"]')].map(item => item.value), ['pick', 'pick']);
  assert.equal(document.querySelector('textarea[aria-label="新的提交訊息"]'), null);
  assert.match(document.querySelector('.git-dialog [role="status"]').textContent, /來源版本已變更.*重設/);
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
    cloneRoot: 'C:/workspace/team',
    projectLocalRepositories: {},
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
    workflowKitInstallTarget: { root: 'C:/workspace/team', manual: false, state: { status: 'installed', version: '0.9.0', source: 'bundled' } },
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
  assert.match(buttons[1].textContent, /second-user.*gitlab.example.test.*已保存/s);
  assert.match(buttons[2].textContent, /other.example.test.*需重新登入/s);
  buttons[1].click();
  assert.equal(view.requests.at(-1).type, 'switchAccount');
  assert.equal(view.requests.at(-1).accountId, 'second');
  buttons[2].click();
  assert.equal(view.requests.at(-1).type, 'addAccount');
  assert.equal(view.requests.at(-1).accountId, 'third');
  [...document.querySelectorAll('.account-manager button')].find(button => button.textContent.includes('新增 GitLab 帳號')).click();
  assert.equal(view.requests.at(-1).type, 'addAccount');
  assert.equal(view.requests.at(-1).accountId, undefined);
  [...document.querySelectorAll('.account-manager button')].find(button => button.textContent === '管理帳號與連線').click();
  assert.equal(view.requests.at(-1).type, 'openAccountManager');
  view.send({ type: 'openAccountManager', intent: { id: 'manage', startLogin: false } }); await view.tick();
  assert.equal(document.querySelectorAll('.account-card').length, 3);
  document.querySelector('button[aria-label="移除 Second 帳號"]').click();
  assert.equal(view.requests.at(-1).type, 'removeAccount');
  document.querySelector('button[aria-label="登出 First 帳號"]').click();
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
  assert.equal(document.querySelector('.page-heading h1').textContent, 'Skills 功能指引');
  assert.equal(document.querySelectorAll('.wiki-guide-card').length, 1);
  assert.equal(document.querySelector('.wiki-guide-card h2').id, 'wiki-card-title-development-spec');
  assert.equal(document.querySelector('.wiki-guide-intro'), null);
  assert.deepEqual([...document.querySelectorAll('.wiki-guide-selector option')].map(option => option.value), [
    'development-spec', 'megin-spec-export', 'ingest', 'query', 'functional-exploration', 'lint', 'audit', 'adr',
    'synthesis', 'business-analysis', 'system-analysis', 'system-design', 'notebooklm-export', 'archaeology'
  ]);

  const selector = document.querySelector('.wiki-guide-selector select');
  assert.equal(selector.value, 'development-spec');
  const devPreview = document.querySelector('.wiki-prompt-preview');
  assert.ok(devPreview.textContent.includes('renamed-alpha → C:/workspace/team/renamed-alpha'));
  assert.ok(devPreview.textContent.includes('unmapped-tools → C:/workspace/team/unmapped-tools'));
  assert.equal(devPreview.textContent.includes('team/alpha'), false);

  selector.value = 'megin-spec-export';
  selector.dispatchEvent(new view.dom.window.Event('change', { bubbles: true })); await view.tick();
  assert.equal(document.querySelector('.wiki-copy-button').disabled, true);
  const spec = document.querySelector('[id="wiki-input-megin-spec-export.spec"]');
  spec.value = 'wiki/synthesis/refund-development-spec.md';
  spec.dispatchEvent(new view.dom.window.Event('input', { bubbles: true }));
  const exportScope = document.querySelector('[id="wiki-input-megin-spec-export.scope"]');
  exportScope.value = 'refund'; exportScope.dispatchEvent(new view.dom.window.Event('input', { bubbles: true })); await view.tick();
  assert.equal(document.querySelector('.wiki-copy-button').disabled, false);
  document.querySelector('.wiki-copy-button').click(); await view.tick();
  assert.match(view.requests.at(-1).text, /megin-spec-export.*refund-development-spec\.md/s);
  assert.match(view.requests.at(-1).text, /exports\/megin\/<scope>-r<spec_revision>\.md/);

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

  selector.value = 'functional-exploration';
  selector.dispatchEvent(new view.dom.window.Event('change', { bubbles: true }));
  await view.tick();
  assert.equal(document.querySelector('.wiki-guide-card h2').id, 'wiki-card-title-functional-exploration');
  assert.equal(document.querySelector('.wiki-copy-button').disabled, false);
  document.querySelector('.wiki-copy-button').click();
  await view.tick();
  assert.match(view.requests.at(-1).text, /functional_exploration.*先從目前原始碼/s);
  assert.match(view.requests.at(-1).text, /不執行目標程式或測試/);
  assert.match(view.requests.at(-1).text, /不保存文件/);

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

  document.querySelector('.skills-install-button').click();
  await view.tick();
  assert.ok(document.querySelector('[role="dialog"]'));
});

test('offline installation uses its own folder and exposes selection, reset, and busy states', async (t) => {
  const state = snapshot('sa');
  state.workflowKitPolicy = { requireGroupEnvironment: false, allowed: true, settingTarget: 'workspace' };
  state.connected = false; state.group = undefined; state.groupRoot = undefined;
  state.groupRepositoryScanStatus = 'idle'; state.workflowKit = { status: 'missing' };
  state.workflowKitInstallTarget = { root: 'C:/local/單一 Repo', manual: true, state: { status: 'missing' } };
  const view = await mount({ mode: 'sa' }, state);
  t.after(() => view.dom.window.close());
  const document = view.dom.window.document;
  document.querySelector('.skills-install-button').click(); await view.tick();
  const button = (text) => [...document.querySelectorAll('[role="dialog"] button')].find(item => item.textContent === text);
  assert.match(document.querySelector('.workflow-kit-install-root').textContent, /C:\/local\/單一 Repo/);
  assert.equal(document.querySelector('.workflow-kit-install-button').disabled, false);
  document.querySelector('.workflow-kit-install-button').click();
  button('選擇資料夾').click(); button('恢復預設位置').click();
  assert.ok(view.requests.some(request => request.type === 'installWorkflowKit' && request.packageId === 'bundled-0.9.0'));
  assert.ok(view.requests.some(request => request.type === 'selectWorkflowKitInstallRoot'));
  assert.ok(view.requests.some(request => request.type === 'resetWorkflowKitInstallRoot'));
  for (const status of ['checking', 'installing', 'work-in-progress', 'needs-cleanup']) {
    state.workflowKitInstallTarget.state = { status };
    view.sendSnapshot(state); await view.tick();
    assert.equal(document.querySelector('.workflow-kit-install-button').disabled, true, status);
    if (status === 'installing') {
      assert.equal(button('選擇資料夾').disabled, true);
      assert.equal(button('恢復預設位置').disabled, true);
    }
  }
  state.workflowKitInstallTarget = { root: 'C:/missing', error: '安裝位置不存在，請重新選擇資料夾。', manual: true, state: { status: 'error' } };
  view.sendSnapshot(state); await view.tick();
  assert.equal(document.querySelector('.workflow-kit-install-button').disabled, true);
  assert.match(document.querySelector('.tool-card').textContent, /安裝位置不存在/);
  state.workflowKitInstallTarget = { manual: false, error: '請選擇技能包安裝資料夾。', state: { status: 'missing' } };
  view.sendSnapshot(state); await view.tick();
  assert.equal(button('選擇資料夾').disabled, false);
  assert.equal(button('恢復預設位置').disabled, true);
  assert.equal(document.querySelector('.workflow-kit-install-button').disabled, true);
});

test('Skills auto mode falls back offline and keeps downloads independent of Group matching', async t => {
  const state = snapshot('sa');
  Object.assign(state, { connected: false, currentUser: undefined, group: undefined, groupRoot: undefined, workflowKitSource: 'github',
    workflowKitInstallTarget: { root: 'C:/local/repo', profile: 'repository', manual: true, state: { status: 'missing' } },
    workflowKitPackages: [{ ...state.workflowKitPackages[0], source: 'github' }],
    workflowKitPolicy: { requireGroupEnvironment: true, allowed: true, mode: 'repository', settingTarget: 'workspace' } });
  setSkillsContext(state, 'repository', { status: 'unverified', reason: '尚未登入 GitLab；使用原生單 Repo 流程。' });
  const view = await mount({ mode: 'sa' }, state); t.after(() => view.dom.window.close());
  const document = view.dom.window.document;
  document.querySelector('.settings-trigger').click(); await view.tick();
  const button = text => [...document.querySelectorAll('.tool-drawer button')].find(item => item.textContent === text);
  const toggle = document.querySelector('[role="switch"]');
  assert.equal(toggle.checked, true);
  assert.match(document.querySelector('.skills-policy').textContent, /符合 Group 時使用 Group 流程/);
  assert.match(document.querySelector('[aria-label="Group 對應狀態"]').textContent, /尚未驗證.*尚未登入/s);
  for (const item of [button('開啟 GitHub Release'), button('匯入組合包 ZIP'), document.querySelector('.workflow-kit-install-button')]) assert.equal(item.disabled, false);
  toggle.checked = false; toggle.dispatchEvent(new view.dom.window.Event('change', { bubbles: true }));
  assert.deepEqual(structuredClone(view.requests.at(-1)), { type: 'setWorkflowKitRequireGroup', enabled: false });
  state.workflowKitPolicy = { requireGroupEnvironment: false, allowed: true, mode: 'repository', settingTarget: 'user' };
  view.sendSnapshot(state); await view.tick();
  assert.equal(toggle.checked, false);
  assert.match(document.querySelector('.skills-policy').textContent, /使用者.*固定使用原生單 Repo/s);
  button('開啟 GitHub Release').click(); assert.equal(view.requests.at(-1).type, 'openWorkflowKitDownload');
  state.workflowKitPolicy = { requireGroupEnvironment: true, allowed: true, mode: 'group', settingTarget: 'workspace' };
  state.groupRoot = 'C:/group'; state.workflowKitInstallTarget = { root: state.groupRoot, profile: 'group', manual: false, state: { status: 'missing' } };
  setSkillsContext(state, 'group');
  view.sendSnapshot(state); await view.tick();
  assert.equal(document.querySelector('.workflow-kit-install-button').disabled, false);
  assert.equal(button('選擇資料夾').disabled, false);
  assert.match(document.querySelector('[aria-label="Group 對應狀態"]').textContent, /已對應/);
  state.workflowKitOperationBusy = true;
  view.sendSnapshot(state); await view.tick();
  assert.equal(toggle.disabled, true); assert.equal(button('匯入組合包 ZIP').disabled, true);
});

test('guided login keeps secrets transient, matches results by request ID, and allows retry after an invalid Token', async t => {
  const state = { ...snapshot(), connected: false, currentUser: undefined, baseUrl: undefined, group: undefined, groupRoot: undefined, accounts: [] };
  const view = await mount({}, state); t.after(() => view.dom.window.close());
  const document = view.dom.window.document;
  view.send({ type: 'openAccountManager', intent: { id: 'new', startLogin: true } });
  await view.tick(); await view.tick();
  const url = document.querySelector('input[name="baseUrl"]');
  assert.ok(url); assert.equal(document.activeElement, url);
  url.value = 'https://gitlab.example.test/gitlab/'; url.dispatchEvent(new view.dom.window.Event('input', { bubbles: true })); await view.tick();
  document.querySelector('.account-login button[type="submit"]').click(); await view.tick();
  const token = document.querySelector('input[name="token"]');
  assert.equal(token.type, 'password'); assert.match(document.querySelector('#token-help').textContent, /api.*SecretStorage/s);
  token.value = 'transient-token-one'; token.dispatchEvent(new view.dom.window.Event('input', { bubbles: true })); await view.tick();
  document.querySelector('.token-input button').click(); await view.tick(); assert.equal(token.type, 'text');
  document.querySelector('.account-login button[type="submit"]').click(); await view.tick();
  const first = view.requests.findLast(item => item.type === 'submitAccountLogin');
  assert.equal(first.baseUrl, 'https://gitlab.example.test/gitlab'); assert.equal(first.token, 'transient-token-one');
  assert.equal(token.value, ''); assert.equal(token.type, 'password');
  assert.equal(document.querySelector('.account-login button[type="submit"]').disabled, true);
  assert.ok(!JSON.stringify(view.savedState).includes('transient-token-one'));
  view.send({ type: 'accountLoginResult', requestId: 'stale', error: 'An obsolete error' }); await view.tick();
  assert.equal(document.querySelector('.account-login-error'), null);
  view.send({ type: 'accountLoginResult', requestId: first.requestId, error: 'Token 無效，請重試。' }); await view.tick();
  assert.match(document.querySelector('.account-login-error').textContent, /請重試/);
  token.value = 'transient-token-two'; token.dispatchEvent(new view.dom.window.Event('input', { bubbles: true })); await view.tick();
  document.querySelector('.account-login button[type="submit"]').click(); await view.tick();
  const second = view.requests.findLast(item => item.type === 'submitAccountLogin'); assert.notEqual(second.requestId, first.requestId);
  view.sendSnapshot({ ...state, connected: true, currentUser: { id: 1, name: 'Verified User', username: 'verified' } });
  view.send({ type: 'accountLoginResult', requestId: second.requestId, name: 'Verified User' }); await view.tick();
  assert.match(document.querySelector('.account-login-success').textContent, /已登入 Verified User/);
  assert.match(document.querySelector('.account-workspace').textContent, /尚未選擇/);
  assert.equal(document.querySelector('.account-login'), null);
  assert.ok(!JSON.stringify(view.savedState).includes('transient-token'));
  [...document.querySelectorAll('.account-workspace button')].find(item => item.textContent === '選擇 Group').click();
  assert.equal(view.requests.at(-1).type, 'selectGroup');
});

test('account settings support keyboard navigation, locked relogin sites, and clearing unsent Tokens on close', async t => {
  const state = snapshot();
  state.accounts = [{ id: 'saved', name: 'Saved User', username: 'saved', baseUrl: 'https://saved.test', userId: 1, needsLogin: true }];
  const view = await mount({}, state); t.after(() => view.dom.window.close());
  const document = view.dom.window.document;
  const trigger = document.querySelector('.settings-trigger'); trigger.click(); await view.tick();
  const tab = document.querySelector('#settings-tab-tools'); tab.focus();
  tab.dispatchEvent(new view.dom.window.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })); await view.tick();
  assert.equal(document.querySelector('#settings-tab-accounts').getAttribute('aria-selected'), 'true');
  assert.equal(document.activeElement.id, 'settings-tab-accounts');
  document.querySelector('button[aria-label="重新登入 Saved User 帳號"]').click(); await view.tick();
  const url = document.querySelector('[name="baseUrl"]'); assert.equal(url.readOnly, true); assert.equal(url.value, 'https://saved.test');
  document.querySelector('.account-login button[type="submit"]').click(); await view.tick();
  const token = document.querySelector('[name="token"]'); token.value = 'never-persist-this'; token.dispatchEvent(new view.dom.window.Event('input', { bubbles: true })); await view.tick();
  document.dispatchEvent(new view.dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); await view.tick();
  assert.equal(document.querySelector('.tool-drawer'), null); assert.equal(document.activeElement, trigger);
  trigger.click(); await view.tick(); document.querySelector('#settings-tab-accounts').click(); await view.tick();
  assert.equal(document.querySelector('[name="token"]'), null);
  assert.ok(!JSON.stringify(view.savedState).includes('never-persist-this'));
});

test('an installed custom folder does not enable the Group guide when the Group kit is missing', async (t) => {
  const state = snapshot('sa'); state.workflowKit = { status: 'missing' };
  state.workflowKitPolicy = { requireGroupEnvironment: false, allowed: true, settingTarget: 'workspace' };
  state.workflowKitInstallTarget = { root: 'C:/another/repo', manual: true, state: { status: 'installed', version: '0.9.0' } };
  const view = await mount({ mode: 'sa' }, state);
  t.after(() => view.dom.window.close());
  const document = view.dom.window.document;
  const scope = document.querySelector('[id="wiki-input-development-spec.scope"]');
  scope.value = 'Retry behavior'; scope.dispatchEvent(new view.dom.window.Event('input', { bubbles: true }));
  const requirement = document.querySelector('[id="wiki-input-development-spec.requirement"]');
  requirement.value = 'Describe retry behavior'; requirement.dispatchEvent(new view.dom.window.Event('input', { bubbles: true }));
  await view.tick();
  assert.equal(document.querySelector('.wiki-copy-button').disabled, true);
  document.querySelector('.skills-install-button').click(); await view.tick();
  assert.match(document.querySelector('.workflow-kit-install-root').textContent, /C:\/another\/repo/);
  assert.equal(document.querySelector('.workflow-kit-install-button').textContent, '安裝／更新整包');
  state.workflowKit = { status: 'installed', version: '0.9.0' };
  view.sendSnapshot(state); await view.tick();
  assert.equal(document.querySelector('.wiki-copy-button').disabled, false);
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
test('four Skills tools preserve legacy Wiki drafts and isolate release inputs across Groups and reopening', async (t) => {
  const view = await mount({ mode: 'sa', scopeKey: 'team-scope',
    wikiGuideInputsByScope: { 'team-scope': { 'query.question': '保留的 Wiki 問題' } },
    wikiGuideSelectionsByScope: { 'team-scope': 'query' } }, snapshot('sa'));
  t.after(() => view.dom.window.close());
  const document = view.dom.window.document;
  const change = async (selector, value, event = 'change') => {
    const input = document.querySelector(selector);
    input.value = value;
    input.dispatchEvent(new view.dom.window.Event(event, { bubbles: true }));
    await view.tick();
  };
  assert.equal(document.querySelectorAll('.skills-tool-selector option').length, 4);
  assert.equal(document.querySelector('[id="wiki-input-query.question"]').value, '保留的 Wiki 問題');
  await change('.skills-tool-selector select', 'release-reviewer');
  assert.equal(document.querySelector('.wiki-guide-selector select').value, 'release-review');
  assert.equal(document.querySelector('.wiki-copy-button').disabled, true);
  await change('[id="wiki-input-release-review.repo"]', 'C:/工作區 with spaces/service', 'input');
  await change('[id="wiki-input-release-review.base"]', 'origin/main', 'input');
  assert.equal(document.querySelector('.wiki-copy-button').disabled, true);
  await change('[id="wiki-input-release-review.head"]', 'HEAD', 'input');
  assert.equal(document.querySelector('.wiki-copy-button').disabled, true);
  await change('[id="wiki-input-release-review.head"]', 'feature/payment', 'input');
  assert.equal(document.querySelector('.wiki-copy-button').disabled, false);
  assert.equal(document.querySelector('[id="wiki-input-release-review.mode"]'), null);
  assert.equal(document.querySelector('[id="wiki-input-release-review.output"]'), null);
  assert.equal(document.querySelector('.wiki-prompt-preview').textContent.includes('--include-json'), false);
  document.querySelector('.wiki-copy-button').click();
  await view.tick();
  const copy = view.requests.at(-1);
  assert.equal(copy.type, 'copy');
  assert.match(copy.text, /\$release-reviewer/);
  assert.match(copy.text, /C:\/工作區 with spaces\/service/);
  assert.match(copy.text, /固定合併前審查/);
  assert.equal(copy.text.includes('--include-json'), false);
  assert.match(copy.text, /Checklist/);
  assert.match(copy.text, /實際 Group 工作區/);
  assert.match(copy.text, /本機實際 Git Repo/);

  await change('.skills-tool-selector select', 'codebase-wiki');
  assert.equal(document.querySelector('[id="wiki-input-query.question"]').value, '保留的 Wiki 問題');
  await change('.skills-tool-selector select', 'merge-reviewer');
  await change('.wiki-guide-selector select', 'merge-group');
  assert.match(document.querySelector('.wiki-prompt-preview').textContent, /--group-root.*--quick/);
  await change('.skills-tool-selector select', 'release-reviewer');

  const groupB = snapshot('sa');
  groupB.connectedScope = 'another-group-scope';
  groupB.groupRoot = 'C:/workspace/another-team';
  groupB.group = { ...groupB.group, id: 9, full_path: 'another-team' };
  view.sendSnapshot(groupB);
  await view.tick();
  assert.equal(document.querySelector('.skills-tool-selector select').value, 'codebase-wiki');
  await change('.skills-tool-selector select', 'release-reviewer');
  assert.equal(document.querySelector('[id="wiki-input-release-review.repo"]').value, '');
  assert.equal(document.querySelector('[id="wiki-input-release-review.mode"]'), null);
  await change('[id="wiki-input-release-review.repo"]', 'other-service', 'input');

  view.sendSnapshot(snapshot('sa'));
  await view.tick();
  assert.equal(document.querySelector('.skills-tool-selector select').value, 'release-reviewer');
  assert.equal(document.querySelector('[id="wiki-input-release-review.repo"]').value, 'C:/工作區 with spaces/service');
  assert.equal(document.querySelector('[id="wiki-input-release-review.mode"]'), null);
  assert.equal(view.savedState.skillsGuideByScope['another-group-scope'].inputs['release-review.repo'], 'other-service');
  const reopened = await mount(view.savedState, snapshot('sa'));
  t.after(() => reopened.dom.window.close());
  assert.equal(reopened.dom.window.document.querySelector('.skills-tool-selector select').value, 'release-reviewer');
  assert.equal(reopened.dom.window.document.querySelector('[id="wiki-input-release-review.head"]').value, 'feature/payment');
  assert.equal(reopened.dom.window.document.querySelector('[id="wiki-input-release-review.output"]'), null);
  reopened.dom.window.document.querySelector('.skills-install-button').click();
  await reopened.tick();
  assert.ok(reopened.dom.window.document.querySelector('[role="dialog"]'));
});

test('release guide retains multiple field inputs dispatched before the next repaint', async (t) => {
  const view = await mount({ mode: 'sa' }, snapshot('sa'));
  t.after(() => view.dom.window.close());
  const document = view.dom.window.document;
  const tool = document.querySelector('.skills-tool-selector select');
  tool.value = 'release-reviewer';
  tool.dispatchEvent(new view.dom.window.Event('change', { bubbles: true }));
  await view.tick();
  for (const [key, value] of Object.entries({ repo: 'service', base: 'origin/main', head: 'feature/payment' })) {
    const input = document.querySelector(`[id="wiki-input-release-review.${key}"]`);
    input.value = value;
    input.dispatchEvent(new view.dom.window.Event('input', { bubbles: true }));
  }
  await view.tick();
  assert.equal(document.querySelector('[id="wiki-input-release-review.repo"]').value, 'service');
  assert.equal(document.querySelector('[id="wiki-input-release-review.base"]').value, 'origin/main');
  assert.equal(document.querySelector('[id="wiki-input-release-review.head"]').value, 'feature/payment');
  assert.equal(document.querySelector('.wiki-copy-button').disabled, false);
});

test('Megin and MR guide buttons use existing workbench navigation', async (t) => {
  const view = await mount({ mode: 'sa' }, snapshot('sa'));
  t.after(() => view.dom.window.close());
  const document = view.dom.window.document;
  const choose = async (selector, value) => {
    const input = document.querySelector(selector);
    input.value = value;
    input.dispatchEvent(new view.dom.window.Event('change', { bubbles: true }));
    await view.tick();
  };
  await choose('.skills-tool-selector select', 'megin');
  assert.equal(document.querySelector('.wiki-copy-button'), null);
  document.querySelector('.skills-navigate-button').click();
  await view.tick();
  assert.ok(view.requests.some(request => request.type === 'setMode' && request.mode === 'developer'));
  view.sendSnapshot(snapshot('sa'));
  await view.tick();
  await choose('.skills-tool-selector select', 'merge-reviewer');
  await choose('.wiki-guide-selector select', 'merge-mr');
  document.querySelector('.skills-navigate-button').click();
  await view.tick();
  assert.ok(view.requests.some(request => request.type === 'setMode' && request.mode === 'reviewer'));
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
test('offers folder selection for unresolved project locations without reusing the Skills Group root', async (t) => {
  const state = snapshot('clone');
  state.cloneRoot = undefined;
  state.cloneRootError = '請選擇專案下載／更新資料夾';
  const view = await mount({ mode: 'clone' }, state);
  t.after(() => view.dom.window.close());
  const document = view.dom.window.document;
  assert.equal(document.querySelector('.clone-submit').disabled, true);
  assert.match(document.querySelector('.clone-root-line').textContent, /請選擇專案下載／更新資料夾/);
  document.querySelector('.clone-select-root').click();
  assert.equal(view.requests.at(-1).type, 'selectCloneRoot');
  assert.equal([...document.querySelectorAll('.more-actions-panel button')].find(button => button.textContent === '更新本機預設分支').disabled, true);
});

test('mixed workspaces keep clone and more project actions enabled with their own root and repository states', async t => {
  const state = snapshot('clone');
  state.groupRoot = undefined; state.workspaceRootError = '所有 Repo 都須對應所選 GitLab Group。';
  state.cloneRoot = 'C:/mixed'; state.cloneRootManual = true;
  state.projectLocalRepositories = { 1: { path: 'C:/mixed/alpha', state: 'ready' } };
  state.localRepositories = { 1: { path: 'C:/skills/alpha', state: 'ready' } };
  const view = await mount({ mode: 'clone', scopeKey: 'team-scope', selectedProjectIds: [1] }, state);
  t.after(() => view.dom.window.close()); const document = view.dom.window.document;
  assert.equal(document.querySelector('.clone-submit').disabled, false);
  assert.match(document.querySelector('.clone-root-line').textContent, /C:\/mixed.*手動指定/);
  assert.match(document.querySelector('.repo-row').textContent, /C:\/mixed\/alpha/);
  assert.equal(document.querySelector('.repo-row').textContent.includes('C:/skills'), false);
  document.querySelector('.clone-submit').click(); assert.equal(view.requests.at(-1).type, 'clone');
  const sync = [...document.querySelectorAll('.more-actions-panel button')].find(button => button.textContent === '更新本機預設分支');
  assert.equal(sync.disabled, false); sync.click(); assert.equal(view.requests.at(-1).type, 'syncRepos');
  document.querySelector('.clone-open-workspace').click(); assert.equal(view.requests.at(-1).type, 'openLocalWorkspace');
  document.querySelector('.clone-reset-root').click(); assert.equal(view.requests.at(-1).type, 'resetCloneRoot');
  view.sendSnapshot({ ...state, busy: true }); await view.tick();
  assert.equal(document.querySelector('.clone-select-root').disabled, true); assert.equal(document.querySelector('.clone-reset-root').disabled, true);
});

test('installation and current Skills locations show independent profiles and statuses', async t => {
  const state = snapshot('sa'); setSkillsContext(state, 'group');
  state.workflowKitPolicy = { requireGroupEnvironment: true, allowed: true, mode: 'group', settingTarget: 'workspace' };
  state.workflowKitInstallTarget = { root: 'D:/external', profile: 'repository', manual: true, state: { status: 'missing' } };
  const view = await mount({ mode: 'sa' }, state); t.after(() => view.dom.window.close());
  const document = view.dom.window.document; document.querySelector('.settings-trigger').click(); await view.tick();
  assert.match(document.querySelector('.workflow-kit-install-root').textContent, /D:\/external/);
  assert.match(document.querySelector('.workflow-kit-skills-root').textContent, /C:\/workspace\/team.*Group/);
  assert.match(document.querySelector('.tool-card').textContent, /安裝版型：原生單 Repo/);
  const select = [...document.querySelectorAll('.tool-drawer button')].find(button => button.textContent === '選擇資料夾');
  assert.equal(select.disabled, false); select.click(); assert.equal(view.requests.at(-1).type, 'selectWorkflowKitInstallRoot');
  assert.equal(document.querySelector('.workflow-kit-install-button').disabled, false);
});

test('AutoHook checkbox enables/disables once, uses the Skills revision and keeps backend state', async t => {
  const state = snapshot('sa'); setSkillsContext(state, 'group');
  state.workflowKitInstallTarget = { root: 'D:/external', profile: 'repository', manual: true, state: { status: 'missing' } };
  state.autoHook = { root: state.skillsContext.root, supported: true, enabled: false, status: 'disabled', stateKnown: true, bundledVersion: '1.1.0', trustRequired: true };
  const view = await mount({ mode: 'sa' }, state); t.after(() => view.dom.window.close());
  const document = view.dom.window.document; document.querySelector('.settings-trigger').click(); await view.tick();
  const card = document.querySelector('.autohook-card');
  const checkbox = card.querySelector('input[type="checkbox"]');
  const button = text => [...card.querySelectorAll('button')].find(item => item.textContent === text);
  assert.match(card.textContent, /1\.1\.0.*C:\/workspace\/team/s); assert.doesNotMatch(card.textContent, /D:\/external/);
  assert.equal(checkbox.checked, false); assert.equal(checkbox.disabled, false);
  checkbox.click(); checkbox.click();
  assert.equal(checkbox.checked, false, 'wait for actual installation rather than optimistic state');
  assert.equal(view.requests.filter(item => item.type === 'manageAutoHook').length, 1);
  assert.deepEqual(structuredClone(view.requests.at(-1)), { type: 'manageAutoHook', operation: 'enable', contextRevision: state.skillsContext.revision, reviewer: { model: 'gpt-6-luna', reasoningEffort: 'low', timeoutSeconds: 30 } });
  view.sendSnapshot({ ...state, workflowKitOperationBusy: true }); await view.tick();
  assert.ok([...card.querySelectorAll('button, input')].every(item => item.disabled));
  const active = structuredClone(state); active.autoHook = { ...state.autoHook, enabled: true, status: 'enabled', runtimeVersion: '1.1.0' };
  view.sendSnapshot(active); await view.tick();
  assert.equal(checkbox.checked, true); assert.equal(checkbox.disabled, false);
  assert.match(card.textContent, /本機執行版本：1\.1\.0/);
  assert.match(card.textContent, /不包含 Codex 的信任狀態.*重新開啟 Codex.*\/hooks/s);
  button('重新驗證').click(); assert.equal(view.requests.at(-1).operation, 'revalidate');
  view.sendSnapshot(structuredClone(active)); await view.tick();
  checkbox.click(); assert.equal(view.requests.at(-1).operation, 'disable');
  assert.equal(checkbox.checked, true);
  view.sendSnapshot(state); await view.tick(); assert.equal(checkbox.checked, false);
  button('刷新狀態').click(); assert.equal(view.requests.at(-1).type, 'refreshAutoHook');
});

test('AutoHook remains optional on non-Windows and a changed Skills root uses the new revision', async t => {
  const state = snapshot('sa'); setSkillsContext(state, 'repository');
  state.autoHook = { root: state.skillsContext.root, supported: false, enabled: false, status: 'disabled', bundledVersion: '1.1.0' };
  const view = await mount({ mode: 'sa' }, state); t.after(() => view.dom.window.close());
  const document = view.dom.window.document; document.querySelector('.settings-trigger').click(); await view.tick();
  const card = document.querySelector('.autohook-card');
  assert.match(card.textContent, /Windows.*PowerShell/); assert.equal(card.querySelector('input').disabled, true);
  assert.equal(document.querySelector('.workflow-kit-install-button').disabled, false);
  const next = structuredClone(state); next.workflowKitInstallTarget.root = 'C:/local/other'; setSkillsContext(next);
  next.autoHook = { ...state.autoHook, root: next.skillsContext.root, supported: true };
  view.sendSnapshot(next); await view.tick(); card.querySelector('input').click();
  assert.equal(view.requests.at(-1).contextRevision, next.skillsContext.revision);
});

test('AutoHook failed operations restore the checkbox and unknown status is never treated as disabled', async t => {
  const state = snapshot('sa'); setSkillsContext(state, 'group');
  state.autoHook = { root: state.skillsContext.root, supported: true, enabled: false, status: 'disabled', stateKnown: true };
  const view = await mount({ mode: 'sa' }, state); t.after(() => view.dom.window.close());
  const document = view.dom.window.document; document.querySelector('.settings-trigger').click(); await view.tick();
  const card = document.querySelector('.autohook-card'), checkbox = card.querySelector('input');
  checkbox.click(); await view.tick(); assert.equal(checkbox.disabled, true);
  view.send({ type: 'error', message: 'enable rejected before launch' }); await view.tick();
  assert.equal(view.requests.at(-1).type, 'refreshAutoHook'); assert.equal(checkbox.checked, false);
  view.sendSnapshot(structuredClone(state)); await view.tick();
  assert.equal(checkbox.checked, false); assert.equal(checkbox.disabled, false);
  const active = { ...state, autoHook: { ...state.autoHook, enabled: true, status: 'needs-revalidation' } };
  view.sendSnapshot(active); await view.tick(); assert.equal(checkbox.checked, true);
  checkbox.click(); await view.tick();
  view.sendSnapshot(structuredClone(active)); await view.tick(); assert.equal(checkbox.checked, true);
  view.sendSnapshot({ ...state, autoHook: { ...state.autoHook, status: 'error', stateKnown: false, message: 'query failed' } }); await view.tick();
  assert.equal(checkbox.disabled, true); assert.match(card.textContent, /尚未確認.*query failed/s);
  view.sendSnapshot({ ...active, autoHook: { ...active.autoHook, status: 'error', stateKnown: false, supported: false, message: 'damaged runtime' } }); await view.tick();
  assert.equal(checkbox.checked, true); assert.equal(checkbox.disabled, false, 'retain emergency disable even with invalid installation');
  checkbox.click(); assert.equal(view.requests.at(-1).operation, 'disable');
});

test('AutoHook reload reads installed state and a different Skills root cannot reuse the old checkbox', async t => {
  const state = snapshot('sa'); setSkillsContext(state, 'group');
  state.autoHook = { root: state.skillsContext.root, supported: true, enabled: true, status: 'enabled', stateKnown: true,
    policySource: { repository: 'https://github.com/openai/codex', revision: 'd'.repeat(40), captured_on: '2026-10-12' },
    policyCoverage: { mode: 'fixed-rules', equivalent_to_native: false, deterministic_rules: ['read.location'], preauthorized_rules: ['build.standard'], manual_review: ['other'], limitations: ['partial'] } };
  for (let reload = 0; reload < 2; reload++) {
    const view = await mount({ mode: 'sa' }, state); t.after(() => view.dom.window.close());
    const document = view.dom.window.document; document.querySelector('.settings-trigger').click(); await view.tick();
    const card = document.querySelector('.autohook-card'), checkbox = card.querySelector('input');
    assert.equal(checkbox.checked, true); assert.match(card.textContent, /官方政策版本：dddddddddddd.*部分本機讀取.*預授權.*Review Agent.*人工核准/s);
    const next = structuredClone(state); next.skillsContext.root = 'D:/different'; next.skillsContext.revision = 'new-root';
    view.sendSnapshot(next); await view.tick();
    assert.equal(checkbox.checked, false); assert.equal(checkbox.disabled, true);
    assert.match(card.querySelector('.pill').textContent, /尚未就緒/);
    assert.equal(view.requests.filter(item => item.type === 'manageAutoHook').length, 0);
  }
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

function setSkillsContext(state, mode = 'repository', matching = {}) {
  const root = mode === 'group' ? state.groupRoot : state.workflowKitInstallTarget.root;
  const repositories = [{ name: 'alpha', path: 'C:/local/repo', matched: true }, { name: 'beta', path: 'C:/local/other', matched: true }];
  const features = ['development-spec', 'query', 'megin-workflow', 'megin-resume', 'merge-repo', 'merge-quick', 'release-review',
    ...(mode === 'group' ? ['merge-group', 'merge-mr'] : [])];
  state.skillsContext = { mode, root, revision: `revision-${root}`, groupMatch: { status: mode === 'group' ? 'matched' : 'mismatched',
    root: mode === 'group' ? root : undefined, repositories, ...matching }, repositories: mode === 'group' ? repositories : repositories.filter(repo => repo.path === root),
    installed: { status: 'installed', profile: mode, version: '0.17.0', capabilities: features,
      upstreamVersions: { 'codebase-wiki': '0.4.0', megin: '0.4.0', 'merge-reviewer': '0.7.0', 'release-reviewer': '0.1.0' } },
    availableFeatures: features, resumeOnly: false };
  return state.skillsContext;
}

test('native Skills shares selected Repo, real versions, functions, prompts and per-Repo drafts', async t => {
  const state = snapshot('sa');
  state.workflowKitPolicy = { requireGroupEnvironment: false, allowed: true, mode: 'repository', settingTarget: 'workspace' };
  state.workflowKitInstallTarget = { root: 'C:/local/repo', profile: 'repository', manual: true, state: { status: 'installed' } };
  setSkillsContext(state);
  const view = await mount({ mode: 'sa' }, state); t.after(() => view.dom.window.close());
  const document = view.dom.window.document;
  const change = async (selector, value, event = 'change') => {
    const control = document.querySelector(selector); control.value = value;
    control.dispatchEvent(new view.dom.window.Event(event, { bubbles: true })); await view.tick();
  };
  assert.match(document.querySelector('.wiki-guide-card-header').textContent, /0.17.0.*0.4.0/);
  await change('[aria-label="Skills 工具"]', 'megin');
  assert.match(document.querySelector('.wiki-guide-card-header').textContent, /單一 Repo 開發流程/);
  assert.equal(document.querySelector('.skills-navigate-button'), null);
  await change('[id="wiki-input-megin-workflow.task"]', '實作可重試的付款 API', 'input');
  const prompt = document.querySelector('.wiki-prompt-preview').textContent;
  assert.match(prompt, /C:\/local\/repo.*實作可重試的付款 API/s);
  assert.doesNotMatch(prompt, /Group 鎖|兄弟 Repo|gitlab_mr|C:\/workspace\/team/);
  assert.equal(document.querySelector('.wiki-copy-button').disabled, false);
  document.querySelector('.wiki-copy-button').click();
  assert.equal(view.requests.at(-1).type, 'copySkillGuidePrompt');
  assert.equal(view.requests.at(-1).featureId, 'megin-workflow');
  assert.equal(view.requests.at(-1).revision, state.skillsContext.revision);
  assert.equal(view.requests.at(-1).inputs['megin-workflow.task'], '實作可重試的付款 API');
  document.querySelector('.skills-codex-button').click();
  assert.deepEqual(structuredClone(view.requests.at(-1)), { type: 'openCodexTerminal', revision: state.skillsContext.revision });
  await change('[aria-label="Skills 工具"]', 'merge-reviewer');
  assert.deepEqual([...document.querySelector('[aria-label="Skills 功能"]').options].map(option => option.value), ['merge-repo', 'merge-quick']);
  assert.equal(document.querySelector('[id="wiki-input-merge-repo.repo"]'), null);
  await change('[aria-label="Skills Repo"]', 'C:/local/other');
  assert.deepEqual(structuredClone(view.requests.at(-1)), { type: 'selectSkillsRepository', root: 'C:/local/other' });
  const second = structuredClone(state); second.workflowKitInstallTarget.root = 'C:/local/other'; setSkillsContext(second);
  view.sendSnapshot(second); await view.tick();
  await change('[aria-label="Skills 工具"]', 'megin');
  assert.equal(document.querySelector('[id="wiki-input-megin-workflow.task"]').value, '');
  await change('[id="wiki-input-megin-workflow.task"]', '另一個 Repo 的草稿', 'input');
  view.sendSnapshot(state); await view.tick();
  await change('[aria-label="Skills 工具"]', 'megin');
  assert.equal(document.querySelector('[id="wiki-input-megin-workflow.task"]').value, '實作可重試的付款 API');
  assert.equal(view.savedState.skillsGuideByScope['repository:C:/local/other'].inputs['megin-workflow.task'], '另一個 Repo 的草稿');
  assert.ok(!view.requests.some(request => request.type === 'installWorkflowKit'), 'navigation must never install or convert a profile');
});

test('legacy Skills only resumes verified Work IDs and never displays another roots version', async t => {
  const state = snapshot('sa');
  state.workflowKitInstallTarget.root = 'C:/local/repo';
  const context = setSkillsContext(state);
  context.installed = { ...context.installed, version: '0.16.0', status: 'work-in-progress', activeWorkIds: ['work-20261011-existing'] };
  context.availableFeatures = ['megin-resume']; context.resumeOnly = true;
  context.reason = '舊版僅可續作既有 Megin 工作；完成後請更新。';
  const view = await mount({ mode: 'sa' }, state); t.after(() => view.dom.window.close());
  const document = view.dom.window.document;
  assert.match(document.querySelector('.wiki-guide-card-header').textContent, /0.16.0/);
  assert.equal(document.querySelector('.wiki-copy-button').disabled, true);
  const change = async (selector, value, event = 'change') => {
    const control = document.querySelector(selector); control.value = value;
    control.dispatchEvent(new view.dom.window.Event(event, { bubbles: true })); await view.tick();
  };
  await change('[aria-label="Skills 工具"]', 'megin');
  assert.equal(document.querySelector('.wiki-copy-button').disabled, true, 'new tasks stay blocked');
  await change('[aria-label="Skills 功能"]', 'megin-resume');
  await change('[id="wiki-input-megin-resume.workId"]', 'work-20261011-other', 'input');
  assert.equal(document.querySelector('.wiki-copy-button').disabled, true);
  await change('[id="wiki-input-megin-resume.workId"]', 'work-20261011-existing', 'input');
  assert.equal(document.querySelector('.wiki-copy-button').disabled, false);
  document.querySelector('.wiki-copy-button').click(); assert.equal(view.requests.at(-1).featureId, 'megin-resume');
  context.installed = { status: 'missing' }; context.availableFeatures = []; context.resumeOnly = false;
  view.sendSnapshot(state); await view.tick();
  assert.match(document.querySelector('.wiki-guide-card-header').textContent, /未安裝/);
  assert.doesNotMatch(document.querySelector('.wiki-guide-card-header').textContent, /0.9.0|0.16.0/);
});

test('Issue development distinguishes default continuation, explicit new work and selected continuation', async t => {
  const data = snapshot();
  data.localRepositories = { 1: { state: 'ready', path: 'C:/workspace/team/alpha' }, 2: { state: 'ready', path: 'C:/workspace/team/beta' } };
  data.meginWorkItems = [
    { workId: 'work-20261013-first', status: 'implementing', issueIid: 1, issueProjectId: 1 },
    { workId: 'work-20261013-second', status: 'implementing', issueIid: 1, issueProjectId: 1 },
    { workId: 'work-20261013-beta', status: 'implementing', issueIid: 2, issueProjectId: 2 }
  ];
  const view = await mount({ mode: 'developer' }, data); t.after(() => view.dom.window.close());
  const document = view.dom.window.document;
  const openIssue = async (index, revision) => {
    const issue = data.issues[index]; const project = data.projects.find(project => project.id === issue.project_id);
    view.send({ type: 'issueNavigation', navigation: { mode: 'detail', projectId: issue.project_id, issueIid: issue.iid, tab: 'development', revision } }); await view.tick();
    view.send({ type: 'issueResponse', revision, response: { type: 'detailData', data: issueDetailData(issue, project) } }); await view.tick();
  };
  const selector = () => [...document.querySelectorAll('.issue-embed select')].find(select => [...select.options].some(option => option.textContent.startsWith('建立新工作')));
  const copyPrompt = () => {
    [...document.querySelectorAll('.issue-embed button')].find(button => button.textContent === '複製任務並開啟 Codex CLI').click();
    return view.requests.findLast(request => request.type === 'copyAndOpenCodex').text;
  };
  const selectWork = async value => {
    const select = selector(); select.value = value;
    select.dispatchEvent(new view.dom.window.Event('change', { bubbles: true })); await view.tick();
  };
  await openIssue(0, 20);
  assert.equal(selector().value, 'work-20261013-first');
  assert.match(copyPrompt(), /續作 Work ID：work-20261013-first/);
  await selectWork('work-20261013-second');
  assert.match(copyPrompt(), /續作 Work ID：work-20261013-second/);
  await selectWork('');
  assert.equal(selector().value, '');
  assert.doesNotMatch(copyPrompt(), /續作 Work ID：/);
  view.sendSnapshot(structuredClone(data)); await view.tick();
  assert.equal(selector().value, '', 'ordinary snapshots preserve the explicit new-work choice');
  assert.doesNotMatch(copyPrompt(), /續作 Work ID：/);
  await openIssue(1, 21);
  assert.equal(selector().value, 'work-20261013-beta', 'another Issue resets the choice to its own default');
  assert.match(copyPrompt(), /續作 Work ID：work-20261013-beta/);
});

test('sidebar mode navigation restores the narrow-layout list while ordinary snapshots preserve its preview', async t => {
  const view = await mount({ mode: 'developer' }, snapshot()); t.after(() => view.dom.window.close());
  const document = view.dom.window.document;
  const panel = () => document.querySelector('.workbench').dataset.mobilePanel;
  document.querySelector('.mobile-switch').click(); await view.tick();
  assert.equal(panel(), 'detail');
  view.sendSnapshot(snapshot()); await view.tick();
  assert.equal(panel(), 'detail', 'background refresh must keep the current preview visible');
  view.sendSnapshot(snapshot('clone')); await view.tick();
  assert.equal(panel(), 'list', 'the project list must remain visible at the narrow-layout CSS breakpoint');
  assert.ok(document.querySelector('.clone-list-column'));
  assert.equal(document.querySelector('.mobile-switch'), null, 'projects have no separate detail pane or return control');
  view.sendSnapshot(snapshot('reviewer')); await view.tick();
  document.querySelector('.mobile-switch').click(); await view.tick();
  assert.equal(panel(), 'detail');
  view.sendSnapshot(snapshot('reviewer')); await view.tick();
  assert.equal(panel(), 'detail');
  view.sendSnapshot(snapshot()); await view.tick();
  assert.equal(panel(), 'list');
});

test('offline Skills footer shows the selected Repo and its actionable state without requiring a Group', async t => {
  const state = snapshot('sa');
  Object.assign(state, { connected: false, group: undefined, groupRoot: undefined, connectedScope: undefined, workspaceRootError: '尚未登入 GitLab' });
  state.workflowKitInstallTarget = { root: 'C:/local/repo', profile: 'repository', manual: true, state: { status: 'installed' } };
  setSkillsContext(state);
  const view = await mount({ mode: 'sa' }, state); t.after(() => view.dom.window.close());
  const document = view.dom.window.document;
  assert.match(document.querySelector('.statusbar').textContent, /Skills 工作區（單一 Repo）：C:\/local\/repo/);
  assert.doesNotMatch(document.querySelector('.statusbar').textContent, /尚未登入|開啟 GitLab Group/);
  const unavailable = structuredClone(state);
  unavailable.skillsContext = { ...unavailable.skillsContext, mode: 'unavailable', root: undefined, reason: '請選擇目前 VS Code 工作區的 Repo。' };
  view.sendSnapshot(unavailable); await view.tick();
  assert.match(document.querySelector('.statusbar').textContent, /請選擇目前 VS Code 工作區的 Repo/);
});

test('AutoHook reviewer model and effort apply to enable and save at the actual Skills root', async t => {
  const state = snapshot('sa'); setSkillsContext(state, 'group');
  state.autoHook = { root: state.skillsContext.root, supported: true, enabled: false, status: 'disabled', stateKnown: true,
    reviewerModels: [
      { model: 'gpt-6-luna', displayName: 'GPT-6 Luna', defaultReasoningEffort: 'low', supportedReasoningEfforts: ['low', 'medium'] },
      { model: 'gpt-6.1-sol', displayName: 'GPT-6.1 Sol', defaultReasoningEffort: 'high', supportedReasoningEfforts: ['medium', 'high', 'xhigh'] }
    ] };
  const view = await mount({ mode: 'sa' }, state); t.after(() => view.dom.window.close());
  const document = view.dom.window.document; document.querySelector('.settings-trigger').click(); await view.tick();
  const card = document.querySelector('.autohook-card');
  const model = card.querySelector('[aria-label="Review Agent 模型"]'), effort = card.querySelector('[aria-label="Review Agent 思考強度"]');
  const save = [...card.querySelectorAll('button')].find(item => item.textContent === '儲存 Review Agent 設定');
  assert.equal(view.requests.at(-1).type, 'refreshAutoHookModels');
  assert.equal(view.requests.at(-1).contextRevision, state.skillsContext.revision);
  assert.equal(model.value, 'gpt-6-luna'); assert.equal(effort.value, 'low'); assert.equal(save.disabled, true);
  model.value = 'gpt-6.1-sol'; model.dispatchEvent(new view.dom.window.Event('change', { bubbles: true })); await view.tick();
  assert.equal(effort.value, 'high'); assert.deepEqual([...effort.options].map(item => item.value), ['medium', 'high', 'xhigh']);
  effort.value = 'xhigh'; effort.dispatchEvent(new view.dom.window.Event('change', { bubbles: true })); await view.tick();
  card.querySelector('input[type="checkbox"]').click();
  assert.deepEqual(structuredClone(view.requests.at(-1)), { type: 'manageAutoHook', operation: 'enable', contextRevision: state.skillsContext.revision,
    reviewer: { model: 'gpt-6.1-sol', reasoningEffort: 'xhigh', timeoutSeconds: 30 } });
  const active = { ...state, autoHook: { ...state.autoHook, enabled: true, status: 'enabled', reviewer: { model: 'gpt-6.1-sol', reasoningEffort: 'xhigh', timeoutSeconds: 30 } } };
  view.sendSnapshot(active); await view.tick(); assert.equal(save.disabled, true);
  model.value = 'gpt-6-luna'; model.dispatchEvent(new view.dom.window.Event('change', { bubbles: true })); await view.tick();
  assert.equal(effort.value, 'low'); assert.equal(save.disabled, false); save.click();
  assert.deepEqual(structuredClone(view.requests.at(-1)), { type: 'manageAutoHook', operation: 'configure', contextRevision: state.skillsContext.revision,
    reviewer: { model: 'gpt-6-luna', reasoningEffort: 'low', timeoutSeconds: 30 } });
  assert.match(card.textContent, /目前套用：gpt-6.1-sol／xhigh/);
  view.sendSnapshot({ ...active, autoHook: { ...active.autoHook, reviewer: { model: 'gpt-6-luna', reasoningEffort: 'low', timeoutSeconds: 30 } } });
  await view.tick(); assert.equal(save.disabled, true); assert.match(card.textContent, /目前套用：gpt-6-luna／low/);
});

test('AutoHook catalog loading and failure preserve emergency disable and root-specific reviewer settings', async t => {
  const state = snapshot('sa'); setSkillsContext(state, 'group');
  state.autoHook = { root: state.skillsContext.root, supported: true, enabled: true, status: 'enabled', stateKnown: true,
    reviewer: { model: 'custom-model', reasoningEffort: 'high', timeoutSeconds: 30 }, reviewerModelsLoading: true };
  const view = await mount({ mode: 'sa' }, state); t.after(() => view.dom.window.close());
  const document = view.dom.window.document; document.querySelector('.settings-trigger').click(); await view.tick();
  const card = document.querySelector('.autohook-card'), checkbox = card.querySelector('input[type="checkbox"]');
  const model = card.querySelector('[aria-label="Review Agent 模型"]');
  assert.equal(model.value, 'custom-model'); assert.equal(model.disabled, true); assert.equal(checkbox.disabled, false);
  view.sendSnapshot({ ...state, autoHook: { ...state.autoHook, reviewerModelsLoading: false, reviewerModelsError: 'offline' } }); await view.tick();
  assert.match(card.textContent, /模型清單讀取失敗：offline.*目前設定仍保留/s); assert.equal(model.value, 'custom-model');
  const next = structuredClone(state); next.skillsContext.root = 'D:/new'; next.skillsContext.revision = 'next-root';
  next.autoHook = { root: next.skillsContext.root, supported: true, enabled: false, status: 'disabled', stateKnown: true };
  view.sendSnapshot(next); await view.tick(); assert.equal(model.value, 'gpt-6-luna');
  assert.equal(view.requests.at(-1).type, 'refreshAutoHookModels'); assert.equal(view.requests.at(-1).contextRevision, 'next-root');
});
