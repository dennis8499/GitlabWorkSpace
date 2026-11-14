import assert from 'node:assert/strict';
import test from 'node:test';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { buildBmadCommand } from '../../src/workspace/bmadCommand';
import type { BmadWorkflowSnapshot } from '../../src/workspace/bmadProtocol';
import { readBmadWorkflow } from '../../src/workspace/bmadWorkflow';
import { WorkflowKitService } from '../../src/workspace/workflowKitService';

const uri = (fsPath: string) => ({ scheme: 'file', fsPath, toString: () => `file:${fsPath}` });
const configuredRoots = new Map<string, string>();
const opened: string[] = [], shown: string[] = [], copied: string[] = [], terminals: any[] = [];
const watches: Array<{ base: string; pattern: string }> = [];
let _terminalAvailable = true;
const vscode = {
  Uri: { file: uri, joinPath: (base: ReturnType<typeof uri>, ...parts: string[]) => uri(path.join(base.fsPath, ...parts)) },
  RelativePattern: class { constructor(public baseUri: ReturnType<typeof uri>, public pattern: string) {} },
  workspace: {
    isTrusted: true, workspaceFolders: [] as Array<{ uri: ReturnType<typeof uri>; name: string }>,
    getConfiguration: (_section: string, resource?: ReturnType<typeof uri>) => ({ get: (key: string, fallback: unknown) => key === 'projectRoot' ? configuredRoots.get(resource?.toString() ?? '') ?? fallback : fallback }),
    createFileSystemWatcher: (pattern: any) => {
      watches.push({ base: pattern.baseUri.fsPath, pattern: pattern.pattern });
      const subscribe = (_changed: unknown) => ({ dispose: () => undefined });
      return { onDidCreate: subscribe, onDidChange: subscribe, onDidDelete: subscribe, dispose: () => undefined };
    },
    openTextDocument: async (target: ReturnType<typeof uri>) => { opened.push(target.fsPath); return { uri: target }; }
  },
  env: { clipboard: { writeText: async (text: string) => { copied.push(text); } } },
  window: { showTextDocument: async (document: any) => { if (document.fsPath) shown.push(document.fsPath); },
    createTerminal: (options: unknown) => { terminals.push(options); return { show: () => undefined,
      sendText: () => { throw new Error('BMAD terminal must remain empty'); } }; } }
};
const loader = require('node:module') as { _load(name: string, parent: unknown, main: boolean): unknown };
const originalLoad = loader._load;
loader._load = (name, parent, main) => name === 'vscode' ? vscode : originalLoad(name, parent, main);
let WorkspacePanel: typeof import('../../src/workspace/workspacePanel').WorkspacePanel;
try { ({ WorkspacePanel } = require('../../src/workspace/workspacePanel')); }
finally { loader._load = originalLoad; }

const CATALOG = ['module,skill,display-name,menu-code,description,action,args,phase,preceded-by,followed-by,required,output-location,outputs',
  'BMad Method,bmad-prd,PRD,PRD,Requirements,,,2-planning,,,true,planning_artifacts,prd',
  'BMad Method,bmad-build,Build,BD,Build,,,ship,,,true,implementation_artifacts,spec',
  'Core,bmad-help,Help,BH,Help,,,anytime,,,false,,'].join('\n');
