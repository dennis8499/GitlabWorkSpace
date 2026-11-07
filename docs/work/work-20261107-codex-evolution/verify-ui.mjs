// Read-only UI audit using production bundles and synthetic data; no GitLab or Codex connection.
// Derived from the 20261105 audit harness; run this file after prepare:validation.
import { readFile, writeFile, mkdir, access } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import ts from 'typescript';
import { chromium } from 'playwright-core';
import { createWebviewCsp } from '../../../out/src/webviewSecurity.js';
import { bmadWorkspaceSnapshot } from '../../../test/fixtures/bmad-ui.mjs';

const directory = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(directory, '../../..');
const evidence = process.env.UX_EVIDENCE_DIR ? path.resolve(root, process.env.UX_EVIDENCE_DIR) : path.join(directory, 'evidence');
await mkdir(evidence, { recursive: true });
const fixtureSource = await readFile(path.join(root, 'test/behavior/dashboard.test.mjs'), 'utf8');
const ast = ts.createSourceFile('dashboard.test.mjs', fixtureSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
const fixtureNames = new Set(['project', 'snapshot', 'gitSnapshot', 'issueDetailData']);
const fixtureFunctions = ast.statements.filter(node => ts.isFunctionDeclaration(node) && fixtureNames.has(node.name?.text)).map(node => node.getText(ast));
if (fixtureFunctions.length !== fixtureNames.size) throw new Error('Expected fixture functions have changed; inspect before updating this probe.');
const { snapshot, gitSnapshot, issueDetailData } = new Function(`const gitHead='a'.repeat(40),gitParent='b'.repeat(40),gitSide='c'.repeat(40); ${fixtureFunctions.join('\n')}; return {snapshot,gitSnapshot,issueDetailData};`)();

let themeRoot = process.env.VSCODE_THEME_ROOT;
if (!themeRoot) {
  for (const candidate of [
    '.vscode-test/vscode-win32-x64-archive-1.145.0/a717861c07/resources/app/extensions/theme-defaults/themes',
    '.vscode-test/vscode-win32-x64-archive-1.90.0/resources/app/extensions/theme-defaults/themes'
  ]) {
    try { await access(path.join(root, candidate, 'light_modern.json')); themeRoot = path.join(root, candidate); break; } catch { /* Try another cached installation. */ }
  }
}
if (!themeRoot) throw new Error('Set VSCODE_THEME_ROOT to an installed theme-defaults/themes directory.');
async function themeColors(filename) {
  const content = await readFile(path.join(themeRoot, filename), 'utf8');
  const parsed = ts.parseConfigFileTextToJson(filename, content);
  if (parsed.error) throw new Error('Invalid theme JSON');
  return { ...(parsed.config.include ? await themeColors(parsed.config.include) : {}), ...parsed.config.colors };
}
const themes = {};
for (const [name, file, bodyClass, light] of [
  ['light', 'light_modern.json', 'vscode-light', true],
  ['dark', 'dark_modern.json', 'vscode-dark', false],
  ['hc-dark', 'hc_black.json', 'vscode-high-contrast', false],
  ['hc-light', 'hc_light.json', 'vscode-high-contrast-light', true]
]) {
  const colors = await themeColors(file);
  // Theme files omit editor defaults. These explicit fallbacks are fixture values,
  // not a claim to reproduce the VS Code theme service or OS high contrast exactly.
  const fallback = {
    foreground: light ? '#3b3b3b' : '#cccccc',
    'editor.background': light ? '#ffffff' : '#1f1f1f',
    'sideBar.background': light ? '#f8f8f8' : '#181818',
    'descriptionForeground': light ? '#616161' : '#9d9d9d',
    'focusBorder': light ? '#005fb8' : '#0078d4',
    'button.background': light ? '#005fb8' : '#0078d4',
    'button.foreground': '#ffffff',
    'button.secondaryBackground': light ? '#e5e5e5' : '#313131',
    'button.secondaryForeground': light ? '#3b3b3b' : '#cccccc',
    'input.background': light ? '#ffffff' : '#313131',
    'input.foreground': light ? '#3b3b3b' : '#cccccc',
    'input.border': light ? '#cecece' : '#3c3c3c',
    'panel.border': light ? '#e5e5e5' : '#2b2b2b',
    'textLink.foreground': light ? '#005fb8' : '#4daafc',
    'errorForeground': light ? '#a1260d' : '#f48771',
    'testing.iconPassed': light ? '#388a34' : '#73c991',
    'list.activeSelectionBackground': light ? '#005fb8' : '#04395e',
    'list.activeSelectionForeground': '#ffffff'
  };
  themes[name] = { bodyClass, css: ':root{' + Object.entries({ ...fallback, ...colors }).map(([key, value]) => `--vscode-${key.replaceAll('.', '-')}:${value};`).join('')
    + '--vscode-font-family:"Segoe UI",sans-serif;--vscode-font-size:13px;--vscode-editor-font-family:Consolas,monospace;}' };
}
const nonce = 'synthetic-audit-nonce';
async function assetResponse(url) {
  try {
    const theme = themes[url.searchParams.get('theme') ?? 'light'];
    if (url.pathname === '/theme.css') {
      return { contentType: 'text/css', body: theme.css };
    }
    const surface = url.pathname.startsWith('/sidebar') ? 'sidebar' : 'dashboard';
    const assetRoot = path.join(root, 'resources', surface === 'sidebar' ? 'sidebar-webview' : 'issue-webview');
    const basename = path.basename(url.pathname);
    if (!/^(?:(dashboard|sidebar)\.(html|js|css)|codicon\.ttf)$/.test(basename)) return { status: 404, body: '' };
    let content = await readFile(path.join(assetRoot, basename));
    if (basename.endsWith('.html')) {
      content = content.toString().replace('<head>', `<head><meta http-equiv="Content-Security-Policy" content="${createWebviewCsp("'self'", nonce, surface)}"><link rel="stylesheet" href="/theme.css?theme=${url.searchParams.get('theme') ?? 'light'}">`)
        .replace('<body>', `<body class="${theme.bodyClass}">`)
        .replace(/<script\b/g, `<script nonce="${nonce}"`);
    }
    return { contentType: basename.endsWith('.ttf') ? 'font/ttf' : basename.endsWith('.js') ? 'application/javascript' : basename.endsWith('.css') ? 'text/css' : 'text/html', body: content };
  } catch { return { status: 500, body: 'Audit asset error' }; }
}
const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROME_PATH ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe' });
const results = [];
const messages = page => page.evaluate(() => window.auditRequests);
const send = (page, message) => page.evaluate(data => window.dispatchEvent(new MessageEvent('message', { data })), message);
const settle = page => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
async function mount({ mode = 'dashboard', theme = 'light', width = 1280, height = 900, scale = 1, sidebar = false, data, initial = {} } = {}) {
  const page = await browser.newPage({ viewport: { width: Math.floor(width / scale), height: Math.floor(height / scale) }, deviceScaleFactor: scale, reducedMotion: 'reduce' });
  const errors = [], csp = [], externalRequests = [];
  page.on('pageerror', error => errors.push(String(error)));
  await page.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.hostname !== '127.0.0.1') { externalRequests.push(url.origin); await route.abort(); }
    else await route.fulfill(await assetResponse(url));
  });
  await page.addInitScript(({ mode, initial }) => {
    let saved = { mode, ...initial };
    window.auditRequests = [];
    window.auditCsp = [];
    window.auditGetSavedState = () => saved;
    window.addEventListener('securitypolicyviolation', event => window.auditCsp.push({ directive: event.violatedDirective, blocked: event.blockedURI }));
    window.acquireVsCodeApi = () => ({
      getState: () => saved,
      setState: next => { saved = next; },
      postMessage: message => { window.auditRequests.push(message); }
    });
  }, { mode, initial });
  await page.goto(`http://127.0.0.1:7777/${sidebar ? 'sidebar' : 'dashboard'}.html?theme=${theme}`);
  await page.waitForFunction(() => window.auditRequests?.some(message => message.type === 'ready'));
  if (sidebar) await send(page, { type: 'state', state: data });
  else await send(page, { type: 'snapshot', snapshot: data ?? snapshot(mode) });
  await page.locator(sidebar ? '.quick-actions' : '.app-shell').waitFor(); await settle(page);
  return { page, errors, csp, externalRequests };
}
async function save(view, name) {
  const { page, errors, externalRequests } = view;
  await page.evaluate(() => document.fonts.ready);
  const geometry = await page.evaluate(() => {
    const visible = element => element.checkVisibility({ visibilityProperty: true }) && !element.closest('[inert]');
    const sizes = ['.topbar', '.workbench', '.page', '.statusbar', '.quick-actions', '.repo-section', '.git-workbench', '.git-shell', '.codex-panel'].map(selector => {
      const node = document.querySelector(selector); if (!node) return null;
      const rect = node.getBoundingClientRect();
      return { selector, x: rect.x, y: rect.y, width: rect.width, height: rect.height, clientWidth: node.clientWidth, scrollWidth: node.scrollWidth };
    }).filter(Boolean);
    return {
      viewport: { width: innerWidth, height: innerHeight }, documentWidth: document.documentElement.scrollWidth,
      sizes,
      clippedControls: [...document.querySelectorAll('button,input,select,textarea,summary')].filter(visible).map(element => {
        const rect = element.getBoundingClientRect();
        return { name: element.getAttribute('aria-label') || element.textContent?.trim().slice(0, 70), x: rect.x, right: rect.right, y: rect.y, bottom: rect.bottom };
      }).filter(rect => rect.x < -1 || rect.right > innerWidth + 1),
      unnamedTabPanels: [...document.querySelectorAll('[role="tabpanel"]')].filter(visible).filter(element => !element.hasAttribute('aria-label') && !element.hasAttribute('aria-labelledby')).length,
      tabsWithoutControlledPanel: [...document.querySelectorAll('[role="tab"]')].filter(visible).filter(element => !document.getElementById(element.getAttribute('aria-controls'))).map(element => element.textContent),
      csp: window.auditCsp
    };
  });
  await page.screenshot({ path: path.join(evidence, `${name}.png`), fullPage: false });
  results.push({ name, ...geometry, errors, externalRequests });
  return geometry;
}

