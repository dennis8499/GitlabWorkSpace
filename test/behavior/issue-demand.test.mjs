import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import { webviewBundle } from './webview-bundle.mjs';

const { script } = await webviewBundle('issue-test');
const project = { id: 1, path_with_namespace: 'team/one', web_url: 'https://gitlab.test/team/one' };
const second = { ...project, id: 2, path_with_namespace: 'team/two' };
const user = { id: 9, name: 'Tester', username: 'tester' };
const idleOptions = () => ({ members: [], labels: [], milestones: [], templates: [], states: { fields: { status: 'idle' }, members: { status: 'idle' }, labels: { status: 'idle' }, milestones: { status: 'idle' }, templates: { status: 'idle' } } });
const readyOptions = () => ({ ...idleOptions(), members: [user], labels: [{ id: 3, name: 'bug' }], milestones: [{ id: 4, title: 'Release' }], states: { fields: { status: 'ready' }, members: { status: 'ready', complete: true }, labels: { status: 'ready', complete: true }, milestones: { status: 'ready', complete: true }, templates: { status: 'idle' } } });
const issueData = () => ({ issue: { id: 101, iid: 1, project_id: 1, title: 'Issue', state: 'opened', labels: [], assignees: [], updated_at: '2026-10-21T00:00:00Z' },
  project, projects: [project], user, options: idleOptions(), discussions: [{ id: 'thread', notes: Array.from({ length: 200 }, (_, index) => ({ id: index + 1, body: '', author: user, system: false })) }],
  links: [], tasks: [], todos: [], timelogs: [], mergeRequests: [], reactions: [], noteReactions: {}, noteReactionStates: {},
  sections: { options: 'idle', activity: 'ready', reactions: 'idle' }, warnings: [], startDate: null, canEdit: true });

async function mount(t) {
  const dom = new JSDOM('<!doctype html><div id="app"></div>', { url: 'https://webview.test/', runScripts: 'outside-only', pretendToBeVisual: true });
  t.after(() => dom.window.close());
  const requests = [];
  dom.window.addEventListener('workspaceIssueRequest', event => requests.push(event.detail));
  dom.window.eval(script);
  const tick = () => new Promise(resolve => setTimeout(resolve, 100));
  const send = async data => { dom.window.dispatchEvent(new dom.window.MessageEvent('message', { data })); await tick(); };
  const input = async (element, value, type = 'input') => { element.value = value; element.dispatchEvent(new dom.window.Event(type, { bubbles: true })); await tick(); };
  await tick();
  const document = dom.window.document;
  const button = label => [...document.querySelectorAll('button')].find(item => item.textContent.trim() === label);
  const select = label => [...document.querySelectorAll('label')].find(item => item.querySelector('span')?.textContent === label)?.querySelector('select');
  const finish = async request => send({ type: 'actionResult', requestId: request.requestId, status: 'succeeded', effect: 'none' });
  return { dom, requests, document, button, select, send, input, tick, finish };
}

