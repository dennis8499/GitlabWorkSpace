import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { JSDOM, VirtualConsole } from 'jsdom';

import { webviewBundle } from './webview-bundle.mjs';
const { html, script } = await webviewBundle('dashboard');
const { version } = JSON.parse(await readFile(new URL('../../package.json', import.meta.url), 'utf8'));

function snapshot(profile, features) {
  const groupRoot = 'C:/工作區 with spaces';
  const repo = { name: 'service', path: `${groupRoot}/service`, matched: profile === 'group' };
  const root = profile === 'group' ? groupRoot : repo.path;
  const capabilities = features ?? ['merge-repo'];
  const installed = { status: 'installed', version, profile, capabilities, upstreamVersions: { 'merge-reviewer': '0.12.1' } };
  return {
    connected: profile === 'group', baseUrl: profile === 'group' ? 'https://gitlab.example.test' : undefined,
    currentUser: profile === 'group' ? { id: 1, name: 'Tester' } : undefined,
    group: profile === 'group' ? { id: 2, name: 'Team', full_path: 'team' } : undefined,
    groups: [], projects: [], issues: [], mergeRequests: [], groupMilestones: [], groupIssueBoards: [],
    groupRoot: profile === 'group' ? root : undefined, groupRepositories: [repo], groupRepositoryScanStatus: 'ready',
    localRepositories: {}, projectLocalRepositories: {}, projectMembers: [], timers: [], tools: [],
    activeMode: 'sa', connectedScope: profile === 'group' ? 'group-scope' : undefined, instanceUserScope: 'tester',
    workflowKit: installed, workflowKitInstallTarget: { root, manual: false, profile, state: installed },
    workflowKitPackages: [], workflowKitSource: 'bundled', busy: false,
    skillsContext: { mode: profile, root, revision: `${profile}-revision`, installed, availableFeatures: capabilities,
      repositories: [repo], reviewerRepositories: [repo], groupMatch: { status: profile === 'group' ? 'matched' : 'unverified',
        root: profile === 'group' ? root : undefined, repositories: [repo] } }
  };
}

async function mount(t, profile, saved, features, initialSnapshot = snapshot(profile, features)) {
  const errors = [];
  const virtualConsole = new VirtualConsole();
  virtualConsole.on('jsdomError', error => errors.push(error.stack ?? error.message));
  const dom = new JSDOM(html, { url: 'https://skills.example.test', runScripts: 'outside-only', pretendToBeVisual: true, virtualConsole });
  t.after(() => { dom.window.close(); assert.deepEqual(errors, []); });
  dom.window.addEventListener('error', event => errors.push(event.error?.stack ?? event.message));
  const requests = [];
  let state = saved ?? { mode: 'sa' };
  let holdOperations = false;
  dom.window.acquireVsCodeApi = () => ({ postMessage: request => {
    requests.push(request);
    if (request.operationId && !holdOperations) queueMicrotask(() => dom.window.dispatchEvent(new dom.window.MessageEvent('message', {
      data: { type: 'operationChanged', operation: { requestId: request.operationId, scopeRevision: request.operationScope,
        resourceKey: request.type === 'copySkillGuidePrompt' ? `skill:${request.featureId}` : 'skills', action: request.type,
        label: '準備提示詞', phase: '已完成', status: 'succeeded', startedAt: Date.now() } }
    })));
  }, getState: () => state,
    setState: value => { state = JSON.parse(JSON.stringify(value)); } });
  dom.window.eval(script);
  const tick = async () => {
    await new Promise(resolve => dom.window.requestAnimationFrame(() => dom.window.requestAnimationFrame(resolve)));
    await new Promise(resolve => setTimeout(resolve, 0));
  };
  await tick();
  dom.window.dispatchEvent(new dom.window.MessageEvent('message', { data: { type: 'snapshot', snapshot: initialSnapshot } }));
  await tick();
  const document = dom.window.document;
  const change = async (id, value, event = 'change') => {
    const control = document.querySelector(id);
    assert.ok(control, `missing ${id}`);
    control.value = value; control.dispatchEvent(new dom.window.Event(event, { bubbles: true })); await tick();
  };
  const sendSnapshot = async value => {
    dom.window.dispatchEvent(new dom.window.MessageEvent('message', { data: { type: 'snapshot', snapshot: value } }));
    await tick();
  };
  const send = async message => {
    dom.window.dispatchEvent(new dom.window.MessageEvent('message', { data: message })); await tick();
  };
  const sendBranches = async (branches, error) => {
    const request = requests.findLast(request => request.type === 'loadSkillBranches');
    assert.ok(request, 'a branch read must be requested first');
    await send({ ...request, type: 'skillBranches', branches, error });
  };
  return { dom, document, requests, tick, change, sendSnapshot, send, sendBranches,
    holdOperations: () => { holdOperations = true; }, get savedState() { return state; } };
}

