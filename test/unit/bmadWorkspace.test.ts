import assert from 'node:assert/strict';
import test from 'node:test';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import * as terminalModule from '../../src/workspace/bmadTerminal';
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
    createTerminal: (options: unknown) => { terminals.push(options); return { show: () => undefined }; } }
};
const loader = require('node:module') as { _load(name: string, parent: unknown, main: boolean): unknown };
const originalLoad = loader._load;
loader._load = (name, parent, main) => name === 'vscode' ? vscode : name === './bmadTerminal' ? {
  ...terminalModule, bmadTerminalOptions: (prompt: string) => terminalAvailable ? { shellPath: 'codex-native', shellArgs: [prompt] } : undefined
} : originalLoad(name, parent, main);
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
  }
  configuredRoots.clear(); opened.length = 0; copied.length = 0; terminals.length = 0; watches.length = 0; terminalAvailable = true;
  vscode.workspace.isTrusted = true;
  vscode.workspace.workspaceFolders = [{ uri: uri(root), name: '專案' }];
  let features = ['bmad-workflow']; let runtimeReason: string | undefined; let runtimeChecks = 0, kitChecks = 0;
  const outcomes: unknown[] = [], errors: unknown[] = [];
  const host: any = Object.assign(Object.create(WorkspacePanel!.prototype), {
    disposed: false, activeMode: 'bmad', webviewReady: true, panel: { visible: true },
    context: { workspaceState: memory(), extensionUri: uri(extensionRoot) }, session: { connectionEpoch: 0 },
    bmadRuntimeReason: undefined, sendSnapshot: () => undefined, post: (message: unknown) => errors.push(message),
    refreshWorkflowKit: async () => { kitChecks++; }, noteOutcome: (outcome: unknown) => outcomes.push(outcome),
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
    checks: () => ({ runtime: runtimeChecks, kit: kitChecks }) };
}

test('BMAD loads installed progress offline from the selected root and resolves configured roots canonically', async t => {
  const f = await fixture(t);
  // There is deliberately no GitLab account or selected Group.
  delete f.host.projectContext;
  const first = await f.refresh();
  assert.equal(first.root, await fs.realpath(f.root));
  assert.equal(f.host.projectContext.root, first.root);
  assert.equal(first.installation.state, 'ready');
  assert.equal(watches.find(watch => watch.base === first.root)?.pattern, '**/*', 'The stable root watcher must cover newly created output descendants');
  configuredRoots.set(uri(f.root).toString(), '../second');
  const next = await f.refresh();
  assert.equal(next.root, await fs.realpath(f.second));
  assert.equal(f.host.projectContext.root, next.root);
  assert.notEqual(next.revision, first.revision);
});

test('launch creates a new interactive terminal with canonical cwd and prompt as an argument', async t => {
  const f = await fixture(t); const snapshot = await f.refresh(); const node = snapshot.nodes.find(item => item.skill === 'bmad-build')!;
  await f.host.launchBmadStep(snapshot.revision, node.id);
  await f.host.launchBmadStep(snapshot.revision, node.id);
  assert.equal(terminals.length, 2);
  for (const terminal of terminals) {
    assert.equal(terminal.cwd, snapshot.root);
    assert.equal(terminal.shellPath, 'codex-native');
    assert.equal(terminal.shellArgs.length, 1);
    assert.match(terminal.shellArgs[0], /\$bmad-build/);
    assert.doesNotMatch(terminal.shellArgs[0], /codex exec/);
  }
  assert.equal(f.checks().kit, 2);
  assert.equal(f.host.bmad.snapshot.steps.find((step: any) => step.id === node.id).status, 'not-observed');
  assert.ok(f.outcomes.every((outcome: any) => !String(outcome.phase).includes('已完成')));
});

