import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import { build } from 'vite';

let bundle;
async function mount(kind, props) {
  const source = name => JSON.stringify(fileURLToPath(new URL(`../../src/webview/${name}.tsx`, import.meta.url)));
  bundle ??= build({ configFile: false, root: fileURLToPath(new URL('../../', import.meta.url)), logLevel: 'silent',
    plugins: [{ name: 'codex-delivery-controls-test', resolveId: id => id.endsWith('virtual:codex-delivery-controls') ? '\0codex-delivery-controls' : undefined,
      load: id => id === '\0codex-delivery-controls' ? `import { h, render } from 'preact';
        import { act } from 'preact/test-utils';
        import { CodexWorkflowResult } from ${source('CodexWorkflow')};
        import { CodexLaunchPanel } from ${source('CodexLaunchPanel')};
        import { CodexWorkspace } from ${source('CodexWorkspace')};
        import { Interaction } from ${source('CodexPanel')};
        const post = request => { window.sent.push(request); return {status:'started'}; };
        const noop = () => {};
        export function mount(target, kind, props) {
          let component, options;
          if (kind === 'workspace') {
            const task = props.task;
            const controller = { tasks:[task], ui:{selectedTaskId:task.id,drafts:{[task.id]:{text:'Old private draft',revision:1}},pending:{},views:{[task.id]:props.view ?? 'execution'}},
              items:{},interactions:{},history:{},results:{},operations:[],environment:{state:'unknown'},post,
              deletion:{taskIds:[],failures:[]},deleteHistory:ids=>post(ids.length===1?{type:'deleteCodexTask',taskId:ids[0]}:{type:'deleteCodexTasks',taskIds:ids}),flushReading:noop,
              draftStorage:{loading:false,saving:false,conflicts:[]},launchVisible:false,read:noop,updateUi:noop,select:noop,showLaunch:noop,
              retryDraftStorage:noop,resolveDraftConflict:noop,storedDraftText:()=>'',draftConflictText:()=>'',edit:noop,submit:()=>{window.submissions=(window.submissions??0)+1;} };
            component=CodexWorkspace; options={controller,active:true,onNavigate:noop};
          } else if (kind === 'launch') { component=CodexLaunchPanel; options={...props,post}; }
          else if (kind === 'interaction') { component=Interaction; options={...props,values:{},onEdit:noop,post,onAnswer:answer=>post({type:'answer',answer})}; }
          else { component=CodexWorkflowResult; options={...props,active:true,post}; }
          return act(() => render(h(component, options), target));
        }
        export const flush = () => act(() => {});` : undefined }],
    build: { write: false, minify: false, lib: { entry: 'virtual:codex-delivery-controls', name: 'CodexDeliveryControls', formats: ['iife'] } } });
  const result = await bundle, script = (Array.isArray(result) ? result[0] : result).output.find(item => item.type === 'chunk' && item.isEntry).code;
  const dom = new JSDOM('<main></main>', { runScripts: 'dangerously', pretendToBeVisual: true, url: 'https://fixture.invalid' });
  dom.window.structuredClone = structuredClone;
  dom.window.sent = []; dom.window.eval(script); await dom.window.CodexDeliveryControls.mount(dom.window.document.querySelector('main'), kind, props);
  return dom;
}
const button = (dom, text) => [...dom.window.document.querySelectorAll('button')].find(item => item.textContent.includes(text));
const localEvidenceTask = () => ({ id: 'local-evidence', title: 'Issue analysis', root: 'C:/group', status: 'completed', createdAt: '2026-11-15', updatedAt: '2026-11-15',
  controls: { external: false }, result: { state: 'ready', summary: 'Review before continuing' },
  workContext: { schema: 'GitLabWorkspaceWorkContext/v1', workId: 'work-one', requirement: { schema: 'GitLabWorkspaceRequirementSnapshot/v1',
    source: { kind: 'issue', identity: 'issue:2', url: 'https://gitlab.test/team/repo/-/issues/2' }, title: 'Keep issue selection', description: 'Preserve the current issue selection',
    capturedAt: '2026-11-15T01:00:00.000Z', contentDigest: 'a'.repeat(64), criteria: [{ id: 'ac-one', text: 'Keeps the selected issue', contentDigest: 'b'.repeat(64) }] },
    verification: { kind: 'docs', commands: ['npm run lint:docs'], manualChecks: ['Inspect selected issue'], reason: 'Documentation only' } },
  validationAttempts: [{ id: 'attempt-failed', cycle: 1, state: 'failed', reason: 'Selection check failed', commands: [{ command: 'npm run lint:docs', exitCode: 1 }] },
    { id: 'attempt-passed', cycle: 2, state: 'passed', commands: [{ command: 'npm run lint:docs', exitCode: 0 }] }],
  workLinks: [{ taskId: 'local-evidence', kind: 'group-analysis' }, { taskId: 'linked-build', kind: 'issue' }] });

test('requirement evidence retains failures and leaves individual criteria pending after checks pass', async t => {
  const task = localEvidenceTask(), dom = await mount('result', { task }); t.after(() => dom.window.close());
  const content = dom.window.document.body.textContent;
  assert.match(content, /Keeps the selected issue · 尚待逐條核對/); assert.match(content, /第 1 次 · 失敗/); assert.match(content, /第 2 次 · 通過/);
  assert.match(content, /待人工核對：Inspect selected issue/); assert.equal(dom.window.sent.length, 0);
  button(dom, 'Issue 開發 · linked-b').click();
  assert.deepEqual(JSON.parse(JSON.stringify(dom.window.sent)), [{ type: 'showCodexTask', taskId: 'linked-build' }]);
});