for (const profile of ['group', 'repository']) test(`${profile} retired development selections restore Query and three accessible tools`, async t => {
  const scope = profile === 'group' ? 'project:C:/工作區 with spaces:group' : 'project:C:/工作區 with spaces/service:repository';
  const saved = { mode: 'sa', skillsGuideByScope: { [scope]: { tool: 'megin',
    selections: { megin: 'megin-resume', 'codebase-wiki': 'synthesis' },
    inputs: { 'megin-resume.workId': 'work-20261017-old', 'query.question': 'saved question' } } } };
  const view = await mount(t, profile, saved, ['query']);
  const { document, dom } = view;
  assert.equal(document.querySelector('.wiki-guide-card h2').textContent, '查詢 Wiki');
  assert.equal(document.getElementById('skill-tool-megin'), null);
  assert.equal(document.getElementById('skill-feature-megin-spec-export'), null);
  assert.equal(document.querySelector('[id="wiki-input-query.question"]').value, 'saved question');
  const tabs = [...document.querySelectorAll('.skills-tool-tabs [role="tab"]')];
  assert.equal(tabs.length, 3);
  tabs[0].dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
  await view.tick();
  assert.equal(document.getElementById('skill-tool-release-reviewer').getAttribute('aria-selected'), 'true');
  tabs[2].dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
  await view.tick();
  assert.equal(document.getElementById('skill-tool-codebase-wiki').getAttribute('aria-selected'), 'true');
  document.querySelector('.wiki-copy-button').click(); await view.tick();
  assert.equal(view.requests.at(-1).featureId, 'query');
  assert.equal(view.requests.some(request => /Delivery|Megin/.test(request.type)), false);
});

test('Skills prompt validation publishes one fixed notice per error transition and preserves its starting scope', async t => {
  const view = await mount(t, 'group', undefined, ['merge-repo', 'release-review']);
  view.document.getElementById('skill-tool-merge-reviewer').click(); await view.tick();
  for (const [field, value] of [['base', 'private-base'], ['head', 'private-head']]) {
    await view.change(`[id="wiki-input-merge-repo.${field}"]`, value, 'input');
  }
  const current = snapshot('group', ['merge-repo', 'release-review']);
  current.operationScope = 'skills-origin';
  current.skillsContext.workspaceRootAmbiguous = true;
  const notices = () => view.requests.filter(request => request.type === 'publishNotification' && request.title === 'Skills 提示詞');
  await view.sendSnapshot(current);
  assert.equal(notices().length, 1);
  assert.equal(notices()[0].operationScope, 'skills-origin');
  assert.equal(notices()[0].level, 'warn');
  assert.equal(notices()[0].message, '無法辨識唯一 VSCode 工作區根目錄；請先儲存 multi-root 工作區或開啟明確資料夾。');
  assert.doesNotMatch(JSON.stringify(notices()), /private-service|private-base|private-head|inputs/);
  assert.match(view.document.querySelector('.wiki-guide-card [role="alert"]').textContent, /無法辨識唯一 VSCode 工作區根目錄/);
  assert.equal(view.document.querySelector('.wiki-copy-button').disabled, true);
  for (let index = 0; index < 3; index++) await view.sendSnapshot({ ...current });
  assert.equal(notices().length, 1, 'unchanged snapshots do not republish a rendered validation error');
  await view.sendSnapshot({ ...current, skillsContext: { ...current.skillsContext, workspaceRootAmbiguous: false } });
  assert.equal(view.document.querySelector('.wiki-guide-card [role="alert"]'), null);
  await view.sendSnapshot(current);
  assert.equal(notices().length, 2, 'an error returning after correction is a new feedback transition');
  assert.equal(notices()[0].operationScope, 'skills-origin');
});

