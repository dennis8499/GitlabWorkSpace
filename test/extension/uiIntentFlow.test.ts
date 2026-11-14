import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import * as vscode from 'vscode';
import { prepareWebviewHtml } from '../../src/webviewSecurity';
import { describeAction } from '../../src/workspace/actionPolicy';
import { HostUiIntents } from '../../src/workspace/hostUiIntents';
import type { UiIntentResult, UiIntentValues } from '../../src/workspace/uiIntentProtocol';
import type { WorkspaceSnapshot } from '../../src/workspace/workspaceProtocol';

const instrumentation = String.raw`(() => {
  let bridge;
  const acquire = window.acquireVsCodeApi;
  window.acquireVsCodeApi = () => bridge ??= acquire();
  const errors = [], violations = [], history = [];
  window.addEventListener('error', event => errors.push(event.message));
  window.addEventListener('unhandledrejection', event => errors.push(String(event.reason)));
  window.addEventListener('securitypolicyviolation', event => violations.push(event.violatedDirective));
  const current = () => document.querySelector('.page[data-mode]')?.dataset.mode;
  const phases = new Map();
  const diagnostics = id => ({ phase: phases.get(id), mode: current(), visibilityState: document.visibilityState,
    documentFocused: document.hasFocus(), errors: [...errors], violations: [...violations] });
  const checkpoint = (request, phase) => {
    phases.set(request.id, phase);
    bridge.postMessage({ type: 'uiIntentProbePhase', id: request.id, ...diagnostics(request.id) });
  };
  const observe = () => {
    const mode = current();
    if (mode && history[history.length - 1] !== mode) history.push(mode);
  };
  new MutationObserver(observe).observe(document.documentElement, { subtree: true, childList: true, attributes: true, attributeFilter: ['data-mode', 'aria-current'] });
  async function wait(check) {
    const deadline = Date.now() + 15000;
    while (!check()) {
      if (Date.now() > deadline) throw new Error('UI intent probe timed out: ' + check.toString() + '; mode=' + current());
      await new Promise(resolve => setTimeout(resolve, 25));
    }
  }
  const painted = () => new Promise(resolve => {
    const timer = setTimeout(resolve, 150);
    requestAnimationFrame(() => requestAnimationFrame(() => { clearTimeout(timer); resolve(); }));
  });
  async function inspect(request) {
    checkpoint(request, 'await-app-shell');
    await wait(() => document.querySelector('.app-shell'));
    checkpoint(request, 'app-shell-ready');
    if (request.action === 'click') {
      const button = document.querySelector('.mode-navigation button[data-mode="' + request.mode + '"]');
      if (!button) throw new Error('Missing navigation mode ' + request.mode);
      button.click();
    }
    checkpoint(request, 'await-mode');
    await wait(() => current() === request.expectedMode);
    checkpoint(request, 'await-paint');
    await painted();
    if (request.action === 'watch') { history.length = 0; observe(); }
    checkpoint(request, 'settling');
    if (request.settleMs) await new Promise(resolve => setTimeout(resolve, request.settleMs));
    observe();
    checkpoint(request, 'complete');
    return { mode: current(), activeNavigation: document.querySelector('.mode-navigation button[aria-current="page"]')?.dataset.mode,
      history: [...history], errors: [...errors], violations: [...violations] };
  }
  window.addEventListener('message', event => {
    if (event.data?.type !== 'uiIntentProbe') return;
    const respond = result => {
      bridge.postMessage({ type: 'uiIntentProbeResult', id: event.data.id, result }); phases.delete(event.data.id);
    };
    inspect(event.data).then(respond,
      error => respond({ error: error.message, ...diagnostics(event.data.id), history: [...history] }));
  });
})();`;