function memory() {
  const values = new Map<string, unknown>();
  return { get: <T>(key: string, fallback?: T) => values.has(key) ? values.get(key) as T : fallback,
    update: async (key: string, value: unknown) => { values.set(key, value); } };
}
async function fixture(t: test.TestContext) {
  const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'bmad-host-test-')));
  const root = path.join(base, '專案'), second = path.join(base, 'second'), extensionRoot = path.join(base, 'extension');
  async function write(target: string, relative: string, content: string) {
    const file = path.join(target, relative); await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, content);
  }
  await fs.mkdir(root); await fs.mkdir(second); await fs.mkdir(path.join(base, 'storage'));
  await write(extensionRoot, 'resources/bmad/bmad-help.csv', CATALOG);
  for (const target of [root, second]) {
    await write(target, '_bmad/_config/manifest.yaml', 'installation:\n  version: 6.12.4\n');
    await write(target, '_bmad/_config/bmad-help.csv', CATALOG);
    await write(target, '_bmad/config.toml', '[core]\noutput_folder = "_bmad-output"\n');
    await write(target, '_bmad/scripts/resolve_config.py', '# installed resolver\n');
    await write(target, '_bmad/scripts/render_skill.py', '# installed renderer\n');
    for (const skill of ['bmad-help', 'bmad-build', 'bmad-prd']) await write(target, `.agents/skills/${skill}/SKILL.md`, `---\nname: ${skill}\n---\n`);
  }
  configuredRoots.clear(); opened.length = 0; shown.length = 0; copied.length = 0; terminals.length = 0; watches.length = 0; _terminalAvailable = true;
  vscode.workspace.isTrusted = true;
  vscode.workspace.workspaceFolders = [{ uri: uri(root), name: '專案' }];
  let features = ['bmad-workflow']; let runtimeReason: string | undefined; let runtimeChecks = 0, kitChecks = 0;
  let kitState: import('../../src/workspace/workspaceProtocol').InstalledWorkflowKitState = { status: 'missing' };
  const outcomes: unknown[] = [], errors: unknown[] = [];
  const host: any = Object.assign(Object.create(WorkspacePanel!.prototype), {
    disposed: false, activeMode: 'bmad', webviewReady: true, panel: { visible: true },
    context: { workspaceState: memory(), extensionUri: uri(extensionRoot), globalStorageUri: uri(path.join(base, 'storage')),
      extension: { packageJSON: { version: 'test' } } }, session: { connectionEpoch: 0 },
    bmadAutoBuildProofs: new Map(),
    bmadRuntimeReason: undefined, sendSnapshot: () => undefined, post: (message: unknown) => errors.push(message),
    refreshWorkflowKitInstallState: async () => {
      kitChecks++; host.projectContext = await host.resolveProjectContext();
      host.workflowKit.setContext({ revision: host.projectContext.revision, root: host.projectContext.root, manual: false,
        profile: kitState.profile });
      await host.workflowKit.refreshStatus();
    }, noteOutcome: (outcome: unknown) => outcomes.push(outcome),
    refreshBmadEnvironment: async () => undefined,
    getSkillsContext: () => ({ root: host.projectContext?.root, availableFeatures: features }),
    checkBmadRuntime: async () => { runtimeChecks++; host.bmadRuntimeReason = runtimeReason; }
  });
  host.workflowKit = new WorkflowKitService({
    storagePath: base, extensionDirectory: extensionRoot, extensionVersion: 'test',
    readSource: () => 'github', writeSource: async () => undefined, pythonPath: () => 'python', reportPhase: () => undefined,
    runWithInstallProgress: (_version, task) => task(), releaseManager: { listReleases: async () => [] } as any,
    runHelper: async () => ({ ...kitState } as Record<string, unknown>)
  });
  host.projectContext = await host.resolveProjectContext();
  t.after(async () => {
    host.workflowKit.dispose();
    host.bmad?.dispose();
    assert.ok(path.basename(base).startsWith('bmad-host-test-'));
    await fs.rm(base, { recursive: true, force: true });
  });
  const refresh = async (): Promise<BmadWorkflowSnapshot> => { await host.refreshBmadWorkflow(); assert.ok(host.bmad?.snapshot); return host.bmad.snapshot; };
  return { host, root, second, write, refresh, outcomes, errors,
    setFeatures: (value: string[]) => { features = value; }, setRuntimeReason: (value?: string) => { runtimeReason = value; },
    setKitState: (value: typeof kitState) => { kitState = value; },
    checks: () => ({ runtime: runtimeChecks, kit: kitChecks }) };
}

async function waitForBmadRegistration(host: any) {
  // Registration schedules a delayed reconciliation even when the fixture's
  // watchers do not emit events. Wait for it before using a snapshot in a test.
  const deadline = Date.now() + 10_000;
  while ((host.bmad.registrationTimer || host.bmad.refreshTimer || host.bmad.pending) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 25));
  assert.ok(Date.now() < deadline, 'BMAD watcher registration must settle');
}

