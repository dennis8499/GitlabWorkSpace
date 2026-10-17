import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import yauzl from 'yauzl';
import { chromium } from 'playwright-core';

// This exercises actual packaged Webview assets against an isolated, fixed mock
// host. It does not run VS Code, an Extension Host, Git, Codex or a GitLab server.
const args = Object.fromEntries(process.argv.slice(2).reduce((pairs, value, index, values) => {
  if (value.startsWith('--')) pairs.push([value.slice(2), values[index + 1]]);
  return pairs;
}, []));
if (!args.artifact || !args.label || !args.output) throw new Error('Usage: node scripts/validate-packaged-ui.mjs --artifact <VSIX> --label baseline|revision --output <directory> [--baseline <JSON>] [--browser <Chrome executable>]');
if (!['baseline', 'revision'].includes(args.label)) throw new Error('label must be baseline or revision');
const feedbackSamples = Number(args['feedback-samples'] ?? 100);
if (!Number.isSafeInteger(feedbackSamples) || feedbackSamples < 1 || feedbackSamples > 10000) throw new Error('feedback-samples must be a positive integer no greater than 10000');
if (args['feedback-only'] !== 'true' && (feedbackSamples < 100 || args['feedback-actions'])) throw new Error('Formal runs require every feedback action and at least 100 samples; use --feedback-only true for diagnostics');
const artifactPath = path.resolve(args.artifact), output = path.resolve(args.output);
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const percentile = (values, fraction = .95) => [...values].sort((a, b) => a - b)[Math.ceil(values.length * fraction) - 1];
const round = value => Number(value.toFixed(3));
const expectedAssets = ['issue-webview/dashboard.html', 'issue-webview/dashboard.js', 'issue-webview/dashboard.css',
  'sidebar-webview/sidebar.html', 'sidebar-webview/sidebar.js', 'sidebar-webview/sidebar.css'];
const actions = { clone: 'openProjects', sa: 'openAnalysis', reviewer: 'openReviewer', git: 'openGit', developer: 'openMyWork' };
const measurement = { rounds: 10, samplesPerRound: 30, repoCount: 20, dashboardWidth: 1440, sidebarWidth: 300, height: 900,
  latency: 'UI postMessage/input capture to matching rendered DOM followed by two requestAnimationFrame callbacks; excludes Playwright input delivery',
  memory: 'Runtime.getHeapUsage after HeapProfiler.collectGarbage at primed, navigation-complete and search-complete checkpoints; parent plus both same-origin Webviews',
  scope: 'VSIX packaged assets + isolated mock host UI; no real GitLab, VS Code Extension Host, Git operations or Codex',
  comparisonLimitPercent: 10,
  firstFeedback: { samplesPerAction: feedbackSamples, limitP95Ms: 100, mockAcknowledgementDelayMs: 160, mockCompletionDelayMs: 220,
    timing: 'DOM click capture before the UI handler to matching selection, disabled control or visible progress followed by one requestAnimationFrame; scripted DOM activation, excludes native input delivery',
    completion: 'Separately measured event-to-mock-host completion. Artificial host delay is not network or Git performance.' } };

