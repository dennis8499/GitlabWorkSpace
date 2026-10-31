const { operationResource } = await import('../../out/src/workspace/operations.js');
const { describeAction } = await import('../../out/src/workspace/actionPolicy.js');
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { JSDOM, VirtualConsole } from 'jsdom';

import { webviewBundle } from './webview-bundle.mjs';
const { html, script } = await webviewBundle('dashboard');
const dashboardCss = await readFile(new URL('../../src/webview/dashboard.css', import.meta.url), 'utf8');

test('Issue empty states distinguish initial loading, failure, partial and confirmed empty without new reads', async t => {
  const data = { ...snapshot(), issues: [], sections: { issues: { status: 'loading' } } };
  const view = await mount({}, data); t.after(() => view.dom.window.close());
  const text = () => view.dom.window.document.querySelector('.developer-view-shell .empty-inline').textContent;
  assert.match(text(), /正在載入指派給你的 Issue/); assert.doesNotMatch(text(), /目前沒有指派|Group 沒有指派/);
  const count = view.requests.length;
  view.sendSnapshot({ ...data, sections: { issues: { status: 'error', error: 'Offline fixture' } } }); await view.tick();
  assert.match(text(), /Issue 載入失敗.*Offline fixture/s); assert.doesNotMatch(text(), /Group 沒有指派/);
  view.sendSnapshot({ ...data, sections: { issues: { status: 'ready', complete: false } } }); await view.tick();
  assert.match(text(), /目前已載入.*尚未完整/s);
  view.sendSnapshot({ ...data, sections: { issues: { status: 'ready', complete: true } } }); await view.tick();
  assert.match(text(), /目前沒有指派給你的 Issue/);
  assert.equal(view.requests.length, count);
});

test('MR saved role is sent on readiness and role changes request the selected server scope once', async t => {
  const view = await mount({ mode: 'reviewer', reviewFilter: 'reviewer' }, snapshot('reviewer')); t.after(() => view.dom.window.close());
  assert.equal(view.requests[0].mergeRequestFilter, 'reviewer');
  const button = [...view.dom.window.document.querySelectorAll('.filter-tabs button')].find(item => item.textContent === '指派給我');
  button.click(); await view.tick(); button.click(); await view.tick();
  assert.deepEqual(view.requests.filter(item => item.type === 'setMergeRequestFilter'), [{ type: 'setMergeRequestFilter', filter: 'assigned', connectedScope: 'team-scope' }]);
  assert.equal(button.getAttribute('aria-pressed'), 'true');
});

test('MR merge control follows Host availability and offers an explicit recheck', async t => {
  const data = snapshot('reviewer');
  const request = { id: 41, iid: 4, project_id: 1, title: 'MR', state: 'opened', source_branch: 'feature', target_branch: 'main',
    web_url: 'https://gitlab.test/team/a/-/merge_requests/4', diff_refs: { head_sha: gitHead } };
  data.mergeRequests = [request];
  data.selectedMergeRequest = { request, diffs: [], discussions: [], sections: { diffs: { status: 'ready' }, discussions: { status: 'idle' } },
    freshness: { state: 'not_checked' }, sourceSha: gitHead, mergeAvailability: { status: 'unknown', reason: 'Permission not confirmed' } };
  const view = await mount({ mode: 'reviewer' }, data); t.after(() => view.dom.window.close());
  const document = view.dom.window.document;
  [...document.querySelectorAll('.review-tabs button')].find(button => button.textContent === '審查報告').click(); await view.tick();
  const merge = () => [...document.querySelectorAll('button')].find(button => button.textContent === '合併 MR');
  assert.equal(merge().disabled, true); assert.match(document.body.textContent, /Permission not confirmed/);
  [...document.querySelectorAll('button')].find(button => button.textContent === '重新檢查合併條件').click(); await view.tick();
  assert.equal(view.requests.filter(item => item.type === 'refreshMergeRequest').length, 1);
  view.sendSnapshot({ ...data, selectedMergeRequest: { ...data.selectedMergeRequest, mergeAvailability: { status: 'allowed' } } }); await view.tick();
  assert.equal(merge().disabled, false); merge().click(); await view.tick();
  assert.equal(view.requests.filter(item => item.type === 'mergeMergeRequest').length, 1);
});

test('MR section reentry asks the Host to apply TTL once while snapshots and failed sections remain quiet', async t => {
  const data = snapshot('reviewer'), request = { id: 41, iid: 4, project_id: 1, title: 'TTL fixture', state: 'opened', source_branch: 'feature', target_branch: 'main', diff_refs: { head_sha: gitHead, base_sha: gitParent } };
  data.mergeRequests = [request]; data.selectedMergeRequest = { request, diffs: [], discussions: [], sections: { diffs: { status: 'ready' }, discussions: { status: 'error', error: 'Fixture error' } }, freshness: { state: 'not_checked' }, sourceSha: gitHead, targetSha: gitParent };
  const view = await mount({ mode: 'reviewer' }, data); t.after(() => view.dom.window.close());
  const reads = () => view.requests.filter(item => item.type === 'loadMergeRequestSection');
  assert.equal(reads().length, 1, 'ready sections still need a TTL decision on entry');
  for (let index = 0; index < 3; index++) { view.sendSnapshot(data); await view.tick(); }
  assert.equal(reads().length, 1);
  const tab = label => [...view.dom.window.document.querySelectorAll('.review-tabs button')].find(item => item.textContent === label);
  tab('討論').click(); await view.tick(); assert.equal(reads().length, 1, 'a previous error never retries automatically');
  tab('變更').click(); await view.tick(); assert.equal(reads().length, 2);
  view.sendSnapshot({ ...data, activeMode: 'sa' }); await view.tick(); view.sendSnapshot(data); await view.tick();
  assert.equal(reads().length, 3);
  const changed = { ...data, selectedMergeRequest: { ...data.selectedMergeRequest, sourceSha: 'c'.repeat(40) } };
  view.sendSnapshot(changed); await view.tick(); assert.equal(reads().length, 4, 'a different diff version establishes a new demand identity');
});

test('Issue filter chips clear local search without requesting remote data', async t => {
  const view = await mount({}, snapshot()); t.after(() => view.dom.window.close());
  const input = view.dom.window.document.querySelector('input[aria-label="搜尋 Issue"]');
  input.value = 'no matching issue'; input.dispatchEvent(new view.dom.window.Event('input', { bubbles: true })); await view.tick();
  const before = view.requests.length;
  view.dom.window.document.querySelector('[aria-label="清除 Issue 搜尋"]').click(); await view.tick();
  assert.equal(view.dom.window.document.querySelector('input[aria-label="搜尋 Issue"]').value, '');
  assert.equal(view.dom.window.document.querySelectorAll('.work-row').length, 3);
  assert.equal(view.requests.length, before);
});

test('freshness expiration and cooldown countdown change presentation without automatic requests', async t => {
  let clock;
  const data = { ...snapshot(), sections: { issues: { status: 'ready', dataSource: 'cache', fetchedAt: 1000, expiresAt: 60000, transportStage: 'cooldown', retryAt: 5000 } } };
  const view = await mount({}, data, {}, window => { clock = snackbarClock(window); }); t.after(() => view.dom.window.close());
  const document = view.dom.window.document, before = view.requests.length;
  assert.match(document.querySelector('.data-freshness').textContent, /使用快取.*資料取得於/s);
  assert.match(document.querySelector('.transport-status').textContent, /5 秒後可重試/);
  clock.advance(60000); await view.tick();
  assert.match(document.querySelector('.data-freshness').textContent, /下次需要時更新/);
  assert.match(document.querySelector('.transport-status').textContent, /暫停時間已到/);
  assert.equal(view.requests.length, before);
});

test('drawer exit retains its focus boundary, clears unsent Tokens immediately and does not reload on snapshots', async t => {
  const view = await mount({}, snapshot(), {}, window => {
    window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
    Object.defineProperty(window.HTMLElement.prototype, 'onanimationend', { configurable: true, writable: true, value: null });
  }); t.after(() => view.dom.window.close());
  const document = view.dom.window.document, trigger = document.querySelector('.settings-trigger');
  trigger.focus(); trigger.click(); await view.tick();
  document.querySelector('#settings-tab-accounts').click(); await view.tick();
  document.querySelector('.accounts-heading button').click(); await view.tick();
  document.querySelector('.account-login').requestSubmit(); await view.tick();
  const token = document.querySelector('[name="token"]'); token.value = 'unsent-fixture-token'; token.dispatchEvent(new view.dom.window.Event('input', { bubbles: true })); await view.tick();
  const reads = view.requests.filter(item => item.type === 'refreshWorkflowKit').length;
  document.querySelector('.drawer-heading > button').click(); await view.tick();
  const overlay = document.querySelector('.drawer-scrim');
  assert.equal(overlay.dataset.presence, 'exiting');
  assert.equal(document.querySelector('[name="token"]').value, '');
  view.sendSnapshot(snapshot()); await view.tick();
  assert.equal(view.requests.filter(item => item.type === 'refreshWorkflowKit').length, reads);
  document.dispatchEvent(new view.dom.window.KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true, cancelable: true }));
  assert.ok(document.querySelector('.tool-drawer').contains(document.activeElement));
  overlay.dispatchEvent(new view.dom.window.Event('animationend', { bubbles: true })); await view.tick();
  assert.equal(document.querySelector('.tool-drawer'), null); assert.equal(document.activeElement, trigger);
  assert.equal(view.requests.some(item => item.type === 'submitAccountLogin'), false);
});

test('hidden Issue views do not announce readiness on any workspace page without navigation', async t => {
  for (const mode of ['clone', 'developer', 'reviewer', 'sa', 'bmad', 'git']) {
    const view = await mount({ mode }, snapshot(mode));
    t.after(() => view.dom.window.close());
    assert.equal(view.requests.some(request => request.type === 'issueRequest' && request.request.type === 'ready'), false, mode);
    view.sendSnapshot(snapshot(mode)); await view.tick();
    assert.equal(view.requests.some(request => request.type === 'issueRequest' && request.request.type === 'ready'), false, `${mode} snapshot`);
  }
});

test('Issue activation announces readiness once and preserves a comment while another workspace page is visible', async t => {
  const data = snapshot();
  const view = await mount({ mode: 'developer' }, data); t.after(() => view.dom.window.close());
  const readiness = () => view.requests.filter(request => request.type === 'issueRequest' && request.request.type === 'ready');
  assert.equal(readiness().length, 0);
  const navigation = { mode: 'detail', projectId: 1, issueIid: 1, revision: 1 };
  view.send({ type: 'issueNavigation', navigation }); await view.tick();
  assert.equal(readiness().length, 1);
  assert.equal(readiness()[0].revision, 1);
  const response = { type: 'detailData', data: { ...issueDetailData(data.issues[0], data.projects[0]), canComment: true } };
  view.send({ type: 'issueResponse', revision: 1, response }); await view.tick();
  const comment = () => view.dom.window.document.querySelector('.issue-embed textarea');
  comment().value = 'Keep this comment draft';
  comment().dispatchEvent(new view.dom.window.Event('input', { bubbles: true })); await view.tick();
  view.sendSnapshot(snapshot('sa')); await view.tick();
  assert.equal(readiness().length, 1, 'hiding the editor never resumes its Host reads');
  view.sendSnapshot(data); await view.tick();
  assert.equal(readiness().length, 2, 'returning to the active Issue resumes it once');
  view.send({ type: 'issueResponse', revision: 1, response }); await view.tick();
  assert.equal(comment().value, 'Keep this comment draft');
  view.sendSnapshot(data); await view.tick();
  assert.equal(readiness().length, 2, 'ordinary snapshots do not repeat readiness');
  view.send({ type: 'issueNavigation', navigation: null }); await view.tick();
  assert.equal(readiness().length, 2, 'closing navigation does not announce a new Issue form');
});

test('page entry describes its source and local refresh keeps Group controls and remote reads out of local projects', async t => {
  const data = { ...snapshot('clone'), localOperationScope: 'local-root' };
  const view = await mount({ mode: 'clone', projectSource: 'local', developerView: 'graph' }, data);
  t.after(() => view.dom.window.close());
  const document = view.dom.window.document;
  assert.deepEqual(view.requests[0], { type: 'ready', projectSource: 'local', developerView: 'graph' });
  assert.equal(document.querySelector('[aria-label="目前 Group"]'), null);
  assert.equal(document.querySelector('.eyebrow').textContent, '本機工作區');
  assert.equal(view.requests.some(request => request.type === 'selectIssueBoard' || request.type === 'loadIssueGraph'), false);
  [...document.querySelectorAll('.heading-actions button')].find(button => button.textContent === '更新資料').click();
  const refresh = view.rawRequests.findLast(request => request.type === 'refresh');
  assert.equal(refresh.mode, 'clone'); assert.equal(refresh.projectSource, 'local');
  assert.equal(refresh.operationScope, 'local-root');
  [...document.querySelectorAll('.project-tabs button')].find(button => button.textContent === 'GitLab 專案').click();
  await view.tick();
  assert.deepEqual(view.requests.findLast(request => request.type === 'setProjectSource'), { type: 'setProjectSource', source: 'gitlab' });
  assert.ok(document.querySelector('[aria-label="目前 Group"]'));
  [...document.querySelectorAll('.project-tabs button')].find(button => button.textContent === '本機 Repo').click();
  await view.tick();
  view.sendSnapshot({ ...data, connectedScope: 'another-group', group: data.groups[1] }); await view.tick();
  assert.equal(view.savedState.projectSource, 'local');
  assert.equal(document.querySelector('[aria-label="目前 Group"]'), null);
});

test('local tools remain independent of Group and do not lazily read hidden remote content', async t => {
  for (const mode of ['sa', 'bmad', 'git']) {
    const data = { ...snapshot(mode), localOperationScope: 'local-root' };
    const request = { project_id: 1, iid: 9 };
    data.selectedMergeRequest = { request, diffs: [], discussions: [], sections: { diffs: { status: 'idle' }, discussions: { status: 'idle' } } };
    const view = await mount({ mode, developerView: 'graph', issueBoardId: 31 }, data);
    t.after(() => view.dom.window.close());
    assert.equal(view.dom.window.document.querySelector('[aria-label="目前 Group"]'), null, mode);
    assert.equal(view.requests.some(request => ['selectIssueBoard', 'loadIssueGraph', 'loadMergeRequestSection', 'loadIssueRelations'].includes(request.type)), false, mode);
  }
});

test('graph entry reports visibility and leaves initial graph loading to the Host', async t => {
  const data = snapshot();
  const view = await mount({ mode: 'developer', scopeKey: 'team-scope', developerView: 'graph' }, data);
  t.after(() => view.dom.window.close());
  assert.equal(view.requests[0].developerView, 'graph');
  assert.equal(view.requests.filter(request => request.type === 'setIssueGraphVisibility' && request.visible).length, 1);
  assert.equal(view.requests.filter(request => request.type === 'loadIssueGraph').length, 0);
});

test('partial lists disclose their search coverage, offer continuation and send cancellation outside the running read lifecycle', async t => {
  const data = { ...snapshot(), sections: {
    projects: { status: 'ready', complete: false, loadedCount: 2, updatedAt: Date.now() },
    issues: { status: 'ready', complete: false, loadedCount: 2, includeClosed: false, updatedAt: Date.now() }
  } };
  const view = await mount({ mode: 'developer' }, data); t.after(() => view.dom.window.close());
  const document = view.dom.window.document;
  const notice = () => [...document.querySelectorAll('.section-status')].find(element => element.textContent.includes('指派 Issue'));
  assert.match(notice().textContent, /尚未完整.*已載入資料/s);
  [...notice().querySelectorAll('button')].find(button => button.textContent === '載入更多').click(); await view.tick();
  assert.deepEqual(view.requests.findLast(request => request.type === 'retryWorkspaceSection'), { type: 'retryWorkspaceSection', section: 'issues', connectedScope: 'team-scope', mode: 'next' });
  view.sendSnapshot({ ...data, sections: { ...data.sections, issues: { ...data.sections.issues, refreshing: true } } }); await view.tick();
  [...notice().querySelectorAll('button')].find(button => button.textContent === '取消載入').click(); await view.tick();
  const cancel = view.rawRequests.findLast(request => request.type === 'retryWorkspaceSection');
  assert.equal(cancel.mode, 'cancel'); assert.equal(cancel.operationId, undefined);
});

test('local discovery offers a continuation without discarding already discovered repositories', async t => {
  const data = { ...snapshot('clone'), repositoryScan: { status: 'partial', checkedDirectories: 10_000, repositories: [], errors: [], excludes: ['.git'], canResume: true, remainingDirectories: 125, pausedReason: '本批已達掃描預算。' } };
  const view = await mount({ mode: 'clone', projectSource: 'local' }, data); t.after(() => view.dom.window.close());
  const document = view.dom.window.document;
  assert.match(document.querySelector('.local-repositories-panel').textContent, /待掃描 125 個資料夾/);
  [...document.querySelectorAll('.local-repositories-panel button')].find(button => button.textContent === '繼續掃描').click(); await view.tick();
  assert.equal(view.requests.findLast(request => request.type === 'scanRepositories').resume, true);
});

test('Git reentry rereads the selected Repo once without replaying writes or losing its draft', async t => {
  const view = await mountGit(t);
  const document = view.dom.window.document;
  const draft = document.querySelector('.git-commit-composer textarea');
  draft.value = 'Keep this commit draft'; draft.dispatchEvent(new view.dom.window.Event('input', { bubbles: true }));
  await view.tick();
  view.sendSnapshot(snapshot('sa')); await view.tick();
  view.sendSnapshot(snapshot('git')); await view.tick();
  assert.equal(gitActions(view, 'open').length, 2);
  assert.equal(gitActions(view, 'open').at(-1).action.refresh, undefined, 'page entry performs a fresh local read');
  assert.equal(gitActions(view, 'commit').length, 0);
  assert.equal(document.querySelector('.git-commit-composer textarea').value, 'Keep this commit draft');
  view.sendSnapshot(snapshot('git')); await view.tick();
  assert.equal(gitActions(view, 'open').length, 2, 'ordinary snapshots do not trigger another read');
});

test('local action refresh errors retry only the currently visible local page', async t => {
  const data = { ...snapshot('clone'), operationScope: 'remote-group', localOperationScope: 'local-root' };
  const view = await mount({ mode: 'clone', projectSource: 'local' }, data); t.after(() => view.dom.window.close());
  view.send({ type: 'operationChanged', operation: { requestId: 'local-refresh-error', scopeRevision: 'local-root',
    resourceKey: 'repositories', action: 'scanRepositories', label: '掃描 Repo', kind: 'write', status: 'succeeded',
    effect: 'applied', refreshError: 'Cannot reload inventory', phase: '已完成', startedAt: 1, finishedAt: 2 } });
  await view.tick();
  [...view.dom.window.document.querySelectorAll('.workspace-operation-area button')].find(button => button.textContent === '重新載入').click();
  const refresh = view.rawRequests.findLast(request => request.type === 'refresh');
  assert.equal(refresh.operationScope, 'local-root');
  assert.equal(refresh.mode, 'clone'); assert.equal(refresh.projectSource, 'local');
});

test('responsiveness: internal comment drafts preserve their visibility across Issues and Webview recreation', async t => {
  const data = snapshot();
  const open = async (view, index, revision) => {
    const issue = data.issues[index];
    view.send({ type: 'issueNavigation', navigation: { mode: 'detail', projectId: issue.project_id, issueIid: issue.iid, revision } });
    await view.tick();
    view.send({ type: 'issueResponse', revision, response: { type: 'detailData', data: { ...issueDetailData(issue, data.projects[index]), canComment: true, canInternalComment: true } } });
    await view.tick();
  };
  const checkbox = view => [...view.dom.window.document.querySelectorAll('.issue-embed label')].find(label => label.textContent.includes('內部留言')).querySelector('input');
  const comment = view => view.dom.window.document.querySelector('.issue-embed textarea');
  const view = await mount({ mode: 'developer' }, data); t.after(() => view.dom.window.close());
  await open(view, 0, 1);
  comment(view).value = 'Internal conversation draft'; comment(view).dispatchEvent(new view.dom.window.Event('input', { bubbles: true }));
  checkbox(view).click();
  assert.equal(view.savedState.issueEditorDrafts['instance-user'].conversations[101].internal, true, 'the final visibility change is saved synchronously');
  await open(view, 1, 2);
  assert.equal(checkbox(view).checked, false);
  await open(view, 0, 3);
  assert.equal(comment(view).value, 'Internal conversation draft');
  assert.equal(checkbox(view).checked, true);
  const saved = structuredClone(view.savedState);
  saved.issueEditorDrafts['instance-user'].conversations[102] = { comment: 'Legacy public draft', reply: {} };
  view.dom.window.close();
  const restored = await mount(saved, data); t.after(() => restored.dom.window.close());
  await open(restored, 0, 4);
  assert.equal(comment(restored).value, 'Internal conversation draft');
  assert.equal(checkbox(restored).checked, true);
  await open(restored, 1, 5);
  assert.equal(comment(restored).value, 'Legacy public draft');
  assert.equal(checkbox(restored).checked, false, 'legacy drafts retain the public default');
});

test('responsiveness: repeated Home and ArrowUp focus requests work after pointer or Tab focus', async t => {
  const view = await mount({ mode: 'developer' }, snapshot()); t.after(() => view.dom.window.close());
  const document = view.dom.window.document;
  const list = document.querySelector('.work-list');
  Object.defineProperty(list, 'clientHeight', { configurable: true, value: 400 });
  const rows = [...list.querySelectorAll('.work-row')];
  rows[2].focus();
  rows[2].dispatchEvent(new view.dom.window.KeyboardEvent('keydown', { key: 'Home', bubbles: true, cancelable: true }));
  await view.tick();
  assert.equal(document.activeElement, rows[0]);
  assert.equal(list.scrollTop, 0);
  rows[1].focus();
  rows[1].dispatchEvent(new view.dom.window.KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true, cancelable: true }));
  await view.tick();
  assert.equal(document.activeElement, rows[0], 'requesting index zero again still moves focus');
  assert.equal(list.scrollTop, 0);
});

test('responsiveness: cancel editing discards only the current Issue form and preserves other drafts and unknown writes', async t => {
  const data = snapshot(); data.issues[0].description = 'Server description';
  const otherForm = { title: 'Other draft', description: 'Keep other description', assigneeId: '', labels: [], milestoneId: '', dueDate: '', startDate: '', confidential: false, discussionLocked: false };
  const submission = { issueId: 102, projectId: 2, issueIid: 2, action: 'note', replyId: null, submission: { body: 'Verify previous write', taskTitle: '', taskDescription: '' }, form: null, creating: false, resourceKey: 'issue:2:2', scopeRevision: 'team-scope:root-team' };
  const saved = { mode: 'developer', issueEditorDrafts: { 'instance-user': {
    create: { 2: otherForm }, issues: { 102: otherForm }, conversations: { 101: { comment: 'Keep conversation', reply: { thread: 'Keep reply' }, internal: true } },
    uncertain: { 'unknown-prior': { ...submission, operationId: 'unknown-prior' } }, pending: { 'pending-prior': { ...submission, operationId: 'pending-prior' } }
  } } };
  const view = await mount(saved, data); t.after(() => view.dom.window.close());
  view.send({ type: 'issueNavigation', navigation: { mode: 'detail', projectId: 1, issueIid: 1, revision: 1 } }); await view.tick();
  view.send({ type: 'issueResponse', revision: 1, response: { type: 'detailData', data: { ...issueDetailData(data.issues[0], data.projects[0]), canEdit: true, canComment: true, canInternalComment: true } } }); await view.tick();
  const document = view.dom.window.document;
  const edit = () => [...document.querySelectorAll('.issue-embed button')].find(button => button.textContent === '編輯需求' || button.textContent === '取消編輯');
  const title = () => document.querySelector('.issue-embed input[placeholder="簡要描述工作內容"]');
  const description = () => document.querySelector('.issue-embed textarea[rows="12"]');
  edit().click(); await view.tick();
  title().value = 'Cancelled title'; title().dispatchEvent(new view.dom.window.Event('input', { bubbles: true }));
  await view.tick();
  description().value = 'Cancelled description'; description().dispatchEvent(new view.dom.window.Event('input', { bubbles: true }));
  const before = structuredClone(view.savedState.issueEditorDrafts['instance-user']);
  assert.equal(before.issues[101].title, 'Cancelled title');
  edit().click();
  const after = view.savedState.issueEditorDrafts['instance-user'];
  assert.equal(after.issues[101], undefined, 'explicit cancellation clears the current draft synchronously');
  assert.deepEqual(after.issues[102], before.issues[102]);
  assert.deepEqual(after.create, before.create);
  assert.deepEqual(after.conversations, before.conversations);
  assert.deepEqual(after.uncertain, before.uncertain);
  assert.deepEqual(after.pending, before.pending);
  await view.tick(); edit().click(); await view.tick();
  assert.equal(title().value, data.issues[0].title);
  assert.equal(description().value, 'Server description');
});