test('BMAD loads installed progress offline from the selected root and resolves configured roots canonically', async t => {
  const f = await fixture(t);
  // There is deliberately no GitLab account or selected Group.
  delete f.host.projectContext;
  const first = await f.refresh();
  assert.equal(first.root, await fs.realpath(f.root));
  assert.equal(f.host.projectContext.root, first.root);
  assert.equal(first.installation.state, 'ready');
  assert.equal(watches.find(watch => watch.base === first.root)?.pattern, '*', 'Root discovery must not subsume the narrower native directory registrations');
  configuredRoots.set(uri(f.root).toString(), '../second');
  const next = await f.refresh();
  assert.equal(next.root, await fs.realpath(f.second));
  assert.equal(f.host.projectContext.root, next.root);
  assert.notEqual(next.revision, first.revision);
});

test('Codex and clipboard share the verified BMAD task, and background continuation survives page changes', async t => {
  const f = await fixture(t);
  f.setKitState({ status: 'installed', version: '1.3.5', integrity: 'verified', workspaceContract: 2,
    installerApi: 1, capabilities: ['bmad-workflow'] } as any);
  await f.refresh(); await waitForBmadRegistration(f.host);
  const snapshot = await f.refresh();
  const request = { revision: snapshot.revision, command: 'task', requirement: '建立付款流程規格' };
  const spec = await f.host.prepareCodexTask({ kind: 'bmad', request });
  await f.host.copyBmadCommand(request);
  assert.ok(spec.prompt.startsWith(copied[copied.length - 1]), 'Both modes share the verified task instruction before Host-owned output binding');
  assert.ok(spec.bmadArtifacts?.outputRoot.startsWith(path.join(f.host.context.globalStorageUri.fsPath, 'codex-bmad-artifacts')));
  assert.ok(spec.prompt.includes(JSON.stringify(spec.bmadArtifacts.outputRoot)));
  assert.equal(spec.root, await fs.realpath(f.root));
  assert.equal(spec.skill.name, 'bmad-help'); assert.match(spec.prompt, /建立付款流程規格/);
  f.host.activeMode = 'dashboard'; f.host.bmad.setContext(f.root, f.host.projectContext.revision, false);
  const resumed = await f.host.prepareCodexTask(spec.source, spec);
  assert.equal(resumed.environmentKey, spec.environmentKey);
  vscode.workspace.isTrusted = false;
  await assert.rejects(f.host.prepareCodexTask(spec.source, spec), /信任/);
});

test('simplified entries bind one verified router and keep native candidates out of additional Skills', async t => {
  const f = await fixture(t);
  await f.write(f.root, '.agents/skills/wk-plan/SKILL.md', '---\nname: wk-plan\n---\nChoose the current planning capability.\n');
  await f.write(f.root, '.agents/skills/bmad-spec/SKILL.md', '---\nname: bmad-spec\n---\n');
  f.setKitState({ status: 'installed', bmadMode: 'bundled', workspaceContract: 2, installerApi: 1,
    integrity: 'verified', interfaceCompatibility: 'compatible', capabilities: ['bmad-workflow', 'bmad-entrypoints'] });
  await f.refresh(); await waitForBmadRegistration(f.host);
  const snapshot = await f.refresh(), request = { revision: snapshot.revision, command: 'entry', entry: 'plan', nativeSkill: 'bmad-spec', requirement: '整理付款需求' };
  const spec = await f.host.prepareCodexTask({ kind: 'bmad', request });
  assert.equal(spec.skill.name, 'wk-plan');
  assert.deepEqual(spec.additionalSkills, []);
  assert.match(spec.prompt, /^\$wk-plan/);
  assert.match(spec.prompt, /\$bmad-spec/);
  assert.ok(!spec.prompt.includes('$bmad-architecture'));
});

