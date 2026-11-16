import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createTaskWorkspace, readTaskWorkspace } from '../../src/codex/taskWorkspace';
import type { CodexTaskSpec } from '../../src/codex/protocol';
import { workflowHash } from '../../src/codex/projectWorkflows';

const loader = require('node:module'), original = loader._load;
const opened: string[] = [];
const uri = (fsPath: string) => ({ fsPath, toString: () => fsPath });
const vscodeApi = { workspace: { isTrusted: true, workspaceFolders: [] as Array<{ uri: ReturnType<typeof uri> }> },
  window: { showQuickPick: async (items: Array<{ id: string }>) => items[0] },
  Uri: { file: uri }, commands: { executeCommand: async (_name: string, target: ReturnType<typeof uri>) => { opened.push(target.fsPath); } } };
loader._load = (name: string, ...args: unknown[]) => name === 'vscode' ? vscodeApi : original(name, ...args);
let WorkspacePanel: any;
try { ({ WorkspacePanel } = require('../../src/workspace/workspacePanel')); } finally { loader._load = original; }

async function fixture(t: test.TestContext) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'glw-task-host-')), storage = path.join(root, 'storage');
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(storage); opened.length = 0;
  const spec: CodexTaskSpec = { source: { kind: 'group-analysis', requirement: 'Explore committed sources' },
    root, executionRoot: path.join(storage, 'artifacts'), title: 'Local exploration', prompt: 'Explore',
    writableRoots: [], workspaceKey: root, environmentKey: 'fixture' };
  const queued: CodexTaskSpec[] = [], panel = Object.create(WorkspacePanel.prototype);
  panel.context = { globalStorageUri: { fsPath: storage }, workspaceState: { update: async () => {} } };
  panel.session = { activeAccountId: 'expired-account' };
  panel.resolveProjectContext = async () => ({ root }); panel.show = async () => {}; panel.post = () => {};
  panel.switchAccount = async () => { throw new Error('Local tasks must not request GitLab authentication'); };
  panel.getCodexBridge = () => ({ initialize: async () => {}, publish: async () => {}, list: () => [],
    claimTaskWorkspace: (binding: { workspaceFile: string }) => readTaskWorkspace(storage, binding.workspaceFile),
    enqueue: async (prepared: CodexTaskSpec) => { queued.push(prepared); } });
  return { root, storage, spec, panel, queued };
}

test('local exploration starts in its origin Group without binding an expired GitLab account or opening a window', async t => {
  const f = await fixture(t);
  assert.equal(await f.panel.openIsolatedCodexWorkspace(f.spec, 'local-exploration'), 'local-exploration');
  assert.equal(f.queued.length, 1); assert.deepEqual(opened, []);
  const launch = await readTaskWorkspace(f.storage, f.queued[0].taskWorkspace!.workspaceFile);
  assert.equal(launch.binding.accountId, undefined); assert.equal(launch.windowMode, 'origin');
  assert.equal(launch.preparedSpec?.root, f.root);
  assert.equal(f.queued[0].root, f.root); assert.equal(f.queued[0].executionRoot, f.spec.executionRoot);
});

test('reopening a local launch made by an older host does not require its saved GitLab login', async t => {
  const f = await fixture(t), launch = await createTaskWorkspace(f.storage,
    { source: f.spec.source, originRoot: f.root, accountId: 'expired-account', preparedSpec: f.spec }, 'offline-reopen');
  vscodeApi.workspace.workspaceFolders = [{ uri: uri(path.join(launch.binding.directory, 'workspace')) }];
  await f.panel.openTaskWorkspace(launch);
  assert.equal(f.queued.length, 1); assert.equal(f.queued[0].root, f.root);
  assert.equal(f.queued[0].taskWorkspace?.taskId, 'offline-reopen');
});

test('an origin BMAD launch retains its working folder and persistent output without opening a window', async t => {
  const f = await fixture(t), outputRoot = path.join(f.storage, 'codex-bmad-artifacts', 'bmad-output');
  const spec = { ...f.spec, executionRoot: undefined, bmadArtifacts: { outputRoot } };
  await f.panel.openIsolatedCodexWorkspace(spec, 'bmad-folders');
  assert.equal(f.queued.length, 1); assert.deepEqual(opened, []);
  const workspace = JSON.parse(await readFile(f.queued[0].taskWorkspace!.workspaceFile, 'utf8'));
  assert.deepEqual(workspace.folders.map((folder: { path: string }) => folder.path), ['workspace', f.root, outputRoot]);
  assert.equal(workspace.settings['gitlabWorkspace.projectRoot'], f.root);
  assert.equal(f.queued[0].bmadArtifacts?.outputRoot, outputRoot);
});

