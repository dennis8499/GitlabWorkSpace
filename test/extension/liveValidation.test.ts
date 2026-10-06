import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import * as vscode from 'vscode';
import { chromium, type Frame, type Page } from 'playwright-core';
import { execFileSync } from 'node:child_process';
import type { GitLabSession } from '../../src/connection/session';

interface TestExtensionApi {
  session: GitLabSession;
  setFetchForTesting(fetcher: typeof fetch): void;
  getGitRepositoryState(): Promise<{ repositories: Array<{ path: string; name: string; branches?: Array<{ name: string; kind: 'local' | 'remote' | 'tag'; current: boolean }> }>; available: boolean; message?: string }>;
  setGitWarningPromptHandlerForTesting(handler: (message: string, options: vscode.MessageOptions, ...items: string[]) => Promise<string | undefined>): void;
  setGitActionTraceHandlerForTesting(handler: (event: { phase: 'start' | 'complete' | 'error'; repositoryId: string; action: string; error?: string }) => void): void;
}
interface ApiMetric { path: string; method: string; status: number; bytes: number | null; elapsedMs: number; }
interface TestWarningPrompt { message: string; modal: boolean; items: string[]; result?: string; }
interface TestGitActionTrace { phase: 'start' | 'complete' | 'error'; repositoryId: string; action: string; error?: string; }