test('created Issue and delivered MR next steps require explicit clicks and preserve distinct Reviewer intent', async t => {
  const scope = 'd'.repeat(64);
  const task = localEvidenceTask(); task.result.followUps = [
    { kind: 'issue', projectId: 3, iid: 7, scope, url: 'https://gitlab.test/team/repo/-/issues/7', title: 'Created issue' },
    { kind: 'merge-request', projectId: 3, iid: 8, scope, url: 'https://gitlab.test/team/repo/-/merge_requests/8', title: 'Delivered MR' }
  ];
  const dom = await mount('result', { task }); t.after(() => dom.window.close()); assert.equal(dom.window.sent.length, 0);
  const nextSteps = dom.window.document.querySelector('[aria-label="後續工作"]');
  assert.equal(nextSteps.tagName, 'SECTION'); assert.equal(nextSteps.closest('details'), null, 'next actions stay visible without expanding technical details');
  button(dom, '使用 Codex 開發').click(); button(dom, 'Merge Review').click(); button(dom, 'Release Review').click();
  assert.deepEqual(JSON.parse(JSON.stringify(dom.window.sent)), [
    { type: 'startCodexTask', source: { kind: 'issue', projectId: 3, issueIid: 7, expectedScope: scope } },
    { type: 'startCodexTask', source: { kind: 'merge-request', projectId: 3, iid: 8, reviewerTool: 'merge-reviewer', expectedScope: scope } },
    { type: 'startCodexTask', source: { kind: 'merge-request', projectId: 3, iid: 8, reviewerTool: 'release-reviewer', expectedScope: scope } }
  ]);
  button(dom, '在 GitLab 查看 Issue').click();
  assert.deepEqual(JSON.parse(JSON.stringify(dom.window.sent.at(-1))), { type: 'openExternal', url: task.result.followUps[0].url });
  assert.equal(dom.window.sent.some(request => request.type === 'openIssue'), false);
});

test('ready Issue results keep verified delivery primary and manual handoff secondary', async t => {
  const task = { ...localEvidenceTask(), controls: { canResume: true, canAutoAccept: true, external: false },
    origin: { kind: 'issue', projectId: 3, iid: 7, projectPath: 'team/repo', repositoryRoot: 'C:/group/repo', sourceSha: 'a'.repeat(40) } };
  const dom = await mount('workspace', { task, view: 'results' }); t.after(() => dom.window.close());
  assert.equal(button(dom, '準備交接'), undefined, 'the main result action must not divert verified delivery into the legacy manual workflow');
  const manual = button(dom, '準備人工交接草稿'); assert.equal(manual.closest('details').open, false);
  const deliver = button(dom, '檢閱並確認交付'); assert.equal(deliver.disabled, false); assert.ok(deliver.classList.contains('primary'));
  assert.equal(dom.window.sent.some(item => item.command?.action === 'confirm-delivery'), false);
  deliver.click(); assert.equal(dom.window.sent.at(-1).command.action, 'confirm-delivery');
});

test('exhausted validation cycles keep review and handoff available without secondary or message-driven resume', async t => {
  const task = { ...localEvidenceTask(), implementationCycles: 3, result: { state: 'needs-work', summary: 'Verification remains unsuccessful' },
    controls: { external: false, canResume: true, canDelete: true, canAutoAccept: true },
    origin: { kind: 'issue', projectId: 3, iid: 7, projectPath: 'team/repo', repositoryRoot: 'C:/group/repo', sourceSha: 'a'.repeat(40) } };
  const dom = await mount('workspace', { task }); t.after(() => dom.window.close());
  assert.match(dom.window.document.querySelector('.codex-result-state').textContent, /已達三輪.*重新準備任務或轉交人工處理/);
  const resumeControls = [...dom.window.document.querySelectorAll('button')].filter(control => ['接續', '接續修正', '恢復任務'].includes(control.textContent));
  assert.ok(resumeControls.every(control => control.disabled), resumeControls.map(control => control.textContent).join(', '));
  assert.ok(button(dom, '檢閱待處理成果')); assert.ok(button(dom, '重新準備')); assert.ok(button(dom, '停止並轉交人工處理'));
  assert.equal(button(dom, '傳送').disabled, true);
  dom.window.document.querySelector('.codex-message').dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));
  assert.equal(dom.window.submissions ?? 0, 0); assert.equal(dom.window.sent.some(item => item.type === 'resumeCodexTask'), false);
});

test('saved autoapproval stays visibly dormant until execution is armed and has only one switch', async t => {
  for (const armed of [false, true]) {
    const task = { ...localEvidenceTask(), status: armed ? 'running' : 'paused', controls: {
      external: false, canResume: true, canAutoAccept: true, autoAccept: true, autoAcceptArmed: armed
    } };
    const dom = await mount('workspace', { task }); t.after(() => dom.window.close());
    const switches = dom.window.document.querySelectorAll('.codex-auto-accept input'); assert.equal(switches.length, 1); assert.equal(switches[0].checked, true);
    assert.match(switches[0].parentElement.textContent, armed ? /本機自動核准：ON/ : /接續後啟用/);
    assert.equal(dom.window.sent.some(item => item.type === 'setCodexAutoAccept'), false, 'rendering a saved switch must never enable approvals');
    switches[0].click(); assert.equal(dom.window.sent.at(-1).enabled, false);
  }
});