test('reopening durable cleanup never recreates the task if cleanup finishes immediately after claim', async t => {
  const f = await fixture(t), launch = await createTaskWorkspace(f.storage,
    { source: f.spec.source, originRoot: f.root, preparedSpec: f.spec }, 'closing-task');
  vscodeApi.workspace.workspaceFolders = [{ uri: uri(path.join(launch.binding.directory, 'workspace')) }];
  let claimed = false;
  f.panel.getCodexBridge = () => ({ initialize: async () => {}, list: () => claimed ? [] : [{ id: 'closing-task' }],
    claimTaskWorkspace: async () => { claimed = true; return launch; },
    enqueue: async () => { throw new Error('A closing task must not be recreated'); } });
  await f.panel.openTaskWorkspace(launch); assert.equal(claimed, true);
});

test('managed activation removes an earlier passive MR preparation and keeps explicit continue available', async t => {
  const f = await fixture(t), id = 'owned-wiki', draftId = 'f553532c-3971-4faa-a4c9-05fd79197dda', messages: any[] = [];
  f.panel.codexAccountKey = () => 'connected-user-2'; f.panel.projectContext = { root: f.root };
  f.panel.post = (message: unknown) => messages.push(message); f.panel.navigateTo = async () => {};
  const directory = path.join(f.storage, 'codex-launches'), file = path.join(directory, draftId + '.json'); await mkdir(directory);
  const blocked = { schema: 'GitLabWorkspaceCodexLaunch/v1', id: draftId, revision: 9,
    scope: workflowHash(['connected-user-2', f.root].join('\0')), state: 'blocked', title: 'MR !1 · Merge review',
    source: { kind: 'merge-request', projectId: 2, iid: 1, reviewerTool: 'merge-reviewer' }, requirement: '',
    repositories: [], models: [], additionalSkillIds: [], availableSkills: [], testCommands: [], automaticDelivery: false,
    checks: [{ id: 'workflow', label: 'Workflow', state: 'blocked' }], updatedAt: '2026-11-14T00:00:00.000Z' };
  const before = JSON.stringify(blocked); await writeFile(file, before);
  const coordinator = f.panel.getCodexLaunch(); t.after(() => coordinator.dispose());
  await coordinator.publish(); assert.equal(messages.at(-1).draft.id, draftId, 'simulate a Webview resolving before managed activation');
  const launch = await createTaskWorkspace(f.storage, { source: f.spec.source, originRoot: f.root, preparedSpec: f.spec }, id);
  vscodeApi.workspace.workspaceFolders = [{ uri: uri(path.join(launch.binding.directory, 'workspace')) }];
  f.panel.getCodexBridge = () => ({ initialize: async () => {}, publish: async () => {}, list: () => [{ id }],
    claimTaskWorkspace: async () => launch, enqueue: async () => { throw new Error('Reopening cannot start another model'); } });
  messages.length = 0; await f.panel.openTaskWorkspace(launch); await f.panel.dispatchMessage({ type: 'listCodexTasks' });
  assert.equal(messages.some(message => message.type === 'codexTaskStarted' && message.taskId === id), true);
  assert.equal(messages.some(message => message.type === 'codexLaunchDraft' && message.draft), false);
  assert.equal(await readFile(file, 'utf8'), before);
  await f.panel.dispatchMessage({ type: 'pickCodexLaunch' });
  assert.equal(messages.at(-1).type, 'codexLaunchDraft'); assert.equal(messages.at(-1).draft.id, draftId); assert.equal(messages.at(-1).open, true);
  await f.panel.dispatchMessage({ type: 'listCodexTasks' }); assert.equal(messages.at(-1).draft.id, draftId, 'explicit continue is retained');
  assert.equal(f.queued.length, 0);
});

test('a persisted launch remains discoverable and reopens after the initial window dispatch was lost', async t => {
  const f = await fixture(t), launch = await createTaskWorkspace(f.storage,
    { source: f.spec.source, originRoot: f.root, preparedSpec: f.spec }, 'pending-launch');
  const coordinator = f.panel.getCodexLaunch(); t.after(() => coordinator.dispose());
  assert.equal(await coordinator.options.taskExists('pending-launch'), true);
  assert.equal(await coordinator.options.taskExists('missing-launch'), false);
  await f.panel.dispatchMessage({ type: 'showCodexTask', taskId: 'pending-launch' });
  assert.deepEqual(opened, [launch.binding.workspaceFile]); assert.equal(f.queued.length, 0);
  await assert.rejects(f.panel.pendingCodexTaskWorkspace('../other'), /識別無效/);
});
