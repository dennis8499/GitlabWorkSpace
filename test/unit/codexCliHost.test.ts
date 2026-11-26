import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { CodexCliSource } from '../../src/codex/cliProtocol';
import type { ManualCodexResult, ManualCodexTerminal } from '../../src/codex/manualTerminal';
import type { CodexTerminalLaunch, CodexTerminalSelection } from '../../src/codex/terminal';
import { LocalNetworkLease, NetworkLeaseError, networkRuntimeRoot } from '../../src/api/localNetworkLease';
import { CodexReviewLeasePool, CodexWorkspaceLease } from '../../src/codex/workspaceLease';
import { OperationLog } from '../../src/logging/operationLog';
import * as managedRepository from '../../src/codex/managedRepository';
import { WorkflowKitService, WorkflowKitVersionMismatchError } from '../../src/workspace/workflowKitService';
import type { WorkflowKitStatusProof } from '../../src/workspace/workflowKitIntegration';
import type { InstalledWorkflowKitState } from '../../src/workspace/workspaceProtocol';
import * as workspacePaths from '../../src/workspace/workspacePaths';

const vscode = {
  workspace: { isTrusted: true, workspaceFolders: [] as Array<{ uri: { scheme: string; fsPath: string } }>, getConfiguration: () => ({
    get: <T>(_setting: string, fallback: T): T => fallback,
    inspect: (_setting: string): { globalValue?: unknown; workspaceValue?: unknown } | undefined => undefined
  }), createFileSystemWatcher: (_pattern: unknown) => ({
    onDidCreate: (_listener: () => void) => undefined, onDidChange: (_listener: () => void) => undefined, dispose() {}
  }) },
  RelativePattern: class { constructor(readonly base: string, readonly pattern: string) {} },
  TerminalExitReason: { Process: 2, Extension: 4 },
  window: { onDidCloseTerminal: () => ({ dispose() {} }) }
};
const moduleLoader = require('node:module') as { _load: (name: string, parent: unknown, main: boolean) => unknown };
const originalLoad = moduleLoader._load;
moduleLoader._load = (name, parent, main) => name === 'vscode' ? vscode : originalLoad(name, parent, main);
let WorkspacePanel: typeof import('../../src/workspace/workspacePanel').WorkspacePanel;
try { ({ WorkspacePanel } = require('../../src/workspace/workspacePanel')); }
finally { moduleLoader._load = originalLoad; }

const revision = 'verified-revision';
const skill: CodexCliSource = { kind: 'skill', featureId: 'commit-draft', inputs: { 'commit-draft.repo': 'verified' }, revision };
const bmad: CodexCliSource = { kind: 'bmad', request: { command: 'task', requirement: '核對本機變更', revision } };
const review: CodexCliSource = { kind: 'review', tool: 'release-reviewer', requestId: 'native-review-1', action: 'resume', revision };
const mergeRequest = (reviewerTool: 'merge-reviewer' | 'release-reviewer'): CodexCliSource =>
  ({ kind: 'merge-request', reviewerTool, projectId: 7, iid: 4, expectedScope: 'connected-scope' });

async function fixture(t: test.TestContext) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'glw-cli-host-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cwd = path.join(root, 'safe-runtime');
  const skillPath = path.join(root, '.agents', 'skills', 'fixture', 'SKILL.md');
  await mkdir(cwd);
  await mkdir(path.dirname(skillPath), { recursive: true });
  await writeFile(skillPath, 'Fixture skill');
  await writeFile(path.join(root, 'AGENTS.md'), 'Fixture workspace rules');

  const heads = { current: 'a'.repeat(40) };
  const project = { id: 7, http_url_to_repo: 'https://gitlab.test/team/project.git' };
  const calls: Array<{ action: string; data?: unknown }> = [];
  const selected: CodexTerminalSelection = { executable: { file: 'native-codex.exe', version: '0.169.0' }, model: 'fixture-model', effort: 'high' };
  const choices = { value: selected as CodexTerminalSelection | undefined };
  const changes = { canAccess: true, launchError: undefined as Error | undefined,
    exitStatus: { code: 0, reason: vscode.TerminalExitReason.Process } as { code?: number; reason: number } | undefined };
  const launched: Array<{ selection: CodexTerminalSelection; options: CodexTerminalLaunch }> = [];
  const nativeTerminal = {
    processId: Promise.resolve(process.pid),
    get exitStatus() { return changes.exitStatus; },
    show() { calls.push({ action: 'show' }); },
    dispose() {
      calls.push({ action: 'dispose' });
      changes.exitStatus = { reason: vscode.TerminalExitReason.Extension };
    }
  };
  const terminal = {
    choose: async (_configured: string, cwd: string) => { calls.push({ action: 'choose', data: cwd }); return choices.value; },
    launch: async (selection: CodexTerminalSelection, options: CodexTerminalLaunch, settings?: { manual?: ManualCodexTerminal }) => {
      calls.push({ action: 'launch' });
      if (changes.launchError) throw changes.launchError;
      launched.push({ selection, options });
      return settings?.manual?.terminal ?? nativeTerminal;
    }
  };
  const prepare = (action: string, data: unknown) => {
    calls.push({ action, data });
    return { title: 'Fixture review', root, executionRoot: cwd, writableRoots: [cwd], skill: { name: 'fixture', path: skillPath },
      prompt: 'Verified task prompt', finish: async () => { calls.push({ action: 'finish' }); },
      rollback: async () => { calls.push({ action: 'rollback' }); } };
  };
  const logs: string[] = [];
  const log = new OperationLog({ info() {}, warn(line) { logs.push(line); }, error(line) { logs.push(line); } });
  const host = Object.assign(Object.create(WorkspacePanel!.prototype), {
    disposed: false,
    resolveProjectContext: async () => ({ root }),
    captureProjectAccess: () => () => { if (!changes.canAccess) throw new Error('工作區已變更'); },
    codexExecutableSetting: () => '',
    codexManualStartSetting: () => undefined,
    operationPhase: () => undefined,
    getCodexTerminal: () => terminal,
    prepareCodexPowerShell: async () => '',
    post: () => undefined,
    cliTerminals: new Map(),
    cliSettlements: new Set(),
    cliRuns: new Map(),
    cliInputQueue: Promise.resolve(),
    codexReviewLeases: new CodexReviewLeasePool(),
    connectedScopeKey: () => 'connected-scope',
    currentUser: { id: 1 },
    session: { log, baseUrl: 'https://gitlab.test', getClient: async () => ({
      getProject: async () => project,
      getMergeRequest: async () => ({ project_id: 7, iid: 4, title: 'Fixed MR', target_branch: 'main', sha: heads.current }),
      getRepositoryBranch: async () => ({ name: 'main', commit: { id: 'b'.repeat(40) } })
    }) },
    resolveGroupProject: async () => project,
    linkedRepositoryCandidates: async () => [root],
    prepareSkillGuideTask: async (source: unknown) => prepare('skill', source),
    prepareBmadCli: async (request: unknown) => prepare('bmad', request),
    prepareNativeReviewCli: async (source: unknown) => prepare('review', source),
    locateReviewSession: async () => ({ root: path.join(root, 'native-runtime') }),
    prepareCliMergeRequest: async (source: unknown, binding: unknown, projectRoot: string, repository: string) =>
      prepare('merge-request', { source, binding, projectRoot, repository }),
    noteOutcome: (value: unknown) => calls.push({ action: 'outcome', data: value })
  });
  const leasePaths = [root, cwd].map(directory => path.join(networkRuntimeRoot(), 'codex-workspaces',
    createHash('sha256').update(process.platform === 'win32' ? directory.toLowerCase() : directory).digest('hex') + '.lock'));
  return { host, root, cwd, skillPath, heads, calls, selected, choices, changes, launched, terminal, leasePaths, logs };
}

function manualTerminal(f: Awaited<ReturnType<typeof fixture>>) {
  const controller = new AbortController();
  let request!: (accepted: boolean) => void;
  let exit!: (result: ManualCodexResult) => void;
  let show!: () => void;
  const shown = new Promise<void>(resolve => { show = resolve; });
  const cancel = () => { controller.abort(); request(false); exit({ state: 'not-started' }); };
  const manual: ManualCodexTerminal = {
    terminal: { show } as unknown as ManualCodexTerminal['terminal'],
    signal: controller.signal,
    requested: new Promise(resolve => { request = resolve; }),
    completion: new Promise(resolve => { exit = resolve; }),
    start() {}, reject: cancel, close: cancel
  };
  f.host.codexManualStartSetting = () => ({ powerShell: '' });
  f.host.openManualCodexTerminal = async () => manual;
  return { manual, shown, enter: () => request(true), exit };
}

