import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM, VirtualConsole } from 'jsdom';
import { webviewBundle } from './webview-bundle.mjs';
import { bmadUiSnapshot } from '../fixtures/bmad-ui.mjs';

process.env.GITLAB_WORKSPACE_UI_SOURCE = '1';
const { html, script } = await webviewBundle('dashboard');
const clone = value => structuredClone(value);
const root = 'C:/team';
const scope = value => 'project-root:' + value.replaceAll('\\', '/').replace(/\/+$/, '').toLowerCase();
const workState = patch => ({ filters: {}, selectedIds: {}, selectedProjectIds: [], analysisProjectIds: [], issueBoardId: 'all',
  issueProjectFilter: 'all', issueLabelFilter: 'all', reviewFilter: 'all', analysisIntent: 'requirements', requirement: '',
  importText: '', draftChecked: {}, draftChoices: {}, reports: {}, manualTimes: {}, timeEdits: {}, ...patch });

function snapshot(mode = 'sa', selectedRoot = root) {
  const projects = [1, 2, 3].map(id => ({ id, name: 'service-' + id, path: 'service-' + id,
    path_with_namespace: 'team/service-' + id, web_url: `https://gitlab.test/team/service-${id}`,
    http_url_to_repo: `https://gitlab.test/team/service-${id}.git`, default_branch: 'main' }));
  const repo = { name: 'service', path: selectedRoot + '/service', matched: true };
  const installed = { status: 'installed', version: '1.5.0', profile: 'group', capabilities: ['query', 'merge-repo', 'release-review', 'commit-draft'] };
  return { connected: true, baseUrl: 'https://gitlab.test', currentUser: { id: 7, username: 'tester', name: 'Tester' },
    group: { id: 3, name: 'Team', full_path: 'team' }, groups: [], projects, issues: [], mergeRequests: [],
    groupMilestones: [], groupIssueBoards: [], groupRoot: selectedRoot, cloneRoot: selectedRoot,
    groupRepositories: [repo], groupRepositoryScanStatus: 'ready', localRepositories: {}, projectLocalRepositories: {},
    projectMembers: [], timers: [], tools: [], activeMode: mode, projectSource: 'gitlab', mergeRequestFilter: 'all',
    connectedScope: 'team-scope', instanceUserScope: 'tester', activeAccountId: 'account', hostNavigationGeneration: 0,
    projectContext: { root: selectedRoot, revision: selectedRoot, folders: [], manual: false },
    skillsContext: { mode: 'group', root: selectedRoot, revision: selectedRoot, installed, availableFeatures: installed.capabilities,
      repositories: [repo], reviewerRepositories: [repo], groupMatch: { status: 'matched', root: selectedRoot, profile: 'group', repositories: [repo] } },
    workflowKit: installed, workflowKitInstallTarget: { root: selectedRoot, profile: 'group', manual: false, state: installed },
    workflowKitReleases: [], workflowKitSource: 'github', busy: false,
    sections: { projects: { status: 'ready', complete: true }, boards: { status: 'ready', complete: true }, milestones: { status: 'ready', complete: true } } };
}

