import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import * as vscode from 'vscode';
import { chromium, type Page } from 'playwright-core';
import type { CodexBridge } from '../../src/codex/bridge';
import type { CodexTaskRecord, CodexTaskState } from '../../src/codex/protocol';
import { collectGroupAnalysis } from '../../src/codex/groupAnalysis';
import { readGroupIssueDrafts } from '../../src/codex/groupIssues';
import { readTaskWorkspace } from '../../src/codex/taskWorkspace';
import { sanitizeDiagnostic } from '../../src/logging/diagnosticText';
import { connectWorkspaceWebview } from './liveValidation.test';

interface RepositoryFixture { role: string; path: string; headSha?: string; httpCloneUrl?: string; }
type LiveUi = Awaited<ReturnType<typeof connectWorkspaceWebview>>;
const hash = (value: Buffer | string): string => createHash('sha256').update(value).digest('hex');
const same = (left: string, right: string): boolean => process.platform === 'win32'
  ? path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase() : path.resolve(left) === path.resolve(right);
const git = (root: string, ...args: string[]): string => execFileSync('git', ['-C', root, ...args], {
  windowsHide: true, encoding: 'utf8', timeout: 30_000, maxBuffer: 1024 * 1024,
  env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_NO_LAZY_FETCH: '1', GIT_TERMINAL_PROMPT: '0' }
});

async function snapshot(repository: RepositoryFixture) {
  const root = await realpath(repository.path), tracked: Record<string, string> = {};
  for (const name of git(root, 'ls-files', '-z').split('\0').filter(Boolean)) {
    const file = path.join(root, name), info = await lstat(file);
    assert.ok(info.isFile() && !info.isSymbolicLink(), 'the isolated fixture contains only regular tracked files');
    tracked[name] = hash(await readFile(file));
  }
  return { role: repository.role, root, headSha: git(root, 'rev-parse', 'HEAD').trim(),
    status: git(root, 'status', '--porcelain=v1', '--untracked-files=all'), tracked,
    configuration: hash(await readFile(path.join(root, '.git', 'config'))),
    refs: git(root, 'for-each-ref', '--format=%(refname) %(objectname)') };
}

async function processMetadata() {
  const configured = process.env.GITLAB_WORKSPACE_RUNTIME_DIR;
  if (!configured || !/^gitlab-codex-runtime-[a-z0-9]+$/i.test(path.basename(configured))) return { unavailable: 'No isolated live-test runtime' };
  try {
    const runtime = await realpath(configured), directory = path.join(runtime, 'codex-processes');
    const info = await lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink() || !same(await realpath(directory), directory)) return { unavailable: 'Runtime metadata is redirected' };
    const names = await readdir(directory), entries: Array<Record<string, unknown>> = [];
    const metadata = async (file: string): Promise<Record<string, any> | undefined> => {
      try {
        const stat = await lstat(file);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4096 || !same(await realpath(file), file)) return undefined;
        return JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>;
      } catch { return undefined; }
    };
    for (const name of names.filter(name => /^[a-f0-9-]{36}\.lock$/i.test(name)).slice(0, 100)) {
      const lock = path.join(directory, name), lockInfo = await lstat(lock);
      if (!lockInfo.isDirectory() || lockInfo.isSymbolicLink() || !same(await realpath(lock), lock)) continue;
      const owner = await metadata(path.join(lock, 'owner.json'));
      const nonce = typeof owner?.nonce === 'string' && /^[a-z0-9-]{16,128}$/i.test(owner.nonce) ? owner.nonce : undefined;
      const receiptName = nonce ? `${name}.stopped-${nonce}.json` : undefined;
      const receipt = receiptName ? await metadata(path.join(directory, receiptName)) : undefined;
      entries.push({ id: name, ownerPresent: !!owner, owner: owner ? { schemaValid: owner.schema === 'GitLabWorkspaceLease/v1', kindCodex: owner.kind === 'codex',
        pid: Number.isSafeInteger(owner.pid) ? owner.pid : undefined,
        state: ['reserved', 'starting', 'running', 'quarantined'].includes(owner.state) ? owner.state : undefined } : undefined,
      receiptPresent: !!receiptName && names.includes(receiptName), receiptValidFile: !!receipt,
      receiptSchemaValid: receipt?.schema === 'GitLabWorkspaceCodexProcess/v1', receiptMatchesOwner: !!receipt && receipt.nonce === nonce,
      processTreeConfirmed: receipt?.processTreeConfirmed === true });
    }
    return { entries, receiptFiles: names.filter(name => /^[a-f0-9-]{36}\.lock\.stopped-[a-z0-9-]{16,128}\.json$/i.test(name)).slice(0, 100),
      truncated: names.length > 100 };
  } catch (error) { return { unavailable: (error as NodeJS.ErrnoException).code ?? 'Runtime metadata could not be inspected' }; }
}