test('Skills prompt error deduplication resets for another card or operation context', async t => {
  const view = await mount(t, 'group', undefined, ['merge-repo', 'release-review']);
  const current = snapshot('group', ['merge-repo', 'release-review']);
  current.operationScope = 'skills-old'; current.skillsContext.workspaceRootAmbiguous = true;
  await view.sendSnapshot(current);
  view.document.getElementById('skill-tool-merge-reviewer').click(); await view.tick();
  const notices = () => view.requests.filter(request => request.type === 'publishNotification' && request.title === 'Skills 提示詞');
  assert.equal(notices().length, 1);
  view.document.getElementById('skill-tool-release-reviewer').click(); await view.tick();
  assert.equal(notices().length, 2, 'the same diagnostic on another card is recorded once for that card');
  await view.sendSnapshot({ ...current, operationScope: 'skills-new', skillsContext: { ...current.skillsContext, revision: 'next-context' } });
  assert.equal(notices().length, 3);
  assert.deepEqual(notices().map(notice => notice.operationScope), ['skills-old', 'skills-old', 'skills-new']);
  await view.tick(); assert.equal(notices().length, 3, 'feedback itself does not cause a publication render loop');
});

for (const profile of ['group', 'repository']) test(`${profile} native branch review uses three inputs and separate Codex opening`, async t => {
  const view = await mount(t, profile); const { document, change } = view;
  document.getElementById('skill-tool-merge-reviewer').click(); await view.tick();
  assert.equal(document.querySelector('[id="wiki-input-merge-repo.target"]'), null);
  for (const field of ['mode','output','remote']) assert.equal(document.querySelector(`[id="wiki-input-merge-repo.${field}"]`),null);
  assert.equal(document.querySelector('[id="wiki-input-merge-repo.repo"]').tagName, 'SELECT');
  assert.equal(document.querySelector('[id="wiki-input-merge-repo.repo"]').value, 'C:/工作區 with spaces/service');
  await change('[id="wiki-input-merge-repo.base"]','main','input');
  await change('[id="wiki-input-merge-repo.head"]','feature/review','input');
  assert.equal(document.querySelector('.wiki-copy-button').disabled,false);
  assert.match(document.querySelector('.wiki-prompt-preview').textContent,/merge-reviewer-workspace-context\/v3/);
  assert.match(document.querySelector('.wiki-prompt-preview').textContent,/review_session\.py start/);
  assert.match(document.querySelector('.wiki-prompt-preview').textContent,/start → 必要 step → finish/);
  assert.match(document.querySelector('.wiki-prompt-preview').textContent,/300 秒/);
  document.querySelector('.wiki-copy-button').click(); await view.tick();
  const copy=view.requests.findLast(request => request.type==='copySkillGuidePrompt');
  assert.equal(copy.featureId,'merge-repo'); assert.equal(copy.inputs['merge-repo.head'],'feature/review');
  assert.equal(view.requests.some(request => request.type==='openCodexTerminal'),false);
  document.querySelector('.skills-codex-button').click(); await view.tick();
  assert.equal(view.requests.findLast(request => request.type==='openCodexTerminal').revision,`${profile}-revision`);
  const reopened=await mount(t,profile,view.savedState);
  assert.equal(reopened.document.querySelector('[id="wiki-input-merge-repo.head"]').value,'feature/review');
});

