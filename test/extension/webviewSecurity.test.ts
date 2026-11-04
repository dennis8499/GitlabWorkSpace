import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import * as vscode from 'vscode';
import { prepareWebviewHtml } from '../../src/webviewSecurity';
import { describeAction } from '../../src/workspace/actionPolicy';
import type { WorkspaceSnapshot } from '../../src/workspace/workspaceProtocol';
import type { GitRepositorySnapshot } from '../../src/git/gitProtocol';

const instrumentation = String.raw`(() => {
  let bridge;
  const acquire = window.acquireVsCodeApi;
  window.acquireVsCodeApi = () => bridge ??= acquire();
  const contextId = String(Date.now()) + Math.random();
  const violations = [], errors = [];
  let workers = 0, positions = 0;
  window.addEventListener('securitypolicyviolation', event => violations.push(event.violatedDirective));
  window.addEventListener('error', event => errors.push(event.message));
  const NativeWorker = window.Worker;
  window.Worker = class extends NativeWorker {
    constructor(...args) {
      super(...args); workers++;
      this.addEventListener('message', event => {
        if (event.data?.positions?.length && [...event.data.positions].every(Number.isFinite)) positions = event.data.positions.length;
      });
      this.addEventListener('error', event => errors.push(event.message));
    }
  };
  async function wait(check) {
    const deadline = Date.now() + 15000;
    while (!check()) {
      if (Date.now() > deadline) throw new Error('Webview probe timed out: ' + check.toString());
      await new Promise(resolve => setTimeout(resolve, 25));
    }
  }
  async function inspect(action) {
    await wait(() => document.querySelector('.app-shell'));
    const result = { contextId, errors, violations };
    if (action === 'list') {
      await wait(() => { const row = document.querySelector('.virtual-list-row'); return row && getComputedStyle(row).position === 'absolute'; });
      const row = document.querySelector('.virtual-list-row');
      return { ...result, position: getComputedStyle(row).position, height: parseFloat(getComputedStyle(row.parentElement).height), rows: document.querySelectorAll('.work-row').length };
    }
    if (action === 'git') {
      await wait(() => document.querySelector('.git-ref-dot'));
      const root = document.querySelector('.git-workbench'), handle = document.querySelector('.git-left-resizer');
      const width = () => parseFloat(getComputedStyle(root).getPropertyValue('--git-left-width'));
      const before = width();
      handle.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: 300, pointerId: 1 }));
      window.dispatchEvent(new PointerEvent('pointermove', { clientX: 340, pointerId: 1 }));
      window.dispatchEvent(new PointerEvent('pointerup', { clientX: 340, pointerId: 1 }));
      await wait(() => width() !== before);
      return { ...result, before, after: width(), color: getComputedStyle(document.querySelector('.git-ref-dot')).backgroundColor,
        spacerHeight: parseFloat(getComputedStyle(document.querySelector('.git-list-spacer')).height) };
    }
    if (action === 'graph') {
      await wait(() => document.querySelector('.developer-view-switch'));
      if (!document.querySelector('.issue-graph-canvas')) document.querySelectorAll('.developer-view-switch button')[1].click();
      await wait(() => document.querySelector('.issue-graph-canvas') && positions === 4000);
      return { ...result, workers, positions, color: getComputedStyle(document.querySelector('.graph-legend-item i')).backgroundColor };
    }
    if (action === 'markdown') {
      await wait(() => document.querySelector('#security-markdown-probe'));
      const node = document.querySelector('#security-markdown-probe');
      return { ...result, text: node.textContent, styleAttribute: node.hasAttribute('style'), handler: node.hasAttribute('onmouseover'), styleTags: document.querySelectorAll('.markdown style').length };
    }
    if (action === 'injection') {
      const before = violations.length;
      const node = document.createElement('div'); node.id = 'security-injection';
      node.setAttribute('style', 'font-size:123px'); document.body.append(node);
      const sheet = document.createElement('style'); sheet.textContent = '#security-injection { position:fixed; }'; document.head.append(sheet);
      await wait(() => violations.length >= before + 2);
      const blocked = getComputedStyle(node).fontSize !== '123px' && getComputedStyle(node).position !== 'fixed';
      node.remove(); sheet.remove(); return { ...result, blocked };
    }
    return result;
  }
  window.addEventListener('message', event => {
    if (event.data?.type !== 'securityProbe') return;
    inspect(event.data.action).then(result => bridge.postMessage({ type: 'securityProbeResult', id: event.data.id, result }),
      error => bridge.postMessage({ type: 'securityProbeResult', id: event.data.id, result: { error: error.message, errors, violations } }));
  });
})();`;