function mrReviewTerminals(f: Awaited<ReturnType<typeof fixture>>) {
  const merge = manualTerminal(f), release = manualTerminal(f);
  f.host.openManualCodexTerminal = async (_root: string, _pwsh: string, _check: unknown, title: string) =>
    title.includes('MergeReviewer') ? merge.manual : release.manual;
  const start = (tool: 'merge-reviewer' | 'release-reviewer'): Promise<void> =>
    f.host.dispatchMessage({ type: 'runCodexCli', source: mergeRequest(tool) });
  return { merge, release, start };
}

const git = (cwd: string, ...args: string[]): string => execFileSync('git', ['-C', cwd,
  '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false',
  '-c', 'core.longpaths=true', ...args], { windowsHide: true, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

function latch() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

const mergeReviewerPayload = '.agents/skills/merge-reviewer/scripts/review_session.py';
const releaseReviewerPayload = '.agents/skills/release-reviewer/scripts/review_session.py';

async function mrWorkflowKit(t: test.TestContext, f: Awaited<ReturnType<typeof fixture>>,
  { initialVersion = '1.12.7', attestedRunner = true } = {}) {
  const digest = (text: string) => createHash('sha256').update(text).digest('hex');
  const assets = {
    '.agents/gitlab-workspace-kit/run.py': '# runner',
    '.agents/gitlab-workspace-kit/review_launch.py': '# launcher',
    '.agents/gitlab-workspace-kit/runner-capabilities.json': JSON.stringify({ schema: 'WorkflowKitRunnerCapabilities/v1',
      review_launch_request: 1, read_only_inspection: true, ...(attestedRunner ? { read_only_manifest_sha256: true } : {}) }),
    '.agents/skills/merge-reviewer/SKILL.md': '# MergeReviewer',
    '.agents/skills/merge-reviewer/VERSION': '0.26.1',
    [mergeReviewerPayload]: '# Fixture managed merge reviewer payload',
    '.agents/skills/release-reviewer/SKILL.md': '# ReleaseReviewer',
    '.agents/skills/release-reviewer/VERSION': '0.12.9',
    [releaseReviewerPayload]: '# Fixture managed reviewer payload'
  };
  for (const [name, bytes] of Object.entries(assets)) {
    const file = path.join(f.root, name);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, bytes);
  }
  const instructions = 'Fixture managed instructions.';
  await writeFile(path.join(f.root, 'AGENTS.md'),
    '<!-- gitlab-workspace-kit:managed:start -->\n' + instructions + '\n<!-- gitlab-workspace-kit:managed:end -->\n');
  const marker = path.join(f.root, '.gitlab-workspace/tool-manifests/workflow-kit.json');
  const files = Object.fromEntries(Object.entries(assets).map(([name, bytes]) => [name, digest(bytes)]));
  let version = initialVersion, contents = '';
  const replaceVersion = async (value: string) => {
    version = value;
    contents = JSON.stringify({ version, source: 'bundled', agentBlockSha256: digest(instructions), files });
    await writeFile(marker, contents);
  };
  await mkdir(path.dirname(marker), { recursive: true });
  await replaceVersion(version);
  let checks = 0;
  const installed: InstalledWorkflowKitState = { status: 'installed', profile: 'group', version, integrity: 'verified', workspaceContract: 2, installerApi: 1 };
  const settings = { installed, availableFeatures: ['merge-repo', 'release-review'], statusError: undefined as string | undefined,
    statusProfile: 'group', statusContract: 2, attest: true, beforeStatus: undefined as (() => Promise<void>) | undefined };
  const service = new WorkflowKitService({
    storagePath: path.join(f.root, 'storage'), extensionDirectory: f.root, extensionVersion: '0.58.8',
    readSource: () => 'github', writeSource: async () => undefined, pythonPath: () => 'python',
    reportPhase: () => undefined, runWithInstallProgress: (_version, task) => task(), releaseManager: { listReleases: async () => [] } as never,
    runHelper: async () => {
      checks++;
      await settings.beforeStatus?.();
      return settings.statusError ? { status: 'error', message: settings.statusError } :
        { ok: true, status: 'installed', version, integrity: 'verified', profile: settings.statusProfile,
          workspaceContract: settings.statusContract, installerApi: 1, capabilities: settings.availableFeatures,
          statusContract: 1, installedManifestSha256: settings.attest ? digest(contents) : undefined };
    }
  });
  t.after(() => service.dispose());
  f.host.workflowKit = service;
  f.host.refreshWorkflowKit = async () => undefined;
  f.host.getSkillsContext = () => ({ root: f.root, workspaceRoot: f.root, revision, mode: 'group',
    installed: settings.installed, availableFeatures: settings.availableFeatures,
    reviewRuntimeRoot: path.join(f.root, 'merge-reviews'), releaseReviewRuntimeRoot: path.join(f.root, 'release-reviews') });
  const prepare = f.host.prepareSkillGuideTask;
  f.host.prepareSkillGuideTask = async (request: unknown, _id: string, _repo: unknown, _promptOnly: boolean, proof: WorkflowKitStatusProof) => {
    assert.equal(proof.sha256, digest(contents));
    await service.verifyInstallation(f.root, { reviewer: true, proof });
    return prepare(request);
  };
  const enableStatusRefresh = async () => {
    const projectContext = { root: f.root, revision, folders: [], manual: false };
    t.mock.property(vscode.workspace, 'workspaceFolders', [{ uri: { scheme: 'file', fsPath: f.root } }]);
    delete f.host.getSkillsContext;
    delete f.host.refreshWorkflowKit;
    f.host.projectContextSignature = () => f.root;
    f.host.resolveProjectContext = async () => projectContext;
    f.host.projectContext = projectContext;
    f.host.inspectEnvironmentSnapshot = async (root: string) => ({ status: 'matched', root, profile: 'group', repositories: [] });
    f.host.workspaceMatch = await f.host.inspectEnvironmentSnapshot(f.root);
    f.host.projects = [];
    f.host.workflowKitRefreshGeneration = 0;
    f.host.skillsEnvironmentGeneration = 0;
    f.host.watchRepositoryRemotes = async () => undefined;
    f.host.sendSnapshot = () => undefined;
    service.setContext({ ...projectContext, profile: 'group' });
    assert.ok(await service.refreshStatus());
    assert.equal(f.host.getSkillsContext().installed.version, version);
    checks = 0;
  };
  return { settings, service, replaceVersion, enableStatusRefresh, checks: () => checks };
}

async function coldMr(t: test.TestContext) {
  const f = await fixture(t);
  const kit = await mrWorkflowKit(t, f);
  const upstream = path.join(f.root, 'origin.git');
  git(f.cwd, 'init', '-qb', 'main');
  await writeFile(path.join(f.cwd, 'seed.txt'), 'common');
  git(f.cwd, 'add', '.'); git(f.cwd, 'commit', '-qm', 'common');
  git(f.cwd, 'checkout', '-qb', 'feature');
  await writeFile(path.join(f.cwd, 'seed.txt'), 'head');
  git(f.cwd, 'commit', '-qam', 'head');
  const head = git(f.cwd, 'rev-parse', 'HEAD');
  git(f.cwd, 'checkout', '-q', 'main');
  await writeFile(path.join(f.cwd, 'seed.txt'), 'base');
  git(f.cwd, 'commit', '-qam', 'base');
  const base = git(f.cwd, 'rev-parse', 'HEAD');
  git(f.root, 'clone', '-q', '--bare', f.cwd, upstream);
  const prefix = '/team/project.git/';
  git(upstream, 'update-ref', 'refs/merge-requests/4/head', head);
  git(upstream, 'update-server-info');
  const firstFetch = latch(), releaseFetch = latch();
  let fetches = 0;
  const server = createServer(async (request, response) => {
    const pathname = new URL(request.url ?? '/', 'http://localhost').pathname;
    const relative = pathname.startsWith(prefix) ? pathname.slice(prefix.length) : '';
    if (!/^(?:HEAD|info\/refs|objects\/(?:info\/packs|pack\/pack-[a-f0-9]+\.(?:idx|pack)|[a-f0-9]{2}\/[a-f0-9]+))$/.test(relative)) {
      response.writeHead(404).end(); return;
    }
    if (relative === 'info/refs' && ++fetches === 1) {
      firstFetch.resolve();
      await releaseFetch.promise;
    }
    try {
      const bytes = await readFile(path.join(upstream, relative));
      response.writeHead(200, { 'Content-Type': 'text/plain' }).end(bytes);
    }
    catch { response.writeHead(404).end(); }
  });
  t.after(() => { releaseFetch.resolve(); server.closeAllConnections(); server.close(); });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const url = `http://127.0.0.1:${address.port}`;
  const project = { id: 7, path_with_namespace: 'team/project', http_url_to_repo: url + prefix.slice(0, -1) };
  f.host.session.baseUrl = url;
  let credentials = 0;
  f.host.session.getCloneCredentials = async () => { credentials++; return { token: 'local-fixture' }; };
  f.heads.current = head;
  f.host.session.getClient = async () => ({ getProject: async () => project,
    getMergeRequest: async () => ({ project_id: 7, iid: 4, title: 'Cold MR', target_branch: 'main', sha: f.heads.current }),
    getRepositoryBranch: async () => ({ name: 'main', commit: { id: base } }) });
  f.host.linkedRepositoryCandidates = async () => [];
  f.host.context = { globalStorageUri: { fsPath: path.join(f.root, 'storage') } };
  delete f.host.prepareCliMergeRequest;
  const secondWaiting = latch();
  const prepare = managedRepository.ensureManagedRepositoryCache;
  let callers = 0, cacheRoot: string | undefined;
  t.mock.method(managedRepository, 'ensureManagedRepositoryCache', (options: managedRepository.ManagedRepositoryCacheOptions) => prepare({ ...options,
    beforeAccess: async root => { cacheRoot = root; await options.beforeAccess?.(root); if (++callers === 2) secondWaiting.resolve(); } }));
  return { ...f, kit, firstFetch, releaseFetch, secondWaiting, base, head, fetches: () => fetches, credentials: () => credentials, cacheRoot: () => cacheRoot };
}

test('MR installation and selected skill failures stop before credentials and Git cache writes', async t => {
  const f = await coldMr(t);
  const source = mergeRequest('release-reviewer'), check = () => undefined;
  const binding = await f.host.readCliMergeRequest(source, check);
  const invoke = () => f.host.prepareCliMergeRequest(source, binding, f.root, undefined, check, check);
  const installed = f.kit.settings.installed;
  f.kit.settings.installed = { status: 'missing' };
  await assert.rejects(invoke(), /安裝或更新/);
  f.kit.settings.installed = { ...installed, workspaceContract: 1 };
  await assert.rejects(invoke(), /安裝或更新/);
  f.kit.settings.installed = installed;
  f.kit.settings.statusError = 'Fixture installation failed verification';
  await assert.rejects(invoke(), /failed verification/);
  f.kit.settings.statusError = undefined;
  f.kit.settings.availableFeatures = ['merge-repo'];
  await assert.rejects(invoke(), /不提供所選 Reviewer/);
  f.kit.settings.availableFeatures.push('release-review');
  await writeFile(path.join(f.root, '.agents/skills/release-reviewer/SKILL.md'), '# Edited Reviewer skill');
  await assert.rejects(invoke(), /Skill 來源已變更/);
  assert.equal(f.credentials(), 0);
  assert.equal(f.fetches(), 0);
  assert.equal(f.cacheRoot(), undefined);
  await assert.rejects(lstat(f.host.context.globalStorageUri.fsPath), { code: 'ENOENT' });
});

test('warm MR preflight rejects either changed Reviewer payload before credentials or Git cache access', async t => {
  const f = await fixture(t);
  const kit = await mrWorkflowKit(t, f, { initialVersion: '1.12.8' });
  await kit.enableStatusRefresh();
  f.host.context = { globalStorageUri: { fsPath: path.join(f.root, 'storage') } };
  delete f.host.prepareCliMergeRequest;
  let credentials = 0;
  f.host.session.getCloneCredentials = async () => { credentials++; return { token: 'fixture' }; };
  const cache = t.mock.method(managedRepository, 'ensureManagedRepositoryCache', async () => assert.fail('Git cache must wait for a verified Reviewer'));
  const check = () => undefined;
  for (const [tool, payload] of [['merge-reviewer', mergeReviewerPayload], ['release-reviewer', releaseReviewerPayload]] as const) {
    await t.test(tool, async () => {
      const file = path.join(f.root, payload), original = await readFile(file);
      await writeFile(file, '# Locally changed Reviewer');
      try {
        const source = mergeRequest(tool);
        const binding = await f.host.readCliMergeRequest(source, check);
        await assert.rejects(f.host.prepareCliMergeRequest(source, binding, f.root, undefined, check, check), /Reviewer 檔案與已驗證/);
      } finally { await writeFile(file, original); }
    });
  }
  assert.equal(kit.checks(), 0, 'the MR preflights must exercise the warm installation path');
  assert.equal(credentials, 0);
  assert.equal(cache.mock.callCount(), 0);
  await assert.rejects(lstat(f.host.context.globalStorageUri.fsPath), { code: 'ENOENT' });
});

test('closing a queued MR terminal cancels its cache wait and releases its Workbench leases', { timeout: 10_000 }, async t => {
  const f = await fixture(t);
  const kit = await mrWorkflowKit(t, f, { initialVersion: '1.12.8' });
  await kit.enableStatusRefresh();
  f.host.context = { globalStorageUri: { fsPath: path.join(f.root, 'storage') } };
  f.host.session.getCloneCredentials = async () => ({ token: 'fixture' });
  delete f.host.prepareCliMergeRequest;
  const terminal = manualTerminal(f), waiting = latch();
  t.mock.method(managedRepository, 'ensureManagedRepositoryCache', async (options: managedRepository.ManagedRepositoryCacheOptions) => {
    assert.equal(options.signal, terminal.manual.signal);
    await options.beforeAccess?.(f.cwd);
    const signal = terminal.manual.signal;
    signal.throwIfAborted();
    return new Promise<never>((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      waiting.resolve();
    });
  });
  const work = f.host.dispatchMessage({ type: 'runCodexCli', source: mergeRequest('merge-reviewer') }) as Promise<void>;
  try {
    await Promise.race([terminal.shown, work.then(() => assert.fail('the terminal was never shown'))]);
    terminal.enter();
    await Promise.race([waiting.promise, work.then(() => assert.fail('the MR never waited for the cache'))]);
    terminal.manual.close();
    await work;
    assert.equal(f.launched.length, 0);
    assert.equal(f.host.cliRuns.size, 0);
    assert.ok(f.calls.some(call => call.action === 'outcome' && (call.data as { status?: string }).status === 'cancelled'));
    for (const lease of f.leasePaths) await assert.rejects(lstat(lease), { code: 'ENOENT' });
  } finally {
    terminal.manual.close();
    await Promise.allSettled([work]);
  }
});

test('both MR preflights continue when a Skills page leaves a pending Settings check', { timeout: 10_000 }, async t => {
  const f = await fixture(t);
  const kit = await mrWorkflowKit(t, f);
  await kit.enableStatusRefresh();
  await kit.replaceVersion('1.12.8');
  f.host.context = { globalStorageUri: { fsPath: path.join(f.root, 'storage') } };
  delete f.host.prepareCliMergeRequest;
  const sources = [mergeRequest('merge-reviewer'), mergeRequest('release-reviewer')];
  const check = () => undefined;
  const bindings = await Promise.all(sources.map(source => f.host.readCliMergeRequest(source, check)));
  const stopAtCache = new Error('Fixture reached Git cache');
  let credentials = 0, cache = 0;
  f.host.session.getCloneCredentials = async () => { credentials++; return { token: 'local-fixture' }; };
  t.mock.method(managedRepository, 'ensureManagedRepositoryCache', async () => { cache++; throw stopAtCache; });
  const statusEntered = latch(), releaseStatus = latch(), pageJoined = latch(), reviewsJoined = latch();
  kit.settings.beforeStatus = async () => { statusEntered.resolve(); await releaseStatus.promise; };
  const pageOwner = new AbortController();
  const refreshInstall = f.host.refreshWorkflowKitInstallState.bind(f.host);
  const settings: Promise<WorkflowKitStatusProof | undefined> = refreshInstall(false, undefined,
    { context: f.host.projectContext, checked: { root: f.root, profile: 'group' } });
  t.mock.method(f.host, 'refreshWorkflowKitInstallState', (publish?: boolean, signal?: AbortSignal, prepared?: unknown) => {
    const task = refreshInstall(publish, signal, prepared);
    if (signal === pageOwner.signal) { assert.equal(task, settings); pageJoined.resolve(); }
    return task;
  });
  const refresh = f.host.refreshWorkflowKit.bind(f.host);
  const reviews: Array<Promise<WorkflowKitStatusProof | undefined>> = [];
  t.mock.method(f.host, 'refreshWorkflowKit', (publish?: boolean, signal?: AbortSignal) => {
    const task = refresh(publish, signal);
    if (!signal && reviews.push(task) === 2) reviewsJoined.resolve();
    return task;
  });
  let page: Promise<WorkflowKitStatusProof | undefined> | undefined;
  let preflights: Promise<void>[] = [];
  try {
    await statusEntered.promise;
    page = f.host.refreshWorkflowKit(true, pageOwner.signal);
    await pageJoined.promise;
    preflights = sources.map((source, index) => assert.rejects(
      f.host.prepareCliMergeRequest(source, bindings[index], f.root, undefined, check, check), error => error === stopAtCache));
    await Promise.race([reviewsJoined.promise, Promise.all(preflights).then(() => assert.fail('Git cache reached before status was released'))]);
    assert.equal(reviews[0], reviews[1]);
    assert.notEqual(reviews[0], page);
    assert.equal(credentials, 0);
    pageOwner.abort();
    releaseStatus.resolve();

    assert.ok(await settings);
    assert.equal(await page, undefined);
    await Promise.all(preflights);
    assert.equal(kit.checks(), 1);
    assert.equal(credentials, 2);
    assert.equal(cache, 2);
    assert.equal(f.host.getSkillsContext().installed.version, '1.12.8');
  } finally {
    pageOwner.abort(); releaseStatus.resolve();
    await Promise.allSettled([settings, page, ...preflights]);
  }
});

for (const outcome of ['result', 'error'] as const) test(`superseded Dashboard discovery discards a late ${outcome}`, { timeout: 10_000 }, async t => {
  const f = await fixture(t);
  const kit = await mrWorkflowKit(t, f);
  await kit.enableStatusRefresh();
  f.host.requestGeneration = 1;
  f.host.refreshInventory = async () => undefined;
  const pageOwner = new AbortController(), entered = latch(), release = latch();
  t.mock.method(workspacePaths, 'inspectWorkflowKitInstallRoot', async () => {
    entered.resolve(); await release.promise;
    if (outcome === 'error') throw new Error('Fixture stale page discovery failed');
    return { root: f.root, profile: 'repository', remoteFingerprint: 'previous-repo' };
  });
  t.after(() => release.resolve());

  await f.host.refreshDashboardLocal(1, pageOwner.signal, () => true);
  await entered.promise;
  const page: Promise<WorkflowKitStatusProof | undefined> = f.host.workflowKitInstallRefreshTask.task;
  try {
    await kit.replaceVersion('1.12.8');
    assert.ok(await f.host.refreshWorkflowKit());
    release.resolve();
    assert.equal(await page, undefined);
    assert.equal(pageOwner.signal.aborted, false);
    assert.equal(kit.service.snapshot.context?.profile, 'group');
    assert.equal(kit.service.snapshot.state.version, '1.12.8');
    assert.equal(f.host.getSkillsContext().mode, 'group');
    assert.equal(kit.checks(), 1);
  } finally {
    release.resolve(); await Promise.allSettled([page]);
  }
});

test('Dashboard reports WorkflowKit errors only for its current install check', async t => {
  for (const superseded of [false, true]) await t.test(superseded ? 'superseded rejection' : 'current rejection', async t => {
    const f = await fixture(t);
    const kit = await mrWorkflowKit(t, f);
    await kit.enableStatusRefresh();
    f.host.requestGeneration = 1;
    f.host.refreshInventory = async () => undefined;
    const owner = new AbortController(), rejectStatus = latch();
    const failure = new Error('Fixture Dashboard status unavailable');
    const status = rejectStatus.promise.then(() => { throw failure; });
    const refreshInstall = f.host.refreshWorkflowKitInstallState.bind(f.host);
    t.mock.method(f.host, 'refreshWorkflowKitInstallState', (publish?: boolean, signal?: AbortSignal, prepared?: unknown) =>
      signal === owner.signal ? status : refreshInstall(publish, signal, prepared));
    try {
      await f.host.refreshDashboardLocal(1, owner.signal, () => true);
      if (superseded) assert.ok(await f.host.refreshWorkflowKit());
      const rejected = assert.rejects(status, failure);
      rejectStatus.resolve();
      await rejected;
      const state = kit.service.snapshot.state;
      assert.equal(state.status, superseded ? 'installed' : 'error');
      if (superseded) assert.equal(state.version, '1.12.7');
      else assert.equal(state.message, failure.message);
    } finally {
      rejectStatus.resolve(); await Promise.allSettled([status]);
    }
  });
});

test('a late legacy MR rechecks managed payload before credentials and Git cache access', { timeout: 10_000 }, async t => {
  const f = await fixture(t);
  const kit = await mrWorkflowKit(t, f, { initialVersion: '1.12.4', attestedRunner: false });
  await kit.enableStatusRefresh();
  await kit.replaceVersion('1.12.5');
  f.host.context = { globalStorageUri: { fsPath: path.join(f.root, 'storage') } };
  delete f.host.prepareCliMergeRequest;
  let credentials = 0, cache = 0;
  f.host.session.getCloneCredentials = async () => { credentials++; return { token: 'local-fixture' }; };
  t.mock.method(managedRepository, 'ensureManagedRepositoryCache', async () => { cache++; throw new Error('Unexpected Git cache'); });
  const source = mergeRequest('release-reviewer'), check = () => undefined;
  const binding = await f.host.readCliMergeRequest(source, check);
  const mismatched = latch(), resume = latch();
  const verify = kit.service.verifyInstallation.bind(kit.service);
  t.mock.method(kit.service, 'verifyInstallation', async (...args: Parameters<typeof verify>) => {
    try { return await verify(...args); }
    catch (error) {
      if (error instanceof WorkflowKitVersionMismatchError && args[1]?.expectedInstalledVersion === '1.12.4') {
        assert.equal(error.actualVersion, '1.12.5');
        mismatched.resolve(); await resume.promise;
      }
      throw error;
    }
  });
  const mr = f.host.prepareCliMergeRequest(source, binding, f.root, undefined, check, check);
  const rejection = assert.rejects(mr, /Managed Reviewer payload changed/);
  try {
    await Promise.race([mismatched.promise, rejection.then(() => assert.fail('MR did not reach the stale version check'))]);
    assert.equal(kit.checks(), 0);
    assert.ok(await f.host.refreshWorkflowKit());
    assert.equal(f.host.getSkillsContext().installed.version, '1.12.5');
    assert.equal(kit.checks(), 1);
    const file = path.join(f.root, releaseReviewerPayload);
    const installed = await readFile(file, 'utf8');
    kit.settings.beforeStatus = async () => {
      if (await readFile(file, 'utf8') !== installed) kit.settings.statusError = 'Managed Reviewer payload changed';
    };
    await writeFile(file, '# Changed managed reviewer payload');
    resume.resolve();
    await rejection;
    assert.equal(kit.checks(), 2);
    assert.equal(credentials, 0);
    assert.equal(cache, 0);
    await assert.rejects(lstat(f.host.context.globalStorageUri.fsPath), { code: 'ENOENT' });
  } finally {
    resume.resolve(); await Promise.allSettled([mr, rejection]);
  }
});

test('stale MR reviewers launch on the same click and reuse a completed WorkflowKit refresh', { timeout: 90_000 }, async t => {
  const f = await coldMr(t);
  await f.kit.enableStatusRefresh();
  await f.kit.replaceVersion('1.12.8');
  assert.equal(f.host.getSkillsContext().installed.version, '1.12.7');
  const mismatches = Array.from({ length: 2 }, () => ({ arrived: latch(), resume: latch() }));
  const verify = f.kit.service.verifyInstallation.bind(f.kit.service);
  let staleRequests = 0;
  t.mock.method(f.kit.service, 'verifyInstallation', async (...args: Parameters<typeof verify>) => {
    try { return await verify(...args); }
    catch (error) {
      if (error instanceof WorkflowKitVersionMismatchError && args[1]?.expectedInstalledVersion === '1.12.7') {
        assert.equal(error.actualVersion, '1.12.8');
        const gate = mismatches[staleRequests++];
        assert.ok(gate);
        gate.arrived.resolve();
        await gate.resume.promise;
      }
      throw error;
    }
  });

  const { merge, release, start } = mrReviewTerminals(f);
  const first = start('merge-reviewer');
  let second: Promise<void> | undefined;
  const ended = () => assert.fail('MR preparation ended before the expected step');
  try {
    await Promise.race([merge.shown, first.then(ended)]);
    merge.enter();
    await Promise.race([mismatches[0].arrived.promise, first.then(ended)]);
    second = start('release-reviewer');
    await Promise.race([release.shown, second.then(ended)]);
    release.enter();
    await Promise.race([mismatches[1].arrived.promise, second.then(ended)]);
    assert.equal(f.kit.checks(), 0, 'the two stale reads require no status helper');

    mismatches[0].resume.resolve();
    await Promise.race([f.firstFetch.promise, first.then(ended)]);
    assert.equal(f.host.getSkillsContext().installed.version, '1.12.8');
    assert.equal(f.host.workflowKitRefreshTask, undefined, 'the late reviewer cannot join the finished refresh');
    mismatches[1].resume.resolve();
    await Promise.race([f.secondWaiting.promise, second.then(ended)]);
    f.releaseFetch.resolve();
    await Promise.all([first, second]);

    assert.equal(f.kit.checks(), 1);
    assert.equal(f.fetches(), 2, 'each pinned commit is fetched once for both reviewers');
    assert.equal(f.launched.length, 2);
    assert.equal(f.launched[0].options.cwd, f.launched[1].options.cwd);
    assert.deepEqual([...f.host.cliRuns.values()].map(run => run.summary.tool).sort(), ['merge-reviewer', 'release-reviewer']);
  } finally {
    for (const gate of mismatches) gate.resume.resolve();
    f.releaseFetch.resolve();
    merge.exit({ state: 'exited', code: 0 }); release.exit({ state: 'exited', code: 0 });
    merge.manual.close(); release.manual.close();
    await Promise.allSettled([first, second]);
    await Promise.resolve();
    await Promise.allSettled(f.host.cliSettlements);
  }
});

for (const cancelledTool of ['merge-reviewer', 'release-reviewer'] as const) test(
  `closing ${cancelledTool} during the shared WorkflowKit refresh preserves the other MR review`, { timeout: 90_000 }, async t => {
    const f = await coldMr(t);
    await f.kit.enableStatusRefresh();
    await f.kit.replaceVersion('1.12.8');
    const statusStarted = latch(), releaseStatus = latch(), joined = latch();
    f.kit.settings.beforeStatus = async () => { statusStarted.resolve(); await releaseStatus.promise; };
    const refresh = f.host.refreshWorkflowKit.bind(f.host);
    const refreshes: Array<Promise<WorkflowKitStatusProof | undefined>> = [];
    t.mock.method(f.host, 'refreshWorkflowKit', (publish?: boolean, signal?: AbortSignal) => {
      assert.equal(signal, undefined, 'the shared refresh has no terminal abort signal');
      const task = refresh(publish, signal);
      refreshes.push(task);
      if (refreshes.length === 2) joined.resolve();
      return task;
    });

    const { merge, release, start } = mrReviewTerminals(f);
    const first = start('merge-reviewer');
    let second: Promise<void> | undefined;
    const ended = () => assert.fail('MR preparation ended before the expected step');
    try {
      await Promise.race([merge.shown, first.then(ended)]);
      merge.enter();
      await Promise.race([statusStarted.promise, first.then(ended)]);
      second = start('release-reviewer');
      await Promise.race([release.shown, second.then(ended)]);
      release.enter();
      await Promise.race([joined.promise, second.then(ended)]);
      assert.equal(refreshes[0], refreshes[1]);
      assert.equal(f.credentials(), 0);
      (cancelledTool === 'merge-reviewer' ? merge : release).manual.close();
      releaseStatus.resolve();
      f.releaseFetch.resolve();
      await Promise.all([first, second]);

      assert.equal(f.kit.checks(), 1);
      assert.equal(f.credentials(), 1);
      assert.equal(f.fetches(), 2);
      assert.equal(f.launched.length, 1);
      assert.deepEqual([...f.host.cliRuns.values()].map(run => run.summary.tool),
        [cancelledTool === 'merge-reviewer' ? 'release-reviewer' : 'merge-reviewer']);
      assert.ok(f.calls.some(call => call.action === 'outcome' && (call.data as { status?: string }).status === 'cancelled'));
    } finally {
      releaseStatus.resolve(); f.releaseFetch.resolve();
      merge.exit({ state: 'exited', code: 0 }); release.exit({ state: 'exited', code: 0 });
      merge.manual.close(); release.manual.close();
      await Promise.allSettled([first, second]);
      await Promise.resolve();
      await Promise.allSettled(f.host.cliSettlements);
    }
  });

test('an invalid WorkflowKit refresh stops MR preparation before Git', async t => {
  type Fixture = Awaited<ReturnType<typeof fixture>>;
  type Kit = Awaited<ReturnType<typeof mrWorkflowKit>>;
  const scenarios: Array<[string, (f: Fixture, kit: Kit, t: test.TestContext) => void, RegExp]> = [
    ['wrong profile', (_f, kit) => { kit.settings.statusProfile = 'repository'; }, /流程與目前專案不同/],
    ['unsupported contract', (_f, kit) => { kit.settings.statusContract = 1; }, /整合介面/],
    ['missing selected reviewer', (_f, kit) => { kit.settings.availableFeatures = ['merge-repo']; }, /不提供所選 Reviewer/],
    ['missing refreshed proof', (_f, kit) => { kit.settings.attest = false; }, /尚未通過驗證/],
    ['proof for another root', (f, _kit, t) => {
      const refresh = f.host.refreshWorkflowKit.bind(f.host);
      t.mock.method(f.host, 'refreshWorkflowKit', async () => {
        const proof = await refresh();
        assert.ok(proof);
        return { ...proof, root: f.cwd };
      });
    }, /尚未通過驗證/],
    ['stale refreshed proof', (f, _kit, t) => {
      const refresh = f.host.refreshWorkflowKit.bind(f.host);
      t.mock.method(f.host, 'refreshWorkflowKit', async () => {
        const proof = await refresh();
        assert.ok(proof);
        const stage = path.join(f.root, '.gitlab-workspace/tool-installs', 'kit-' + 'a'.repeat(32));
        await mkdir(stage, { recursive: true });
        await writeFile(path.join(stage, 'transaction.json'), '{"phase":"applying"}');
        return proof;
      });
    }, /安裝紀錄或交易狀態/],
    ['version changed again', (_f, kit) => { kit.settings.beforeStatus = () => kit.replaceVersion('1.12.9'); }, /安裝版本已變更/],
    ['project root changed', (f, kit) => {
      kit.settings.beforeStatus = async () => {
        f.host.projectContext = { ...f.host.projectContext, root: f.cwd };
      };
    }, /專案根目錄已變更/],
  ];
  for (const [name, arrange, expected] of scenarios) await t.test(name, async t => {
    const f = await fixture(t);
    const kit = await mrWorkflowKit(t, f);
    await kit.enableStatusRefresh();
    await kit.replaceVersion('1.12.8');
    const storage = path.join(f.root, 'storage');
    f.host.context = { globalStorageUri: { fsPath: storage } };
    delete f.host.prepareCliMergeRequest;
    let credentials = 0, cache = 0;
    f.host.session.getCloneCredentials = async () => { credentials++; return { token: 'local-fixture' }; };
    t.mock.method(managedRepository, 'ensureManagedRepositoryCache', async () => { cache++; throw new Error('Unexpected Git cache access'); });
    arrange(f, kit, t);

    const source = mergeRequest('release-reviewer'), check = () => undefined;
    const binding = await f.host.readCliMergeRequest(source, check);
    await assert.rejects(f.host.prepareCliMergeRequest(source, binding, f.root, undefined, check, check), expected);
    assert.equal(kit.checks(), 1);
    assert.equal(credentials, 0);
    assert.equal(cache, 0);
    await assert.rejects(lstat(storage), { code: 'ENOENT' });
  });
});

for (const installChanged of [true, false]) test(installChanged
  ? 'MR installation drift during fetch stops before creating review refs'
  : 'MR version drift during fetch stops before creating review refs', { timeout: 90_000 }, async t => {
  const f = await coldMr(t);
  const source = mergeRequest('release-reviewer'), check = () => undefined;
  const binding = await f.host.readCliMergeRequest(source, check);
  const pending = f.host.prepareCliMergeRequest(source, binding, f.root, undefined, check, check);
  try {
    await Promise.race([f.firstFetch.promise, pending.then(() => assert.fail('review was prepared before fetch'))]);
    if (installChanged) {
      const stage = path.join(f.root, '.gitlab-workspace/tool-installs', 'kit-' + 'a'.repeat(32));
      await mkdir(stage, { recursive: true });
      await writeFile(path.join(stage, 'transaction.json'), '{"phase":"applying"}');
    } else {
      f.heads.current = '2'.repeat(40);
    }
    f.releaseFetch.resolve();
    await assert.rejects(pending, installChanged ? /安裝紀錄或交易狀態/ : /固定來源或目標版本已變更/);
    const cache = f.cacheRoot();
    assert.ok(cache);
    assert.equal(git(cache, 'for-each-ref', '--format=%(refname)', 'refs/heads/workbench'), '');
    await assert.rejects(lstat(path.join(f.host.context.globalStorageUri.fsPath, 'codex-cli-reviews')), { code: 'ENOENT' });
    assert.equal(f.kit.checks(), 1);
  } finally {
    f.releaseFetch.resolve();
    await Promise.allSettled([pending]);
  }
});

for (const closeFirst of [false, true]) test(closeFirst
  ? 'closing the first terminal preserves a sibling waiting on the real MR cache'
  : 'both MR reviewers pass the old queue deadline while sharing one real cold cache', { timeout: 110_000 }, async t => {
  const f = await coldMr(t);
  const { merge, release, start } = mrReviewTerminals(f);
  const first = start('merge-reviewer');
  let second: Promise<void> | undefined;
  try {
    await Promise.race([merge.shown, first.then(() => assert.fail('first terminal was not prepared'))]);
    merge.enter();
    await Promise.race([f.firstFetch.promise, first.then(() => assert.fail('first run ended before the actual fetch'))]);
    const startedSecond: Promise<void> = start('release-reviewer');
    second = startedSecond;
    await Promise.race([release.shown, startedSecond.then(() => assert.fail('second terminal was not prepared'))]);
    release.enter();
    await Promise.race([f.secondWaiting.promise, startedSecond.then(() => assert.fail('second run ended before joining the cache'))]);
    if (closeFirst) merge.manual.close();
    else await new Promise(resolve => setTimeout(resolve, 31_000));
    assert.equal(f.launched.length, 0);
    f.releaseFetch.resolve();
    await Promise.all([first, second]);
    assert.equal(f.fetches(), 2, 'each of the two distinct pinned commits is fetched once');
    assert.equal(f.kit.checks(), 1, 'both operations reuse the authenticated, unchanged installation');
    assert.equal(f.launched.length, closeFirst ? 1 : 2);
    const cache = f.launched[0].options.cwd;
    assert.ok(f.launched.every(run => run.options.cwd === cache));
    const refs = () => git(cache, 'for-each-ref', '--format=%(objectname)', 'refs/heads/workbench').split(/\r?\n/).sort();
    assert.deepEqual(refs(), (closeFirst ? [f.base, f.head] : [f.base, f.head, f.base, f.head]).sort());
    if (!closeFirst) {
      merge.exit({ state: 'exited', code: 7 });
      await Promise.resolve();
      await Promise.all(f.host.cliSettlements);
      const failed = [...f.host.cliRuns.values()].find(run => run.summary.state === 'failed');
      assert.ok(failed);
      await f.host.dispatchMessage({ type: 'resetCodexCliRun', runId: failed.summary.runId });
      assert.deepEqual(refs(), [f.base, f.head].sort());
      assert.equal([...f.host.cliRuns.values()][0].summary.tool, 'release-reviewer');
    }
  } finally {
    f.releaseFetch.resolve();
    release.exit({ state: 'exited', code: 0 });
    merge.manual.close(); release.manual.close();
    await Promise.allSettled([first, second]);
    await Promise.resolve();
    await Promise.allSettled(f.host.cliSettlements);
  }
});

test('retained workflow sources launch the chosen CLI settings with prepared input and writable scope', async t => {
  const f = await fixture(t);
  t.mock.method(vscode.workspace, 'getConfiguration', () => ({
    inspect: (setting: string) => setting === 'codex.waitForEnter' ? { globalValue: false } : undefined
  }));
  delete f.host.codexManualStartSetting;
  for (const source of [skill, bmad, review, mergeRequest('merge-reviewer'), mergeRequest('release-reviewer')]) {
    f.calls.length = 0;
    await f.host.dispatchMessage({ type: 'runCodexCli', source });
    assert.deepEqual(f.calls.map(call => call.action), ['choose', source.kind, 'launch', 'finish', 'outcome']);
    const launch = f.launched.at(-1)!;
    assert.equal(launch.selection, f.selected);
    assert.equal(launch.options.cwd, f.cwd);
    assert.deepEqual(launch.options.writableRoots, [f.cwd]);
    assert.ok(launch.options.prompt.includes(JSON.stringify(f.skillPath)));
    assert.ok(launch.options.prompt.includes(JSON.stringify(path.join(f.root, 'AGENTS.md'))));
    assert.match(launch.options.prompt, /Verified task prompt/);
    if (source.kind === 'merge-request') {
      const data = f.calls[1].data as { source: CodexCliSource; binding: { head: string; base: string }; projectRoot: string; repository: string };
      assert.deepEqual(data.source, source);
      assert.deepEqual([data.binding.head, data.binding.base], ['a'.repeat(40), 'b'.repeat(40)]);
      assert.equal(data.projectRoot, f.root);
      assert.equal(data.repository, f.root);
    } else assert.deepEqual(f.calls[1].data, source.kind === 'bmad' ? source.request : source);
  }
});

test('Codex workflow entries wait for Enter by default despite a workspace override', async t => {
  t.mock.method(vscode.workspace, 'getConfiguration', () => ({
    inspect: (setting: string) => setting === 'codex.waitForEnter' ? { workspaceValue: false } : undefined
  }));
  const sources = [
    { name: 'Skills', source: skill },
    { name: 'BMAD', source: bmad },
    { name: 'Reviewer resume', source: review },
    { name: 'MR MergeReviewer', source: mergeRequest('merge-reviewer') },
    { name: 'MR ReleaseReviewer', source: mergeRequest('release-reviewer') }
  ];
  for (const { name, source } of sources) await t.test(name, async tc => {
    const f = await fixture(tc);
    const m = manualTerminal(f);
    delete f.host.codexManualStartSetting;
    const running = f.host.dispatchMessage({ type: 'runCodexCli', source });
    try {
      await Promise.race([m.shown, running.then(() => assert.fail('The workflow started before the terminal confirmation'))]);
      assert.deepEqual(f.calls.map(call => call.action), ['choose']);
      for (const leasePath of f.leasePaths) await assert.rejects(lstat(leasePath), { code: 'ENOENT' });
      m.enter();
      await running;
      assert.deepEqual(f.calls.map(call => call.action), ['choose', source.kind, 'launch', 'outcome']);
      assert.equal(f.launched.length, 1);
    } finally {
      m.exit({ state: 'exited', code: 0 });
      m.manual.close();
      await Promise.resolve();
      await Promise.all(f.host.cliSettlements);
    }
  });
});

test('cancelled CLI model selection stops before workflow preparation and terminal creation', async t => {
  const f = await fixture(t);
  f.choices.value = undefined;
  await f.host.dispatchMessage({ type: 'runCodexCli', source: bmad });
  assert.deepEqual(f.calls, [{ action: 'choose', data: f.root }, { action: 'outcome', data: { status: 'cancelled', effect: 'none' } }]);
  assert.deepEqual(f.launched, []);
});

test('manual startup resolves the current PowerShell setting after prewarming', async t => {
  const f = await fixture(t), m = manualTerminal(f);
  let setting = '';
  f.host.codexManualStartSetting = () => ({ powerShell: setting });
  f.host.prepareCodexPowerShell = async (_root: string, configured: string) => {
    assert.equal(configured, '');
    return path.join(f.root, 'previous Store package', 'pwsh.exe');
  };
  t.mock.method(f.terminal, 'choose', async () => {
    setting = path.join(f.root, 'current explicit PowerShell', 'pwsh.exe');
    return f.selected;
  });
  let resolvedOption: string | undefined;
  f.host.openManualCodexTerminal = async (_root: string, configured: string) => {
    resolvedOption = configured;
    return m.manual;
  };
  const pending = f.host.dispatchMessage({ type: 'runCodexCli', source: skill });
  try {
    await Promise.race([m.shown, pending.then(() => assert.fail('terminal did not wait for Enter'))]);
    assert.equal(resolvedOption, setting);
    assert.equal(f.launched.length, 0);
    m.enter(); await pending;
    assert.equal(f.launched.length, 1);
  } finally {
    m.exit({ state: 'exited', code: 0 });
    m.manual.close();
    await Promise.resolve();
    await Promise.all(f.host.cliSettlements);
  }
});

test('resuming an active native request brings its existing terminal forward', async t => {
  const f = await fixture(t), m = manualTerminal(f);
  let terminals = 0;
  f.host.openManualCodexTerminal = async () => {
    assert.equal(++terminals, 1, 'an existing native request must not open a second terminal');
    return m.manual;
  };
  const id = 'd'.repeat(32), runtime = path.join(f.root, 'native-runtime');
  const prepare = f.host.prepareSkillGuideTask;
  f.host.prepareSkillGuideTask = async (source: unknown) => ({ ...await prepare(source),
    review: { tool: 'merge-reviewer', requestId: id, runtimeRoot: runtime, workspace: f.root, repository: f.cwd } });
  const activeSource: CodexCliSource = { kind: 'skill', featureId: 'merge-repo', inputs: { 'merge-repo.repo': f.cwd }, revision };
  const resume: CodexCliSource = { kind: 'review', tool: 'merge-reviewer', requestId: id, action: 'resume', revision };
  const start = f.host.dispatchMessage({ type: 'runCodexCli', source: activeSource });
  try {
    await Promise.race([m.shown, start.then(() => assert.fail('native startup ended before Enter'))]);
    m.enter(); await start;
    const show = t.mock.method(m.manual.terminal, 'show', () => undefined);
    await Promise.all([f.host.dispatchMessage({ type: 'runCodexCli', source: resume }),
      f.host.dispatchMessage({ type: 'runCodexCli', source: resume })]);
    assert.equal(show.mock.callCount(), 1);
    assert.equal(f.launched.length, 1);
    assert.equal(terminals, 1);
    assert.equal(f.calls.filter(call => call.action === 'choose').length, 1);
    assert.equal(f.calls.filter(call => call.action === 'review').length, 0);
    assert.equal(f.host.cliRuns.size, 1);
  } finally {
    m.exit({ state: 'exited', code: 0 });
    m.manual.close();
    await Promise.resolve();
    await Promise.all(f.host.cliSettlements);
  }
});

test('source or local project drift during model selection prevents CLI launch', async t => {
  const f = await fixture(t);
  t.mock.method(f.terminal, 'choose', async () => { f.heads.current = 'c'.repeat(40); return f.selected; });
  await assert.rejects(f.host.dispatchMessage({ type: 'runCodexCli', source: mergeRequest('merge-reviewer') }), /固定來源或目標版本已變更/);
  assert.deepEqual(f.calls, []);
  t.mock.method(f.terminal, 'choose', async () => { f.changes.canAccess = false; return f.selected; });
  await assert.rejects(f.host.dispatchMessage({ type: 'runCodexCli', source: skill }), /工作區已變更/);
  assert.deepEqual(f.launched, []);
});

test('MR reviewer selects the new Repo after inventory changes during model selection', async t => {
  const f = await fixture(t);
  const gitRepositories = { inventoryRevision: 1 };
  f.host.gitRepositories = gitRepositories;
  const candidates = [f.root];
  let reads = 0;
  f.host.linkedRepositoryCandidates = async () => { reads++; return [...candidates]; };
  t.mock.method(f.terminal, 'choose', async () => {
    candidates[0] = f.cwd;
    gitRepositories.inventoryRevision++;
    return f.selected;
  });
  await f.host.dispatchMessage({ type: 'runCodexCli', source: mergeRequest('merge-reviewer') });
  assert.equal(reads, 2);
  assert.equal((f.calls.find(call => call.action === 'merge-request')?.data as { repository: string }).repository, f.cwd);
  assert.equal(f.launched.length, 1);
});

test('a failed terminal launch rolls back its preparation and permits a fresh retry', async t => {
  const f = await fixture(t);
  f.changes.launchError = new Error('terminal startup failed');
  await assert.rejects(f.host.dispatchMessage({ type: 'runCodexCli', source: bmad }), /terminal startup failed/);
  assert.deepEqual(f.calls.map(call => call.action), ['choose', 'bmad', 'launch', 'rollback']);
  f.calls.length = 0;
  f.changes.launchError = undefined;
  await f.host.dispatchMessage({ type: 'runCodexCli', source: bmad });
  assert.deepEqual(f.calls.map(call => call.action), ['choose', 'bmad', 'launch', 'finish', 'outcome']);
});

test('a waiting manual terminal leaves the workflow untouched when closed before Enter', async t => {
  const f = await fixture(t);
  const m = manualTerminal(f);
  const running = f.host.dispatchMessage({ type: 'runCodexCli', source: bmad });
  await m.shown;
  assert.deepEqual(f.calls.map(call => call.action), ['choose']);
  for (const leasePath of f.leasePaths) await assert.rejects(lstat(leasePath), { code: 'ENOENT' });
  m.manual.close();
  await running;
  assert.deepEqual(f.launched, []);
  assert.deepEqual(f.calls.at(-1), { action: 'outcome', data: { status: 'cancelled', effect: 'none' } });
  assert.equal(f.host.cliTerminals.size, 0);
});

test('a failed manual terminal setup never prepares a workflow or falls back to direct launch', async t => {
  const f = await fixture(t);
  manualTerminal(f);
  const error = new Error('PowerShell terminal setup failed');
  f.host.openManualCodexTerminal = async () => { throw error; };
  await assert.rejects(f.host.dispatchMessage({ type: 'runCodexCli', source: skill }), error);
  assert.deepEqual(f.calls.map(call => call.action), ['choose']);
  for (const leasePath of f.leasePaths) await assert.rejects(lstat(leasePath), { code: 'ENOENT' });
});

test('manual Enter checks the pinned MR revision again before workflow preparation', async t => {
  const f = await fixture(t);
  const m = manualTerminal(f);
  const running = f.host.dispatchMessage({ type: 'runCodexCli', source: mergeRequest('release-reviewer') });
  await m.shown;
  f.heads.current = 'c'.repeat(40);
  m.enter();
  await assert.rejects(running, /固定來源或目標版本已變更/);
  assert.equal(m.manual.signal.aborted, true);
  assert.deepEqual(f.calls.map(call => call.action), ['choose']);
  for (const leasePath of f.leasePaths) await assert.rejects(lstat(leasePath), { code: 'ENOENT' });
});

for (const entry of ['Skills', 'MR'] as const) test(`${entry} runs both reviewers on one Repo and resets only the failed run`, async t => {
  const f = await fixture(t);
  const merge = manualTerminal(f);
  const release = manualTerminal(f);
  f.host.openManualCodexTerminal = async (_root: string, _pwsh: string, _check: unknown, title: string) =>
    title.includes('MergeReviewer') ? merge.manual : release.manual;
  const start = (tool: 'merge-reviewer' | 'release-reviewer') => {
    const feature = tool === 'merge-reviewer' ? 'merge-repo' : 'release-review';
    const source: CodexCliSource = entry === 'MR' ? mergeRequest(tool) :
      { kind: 'skill', featureId: feature, inputs: { [`${feature}.repo`]: f.root }, revision };
    return f.host.dispatchMessage({ type: 'runCodexCli', source });
  };
  const startingMerge = start('merge-reviewer');
  try {
    await merge.shown;
    const startingRelease = start('release-reviewer');
    await release.shown;
    assert.equal(f.host.cliRuns.size, 2);
    assert.deepEqual([...f.host.cliRuns.values()].map(run => run.summary.state), ['waiting-for-enter', 'waiting-for-enter']);
    merge.enter();
    release.enter();
    await Promise.all([startingMerge, startingRelease]);
    assert.equal(f.launched.length, 2);
    await start('merge-reviewer');
    assert.equal(f.launched.length, 2, 'a second click reuses the live reviewer');
    const [first, second] = [...f.host.cliRuns.values()];
    assert.notEqual(first.terminal, second.terminal);
    const marker = path.join(f.leasePaths[0], 'owner.json');
    const ownership = JSON.parse(await readFile(marker, 'utf8')).nonce;
    merge.exit({ state: 'exited', code: 7 });
    await Promise.resolve();
    await Promise.all(f.host.cliSettlements);
    assert.equal(first.summary.state, 'failed');
    assert.equal(second.summary.state, 'running');
    await f.host.dispatchMessage({ type: 'resetCodexCliRun', runId: first.summary.runId });
    assert.equal(f.host.cliRuns.has(first.summary.runId), false);
    assert.equal(f.host.cliRuns.get(second.summary.runId), second);
    assert.equal(JSON.parse(await readFile(marker, 'utf8')).nonce, ownership);
    release.exit({ state: 'exited', code: 0 });
    await Promise.resolve();
    await Promise.all(f.host.cliSettlements);
    await assert.rejects(lstat(marker), { code: 'ENOENT' });
    assert.equal(f.calls.filter(call => call.action === 'finish').length, 1);
    assert.equal(f.host.cliRuns.size, 0);
  } finally {
    merge.manual.close();
    release.manual.close();
    await Promise.resolve();
    await Promise.allSettled(f.host.cliSettlements);
  }
});

test('a native review failure can be reset while the CLI terminal is still open', async t => {
  const f = await fixture(t);
  const terminal = manualTerminal(f);
  const runtimeRoot = path.join(f.root, 'review-runtime');
  const requestId = 'a'.repeat(32);
  const jobs = path.join(runtimeRoot, 'jobs');
  await mkdir(jobs, { recursive: true });
  await writeFile(path.join(runtimeRoot, '.merge-reviewer-runtime.json'), JSON.stringify({ schema: 'MergeReviewRuntime/v1', directory: runtimeRoot }));
  let notify!: () => void;
  t.mock.method(vscode.workspace, 'createFileSystemWatcher', () => ({
    onDidCreate(listener: () => void) { notify = listener; }, onDidChange() {}, dispose() {}
  }));
  const prepare = f.host.prepareSkillGuideTask;
  f.host.prepareSkillGuideTask = async (source: unknown) => ({ ...await prepare(source),
    review: { tool: 'merge-reviewer', requestId, runtimeRoot, workspace: f.root, repository: f.cwd } });
  const source: CodexCliSource = { kind: 'skill', featureId: 'merge-repo', inputs: { 'merge-repo.repo': f.cwd }, revision };
  const launching = f.host.dispatchMessage({ type: 'runCodexCli', source });
  try {
    await terminal.shown;
    terminal.enter();
    await launching;
    const [run] = f.host.cliRuns.values();
    const jobPath = path.join(jobs, requestId + '.json');
    const job = { schema: 'MergeReviewSession/v1', request_id: requestId, runtime_root: runtimeRoot, state: 'failed',
      phase: 'terminal', updated_at: '2026-10-22T00:00:00Z', error: 'Git admission failed',
      inputs: { workspace: f.root, project: f.cwd, base: 'origin/main', head: 'origin/topic' } };
    await writeFile(jobPath, JSON.stringify(job));
    notify();
    for (let attempt = 0; attempt < 100 && run.summary.state === 'running'; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.equal(run.summary.state, 'failed');
    assert.equal(run.summary.error, job.error);
    assert.equal(f.host.cliTerminals.size, 1);
    await f.host.dispatchMessage({ type: 'resetCodexCliRun', runId: run.summary.runId });
    assert.equal(f.host.cliRuns.size, 0);
    assert.deepEqual(JSON.parse(await readFile(jobPath, 'utf8')), job);
  } finally {
    terminal.manual.close();
    await Promise.resolve();
    await Promise.allSettled(f.host.cliSettlements);
  }
});

for (const scenario of [
  { name: 'a successful manual Codex exit finishes the workflow and releases its leases', result: { state: 'exited', code: 0 }, finish: true },
  { name: 'a nonzero manual Codex exit releases leases without finishing the workflow', result: { state: 'exited', code: 23 }, finish: false },
  { name: 'a refused manual Codex launch rolls back preparation and releases its leases', result: { state: 'not-started' }, finish: false },
  { name: 'an unconfirmed manual Codex exit preserves legacy leases and records the uncertainty', result: { state: 'unknown' }, finish: false }
] as const) {
  test(scenario.name, async t => {
    if (scenario.result.state === 'unknown') t.mock.method(LocalNetworkLease, 'acquireRecoverable', async () => undefined);
    const f = await fixture(t);
    const m = manualTerminal(f);
    const running = f.host.dispatchMessage({ type: 'runCodexCli', source: bmad });
    await m.shown;
    m.enter();
    await running;
    assert.deepEqual(f.calls.map(call => call.action), ['choose', 'bmad', 'launch', 'outcome']);
    for (const leasePath of f.leasePaths) assert.ok((await lstat(path.join(leasePath, 'owner.json'))).isFile());
    m.exit(scenario.result);
    await Promise.resolve();
    await Promise.all(f.host.cliSettlements);
    assert.equal(f.host.cliTerminals.size, 0);
    assert.equal(f.calls.some(call => call.action === 'finish'), scenario.finish);
    assert.equal(f.calls.some(call => call.action === 'rollback'), scenario.result.state === 'not-started');
    for (const leasePath of f.leasePaths) {
      if (scenario.result.state === 'unknown') assert.ok((await lstat(path.join(leasePath, 'owner.json'))).isFile());
      else await assert.rejects(lstat(leasePath), { code: 'ENOENT' });
    }
    if (scenario.result.state === 'unknown') {
      assert.equal(f.logs.filter(entry => entry.includes('terminal-exit-unconfirmed')).length, f.leasePaths.length);
    }
  });
}

test('CLI shutdown retains both leases until the direct terminal process is confirmed stopped', async t => {
  const f = await fixture(t);
  f.changes.exitStatus = undefined;
  const kill = process.kill;
  let stopped = false;
  t.mock.method(process, 'kill', (pid: number, signal?: string | number) => {
    if (pid !== process.pid || signal !== 0) return kill(pid, signal);
    if (stopped) throw Object.assign(new Error('Fixture process stopped'), { code: 'ESRCH' });
    return true;
  });
  await f.host.dispatchMessage({ type: 'runCodexCli', source: bmad });
  const closing = f.host.shutdownCliTerminals();
  assert.equal(f.calls.at(-1)?.action, 'dispose');
  for (const leasePath of f.leasePaths) assert.ok((await lstat(path.join(leasePath, 'owner.json'))).isFile());
  stopped = true;
  await closing;
  for (const leasePath of f.leasePaths) await assert.rejects(lstat(leasePath), { code: 'ENOENT' });
  assert.equal(f.calls.some(call => call.action === 'finish'), false);
});

test('CLI shutdown preserves unconfirmed legacy leases with per-path cleanup diagnostics', async t => {
  t.mock.method(LocalNetworkLease, 'acquireRecoverable', async () => undefined);
  const f = await fixture(t);
  f.changes.exitStatus = undefined;
  await f.host.dispatchMessage({ type: 'runCodexCli', source: bmad });
  await f.host.shutdownCliTerminals();
  for (const leasePath of f.leasePaths) assert.ok((await lstat(path.join(leasePath, 'owner.json'))).isFile());
  assert.equal(f.calls.some(call => call.action === 'finish'), false);
  const diagnostics = f.logs.map(line => JSON.parse(line.slice(line.indexOf('{'))));
  assert.deepEqual(diagnostics.map(value => [value.coordinationCode, value.coordinationPhase, value.leaseKind]),
    f.leasePaths.map(() => ['terminal-exit-unconfirmed', 'cleanup', 'codex']));
  assert.deepEqual(new Set(diagnostics.map(value => value.leasePath)), new Set(f.leasePaths));
});

test('Windows clears an unconfirmed terminal lease when no child was authorized', { skip: process.platform !== 'win32' }, async t => {
  const f = await fixture(t);
  f.changes.exitStatus = undefined;
  await f.host.dispatchMessage({ type: 'runCodexCli', source: bmad });
  const owner = JSON.parse(await readFile(path.join(f.leasePaths[0], 'owner.json'), 'utf8'));
  assert.deepEqual(owner.lifecycle.jobs, []);
  await f.host.shutdownCliTerminals();
  for (const leasePath of f.leasePaths) await assert.rejects(lstat(leasePath), { code: 'ENOENT' });
  assert.equal(f.calls.some(call => call.action === 'finish'), false);
  assert.equal(f.logs.some(entry => entry.includes('terminal-exit-unconfirmed')), false);
});

test('installer preflight attempts all releases and keeps the confirmed result when one release fails', async t => {
  const f = await fixture(t);
  f.host.projectContext = { root: f.root };
  f.host.localWorkspaceRepositories = [{ path: f.cwd }];
  const release = CodexWorkspaceLease.prototype.release;
  const attempted: string[] = [];
  const failed: CodexWorkspaceLease[] = [];
  t.mock.method(CodexWorkspaceLease.prototype, 'release', async function (this: CodexWorkspaceLease) {
    attempted.push(this.directory);
    if (!failed.length) {
      failed.push(this);
      throw new NetworkLeaseError('Fixture release blocked', 'release-pending', { leaseKind: 'codex', leasePath: this.directory });
    }
    await release.call(this);
  });
  const confirmed = { effect: 'applied' };
  assert.equal(await f.host.withCodexWriteGuard({ type: 'installWorkflowKit' }, async () => confirmed), confirmed);
  assert.deepEqual(new Set(attempted), new Set(f.leasePaths));
  assert.equal(attempted.length, 2);
  assert.equal(f.logs.length, 1);
  assert.match(f.logs[0], /release-pending/);
  await release.call(failed[0]);
});
