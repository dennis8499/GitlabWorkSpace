import assert from 'node:assert/strict';
import test from 'node:test';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { buildBmadCommand } from '../../src/workspace/bmadCommand';
import type { BmadWorkflowSnapshot } from '../../src/workspace/bmadProtocol';

const uri = (fsPath: string) => ({ scheme: 'file', fsPath, toString: () => `file:${fsPath}` });
const configuredRoots = new Map<string, string>();
const opened: string[] = [], copied: string[] = [], terminals: any[] = [];
const watches: Array<{ base: string; pattern: string }> = [];
let terminalAvailable = true;
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
  window: { showTextDocument: async (_document: unknown) => undefined,
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
  await fs.mkdir(root); await fs.mkdir(second);
  await write(extensionRoot, 'resources/bmad/bmad-help.csv', CATALOG);
  for (const target of [root, second]) {
    await write(target, '_bmad/_config/manifest.yaml', 'installation:\n  version: 6.12.4\n');
    await write(target, '_bmad/_config/bmad-help.csv', CATALOG);
    await write(target, '_bmad/config.toml', '[core]\noutput_folder = "_bmad-output"\n');
    await write(target, '_bmad/scripts/resolve_config.py', '# installed resolver\n');
    await write(target, '_bmad/scripts/render_skill.py', '# installed renderer\n');
    for (const skill of ['bmad-help', 'bmad-build', 'bmad-prd']) await write(target, `.agents/skills/${skill}/SKILL.md`, `---\nname: ${skill}\n---\n`);
  }
  configuredRoots.clear(); opened.length = 0; copied.length = 0; terminals.length = 0; watches.length = 0; terminalAvailable = true;
  vscode.workspace.isTrusted = true;
  vscode.workspace.workspaceFolders = [{ uri: uri(root), name: '專案' }];
  let features = ['bmad-workflow']; let runtimeReason: string | undefined; let runtimeChecks = 0, kitChecks = 0;
  let kitState: import('../../src/workspace/workspaceProtocol').InstalledWorkflowKitState = { status: 'missing' };
  const outcomes: unknown[] = [], errors: unknown[] = [];
  const host: any = Object.assign(Object.create(WorkspacePanel!.prototype), {
    disposed: false, activeMode: 'bmad', webviewReady: true, panel: { visible: true },
    context: { workspaceState: memory(), extensionUri: uri(extensionRoot) }, session: { connectionEpoch: 0 },
    bmadRuntimeReason: undefined, sendSnapshot: () => undefined, post: (message: unknown) => errors.push(message),
    refreshWorkflowKitInstallState: async () => {
      kitChecks++; host.projectContext = await host.resolveProjectContext();
      host.workflowKitStateRoot = host.projectContext.root; host.workflowKitState = kitState;
    }, noteOutcome: (outcome: unknown) => outcomes.push(outcome),
    refreshBmadEnvironment: async () => undefined,
    getSkillsContext: () => ({ root: host.projectContext?.root, availableFeatures: features }),
    checkBmadRuntime: async () => { runtimeChecks++; host.bmadRuntimeReason = runtimeReason; }
  });
  host.projectContext = await host.resolveProjectContext();
  t.after(async () => {
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

test('task copy rechecks bundled integrity and writes a root-bound prompt', async t => {
  const f = await fixture(t);
  f.setKitState({ status: 'installed', bmadMode: 'bundled', integrity: 'verified', interfaceCompatibility: 'compatible', capabilities: ['bmad-workflow'] });
  await f.refresh(); await waitForBmadRegistration(f.host);
  const snapshot = await f.refresh();
  await f.host.copyBmadCommand({ revision: snapshot.revision, command: 'task', requirement: '完成付款功能' });
  assert.match(copied[0], /\$bmad-help/);
  assert.ok(copied[0].includes(f.root));
  assert.ok(copied[0].includes('完成付款功能'));
  f.setKitState({ status: 'installed', bmadMode: 'bundled', integrity: 'unverified', interfaceCompatibility: 'compatible', capabilities: ['bmad-workflow'] });
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
