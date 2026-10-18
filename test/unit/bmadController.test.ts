import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import { BmadWorkflowController } from '../../src/workspace/bmadWorkflowController';
import type { BmadWorkflowSnapshot } from '../../src/workspace/bmadProtocol';
import { bmadTerminalOptions, buildBmadLaunchPrompt } from '../../src/workspace/bmadTerminal';

function snapshot(root = '/project', revision = 'one'): BmadWorkflowSnapshot {
  return { root, revision, version: '6.12.4', installation: { state: 'ready', reason: 'Ready' }, catalogSource: 'installed',
    nodes: [{ id: 'brief', module: 'BMad Method', skill: 'bmad-product-brief', displayName: 'Brief', menuCode: 'CB', description: '',
      action: '', args: '-A', phase: 'plan', required: false, precededBy: [], followedBy: [], outputLocation: '', outputs: [] }],
    phases: [], edges: [], stories: [], currentCandidates: [], recommendations: [], diagnostics: [], watchDirectories: [root],
    steps: [{ id: 'brief', status: 'needs-confirmation', summary: '', artifacts: [{ id: 'file', path: root + '/brief.md', relativePath: 'brief.md',
      fingerprint: 'a'.repeat(64), status: 'needs-confirmation', reason: 'Unknown', canConfirm: true, confirmed: false }] }] };
}
function fixture(reader: (options: any) => Promise<BmadWorkflowSnapshot>) {
  const data = new Map<string, unknown>();
  const watchers: Array<{ directory: string; changed(filename?: string): void; disposed: boolean }> = [];
  const watchOrder: string[] = [];
  let changes = 0;
  const controller = new BmadWorkflowController({
    store: { get: <T>(key: string, fallback: T): T => data.has(key) ? data.get(key) as T : fallback,
      update: async (key, value) => { data.set(key, value); } },
    bundledCatalog: async () => 'catalog', read: reader,
    watch: (directory, changed) => { const watcher = { directory, changed, disposed: false }; watchers.push(watcher); watchOrder.push(`add:${directory}`); return { dispose: () => { watcher.disposed = true; watchOrder.push(`remove:${directory}`); } }; },
    changed: () => changes++, error: message => assert.fail(message)
  });
  return { controller, data, watchers, watchOrder, changes: () => changes };
}

test('BMAD watcher coalesces changes and is disposed while hidden or after shutdown', async () => {
  let reads = 0;
  const f = fixture(async () => { reads++; return snapshot(); });
  f.controller.setContext('/project', 'project-one', true);
  await f.controller.refresh();
  assert.equal(reads, 1);
  for (let index = 0; index < 3; index++) f.watchers[0].changed();
  await new Promise(resolve => setTimeout(resolve, 220));
  assert.equal(reads, 2);
  f.controller.setContext('/project', 'project-one', false);
  assert.equal(f.watchers.every(watcher => watcher.disposed), true);
  f.watchers[0].changed();
  await f.controller.refresh();
  assert.equal(reads, 2);
  f.controller.dispose();
});

test('output discovery retains common native watches and adds replacements before removing old ancestors', async () => {
  const root = '/project', common = '/project/_bmad-output', ancestor = '/project/var', discovered = '/project/var/build';
  let value = { ...snapshot(root), watchDirectories: [root, common, ancestor] };
  const f = fixture(async () => value);
  try {
    f.controller.setContext(root, 'project', true);
    await f.controller.refresh();
    const rootWatcher = f.watchers[0], commonWatcher = f.watchers[1];
    value = { ...snapshot(root, 'two'), watchDirectories: [root, common, discovered] };
    await f.controller.refresh();
    assert.equal(f.watchers.length, 4, 'Discovery creates only the newly needed registration');
    assert.equal(f.watchers[0], rootWatcher); assert.equal(rootWatcher.disposed, false);
    assert.equal(f.watchers[1], commonWatcher); assert.equal(commonWatcher.disposed, false);
    assert.equal(f.watchers[2].disposed, true);
    assert.ok(f.watchOrder.indexOf(`add:${discovered}`) < f.watchOrder.indexOf(`remove:${ancestor}`));
    await f.controller.refresh();
    assert.equal(f.watchers.length, 4, 'Refreshing an unchanged watch set does not restart registrations');
  } finally { f.controller.dispose(); }
  assert.equal(f.watchers.every(watcher => watcher.disposed), true);
});

test('recursive root events refresh only observed targets, their missing ancestors, and root AGENTS.md', async () => {
  const root = path.resolve('/project');
  const output = path.join(root, 'custom', 'deep', 'output');
  let reads = 0;
  const f = fixture(async () => { reads++; return { ...snapshot(root), watchDirectories: [root, path.join(root, '_bmad'), output] }; });
  try {
    f.controller.setContext(root, 'project', true);
    await f.controller.refresh();
    const rootWatcher = f.watchers[0];
    rootWatcher.changed(path.resolve('/another-project/custom/deep/output/prd.md'));
    rootWatcher.changed(path.join(root, 'src', 'unrelated.ts'));
    rootWatcher.changed(path.join(root, 'README.md'));
    await new Promise(resolve => setTimeout(resolve, 220));
    assert.equal(reads, 1, 'Unrelated trees and other roots must not schedule reads');
    rootWatcher.changed(path.join(root, 'custom'));
    await new Promise(resolve => setTimeout(resolve, 220));
    assert.equal(reads, 2, 'Creating an ancestor of a configured missing output must refresh discovery');
    rootWatcher.changed(path.join(output, 'prd.md'));
    await new Promise(resolve => setTimeout(resolve, 220));
    assert.equal(reads, 3, 'A descendant artifact must refresh through the stable recursive root registration');
    rootWatcher.changed(path.join(root, 'AGENTS.md'));
    await new Promise(resolve => setTimeout(resolve, 220));
    assert.equal(reads, 4, 'Root agent instructions are part of the BMAD observation');
    rootWatcher.changed();
    await new Promise(resolve => setTimeout(resolve, 220));
    assert.equal(reads, 5, 'Watch adapters without a path remain supported');
  } finally { f.controller.dispose(); }
});

