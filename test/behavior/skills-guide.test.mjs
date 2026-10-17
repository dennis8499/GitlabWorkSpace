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
    localRepositories: {}, projectLocalRepositories: {}, projectMembers: [], timers: [], deliveryRecords: [], tools: [],
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
  return { dom, document, requests, tick, change, holdOperations: () => { holdOperations = true; }, get savedState() { return state; } };
}

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

for (const profile of ['group', 'repository']) test(`${profile} Export Megin Spec unifies generation and existing specs with durable drafts`, async t => {
  const features = ['megin-spec-export'];
  const view = await mount(t, profile, undefined, features);
  const { document, change } = view;
  assert.ok(document.getElementById('skill-feature-megin-spec-export'));
  assert.equal(document.querySelectorAll('[role="tab"][id^="skill-tool-"]').length,4);
  assert.equal(document.querySelector('.wiki-guide-card h2').textContent, 'Export Megin Spec');
  assert.equal(document.querySelector('[aria-label="Skills Repo"]'), null);
  assert.equal(document.querySelector('[id="wiki-input-development-spec.delivery"]'), null);
  const feature = '[id="wiki-input-megin-spec-export.feature"]';
  const requirement = '[id="wiki-input-megin-spec-export.requirement"]';
  const spec = '[id="wiki-input-megin-spec-export.existingSpec"]';
  assert.equal(document.querySelector('.wiki-copy-button').disabled, true);
  await change(feature, '退款', 'input');
  assert.equal(document.querySelector('.wiki-copy-button').disabled, true);
  await change(requirement, '客服可發起退款。\n重複操作不得重複退款。', 'input');
  assert.equal(document.querySelector('.wiki-copy-button').disabled, false);
  const preview = document.querySelector('.wiki-prompt-preview').textContent;
  assert.match(preview, /development_spec.*不依賴 Wiki、BA／SA／SD.*exports\/megin\//s);
  document.querySelector('.wiki-copy-button').click(); await view.tick();
  const copied = view.requests.at(-1);
  assert.equal(copied.type, 'copySkillGuidePrompt');
  assert.equal(copied.featureId, 'megin-spec-export');
  assert.equal(copied.revision, `${profile}-revision`);
  assert.equal(copied.inputs['megin-spec-export.feature'], '退款');
  assert.equal(view.requests.some(item => item.type === 'openCodexTerminal'), false);
  await change(feature, '', 'input'); await change(requirement, '', 'input');
  await change(spec, 'wiki/synthesis/refund-development-spec.md', 'input');
  assert.equal(document.querySelector(feature).required, false);
  assert.equal(document.querySelector(requirement).required, false);
  assert.equal(document.querySelector('.wiki-copy-button').disabled, false);
  assert.match(document.querySelector('.wiki-prompt-preview').textContent, /既有規格.*refund-development-spec\.md.*既有 draft 或過時規格/s);
  const reopened = await mount(t, profile, view.savedState, features);
  assert.equal(reopened.document.querySelector(spec).value, 'wiki/synthesis/refund-development-spec.md');
  assert.equal(reopened.document.querySelector('.wiki-copy-button').disabled, false);
  await reopened.change(spec, '', 'input');
  assert.equal(reopened.document.querySelector(feature).required, true);
  assert.equal(reopened.document.querySelector('.wiki-copy-button').disabled, true);
});

for (const profile of ['group', 'repository']) test(`${profile} legacy development draft reopens in Export Megin Spec without another draft's path`, async t => {
  const scope = `project:${snapshot(profile).skillsContext.root}:${profile}`;
  const saved = { mode: 'sa', projectGuideScope: scope,
    wikiGuideSelectionsByScope: { [scope]: 'development-spec' },
    wikiGuideInputsByScope: { [scope]: { 'development-spec.scope': '退款', 'development-spec.requirement': '既有退款草稿',
      'megin-spec-export.spec': 'wiki/synthesis/unrelated.md', 'megin-spec-export.scope': 'unrelated' } } };
  const view = await mount(t, profile, saved, ['megin-spec-export']);
  assert.equal(view.document.querySelector('[id="wiki-input-megin-spec-export.feature"]').value, '退款');
  assert.equal(view.document.querySelector('[id="wiki-input-megin-spec-export.requirement"]').value, '既有退款草稿');
  assert.equal(view.document.querySelector('[id="wiki-input-megin-spec-export.existingSpec"]').value, '');
  assert.equal(view.document.querySelector('.wiki-copy-button').disabled, false);
  const reopened = await mount(t, profile, view.savedState, ['megin-spec-export']);
  assert.equal(reopened.document.querySelector('[id="wiki-input-megin-spec-export.feature"]').value, '退款');
});
