import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { CodexCliSource } from '../../src/codex/cliProtocol';
import type { ManualCodexResult, ManualCodexTerminal } from '../../src/codex/manualTerminal';
import type { CodexTerminalLaunch, CodexTerminalSelection } from '../../src/codex/terminal';
import { LocalNetworkLease, NetworkLeaseError, networkRuntimeRoot } from '../../src/api/localNetworkLease';
import { CodexWorkspaceLease } from '../../src/codex/workspaceLease';
import { OperationLog } from '../../src/logging/operationLog';

const vscode = {
  workspace: { isTrusted: true, getConfiguration: () => ({
    inspect: (_setting: string): { globalValue?: unknown; workspaceValue?: unknown } | undefined => undefined
  }) },
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
    post: () => undefined,
    cliTerminals: new Map(),
    cliSettlements: new Set(),
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
    prepareCliMergeRequest: async (source: unknown, binding: unknown, repository: string) => prepare('merge-request', { source, binding, repository }),
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
      const data = f.calls[1].data as { source: CodexCliSource; binding: { head: string; base: string }; repository: string };
      assert.deepEqual(data.source, source);
      assert.deepEqual([data.binding.head, data.binding.base], ['a'.repeat(40), 'b'.repeat(40)]);
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

test('source or local project drift during model selection prevents CLI launch', async t => {
  const f = await fixture(t);
  t.mock.method(f.terminal, 'choose', async () => { f.heads.current = 'c'.repeat(40); return f.selected; });
  await assert.rejects(f.host.dispatchMessage({ type: 'runCodexCli', source: mergeRequest('merge-reviewer') }), /固定來源或目標版本已變更/);
  assert.deepEqual(f.calls, []);
  t.mock.method(f.terminal, 'choose', async () => { f.changes.canAccess = false; return f.selected; });
  await assert.rejects(f.host.dispatchMessage({ type: 'runCodexCli', source: skill }), /工作區已變更/);
  assert.deepEqual(f.launched, []);
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
