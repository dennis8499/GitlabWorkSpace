import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import * as vscode from 'vscode';
import { chromium } from 'playwright-core';
import { connectWorkspaceWebview } from './liveValidation.test';
import type { CodexBridge } from '../../src/codex/bridge';
import type { CodexInteraction, CodexTaskState } from '../../src/codex/protocol';
import { readReviewSessions } from '../../src/workspace/reviewSessions';

suite('Codex one-click packaged extension', function () {
  this.timeout(1_500_000);
  test('runs Wiki, all three reviewers and BMAD through the real app-server and webview', async function () {
    if (process.env.GLW_CODEX_LIVE !== '1') this.skip();
    const root = process.env.GLW_CODEX_LIVE_ROOT!, evidence = process.env.GLW_CODEX_LIVE_EVIDENCE!, port = Number(process.env.GLW_CODEX_LIVE_PORT);
    const enabled = new Set((process.env.GLW_CODEX_LIVE_TOOLS ?? 'wiki,merge-reviewer,release-reviewer,bmad,commit-reviewer').split(','));
    assert.match(path.basename(root), /^gitlab-codex-real-[a-z0-9]+$/i);
    await mkdir(evidence, { recursive: true });
    const extension = vscode.extensions.getExtension('local-dev.gitlab-workspace')!;
    assert.ok(extension); const api = await extension.activate();
    const host = api.getWorkspaceForTesting() as any;
    const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, { timeout: 30_000 });
    let ui: Awaited<ReturnType<typeof connectWorkspaceWebview>> | undefined;
    const results: Array<Record<string, unknown>> = [];
    const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
    const wait = async (predicate: () => boolean, label: string, timeout = 60_000) => {
      const deadline = Date.now() + timeout;
      while (!predicate()) { if (Date.now() > deadline) throw new Error(label); await sleep(100); }
    };
    try {
      await vscode.commands.executeCommand('gitlabWorkspace.openSaMode');
      ui = await connectWorkspaceWebview(browser, port, path.join(evidence, 'targets.json'), path.join(evidence, 'webview.json'), fetch,
        "!!document.querySelector('.skills-action-bar')");
      await ui.waitForVisible('.skills-action-bar', 90_000);
      for (let attempt = 0; attempt < 4; attempt++) {
        try { await host.refreshWorkflowKit(); break; }
        catch (error) { if ((error as Error).name !== 'AbortError') throw error; await sleep(300); }
      }
      await writeFile(path.join(evidence, 'skills.json'), JSON.stringify(host.getSkillsContext(), null, 2));
      await wait(() => host.getSkillsContext().installed.status === 'installed', 'WorkflowKit did not become available', 90_000);
      const bridge = host.getCodexBridge() as CodexBridge;
      async function finish(taskId: string, timeout = 300_000): Promise<CodexTaskState> {
        const deadline = Date.now() + timeout, answered = new Set<string>();
        while (Date.now() < deadline) {
          const task = bridge.list().find(value => value.id === taskId)!;
          if (['completed', 'failed', 'interrupted', 'uncertain'].includes(task.status)) {
            await wait(() => !(bridge as any).active, 'The process supervisor did not settle');
            assert.equal(task.status, 'completed', task.error ?? task.status); return task;
          }
          const requests = [...(bridge as any).interactions.values()] as Array<{ projection: CodexInteraction }>;
          for (const { projection } of requests) {
            if (answered.has(projection.id)) continue;
            answered.add(projection.id);
            if (projection.kind === 'questions') {
              const answers = Object.fromEntries((projection.questions ?? []).map(question => [question.id,
                question.options?.[0]?.label ?? '採用最精簡、僅修改此隔離測試專案的合理預設；不發布、不推送、不傳送訊息。']));
              await bridge.answer(task.id, projection.id, { decision: 'accept', answers });
            } else {
              // Only local command/file approvals in the explicit disposable workspace are accepted.
              const local = ['command', 'file'].includes(projection.kind) && !(projection.detail ?? '').includes('http');
              await bridge.answer(task.id, projection.id, { decision: local ? 'accept' : 'decline' });
            }
          }
          await sleep(200);
        }
        await bridge.cancel(taskId); throw new Error(`Codex live task timed out: ${taskId}`);
      }
      async function clickRun(selector: string, name: string): Promise<CodexTaskState> {
        const checks: Record<string, boolean> = {};
        const before = new Set(bridge.list().map(value => value.id));
        await ui!.waitForProperty(selector, 'disabled', false, 30_000);
        await ui!.click(selector);
        await wait(() => bridge.list().some(value => !before.has(value.id)), `${name}: one-click did not enqueue a task`, 90_000);
        const task = bridge.list().find(value => !before.has(value.id))!;
        await ui!.waitForVisible('.codex-workspace:not([hidden])', 30_000);
        if (name === 'wiki') {
          await ui!.waitForProperty('.codex-auto-accept input', 'disabled', false, 30_000);
          await ui!.click('.codex-auto-accept input');
          await wait(() => bridge.list().find(value => value.id === task.id)?.controls?.autoAccept === true, 'Auto-Accept did not enable');
          await ui!.waitForProperty('.codex-auto-accept input', 'checked', true, 30_000);
          await ui!.click('.codex-auto-accept input');
          await wait(() => bridge.list().find(value => value.id === task.id)?.controls?.autoAccept === false, 'Auto-Accept did not disable');
          await ui!.waitForProperty('.codex-auto-accept input', 'checked', false, 30_000);
          checks.autoAcceptToggle = true;
          await wait(() => !!bridge.list().find(value => value.id === task.id)?.turnId || bridge.list().find(value => value.id === task.id)?.status === 'failed', 'Wiki did not enter a turn');
          const running = bridge.list().find(value => value.id === task.id)!;
          if (running.status === 'running') {
            await ui!.click('.codex-controls > button.primary');
            await wait(() => bridge.list().find(value => value.id === task.id)?.status === 'paused', 'Wiki pause did not settle', 90_000);
            assert.equal((bridge as any).active, undefined, 'paused is published after process cleanup');
            await ui!.waitForVisible('.codex-controls > button.primary:not([aria-busy]):not([disabled])', 30_000);
            await ui!.click('.codex-controls > button.primary');
            await wait(() => ['queued', 'starting', 'running', 'completed'].includes(bridge.list().find(value => value.id === task.id)!.status), 'Wiki resume was not accepted');
            assert.equal(bridge.list().find(value => value.id === task.id)?.threadId, running.threadId, 'resume retains the real Codex conversation');
            checks.pauseAndResume = true;
          }
        }
        await finish(task.id);
        if (name === 'wiki') {
          const reply = ((bridge as any).outputs.get(task.id) as Array<{ kind: string; text: string }>).filter(item => item.kind === 'agent').at(-1)?.text ?? '';
          assert.match(reply, /calculator|add|加法|減法/i, 'resuming Wiki still answers the original calculator question');
          assert.doesNotMatch(reply, /請提供原\s*request|未找到審查\s*runtime/, 'Wiki resume does not ask for reviewer state');
          await wait(() => !host.operations.list().some((operation: { action: string; status: string }) => operation.action === 'codexHistory' && ['queued', 'running'].includes(operation.status)),
            'automatic history did not finish');
          assert.equal(host.operations.list().filter((operation: { action: string; status: string }) => operation.action === 'codexHistory' && operation.status === 'failed').length, 0,
            'automatic history waits until the thread has a persisted user message');
          checks.originalGoal = true;
          checks.historyReadiness = true;
        }
        const final = bridge.list().find(value => value.id === task.id)!;
        results.push({ name, ...final, checks });
        const page = browser.contexts()[0].pages().find(page => page.url().includes('workbench')) ?? browser.contexts()[0].pages()[0];
        await page.screenshot({ path: path.join(evidence, `${name}.png`) });
        await writeFile(path.join(evidence, 'results.json'), JSON.stringify(results, null, 2));
        return final;
      }
      if (enabled.has('wiki')) {
      await ui.evaluate(`(() => { const input = document.getElementById('wiki-input-query.question'); input.value = '請根據 service/calculator.py 與 service/test_calculator.py，簡短說明 add 的行為及目前的問題；僅讀取本機，不呼叫外部服務。'; input.dispatchEvent(new Event('input', { bubbles: true })); })()`);
      const wiki = await clickRun('.skills-action-bar > button:first-child', 'wiki');
      assert.ok(wiki.threadId);
      }
      for (const [tool, feature] of [['merge-reviewer', 'merge-repo'], ['release-reviewer', 'release-review']] as const) {
        if (!enabled.has(tool)) continue;
        await vscode.commands.executeCommand('gitlabWorkspace.openSaMode');
        await ui.waitForVisible('.skills-action-bar', 30_000);
        await ui.evaluate(`document.getElementById(${JSON.stringify('skill-tool-' + tool)}).click()`);
        await ui.waitForVisible(`[id="wiki-input-${feature}.base"]`, 30_000);
        await ui.evaluate(`(() => { for (const [field, value] of [['repo', ${JSON.stringify(path.join(root, 'service'))}], ['base', 'main'], ['head', 'feature']]) { const input = document.getElementById(${JSON.stringify('wiki-input-' + feature + '.')} + field); input.value = value; input.dispatchEvent(new Event(input.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true })); } })()`);
        const task = await clickRun('.skills-action-bar > button:first-child', tool);
        assert.match(task.review!.requestId, /^[a-f0-9]{32}$/, 'Bridge binds the canonical persisted helper request ID');
        const context = host.getSkillsContext();
        const runtime = tool === 'merge-reviewer' ? context.reviewRuntimeRoot : context.releaseReviewRuntimeRoot;
        const sessions = await readReviewSessions(runtime, root, [path.join(root, 'service')], tool);
        const review = sessions.find(session => session.requestId === task.review?.requestId);
        assert.ok(review?.reportPath, `${tool}: a completed Codex turn must have a real helper report`);
      }
      if (enabled.has('bmad')) {
      await vscode.commands.executeCommand('gitlabWorkspace.openBmadMode');
      await ui.waitForVisible('#bmad-tab-start', 90_000);
      await ui.click('#bmad-tab-start');
      await ui.waitForVisible('#bmad-requirement', 90_000);
      await ui.evaluate(`(() => { const input = document.getElementById('bmad-requirement'); input.value = 'calculator.add 的加法目前寫成減法。請採用最精簡 BMAD 流程，直接建立修正此 bug 的最小 Spec，放入 _bmad-output；目前已有可驗證的測試，不需要額外釐清，不要開始 Build、不修改 service、不連外、不發布。'; input.dispatchEvent(new Event('input', { bubbles: true })); })()`);
      const bmad = await clickRun('.bmad-inline-actions .feature-control > button', 'bmad');
      let files = await readdir(path.join(root, '_bmad-output'), { recursive: true }).catch(() => []);
      if (!files.some(file => /\.md$/i.test(String(file)))) {
        await ui.fill('#codex-follow-up', '$bmad-spec 請直接建立最小 bugfix Spec：service/calculator.py 的 add 應回傳 a + b，目前錯成 a - b；驗收是 test_calculator.py 的 add(2, 3) == 5。採合理預設，規格存入 _bmad-output，不執行 Build、不修改 service、不發布。');
        await ui.click('.codex-message button[type="submit"]');
        await wait(() => bridge.list().find(value => value.id === bmad.id)?.turnId !== bmad.turnId || bridge.list().find(value => value.id === bmad.id)?.status !== 'completed', 'BMAD follow-up did not start');
        const continued = await finish(bmad.id); results[results.length - 1] = { name: 'bmad', ...continued };
        files = await readdir(path.join(root, '_bmad-output'), { recursive: true }).catch(() => []);
      }
      assert.ok(files.some(file => /\.md$/i.test(String(file))), 'BMAD produces a real saved document');
      }
      if (enabled.has('commit-reviewer')) {
        const repository = path.join(root, 'service');
        const head = execFileSync('git', ['-C', repository, 'rev-parse', 'HEAD'], { encoding: 'utf8', windowsHide: true }).trim();
        await writeFile(path.join(repository, 'commit-review-fixture.md'), '# Local fixture\n\nPrepared for CommitReviewer; no commit or remote write is authorized.\n');
        await vscode.commands.executeCommand('gitlabWorkspace.openSaMode');
        await ui.waitForVisible('#skill-tool-commit-reviewer', 30_000); await ui.click('#skill-tool-commit-reviewer');
        await ui.waitForVisible('[id="wiki-input-commit-draft.repo"]', 30_000);
        await ui.evaluate(`(() => { for (const [field, value] of [['repo', ${JSON.stringify(repository)}], ['issues', '#1']]) { const input = document.getElementById('wiki-input-commit-draft.' + field); input.value = value; input.dispatchEvent(new Event(input.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true })); } })()`);
        const commit = await clickRun('.skills-action-bar > button:first-child', 'commit-reviewer');
        const spec = await bridge.specification(commit.id);
        assert.ok(spec.commitReview?.runtimeRoot, 'CommitReviewer binds its native runtime');
        assert.ok((await readdir(spec.commitReview!.runtimeRoot, { recursive: true })).length, 'CommitReviewer produces native runtime evidence');
        assert.equal(execFileSync('git', ['-C', repository, 'rev-parse', 'HEAD'], { encoding: 'utf8', windowsHide: true }).trim(), head, 'CommitReviewer never commits automatically');
      }
      await vscode.commands.executeCommand('gitlabWorkspace.openWorkspace');
      await vscode.commands.executeCommand('gitlabWorkspace.openCodexMode');
      await ui.waitForVisible('.codex-workspace:not([hidden])', 30_000);
      assert.equal(bridge.list().length, enabled.size, 'leaving and reopening Codex never resubmits work');
      await writeFile(path.join(evidence, 'results.json'), JSON.stringify({ success: true, vscode: vscode.version, tasks: results }, null, 2));
    } catch (error) {
      await writeFile(path.join(evidence, 'failure.json'), JSON.stringify({ error: String(error), skills: host.getSkillsContext(), tasks: host.getCodexBridge().list() }, null, 2));
      throw error;
    } finally { await host.shutdownCodex(); await ui?.close(); await browser.close(); }
  });
});