test('task context distinguishes shared local Wiki output from a GitLab Wiki snapshot without inferring another output', async t => {
  for (const target of ['local', 'gitlab']) {
    const task = { ...localEvidenceTask(), locations: { workspaceRoot: 'C:/group', sourceRoot: 'C:/group/service',
      executionRoot: target === 'local' ? 'C:/group/.gitlab-workspace/runtime' : 'C:/storage/snapshot/wiki',
      outputRoot: target === 'local' ? 'C:/group/wiki' : 'C:/storage/snapshot/wiki', wikiTarget: target,
      sourceBasis: target === 'local' ? '目前本機來源內容' : '遠端預設分支固定版本' } };
    const dom = await mount('workspace', { task }); t.after(() => dom.window.close());
    const context = dom.window.document.querySelector('[aria-label="任務來源與位置"]');
    assert.match(context.textContent, target === 'local' ? /本地 Codebase Wiki/ : /GitLab Wiki 草稿/);
    const values = [...context.querySelectorAll('dd')].map(item => item.textContent);
    assert.deepEqual(values, ['C:/group', 'C:/group/service', task.locations.executionRoot, task.locations.outputRoot]);
    assert.equal(context.textContent.includes('C:/group/service/wiki'), false, 'a selected Repo must never silently change the Group Wiki output');
  }
});

test('unsettled publication and delivery steps disable result writes and next-stage dispatch', async t => {
  for (const patch of [
    { publication: { kind: 'reply', state: 'pending', key: 'pending' } },
    { delivery: { state: 'needs-attention', steps: [{ kind: 'push', state: 'uncertain' }] } },
    { cleanupState: 'running' }
  ]) {
    const task = { ...localEvidenceTask(), ...patch, origin: { kind: 'issue', projectId: 3, iid: 7, projectPath: 'team/repo', sourceSha: 'a'.repeat(40) } };
    task.result.followUps = [{ kind: 'merge-request', projectId: 3, iid: 8, scope: 'd'.repeat(64), url: 'https://gitlab.test/mr/8', title: 'MR' }];
    const dom = await mount('result', { task }); t.after(() => dom.window.close());
    for (const label of ['檢閱並確認交付', 'Merge Review', 'Release Review']) { const control = button(dom, label); assert.equal(control.disabled, true, label); control.click(); }
    assert.equal(dom.window.sent.some(item => item.type === 'startCodexTask' || item.command?.action === 'confirm-delivery'), false);
  }
});

test('external or unsettled tasks cannot start follow-up work from a result card', async t => {
  for (const patch of [{ status: 'uncertain' }, { controls: { external: true } }]) {
    const task = { ...localEvidenceTask(), ...patch }; task.result.followUps = [{ kind: 'issue', projectId: 3, iid: 7, scope: 'd'.repeat(64), url: 'https://gitlab.test/issue/7', title: 'Created issue' }];
    const dom = await mount('result', { task }); t.after(() => dom.window.close());
    const launch = button(dom, '使用 Codex 開發'); assert.equal(launch.disabled, true); launch.click();
    assert.equal(dom.window.sent.some(item => item.type === 'startCodexTask'), false);
  }
});

test('legacy or invalid account scopes keep only original links and cannot dispatch numeric-ID work', async t => {
  for (const scope of [undefined, 'invalid-scope']) {
    const task = localEvidenceTask(); task.result.followUps = [
      { kind: 'issue', projectId: 3, iid: 7, scope, url: 'https://original.gitlab.test/team/repo/-/issues/7', title: 'Historical issue' },
      { kind: 'merge-request', projectId: 3, iid: 8, scope, url: 'https://original.gitlab.test/team/repo/-/merge_requests/8', title: 'Historical MR' }
    ];
    const dom = await mount('result', { task }); t.after(() => dom.window.close()); assert.equal(dom.window.sent.length, 0);
    for (const text of ['使用 Codex 開發', 'Merge Review', 'Release Review']) assert.equal(button(dom, text), undefined);
    button(dom, '在 GitLab 查看 Issue').click(); button(dom, '查看 MR').click();
    assert.deepEqual(JSON.parse(JSON.stringify(dom.window.sent)), task.result.followUps.map(item => ({ type: 'openExternal', url: item.url })));
  }
});

test('saved next steps retain the archived account scope across realms instead of deriving a current-account scope', async t => {
  const task = localEvidenceTask(), originalScope = 'a'.repeat(64), anotherScope = 'b'.repeat(64);
  task.retention = 'results-only'; task.result.followUps = [{ kind: 'merge-request', projectId: 3, iid: 8, scope: anotherScope, url: 'https://another.gitlab.test/mr/8', title: 'Current realm' }];
  task.savedResult = { id: task.id, title: task.title, root: task.root, status: 'completed', createdAt: task.createdAt, updatedAt: task.updatedAt, reason: 'completed', summary: 'Archived work', artifacts: [],
    result: { state: 'published', summary: 'Original realm', followUps: [{ kind: 'merge-request', projectId: 3, iid: 8, scope: originalScope, url: 'https://original.gitlab.test/team/repo/-/merge_requests/8', title: 'Original realm' }] } };
  const dom = await mount('result', { task }); t.after(() => dom.window.close()); assert.equal(dom.window.sent.length, 0);
  button(dom, 'Release Review').click();
  assert.deepEqual(JSON.parse(JSON.stringify(dom.window.sent)), [{ type: 'startCodexTask', source: { kind: 'merge-request', projectId: 3, iid: 8,
    reviewerTool: 'release-reviewer', expectedScope: originalScope } }]);
});