async function mount(t, data = snapshot(), saved = { mode: data.activeMode }) {
  const errors = [], requests = [], virtualConsole = new VirtualConsole();
  virtualConsole.on('jsdomError', error => errors.push(error.stack ?? error.message));
  const dom = new JSDOM(html, { url: 'https://ui-state.test', runScripts: 'outside-only', pretendToBeVisual: true, virtualConsole });
  dom.window.addEventListener('error', event => errors.push(event.error?.stack ?? event.message));
  let state = saved;
  const send = message => dom.window.dispatchEvent(new dom.window.MessageEvent('message', { data: message }));
  dom.window.acquireVsCodeApi = () => ({ getState: () => state, setState: value => { state = JSON.parse(JSON.stringify(value)); }, postMessage: request => {
    requests.push(request);
    if (request.type === 'loadReviewerCapabilities') queueMicrotask(() => send({ ...request, type: 'reviewerCapabilities' }));
    if (request.type === 'loadSkillBranches') queueMicrotask(() => send({ ...request, type: 'skillBranches', branches: ['main', 'feature'] }));
    if (request.type === 'loadReviewSessions') queueMicrotask(() => send({ ...request, type: 'reviewSessions', sessions: [] }));
  } });
  const tick = async () => { await new Promise(resolve => dom.window.requestAnimationFrame(() => dom.window.requestAnimationFrame(resolve))); await new Promise(resolve => setTimeout(resolve, 0)); };
  dom.window.eval(script); await tick(); send({ type: 'snapshot', snapshot: data }); await tick();
  t.after(() => { dom.window.close(); assert.deepEqual(errors, []); });
  return { dom, document: dom.window.document, requests, tick, send,
    async snapshot(value) { send({ type: 'snapshot', snapshot: value }); await tick(); },
    async click(selector) { const target = dom.window.document.querySelector(selector); assert.ok(target, selector); target.click(); await tick(); },
    async input(selector, value) { const target = dom.window.document.querySelector(selector); assert.ok(target, selector); target.value = value; target.dispatchEvent(new dom.window.Event('input', { bubbles: true })); await tick(); },
    async ack(request, field, value, patch = {}) { send({ type: 'uiIntentResult', uiIntentId: request.uiIntentId, field, value, applied: true, hostNavigationGeneration: 0, ...patch }); await tick(); },
    get state() { return state; } };
}

test('Skills binds unavailable known roots immediately and preserves the selected tool through detection', async t => {
  const pending = snapshot(); pending.skillsContext.mode = 'unavailable';
  const view = await mount(t, pending);
  await view.click('#skill-tool-merge-reviewer');
  await view.input('[id="wiki-input-merge-repo.base"]', 'main');
  await view.snapshot(snapshot());
  assert.equal(view.document.querySelector('.skills-tool-tabs [aria-selected=true]').id, 'skill-tool-merge-reviewer');
  assert.equal(view.document.getElementById('wiki-input-merge-repo.base').value, 'main');
  assert.equal(view.state.projectGuideScope, scope(root));
});

test('Skills overlays unresolved explicit edits onto a saved project without importing automatic Repo selection', async t => {
  const pending = snapshot(); delete pending.projectContext; delete pending.groupRoot; delete pending.skillsContext.root;
  pending.skillsContext.mode = 'unavailable';
  const saved = { mode: 'sa', skillsGuideByScope: { [scope(root)]: { tool: 'codebase-wiki', selections: {},
    inputs: { 'merge-repo.repo': root + '/saved-repo', 'query.question': 'keep saved question', 'merge-repo.base': 'saved-base' } } } };
  const view = await mount(t, pending, saved);
  await view.click('#skill-tool-merge-reviewer');
  await view.input('[id="wiki-input-merge-repo.base"]', '');
  await view.snapshot(snapshot());
  const draft = view.state.skillsGuideByScope[scope(root)];
  assert.equal(draft.tool, 'merge-reviewer');
  assert.equal(draft.inputs['merge-repo.repo'], root + '/saved-repo');
  assert.equal(draft.inputs['query.question'], 'keep saved question');
  assert.equal(draft.inputs['merge-repo.base'], '');
});

test('Skills normalizes Windows roots, preserves profile transitions and isolates real project changes', async t => {
  const view = await mount(t);
  await view.click('#skill-tool-release-reviewer');
  await view.input('[id="wiki-input-release-review.base"]', 'release-base');
  const variant = snapshot('sa', 'c:\\TEAM\\'); variant.skillsContext.mode = 'repository';
  await view.snapshot(variant);
  assert.equal(view.document.querySelector('.skills-tool-tabs [aria-selected=true]').id, 'skill-tool-release-reviewer');
  await view.snapshot(snapshot('sa', 'D:/other'));
  assert.equal(view.document.querySelector('.skills-tool-tabs [aria-selected=true]').id, 'skill-tool-codebase-wiki');
  await view.snapshot(snapshot());
  assert.equal(view.document.getElementById('wiki-input-release-review.base').value, 'release-base');
});