function createFixture() {
  const group = { id: 1, name: 'Fixture', full_path: 'fixture/team', web_url: 'https://gitlab.invalid/groups/fixture/team' };
  const projects = Array.from({ length: 20 }, (_, index) => {
    const name = `service-${String(index + 1).padStart(2, '0')}`;
    return { id: index + 1, name, path: name, path_with_namespace: `fixture/team/${name}`, default_branch: 'main',
      web_url: `https://gitlab.invalid/fixture/team/${name}`, http_url_to_repo: `https://gitlab.invalid/fixture/team/${name}.git` };
  });
  const repositories = projects.map(project => ({ id: `repo-${project.id}`, name: project.name, path: `C:/fixture/team/${project.name}`,
    revision: 1, branch: 'main', tracking: 'origin/main', headCommit: 'a'.repeat(40), ahead: 0, behind: 0,
    stagedCount: 0, unstagedCount: 1, conflictCount: 0,
    branches: [{ name: 'main', kind: 'local', current: true, commit: 'a'.repeat(40) },
      { name: 'feature/sample', kind: 'local', current: false, commit: 'b'.repeat(40) },
      { name: 'origin/main', kind: 'remote', current: false, commit: 'a'.repeat(40) }],
    stashes: [], recoveryRefs: [], remotes: ['origin'], changes: [{ path: 'src/fixture.ts', section: 'unstaged', kind: '修改' }], historyHasMore: false,
    history: Array.from({ length: 10 }, (_, index) => ({ hash: (index + 10).toString(16).padStart(40, '0'),
      parents: index === 9 ? [] : [(index + 11).toString(16).padStart(40, '0')], subject: `Fixture commit ${index + 1}`,
      author: 'Fixture User', date: '2026-10-13T00:00:00Z' })), configuredPullStrategy: 'merge' }));
  const features = ['megin-spec-export', 'ingest', 'query', 'functional-exploration', 'lint', 'audit', 'adr',
    'synthesis', 'business-analysis', 'system-analysis', 'system-design', 'notebooklm-export', 'archaeology',
    'megin-workflow', 'megin-resume', 'merge-repo', 'release-review'];
  const installed = { status: 'installed', version: '0.24.1', profile: 'group', source: 'bundled', capabilities: features,
    upstreamVersions: { 'codebase-wiki': '0.6.0', megin: '0.8.0', 'merge-reviewer': '0.12.1', 'release-reviewer': '0.3.0' } };
  const local = Object.fromEntries(projects.map(project => [project.id, { state: 'ready', path: repositories[project.id - 1].path }]));
  const matched = projects.map(project => ({ name: project.name, path: repositories[project.id - 1].path, projectId: project.id, matched: true, defaultBranch: 'main' }));
  return { repositories, snapshot: { connected: true, baseUrl: 'https://gitlab.invalid', currentUser: { id: 7, name: 'Fixture User', username: 'fixture-user' },
    group, groups: [group], projects, activeMode: 'developer', instanceUserScope: 'fixture-instance-user', connectedScope: 'fixture-group',
    groupRoot: 'C:/fixture/team', cloneRoot: 'C:/fixture/team', localRepositories: local, projectLocalRepositories: local,
    localWorkspaceRepositories: repositories.map((repository, index) => ({ name: repository.name, path: repository.path, repositoryId: repository.id, projectIds: [index + 1] })),
    groupRepositories: matched, groupRepositoryScanStatus: 'ready', groupMilestones: [], groupIssueBoards: [],
    issues: projects.map(project => ({ id: 100 + project.id, iid: 1, project_id: project.id, title: `Review ${project.name}`, state: 'opened', labels: ['fixture'],
      description: 'Fixed, isolated UI fixture.', web_url: `${project.web_url}/-/issues/1`, assignees: [{ id: 7, name: 'Fixture User', username: 'fixture-user' }] })),
    mergeRequests: projects.map(project => ({ id: 200 + project.id, iid: 1, project_id: project.id, title: `Change ${project.name}`, state: 'opened',
      source_branch: 'feature/sample', target_branch: 'main', sha: 'b'.repeat(40), author: { id: 7, name: 'Fixture User', username: 'fixture-user' },
      reviewers: [{ id: 7, name: 'Fixture User', username: 'fixture-user' }], assignees: [], web_url: `${project.web_url}/-/merge_requests/1` })),
    projectMembers: [], timers: [], timerVersion: 0, deliveryRecords: [], meginWorkItems: [],
    operationScope: 'fixture-operation-scope', scopeEpoch: 1,
    workflowKit: installed, workflowKitInstallTarget: { root: 'C:/fixture/team', profile: 'group', manual: false, state: installed },
    workflowKitPackages: [{ id: 'bundled-0.24.0', version: '0.24.0', source: 'bundled', assetName: 'workflow-kit.tar.xz', format: 'tar.xz', entryRoot: 'workflow-kit', available: true }],
    workflowKitSource: 'bundled', workflowKitPolicy: { allowed: true, requireGroupEnvironment: true, mode: 'group', settingTarget: 'workspace' },
    skillsContext: { mode: 'group', root: 'C:/fixture/team', revision: 'fixture-revision', installed, availableFeatures: features, resumeOnly: false,
      groupMatch: { status: 'matched', root: 'C:/fixture/team', repositories: matched }, repositories: matched },
    accounts: [], tools: [], busy: false } };
}
const fixture = createFixture();
const hostTheme = `:root { --vscode-font-family: 'Segoe UI', sans-serif; --vscode-font-size: 13px; --vscode-editor-font-family: Consolas, monospace;
 --vscode-foreground:#cccccc; --vscode-editor-background:#1e1e1e; --vscode-sideBar-background:#252526; --vscode-editorWidget-background:#252526;
 --vscode-panel-border:#454545; --vscode-widget-border:#454545; --vscode-focusBorder:#007fd4; --vscode-descriptionForeground:#aaaaaa;
 --vscode-button-background:#0e639c; --vscode-button-foreground:#ffffff; --vscode-button-hoverBackground:#1177bb;
 --vscode-button-secondaryBackground:#3a3d41; --vscode-button-secondaryForeground:#ffffff; --vscode-button-secondaryHoverBackground:#45494e;
 --vscode-input-background:#3c3c3c; --vscode-input-foreground:#cccccc; --vscode-input-border:#454545;
 --vscode-dropdown-background:#3c3c3c; --vscode-dropdown-foreground:#cccccc; --vscode-dropdown-border:#454545;
 --vscode-list-hoverBackground:#2a2d2e; --vscode-list-activeSelectionBackground:#094771; --vscode-list-activeSelectionForeground:#ffffff;
 --vscode-textLink-foreground:#3794ff; --vscode-errorForeground:#f48771; --vscode-editorWarning-foreground:#cca700;
 --vscode-badge-background:#4d4d4d; --vscode-badge-foreground:#ffffff; }
 body { font-family:var(--vscode-font-family); font-size:13px; }
 body.vscode-high-contrast { --vscode-foreground:#ffffff; --vscode-editor-background:#000000; --vscode-sideBar-background:#000000;
 --vscode-editorWidget-background:#000000; --vscode-panel-border:#ffffff; --vscode-widget-border:#ffffff; --vscode-focusBorder:#f38518;
 --vscode-input-background:#000000; --vscode-input-foreground:#ffffff; --vscode-input-border:#ffffff; --vscode-descriptionForeground:#ffffff; }`;