test('project entry stages proposed rules outside the original project writable scope', async t => {
  const f = await fixture(t);
  await f.write(f.root, '.agents/skills/wk-project/SKILL.md', '---\nname: wk-project\n---\nReview and propose project rules.\n');
  f.setKitState({ status: 'installed', bmadMode: 'bundled', workspaceContract: 2, installerApi: 1,
    integrity: 'verified', interfaceCompatibility: 'compatible', capabilities: ['bmad-workflow', 'bmad-entrypoints'] });
  await f.refresh(); await waitForBmadRegistration(f.host);
  const snapshot = await f.refresh();
  const spec = await f.host.prepareCodexTask({ kind: 'bmad', request: { revision: snapshot.revision, command: 'entry', entry: 'project', requirement: '整理代理規則' } });
  assert.equal(spec.executionRoot, spec.bmadArtifacts.projectChangesRoot);
  assert.ok(spec.executionRoot.startsWith(f.host.context.globalStorageUri.fsPath));
  assert.ok(!spec.writableRoots.includes(f.root));
  assert.match(spec.prompt, /人工確認後才套回原專案/);
});

test('helper runtime is narrowly authorized and Host creates it before task startup', async t => {
  const f = await fixture(t), executionRoot = path.join(f.host.context.globalStorageUri.fsPath, 'task-clone');
  await fs.mkdir(executionRoot);
  const source = { kind: 'skill', skillId: 'bmad-help' }, helperRuntime = path.join(f.root, '.gitlab-workspace', 'runtime');
  const prepared = () => ({ source, title: 'Helper scope', root: f.root, executionRoot, writableRoots: [executionRoot],
    prompt: 'Run selected helper', workspaceKey: 'workspace', environmentKey: 'environment',
    skill: { name: 'bmad-help', path: path.join(f.root, '.agents', 'skills', 'bmad-help', 'SKILL.md') } });
  f.host.prepareCodexEnvironment = async () => prepared();
  const spec = await f.host.prepareCodexTask(source);
  assert.deepEqual(spec.writableRoots, [executionRoot, helperRuntime]);
  assert.ok(!spec.writableRoots.includes(f.root));
  assert.ok(!spec.writableRoots.includes(path.join(f.root, '.git')));
  await assert.rejects(fs.lstat(helperRuntime), { code: 'ENOENT' });
  await f.host.getCodexBridge().options.started(spec, new AbortController().signal);
  assert.equal((await fs.lstat(helperRuntime)).isDirectory(), true);
  await f.write(f.root, '.gitlab-workspace/runtime/retained.txt', 'Existing runtime');
  await f.host.getCodexBridge().options.started(spec, new AbortController().signal);
  assert.equal(await fs.readFile(path.join(helperRuntime, 'retained.txt'), 'utf8'), 'Existing runtime');

  for (const binding of [{ review: { tool: 'merge-reviewer', requestId: 'review', revision: 'revision' } },
    { commitReview: { runtimeRoot: path.join(executionRoot, 'commit-review') } }]) {
    f.host.prepareCodexEnvironment = async () => ({ ...prepared(), ...binding });
    assert.deepEqual((await f.host.prepareCodexTask(source)).writableRoots, [executionRoot], 'Native reviewers retain their own runtime scopes');
  }
  f.host.prepareCodexEnvironment = async () => prepared();
  assert.deepEqual((await f.host.prepareCodexTask(source, prepared())).writableRoots, [executionRoot], 'Legacy tasks without a managed workspace do not gain new permissions');
});

test('helper runtime is not created without its explicit writable root', async t => {
  const f = await fixture(t), helperRuntime = path.join(f.root, '.gitlab-workspace', 'runtime');
  await f.host.getCodexBridge().options.started({ root: f.root, source: { kind: 'skill' }, writableRoots: [f.second] }, new AbortController().signal);
  await assert.rejects(fs.lstat(helperRuntime), { code: 'ENOENT' });
});

