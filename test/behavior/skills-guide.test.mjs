import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { JSDOM, VirtualConsole } from 'jsdom';

const html = await readFile(new URL('../../resources/issue-webview/dashboard.html', import.meta.url), 'utf8');
const script = await readFile(new URL('../../resources/issue-webview/dashboard.js', import.meta.url), 'utf8');
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
      repositories: [repo], groupMatch: { status: profile === 'group' ? 'matched' : 'unverified',
        root: profile === 'group' ? root : undefined, repositories: [repo] } }
  };
}

async function mount(t, profile, saved, features) {
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
  dom.window.dispatchEvent(new dom.window.MessageEvent('message', { data: { type: 'snapshot', snapshot: snapshot(profile, features) } }));
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
  return { dom, document, requests, tick, change, sendSnapshot, holdOperations: () => { holdOperations = true; }, get savedState() { return state; } };
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
  for (const [field, value] of [['repo', 'private-service'], ['base', 'private-base'], ['head', 'private-head']]) {
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
  if (profile === 'group') await change('[id="wiki-input-merge-repo.repo"]','service','input');
  await change('[id="wiki-input-merge-repo.base"]','main','input');
  await change('[id="wiki-input-merge-repo.head"]','feature/review','input');
  assert.equal(document.querySelector('.wiki-copy-button').disabled,false);
  assert.match(document.querySelector('.wiki-prompt-preview').textContent,/merge-reviewer-workspace-context\/v3/);
  assert.match(document.querySelector('.wiki-prompt-preview').textContent,/<base-commit前8碼>-<head-commit前8碼>\.md/);
  assert.match(document.querySelector('.wiki-prompt-preview').textContent,/比較資訊/);
  document.querySelector('.wiki-copy-button').click(); await view.tick();
  const copy=view.requests.findLast(request => request.type==='copySkillGuidePrompt');
  assert.equal(copy.featureId,'merge-repo'); assert.equal(copy.inputs['merge-repo.head'],'feature/review');
  assert.equal(view.requests.some(request => request.type==='openCodexTerminal'),false);
  document.querySelector('.skills-codex-button').click(); await view.tick();
  assert.equal(view.requests.findLast(request => request.type==='openCodexTerminal').revision,`${profile}-revision`);
  const reopened=await mount(t,profile,view.savedState);
  assert.equal(reopened.document.querySelector('[id="wiki-input-merge-repo.head"]').value,'feature/review');
});

test('copy feedback blocks duplicate clicks, allows retry and ignores obsolete environment receipts', async t => {
  const view=await mount(t,'group'); view.document.getElementById('skill-tool-merge-reviewer').click(); await view.tick();
  for (const [field,value] of [['repo','service'],['base','main'],['head','feature/review']]) await view.change(`[id="wiki-input-merge-repo.${field}"]`,value,'input');
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