async function extractAssets(temp) {
  const files = {};
  await new Promise((resolve, reject) => yauzl.open(artifactPath, { lazyEntries: true }, (error, zip) => {
    if (error) return reject(error);
    zip.on('error', reject); zip.on('end', resolve);
    zip.on('entry', entry => {
      const key = entry.fileName.replace(/^extension\/resources\//, '');
      if (!expectedAssets.includes(key)) { zip.readEntry(); return; }
      zip.openReadStream(entry, (error, stream) => {
        if (error) return reject(error);
        const chunks = []; stream.on('data', chunk => chunks.push(chunk)); stream.on('error', reject);
        stream.on('end', () => { files[key] = Buffer.concat(chunks); zip.readEntry(); });
      });
    }); zip.readEntry();
  }));
  for (const key of expectedAssets) {
    assert.ok(files[key], `Missing packaged asset ${key}`);
    const target = path.join(temp, key); await mkdir(path.dirname(target), { recursive: true }); await writeFile(target, files[key]);
  }
  return files;
}

// Serialized by Playwright into the parent fixture page. Child Webviews execute
// only their packaged JS; this function substitutes the extension-side bridge.
function installHost(data) {
  const { fixture, actions } = data;
  const host = window.__host = { fixture, activeMode: 'developer', requests: [], stored: {}, navigation: undefined, search: undefined, unexpected: [],
    sessionId: 'packaged-ui-host', revision: 0, operations: new Map(), pendingTasks: new Set(), acknowledgementDelayMs: 0, completionDelayMs: 0, completed: 0 };
  const frameWindow = name => document.getElementById(name)?.contentWindow;
  const send = (name, data) => frameWindow(name)?.dispatchEvent(new MessageEvent('message', { data }));
  const operationSnapshot = requestedIds => ({ sessionId: host.sessionId, revision: host.revision, operations: [...host.operations.values()],
    ...(requestedIds ? { requestedIds, missingIds: requestedIds.filter(id => !host.operations.has(id)) } : {}) });
  const sidebarState = () => ({ connected: true, groupLabel: fixture.snapshot.group.full_path, activeMode: host.activeMode,
    gitAvailable: true, accounts: [], repositories: fixture.repositories, selectedRepositoryId: fixture.repositories[0].id,
    operationScope: fixture.snapshot.operationScope, scopeEpoch: fixture.snapshot.scopeEpoch, operationSnapshot: operationSnapshot() });
  host.publish = () => { send('dashboard', { type: 'snapshot', snapshot: { ...fixture.snapshot, activeMode: host.activeMode,
    operations: [...host.operations.values()], operationSnapshot: operationSnapshot() } }); send('sidebar', { type: 'state', state: sidebarState() }); };
  const publishOperation = operation => {
    operation = { ...operation, hostSessionId: host.sessionId, revision: ++host.revision };
    host.operations.set(operation.requestId, operation);
    for (const surface of ['dashboard', 'sidebar']) send(surface, { type: 'operationChanged', operation });
    const finished = [...host.operations.values()].filter(value => value.finishedAt !== undefined);
    for (const entry of finished.slice(0, Math.max(0, finished.length - 30))) host.operations.delete(entry.requestId);
  };
  host.navigate = (mode, started = performance.now()) => {
    host.navigation = { mode, started }; host.activeMode = mode; host.publish();
  };
  const perform = (surface, message, receivedAt) => {
    if (surface === 'sidebar' && message.type === 'perform') {
      const mode = Object.keys(actions).find(mode => actions[mode] === message.action);
      if (mode) host.navigate(mode, receivedAt);
      else if (message.action === 'openWorkspace') host.navigate(host.activeMode, receivedAt);
      else if (message.action === 'openRepository') host.navigate('git', receivedAt);
      else if (message.action === 'manageAccounts' || message.action === 'addAccount') send('dashboard', { type: 'openAccountManager', intent: { id: `intent-${host.completed}`, startLogin: message.action === 'addAccount' } });
      else if (message.action === 'openNotifications') send('dashboard', { type: 'openNotifications' });
      else host.unexpected.push(message);
    } else if (surface === 'sidebar' && message.type === 'repositoryDetails') {
      const repository = fixture.repositories.find(repo => repo.id === message.repositoryId);
      send('sidebar', { type: 'repositoryDetails', repositoryId: message.repositoryId, requestId: message.requestId,
        details: { id: repository.id, revision: repository.revision, branches: repository.branches, stashes: repository.stashes, recoveryRefs: repository.recoveryRefs } });
    } else if (message.type === 'setMode') host.navigate(message.mode, receivedAt);
    else if (message.type === 'selectIssue') {
      const issue = fixture.snapshot.issues.find(value => value.project_id === message.projectId && value.iid === message.issueIid);
      fixture.snapshot.selectedIssue = { issue, project: fixture.snapshot.projects.find(project => project.id === message.projectId) };
      fixture.snapshot.issuePreview = { status: 'ready', projectId: message.projectId, issueIid: message.issueIid };
      host.publish();
    } else if (message.type === 'selectMergeRequest' || message.type === 'refreshMergeRequest') {
      const request = fixture.snapshot.mergeRequests.find(value => value.project_id === message.projectId && value.iid === message.iid);
      fixture.snapshot.selectedMergeRequest = { request, diffs: [], discussions: [], warnings: [], sections: { diffs: { status: 'ready' }, discussions: { status: 'ready' } },
        freshness: { state: 'current', sourceSha: 'b'.repeat(40), targetSha: 'a'.repeat(40), checkedAt: 1 }, sourceSha: 'b'.repeat(40), targetSha: 'a'.repeat(40) };
      host.publish();
    } else if (message.type === 'refresh' || message.type === 'refreshWorkflowKit') host.publish();
    else if (message.type === 'submitAccountLogin') send('dashboard', { type: 'accountLoginResult', requestId: message.requestId, error: '固定測試：未連線外部 GitLab。' });
    else if (message.type === 'openAccountManager' || message.type === 'addAccount') send('dashboard', { type: 'openAccountManager', intent: { id: `intent-${host.completed}`, startLogin: message.type === 'addAccount' } });
    else if (message.type === 'gitAction') {
      const repository = fixture.repositories.find(repo => repo.id === message.repoId) ?? fixture.repositories[0];
      send('dashboard', { type: 'gitSnapshot', requestId: message.requestId, snapshot: repository });
      send('dashboard', { type: 'gitActionResult', requestId: message.requestId, write: !['open', 'refresh', 'readCommit', 'readDiff', 'history'].includes(message.action.type), effect: 'none' });
    }
  };
  host.receive = (surface, message) => {
    const receivedAt = performance.now();
    host.requests.push({ surface, type: message.type, action: message.action?.type ?? message.action, operationId: message.operationId });
    if (message.type === 'ready') { host.publish(); send(surface, { type: 'operationsSnapshot', snapshot: operationSnapshot() }); return; }
    if (message.type === 'reconcileOperations') { send(surface, { type: 'operationsSnapshot', snapshot: operationSnapshot(message.pendingIds) }); return; }
    if (message.type === 'gitReady') { send('dashboard', { type: 'gitRepositories', available: true, revision: 1, repositories: fixture.repositories }); return; }
    if (message.type === 'issueRequest' && message.request?.type === 'ready') return;
    if (['gitAcknowledgeResult', 'setLogVisibility', 'setIssueGraphVisibility', 'cancelRepositoryDetails', 'markNotificationsRead', 'markAllNotificationsRead'].includes(message.type)) return;
    if (message.type === 'setMode') { perform(surface, message, receivedAt); return; }
    const action = message.type === 'perform' ? message.action : message.type;
    const write = message.type === 'submitAccountLogin' || message.type === 'gitAction' && !['open', 'refresh', 'readCommit', 'readDiff', 'history'].includes(message.action.type);
    const resourceKey = message.type === 'gitAction' ? `git:${message.repoId}`
      : message.type === 'repositoryDetails' ? `git:${message.repositoryId}:details`
      : message.type === 'submitAccountLogin' ? 'connection'
      : message.type === 'refreshWorkflowKit' ? 'skills'
      : message.type === 'selectIssue' ? `issue:${message.projectId}:${message.issueIid}`
      : message.type === 'selectMergeRequest' || message.type === 'refreshMergeRequest' ? `mr:${message.projectId}:${message.iid}`
      : action;
    const operation = { requestId: message.operationId ?? `mock-${++host.completed}`, scopeRevision: message.operationScope ?? fixture.snapshot.operationScope,
      resourceKey, action,
      correlationId: message.requestId, label: action, phase: '模擬 Host 處理中…', status: 'running', startedAt: Date.now(), kind: write ? 'write' : 'read', effect: 'none' };
    if (host.probe && !host.probe.operationId) host.probe.operationId = operation.requestId;
    const task = new Promise(resolve => {
      const acknowledge = () => {
        publishOperation(operation);
        if (surface === 'sidebar' && message.type === 'perform') send(surface, { type: 'state', state: { ...sidebarState(), busyAction: message.action } });
        if (message.type === 'refresh') send('dashboard', { type: 'busy', value: true, label: '模擬 Host 更新中…' });
        if (message.type === 'refreshWorkflowKit') { fixture.snapshot.workflowKit.status = 'checking'; host.publish(); }
      };
      const complete = () => {
        if (message.type === 'refreshWorkflowKit') fixture.snapshot.workflowKit.status = 'installed';
        perform(surface, message, receivedAt);
        publishOperation({ ...operation, status: message.type === 'submitAccountLogin' ? 'failed' : 'succeeded',
          phase: message.type === 'submitAccountLogin' ? '固定測試：驗證失敗' : '已完成',
          ...(message.type === 'submitAccountLogin' ? { error: '固定測試：未連線外部 GitLab。' } : {}), finishedAt: Date.now() });
        if (message.type === 'refresh') send('dashboard', { type: 'busy', value: false });
        if (surface === 'sidebar' && message.type === 'perform') send(surface, { type: 'state', state: sidebarState() });
        host.completed++; host.lastCompletedAt = performance.now();
        if (host.probe?.operationId === operation.requestId) host.probe.completedAt = performance.now();
        resolve();
      };
      if (host.acknowledgementDelayMs) setTimeout(acknowledge, host.acknowledgementDelayMs); else acknowledge();
      if (host.completionDelayMs) setTimeout(complete, host.completionDelayMs); else complete();
    });
    host.pendingTasks.add(task); void task.finally(() => host.pendingTasks.delete(task));
  };
  host.idle = async () => { while (host.pendingTasks.size) await Promise.all([...host.pendingTasks]); };
  host.waitFor = async (kind, expected) => {
    const start = performance.now();
    for (;;) {
      const state = host[kind];
      const doc = frameWindow(kind === 'navigation' ? 'dashboard' : 'sidebar')?.document;
      const ready = kind === 'navigation' ? state?.mode === expected && doc?.querySelector('.page')?.dataset.mode === expected
        : state?.query === expected && doc?.querySelectorAll('.repo-link').length === fixture.repositories.filter(repo =>
          `${repo.name} ${repo.path} ${repo.branch ?? ''}`.toLocaleLowerCase().includes(expected.trim().toLocaleLowerCase())).length;
      if (ready) { await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))); return performance.now() - state.started; }
      if (performance.now() - start > 5000) throw new Error(`Timed out awaiting ${kind} ${expected}`);
      await new Promise(resolve => requestAnimationFrame(resolve));
    }
  };
}