test('Skills keeps POSIX case-sensitive roots isolated and migrates legacy scope once', async t => {
  const legacy = 'project:/Repo:group', saved = { mode: 'sa', projectGuideScope: legacy,
    skillsGuideByScope: { [legacy]: { tool: 'merge-reviewer', selections: {}, inputs: { 'merge-repo.base': 'legacy-main' } } } };
  const view = await mount(t, snapshot('sa', '/Repo'), saved);
  assert.equal(view.document.getElementById('wiki-input-merge-repo.base').value, 'legacy-main');
  assert.ok(view.state.skillsGuideByScope[legacy], 'legacy state remains available for recovery');
  await view.snapshot(snapshot('sa', '/repo'));
  assert.equal(view.document.querySelector('.skills-tool-tabs [aria-selected=true]').id, 'skill-tool-codebase-wiki');
  await view.snapshot(snapshot('sa', '/Repo'));
  assert.equal(view.document.getElementById('wiki-input-merge-repo.base').value, 'legacy-main');
});

test('BMAD progress arrival preserves Start edits and normalized root variants preserve capability selection', async t => {
  const data = snapshot('bmad'); data.bmad = bmadUiSnapshot(root);
  for (const step of data.bmad.steps) { step.status = 'not-observed'; step.artifacts = []; }
  data.bmad.stories = []; data.bmad.currentCandidates = []; data.bmad.recommendations = [];
  const view = await mount(t, data);
  await view.input('.bmad-panel textarea', 'keep requirement');
  const live = snapshot('bmad'); live.bmad = bmadUiSnapshot(root);
  await view.snapshot(live);
  assert.equal(view.document.getElementById('bmad-tab-start').getAttribute('aria-selected'), 'true');
  assert.equal(view.document.querySelector('.bmad-panel textarea').value, 'keep requirement');
  await view.click('#bmad-tab-capabilities');
  const variant = snapshot('bmad', 'c:\\TEAM\\'); variant.bmad = bmadUiSnapshot('c:\\TEAM\\');
  await view.snapshot(variant);
  assert.equal(view.document.getElementById('bmad-tab-capabilities').getAttribute('aria-selected'), 'true');
  assert.equal(view.state.bmadUiByRoot[scope(root)].requirement, 'keep requirement');
});

test('initial same-Group account hydration retains work view and typed search, true Group changes isolate them', async t => {
  const pending = snapshot('developer'); delete pending.currentUser; delete pending.connectedScope;
  const view = await mount(t, pending);
  await view.input('.developer-toolbar input', 'typed during load');
  await view.click('.developer-view-switch button:nth-child(2)');
  await view.snapshot(snapshot('developer'));
  assert.equal(view.state.developerView, 'graph'); assert.equal(view.state.filters.developer, 'typed during load');
  const other = snapshot('developer'); other.connectedScope = 'other-group'; other.group = { id: 4, name: 'Other', full_path: 'other' };
  await view.snapshot(other);
  assert.equal(view.state.developerView, 'list'); assert.equal(view.state.filters.developer, undefined);
});

test('partial project refresh preserves checkbox selection until an authoritative complete list removes it', async t => {
  const data = snapshot('clone'), view = await mount(t, data, { mode: 'clone', scopeKey: 'team-scope', selectedProjectIds: [3] });
  const partial = clone(data); partial.projects = data.projects.slice(0, 1); partial.sections.projects.complete = false;
  await view.snapshot(partial); assert.deepEqual(view.state.selectedProjectIds, [3]);
  assert.match(view.document.querySelector('.clone-unloaded-selection[role=status]').textContent, /1 個尚未載入/);
  assert.doesNotMatch(view.document.querySelector('.clone-selection-summary').textContent, /不在目前搜尋結果/);
  assert.equal(view.document.querySelector('.clone-submit').disabled, true);
  assert.equal(view.document.querySelector('.more-actions-panel button').disabled, true);
  assert.match(view.document.querySelector('.clone-actions .feature-notices').textContent, /部分已選專案尚未載入/);
  view.document.querySelector('.clone-submit').click(); view.document.querySelector('.more-actions-panel button').click(); await view.tick();
  assert.equal(view.requests.some(request => request.type === 'clone' || request.type === 'syncRepos'), false);
  await view.snapshot(data); assert.deepEqual(view.state.selectedProjectIds, [3]);
  assert.equal(view.document.querySelector('.clone-unloaded-selection'), null);
  assert.equal(view.document.querySelector('.clone-submit').disabled, false);
  partial.sections.projects.complete = true;
  await view.snapshot(partial); assert.deepEqual(view.state.selectedProjectIds, []);
});

