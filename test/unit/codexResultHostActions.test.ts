import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, realpath, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type * as VSCode from 'vscode';
import { CodexHostActions, type CodexHostActionOptions } from '../../src/codex/hostActions';
import type { CodexResultManifest } from '../../src/codex/resultProtocol';
import type { CodexTaskSource, CodexTaskSpec, CodexTaskState } from '../../src/codex/protocol';
import { isCodexCommand } from '../../src/codex/commands';
import { isWorkspaceRequest } from '../../src/workspace/workspaceRequestValidation';
import { describeAction } from '../../src/workspace/actionPolicy';
import { ActionController } from '../../src/workspace/actionController';

async function fixture(t: test.TestContext) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'glw-result-host-'));
  assert.ok(path.resolve(directory).startsWith(path.resolve(os.tmpdir()) + path.sep));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await mkdir(path.join(directory, 'repo')); await mkdir(path.join(directory, 'manual'));
  const repository = await realpath(path.join(directory, 'repo')), parent = await realpath(path.join(directory, 'manual'));
  const manifest: CodexResultManifest = { schema: 'GitLabWorkspaceCodexResult/v1', id: 'saved-task', title: 'Saved change', root: path.join(directory, 'removed-runtime'),
    status: 'completed', createdAt: '2026-01-01', updatedAt: '2026-01-01', reason: 'completed', summary: 'Saved summary',
    restore: { schema: 'GitLabWorkspaceCodexChanges/v1', originalRepository: repository, baseSha: 'a'.repeat(40), headSha: 'b'.repeat(40), objectFormat: 'sha1',
      patchArtifactId: 'patch', inventoryArtifactId: 'inventory', validatedAt: '2026-01-01' },
    artifacts: [{ id: 'handoff', path: 'handoff.md', name: '手動接續說明', mediaType: 'text/markdown', size: 12, sha256: 'a'.repeat(64) }] };
  const events: string[] = [], documents: string[] = [], copied: string[] = [], created: CodexTaskSource[] = [], exports: string[] = [], warnings: string[] = [];
  const dialogs: Array<Array<{ fsPath: string }> | undefined> = [[{ fsPath: parent }]], notices: Array<string | undefined> = ['開啟工作目錄'];
  let restore = async (_id: string, repo: string, destination: string) => { assert.equal(repo, repository); events.push('restore'); return { path: destination, branch: 'manual/saved-task', baseSha: manifest.restore!.baseSha }; };
  let cleanupError: Error | undefined, unsealed = false;
  const pendingExports: string[] = [], initialized: boolean[] = [], stopped: Array<{ id: string; reason: string }> = [], nativePicks: unknown[][] = [], pickerIndices: number[] = [];
  const connections: CodexTaskState[] = [{ id: manifest.id, title: 'Other account connection', root: manifest.root, status: 'completed',
    createdAt: manifest.createdAt, updatedAt: manifest.updatedAt, controls: { external: false, canPause: false, canResume: false, canDelete: false, canAutoAccept: false, autoAccept: false } },
  { id: 'already-saved', title: 'Only a saved result', root: manifest.root, status: 'completed', createdAt: manifest.createdAt, updatedAt: manifest.updatedAt, retention: 'results-only' }];
  const bridge = { initialize: async () => { initialized.push(true); }, list: () => connections,
    resultManifest: async () => { if (unsealed) throw new Error('not sealed'); return manifest; },
    exportForHandoff: async (_id: string, destination: string) => { pendingExports.push(destination); return manifest; },
    stopAndClean: async (id: string, reason: string) => { stopped.push({ id, reason }); if (cleanupError) throw cleanupError; }, results: { directory: path.join(directory, 'durable-results'),
    readArtifact: async (_id: string, artifactId: string) => { assert.equal(artifactId, 'handoff'); return { artifact: manifest.artifacts[0], bytes: Buffer.from('Saved handoff') }; },
    restoreTo: (...args: Parameters<typeof restore>) => restore(...args), exportTo: async (_id: string, destination: string) => { exports.push(destination); } } };
  const options: CodexHostActionOptions = { bridge: () => bridge as unknown as ReturnType<CodexHostActionOptions['bridge']>,
    repositories: async () => { throw new Error('must not inspect GitLab repositories'); }, prepare: async () => { throw new Error('must not prepare App Server'); },
    createTask: async source => { created.push(source); return 'new-task'; }, selected: async () => {}, check: () => { throw new Error('must not require original task'); },
    diff: async () => {}, workflow: async () => {}, reply: async () => {} };
  const executed: Array<{ command: string; args: unknown[] }> = [];
  const vscode = { workspace: { isTrusted: true, openTextDocument: async (input: { content: string }) => { documents.push(input.content); return input; } },
    Uri: { file: (fsPath: string) => ({ fsPath }) }, env: { clipboard: { writeText: async (text: string) => { copied.push(text); } } },
    commands: { executeCommand: async (command: string, ...args: unknown[]) => { executed.push({ command, args }); } },
    window: { showQuickPick: async (items: unknown[]) => { nativePicks.push(items); return items[pickerIndices.shift() ?? 0]; }, showOpenDialog: async () => dialogs.shift(),
      showInformationMessage: async () => notices.shift(), showWarningMessage: async (message: string) => { warnings.push(message); }, showTextDocument: async () => {} } } as unknown as typeof VSCode;
  const actions = new CodexHostActions(options, vscode), admitted: CodexTaskSpec[] = [];
  Object.assign(actions, { restoreScheduler: { tryAcquire: async (_taskId: string, spec: CodexTaskSpec) => { admitted.push(spec); return { reservation: {
    primary: { release: async () => { events.push('primary-release'); } }, extras: [{ release: async () => { events.push('extra-release'); } }],
    release: async (quarantine: boolean, stopped: boolean) => { events.push(`reservation-release:${quarantine}:${stopped}`); } } }; } } });
  return { actions, directory, repository, parent, manifest, events, documents, copied, created, dialogs, notices, exports, executed, admitted, warnings, pendingExports,
    connections, nativePicks, pickerIndices, initialized, stopped,
    failCleanup: (withoutSealedResult = false) => { cleanupError = new Error('native thread deletion unavailable'); unsealed = withoutSealedResult; },
    failRestore: () => { restore = async () => { events.push('restore'); throw new Error('restore failed'); }; } };
}