test('responsiveness: 100 refreshes acknowledge locally before Host receipts and restore their control on completion', async t => {
  const view = await mount({ mode: 'developer' }, snapshot(), {}, () => {}, { autoOperations: false });
  t.after(() => view.dom.window.close());
  const refresh = () => [...view.dom.window.document.querySelectorAll('.heading-actions button')].find(button => /更新/.test(button.textContent));
  for (let index = 0; index < 100; index++) {
    refresh().click(); await view.tick();
    const request = view.rawRequests.findLast(request => request.type === 'refresh');
    assert.ok(request?.operationId);
    assert.equal(refresh().disabled, true, 'the initiating control acknowledges a locally queued refresh without waiting for the Host');
    assert.equal(refresh().getAttribute('aria-busy'), 'true');
    assert.match(refresh().textContent, /正在更新/);
    refresh().click();
    assert.equal(view.rawRequests.filter(request => request.type === 'refresh').length, index + 1);
    view.receipt(request, { status: 'running', effect: 'none' }); await view.tick();
    assert.equal(refresh().disabled, true);
    view.receipt(request, { status: 'succeeded', effect: 'none' }); await view.tick();
    assert.equal(refresh().disabled, false);
    assert.equal(refresh().getAttribute('aria-busy'), 'false');
    assert.equal(refresh().textContent, '更新資料');
  }
});

test('responsiveness: current operations and unknown writes stay visible ahead of older failed categories', async t => {
  const view = await mount({ mode: 'developer' }, { ...snapshot(), operationScope: 'feedback-scope' }, {}, () => {}, { autoOperations: false });
  t.after(() => view.dom.window.close());
  const send = operation => view.send({ type: 'operationChanged', operation: { scopeRevision: 'feedback-scope', kind: 'read', effect: 'none', phase: 'Feedback', ...operation } });
  send({ requestId: 'old-refresh', resourceKey: 'refresh', lockKey: 'refresh', action: 'refresh', label: 'Old refresh', status: 'succeeded', startedAt: 1, finishedAt: 2 });
  for (const [label, startedAt, finishedAt] of [['Failure A', 10, 80], ['Failure B', 20, 60], ['Failure C', 30, 40]]) {
    send({ requestId: label, resourceKey: label, lockKey: label, action: label, label, status: 'failed', startedAt, finishedAt });
  }
  send({ requestId: 'current-refresh', resourceKey: 'refresh', lockKey: 'refresh', action: 'refresh', label: 'Current refresh', status: 'running', startedAt: 50 });
  await view.tick();
  const area = () => view.dom.window.document.querySelector('.workspace-operation-area');
  const labels = () => [...area().querySelectorAll('.operation-status strong')].map(element => element.textContent);
  assert.deepEqual(labels(), ['Current refresh', 'Failure A', 'Failure B'], 'active feedback takes priority and terminal feedback follows actual completion time');
  send({ requestId: 'unknown-write', resourceKey: 'unknown-write', lockKey: 'unknown-write', action: 'updateUnknown', label: 'Verify unknown write', kind: 'write', status: 'failed', effect: 'unknown', startedAt: 3, finishedAt: 4 });
  await view.tick();
  assert.deepEqual(labels(), ['Verify unknown write', 'Current refresh', 'Failure A']);
  assert.match(area().textContent, /核對寫入結果/);
  send({ requestId: 'Failure A', resourceKey: 'Failure A', lockKey: 'Failure A', action: 'Failure A', label: 'Failure A', status: 'failed', startedAt: 10, finishedAt: 80, revision: 100 });
  send({ requestId: 'Failure B', resourceKey: 'Failure B', lockKey: 'Failure B', action: 'Failure B', label: 'Failure B', status: 'failed', startedAt: 20, finishedAt: 60, revision: 101 });
  await view.tick();
  assert.deepEqual(labels(), ['Verify unknown write', 'Current refresh', 'Failure B'], 'same-Host revisions preserve actual receipt update order');
});

test('responsiveness: Issue relations load once on their tab and never loop after a reply or unrelated render', async t => {
  const data = snapshot();
  const view = await mount({ mode: 'developer' }, data); t.after(() => view.dom.window.close());
  view.send({ type: 'issueNavigation', navigation: { mode: 'detail', projectId: 1, issueIid: 1, revision: 1 } });
  await view.tick();
  const detail = issueDetailData(data.issues[0], data.projects[0]);
  view.send({ type: 'issueResponse', revision: 1, response: { type: 'detailData', data: detail } }); await view.tick();
  const reads = () => view.requests.filter(request => request.type === 'loadIssueRelations');
  assert.equal(reads().length, 0, 'Content does not load relations');
  [...view.dom.window.document.querySelectorAll('.issue-embed [role="tab"]')].find(tab => /關聯/.test(tab.textContent)).click(); await view.tick();
  assert.equal(reads().length, 1);
  const request = reads()[0];
  view.send({ ...request, type: 'issueRelations', data: detail }); await view.tick(); await view.tick();
  assert.equal(reads().length, 1, 'a reply does not trigger another read');
  view.sendSnapshot({ ...data }); await view.tick();
  assert.equal(reads().length, 1, 'an unrelated root render does not trigger another read');
});

test('responsiveness: lazy activity patches render new Markdown once and reconcile edits', async t => {
  const data = snapshot(), view = await mount({ mode: 'developer' }, data); t.after(() => view.dom.window.close());
  view.send({ type: 'issueNavigation', navigation: { mode: 'detail', projectId: 1, issueIid: 1, revision: 1 } }); await view.tick();
  view.send({ type: 'issueResponse', revision: 1, response: { type: 'detailData', data: issueDetailData(data.issues[0], data.projects[0]) } }); await view.tick();
  const patch = body => ({ type: 'issueResponse', revision: 1, response: { type: 'detailPatch', issueId: 101,
    patch: { discussions: [{ id: 'lazy-thread', notes: [{ id: 51, body, author: { id: 7, name: 'Test' }, created_at: '2026-10-17T00:00:00Z' }] }], sections: { activity: 'ready' } } } });
  view.send(patch('**first**')); await view.tick();
  const previews = () => view.requests.filter(request => request.type === 'issueRequest' && request.request.type === 'preview' && request.request.target === 'note:51');
  assert.equal(previews().length, 1);
  view.send(patch('**first**')); await view.tick(); assert.equal(previews().length, 1);
  view.send(patch('**edited**')); await view.tick(); assert.equal(previews().length, 2);
  const latest = previews().at(-1).request;
  view.send({ type: 'issueResponse', revision: 1, response: { type: 'reply', requestId: latest.requestId, result: { html: '<strong>edited</strong>' } } }); await view.tick();
  assert.equal(view.dom.window.document.querySelector('.note .markdown strong')?.textContent, 'edited');
});

test('responsiveness: virtual MR files retain expansion and a stable scroll anchor after refresh', async t => {
  const data = snapshot('reviewer'), request = { id: 41, iid: 4, project_id: 1, title: 'Review', state: 'opened', source_branch: 'feature', target_branch: 'main', web_url: 'https://gitlab.test/team/a/-/merge_requests/4' };
  data.mergeRequests = [request];
  data.selectedMergeRequest = { request, diffs: Array.from({ length: 300 }, (_, index) => ({ old_path: 'file' + index, new_path: 'file' + index, diff: '+x' })), discussions: [],
    sections: { diffs: { status: 'ready' }, discussions: { status: 'ready' } }, warnings: [], freshness: { state: 'not_checked' } };
  const view = await mount({ mode: 'reviewer' }, data); t.after(() => view.dom.window.close());
  const list = view.dom.window.document.querySelector('.diff-list');
  list.querySelector('details').open = true; list.querySelector('details').dispatchEvent(new view.dom.window.Event('toggle')); await view.tick();
  const scroll = async top => { list.scrollTop = top; list.dispatchEvent(new view.dom.window.Event('scroll')); await view.tick(); };
  await scroll(6000); await scroll(0); assert.equal(list.querySelector('details').open, true);
  await scroll(6000);
  view.sendSnapshot({ ...data, selectedMergeRequest: { ...data.selectedMergeRequest, diffs: [...data.selectedMergeRequest.diffs, { old_path: 'new', new_path: 'new', diff: '+new' }] } }); await view.tick();
  assert.equal(list.scrollTop, 6000, 'appending data preserves the first visible item and its offset');
});

test('responsiveness: versioned workspace patches reject gaps, request one resync and preserve independent deltas', async t => {
  const data = { ...snapshot(), operationScope: 'operation-scope' }, view = await mount({ mode: 'developer' }, data); t.after(() => view.dom.window.close());
  const full = (version, snapshot = data, streamId = 'stream-a') => view.send({ type: 'snapshot', streamId, scope: snapshot.operationScope, version, snapshot });
  full(1); await view.tick();
  view.send({ type: 'snapshotPatch', streamId: 'stream-a', scope: 'operation-scope', baseVersion: 1, version: 2,
    changes: { issues: [{ ...data.issues[0], title: 'Patched issue' }], error: 'temporary' }, cleared: [] }); await view.tick();
  assert.equal(view.dom.window.document.querySelector('.work-row .row-title').textContent, 'Patched issue');
  const before = view.requests.filter(request => request.type === 'resyncWorkspace').length;
  const gap = { type: 'snapshotPatch', streamId: 'stream-a', scope: 'operation-scope', baseVersion: 4, version: 5, changes: { issues: [] }, cleared: [] };
  view.send(gap); view.send(gap); await view.tick();
  assert.equal(view.requests.filter(request => request.type === 'resyncWorkspace').length, before + 1);
  assert.equal(view.dom.window.document.querySelector('.work-row .row-title').textContent, 'Patched issue');
  full(6); await view.tick();
  view.send({ type: 'snapshotPatch', streamId: 'stream-a', scope: 'operation-scope', baseVersion: 6, version: 7, changes: { activeMode: 'clone' }, cleared: ['error'] }); await view.tick();
  assert.ok(view.dom.window.document.querySelector('.clone-list-column'));
  full(1, { ...data, activeMode: 'reviewer', operationScope: 'other-operation-scope', connectedScope: 'other-connected-scope' }, 'stream-b'); await view.tick();
  view.send({ type: 'snapshot', streamId: 'stream-a', scope: 'operation-scope', version: 99, snapshot: data }); await view.tick();
  assert.equal(view.dom.window.document.querySelector('.page').dataset.mode, 'reviewer', 'a retired Host stream cannot restore an obsolete workspace');
});

test('responsiveness: large Git refs, changed files and short-line diffs keep bounded DOM and offer native Diff', async t => {
  const branches = Array.from({ length: 600 }, (_, index) => ({ name: 'branch-' + index, kind: 'local', current: index === 0, commit: gitHead }));
  const changes = Array.from({ length: 1000 }, (_, index) => ({ path: 'file-' + index + '.ts', section: 'unstaged', kind: '已修改' }));
  const view = await mountGit(t, {}, gitSnapshot('repo-a', { branches, changes }));
  const document = view.dom.window.document;
  assert.ok(document.querySelectorAll('.git-ref-row').length < 100);
  assert.ok(document.querySelectorAll('.git-change-row').length < 100);
  document.querySelector('.git-change-name').click(); await view.tick();
  const read = gitActions(view, 'readDiff').at(-1);
  await finishGit(view, read, { revision: 2, branches, changes, diffPath: read.action.path, diffStaged: false, diffText: '+short\n context\n'.repeat(2500) });
  assert.ok(document.querySelectorAll('.git-diff-line').length < 100);
  document.querySelector('.git-diff-line input').dispatchEvent(new view.dom.window.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })); await view.tick();
  assert.equal(document.activeElement.closest('[data-virtual-index]').dataset.virtualIndex, '1', 'keyboard navigation can focus a context line without a checkbox');
  view.send({ type: 'gitSnapshot', snapshot: gitSnapshot('repo-a', { revision: 3, branches, changes, diffPath: read.action.path, diffStaged: false, diffText: '+x\n'.repeat(20001) }) }); await view.tick();
  assert.equal(document.querySelectorAll('.git-diff-line').length, 0);
  assert.match(document.querySelector('.git-large-diff').textContent, /20,000/);
  document.querySelector('.git-large-diff button').click();
  assert.equal(view.requests.at(-1).type, 'gitOpenDiff');
});

test('responsiveness: progressive create options preserve the latest draft and pending previews', async t => {
  const data = snapshot(), view = await mount({ mode: 'developer' }, data); t.after(() => view.dom.window.close());
  view.send({ type: 'issueNavigation', navigation: { mode: 'create', revision: 1 } }); await view.tick();
  view.send({ type: 'issueResponse', revision: 1, response: { type: 'createData', projects: data.projects, selectedProjectId: 1,
    options: { members: [], labels: [], milestones: [], templates: [] }, canCreateIssue: false, canSetStartDate: false, optionsLoading: true } }); await view.tick();
  const title = view.dom.window.document.querySelector('.issue-embed input[placeholder="簡要描述工作內容"]');
  title.value = 'Last input before metadata'; title.dispatchEvent(new view.dom.window.Event('input', { bubbles: true }));
  view.send({ type: 'issueResponse', revision: 1, response: { type: 'projectData', projectId: 1, preserveDraft: true, optionsLoading: false,
    options: { members: [], labels: [], milestones: [], templates: [] }, canCreateIssue: true, canSetStartDate: true } }); await view.tick();
  assert.equal(title.value, 'Last input before metadata');
  assert.equal([...view.dom.window.document.querySelectorAll('.issue-embed button')].find(button => button.textContent === '建立 Issue').disabled, false);
});

test('responsiveness: lazy templates respect the latest selection and preserve edits made during loading', async t => {
  const data = snapshot(), view = await mount({ mode: 'developer' }, data); t.after(() => view.dom.window.close());
  view.send({ type: 'issueNavigation', navigation: { mode: 'create', revision: 1 } }); await view.tick();
  view.send({ type: 'issueResponse', revision: 1, response: { type: 'createData', projects: data.projects, selectedProjectId: 1,
    options: { members: [], labels: [], milestones: [], templates: [{ key: 'a.md', name: 'A', content: '', loaded: false }, { name: 'B', content: 'Inline template' }] }, canCreateIssue: true, canSetStartDate: false } }); await view.tick();
  const document = view.dom.window.document, select = document.querySelector('.issue-embed .field-wide select');
  select.value = 'gitlab:a.md'; select.dispatchEvent(new view.dom.window.Event('change', { bubbles: true })); await view.tick();
  const request = view.requests.findLast(request => request.type === 'issueRequest' && request.request.type === 'loadTemplate').request;
  const description = document.querySelector('.issue-embed textarea[rows="8"]');
  description.value = 'New manual description'; description.dispatchEvent(new view.dom.window.Event('input', { bubbles: true }));
  view.send({ type: 'issueResponse', revision: 1, response: { type: 'reply', requestId: request.requestId, result: { name: 'A', content: 'Late template' } } }); await view.tick();
  assert.equal(description.value, 'New manual description');
  select.value = 'gitlab:a.md'; select.dispatchEvent(new view.dom.window.Event('change', { bubbles: true })); await view.tick();
  const second = view.requests.findLast(request => request.type === 'issueRequest' && request.request.type === 'loadTemplate').request;
  select.value = 'gitlab:B'; select.dispatchEvent(new view.dom.window.Event('change', { bubbles: true })); await view.tick();
  view.send({ type: 'issueResponse', revision: 1, response: { type: 'reply', requestId: second.requestId, result: { name: 'A', content: 'Obsolete selection' } } }); await view.tick();
  assert.equal(description.value, 'Inline template');
});

test('responsiveness: attachment cancellation retains drafts and an uncertain upload cannot be resent', async t => {
  const data = snapshot(), view = await mount({ mode: 'developer' }, data, {}, () => {}, { autoOperations: false }); t.after(() => view.dom.window.close());
  view.send({ type: 'issueNavigation', navigation: { mode: 'detail', projectId: 1, issueIid: 1, revision: 1 } }); await view.tick();
  view.send({ type: 'issueResponse', revision: 1, response: { type: 'detailData', data: { ...issueDetailData(data.issues[0], data.projects[0]), canComment: true } } }); await view.tick();
  const document = view.dom.window.document, comment = document.querySelector('.issue-embed textarea[rows="5"]');
  comment.value = 'Keep this draft'; comment.dispatchEvent(new view.dom.window.Event('input', { bubbles: true }));
  const upload = [...document.querySelectorAll('.issue-embed button')].find(button => button.textContent === '上傳附件'); upload.click(); await view.tick();
  const original = view.requests.findLast(request => request.type === 'issueRequest' && request.request.type === 'upload').request;
  [...document.querySelectorAll('.upload-status button')].find(button => button.textContent === '取消上傳').click(); await view.tick();
  const cancel = view.requests.findLast(request => request.type === 'issueRequest' && request.request.type === 'cancelUpload').request;
  assert.equal(cancel.targetRequestId, original.requestId);
  view.send({ type: 'issueResponse', revision: 1, response: { type: 'reply', requestId: original.requestId, effect: 'unknown', error: 'Upload result unknown', notificationOnly: true } }); await view.tick();
  assert.equal(comment.value, 'Keep this draft'); upload.click(); await view.tick();
  assert.equal(view.requests.filter(request => request.type === 'issueRequest' && request.request.type === 'upload').length, 1);
});

test('responsiveness: the last Issue keystroke is durable once without rebuilding workspace state again', async t => {
  const data = snapshot(), view = await mount({ mode: 'developer' }, data); t.after(() => view.dom.window.close());
  view.send({ type: 'issueNavigation', navigation: { mode: 'detail', projectId: 1, issueIid: 1, revision: 1 } }); await view.tick();
  view.send({ type: 'issueResponse', revision: 1, response: { type: 'detailData', data: { ...issueDetailData(data.issues[0], data.projects[0]), canComment: true } } }); await view.tick();
  const comment = view.dom.window.document.querySelector('.issue-embed textarea[rows="5"]'), before = view.stateSaves;
  comment.value = 'Last keystroke'; comment.dispatchEvent(new view.dom.window.Event('input', { bubbles: true }));
  assert.equal(view.savedState.issueEditorDrafts['instance-user'].conversations[101].comment, 'Last keystroke');
  assert.equal(view.stateSaves, before + 1);
  await view.tick(); assert.equal(view.stateSaves, before + 1);
});

test('account preflight terminal receipts release the form even without a domain login reply', async t => {
  const state = { ...snapshot(), connected: false, accounts: [], currentUser: undefined };
  const view = await mount({}, state, {}, () => {}, { autoOperations: false }); t.after(() => view.dom.window.close());
  const document = view.dom.window.document;
  view.send({ type: 'openAccountManager', intent: { id: 'login', startLogin: true } }); await view.tick(); await view.tick();
  document.querySelector('.account-login button[type="submit"]').click(); await view.tick();
  const token = document.querySelector('[name="token"]'); token.value = 'never-persist';
  token.dispatchEvent(new view.dom.window.Event('input', { bubbles: true })); await view.tick();
  document.querySelector('.account-login button[type="submit"]').click(); await view.tick();
  const request = view.rawRequests.findLast(item => item.type === 'submitAccountLogin');
  view.receipt(request, { status: 'failed', effect: 'none', error: 'Account switching' }); await view.tick();
  assert.match(document.querySelector('.account-login-error').textContent, /Account switching/);
  assert.equal(document.querySelector('.account-login fieldset').disabled, false);
  assert.ok(!JSON.stringify(view.savedState).includes('never-persist'));
});

test('account native and custom validation keep inline feedback and publish one fixed message without field values', async t => {
  const view = await mount({}, { ...snapshot(), connected: false, accounts: [], currentUser: undefined }); t.after(() => view.dom.window.close());
  const document = view.dom.window.document;
  view.send({ type: 'openAccountManager', intent: { id: 'validation', startLogin: true } }); await view.tick(); await view.tick();
  const notices = () => view.requests.filter(request => request.type === 'publishNotification');
  const url = document.querySelector('[name="baseUrl"]');
  url.value = ''; url.dispatchEvent(new view.dom.window.Event('input', { bubbles: true })); await view.tick();
  document.querySelector('.account-login').requestSubmit(); await view.tick();
  assert.equal(notices().length, 1); assert.match(document.querySelector('.account-login-error').textContent, /完整 HTTP 或 HTTPS 網址/);
  url.value = 'ftp://private-user:private-password@private.example.test'; url.dispatchEvent(new view.dom.window.Event('input', { bubbles: true })); await view.tick();
  document.querySelector('.account-login button[type="submit"]').click(); await view.tick();
  assert.equal(notices().length, 2); assert.equal(notices()[1].message, notices()[0].message);
  assert.doesNotMatch(JSON.stringify(notices()), /private-user|private-password|private.example/);
  url.value = 'https://gitlab.test'; url.dispatchEvent(new view.dom.window.Event('input', { bubbles: true })); await view.tick();
  document.querySelector('.account-login button[type="submit"]').click(); await view.tick();
  document.querySelector('.account-login').requestSubmit(); await view.tick();
  assert.equal(notices().length, 3); assert.equal(notices()[2].message, '請輸入 Personal Access Token。');
  assert.equal(document.querySelector('.account-login-error').textContent, notices()[2].message);
  assert.equal(view.requests.some(request => request.type === 'submitAccountLogin'), false);
});

test('Issue and MR selections respond before host data and ignore old busy clearing', async t => {
  const data = snapshot();
  const view = await mount({}, data, {}, () => {}, { autoOperations: false }); t.after(() => view.dom.window.close());
  const document = view.dom.window.document;
  const rows = document.querySelectorAll('.work-row'); rows[0].click(); rows[1].click(); await view.tick();
  assert.match(document.querySelector('.work-row.selected').textContent, /Beta milestone/);
  assert.equal(view.requests.filter(request => request.type === 'selectIssue').length, 2);
  const refresh = [...document.querySelectorAll('button')].find(button => button.textContent.trim() === '更新資料');
  refresh.click(); await view.tick();
  assert.match(document.querySelector('.workspace-operation-area').textContent, /更新目前頁面/);
  view.send({ type: 'busy', value: false }); await view.tick();
  assert.match(document.querySelector('.workspace-operation-area').textContent, /更新目前頁面/);
  view.receipt(view.rawRequests.findLast(request => request.type === 'refresh')); await view.tick();
  assert.doesNotMatch(document.querySelector('.workspace-operation-area').textContent, /更新目前頁面/);
});

