const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');
const { JSDOM } = require('jsdom');
const { After, Given, When, Then, setWorldConstructor } = require('@cucumber/cucumber');

const bundle = readFileSync(resolve(__dirname, '../../resources/issue-webview/issue-test.js'), 'utf8');
const project = { id: 42, name: 'Project', path: 'project', path_with_namespace: 'group/project', web_url: 'https://gitlab.example.test/group/project' };
const target = { ...project, id: 43, name: 'Target', path: 'target', path_with_namespace: 'group/target' };
const user = { id: 9, name: 'Test User', username: 'tester' };
const issue = { id: 401, iid: 7, project_id: 42, title: 'Original issue', description: '**Safe description**', state: 'opened', web_url: 'https://gitlab.example.test/group/project/-/issues/7', updated_at: '2026-09-24T00:00:00Z', author: user, assignees: [], labels: [], subscribed: false };
const options = { members: [user], labels: [{ id: 3, name: 'bug', color: '#ff0000' }], milestones: [{ id: 4, title: 'Iteration' }], templates: [{ name: 'Bug', content: 'Steps to reproduce' }] };
const discussion = { id: 'thread-1', notes: [{ id: 88, body: 'First comment', author: user, created_at: '2026-09-24T00:00:00Z', system: false }] };

class IssueWorld {
  messages = [];
  workspaceActions = [];
  data = null;
  async boot() {
    this.dom = new JSDOM('<!doctype html><html><body><div id="app"></div></body></html>', { url: 'https://webview.example.test/', runScripts: 'outside-only', pretendToBeVisual: true });
    this.dom.window.addEventListener('workspaceIssueRequest', (event) => this.messages.push(event.detail));
    this.dom.window.addEventListener('workspaceAction', (event) => this.workspaceActions.push(event.detail));
    this.dom.window.eval(bundle);
    await this.tick();
  }
  async tick() { await new Promise((done) => setTimeout(done, 120)); }
  async send(data) {
    this.dom.window.dispatchEvent(new this.dom.window.MessageEvent('message', { data }));
    await this.tick();
  }
  get root() { return this.dom.window.document; }
  button(label) {
    const button = [...this.root.querySelectorAll('button')].find((item) => item.textContent.trim() === label);
    assert.ok(button, `Missing button: ${label}`);
    const menu = button.closest('details');
    if (menu) menu.open = true;
    return button;
  }
  async click(label) { this.button(label).click(); await this.tick(); }
  async tab(label) {
    const tab = [...this.root.querySelectorAll('[role="tab"]')].find((item) => item.textContent.trim() === label);
    assert.ok(tab, `Missing tab: ${label}`);
    tab.click();
    await this.tick();
    return tab;
  }
  async input(selector, value) {
    const element = this.root.querySelector(selector);
    assert.ok(element, `Missing field: ${selector}`);
    element.value = value;
    element.dispatchEvent(new this.dom.window.Event('input', { bubbles: true }));
    await this.tick();
  }
  async detail(canEdit = true) {
    this.data = { issue, project, projects: [project, target], user, options, discussions: [discussion], links: [], mergeRequests: [], reactions: [], noteReactions: {}, todos: [], tasks: [{ id: 'gid://gitlab/WorkItem/99', iid: '3', title: 'Child task', description: 'Task details', state: 'OPEN', canEdit }], timelogs: [], startDate: null, parentWorkItemId: 'gid://gitlab/WorkItem/401', taskTypeId: 'gid://gitlab/WorkItems::Type/5', warnings: [], canEdit, canDelete: canEdit, canMove: canEdit, canClone: canEdit, canComment: canEdit, canInternalComment: canEdit, canLink: canEdit, canManageChildren: canEdit, canTrackTime: canEdit, canResolveThreads: canEdit, canSetStartDate: canEdit, hasStartDate: true, canLogTime: canEdit, canDeleteTimelog: canEdit };
    await this.send({ type: 'detailData', data: this.data });
  }
}
setWorldConstructor(IssueWorld);

After(function () {
  this.dom?.window.close();
});

