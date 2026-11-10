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

const probe = String.raw`(() => {
  let bridge, initialUiPresent = false;
  const acquire = window.acquireVsCodeApi;
  window.acquireVsCodeApi = () => {
    if (!bridge) { bridge = acquire(); initialUiPresent = !!bridge.getState()?.codexUi; }
    return bridge;
  };
  const errors = [], violations = [];
  window.addEventListener('error', event => errors.push(event.message));
  window.addEventListener('unhandledrejection', event => errors.push(String(event.reason)));
  window.addEventListener('securitypolicyviolation', event => violations.push(event.violatedDirective));
  const wait = async (check, label) => {
    const deadline = Date.now() + 15000;
    while (!check()) {
      if (Date.now() >= deadline) throw new Error('Draft recovery probe timed out: ' + label);
      await new Promise(resolve => setTimeout(resolve, 20));
    }
  };
  const input = (node, text) => {
    node.value = text; node.dispatchEvent(new Event('input', { bubbles: true }));
  };
  async function inspect(request) {
    await wait(() => document.querySelector('#codex-follow-up') && document.querySelector('.codex-question input[type=text]'), 'task and questions');
    document.querySelector('#codex-results-tab').click();
    await wait(() => document.querySelector('.codex-workflow-result details textarea'), 'MR reply');
    const message = document.querySelector('#codex-follow-up');
    const answer = document.querySelector('.codex-question input[type=text]');
    const secret = document.querySelector('.codex-question input[type=password]');
    const reply = document.querySelector('.codex-workflow-result details textarea');
    reply.closest('details').open = true;
    if (request.action === 'edit') {
      input(message, request.message); input(answer, request.answer); input(secret, request.secret); input(reply, request.reply);
    } else if (request.action === 'last-key') input(message, request.message);
    if (request.action === 'check') await wait(() => message.value === request.message && answer.value === request.answer && reply.value === request.reply, 'Host restored all three drafts');
    await new Promise(resolve => setTimeout(resolve, 50));
    return { message: message.value, answer: answer.value, secret: secret.value, reply: reply.value,
      saved: bridge.getState()?.codexUi, initialUiPresent, errors: [...errors], violations: [...violations] };
  }
  window.addEventListener('message', event => {
    if (event.data?.type !== 'nativeDraftRecoveryProbe') return;
    inspect(event.data).then(result => bridge.postMessage({ type: 'nativeDraftRecoveryResult', id: event.data.id, result }),
      error => bridge.postMessage({ type: 'nativeDraftRecoveryResult', id: event.data.id, result: { error: error.message, errors, violations } }));
  });
})();`;