test('bounded and failed graph refreshes retain the selected logical node', async t => {
  const data = snapshot('developer');
  const node = { id: 'project:1:issue:1', sourceIds: [], kind: 'issue', namespacePath: 'team/service', projectId: 1, iid: '1',
    title: 'Keep selection', state: 'opened', labels: [], assignees: [], boardIds: [], assignedToMe: true, isRoot: true, relationsStatus: 'ready' };
  data.issueGraph = { connectedScope: 'team-scope', status: 'ready', roots: [node.id], nodes: [node], edges: [], boardIssueIds: {}, boardStatus: {}, errors: [], updatedAt: 1 };
  data.issueGraphVersion = 1;
  const view = await mount(t, data, { mode: 'developer', scopeKey: 'team-scope', developerView: 'graph', selectedGraphNodeId: node.id });
  for (const [index, status] of ['partial', 'error', 'ready'].entries()) {
    view.send({ type: 'issueGraphChanged', connectedScope: 'team-scope', version: index + 2, graph: { ...data.issueGraph, status, roots: [], nodes: [] } }); await view.tick();
    assert.equal(view.state.selectedGraphNodeId, node.id); assert.ok(view.document.querySelector('.graph-selection-pending'));
  }
  view.send({ type: 'issueGraphChanged', connectedScope: 'team-scope', version: 5, graph: data.issueGraph }); await view.tick();
  assert.equal(view.state.selectedGraphNodeId, node.id); assert.equal(view.document.querySelector('.graph-selection-pending'), null);
});

test('latest navigation intent survives unrelated snapshots, old results, and an old Webview result', async t => {
  const data = snapshot('developer'), view = await mount(t, data, { mode: 'developer', scopeKey: 'team-scope' });
  await view.click('.mode-navigation [data-mode=reviewer]'); const old = view.requests.findLast(request => request.type === 'setMode');
  await view.click('.mode-navigation [data-mode=clone]'); const latest = view.requests.findLast(request => request.type === 'setMode');
  await view.snapshot(data); assert.equal(view.state.mode, 'clone');
  await view.ack(old, 'mode', 'reviewer', { applied: false, error: 'old failure' }); assert.equal(view.state.mode, 'clone');
  await view.ack({ ...latest, uiIntentId: { ...latest.uiIntentId, viewId: 'old-view' } }, 'mode', 'developer'); assert.equal(view.state.mode, 'clone');
  await view.ack(latest, 'mode', 'clone'); assert.equal(view.state.mode, 'clone');
  assert.equal(Object.hasOwn(latest, 'projectSource'), false); assert.equal(Object.hasOwn(latest, 'mergeRequestFilter'), false);
});

test('explicit Host navigation supersedes pending UI and rejects older-generation snapshots', async t => {
  const data = snapshot('developer'), view = await mount(t, data, { mode: 'developer', scopeKey: 'team-scope' });
  await view.click('.mode-navigation [data-mode=reviewer]'); const request = view.requests.findLast(item => item.type === 'setMode');
  view.send({ type: 'hostNavigation', generation: 1, values: { mode: 'clone' } }); await view.tick();
  await view.snapshot(data); assert.equal(view.state.mode, 'clone');
  await view.ack(request, 'mode', 'reviewer'); assert.equal(view.state.mode, 'clone');
  await view.snapshot({ ...data, activeMode: 'clone', hostNavigationGeneration: 1 }); assert.equal(view.state.mode, 'clone');
});