test('documentation-only issues offer explicit manual acceptance without claiming checks passed', async t => {
  const task = localEvidenceTask(); task.origin = { kind: 'issue', projectPath: 'team/repo', sourceSha: 'a'.repeat(40), sourceBranch: 'main' };
  task.result = { state: 'needs-work', summary: 'Needs manual review', files: ['README.md', 'docs/screen.png'] };
  task.workContext.verification.commands = []; task.validationAttempts = [];
  const dom = await mount('result', { task }); t.after(() => dom.window.close());
  const manual = button(dom, '人工驗收文件變更'); assert.ok(manual); assert.equal(button(dom, '檢閱並確認交付'), undefined);
  assert.equal(dom.window.sent.length, 0); manual.click();
  assert.deepEqual(JSON.parse(JSON.stringify(dom.window.sent)), [{ type: 'codexCommand', command: { action: 'confirm-documentation', taskId: task.id } }]);
});

test('manual acceptance is unavailable for mixed code configured commands active or already accepted documents', async t => {
  for (const variant of ['code', 'configured', 'running', 'accepted', 'external', 'empty']) {
    const task = localEvidenceTask(); task.origin = { kind: 'issue', projectPath: 'team/repo', sourceSha: 'a'.repeat(40), sourceBranch: 'main' };
    task.result = { state: 'needs-work', summary: 'Needs verification', files: ['README.md'] }; task.workContext.verification.commands = [];
    if (variant === 'code') task.result.files.push('src/main.ts');
    if (variant === 'configured') task.workContext.verification.commands = ['npm run lint:docs'];
    if (variant === 'running') task.status = 'running';
    if (variant === 'accepted') task.validation = { manual: { checks: ['Verified'] } };
    if (variant === 'external') task.controls.external = true;
    if (variant === 'empty') task.result.files = [];
    const dom = await mount('result', { task }); t.after(() => dom.window.close());
    assert.equal(button(dom, '人工驗收文件變更'), undefined, variant); assert.equal(dom.window.sent.some(request => request.type === 'codexCommand'), false);
  }
});

test('human-reviewed criteria are labeled only for the exact requirement snapshot', async t => {
  for (const matches of [true, false]) {
    const task = localEvidenceTask(); task.validation = { requirementDigest: matches ? task.workContext.requirement.contentDigest : 'c'.repeat(64),
      manual: { confirmedAt: '2026-11-15T01:00:00.000Z', checks: ['Keeps the selected issue', 'Inspect selected issue'] } };
    const dom = await mount('result', { task }); t.after(() => dom.window.close());
    assert.match(dom.window.document.body.textContent, matches ? /Keeps the selected issue · 已人工核對/ : /Keeps the selected issue · 尚待逐條核對/);
    assert.equal(dom.window.sent.length, 0);
  }
});
const resultTask = () => ({ id: 'saved-task', title: 'Saved analysis', root: 'C:/removed-source', status: 'completed', createdAt: '2026-01-01', updatedAt: '2026-01-01',
  threadId: 'deleted-thread', retention: 'results-only', cleanupState: 'complete', controls: { canResume: true, canAutoAccept: true },
  result: { state: 'ready', summary: 'Saved summary', draftId: 'removed-wiki', reportPath: 'C:/removed/report.md' },
  savedResult: { id: 'saved-task', title: 'Saved analysis', root: 'C:/removed-source', status: 'completed', reason: 'completed', summary: 'Portable result',
    createdAt: '2026-01-01', updatedAt: '2026-01-01', artifacts: [{ id: 'spec', path: 'spec.md', name: 'SPEC.md', mediaType: 'text/markdown', size: 12, sha256: 'a'.repeat(64) }] } });

test('completed local Group and BMAD results keep documents closed until explicitly opened', async t => {
  for (const kind of ['Group', 'BMAD']) await t.test(kind, async t => {
    const task = { id:`local-${kind}`,title:`${kind} analysis`,root:'C:/group',status:'completed',createdAt:'2026-01-01',updatedAt:'2026-01-01',
      controls:{external:false},groupAnalysis:kind === 'Group' ? {repositories:3} : undefined,
      result:{state:'ready',summary:`${kind} documents await review`,reportPath:'C:/artifacts/SPEC.md',handoffPath:'C:/artifacts/cards.md'} };
    const dom = await mount('result', {task}); t.after(() => dom.window.close());
    assert.match(dom.window.document.body.textContent, new RegExp(task.result.summary));
    assert.equal(dom.window.sent.length, 0, 'mounting local results must keep the workbench visible instead of opening a document');
    if (kind === 'Group') assert.equal(button(dom,'檢閱並建立 Issue').disabled,false);
    button(dom,'開啟需求文件').click();
    assert.deepEqual(Array.from(dom.window.sent, request => [request.type,request.taskId]), [['readCodexResult',task.id]]);
    if (kind === 'Group') assert.equal(button(dom,'檢閱並建立 Issue').disabled,false);
  });
});