suite('Production Webview UI intent IPC without GitLab credentials', function () {
  this.timeout(120_000);

  test('preserves rapid page clicks across delayed acknowledgements and accepts explicit Host navigation', async () => {
    const extension = vscode.extensions.getExtension('local-dev.gitlab-workspace');
    assert.ok(extension);
    const assetRoot = vscode.Uri.joinPath(extension.extensionUri, 'resources', 'issue-webview');
    const panel = vscode.window.createWebviewPanel('gitlabWorkspace.uiIntentProbe', 'UI intent IPC regression', vscode.ViewColumn.Active,
      { enableScripts: true, localResourceRoots: [assetRoot] });
    const scope = 'ui-intent-ipc-probe', sessionId = 'ui-intent-ipc-host';
    const project = { id: 1, name: 'Probe', path: 'project', path_with_namespace: 'probe/project',
      web_url: 'https://probe.invalid/probe/project', http_url_to_repo: 'https://probe.invalid/probe/project.git' };
    const snapshot: WorkspaceSnapshot = {
      connected: true, baseUrl: 'https://probe.invalid', currentUser: { id: 7, username: 'probe', name: 'Probe' },
      group: { id: 1, name: 'Probe', full_path: 'probe', web_url: 'https://probe.invalid/probe' },
      groups: [], projects: [project], issues: [], mergeRequests: [], groupMilestones: [], groupIssueBoards: [],
      connectedScope: scope, instanceUserScope: scope, operationScope: scope, localOperationScope: scope,
      activeMode: 'developer', projectSource: 'gitlab', mergeRequestFilter: 'all', hostNavigationGeneration: 0,
      groupRepositories: [], groupRepositoryScanStatus: 'idle', localRepositories: {}, projectLocalRepositories: {}, projectMembers: [], timers: [],
      workflowKit: { status: 'missing' }, workflowKitSource: 'github', workflowKitInstallTarget: { manual: false, state: { status: 'missing' } },
      sections: { projects: { status: 'ready', complete: true }, issues: { status: 'ready', complete: true },
        mergeRequests: { status: 'ready', complete: true }, boards: { status: 'ready', complete: true }, milestones: { status: 'ready', complete: true } },
      operationSnapshot: { sessionId, revision: 0, operations: [] }
    };
    const hostIntents = new HostUiIntents();
    const hostValues: UiIntentValues = { mode: 'developer', projectSource: 'gitlab', mergeRequestFilter: 'all', workflowKitSource: 'github' };
    const heldResults: UiIntentResult[] = [], hostErrors: unknown[] = [];
    const pending = new Map<number, (result: any) => void>();
    const probePhases = new Map<number, unknown>();
    let readyCount = 0, sequence = 0, snapshotVersion = 0, operationRevision = 0;
    const post = (message: unknown) => panel.webview.postMessage(message);
    const sendSnapshot = (activeMode: WorkspaceSnapshot['activeMode'], generation = hostIntents.generation) => post({
      type: 'snapshot', streamId: 'ui-intent-ipc-stream', scope, version: ++snapshotVersion,
      snapshot: { ...snapshot, activeMode, hostNavigationGeneration: generation }
    });
    const listener = panel.webview.onDidReceiveMessage((request: any) => {
      if (request.type === 'uiIntentProbePhase') { probePhases.set(request.id, request); return; }
      if (request.type === 'uiIntentProbeResult') { pending.get(request.id)?.(request.result); pending.delete(request.id); return; }
      if (request.type === 'ready') { readyCount++; void sendSnapshot('developer', 0); }
      if (request.type === 'setMode') {
        // The Host commits the actual production intent ticket, but deliberately
        // holds its acknowledgement while unrelated snapshots traverse the IPC.
        try {
          assert.ok(request.uiIntentId?.viewId);
          assert.ok(Number.isSafeInteger(request.uiIntentId.sequence));
          const ticket = hostIntents.register('mode', request);
          void hostIntents.apply(ticket, async current => { if (current()) hostValues.mode = request.mode; }).then(applied => {
            heldResults.push({ type: 'uiIntentResult', uiIntentId: request.uiIntentId, field: 'mode', applied,
              value: hostValues.mode, hostNavigationGeneration: hostIntents.generation });
          }, error => hostErrors.push(error));
        } catch (error) { hostErrors.push(error); }
      }
      if (request.operationId) {
        const policy = describeAction(request);
        void post({ type: 'operationChanged', operation: { ...policy, requestId: request.operationId, correlationId: request.requestId,
          hostSessionId: sessionId, revision: ++operationRevision, scopeRevision: request.operationScope ?? scope,
          status: 'succeeded', effect: 'none', phase: 'Controlled Host result', startedAt: Date.now(), finishedAt: Date.now() } });
      }
    });
    const wait = async (condition: () => boolean, message: string): Promise<void> => {
      const deadline = Date.now() + 20_000;
      while (!condition()) { assert.ok(Date.now() < deadline, message); await new Promise(resolve => setTimeout(resolve, 25)); }
      assert.deepEqual(hostErrors, []);
    };
    const inspect = async (action: 'click' | 'watch' | 'check', expectedMode: string, mode?: string, settleMs = 0): Promise<any> => {
      const id = ++sequence;
      const result = await new Promise<any>((resolve, reject) => {
        const diagnostics = () => JSON.stringify({ probe: probePhases.get(id) ?? { phase: 'await-probe-delivery' },
          panelVisible: panel.visible, panelActive: panel.active, workbenchFocused: vscode.window.state.focused });
        const fail = (error: unknown) => { clearTimeout(timeout); pending.delete(id); probePhases.delete(id); reject(error); };
        const timeout = setTimeout(() => fail(new Error(`No ${action}/${expectedMode} Webview result; ${diagnostics()}`)), 25_000);
        pending.set(id, value => { clearTimeout(timeout); probePhases.delete(id); resolve(value); });
        void post({ type: 'uiIntentProbe', id, action, expectedMode, mode, settleMs }).then(delivered => {
          if (!delivered) fail(new Error(`UI intent ${action}/${expectedMode} probe was not delivered; ${diagnostics()}`));
        }, error => fail(error));
      });
      assert.equal(result.error, undefined, JSON.stringify(result));
      assert.deepEqual(result.errors, []); assert.deepEqual(result.violations, []);
      assert.equal(result.mode, expectedMode); assert.equal(result.activeNavigation, expectedMode);
      return result;
    };
    try {
      const nonce = randomBytes(16).toString('base64');
      panel.webview.html = prepareWebviewHtml(await readFile(vscode.Uri.joinPath(assetRoot, 'dashboard.html').fsPath, 'utf8'),
        panel.webview, assetRoot, 'dashboard', nonce).replace('</head>', `<script nonce="${nonce}">${instrumentation}</script></head>`);
      await wait(() => readyCount > 0, 'the production Webview announces readiness');
      await inspect('check', 'developer');

      await inspect('click', 'reviewer', 'reviewer');
      await wait(() => heldResults.length === 1, 'the Reviewer click reaches the Extension Host before its acknowledgement');
      assert.equal(heldResults[0].value, 'reviewer');
      await inspect('watch', 'reviewer');
      // This is a newer transport snapshot, not an out-of-order stream packet.
      await sendSnapshot('developer', 0);
      const reviewer = await inspect('check', 'reviewer', undefined, 150);
      assert.deepEqual(reviewer.history, ['reviewer'], 'background data cannot roll back an unacknowledged page click');

      await inspect('click', 'sa', 'sa');
      await wait(() => heldResults.length === 2, 'the later Skills click reaches the Extension Host');
      assert.equal(heldResults[1].value, 'sa');
      assert.ok(heldResults[1].uiIntentId.sequence > heldResults[0].uiIntentId.sequence);
      await inspect('watch', 'sa');
      await post(heldResults[0]);
      await sendSnapshot('reviewer', 0);
      const skills = await inspect('check', 'sa', undefined, 150);
      assert.deepEqual(skills.history, ['sa'], 'the earlier Reviewer acknowledgement cannot supersede the latest Skills click');

      const navigation = { ...hostIntents.navigate({ mode: 'dashboard' }), hostSessionId: sessionId };
      await post(navigation);
      await inspect('watch', 'dashboard');
      await post(heldResults[1]);
      await sendSnapshot('sa', 0);
      const explicit = await inspect('check', 'dashboard', undefined, 150);
      assert.deepEqual(explicit.history, ['dashboard'], 'explicit Host navigation wins over delayed acknowledgement and background data');
      assert.deepEqual(hostErrors, []);
      console.log('Native UI intent IPC proof', JSON.stringify({ heldAcknowledgements: heldResults.length,
        reviewerHistory: reviewer.history, skillsHistory: skills.history, hostNavigationGeneration: navigation.generation, explicitHistory: explicit.history }));
    } finally { listener.dispose(); panel.dispose(); }
  });
});