async function mount(browser, files, width = 1440, highContrast = false) {
  const context = await browser.newContext({ viewport: { width: width + 300, height: 900 }, reducedMotion: 'reduce' });
  const page = await context.newPage(); page.setDefaultTimeout(8000);
  const network = [], errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', async route => {
    const url = new URL(route.request().url()); const key = url.pathname.slice(1);
    if (url.origin === 'https://packaged-ui.test' && key === '') {
      await route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><body style="margin:0;display:flex;height:900px"><iframe id="sidebar" title="sidebar" style="border:0;width:300px;height:900px;flex:none"></iframe><iframe id="dashboard" title="dashboard" style="border:0;flex:none;height:900px"></iframe></body></html>' });
    } else if (url.origin === 'https://packaged-ui.test' && files[key]) {
      let body = files[key];
      if (key.endsWith('.html')) {
        const surface = key.startsWith('sidebar') ? 'sidebar' : 'dashboard';
        const bridge = `<style>${hostTheme}</style><script>window.acquireVsCodeApi=()=>({postMessage:message=>parent.__host.receive('${surface}',message),getState:()=>parent.__host.stored['${surface}']??{mode:'developer'},setState:value=>{parent.__host.stored['${surface}']=value;}});document.addEventListener('input',event=>{if(event.target.matches('.repo-search input'))parent.__host.search={query:event.target.value,started:parent.performance.now()};},true);</script>`;
        body = body.toString().replace('<head>', `<head>${bridge}`).replace('<body>', `<body class="${highContrast ? 'vscode-high-contrast' : 'vscode-dark'}">`);
      }
      await route.fulfill({ contentType: key.endsWith('.js') ? 'text/javascript' : key.endsWith('.css') ? 'text/css' : 'text/html', body });
    } else { network.push(route.request().url()); await route.abort('blockedbyclient'); }
  });
  await page.goto('https://packaged-ui.test/'); await page.evaluate(installHost, { fixture, actions });
  await page.evaluate(width => { const dashboard = document.getElementById('dashboard'); dashboard.style.width = `${width}px`;
    dashboard.src = '/issue-webview/dashboard.html'; document.getElementById('sidebar').src = '/sidebar-webview/sidebar.html'; }, width);
  const dashboard = page.frameLocator('#dashboard'), sidebar = page.frameLocator('#sidebar');
  await dashboard.locator('.app-shell').waitFor(); await sidebar.locator('.repo-link').first().waitFor();
  const cdp = await context.newCDPSession(page);
  return { context, page, dashboard, sidebar, cdp, network, errors };
}
async function navigate(view, mode) {
  await view.sidebar.locator('.workspace-shortcuts button').nth(['developer', 'clone', 'sa', 'reviewer', 'git'].indexOf(mode)).click();
  return view.page.evaluate(mode => window.__host.waitFor('navigation', mode), mode);
}
async function heap(view, checkpoint) {
  await view.cdp.send('HeapProfiler.collectGarbage');
  const value = await view.cdp.send('Runtime.getHeapUsage');
  return { checkpoint, usedSize: value.usedSize, totalSize: value.totalSize,
    embedderHeapUsedSize: value.embedderHeapUsedSize ?? null, backingStorageSize: value.backingStorageSize ?? null };
}