test('linked completed Issue, MR and Wiki results retain automatic payload hydration', async t => {
  for (const kind of ['issue','merge-request','project-wiki']) await t.test(kind, async t => {
    const task = { id:`linked-${kind}`,title:'Linked result',root:'C:/repo',status:'completed',createdAt:'2026-01-01',updatedAt:'2026-01-01',
      controls:{external:false},origin:{kind,projectId:1,projectPath:'group/service',sourceSha:'a'.repeat(40),branch:'feature'},
      result:{state:'ready',summary:'Review the linked result',reportPath:'C:/artifacts/report.md',handoffPath:'C:/artifacts/handoff.md',
        ...(kind === 'project-wiki' ? {draftId:'wiki-draft'} : {})} };
    const dom = await mount('result', {task}); t.after(() => dom.window.close());
    assert.deepEqual(Array.from(dom.window.sent, request => [request.type,request.taskId]),
      [[kind === 'project-wiki' ? 'previewProjectWiki' : 'readCodexResult',task.id]]);
  });
});

const nativeReviewTask = (tool, patch = {}) => ({ id: `native-${tool}`, title: tool, root: 'C:/group', status: 'completed',
  createdAt: '2026-01-01', updatedAt: '2026-01-01', controls: { external: false },
  origin: { kind: 'merge-request', intent: 'review', projectId: 2, iid: 1, projectPath: 'group/service', sourceSha: 'a'.repeat(40), targetSha: 'b'.repeat(40) },
  review: { tool, requestId: tool === 'merge-reviewer' ? 'a'.repeat(32) : 'b'.repeat(32), revision: 'c'.repeat(64) },
  result: { state: 'ready', summary: 'Report ready for human review', reportPath: `C:/reports/${tool}.md` }, ...patch });

test('both native Reviewer results publish only their own task and complete report for the same MR', async t => {
  for (const tool of ['merge-reviewer', 'release-reviewer']) await t.test(tool, async t => {
    const task = nativeReviewTask(tool), body = `# ${tool}\n\nComplete ${tool} findings.\n`;
    const dom = await mount('result', { task, payload: { type: 'codexWorkflowResult', taskId: task.id, report: body } }); t.after(() => dom.window.close());
    const publish = button(dom, '發布審查報告留言'); assert.ok(publish, 'each tool needs its own native publication entry');
    assert.equal(publish.disabled, false); assert.equal(dom.window.sent.some(request => request.type === 'publishCodexReview'), false);
    assert.match(dom.window.document.querySelector('details').textContent, new RegExp(`Complete ${tool} findings`));
    publish.click();
    assert.deepEqual(JSON.parse(JSON.stringify(dom.window.sent.filter(request => request.type === 'publishCodexReview'))),
      [{ type: 'publishCodexReview', taskId: task.id, body }]);
  });
});

test('native Reviewer publication blocks active or external tasks and never resends published or unknown outcomes', async t => {
  const cases = [
    ['needs-work', { result: { state: 'needs-work', reportPath: 'C:/reports/partial.md' } }, false],
    ['external', { controls: { external: true } }, true], ['running', { status: 'running' }, true],
    ['queued', { status: 'queued' }, true], ['uncertain-task', { status: 'uncertain' }, true],
    ['published', { result: { state: 'published', reportPath: 'C:/reports/published.md' } }, false],
    ['uncertain-result', { result: { state: 'uncertain', reportPath: 'C:/reports/unknown.md' } }, false],
    ['pending-receipt', { publication: { kind: 'review', state: 'pending', key: 'review-key' } }, true],
    ['confirmed-receipt', { publication: { kind: 'review', state: 'confirmed', key: 'review-key' } }, true],
    ['unknown-recovery', { recovery: { publication: 'unknown' } }, true]
  ];
  for (const [label, patch, visible] of cases) await t.test(label, async t => {
    const task = nativeReviewTask('release-reviewer', patch);
    const dom = await mount('result', { task, payload: { type: 'codexWorkflowResult', taskId: task.id, report: '# Release findings' } }); t.after(() => dom.window.close());
    const publish = button(dom, '發布審查報告留言');
    if (visible) { assert.ok(publish); assert.equal(publish.disabled, true); publish.click(); }
    else assert.equal(publish, undefined);
    assert.equal(dom.window.sent.some(request => request.type === 'publishCodexReview'), false);
  });
});

test('native report publication stays hidden for other origins, missing reports and mismatched task payloads', async t => {
  const base = nativeReviewTask('merge-reviewer');
  for (const [label, patch, payloadPatch] of [
    ['Issue', { origin: { ...base.origin, kind: 'issue' } }, {}],
    ['Wiki', { origin: { ...base.origin, kind: 'project-wiki' } }, {}],
    ['fix-comments', { origin: { ...base.origin, intent: 'fix-comments' } }, {}],
    ['missing-review', { review: undefined }, {}], ['empty-report', {}, { report: '  ' }],
    ['other-task-payload', {}, { taskId: 'other-reviewer-task' }]
  ]) await t.test(label, async t => {
    const task = { ...base, ...patch }, payload = { type: 'codexWorkflowResult', taskId: task.id, report: '# Findings', ...payloadPatch };
    const dom = await mount('result', { task, payload }); t.after(() => dom.window.close());
    assert.equal(button(dom, '發布審查報告留言'), undefined);
    assert.equal(dom.window.sent.some(request => request.type === 'publishCodexReview'), false);
  });
});