test('project source and MR role keep pending choices and latest failure rolls back only its own field', async t => {
  const data = snapshot('clone'), view = await mount(t, data, { mode: 'clone', scopeKey: 'team-scope' });
  await view.click('.project-tabs button:last-child'); const source = view.requests.findLast(item => item.type === 'setProjectSource');
  await view.snapshot(data); assert.equal(view.state.projectSource, 'local');
  await view.ack(source, 'projectSource', 'gitlab', { applied: false, error: 'source unavailable' }); assert.equal(view.state.projectSource, 'gitlab');
  view.send({ type: 'hostNavigation', generation: 1, values: { mode: 'reviewer' } }); await view.tick();
  await view.click('.filter-tabs button:nth-child(2)'); const role = view.requests.findLast(item => item.type === 'setMergeRequestFilter');
  await view.snapshot({ ...data, activeMode: 'reviewer', hostNavigationGeneration: 1 }); assert.equal(view.state.reviewFilter, 'reviewer');
  await view.ack(role, 'mergeRequestFilter', 'reviewer', { hostNavigationGeneration: 1 }); assert.equal(view.state.reviewFilter, 'reviewer');
});

test('workflow source remains selected during background updates and an applied choice survives refresh failure', async t => {
  const data = snapshot('dashboard'), view = await mount(t, data, { mode: 'dashboard', scopeKey: 'team-scope' });
  await view.click('.settings-trigger');
  const select = [...view.document.querySelectorAll('.tool-drawer select')].find(item => [...item.options].some(option => option.value === 'gitea'));
  assert.ok(select); select.value = 'gitea'; select.dispatchEvent(new view.dom.window.Event('change', { bubbles: true })); await view.tick();
  const request = view.requests.findLast(item => item.type === 'setWorkflowKitSource'); assert.ok(request.uiIntentId);
  await view.snapshot(data); assert.equal(view.state.workflowKitSource, 'gitea');
  await view.ack(request, 'workflowKitSource', 'gitea');
  view.send({ type: 'error', message: 'refresh failed', mode: 'dashboard' }); await view.tick();
  assert.equal(view.state.workflowKitSource, 'gitea');
});

test('new Group cancels a pending intent and delayed old-group acknowledgement cannot restore it', async t => {
  const data = snapshot('developer'), view = await mount(t, data, { mode: 'developer', scopeKey: 'team-scope' });
  await view.click('.mode-navigation [data-mode=reviewer]'); const request = view.requests.findLast(item => item.type === 'setMode');
  const other = snapshot('developer'); other.connectedScope = 'other-group'; other.group = { id: 4, name: 'Other', full_path: 'other' };
  await view.snapshot(other); assert.equal(view.state.mode, 'developer');
  await view.ack(request, 'mode', 'reviewer'); assert.equal(view.state.mode, 'developer');
});

test('queued Host navigation still applies after its generation was received as a snapshot baseline', async t => {
  const data = snapshot('developer'), view = await mount(t, data, { mode: 'developer', scopeKey: 'team-scope' });
  await view.click('.mode-navigation [data-mode=reviewer]');
  await view.snapshot({ ...data, hostNavigationGeneration: 1 }); assert.equal(view.state.mode, 'reviewer');
  view.send({ type: 'hostNavigation', generation: 1, values: { mode: 'clone' } }); await view.tick();
  assert.equal(view.state.mode, 'clone');
  view.send({ type: 'hostNavigation', generation: 1, values: { mode: 'developer' } }); await view.tick();
  assert.equal(view.state.mode, 'clone', 'same event generation is consumed once');
});

test('canonical Skills state wins over stale aliases while legacy keys remain recoverable', async t => {
  const legacy = 'project:C:/team:group';
  const saved = { mode: 'sa', projectGuideScope: legacy, skillsGuideByScope: {
    [legacy]: { tool: 'merge-reviewer', selections: {}, inputs: { 'merge-repo.base': 'old' } },
    [scope(root)]: { tool: 'release-reviewer', selections: {}, inputs: { 'release-review.base': 'current' } } } };
  const view = await mount(t, snapshot(), saved);
  assert.equal(view.document.getElementById('wiki-input-release-review.base').value, 'current');
  assert.equal(view.state.skillsGuideByScope[legacy].inputs['merge-repo.base'], 'old');
});

