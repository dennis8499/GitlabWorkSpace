import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM, VirtualConsole } from 'jsdom';
import { webviewBundle } from './webview-bundle.mjs';

const { html, script } = await webviewBundle('dashboard');

function repository(id) {
  return { id, name: id, path: `C:/workspace/${id}`, branch: 'main', headCommit: 'a'.repeat(40),
    stagedCount: 0, unstagedCount: 0, conflictCount: 0, branches: [], stashes: [], recoveryRefs: [], remotes: [],
    changes: [], history: [], historyHasMore: false, revision: 1 };
}

function workspace(activeMode = 'git', navigationState) {
  return { activeMode, connected: false, groups: [], projects: [], issues: [], mergeRequests: [], groupMilestones: [],
    groupIssueBoards: [], groupRepositories: [], projectLocalRepositories: {}, localRepositories: {}, projectMembers: [],
    timers: [], tools: [], workflowKit: { status: 'missing' }, workflowKitReleases: [], workflowKitSource: 'github', busy: false,
    hostNavigationGeneration: navigationState?.generation,
    operationSnapshot: navigationState?.hostSessionId ? { sessionId: navigationState.hostSessionId, revision: 0, operations: [] } : undefined };
}

async function mount(t, saved, navigationState) {
  const errors = [], requests = [], virtualConsole = new VirtualConsole();
  virtualConsole.on('jsdomError', error => errors.push(error.stack ?? error.message));
  const dom = new JSDOM(html, { url: 'https://git-selection.example.test', runScripts: 'outside-only', pretendToBeVisual: true, virtualConsole });
  t.after(() => { dom.window.close(); assert.deepEqual(errors, []); });
  dom.window.addEventListener('error', event => errors.push(event.error?.stack ?? event.message));
  let state = saved ?? { mode: 'git' };
  dom.window.acquireVsCodeApi = () => ({ postMessage: request => requests.push(request), getState: () => state,
    setState: value => { state = JSON.parse(JSON.stringify(value)); } });
  const send = message => dom.window.dispatchEvent(new dom.window.MessageEvent('message', { data: message }));
  const tick = async () => {
    await new Promise(resolve => dom.window.requestAnimationFrame(() => dom.window.requestAnimationFrame(resolve)));
    await new Promise(resolve => setTimeout(resolve, 0));
  };
  const until = async (condition, description) => {
    for (let attempt = 0; attempt < 50 && !condition(); attempt++) await tick();
    assert.ok(condition(), description);
  };
  dom.window.eval(script);
  await until(() => requests.some(request => request.type === 'ready'), 'dashboard announces readiness');
  send({ type: 'snapshot', snapshot: workspace('git', navigationState) });
  await until(() => requests.some(request => request.type === 'gitReady'), 'Git subscribes before requesting its inventory');
  const list = (patch = {}) => send({ type: 'gitRepositories', available: true, revision: 1,
    repositories: [repository('repo-a'), repository('repo-b')], selectedRepositoryId: 'repo-a', ...patch });
  const open = async id => {
    await until(() => requests.some(request => request.type === 'gitAction' && request.action.type === 'open' && request.repoId === id), `Git opens ${id}`);
    const request = requests.findLast(request => request.type === 'gitAction' && request.action.type === 'open' && request.repoId === id);
    send({ type: 'gitSnapshot', requestId: request.requestId, snapshot: repository(id) });
    send({ type: 'gitActionResult', requestId: request.requestId });
    await tick();
  };
  const choose = id => {
    const select = dom.window.document.querySelector('.git-repo-picker select');
    assert.ok(select, 'Repo selection is visible');
    select.value = id; select.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
  };
  return { dom, document: dom.window.document, requests, list, open, choose, tick, send,
    get state() { return state; } };
}

test('Git inventory cannot replace a newer Repo choice, including before the next render', async t => {
  const view = await mount(t);
  view.list(); await view.open('repo-a');
  view.choose('repo-b');
  assert.equal(view.state.gitUi.selectedId, 'repo-b', 'the dropdown choice is durable within its event');
  view.list();
  assert.equal(view.state.gitUi.selectedId, 'repo-b', 'an equal-revision list cannot overwrite the choice before rendering');
  await view.open('repo-b');
  view.list({ revision: 2 }); await view.tick();
  assert.equal(view.state.gitUi.selectedId, 'repo-b', 'a newer inventory revision is not a navigation command');
  view.list({ revision: 3, repositories: [repository('repo-a')] }); await view.tick();
  assert.equal(view.state.gitUi.selectedId, 'repo-a', 'removing the selected Repo permits a valid fallback');
});

test('Git consumes explicit Repo navigation once independently of inventory revisions and replays', async t => {
  const view = await mount(t);
  view.list(); await view.open('repo-a');
  const intent = { hostSessionId: 'host-a', sequence: 2, repositoryId: 'repo-b' };
  view.list({ selectionIntent: intent });
  assert.equal(view.state.gitUi.selectedId, 'repo-b');
  assert.deepEqual(view.state.gitUi.selectionCursor, { hostSessionId: 'host-a', sequence: 2 });
  await view.open('repo-b');
  view.choose('repo-a'); await view.open('repo-a');
  view.list({ selectionIntent: intent });
  view.list({ selectionIntent: { ...intent, sequence: 1 } }); await view.tick();
  assert.equal(view.state.gitUi.selectedId, 'repo-a', 'duplicate and older intentions cannot undo a later local selection');
  view.list({ selectionIntent: { ...intent, sequence: 3 } }); await view.open('repo-b');
  assert.equal(view.state.gitUi.selectedId, 'repo-b', 'a new native navigation works with an unchanged inventory revision');
  view.list({ selectionIntent: { ...intent, hostSessionId: 'host-b', sequence: 1, repositoryId: 'repo-a' } }); await view.open('repo-a');
  view.list({ selectionIntent: { ...intent, sequence: 4 } }); await view.tick();
  assert.equal(view.state.gitUi.selectedId, 'repo-a', 'a retired Host cannot restore its old navigation');
});