test('saved local results render without GitLab origin and only dispatch artifact actions', async t => {
  const dom = await mount('result', { task: resultTask() }); t.after(() => dom.window.close());
  assert.match(dom.window.document.body.textContent, /Portable result/);
  assert.equal(dom.window.sent.length, 0, 'viewing saved results must not read removed Wiki/report sources');
  button(dom, 'SPEC.md').click(); button(dom, '匯出成果包').click(); button(dom, '複製接續摘要').click();
  assert.deepEqual(Array.from(dom.window.sent, item => item.command.action), ['open-artifact', 'export-result', 'copy-handoff']);
  assert.equal(dom.window.sent[0].command.artifactId, 'spec');
});

test('archived GitLab Wiki updates start a new source check only after a click and provisional bundles cannot update', async t => {
  for (const provisional of [false, true]) {
    const task = resultTask(); task.savedResult.origin = { kind: 'project-wiki', projectId: 3, projectPath: 'team/service',
      webUrl: 'https://gitlab.test/team/service', repositoryRoot: 'C:/group/service', sourceBranch: 'main', sourceSha: 'a'.repeat(40) };
    task.savedResult.provisional = provisional;
    const dom = await mount('result', { task }); t.after(() => dom.window.close());
    assert.equal(dom.window.sent.length, 0, 'reading retained Wiki content must not restart its old thread or generate an update');
    const update = button(dom, '依來源變更更新 GitLab Wiki');
    if (provisional) assert.equal(update, undefined);
    else { assert.ok(update); update.click(); assert.deepEqual(JSON.parse(JSON.stringify(dom.window.sent)), [{ type: 'codexCommand', command: { action: 'regenerate-wiki', taskId: task.id } }]); }
  }
});

test('results-only workspace ignores stale thread and resume fields and never resurrects a conversation', async t => {
  const dom = await mount('workspace', { task: resultTask() }); t.after(() => dom.window.close());
  assert.equal(dom.window.document.querySelector('#codex-follow-up'), null);
  assert.equal(dom.window.document.querySelector('#codex-execution-panel').hidden, true);
  assert.equal(dom.window.document.body.textContent.includes('Old private draft'), false);
  assert.equal(dom.window.sent.some(item => ['codexHistory', 'resumeCodexTask', 'previewProjectWiki', 'readCodexResult'].includes(item.type) || item.command?.action === 'reconcile'), false);
  assert.ok(button(dom, '以成果建立新任務'));
  const utilities = dom.window.document.querySelector('.codex-list-utilities'); utilities.querySelector('summary').click(); assert.equal(utilities.open, true);
  button(dom, '管理本機連線').click();
  assert.equal(dom.window.sent.at(-1).command.action, 'manage-local-connections');
  assert.equal(dom.window.sent.at(-1).command.taskId, undefined);
});

test('a recoverable saved result offers explicit manual restoration without reviving its removed thread', async t => {
  const task = resultTask(); task.savedResult.restore = { originalRepository:'C:/retained-repo',baseSha:'a'.repeat(40) };
  const dom = await mount('result', { task }); t.after(() => dom.window.close());
  button(dom, '還原至新的手動工作目錄').click();
  assert.deepEqual(Array.from(dom.window.sent, item => item.command.action), ['restore-result']);
});

test('large saved artifact lists reveal one hundred at a time, reset for another task and never offer retired delivery', async t => {
  const task = resultTask(); task.savedResult.delivery={state:'needs-attention'};
  task.savedResult.artifacts = Array.from({length:250}, (_,index) => ({id:`file-${index}`,path:`files/${index}.md`,name:`File ${index}`,
    mediaType:'text/markdown',size:12,sha256:'a'.repeat(64)}));
  const dom = await mount('result', {task}); t.after(() => dom.window.close());
  const visible = () => dom.window.document.querySelectorAll('[aria-label="成果檔案"] li').length;
  assert.equal(visible(),100); assert.equal(button(dom,'核對並重試交付'),undefined);
  assert.match(button(dom,'顯示更多成果').textContent,/100\/250/);
  button(dom,'顯示更多成果').click(); await dom.window.CodexDeliveryControls.flush(); assert.equal(visible(),200);
  assert.equal(dom.window.document.activeElement.textContent,'File 100');
  button(dom,'顯示更多成果').click(); await dom.window.CodexDeliveryControls.flush(); assert.equal(visible(),250);
  assert.equal(dom.window.document.activeElement.textContent,'File 200');
  assert.equal(button(dom,'顯示更多成果'),undefined);
  const other={...task,id:'another-result',savedResult:{...task.savedResult,id:'another-result'}};
  await dom.window.CodexDeliveryControls.mount(dom.window.document.querySelector('main'),'result',{task:other});
  assert.equal(visible(),100); assert.match(button(dom,'顯示更多成果').textContent,/100\/250/);
  const exportButton=button(dom,'匯出成果包'); exportButton.focus();
  await dom.window.CodexDeliveryControls.mount(dom.window.document.querySelector('main'),'result',{task:{...other,savedResult:{...other.savedResult,summary:'Updated result metadata'}}});
  assert.equal(dom.window.document.activeElement,exportButton,'background result changes must preserve current focus');
});