test('creation demands fields and templates independently and preserves every project draft field', async t => {
  const v = await mount(t);
  await v.send({ type: 'createData', projects: [project, second], selectedProjectId: 1, options: idleOptions(), canCreateIssue: true });
  assert.equal(v.requests.some(r => r.type === 'loadFormOptions'), false);
  await v.input(v.document.querySelector('input[required]'), 'Saved title');
  await v.input(v.document.querySelector('textarea'), 'Saved description');
  const fields = v.document.querySelector('.issue-more-fields'); fields.open = true; fields.dispatchEvent(new v.dom.window.Event('toggle')); await v.tick();
  assert.equal(v.requests.some(r => r.type === 'loadFormOptions'), false, 'opening optional settings does not request unused controls');
  for (const [section, label] of [['members', '負責人'], ['milestones', '里程碑'], ['labels', '標籤']]) {
    v.button(`載入${label}`).click(); await v.tick();
    const requested = v.requests.findLast(r => r.type === 'loadFormOptions');
    assert.equal(requested.section, section);
    const loaded = new Set(v.requests.filter(r => r.type === 'loadFormOptions').map(r => r.section));
    const options = readyOptions();
    for (const key of ['members', 'milestones', 'labels']) if (!loaded.has(key)) { options[key] = []; options.states[key] = { status: 'idle' }; }
    await v.send({ type: 'projectData', projectId: 1, options, preserveDraft: true, canCreateIssue: true });
    await v.finish(requested);
  }
  assert.equal(v.document.querySelector('input[required]').value, 'Saved title');
  await v.input(v.select('負責人'), '9', 'change'); await v.input(v.select('里程碑'), '4', 'change'); await v.input(v.select('標籤'), 'bug', 'change');
  v.button('載入 GitLab 專案範本').click(); await v.tick();
  assert.deepEqual(v.requests.filter(r => r.type === 'loadFormOptions').map(r => r.section), ['members', 'milestones', 'labels', 'templates']);
  const chooseProject = () => v.select('專案 *');
  await v.input(chooseProject(), '2', 'change');
  await v.send({ type: 'projectData', projectId: 2, options: idleOptions(), canCreateIssue: true });
  await v.finish(v.requests.findLast(r => r.type === 'selectProject'));
  assert.equal(v.select('負責人').value, '');
  await v.input(v.document.querySelector('input[required]'), 'Other project');
  await v.input(chooseProject(), '1', 'change');
  await v.send({ type: 'projectData', projectId: 1, options: idleOptions(), canCreateIssue: true });
  await v.finish(v.requests.findLast(r => r.type === 'selectProject'));
  assert.equal(v.document.querySelector('input[required]').value, 'Saved title');
  assert.equal(v.document.querySelector('textarea').value, 'Saved description');
  assert.equal(v.select('負責人').value, '9'); assert.equal(v.select('里程碑').value, '4'); assert.equal(v.select('標籤').value, 'bug');
  await v.send({ type: 'projectData', projectId: 2, options: readyOptions(), preserveDraft: true, canCreateIssue: true });
  assert.equal(v.select('專案 *').value, '1', 'a late option patch cannot change the selected project');
  await v.send({ type: 'projectData', projectId: 1, options: { ...idleOptions(), states: { ...idleOptions().states, members: { status: 'error', error: 'offline' } } }, preserveDraft: true, canCreateIssue: true });
  const count = v.requests.length; await v.tick(); assert.equal(v.requests.length, count, 'rendering an error cannot retry');
  assert.equal(v.select('負責人').value, '9'); assert.equal(v.select('標籤').value, 'bug');
  v.button('重試載入負責人').click(); await v.tick();
  assert.equal(v.requests.findLast(r => r.type === 'loadFormOptions').section, 'members');
});

