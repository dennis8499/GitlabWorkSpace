import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import { webviewBundle } from './webview-bundle.mjs';

const { script } = await webviewBundle('issue-test');
const project = { id: 1, path_with_namespace: 'team/one', web_url: 'https://gitlab.test/team/one' };
const second = { ...project, id: 2, path_with_namespace: 'team/two' };
const user = { id: 9, name: 'Tester', username: 'tester' };
const idleOptions = () => ({ members: [], labels: [], milestones: [], templates: [], states: { fields: { status: 'idle' }, templates: { status: 'idle' } } });
const readyOptions = () => ({ ...idleOptions(), members: [user], labels: [{ id: 3, name: 'bug' }], milestones: [{ id: 4, title: 'Release' }], states: { fields: { status: 'ready' }, templates: { status: 'idle' } } });
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
  assert.deepEqual(v.requests.filter(r => r.type === 'loadFormOptions').map(r => r.section), ['fields']);
  await v.send({ type: 'projectData', projectId: 1, options: readyOptions(), preserveDraft: true, canCreateIssue: true });
  await v.finish(v.requests.find(r => r.type === 'loadFormOptions'));
  assert.equal(v.document.querySelector('input[required]').value, 'Saved title');
  await v.input(v.select('負責人'), '9', 'change'); await v.input(v.select('里程碑'), '4', 'change'); await v.input(v.select('標籤'), 'bug', 'change');
  v.button('使用描述範本').click(); await v.tick();
  assert.deepEqual(v.requests.filter(r => r.type === 'loadFormOptions').map(r => r.section), ['fields', 'templates']);
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
  await v.send({ type: 'projectData', projectId: 1, options: { ...idleOptions(), states: { fields: { status: 'error', error: 'offline' }, templates: { status: 'idle' } } }, preserveDraft: true, canCreateIssue: true });
  const count = v.requests.length; await v.tick(); assert.equal(v.requests.length, count, 'rendering an error cannot retry');
  assert.equal(v.select('負責人').value, '9'); assert.equal(v.select('標籤').value, 'bug');
  v.button('重試載入欄位選項').click(); await v.tick();
  assert.equal(v.requests.findLast(r => r.type === 'loadFormOptions').section, 'fields');
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
  assert.equal(v.requests.filter(r => r.type === 'loadSection' && r.sections.includes('options')).length, 1);
  assert.equal(v.requests.some(r => r.type === 'loadFormOptions' || r.type === 'loadTemplate'), false);
  v.document.querySelector('.note .reaction-demand button').click(); await v.tick();
  await v.finish(v.requests.findLast(r => r.type === 'loadNoteReactions'));
  await v.send({ type: 'detailPatch', issueId: 101, patch: { noteReactionStates: { 1: { status: 'error', error: 'offline' } } } });
  const before = v.requests.length; await v.tick(); assert.equal(v.requests.length, before);
  v.button('重試載入留言表情').click(); await v.tick();
  assert.equal(v.requests.filter(r => r.type === 'loadNoteReactions' && r.noteId === 1).length, 2);
});