// Reuses the preceding audit harness; this run targets the final implementation.
const metrics = [], timings = [];
let exception;
const p95 = values => [...values].sort((a,b) => a-b)[Math.ceil(values.length * .95)-1];
try {
  if (process.env.UX_PERFORMANCE_ONLY !== '1') {
  for (const mode of (process.env.UX_WIKI_ONLY === '1' ? [] : ['codex'])) for (const theme of Object.keys(themes)) for (const width of [240,320,1280]) {
    const view = await mount({mode,theme,width,data:mode==='bmad'?bmadWorkspaceSnapshot():snapshot(mode)});
    try { await save(view, 'initial-'+mode+'-'+theme+'-'+width); }
    finally { await view.page.close(); }
  }
  for (const theme of Object.keys(themes)) for (const width of [240,320,1280]) {
    const view = await mount({mode:'codex',theme,width});
    try {
      const origin = {kind:'project-wiki',accountKey:'account',baseUrl:'https://gitlab.test',projectId:1,projectPath:'team/repo',webUrl:'https://gitlab.test/team/repo',repositoryRoot:'C:/fixture/repo',sourceBranch:'main',sourceSha:'a'.repeat(40)};
      const task = {id:'wiki',title:'Wiki 核對與續載',root:'C:/fixture',status:'completed',createdAt:'2026-11-06T00:00:00Z',updatedAt:'2026-11-06T00:00:00Z',controls:{canResume:true,canDelete:true,canAutoAccept:true},origin,result:{state:'draft',draftId:'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa',summary:'草稿已就緒'}};
      task.progress = {plan:[{step:'核對固定來源與測試證據',status:'completed'},{step:'產生差異與報告',status:'inProgress'}],model:'gpt-test',effort:'high',tokens:{total:1200,input:900,output:300},updatedAt:new Date().toISOString()};
      task.recovery = {execution:'completed',cleanup:'confirmed',publication:'not-published',checkedAt:new Date().toISOString(),message:'已核對程序停止與成果收據'};
      await settle(view.page); await send(view.page,{type:'codexEvent',event:{kind:'tasks',tasks:[task]}}); await settle(view.page);
      for (const status of ['loading','partial','cancelled','ready']) {
        await view.page.locator('.codex-tasks > button').first().focus();
        await view.page.locator('.codex-conversation').evaluate(node => { node.scrollTop = 0; });
        const wiki = {id:task.result.draftId,revision:status,projectPath:origin.projectPath,sourceBranch:'main',sourceSha:origin.sourceSha,pages:[{slug:'codebase/index',title:'Overview',content:'# Overview\n'+('程式架構與使用流程 '.repeat(30)),action:status==='ready'?'create':'unchecked',published:false}],progress:{status,completed:status==='ready'?1:0,total:1,nextCursor:status==='ready'?undefined:'fixture-cursor',reason:status==='cancelled'?'已停止核對，已保存的結果保留。':undefined}};
        await send(view.page,{type:'codexWorkflowResult',taskId:task.id,wiki}); await settle(view.page);
        if (status !== 'loading') {
          const request = (await messages(view.page)).findLast(message => message.type === 'previewProjectWiki');
          if (request?.operationId) await send(view.page,{type:'operationChanged',operation:{requestId:request.operationId,scopeRevision:request.operationScope,resourceKey:'codex:wiki',action:request.type,label:'核對 Wiki',kind:'read',status:'succeeded',effect:'none',phase:'完成',startedAt:1,finishedAt:2}});
          await settle(view.page);
        }
        if (await view.page.locator('.codex-task-details').evaluate(node => node.clientHeight) < 60) throw new Error('Structured progress must not collapse in the conversation');
        if (await view.page.locator('.codex-workflow-result').evaluate(node => node.clientHeight) < 160) throw new Error('Wiki progress must remain readable in a narrow conversation');
        await save(view,'wiki-'+status+'-'+theme+'-'+width);
        await view.page.locator('#codex-follow-up').focus(); await settle(view.page);
        const composerVisible = await view.page.locator('#codex-follow-up').evaluate(node => {
          const rect = node.getBoundingClientRect();
          return document.activeElement === node && rect.top >= 0 && rect.bottom <= innerHeight;
        });
        if (!composerVisible) throw new Error('Keyboard focus must reveal the composer below the Wiki preview');
        results.at(-1).composerFocusVisible = composerVisible;
      }
    } finally { await view.page.close(); }
  }
  }
  const view = await mount({mode:'clone',theme:'dark'});
  try {
    for (let round=0;round<30;round++) {
      const mode=round%2?'clone':'developer';
      timings.push(await view.page.evaluate(async mode=>{
        const button=document.querySelector('.mode-navigation [data-mode="'+mode+'"]');
        const started=performance.now();button.click();
        await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
        if(document.querySelector('.page').dataset.mode!==mode) throw new Error('Navigation did not settle');
        return {kind:'warmNavigation',mode,ms:performance.now()-started};
      },mode));
    }
    await view.page.locator('.mode-navigation [data-mode="clone"]').click();await settle(view.page);
    for(let round=0;round<30;round++) timings.push(await view.page.evaluate(async round=>{
      const input=document.querySelector('.search input'); const started=performance.now();
      input.value=round%2?'alpha':'';input.dispatchEvent(new Event('input',{bubbles:true}));
      const expected = round%2 ? 1 : 3;
      while (document.querySelectorAll('.repo-row').length !== expected) {
        if (performance.now()-started > 5000) throw new Error('Filtered repository rows did not settle');
        await new Promise(requestAnimationFrame);
      }
      await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
      return {kind:'localSearch',ms:performance.now()-started};
    },round));
  } finally {await view.page.close();}
  for(const kind of ['warmNavigation','localSearch']) { const values=timings.filter(row=>row.kind===kind).map(row=>row.ms);metrics.push({kind,samples:values.length,p95Ms:p95(values)}); }
} catch (error) {
  exception = String(error);
  throw error;
} finally {
  const failed=results.filter(row=>row.documentWidth>row.viewport.width+1||row.clippedControls.length||row.errors.length||row.csp.length||row.externalRequests.length);
  await writeFile(path.join(evidence,'ui-verification.json'),JSON.stringify({schema:'GitLabWorkspaceUiVerification/v1',status:exception||failed.length||metrics.some(row=>row.p95Ms>(row.kind==='warmNavigation'?200:100))?'FAIL':'PASS',exception,checkedAt:new Date().toISOString(),browser:browser.version(),bundleSha256:createHash('sha256').update(await readFile(path.join(root,'resources/issue-webview/dashboard.js'))).digest('hex'),scope:'Production Webview, synthetic Host and theme fixtures; excludes native input, VS Code bridge, actual zoom, external service latency and NVDA.',cases:results.length,failures:failed.map(row=>row.name),metrics,timings,results},null,2)+'\n');
  console.log(JSON.stringify({cases:results.length,failures:failed.map(row=>row.name),metrics}));
  if(failed.length||metrics.some(row=>row.p95Ms>(row.kind==='warmNavigation'?200:100))) process.exitCode=1;
  await browser.close();
}