test('SOP templates remain available when GitLab templates fail and preserve other create fields', async t => {
  const v = await mount(t);
  const ready = readyOptions();
  const failedOptions = { ...ready, templates: [], states: { ...ready.states, templates: { status: 'error', error: 'offline' } } };
  await v.send({ type: 'createData', projects: [project], selectedProjectId: 1, options: failedOptions, canCreateIssue: true, canSetStartDate: true });

  const templateSelect = v.select('描述範本');
  const sopGroup = templateSelect.querySelector('optgroup[label="SOP 內建範本"]');
  assert.deepEqual(Array.from(sopGroup.querySelectorAll('option')).map(option => option.textContent), ['User Story', 'Task', 'Change', 'Bug']);
  assert.equal(templateSelect.querySelector('optgroup[label="GitLab 專案範本"]'), null);
  assert.ok(v.button('重試載入 GitLab 專案範本'));

  await v.input(v.document.querySelector('input[required]'), 'Keep title');
  await v.input(v.document.querySelector('textarea'), 'Old description');
  const details = v.document.querySelector('.issue-more-fields'); details.open = true; details.dispatchEvent(new v.dom.window.Event('toggle')); await v.tick();
  await v.input(v.select('負責人'), '9', 'change');
  await v.input(v.select('里程碑'), '4', 'change');
  await v.input(v.select('標籤'), 'bug', 'change');
  const dueDate = [...v.document.querySelectorAll('label')].find(label => label.querySelector('span')?.textContent === '到期日').querySelector('input');
  await v.input(dueDate, '2026-11-01');

  for (const [id, heading] of [
    ['user-story', '## 需求背景'],
    ['task', '## 工作內容與處理目標'],
    ['change', '## 原需求內容'],
    ['bug', '## 問題描述']
  ]) {
    await v.input(v.select('描述範本'), `sop:${id}`, 'change');
    assert.match(v.document.querySelector('textarea').value, new RegExp(heading));
  }
  assert.doesNotMatch(v.document.querySelector('textarea').value, /Old description/);
  assert.equal(v.document.querySelector('input[required]').value, 'Keep title');
  assert.equal(v.select('負責人').value, '9');
  assert.equal(v.select('里程碑').value, '4');
  assert.equal(v.select('標籤').value, 'bug');
  assert.equal(dueDate.value, '2026-11-01');
  assert.equal(v.requests.some(request => request.type === 'loadFormOptions' && request.section === 'templates'), false);

  const remoteOptions = { ...ready, templates: [{ name: 'Bug', content: 'GitLab bug template' }], states: { ...ready.states, templates: { status: 'ready' } } };
  await v.send({ type: 'projectData', projectId: 1, options: remoteOptions, preserveDraft: true, canCreateIssue: true, canSetStartDate: true });
  const updatedSelect = v.select('描述範本');
  assert.deepEqual(Array.from(updatedSelect.querySelectorAll('optgroup')).map(group => group.label), ['SOP 內建範本', 'GitLab 專案範本']);
  assert.equal(updatedSelect.querySelector('optgroup[label="SOP 內建範本"] option[value="sop:bug"]').textContent, 'Bug');
  assert.equal(updatedSelect.querySelector('optgroup[label="GitLab 專案範本"] option[value="gitlab:Bug"]').textContent, 'Bug');
  await v.input(updatedSelect, 'gitlab:Bug', 'change');
  assert.equal(v.document.querySelector('textarea').value, 'GitLab bug template');
  assert.equal(v.document.querySelector('input[required]').value, 'Keep title');
  assert.equal(v.select('負責人').value, '9');
  assert.equal(v.select('里程碑').value, '4');
  assert.equal(v.select('標籤').value, 'bug');
  assert.equal(dueDate.value, '2026-11-01');

  await v.input(v.select('描述範本'), 'sop:bug', 'change');
  v.button('建立 Issue').click(); await v.tick();
  const created = v.requests.findLast(request => request.type === 'create');
  assert.equal(created.input.title, 'Keep title');
  assert.match(created.input.description, /## 問題描述/);
  assert.equal(created.input.assigneeId, 9);
  assert.equal(created.input.milestoneId, 4);
  assert.deepEqual(Array.from(created.input.labels), ['bug']);
  assert.equal(created.input.dueDate, '2026-11-01');
});

test('two requested comment reaction patches merge in either order without reading the other 198 comments', async t => {
  const v = await mount(t), data = issueData();
  await v.send({ type: 'detailData', data });
  assert.equal(v.requests.some(r => r.type === 'loadNoteReactions' || r.type === 'loadSection' && r.sections.includes('reactions')), false);
  assert.equal(v.document.querySelectorAll('.note .reaction-demand').length, 200);
  v.document.querySelectorAll('.note .reaction-demand button')[0].click();
  v.document.querySelectorAll('.note .reaction-demand button')[1].click(); await v.tick();
  assert.deepEqual(v.requests.filter(r => r.type === 'loadNoteReactions').map(r => r.noteId), [1, 2]);
  for (const id of [2, 1]) await v.send({ type: 'detailPatch', issueId: 101, patch: { noteReactions: { [id]: [{ id: id + 500, name: 'thumbsup', user }] }, noteReactionStates: { [id]: { status: 'ready' } } } });
  assert.ok(v.document.querySelector('[aria-label="留言表情 1"]')); assert.ok(v.document.querySelector('[aria-label="留言表情 2"]'));
  assert.equal(v.document.querySelectorAll('.note .reaction-demand').length, 198);
  const before = v.requests.length;
  await v.send({ type: 'detailPatch', issueId: 999, patch: { noteReactionStates: { 1: { status: 'error', error: 'stale' } } } });
  assert.ok(v.document.querySelector('[aria-label="留言表情 1"]')); assert.equal(v.requests.length, before);
  v.button('載入Issue 表情').click(); await v.tick();
  assert.deepEqual(Array.from(v.requests.findLast(r => r.type === 'loadSection').sections), ['reactions']);
});

test('restored Issue editing demands fields only and failed note reactions require an explicit retry', async t => {
  const v = await mount(t); await v.send({ type: 'detailData', data: issueData() });
  v.button('編輯需求').click(); await v.tick();
  assert.equal(v.requests.filter(r => r.type === 'loadSection' && r.sections.includes('options')).length, 0);
  assert.equal(v.requests.some(r => r.type === 'loadFormOptions' || r.type === 'loadTemplate'), false);
  v.button('載入負責人').click(); await v.tick();
  assert.equal(v.requests.findLast(r => r.type === 'loadFormOptions').section, 'members');
  v.document.querySelector('.note .reaction-demand button').click(); await v.tick();
  await v.finish(v.requests.findLast(r => r.type === 'loadNoteReactions'));
  await v.send({ type: 'detailPatch', issueId: 101, patch: { noteReactionStates: { 1: { status: 'error', error: 'offline' } } } });
  const before = v.requests.length; await v.tick(); assert.equal(v.requests.length, before);
  v.button('重試載入留言表情').click(); await v.tick();
  assert.equal(v.requests.filter(r => r.type === 'loadNoteReactions' && r.noteId === 1).length, 2);
});

test('preview replies render before terminal cleanup and cancelled reads cannot repaint the form', async t => {
  const v = await mount(t);
  await v.send({ type: 'createData', projects: [project], selectedProjectId: 1, options: idleOptions(), canCreateIssue: true });
  await v.input(v.document.querySelector('textarea'), 'Description');
  v.button('預覽 Markdown').click(); await v.tick();
  const first = v.requests.findLast(request => request.type === 'preview');
  assert.ok(first);
  await v.send({ type: 'reply', requestId: first.requestId, result: { html: '<p>Current preview</p>' } });
  await v.finish(first);
  assert.match(v.document.querySelector('.preview')?.textContent ?? '', /Current preview/);
  v.button('預覽 Markdown').click(); await v.tick();
  const cancelled = v.requests.findLast(request => request.type === 'preview');
  assert.notEqual(cancelled.requestId, first.requestId);
  await v.send({ type: 'actionResult', requestId: cancelled.requestId, status: 'cancelled', effect: 'none' });
  await v.send({ type: 'reply', requestId: cancelled.requestId, result: { html: '<p>Discarded preview</p>' } });
  assert.match(v.document.querySelector('.preview')?.textContent ?? '', /Current preview/);
  assert.doesNotMatch(v.document.body.textContent, /Discarded preview/);
  v.button('預覽 Markdown').click(); await v.tick();
  assert.equal(v.requests.filter(request => request.type === 'preview').length, 3, 'terminal cleanup permits the next read');
});

test('project picker and similar Issue continuations preserve the draft and send only query identity', async t => {
  const v = await mount(t);
  const page = { items: [project], query: '', queryIdentity: 'group-first', complete: false, updatedAt: '2026-10-23T00:00:00Z' };
  await v.send({ type: 'createData', projects: [project], projectsState: page, selectedProjectId: 1, options: idleOptions(), canCreateIssue: true });
  const title = v.document.querySelector('input[required]');
  await v.input(title, 'Keep my title'); await v.input(v.document.querySelector('textarea'), 'Keep my description');
  v.button('載入更多專案').click(); await v.tick();
  const request = v.requests.findLast(request => request.type === 'loadCreateProjects');
  assert.equal(request.mode, 'next'); assert.equal(request.queryIdentity, 'group-first'); assert.equal('cursor' in request, false);
  await v.send({ type: 'createProjectsPage', page: { ...page, items: [project, second], complete: true } }); await v.finish(request);
  assert.equal(title.value, 'Keep my title'); assert.equal(v.document.querySelector('textarea').value, 'Keep my description'); assert.equal(v.select('專案 *').value, '1');
  title.dispatchEvent(new v.dom.window.FocusEvent('blur')); await v.tick();
  const search = v.requests.findLast(request => request.type === 'search');
  await v.send({ type: 'reply', requestId: search.requestId, result: { items: [{ id: 100, iid: 1, title: 'Matching issue', web_url: 'https://gitlab.test/team/one/-/issues/1' }], query: 'Keep my title', queryIdentity: 'issue-query', complete: false, updatedAt: page.updatedAt } }); await v.finish(search);
  v.button('載入更多相似 Issue').click(); await v.tick();
  const next = v.requests.findLast(request => request.type === 'search');
  assert.equal(next.mode, 'next'); assert.equal(next.queryIdentity, 'issue-query'); assert.equal(next.query, 'Keep my title'); assert.equal('cursor' in next, false);
  assert.equal(title.value, 'Keep my title');
});