test('saved code restores with repository and destination admission, then opens a user-owned directory without App Server', async t => {
  const f = await fixture(t); await f.actions.run({ action: 'restore-result', taskId: f.manifest.id });
  assert.deepEqual(f.events, ['restore', 'primary-release', 'extra-release', 'reservation-release:false:true']);
  const spec = f.admitted[0], destination = spec.writableRoots[0];
  assert.equal(spec.root, f.repository); assert.equal(spec.executionRoot, f.repository);
  assert.equal(path.dirname(destination), f.parent); assert.match(path.basename(destination), /^codex-manual-saved-task-[a-f0-9]{8}$/);
  assert.equal(f.executed[0].command, 'vscode.openFolder'); assert.deepEqual(f.executed[0].args, [{ fsPath: destination }, { forceNewWindow: true }]);
  assert.match(f.documents[0], /不會由原任務自動清理/); assert.match(f.documents[0], /Saved handoff/);
  assert.ok(f.documents[0].includes(JSON.stringify(path.join(f.directory, 'durable-results', f.manifest.id))));
  assert.equal(f.created.length, 0);
});

test('failed restoration releases every lease and never opens a directory or starts a task', async t => {
  const f = await fixture(t); f.failRestore();
  await assert.rejects(f.actions.run({ action: 'restore-result', taskId: f.manifest.id }), /restore failed/);
  assert.deepEqual(f.events, ['restore', 'primary-release', 'extra-release', 'reservation-release:false:true']);
  assert.equal(f.executed.length, 0); assert.equal(f.created.length, 0);
});

test('saved handoff and new task use durable artifact paths while a missing repository can still export documents', async t => {
  const f = await fixture(t); await f.actions.run({ action: 'copy-handoff', taskId: f.manifest.id });
  assert.match(f.copied[0], /Saved handoff/); assert.ok(f.copied[0].includes(JSON.stringify(path.join(f.directory, 'durable-results', f.manifest.id))));
  await f.actions.run({ action: 'new-from-result', taskId: f.manifest.id });
  assert.equal(f.created[0].kind, 'free'); assert.equal(f.created[0].kind === 'free' && f.created[0].repository, f.repository);
  assert.equal(f.created[0].kind === 'free' && f.created[0].prompt, f.copied[0]);
  f.manifest.restore = undefined; f.notices.splice(0, f.notices.length, '匯出成果包');
  await f.actions.run({ action: 'new-from-result', taskId: f.manifest.id });
  assert.equal(f.created.length, 1); assert.equal(f.exports.length, 1); assert.equal(f.events.length, 0);
});