test('MR section failure remains stable until explicit retry and snapshot receipts clear pending', async t => {
  const data = snapshot('reviewer'); data.operationScope = 'mr-scope';
  const mr = { id: 1, iid: 1, project_id: 1, title: 'Review', source_branch: 'feature', target_branch: 'main', state: 'opened' };
  data.mergeRequests = [mr];
  data.selectedMergeRequest = { request: mr, diffs: [], discussions: [], sections: { diffs: { status: 'idle' }, discussions: { status: 'idle' } }, freshness: { state: 'not_checked' }, warnings: [] };
  const view = await mount({ mode: 'reviewer' }, data, {}, () => {}, { autoOperations: false }); t.after(() => view.dom.window.close());
  assert.equal(view.requests.filter(request => request.type === 'loadMergeRequestSection').length, 1);
  const failed = view.rawRequests.findLast(request => request.type === 'loadMergeRequestSection');
  view.receipt(failed, { status: 'failed', error: 'offline' });
  const error = { ...data, selectedMergeRequest: { ...data.selectedMergeRequest, sections: { ...data.selectedMergeRequest.sections, diffs: { status: 'error', error: 'offline' } } } };
  for (let index = 0; index < 3; index++) { view.sendSnapshot(error); await view.tick(); }
  assert.equal(view.requests.filter(request => request.type === 'loadMergeRequestSection').length, 1);
  const sectionRetry = [...view.dom.window.document.querySelectorAll('.reviewer-detail .section-status button')].find(button => button.textContent === '重試');
  sectionRetry.click(); await view.tick();
  assert.equal(view.requests.filter(request => request.type === 'loadMergeRequestSection').length, 2);
  const retry = view.rawRequests.findLast(request => request.type === 'loadMergeRequestSection');
  view.send({ type: 'operationsSnapshot', snapshot: { sessionId: 'host', revision: 2, operations: [{ requestId: retry.operationId, scopeRevision: 'mr-scope', resourceKey: 'mr:1:1', action: 'loadMergeRequestSection', label: 'MR', status: 'failed', phase: '處理失敗', error: 'offline', startedAt: 1, finishedAt: 2, revision: 2 }] } });
  await view.tick(); sectionRetry.click(); await view.tick();
  assert.equal(view.requests.filter(request => request.type === 'loadMergeRequestSection').length, 3);
});

test('Skills recheck shows waiting inside settings immediately and preserves unrelated controls', async t => {
  const view = await mount({}, snapshot(), {}, () => {}, { autoOperations: false }); t.after(() => view.dom.window.close());
  const document = view.dom.window.document; document.querySelector('.settings-trigger').click(); await view.tick();
  const recheck = document.querySelector('.tool-drawer .drawer-footer button');
  assert.equal(view.requests.filter(request => request.type === 'refreshWorkflowKit').length, 1, 'entering tools loads its local environment once');
  assert.equal(recheck.getAttribute('aria-busy'), 'false'); assert.equal(recheck.disabled, false);
  assert.equal(document.querySelector('.notifications-trigger').disabled, false);
  view.receipt(view.rawRequests.findLast(request => request.type === 'refreshWorkflowKit')); await view.tick();
  assert.equal(recheck.disabled, false);
  recheck.click(); await view.tick();
  assert.equal(view.requests.filter(request => request.type === 'checkWorkflowKitReleases').length, 1);
  assert.equal(recheck.getAttribute('aria-busy'), 'true'); assert.equal(recheck.disabled, true);
  assert.equal(document.querySelector('.notifications-trigger').disabled, false);
  view.receipt(view.rawRequests.findLast(request => request.type === 'checkWorkflowKitReleases')); await view.tick();
  assert.equal(recheck.disabled, false);
});

test('settings load local tools once per entry and account settings do not read Skills', async t => {
  const data = { ...snapshot(), localOperationScope: 'local-settings' };
  const view = await mount({}, data); t.after(() => view.dom.window.close());
  const document = view.dom.window.document;
  view.send({ type: 'openAccountManager', intent: { id: 'accounts-only', startLogin: false } }); await view.tick();
  assert.equal(view.requests.filter(request => request.type === 'refreshWorkflowKit').length, 0);
  document.querySelector('#settings-tab-tools').click(); await view.tick();
  const initial = view.rawRequests.filter(request => request.type === 'refreshWorkflowKit');
  assert.equal(initial.length, 1); assert.equal(initial[0].operationScope, 'local-settings');
  view.sendSnapshot({ ...data, connectedScope: 'another-group' }); await view.tick();
  view.sendSnapshot(data); await view.tick();
  assert.equal(view.requests.filter(request => request.type === 'refreshWorkflowKit').length, 1, 'background snapshots do not repeat the tools read');
  document.querySelector('#settings-tab-accounts').click(); await view.tick();
  assert.equal(view.requests.filter(request => request.type === 'refreshWorkflowKit').length, 1);
  document.querySelector('#settings-tab-tools').click(); await view.tick();
  assert.equal(view.requests.filter(request => request.type === 'refreshWorkflowKit').length, 2);
});

test('host settings navigation resets account login intent and preserves the selected Issue and draft', async t => {
  const data = snapshot(), view = await mount({ mode: 'developer', scopeKey: 'team-scope' }, data);
  t.after(() => view.dom.window.close());
  const document = view.dom.window.document;
  const navigation = { mode: 'detail', projectId: 1, issueIid: 1, revision: 1 };
  view.send({ type: 'issueNavigation', navigation }); await view.tick();
  view.send({ type: 'issueResponse', revision: 1, response: { type: 'detailData', data: {
    ...issueDetailData(data.issues[0], data.projects[0]), canComment: true
  } } }); await view.tick();
  const comment = document.querySelector('.issue-embed textarea');
  comment.value = 'Keep this selected Issue draft';
  comment.dispatchEvent(new view.dom.window.Event('input', { bubbles: true })); await view.tick();
  const readiness = view.requests.filter(request => request.type === 'issueRequest' && request.request.type === 'ready').length;
  view.send({ type: 'openAccountManager', intent: { id: 'settings-login', startLogin: true } }); await view.tick();
  assert.ok(document.querySelector('.account-login'));
  assert.equal(document.querySelector('#settings-tab-accounts').getAttribute('aria-selected'), 'true');
  const loginUrl = document.querySelector('.account-login [name="baseUrl"]');
  loginUrl.focus(); assert.equal(document.activeElement, loginUrl);
  const before = view.requests.length;
  view.send({ type: 'openSettings' }); await view.tick();
  assert.equal(document.querySelector('#settings-tab-tools').getAttribute('aria-selected'), 'true');
  assert.equal(document.activeElement, document.querySelector('#settings-tab-tools'));
  assert.equal(document.querySelector('.account-login'), null);
  assert.equal(view.requests.slice(before).filter(request => request.type === 'refreshWorkflowKit').length, 1);
  document.querySelector('#settings-tab-accounts').click(); await view.tick();
  assert.equal(document.querySelector('.account-login'), null, 'returning to accounts does not restart the earlier login intent');
  document.dispatchEvent(new view.dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); await view.tick();
  assert.equal(document.querySelector('.tool-drawer'), null);
  assert.equal(document.activeElement, document.querySelector('.settings-trigger'));
  assert.equal(document.querySelector('.page').dataset.mode, 'developer');
  assert.deepEqual(view.savedState.issueNavigation, navigation);
  assert.equal(document.querySelector('.issue-embed textarea'), comment);
  assert.equal(comment.value, 'Keep this selected Issue draft');
  assert.equal(view.requests.filter(request => request.type === 'issueRequest' && request.request.type === 'ready').length, readiness);
  assert.equal(view.requests.slice(before).some(request => ['setMode', 'closeIssue', 'selectIssue', 'refresh'].includes(request.type)), false);
});

test('Skills recheck completes 35 full running snapshot and terminal receipt cycles without retaining busy state', async t => {
  const sessionId = 'skills-soak-host';
  const data = { ...snapshot(), operationScope: 'skills-soak', operationSnapshot: { sessionId, revision: 0, operations: [] } };
  const view = await mount({}, data, {}, () => {}, { autoOperations: false }); t.after(() => view.dom.window.close());
  const document = view.dom.window.document;
  document.querySelector('.settings-trigger').click(); await view.tick();
  view.receipt(view.rawRequests.findLast(request => request.type === 'refreshWorkflowKit')); await view.tick();
  const button = () => document.querySelector('.tool-drawer .drawer-footer button');
  const recentTerminals = new Map();
  let revision = 0;
  for (let index = 0; index < 35; index++) {
    assert.equal(button().disabled, false, `cycle ${index + 1} starts enabled`);
    button().click(); await view.tick();
    const request = view.rawRequests.filter(item => item.type === 'checkWorkflowKitReleases').at(-1);
    assert.equal(view.rawRequests.filter(item => item.type === 'checkWorkflowKitReleases').length, index + 1);
    const operation = { ...describeAction(request, { scopeRevision: data.operationScope, accountKey: data.instanceUserScope, rootKey: data.projectContext.root }),
      requestId: request.operationId, scopeRevision: request.operationScope, hostSessionId: sessionId,
      status: 'running', phase: '正在檢查安裝', startedAt: index + 1, revision: ++revision };
    const operations = [...recentTerminals.values(), operation];
    view.sendSnapshot({ ...data, operations, operationSnapshot: { sessionId, revision, operations } });
    await view.tick();
    assert.equal(button().disabled, true, `cycle ${index + 1} waits for its receipt`);
    // The host publishes installed domain data while the operation is still
    // running, then its terminal receipt in the same synchronous call stack.
    // The resulting deferred legacy-snapshot effect must not resurrect running.
    view.sendSnapshot({ ...data, workflowKit: { ...data.workflowKit, status: 'installed' }, operations,
      operationSnapshot: { sessionId, revision: ++revision, operations } });
    const terminal = { ...operation, status: 'succeeded', phase: '已完成', finishedAt: index + 2, revision: ++revision };
    view.send({ type: 'operationChanged', operation: terminal });
    await view.tick();
    assert.equal(button().disabled, false, `cycle ${index + 1} releases after its terminal receipt`);
    assert.notEqual(button().getAttribute('aria-busy'), 'true');
    recentTerminals.set(terminal.requestId, terminal);
    if (recentTerminals.size > 30) recentTerminals.delete(recentTerminals.keys().next().value);
  }
});

test('message center keeps results out of the workbench and supports reading, filters, removal and focus', async t => {
  const notices = { sessionId: 'center-session', revision: 2, unreadCount: 1, items: [
    { id: 'operation:failed', level: 'error', title: '推送 Repo', messages: ['Remote changed <b>SHA</b>'], createdAt: 1, updatedAt: 2, read: false, origin: { baseUrl: 'https://old.gitlab.test', groupId: 42, root: 'C:/previous' } },
    { id: 'notice:read', level: 'info', title: '複製', messages: ['Copied'], createdAt: 1, updatedAt: 1, read: true }
  ] };
  const data = { ...snapshot(), operationScope: 'center-scope', notifications: notices };
  const view = await mount({}, data); t.after(() => view.dom.window.close());
  const document = view.dom.window.document;
  assert.equal(document.querySelector('.toast'), null); assert.equal(document.querySelector('.dashboard-error'), null);
  assert.equal(document.querySelector('.notification-drawer'), null);
  const trigger = document.querySelector('.notifications-trigger'); trigger.focus(); trigger.click(); await view.tick();
  assert.equal(document.activeElement.textContent, '關閉');
  assert.equal(document.querySelectorAll('.notification-item').length, 2);
  const details = document.querySelector('.notification-item details'); details.open = true;
  details.dispatchEvent(new view.dom.window.Event('toggle')); await view.tick();
  assert.deepEqual(Array.from(view.requests.findLast(request => request.type === 'markNotificationsRead').ids), ['operation:failed']);
  assert.equal(document.querySelector('.notification-detail b'), null);
  assert.match(document.querySelector('.notification-origin').textContent, /old.gitlab.test.*C:\/previous/);
  const controls = document.querySelector('.notification-controls');
  [...controls.querySelectorAll('button')].find(button => button.textContent === '未讀').click(); await view.tick();
  assert.equal(document.querySelectorAll('.notification-item').length, 1);
  document.querySelector('.notification-remove').click(); await view.tick();
  assert.equal(view.requests.at(-1).type, 'removeNotification');
  [...controls.querySelectorAll('button')].find(button => button.textContent === '全部已讀').click(); await view.tick();
  assert.equal(view.requests.at(-1).type, 'markAllNotificationsRead'); assert.equal(view.requests.at(-1).revision, 2);
  [...controls.querySelectorAll('button')].find(button => button.textContent === '清除全部').click(); await view.tick();
  assert.equal(view.requests.at(-1).type, 'clearNotifications');
  document.dispatchEvent(new view.dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); await view.tick();
  assert.equal(document.querySelector('.notification-drawer'), null); assert.equal(document.activeElement, trigger);
  assert.equal(Object.hasOwn(view.savedState, 'notifications'), false);
  view.send({ type: 'operationChanged', operation: { requestId: 'running', scopeRevision: 'center-scope', resourceKey: 'skills', action: 'copy', label: 'Working', status: 'running', phase: 'Processing', startedAt: 1 } }); await view.tick();
  assert.match(document.querySelector('.workspace-operation-area').textContent, /Working/);
  view.send({ type: 'operationChanged', operation: { requestId: 'running', scopeRevision: 'center-scope', resourceKey: 'skills', action: 'copy', label: 'Working', status: 'succeeded', phase: 'Done', startedAt: 1, finishedAt: 2 } }); await view.tick();
  assert.equal(document.querySelector('.workspace-operation-area .operation-status'), null);
});

test('message snapshots ignore stale revisions and do not restore a retired extension session', async t => {
  const center = (sessionId, revision, unreadCount) => ({ sessionId, revision, unreadCount, items: [] });
  const view = await mount({}, { ...snapshot(), notifications: center('old-session', 4, 2) }); t.after(() => view.dom.window.close());
  const button = () => view.dom.window.document.querySelector('.notifications-trigger');
  view.send({ type: 'notificationsChanged', snapshot: center('old-session', 3, 5) }); await view.tick();
  assert.match(button().getAttribute('aria-label'), /2 筆未讀/);
  view.send({ type: 'notificationsChanged', snapshot: center('new-session', 0, 0) }); await view.tick();
  view.send({ type: 'notificationsChanged', snapshot: center('old-session', 5, 5) }); await view.tick();
  assert.match(button().getAttribute('aria-label'), /0 筆未讀/);
  view.send({ type: 'openNotifications' }); await view.tick();
  assert.ok(view.dom.window.document.querySelector('.notification-drawer'));
});

test('an expanded unread message remains readable after the host marks it read', async t => {
  const item = { id: 'notice:details', level: 'error', title: 'Push', messages: ['First detail', 'Second detail'], createdAt: 1, updatedAt: 1, read: false };
  const initialCenter = { sessionId: 'details-session', revision: 1, unreadCount: 1, items: [item] };
  const view = await mount({}, { ...snapshot(), notifications: initialCenter }); t.after(() => view.dom.window.close());
  const document = view.dom.window.document;
  document.querySelector('.notifications-trigger').click(); await view.tick();
  [...document.querySelectorAll('.notification-controls button')].find(button => button.textContent === '未讀').click(); await view.tick();
  let details = document.querySelector('.notification-item details');
  details.open = true; details.dispatchEvent(new view.dom.window.Event('toggle')); await view.tick();
  view.send({ type: 'notificationsChanged', snapshot: { ...initialCenter, revision: 2, unreadCount: 0, items: [{ ...item, read: true }] } }); await view.tick();
  assert.equal(document.querySelectorAll('.notification-item').length, 1);
  assert.match(document.querySelector('.notification-detail').textContent, /First detail.*Second detail/);
  details = document.querySelector('.notification-item details'); details.open = false;
  details.dispatchEvent(new view.dom.window.Event('toggle')); await view.tick();
  assert.equal(document.querySelectorAll('.notification-item').length, 0);
});

function notification(id, contentRevision = 1, patch = {}) {
  return { id, level: 'info', title: `Result ${id}`, messages: [`Detail ${id}:${contentRevision}`], contentRevision,
    createdAt: contentRevision, updatedAt: contentRevision, read: false, ...patch };
}
function notificationCenter(revision, items = [], sessionId = 'snack-session') {
  return { sessionId, revision, items, unreadCount: items.filter(item => !item.read).length };
}
function snackbarClock(window) {
  const setTimeout = window.setTimeout.bind(window), clearTimeout = window.clearTimeout.bind(window);
  let now = 0, serial = 100000;
  const timers = new Map();
  window.Date.now = () => now;
  window.setTimeout = (callback, delay = 0, ...args) => {
    if (delay < 1000) return setTimeout(callback, delay, ...args);
    const id = serial++; timers.set(id, { at: now + delay, callback: () => callback(...args) }); return id;
  };
  window.clearTimeout = id => { if (!timers.delete(id)) clearTimeout(id); };
  return { get delays() { return [...timers.values()].map(timer => timer.at - now); }, advance(milliseconds) {
    const end = now + milliseconds;
    for (;;) {
      const next = [...timers.entries()].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!next) break;
      timers.delete(next[0]); now = next[1].at; next[1].callback();
    }
    now = end;
  } };
}

test('SnackBar queues new content, keeps unread state on dismissal, and View expands the matching message', async t => {
  const old = notification('old');
  const view = await mount({}, { ...snapshot(), notifications: notificationCenter(1, [old]) }); t.after(() => view.dom.window.close());
  const document = view.dom.window.document;
  assert.equal(document.querySelector('.notification-snackbar'), null, 'hydration does not replay history');
  const first = notification('first'), second = notification('second');
  view.send({ type: 'notificationsChanged', snapshot: notificationCenter(2, [first, old]) }); await view.tick();
  assert.match(document.querySelector('.notification-snackbar').textContent, /Detail first:1/);
  view.send({ type: 'notificationsChanged', snapshot: notificationCenter(3, [second, first, old]) }); await view.tick();
  assert.equal(document.querySelectorAll('.notification-snackbar').length, 1);
  assert.match(document.querySelector('.notification-snackbar').textContent, /Detail first:1/);
  view.send({ type: 'notificationsChanged', snapshot: notificationCenter(4, [second, { ...first, read: true }, old]) }); await view.tick();
  [...document.querySelectorAll('.notification-snackbar button')].find(button => button.textContent === '關閉').click(); await view.tick();
  assert.match(document.querySelector('.notification-snackbar').textContent, /Detail second:1/);
  assert.equal(view.requests.filter(request => request.type === 'markNotificationsRead').length, 0);
  document.querySelector('.notification-snackbar button').focus(); document.querySelector('.notification-snackbar button').click(); await view.tick();
  const details = [...document.querySelectorAll('.notification-item details')].find(item => item.textContent.includes('Result second'));
  assert.equal(details.open, true);
  assert.equal(document.activeElement, details.querySelector('summary'));
  const read = view.requests.filter(request => request.type === 'markNotificationsRead');
  assert.equal(read.length, 1); assert.deepEqual(Array.from(read[0].ids), ['second']); assert.equal(read[0].revision, 4);
  assert.match(document.querySelector('.notifications-trigger').getAttribute('aria-label'), /2 筆未讀/);
});

test('SnackBar uses six seconds of active time, pauses for hover and focus, then advances its queue', async t => {
  let clock;
  const view = await mount({}, { ...snapshot(), notifications: notificationCenter(0) }, {}, window => { clock = snackbarClock(window); });
  t.after(() => view.dom.window.close()); const document = view.dom.window.document;
  view.send({ type: 'notificationsChanged', snapshot: notificationCenter(1, [notification('second'), notification('first')]) }); await view.tick();
  const snack = () => document.querySelector('.notification-snackbar');
  const waitForTimer = async (delays) => {
    for (let attempt = 0; attempt < 30 && JSON.stringify(clock.delays) !== JSON.stringify(delays); attempt++) await view.tick();
    assert.deepEqual(clock.delays, delays, 'timer effects have settled before advancing the fake clock');
  };
  await waitForTimer([6000]);
  clock.advance(2000); snack().dispatchEvent(new view.dom.window.Event('mouseenter')); await view.tick();
  await waitForTimer([]);
  snack().querySelector('button').focus(); await view.tick();
  clock.advance(10000); await view.tick(); assert.match(snack().textContent, /Detail first:1/);
  snack().dispatchEvent(new view.dom.window.Event('mouseleave')); await view.tick();
  clock.advance(10000); await view.tick(); assert.match(snack().textContent, /Detail first:1/, 'focus keeps the timer paused after hover ends');
  document.querySelector('.notifications-trigger').focus(); await view.tick();
  await waitForTimer([4000]);
  clock.advance(3999); await view.tick(); assert.match(snack().textContent, /Detail first:1/);
  clock.advance(1); await view.tick(); assert.match(snack().textContent, /Detail second:1/);
  await waitForTimer([6000]);
  clock.advance(6000); await view.tick(); assert.equal(snack(), null);
  assert.equal(view.requests.filter(request => request.type === 'markNotificationsRead').length, 0);
});

test('SnackBar keeps a queued replacement paused while focus or the pointer remains inside', async t => {
  for (const pausedBy of ['focus', 'hover']) await t.test(pausedBy, async t => {
    let clock;
    const view = await mount({}, { ...snapshot(), notifications: notificationCenter(0) }, {}, window => { clock = snackbarClock(window); });
    t.after(() => view.dom.window.close()); const document = view.dom.window.document;
    view.send({ type: 'notificationsChanged', snapshot: notificationCenter(1, [notification('second'), notification('first')]) }); await view.tick();
    const snack = () => document.querySelector('.notification-snackbar');
    const waitForTimer = async delays => {
      for (let attempt = 0; attempt < 30 && JSON.stringify(clock.delays) !== JSON.stringify(delays); attempt++) await view.tick();
      assert.deepEqual(clock.delays, delays);
    };
    await waitForTimer([6000]);
    if (pausedBy === 'focus') snack().querySelectorAll('button')[1].focus();
    else snack().dispatchEvent(new view.dom.window.Event('mouseenter'));
    await waitForTimer([]);
    snack().querySelectorAll('button')[1].click(); await view.tick();
    assert.match(snack().textContent, /Detail second:1/);
    if (pausedBy === 'focus') assert.equal(document.activeElement, snack().querySelectorAll('button')[1], 'closing retains focus on the next message action');
    await waitForTimer([]);
    clock.advance(10000); await view.tick();
    assert.ok(snack(), 'the replacement stays visible while interaction remains inside');
    assert.match(snack().textContent, /Detail second:1/);
    if (pausedBy === 'focus') document.querySelector('.notifications-trigger').focus();
    else snack().dispatchEvent(new view.dom.window.Event('mouseleave'));
    await waitForTimer([6000]); clock.advance(6000); await view.tick(); assert.equal(snack(), null);
  });
});

test('SnackBar ignores duplicate snapshots, prunes removed messages and suppresses hidden history', async t => {
  const view = await mount({}, { ...snapshot(), notifications: notificationCenter(0) }); t.after(() => view.dom.window.close());
  const document = view.dom.window.document, first = notification('first'), second = notification('second');
  const snack = () => document.querySelector('.notification-snackbar');
  view.send({ type: 'notificationsChanged', snapshot: notificationCenter(1, [first]) }); await view.tick();
  snack().querySelectorAll('button')[1].click(); await view.tick();
  view.send({ type: 'notificationsChanged', snapshot: notificationCenter(2, [{ ...first, read: true }]) }); await view.tick();
  assert.equal(snack(), null, 'read-state revisions do not replay content');
  const updated = notification('first', 2);
  view.send({ type: 'notificationsChanged', snapshot: notificationCenter(3, [updated]) }); await view.tick();
  view.send({ type: 'notificationsChanged', snapshot: notificationCenter(3, [updated]) }); await view.tick();
  snack().querySelectorAll('button')[1].click(); await view.tick(); assert.equal(snack(), null, 'a content revision is queued once');
  view.sendSnapshot({ ...snapshot(), notifications: notificationCenter(4, [second, updated]) }); await view.tick();
  assert.match(snack().textContent, /Detail second:1/, 'new content in a full live snapshot is displayed');
  snack().querySelectorAll('button')[1].click(); await view.tick();
  view.sendSnapshot({ ...snapshot(), notifications: notificationCenter(4, [second, updated]) }); await view.tick();
  assert.equal(snack(), null, 'a repeated full snapshot does not replay history');
  view.send({ type: 'notificationsChanged', snapshot: notificationCenter(5, [notification('third'), second, updated]) }); await view.tick();
  assert.ok(snack());
  view.send({ type: 'notificationsChanged', snapshot: notificationCenter(6, [second, updated]) }); await view.tick();
  assert.equal(snack(), null, 'removed messages leave the queue');
  let hidden = true; Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden });
  document.dispatchEvent(new view.dom.window.Event('visibilitychange')); await view.tick();
  const hiddenItem = notification('hidden');
  view.send({ type: 'notificationsChanged', snapshot: notificationCenter(7, [hiddenItem, second, updated]) }); await view.tick(); assert.equal(snack(), null);
  hidden = false; document.dispatchEvent(new view.dom.window.Event('visibilitychange')); await view.tick();
  view.send({ type: 'notificationsChanged', snapshot: notificationCenter(8, [{ ...hiddenItem, read: true }, second, updated]) }); await view.tick();
  assert.equal(snack(), null, 'restoring visibility does not replay hidden messages');
  view.send({ type: 'notificationsChanged', snapshot: notificationCenter(9, [notification('visible'), hiddenItem, second, updated]) }); await view.tick();
  assert.match(snack().textContent, /Detail visible:1/);
  view.send({ type: 'notificationsChanged', snapshot: notificationCenter(0, [notification('session-history')], 'next-session') }); await view.tick(); assert.equal(snack(), null);
  view.send({ type: 'notificationsChanged', snapshot: notificationCenter(10, [notification('retired')]) }); await view.tick(); assert.equal(snack(), null);
});