async function benchmark(browser, files) {
  const rounds = [];
  for (let index = 0; index < measurement.rounds; index++) {
    const view = await mount(browser, files);
    try {
      for (const mode of Object.keys(actions)) await navigate(view, mode);
      const memory = [await heap(view, 'primed')], warm = [], search = [];
      for (let sample = 0; sample < measurement.samplesPerRound; sample++) warm.push(round(await navigate(view, Object.keys(actions)[sample % 5])));
      memory.push(await heap(view, 'after-navigation'));
      const queries = ['service-01', 'service-1', 'missing', 'fixture/team/service-20', 'main', ''];
      for (let sample = 0; sample < measurement.samplesPerRound; sample++) {
        const query = queries[sample % queries.length];
        await view.sidebar.locator('.repo-search input').fill(query);
        search.push(round(await view.page.evaluate(query => window.__host.waitFor('search', query), query)));
      }
      memory.push(await heap(view, 'after-search'));
      const requests = await view.page.evaluate(() => ({ count: window.__host.requests.length, unexpected: window.__host.unexpected }));
      assert.equal(view.errors.length, 0, view.errors.join('; ')); assert.equal(view.network.length, 0, 'Unexpected requests were blocked');
      rounds.push({ round: index + 1, warmNavigationMs: { samples: warm, p95: round(percentile(warm)) },
        repoSearchMs: { samples: search, p95: round(percentile(search)) }, rendererHeap: memory, mockedRequests: requests,
        blockedNetworkRequests: view.network, runtimeErrors: view.errors });
      console.log(`${args.label} round ${index + 1}/10: navigation p95=${round(percentile(warm))}ms search p95=${round(percentile(search))}ms renderer retained=${Math.max(...memory.map(value => value.usedSize))} bytes`);
    } finally { await view.context.close(); }
  }
  return rounds;
}