test('late reads from an old project or hidden view never publish', async () => {
  let finish!: (value: BmadWorkflowSnapshot) => void;
  const f = fixture(async ({ root }) => root === '/old' ? new Promise(resolve => { finish = resolve; }) : snapshot(root));
  f.controller.setContext('/old', 'old', true);
  const old = f.controller.refresh();
  await new Promise(resolve => setImmediate(resolve));
  f.controller.setContext('/new', 'new', true);
  await f.controller.refresh();
  finish(snapshot('/old'));
  await old;
  assert.equal(f.controller.snapshot?.root, '/new');
  assert.equal(f.changes(), 1);
  f.controller.dispose();
});

test('switching project aborts the previous BMAD reader instead of only ignoring its result', async () => {
  let oldSignal: AbortSignal | undefined;
  const f = fixture(async (options) => {
    if (options.root !== '/old') return snapshot(options.root);
    oldSignal = options.signal;
    return new Promise(resolve => options.signal?.addEventListener('abort', () => resolve(snapshot('/old')), { once: true }));
  });
  try {
    f.controller.setContext('/old', 'old', true); const old = f.controller.refresh();
    await new Promise(resolve => setImmediate(resolve));
    f.controller.setContext('/new', 'new', true); await f.controller.refresh();
    assert.ok(oldSignal?.aborted, 'the reader must receive a real cancellation signal');
    await old;
  } finally { f.controller.dispose(); }
});

test('snapshot validation rejects a filesystem event during its read instead of accepting the cached revision', async () => {
  let reads = 0;
  let finish!: (value: BmadWorkflowSnapshot) => void;
  const f = fixture(async () => ++reads === 1 ? snapshot() : new Promise(resolve => { finish = resolve; }));
  try {
    f.controller.setContext('/project', 'project', true);
    await f.controller.refresh();
    const validation = f.controller.requireSnapshot('one');
    const rejected = assert.rejects(validation, /已變更/);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(typeof finish, 'function', 'The validating read must be in flight');
    f.watchers[0].changed();
    finish(snapshot('/project', 'two'));
    await rejected;
    assert.equal(f.controller.snapshot?.revision, 'one', 'The obsolete read was discarded; its cached predecessor must not authorize an action');
    assert.equal(f.changes(), 1, 'An invalidated read must not publish');
  } finally { f.controller.dispose(); }
});

test('manual completion is persisted with evidence and rejects stale or explicit draft state', async () => {
  let value = snapshot();
  const f = fixture(async ({ confirmations }) => {
    const found = confirmations?.some((item: any) => item.fingerprint === value.steps[0].artifacts[0].fingerprint);
    return { ...value, steps: value.steps.map(step => ({ ...step, artifacts: step.artifacts.map(artifact => ({ ...artifact, confirmed: !!found })) })) };
  });
  f.controller.setContext('/project', 'project', true);
  await f.controller.refresh();
  await f.controller.confirm({ revision: 'one', stepId: 'brief', artifactId: 'file' });
  const stored = [...f.data.values()][0] as any[];
  assert.equal(stored.length, 1);
  assert.equal(stored[0].root, '/project');
  assert.equal(stored[0].fingerprint, 'a'.repeat(64));
  await f.controller.confirm({ revision: 'one', stepId: 'brief', artifactId: 'file' }, true);
  assert.deepEqual([...f.data.values()][0], []);
  value = { ...value, revision: 'two' };
  await assert.rejects(f.controller.confirm({ revision: 'one', stepId: 'brief', artifactId: 'file' }), /已變更/);
  value.steps[0].artifacts[0].canConfirm = false;
  value.steps[0].artifacts[0].status = 'draft';
  await assert.rejects(f.controller.confirm({ revision: 'two', stepId: 'brief', artifactId: 'file' }), /確認|完成/);
  f.controller.dispose();
});

test('Codex terminal receives one literal prompt argument, including shell metacharacters', () => {
  const prompt = '文字 " & %PATH% $() `command`\nnext line';
  const executable = 'C:\\Codex tools\\codex.exe';
  assert.deepEqual(bmadTerminalOptions(prompt, { PATH: 'C:\\Codex tools' }, 'win32', filename => filename === executable),
    { shellPath: executable, shellArgs: [prompt] });
  const script = 'C:\\npm\\node_modules\\@openai\\codex\\bin\\codex.js';
  const files = new Set(['C:\\npm\\codex.cmd', script, 'C:\\node\\node.exe']);
  assert.deepEqual(bmadTerminalOptions(prompt, { PATH: 'C:\\npm;C:\\node' }, 'win32', filename => files.has(filename)),
    { shellPath: 'C:\\node\\node.exe', shellArgs: [script, prompt] });
  assert.equal(bmadTerminalOptions(prompt, { PATH: 'C:\\npm' }, 'win32', filename => filename.endsWith('codex.cmd')), undefined);
  assert.match(buildBmadLaunchPrompt(snapshot().nodes[0]), /\$bmad-product-brief/);
  assert.throws(() => buildBmadLaunchPrompt({ ...snapshot().nodes[0], skill: 'bmad-help & calc' }), /無效/);
});