test('a failed publisher keeps retry and manual controls reachable before result sealing', async t => {
  const task = { ...resultTask(), retention:undefined, savedResult:undefined, cleanupState:undefined,
    delivery:{mode:'automatic',state:'needs-attention',steps:[],error:'GitLab temporarily unavailable'},controls:{canResume:false,canAutoAccept:false} };
  const dom = await mount('workspace', { task }); t.after(() => dom.window.close());
  assert.match(dom.window.document.body.textContent, /GitLab temporarily unavailable/);
  button(dom, '任務詳情').click(); await dom.window.CodexDeliveryControls.flush();
  assert.equal(dom.window.document.querySelector('.codex-details-drawer').hidden, false);
  button(dom, '核對並重試交付').click(); button(dom, '停止並轉交人工處理').click();
  assert.deepEqual(Array.from(dom.window.sent.filter(item => item.command), item => item.command.action), ['retry-delivery','manual-handoff']);
});

test('a running publisher still offers the manual stop control without offering another delivery', async t => {
  const task = { ...resultTask(), retention:undefined, savedResult:undefined, cleanupState:undefined,
    delivery:{mode:'automatic',state:'running',steps:[]},controls:{canResume:false,canAutoAccept:false} };
  const dom = await mount('workspace', { task }); t.after(() => dom.window.close());
  assert.equal(button(dom, '核對並重試交付'), undefined);
  button(dom, '任務詳情').click(); await dom.window.CodexDeliveryControls.flush();
  assert.equal(dom.window.document.querySelector('.codex-details-drawer').hidden, false);
  button(dom, '停止並轉交人工處理').click();
  assert.equal(dom.window.sent.at(-1).command.action, 'manual-handoff');
});

function blockedLaunch(source) {
  return { id:'draft', schema:'GitLabWorkspaceCodexLaunch/v1',revision:1,scope:'scope',state:'blocked',source,
    title:'Issue #2',requirement:'Implement login',repositories:[{id:'repo',name:'service',path:'C:/service'}],repositoryId:'repo',models:[],isolated:true,checks:[],
    updatedAt:'2026-01-01',availableSkills:[{id:'required',name:'bmad-help',description:'Workflow',required:true},{id:'extra',name:'testing',description:'Tests'}],
    additionalSkillIds:['extra'],testCommands:['npm test'],automaticDelivery:true,error:'Codex not authenticated' };
}

test('suggested verification commands fill an empty field only after explicit adoption', async t => {
  const draft = { ...blockedLaunch({kind:'issue',projectId:1,issueIid:2}), testCommands:[], suggestedTestCommands:['npm test','npm run lint'] };
  const dom = await mount('launch', { draft }); t.after(() => dom.window.close());
  const field = dom.window.document.querySelector('#codex-launch-tests');
  assert.equal(field.value, ''); assert.deepEqual(dom.window.sent, []);
  button(dom, '採用建議驗證命令').click(); await dom.window.CodexDeliveryControls.flush();
  assert.equal(field.value, 'npm test\nnpm run lint'); assert.equal(button(dom, '採用建議驗證命令'), undefined);
  button(dom, '重新檢查').click();
  const update = dom.window.sent.find(item => item.type === 'checkCodexLaunch');
  assert.deepEqual(Array.from(update.patch.testCommands), ['npm test','npm run lint']);
  assert.equal(dom.window.sent.some(item => item.type === 'submitCodexLaunch'), false);
});

test('verification command suggestions never replace an existing entry', async t => {
  const draft = { ...blockedLaunch({kind:'issue',projectId:1,issueIid:2}), testCommands:['npm run typecheck'], suggestedTestCommands:['npm test'] };
  const dom = await mount('launch', { draft }); t.after(() => dom.window.close());
  assert.equal(button(dom, '採用建議驗證命令'), undefined);
  assert.equal(dom.window.document.querySelector('#codex-launch-tests').value, 'npm run typecheck'); assert.deepEqual(dom.window.sent, []);
});

test('App Server-only launches keep required Skills without offering manual execution or automatic publication authority', async t => {
  for (const source of [{kind:'issue',projectId:1,issueIid:2}, {kind:'project-wiki',projectId:1},
    {kind:'merge-request',projectId:1,iid:3,intent:'fix-comments'}]) await t.test(source.kind + (source.intent ?? ''), async t => {
    const dom = await mount('launch', { draft: blockedLaunch(source) }); t.after(() => dom.window.close());
    const document = dom.window.document;
    const required = [...document.querySelectorAll('label')].find(item => item.textContent.includes('bmad-help')).querySelector('input');
    assert.equal(required.disabled, true); assert.equal(required.checked, true);
    assert.equal(button(dom, '複製手動執行資料'), undefined);
    assert.equal(document.querySelectorAll('input[type="checkbox"]').length, 2, 'Only required and optional Skills have checkboxes');
    assert.match(document.body.textContent, /人工確認後交付/);
    assert.match(document.body.textContent, /既有自動交付設定不代替這次確認/);
    assert.equal(button(dom, '開始任務').type, 'submit');
    assert.deepEqual(dom.window.sent, [], 'Viewing a blocked launch grants no remote publication or task submission');
  });
});