test('local review cards isolate request IDs, ignore stale snapshots and only request local controls', async t => {
  const view = await mount(t, 'group');
  view.document.getElementById('skill-tool-merge-reviewer').click(); await view.tick();
  assert.equal(view.requests.filter(request => request.type === 'loadReviewSessions').length, 1);
  const first = 'a'.repeat(32), second = 'b'.repeat(32);
  const rows = [first, second].map((id, index) => ({ requestId: id, repository: 'service-' + index,
    repositoryPath: 'C:/service-' + index, base: 'main', head: 'topic-' + index,
    state: index ? 'published' : 'reviewing', phase: index ? 'complete' : 'review',
    reportPath: index ? 'C:/service-1/review-reports/report.md' : undefined,
    updatedAt: '2026-10-22T00:00:00Z', fetchCount: index ? 0 : 1, packCacheHits: index }));
  await view.send({ type: 'reviewSessions', revision: 'obsolete', sessions: rows });
  assert.equal(view.document.querySelectorAll('.review-session-list article').length, 0);
  await view.send({ type: 'reviewSessions', revision: 'group-revision', sessions: rows });
  assert.equal(view.document.querySelectorAll('.review-session-list article').length, 2);
  const button = text => [...view.document.querySelectorAll('.review-sessions button')].find(item => item.textContent === text);
  button('取消審查').click(); await view.tick();
  assert.equal(view.requests.findLast(request => request.type === 'cancelReviewSession').requestId, first);
  button('開啟報告').click(); await view.tick();
  assert.equal(view.requests.findLast(request => request.type === 'openReviewReport').requestId, second);
  button('複製重新同步指令').click(); await view.tick();
  assert.equal(view.requests.findLast(request => request.type === 'copyReviewRefresh').requestId, first);
  button('更新審查狀態').click(); await view.tick();
  assert.equal(view.requests.filter(request => request.type === 'loadReviewSessions').length, 2);
  assert.equal(view.requests.some(request => ['refresh', 'refreshMergeRequest', 'gitAction', 'openCodexTerminal'].includes(request.type)), false);
});

test('copy feedback blocks duplicate clicks, allows retry and ignores obsolete environment receipts', async t => {
  const view=await mount(t,'group'); view.document.getElementById('skill-tool-merge-reviewer').click(); await view.tick();
  for (const [field,value] of [['base','main'],['head','feature/review']]) await view.change(`[id="wiki-input-merge-repo.${field}"]`,value,'input');
  view.holdOperations(); const button=view.document.querySelector('.wiki-copy-button'); button.click(); button.click(); await view.tick();
  assert.equal(view.requests.filter(request => request.type==='copySkillGuidePrompt').length,1); assert.equal(button.disabled,true);
  const request=view.requests.findLast(request => request.type==='copySkillGuidePrompt');
  view.dom.window.dispatchEvent(new view.dom.window.MessageEvent('message',{data:{type:'operationChanged',operation:{requestId:request.operationId,
    scopeRevision:request.operationScope,resourceKey:'skill:merge-repo',action:'copySkillGuidePrompt',label:'複製提示詞',phase:'處理失敗',status:'failed',error:'套件已變更',startedAt:Date.now()}}}));
  view.dom.window.dispatchEvent(new view.dom.window.MessageEvent('message',{data:{type:'notificationsChanged',snapshot:{
    sessionId:'skills-session',revision:1,unreadCount:1,items:[{id:`operation:${request.operationId}`,operationId:request.operationId,
      level:'error',title:'複製提示詞',messages:['套件已變更'],createdAt:Date.now(),updatedAt:Date.now(),read:false}]
  }}}));
  await view.tick(); assert.equal(button.disabled,false);
  assert.match(view.document.querySelector('.operation-feedback').textContent,/套件已變更/,'failure stays beside its operation until retry or dismissal');
  assert.match(view.document.querySelector('.notifications-trigger').getAttribute('aria-label'),/1 筆未讀/);
  view.document.querySelector('.notifications-trigger').click(); await view.tick();
  assert.match(view.document.querySelector('.notification-drawer').textContent,/套件已變更/);
  view.document.querySelector('.notification-drawer .drawer-heading button').click(); await view.tick();
  button.click(); await view.tick(); assert.equal(view.requests.filter(request => request.type==='copySkillGuidePrompt').length,2);
  view.dom.window.dispatchEvent(new view.dom.window.MessageEvent('message',{data:{type:'operationChanged',operation:{requestId:'obsolete',
    scopeRevision:'old-root',resourceKey:'skill:merge-repo',label:'Obsolete',phase:'STALE RESULT',status:'succeeded',startedAt:Date.now()}}}));
  await view.tick(); assert.doesNotMatch(view.document.body.textContent,/STALE RESULT/);
});