const enabled = process.env.GLW_LIVE_ENVIRONMENT === 'ce19' || process.env.GLW_LIVE_ENVIRONMENT === 'ce16';
const localGitGuiEnabled = process.env.GLW_LOCAL_GIT_GUI === '1';
suite('Live GitLab Workspace Webview validation', function () {
  this.timeout(120_000);

  test('exercises the packaged Git GUI against an isolated local bare remote', async function () {
    if (!localGitGuiEnabled) this.skip();
    this.timeout(300_000);
    assert.equal(vscode.version, '1.140.0', 'the packaged Git GUI is loaded in the pinned VS Code Extension Host');
    const extension = vscode.extensions.getExtension('local-dev.gitlab-workspace');
    assert.ok(extension, 'the packaged project extension is loaded in the actual Extension Host');
    assert.equal(extension.packageJSON.version, process.env.GLW_LIVE_EXPECTED_VERSION, 'the actual packaged VSIX is loaded');
    const api = await extension.activate() as TestExtensionApi | undefined;
    assert.ok(api?.session, 'the packaged extension is active without a GitLab connection');
    const workspaceRoot = process.env.GLW_LIVE_WORKSPACE_ROOT!;
    const reportPath = process.env.GLW_LOCAL_GIT_GUI_REPORT!;
      const warningPrompts: TestWarningPrompt[] = [];
      const actionTrace: TestGitActionTrace[] = [];
      const nativeConfirmation = process.env.GLW_LOCAL_GIT_GUI_NATIVE_CONFIRM === '1';
      const promptRace: { beforeForcePush?: () => void } = {};
      if (!nativeConfirmation) {
        api.setGitWarningPromptHandlerForTesting(async (message, options, ...items) => {
          const result = items[0];
          warningPrompts.push({ message, modal: options.modal === true, items, ...(result ? { result } : {}) });
          if (items.includes('Force Push') && promptRace.beforeForcePush) {
            const changeRemote = promptRace.beforeForcePush;
            promptRace.beforeForcePush = undefined;
            changeRemote();
          }
          return result;
        });
      }
      api.setGitActionTraceHandlerForTesting((event) => actionTrace.push(event));
      const gitDiscoveryStarted = performance.now();
      let initialGitState = await api.getGitRepositoryState();
      let gitDiscoveryMs = 0;
      let remoteBranchNames: string[] = [];
    const port = Number(process.env.GLW_LIVE_CDP_PORT);
    const runId = process.env.GLW_RUN_ID || `local-git-gui-${Date.now()}`;
    let browser: Awaited<ReturnType<typeof chromium.connectOverCDP>> | undefined;
    let ui: WebviewCdp | undefined;
    try {
      mkdirSync(path.join(path.dirname(reportPath), 'screenshots'), { recursive: true });
      browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, { timeout: 25_000 });
      const context = browser.contexts()[0];
      assert.ok(context, 'the isolated VS Code Chromium context is available over CDP');
      const page = await waitForWorkbenchPage(context.pages());
      await vscode.commands.executeCommand('gitlabWorkspace.openGitMode');
      await page.locator('iframe.webview').waitFor({ state: 'attached', timeout: 20_000 });
      ui = await connectWorkspaceWebview(browser, port, path.join(path.dirname(reportPath), 'local-git-gui-cdp-targets.json'), path.join(path.dirname(reportPath), 'local-git-gui-webview-debug.json'));
      await ui.waitForVisible('.git-workbench', 20_000);
      while (!initialGitState.repositories.some((repository) => path.resolve(repository.path).toLocaleLowerCase('en-US') === path.resolve(workspaceRoot).toLocaleLowerCase('en-US')) && performance.now() - gitDiscoveryStarted < 30_000) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        initialGitState = await api.getGitRepositoryState();
      }
      gitDiscoveryMs = Number((performance.now() - gitDiscoveryStarted).toFixed(2));
      const discoveredRepository = initialGitState.repositories.find((repository) => path.resolve(repository.path).toLocaleLowerCase('en-US') === path.resolve(workspaceRoot).toLocaleLowerCase('en-US'));
      assert.ok(discoveredRepository,
        `VS Code Git discovers the isolated demonstration Repo (${JSON.stringify(initialGitState)})`);
      remoteBranchNames = discoveredRepository.branches?.filter((branch) => branch.kind === 'remote').map((branch) => branch.name) ?? [];
      assert.ok(remoteBranchNames.includes('origin/main'), `the branch list uses canonical remote names (${remoteBranchNames.join(', ')})`);
      assert.ok(!remoteBranchNames.some((name) => name.startsWith('origin/origin/')), `remote names are not prefixed twice (${remoteBranchNames.join(', ')})`);
      await ui.waitUntil(`([...document.querySelectorAll('.git-repo-picker select option')].some((option) => option.textContent?.toLocaleLowerCase('en-US').includes('service')))`, 20_000,
        'The open Git GUI receives the Repo after VS Code Git finishes asynchronous repository discovery.');
      const gitGui = await exerciseGitGui(ui, page, workspaceRoot, runId, warningPrompts, false, promptRace);
      await page.screenshot({ path: path.join(path.dirname(reportPath), 'screenshots', 'local-git-gui.png') });
      const status = gitGui.committed === true && gitGui.pushedWithUpstream === true ? 'PASS' : gitGui.commitUi && typeof gitGui.commitUi === 'object' && 'error' in gitGui.commitUi && Boolean(gitGui.commitUi.error) ? 'FAIL' : 'BLOCKED';
      writeFileSync(reportPath, `${JSON.stringify({
        schema: 'GitLabWorkspaceLocalGitGuiEvidence/v1', generatedAt: new Date().toISOString(),
        mode: 'local-only', vscodeVersion: vscode.version,
        testedArtifact: { vsix: process.env.GLW_LIVE_VSIX, sha256: process.env.GLW_LIVE_VSIX_SHA256 },
        repository: workspaceRoot, remoteKind: 'isolated-local-bare-repository', status, gitDiscoveryMs, initialGitState, remoteBranchNames,
        interactiveConfirmationUI: status !== 'PASS' ? 'NOT_COMPLETE' :
          gitGui.commitConfirmation === 'workbench-dom' && gitGui.pushConfirmation === 'workbench-dom' ? 'PASS: both native VS Code modal confirmations were presented and clicked through the Workbench DOM.' :
          'BLOCKED: Commit/Push decisions used the Extension Host test adapter because the isolated VS Code modal was unavailable.',
        warningPrompts, actionTrace, gitGui
      }, null, 2)}\n`, 'utf8');
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Local Git GUI validation failed.';
      writeFileSync(reportPath, `${JSON.stringify({
        schema: 'GitLabWorkspaceLocalGitGuiEvidence/v1', generatedAt: new Date().toISOString(),
        mode: 'local-only', vscodeVersion: vscode.version,
        testedArtifact: { vsix: process.env.GLW_LIVE_VSIX, sha256: process.env.GLW_LIVE_VSIX_SHA256 },
        status: 'FAIL', error: message, workspaceFolders: vscode.workspace.workspaceFolders?.map((folder) => folder.uri.fsPath),
        nativeGitRepositoryState: await api.getGitRepositoryState().catch((stateError: unknown) => ({
          repositories: [], available: false, message: stateError instanceof Error ? stateError.message : String(stateError)
        })),
        actionTrace
      }, null, 2)}\n`, 'utf8');
      throw error;
    } finally {
      await ui?.close();
      if (browser) await browser.close();
    }
  });

  test('authenticates in SecretStorage and renders the real GitLab Workspace Webview through CDP', async function () {
  if (!enabled) this.skip();
  assert.equal(vscode.version, '1.140.0', 'the real Extension Host uses the pinned local VS Code version');
  const environment = process.env.GLW_LIVE_ENVIRONMENT!;
  const baseUrl = process.env.GLW_LIVE_BASE_URL!;
  const groupPath = process.env.GLW_LIVE_GROUP_PATH!;
  const workspaceRoot = process.env.GLW_LIVE_WORKSPACE_ROOT!;
  const reportPath = process.env.GLW_LIVE_REPORT!;
  let token = process.env.GLW_LIVE_TOKEN!;
  assert.ok(token && new URL(baseUrl).hostname === '127.0.0.1');

  const extension = vscode.extensions.getExtension('local-dev.gitlab-workspace');
  assert.ok(extension, 'the project extension is loaded in the actual Extension Host');
  assert.equal(extension.packageJSON.version, process.env.GLW_LIVE_EXPECTED_VERSION, 'the actual packaged VSIX is loaded');
  const api = await extension.activate() as TestExtensionApi | undefined;
  assert.ok(api?.session, 'test mode exposes only the live GitLab session handle');

  const metrics: ApiMetric[] = [];
  const originalFetch = globalThis.fetch;
  api.setFetchForTesting(async (input, init) => {
    const requestUrl = new URL(typeof input === 'string' || input instanceof URL ? input.toString() : input.url);
    const started = performance.now();
    const response = await originalFetch(input, init);
    if (requestUrl.origin === baseUrl) metrics.push({
      path: requestUrl.pathname.replace(/^\/api\/(?:v\d+\/)?/, ''), method: init?.method ?? 'GET', status: response.status,
      bytes: Number(response.headers.get('content-length')) || (await response.clone().arrayBuffer()).byteLength,
      elapsedMs: Number((performance.now() - started).toFixed(2))
    });
    return response;
  });

  let browser;
  let ui: WebviewCdp | undefined;
  try {
    await assert.rejects(api.session.connect(baseUrl, 'invalid-live-validation-token'), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.doesNotMatch(error.message, /invalid-live-validation-token|private-token|authorization/i);
      return true;
    });
    assert.equal(api.session.baseUrl, undefined, 'a rejected token is not persisted in the extension SecretStorage');
    const connected = await api.session.connect(baseUrl, token);
    process.env.GLW_LIVE_TOKEN = '';
    assert.ok(connected.id > 0, 'GitLab validated the token against the requested localhost server');
    const initialSchemaRequests = metrics.filter((item) => item.path === 'graphql' && item.method === 'POST').length;
    assert.ok(initialSchemaRequests > 0, `the real Schema detection reached the GitLab GraphQL endpoint (requests: ${JSON.stringify(metrics.map(({ path, method, status }) => ({ path, method, status })))})`);
    const schemaByteLengths = metrics.filter((item) => item.path === 'graphql' && item.method === 'POST').map((item) => item.bytes).filter((item): item is number => item !== null);
    const firstCapabilitySnapshot = (api.session as unknown as { state: { get<T>(key: string): T } }).state.get<{ scope: string }>('gitlabWorkspace.issueCapabilities.v1');
    const expectedCapabilityScope = JSON.stringify([baseUrl, connected.id, api.session.metadata?.version ?? null, api.session.metadata?.revision ?? null, api.session.metadata?.enterprise ?? null]);
    assert.equal(firstCapabilitySnapshot?.scope, expectedCapabilityScope, `GitLab's live capability probe was cached under its instance and account scope (${JSON.stringify({ metadata: api.session.metadata, cachedScope: firstCapabilitySnapshot?.scope })})`);

    await api.session.connect(baseUrl, token);
    token = '';
    const reconnectSchemaRequests = metrics.filter((item) => item.path === 'graphql' && item.method === 'POST').length;
    const cachedCapabilities = (api.session as unknown as { state: { get<T>(key: string): T } }).state.get('gitlabWorkspace.issueCapabilities.v1');
    assert.equal(reconnectSchemaRequests, initialSchemaRequests,
      `same-account reconnect reuses the persistent, version-scoped capability cache (${JSON.stringify({ metadata: api.session.metadata, capabilities: api.session.issueCapabilities, diagnostics: api.session.capabilityDiagnostics, cachedCapabilities, graphql: metrics.filter((item) => item.path === 'graphql') })})`);
    const groups = await api.session.cachedRead('live-validation-groups', (client) => client.listGroups(), { force: true });
    const group = groups.find((candidate) => candidate.full_path === groupPath);
    assert.ok(group, `the isolated ${environment} demo subgroup is visible to the connected user`);
    await vscode.commands.executeCommand('gitlabWorkspace.selectGroup', group);
    await vscode.commands.executeCommand('gitlabWorkspace.openCloneMode');

    const cdpPort = Number(process.env.GLW_LIVE_CDP_PORT);
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${cdpPort}`, { timeout: 25_000 });
    const context = browser.contexts()[0];
    assert.ok(context, 'the isolated VS Code Chromium context is available over CDP');
    const page = await waitForWorkbenchPage(context.pages());
    await page.locator('iframe.webview').waitFor({ state: 'attached', timeout: 20_000 });
    ui = await connectWorkspaceWebview(browser, cdpPort, path.join(path.dirname(reportPath), `${environment}-cdp-targets.json`), path.join(path.dirname(reportPath), `${environment}-webview-cdp-debug.json`), originalFetch);
    const screenshotDir = path.join(path.dirname(reportPath), 'screenshots');
    mkdirSync(screenshotDir, { recursive: true });
    if (process.env.GLW_LIVE_ROUND === '1') await page.screenshot({ path: path.join(screenshotDir, `${environment}-clone.png`) });
    await ui.waitForVisible('.clone-list-column', 20_000);
    const visibleRepoCount = await ui.text('.clone-list-column .count');
    assert.match(visibleRepoCount ?? '', /3/);
    const cloneText = await ui.text('body');
    for (const project of ['contracts', 'service', 'client']) assert.ok(cloneText?.includes(`${groupPath}/${project}`), `the GUI lists the isolated ${project} Repo`);

    await ui.click('.settings-trigger');
    await ui.waitForVisible('.tool-drawer');
    await ui.click('.instance-capabilities button');
    await ui.waitForProperty('.instance-capabilities button', 'disabled', true, 10_000);
    await ui.waitForProperty('.instance-capabilities button', 'disabled', false, 30_000);
    const refreshedSchemaRequests = metrics.filter((item) => item.path === 'graphql' && item.method === 'POST').length;
    assert.ok(refreshedSchemaRequests > reconnectSchemaRequests, 'the settings panel manual-detection action reaches GraphQL again');
    const refreshedSchemaByteLengths = metrics.filter((item) => item.path === 'graphql' && item.method === 'POST').slice(initialSchemaRequests).map((item) => item.bytes).filter((item): item is number => item !== null);
    await ui.click('.drawer-heading button');

    const latencyMs: number[] = [];
    const modes = ['gitlabWorkspace.openGitMode', 'gitlabWorkspace.openCloneMode'];
    for (let index = 0; index < 30; index++) {
      const started = performance.now();
      await vscode.commands.executeCommand(modes[index % modes.length]);
      await ui.waitForVisible(index % modes.length === 0 ? '.git-workbench' : '.clone-list-column', 10_000);
      latencyMs.push(Number((performance.now() - started).toFixed(2)));
    }
    const bytes = await ui.htmlBytes();
    const gitGui = process.env.GLW_LIVE_GIT_GUI === '1' ? await exerciseGitGui(ui, page, workspaceRoot, process.env.GLW_RUN_ID || 'work-20261006-livevalidation') : undefined;
    const screenshotPath = gitGui ? path.join(screenshotDir, `${environment}-git-gui.png`) : undefined;
    if (screenshotPath && process.env.GLW_LIVE_ROUND === '1') await page.screenshot({ path: screenshotPath });

    const report = {
      schema: 'GitLabWorkspaceLiveExtensionEvidence/v1', generatedAt: new Date().toISOString(),
      environment, baseUrl, version: api.session.metadata?.version, revision: api.session.metadata?.revision ?? null,
      vscodeVersion: vscode.version, currentUserId: connected.id, selectedGroup: group.full_path,
      testedArtifact: { vsix: process.env.GLW_LIVE_VSIX, sha256: process.env.GLW_LIVE_VSIX_SHA256 },
      projects: groupPath, visibleRepoCount,
      schemaBytes: { initial: schemaByteLengths.reduce((sum, value) => sum + value, 0), afterManualDetection: refreshedSchemaByteLengths.reduce((sum, value) => sum + value, 0) },
      schemaGraphQlRequests: metrics.filter((item) => item.path === 'graphql' && item.method === 'POST').length,
      api: metrics, webview: { viewport: await page.evaluate(() => ({ width: innerWidth, height: innerHeight })), frameBytes: bytes },
      warmNavigationMs: { samples: latencyMs, median: percentile(latencyMs, 0.5), p95: percentile(latencyMs, 0.95) }, gitGui,
      screenshots: [path.relative(path.dirname(reportPath), path.join(screenshotDir, `${environment}-clone.png`)), ...(screenshotPath ? [path.relative(path.dirname(reportPath), screenshotPath)] : [])]
    };
    writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  } catch (error) {
    let message = error instanceof Error ? error.message : 'Live GitLab Workspace validation failed.';
    const secrets = [token, process.env.GLW_LIVE_TOKEN, 'invalid-live-validation-token']
      .filter((secret): secret is string => Boolean(secret));
    for (const secret of secrets) {
      message = message.split(secret).join('[redacted]');
    }
    const status = /timed out|fetch failed|ECONNREFUSED|network error/i.test(message) ? 'BLOCKED' : 'FAIL';
    writeFileSync(reportPath, `${JSON.stringify({
      schema: 'GitLabWorkspaceLiveExtensionEvidence/v1', generatedAt: new Date().toISOString(),
      environment, baseUrl, expectedGitLabVersion: environment === 'ce19' ? '19.4.1' : '16.11.10',
      vscodeVersion: vscode.version, testedArtifact: { vsix: process.env.GLW_LIVE_VSIX, sha256: process.env.GLW_LIVE_VSIX_SHA256 },
      status, error: message
    }, null, 2)}\n`, 'utf8');
    throw error;
  } finally {
    process.env.GLW_LIVE_TOKEN = '';
    await ui?.close();
    if (browser) await browser.close();
  }
  });
});

async function waitForWorkbenchPage(pages: Page[]): Promise<Page> {
  for (let attempt = 0; attempt < 40; attempt++) {
    const page = pages.find((candidate) => /workbench\.html|vscode-file:/.test(candidate.url()));
    if (page) return page;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`No VS Code workbench page was found over CDP (${pages.map((page) => page.url()).join(', ') || 'no pages'}).`);
}

async function connectWorkspaceWebview(
  browser: Awaited<ReturnType<typeof chromium.connectOverCDP>>,
  port: number,
  targetEvidencePath: string,
  debugEvidencePath: string,
  request: typeof fetch = fetch
): Promise<WebviewCdp> {
  const browserCdp = await browser.newBrowserCDPSession();
  let targets: { targetInfos?: Array<{ targetId: string; type: string; url: string }> } = {};
  let webviewTargets: Array<{ targetId: string }> = [];
  const deadline = Date.now() + 20_000;
  try {
    while (Date.now() < deadline) {
      targets = await browserCdp.send('Target.getTargets') as typeof targets;
      webviewTargets = (targets.targetInfos ?? []).filter((target) => target.type === 'iframe' && target.url.startsWith('vscode-webview://'));
      if (webviewTargets.length) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  } finally {
    await browserCdp.detach();
  }
  writeFileSync(targetEvidencePath, `${JSON.stringify(targets, null, 2)}\n`, 'utf8');
  const devtools = await request(`http://127.0.0.1:${port}/json/version`).then((response) => response.json()) as { webSocketDebuggerUrl?: string };
  return WebviewCdp.connect(devtools.webSocketDebuggerUrl!, webviewTargets, debugEvidencePath);
}

type CdpMessage = { id?: number; result?: Record<string, unknown>; error?: { message?: string } };
type CdpRemoteObject = { result?: { value?: unknown }; exceptionDetails?: { text?: string } };

class RawCdpConnection {
  private sequence = 0;
  private readonly pending = new Map<number, { resolve: (value: Record<string, unknown>) => void; reject: (error: Error) => void }>();

  private constructor(private readonly socket: WebSocket) {
    socket.addEventListener('message', (event) => {
      let message: CdpMessage;
      try { message = JSON.parse(String(event.data)) as CdpMessage; } catch { return; }
      if (message.id === undefined) return;
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(message.error.message ?? 'Chromium rejected a CDP request.'));
      else pending.resolve(message.result ?? {});
    });
    socket.addEventListener('close', () => {
      for (const pending of this.pending.values()) pending.reject(new Error('The VS Code CDP connection closed.'));
      this.pending.clear();
    });
  }

  static async connect(address: string): Promise<RawCdpConnection> {
    const socket = new WebSocket(address);
    await new Promise<void>((resolve, reject) => {
      socket.addEventListener('open', () => resolve(), { once: true });
      socket.addEventListener('error', () => reject(new Error('Could not open the VS Code CDP WebSocket.')), { once: true });
    });
    return new RawCdpConnection(socket);
  }

  send(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<Record<string, unknown>> {
    const id = ++this.sequence;
    const promise = new Promise<Record<string, unknown>>((resolve, reject) => this.pending.set(id, { resolve, reject }));
    this.socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    return promise;
  }

  close(): void { this.socket.close(); }
}

class WebviewCdp {
  private constructor(private readonly connection: RawCdpConnection, private readonly sessionId: string) {}

  static async connect(address: string, candidates: Array<{ targetId: string }>, diagnosticPath: string): Promise<WebviewCdp> {
    if (!address || !candidates.length) throw new Error('Chromium did not expose a VS Code Webview target.');
    const connection = await RawCdpConnection.connect(address);
    const diagnostics: unknown[] = [];
    try {
      for (const candidate of candidates) {
        const attached = await connection.send('Target.attachToTarget', { targetId: candidate.targetId, flatten: true });
        const sessionId = attached.sessionId;
        if (typeof sessionId !== 'string') continue;
        const webview = new WebviewCdp(connection, sessionId);
        await webview.send('Runtime.enable');
        const firstInspection = await webview.evaluate(`({href: location.href, readyState: document.readyState, title: document.title, body: document.body?.innerText?.slice(0, 350), frames: [...document.querySelectorAll('iframe')].map((item) => ({src: item.src, readyState: item.contentDocument?.readyState, title: item.contentDocument?.title, body: item.contentDocument?.body?.innerText?.slice(0, 500), bodyHtml: item.contentDocument?.body?.innerHTML?.slice(0, 350)})), clone: !!document.querySelector('.clone-list-column')})`).catch((error) => `evaluate failed: ${String(error)}`);
        diagnostics.push({ targetId: candidate.targetId, firstInspection });
        for (let attempt = 0; attempt < 100; attempt++) {
          const ready = await webview.evaluate<boolean>(`Boolean(document.querySelector('.app-shell, .git-workbench'))`).catch(() => false);
          if (ready) return webview;
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
        await connection.send('Target.detachFromTarget', { sessionId }).catch(() => undefined);
      }
    } catch (error) {
      connection.close();
      throw error;
    }
    writeFileSync(diagnosticPath, `${JSON.stringify(diagnostics, null, 2)}\n`, 'utf8');
    connection.close();
    throw new Error(`VS Code exposed Webview targets, but none contains the GitLab Workspace UI (${JSON.stringify(diagnostics)}).`);
  }

  private send(method: string, params: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    return this.connection.send(method, params, this.sessionId);
  }

  async evaluate<T>(expression: string): Promise<T> {
    const webviewExpression = `(() => { const find = (doc, depth = 0) => { if (!doc || depth > 6) return null; if (doc.querySelector('.app-shell, .git-workbench')) return doc; for (const iframe of doc.querySelectorAll('iframe')) { try { const result = find(iframe.contentDocument, depth + 1); if (result) return result; } catch {} } return null; }; const document = find(window.document) ?? window.document; return (${expression}); })()`;
    const response = await this.send('Runtime.evaluate', { expression: webviewExpression, awaitPromise: true, returnByValue: true, userGesture: true }) as unknown as CdpRemoteObject;
    if (response.exceptionDetails) throw new Error(response.exceptionDetails.text ?? 'Webview JavaScript evaluation failed.');
    return response.result?.value as T;
  }

  async waitForVisible(selector: string, timeoutMs = 10_000): Promise<void> {
    await this.waitUntil(`(() => { const e = document.querySelector(${JSON.stringify(selector)}); return !!e && e.getClientRects().length > 0; })()`, timeoutMs, `Webview element ${selector} did not become visible.`);
  }

  async waitForHidden(selector: string, timeoutMs = 20_000): Promise<void> {
    await this.waitUntil(`(() => { const e = document.querySelector(${JSON.stringify(selector)}); return !e || e.getClientRects().length === 0; })()`, timeoutMs, `Webview element ${selector} did not become hidden.`);
  }

  async waitForProperty(selector: string, property: 'disabled', value: boolean, timeoutMs = 10_000): Promise<void> {
    await this.waitUntil(`(() => { const e = document.querySelector(${JSON.stringify(selector)}); return !!e && e.disabled === ${value}; })()`, timeoutMs, `Webview control ${selector} did not reach disabled=${value}.`);
  }

  async click(selector: string, index = 0): Promise<void> {
    const clicked = await this.evaluate<boolean>(`(() => { const e = document.querySelectorAll(${JSON.stringify(selector)})[${index}]; if (!e) return false; e.click(); return true; })()`);
    if (!clicked) throw new Error(`Could not click Webview element ${selector}[${index}].`);
  }

  async fill(selector: string, value: string, index = 0): Promise<void> {
    const focused = await this.evaluate<string | null>(`(() => {
      const e = document.querySelectorAll(${JSON.stringify(selector)})[${index}];
      if (!e || !('value' in e)) return null;
      e.focus();
      if (e.tagName === 'SELECT') return 'select';
      if (typeof e.select === 'function') e.select();
      return 'text';
    })()`);
    if (focused === 'text') await this.send('Input.insertText', { text: value });
    else if (focused === 'select') {
      const selected = await this.evaluate<boolean>(`(() => {
        const e = document.querySelectorAll(${JSON.stringify(selector)})[${index}];
        const view = e?.ownerDocument.defaultView;
        if (!e || !view) return false;
        Object.getOwnPropertyDescriptor(view.HTMLSelectElement.prototype, 'value')?.set?.call(e, ${JSON.stringify(value)});
        e.dispatchEvent(new view.Event('change', { bubbles: true }));
        return true;
      })()`);
      if (!selected) throw new Error(`Could not select a value in Webview element ${selector}[${index}].`);
    } else throw new Error(`Could not focus Webview element ${selector}[${index}].`);
  }

  async selectOptionContaining(selector: string, text: string): Promise<void> {
    const selected = await this.evaluate<boolean>(`(() => {
      const e = document.querySelector(${JSON.stringify(selector)});
      const option = e && [...e.options].find((item) => item.textContent?.toLowerCase().includes(${JSON.stringify(text.toLowerCase())}));
      const view = e?.ownerDocument.defaultView;
      if (!e || !option || !view) return false;
      Object.getOwnPropertyDescriptor(view.HTMLSelectElement.prototype, 'value')?.set?.call(e, option.value);
      e.dispatchEvent(new view.Event('change', { bubbles: true }));
      return true;
    })()`);
    if (!selected) throw new Error(`Could not select a Webview option containing ${text}.`);
  }

  async setChecked(selector: string, checked: boolean, index = 0): Promise<void> {
    const changed = await this.evaluate<boolean>(`(() => { const e = document.querySelectorAll(${JSON.stringify(selector)})[${index}]; if (!e || !('checked' in e)) return false; if (e.checked !== ${checked}) e.click(); return true; })()`);
    if (!changed) throw new Error(`Could not set Webview checkbox ${selector}[${index}].`);
  }

  async text(selector: string): Promise<string | null> {
    return this.evaluate<string | null>(`document.querySelector(${JSON.stringify(selector)})?.textContent ?? null`);
  }

  async count(selector: string): Promise<number> {
    return this.evaluate<number>(`document.querySelectorAll(${JSON.stringify(selector)}).length`);
  }

  async htmlBytes(): Promise<number> {
    return this.evaluate<number>(`new TextEncoder().encode(document.body.innerHTML).length`);
  }

  async waitUntil(expression: string, timeoutMs: number, message: string): Promise<void> {
    const started = performance.now();
    while (performance.now() - started < timeoutMs) {
      if (await this.evaluate<boolean>(expression).catch(() => false)) return;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const preview = await this.text('body').catch(() => null);
    throw new Error(`${message}${preview ? ` (${preview.slice(0, 700)})` : ''}`);
  }

  async close(): Promise<void> {
    await this.connection.send('Target.detachFromTarget', { sessionId: this.sessionId }).catch(() => undefined);
    this.connection.close();
  }
}

function percentile(values: number[], fraction: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length ? Number(sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)].toFixed(2)) : 0;
}

async function exerciseGitGui(ui: WebviewCdp, page: Page, workspaceRoot: string, runId: string, warningPrompts: TestWarningPrompt[] = [], openWorkspace = true, promptRace: { beforeForcePush?: () => void } = {}): Promise<Record<string, unknown>> {
  const confirmationDialogs: string[] = [];
  page.on('dialog', async (dialog) => {
    const message = dialog.message();
    confirmationDialogs.push(message);
    if (/commit|push/i.test(message)) await dialog.accept();
    else await dialog.dismiss();
  });
  if (openWorkspace) await vscode.commands.executeCommand('gitlabWorkspace.openGitMode');
  await ui.waitForVisible('.git-workbench', 20_000);
  await ui.waitForVisible('.git-repo-picker select', 20_000);
  await ui.waitUntil(`[...document.querySelectorAll('.git-repo-picker option')].some((option) => option.textContent?.toLowerCase().includes('service'))`, 25_000, 'VS Code did not discover the isolated service Repo for the Git GUI.');
  await ui.selectOptionContaining('.git-repo-picker select', 'service');
  await ui.waitUntil(`document.querySelector('.git-repo-heading strong')?.textContent?.toLowerCase().includes('service')`, 15_000, 'The Git GUI did not activate the service Repo.');
  await ui.waitForVisible('.git-toolbar > button.secondary', 20_000);
  await ui.waitForProperty('.git-toolbar > button.secondary', 'disabled', false, 20_000);
  const playwrightWebview = await findPlaywrightFrame(page, '.git-commit-launch');
  const repoPath = path.basename(path.resolve(workspaceRoot)).toLocaleLowerCase('en-US') === 'service'
    ? workspaceRoot : path.join(workspaceRoot, 'service');
  const trackedFile = path.join(repoPath, 'service.ts');
  assert.ok(existsSync(trackedFile), 'the selected Demo Service repository is present in the disposable workspace');
  const currentBranch = execFileSync('git', ['branch', '--show-current'], { cwd: repoPath, encoding: 'utf8' }).trim();
  const branch = `validation/${runId}/${Date.now().toString(36)}`;

  await ui.click('.git-toolbar > button.secondary');
  await ui.waitForVisible('.git-dialog input[name="name"]', 5_000);
  await ui.fill('.git-dialog input[name="name"]', branch);
  await ui.waitUntil(`document.querySelector('.git-dialog input[name="name"]')?.value === ${JSON.stringify(branch)}`, 5_000, 'The Git GUI did not retain the new branch name.');
  assert.equal(await ui.evaluate<string | null>(`new FormData(document.querySelector('.git-dialog')).get('name')`), branch, 'the branch form contains the exact value entered through the real Webview keyboard input path');
  await ui.click('.git-dialog button[type="submit"]');
  try {
    await ui.waitUntil(`(() => { const select = document.querySelector('.git-branch-picker select'); return !!select && [...select.options].some((option) => option.value === ${JSON.stringify(branch)}) && select.value === ${JSON.stringify(branch)}; })()`, 15_000, 'The Git GUI did not switch to the new branch.');
  } catch {
    const picker = await ui.evaluate(`(() => { const select = document.querySelector('.git-branch-picker select'); return { value: select?.value, options: [...(select?.options ?? [])].map((option) => option.value), current: document.querySelector('.git-branch-chip')?.textContent }; })()`);
    assert.fail(`The Git GUI did not reflect the checked-out branch from the Git repository (${JSON.stringify(picker)}).`);
  }
  await waitForGitState(repoPath, ['branch', '--show-current'], (output) => output.trim() === branch, 'The branch is checked out in the actual local Git repository.');

  const original = await import('node:fs/promises').then(({ readFile }) => readFile(trackedFile, 'utf8'));
  const markerA = `// live GUI partial-stage ${runId}`;
  const markerB = `// live GUI whole-file stage ${runId}`;
  writeFileSync(trackedFile, `${original.trimEnd()}\n${markerA}\n${markerB}\n`, 'utf8');
  await ui.waitUntil(`Boolean(document.querySelector('.git-change-name')?.textContent?.includes('service.ts'))`, 15_000, 'The Git GUI did not refresh after the working tree changed.');
  await ui.click('.git-change-name');
  await ui.waitForVisible('.git-diff-line.add input[type="checkbox"]');
  assert.equal(await ui.count('.git-diff-line.add input[type="checkbox"]'), 2, 'the real Git diff exposes both added lines for line-level staging');
  await ui.setChecked('.git-diff-line.add input[type="checkbox"]', true, 0);
  await ui.click('.git-diff-actions button', 0);
  await waitForGitUiAction(ui);
  const indexAfterPartial = await waitForGitState(repoPath, ['diff', '--cached', '--numstat'], (output) => /^1\s+0\s+service\.ts$/.test(output.trim()), 'Exactly one added line is staged through the Git GUI.');

  await ui.click('.git-change-section .git-change-row button.quiet.small', 0);
  await waitForGitUiAction(ui);
  await waitForGitState(repoPath, ['diff', '--cached', '--numstat'], (output) => output.trim() === '', 'The Git GUI cancels staging for the entire file.');
  const beforeWholeFileStage = await ui.evaluate(`(() => ({
    selected: document.querySelector('.git-diff-heading')?.textContent,
    fileSections: [...document.querySelectorAll('.git-change-section')].map((section) => ({ title: section.querySelector('h3')?.textContent, rows: [...section.querySelectorAll('.git-change-row')].map((row) => ({ name: row.querySelector('.git-change-name')?.textContent, buttons: [...row.querySelectorAll('button')].map((button) => ({ title: button.title, disabled: button.disabled })) })) })),
    diffButtons: [...document.querySelectorAll('.git-diff-actions button')].map((button) => ({ title: button.title, text: button.textContent, disabled: button.disabled })),
    progress: document.querySelector('.git-progress')?.textContent ?? null,
    error: document.querySelector('.dashboard-error')?.textContent ?? null
  }))()`);
  await ui.click('.git-change-section .git-change-row button.quiet.small', 0);
  await waitForGitUiAction(ui);
  let indexAfterWholeFile: string;
  try { indexAfterWholeFile = await waitForGitState(repoPath, ['diff', '--cached', '--numstat'], (output) => /^2\s+0\s+service\.ts$/.test(output.trim()), 'The whole-file stage includes both added lines.'); }
  catch (error) {
    const afterWholeFileStage = await ui.evaluate(`(() => ({
      selected: document.querySelector('.git-diff-heading')?.textContent,
      fileSections: [...document.querySelectorAll('.git-change-section')].map((section) => ({ title: section.querySelector('h3')?.textContent, rows: [...section.querySelectorAll('.git-change-row')].map((row) => ({ name: row.querySelector('.git-change-name')?.textContent, buttons: [...row.querySelectorAll('button')].map((button) => ({ title: button.title, disabled: button.disabled })) })) })),
      diffButtons: [...document.querySelectorAll('.git-diff-actions button')].map((button) => ({ title: button.title, text: button.textContent, disabled: button.disabled })),
      progress: document.querySelector('.git-progress')?.textContent ?? null,
      error: document.querySelector('.dashboard-error')?.textContent ?? null
    }))()`);
    throw new Error(`${String(error)} (UI before whole-file stage: ${JSON.stringify(beforeWholeFileStage)}; UI after: ${JSON.stringify(afterWholeFileStage)})`);
  }
  await playwrightWebview.locator('.git-commit-launch').click();
  const commitMessage = `GUI validation ${runId}`;
  await playwrightWebview.locator('.git-dialog textarea[name="message"]').fill(commitMessage);
  assert.equal(await ui.evaluate<string | null>(`new FormData(document.querySelector('.git-dialog')).get('message')`), commitMessage, 'the commit form contains the exact message typed through the Webview keyboard path');
  await page.bringToFront();
  await playwrightWebview.locator('.git-dialog button[type="submit"]').click();
  await ui.waitForVisible('.git-progress', 10_000);
  const commitDomConfirmed = await confirmWorkbenchDialog(page, ui, 'Commit');
  const commitBrowserDialog = confirmationDialogs.find((message) => /commit/i.test(message));
  const commitTestAdapter = warningPrompts.some((prompt) => prompt.modal && prompt.items.includes('Commit') && prompt.result === 'Commit');
  if (!commitDomConfirmed && !commitBrowserDialog && !commitTestAdapter) {
    const commitUi = await ui.evaluate(`(() => ({
      pending: document.querySelector('.git-progress')?.textContent ?? null,
      error: document.querySelector('.dashboard-error')?.textContent ?? null,
      dialog: document.querySelector('.git-dialog')?.textContent ?? null,
      staged: [...document.querySelectorAll('.git-change-section')].map((section) => ({ title: section.querySelector('h3')?.textContent, files: [...section.querySelectorAll('.git-change-name')].map((file) => file.textContent) }))
    }))()`);
    return { branch, previousBranch: currentBranch, stagedPartialLines: 1, stagedWholeFileLines: 2,
      indexAfterPartial: indexAfterPartial.trim(), indexAfterWholeFile: indexAfterWholeFile.trim(),
      commitConfirmation: 'BLOCKED: VS Code did not expose the Commit confirmation to the isolated test host.',
      committed: false, push: 'NOT_RUN', warningPrompts, confirmationDialogs, commitUi };
  }
  await ui.waitForHidden('.git-progress', 30_000);
  const commitSubject = await waitForGitState(repoPath, ['log', '-1', '--format=%s'], (output) => output.includes(`GUI validation ${runId}`), 'The staged changes appear in the committed Git history.');

  await ui.click('.git-actions-menu summary');
  await ui.click('.git-actions-popup button', 2);
  await ui.waitForVisible('.git-dialog');
  const pushForm = await ui.evaluate(`Object.fromEntries(new FormData(document.querySelector('.git-dialog')).entries())`);
  await ui.click('.git-dialog button[type="submit"]');
  await ui.waitForVisible('.git-progress', 10_000);
  const pushDomConfirmed = await confirmWorkbenchDialog(page, ui, 'Push');
  const pushBrowserDialog = confirmationDialogs.find((message) => /push/i.test(message));
  const pushTestAdapter = warningPrompts.some((prompt) => prompt.modal && prompt.items.includes('Push') && prompt.result === 'Push');
  if (!pushDomConfirmed && !pushBrowserDialog && !pushTestAdapter) {
    const pushUi = await ui.evaluate(`(() => ({
      pending: document.querySelector('.git-progress')?.textContent ?? null,
      error: document.querySelector('.dashboard-error')?.textContent ?? null,
      dialog: document.querySelector('.git-dialog')?.textContent ?? null,
      dialogValues: document.querySelector('.git-dialog') ? Object.fromEntries(new FormData(document.querySelector('.git-dialog')).entries()) : null,
      menuOpen: document.querySelector('.git-actions-menu')?.open ?? false
    }))()`);
    const remoteBranch = execFileSync('git', ['ls-remote', 'origin', 'refs/heads/' + branch], { cwd: repoPath, encoding: 'utf8' }).trim();
    return { branch, previousBranch: currentBranch, stagedPartialLines: 1, stagedWholeFileLines: 2,
      indexAfterPartial: indexAfterPartial.trim(), indexAfterWholeFile: indexAfterWholeFile.trim(),
      commitMessage: commitSubject.trim(), committed: true,
      push: 'BLOCKED: VS Code did not expose the Push confirmation to the isolated test host.', warningPrompts, confirmationDialogs, pushUi, pushForm, remoteBranch };
  }
  await ui.waitForHidden('.git-progress', 30_000);
  const upstream = await waitForGitState(repoPath, ['rev-parse', '--abbrev-ref', '@{upstream}'], (output) => output.includes(`origin/${branch}`), 'The Push action set the upstream to the matching remote branch.');

  await ui.click('.git-tabbar button[role="tab"]', 1);
  await ui.waitForVisible('.git-commit-list');
  await ui.waitUntil(`document.querySelector('.git-commit-list')?.textContent?.includes(${JSON.stringify(`GUI validation ${runId}`)})`, 10_000, 'The Git GUI history did not show the new commit.');
  const commits = await ui.count('.git-commit-row');
  const advancedActions = localGitGuiEnabled ? await exerciseAdvancedGitGui(ui, repoPath, runId, promptRace, playwrightWebview) : undefined;
  return { branch, previousBranch: currentBranch, stagedPartialLines: 1, stagedWholeFileLines: 2,
    indexAfterPartial: indexAfterPartial.trim(), indexAfterWholeFile: indexAfterWholeFile.trim(),
    commitMessage: commitSubject.trim(), committed: true, commitConfirmation: commitDomConfirmed ? 'workbench-dom' : commitBrowserDialog ? 'browser-dialog' : 'test-adapter',
    pushConfirmation: pushDomConfirmed ? 'workbench-dom' : pushBrowserDialog ? 'browser-dialog' : 'test-adapter', upstream: upstream.trim(), pushedWithUpstream: true, historyRows: commits,
    warningPrompts, confirmationDialogs, ...(advancedActions ? { advancedActions } : {}) };
}

async function exerciseAdvancedGitGui(ui: WebviewCdp, repoPath: string, runId: string, promptRace: { beforeForcePush?: () => void }, playwrightWebview: Frame): Promise<Record<string, unknown>> {
  const runGit = (args: string[], cwd = repoPath) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const openMenuAction = async (index: number): Promise<void> => {
    const alreadyOpen = await ui.evaluate<boolean>(`document.querySelector('.git-actions-menu')?.open === true`);
    if (!alreadyOpen) {
      await ui.click('.git-actions-menu summary');
      await ui.waitUntil(`document.querySelector('.git-actions-menu')?.open === true`, 5_000, 'The Git GUI advanced action menu did not open.');
    }
    await ui.click('.git-actions-popup button', index);
    await ui.waitForVisible('.git-dialog', 5_000);
  };
  const submitGuiAction = async (): Promise<void> => {
    await ui.click('.git-dialog button[type="submit"]');
    await waitForGitUiAction(ui);
  };
  const appendMarker = async (marker: string): Promise<void> => {
    const trackedFile = path.join(repoPath, 'service.ts');
    const { readFile } = await import('node:fs/promises');
    const original = await readFile(trackedFile, 'utf8');
    writeFileSync(trackedFile, `${original.trimEnd()}\n// ${marker}\n`, 'utf8');
    await ui.waitUntil(`Boolean(document.querySelector('.git-change-name')?.textContent?.includes('service.ts'))`, 10_000,
      'The Git GUI did not refresh after preparing the isolated Repo change.');
  };

  await ui.click('.git-tabbar button[role="tab"]', 0);
  const stashA = `GUI stash A ${runId}`;
  const stashB = `GUI stash B ${runId}`;
  await appendMarker(stashA);
  await openMenuAction(5);
  await ui.fill('.git-dialog input[name="message"]', stashA);
  await submitGuiAction();
  const stashAfterA = await waitForGitState(repoPath, ['stash', 'list', '--format=%gs'], (value) => value.includes(stashA), 'The Git GUI saved the first Stash.');
  assert.equal(runGit(['status', '--porcelain']), '', 'Creating a Stash clears the prepared working-tree change.');

  await appendMarker(stashB);
  await openMenuAction(5);
  await ui.fill('.git-dialog input[name="message"]', stashB);
  await submitGuiAction();
  const stashAfterB = runGit(['stash', 'list', '--format=%gs']);
  assert.ok(stashAfterB.includes(stashA) && stashAfterB.includes(stashB), 'The Git GUI retains multiple Stashes in order.');

  await openMenuAction(6);
  await ui.fill('.git-dialog select[name="operation"]', 'pop');
  await submitGuiAction();
  const stashAfterPop = runGit(['stash', 'list', '--format=%gs']);
  assert.ok(stashAfterPop.includes(stashA) && !stashAfterPop.includes(stashB), 'Pop applies and removes only the selected newest Stash.');
  assert.ok(readFileSync(path.join(repoPath, 'service.ts'), 'utf8').includes(stashB), 'The popped change is restored to the working tree.');

  await openMenuAction(6);
  await ui.fill('.git-dialog select[name="operation"]', 'drop');
  await submitGuiAction();
  assert.equal(runGit(['stash', 'list', '--format=%gs']), '', 'The confirmed Stash drop removes the selected Stash.');

  await ui.click('.git-change-section .git-change-row button[title="先建立復原 Stash，再還原此檔"]');
  await waitForGitUiAction(ui);
  const recoveredStash = runGit(['stash', 'list', '--format=%gs']);
  assert.match(recoveredStash, /GitLab Workspace 復原點/, 'Discard stores the file in a recovery Stash before restoring the worktree.');
  assert.equal(runGit(['status', '--porcelain']), '', 'Discard restores the tracked file to a clean worktree.');
  assert.ok(!readFileSync(path.join(repoPath, 'service.ts'), 'utf8').includes(stashB), 'Discard removes the popped marker from the working file.');

  const bareRemote = runGit(['remote', 'get-url', 'origin']);
  const fixtureRoot = path.dirname(path.dirname(repoPath));
  const peerPath = path.join(fixtureRoot, `peer-${runId.replace(/[^a-z0-9-]/gi, '-')}`);
  execFileSync('git', ['clone', '--branch', 'main', bareRemote, peerPath], { stdio: 'ignore', windowsHide: true });
  execFileSync('git', ['config', 'user.name', 'GitLab Workspace Validation'], { cwd: peerPath, stdio: 'ignore', windowsHide: true });
  execFileSync('git', ['config', 'user.email', 'gitlab-workspace-validation@localhost'], { cwd: peerPath, stdio: 'ignore', windowsHide: true });
  const remoteMarker = `remote-fetch-${runId.replace(/[^a-z0-9-]/gi, '-')}.txt`;
  writeFileSync(path.join(peerPath, remoteMarker), `Created for ${runId}\n`, 'utf8');
  execFileSync('git', ['add', '--', remoteMarker], { cwd: peerPath, stdio: 'ignore', windowsHide: true });
  execFileSync('git', ['commit', '-m', `Prepare remote Pull ${runId}`], { cwd: peerPath, stdio: 'ignore', windowsHide: true });
  execFileSync('git', ['push', 'origin', 'main'], { cwd: peerPath, stdio: 'ignore', windowsHide: true });
  const expectedRemoteMain = runGit(['--git-dir', bareRemote, 'rev-parse', 'refs/heads/main']);

  await openMenuAction(0);
  await submitGuiAction();
  const fetchedMain = runGit(['rev-parse', 'refs/remotes/origin/main']);
  assert.equal(fetchedMain, expectedRemoteMain, 'Fetch updates the remote-tracking ref from the isolated bare remote.');

  await openMenuAction(1);
  await ui.fill('.git-dialog input[name="branch"]', 'main');
  await ui.fill('.git-dialog select[name="strategy"]', 'merge');
  await submitGuiAction();
  const pulledFile = readFileSync(path.join(repoPath, remoteMarker), 'utf8');
  assert.ok(pulledFile.includes(runId), 'Pull merges the newly fetched remote default-branch commit through the Git GUI.');
  assert.equal(runGit(['merge-base', '--is-ancestor', expectedRemoteMain, 'HEAD'], repoPath), '', 'The fetched default branch is integrated into the current branch.');

  const rebaseBranch = runGit(['branch', '--show-current']);
  const rebaseBase = `validation/rebase-base-${runId.replace(/[^a-z0-9-]/gi, '-')}`;
  runGit(['branch', rebaseBase]);
  const rebaseSubjects = Array.from({ length: 6 }, (_, index) => `GUI rebase ${index + 1} ${runId}`);
  for (let index = 0; index < rebaseSubjects.length; index++) {
    const filename = `gui-rebase-${index + 1}-${runId.replace(/[^a-z0-9-]/gi, '-')}.txt`;
    writeFileSync(path.join(repoPath, filename), `${rebaseSubjects[index]}\n`, 'utf8');
    runGit(['add', '--', filename]);
    runGit(['commit', '-m', rebaseSubjects[index]]);
  }

  await openMenuAction(4);
  await playwrightWebview.locator('.git-dialog select[name="ref"]').selectOption(rebaseBase);
  assert.equal(await ui.evaluate<string>(`document.querySelector('.git-dialog select[name="ref"]')?.value ?? ''`), rebaseBase,
    'The interactive Rebase target is selected in the actual Webview form.');
  await ui.setChecked('.git-dialog input[name="interactive"]', true);
  await ui.click('.git-dialog button[type="submit"]');
  try {
    await ui.waitUntil('document.querySelectorAll(".git-rebase-todo-row select").length === 6', 15_000,
      'The Git GUI displays all six commits in the interactive Rebase editor.');
  } catch (error) {
    const rebaseUi = await ui.evaluate(`(() => ({
      dialog: document.querySelector('.git-dialog')?.innerText ?? null,
      dashboardError: document.querySelector('.dashboard-error')?.innerText ?? null,
      dialogError: document.querySelector('.git-dialog [role="alert"]')?.innerText ?? null,
      progress: document.querySelector('.git-progress')?.innerText ?? null,
      action: [...document.querySelectorAll('.git-actions-popup button')].map((button) => ({ text: button.innerText, disabled: button.disabled })),
      branches: [...(document.querySelector('.git-dialog select[name="ref"]')?.options ?? [])].map((option) => option.value),
      interactive: document.querySelector('.git-dialog input[name="interactive"]')?.checked ?? null,
      todoRows: document.querySelectorAll('.git-rebase-todo-row').length
    }))()`);
    throw new Error(`${String(error)} (Rebase UI: ${JSON.stringify(rebaseUi)})`);
  }
  const rebaseActions = ['pick', 'reword', 'edit', 'squash', 'fixup', 'drop'];
  for (let index = 0; index < rebaseActions.length; index++) {
    await ui.fill('.git-rebase-todo-row select', rebaseActions[index], index);
  }
  const rewordMessage = `GUI rebase reworded ${runId}`;
  const squashMessage = `GUI rebase squashed ${runId}`;
  await ui.fill('.git-rebase-todo-row textarea', rewordMessage, 0);
  await ui.fill('.git-rebase-todo-row textarea', squashMessage, 1);
  const todoActions = await ui.evaluate<string[]>(`[...document.querySelectorAll('.git-rebase-todo-row select')].map((control) => control.value)`);
  assert.deepEqual(todoActions, rebaseActions, 'The six supported interactive Rebase actions are configured through the real Webview form.');
  await ui.click('.git-dialog button[type="submit"]');
  await waitForGitUiAction(ui);
  await ui.waitUntil('Boolean(document.querySelector(".git-operation-banner"))', 15_000,
    'The interactive Rebase pauses at the selected edit commit.');
  assert.ok(runGit(['rev-parse', '--git-path', 'rebase-merge']), 'The native Git repository records the expected paused Rebase operation.');
  const actionsMenuOpen = await ui.evaluate<boolean>(`document.querySelector('.git-actions-menu')?.open === true`);
  if (!actionsMenuOpen) await ui.click('.git-actions-menu summary');
  const continued = await ui.evaluate<boolean>(`(() => { const button = [...document.querySelectorAll('.git-actions-popup button')].find((item) => item.textContent?.includes('繼續')); if (!button) return false; button.click(); return true; })()`);
  assert.ok(continued, 'The Git GUI exposes Continue for the edit pause.');
  await waitForGitUiAction(ui);
  await ui.waitUntil('!document.querySelector(".git-operation-banner")', 20_000,
    'The Git GUI continues the interactive Rebase after the edit pause.');
  const rebasedSubjects = runGit(['log', '--format=%s', `${rebaseBase}..HEAD`]).split(/\r?\n/).filter(Boolean);
  assert.equal(rebasedSubjects.length, 3, 'Pick, reword, edit, squash, fixup, and drop produce three final commits.');
  assert.ok(rebasedSubjects.includes(rewordMessage) && rebasedSubjects.includes(squashMessage),
    `Reword and Squash use the exact messages entered in the Webview (${JSON.stringify(rebasedSubjects)}).`);
  assert.ok(!rebasedSubjects.some((subject) => subject.includes('GUI rebase 6 ')), 'Drop omits the selected commit from the resulting history.');
  assert.equal(runGit(['branch', '--show-current']), rebaseBranch, 'Interactive Rebase keeps the original feature branch checked out.');

  await ui.click('.git-tabbar button[role="tab"]', 0);
  const amendFile = `gui-amend-${runId.replace(/[^a-z0-9-]/gi, '-')}.txt`;
  const amendMessage = `GUI amend ${runId}`;
  const headBeforeAmend = runGit(['rev-parse', 'HEAD']);
  const parentBeforeAmend = runGit(['rev-parse', 'HEAD^']);
  writeFileSync(path.join(repoPath, amendFile), `${amendMessage}\n`, 'utf8');
  await ui.waitUntil(`Boolean([...document.querySelectorAll('.git-change-name')].some((item) => item.textContent?.includes(${JSON.stringify(amendFile)})))`, 10_000,
    'The Git GUI refreshes the working-tree list for the Amend fixture.');
  const changeRows = await ui.evaluate<string[]>(`[...document.querySelectorAll('.git-change-section .git-change-row')].map((row) => row.querySelector('.git-change-name')?.textContent ?? '')`);
  const amendRow = changeRows.findIndex((name) => name.includes(amendFile));
  assert.ok(amendRow >= 0, 'The Amend fixture is visible as a real Git change row.');
  await ui.click('.git-change-section .git-change-row button.quiet.small', amendRow);
  await waitForGitUiAction(ui);
  assert.match(runGit(['diff', '--cached', '--name-only']), new RegExp(amendFile), 'The Amend fixture is staged through the Git GUI.');
  await ui.click('.git-tabbar button.quiet');
  await ui.waitForVisible('.git-dialog textarea[name="message"]');
  await ui.fill('.git-dialog textarea[name="message"]', amendMessage);
  assert.equal(await ui.evaluate<boolean>(`document.querySelector('.git-dialog input[name="amend"]')?.checked === true`), true,
    'The Amend checkbox is selected in the real Webview form.');
  await submitGuiAction();
  const amendedHead = runGit(['rev-parse', 'HEAD']);
  assert.notEqual(amendedHead, headBeforeAmend, 'Amend replaces the current commit SHA.');
  assert.equal(runGit(['rev-parse', 'HEAD^']), parentBeforeAmend, 'Amend preserves the replaced commit parent.');
  assert.equal(runGit(['log', '-1', '--format=%s']), amendMessage, 'Amend stores the exact replacement message.');
  assert.ok(runGit(['for-each-ref', '--format=%(refname)', 'refs/gitlab-workspace/backups']).trim(),
    'Amend creates a recovery reference before rewriting history.');

  await openMenuAction(2);
  await ui.setChecked('.git-dialog input[name="force"]', true);
  await submitGuiAction();
  const forcePushSha = runGit(['ls-remote', 'origin', `refs/heads/${rebaseBranch}`]).split(/\s+/)[0];
  assert.equal(forcePushSha, amendedHead, 'Force-with-lease updates the remote only while its preflight SHA still matches.');

  const raceTree = runGit(['rev-parse', 'HEAD^{tree}']);
  const raceCommit = runGit(['commit-tree', raceTree, '-p', amendedHead, '-m', `Concurrent remote update ${runId}`]);
  promptRace.beforeForcePush = () => execFileSync('git', ['push', '--force', 'origin', `${raceCommit}:refs/heads/${rebaseBranch}`], {
    cwd: repoPath, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true
  });
  await openMenuAction(2);
  await ui.setChecked('.git-dialog input[name="force"]', true);
  await submitGuiAction();
  const leaseRaceError = await ui.text('.dashboard-error');
  assert.ok(leaseRaceError?.includes('SHA'), `The Git GUI reports a remote SHA drift instead of overwriting it (${leaseRaceError ?? 'no error'}).`);
  assert.equal(runGit(['ls-remote', 'origin', `refs/heads/${rebaseBranch}`]).split(/\s+/)[0], raceCommit,
    'Force-with-lease preserves the concurrent remote update.');
  assert.equal(runGit(['rev-parse', 'HEAD']), amendedHead, 'A rejected Force Push leaves the local branch unchanged.');

  const mergeBranch = `validation/merge-source-${runId.replace(/[^a-z0-9-]/gi, '-')}`;
  const mergeFile = `gui-merge-source-${runId.replace(/[^a-z0-9-]/gi, '-')}.txt`;
  const localMergeFile = `gui-merge-local-${runId.replace(/[^a-z0-9-]/gi, '-')}.txt`;
  runGit(['branch', mergeBranch]);
  runGit(['checkout', mergeBranch]);
  writeFileSync(path.join(repoPath, mergeFile), `Created on ${mergeBranch}\n`, 'utf8');
  runGit(['add', '--', mergeFile]);
  runGit(['commit', '-m', `GUI merge source ${runId}`]);
  const mergeSourceHead = runGit(['rev-parse', 'HEAD']);
  runGit(['checkout', rebaseBranch]);
  writeFileSync(path.join(repoPath, localMergeFile), `Created on ${rebaseBranch}\n`, 'utf8');
  runGit(['add', '--', localMergeFile]);
  runGit(['commit', '-m', `GUI merge local ${runId}`]);
  const localMergeHead = runGit(['rev-parse', 'HEAD']);

  await openMenuAction(3);
  await playwrightWebview.locator('.git-dialog select[name="ref"]').selectOption(mergeBranch);
  await submitGuiAction();
  const mergeHead = runGit(['rev-parse', 'HEAD']);
  const mergeParents = runGit(['show', '-s', '--format=%P', 'HEAD']).split(/\s+/);
  assert.equal(mergeParents.length, 2, 'The GUI Merge creates a two-parent merge commit for diverged branches.');
  assert.ok(mergeParents.includes(mergeSourceHead) && mergeParents.includes(localMergeHead), 'The GUI Merge retains both source histories.');
  assert.ok(readFileSync(path.join(repoPath, mergeFile), 'utf8').includes(mergeBranch), 'The GUI Merge brings in the source branch file.');
  assert.ok(readFileSync(path.join(repoPath, localMergeFile), 'utf8').includes(rebaseBranch), 'The GUI Merge preserves the current branch file.');
  const mergeSubject = runGit(['log', '-1', '--format=%s']);

  await ui.click('.git-tabbar button[role="tab"]', 1);
  await ui.waitUntil(`document.querySelector('.git-commit-list')?.textContent?.includes(${JSON.stringify(mergeSubject)})`, 10_000,
    'The Git GUI history displays the merge commit.');
  await ui.click('.git-commit-row', 0);
  await ui.waitForVisible('.git-commit-detail select');
  await playwrightWebview.locator('.git-commit-detail select').selectOption(mergeParents[1]);
  assert.equal(await ui.evaluate<string>(`document.querySelector('.git-commit-detail select')?.value ?? ''`), mergeParents[1],
    'The Git GUI switches the selected Merge Parent.');
  await ui.waitUntil(`([...document.querySelectorAll('.git-commit-files button')].some((button) => button.textContent?.includes(${JSON.stringify(localMergeFile)})))`, 10_000,
    'The Git GUI reloads the commit file list for the selected Merge Parent.');
  const mergeDiffFile = localMergeFile;
  const mergeDiffIndex = await ui.evaluate<number>(`[...document.querySelectorAll('.git-commit-files button')].findIndex((button) => button.textContent?.includes(${JSON.stringify(mergeDiffFile)}))`);
  assert.ok(mergeDiffIndex >= 0, 'The selected merge parent exposes a file list for Diff review.');
  await ui.click('.git-commit-files button', mergeDiffIndex);
  try {
    await ui.waitUntil(`(() => { const preview = document.querySelector('.git-commit-diff-preview'); return preview?.querySelector('h4')?.textContent?.includes(${JSON.stringify(mergeDiffFile)}) && preview.textContent?.includes('Parent 2') && preview.querySelector('.git-diff-view')?.textContent?.includes(${JSON.stringify(`Created on ${rebaseBranch}`)}); })()`, 10_000,
      'The Git GUI opens a file Diff under the selected Merge Parent.');
  } catch (error) {
    const diffUi = await ui.evaluate(`(() => ({
      heading: document.querySelector('.git-diff-heading')?.innerText ?? null,
      detail: document.querySelector('.git-commit-detail')?.innerText ?? null,
      selectedParent: document.querySelector('.git-commit-detail select')?.value ?? null,
      selectedFiles: [...document.querySelectorAll('.git-commit-files button')].map((button) => button.textContent),
      progress: document.querySelector('.git-progress')?.innerText ?? null,
      error: document.querySelector('.dashboard-error')?.innerText ?? null,
      diffText: document.querySelector('.git-diff-view')?.innerText?.slice(0, 800) ?? null
    }))()`);
    throw new Error(`${String(error)} (Merge Parent Diff UI: ${JSON.stringify(diffUi)})`);
  }

  const pickFile = `gui-pick-${runId.replace(/[^a-z0-9-]/gi, '-')}.txt`;
  const pickMessage = `GUI pick target ${runId}`;
  writeFileSync(path.join(repoPath, pickFile), `${pickMessage}\n`, 'utf8');
  runGit(['add', '--', pickFile]);
  runGit(['commit', '-m', pickMessage]);
  const pickSourceHead = runGit(['rev-parse', 'HEAD']);
  await ui.click('.git-tabbar button[role="tab"]', 0);
  await ui.click('.git-tabbar button[role="tab"]', 1);
  const selectHistoryCommit = async (): Promise<void> => {
    await ui.waitUntil(`([...document.querySelectorAll('.git-commit-row')].some((row) => row.textContent?.includes(${JSON.stringify(pickMessage)})))`, 10_000,
      'The Git GUI history exposes the selected Cherry-pick/Revert source commit.');
    const clicked = await ui.evaluate<boolean>(`(() => { const row = [...document.querySelectorAll('.git-commit-row')].find((item) => item.textContent?.includes(${JSON.stringify(pickMessage)})); if (!row) return false; row.click(); return true; })()`);
    assert.ok(clicked, 'The source commit is selected from the actual Git GUI history list.');
    await ui.waitUntil(`document.querySelector('.git-commit-detail')?.textContent?.includes(${JSON.stringify(pickMessage)})`, 10_000,
      'The Git GUI loads the selected commit detail.');
  };

  await selectHistoryCommit();
  await ui.click('.git-commit-actions button', 1);
  await ui.waitForVisible('.git-dialog');
  assert.equal(await ui.evaluate<string>(`document.querySelector('.git-dialog select[name="operation"]')?.value ?? ''`), 'revert',
    'The Git GUI dialog selects Revert when opened from the Revert action.');
  await submitGuiAction();
  assert.equal(existsSync(path.join(repoPath, pickFile)), false, 'Revert removes the selected commit file from the working tree.');
  assert.ok(runGit(['log', '-1', '--format=%s']).includes('Revert'), 'The GUI Revert records a new inverse commit.');
  const revertHead = runGit(['rev-parse', 'HEAD']);

  await selectHistoryCommit();
  await ui.click('.git-commit-actions button', 0);
  await ui.waitForVisible('.git-dialog');
  assert.equal(await ui.evaluate<string>(`document.querySelector('.git-dialog select[name="operation"]')?.value ?? ''`), 'cherryPick',
    'The Git GUI dialog selects Cherry-pick when opened from the Cherry-pick action.');
  await submitGuiAction();
  assert.equal(runGit(['rev-parse', 'HEAD^']), revertHead, 'Cherry-pick applies the selected source commit on top of the Revert commit.');
  assert.equal(readFileSync(path.join(repoPath, pickFile), 'utf8').replace(/\r\n/g, '\n'), `${pickMessage}\n`, 'Cherry-pick restores the selected commit content.');

  return {
    stashA: stashAfterA.trim(), stashPopLeavesOlderEntry: stashAfterPop.trim(),
    stashDropAndDiscardRecovery: recoveredStash.trim(),
    fetchRemoteMain: fetchedMain, pulledRemoteFile: remoteMarker,
    pullMergeHead: runGit(['log', '-1', '--format=%H %P %s']),
    interactiveRebase: { actions: rebaseActions, pauseAndContinue: true, resultingSubjects: rebasedSubjects },
    amend: { previousHead: headBeforeAmend, newHead: amendedHead, message: amendMessage, parent: parentBeforeAmend },
    forceWithLease: { pushedSha: forcePushSha, raceCommit, rejectedRaceMessage: leaseRaceError },
    merge: { branch: mergeBranch, head: mergeHead, parents: mergeParents, parentDiff: { selectedParent: mergeParents[1], file: mergeDiffFile } },
    revertAndCherryPick: { sourceCommit: pickSourceHead, file: pickFile, revertAndReplay: true }
  };
}

async function findPlaywrightFrame(page: Page, selector: string): Promise<Frame> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    for (const frame of page.frames()) {
      try { if (await frame.locator(selector).count()) return frame; } catch { /* the webview frame can navigate during startup */ }
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Playwright could not find ${selector} in any VS Code workbench frame (${page.frames().map((frame) => frame.url()).join(', ')}).`);
}

async function waitForGitState(repoPath: string, args: string[], matches: (output: string) => boolean, assertion: string, timeoutMs = 30_000): Promise<string> {
  const started = performance.now();
  let latest = '';
  while (performance.now() - started < timeoutMs) {
    try { latest = execFileSync('git', args, { cwd: repoPath, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }); }
    catch (error) { latest = error instanceof Error ? error.message : String(error); }
    if (matches(latest)) return latest;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.fail(`${assertion} (last Git output: ${latest.trim() || '(empty)'})`);
}

async function waitForGitUiAction(ui: WebviewCdp): Promise<void> {
  await ui.waitForVisible('.git-progress', 10_000);
  await ui.waitForHidden('.git-progress', 30_000);
}

async function confirmWorkbenchDialog(page: Page, ui: WebviewCdp, label: string): Promise<boolean> {
  const dialog = page.locator('.monaco-dialog-box');
  try { await dialog.waitFor({ state: 'visible', timeout: 5_000 }); }
  catch {
    const diagnostic = await page.evaluate(() => ({
      title: document.title,
      visibleDialogText: [...document.querySelectorAll('[role="dialog"], .monaco-dialog-box, .monaco-dialog')]
        .filter((element) => (element as HTMLElement).offsetParent !== null)
        .map((element) => ({ className: (element as HTMLElement).className, text: element.textContent?.slice(0, 1200) ?? '' })),
      bodyTextEnd: document.body.innerText.slice(-1600)
    })).catch((error: unknown) => ({ error: error instanceof Error ? error.message : String(error) }));
    const reportPath = process.env.GLW_LOCAL_GIT_GUI_REPORT;
    if (reportPath) {
      const evidenceRoot = path.dirname(reportPath);
      mkdirSync(path.join(evidenceRoot, 'screenshots'), { recursive: true });
      await page.screenshot({ path: path.join(evidenceRoot, 'screenshots', `${label.toLocaleLowerCase('en-US')}-native-confirmation.png`) }).catch(() => undefined);
      writeFileSync(path.join(evidenceRoot, `${label.toLocaleLowerCase('en-US')}-native-confirmation-debug.json`), `${JSON.stringify(diagnostic, null, 2)}\n`, 'utf8');
    }
    return false;
  }
  await dialog.getByRole('button', { name: label, exact: true }).click();
  return true;
}