test('BMAD result reports open only regular bounded files inside the task output', async t => {
  const f = await fixture(t), outputRoot = path.join(f.host.context.globalStorageUri.fsPath, 'codex-bmad-artifacts', 'task');
  const report = path.join(outputRoot, 'planning-artifacts', 'prd.md');
  await fs.mkdir(path.dirname(report), { recursive: true }); await fs.writeFile(report, 'Reviewed requirements');
  let reportPath = report;
  f.host.getCodexBridge = () => ({ initialize: async () => undefined, list: () => [{ id: 'task', result: { reportPath } }],
    specification: async () => ({ root: f.root, bmadArtifacts: { outputRoot } }) });
  f.host.getCodexWorkflowService = () => { throw new Error('BMAD reports must not use the GitLab workflow reader'); };
  await f.host.readLinkedCodexResult('task'); assert.deepEqual(shown, [report]);
  const outside = path.join(f.root, 'outside.md'), sibling = path.join(path.dirname(outputRoot), 'foreign.md');
  await fs.writeFile(outside, 'Original project file'); await fs.writeFile(sibling, 'Other task file');
  for (const rejected of [outside, sibling, outputRoot, path.dirname(report), path.join(outputRoot, 'missing.md')]) {
    reportPath = rejected;
    await assert.rejects(f.host.readLinkedCodexResult('task'));
  }
  reportPath = path.join(outputRoot, 'oversized.md'); await fs.writeFile(reportPath, Buffer.alloc(2 * 1024 * 1024 + 1));
  await assert.rejects(f.host.readLinkedCodexResult('task'), /BMAD/);
  assert.deepEqual(shown, [report], 'Invalid reports never reach the editor');
});

test('copy works offline without launching and stale artifact revisions are rejected', async t => {
  const f = await fixture(t); const snapshot = await f.refresh(); const node = snapshot.nodes.find(item => item.skill === 'bmad-prd')!;
  f.setFeatures([]); vscode.workspace.isTrusted = false;
  const request = { revision: snapshot.revision, command: 'skill' as const, stepId: node.id };
  await f.host.copyBmadCommand(request);
  assert.equal(copied.length, 1); assert.match(copied[0], /\$bmad-prd/); assert.equal(terminals.length, 0);
  assert.equal(copied[0], buildBmadCommand(snapshot, request), 'Clipboard matches the native command generator');
  assert.equal(f.checks().runtime, 0);
  assert.ok(f.checks().kit > 0, 'Copying rechecks the selected WorkflowKit state');
  await f.write(f.root, '_bmad-output/planning-artifacts/prd.md', '---\nstatus: final\n---\n');
  await assert.rejects(f.host.copyBmadCommand(request), /已變更/);
  await assert.rejects(f.host.copyBmadCommand({ ...request, revision: (await f.refresh()).revision, stepId: 'invalid-step' }), /找不到/);
});

test('copy validates observed work and rejects the retired installation command', async t => {
  const f = await fixture(t); await f.refresh(); await waitForBmadRegistration(f.host);
  const snapshot = await f.refresh(); const node = snapshot.nodes.find(item => item.skill === 'bmad-build')!;
  await assert.rejects(f.host.copyBmadCommand({ revision: snapshot.revision, command: 'skill', stepId: node.id, storyId: 'removed' }), /Story/);
  await assert.rejects(f.host.copyBmadCommand({ revision: snapshot.revision, command: 'skill', stepId: node.id, artifactId: 'removed' }), /紀錄/);
  await assert.rejects(f.host.copyBmadCommand({ revision: snapshot.revision, command: 'shell' }), /不支援/);
  assert.equal(copied.length, 0);
  await fs.unlink(path.join(f.root, '_bmad', '_config', 'manifest.yaml'));
  const missing = await f.refresh();
  await assert.rejects(f.host.copyBmadCommand({ revision: missing.revision, command: 'install' }), /不支援/);
  assert.equal(copied.length, 0);
  assert.equal(f.checks().runtime, 0);
});

test('BMAD action validation prepares its context and reads the final workflow only once', async t => {
  const f = await fixture(t); await f.refresh(); await waitForBmadRegistration(f.host);
  const snapshot = await f.refresh();
  let reads = 0;
  f.host.bmad.options.read = async (options: Parameters<typeof readBmadWorkflow>[0]) => {
    reads++; return readBmadWorkflow(options);
  };
  const before = f.checks().kit;
  assert.equal((await f.host.requireBmadSnapshot(snapshot.revision)).revision, snapshot.revision);
  assert.equal(reads, 1, 'Validation must not perform a cached refresh before its uncached final read');
  assert.equal(f.checks().kit, before + 1, 'The selected WorkflowKit is still rechecked');
  reads = 0;
  assert.equal((await f.host.requireBmadSnapshot(snapshot.revision, true)).revision, snapshot.revision);
  assert.equal(reads, 1, 'Guidance also refreshes its snapshot once');
});