for (const profile of ['group', 'repository']) for (const [tool, card] of [['merge-reviewer', 'merge-repo'], ['release-reviewer', 'release-review']]) {
  test(`${profile} ${tool} offers searchable branch choices in both fields and accepts manual branches`, async t => {
    const view = await mount(t, profile, undefined, ['merge-repo', 'release-review']);
    view.document.getElementById(`skill-tool-${tool}`).click(); await view.tick();
    const repo = 'C:/工作區 with spaces/service';
    assert.equal(view.requests.findLast(request => request.type === 'loadSkillBranches').repo, repo);
    const control = field => view.document.getElementById(`wiki-input-${card}.${field}`);
    assert.equal(control('repo').tagName, 'SELECT');
    assert.equal(control('repo').value, repo);
    assert.equal(control('base').getAttribute('role'), 'combobox');
    assert.equal(control('head').getAttribute('role'), 'combobox');
    assert.match(view.document.querySelector('.skills-branch-status').textContent, /正在讀取/);
    await view.sendBranches(['main', 'origin/main', 'feature/payment', 'origin/feature/payment']);
    const options = () => [...view.document.querySelectorAll('[role="listbox"] [role="option"]')];
    control('base').closest('.skills-branch-input').querySelector('button').click(); await view.tick();
    assert.equal(control('base').getAttribute('aria-expanded'), 'true');
    assert.deepEqual(options().map(option => option.textContent), ['main', 'origin/main', 'feature/payment', 'origin/feature/payment']);
    await view.change(`[id="${control('base').id}"]`, 'PAY', 'input');
    assert.deepEqual(options().map(option => option.textContent), ['feature/payment', 'origin/feature/payment']);
    control('base').dispatchEvent(new view.dom.window.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })); await view.tick();
    const activeId = control('base').getAttribute('aria-activedescendant');
    assert.equal(view.document.getElementById(activeId).textContent, 'feature/payment');
    control('base').dispatchEvent(new view.dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); await view.tick();
    assert.equal(control('base').value, 'feature/payment');
    assert.equal(control('base').getAttribute('aria-expanded'), 'false');
    control('head').closest('.skills-branch-input').querySelector('button').click(); await view.tick();
    assert.equal(options().length, 4);
    options().find(option => option.textContent === 'origin/main').click(); await view.tick();
    assert.equal(control('head').value, 'origin/main');
    assert.equal(view.document.querySelector('.wiki-copy-button').disabled, false);
    await view.change(`[id="${control('head').id}"]`, 'feature/not-in-local-list', 'input');
    assert.match(view.document.querySelector('.skills-branch-empty').textContent, /可直接使用輸入/);
    control('head').dispatchEvent(new view.dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); await view.tick();
    assert.equal(control('head').value, 'feature/not-in-local-list');
    assert.equal(view.document.querySelector('.wiki-copy-button').disabled, false);
    view.document.querySelector('.wiki-copy-button').click(); await view.tick();
    const copy = view.requests.findLast(request => request.type === 'copySkillGuidePrompt');
    assert.equal(copy.inputs[`${card}.repo`], repo);
    assert.equal(copy.inputs[`${card}.head`], 'feature/not-in-local-list');
    await view.change(`[id="${control('head').id}"]`, 'HEAD', 'input');
    assert.equal(view.document.querySelector('.wiki-copy-button').disabled, true);
  });
}

test('branch loading, failure, retry and empty refs preserve manually entered choices', async t => {
  const view = await mount(t, 'group');
  view.document.getElementById('skill-tool-merge-reviewer').click(); await view.tick();
  await view.change('[id="wiki-input-merge-repo.base"]', 'manual/base', 'input');
  await view.change('[id="wiki-input-merge-repo.head"]', 'manual/head', 'input');
  assert.equal(view.document.querySelector('.wiki-copy-button').disabled, false, 'loading does not block manual branches');
  await view.sendBranches([], 'Git unavailable');
  assert.match(view.document.querySelector('.skills-branch-status [role="status"]').textContent, /Git unavailable.*仍可輸入/);
  assert.equal(view.document.querySelector('.wiki-copy-button').disabled, false);
  const count = view.requests.filter(request => request.type === 'loadSkillBranches').length;
  const retry = view.document.querySelector('.skills-branch-refresh');
  assert.equal(retry.textContent, '重試讀取分支'); retry.click(); await view.tick();
  assert.equal(view.requests.filter(request => request.type === 'loadSkillBranches').length, count + 1);
  assert.equal(view.document.querySelector('.skills-branch-refresh').disabled, true);
  await view.sendBranches([]);
  assert.match(view.document.querySelector('.skills-branch-status [role="status"]').textContent, /尚無本機或遠端追蹤分支/);
  assert.equal(view.document.getElementById('wiki-input-merge-repo.base').value, 'manual/base');
  assert.equal(view.document.getElementById('wiki-input-merge-repo.head').value, 'manual/head');
  assert.equal(view.document.querySelector('.wiki-copy-button').disabled, false);
});