async function failureDiagnostics(bridge: CodexBridge, host: any) {
  const clients = [...((bridge as unknown as { clients?: Set<{ diagnostics: { stderr: string; exit?: { code: number | null; signal: string | null; errorCode?: string } } }> }).clients ?? [])]
    .map(client => ({ stderr: sanitizeDiagnostic(client.diagnostics.stderr), exit: client.diagnostics.exit }));
  let launches: Array<Record<string, unknown>> | { unavailable: string };
  try {
    launches = (await host.getCodexLaunch().list()).slice(0, 25).map((draft: any) => ({ id: draft.id, state: draft.state, revision: draft.revision,
      sourceKind: draft.source?.kind, error: draft.error ? sanitizeDiagnostic(draft.error) : undefined,
      checking: !!draft.checkOwner, checks: draft.checks?.map((check: any) => ({ id: check.id, state: check.state,
        message: check.message ? sanitizeDiagnostic(check.message) : undefined, repair: check.repair })) }));
  } catch (error) { launches = { unavailable: sanitizeDiagnostic(error instanceof Error ? error.message : 'Launch diagnostics unavailable') }; }
  return { clients, launches, processes: await processMetadata() };
}

suite('Managed Group analysis through a real owner window', function () {
  this.timeout(1_200_000);
  test('keeps committed sources fixed and awaits human Issue publication after real source-first and BMAD work', async function () {
    const enabled = new Set((process.env.GLW_CODEX_LIVE_TOOLS ?? '').split(','));
    if (process.env.GLW_CODEX_LIVE !== '1' || !enabled.has('group')) { this.skip(); return; }
    const root = await realpath(process.env.GLW_CODEX_LIVE_ROOT!), evidence = process.env.GLW_CODEX_LIVE_EVIDENCE!;
    const port = Number(process.env.GLW_CODEX_LIVE_PORT);
    assert.match(path.basename(root), /^gitlab-codex-real-[a-z0-9]+$/i);
    const secretNames = Object.keys(process.env).filter(name => /^(?:GLW|GITLAB)_.*(?:TOKEN|PASSWORD|SECRET|AUTHORIZATION|PRIVATE_KEY)/i.test(name));
    assert.deepEqual(secretNames, [], 'the original and newly opened model Hosts must not inherit GitLab test secrets');
    const repositories: RepositoryFixture[] = process.env.GLW_CODEX_LIVE_REPOSITORIES
      ? JSON.parse(process.env.GLW_CODEX_LIVE_REPOSITORIES) : [{ role: 'service', path: path.join(root, 'service') }];
    assert.ok(repositories.length >= 1 && repositories.length <= 3);
    for (const repository of repositories) {
      assert.ok(['contracts', 'service', 'client'].includes(repository.role));
      assert.ok(same(path.dirname(await realpath(repository.path)), root), 'all source Repos belong to this disposable Group');
    }
    const before = await Promise.all(repositories.map(snapshot));
    for (const repository of repositories) if (repository.headSha) {
      assert.equal(before.find(item => item.role === repository.role)!.headSha, repository.headSha);
    }
    const sentinel = JSON.parse(process.env.GLW_CODEX_LIVE_SENTINEL ?? '{}') as { file?: string; marker?: string };
    assert.ok(sentinel.file && sentinel.marker, 'the runner must prepare an uncommitted sentinel before launching the Host');
    const sentinelPath = await realpath(sentinel.file);
    assert.ok(same(path.dirname(sentinelPath), path.join(root, 'service')));
    const sentinelBefore = await readFile(sentinelPath);
    assert.ok(sentinelBefore.includes(Buffer.from(sentinel.marker)));

    const extension = vscode.extensions.getExtension('local-dev.gitlab-workspace'); assert.ok(extension);
    const api = await extension.activate() as any, host = api.getWorkspaceForTesting();
    assert.equal(host.session?.baseUrl ?? api.session?.baseUrl, undefined, 'this first Group scenario requires no GitLab login');
    const bridge = host.getCodexBridge() as CodexBridge;
    if (process.env.GLW_CODEX_LIVE_DIAGNOSTIC_ONLY === '1') {
      const probes: Array<Record<string, unknown>> = [];
      try {
        for (const method of ['preflight', 'models'] as const) {
          const started = Date.now();
          try {
            if (method === 'preflight') {
              const result = await bridge.preflight(root);
              probes.push({ method, elapsedMs: Date.now() - started, result: { state: result.state, version: result.version,
                authenticated: result.authenticated, sandbox: result.sandbox, compatibility: result.compatibility,
                message: result.message ? sanitizeDiagnostic(result.message) : undefined } });
            } else {
              const models = await bridge.models(root);
              probes.push({ method, elapsedMs: Date.now() - started, modelCount: models.length, modelIds: models.map(model => model.id) });
            }
          } catch (error) { probes.push({ method, elapsedMs: Date.now() - started, error: sanitizeDiagnostic(error instanceof Error ? error.message : 'Probe failed') }); }
          probes.push({ after: method, diagnostics: await failureDiagnostics(bridge, host) });
        }
      } finally {
        await host.shutdownCodex();
        await writeFile(path.join(evidence, 'zero-model-results.json'), JSON.stringify({ schema: 'GitLabWorkspaceCodexZeroModelLive/v1',
          diagnosticOnly: true, groupE2EExecuted: false, tasksStarted: 0, modelTurns: 0, remoteWrites: 0,
          vscode: vscode.version, extensionVersion: extension.packageJSON.version, sourceRoot: root, probes,
          afterShutdown: await failureDiagnostics(bridge, host) }, null, 2));
      }
      this.skip(); return;
    }
    const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, { timeout: 30_000 });
    let originUi: LiveUi | undefined, ownerUi: LiveUi | undefined, taskId: string | undefined, phase = 'initializing';
    const journal: Array<Record<string, unknown>> = [];
    let ownerStopped = false, submissionStarted = false;
    const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
    const wait = async <T>(read: () => Promise<T | undefined | false>, description: string, timeoutMs = 90_000): Promise<T> => {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const value = await read(); if (value !== undefined && value !== false) return value;
        await delay(250);
      }
      throw new Error(description);
    };
    const currentTask = async (): Promise<CodexTaskState | undefined> => {
      await bridge.publish();
      return taskId ? bridge.list().find(item => item.id === taskId) : undefined;
    };
    const findOwner = async (timeoutMs = 90_000): Promise<LiveUi> => {
      assert.ok(taskId);
      const id = JSON.stringify(taskId), deadline = Date.now() + timeoutMs;
      const ready = `(() => { const selected = document.querySelector('.codex-mobile-tasks select');
        const control = [...document.querySelectorAll('.codex-secondary-controls button')].find(button => button.textContent === '停止並轉交人工處理');
        return selected?.value === ${id} && !!control && !control.disabled &&
          !document.body.innerText.includes('任務正在另一個 VS Code 視窗執行'); })()`;
      let latest = '';
      while (Date.now() < deadline) {
        try {
          // Each call re-enumerates targets, including the owner iframe created after the launch was submitted.
          const candidate = await connectWorkspaceWebview(browser, port, path.join(evidence, 'group-owner-targets.json'),
            path.join(evidence, 'group-owner-target-debug.json'), fetch, ready);
          if (candidate.targetId === originUi?.targetId) { await candidate.close(); throw new Error('The original window is not the execution owner'); }
          return candidate;
        } catch (error) { latest = error instanceof Error ? error.message : 'Owner target not available'; }
        await delay(250);
      }
      throw new Error(`The new owner window did not expose its own task UI: ${latest.slice(0, 1000)}`);
    };
    const pauseOwner = async (): Promise<void> => {
      if (!taskId || !submissionStarted) { ownerStopped = true; return; }
      const task = await wait(currentTask, 'a submitted launch has no observable task record; stopping cannot be verified', 90_000);
      if (['queued', 'starting', 'running', 'waiting'].includes(task.status)) {
        ownerUi ??= await findOwner(45_000);
        const pause = `(() => { const buttons = [...document.querySelectorAll('.codex-controls button')];
          const pause = buttons.find(button => button.textContent === '暫停' && !button.disabled);
          if (!pause) return false; pause.click(); return true; })()`;
        let clicked: boolean;
        try { clicked = await ownerUi.evaluate<boolean>(pause); }
        catch {
          try { await ownerUi.close(); } catch { /* A lost CDP context is replaced once, without using the observing Bridge for control. */ }
          ownerUi = await findOwner(45_000);
          clicked = await ownerUi.evaluate<boolean>(pause);
        }
        if (!clicked) {
          const latest = await currentTask();
          assert.ok(latest && ['pausing', 'paused', 'completed', 'failed', 'interrupted'].includes(latest.status),
            'a failed live scenario must stop through the owner window, never the observing Bridge');
        }
      }
      await wait(async () => {
        const stopped = await currentTask();
        if (!stopped || !['paused', 'completed', 'failed', 'interrupted'].includes(stopped.status)) return undefined;
        const specification = await bridge.specification(taskId!);
        assert.ok(specification.taskWorkspace);
        const globalStorage = path.dirname(path.dirname(specification.taskWorkspace.directory));
        const record = JSON.parse(await readFile(path.join(globalStorage, 'codex-tasks', taskId! + '.json'), 'utf8')) as CodexTaskRecord;
        return !record.lease || record.lease.released === true ? stopped : undefined;
      }, 'the owner did not confirm a stopped task', 90_000);
      ownerStopped = true;
    };
    try {
      phase = 'opening-original-group';
      await vscode.commands.executeCommand('gitlabWorkspace.openCloneMode');
      originUi = await connectWorkspaceWebview(browser, port, path.join(evidence, 'group-origin-targets.json'),
        path.join(evidence, 'group-origin-debug.json'), fetch, `!!document.querySelector('.repository-scan-action')`);
      for (let attempt = 0; attempt < 4; attempt++) {
        try { await host.refreshWorkflowKit(); break; }
        catch (error) {
          if ((error as Error).name !== 'AbortError' || attempt === 3) throw error;
          await delay(300);
        }
      }
      const selectedSkills = await wait(async () => {
        const context = host.getSkillsContext();
        return context.installed.status === 'installed' && context.root && same(context.root, root) ? context : undefined;
      }, 'WorkflowKit did not settle on the original disposable Group', 90_000);
      assert.equal(selectedSkills.installed.version, process.env.GLW_CODEX_LIVE_KIT_VERSION ?? '1.9.0');
      await originUi.waitForProperty('.repository-scan-trigger', 'disabled', false, 60_000);
      await originUi.click('.repository-scan-trigger');
      await wait(async () => {
        const inventory = await api.getRepositoryInventoryForTesting();
        return repositories.every(repository => inventory.some((item: { path: string }) => same(item.path, repository.path))) ? true : undefined;
      }, 'native Git inventory did not register the fixture Repos');
      await originUi.evaluate(`(() => { const button = [...document.querySelectorAll('.repository-scan-action button')].find(item => item.textContent.includes('需求影響分析'));
        if (!button || button.disabled) throw new Error('Group analysis entry is unavailable'); button.click(); })()`);
      await originUi.waitForVisible('.codex-launch', 90_000);
      phase = 'waiting-for-initial-launch-check';
      const initialDraft = await wait(async () => {
        const drafts = await host.getCodexLaunch().list();
        const draft = drafts.find((item: { source: { kind: string } }) => item.source.kind === 'group-analysis');
        return draft && !draft.checkOwner && ['ready', 'blocked'].includes(draft.state) ? draft : undefined;
      }, 'the initial automatic Group check did not settle');
      taskId = initialDraft.id;
      await originUi.waitUntil(`(() => { const input = document.querySelector('#codex-launch-requirement');
        return !!input && !input.disabled && !input.matches(':disabled'); })()`, 30_000,
      'the Group requirement field remains disabled after the initial check');
      const requirement = '只分析所選 Repo 的本機已提交 HEAD。service/calculator.py 的 add 在已提交版本中誤用 a - b；唯一需求是修正為 a + b，驗收沿用 test_calculator.py 的 add(2, 3) == 5。' +
        '請先完成 source-first functional-exploration，再以 BMAD Spec 整理規格。其他選定 Repo 列明影響或不受影響的程式證據。' +
        '產生 SPEC.md、cards.md、sources.json、issues.json，Issue 草稿僅針對 service，先保存文件等待人確認。' +
        '資訊已足夠，採最小合理預設；不開始 Build，不修改原 Repo，不提交、不推送、不建立 Issue，不發布 Wiki 或留言，也不連外。';
      phase = 'saving-group-requirement';
      await originUi.fill('#codex-launch-requirement', requirement);
      await wait(async () => {
        const drafts = await host.getCodexLaunch().list();
        const draft = drafts.find((item: { id: string }) => item.id === taskId);
        return draft && draft.revision > initialDraft.revision && draft.requirement === requirement && !draft.checkOwner &&
          !['checking', 'submitting'].includes(draft.state) ? draft : undefined;
      }, 'the exact Group requirement was not persisted to the selected draft');
      const waitLaunchEditable = async () => originUi!.waitUntil(`(() => {
        const input = document.querySelector('#codex-launch-requirement');
        const button = [...document.querySelectorAll('.codex-launch-actions button')].find(item => item.textContent === '重新檢查');
        return !!input && !input.matches(':disabled') && input.value === ${JSON.stringify(requirement)} &&
          document.querySelector('.codex-launch-actions [role="status"]')?.textContent === '設定已保存' && !!button && !button.disabled;
      })()`, 30_000, 'the saved Group draft did not enable its recheck button');
      await waitLaunchEditable();
      phase = 'checking-fixed-source-selection';
      const checkLaunch = async () => {
        await waitLaunchEditable();
        const previous = (await host.getCodexLaunch().list()).find((item: { id: string }) => item.id === taskId);
        assert.ok(previous);
        assert.equal(previous.requirement, requirement);
        const activation = await originUi!.evaluate<{ exists: boolean; disabled: boolean; clicked: boolean }>(`(() => {
          const button = [...document.querySelectorAll('.codex-launch-actions button')].find(item => item.textContent === '重新檢查');
          const state = { exists: !!button, disabled: !button || button.disabled, clicked: false };
          if (button && !button.disabled) { button.click(); state.clicked = true; } return state; })()`);
        journal.push({ phase: 'requesting-launch-check', activation, revision: previous.revision });
        assert.equal(activation.clicked, true, `the Group recheck button was unavailable: ${JSON.stringify(activation)}`);
        const checked = await wait(async () => {
          const drafts = await host.getCodexLaunch().list();
          const draft = drafts.find((item: { id: string }) => item.id === taskId);
          return draft && draft.revision > previous.revision && !draft.checkOwner &&
            (draft.state === 'blocked' || draft.state === 'ready' && draft.preparationId !== previous.preparationId) ? draft : undefined;
        }, 'the Group launch checks did not settle');
        assert.equal(checked.state, 'ready', checked.error ?? 'the Group launch is blocked');
        return checked;
      };
      let checked = await checkLaunch();
      await waitLaunchEditable();
      const changedSelection = await originUi.evaluate<boolean>(`(() => {
        const group = [...document.querySelectorAll('.codex-launch fieldset')].find(fieldset => fieldset.querySelector(':scope > legend')?.textContent === '分析的本機 Repo');
        const inputs = [...(group?.querySelectorAll('input[type="checkbox"]') ?? [])];
        if (inputs.length !== ${repositories.length}) throw new Error('The Group selector does not show the exact fixture inventory');
        let changed = false; for (const input of inputs) if (!input.checked) { input.click(); changed = true; }
        return changed; })()`);
      if (changedSelection) {
        const expectedIds = checked.repositories.map((repository: { id: string }) => repository.id).sort();
        await wait(async () => {
          const draft = (await host.getCodexLaunch().list()).find((item: { id: string }) => item.id === taskId);
          return draft && draft.requirement === requirement && !draft.checkOwner && !['checking', 'submitting'].includes(draft.state) &&
            JSON.stringify([...(draft.repositoryIds ?? [])].sort()) === JSON.stringify(expectedIds) ? draft : undefined;
        }, 'the exact source Repo selection was not persisted');
        checked = await checkLaunch();
      }
      for (const source of before) assert.equal(checked.sourceSnapshot?.repositories?.find((item: { id: string; sha: string }) =>
        checked.repositories.find((repository: { id: string; path: string }) => repository.id === item.id && same(repository.path, source.root)))?.sha, source.headSha);
      phase = 'submitting-managed-launch';
      submissionStarted = true;
      await originUi.click('.codex-launch-actions button[type="submit"]');
      const observed = await wait(async () => {
        const task = await currentTask(); return task?.controls?.external ? task : undefined;
      }, 'the original Bridge did not observe the separately owned task');
      assert.equal(observed.controls?.canPause, false);
      const spec = await bridge.specification(taskId!);
      assert.ok(spec.groupAnalysis && spec.taskWorkspace);
      assert.ok(same(spec.root, root) && same(spec.taskWorkspace.originRoot, root));
      assert.equal(spec.skill?.name, 'codebase-wiki');
      assert.equal(spec.groupAnalysis.repositories.length, repositories.length);
      const globalStorage = path.dirname(path.dirname(spec.taskWorkspace.directory));
      assert.ok(process.env.GLW_CODEX_LIVE_USER_DATA && same(globalStorage,
        path.join(process.env.GLW_CODEX_LIVE_USER_DATA, 'User', 'globalStorage', 'local-dev.gitlab-workspace')),
      'the managed owner uses the exact isolated temporary profile');
      const launch = await readTaskWorkspace(globalStorage, spec.taskWorkspace.workspaceFile);
      assert.ok(launch.owner && launch.owner.pid !== process.pid && launch.owner.generation > 0);
      assert.equal(launch.binding.accountId, undefined, 'the Group owner window does not inherit a GitLab account binding');
      const ownerRoleFile = path.join(evidence, `owner-role-${taskId}-${launch.owner.pid}.json`);
      const ownerRole = await wait(async () => {
        try { return JSON.parse(await readFile(ownerRoleFile, 'utf8')) as Record<string, unknown>; }
        catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
      }, 'the native owner did not acknowledge the pending test bootstrap');
      assert.equal(ownerRole.role, 'managed-owner'); assert.equal(ownerRole.pid, launch.owner.pid);
      assert.equal(ownerRole.taskId, taskId); assert.equal(ownerRole.generation, launch.owner.generation);
      assert.equal(ownerRole.inheritedTestContext, true); assert.equal(ownerRole.ownerExtensionMode, 'Test');
      assert.equal(ownerRole.candidateBytesMatch, true); assert.equal(ownerRole.mochaLoaded, false);
      for (const repository of spec.groupAnalysis.repositories) {
        assert.equal(before.find(item => same(item.root, repository.path))?.headSha, repository.sha);
        assert.equal(git(repository.path, 'rev-parse', 'HEAD').trim(), repository.sha);
      }
      phase = 'connecting-owner-ui';
      ownerUi = await findOwner();
      const targetsCdp = await browser.newBrowserCDPSession();
      let ownerWorkbenchTarget: string | undefined;
      try {
        const targets = await targetsCdp.send('Target.getTargets') as { targetInfos: Array<{ targetId: string; type: string; parentId?: string }> };
        ownerWorkbenchTarget = targets.targetInfos.find(target => target.targetId === ownerUi!.targetId)?.parentId;
        assert.ok(ownerWorkbenchTarget && targets.targetInfos.some(target => target.targetId === ownerWorkbenchTarget && target.type === 'page'));
      } finally { await targetsCdp.detach(); }
      let ownerWorkbench: Page | undefined;
      for (const page of browser.contexts().flatMap(context => context.pages())) {
        const pageCdp = await page.context().newCDPSession(page);
        try {
          const target = await pageCdp.send('Target.getTargetInfo') as { targetInfo: { targetId: string } };
          if (target.targetInfo.targetId === ownerWorkbenchTarget) ownerWorkbench = page;
        } finally { await pageCdp.detach(); }
        if (ownerWorkbench) break;
      }
      assert.ok(ownerWorkbench, 'the owner iframe must be bound to its exact native workbench page');
      const ownerWorkbenchPage = ownerWorkbench;
      journal.push({ phase, taskId, originalHostPid: process.pid, ownerPid: launch.owner.pid, generation: launch.owner.generation,
        originalTarget: originUi.targetId, ownerTarget: ownerUi.targetId, observerExternal: observed.controls?.external,
        ownerWorkbenchTarget, ownerRoleFile, ownerExtensionMode: 'Test', inheritedTestContext: true, candidateBytesMatch: true, ownerMochaLoaded: false });
      const expectedOwner = launch.owner;
      const readOwnerUi = async <T>(expression: string): Promise<T> => {
        try { return await ownerUi!.evaluate<T>(expression); }
        catch (error) {
          const message = error instanceof Error ? error.message : '';
          if (!/Session with given id not found|Cannot find context with specified id|Cannot find context with id|Execution context was destroyed|The VS Code CDP connection closed/i.test(message)) throw error;
          const verifyOwner = async () => {
            const current = await readTaskWorkspace(globalStorage, spec.taskWorkspace!.workspaceFile);
            assert.equal(current.binding.taskId, taskId);
            assert.equal(current.owner?.pid, expectedOwner.pid); assert.equal(current.owner?.generation, expectedOwner.generation);
          };
          await verifyOwner();
          const previousTarget = ownerUi!.targetId;
          await ownerUi!.close().catch(() => {});
          // Completion can open SPEC.md, hiding and destroying the non-retained webview.
          // Reveal only the Codex panel through the exact owner's native command palette.
          await ownerWorkbenchPage.keyboard.press('F1');
          const commandInput = ownerWorkbenchPage.locator('.quick-input-widget input').first();
          await commandInput.waitFor({ state: 'visible', timeout: 10_000 });
          await commandInput.fill('>GitLab Workspace: 開啟 Codex');
          const command = ownerWorkbenchPage.locator('.quick-input-list .monaco-list-row').filter({ hasText: 'GitLab Workspace: 開啟 Codex' });
          await command.waitFor({ state: 'visible', timeout: 10_000 });
          assert.equal(await command.count(), 1, 'the navigation must resolve exactly the Codex workbench command');
          await command.click();
          ownerUi = await findOwner();
          await verifyOwner();
          journal.push({ phase: 'reconnecting-owner-read', reason: sanitizeDiagnostic(message), navigation: 'GitLab Workspace: 開啟 Codex', previousTarget, ownerTarget: ownerUi.targetId,
            taskId, ownerPid: expectedOwner.pid, generation: expectedOwner.generation });
          // Only the read is retried once. Questions, file/command approvals and all clicks remain outside this helper.
          return ownerUi.evaluate<T>(expression);
        }
      };
      const answers = new Set<string>(), deadline = Date.now() + 600_000;
      phase = 'waiting-for-model-artifacts';
      let completed: CodexTaskState | undefined;
      while (Date.now() < deadline) {
        const task = await currentTask(); assert.ok(task);
        if (['failed', 'interrupted', 'uncertain'].includes(task.status)) throw new Error(task.error ?? `Group task ended as ${task.status}`);
        if (task.status === 'completed' && task.result) { completed = task; break; }
        const forms = await readOwnerUi<Array<{ id: string; questions: number; secret: boolean; disabled: boolean }>>(`
          [...document.querySelectorAll('.codex-interaction')].filter(form => form.getClientRects().length).map(form => ({
            id: form.getAttribute('aria-labelledby'), questions: form.querySelectorAll('.codex-question').length,
            secret: !!form.querySelector('input[type="password"]'), disabled: form.querySelector('button[type="submit"]')?.disabled === true }))`);
        for (const form of forms) {
          if (answers.has(form.id) || form.disabled) continue;
          if (!form.questions || form.secret) throw new Error('A live Group tool or secret request requires human review; no approval was granted');
          assert.ok(answers.size < 10, 'the minimal Group scenario may not loop indefinitely asking for requirements');
          const selector = `.codex-interaction[aria-labelledby=${JSON.stringify(form.id)}]`;
          for (let index = 0; index < form.questions; index++) await ownerUi.fill(`${selector} .codex-question input[type="text"]`,
            '唯一需求是 service 已提交版本的 add 回傳 a + b，沿用既有測試；其他 Repo 列明影響證據。只產生本機規格和 Issue 草稿，不開始 Build、不提交、不推送、不建立 Issue或任何遠端寫入。採最小合理預設完成文件。', index);
          await ownerUi.click(`${selector} button[type="submit"]`); answers.add(form.id);
          await ownerUi.waitForHidden(selector, 30_000);
        }
        await delay(300);
      }
      assert.ok(completed, 'the real model did not finish the Group documents within the bounded deadline');
      assert.equal(completed.result?.state, 'ready', completed.result?.summary ?? 'the Group result is not ready');
      phase = 'validating-persisted-results';
      const recordFile = path.join(globalStorage, 'codex-tasks', taskId! + '.json');
      const record = await wait(async () => {
        const saved = JSON.parse(await readFile(recordFile, 'utf8')) as CodexTaskRecord;
        return saved.lease?.released === true ? saved : undefined;
      }, 'a completed Group turn did not release its native process lease');
      assert.equal(record.ownerPid, launch.owner.pid); assert.equal(record.ownerGeneration, launch.owner.generation);
      assert.equal(record.cleanupState, undefined, 'documents awaiting Issue confirmation remain recoverable');
      assert.equal(record.lease?.released, true, 'a completed turn releases its native process lease before acceptance');
      const collected = await collectGroupAnalysis(spec), bundle = await readGroupIssueDrafts(spec);
      assert.equal(collected.state, 'ready'); assert.ok(bundle.bundle.drafts.length > 0);
      const artifacts: Record<string, string> = {};
      for (const name of ['SPEC.md', 'cards.md', 'sources.json', 'issues.json']) {
        const bytes: Buffer = await readFile(path.join(spec.groupAnalysis.outputRoot, name));
        assert.ok(bytes.length && !bytes.includes(Buffer.from(sentinel.marker)), 'uncommitted source content must not enter the documents');
        artifacts[name] = hash(bytes);
      }
      assert.deepEqual(await Promise.all(repositories.map(snapshot)), before, 'the model and Host leave original Repo content, refs and configuration unchanged');
      assert.deepEqual(await readFile(sentinelPath), sentinelBefore);
      assert.equal(completed.publication, undefined);
      assert.ok(!completed.delivery?.steps.some(step => step.kind !== 'commit'), 'the draft does not authorize any remote publication');
      const publish = await readOwnerUi<{ exists: boolean; disabled?: boolean }>(`(() => { const button = [...document.querySelectorAll('button')].find(item => item.textContent === '檢閱並建立 Issue');
        return { exists: !!button, disabled: button?.disabled }; })()`);
      assert.equal(publish.exists, true); assert.equal(publish.disabled, false);
      ownerStopped = true;
      await writeFile(path.join(evidence, 'group-results.json'), JSON.stringify({ schema: 'GitLabWorkspaceManagedGroupLive/v1', success: true,
        vscode: vscode.version, extensionVersion: extension.packageJSON.version, kitVersion: process.env.GLW_CODEX_LIVE_KIT_VERSION,
        taskId, sourceRoot: root, snapshots: before, owner: journal, status: completed.status, result: collected,
        artifactHashes: artifacts, draftCount: bundle.bundle.drafts.length, questionAnswers: answers.size, awaitingIssueConfirmation: true,
        secretEnvironmentKeys: secretNames, automaticApprovals: 0, remoteWrites: 0 }, null, 2));
    } catch (error) {
      if (originUi && !submissionStarted) {
        try {
          const launchUi = await originUi.evaluate(`(() => {
            const input = document.querySelector('#codex-launch-requirement');
            const recheck = [...document.querySelectorAll('.codex-launch-actions button')].find(item => item.textContent === '重新檢查');
            return { requirementExists: !!input, requirementDisabled: !input || input.matches(':disabled'), requirementLength: input?.value?.length,
              recheckExists: !!recheck, recheckDisabled: !recheck || recheck.disabled,
              status: document.querySelector('.codex-launch-actions [role="status"]')?.textContent }; })()`);
          journal.push({ phase: 'failed-launch-ui', launchUi });
        } catch { journal.push({ phase: 'failed-launch-ui', diagnosticUnavailable: true }); }
      }
      try { await pauseOwner(); } catch (stopError) { journal.push({ stopFailure: stopError instanceof Error ? stopError.message : 'Owner stop failed' }); }
      const message = error instanceof Error ? error.message : 'Group acceptance failed';
      await writeFile(path.join(evidence, 'group-failure.json'), JSON.stringify({ schema: 'GitLabWorkspaceManagedGroupLive/v1', success: false,
        phase, taskId, ownerStopped, journal, error: /token|authorization|private-token/i.test(message) ? 'Sensitive diagnostic omitted' : message,
        tasks: bridge.list().map(task => ({ id: task.id, status: task.status, external: task.controls?.external, resultState: task.result?.state })),
        diagnostics: await failureDiagnostics(bridge, host) }, null, 2));
      throw error;
    } finally {
      await ownerUi?.close(); await originUi?.close(); await browser.close();
      // This original Host owns no managed execution; only its observer connection is disposed here.
      await host.shutdownCodex();
    }
  });
});