async function firstFeedbackBenchmark(browser, files) {
  const cases = [
    { name: 'navigation', mode: 'developer', surface: 'sidebar' },
    { name: 'issue-selection', mode: 'developer', surface: 'dashboard' },
    { name: 'mr-selection', mode: 'reviewer', surface: 'dashboard' },
    { name: 'refresh', mode: 'developer', surface: 'dashboard' },
    { name: 'skills-check', mode: 'sa', surface: 'dashboard' },
    { name: 'account-submit', mode: 'developer', surface: 'dashboard' },
    { name: 'git-read', mode: 'git', surface: 'dashboard' },
    { name: 'git-write', mode: 'git', surface: 'dashboard' }
  ].filter(entry => !args['feedback-actions'] || args['feedback-actions'].split(',').includes(entry.name));
  const results = [];
  for (const entry of cases) {
    const view = await mount(browser, files), samples = [];
    let error;
    try {
      await navigate(view, entry.mode);
      await view.page.evaluate(() => window.__host.idle());
      if (entry.name === 'skills-check' || entry.name === 'account-submit') {
        await view.dashboard.locator('.settings-trigger').click();
      }
      if (entry.name === 'account-submit') {
        await view.dashboard.locator('#settings-tab-accounts').click();
        await view.dashboard.locator('.accounts-heading button').click();
        await view.dashboard.locator('.account-login input[name="baseUrl"]').fill('https://gitlab.invalid');
        await view.dashboard.locator('.account-login button[type="submit"]').click();
        await view.dashboard.locator('.account-login input[name="token"]').waitFor();
      }
      if (entry.name === 'git-read' || entry.name === 'git-write') {
        await view.dashboard.locator('.git-refresh').waitFor({ state: 'visible' });
        await view.dashboard.locator('.git-refresh').waitFor();
      }
      await view.page.evaluate(delays => {
        window.__host.acknowledgementDelayMs = delays.mockAcknowledgementDelayMs;
        window.__host.completionDelayMs = delays.mockCompletionDelayMs;
      }, measurement.firstFeedback);
      for (let index = 0; index < measurement.firstFeedback.samplesPerAction; index++) {
        if (entry.name === 'account-submit') await view.dashboard.locator('.account-login input[name="token"]').fill('fixed-isolated-ui-fixture-token');
        const sample = await view.page.evaluate(async ({ entry, index }) => {
          const host = window.__host;
          await host.idle();
          const doc = document.getElementById(entry.surface).contentDocument;
          const dashboard = document.getElementById('dashboard').contentDocument;
          const visible = element => {
            if (!element || !element.getClientRects().length) return false;
            const rect = element.getBoundingClientRect();
            if (rect.width <= 0 || rect.height <= 0) return false;
            const style = element.ownerDocument.defaultView.getComputedStyle(element);
            if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) return false;
            const target = element.ownerDocument.elementFromPoint(Math.max(0, Math.min(innerWidth - 1, rect.left + rect.width / 2)),
              Math.max(0, Math.min(innerHeight - 1, rect.top + rect.height / 2)));
            return !!target && (element.contains(target) || target.contains(element));
          };
          const textButton = (root, text) => [...root.querySelectorAll('button')].find(button => button.textContent.trim() === text);
          let target, destination;
          if (entry.name === 'navigation') {
            destination = ['clone', 'sa', 'reviewer', 'git', 'developer'][index % 5];
            target = [...doc.querySelectorAll('.workspace-shortcuts button')][['developer', 'clone', 'sa', 'reviewer', 'git'].indexOf(destination)];
          } else if (entry.name === 'issue-selection' || entry.name === 'mr-selection') {
            target = [...doc.querySelectorAll('.work-list .work-row')].find(row => !row.classList.contains('selected'));
          } else if (entry.name === 'refresh') target = textButton(doc.querySelector('.heading-actions'), '更新資料');
          else if (entry.name === 'skills-check') target = textButton(doc.querySelector('.tool-drawer'), '重新檢查安裝');
          else if (entry.name === 'account-submit') target = doc.querySelector('.account-login button[type="submit"]');
          else if (entry.name === 'git-read') target = doc.querySelector('.git-refresh');
          else if (entry.name === 'git-write') target = doc.querySelector('button[aria-label="暫存 src/fixture.ts"]');
          target?.scrollIntoView({ block: 'center' });
          if (!target || target.disabled || !visible(target)) throw new Error(`No enabled visible control for ${entry.name}, sample ${index + 1}`);
          const probe = host.probe = { started: 0, operationId: undefined, completedAt: undefined };
          doc.addEventListener('click', () => { probe.started = performance.now(); }, { capture: true, once: true });
          target.click();
          if (!probe.started) throw new Error(`No click captured for ${entry.name}`);
          const progress = () => [...doc.querySelectorAll('.operation-status.queued, .operation-status.running, .action-message, .git-status-message .spinner, .account-login [role="status"]')]
            .some(element => visible(element) && (element.matches('.spinner') || !!element.textContent.trim()));
          const ready = () => {
            if (target.disabled || target.getAttribute('aria-busy') === 'true') return true;
            if (entry.name === 'navigation' && dashboard.querySelector('.page')?.dataset.mode === destination) return true;
            if ((entry.name === 'issue-selection' || entry.name === 'mr-selection') && target.classList.contains('selected')) return true;
            if (entry.name === 'skills-check' && [...doc.querySelectorAll('.tool-drawer [role="status"], .tool-drawer .tool-card .pill')].some(element => visible(element) && /檢查中|正在/.test(element.textContent))) return true;
            return progress();
          };
          while (!ready()) {
            if (performance.now() - probe.started > 2000) throw new Error(`No visible feedback for ${entry.name}, sample ${index + 1}`);
            await new Promise(resolve => requestAnimationFrame(resolve));
          }
          await new Promise(resolve => requestAnimationFrame(resolve));
          const firstFeedbackMs = performance.now() - probe.started;
          await host.idle();
          if (!probe.operationId || probe.completedAt === undefined) throw new Error(`No matching mock-host completion for ${entry.name}; requests=${JSON.stringify(host.requests.slice(-4))}; probe=${JSON.stringify(probe)}`);
          const mockCompletionMs = probe.completedAt - probe.started;
          host.probe = undefined;
          await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
          return { firstFeedbackMs, mockCompletionMs };
        }, { entry, index });
        samples.push({ firstFeedbackMs: round(sample.firstFeedbackMs), mockCompletionMs: round(sample.mockCompletionMs) });
      }
      assert.equal(view.errors.length, 0, view.errors.join('; '));
      assert.equal(view.network.length, 0, 'First-feedback probe must not contact external services');
    } catch (failure) { error = failure.message; }
    finally { await view.context.close(); }
    const firstFeedbackP95Ms = samples.length ? round(percentile(samples.map(sample => sample.firstFeedbackMs))) : null;
    const result = { action: entry.name, status: error ? 'ERROR' : firstFeedbackP95Ms <= measurement.firstFeedback.limitP95Ms ? 'PASS' : 'FAIL',
      sampleCount: samples.length, requiredSamples: measurement.firstFeedback.samplesPerAction, firstFeedbackP95Ms,
      mockCompletionP95Ms: samples.length ? round(percentile(samples.map(sample => sample.mockCompletionMs))) : null,
      samples, ...(error ? { error } : {}), blockedNetworkRequests: view.network, runtimeErrors: view.errors };
    results.push(result);
    console.log(`${args.label} first feedback ${entry.name}: ${result.status}, ${samples.length} samples, p95=${firstFeedbackP95Ms}ms${error ? ` (${error})` : ''}`);
  }
  return { status: results.every(result => result.status === 'PASS') ? 'PASS' : 'FAIL', cases: results,
    scope: 'Actual packaged UI handlers, isolated delayed mock host. Writes and login use fixed fake responses and do not change repositories or contact GitLab.' };
}