suite('Native Codex durable draft recovery', function () {
  this.timeout(90_000);
  test('restores message, question and MR reply after actual panel disposal with a new Host store', async function () {
    if (!process.env.GITLAB_WORKSPACE_TEST_TMP) { this.skip(); return; }
    const profile = await realpath(process.env.GITLAB_WORKSPACE_TEST_TMP);
    assert.ok(path.basename(profile).startsWith('gitlab-workspace-host-tests-'));
    assert.equal(await realpath(vscode.workspace.workspaceFile!.fsPath), await realpath(path.join(profile, 'host.code-workspace')));
    const extension = vscode.extensions.getExtension('local-dev.gitlab-workspace'); assert.ok(extension);
    let assets = vscode.Uri.joinPath(extension.extensionUri, 'resources', 'issue-webview');
    if (process.env.GITLAB_WORKSPACE_ZOOM_ASSET_ROOT) {
      const temporary = await realpath(path.join(extension.extensionUri.fsPath, '.tmp'));
      const target = await realpath(process.env.GITLAB_WORKSPACE_ZOOM_ASSET_ROOT), relative = path.relative(temporary, target);
      assert.ok(relative && !path.isAbsolute(relative) && relative !== '..' && !relative.startsWith('..' + path.sep));
      assets = vscode.Uri.file(target);
    }
    const directory = path.join(profile, 'native-draft-store'), scope = createHash('sha256').update('native-draft-account-and-project').digest('hex');
    const task: CodexTaskState = { id: 'native-draft-task', title: 'Native durable drafts', root: 'C:/offline/draft-fixture', status: 'waiting',
      createdAt: '2026-11-10T00:00:00Z', updatedAt: '2026-11-10T00:00:00Z',
      controls: { external: false, canPause: true, canResume: false, canDelete: false, canAutoAccept: true, autoAccept: false },
      origin: { kind: 'merge-request', accountKey: 'native-account', baseUrl: 'https://offline.invalid', projectId: 1,
        projectPath: 'offline/draft-fixture', webUrl: 'https://offline.invalid/merge_requests/1', repositoryRoot: 'C:/offline/draft-fixture',
        sourceBranch: 'feature', sourceSha: 'a'.repeat(40), iid: 1, intent: 'fix-comments' },
      result: { state: 'needs-work', summary: 'Synthetic result; no publication is authorized.', replyDrafts: [{ discussionId: 'discussion-1', body: 'Original suggestion' }] } };
    const snapshot: WorkspaceSnapshot = { connected: true, baseUrl: 'https://offline.invalid',
      currentUser: { id: 7, username: 'fixture', name: 'Fixture' }, activeAccountId: 'native-account', groups: [], projects: [], issues: [], mergeRequests: [],
      groupMilestones: [], groupIssueBoards: [], connectedScope: 'native-draft', instanceUserScope: 'native-draft',
      operationScope: 'native-draft', localOperationScope: 'native-draft', activeMode: 'codex', codexWorkspaceLayout: 'workspace',
      projectContext: { root: 'C:/offline/draft-fixture', revision: 'fixture', folders: [], manual: false },
      groupRepositories: [], groupRepositoryScanStatus: 'idle', localRepositories: {}, projectLocalRepositories: {}, projectMembers: [], timers: [],
      workflowKit: { status: 'missing' }, workflowKitSource: 'github', workflowKitInstallTarget: { manual: false, state: { status: 'missing' } },
      operationSnapshot: { sessionId: 'native-draft', revision: 0, operations: [] } };
    const values = { message: 'Keep the complete message draft.', answer: 'Public answer draft.', secret: 'native-memory-only-secret-8241', reply: 'Keep the edited MR reply.' };
    const lastMessage = 'Final keystroke before panel disposal.';
    let releaseSave!: () => void, enteredSave!: () => void;
    const heldSave = new Promise<void>(resolve => { releaseSave = resolve; }), saveEntered = new Promise<void>(resolve => { enteredSave = resolve; });
    const errors: string[] = [], wire: unknown[] = [], writes: string[] = [];
    let panelsCreated = 0, saveReceipts = 0, sequence = 0;
    const alive = new Set<{ dispose(): void }>();
    async function mount() {
      // No acquireVsCodeApi state is passed to the new panel, and this is a new store instance.
      const store = new CodexUiDraftStore(directory);
      const panel = vscode.window.createWebviewPanel('gitlabWorkspace.nativeDraftRecovery', 'Native draft recovery', vscode.ViewColumn.Active,
        { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [assets] });
      panelsCreated++;
      const pending = new Map<number, (value: any) => void>(), saves = new Set<Promise<void>>();
      let ready = false, disposed = false;
      const post = async (value: unknown) => {
        if (disposed) return false;
        try { return await panel.webview.postMessage(value); }
        catch (error) { if (disposed) return false; throw error; }
      };
      const listener = panel.webview.onDidReceiveMessage((request: any) => {
        if (request.type === 'nativeDraftRecoveryResult') { pending.get(request.id)?.(request.result); pending.delete(request.id); return; }
        if (request.type === 'ready') { ready = true; void post({ type: 'snapshot', snapshot }); }
        if (request.type === 'listCodexTasks') {
          void post({ type: 'codexEvent', event: { kind: 'tasks', tasks: [task] } });
          void post({ type: 'codexEvent', event: { kind: 'interactions', taskId: task.id, interactions: [{ id: 'native-question', taskId: task.id,
            kind: 'questions', title: 'Public and secret answers', questions: [{ id: 'answer', question: 'Public answer' }, { id: 'password', question: 'Secret answer', isSecret: true }] }] } });
        }
        if (request.type === 'loadCodexUiDrafts' || request.type === 'saveCodexUiDrafts') {
          wire.push(structuredClone(request));
          const job = (async () => {
            try {
              if (request.type === 'saveCodexUiDrafts') assert.equal(request.scope, scope);
              if (request.type === 'saveCodexUiDrafts' && request.updates.some((update: any) =>
                update.key === JSON.stringify(['draft', task.id]) && update.value?.text === lastMessage)) { enteredSave(); await heldSave; }
              const saved = request.type === 'loadCodexUiDrafts' ? await store.read(scope) : await store.save(scope, request.updates.map((update: any) => ({
                ...update, value: sanitizeCodexUiDraftValue(update.key, update.value, parseCodexUiDraftKey(update.key)[0] === 'interaction' ? new Set(['answer']) : undefined)
              })), request.resolveConflictIds);
              if (request.type === 'saveCodexUiDrafts') saveReceipts++;
              await post({ type: 'codexUiDrafts', requestId: request.requestId, snapshot: saved });
            } catch (error) { errors.push(String(error)); await post({ type: 'codexUiDrafts', requestId: request.requestId, error: String(error) }); }
          })();
          saves.add(job); void job.finally(() => saves.delete(job));
        }
        if (['sendCodexMessage', 'answerCodex', 'resumeCodexTask', 'submitCodexLaunch', 'startCodexTask', 'codexCommand'].includes(request.type)) writes.push(request.type);
      });
      const nonce = randomBytes(16).toString('base64');
      panel.webview.html = prepareWebviewHtml(await readFile(vscode.Uri.joinPath(assets, 'dashboard.html').fsPath, 'utf8'), panel.webview, assets, 'dashboard', nonce)
        .replace('</head>', '<script nonce="' + nonce + '">' + probe + '</script></head>');
      const readyDeadline = Date.now() + 15_000;
      while (!ready) { assert.ok(Date.now() < readyDeadline, 'native draft panel announces readiness'); await new Promise(resolve => setTimeout(resolve, 20)); }
      const view = {
        async inspect(action: string, expected = values): Promise<any> {
          panel.reveal(vscode.ViewColumn.Active);
          const id = ++sequence;
          const result = await new Promise<any>((resolve, reject) => {
            const timer = setTimeout(() => { pending.delete(id); reject(new Error('No native draft recovery result')); }, 20_000);
            pending.set(id, value => { clearTimeout(timer); resolve(value); });
            void post({ type: 'nativeDraftRecoveryProbe', id, action, ...expected });
          });
          assert.equal(result.error, undefined, JSON.stringify(result)); assert.equal(result.initialUiPresent, false, 'a new native panel cannot reuse the old Webview state');
          assert.deepEqual(result.errors, []); assert.deepEqual(result.violations, []);
          return result;
        },
        async flush() { await Promise.all([...saves]); },
        dispose() { disposed = true; listener.dispose(); panel.dispose(); alive.delete(view); }
      };
      alive.add(view); return view;
    }
    async function disk(expectedMessage: string) {
      const deadline = Date.now() + 15_000;
      for (;;) {
        const saved = await new CodexUiDraftStore(directory).read(scope);
        const message = saved.entries.find(entry => entry.key === JSON.stringify(['draft', task.id]))?.value as { text?: string } | undefined;
        const answer = saved.entries.find(entry => entry.key === JSON.stringify(['interaction', JSON.stringify([task.id, 'native-question'])]))?.value as { values?: Record<string, string> } | undefined;
        const reply = saved.entries.find(entry => entry.key === JSON.stringify(['reply', JSON.stringify([task.id, 'discussion-1'])]))?.value as { text?: string } | undefined;
        if (message?.text === expectedMessage && answer?.values?.answer === values.answer && reply?.text === values.reply) {
          assert.ok(!JSON.stringify(saved).includes(values.secret)); return;
        }
        assert.ok(Date.now() < deadline, 'all three draft kinds must reach the actual disk store'); await new Promise(resolve => setTimeout(resolve, 25));
      }
    }
    try {
      const first = await mount(); await first.inspect('edit'); await disk(values.message); await first.flush(); first.dispose();
      const second = await mount(), restored = await second.inspect('check');
      assert.equal(restored.secret, ''); assert.equal(restored.message, values.message); assert.equal(restored.answer, values.answer); assert.equal(restored.reply, values.reply);
      const latest = { ...values, message: lastMessage };
      await second.inspect('last-key', latest);
      let arrivalTimer: ReturnType<typeof setTimeout> | undefined;
      try { await Promise.race([saveEntered, new Promise<never>((_resolve, reject) => { arrivalTimer = setTimeout(() => reject(new Error('Latest edit never reached the Host before closure')), 15_000); })]); }
      finally { if (arrivalTimer) clearTimeout(arrivalTimer); }
      second.dispose(); releaseSave(); await disk(latest.message);
      const third = await mount(), restoredAgain = await third.inspect('check', latest);
      assert.equal(restoredAgain.secret, ''); await third.flush();
      assert.equal(panelsCreated, 3); assert.ok(saveReceipts > 0); assert.deepEqual(errors, []); assert.deepEqual(writes, []);
      assert.ok(!JSON.stringify(wire).includes(values.secret), 'secret answers must never enter the persistence IPC');
      const assetHashes = Object.fromEntries(await Promise.all(['dashboard.html', 'dashboard.js', 'dashboard.css', 'codicon.ttf'].map(async name =>
        [name, createHash('sha256').update(await readFile(vscode.Uri.joinPath(assets, name).fsPath)).digest('hex')])));
      const evidence = { schema: 'GitLabWorkspaceNativeDraftRecovery/v1', panelsCreated, storeInstancesRecreated: true,
        method: 'Actual native panel disposal and fresh Webview API state; new production disk-store instance for each panel; controlled local Host, no model or GitLab calls.',
        passed: ['message', 'public-answer', 'MR-reply', 'last-keystroke'], secretAbsentFromWireAndDisk: true,
        closedWhileSaveAcknowledgementHeld: true, dispatches: writes.length, persistenceReceipts: saveReceipts, assetHashes };
      console.log('Native draft recovery proof', JSON.stringify(evidence));
      if (process.env.GITLAB_WORKSPACE_VALIDATION_DIR) await writeFile(path.join(process.env.GITLAB_WORKSPACE_VALIDATION_DIR, 'native-codex-draft-recovery.json'), JSON.stringify(evidence, null, 2));
    } finally { releaseSave(); for (const view of [...alive]) view.dispose(); }
  });
});