test('a live notification followed immediately by a full workspace snapshot still shows one SnackBar', async t => {
  const initial = notificationCenter(0);
  const view = await mount({}, { ...snapshot(), notifications: initial }); t.after(() => view.dom.window.close());
  const center = notificationCenter(1, [notification('live')]);
  view.send({ type: 'notificationsChanged', snapshot: center });
  view.sendSnapshot({ ...snapshot(), notifications: center });
  await view.tick();
  const document = view.dom.window.document;
  assert.match(document.querySelector('.notification-snackbar').textContent, /Detail live:1/);
  document.querySelectorAll('.notification-snackbar button')[1].click(); await view.tick();
  assert.equal(document.querySelector('.notification-snackbar'), null);
});

test('MR changes show partial-diff warnings and a GitLab link beside limited files', async t => {
  const data = snapshot('reviewer');
  const request = { id: 41, iid: 4, project_id: 1, title: 'Review', state: 'opened', source_branch: 'feature', target_branch: 'main', web_url: 'https://gitlab.test/group/service/-/merge_requests/4' };
  data.mergeRequests = [request]; data.selectedMergeRequest = { request, diffs: [{ old_path: 'large.ts', new_path: 'large.ts', diff: '', too_large: true }], discussions: [],
    sections: { diffs: { status: 'ready' }, discussions: { status: 'ready' } }, warnings: ['GitLab 僅回傳部分差異。'], freshness: { state: 'not_checked' } };
  const view = await mount({ mode: 'reviewer' }, data); t.after(() => view.dom.window.close());
  const document = view.dom.window.document;
  assert.match(document.querySelector('.mr-diff-warnings').textContent, /僅回傳部分差異/);
  assert.equal(document.querySelector('.mr-diff-warnings a').href, request.web_url);
  assert.match(document.querySelector('.diff-list').textContent, /檔案差異超過顯示限制/);
});

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
async function mountGit(t, storage = {}, data = gitSnapshot(), beforeMount = () => {}) {
  const view = await mount({ mode: 'git', scopeKey: 'team-scope' }, snapshot('git'), storage, beforeMount);
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

test('Git synchronous Host replies settle initial open, refresh and confirmed write before dispatch returns', async t => {
  let revision = 0;
  let failNext;
  const synchronousHost = window => {
    const acquire = window.acquireVsCodeApi;
    const send = data => window.dispatchEvent(new window.MessageEvent('message', { data }));
    window.acquireVsCodeApi = () => {
      const api = acquire();
      return { ...api, postMessage(message) {
        api.postMessage(message);
        if (message.type === 'gitReady') send({ type: 'gitRepositories', available: true, revision: 1, repositories: [gitSnapshot()] });
        if (message.type !== 'gitAction') return;
        if (message.action.type === failNext) { failNext = undefined; throw new Error('Synchronous bridge unavailable'); }
        const write = message.action.type === 'commit';
        send({ type: 'gitSnapshot', requestId: message.requestId, snapshot: gitSnapshot(message.repoId, {
          revision: ++revision, branch: message.action.type === 'refresh' ? 'refreshed' : 'main',
          ...(write ? { headCommit: 'd'.repeat(40), stagedCount: 0, changes: [] } : {})
        }) });
        send({ type: 'gitActionResult', requestId: message.requestId, write, ...(write ? { effect: 'applied', commitCompleted: true } : {}) });
      } };
    };
  };
  const view = await mount({ mode: 'git', scopeKey: 'team-scope' }, snapshot('git'), {}, synchronousHost, { autoOperations: false });
  t.after(() => view.dom.window.close());
  const document = view.dom.window.document;
  for (let attempt = 0; attempt < 40 && !gitActions(view, 'open').length; attempt++) await view.tick();
  await view.tick();
  assert.equal(gitActions(view, 'open').length, 1);
  assert.equal(document.querySelector('.git-branch-picker select').value, 'main', 'the initial synchronous snapshot is accepted');
  assert.equal(document.querySelector('.git-refresh').disabled, false, 'initial open does not restore stale reading state');
  document.querySelector('.git-refresh').click(); await view.tick();
  assert.equal(gitActions(view, 'refresh').length, 1);
  assert.equal(document.querySelector('.git-branch-picker select').value, 'refreshed');
  assert.equal(document.querySelector('.git-refresh').disabled, false, 'a synchronous refresh finishes reading');
  failNext = 'refresh'; document.querySelector('.git-refresh').click(); await view.tick();
  assert.match(document.querySelector('.git-error').textContent, /Synchronous bridge unavailable/);
  assert.equal(document.querySelector('.git-refresh').disabled, false, 'a blocked dispatch rolls back its provisional reading state');
  document.querySelector('.git-refresh').click(); await view.tick();
  assert.equal(document.querySelector('.git-error'), null);
  const draft = document.querySelector('.git-commit-composer textarea');
  draft.value = 'Synchronously confirmed'; draft.dispatchEvent(new view.dom.window.Event('input', { bubbles: true })); await view.tick();
  failNext = 'commit';
  document.querySelector('.git-commit-composer').dispatchEvent(new view.dom.window.Event('submit', { bubbles: true, cancelable: true }));
  await view.tick();
  assert.equal(document.querySelector('.git-commit-composer textarea').value, 'Synchronously confirmed');
  assert.equal(view.savedState.gitUi.pendingWrites.length, 0, 'a blocked write drops only its provisional pending context');
  assert.equal(document.querySelector('.git-commit-launch').disabled, false);
  document.querySelector('.git-commit-composer').dispatchEvent(new view.dom.window.Event('submit', { bubbles: true, cancelable: true }));
  await view.tick();
  const commit = gitActions(view, 'commit').at(-1); assert.ok(commit);
  assert.equal(document.querySelector('.git-commit-composer textarea').value, '');
  assert.equal(view.savedState.gitUi.pendingWrites.length, 0, 'a terminal reply cannot be overwritten by post-dispatch persistence');
  assert.equal(document.querySelector('.git-refresh').disabled, false);
  assert.equal(document.querySelector('.git-progress'), null);
  assert.equal(view.requests.filter(item => item.type === 'gitAcknowledgeResult' && item.requestId === commit.requestId).length, 1);
});

for (const action of ['refresh', 'commit']) test(`Git preflight terminal receipts release ${action} without a domain result and preserve the latest owner`, async t => {
  const view = await mount({ mode: 'git', scopeKey: 'team-scope' }, snapshot('git'), {}, () => {}, { autoOperations: false });
  t.after(() => view.dom.window.close());
  const document = view.dom.window.document;
  view.send({ type: 'gitRepositories', available: true, revision: 1, repositories: [gitSnapshot()] });
  for (let attempt = 0; attempt < 40 && !gitActions(view, 'open').length; attempt++) await view.tick();
  const open = gitActions(view, 'open').at(-1); assert.ok(open);
  await finishGit(view, open);
  const draft = () => document.querySelector('.git-commit-composer textarea');
  draft().value = 'Keep this Git draft'; draft().dispatchEvent(new view.dom.window.Event('input', { bubbles: true })); await view.tick();
  const control = () => document.querySelector(action === 'commit' ? '.git-commit-launch' : '.git-refresh');
  const start = async () => {
    if (action === 'commit') document.querySelector('.git-commit-composer').dispatchEvent(new view.dom.window.Event('submit', { bubbles: true, cancelable: true }));
    else control().click();
    await view.tick();
    return view.rawRequests.findLast(request => request.type === 'gitAction' && request.action.type === action);
  };
  const reject = async request => {
    // Host preflight can reject before the Git adapter runs, so there is no
    // gitSnapshot or gitActionResult: only the correlated lifecycle terminal.
    view.receipt(request, { status: 'failed', effect: 'none', correlationId: request.requestId, error: 'Host scope rejected before Git adapter' });
    await view.tick();
  };
  assert.equal(control().disabled, false);
  const rejected = await start(); assert.ok(rejected?.operationId);
  assert.equal(control().disabled, true);
  assert.ok(document.querySelector('.git-status-message .spinner'));
  await reject(rejected);
  assert.equal(draft().value, 'Keep this Git draft', 'a preflight rejection preserves unsubmitted and submitted input');
  assert.equal(control().disabled, false, 'a lifecycle-only preflight failure must release the Git control for retry');
  assert.equal(document.querySelector('.git-status-message .spinner'), null, 'reading and pending labels must also settle without a domain receipt');
  assert.equal(view.savedState.gitUi.pendingWrites.length, 0);
  const retry = await start(); assert.ok(retry?.operationId);
  assert.notEqual(retry.operationId, rejected.operationId);
  assert.equal(control().disabled, true, 'the retry owns its own waiting state');
  await reject(rejected);
  assert.equal(control().disabled, true, 'replaying the old terminal cannot clear the newer owner');
  assert.ok(document.querySelector('.git-status-message .spinner'));
  if (action === 'commit') assert.deepEqual(view.savedState.gitUi.pendingWrites.map(item => item.id), [retry.requestId]);
  await reject(retry);
  assert.equal(control().disabled, false);
  assert.equal(document.querySelector('.git-status-message .spinner'), null);
  assert.equal(view.savedState.gitUi.pendingWrites.length, 0);
  assert.equal(draft().value, 'Keep this Git draft');
});

for (const status of ['failed', 'cancelled']) test(`Git initial open ${status} settles without a domain reply and retries only when requested`, async t => {
  const view = await mount({ mode: 'git', scopeKey: 'team-scope' }, snapshot('git'), {}, () => {}, { autoOperations: false });
  t.after(() => view.dom.window.close());
  const document = view.dom.window.document;
  view.send({ type: 'gitRepositories', available: true, revision: 1, repositories: [gitSnapshot()] });
  for (let attempt = 0; attempt < 40 && !gitActions(view, 'open').length; attempt++) await view.tick();
  const first = view.rawRequests.findLast(request => request.type === 'gitAction' && request.action.type === 'open');
  assert.ok(first?.operationId);
  const retryButton = () => document.querySelector('.git-empty-state button');
  assert.match(document.querySelector('.git-empty-state h2').textContent, /正在開啟 Repo/);
  assert.equal(retryButton().disabled, true);
  const terminal = { status, effect: 'none', correlationId: first.requestId,
    ...(status === 'failed' ? { error: 'The Host rejected the initial Repo open' } : {}) };
  view.receipt(first, terminal); await view.tick();
  assert.equal(document.querySelector('.git-empty-state h2').textContent, '無法開啟 Repo');
  assert.match(document.querySelector('.git-empty-state p').textContent, status === 'failed' ? /Host rejected/ : /已中止/);
  assert.equal(retryButton().disabled, false);
  for (let attempt = 0; attempt < 3; attempt++) await view.tick();
  assert.equal(gitActions(view, 'open').length, 1, 'a rejected open never starts an automatic retry loop');
  const readyRequests = view.requests.filter(request => request.type === 'gitReady').length;
  retryButton().click(); await view.tick();
  const retry = view.rawRequests.findLast(request => request.type === 'gitAction' && request.action.type === 'open');
  assert.notEqual(retry.requestId, first.requestId);
  assert.equal(gitActions(view, 'open').length, 2);
  assert.equal(view.requests.filter(request => request.type === 'gitReady').length, readyRequests, 'retry opens the selected Repo instead of only reloading its list');
  assert.match(document.querySelector('.git-empty-state h2').textContent, /正在開啟 Repo/);
  assert.equal(retryButton().disabled, true);
  view.receipt(first, terminal);
  view.send({ type: 'gitSnapshot', requestId: first.requestId, snapshot: gitSnapshot('repo-a', { revision: 2, branch: 'stale-branch' }) });
  view.send({ type: 'gitActionResult', requestId: first.requestId, error: 'Late rejected open' });
  await view.tick();
  assert.ok(document.querySelector('.git-empty-state'), 'old domain and lifecycle replies cannot finish the newer open');
  assert.equal(retryButton().disabled, true);
  await finishGit(view, retry, { revision: 3, branch: 'current-branch' });
  view.receipt(retry, { status: 'succeeded', effect: 'none', correlationId: retry.requestId }); await view.tick();
  assert.equal(document.querySelector('.git-empty-state'), null);
  assert.equal(document.querySelector('.git-branch-picker select').value, 'current-branch');
  assert.equal(document.querySelector('.git-refresh').disabled, false);
  assert.equal(document.querySelector('.git-status-message .spinner'), null);
  assert.equal(document.querySelector('.git-error'), null);
});

for (const action of ['open', 'refresh']) test(`Git global retry rebuilds the ${action} domain request after a lifecycle-only rejection`, async t => {
  const view = await mount({ mode: 'git', scopeKey: 'team-scope' }, snapshot('git'), {}, () => {}, { autoOperations: false });
  t.after(() => view.dom.window.close());
  const document = view.dom.window.document;
  view.send({ type: 'gitRepositories', available: true, revision: 1, repositories: [gitSnapshot()] });
  for (let attempt = 0; attempt < 40 && !gitActions(view, 'open').length; attempt++) await view.tick();
  if (action === 'refresh') {
    await finishGit(view, gitActions(view, 'open').at(-1));
    document.querySelector('.git-refresh').click(); await view.tick();
  }
  const rejected = view.rawRequests.findLast(request => request.type === 'gitAction' && request.action.type === action);
  const failure = { status: 'failed', effect: 'none', correlationId: rejected.requestId, startedAt: 1,
    error: 'Preflight rejected this Git read' };
  view.receipt(rejected, failure); await view.tick();
  const feedback = [...document.querySelectorAll('.operation-status.failed')].find(item => item.textContent.includes(failure.error));
  assert.ok(feedback, 'the failed read is visible in the shared operation feedback');
  const retryButton = [...feedback.querySelectorAll('button')].find(button => button.textContent === '重試');
  assert.ok(retryButton);
  const beforeRetry = gitActions(view, action).length;
  retryButton.click(); await view.tick();
  const retry = view.rawRequests.findLast(request => request.type === 'gitAction' && request.action.type === action);
  assert.equal(gitActions(view, action).length, beforeRetry + 1);
  assert.notEqual(retry.operationId, rejected.operationId);
  assert.notEqual(retry.requestId, rejected.requestId, 'the domain adapter owns a fresh correlation and result context');
  assert.equal(retry.repoId, rejected.repoId);
  view.receipt(rejected, failure); await view.tick();
  assert.equal(document.querySelector(action === 'open' ? '.git-empty-state button' : '.git-refresh').disabled, true,
    'the earlier terminal cannot release the retry owner');
  await finishGit(view, retry, { revision: 3, branch: 'recovered-through-global-retry' });
  view.receipt(retry, { status: 'succeeded', effect: 'none', correlationId: retry.requestId }); await view.tick();
  assert.equal(document.querySelector('.git-branch-picker select').value, 'recovered-through-global-retry', 'the retried snapshot reaches its domain consumer');
  assert.equal(document.querySelector('.git-refresh').disabled, false);
  assert.equal(document.querySelector('.git-status-message .spinner'), null);
  assert.equal(document.querySelector('.git-error'), null);
});

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
    sections: { boards: { status: 'ready', complete: true }, milestones: { status: 'ready', complete: true } },
    projectMembers: [],
    timers: [],
    workflowKit: { status: 'installed', version: '0.9.0', source: 'bundled' },
    projectContext: { folders: [{ uri: 'file:C:/workspace/team', path: 'C:/workspace/team', name: 'team' }], selectedFolderUri: 'file:C:/workspace/team', root: 'C:/workspace/team', manual: false, revision: 'root-team' },
    workflowKitInstallTarget: { root: 'C:/workspace/team', manual: false, state: { status: 'installed', version: '0.9.0', source: 'bundled' } },
    workflowKitReleases: [{ id: 'github-1.0.0', version: '1.0.0', source: 'github', assetName: 'gitlab-workspace-kit-1.0.0.zip', format: 'zip', entryRoot: 'workflow-kit', available: true }],
    workflowKitSource: 'github',
    tools: [],
    toolSource: 'gitea',
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

async function mount(initialState, initialSnapshot, storage = {}, beforeMount = () => {}, options = {}) {
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
  const requests = [], rawRequests = [];
  for (const [key, value] of Object.entries(storage)) dom.window.localStorage.setItem(key, JSON.stringify(value));
  let state = initialState;
  let stateSaves = 0;
  dom.window.acquireVsCodeApi = () => ({
    postMessage: (message) => {
      const { operationId, operationScope, ...payload } = message;
      requests.push(payload); rawRequests.push(message);
      if (operationId && options.autoOperations !== false) queueMicrotask(() => dom.window.dispatchEvent(new dom.window.MessageEvent('message', { data: {
        type: 'operationChanged', operation: { requestId: operationId, scopeRevision: operationScope,
          resourceKey: operationResource(message), action: message.type, label: 'Fixture operation', status: 'succeeded', phase: '已完成', startedAt: Date.now() }
      } })));
    },
    getState: () => state,
    setState: (value) => { stateSaves++; state = JSON.parse(JSON.stringify(value)); }
  });
  beforeMount(dom.window);
  const tick = async () => {
    await new Promise((resolve) => dom.window.requestAnimationFrame(() => dom.window.requestAnimationFrame(resolve)));
    await new Promise((resolve) => setTimeout(resolve, 0));
  };
  const waitFor = async (condition, description) => {
    const deadline = performance.now() + 5000;
    while (!condition() && performance.now() < deadline) await tick();
    assert.ok(condition(), description);
  };
  dom.window.eval(script);
  await waitFor(() => requests.some(request => request.type === 'ready'), 'the dashboard announces readiness before hydration');
  assert.equal(requests[0]?.type, 'ready');
  dom.window.dispatchEvent(new dom.window.MessageEvent('message', { data: { type: 'snapshot', snapshot: initialSnapshot } }));
  await waitFor(() => dom.window.document.querySelector('.app-shell'), 'the dashboard renders its initial snapshot');
  await tick();
  assert.equal(runtimeErrors.length, 0, runtimeErrors.join('\n'));
  assert.ok(dom.window.document.querySelector('.app-shell'), `the dashboard is mounted: root=${dom.window.document.querySelector('#workspace')?.innerHTML ?? 'missing'}, requests=${JSON.stringify(requests)}, errors=${runtimeErrors.join('; ')}`);
  return {
    dom,
    requests,
    rawRequests,
    receipt(request, patch = {}) {
      dom.window.dispatchEvent(new dom.window.MessageEvent('message', { data: { type: 'operationChanged', operation: {
        requestId: request.operationId, scopeRevision: request.operationScope, resourceKey: operationResource(request),
        action: request.type, label: 'Controlled operation', status: 'succeeded', phase: 'Done', startedAt: Date.now(), ...patch
      } } }));
    },
    tick,
    get savedState() { return state; },
    get stateSaves() { return stateSaves; },
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

test('settings opens native Output with or without a connection or an active project operation', async (t) => {
  for (const connected of [true, false]) {
    const data = { ...snapshot(), connected, localOperationScope: 'local-root', projectOperationBusy: true,
      ...(connected ? {} : { currentUser: undefined, group: undefined, connectedScope: undefined }) };
    const view = await mount({ mode: 'developer' }, data, {}, () => {}, { autoOperations: false });
    t.after(() => view.dom.window.close());
    const document = view.dom.window.document;
    if (connected) document.querySelector('.settings-trigger').click();
    else view.send({ type: 'openSettings' });
    await view.tick();
    assert.equal(document.querySelector('#settings-tab-tools').getAttribute('aria-selected'), 'true');
    const open = [...document.querySelectorAll('.tool-drawer button')].find((button) => button.textContent === '開啟 Log');
    assert.ok(open);
    assert.equal(open.disabled, false);
    open.click();
    await view.tick();
    assert.equal(document.querySelector('.tool-drawer'), null);
    assert.equal(document.querySelector('.page-heading h1').textContent, '我的工作');
    assert.equal(document.querySelector('.admin-log-panel'), null);
    assert.equal(view.savedState.mode, 'developer');
    assert.deepEqual(view.requests.findLast(request => request.type === 'openLogs'), { type: 'openLogs' });
    assert.equal(view.requests.some(request => ['setMode', 'queryLogs', 'setLogVisibility'].includes(request.type)), false);
    assert.equal(view.rawRequests.findLast(request => request.type === 'openLogs').operationId, undefined, 'opening Output does not create a tracked read or write');
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
  await view.tick(); buttons[2].click();
  assert.equal(view.requests.at(-1).type, 'addAccount');
  assert.equal(view.requests.at(-1).accountId, 'third');
  await view.tick(); [...document.querySelectorAll('.account-manager button')].find(button => button.textContent.includes('新增 GitLab 帳號')).click();
  assert.equal(view.requests.at(-1).type, 'addAccount');
  assert.equal(view.requests.at(-1).accountId, undefined);
  [...document.querySelectorAll('.account-manager button')].find(button => button.textContent === '管理帳號與連線').click();
  assert.equal(view.requests.at(-1).type, 'openAccountManager');
  view.send({ type: 'openAccountManager', intent: { id: 'manage', startLogin: false } }); await view.tick();
  assert.equal(document.querySelectorAll('.account-card').length, 3);
  document.querySelector('button[aria-label="移除 Second 帳號"]').click();
  assert.equal(view.requests.at(-1).type, 'removeAccount');
  await view.tick(); document.querySelector('button[aria-label="登出 First 帳號"]').click();
  assert.equal(view.requests.at(-1).type, 'disconnect');
});

test('legacy admin mode restores My Work while retaining saved selections and drafts', async (t) => {
  const saved = { mode: 'admin', scopeKey: 'team-scope', selectedProjectIds: [2], selectedIds: { clone: 2 },
    requirement: 'Preserve this analysis draft', reports: { '1:4': { text: 'Preserve this MR report', sha: '' } } };
  const view = await mount(saved, snapshot('admin'));
  t.after(() => view.dom.window.close());
  const document = view.dom.window.document;
  assert.equal(document.querySelector('.page-heading h1').textContent, '我的工作');
  assert.equal(document.querySelector('.page').dataset.mode, 'developer');
  assert.equal(view.savedState.mode, 'developer');
  assert.deepEqual(view.savedState.selectedProjectIds, saved.selectedProjectIds);
  assert.deepEqual(view.savedState.selectedIds, saved.selectedIds);
  assert.equal(view.savedState.requirement, saved.requirement);
  assert.deepEqual(view.savedState.reports, saved.reports);
  assert.equal(view.requests.some(request => ['openLogs', 'queryLogs', 'setLogVisibility'].includes(request.type)), false, 'restoring the old page does not reveal Output automatically');
});

test('opening Output keeps the active Repo, selected file and commit draft', async t => {
  const view = await mountGit(t);
  const document = view.dom.window.document;
  const draft = document.querySelector('.git-commit-composer textarea');
  draft.value = 'Keep this commit draft'; draft.dispatchEvent(new view.dom.window.Event('input', { bubbles: true }));
  document.querySelector('.git-change-name').click(); await view.tick();
  const before = structuredClone(view.savedState.gitUi);
  const requestCount = view.requests.length;
  document.querySelector('.notifications-trigger').click(); await view.tick();
  assert.ok(document.querySelector('.notification-drawer'));
  view.send({ type: 'openSettings' }); await view.tick();
  assert.equal(document.querySelector('.notification-drawer'), null);
  assert.equal(document.querySelector('#settings-tab-tools').getAttribute('aria-selected'), 'true');
  assert.ok(document.querySelector('.tool-drawer').contains(document.activeElement));
  document.dispatchEvent(new view.dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); await view.tick();
  assert.equal(document.querySelector('.tool-drawer'), null);
  assert.equal(document.activeElement, document.querySelector('.settings-trigger'), 'a removed notification control is never the return focus target');
  assert.equal(document.querySelector('.page').dataset.mode, 'git');
  assert.deepEqual(view.savedState.gitUi, before);
  assert.equal(document.querySelector('.git-commit-composer textarea').value, 'Keep this commit draft');
  document.querySelector('.settings-trigger').click(); await view.tick();
  [...document.querySelectorAll('.tool-drawer button')].find(button => button.textContent === '開啟 Log').click();
  await view.tick();
  assert.equal(document.querySelector('.tool-drawer'), null);
  assert.equal(document.querySelector('.page').dataset.mode, 'git');
  assert.equal(document.querySelector('.git-commit-composer textarea').value, 'Keep this commit draft');
  assert.deepEqual(view.savedState.gitUi, before);
  const requests = view.requests.slice(requestCount);
  assert.equal(requests.filter(request => request.type === 'openLogs').length, 1);
  assert.equal(requests.some(request => ['setMode', 'closeIssue', 'refresh', 'gitAction', 'queryLogs'].includes(request.type)), false);
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

test('bounds the dashboard without a maximize control and keeps GitLab support details in settings', async (t) => {
  const data = snapshot('developer');
  data.instance = { version: '16.11.10', enterprise: false, warnings: ['Minimum version note'], capabilities: [{ id: 'timelogReport', label: '個別工時紀錄', status: 'supported', source: 'GraphQL' }] };
  const view = await mount({ mode: 'developer' }, data);
  t.after(() => view.dom.window.close());
  const document = view.dom.window.document;
  const shell = document.querySelector('.app-shell');
  assert.ok(shell);
  assert.equal(document.querySelector('button[aria-label="放大／還原工作台"]'), null);
  assert.equal(document.querySelector('.page > .alert[role="status"]'), null, 'instance diagnostics do not take space in the main dashboard');
  document.querySelector('.settings-trigger').click();
  await view.tick();
  assert.equal(view.requests.some((request) => request.type === 'toggleFullDisplay'), false);
  assert.match(document.querySelector('.instance-capabilities').textContent, /GitLab 16\.11\.10.*Minimum version note/s);
  assert.match(document.querySelector('.instance-capabilities').textContent, /個別工時紀錄.*支援.*GraphQL/s);
  assert.match(dashboardCss, /\.app-shell\s*\{[^}]*height:\s*100dvh/s);
  assert.match(dashboardCss, /\.topbar\s*\{[^}]*flex:\s*0\s+0\s+auto/s);
  assert.match(dashboardCss, /\.page\s*\{[^}]*overflow:\s*auto/s);
  assert.match(dashboardCss, /\.issue-list-panel\s*\{[^}]*overflow:\s*auto/s);
  assert.match(dashboardCss, /\.tool-drawer\s*\{[^}]*overflow:\s*auto/s);
  assert.match(dashboardCss, /\.statusbar\s*\{[^}]*flex:\s*0\s+0\s+auto/s);
});

test('retired Issue development navigation and saved tabs reopen on Content', async t => {
  const data = snapshot(); data.instanceUserScope = 'retired-tab-scope';
  const issue = data.issues[0], project = data.projects.find(item => item.id === issue.project_id);
  const key = `${issue.project_id}:${issue.iid}`;
  const view = await mount({ mode: 'developer', issueEditorDrafts: {
    [data.instanceUserScope]: { tabs: { [key]: { tab: 'development', revision: 20 } } }
  } }, data);
  t.after(() => view.dom.window.close());
  for (const revision of [20, 21]) {
    view.send({ type: 'issueNavigation', navigation: { mode: 'detail', projectId: issue.project_id,
      issueIid: issue.iid, tab: 'development', revision } }); await view.tick();
    view.send({ type: 'issueResponse', revision, response: { type: 'detailData', data: issueDetailData(issue, project) } }); await view.tick();
    const tabs = [...view.dom.window.document.querySelectorAll('.issue-tabs [role="tab"]')];
    assert.deepEqual(tabs.map(tab => tab.textContent.trim()), ['內容與討論', '關聯與子工作', '工時']);
    assert.equal(tabs.find(tab => tab.getAttribute('aria-selected') === 'true').textContent.trim(), '內容與討論');
    assert.equal(view.requests.some(request => /Delivery|copyAndOpenCodex/.test(request.type)), false);
  }
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
  assert.equal(document.querySelector('.wiki-guide-card h2').id, 'wiki-card-title-query');
  assert.equal(document.querySelector('.wiki-guide-intro'), null);
  assert.deepEqual([...document.querySelectorAll('.skills-feature-navigation button')].map(button => button.id.replace('skill-feature-','')).sort(), [
    'ingest', 'query', 'functional-exploration', 'lint', 'audit', 'adr',
    'synthesis', 'visualize', 'business-analysis', 'system-analysis', 'system-design', 'notebooklm-export', 'archaeology'
  ].sort());

  assert.equal(selectedSkillFeature(document), 'query');
  const devPreview = document.querySelector('.wiki-prompt-preview');
  assert.ok(devPreview.textContent.includes('renamed-alpha → C:/workspace/team/renamed-alpha'));
  assert.ok(devPreview.textContent.includes('unmapped-tools → C:/workspace/team/unmapped-tools'));
  assert.equal(devPreview.textContent.includes('team/alpha'), false);

  selectSkillFeature(document, 'query');

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
  view.send({ type: 'notificationsChanged', snapshot: { sessionId: 'session-one', revision: 1, unreadCount: 1,
    items: [{ id: 'notice:copied', level: 'info', title: '複製提示詞', messages: ['Prompt copied'], createdAt: 1, updatedAt: 1, read: false }] } });
  await view.tick();
  assert.equal(document.querySelector('.toast'), null);
  assert.match(document.querySelector('.notifications-trigger').textContent, /1/);

  selectSkillFeature(document, 'functional-exploration');

  await view.tick();
  assert.equal(document.querySelector('.wiki-guide-card h2').id, 'wiki-card-title-functional-exploration');
  assert.equal(document.querySelector('.wiki-copy-button').disabled, false);
  document.querySelector('.wiki-copy-button').click();
  await view.tick();
  assert.match(view.requests.at(-1).text, /functional_exploration.*先從目前原始碼/s);
  assert.match(view.requests.at(-1).text, /不執行目標程式或測試/);
  assert.match(view.requests.at(-1).text, /不保存文件/);

  selectSkillFeature(document, 'audit');

  await view.tick();
  const auditScope = document.querySelector('[id="wiki-input-audit.scope"]');
  auditScope.value = 'src/payments';
  auditScope.dispatchEvent(new view.dom.window.Event('input', { bubbles: true }));
  await view.tick();
  selectSkillFeature(document, 'query');

  await view.tick();
  assert.equal(document.querySelector('[id="wiki-input-query.question"]').value, query.value);
  assert.equal(view.savedState.wikiGuideSelectionsByScope['project:C:/workspace/team:local'], 'query');
  assert.equal(view.savedState.wikiGuideInputsByScope['project:C:/workspace/team:local']['query.question'], query.value);
  assert.equal(view.savedState.wikiGuideInputsByScope['project:C:/workspace/team:local']['audit.scope'], 'src/payments');

  const reopened = await mount(view.savedState, selectedGroup);
  t.after(() => reopened.dom.window.close());
  assert.equal(selectedSkillFeature(reopened.dom.window.document), 'query');
  assert.equal(reopened.dom.window.document.querySelector('[id="wiki-input-query.question"]').value, query.value);

  document.querySelector('.skills-install-button').click();
  await view.tick();
  assert.ok(document.querySelector('[role="dialog"]'));
});

test('offline installation exposes the shared root, reset, errors and busy states', async t => {
  const state = snapshot('sa'); state.connected = false; state.group = undefined;
  setProjectContext(state, 'C:/local/repo', true); state.workflowKitInstallTarget.state = { status: 'missing' };
  const view = await mount({ mode: 'sa' }, state); t.after(() => view.dom.window.close());
  const document = view.dom.window.document; document.querySelector('.settings-trigger').click(); await view.tick();
  const button = text => [...document.querySelectorAll('.tool-drawer button')].find(item => item.textContent === text);
  assert.equal(document.querySelector('.project-root-path').textContent, 'C:/local/repo');
  assert.equal(document.querySelector('.workflow-kit-install-button').disabled, false);
  button('選擇共用根目錄').click(); assert.equal(view.requests.at(-1).type, 'selectProjectRoot');
  await view.tick(); button('恢復 VS Code 根目錄').click(); assert.equal(view.requests.at(-1).type, 'resetProjectRoot');
  for (const status of ['checking', 'installing', 'needs-cleanup']) {
    state.workflowKitInstallTarget.state = { status }; view.sendSnapshot(state); await view.tick();
    assert.equal(document.querySelector('.workflow-kit-install-button').disabled, true);
    if (status === 'installing') assert.equal(button('選擇共用根目錄').disabled, true);
  }
  state.workflowKitInstallTarget = { manual: true, error: '專案根目錄不存在', state: { status: 'error' } };
  state.projectContext.root = undefined; state.projectContext.error = '專案根目錄不存在'; view.sendSnapshot(state); await view.tick();
  assert.equal(document.querySelector('.workflow-kit-install-button').disabled, true);
  assert.equal(document.querySelector('.project-root-path').textContent, '專案根目錄不存在');
});

test('settings shows the checked installation while full Skills discovery is deferred', async t => {
  const state = snapshot('clone'); setProjectContext(state, 'C:/local/repo', true);
  state.workflowKitInstallTarget.state = { status: 'installed', version: '0.9.0', profile: 'repository' };
  state.skillsContext = { mode: 'unavailable', root: 'C:/local/repo', installed: { status: 'missing' },
    repositories: [], availableFeatures: [], revision: 'deferred', reason: 'Skills environment has not been discovered' };
  const view = await mount({ mode: 'clone' }, state); t.after(() => view.dom.window.close());
  const document = view.dom.window.document; document.querySelector('.settings-trigger').click(); await view.tick();
  assert.match(document.querySelector('.workflow-kit-skills-root').textContent, /C:\/local\/repo · 已安裝/);
  assert.equal(document.querySelector('.workflow-kit-install-button').textContent, '下載並更新');
  assert.equal(document.querySelector('.workflow-kit-install-button').disabled, false);
  assert.ok(!document.querySelector('.tool-drawer').textContent.includes(state.skillsContext.reason));
  state.workflowKitInstallTarget.profile = 'group'; view.sendSnapshot(state); await view.tick();
  assert.match(document.querySelector('.tool-drawer').textContent, /安裝的 Skills 流程與目前專案不同/);
});

test('Skills offers online Releases and one shared root without Group mode controls', async t => {
  const state = snapshot('sa'); state.connected = false; state.group = undefined;
  state.workflowKitSource = 'github'; state.workflowKitReleases[0].source = 'github';
  state.workflowKitInstallTarget.root = 'C:/local/repo'; setSkillsContext(state);
  const view = await mount({ mode: 'sa' }, state); t.after(() => view.dom.window.close());
  const document = view.dom.window.document; document.querySelector('.settings-trigger').click(); await view.tick();
  assert.equal(document.querySelector('.skills-policy'), null); assert.equal(document.querySelector('[aria-label="Group 對應狀態"]'), null);
  const button = text => [...document.querySelectorAll('.tool-drawer button')].find(item => item.textContent === text);
  assert.equal(button('選擇共用根目錄').disabled, false); assert.equal(button('開啟 GitHub Release').disabled, false);
  button('開啟 GitHub Release').click(); assert.equal(view.requests.at(-1).type, 'openWorkflowKitDownload');
  state.workflowKitOperationBusy = true; view.sendSnapshot(state); await view.tick();
  assert.equal(button('選擇共用根目錄').disabled, true); assert.equal(button('匯入組合包 ZIP'), undefined); assert.equal(button('檢查最新正式版').disabled, true);
});

test('online setup explicitly checks Releases and offers only GitHub and Gitea sources', async t => {
  const state = snapshot('clone'); setProjectContext(state, 'C:/local/repo', true);
  state.workflowKitReleases = []; state.workflowKitInstallTarget.state = { status: 'missing' };
  const view = await mount({ mode: 'clone' }, state); t.after(() => view.dom.window.close());
  const document = view.dom.window.document; document.querySelector('.settings-trigger').click(); await view.tick();
  const tools = document.querySelector('.tool-settings');
  assert.deepEqual([...tools.querySelectorAll('select option')].map(option => option.value), ['github', 'gitea']);
  assert.equal(tools.querySelectorAll('select').length, 1);
  assert.equal(document.querySelector('.workflow-kit-install-button').disabled, true);
  assert.equal(view.requests.some(request => request.type === 'checkWorkflowKitReleases'), false);
  assert.equal([...tools.querySelectorAll('button')].some(button => button.textContent.includes('匯入')), false);
  [...tools.querySelectorAll('button')].find(button => button.textContent === '檢查最新正式版').click();
  assert.equal(view.requests.at(-1).type, 'checkWorkflowKitReleases');
  assert.equal(view.requests.at(-1).source, 'github');
});

test('online installation sends a Release identity without a client-controlled local archive', async t => {
  const state = snapshot('clone'); setProjectContext(state, 'C:/local/repo', true);
  state.workflowKitInstallTarget.state = { status: 'missing' };
  const view = await mount({ mode: 'clone' }, state); t.after(() => view.dom.window.close());
  const document = view.dom.window.document; document.querySelector('.settings-trigger').click(); await view.tick();
  assert.ok(document.querySelector('.tool-settings').textContent.includes('最新正式版 v1.0.0'));
  const button = document.querySelector('.workflow-kit-install-button');
  assert.equal(button.disabled, false); button.click();
  assert.equal(view.requests.at(-1).type, 'installWorkflowKit');
  assert.equal(view.requests.at(-1).releaseId, 'github-1.0.0');
  assert.equal(Object.hasOwn(view.requests.at(-1), 'archivePath'), false);
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
  const scope = document.querySelector('[id="wiki-input-query.question"]');
  scope.value = 'Retry behavior'; scope.dispatchEvent(new view.dom.window.Event('input', { bubbles: true }));
  await view.tick();
  assert.equal(document.querySelector('.wiki-copy-button').disabled, true);
  document.querySelector('.skills-install-button').click(); await view.tick();
  assert.match(document.querySelector('.workflow-kit-skills-root').textContent, /C:\/another\/repo/);
  assert.equal(document.querySelector('.workflow-kit-install-button').textContent, '下載並更新');
  state.workflowKit = { status: 'installed', version: '0.9.0' };
  view.sendSnapshot(state); await view.tick();
  assert.equal(document.querySelector('.wiki-copy-button').disabled, false);
});

test('keeps Wiki inputs when Group changes and separates drafts by local project root', async (t) => {
  const view = await mount({ mode: 'sa', scopeKey: 'team-scope' }, snapshot('sa'));
  t.after(() => view.dom.window.close());
  const document = view.dom.window.document;
  selectSkillFeature(document, 'query');

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
  assert.equal(selectedSkillFeature(document), 'query');
  assert.equal(document.querySelector('[id="wiki-input-query.question"]').value, 'Team A query', 'Group changes preserve the current local draft');
  groupB.projectContext = { ...groupB.projectContext, root: 'C:/workspace/another-team', revision: 'another-root' };
  view.sendSnapshot(groupB); await view.tick();
  selectSkillFeature(document, 'query');

  await view.tick();
  const secondQuery = document.querySelector('[id="wiki-input-query.question"]');
  secondQuery.value = 'Team B query';
  secondQuery.dispatchEvent(new view.dom.window.Event('input', { bubbles: true }));
  await view.tick();

  view.sendSnapshot(snapshot('sa'));
  await view.tick();
  assert.equal(selectedSkillFeature(document), 'query');
  assert.equal(document.querySelector('[id="wiki-input-query.question"]').value, 'Team A query');
  assert.equal(view.savedState.wikiGuideSelectionsByScope['project:C:/workspace/team:local'], 'query');
  assert.equal(view.savedState.wikiGuideSelectionsByScope['project:C:/workspace/another-team:local'], 'query');
  assert.equal(view.savedState.wikiGuideInputsByScope['project:C:/workspace/team:local']['query.question'], 'Team A query');
  assert.equal(view.savedState.wikiGuideInputsByScope['project:C:/workspace/another-team:local']['query.question'], 'Team B query');
});

test('blocks Wiki prompt copying until the VS Code Group workspace, Repo scan, and workflow kit are ready', async (t) => {
  const state = snapshot('sa');
  state.groupRoot = undefined;
  state.groupRepositoryScanStatus = 'idle';
  state.workflowKit = { status: 'missing' };
  const view = await mount({ mode: 'sa' }, state);
  t.after(() => view.dom.window.close());
  const document = view.dom.window.document;
  const query = document.querySelector('[id="wiki-input-query.question"]');
  query.value = 'Retry behavior';
  query.dispatchEvent(new view.dom.window.Event('input', { bubbles: true }));
  await view.tick();
  assert.equal(document.querySelector('.wiki-copy-button').disabled, true);
  assert.ok(document.querySelector('.skills-feature-navigation'));
  assert.equal(document.querySelector('.wiki-guide-intro'), null);
});
test('three Skills tools preserve legacy Wiki drafts and isolate release inputs across roots and reopening', async (t) => {
  const data = snapshot('sa');
  const selectedRepo = 'C:/工作區 with spaces/service';
  data.groupRepositories = [{ name: 'service', path: selectedRepo }, { name: 'alpha', path: 'C:/workspace/team/alpha' }];
  const view = await mount({ mode: 'sa', scopeKey: 'team-scope',
    wikiGuideInputsByScope: { 'team-scope': { 'query.question': '保留的 Wiki 問題' } },
    wikiGuideSelectionsByScope: { 'team-scope': 'query' } }, data);
  t.after(() => view.dom.window.close());
  const document = view.dom.window.document;
  const change = async (selector, value, event = 'change') => {
    if (selectSkillControl(document,selector,value)) { await view.tick(); return; }
    const input = document.querySelector(selector);
    input.value = value;
    input.dispatchEvent(new view.dom.window.Event(event, { bubbles: true }));
    await view.tick();
  };
  assert.equal(document.querySelectorAll('.skills-tool-tabs [role=tab]').length, 3);
  assert.equal(document.querySelector('[id="wiki-input-query.question"]').value, '保留的 Wiki 問題');
  await change('.skills-tool-selector select', 'release-reviewer');
  assert.equal(selectedSkillFeature(document), 'release-review');
  assert.equal(document.querySelector('.wiki-copy-button').disabled, true);
  await change('[id="wiki-input-release-review.repo"]', selectedRepo);
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
  assert.match(copy.text, /review_session\.py" start --workspace/);
  assert.equal(copy.text.includes('--include-json'), false);
  assert.match(copy.text, /Checklist/);
  assert.match(copy.text, /VSCode 工作區根目錄：C:\/workspace\/team/);
  assert.match(copy.text, /本機實際 Git Repo/);

  await change('.skills-tool-selector select', 'codebase-wiki');
  assert.equal(document.querySelector('[id="wiki-input-query.question"]').value, '保留的 Wiki 問題');
  await change('.skills-tool-selector select', 'merge-reviewer');
  await change('.wiki-guide-selector select', 'merge-repo');
  assert.match(document.querySelector('.wiki-prompt-preview').textContent, /ReviewExecutionPolicy\/v1/);
  await change('.skills-tool-selector select', 'release-reviewer');

  const groupB = snapshot('sa');
  groupB.connectedScope = 'another-group-scope';
  groupB.groupRoot = 'C:/workspace/another-team';
  groupB.projectContext = { ...groupB.projectContext, root: groupB.groupRoot, revision: 'another-root' };
  groupB.group = { ...groupB.group, id: 9, full_path: 'another-team' };
  groupB.groupRepositories = [
    { name: 'other-service', path: 'C:/workspace/another-team/other-service' },
    { name: 'tools', path: 'C:/workspace/another-team/tools' }
  ];
  view.sendSnapshot(groupB);
  await view.tick();
  assert.equal(selectedSkillTool(document), 'codebase-wiki');
  await change('.skills-tool-selector select', 'release-reviewer');
  assert.equal(document.querySelector('[id="wiki-input-release-review.repo"]').value, '');
  assert.equal(document.querySelector('[id="wiki-input-release-review.mode"]'), null);
  await change('[id="wiki-input-release-review.repo"]', 'C:/workspace/another-team/other-service');

  view.sendSnapshot(data);
  await view.tick();
  assert.equal(selectedSkillTool(document), 'release-reviewer');
  assert.equal(document.querySelector('[id="wiki-input-release-review.repo"]').value, selectedRepo);
  assert.equal(document.querySelector('[id="wiki-input-release-review.mode"]'), null);
  assert.equal(view.savedState.skillsGuideByScope['project:C:/workspace/another-team:local'].inputs['release-review.repo'], 'C:/workspace/another-team/other-service');
  const reopened = await mount(view.savedState, data);
  t.after(() => reopened.dom.window.close());
  assert.equal(selectedSkillTool(reopened.dom.window.document), 'release-reviewer');
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
  selectSkillTool(document, 'release-reviewer');

  await view.tick();
  assert.equal(document.querySelector('[id="wiki-input-release-review.repo"]').tagName, 'SELECT');
  assert.equal(document.querySelector('[id="wiki-input-release-review.repo"]').value, 'C:/workspace/team/alpha', 'a single candidate is selected automatically');
  for (const [key, value] of Object.entries({ base: 'origin/main', head: 'feature/payment' })) {
    const input = document.querySelector(`[id="wiki-input-release-review.${key}"]`);
    input.value = value;
    input.dispatchEvent(new view.dom.window.Event('input', { bubbles: true }));
  }
  await view.tick();
  assert.equal(document.querySelector('[id="wiki-input-release-review.repo"]').value, 'C:/workspace/team/alpha');
  assert.equal(document.querySelector('[id="wiki-input-release-review.base"]').value, 'origin/main');
  assert.equal(document.querySelector('[id="wiki-input-release-review.head"]').value, 'feature/payment');
  assert.equal(document.querySelector('.wiki-copy-button').disabled, false);
});

test('reviewer branch replies correlate requests across Repo switches, retries and workspace revisions', async t => {
  for (const [tool, card] of [['merge-reviewer', 'merge-repo'], ['release-reviewer', 'release-review']]) {
    await t.test(tool, async t => {
      const data = snapshot('sa');
      data.connected = false;
      data.group = undefined;
      setSkillsContext(data);
      const repositories = [
        { name: 'alpha', path: 'C:/workspace/team/alpha' },
        { name: 'beta', path: 'C:/workspace/team/beta' }
      ];
      data.skillsContext.reviewerRepositories = repositories;
      const view = await mount({ mode: 'sa' }, data); t.after(() => view.dom.window.close());
      const document = view.dom.window.document;
      selectSkillTool(document, tool); await view.tick();
      const reads = () => view.requests.filter(request => request.type === 'loadSkillBranches');
      const choose = async repo => {
        const select = document.getElementById(`wiki-input-${card}.repo`);
        assert.equal(select.tagName, 'SELECT');
        select.value = repo;
        select.dispatchEvent(new view.dom.window.Event('change', { bubbles: true }));
        await view.tick();
        return reads().at(-1);
      };
      const reply = async (request, branches, patch = {}) => {
        view.send({ ...request, type: 'skillBranches', branches, ...patch });
        await view.tick();
      };
      const branchOptions = async () => {
        const input = document.getElementById(`wiki-input-${card}.base`);
        input.dispatchEvent(new view.dom.window.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }));
        await view.tick();
        return [...document.querySelectorAll('[role="listbox"] [role="option"]')].map(option => option.textContent);
      };
      assert.equal(reads().length, 0, 'multiple Repo candidates require an explicit selection');
      const firstA = await choose(repositories[0].path);
      const firstB = await choose(repositories[1].path);
      const currentA = await choose(repositories[0].path);
      assert.equal(reads().length, 3, 'each actual Repo change starts a fresh read without GitLab connectivity');
      for (const request of [firstA, firstB, currentA]) {
        assert.ok(request.requestId, 'each read has a correlation ID');
        assert.equal(request.revision, data.skillsContext.revision);
      }
      assert.equal(new Set([firstA.requestId, firstB.requestId, currentA.requestId]).size, 3);
      await reply(firstA, ['stale/first-a']);
      await reply(firstB, ['stale/first-b']);
      assert.deepEqual(await branchOptions(), [], 'A → B → A cannot accept either earlier reply');
      await reply(currentA, ['origin/current-a', 'feature/current-a']);
      assert.deepEqual(await branchOptions(), ['origin/current-a', 'feature/current-a']);
      await reply(currentA, ['stale/wrong-repo'], { repo: repositories[1].path });
      await reply(currentA, ['stale/wrong-revision'], { revision: 'obsolete-workspace-revision' });
      assert.deepEqual(await branchOptions(), ['origin/current-a', 'feature/current-a'], 'matching request ID also requires its Repo and workspace revision');

      const base = document.getElementById(`wiki-input-${card}.base`);
      const head = document.getElementById(`wiki-input-${card}.head`);
      for (const [input, value] of [[base, 'origin/main'], [head, 'feature/manual']]) {
        input.value = value;
        input.dispatchEvent(new view.dom.window.Event('input', { bubbles: true }));
      }
      await view.tick();
      document.querySelector('.skills-branch-refresh').click(); await view.tick();
      const retryA = reads().at(-1);
      assert.notEqual(retryA.requestId, currentA.requestId, 'same-Repo refresh starts a distinct request');
      assert.equal(base.value, 'origin/main');
      assert.equal(head.value, 'feature/manual');
      await reply(currentA, ['stale/before-refresh']);
      assert.equal(document.querySelector('.skills-branch-refresh').disabled, true, 'an older response cannot finish the refresh');
      await reply(retryA, [], { error: 'Branch read failed' });
      assert.match(document.querySelector('.skills-branch-status').textContent, /Branch read failed/);
      assert.equal(document.querySelector('.wiki-copy-button').disabled, false, 'manual branches remain usable after a list error');
      document.querySelector('.skills-branch-refresh').click(); await view.tick();
      const recoveryA = reads().at(-1);
      assert.notEqual(recoveryA.requestId, retryA.requestId);
      await reply(recoveryA, ['origin/recovered']);
      assert.doesNotMatch(document.querySelector('.skills-branch-status')?.textContent ?? '', /Branch read failed/);

      const nextData = structuredClone(data);
      nextData.skillsContext.revision += '-next';
      view.sendSnapshot(nextData); await view.tick();
      const nextRevision = reads().at(-1);
      assert.equal(nextRevision.revision, nextData.skillsContext.revision);
      assert.notEqual(nextRevision.requestId, recoveryA.requestId);
      await reply(recoveryA, ['stale/old-workspace']);
      assert.equal(document.querySelector('.skills-branch-refresh').disabled, true, 'old-workspace replies cannot complete the new read');
      await reply(nextRevision, ['origin/next-workspace']);
      assert.equal(document.querySelector('.skills-branch-refresh').disabled, false);
      assert.equal(document.getElementById(`wiki-input-${card}.base`).value, 'origin/main', 'workspace refresh retains the draft branches');
      assert.equal(document.getElementById(`wiki-input-${card}.head`).value, 'feature/manual');
      assert.ok(!document.querySelector('.wiki-guide-card').textContent.includes('stale/'));
      const nextScope = { ...nextData, operationScope: 'reconnected-same-skills' };
      view.sendSnapshot(nextScope); await view.tick();
      const scopeRead = reads().at(-1);
      assert.equal(scopeRead.revision, nextRevision.revision);
      assert.notEqual(scopeRead.requestId, nextRevision.requestId, 'changing only operation scope reloads the retained Repo');
      await reply(nextRevision, ['stale/old-operation-scope']);
      assert.equal(document.querySelector('.skills-branch-refresh').disabled, true);
      await reply(scopeRead, ['origin/reconnected']);
      assert.equal(document.querySelector('.skills-branch-refresh').disabled, false);
    });
  }
});

test('MR branch review keeps the selected workspace Repo and carried branches in preview and copy inputs', async t => {
  const data = snapshot('reviewer');
  setSkillsContext(data);
  data.skillsContext.reviewerRepositories = [
    { name: 'alpha', path: 'C:/workspace/team/alpha' },
    { name: 'beta', path: 'C:/workspace/team/beta' }
  ];
  const request = { id: 41, iid: 4, project_id: 2, title: 'Beta review', state: 'opened', source_branch: 'feature/payment', target_branch: 'main', web_url: 'https://gitlab.example.test/team/beta/-/merge_requests/4' };
  data.mergeRequests = [request];
  data.selectedMergeRequest = { request, diffs: [], discussions: [], warnings: [], freshness: { state: 'not_checked' },
    sections: { diffs: { status: 'ready' }, discussions: { status: 'ready' } } };
  const view = await mount({ mode: 'reviewer' }, data); t.after(() => view.dom.window.close());
  const document = view.dom.window.document;
  [...document.querySelectorAll('.reviewer-detail button')].find(button => button.textContent === '前往分支審查').click(); await view.tick();
  assert.deepEqual(view.requests.findLast(request => request.type === 'openBranchReview'), { type: 'openBranchReview', projectId: 2, iid: 4 });
  const inputs = { 'merge-repo.repo': 'C:/workspace/team/beta', 'merge-repo.base': 'origin/main', 'merge-repo.head': 'origin/feature/payment' };
  view.send({ type: 'branchReviewReady', revision: 'obsolete-revision', inputs }); await view.tick();
  assert.equal(document.querySelector('.page').dataset.mode, 'reviewer', 'an obsolete entry reply cannot change modes or inputs');
  view.send({ type: 'branchReviewReady', revision: data.skillsContext.revision, inputs }); await view.tick();
  assert.equal(selectedSkillTool(document), 'merge-reviewer');
  for (const [key, value] of Object.entries(inputs)) assert.equal(document.getElementById(`wiki-input-${key}`).value, value);
  assert.equal(view.requests.findLast(request => request.type === 'loadSkillBranches').repo, inputs['merge-repo.repo']);
  assert.ok(document.querySelector('.wiki-prompt-preview').textContent.includes('--project "C:/workspace/team/beta"'));
  assert.equal(document.querySelector('.wiki-copy-button').disabled, true, 'MR branches still require the existing explicit confirmation');
  [...document.querySelectorAll('.wiki-guide-card button')].find(button => button.textContent === '確認使用分支審查').click(); await view.tick();
  assert.equal(document.querySelector('.wiki-copy-button').disabled, false);
  document.querySelector('.wiki-copy-button').click(); await view.tick();
  const copy = view.requests.findLast(request => request.type === 'copySkillGuidePrompt');
  assert.equal(copy.featureId, 'merge-repo');
  assert.equal(copy.revision, data.skillsContext.revision);
  for (const [key, value] of Object.entries(inputs)) assert.equal(copy.inputs[key], value);
});

test('reviewer branch preflight failures settle only the current read and expose retry', async t => {
  for (const status of ['failed', 'cancelled']) await t.test(status, async t => {
    const data = snapshot('sa');
    setSkillsContext(data);
    data.skillsContext.reviewerRepositories = [{ name: 'alpha', path: 'C:/workspace/team/alpha' }];
    const view = await mount({ mode: 'sa' }, data, {}, () => {}, { autoOperations: false });
    t.after(() => view.dom.window.close());
    const document = view.dom.window.document;
    selectSkillTool(document, 'release-reviewer'); await view.tick();
    const reads = () => view.rawRequests.filter(request => request.type === 'loadSkillBranches');
    const first = reads().at(-1);
    assert.ok(first?.operationId);
    const refresh = () => document.querySelector('.skills-branch-refresh');
    view.receipt({ ...first, operationId: 'unrelated-branch-operation' }, { status, error: 'Unrelated failure' }); await view.tick();
    assert.equal(refresh().disabled, true, 'an unrelated terminal receipt cannot finish the active read');
    view.receipt({ ...first, operationScope: 'obsolete-operation-scope' }, { status, correlationId: first.requestId, error: 'Old scope failure' }); await view.tick();
    assert.equal(refresh().disabled, true, 'even matching correlation cannot settle a read from another operation scope');
    view.receipt(first, { status, correlationId: first.requestId, error: 'Preflight rejected' }); await view.tick();
    assert.equal(refresh().disabled, false, 'a matching failure releases the branch retry control without a domain reply');
    assert.match(document.querySelector('.skills-branch-status').textContent, /Preflight rejected/);
    refresh().click(); await view.tick();
    const retry = reads().at(-1);
    assert.notEqual(retry.operationId, first.operationId);
    assert.notEqual(retry.requestId, first.requestId);
    view.receipt(first, { status, correlationId: first.requestId, error: 'Delayed old failure' }); await view.tick();
    assert.equal(refresh().disabled, true, 'an old read receipt cannot cancel its replacement');
    view.send({ type: 'skillBranches', repo: retry.repo, requestId: retry.requestId, revision: retry.revision, branches: ['main'] }); await view.tick();
    assert.equal(refresh().disabled, false);
    assert.doesNotMatch(document.querySelector('.skills-branch-status').textContent, /Preflight rejected|Delayed old failure|Unrelated failure/);
  });
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
  view.send({ type: 'issueResponse', revision: 12, response: { type: 'reply', requestId: failedRequest.request.requestId, error: 'Clipboard denied', notificationOnly: true } });
  await view.tick();
  assert.equal(document.querySelector('[role="alert"]'), null, 'operation errors are shown by the host message center');
});
test('unresolved project locations open the common root settings and disable downloads', async t => {
  const state = snapshot('clone'); state.cloneRoot = undefined; state.cloneRootError = '請選擇專案資料夾';
  const view = await mount({ mode: 'clone' }, state); t.after(() => view.dom.window.close());
  const document = view.dom.window.document; assert.equal(document.querySelector('.clone-submit').disabled, true);
  document.querySelector('.clone-select-root').click(); await view.tick();
  assert.ok(document.querySelector('[aria-label="共用專案根目錄"]'));
  assert.equal(view.requests.some(request => request.type === 'selectCloneRoot'), false);
});

test('mixed workspaces use the common root for downloads, sync and settings', async t => {
  const state = snapshot('clone'); setProjectContext(state, 'C:/mixed', true);
  state.projectLocalRepositories = { 1: { path: 'C:/mixed/alpha', state: 'ready' } };
  const view = await mount({ mode: 'clone', scopeKey: 'team-scope', selectedProjectIds: [1] }, state); t.after(() => view.dom.window.close());
  const document = view.dom.window.document; assert.equal(document.querySelector('.clone-submit').disabled, false);
  assert.match(document.querySelector('.clone-root-line').textContent, /mixed/);
  document.querySelector('.clone-submit').click(); assert.equal(view.requests.at(-1).type, 'clone');
  const sync = [...document.querySelectorAll('.more-actions-panel button')].find(button => button.textContent === '更新全部本機預設分支');
  await view.tick(); sync.click(); assert.equal(view.requests.at(-1).type, 'syncRepos');
  assert.equal(Object.hasOwn(view.requests.at(-1), 'projectIds'), false);
  document.querySelector('.clone-select-root').click(); await view.tick();
  const reset = [...document.querySelectorAll('.tool-drawer button')].find(button => button.textContent === '恢復 VS Code 根目錄');
  reset.click(); assert.equal(view.requests.at(-1).type, 'resetProjectRoot');
  view.sendSnapshot({ ...state, busy: true }); await view.tick(); assert.equal(reset.disabled, true);
});

test('settings display the same root for installation and Skills', async t => {
  const state = snapshot('sa'); setSkillsContext(state, 'group');
  const view = await mount({ mode: 'sa' }, state); t.after(() => view.dom.window.close());
  const document = view.dom.window.document; document.querySelector('.settings-trigger').click(); await view.tick();
  for (const selector of ['.project-root-path', '.workflow-kit-skills-root']) {
    assert.ok(document.querySelector(selector).textContent.includes(state.skillsContext.root), selector);
  }
  assert.equal(document.querySelector('.tool-drawer').textContent.includes('安裝版型：'), false);
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

test('partial Issue Board membership shows only known Issues, incomplete coverage, and scoped continue/cancel controls', async t => {
  const data = snapshot(); data.issueBoardContent = { boardId: 31, connectedScope: 'team-scope', issueIds: [101], loadedCount: 1, complete: false, status: 'partial', pausedReason: '本批已達請求數上限。' };
  const view = await mount({ mode: 'developer', scopeKey: 'team-scope', issueBoardId: 31 }, data); t.after(() => view.dom.window.close());
  const document = view.dom.window.document, notice = () => document.querySelector('[aria-label="Issue Board 載入狀態"]');
  assert.deepEqual([...document.querySelectorAll('.work-row .row-title')].map(item => item.textContent), ['Alpha milestone issue']);
  assert.match(notice().textContent, /已確認 1.*尚未完整載入/); assert.match(notice().textContent, /搜尋與篩選僅涵蓋/);
  [...notice().querySelectorAll('button')].find(button => button.textContent === '繼續載入看板').click(); await view.tick();
  assert.deepEqual(view.requests.findLast(request => request.type === 'selectIssueBoard'), { type: 'selectIssueBoard', boardId: 31, connectedScope: 'team-scope', mode: 'continue' });
  view.sendSnapshot({ ...data, issueBoardContent: { ...data.issueBoardContent, status: 'loading' } }); await view.tick();
  [...notice().querySelectorAll('button')].find(button => button.textContent === '取消看板載入').click(); await view.tick();
  assert.deepEqual(view.requests.findLast(request => request.type === 'selectIssueBoard'), { type: 'selectIssueBoard', boardId: 31, connectedScope: 'team-scope', mode: 'cancel' });
  view.sendSnapshot({ ...data, issueBoardContent: { ...data.issueBoardContent, issueIds: [], loadedCount: 0 } }); await view.tick();
  assert.match(document.querySelector('.empty-inline').textContent, /尚未完整載入/); assert.doesNotMatch(document.querySelector('.empty-inline').textContent, /此 Board 沒有指派給你的 Issue/);
  view.sendSnapshot({ ...data, issues: [], sections: { issues: { status: 'ready', complete: false } }, issueBoardContent: { ...data.issueBoardContent, complete: true, status: 'ready' } }); await view.tick();
  assert.match(document.querySelector('.empty-inline').textContent, /Issue 清單尚未完整載入/); assert.doesNotMatch(document.querySelector('.empty-inline').textContent, /此 Board 沒有指派給你的 Issue/);
  view.sendSnapshot(data); await view.tick();
  const filter = document.querySelector('select[aria-label="Issue Board"]'); filter.value = 'all'; filter.dispatchEvent(new view.dom.window.Event('change', { bubbles: true })); await view.tick();
  assert.equal(document.querySelectorAll('.work-row').length, 3); assert.equal(notice(), null);
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
  const graphRequest = view.requests.filter((request) => request.type === 'setIssueGraphVisibility' && request.visible).at(-1);
  assert.equal(graphRequest?.type, 'setIssueGraphVisibility');
  assert.equal(graphRequest?.connectedScope, 'team-scope');
  assert.equal(view.requests.some(request => request.type === 'loadIssueGraph'), false, 'the Host owns page-entry graph loading');
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

test('optional Issue filters load only on demand and retry failures without automatic requests', async t => {
  const data = { ...snapshot(), groupIssueBoards: [], groupMilestones: [],
    sections: { boards: { status: 'idle' }, milestones: { status: 'idle' } } };
  const view = await mount({ mode: 'developer', scopeKey: 'team-scope' }, data); t.after(() => view.dom.window.close());
  const document = view.dom.window.document;
  const ensureRequests = () => view.requests.filter(request => request.type === 'ensureWorkspaceSection');
  const button = label => [...document.querySelectorAll('.developer-filter-row button')].find(item => item.textContent === label);
  assert.equal(ensureRequests().length, 0);
  assert.equal(document.querySelector('select[aria-label="Issue Board"]'), null);
  assert.equal(document.querySelector('select[aria-label="Issue Milestone"]'), null);
  button('載入看板').click(); await view.tick();
  assert.deepEqual(ensureRequests(), [{ type: 'ensureWorkspaceSection', section: 'boards', connectedScope: 'team-scope' }]);
  const loading = { ...data, sections: { ...data.sections, boards: { status: 'loading' } } };
  view.sendSnapshot(loading); await view.tick();
  assert.equal(button('載入看板中…').disabled, true);
  view.sendSnapshot(loading); await view.tick();
  assert.equal(ensureRequests().length, 1);
  const failed = { ...data, groupIssueBoardsError: 'Board API unavailable',
    sections: { ...data.sections, boards: { status: 'error', error: 'Board API unavailable' } } };
  view.sendSnapshot(failed); await view.tick();
  assert.match(document.querySelector('.developer-filter-row [role="alert"]').textContent, /Board API unavailable/);
  view.sendSnapshot(failed); await view.tick();
  assert.equal(ensureRequests().length, 1, 'a failed snapshot never automatically retries');
  button('重試載入看板').click(); await view.tick();
  assert.equal(ensureRequests().length, 2);
  assert.equal(view.requests.some(request => request.type === 'retryWorkspaceSection'), false, 'the Host decides retry revalidation for the option demand');
  view.sendSnapshot({ ...data, groupIssueBoards: snapshot().groupIssueBoards,
    sections: { ...data.sections, boards: { status: 'ready', complete: true } } }); await view.tick();
  const boards = document.querySelector('select[aria-label="Issue Board"]');
  assert.equal(boards.options.length, 4);
  assert.ok(button('載入里程碑'));
  button('載入里程碑').click(); await view.tick();
  assert.equal(ensureRequests().at(-1).section, 'milestones');
  view.sendSnapshot(snapshot()); await view.tick();
  const milestones = document.querySelector('select[aria-label="Issue Milestone"]');
  milestones.value = '23'; milestones.dispatchEvent(new view.dom.window.Event('change', { bubbles: true })); await view.tick();
  assert.deepEqual([...document.querySelectorAll('.work-row .row-title')].map(item => item.textContent), ['Beta milestone issue']);
});

test('restored Board and Milestone filters ensure options once and survive empty, failed and partial lists', async t => {
  const data = { ...snapshot(), groupIssueBoards: [], groupMilestones: [], issueBoardContent: undefined,
    sections: { boards: { status: 'idle' }, milestones: { status: 'idle' } } };
  const view = await mount({ mode: 'developer', scopeKey: 'team-scope', issueBoardId: 31, graphBoardId: 32, issueMilestoneFilter: '23' }, data);
  t.after(() => view.dom.window.close());
  const document = view.dom.window.document;
  const ensures = () => view.requests.filter(request => request.type === 'ensureWorkspaceSection');
  const saved = () => view.savedState.scopedData['team-scope'];
  assert.deepEqual(ensures().map(request => request.section).sort(), ['boards', 'milestones']);
  assert.equal(document.querySelector('select[aria-label="Issue Board"]').value, '31');
  assert.equal(document.querySelector('select[aria-label="Issue Milestone"]').value, '23');
  assert.equal(view.requests.some(request => request.type === 'selectIssueBoard'), false);
  view.sendSnapshot(data); await view.tick();
  view.sendSnapshot({ ...data, groupIssueBoardsError: 'Board unavailable', groupMilestonesError: 'Milestone unavailable',
    sections: { boards: { status: 'error' }, milestones: { status: 'error' } } }); await view.tick();
  assert.equal(ensures().length, 2);
  assert.equal(saved().issueBoardId, 31); assert.equal(saved().graphBoardId, 32); assert.equal(saved().issueMilestoneFilter, '23');
  const partial = { ...data, groupIssueBoards: [snapshot().groupIssueBoards[0]], groupMilestones: [snapshot().groupMilestones[0]],
    sections: { boards: { status: 'ready', complete: false }, milestones: { status: 'ready', complete: false } } };
  view.sendSnapshot(partial); await view.tick();
  assert.equal(saved().issueBoardId, 31); assert.equal(saved().graphBoardId, 32); assert.equal(saved().issueMilestoneFilter, '23');
  assert.deepEqual(view.requests.findLast(request => request.type === 'selectIssueBoard'), { type: 'selectIssueBoard', boardId: 31, connectedScope: 'team-scope' });
  [...document.querySelectorAll('.developer-view-switch button')].find(item => item.textContent === '圖譜').click(); await view.tick();
  assert.equal(document.querySelector('select[aria-label="圖譜 Issue Board"]').value, '32');
  assert.equal(ensures().length, 2, 'switching views does not repeat option discovery');
  view.sendSnapshot({ ...snapshot(), groupIssueBoards: [snapshot().groupIssueBoards[0]],
    groupMilestones: [snapshot().groupMilestones[0]] }); await view.tick();
  assert.equal(saved().issueBoardId, 31); assert.equal(saved().graphBoardId, 'all'); assert.equal(saved().issueMilestoneFilter, 'all');
});

test('optional filter demand follows the active Group and graph entry with default filters reads no options', async t => {
  const data = { ...snapshot(), groupIssueBoards: [], groupMilestones: [],
    sections: { boards: { status: 'idle' }, milestones: { status: 'idle' } } };
  const view = await mount({ mode: 'developer', scopeKey: 'team-scope', developerView: 'graph', issueMilestoneFilter: 'none' }, data);
  t.after(() => view.dom.window.close());
  const document = view.dom.window.document;
  const ensures = () => view.requests.filter(request => request.type === 'ensureWorkspaceSection');
  assert.equal(ensures().length, 0, 'graph visibility and the no-Milestone filter need no option discovery');
  const loadBoards = () => [...document.querySelectorAll('.developer-filter-row button')].find(item => item.textContent === '載入看板');
  loadBoards().click(); await view.tick();
  assert.equal(ensures().at(-1).connectedScope, 'team-scope');
  view.sendSnapshot({ ...data, connectedScope: 'another-scope', group: data.groups[1] }); await view.tick();
  assert.equal(ensures().length, 1, 'previous Group requests do not become demand in the new Group');
  loadBoards().click(); await view.tick();
  assert.equal(ensures().at(-1).connectedScope, 'another-scope');
  view.sendSnapshot(data); await view.tick();
  assert.equal(ensures().length, 2);
  assert.equal(view.savedState.scopedData['team-scope'].issueMilestoneFilter, 'none');
});

test('restored filter demand resumes after cancellation and same-Group page reentry', async t => {
  const data = { ...snapshot(), groupIssueBoards: [], groupMilestones: [],
    sections: { boards: { status: 'idle' }, milestones: { status: 'idle' } } };
  const view = await mount({ mode: 'developer', scopeKey: 'team-scope', issueBoardId: 31 }, data);
  t.after(() => view.dom.window.close());
  const ensures = () => view.requests.filter(request => request.type === 'ensureWorkspaceSection');
  assert.equal(ensures().length, 1);
  view.sendSnapshot({ ...data, sections: { ...data.sections, boards: { status: 'loading' } } }); await view.tick();
  view.sendSnapshot(data); await view.tick();
  assert.equal(ensures().length, 2, 'an interrupted loading read may start again once it returns to idle');
  view.sendSnapshot(data); await view.tick();
  assert.equal(ensures().length, 2, 'ordinary idle snapshots do not resend the pending read');
  view.sendSnapshot({ ...data, activeMode: 'clone' }); await view.tick();
  view.sendSnapshot(data); await view.tick();
  assert.equal(ensures().length, 3, 'returning to the same Group resumes a discarded pending read');
  assert.equal(view.savedState.scopedData['team-scope'].issueBoardId, 31);
});

test('cold Issue graph keeps Board colors loadable without discovering options on entry', async t => {
  const data = { ...snapshot(), groupIssueBoards: [], groupMilestones: [],
    sections: { boards: { status: 'idle' }, milestones: { status: 'idle' } },
    issueGraph: { connectedScope: 'team-scope', status: 'ready', roots: [], nodes: [], edges: [], boardIssueIds: {}, boardStatus: {}, errors: [], updatedAt: Date.now() } };
  const view = await mount({ mode: 'developer', scopeKey: 'team-scope', developerView: 'graph' }, data);
  t.after(() => view.dom.window.close());
  const document = view.dom.window.document;
  const colors = [...document.querySelectorAll('.developer-graph-panel button')].find(button => button.textContent === '載入／繼續看板色彩');
  assert.equal(view.requests.some(request => request.type === 'ensureWorkspaceSection' || request.type === 'loadIssueGraph' && request.loadBoards), false);
  assert.equal(colors.disabled, false);
  colors.click(); await view.tick();
  assert.deepEqual(view.requests.findLast(request => request.type === 'loadIssueGraph'), { type: 'loadIssueGraph', connectedScope: 'team-scope', loadBoards: true });
  view.sendSnapshot({ ...data, sections: { ...data.sections, boards: { status: 'ready', complete: true } } }); await view.tick();
  assert.equal(colors.disabled, true, 'an explicitly complete empty Board list needs no further color reads');
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
  assert.ok([...document.querySelectorAll('.developer-filter-row button')].some(button => button.textContent === '重試載入看板'));
  assert.match(document.querySelector('.developer-filter-row [role="alert"]').textContent, /Board API unavailable/);
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

test('selected Repo sync requires a selection, preserves hidden selections and keeps an explicit all option', async t => {
  const data = snapshot('clone');
  const view = await mount({ mode: 'clone', scopeKey: 'team-scope' }, data); t.after(() => view.dom.window.close());
  const document = view.dom.window.document;
  const selectedSync = () => [...document.querySelectorAll('.more-actions-panel button')].find(button => button.textContent.startsWith('更新選取 Repo 預設分支'));
  const allSync = () => [...document.querySelectorAll('.more-actions-panel button')].find(button => button.textContent === '更新全部本機預設分支');
  assert.equal(selectedSync().disabled, true); selectedSync().click(); await view.tick();
  assert.equal(view.requests.some(request => request.type === 'syncRepos'), false);
  document.querySelectorAll('.repo-row input[type="checkbox"]')[0].click(); await view.tick();
  document.querySelectorAll('.repo-row input[type="checkbox"]')[2].click(); await view.tick();
  const search = document.querySelector('input[aria-label="搜尋 Repo"]');
  search.value = 'alpha'; search.dispatchEvent(new view.dom.window.Event('input', { bubbles: true })); await view.tick();
  assert.match(document.querySelector('.clone-selection-summary').textContent, /1 個不在目前搜尋結果/);
  assert.equal(selectedSync().disabled, false); selectedSync().click(); await view.tick();
  assert.deepEqual([...view.requests.findLast(request => request.type === 'syncRepos').projectIds], [1, 3]);
  allSync().click(); await view.tick();
  assert.equal(Object.hasOwn(view.requests.findLast(request => request.type === 'syncRepos'), 'projectIds'), false);
  view.sendSnapshot({ ...data, busy: true }); await view.tick();
  assert.equal(selectedSync().disabled, true); assert.equal(allSync().disabled, true);
  const requestCount = view.requests.filter(request => request.type === 'syncRepos').length;
  view.sendSnapshot({ ...data, connectedScope: 'other-team-scope', group: data.groups[1] }); await view.tick();
  assert.equal(selectedSync().disabled, true, 'a new Group never inherits the old sync selection');
  selectedSync().click(); await view.tick();
  assert.equal(view.requests.filter(request => request.type === 'syncRepos').length, requestCount);
});

test('project search and selection stay local until the user explicitly loads another list page', async t => {
  const data = { ...snapshot('clone'), sections: { projects: { status: 'ready', complete: false, loadedCount: 3 } } };
  const view = await mount({ mode: 'clone', scopeKey: 'team-scope' }, data); t.after(() => view.dom.window.close());
  const document = view.dom.window.document;
  view.send({ type: 'requestCloneSelection', requestId: 'selection-demand', scopeKey: 'team-scope' }); await view.tick();
  const baseline = view.requests.length;
  const search = document.querySelector('input[aria-label="搜尋 Repo"]');
  search.value = 'alpha'; search.dispatchEvent(new view.dom.window.Event('input', { bubbles: true })); await view.tick();
  document.querySelector('input[aria-label="全選搜尋結果"]').click(); await view.tick();
  assert.deepEqual(view.savedState.selectedProjectIds, [1]);
  view.send({ type: 'requestCloneSelection', requestId: 'selected-demand' }); await view.tick();
  assert.deepEqual([...view.requests.findLast(request => request.type === 'cloneSelection').projectIds], [1]);
  assert.equal(view.requests.slice(baseline).every(request => request.type === 'cloneSelection'), true,
    'search and selection send no project detail, option discovery, download or sync requests');
  const notice = [...document.querySelectorAll('.section-status')].find(item => item.textContent.includes('專案清單'));
  [...notice.querySelectorAll('button')].find(button => button.textContent === '載入更多').click(); await view.tick();
  assert.deepEqual(view.requests.findLast(request => request.type === 'retryWorkspaceSection'),
    { type: 'retryWorkspaceSection', section: 'projects', connectedScope: 'team-scope', mode: 'next' });
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

test('MR filters show all, reviewer-only and assigned-only requests and combine with search', async t => {
  const data = snapshot('reviewer');
  const me = data.currentUser;
  const other = { id: 8, username: 'other', name: 'Other User' };
  const request = (iid, projectId, title, reviewers, assignees) => ({
    id: iid, iid, project_id: projectId, title, state: 'opened', reviewers, assignees, author: other,
    source_branch: `feature/mr-${iid}`, target_branch: 'main'
  });
  data.mergeRequests = [
    request(1, 1, 'Reviewer only', [me], []),
    request(2, 1, 'Assignee only', [], [me]),
    request(3, 2, 'Both roles', [me], [me]),
    request(4, 2, 'Neither role', [other], [other])
  ];
  data.sections = { mergeRequests: { status: 'ready' } };
  const view = await mount({ mode: 'reviewer', scopeKey: 'team-scope' }, data);
  t.after(() => view.dom.window.close());
  const document = view.dom.window.document;
  const rowIds = () => [...document.querySelectorAll('.reviewer-layout .work-row .row-title')]
    .map(row => Number(row.textContent.match(/!(\d+)/)[1]));
  const chooseFilter = async label => {
    [...document.querySelectorAll('.reviewer-layout .filter-tabs button')].find(button => button.textContent === label).click();
    await view.tick();
  };
  const search = async value => {
    const input = document.querySelector('input[aria-label="搜尋 MR"]');
    input.value = value; input.dispatchEvent(new view.dom.window.Event('input', { bubbles: true }));
    await view.tick();
  };
  assert.deepEqual(rowIds(), [1, 2, 3, 4]);
  await chooseFilter('指定我為 Reviewer'); assert.deepEqual(rowIds(), [1, 3]);
  await search('only'); assert.deepEqual(rowIds(), [1]);
  await chooseFilter('指派給我'); assert.deepEqual(rowIds(), [2]);
  await search(''); assert.deepEqual(rowIds(), [2, 3]);
  await chooseFilter('全部'); assert.deepEqual(rowIds(), [1, 2, 3, 4]);
  await search('team/beta'); assert.deepEqual(rowIds(), [3, 4]);
  await chooseFilter('指定我為 Reviewer'); assert.deepEqual(rowIds(), [3]);
  await search('feature/mr-2'); assert.deepEqual(rowIds(), []);
  assert.match(document.querySelector('.reviewer-layout .list-column').textContent, /沒有符合目前條件的 MR/);
  await chooseFilter('指派給我'); assert.deepEqual(rowIds(), [2]);
  assert.doesNotMatch(document.querySelector('.reviewer-layout .list-column').textContent, /沒有符合目前條件的 MR/);
});

test('MR empty results appear only after a successful load and respect the current account and Group', async t => {
  const data = { ...snapshot('reviewer'), sections: { mergeRequests: { status: 'ready' } } };
  const view = await mount({ mode: 'reviewer', scopeKey: 'team-scope' }, data);
  t.after(() => view.dom.window.close());
  const document = view.dom.window.document;
  const list = () => document.querySelector('.reviewer-layout .list-column').textContent;
  assert.match(list(), /沒有符合目前條件的 MR/);
  for (const status of ['idle', 'loading', 'error']) {
    view.sendSnapshot({ ...data, sections: { mergeRequests: { status, error: 'Network unavailable' } } });
    await view.tick();
    assert.doesNotMatch(list(), /沒有符合目前條件的 MR/);
    if (status === 'loading') assert.match(document.body.textContent, /待審查 MR載入中/);
    if (status === 'error') assert.match(document.body.textContent, /待審查 MR載入失敗/);
  }
  const rows = [
    { id: 1, iid: 1, project_id: 1, title: 'First reviewer', state: 'opened', reviewers: [data.currentUser], source_branch: 'first', target_branch: 'main' },
    { id: 2, iid: 2, project_id: 1, title: 'Second reviewer', state: 'opened', reviewers: [{ id: 8 }], source_branch: 'second', target_branch: 'main' }
  ];
  view.sendSnapshot({ ...data, mergeRequests: rows }); await view.tick();
  [...document.querySelectorAll('.reviewer-layout .filter-tabs button')].find(button => button.textContent === '指定我為 Reviewer').click();
  await view.tick();
  const titles = () => [...document.querySelectorAll('.reviewer-layout .work-row .row-title')].map(row => row.textContent.trim());
  assert.deepEqual(titles(), ['!1　First reviewer']);
  const secondAccount = { ...data, mergeRequests: rows, currentUser: { id: 8, username: 'second', name: 'Second' },
    instanceUserScope: 'second-account', connectedScope: 'second-account-scope' };
  view.sendSnapshot(secondAccount); await view.tick();
  [...document.querySelectorAll('.reviewer-layout .filter-tabs button')].find(button => button.textContent === '指定我為 Reviewer').click();
  await view.tick();
  assert.deepEqual(titles(), ['!2　Second reviewer']);
  view.sendSnapshot({ ...secondAccount, group: { ...data.group, id: 99 }, connectedScope: 'another-group-scope', mergeRequests: [] });
  await view.tick();
  assert.deepEqual(titles(), []);
  assert.match(list(), /沒有符合目前條件的 MR/);
});

test('MR reports publish as manual comments while approval and merge remain SHA based', async t => {
  const data=snapshot('reviewer'); const request={id:41,iid:4,project_id:1,title:'Review',state:'opened',source_branch:'feature',target_branch:'main',diff_refs:{head_sha:gitHead}};
  data.instance={version:'16.11.0',enterprise:true};
  data.mergeRequests=[request]; data.selectedMergeRequest={request,mergeAvailability:{status:'allowed'},diffs:[],discussions:[],sections:{diffs:{status:'ready'},discussions:{status:'ready'}},warnings:[],freshness:{state:'current',checkedAt:Date.now()},sourceSha:gitHead,targetSha:gitParent};
  const view=await mount({mode:'reviewer'},data); t.after(() => view.dom.window.close()); const document=view.dom.window.document;
  [...document.querySelectorAll('[role=tab]')].find(button => button.textContent==='審查報告').click(); await view.tick();
  const input=document.querySelector('.reviewer-detail textarea'); input.value='Merge Report: service\nStatic findings'; input.dispatchEvent(new view.dom.window.Event('input',{bubbles:true})); await view.tick();
  const buttons=[...document.querySelectorAll('.reviewer-detail button')];
  assert.equal(buttons.some(button => /匯入報告|核對貼上|發布審查報告/.test(button.textContent)),false);
  assert.equal(buttons.find(button => button.textContent==='核准').disabled,false);
  assert.equal(buttons.find(button => button.textContent==='合併 MR').disabled,false);
  buttons.find(button => button.textContent==='作一般留言發布').click(); await view.tick();
  assert.equal(view.requests.findLast(request => request.type==='postMergeRequestNote').body,input.value);
});

test('CE and unconfirmed instances omit unsupported MR approvals while preserving merge and comments', async t => {
  for (const enterprise of [false, undefined]) {
    const data = snapshot('reviewer'), request = { id: 41, iid: 4, project_id: 1, title: 'Review', state: 'opened', source_branch: 'feature', target_branch: 'main', diff_refs: { head_sha: gitHead } };
    data.instance = { version: '16.11.0', enterprise };
    data.mergeRequests = [request]; data.selectedMergeRequest = { request, mergeAvailability: { status: 'allowed' }, diffs: [], discussions: [], sections: { diffs: { status: 'ready' }, discussions: { status: 'ready' } }, freshness: { state: 'not_checked' }, sourceSha: gitHead, targetSha: gitParent };
    const view = await mount({ mode: 'reviewer', reviewerTab: 'report' }, data); t.after(() => view.dom.window.close());
    const buttons = [...view.dom.window.document.querySelectorAll('.reviewer-detail button')];
    assert.equal(buttons.some(item => item.textContent === '核准'), false);
    assert.equal(buttons.find(item => item.textContent === '合併 MR').disabled, false);
    assert.equal(view.requests.some(item => item.type === 'approveMergeRequest'), false);
  }
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
  assert.equal(open.action.refresh, undefined, 'reconstructing the visible Git page performs a fresh local read');
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
  assert.equal(restored.requests.filter(request => request.type === 'issueRequest' && request.request.type === 'ready').length, 1, 'a restored active Issue announces readiness once');
  restored.send({ type: 'issueNavigation', navigation });
  restored.send({ type: 'issueResponse', revision: 7, response });
  await restored.tick();
  const deadline = Date.now() + 1500;
  while (restored.dom.window.document.querySelector('.issue-embed [role=tab][aria-selected=true]')?.textContent !== '工時' && Date.now() < deadline) await restored.tick();
  assert.equal(restored.dom.window.document.querySelector('.issue-embed [role=tab][aria-selected=true]').textContent, '工時');
  assert.equal(restored.savedState.issueNavigation.revision, 7);
});

function setProjectContext(state, root, manual = false) {
  state.projectContext = { folders: [{ uri: 'file:' + root, name: 'project', path: root }], selectedFolderUri: 'file:' + root,
    root, manual, revision: 'root-' + root };
  state.cloneRoot = root; state.cloneRootManual = manual; state.groupRoot = root;
  state.workflowKitInstallTarget = { ...state.workflowKitInstallTarget, root, manual };
}

function setSkillsContext(state, mode = 'repository', matching = {}) {
  const root = mode === 'group' ? state.groupRoot : state.workflowKitInstallTarget.root;
  setProjectContext(state, root, state.workflowKitInstallTarget.manual);
  const repositories = [{ name: 'alpha', path: 'C:/local/repo', matched: true }, { name: 'beta', path: 'C:/local/other', matched: true }];
  const features = ['query', 'merge-repo', 'merge-quick', 'release-review',
    ...(mode === 'group' ? ['merge-group', 'merge-mr'] : [])];
  state.skillsContext = { mode, root, revision: `revision-${root}`, groupMatch: { status: mode === 'group' ? 'matched' : 'mismatched',
    root: mode === 'group' ? root : undefined, repositories, ...matching }, repositories: mode === 'group' ? repositories : repositories.filter(repo => repo.path === root),
    installed: { status: 'installed', profile: mode, version: '0.17.0', capabilities: features,
      upstreamVersions: { 'codebase-wiki': '0.4.0', 'merge-reviewer': '0.7.0', 'release-reviewer': '0.1.0' } },
    availableFeatures: features };
  return state.skillsContext;
}




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
  assert.match(document.querySelector('.statusbar').textContent, /專案根目錄：C:\/local\/repo/);
  assert.doesNotMatch(document.querySelector('.statusbar').textContent, /尚未登入|開啟 GitLab Group/);
  const unavailable = structuredClone(state);
  unavailable.skillsContext = { ...unavailable.skillsContext, mode: 'unavailable', root: undefined, reason: '請選擇目前 VS Code 工作區的 Repo。' };
  view.sendSnapshot(unavailable); await view.tick();
  assert.match(document.querySelector('.statusbar').textContent, /請選擇目前 VS Code 工作區的 Repo/);
});

function selectedSkillFeature(document) { return document.querySelector('.skills-feature-navigation [aria-current="true"]').id.replace('skill-feature-',''); }
function selectedSkillTool(document) { return document.querySelector('.skills-tool-tabs [aria-selected="true"]').id.replace('skill-tool-',''); }
function selectSkillFeature(document, value) { const button=document.getElementById('skill-feature-'+value); assert.ok(button,'missing feature '+value); button.click(); }
function selectSkillTool(document, value) { const button=document.getElementById('skill-tool-'+value); assert.ok(button,'missing tool '+value); button.click(); }
function selectSkillControl(document, selector, value) {
  if (/Skills 工具|skills-tool-selector/.test(selector)) { selectSkillTool(document,value); return true; }
  if (/Skills 功能|wiki-guide-selector/.test(selector)) { selectSkillFeature(document,value); return true; }
  return false;
}

function holdOperationReceipts(window) {
  window.heldOperations = [];
  const acquire = window.acquireVsCodeApi;
  window.acquireVsCodeApi = () => {
    const api = acquire();
    return { ...api, postMessage: message => { window.heldOperations.push(message); api.postMessage({ ...message, operationId: undefined }); } };
  };
}
async function mountGitLifecycle(t) {
  const view = await mount({ mode: 'git', scopeKey: 'team-scope' }, snapshot('git'), {}, holdOperationReceipts);
  t.after(() => view.dom.window.close());
  view.send({ type: 'gitRepositories', available: true, revision: 1, repositories: [gitSnapshot()] }); await view.tick();
  const open = gitActions(view, 'open').at(-1); assert.ok(open);
  await finishGit(view, open);
  return view;
}

test('Git confirmed Commit clears only its submitted draft and acknowledges a refresh failure', async t => {
  const view = await mountGitLifecycle(t), document = view.dom.window.document;
  const composer = document.querySelector('.git-commit-composer'), draft = composer.querySelector('textarea');
  draft.value = 'Confirmed commit'; draft.dispatchEvent(new view.dom.window.Event('input', { bubbles: true })); await view.tick();
  composer.dispatchEvent(new view.dom.window.Event('submit', { bubbles: true, cancelable: true })); await view.tick();
  const commit = gitActions(view, 'commit').at(-1); assert.ok(commit);
  assert.equal(view.savedState.gitUi.pendingWrites.length, 1);
  view.send({ type: 'gitActionResult', requestId: commit.requestId, write: true, effect: 'applied', commitCompleted: true, refreshError: 'offline' }); await view.tick();
  assert.equal(draft.value, ''); assert.equal(view.savedState.gitUi.pendingWrites.length, 0);
  assert.equal(view.requests.filter(request => request.type === 'gitAcknowledgeResult' && request.requestId === commit.requestId).length, 1);
  assert.match(document.querySelector('.git-error').textContent, /操作已完成.*更新失敗.*offline/);
});

test('Git uncertain write keeps its draft and receipt without sending or acknowledging another write', async t => {
  const view = await mountGitLifecycle(t), document = view.dom.window.document;
  const composer = document.querySelector('.git-commit-composer'), draft = composer.querySelector('textarea');
  draft.value = 'Verify this commit'; draft.dispatchEvent(new view.dom.window.Event('input', { bubbles: true })); await view.tick();
  composer.dispatchEvent(new view.dom.window.Event('submit', { bubbles: true, cancelable: true })); await view.tick();
  const commit = gitActions(view, 'commit').at(-1); assert.ok(commit);
  view.send({ type: 'gitActionResult', requestId: commit.requestId, write: true, effect: 'unknown', error: 'socket closed' }); await view.tick();
  const uncertainFeedback = [...document.querySelectorAll('.operation-status.failed')].find(item => item.textContent.includes('socket closed'));
  assert.ok(uncertainFeedback);
  assert.equal([...uncertainFeedback.querySelectorAll('button')].some(button => button.textContent === '重試'), false, 'unknown writes offer confirmation instead of a resend');
  assert.equal(draft.value, 'Verify this commit'); assert.equal(view.savedState.gitUi.pendingWrites.length, 1);
  assert.equal(view.requests.some(request => request.type === 'gitAcknowledgeResult' && request.requestId === commit.requestId), false);
  composer.dispatchEvent(new view.dom.window.Event('submit', { bubbles: true, cancelable: true })); await view.tick();
  assert.equal(gitActions(view, 'commit').length, 1); assert.equal(composer.querySelector('button[type="submit"]').disabled, true);
  assert.equal(document.querySelector('.git-refresh').disabled, false, 'reading remains available while verifying a write');
  const sent = view.dom.window.heldOperations.find(message => message.requestId === commit.requestId);
  view.send({ type: 'operationChanged', operation: { requestId: sent.operationId, scopeRevision: sent.operationScope, resourceKey: 'git:repo-a',
    action: 'gitAction', kind: 'write', status: 'succeeded', effect: 'applied', correlationId: commit.requestId, label: 'Confirmed', phase: 'Confirmed', startedAt: 1, finishedAt: 2 } }); await view.tick();
  assert.equal(draft.value, ''); assert.equal(view.savedState.gitUi.pendingWrites.length, 0);
  assert.equal(view.requests.filter(request => request.type === 'gitAcknowledgeResult' && request.requestId === commit.requestId).length, 1);
});

test('Issue mutation receipts preserve newer drafts after a refresh failure and retain uncertain submissions', async t => {
  const data = snapshot(), view = await mount({ mode: 'developer', scopeKey: 'team-scope' }, data, {}, holdOperationReceipts);
  t.after(() => view.dom.window.close()); const document = view.dom.window.document, revision = 70;
  const issue = data.issues[0], detail = { ...issueDetailData(issue, data.projects[0]), canComment: true };
  view.send({ type: 'issueNavigation', navigation: { mode: 'detail', projectId: issue.project_id, issueIid: issue.iid, revision } }); await view.tick();
  view.send({ type: 'issueResponse', revision, response: { type: 'detailData', data: detail } }); await view.tick();
  const comment = document.querySelector('.issue-detail-column textarea[rows="5"]'); assert.ok(comment);
  const submit = () => [...document.querySelectorAll('.issue-detail-column button')].find(button => button.textContent === '送出留言');
  comment.value = 'Submitted comment'; comment.dispatchEvent(new view.dom.window.Event('input', { bubbles: true })); await view.tick();
  submit().click(); await view.tick();
  const first = view.requests.findLast(request => request.type === 'issueRequest' && request.request.type === 'invoke'); assert.ok(first);
  comment.value = 'Newer draft'; comment.dispatchEvent(new view.dom.window.Event('input', { bubbles: true })); await view.tick();
  view.send({ type: 'issueResponse', revision, response: { type: 'actionResult', requestId: first.request.requestId, status: 'succeeded', effect: 'applied', refreshError: 'offline' } }); await view.tick();
  assert.equal(comment.value, 'Newer draft'); assert.match(document.querySelector('.issue-embed').textContent, /操作已完成.*更新失敗/);
  submit().click(); await view.tick();
  const second = view.requests.findLast(request => request.type === 'issueRequest' && request.request.type === 'invoke'); assert.notEqual(second.request.requestId, first.request.requestId);
  view.send({ type: 'issueResponse', revision, response: { type: 'actionResult', requestId: second.request.requestId, status: 'failed', effect: 'unknown', error: 'Check GitLab before sending again' } }); await view.tick();
  assert.equal(comment.value, 'Newer draft'); assert.equal(submit().disabled, true);
  assert.equal(view.requests.filter(request => request.type === 'issueRequest' && request.request.type === 'invoke').length, 2);
  assert.equal([...document.querySelectorAll('.issue-heading-actions button')].find(button => button.textContent === '重新整理').disabled, false);
  assert.equal(Object.keys(view.savedState.issueEditorDrafts['instance-user'].uncertain).length, 1);
  const sent = view.dom.window.heldOperations.find(message => message.request?.requestId === second.request.requestId);
  view.send({ type: 'operationChanged', operation: { requestId: sent.operationId, scopeRevision: sent.operationScope, resourceKey: `issue:${issue.project_id}:${issue.iid}`,
    action: 'issueRequest', kind: 'write', status: 'succeeded', effect: 'none', correlationId: second.request.requestId, label: 'Confirmed', phase: 'Confirmed', startedAt: 1, finishedAt: 2 } }); await view.tick();
  assert.equal(comment.value, 'Newer draft'); assert.equal(submit().disabled, false);
  assert.equal(Object.keys(view.savedState.issueEditorDrafts['instance-user'].uncertain).length, 0);
});

async function showLifecycleIssue(view, issue, project, revision, extra = {}) {
  view.send({ type: 'issueNavigation', navigation: { mode: 'detail', projectId: issue.project_id, issueIid: issue.iid, revision } }); await view.tick();
  view.send({ type: 'issueResponse', revision, response: { type: 'detailData', data: { ...issueDetailData(issue, project), canComment: true, ...extra } } }); await view.tick();
}

test('Issue pending submissions survive reconstruction and reconcile the original Issue without clearing another draft', async t => {
  const data = snapshot(), view = await mount({ mode: 'developer', scopeKey: 'team-scope' }, data, {}, holdOperationReceipts);
  t.after(() => view.dom.window.close()); const document = view.dom.window.document, first = data.issues[0], second = data.issues[1];
  await showLifecycleIssue(view, first, data.projects[0], 80);
  const input = document.querySelector('.issue-detail-column textarea[rows="5"]');
  input.value = 'Original pending comment'; input.dispatchEvent(new view.dom.window.Event('input', { bubbles: true })); await view.tick();
  [...document.querySelectorAll('.issue-detail-column button')].find(button => button.textContent === '送出留言').click();
  const request = view.requests.findLast(message => message.type === 'issueRequest' && message.request.type === 'invoke'); assert.ok(request);
  assert.ok(view.savedState.issueEditorDrafts['instance-user'].pending[request.request.requestId], 'submission metadata is durable before the next render');
  const sent = view.dom.window.heldOperations.find(message => message.request?.requestId === request.request.requestId);
  await showLifecycleIssue(view, second, data.projects[1], 81);
  const secondInput = document.querySelector('.issue-detail-column textarea[rows="5"]');
  secondInput.value = 'Keep the second Issue draft'; secondInput.dispatchEvent(new view.dom.window.Event('input', { bubbles: true })); await view.tick();
  const saved = view.savedState; view.dom.window.close();
  const restored = await mount(saved, data, {}, holdOperationReceipts); t.after(() => restored.dom.window.close());
  restored.send({ type: 'issueResponse', revision: 81, response: { type: 'detailData', data: { ...issueDetailData(second, data.projects[1]), canComment: true } } }); await restored.tick();
  const restoredInput = restored.dom.window.document.querySelector('.issue-detail-column textarea[rows="5"]');
  assert.equal(restoredInput.value, 'Keep the second Issue draft');
  const operation = { requestId: sent.operationId, scopeRevision: sent.operationScope, resourceKey: `issue:${first.project_id}:${first.iid}`,
    action: 'issueRequest', kind: 'write', status: 'failed', effect: 'unknown', correlationId: request.request.requestId,
    label: 'Verify original comment', phase: 'Unknown', startedAt: 1, finishedAt: 2, hostSessionId: 'restored-host', revision: 1 };
  restored.send({ type: 'operationsSnapshot', snapshot: { sessionId: 'restored-host', revision: 1, operations: [operation] } }); await restored.tick();
  restored.send({ type: 'operationChanged', operation: { ...operation, revision: 2, status: 'succeeded', effect: 'applied', phase: 'Confirmed' } }); await restored.tick();
  assert.equal(restoredInput.value, 'Keep the second Issue draft');
  const drafts = restored.savedState.issueEditorDrafts['instance-user'];
  assert.equal(drafts.conversations[first.id].comment, ''); assert.equal(drafts.conversations[second.id].comment, 'Keep the second Issue draft');
  assert.equal(Object.hasOwn(drafts.pending, request.request.requestId), false);
  assert.equal(restored.requests.some(message => message.type === 'issueRequest' && message.request.type === 'invoke'), false, 'restoring never resends a write');
});

test('joined Issue previews, project searches and uploads use the original correlation and preserve their destination', async t => {
  const data = snapshot(), view = await mount({ mode: 'developer', scopeKey: 'team-scope' }, data, {}, holdOperationReceipts);
  t.after(() => view.dom.window.close()); const document = view.dom.window.document, revision = 90;
  await showLifecycleIssue(view, { ...data.issues[0], description: 'Description to preview' }, data.projects[0], revision, { canEdit: true, canClone: true });
  [...document.querySelectorAll('.issue-detail-column button')].find(button => button.textContent === '編輯需求').click(); await view.tick();
  const preview = [...document.querySelectorAll('.issue-detail-column .form-grid button')].find(button => button.textContent === '預覽 Markdown'); assert.ok(preview);
  const previews = () => view.requests.filter(message => message.type === 'issueRequest' && message.request.type === 'preview' && message.request.target === 'description');
  const before = previews().length; preview.click(); await view.tick(); preview.click(); await view.tick();
  assert.equal(previews().length, before + 1);
  view.send({ type: 'issueResponse', revision, response: { type: 'reply', requestId: previews().at(-1).request.requestId, result: { html: '<p>Joined description rendered</p>' } } }); await view.tick();
  assert.match(document.querySelector('.field-wide.preview').textContent, /Joined description rendered/);
  const comment = document.querySelector('.issue-detail-column textarea[rows="5"]'); comment.value = 'Preview this comment'; comment.dispatchEvent(new view.dom.window.Event('input', { bubbles: true })); await view.tick();
  const commentToolbar = [...document.querySelectorAll('.issue-detail-column .toolbar')].find(element => element.textContent.includes('送出留言'));
  const commentPreview = [...commentToolbar.querySelectorAll('button')].find(button => button.textContent === '預覽 Markdown');
  commentPreview.click(); await view.tick(); commentPreview.click(); await view.tick();
  const editorRequests = view.requests.filter(message => message.type === 'issueRequest' && message.request.type === 'preview' && message.request.target === 'editor:comment');
  assert.equal(editorRequests.length, 1);
  view.send({ type: 'issueResponse', revision, response: { type: 'reply', requestId: editorRequests[0].request.requestId, result: { html: '<p>Joined comment rendered</p>' } } }); await view.tick();
  assert.match(document.querySelector('.issue-detail-column').textContent, /Joined comment rendered/);
  const search = document.querySelector('input[aria-label="搜尋目標專案"]'); search.value = 'outside'; search.dispatchEvent(new view.dom.window.Event('input', { bubbles: true })); await view.tick();
  const searchButton = [...document.querySelectorAll('.issue-actions button')].find(button => button.textContent === '搜尋專案');
  searchButton.click(); await view.tick(); searchButton.click(); await view.tick();
  const searches = view.requests.filter(message => message.type === 'issueRequest' && message.request.type === 'searchProjects'); assert.equal(searches.length, 1);
  view.send({ type: 'issueResponse', revision, response: { type: 'reply', requestId: searches[0].request.requestId, result: [{ ...project(99, 'outside'), path_with_namespace: 'outside/matched-project' }] } }); await view.tick();
  assert.ok([...document.querySelectorAll('.issue-actions option')].some(option => option.textContent === 'outside/matched-project'));
  const upload = [...commentToolbar.querySelectorAll('button')].find(button => button.textContent === '上傳附件');
  upload.click(); await view.tick(); upload.click(); await view.tick();
  const uploads = view.requests.filter(message => message.type === 'issueRequest' && message.request.type === 'upload'); assert.equal(uploads.length, 1);
  view.send({ type: 'issueResponse', revision, response: { type: 'reply', requestId: uploads[0].request.requestId, effect: 'applied', result: { markdown: '[attachment](uploads/file.txt)' } } }); await view.tick();
  assert.match(comment.value, /Preview this comment\n\n\[attachment\]/);
});

test('joined similar-Issue searches accept the original response', async t => {
  const data = snapshot(), view = await mount({ mode: 'developer', scopeKey: 'team-scope' }, data, {}, holdOperationReceipts);
  t.after(() => view.dom.window.close()); const revision = 91, document = view.dom.window.document;
  view.send({ type: 'issueNavigation', navigation: { mode: 'create', revision } }); await view.tick();
  view.send({ type: 'issueResponse', revision, response: { type: 'createData', projects: data.projects, selectedProjectId: 1,
    options: { members: [], labels: [], milestones: [], templates: [] }, canSetStartDate: false, canCreateIssue: true } }); await view.tick();
  const title = document.querySelector('.issue-embed .form-grid input[maxlength="1024"]'); title.value = 'Related bug'; title.dispatchEvent(new view.dom.window.Event('input', { bubbles: true })); await view.tick();
  title.dispatchEvent(new view.dom.window.FocusEvent('blur')); await view.tick(); title.dispatchEvent(new view.dom.window.FocusEvent('blur')); await view.tick();
  const requests = view.requests.filter(message => message.type === 'issueRequest' && message.request.type === 'search'); assert.equal(requests.length, 1);
  view.send({ type: 'issueResponse', revision, response: { type: 'reply', requestId: requests[0].request.requestId, result: [{ ...data.issues[0], title: 'Matched related bug' }] } }); await view.tick();
  assert.match(document.querySelector('.issue-embed .hint').textContent, /Matched related bug/);
});

test('Git reconstruction after a Host reset recovers both legacy and current pending writes without resending', async t => {
  for (const legacy of [true, false]) await t.test(legacy ? 'legacy correlation ID' : 'persisted operation ID', async t => {
    const original = await mountGitLifecycle(t), document = original.dom.window.document;
    const draft = document.querySelector('.git-commit-composer textarea'); draft.value = 'Verify after Host restart'; draft.dispatchEvent(new original.dom.window.Event('input', { bubbles: true })); await original.tick();
    document.querySelector('.git-commit-composer').dispatchEvent(new original.dom.window.Event('submit', { bubbles: true, cancelable: true })); await original.tick();
    const commit = gitActions(original, 'commit').at(-1); assert.ok(commit);
    const saved = structuredClone(original.savedState); if (legacy) delete saved.gitUi.pendingWrites[0].operationId;
    const pendingId = saved.gitUi.pendingWrites[0].operationId ?? commit.requestId;
    original.dom.window.close();
    const restored = await mount(saved, { ...snapshot('git'), operationSnapshot: { sessionId: 'new-git-host', revision: 0, operations: [] } }, {}, holdOperationReceipts);
    t.after(() => restored.dom.window.close());
    restored.send({ type: 'gitRepositories', available: true, revision: 1, repositories: [gitSnapshot()] }); await restored.tick();
    await finishGit(restored, gitActions(restored, 'open').at(-1));
    assert.ok(restored.requests.some(message => message.type === 'reconcileOperations' && message.pendingIds?.includes(pendingId)));
    restored.send({ type: 'operationsSnapshot', snapshot: { sessionId: 'new-git-host', revision: 1, operations: [], requestedIds: [pendingId], missingIds: [pendingId] } }); await restored.tick();
    const root = restored.dom.window.document;
    assert.equal(root.querySelector('.git-commit-composer textarea').value, 'Verify after Host restart');
    assert.equal(root.querySelector('.git-commit-launch').disabled, true); assert.equal(root.querySelector('.git-refresh').disabled, false);
    const confirm = [...root.querySelectorAll('.workspace-operation-area button')].find(button => button.textContent === '核對寫入結果'); assert.ok(confirm); confirm.click(); await restored.tick();
    assert.equal(restored.requests.findLast(message => message.type === 'confirmOperationResult').targetOperationId, pendingId);
    assert.equal(gitActions(restored, 'commit').length, 0);
    restored.send({ type: 'operationChanged', operation: { requestId: pendingId, correlationId: commit.requestId, resourceKey: 'git:repo-a', action: 'gitAction', kind: 'write',
      scopeRevision: saved.gitUi.pendingWrites[0].scopeRevision ?? 'team-scope:root-team', status: 'succeeded', effect: legacy ? 'none' : 'applied', label: 'Verified', phase: 'Verified',
      hostSessionId: 'new-git-host', revision: 2, startedAt: 1, finishedAt: 2 } }); await restored.tick();
    assert.equal(restored.savedState.gitUi.pendingWrites.length, 0);
    assert.equal(root.querySelector('.git-commit-composer textarea').value, legacy ? 'Verify after Host restart' : '');
    assert.ok(restored.requests.some(message => message.type === 'gitAcknowledgeResult' && message.requestId === commit.requestId));
  });
});

test('Issue reconstruction after a Host reset restores missing pending receipts as confirmable unknown operations', async t => {
  const data = snapshot(), issue = data.issues[0], revision = 100, requestId = 'issue-before-host-reset', operationId = 'ui-before-host-reset';
  const saved = { mode: 'developer', scopeKey: 'team-scope', instanceUserScope: 'instance-user',
    issueNavigation: { mode: 'detail', projectId: issue.project_id, issueIid: issue.iid, revision },
    issueEditorDrafts: { 'instance-user': { create: {}, issues: {}, conversations: { [issue.id]: { comment: 'Verify this original comment', reply: {} } },
      pending: { [requestId]: { issueId: issue.id, projectId: issue.project_id, issueIid: issue.iid, operationId, resourceKey: `issue:${issue.project_id}:${issue.iid}`,
        scopeRevision: 'team-scope:root-team', action: 'note', replyId: null, submission: { body: 'Verify this original comment', taskTitle: '', taskDescription: '' }, form: null, creating: false } } } } };
  const view = await mount(saved, { ...data, operationSnapshot: { sessionId: 'new-issue-host', revision: 0, operations: [] } }, {}, holdOperationReceipts);
  t.after(() => view.dom.window.close());
  view.send({ type: 'issueResponse', revision, response: { type: 'detailData', data: { ...issueDetailData(issue, data.projects[0]), canComment: true } } }); await view.tick();
  assert.ok(view.requests.some(message => message.type === 'reconcileOperations' && message.pendingIds?.includes(operationId)));
  view.send({ type: 'operationsSnapshot', snapshot: { sessionId: 'new-issue-host', revision: 1, operations: [], requestedIds: [operationId], missingIds: [operationId] } }); await view.tick();
  const document = view.dom.window.document, comment = document.querySelector('.issue-detail-column textarea[rows="5"]');
  const submit = () => [...document.querySelectorAll('.issue-detail-column button')].find(button => button.textContent === '送出留言');
  assert.equal(comment.value, 'Verify this original comment'); assert.equal(submit().disabled, true);
  assert.equal([...document.querySelectorAll('.issue-heading-actions button')].find(button => button.textContent === '重新整理').disabled, false);
  const confirm = [...document.querySelectorAll('.workspace-operation-area button')].find(button => button.textContent === '核對寫入結果'); assert.ok(confirm); confirm.click(); await view.tick();
  assert.equal(view.requests.findLast(message => message.type === 'confirmOperationResult').targetOperationId, operationId);
  assert.equal(view.requests.some(message => message.type === 'issueRequest' && message.request.type === 'invoke'), false);
  view.send({ type: 'operationChanged', operation: { requestId: operationId, correlationId: requestId, resourceKey: `issue:${issue.project_id}:${issue.iid}`, action: 'issueRequest', kind: 'write',
    scopeRevision: 'team-scope:root-team', status: 'succeeded', effect: 'none', label: 'Verified', phase: 'Verified', hostSessionId: 'new-issue-host', revision: 2, startedAt: 1, finishedAt: 2 } }); await view.tick();
  assert.equal(comment.value, 'Verify this original comment'); assert.equal(submit().disabled, false);
  assert.equal(Object.hasOwn(view.savedState.issueEditorDrafts['instance-user'].pending, requestId), false);
});

test('MR discussion replies retain failed and uncertain drafts and clear only confirmed submitted text', async t => {
  const data = snapshot('reviewer'), mr = { id: 41, iid: 4, project_id: 1, title: 'Review', state: 'opened', source_branch: 'feature', target_branch: 'main' };
  data.mergeRequests = [mr]; data.selectedMergeRequest = { request: mr, diffs: [], discussions: [{ id: 'thread-retain', notes: [{ id: 1, body: 'Review comment', author: { name: 'Reviewer' } }] }],
    sections: { diffs: { status: 'ready' }, discussions: { status: 'ready' } }, warnings: [], freshness: { state: 'current', checkedAt: Date.now() }, sourceSha: gitHead, targetSha: gitParent };
  const view = await mount({ mode: 'reviewer', scopeKey: 'team-scope' }, data, {}, holdOperationReceipts); t.after(() => view.dom.window.close());
  const document = view.dom.window.document;
  [...document.querySelectorAll('.review-tabs button')].find(button => button.textContent === '討論').click(); await view.tick();
  const input = document.querySelector('input[aria-label="討論回覆"]'), button = input.parentElement.querySelector('button'), key = 'instance-user:1:4:thread-retain';
  const type = async text => { input.value = text; input.dispatchEvent(new view.dom.window.Event('input', { bubbles: true })); await view.tick(); };
  const submit = async () => { button.click(); await view.tick(); return view.dom.window.heldOperations.findLast(message => message.type === 'replyMergeRequest'); };
  const finish = async (sent, patch) => { view.send({ type: 'operationChanged', operation: { requestId: sent.operationId, scopeRevision: sent.operationScope, resourceKey: 'mr:1:4', action: 'replyMergeRequest', kind: 'write',
    label: 'Reply', phase: 'Finished', startedAt: 1, finishedAt: 2, ...patch } }); await view.tick(); };
  await type('Keep after failed send');
  const failed = await submit(); assert.ok(failed); assert.equal(input.value, 'Keep after failed send');
  await finish(failed, { status: 'failed', effect: 'none', error: 'GitLab rejected the reply' });
  assert.equal(input.value, 'Keep after failed send'); assert.equal(view.savedState.mrReplyDrafts[key], input.value);
  const uncertain = await submit();
  await finish(uncertain, { status: 'failed', effect: 'unknown', error: 'Verify the posted reply' });
  assert.equal(input.value, 'Keep after failed send'); assert.equal(button.disabled, true);
  await finish(uncertain, { status: 'succeeded', effect: 'none' });
  assert.equal(input.value, 'Keep after failed send'); assert.equal(button.disabled, false);
  await type('Submitted original'); const edited = await submit();
  await type('Newer draft typed while sending');
  await finish(edited, { status: 'succeeded', effect: 'applied', refreshError: 'Discussions unavailable' });
  assert.equal(input.value, 'Newer draft typed while sending'); assert.equal(view.savedState.mrReplyDrafts[key], input.value);
  await type('Confirmed exact text'); const applied = await submit();
  await finish(applied, { status: 'succeeded', effect: 'applied', refreshError: 'Discussions unavailable' });
  assert.equal(input.value, ''); assert.equal(view.savedState.mrReplyDrafts[key], '');
});

test('Git dialog cancellation restores its trigger and focus stays inside until closure', async t => {
  const view = await mountGit(t);
  const document = view.dom.window.document;
  const trigger = document.querySelector('.git-fetch');
  trigger.focus(); trigger.click(); await view.tick();
  const dialog = document.querySelector('.git-dialog');
  assert.ok(dialog.contains(document.activeElement));
  document.querySelector('.git-branch-picker select').focus();
  assert.ok(dialog.contains(document.activeElement), 'programmatic focus cannot escape the modal');
  const controls = [...dialog.querySelectorAll('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled)')];
  controls.at(-1).focus();
  view.dom.window.dispatchEvent(new view.dom.window.KeyboardEvent('keydown', { key: 'Tab', cancelable: true }));
  assert.equal(document.activeElement, controls[0]);
  view.dom.window.dispatchEvent(new view.dom.window.KeyboardEvent('keydown', { key: 'Escape', cancelable: true }));
  await view.tick();
  assert.equal(document.querySelector('.git-dialog'), null);
  assert.equal(document.activeElement, trigger);
  assert.equal(gitActions(view, 'fetch').length, 0);
  assert.match(document.querySelector('.git-statusbar').textContent, /本機追蹤分支資訊.*工作台最近成功 Fetch：尚未執行/);
  view.send({ type: 'gitSnapshot', snapshot: gitSnapshot('repo-a', { revision: 2, lastSuccessfulFetchAt: 1_800_000_000_000 }) });
  await view.tick();
  assert.doesNotMatch(document.querySelector('.git-fetch-freshness').textContent, /尚未執行/);
});

test('Git dialog exit animation blocks submit, preserves focus return and supports rapid reopening', async t => {
  const view = await mountGit(t, {}, gitSnapshot(), window => {
    window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
    Object.defineProperty(window.HTMLElement.prototype, 'onanimationend', { configurable: true, writable: true, value: null });
  });
  const document = view.dom.window.document;
  const trigger = document.querySelector('.git-fetch');
  trigger.focus(); trigger.click(); await view.tick();
  let overlay = document.querySelector('.git-dialog-backdrop');
  overlay.dispatchEvent(new view.dom.window.Event('animationend', { bubbles: true })); await view.tick();
  assert.equal(overlay.dataset.presence, 'entered');
  document.querySelector('.git-dialog button[aria-label="關閉"]').click(); await view.tick();
  assert.equal(overlay.dataset.presence, 'exiting');
  document.querySelector('.git-dialog').dispatchEvent(new view.dom.window.Event('submit', { bubbles: true, cancelable: true }));
  await view.tick(); assert.equal(gitActions(view, 'fetch').length, 0);
  // A quick reopen must cancel the old exit callback without losing its form.
  trigger.click(); await view.tick();
  overlay = document.querySelector('.git-dialog-backdrop');
  overlay.dispatchEvent(new view.dom.window.Event('animationend', { bubbles: true })); await view.tick();
  assert.equal(overlay.dataset.presence, 'entered');
  document.querySelector('.git-dialog button[aria-label="關閉"]').click(); await view.tick();
  overlay.dispatchEvent(new view.dom.window.Event('animationend', { bubbles: true })); await view.tick();
  assert.equal(document.querySelector('.git-dialog'), null);
  assert.equal(document.activeElement, trigger);
  assert.equal(gitActions(view, 'fetch').length, 0);
});

test('changing Git Repo immediately removes the previous Repo dialog without an exit animation', async t => {
  const view = await mountGit(t, {}, gitSnapshot(), window => {
    window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
    Object.defineProperty(window.HTMLElement.prototype, 'onanimationend', { configurable: true, writable: true, value: null });
  });
  const document = view.dom.window.document;
  const trigger = document.querySelector('.git-fetch');
  trigger.focus(); trigger.click(); await view.tick();
  assert.ok(document.querySelector('.git-dialog'));
  const picker = document.querySelector('.git-repo-picker select');
  picker.value = 'repo-b'; picker.dispatchEvent(new view.dom.window.Event('change', { bubbles: true }));
  view.send({ type: 'gitSnapshot', snapshot: gitSnapshot('repo-b', { revision: 2 }) });
  await view.tick();
  assert.equal(document.querySelector('.git-dialog'), null, 'old-scope form must not remain against the next Repo snapshot');
  assert.equal(gitActions(view, 'fetch').length, 0);
});