Given('the Issue Webview is ready for creation', async function () { await this.boot(); });
When('the selected group supplies a project and its form options', async function () {
  await this.send({ type: 'createData', projects: [project], selectedProjectId: 42, options, canSetStartDate: true, canCreateIssue: true });
});
When('the selected group supplies two projects', async function () {
  await this.send({ type: 'createData', projects: [project, target], selectedProjectId: 42, options, canSetStartDate: true, canCreateIssue: true });
});
Then('the CE creation controls and similar issue search are available', function () {
  for (const text of ['標題 *', '描述範本', '負責人', '標籤', '里程碑', '開始日期', '到期日', '機密 Issue']) {
    assert.ok(this.root.body.textContent.includes(text), `Missing ${text}`);
  }
  assert.ok(this.button('預覽 Markdown'));
  assert.ok(this.button('上傳附件'));
});
When('I create an unassigned confidential issue with Markdown', async function () {
  await this.input('input[placeholder="簡要描述工作內容"]', 'New issue');
  await this.input('textarea[placeholder]', '# Description');
  const startDate = this.root.querySelectorAll('input[type="date"]')[1];
  startDate.value = '2026-10-02';
  startDate.dispatchEvent(new this.dom.window.Event('input', { bubbles: true }));
  await this.tick();
  const confidential = this.root.querySelector('input[type="checkbox"]');
  confidential.click();
  await this.tick();
  await this.click('建立 Issue');
});
Then('a typed create request contains the CE fields and no token', function () {
  const request = this.messages.find((item) => item.type === 'create');
  assert.equal(request.projectId, 42);
  assert.equal(request.input.title, 'New issue');
  assert.equal(request.input.description, '# Description');
  assert.equal(request.input.assigneeId, undefined);
  assert.equal(request.input.confidential, true);
  assert.equal(request.input.startDate, '2026-10-02');
  assert.doesNotMatch(JSON.stringify(this.messages), /PRIVATE-TOKEN|issue-api-test-token/);
});
When('GitLab returns the newly created issue detail', async function () { await this.detail(); });
Then('the unassigned issue is open in the detail view', function () {
  assert.match(this.root.body.textContent, /#7 Original issue/);
  assert.match(this.root.body.textContent, /未指派/);
});
When('I fill the template and every project metadata field', async function () {
  const select = (labelText) => [...this.root.querySelectorAll('label')].find((label) => label.querySelector('span')?.textContent.trim() === labelText)?.querySelector('select');
  const choose = async (element, value) => {
    assert.ok(element);
    element.value = value;
    element.dispatchEvent(new this.dom.window.Event('change', { bubbles: true }));
    await this.tick();
  };
  await this.input('input[placeholder="簡要描述工作內容"]', 'Complete issue');
  await choose(select('描述範本'), 'Bug');
  await choose(select('負責人'), '9');
  await choose(select('里程碑'), '4');
  await choose(select('標籤'), 'bug');
  const setDate = async (labelText, value) => {
    const input = [...this.root.querySelectorAll('label')].find((label) => label.querySelector('span')?.textContent.trim() === labelText)?.querySelector('input[type="date"]');
    assert.ok(input);
    input.value = value;
    input.dispatchEvent(new this.dom.window.Event('input', { bubbles: true }));
    await this.tick();
  };
  await setDate('到期日', '2026-10-05');
  await setDate('開始日期', '2026-10-01');
  await this.click('建立 Issue');
});
Then('the create request contains the selected CE values', function () {
  const input = this.messages.find((item) => item.type === 'create').input;
  assert.equal(input.title, 'Complete issue');
  assert.equal(input.description, 'Steps to reproduce');
  assert.equal(input.assigneeId, 9);
  assert.equal(input.milestoneId, 4);
  assert.equal(input.dueDate, '2026-10-05');
  assert.equal(input.startDate, '2026-10-01');
  assert.equal(JSON.stringify(input.labels), '["bug"]');
});
When('I choose another project but GitLab rejects its form options', async function () {
  const select = this.root.querySelector('select');
  select.value = '43';
  select.dispatchEvent(new this.dom.window.Event('change', { bubbles: true }));
  await this.tick();
  assert.equal(this.messages.at(-1).type, 'selectProject');
  assert.equal(this.messages.at(-1).projectId, 43);
  await this.send({ type: 'error', message: 'Could not load project options.' });
});
Then('the form remains on the first project and can only create there', async function () {
  assert.equal(this.root.querySelector('select').value, '42');
  assert.match(this.root.querySelector('[role="alert"]').textContent, /Could not load project options/);
  await this.input('input[placeholder="簡要描述工作內容"]', 'Still on first project');
  await this.click('建立 Issue');
  assert.equal(this.messages.at(-1).projectId, 42);
});
When('GitLab reports no create permission for the selected project', async function () {
  await this.send({ type: 'createData', projects: [project], selectedProjectId: 42, options: { ...options, warnings: ['This account cannot create issues in the selected project.'] }, canSetStartDate: true, canCreateIssue: false });
  await this.input('input[placeholder="簡要描述工作內容"]', 'Not permitted');
});
Then('the create action is disabled', function () {
  assert.equal(this.button('建立 Issue').disabled, true);
  assert.match(this.root.body.textContent, /cannot create issues/);
});
When('GitLab cannot load the selected group', async function () {
  await this.send({ type: 'error', message: 'Select a GitLab group first.' });
});
Then('the loading error is visible with a retry action', function () {
  assert.match(this.root.querySelector('[role="alert"]').textContent, /Select a GitLab group first/);
  assert.ok(this.button('重試'));
});

Given('the Issue Webview is ready with an editable issue', async function () { await this.boot(); await this.detail(); });
When('GitLab renders Markdown containing an unsafe script', async function () {
  const preview = this.messages.find((item) => item.type === 'preview');
  assert.ok(preview);
  await this.send({ type: 'reply', requestId: preview.requestId, result: { html: '<strong>Safe Markdown</strong><script>window.bad = 1</script><img src="/group/project/uploads/hash/image.png" onerror=alert(1)>' } });
});
Then('the rendered description contains safe Markdown without script', function () {
  const description = this.root.querySelector('.description');
  assert.match(description.innerHTML, /<strong>Safe Markdown<\/strong>/);
  assert.doesNotMatch(description.innerHTML, /<script|onerror/);
});
Then('a private upload image is requested through the host', async function () {
  const request = this.messages.find((item) => item.type === 'image');
  assert.equal(request.url, 'https://gitlab.example.test/group/project/uploads/hash/image.png');
  await this.send({ type: 'reply', requestId: request.requestId, result: { dataUrl: 'data:image/png;base64,iVBORw0KGgo=' } });
  assert.match(this.root.querySelector('.description img').src, /^data:image\/png;base64,/);
});
When('GitLab cannot render the description Markdown', async function () {
  const preview = this.messages.find((item) => item.type === 'preview');
  await this.send({ type: 'reply', requestId: preview.requestId, error: 'Markdown renderer unavailable.' });
});
Then('the original Markdown text remains readable', function () {
  assert.match(this.root.querySelector('.description pre').textContent, /Safe description/);
});
When('I request an attachment', async function () { await this.click('編輯需求'); await this.click('上傳附件'); });
Then('the Webview sends a typed upload request without a token', function () {
  const upload = this.messages.find((item) => item.type === 'upload');
  assert.equal(upload.projectId, 42);
  assert.doesNotMatch(JSON.stringify(upload), /token|authorization/i);
});
When('I preview and attach a file to a comment', async function () {
  await this.input('.card textarea:not([placeholder])', '**Comment draft**');
  const previews = [...this.root.querySelectorAll('button')].filter((button) => button.textContent.trim() === '預覽 Markdown');
  previews.at(-1).click();
  await this.tick();
  const preview = this.messages.find((item) => item.type === 'preview' && item.markdown === '**Comment draft**');
  assert.ok(preview);
  await this.send({ type: 'reply', requestId: preview.requestId, result: { html: '<strong>Comment draft</strong>' } });
  const uploads = [...this.root.querySelectorAll('button')].filter((button) => button.textContent.trim() === '上傳附件');
  uploads.at(-1).click();
  await this.tick();
  this.commentUpload = this.messages.filter((item) => item.type === 'upload').at(-1);
  await this.send({ type: 'reply', requestId: this.commentUpload.requestId, result: { markdown: '![file](/group/project/uploads/hash/file.png)' } });
});
Then('the comment preview and attachment remain in the comment editor', function () {
  assert.match(this.root.body.innerHTML, /<strong>Comment draft<\/strong>/);
  assert.match(this.root.querySelector('.card textarea:not([placeholder])').value, /!\[file\]/);
  assert.equal(this.messages.find((item) => item.type === 'update'), undefined);
});
When('I mark a comment as internal', async function () {
  await this.input('.card textarea:not([placeholder])', 'Private note');
  const checkbox = [...this.root.querySelectorAll('label')].find((label) => label.textContent.includes('內部留言')).querySelector('input');
  checkbox.click();
  await this.tick();
});
Then('starting a public thread is disabled', function () {
  assert.equal(this.button('開始討論').disabled, true);
  assert.match(this.root.body.textContent, /內部留言無法建立討論串/);
  assert.equal(this.button('送出留言').disabled, false);
});
When('I open another issue before the old Markdown reply arrives', async function () {
  const oldPreview = this.messages.find((item) => item.type === 'preview' && item.markdown === issue.description);
  assert.ok(oldPreview);
  const next = { ...issue, id: 402, iid: 8, title: 'Second issue', description: 'New description', web_url: 'https://gitlab.example.test/group/project/-/issues/8' };
  await this.send({ type: 'detailData', data: { ...this.data, issue: next } });
  const newPreview = this.messages.find((item) => item.type === 'preview' && item.markdown === 'New description');
  assert.ok(newPreview);
  await this.send({ type: 'reply', requestId: newPreview.requestId, result: { html: '<em>New content</em>' } });
  await this.send({ type: 'reply', requestId: oldPreview.requestId, result: { html: '<em>Old content</em>' } });
});
Then('only the new issue Markdown remains visible', function () {
  const description = this.root.querySelector('.description').innerHTML;
  assert.match(description, /New content/);
  assert.doesNotMatch(description, /Old content/);
  assert.match(this.root.querySelector('h1').textContent, /Second issue/);
});

When('I change the title and save', async function () {
  await this.click('編輯需求');
  await this.input('input[placeholder="簡要描述工作內容"]', 'My changed title');
  await this.click('儲存變更');
});
Then('the update request includes the last seen revision', function () {
  const update = this.messages.find((item) => item.type === 'update');
  assert.equal(update.issueId, issue.id);
  assert.equal(update.expectedUpdatedAt, issue.updated_at);
  assert.equal(update.input.title, 'My changed title');
});
When('GitLab reports a save conflict', async function () { await this.send({ type: 'error', message: 'This issue changed in GitLab. Reload it before saving your edits.' }); });
Then('the changed title and conflict message remain visible', function () {
  assert.equal(this.root.querySelector('input[placeholder="簡要描述工作內容"]').value, 'My changed title');
  assert.match(this.root.querySelector('[role="alert"]').textContent, /changed in GitLab/);
  assert.ok(this.button('重新整理'));
});
When('I reload the latest issue after the conflict', async function () {
  await this.click('重新整理');
  await this.send({ type: 'detailData', data: { ...this.data, issue: { ...issue, updated_at: '2026-09-24T01:00:00Z' } } });
});
Then('my draft remains and a retry uses the latest revision', async function () {
  assert.equal(this.root.querySelector('input[placeholder="簡要描述工作內容"]').value, 'My changed title');
  await this.click('儲存變更');
  const updates = this.messages.filter((item) => item.type === 'update');
  assert.equal(updates.at(-1).expectedUpdatedAt, '2026-09-24T01:00:00Z');
});

When('I comment, reply, subscribe, and add a to-do', async function () {
  await this.input('.card textarea:not([placeholder])', 'A new comment');
  await this.click('送出留言');
  await this.detail();
  await this.input('textarea[aria-label="回覆內容"]', 'A reply');
  await this.click('送出回覆');
  await this.detail();
  await this.tab('關聯與子工作');
  await this.click('訂閱此 Issue');
  await this.detail();
  await this.click('加入待辦');
});
Then('the corresponding typed actions are sent without a token', function () {
  const actions = this.messages.filter((item) => item.type === 'invoke').map((item) => item.action);
  assert.deepEqual(actions, ['note', 'reply', 'subscribe', 'todo']);
  assert.ok(this.messages.filter((item) => item.type === 'invoke').every((item) => item.issueId === issue.id));
  assert.doesNotMatch(JSON.stringify(this.messages), /PRIVATE-TOKEN|Authorization/i);
});

Then('the relationship, child task, time, move, clone, and delete controls are available', function () {
  for (const label of ['建立關聯', '建立子工作', '加入既有子工作', '設定預估', '新增待送出工時', '移動 Issue', '複製 Issue', '刪除 Issue']) {
    assert.ok(this.button(label));
  }
  assert.equal(this.root.querySelectorAll('select option[value="43"]').length, 1);
});
When('I request a clone with comments', async function () {
  const targetSelect = this.root.querySelector('.sidebar .card:last-child select');
  targetSelect.value = '43';
  targetSelect.dispatchEvent(new this.dom.window.Event('change', { bubbles: true }));
  await this.tick();
  this.root.querySelector('.sidebar .card:last-child input[type="checkbox"]').click();
  await this.tick();
  await this.click('複製 Issue');
});
Then('the typed clone request includes comments and the target project', function () {
  const clone = this.messages.find((message) => message.type === 'invoke' && message.action === 'clone');
  assert.equal(clone.payload.toProjectId, 43);
  assert.equal(clone.payload.withNotes, true);
});
When('I search for a target project in another group', async function () {
  await this.input('input[aria-label="搜尋目標專案"]', 'external');
  await this.click('搜尋專案');
  const request = this.messages.find((item) => item.type === 'searchProjects');
  assert.equal(request.query, 'external');
  await this.send({ type: 'reply', requestId: request.requestId, result: [{ ...target, id: 99, path_with_namespace: 'other-group/external' }] });
});
Then('the other group project can be selected for moving or cloning', function () {
  assert.ok(this.root.querySelector('.sidebar option[value="99"]'));
});
When('GitLab supplies a time report and I log time on a chosen date', async function () {
  await this.send({ type: 'detailData', data: { ...this.data, timelogs: [{ id: 'gid://gitlab/Timelog/1', timeSpent: 3600, spentAt: '2026-09-24T12:00:00Z', summary: 'Investigated', user, userPermissions: { adminTimelog: true } }] } });
  await this.tab('工時');
  const date = [...this.root.querySelectorAll('label')].find((label) => label.textContent.includes('登錄日期')).querySelector('input');
  date.value = '2026-09-23';
  date.dispatchEvent(new this.dom.window.Event('input', { bubbles: true }));
  await this.tick();
  assert.equal(this.root.querySelector('input[aria-label="工時日期"]').value, '2026-09-23');
  await this.input('input[aria-label="工時長度"]', '1h');
  await this.click('新增待送出工時');
});
Then('the dated time action and a permitted timelog deletion are available', function () {
  const spend = this.workspaceActions.find((item) => item.type === 'addManualTime');
  assert.equal(spend.spentAt, '2026-09-23');
  assert.match(this.root.body.textContent, /Investigated/);
  assert.ok(this.root.querySelector('.time-report button.danger'));
});
When('I inspect and edit a child task', async function () {
  await this.tab('關聯與子工作');
  await this.click('#3 Child task');
  assert.match(this.root.body.textContent, /Task details/);
  await this.click('編輯子工作');
  await this.input('input[aria-label="子工作標題"]', 'Updated child');
  await this.input('textarea[aria-label="子工作描述"]', 'Updated details');
  await this.click('儲存子工作');
});
Then('the task update stays inside the Issue Webview', function () {
  const action = this.messages.find((item) => item.type === 'invoke' && item.action === 'updateChild');
  assert.equal(action.payload.taskId, 'gid://gitlab/WorkItem/99');
  assert.equal(action.payload.title, 'Updated child');
  assert.equal(action.payload.description, 'Updated details');
  assert.equal(this.messages.some((item) => item.type === 'openLink'), false);
});
When('I use a reaction on a comment', async function () {
  await this.send({ type: 'detailData', data: { ...this.data, noteReactions: { 88: [{ id: 6, name: 'thumbsup', user }] } } });
  await this.click('thumbsup 1');
});
When('I open the issue in GitLab', async function () { await this.click('在 GitLab 開啟'); });
Then('the host receives an explicit GitLab open request', function () {
  const requests = this.messages.filter((item) => item.type === 'openIssueInGitLab');
  assert.equal(requests.length, 1);
  assert.equal(requests[0].issueId, issue.id);
  assert.equal(this.messages.some((item) => item.type === 'openLink'), false);
});
Then('the comment reaction sends its own typed operation', function () {
  const action = this.messages.find((item) => item.type === 'invoke' && item.action === 'unreactNote');
  assert.equal(action.payload.noteId, 88);
  assert.equal(action.payload.reactionId, 6);
});

Given('the Issue Webview is ready with a read-only issue', async function () { await this.boot(); await this.detail(false); });
Then('editing and destructive controls are hidden', function () {
  assert.equal([...this.root.querySelectorAll('.main-column .card:first-child button')].some((button) => button.textContent.trim() === 'Edit'), false);
  for (const label of ['移動 Issue', '刪除 Issue', '建立子工作']) {
    assert.equal([...this.root.querySelectorAll('button')].some((button) => button.textContent.trim() === label), false);
  }
  assert.match(this.root.body.textContent, /開始日期/);
});
When('GitLab rejects an action', async function () { await this.tab('關聯與子工作'); await this.click('訂閱此 Issue'); await this.send({ type: 'error', message: 'GitLab rejected this operation.' }); });
Then('the error is visible and the issue remains open', function () {
  assert.match(this.root.querySelector('[role="alert"]').textContent, /rejected/);
  assert.match(this.root.querySelector('h1').textContent, /Original issue/);
});

When('I edit my comment and GitLab rejects the save', async function () {
  const editButton = [...this.root.querySelectorAll('.note button')].find((button) => button.textContent.trim() === '編輯');
  assert.ok(editButton);
  editButton.click();
  await this.tick();
  await this.input('textarea[aria-label="編輯留言"]', 'Updated comment draft');
  await this.click('儲存');
  const edit = this.messages.filter((item) => item.type === 'invoke' && item.action === 'editNote').at(-1);
  assert.equal(edit.payload.body, 'Updated comment draft');
  await this.send({ type: 'error', message: 'GitLab rejected the comment edit.' });
});
Then('my changed comment and the error remain in the editor', function () {
  assert.equal(this.root.querySelector('textarea[aria-label="編輯留言"]')?.value, 'Updated comment draft');
  assert.match(this.root.querySelector('[role="alert"]').textContent, /rejected the comment edit/);
});
When('GitLab accepts the retried comment edit', async function () {
  await this.click('儲存');
  const edits = this.messages.filter((item) => item.type === 'invoke' && item.action === 'editNote');
  assert.equal(edits.length, 2);
  assert.equal(edits.at(-1).payload.body, 'Updated comment draft');
  const updated = { ...discussion, notes: [{ ...discussion.notes[0], body: 'Updated comment draft' }] };
  await this.send({ type: 'detailData', data: { ...this.data, discussions: [updated] } });
});
Then('the editor closes and the updated comment is shown', function () {
  assert.equal(this.root.querySelector('textarea[aria-label="編輯留言"]'), null);
  assert.match(this.root.body.textContent, /Updated comment draft/);
});

Then('the detail shows the four task tabs and opens on content', function () {
  const labels = ['內容與討論', '開發與交付', '關聯與子工作', '工時'];
  const tabs = [...this.root.querySelectorAll('.issue-tabs[role="tablist"] [role="tab"]')];
  assert.deepEqual(tabs.map((item) => item.textContent.trim()), labels);
  assert.equal(tabs[0].getAttribute('aria-selected'), 'true');
  assert.equal(tabs[0].tabIndex, 0);
  assert.equal(tabs[1].tabIndex, -1);
  assert.ok([...this.root.querySelectorAll('.issue-section:not([hidden])')].some((section) => section.textContent.includes('討論與活動')));
});
When('I visit each Issue task tab', async function () {
  for (const label of ['開發與交付', '關聯與子工作', '工時', '內容與討論']) {
    const selected = this.root.querySelector('.issue-tabs[role="tablist"] [role="tab"][aria-selected="true"]');
    selected.focus();
    selected.dispatchEvent(new this.dom.window.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    await this.tick();
    assert.equal(this.root.querySelector('.issue-tabs[role="tablist"] [role="tab"][aria-selected="true"]').textContent.trim(), label);
  }
});
Then('the selected tab displays the matching section', function () {
  const selected = this.root.querySelector('.issue-tabs[role="tablist"] [role="tab"][aria-selected="true"]');
  assert.ok(selected);
  const expectedHeading = ({
    '內容與討論': '討論與活動',
    '開發與交付': '開始開發與交付',
    '關聯與子工作': '關聯 Issue',
    '工時': '工時'
  })[selected.textContent.trim()];
  assert.ok(expectedHeading, `Unexpected selected tab: ${selected.textContent}`);
  const visibleSections = [...this.root.querySelectorAll('.issue-section:not([hidden])')];
  assert.ok(visibleSections.some((section) => [...section.querySelectorAll('h2, h3')].some((heading) => heading.textContent.includes(expectedHeading))), `Missing visible section for ${expectedHeading}`);
});

When('I edit issue fields and subscribing refreshes the detail', async function () {
  await this.click('編輯需求');
  await this.input('input[placeholder="簡要描述工作內容"]', 'Unsaved issue title');
  await this.input('textarea[placeholder="填寫背景、操作步驟、驗收條件或 /quick_actions"]', 'Unsaved issue description');
  await this.tab('關聯與子工作');
  await this.click('訂閱此 Issue');
  await this.send({ type: 'detailData', data: { ...this.data, issue: { ...issue, subscribed: true } } });
  await this.tab('內容與討論');
});
Then('my unsaved issue fields stay in the editor', function () {
  assert.equal(this.root.querySelector('input[placeholder="簡要描述工作內容"]')?.value, 'Unsaved issue title');
  assert.equal(this.root.querySelector('textarea[placeholder="填寫背景、操作步驟、驗收條件或 /quick_actions"]')?.value, 'Unsaved issue description');
  const preview = this.messages.filter((item) => item.type === 'preview' && item.requestId.startsWith('preview-')).at(-1);
  assert.equal(preview.markdown, 'Unsaved issue description');
  assert.ok(this.button('儲存變更'));
});
When('I successfully save those issue fields', async function () {
  await this.click('儲存變更');
  const request = this.messages.filter((item) => item.type === 'update').at(-1);
  assert.equal(request.input.title, 'Unsaved issue title');
  assert.equal(request.input.description, 'Unsaved issue description');
  await this.send({ type: 'detailData', data: { ...this.data, issue: { ...issue, title: 'Unsaved issue title', description: 'Unsaved issue description', subscribed: true } } });
});
Then('the editor closes with the saved issue fields', function () {
  assert.equal(this.root.querySelector('input[placeholder="簡要描述工作內容"]'), null);
  assert.match(this.root.querySelector('h1').textContent, /Unsaved issue title/);
});

When('I draft replies in two threads and post the first', async function () {
  const secondDiscussion = { id: 'thread-2', notes: [{ ...discussion.notes[0], id: 89, body: 'Another comment' }] };
  const discussions = [discussion, secondDiscussion];
  await this.send({ type: 'detailData', data: { ...this.data, discussions } });
  const editors = this.root.querySelectorAll('textarea[aria-label="回覆內容"]');
  assert.equal(editors.length, 2);
  for (const [index, body] of ['First reply draft', 'Second reply draft'].entries()) {
    editors[index].value = body;
    editors[index].dispatchEvent(new this.dom.window.Event('input', { bubbles: true }));
    await this.tick();
  }
  const firstReply = this.root.querySelector('.discussion .reply-row button:last-of-type');
  assert.ok(firstReply);
  firstReply.click();
  await this.tick();
  const request = this.messages.filter((item) => item.type === 'invoke' && item.action === 'reply').at(-1);
  assert.equal(request.payload.discussionId, 'thread-1');
  await this.send({ type: 'detailData', data: { ...this.data, discussions } });
});
Then('only the posted thread reply draft is cleared', function () {
  const editors = this.root.querySelectorAll('textarea[aria-label="回覆內容"]');
  assert.equal(editors[0].value, '');
  assert.equal(editors[1].value, 'Second reply draft');
});

When('a previously rendered comment changes and its new preview fails', async function () {
  const originalPreview = this.messages.find((item) => item.type === 'preview' && item.markdown === 'First comment');
  assert.ok(originalPreview);
  await this.send({ type: 'reply', requestId: originalPreview.requestId, result: { html: '<strong>Old rendered comment</strong>' } });
  assert.match(this.root.querySelector('.note').innerHTML, /Old rendered comment/);
  const changed = { ...discussion, notes: [{ ...discussion.notes[0], body: 'New **raw** comment', updated_at: '2026-09-24T01:00:00Z' }] };
  await this.send({ type: 'detailData', data: { ...this.data, discussions: [changed] } });
  const newPreview = this.messages.find((item) => item.type === 'preview' && item.markdown === 'New **raw** comment');
  assert.ok(newPreview);
  await this.send({ type: 'reply', requestId: newPreview.requestId, error: 'Markdown renderer unavailable.' });
});
Then('the changed comment source remains visible without stale HTML', function () {
  const note = this.root.querySelector('.note');
  assert.match(note.textContent, /New \*\*raw\*\* comment/);
  assert.doesNotMatch(note.innerHTML, /Old rendered comment/);
});

When('I request deletion and cancel the confirmation', async function () {
  await this.click('刪除 Issue');
  assert.ok(this.root.querySelector('.loading'));
  await this.send({ type: 'cancelled' });
});
Then('the detail stays open and actions are available again', function () {
  assert.match(this.root.querySelector('h1').textContent, /Original issue/);
  assert.equal(this.root.querySelector('.loading'), null);
  assert.equal(this.button('重新整理').disabled, false);
});

When('I enter another comment and child title while their requests are pending', async function () {
  const comment = this.root.querySelector('.card textarea:not([placeholder])');
  await this.input('.card textarea:not([placeholder])', 'Posted comment');
  await this.click('送出留言');
  comment.value = 'Next comment draft';
  comment.dispatchEvent(new this.dom.window.Event('input', { bubbles: true }));
  await this.tick();
  await this.send({ type: 'detailData', data: this.data });
  await this.tab('關聯與子工作');
  await this.input('input[aria-label="新子工作標題"]', 'Posted task');
  await this.click('建立子工作');
  const next = this.root.querySelector('input[aria-label="新子工作標題"]');
  next.value = 'Next task draft';
  next.dispatchEvent(new this.dom.window.Event('input', { bubbles: true }));
  await this.tick();
  await this.send({ type: 'detailData', data: this.data });
});
Then('the later comment and child title remain after GitLab responds', function () {
  assert.equal(this.root.querySelector('.card textarea:not([placeholder])').value, 'Next comment draft');
  assert.equal(this.root.querySelector('input[aria-label="新子工作標題"]').value, 'Next task draft');
});

When('I change a field again before the prior save completes', async function () {
  await this.click('編輯需求');
  await this.input('input[placeholder="簡要描述工作內容"]', 'First saved title');
  await this.click('儲存變更');
  await this.input('input[placeholder="簡要描述工作內容"]', 'Later title draft');
  await this.send({ type: 'detailData', data: { ...this.data, issue: { ...issue, title: 'First saved title', updated_at: '2026-09-24T01:00:00Z' } } });
});
Then('the later field value remains ready for another save', async function () {
  assert.equal(this.root.querySelector('input[placeholder="簡要描述工作內容"]').value, 'Later title draft');
  await this.click('儲存變更');
  const saves = this.messages.filter((item) => item.type === 'update');
  assert.equal(saves.at(-1).input.title, 'Later title draft');
  assert.equal(saves.at(-1).expectedUpdatedAt, '2026-09-24T01:00:00Z');
});