test('new work from a cloned task result starts with its original Group rather than the shared cache', async t => {
  const f = await fixture(t); f.manifest.restore!.commitBundleArtifactId = 'commits';
  f.manifest.root = f.directory;
  await f.actions.run({ action: 'new-from-result', taskId: f.manifest.id });
  assert.equal(f.created.length, 1); assert.equal(f.created[0].kind, 'free');
  assert.equal(f.created[0].kind === 'free' && f.created[0].repository, f.directory);
  assert.equal((f.nativePicks[0][0] as { description: string }).description, f.directory);
  assert.equal(f.events.length, 0, 'creating a follow-up does not restore or mutate the source cache');
});

test('native fork is offered only for ordinary free conversations and forged managed requests never read turns', async () => {
  const root = os.tmpdir(), base: CodexTaskSpec = { source: { kind: 'free', repository: root, prompt: 'Continue' }, root,
    title: 'Conversation', workspaceKey: 'fixture', prompt: 'Continue', writableRoots: [root], environmentKey: 'fixture' };
  const managed = { ...base, taskWorkspace: { schema: 'GitLabWorkspaceTaskWorkspace/v1' as const, taskId: 'task', directory: root,
    workspaceFile: path.join(root, 'task.code-workspace'), originRoot: root } };
  const linked = { ...base, source: { kind: 'issue' as const, projectId: 1, issueIid: 42 } };
  for (const spec of [base, managed, linked]) {
    let reads = 0; const menus: Array<Array<{ value: string }>> = [];
    const task = { id: 'task', title: spec.title, status: 'paused', controls: { canResume: true } };
    const bridge = { specification: async () => spec, list: () => [task], turns: async () => { reads++; return []; } };
    const options = { bridge: () => bridge, check: () => {} } as unknown as CodexHostActionOptions;
    const vscode = { workspace: { isTrusted: true }, window: { showQuickPick: async (items: Array<{ value: string }>) => { menus.push(items); return undefined; } } } as unknown as typeof VSCode;
    const actions = new CodexHostActions(options, vscode); await actions.run({ action: 'manage', taskId: task.id });
    assert.equal(menus[0].some(item => item.value === 'fork'), spec === base);
    if (spec !== base) await assert.rejects(actions.run({ action: 'fork', taskId: task.id }), /持久成果.*新任務/);
    assert.equal(reads, 0);
  }
});

test('manual handoff still exports a sealed result when cleanup requires attention', async t => {
  const f = await fixture(t); f.failCleanup(); f.manifest.restore = undefined;
  await f.actions.run({ action: 'manual-handoff', taskId: f.manifest.id });
  assert.equal(f.exports.length, 1); assert.match(f.warnings[0], /native thread deletion unavailable/);
  assert.match(f.warnings[0], /原暫存環境保留/); assert.equal(f.created.length, 0);
});

test('manual handoff exports pending receipts to a new package when publication prevents sealing', async t => {
  const f = await fixture(t); f.failCleanup(true);
  await f.actions.run({ action: 'manual-handoff', taskId: f.manifest.id });
  assert.equal(f.pendingExports.length, 1); assert.equal(path.dirname(f.pendingExports[0]), f.parent);
  assert.match(path.basename(f.pendingExports[0]), /^codex-handoff-saved-task-[a-f0-9]{8}$/);
  assert.match(f.warnings.at(-1)!, /發布／清理結果仍待核對/); assert.match(f.warnings.at(-1)!, /不要重複發布/);
  assert.equal(f.exports.length, 0); assert.equal(f.created.length, 0); assert.equal(f.admitted.length, 0);
  assert.equal(f.executed[0].command, 'revealFileInOS');
});

test('native connection manager lists local connections across account filtering without exposing saved-only cards', async t => {
  const f = await fixture(t); f.pickerIndices.push(0, 1);
  await f.actions.run({ action: 'manage-local-connections' });
  assert.equal(f.initialized.length, 1); assert.equal(f.nativePicks[0].length, 1);
  assert.equal((f.nativePicks[0][0] as { label: string }).label, 'Other account connection');
  assert.deepEqual(f.stopped, [{ id: f.manifest.id, reason: 'deleted' }]);
  assert.equal(f.created.length, 0); assert.equal(f.documents.length, 0);
});