test('launch checks verified kit capability, workspace trust, runtime availability and executable discovery', async t => {
  const f = await fixture(t); const snapshot = await f.refresh(); const node = snapshot.nodes.find(item => item.skill === 'bmad-build')!;
  f.setFeatures([]);
  await assert.rejects(f.host.launchBmadStep(snapshot.revision, node.id), /安裝/);
  f.setFeatures(['bmad-workflow']); vscode.workspace.isTrusted = false;
  await assert.rejects(f.host.launchBmadStep(snapshot.revision, node.id), /信任/);
  vscode.workspace.isTrusted = true; f.setRuntimeReason('缺少 uv');
  await assert.rejects(f.host.launchBmadStep(snapshot.revision, node.id), /缺少 uv/);
  f.setRuntimeReason(); terminalAvailable = false;
  await assert.rejects(f.host.launchBmadStep(snapshot.revision, node.id), /Codex CLI/);
  assert.equal(terminals.length, 0);
});

test('copy works offline without launching and stale artifact revisions are rejected', async t => {
  const f = await fixture(t); const snapshot = await f.refresh(); const node = snapshot.nodes.find(item => item.skill === 'bmad-prd')!;
  f.setFeatures([]); vscode.workspace.isTrusted = false;
  await f.host.copyBmadPrompt(snapshot.revision, node.id);
  assert.equal(copied.length, 1); assert.match(copied[0], /\$bmad-prd/); assert.equal(terminals.length, 0);
  await f.write(f.root, '_bmad-output/planning-artifacts/prd.md', '---\nstatus: final\n---\n');
  await assert.rejects(f.host.copyBmadPrompt(snapshot.revision, node.id), /已變更/);
  await assert.rejects(f.host.copyBmadPrompt((await f.refresh()).revision, 'invalid-step'), /找不到/);
});

test('openArtifact accepts only the selected snapshot step artifact path', async t => {
  const f = await fixture(t);
  await f.write(f.root, '_bmad-output/planning-artifacts/prd.md', '---\nstatus: final\n---\n');
  const snapshot = await f.refresh(); const node = snapshot.nodes.find(item => item.skill === 'bmad-prd')!;
  const artifact = snapshot.steps.find(step => step.id === node.id)!.artifacts[0];
  await assert.rejects(f.host.openBmadArtifact(snapshot.revision, node.id, path.join(f.second, 'foreign.md')), /找不到/);
  await assert.rejects(f.host.openBmadArtifact(snapshot.revision, snapshot.nodes.find(item => item.skill === 'bmad-build')!.id, artifact.path), /找不到/);
  await f.host.openBmadArtifact(snapshot.revision, node.id, artifact.path);
  assert.deepEqual(opened, [artifact.path]);
});

test('root or page changes while waiting for runtime prevent a delayed terminal launch', async t => {
  const f = await fixture(t); const snapshot = await f.refresh(); const node = snapshot.nodes.find(item => item.skill === 'bmad-build')!;
  f.host.checkBmadRuntime = async () => { configuredRoots.set(uri(f.root).toString(), '../second'); f.host.projectContext = await f.host.resolveProjectContext(); };
  await assert.rejects(f.host.launchBmadStep(snapshot.revision, node.id), /已變更/);
  assert.equal(terminals.length, 0);
  configuredRoots.clear(); f.host.projectContext = await f.host.resolveProjectContext();
  const restored = await f.refresh();
  f.host.checkBmadRuntime = async () => { f.host.activeMode = 'sa'; };
  await assert.rejects(f.host.launchBmadStep(restored.revision, node.id), /已變更/);
  assert.equal(terminals.length, 0);
});

test('root changes during snapshot verification block copy and artifact actions', async t => {
  const f = await fixture(t); const snapshot = await f.refresh(); const node = snapshot.nodes.find(item => item.skill === 'bmad-prd')!;
  f.host.bmad.requireSnapshot = async () => { configuredRoots.set(uri(f.root).toString(), '../second'); f.host.projectContext = await f.host.resolveProjectContext(); return snapshot; };
  await assert.rejects(f.host.copyBmadPrompt(snapshot.revision, node.id), /已變更/);
  assert.equal(copied.length, 0); assert.equal(opened.length, 0);
});