test('Group and both MR reviewers copy evidence-bound manual instructions with human handling of final results', async t => {
  for (const source of [{kind:'group-analysis',repositoryIds:['repo']},
    {kind:'merge-request',projectId:1,iid:3,reviewerTool:'merge-reviewer'},
    {kind:'merge-request',projectId:1,iid:3,reviewerTool:'release-reviewer'}]) await t.test(source.reviewerTool ?? source.kind, async t => {
    const draft = { ...blockedLaunch(source), repositoryIds:['repo'], sourceSha:'a'.repeat(40), targetSha:'b'.repeat(40),
      sourceSnapshot:{sourceSha:'a'.repeat(40),repositories:[{id:'repo',sha:'a'.repeat(40)}]} };
    const dom = await mount('launch', { draft }); t.after(() => dom.window.close());
    button(dom, '複製手動執行資料').click();
    assert.equal(dom.window.sent.length, 1); assert.equal(dom.window.sent[0].type, 'copy');
    const text = dom.window.sent[0].text;
    assert.match(text, /Implement login/); assert.match(text, /C:\/service/); assert.ok(text.includes('a'.repeat(40)));
    assert.match(text, /最終文件與報告交由使用者處理/);
    if (source.kind === 'group-analysis') {
      assert.match(text, /source-first functional-exploration/); assert.match(text, /IssueDraftBundle\/v1/);
      assert.match(text, /不得建立 Issue 或修改程式/);
    } else {
      assert.ok(text.includes('b'.repeat(40))); assert.ok(text.includes(source.reviewerTool));
      assert.match(text, /不得提交、推送或寫入 GitLab/);
    }
    assert.equal(dom.window.sent.some(request => request.type === 'submitCodexLaunch'), false);
    assert.equal([...dom.window.document.querySelectorAll('label')].some(label => /自動.*(?:交付|發布|推送)/.test(label.textContent)), false);
  });
});

test('Group source confirmation shows each selected repository version and its change', async t => {
  const draft = { id:'group',revision:2,state:'ready',source:{kind:'group-analysis'},title:'Group analysis',requirement:'Shared login change',models:[],isolated:false,checks:[],
    repositories:[{id:'front',name:'Front end',path:'C:/front'},{id:'api',name:'API service',path:'C:/api'}],repositoryIds:['front','api'],
    sourceSnapshot:{sourceSha:'a'.repeat(40),repositories:[{id:'front',sha:'a'.repeat(40)},{id:'api',sha:'c'.repeat(40)}]},
    sourceChange:{key:'change',acknowledged:false,previous:{sourceSha:'a'.repeat(40),repositories:[{id:'front',sha:'a'.repeat(40)},{id:'api',sha:'b'.repeat(40)}]},
      current:{sourceSha:'a'.repeat(40),repositories:[{id:'front',sha:'a'.repeat(40)},{id:'api',sha:'c'.repeat(40)}]}} };
  const dom = await mount('launch', {draft}); t.after(() => dom.window.close());
  const fixed = dom.window.document.querySelector('[aria-label="Group 固定 Repo 版本"]');
  assert.match(fixed.textContent, /Front end/); assert.match(fixed.textContent, /API service/); assert.ok(fixed.textContent.includes('c'.repeat(40)));
  const changes = dom.window.document.querySelector('[aria-label="Group Repo 版本變更"]');
  assert.match(changes.textContent, /API service/); assert.ok(changes.textContent.includes('b'.repeat(40))); assert.ok(changes.textContent.includes('c'.repeat(40)));
  assert.equal(button(dom,'開始任務').disabled, true);
});

test('approvals render only advertised decisions and retain session scope', async t => {
  const dom = await mount('interaction', { root:'C:/repo',interaction:{id:'approval',taskId:'task',kind:'command',title:'Run test',availableDecisions:['acceptForSession','decline']} });
  t.after(() => dom.window.close());
  assert.equal(button(dom, '核准本次要求'), undefined); assert.equal(button(dom, '取消'), undefined);
  button(dom, '目前對話均允許').click(); assert.equal(dom.window.sent.at(-1).answer.decision, 'acceptForSession');
  const permissions = await mount('interaction', { root:'C:/repo',interaction:{id:'permissions',taskId:'task',kind:'permissions',title:'Extra path',permissionScopes:['turn','session']} });
  t.after(() => permissions.window.close());
  const select = permissions.window.document.querySelector('select'); select.value='session'; select.dispatchEvent(new permissions.window.Event('change',{bubbles:true}));
  await permissions.window.CodexDeliveryControls.flush();
  button(permissions, '核准本次要求').click(); assert.equal(permissions.window.sent.at(-1).answer.scope, 'session');
});

test('network policy changes use only the advertised host and explicit persistent choice', async t => {
  const dom = await mount('interaction', { root:'C:/repo',interaction:{id:'network',taskId:'task',kind:'command',title:'Network request',
    availableDecisions:[{applyNetworkPolicyAmendment:{network_policy_amendment:{action:'deny',host:'example.com'}}},'cancel']} });
  t.after(() => dom.window.close());
  assert.equal(button(dom, '核准本次要求'), undefined);
  button(dom, '保存網路規則：拒絕 example.com').click();
  assert.deepEqual(JSON.parse(JSON.stringify(dom.window.sent.at(-1).answer.networkPolicyAmendment)), {action:'deny',host:'example.com'});
  assert.equal(dom.window.sent.at(-1).answer.execpolicyAmendment, undefined);
  const unsupported = await mount('interaction', { root:'C:/repo',interaction:{id:'future',taskId:'task',kind:'command',title:'Future request',availableDecisions:['futureChoice','cancel']} });
  t.after(() => unsupported.window.close());
  assert.match(unsupported.window.document.body.textContent, /尚未支援的原生核准選項/);
  assert.equal(button(unsupported, '核准本次要求'), undefined);
});
