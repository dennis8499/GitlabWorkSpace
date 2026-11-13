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
            const controller = { tasks:[task], ui:{selectedTaskId:task.id,drafts:{[task.id]:{text:'Old private draft',revision:1}},pending:{},views:{[task.id]:'execution'}},
              items:{},interactions:{},history:{},results:{},operations:[],environment:{state:'unknown'},post,
              draftStorage:{loading:false,saving:false,conflicts:[]},launchVisible:false,read:noop,updateUi:noop,select:noop,showLaunch:noop,
              retryDraftStorage:noop,resolveDraftConflict:noop,storedDraftText:()=>'',draftConflictText:()=>'',edit:noop,submit:noop };
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
  dom.window.sent = []; dom.window.eval(script); await dom.window.CodexDeliveryControls.mount(dom.window.document.querySelector('main'), kind, props);
  return dom;
}
const button = (dom, text) => [...dom.window.document.querySelectorAll('button')].find(item => item.textContent.includes(text));
const resultTask = () => ({ id: 'saved-task', title: 'Saved analysis', root: 'C:/removed-source', status: 'completed', createdAt: '2026-01-01', updatedAt: '2026-01-01',
  threadId: 'deleted-thread', retention: 'results-only', cleanupState: 'complete', controls: { canResume: true, canAutoAccept: true },
  result: { state: 'ready', summary: 'Saved summary', draftId: 'removed-wiki', reportPath: 'C:/removed/report.md' },
  savedResult: { id: 'saved-task', title: 'Saved analysis', root: 'C:/removed-source', status: 'completed', reason: 'completed', summary: 'Portable result',
    createdAt: '2026-01-01', updatedAt: '2026-01-01', artifacts: [{ id: 'spec', path: 'spec.md', name: 'SPEC.md', mediaType: 'text/markdown', size: 12, sha256: 'a'.repeat(64) }] } });

test('saved local results render without GitLab origin and only dispatch artifact actions', async t => {
  const dom = await mount('result', { task: resultTask() }); t.after(() => dom.window.close());
  assert.match(dom.window.document.body.textContent, /Portable result/);
  assert.equal(dom.window.sent.length, 0, 'viewing saved results must not read removed Wiki/report sources');
  button(dom, 'SPEC.md').click(); button(dom, '匯出成果包').click(); button(dom, '複製接續摘要').click();
  assert.deepEqual(Array.from(dom.window.sent, item => item.command.action), ['open-artifact', 'export-result', 'copy-handoff']);
  assert.equal(dom.window.sent[0].command.artifactId, 'spec');
});

test('results-only workspace ignores stale thread and resume fields and never resurrects a conversation', async t => {
  const dom = await mount('workspace', { task: resultTask() }); t.after(() => dom.window.close());
  assert.equal(dom.window.document.querySelector('#codex-follow-up'), null);
  assert.equal(dom.window.document.querySelector('#codex-execution-panel').hidden, true);
  assert.equal(dom.window.document.body.textContent.includes('Old private draft'), false);
  assert.equal(dom.window.sent.some(item => ['codexHistory', 'resumeCodexTask', 'previewProjectWiki', 'readCodexResult'].includes(item.type) || item.command?.action === 'reconcile'), false);
  assert.ok(button(dom, '以成果建立新任務'));
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
  button(dom, '核對並重試交付').click(); button(dom, '停止並轉交人工處理').click();
  assert.deepEqual(Array.from(dom.window.sent.filter(item => item.command), item => item.command.action), ['retry-delivery','manual-handoff']);
});

test('a running publisher still offers the manual stop control without offering another delivery', async t => {
  const task = { ...resultTask(), retention:undefined, savedResult:undefined, cleanupState:undefined,
    delivery:{mode:'automatic',state:'running',steps:[]},controls:{canResume:false,canAutoAccept:false} };
  const dom = await mount('workspace', { task }); t.after(() => dom.window.close());
  assert.equal(button(dom, '核對並重試交付'), undefined);
  button(dom, '停止並轉交人工處理').click();
  assert.equal(dom.window.sent.at(-1).command.action, 'manual-handoff');
});

test('blocked launch retains manual copy and exposes required Skills and delivery choices', async t => {
  const draft = { id:'draft', schema:'GitLabWorkspaceCodexLaunch/v1',revision:1,scope:'scope',state:'blocked',source:{kind:'issue',projectId:1,issueIid:2},
    title:'Issue #2',requirement:'Implement login',repositories:[{id:'repo',name:'service',path:'C:/service'}],repositoryId:'repo',models:[],isolated:true,checks:[],
    updatedAt:'2026-01-01',availableSkills:[{id:'required',name:'bmad-help',description:'Workflow',required:true},{id:'extra',name:'testing',description:'Tests'}],
    additionalSkillIds:['extra'],testCommands:['npm test'],automaticDelivery:true,error:'Codex not authenticated' };
  const dom = await mount('launch', { draft }); t.after(() => dom.window.close());
  const required = [...dom.window.document.querySelectorAll('label')].find(item => item.textContent.includes('bmad-help')).querySelector('input');
  assert.equal(required.disabled, true); assert.equal(required.checked, true);
  button(dom, '複製手動執行資料').click();
  assert.equal(dom.window.sent.at(-1).type, 'copy'); assert.match(dom.window.sent.at(-1).text, /Implement login/);
  assert.ok(button(dom, '執行並回寫'));
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
  assert.equal(button(dom,'開始執行').disabled, true);
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