test('connection manager reuses manual export and sends externally owned running tasks to their original window', async t => {
  const f = await fixture(t); f.manifest.restore = undefined;
  await f.actions.run({ action: 'manage-local-connections' });
  assert.deepEqual(f.stopped, [{ id: f.manifest.id, reason: 'manual' }]); assert.equal(f.exports.length, 1);
  f.stopped.length = 0; f.nativePicks.length = 0; f.connections[0].controls!.external = true; f.connections[0].status = 'running';
  await f.actions.run({ action: 'manage-local-connections' });
  assert.equal(f.nativePicks.length, 1); assert.equal(f.stopped.length, 0);
});

test('connection management is a parameterless local control and bypasses active publisher exclusivity', () => {
  const request = { type: 'codexCommand', command: { action: 'manage-local-connections' } };
  assert.equal(isCodexCommand(request.command), true); assert.equal(isWorkspaceRequest(request), true);
  assert.equal(isCodexCommand({ ...request.command, taskId: 'foreign-task' }), false);
  const policy = describeAction(request);
  assert.equal(policy.kind, 'control'); assert.equal(policy.concurrency, 'parallel');
  const sent: unknown[] = [], controller = new ActionController(value => { sent.push(value); });
  const delivery = controller.dispatch({ type: 'codexCommand', command: { action: 'retry-delivery', taskId: 'saved-task' } });
  assert.equal(delivery.status, 'started'); assert.equal(controller.dispatch(request).status, 'started'); assert.equal(sent.length, 2);
  controller.dispose();
});

test('delivery confirmation shows reviewed target differences, complete commit messages and validation before authorizing its exact digest', async () => {
  const targetDetail = `目標分支：main\n固定測試基準：${'1'.repeat(40)}\n本次確認的目標版本：${'2'.repeat(40)}\n目標分支已前進；尚未驗證與目前目標整合後的結果。本次保留原基準，不會自動 rebase。\n查看差異：https://gitlab.test/team/repo/-/compare/${'1'.repeat(40)}...${'2'.repeat(40)}`;
  const preview = { digest: 'd'.repeat(64), summary: 'Ready change\n\n' + targetDetail,
    commits: [{ sha: 'a'.repeat(40), subject: 'First (#42)', message: 'First (#42)\n\nReviewed body with migration detail.\nTrailer: retained' },
      { sha: 'b'.repeat(40), subject: 'Second (#42)', message: 'Second (#42)\n\nA separate follow-up body.' }],
    plannedCommitMessage: 'Finish requirement (#42)\n\nGitLab-Workspace-Task: task-42',
    validation: { cwd: os.tmpdir(), testedAt: '2026-11-13T10:20:30.000Z', artifactDigest: 'e'.repeat(64),
      commands: [{ command: 'npm test -- --runInBand', exitCode: 0, cwd: path.join(os.tmpdir(), 'repo') }] } };
  for (const decision of [undefined, '確認並交付']) {
    const confirmations: Array<{ id: string; digest: string }> = [], details: string[] = [];
    const bridge = { previewDelivery: async (id: string) => { assert.equal(id, 'task-42'); return preview; },
      confirmDelivery: async (id: string, digest: string) => { confirmations.push({ id, digest }); } };
    const options = { bridge: () => bridge } as unknown as CodexHostActionOptions;
    const vscode = { workspace: { isTrusted: true }, window: {
      showWarningMessage: async (_message: string, options: { modal: boolean; detail: string }) => {
        assert.equal(options.modal, true); details.push(options.detail); assert.equal(confirmations.length, 0); return decision;
      }
    } } as unknown as typeof VSCode;
    await new CodexHostActions(options, vscode).run({ action: 'confirm-delivery', taskId: 'task-42' });
    assert.equal(details.length, 1);
    assert.ok(details[0].includes(targetDetail), 'the human sees both target versions and the comparison before authorization');
    for (const commit of preview.commits) { assert.ok(details[0].includes(commit.sha)); assert.ok(details[0].includes(commit.message)); }
    assert.ok(details[0].includes(preview.plannedCommitMessage)); assert.match(details[0], /乾淨工作樹直接採用已驗證 HEAD/);
    assert.ok(details[0].includes(preview.validation.testedAt)); assert.ok(details[0].includes(preview.validation.artifactDigest));
    assert.ok(details[0].includes(preview.validation.cwd)); assert.ok(details[0].includes(preview.validation.commands[0].cwd));
    assert.match(details[0], /exit 0 · npm test -- --runInBand/);
    assert.deepEqual(confirmations, decision ? [{ id: 'task-42', digest: preview.digest }] : []);
  }
});