async function smoke(browser, files) {
  const checks = [], screenshots = [], blockedNetworkRequests = [], runtimeErrors = [];
  const check = async (name, operation) => { try { const detail = await operation(); checks.push({ name, status: 'PASS', detail: detail ?? null }); }
    catch (error) { checks.push({ name, status: 'FAIL', error: error.message }); } };
  const shot = async (view, name) => { const filename = `${args.label}-${name}.png`; await view.dashboard.locator('body').screenshot({ path: path.join(output, filename) }); screenshots.push(filename); };
  const desktop = await mount(browser, files);
  try {
    await navigate(desktop, 'sa'); await shot(desktop, '1440-skills');
    await check('1440x900 Skills tools keyboard navigation', async () => {
      const tab=desktop.dashboard.locator('#skill-tool-codebase-wiki');
      if (await tab.count()) {
        await tab.click(); await tab.focus(); await tab.press('ArrowRight');
        assert.equal(await desktop.dashboard.locator('#skill-tool-megin').getAttribute('aria-selected'),'true');
      } else {
        const select=desktop.dashboard.locator('select[aria-label="Skills 工具"]'); await select.selectOption('codebase-wiki'); await select.focus();
        await select.press('ArrowDown'); await select.press('Enter'); assert.equal(await select.inputValue(),'megin');
      }
    });
    await check('settings keyboard focus remains in dialog and Escape restores trigger', async () => {
      await desktop.dashboard.locator('.settings-trigger').click(); const dialog = desktop.dashboard.locator('.tool-drawer'); await dialog.waitFor();
      for (let index = 0; index < 20; index++) { await desktop.page.keyboard.press('Tab');
        assert.ok(await dialog.evaluate(element => element.contains(element.ownerDocument.activeElement)), `focus escaped after Tab ${index + 1}`); }
      await shot(desktop, '1440-settings'); await desktop.page.keyboard.press('Escape'); await dialog.waitFor({ state: 'detached' });
      await desktop.page.waitForFunction(() => document.getElementById('dashboard').contentDocument.activeElement?.classList.contains('settings-trigger'));
      assert.ok(await desktop.dashboard.locator('.settings-trigger').evaluate(element => element === element.ownerDocument.activeElement));
    });
    await check('sidebar disclosure supports keyboard and fixed local branch details', async () => {
      const disclosure = desktop.sidebar.locator('.repo-disclosure').first(); await disclosure.focus(); await disclosure.press('Enter');
      await desktop.sidebar.locator('.repo-details').first().locator('.ref-link').filter({ hasText: 'feature/sample' }).waitFor();
      assert.equal(await disclosure.getAttribute('aria-expanded'), 'true'); await disclosure.press('Enter'); assert.equal(await disclosure.getAttribute('aria-expanded'), 'false');
    });
    await check('1440x900 packaged UI has no horizontal body overflow', async () => assert.ok(await desktop.dashboard.locator('body').evaluate(element => element.scrollWidth <= element.clientWidth)));
  } finally { blockedNetworkRequests.push(...desktop.network); runtimeErrors.push(...desktop.errors); await desktop.context.close(); }
  for (const highContrast of [false, true]) {
    const view = await mount(browser, files, 800, highContrast);
    try {
      await check(`800x900${highContrast ? ' high contrast' : ''} preview survives refresh and projects remain visible after sidebar navigation`, async () => {
        await view.dashboard.locator('.mobile-switch').click();
        await view.page.evaluate(() => window.__host.publish());
        assert.equal(await view.dashboard.locator('.workbench').getAttribute('data-mobile-panel'), 'detail');
        await navigate(view, 'clone');
        assert.equal(await view.dashboard.locator('.workbench').getAttribute('data-mobile-panel'), 'list');
        assert.ok(await view.dashboard.locator('.clone-submit').isVisible());
      });
      await shot(view, highContrast ? '800-highcontrast-projects' : '800-projects');
      await navigate(view, 'sa'); await shot(view, highContrast ? '800-highcontrast-skills' : '800-skills');
      await check(`800x900${highContrast ? ' high contrast' : ''} Skills controls fit and retain keyboard focus`, async () => {
        assert.ok(await view.dashboard.locator('body').evaluate(element => element.scrollWidth <= element.clientWidth));
        const selector = view.dashboard.locator('#skill-tool-codebase-wiki, select[aria-label="Skills 工具"]'); await selector.focus();
        assert.ok(await selector.evaluate(element => element === element.ownerDocument.activeElement));
      });
    } finally { blockedNetworkRequests.push(...view.network); runtimeErrors.push(...view.errors); await view.context.close(); }
  }
  return { status: checks.some(check => check.status === 'FAIL') || blockedNetworkRequests.length || runtimeErrors.length ? 'FAIL' : 'PASS', checks, screenshots, blockedNetworkRequests, runtimeErrors,
    limits: 'Automated layout/keyboard checks and screenshot capture; screenshots still require human visual review. High contrast emulates VS Code body class and theme tokens, not OS assistive technology.' };
}

