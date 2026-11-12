import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { readFile, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import * as vscode from 'vscode';
import { prepareWebviewHtml } from '../../src/webviewSecurity';
import { CodexUiDraftStore } from '../../src/codex/uiDraftStore';
import { parseCodexUiDraftKey, sanitizeCodexUiDraftValue } from '../../src/codex/uiDraftProtocol';
import type { CodexTaskState } from '../../src/codex/protocol';
import type { WorkspaceSnapshot } from '../../src/workspace/workspaceProtocol';

const instrumentation = String.raw`(() => {
  let bridge;
  const acquire = window.acquireVsCodeApi;
  window.acquireVsCodeApi = () => bridge ??= acquire();
  const errors = [], violations = [];
  window.addEventListener('error', event => errors.push(event.message));
  window.addEventListener('unhandledrejection', event => errors.push(String(event.reason)));
  window.addEventListener('securitypolicyviolation', event => violations.push(event.violatedDirective));
  async function wait(check, label) {
    const deadline = Date.now() + 12000;
    while (!check()) {
      if (Date.now() > deadline) throw new Error('Native zoom probe timed out: ' + label);
      await new Promise(resolve => setTimeout(resolve, 25));
    }
  }
  const painted = () => new Promise(resolve => {
    const timer = setTimeout(resolve, 150);
    requestAnimationFrame(() => requestAnimationFrame(() => { clearTimeout(timer); resolve(); }));
  });
  async function focus(node) {
    node.scrollIntoView({ behavior: 'instant', block: 'center', inline: 'nearest' }); node.focus({ preventScroll: true });
    let previous, stable = 0; const deadline = Date.now() + 3000;
    while (stable < 5) {
      await painted(); const rect = node.getBoundingClientRect(), scroll = [];
      for (let parent = node.parentElement; parent; parent = parent.parentElement) scroll.push(parent.scrollTop, parent.scrollLeft);
      const signature = JSON.stringify([rect.x, rect.y, rect.width, rect.height, scrollX, scrollY, ...scroll]);
      stable = signature === previous ? stable + 1 : 0; previous = signature;
      if (Date.now() > deadline) throw new Error('Focused control geometry did not settle');
    }
    const rect = node.getBoundingClientRect(), style = getComputedStyle(node);
    const hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
    const ancestors = [];
    for (let parent = node.parentElement; parent && ancestors.length < 8; parent = parent.parentElement) {
      const rect = parent.getBoundingClientRect(), style = getComputedStyle(parent);
      ancestors.push({ tag: parent.tagName, className: parent.className, y: rect.y, height: rect.height, scrollTop: parent.scrollTop,
        clientHeight: parent.clientHeight, scrollHeight: parent.scrollHeight, overflowY: style.overflowY, position: style.position });
    }
    return { focused: document.activeElement === node, documentFocused: document.hasFocus(), connected: node.isConnected,
      activeElement: document.activeElement ? { tag: document.activeElement.tagName, id: document.activeElement.id } : null,
      visible: rect.width > 0 && rect.height > 0 && rect.top >= -1 && rect.bottom <= innerHeight + 1 &&
      rect.left >= -1 && rect.right <= innerWidth + 1 && !!hit && (hit === node || node.contains(hit)),
      focusVisible: node.matches(':focus-visible'), outlineWidth: parseFloat(style.outlineWidth), outlineStyle: style.outlineStyle,
      outlineColor: style.outlineColor, id: node.id || node.textContent, rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
      hit: hit ? { tag: hit.tagName, className: hit.className, text: hit.textContent.slice(0, 100) } : null, ancestors };
  }
  async function inspect(request) {
    await wait(() => document.querySelector('#codex-follow-up') && document.querySelector('.codex-interaction pre'), 'Codex task and approval');
    await wait(() => document.body.classList.contains(request.themeClass), 'native body theme');
    if (request.expectedDpr) await wait(() => Math.abs(devicePixelRatio / request.expectedDpr - 1) < .02, 'Electron devicePixelRatio');
    await wait(() => document.hasFocus(), 'native Webview has received Workbench focus');
    const textarea = document.querySelector('#codex-follow-up'), detail = document.querySelector('.codex-interaction pre');
    if (request.seed) { textarea.value = request.draft; textarea.dispatchEvent(new Event('input', { bubbles: true })); }
    await wait(() => textarea.value === request.draft && bridge.getState()?.codexUi?.drafts?.['native-zoom-task']?.text === request.draft, 'durable textarea draft');
    const approval = document.querySelector('.codex-interaction button[type="submit"]');
    const inputFocus = await focus(textarea), approvalFocus = await focus(approval);
    const bounds = detail.getBoundingClientRect(), actions = approval.parentElement.getBoundingClientRect();
    const overflow = Math.max(0, document.documentElement.scrollWidth - document.documentElement.clientWidth,
      document.body.scrollWidth - document.body.clientWidth, ...['.app-shell', '.codex-workspace', '.codex-conversation', '.codex-attention'].map(selector => {
        const node = document.querySelector(selector); return node ? node.scrollWidth - node.clientWidth : 0;
      }));
    return { dpr: devicePixelRatio, width: innerWidth, height: innerHeight, bodyClasses: document.body.className,
      themeId: document.body.dataset.vscodeThemeId, themeKind: document.body.dataset.vscodeThemeKind,
      draft: textarea.value, savedDraft: bridge.getState()?.codexUi?.drafts?.['native-zoom-task']?.text,
      detailPreserved: detail.textContent === request.detail, detailHeight: bounds.height, detailScrollHeight: detail.scrollHeight,
      detailClientHeight: detail.clientHeight, controlsOverlap: Math.max(0, bounds.bottom - actions.top), overflow,
      inputFocus, approvalFocus, errors: [...errors], violations: [...violations] };
  }
  window.addEventListener('message', event => {
    if (event.data?.type !== 'nativeCodexZoomProbe') return;
    inspect(event.data).then(result => bridge.postMessage({ type: 'nativeCodexZoomResult', id: event.data.id, result }),
      error => bridge.postMessage({ type: 'nativeCodexZoomResult', id: event.data.id, result: { error: error.message, errors, violations } }));
  });
})();`;

suite('Native Codex Electron zoom and built-in themes', function () {
  this.timeout(180_000);
  test('preserves the draft and accessible long approval across all 12 native zoom/theme cases', async function () {
    // Global settings are changed only inside the test runner's disposable profile.
    if (!process.env.GITLAB_WORKSPACE_TEST_TMP) { this.skip(); return; }
    assert.ok(path.basename(process.env.GITLAB_WORKSPACE_TEST_TMP).startsWith('gitlab-workspace-host-tests-'));
    const profile = await realpath(process.env.GITLAB_WORKSPACE_TEST_TMP);
    for (const name of ['user-data', 'logs']) {
      const relative = path.relative(profile, await realpath(path.join(profile, name)));
      assert.ok(relative && !path.isAbsolute(relative) && relative !== '..' && !relative.startsWith('..' + path.sep), 'profile paths cannot escape the isolated runner');
    }
    assert.equal(await realpath(vscode.workspace.workspaceFile!.fsPath), await realpath(path.join(profile, 'host.code-workspace')));
    const windowConfig = vscode.workspace.getConfiguration('window'), workbenchConfig = vscode.workspace.getConfiguration('workbench');
    const priorZoom = windowConfig.inspect<number>('zoomLevel')?.globalValue;
    const priorTheme = workbenchConfig.inspect<string>('colorTheme')?.globalValue;
    const priorDetect = windowConfig.inspect<boolean>('autoDetectColorScheme')?.globalValue;
    const priorContrast = windowConfig.inspect<boolean>('autoDetectHighContrast')?.globalValue;
    const extension = vscode.extensions.getExtension('local-dev.gitlab-workspace'); assert.ok(extension);
    const nativeThemes = vscode.extensions.getExtension('vscode.theme-defaults')?.packageJSON.contributes?.themes as
      Array<{ id: string; path: string }> | undefined;
    assert.ok(Array.isArray(nativeThemes), 'the selected VS Code installation provides its built-in themes');
    const themeCases = [['dark_plus.json', 'vscode-dark'], ['light_plus.json', 'vscode-light'],
      ['hc_black.json', 'vscode-high-contrast'], ['hc_light.json', 'vscode-high-contrast-light']].map(([filename, themeClass]) => {
      const theme = nativeThemes.find(item => item.path.replaceAll('\\', '/').endsWith('/' + filename));
      assert.ok(theme?.id, `built-in theme is available: ${filename}`);
      return [theme.id, themeClass] as const;
    });
    let assets = vscode.Uri.joinPath(extension.extensionUri, 'resources', 'issue-webview');
    if (process.env.GITLAB_WORKSPACE_ZOOM_ASSET_ROOT) {
      const temporary = await realpath(path.join(extension.extensionUri.fsPath, '.tmp'));
      const target = await realpath(process.env.GITLAB_WORKSPACE_ZOOM_ASSET_ROOT);
      const relative = path.relative(temporary, target);
      assert.ok(relative && !path.isAbsolute(relative) && relative !== '..' && !relative.startsWith('..' + path.sep), 'pilot assets must stay inside the repository temporary directory');
      assets = vscode.Uri.file(target);
    }
    const panel = vscode.window.createWebviewPanel('gitlabWorkspace.nativeCodexZoom', 'Native Codex zoom regression', vscode.ViewColumn.Active,
      { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [assets] });
    const scope = 'native-codex-zoom', draft = '跨 zoom／主題保留的補充需求：請驗證結果，尚未送出。';
    const detail = Array.from({ length: 48 }, (_, index) => `Approval line ${index + 1}: ${'核對長命令與檔案範圍 '.repeat(4)}`).join('\n');
    const task: CodexTaskState = { id: 'native-zoom-task', title: 'Native zoom · waiting for approval', root: 'C:/offline/zoom-fixture',
      status: 'waiting', threadId: 'offline-thread', turnId: 'offline-turn', createdAt: '2026-11-10T00:00:00Z', updatedAt: '2026-11-10T00:00:00Z',
      progress: { phase: 'executing', waitReason: 'approval' }, controls: { external: false, canPause: true, canResume: false,
        canDelete: false, canAutoAccept: true, autoAccept: false } };
    const snapshot: WorkspaceSnapshot = { connected: true, baseUrl: 'https://offline.invalid',
      currentUser: { id: 7, username: 'fixture', name: 'Fixture' }, groups: [], projects: [], issues: [], mergeRequests: [],
      groupMilestones: [], groupIssueBoards: [], connectedScope: scope, instanceUserScope: scope, operationScope: scope, localOperationScope: scope,
      activeMode: 'codex', codexWorkspaceLayout: 'workspace', groupRepositories: [], groupRepositoryScanStatus: 'idle', localRepositories: {},
      projectLocalRepositories: {}, projectMembers: [], timers: [], workflowKit: { status: 'missing' }, workflowKitSource: 'github',
      workflowKitInstallTarget: { manual: false, state: { status: 'missing' } },
      operationSnapshot: { sessionId: scope, revision: 0, operations: [] } };
    let ready = false, sequence = 0;
    const pending = new Map<number, (result: any) => void>(), unexpectedWrites: string[] = [];
    const draftStore = new CodexUiDraftStore(path.join(profile, 'native-zoom-drafts')), draftScope = createHash('sha256').update(scope).digest('hex');
    const persistence = new Set<Promise<void>>(), persistenceErrors: string[] = [];
    const post = (value: unknown) => panel.webview.postMessage(value);
    const publishTask = async () => {
      await post({ type: 'codexEvent', event: { kind: 'tasks', tasks: [task] } });
      await post({ type: 'codexEvent', event: { kind: 'interactions', taskId: task.id,
        interactions: [{ id: 'native-approval', taskId: task.id, kind: 'command', title: '核對完整命令', detail }] } });
    };
    const listener = panel.webview.onDidReceiveMessage((request: any) => {
      if (request.type === 'nativeCodexZoomResult') { pending.get(request.id)?.(request.result); pending.delete(request.id); return; }
      if (request.type === 'ready') { ready = true; void post({ type: 'snapshot', snapshot }); }
      if (request.type === 'listCodexTasks') void publishTask();
      if (request.type === 'loadCodexUiDrafts' || request.type === 'saveCodexUiDrafts') {
        const job = (async () => {
          try {
            if (request.type === 'saveCodexUiDrafts') assert.equal(request.scope, draftScope);
            const saved = request.type === 'loadCodexUiDrafts' ? await draftStore.read(draftScope) : await draftStore.save(draftScope, request.updates.map((update: any) => ({
              ...update, value: sanitizeCodexUiDraftValue(update.key, update.value, parseCodexUiDraftKey(update.key)[0] === 'interaction' ? new Set<string>() : undefined)
            })), request.resolveConflictIds);
            await post({ type: 'codexUiDrafts', requestId: request.requestId, snapshot: saved });
          } catch (error) { persistenceErrors.push(String(error)); await post({ type: 'codexUiDrafts', requestId: request.requestId, error: String(error) }); }
        })();
        persistence.add(job); void job.finally(() => persistence.delete(job));
      }
      if (request.type === 'codexHistory') void post({ type: 'codexEvent', event: { kind: 'history', taskId: task.id, items: [], reset: true } });
      if (['sendCodexMessage', 'answerCodex', 'createCodexTask', 'resumeCodexTask'].includes(request.type)) unexpectedWrites.push(request.type);
    });
    const wait = async (check: () => boolean, label: string) => {
      const deadline = Date.now() + 15_000;
      while (!check()) { assert.ok(Date.now() < deadline, label); await new Promise(resolve => setTimeout(resolve, 25)); }
    };
    const inspect = async (themeClass: string, expectedDpr?: number, seed = false): Promise<any> => {
      panel.reveal(vscode.ViewColumn.Active); await wait(() => panel.visible, 'native panel must be visible');
      await vscode.commands.executeCommand('workbench.action.focusActiveEditorGroup');
      const id = ++sequence;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { pending.delete(id); reject(new Error('No native Codex zoom result')); }, 20_000);
        pending.set(id, value => { clearTimeout(timer); resolve(value); });
        void post({ type: 'nativeCodexZoomProbe', id, themeClass, expectedDpr, seed, draft, detail }).then(delivered => {
          if (!delivered) { clearTimeout(timer); pending.delete(id); reject(new Error('Native zoom probe was not delivered')); }
        }, error => { clearTimeout(timer); pending.delete(id); reject(error); });
      });
    };
    const cases: Array<Record<string, unknown>> = [];
    try {
      await windowConfig.update('autoDetectColorScheme', false, vscode.ConfigurationTarget.Global);
      await windowConfig.update('autoDetectHighContrast', false, vscode.ConfigurationTarget.Global);
      await windowConfig.update('zoomLevel', 0, vscode.ConfigurationTarget.Global);
      await workbenchConfig.update('colorTheme', themeCases[0][0], vscode.ConfigurationTarget.Global);
      const nonce = randomBytes(16).toString('base64');
      panel.webview.html = prepareWebviewHtml(await readFile(vscode.Uri.joinPath(assets, 'dashboard.html').fsPath, 'utf8'), panel.webview, assets, 'dashboard', nonce)
        .replace('</head>', `<script nonce="${nonce}">${instrumentation}</script></head>`);
      await wait(() => ready, 'production bundle readiness');
      const baseline = await inspect('vscode-dark', undefined, true); assert.equal(baseline.error, undefined, JSON.stringify(baseline));
      assert.ok(Number.isFinite(baseline.dpr) && baseline.dpr > 0);
      for (const [theme, themeClass] of themeCases) {
        await workbenchConfig.update('colorTheme', theme, vscode.ConfigurationTarget.Global);
        for (const scale of [1, 1.25, 2]) {
          await windowConfig.update('zoomLevel', Math.log(scale) / Math.log(1.2), vscode.ConfigurationTarget.Global);
          let result = await inspect(themeClass, baseline.dpr * scale);
          const label = `${theme} at ${scale * 100}%`;
          if (result.width < 320) {
            // Only this disposable Workbench profile is adjusted; content CSS is untouched.
            for (const command of ['workbench.action.closeSidebar', 'workbench.action.closeAuxiliaryBar', 'workbench.action.closePanel']) await vscode.commands.executeCommand(command);
            result = { ...await inspect(themeClass, baseline.dpr * scale), optionalSidebarsClosed: true };
          }
          assert.equal(result.error, undefined, JSON.stringify({ label, result }));
          assert.ok(result.width >= 320, `${label}: native editor viewport must be at least 320 CSS pixels`);
          assert.ok(Math.abs(result.dpr / baseline.dpr - scale) < .03, `${label}: actual Electron zoom must change DPR`);
          assert.equal(result.draft, draft); assert.equal(result.savedDraft, draft); assert.equal(result.detailPreserved, true);
          assert.ok(result.detailHeight > 360 && result.detailScrollHeight <= result.detailClientHeight + 2, `${label}: approval text remains expanded`);
          assert.ok(result.controlsOverlap <= 1 && result.overflow <= 2, `${label}: no text/control overlap or horizontal overflow: ${JSON.stringify(result)}`);
          for (const focus of [result.inputFocus, result.approvalFocus]) {
            assert.ok(focus.focused && focus.visible && focus.focusVisible && focus.outlineWidth >= 1 && focus.outlineStyle !== 'none', `${label} at ${result.width}x${result.height}: focused control is visible: ${JSON.stringify(focus)}`);
          }
          assert.deepEqual(result.errors, []); assert.deepEqual(result.violations, []);
          cases.push({ theme, scale, ...result });
        }
      }
      await Promise.all([...persistence]);
      assert.equal(cases.length, 12); assert.deepEqual(unexpectedWrites, []); assert.deepEqual(persistenceErrors, []);
      const assetHashes = Object.fromEntries(await Promise.all(['dashboard.html', 'dashboard.js', 'dashboard.css', 'codicon.ttf'].map(async name =>
        [name, createHash('sha256').update(await readFile(vscode.Uri.joinPath(assets, name).fsPath)).digest('hex')])));
      const evidence = { schema: 'GitLabWorkspaceNativeCodexZoom/v1', executedCases: cases.length, baselineDpr: baseline.dpr, assetHashes,
        method: 'VS Code window.zoomLevel, verified by Webview DPR ratio; native viewport, no CSS scaling or theme injection', cases };
      console.log('Native Codex zoom proof', JSON.stringify(evidence));
      if (process.env.GITLAB_WORKSPACE_VALIDATION_DIR) await writeFile(path.join(process.env.GITLAB_WORKSPACE_VALIDATION_DIR, 'native-codex-zoom.json'), JSON.stringify(evidence, null, 2));
    } finally {
      listener.dispose(); panel.dispose();
      const restored = await Promise.allSettled([
        windowConfig.update('zoomLevel', priorZoom, vscode.ConfigurationTarget.Global),
        workbenchConfig.update('colorTheme', priorTheme, vscode.ConfigurationTarget.Global),
        windowConfig.update('autoDetectColorScheme', priorDetect, vscode.ConfigurationTarget.Global),
        windowConfig.update('autoDetectHighContrast', priorContrast, vscode.ConfigurationTarget.Global)
      ]);
      assert.ok(restored.every(result => result.status === 'fulfilled'), 'all isolated profile settings restore');
    }
  });
});