test('workspace Repo selector distinguishes duplicate names and resets only the changed reviewer', async t => {
  const current = snapshot('repository', ['merge-repo', 'release-review']);
  current.skillsContext.workspaceRoot = 'C:/workspace';
  current.skillsContext.workspaceFile = 'C:/workspace/review.code-workspace';
  current.skillsContext.reviewerRepositories = [
    { name: 'service', path: 'C:/workspace/team-a/service' },
    { name: 'service', path: 'D:/other-root/service' }
  ];
  const view = await mount(t, 'repository', undefined, ['merge-repo', 'release-review'], current);
  view.document.getElementById('skill-tool-merge-reviewer').click(); await view.tick();
  const repoSelect = view.document.getElementById('wiki-input-merge-repo.repo');
  assert.equal(repoSelect.value, '', 'multiple candidates need an explicit selection');
  assert.equal(view.requests.some(request => request.type === 'loadSkillBranches'), false);
  assert.equal(view.document.getElementById('wiki-input-merge-repo.base').disabled, true);
  assert.deepEqual([...repoSelect.options].slice(1).map(option => option.textContent), [
    'service — C:/workspace/team-a/service', 'service — D:/other-root/service'
  ]);
  await view.change('[id="wiki-input-merge-repo.repo"]', 'C:/workspace/team-a/service');
  await view.change('[id="wiki-input-merge-repo.base"]', 'base/a', 'input');
  await view.change('[id="wiki-input-merge-repo.head"]', 'head/a', 'input');
  view.document.getElementById('skill-tool-release-reviewer').click(); await view.tick();
  await view.change('[id="wiki-input-release-review.repo"]', 'C:/workspace/team-a/service');
  await view.change('[id="wiki-input-release-review.base"]', 'release/base', 'input');
  await view.change('[id="wiki-input-release-review.head"]', 'release/head', 'input');
  view.document.getElementById('skill-tool-merge-reviewer').click(); await view.tick();
  await view.change('[id="wiki-input-merge-repo.repo"]', 'D:/other-root/service');
  assert.equal(view.document.getElementById('wiki-input-merge-repo.base').value, '');
  assert.equal(view.document.getElementById('wiki-input-merge-repo.head').value, '');
  assert.equal(view.requests.findLast(request => request.type === 'loadSkillBranches').repo, 'D:/other-root/service');
  assert.match(view.document.querySelector('.wiki-prompt-preview').textContent, /專案名稱："D:\/other-root\/service"/);
  view.document.getElementById('skill-tool-release-reviewer').click(); await view.tick();
  assert.equal(view.document.getElementById('wiki-input-release-review.base').value, 'release/base');
  assert.equal(view.document.getElementById('wiki-input-release-review.head').value, 'release/head');
});

test('legacy unique Repo names migrate without clearing drafts while removed Repo choices stay invalid', async t => {
  const scope = 'project:C:/工作區 with spaces:group';
  const saved = { mode: 'sa', skillsGuideByScope: { [scope]: { tool: 'merge-reviewer', selections: {},
    inputs: { 'merge-repo.repo': 'service', 'merge-repo.base': 'saved/base', 'merge-repo.head': 'saved/head' } } } };
  const view = await mount(t, 'group', saved);
  assert.equal(view.document.getElementById('wiki-input-merge-repo.repo').value, 'C:/工作區 with spaces/service');
  assert.equal(view.document.getElementById('wiki-input-merge-repo.base').value, 'saved/base');
  assert.equal(view.document.getElementById('wiki-input-merge-repo.head').value, 'saved/head');
  const next = snapshot('group');
  next.skillsContext.reviewerRepositories = [{ name: 'other', path: 'D:/other' }];
  await view.sendSnapshot(next);
  assert.equal(view.document.getElementById('wiki-input-merge-repo.repo').value, 'C:/工作區 with spaces/service');
  assert.match(view.document.getElementById('wiki-input-merge-repo.repo').selectedOptions[0].textContent, /不在目前工作區/);
  assert.equal(view.document.querySelector('.wiki-copy-button').disabled, true);
  assert.equal(view.document.getElementById('wiki-input-merge-repo.head').value, 'saved/head');
});