suite('Production Webview CSP without GitLab credentials', function () {
  this.timeout(120_000);
  test('preserves dynamic layouts, native Workers and restoration while blocking injected styles', async () => {
    const extension = vscode.extensions.getExtension('local-dev.gitlab-workspace');
    assert.ok(extension);
    const assetRoot = vscode.Uri.joinPath(extension.extensionUri, 'resources', 'issue-webview');
    const panel = vscode.window.createWebviewPanel('gitlabWorkspace.securityProbe', 'Webview security regression', vscode.ViewColumn.Active,
      { enableScripts: true, localResourceRoots: [assetRoot] });
    const user = { id: 7, username: 'probe', name: 'Probe' };
    const project = { id: 1, name: 'Probe', path: 'project', path_with_namespace: 'probe/project',
      web_url: 'https://probe.invalid/probe/project', http_url_to_repo: 'https://probe.invalid/probe/project.git' };
    const issues = Array.from({ length: 2000 }, (_, i) => ({ id: i + 1, iid: i + 1, project_id: 1, title: `Probe issue ${i + 1}`,
      description: 'Markdown probe', state: 'opened', web_url: `${project.web_url}/-/issues/${i + 1}`, assignees: [user], labels: [] }));
    const scope = 'security-probe';
    const snapshot: WorkspaceSnapshot = {
      connected: true, baseUrl: 'https://probe.invalid', currentUser: user,
      group: { id: 1, name: 'Probe', full_path: 'probe', web_url: 'https://probe.invalid/probe' }, groups: [], projects: [project],
      connectedScope: scope, instanceUserScope: scope, operationScope: scope, localOperationScope: scope, activeMode: 'developer',
      groupRepositories: [], groupRepositoryScanStatus: 'idle', groupMilestones: [],
      groupIssueBoards: [{ id: 31, name: 'Probe board', hide_backlog_list: false, hide_closed_list: false }],
      localRepositories: {}, projectLocalRepositories: {}, issues, mergeRequests: [], projectMembers: [], timers: [],
      workflowKit: { status: 'missing' }, workflowKitSource: 'github', workflowKitInstallTarget: { manual: false, state: { status: 'missing' } },
      sections: { projects: { status: 'ready' }, issues: { status: 'ready', complete: true }, graph: { status: 'ready' },
        boards: { status: 'ready', complete: true }, milestones: { status: 'ready', complete: true } },
      issueGraph: { connectedScope: scope, status: 'ready', roots: issues.map(issue => `project:1:issue:${issue.iid}`),
        nodes: issues.map(issue => ({ id: `project:1:issue:${issue.iid}`, sourceIds: [`rest:${issue.id}`], kind: 'issue', namespacePath: 'probe/project',
          projectId: 1, projectPath: 'probe/project', iid: String(issue.iid), title: issue.title, state: 'opened', webUrl: issue.web_url,
          labels: [], assignees: [user], boardIds: [31], assignedToMe: true, isRoot: true })),
        edges: [], boardIssueIds: {}, boardStatus: {}, errors: [], updatedAt: Date.now() }, issueGraphVersion: 1
    };
    const head = 'a'.repeat(40);
    const git: GitRepositorySnapshot = { id: 'c'.repeat(32), name: 'Probe', path: 'C:/probe', branch: 'main', headCommit: head,
      stagedCount: 0, unstagedCount: 0, conflictCount: 0, revision: 1, branches: [{ name: 'main', kind: 'local', current: true, commit: head }],
      stashes: [], recoveryRefs: [], remotes: [], changes: [], historyHasMore: false,
      history: Array.from({ length: 200 }, (_, i) => ({ hash: i ? i.toString(16).padStart(40, '0') : head,
        parents: i < 199 ? [(i + 1).toString(16).padStart(40, '0')] : [], subject: `Commit ${i}`, author: 'Probe', date: '2026-01-01T00:00:00Z' })) };
    let readyCount = 0, sequence = 0;
    const pending = new Map<number, (result: any) => void>();
    const post = (message: unknown) => panel.webview.postMessage(message);
    const listener = panel.webview.onDidReceiveMessage((request: any) => {
      if (request.type === 'securityProbeResult') { pending.get(request.id)?.(request.result); pending.delete(request.id); return; }
      if (request.type === 'ready') { readyCount++; void post({ type: 'snapshot', snapshot }); }
      if (request.type === 'loadIssueGraph') void post({ type: 'issueGraphChanged', connectedScope: scope, version: 2, graph: snapshot.issueGraph });
      if (request.type === 'gitReady') void post({ type: 'gitRepositories', available: true, revision: 1, repositories: [git] });
      if (request.type === 'gitAction') { void post({ type: 'gitSnapshot', snapshot: git, requestId: request.requestId });
        void post({ type: 'gitActionResult', requestId: request.requestId, write: false, effect: 'none' }); }
      if (request.type === 'issueRequest' && request.request.type === 'ready') void post({ type: 'issueResponse', revision: 1,
        response: { type: 'detailData', data: { issue: issues[0], project, projects: [project], user,
          options: { members: [], labels: [], milestones: [], templates: [], warnings: [] }, discussions: [], links: [], mergeRequests: [],
          reactions: [], noteReactions: {}, todos: [], tasks: [], timelogs: [], startDate: null, warnings: [] } } });
      if (request.type === 'issueRequest' && request.request.type === 'preview') void post({ type: 'issueResponse', revision: 1,
        response: { type: 'reply', requestId: request.request.requestId, result: { html: '<style>body{position:fixed}</style><span id="security-markdown-probe" style="position:fixed" onmouseover="alert(1)">safe Markdown</span>' } } });
      if (request.operationId) {
        const policy = describeAction(request);
        void post({ type: 'operationChanged', operation: { ...policy, requestId: request.operationId, correlationId: request.requestId,
          scopeRevision: scope, status: 'succeeded', phase: 'Mock result', startedAt: Date.now(), finishedAt: Date.now() } });
      }
    });
    const inspect = async (action: string): Promise<any> => {
      const id = ++sequence;
      const result = await new Promise<any>((resolve, reject) => {
        const timeout = setTimeout(() => { pending.delete(id); reject(new Error(`No ${action} Webview result`)); }, 25_000);
        pending.set(id, value => { clearTimeout(timeout); resolve(value); });
        void post({ type: 'securityProbe', id, action });
      });
      assert.equal(result.error, undefined, JSON.stringify(result));
      assert.deepEqual(result.errors, []);
      return result;
    };
    const wait = async (condition: () => boolean): Promise<void> => {
      const deadline = Date.now() + 20_000;
      while (!condition()) { assert.ok(Date.now() < deadline, 'the Webview changes visibility or announces readiness'); await new Promise(resolve => setTimeout(resolve, 50)); }
    };
    try {
      const nonce = randomBytes(16).toString('base64');
      panel.webview.html = prepareWebviewHtml(await readFile(vscode.Uri.joinPath(assetRoot, 'dashboard.html').fsPath, 'utf8'),
        panel.webview, assetRoot, 'dashboard', nonce).replace('</head>', `<script nonce="${nonce}">${instrumentation}</script></head>`);
      await wait(() => readyCount > 0);
      const list = await inspect('list'); assert.equal(list.position, 'absolute'); assert.ok(list.height > 1000); assert.ok(list.rows < issues.length);
      snapshot.activeMode = 'git'; await post({ type: 'snapshot', snapshot });
      const layout = await inspect('git'); assert.equal(layout.after, layout.before + 40); assert.ok(layout.spacerHeight > 0);
      assert.ok(layout.color !== 'rgba(0, 0, 0, 0)'); assert.deepEqual(layout.violations, []);
      snapshot.activeMode = 'developer'; await post({ type: 'snapshot', snapshot });
      const graph = await inspect('graph'); assert.ok(graph.workers > 0); assert.equal(graph.positions, 4000); assert.deepEqual(graph.violations, []);
      assert.ok(graph.color !== 'rgba(0, 0, 0, 0)');
      const readyBeforeHide = readyCount;
      await vscode.commands.executeCommand('workbench.action.files.newUntitledFile'); await wait(() => !panel.visible);
      await new Promise(resolve => setTimeout(resolve, 500)); panel.reveal(vscode.ViewColumn.Active);
      await wait(() => readyCount > readyBeforeHide);
      const restored = await inspect('graph'); assert.notEqual(restored.contextId, graph.contextId); assert.equal(restored.positions, 4000);
      await post({ type: 'issueNavigation', navigation: { mode: 'detail', projectId: 1, issueIid: 1, revision: 1 } });
      const markdown = await inspect('markdown'); assert.equal(markdown.text, 'safe Markdown');
      assert.equal(markdown.styleAttribute, false); assert.equal(markdown.handler, false); assert.equal(markdown.styleTags, 0);
      // Chromium can report rejected styles while DOMPurify parses hostile input
      // in an inert document. None survive sanitization or change the live UI.
      assert.ok(markdown.violations.every((value: string) => value.startsWith('style-src')));
      const injection = await inspect('injection'); assert.equal(injection.blocked, true);
      assert.ok(injection.violations.every((value: string) => value.startsWith('style-src')));
      console.log('Native CSP proof', JSON.stringify({ listRows: list.rows, virtualHeight: list.height,
        resizedFrom: layout.before, resizedTo: layout.after, workerPositions: graph.positions,
        restoredContext: restored.contextId !== graph.contextId, markdownStylesRemoved: !markdown.styleAttribute && !markdown.styleTags,
        injectedStylesBlocked: injection.blocked }));
    } finally { listener.dispose(); panel.dispose(); }
  });
});