test('an acknowledgement for an unaffected field settles after a newer Host navigation', async t => {
  const data = snapshot('clone'), view = await mount(t, data, { mode: 'clone', scopeKey: 'team-scope' });
  await view.click('.project-tabs button:last-child'); const request = view.requests.findLast(item => item.type === 'setProjectSource');
  view.send({ type: 'hostNavigation', generation: 1, values: { mode: 'reviewer' } }); await view.tick();
  await view.ack(request, 'projectSource', 'local');
  await view.snapshot({ ...data, activeMode: 'reviewer', projectSource: 'gitlab', hostNavigationGeneration: 1 });
  assert.equal(view.state.projectSource, 'gitlab', 'the older applied acknowledgement settled the unaffected pending field');
  assert.equal(view.state.mode, 'reviewer');
});

test('explicit unresolved default-tool selection overrides the saved project tool', async t => {
  const pending = snapshot(); delete pending.projectContext; delete pending.groupRoot; delete pending.skillsContext.root;
  pending.skillsContext.mode = 'unavailable';
  const saved = { mode: 'sa', skillsGuideByScope: { [scope(root)]: { tool: 'merge-reviewer', selections: {}, inputs: {} } } };
  const view = await mount(t, pending, saved);
  await view.click('#skill-tool-codebase-wiki');
  await view.snapshot(snapshot());
  assert.equal(view.document.querySelector('.skills-tool-tabs [aria-selected=true]').id, 'skill-tool-codebase-wiki');
});

test('BMAD legacy migration prefers the exact raw root over equivalent aliases', async t => {
  const data = snapshot('bmad'); data.bmad = bmadUiSnapshot(root);
  const view = await mount(t, data, { mode: 'bmad', bmadUiByRoot: {
    'c:/TEAM': { selectedSection: 'start', requirement: 'alias draft' },
    [root]: { selectedSection: 'start', requirement: 'exact draft' } } });
  assert.equal(view.document.querySelector('#bmad-requirement').value, 'exact draft');
  assert.equal(view.state.bmadUiByRoot[scope(root)].requirement, 'exact draft');
});

test('BMAD persists its first usable default without interaction and keeps it on reentry after progress arrives', async t => {
  const data = snapshot('bmad'); data.bmad = bmadUiSnapshot(root);
  for (const step of data.bmad.steps) { step.status = 'not-observed'; step.artifacts = []; }
  data.bmad.stories = []; data.bmad.currentCandidates = []; data.bmad.recommendations = [];
  const view = await mount(t, data); await view.tick();
  assert.equal(view.state.bmadUiByRoot[scope(root)].selectedSection, 'start');
  view.send({ type: 'hostNavigation', generation: 1, values: { mode: 'dashboard' } }); await view.tick();
  const live = snapshot('dashboard'); live.bmad = bmadUiSnapshot(root); live.hostNavigationGeneration = 1;
  await view.snapshot(live);
  view.send({ type: 'hostNavigation', generation: 2, values: { mode: 'bmad' } }); await view.tick();
  assert.equal(view.document.getElementById('bmad-tab-start').getAttribute('aria-selected'), 'true');
  assert.equal(view.state.bmadUiByRoot[scope(root)].selectedSection, 'start');
});

test('BMAD automatic unresolved default does not replace the resolved project section', async t => {
  const pending = snapshot('bmad'); delete pending.projectContext; delete pending.groupRoot; delete pending.skillsContext.root;
  pending.bmad = bmadUiSnapshot(root); delete pending.bmad.root;
  for (const step of pending.bmad.steps) { step.status = 'not-observed'; step.artifacts = []; }
  pending.bmad.stories = []; pending.bmad.currentCandidates = []; pending.bmad.recommendations = [];
  const saved = { mode: 'bmad', bmadUiByRoot: { [scope(root)]: { selectedSection: 'capabilities', selectedTaskId: 'product' } } };
  const view = await mount(t, pending, saved); await view.tick();
  assert.equal(view.state.bmadUiByRoot.none.selectedSection, 'start');
  const live = snapshot('bmad'); live.bmad = bmadUiSnapshot(root);
  await view.snapshot(live); await view.tick();
  assert.equal(view.document.getElementById('bmad-tab-capabilities').getAttribute('aria-selected'), 'true');
  assert.equal(view.state.bmadUiByRoot[scope(root)].selectedTaskId, 'product');
});