test('branch browsing remains available without the installed review capability', async t => {
  const view = await mount(t, 'group', undefined, []);
  view.document.getElementById('skill-tool-merge-reviewer').click(); await view.tick();
  assert.ok(view.requests.findLast(request => request.type === 'loadSkillBranches'));
  await view.sendBranches(['main', 'origin/main']);
  view.document.querySelector('.skills-branch-toggle').click(); await view.tick();
  assert.equal(view.document.querySelectorAll('[role="option"]').length, 2);
  assert.equal(view.document.querySelector('.wiki-copy-button').disabled, true);
});

test('MR branch inputs arrive together without the Repo change handler clearing them', async t => {
  const view = await mount(t, 'group');
  await view.send({ type: 'branchReviewReady', revision: 'group-revision', inputs: {
    'merge-repo.repo': 'C:/工作區 with spaces/service',
    'merge-repo.base': 'origin/main', 'merge-repo.head': 'origin/feature/from-mr'
  } });
  assert.equal(view.document.getElementById('wiki-input-merge-repo.repo').value, 'C:/工作區 with spaces/service');
  assert.equal(view.document.getElementById('wiki-input-merge-repo.base').value, 'origin/main');
  assert.equal(view.document.getElementById('wiki-input-merge-repo.head').value, 'origin/feature/from-mr');
  await view.sendBranches(['main']);
  assert.equal(view.document.getElementById('wiki-input-merge-repo.head').value, 'origin/feature/from-mr',
    'refreshing candidates does not discard a branch missing from the local list');
  assert.equal(view.document.querySelector('.wiki-copy-button').disabled, true, 'existing MR confirmation still applies');
  [...view.document.querySelectorAll('button')].find(button => button.textContent === '確認使用分支審查').click(); await view.tick();
  assert.equal(view.document.querySelector('.wiki-copy-button').disabled, false);
});

test('branch list handles reverse keyboard navigation, Tab and outside pointer dismissal', async t => {
  const view = await mount(t, 'group');
  view.document.getElementById('skill-tool-merge-reviewer').click(); await view.tick();
  await view.sendBranches(['main', 'origin/main']);
  const input = view.document.getElementById('wiki-input-merge-repo.base');
  input.dispatchEvent(new view.dom.window.KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true })); await view.tick();
  assert.equal(view.document.getElementById(input.getAttribute('aria-activedescendant')).textContent, 'origin/main');
  input.dispatchEvent(new view.dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); await view.tick();
  assert.equal(input.value, 'origin/main');
  input.focus(); await view.tick();
  input.dispatchEvent(new view.dom.window.KeyboardEvent('keydown', { key: 'Tab', bubbles: true })); await view.tick();
  assert.equal(input.getAttribute('aria-expanded'), 'false');
  input.closest('.skills-branch-input').querySelector('button').click(); await view.tick();
  view.document.body.dispatchEvent(new view.dom.window.Event('pointerdown', { bubbles: true })); await view.tick();
  assert.equal(input.getAttribute('aria-expanded'), 'false');
  assert.equal(input.value, 'origin/main');
  await view.change('[id="wiki-input-merge-repo.base"]', 'manual/unmatched', 'input');
  input.dispatchEvent(new view.dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); await view.tick();
  input.dispatchEvent(new view.dom.window.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })); await view.tick();
  assert.equal(view.document.getElementById(input.getAttribute('aria-activedescendant')).textContent, 'main');
  input.dispatchEvent(new view.dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); await view.tick();
  assert.equal(input.value, 'main', 'the first ArrowDown after reopening clears the filter and selects the first candidate');
});
