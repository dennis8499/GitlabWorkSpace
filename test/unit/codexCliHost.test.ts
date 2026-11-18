import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { CodexCliSource } from '../../src/codex/cliProtocol';
import type { CodexTerminalLaunch, CodexTerminalSelection } from '../../src/codex/terminal';

const vscode = {
  workspace: { isTrusted: true },
  TerminalExitReason: { Process: 2 },
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
  const changes = { canAccess: true, launchError: undefined as Error | undefined };
  const launched: Array<{ selection: CodexTerminalSelection; options: CodexTerminalLaunch }> = [];
  const terminal = {
    choose: async (_configured: string, cwd: string) => { calls.push({ action: 'choose', data: cwd }); return choices.value; },
    launch: async (selection: CodexTerminalSelection, options: CodexTerminalLaunch) => {
      calls.push({ action: 'launch' });
      if (changes.launchError) throw changes.launchError;
      launched.push({ selection, options });
      return { exitStatus: { code: 0, reason: vscode.TerminalExitReason.Process } };
    }
  };
  const prepare = (action: string, data: unknown) => {
    calls.push({ action, data });
    return { title: 'Fixture review', root, executionRoot: cwd, writableRoots: [cwd], skill: { name: 'fixture', path: skillPath },
      prompt: 'Verified task prompt', finish: async () => { calls.push({ action: 'finish' }); },
      rollback: async () => { calls.push({ action: 'rollback' }); } };
  };
  const host = Object.assign(Object.create(WorkspacePanel!.prototype), {
    disposed: false,
    resolveProjectContext: async () => ({ root }),
    captureProjectAccess: () => () => { if (!changes.canAccess) throw new Error('工作區已變更'); },
    codexExecutableSetting: () => '',
    getCodexTerminal: () => terminal,
    post: () => undefined,
    cliTerminals: new Map(),
    cliSettlements: new Set(),
    connectedScopeKey: () => 'connected-scope',
    currentUser: { id: 1 },
    session: { baseUrl: 'https://gitlab.test', getClient: async () => ({
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
  return { host, root, cwd, skillPath, heads, calls, selected, choices, changes, launched, terminal };
}

test('retained workflow sources launch the chosen CLI settings with prepared input and writable scope', async t => {
  const f = await fixture(t);
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