test('task copy rechecks bundled integrity and writes a root-bound prompt', async t => {
  const f = await fixture(t);
  f.setKitState({ status: 'installed', bmadMode: 'bundled', workspaceContract: 2, installerApi: 1,
    integrity: 'verified', interfaceCompatibility: 'compatible', capabilities: ['bmad-workflow'] });
  await f.refresh(); await waitForBmadRegistration(f.host);
  const snapshot = await f.refresh();
  await f.host.copyBmadCommand({ revision: snapshot.revision, command: 'task', requirement: '完成付款功能' });
  assert.match(copied[0], /\$bmad-help/);
  assert.ok(copied[0].includes(f.root));
  assert.ok(copied[0].includes('完成付款功能'));
  f.setKitState({ status: 'installed', bmadMode: 'bundled', workspaceContract: 2, installerApi: 1,
    integrity: 'unverified', interfaceCompatibility: 'compatible', capabilities: ['bmad-workflow'] });
  await assert.rejects(f.host.copyBmadCommand({ revision: snapshot.revision, command: 'task', requirement: '再檢查' }), /尚未通過驗證/);
  assert.equal(copied.length, 1);
});

test('openArtifact accepts only the selected snapshot step artifact path', async t => {
  const f = await fixture(t);
  await f.write(f.root, '_bmad-output/planning-artifacts/prd.md', '---\nstatus: final\n---\n');
  await f.refresh();
  await waitForBmadRegistration(f.host);
  const snapshot = await f.refresh(); const node = snapshot.nodes.find(item => item.skill === 'bmad-prd')!;
  const artifact = snapshot.steps.find(step => step.id === node.id)!.artifacts[0];
  await assert.rejects(f.host.openBmadArtifact(snapshot.revision, node.id, path.join(f.second, 'foreign.md')), /找不到/);
  await assert.rejects(f.host.openBmadArtifact(snapshot.revision, snapshot.nodes.find(item => item.skill === 'bmad-build')!.id, artifact.path), /找不到/);
  await f.host.openBmadArtifact(snapshot.revision, node.id, artifact.path);
  assert.deepEqual(opened, [artifact.path]);
});

test('root changes during snapshot verification block copy and artifact actions', async t => {
  const f = await fixture(t);
  await f.write(f.root, '_bmad-output/planning-artifacts/prd.md', '---\nstatus: final\n---\n');
  const snapshot = await f.refresh(); const node = snapshot.nodes.find(item => item.skill === 'bmad-prd')!;
  const artifactId = snapshot.steps.find(item => item.id === node.id)!.artifacts[0].id;
  f.host.bmad.requireSnapshot = async () => { configuredRoots.set(uri(f.root).toString(), '../second'); f.host.projectContext = await f.host.resolveProjectContext(); return snapshot; };
  await assert.rejects(f.host.copyBmadCommand({ revision: snapshot.revision, command: 'skill', stepId: node.id, artifactId }), /已變更/);
  assert.equal(copied.length, 0); assert.equal(opened.length, 0);
});

test('Codex guidance and the project terminal remain available after a config read error', async t => {
  const f = await fixture(t); await f.refresh();
  await f.write(f.root, '_bmad/config.toml', '[unfinished');
  const snapshot = await f.refresh();
  assert.equal(snapshot.observation.state, 'error');
  await f.host.copyBmadCommand({ revision: snapshot.revision, command: 'codex' });
  await f.host.openBmadTerminal(snapshot.revision);
  assert.equal(copied[0], 'codex'); assert.equal(terminals[0].cwd, f.root);
});

test('the BMAD terminal opens at the selected root without installing a kit or sending commands', async t => {
  const f = await fixture(t);
  await fs.unlink(path.join(f.root, '_bmad', '_config', 'manifest.yaml'));
  const snapshot = await f.refresh(); f.setFeatures([]);
  await f.host.openBmadTerminal(snapshot.revision);
  assert.deepEqual(terminals, [{ name: 'BMAD 專案終端', cwd: snapshot.root }]);
  assert.equal(f.checks().runtime, 0); assert.ok(f.checks().kit > 0);
  configuredRoots.set(uri(f.root).toString(), '../second');
  await assert.rejects(f.host.openBmadTerminal(snapshot.revision), /已變更/);
  assert.equal(terminals.length, 1);
});