test('an explicit unresolved List choice wins over the saved Group Graph view', async t => {
  const pending = snapshot('developer'); delete pending.currentUser; delete pending.connectedScope;
  const saved = { mode: 'developer', scopedData: { 'team-scope': workState({ developerView: 'graph' }) } };
  const view = await mount(t, pending, saved);
  await view.click('.developer-view-switch button:first-child');
  await view.snapshot(snapshot('developer'));
  assert.equal(view.state.developerView, 'list');
  assert.equal(view.document.querySelector('.developer-view-switch button:first-child').getAttribute('aria-pressed'), 'true');
});

test('typing and clearing unresolved search wins over a saved nonempty Group query', async t => {
  const pending = snapshot('developer'); delete pending.currentUser; delete pending.connectedScope;
  const saved = { mode: 'developer', scopedData: { 'team-scope': workState({ developerView: 'list', filters: { developer: 'saved query' } }) } };
  const view = await mount(t, pending, saved);
  await view.input('.developer-toolbar input', 'temporary');
  await view.input('.developer-toolbar input', '');
  await view.snapshot(snapshot('developer'));
  assert.equal(view.state.filters.developer, '');
  assert.equal(view.document.querySelector('.developer-toolbar input').value, '');
});

test('unbound Group Skills drafts migrate to one root and cannot leak to another root after recreation', async t => {
  const saved = { mode: 'sa', wikiGuideInputsByScope: { 'team-scope': { 'query.question': 'legacy Group question' } } };
  const first = await mount(t, snapshot(), saved);
  assert.equal(first.document.getElementById('wiki-input-query.question').value, 'legacy Group question');
  assert.equal(first.state.skillsGuideLegacyRoots['team-scope'], root.toLowerCase());
  const bound = clone(first.state);
  await first.snapshot(snapshot('sa', 'D:/other'));
  assert.equal(first.document.getElementById('wiki-input-query.question').value, '');
  await first.snapshot(snapshot());
  assert.equal(first.document.getElementById('wiki-input-query.question').value, 'legacy Group question');
  const recreated = await mount(t, snapshot('sa', 'D:/other'), bound);
  assert.equal(recreated.document.getElementById('wiki-input-query.question').value, '');
  assert.equal(recreated.state.skillsGuideLegacyRoots['team-scope'], root.toLowerCase());
});

test('existing canonical Skills state reserves retained unbound leftovers before visiting another root', async t => {
  const saved = { mode: 'sa', projectGuideScope: scope(root), skillsGuideByScope: {
    [scope(root)]: { tool: 'codebase-wiki', selections: {}, inputs: { 'query.question': 'canonical question' } } },
    wikiGuideInputsByScope: { 'team-scope': { 'query.question': 'stale Group question' } } };
  const view = await mount(t, snapshot(), saved);
  assert.equal(view.document.getElementById('wiki-input-query.question').value, 'canonical question');
  assert.equal(view.state.skillsGuideLegacyRoots['team-scope'], root.toLowerCase());
  const recreated = await mount(t, snapshot('sa', 'D:/other'), clone(view.state));
  assert.equal(recreated.document.getElementById('wiki-input-query.question').value, '');
});

test('an initially owned offline Skills draft can migrate without auto-created offline defaults shadowing Group data', async t => {
  const saved = { mode: 'sa', projectGuideScope: 'offline', skillsGuideByScope: {
    offline: { tool: 'merge-reviewer', selections: {}, inputs: { 'merge-repo.base': 'offline-main' } } } };
  const view = await mount(t, snapshot(), saved);
  assert.equal(view.document.getElementById('wiki-input-merge-repo.base').value, 'offline-main');
  assert.equal(view.state.skillsGuideLegacyRoots.offline, root.toLowerCase());
});