test('Git persists consumed navigation before rendering and ignores it after Webview reconstruction', async t => {
  const view = await mount(t);
  const intent = { hostSessionId: 'host-a', sequence: 1, repositoryId: 'repo-a' };
  view.list({ selectionIntent: intent });
  assert.deepEqual(view.state.gitUi.selectionCursor, { hostSessionId: 'host-a', sequence: 1 });
  await view.open('repo-a');
  view.choose('repo-b');
  const saved = view.state;
  view.dom.window.close();
  const restored = await mount(t, saved);
  restored.list({ selectionIntent: intent }); await restored.open('repo-b');
  assert.equal(restored.state.gitUi.selectedId, 'repo-b', 'gitReady replay does not restore the already consumed native selection');
  assert.equal(restored.requests.some(request => request.type === 'gitAction' && request.repoId === 'repo-a'), false);
  restored.list({ selectionIntent: { hostSessionId: 'host-new', sequence: 1, repositoryId: 'repo-a' } }); await restored.open('repo-a');
  assert.equal(restored.state.gitUi.selectedId, 'repo-a', 'a new Host can start its own selection sequence');
});

test('Git consumes a delayed native selection without overriding a later manual Repo choice', async t => {
  const view = await mount(t);
  view.list(); await view.open('repo-a');
  view.send({ type: 'hostNavigation', hostSessionId: 'host-a', generation: 4, values: { mode: 'git' } });
  view.choose('repo-b');
  const intent = { hostSessionId: 'host-a', sequence: 1, repositoryId: 'repo-a', hostNavigationGeneration: 4 };
  view.list({ selectionIntent: intent });
  assert.equal(view.state.gitUi.selectedId, 'repo-b', 'the delayed first delivery respects the newer manual selection');
  assert.deepEqual(view.state.gitUi.selectionCursor, { hostSessionId: 'host-a', sequence: 1 }, 'the stale intent is consumed durably');
  await view.open('repo-b');
  view.send({ type: 'hostNavigation', hostSessionId: 'host-a', generation: 5, values: { mode: 'git' } });
  view.list({ selectionIntent: { ...intent, sequence: 2, hostNavigationGeneration: 5 } }); await view.open('repo-a');
  assert.equal(view.state.gitUi.selectedId, 'repo-a', 'a new explicit native request still navigates');
  view.send({ type: 'hostNavigation', hostSessionId: 'host-a', generation: 6, values: { mode: 'sa' } });
  view.list({ selectionIntent: { ...intent, sequence: 3, repositoryId: 'repo-b', hostNavigationGeneration: 5 } }); await view.tick();
  assert.equal(view.state.gitUi.selectedId, 'repo-a', 'navigation to another page retires older pending Repo navigation');
});

test('Git retains a manual selection across reconstruction before its first native token arrives', async t => {
  const navigation = { hostSessionId: 'host-a', generation: 8 };
  const view = await mount(t, undefined, navigation);
  view.list(); await view.open('repo-a');
  view.choose('repo-b');
  assert.deepEqual(view.state.gitUi.manualSelectionBaseline, navigation, 'the manual baseline is durable in its input event');
  const saved = view.state;
  view.dom.window.close();
  const restored = await mount(t, saved, navigation);
  restored.list({ selectionIntent: { hostSessionId: 'host-a', sequence: 1, repositoryId: 'repo-a', hostNavigationGeneration: 8 } });
  assert.equal(restored.state.gitUi.selectedId, 'repo-b');
  await restored.open('repo-b');
  restored.send({ type: 'hostNavigation', hostSessionId: 'host-new', generation: 1, values: { mode: 'git' } });
  restored.list({ selectionIntent: { hostSessionId: 'host-new', sequence: 1, repositoryId: 'repo-a', hostNavigationGeneration: 1 } });
  await restored.open('repo-a');
  assert.equal(restored.state.gitUi.selectedId, 'repo-a', 'a new Host resets generation comparisons instead of inheriting the old manual baseline');
});

test('Git retains history search on same-Repo reentry and clears it after an actual Repo switch', async t => {
  const view = await mount(t);
  view.list(); await view.open('repo-a');
  const search = view.document.querySelector('.git-graph-search input');
  search.value = 'Keep my search'; search.dispatchEvent(new view.dom.window.Event('input', { bubbles: true })); await view.tick();
  view.send({ type: 'snapshot', snapshot: workspace('sa') }); await view.tick();
  view.send({ type: 'snapshot', snapshot: workspace() }); await view.tick();
  assert.equal(view.state.gitUi.historyFilter, 'Keep my search');
  view.choose('repo-b'); await view.open('repo-b');
  assert.equal(view.state.gitUi.historyFilter, '');
});