function collect(rounds) {
  return { warmNavigationP95Ms: round(percentile(rounds.flatMap(value => value.warmNavigationMs.samples))),
    repoSearchP95Ms: round(percentile(rounds.flatMap(value => value.repoSearchMs.samples))),
    rendererRetainedHeapP95Bytes: percentile(rounds.flatMap(value => value.rendererHeap.map(sample => sample.usedSize))),
    rendererRetainedHeapMaxBytes: Math.max(...rounds.flatMap(value => value.rendererHeap.map(sample => sample.usedSize))) };
}
function compare(current, baseline) {
  const identity = current.fixtureSha256 === baseline.fixtureSha256 && current.harnessSha256 === baseline.harnessSha256 &&
    current.browserVersion === baseline.browserVersion && JSON.stringify(current.measurement) === JSON.stringify(baseline.measurement) &&
    current.artifact.sha256 !== baseline.artifact.sha256;
  const complete = result => result.rounds?.length === 10 && result.rounds.every(value => value.warmNavigationMs.samples.length === 30 && value.repoSearchMs.samples.length === 30)
    && result.firstFeedback?.cases.length === 8 && result.firstFeedback.cases.every(value => value.sampleCount >= 100 && value.sampleCount === result.measurement.firstFeedback.samplesPerAction);
  if (!identity || !complete(current) || !complete(baseline)) return { status: 'BLOCKED', reason: 'Comparison requires distinct artifacts, identical harness/fixture/browser/method and complete 10 × 30 samples.' };
  const metrics = Object.fromEntries(Object.entries(current.metrics).map(([name, value]) => {
    const old = baseline.metrics[name], change = round((value / old - 1) * 100);
    return [name, { baseline: old, revision: value, increasePercent: change, limitPercent: 10, status: change <= 10 ? 'PASS' : 'FAIL' }];
  }));
  return { status: Object.values(metrics).some(value => value.status === 'FAIL') ? 'FAIL' : 'PASS', metrics,
    note: 'Observed comparison only. Frame scheduling, GC, machine load and instrumentation add noise; a threshold failure is reported as measured and must not be rewritten as a pass.' };
}

await mkdir(output, { recursive: true });
const temp = await mkdtemp(path.join(os.tmpdir(), 'glw-packaged-ui-'));
let browser;
try {
  const files = await extractAssets(temp);
  browser = await chromium.launch({ headless: true, executablePath: args.browser ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe',
    args: ['--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows'] });
  const result = { schema: 'GitLabWorkspacePackagedUiVerification/v2', label: args.label, capturedAt: new Date().toISOString(),
    artifact: { path: artifactPath, sha256: sha256(await readFile(artifactPath)) },
    assets: expectedAssets.map(name => ({ name, sha256: sha256(files[name]), bytes: files[name].length })),
    harnessSha256: sha256(await readFile(fileURLToPath(import.meta.url))), fixtureSha256: sha256(JSON.stringify(fixture)),
    browserVersion: browser.version(), platform: { platform: process.platform, arch: process.arch, node: process.version }, measurement };
  if (args['feedback-only'] !== 'true') {
    result.rounds = await benchmark(browser, files); result.metrics = collect(result.rounds);
    await writeFile(path.join(output, `${args.label}.json`), JSON.stringify({ ...result, performanceStatus: 'RUNNING' }, null, 2) + '\n');
  }
  result.firstFeedback = await firstFeedbackBenchmark(browser, files);
  result.smoke = args['feedback-only'] === 'true' ? { status: 'NOT_RUN', reason: 'Diagnostic feedback-only run.' } : await smoke(browser, files);
  result.performanceStatus = 'MEASURED';
  if (args.baseline) result.comparison = compare(result, JSON.parse(await readFile(args.baseline, 'utf8')));
  await writeFile(path.join(output, `${args.label}.json`), JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify({ label: result.label, metrics: result.metrics, firstFeedback: { status: result.firstFeedback.status,
    cases: result.firstFeedback.cases.map(({ samples, ...summary }) => summary) }, smoke: result.smoke.status, comparison: result.comparison ?? null }, null, 2));
  if (args.label === 'revision' && (result.firstFeedback.status !== 'PASS' || result.smoke.status === 'FAIL' || result.comparison && result.comparison.status !== 'PASS')) process.exitCode = 1;
} finally {
  await browser?.close();
  assert.ok(path.resolve(temp).startsWith(path.resolve(os.tmpdir()) + path.sep), 'Temporary cleanup must stay inside the system temp directory');
  await rm(temp, { recursive: true, force: true });
}
