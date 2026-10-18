import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import { BmadWorkflowController } from '../../src/workspace/bmadWorkflowController';
import type { BmadWorkflowSnapshot } from '../../src/workspace/bmadProtocol';

function snapshot(root = '/project', revision = 'one'): BmadWorkflowSnapshot {
  return { root, revision, version: '6.12.4', guidanceVersion: '6.12.4', compatibility: 'verified',
    codex: { state: 'ready', skills: ['bmad-help', 'bmad-product-brief'], reason: 'Ready' }, observation: { state: 'paused' }, installation: { state: 'ready', reason: 'Ready' }, catalogSource: 'installed',
    nodes: [{ id: 'brief', module: 'BMad Method', skill: 'bmad-product-brief', displayName: 'Brief', menuCode: 'CB', description: '',
      action: '', args: '-A', phase: 'plan', required: false, precededBy: [], followedBy: [], outputLocation: '', outputs: [] }],
    phases: [], edges: [], stories: [], currentCandidates: [], recommendations: [], diagnostics: [], watchDirectories: [root],
    steps: [{ id: 'brief', status: 'needs-confirmation', summary: '', artifacts: [{ id: 'file', path: root + '/brief.md', relativePath: 'brief.md',
      fingerprint: 'a'.repeat(64), status: 'needs-confirmation', reason: 'Unknown' }] }] };
}
function fixture(reader: (options: any) => Promise<BmadWorkflowSnapshot>, directoryExists: (directory: string) => Promise<boolean> = async () => true) {
  const errors: string[] = [];
  const watchers: Array<{ directory: string; changed(filename?: string): void; disposed: boolean }> = [];
  const watchOrder: string[] = [];
  let changes = 0;
  const controller = new BmadWorkflowController({
    bundledCatalog: async () => 'catalog', read: reader, directoryExists,
    watch: (directory, changed) => { const watcher = { directory, changed, disposed: false }; watchers.push(watcher); watchOrder.push(`add:${directory}`); return { dispose: () => { watcher.disposed = true; watchOrder.push(`remove:${directory}`); } }; },
    changed: () => changes++, error: message => errors.push(message)
  });
  return { controller, errors, watchers, watchOrder, changes: () => changes };
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

test('configured root outputs observe direct Markdown and YAML artifacts without widening the recursive scope', async () => {
  const root = path.resolve('/project');
  let reads = 0;
  let watchRootArtifacts = true;
  const f = fixture(async () => { reads++; return { ...snapshot(root), watchRootArtifacts }; });
  try {
    f.controller.setContext(root, 'project', true);
    await f.controller.refresh();
    const watcher = f.watchers[0];
    watcher.changed(path.join(root, 'src', 'unrelated.md'));
    watcher.changed(path.join(root, 'source.ts'));
    watcher.changed(path.resolve('/another-project/prd.md'));
    await new Promise(resolve => setTimeout(resolve, 220));
    assert.equal(reads, 1, 'Root outputs do not enable unrelated descendant or source-file events');
    for (const filename of ['prd.md', 'sprint-status.yaml', 'stories.yml']) {
      watcher.changed(path.join(root, filename));
      await new Promise(resolve => setTimeout(resolve, 220));
    }
    assert.equal(reads, 4, 'Each supported root artifact extension must invalidate the snapshot');
    watchRootArtifacts = false;
    await f.controller.refresh();
    watcher.changed(path.join(root, 'prd.md'));
    await new Promise(resolve => setTimeout(resolve, 220));
    assert.equal(reads, 5, 'Discovery-only root registrations must still ignore unrelated Markdown');
  } finally { f.controller.dispose(); }
});

test('showing a hidden view rereads uncached files and ignores callbacks from its disposed watchers', async () => {
  let value = 'before hiding', reads = 0;
  const seen: string[] = [];
  const f = fixture(async ({ cache }) => {
    reads++;
    seen.push(cache.derive('same-file-stamp', 10, () => value));
    return snapshot();
  });
  try {
    f.controller.setContext('/project', 'project', true);
    await f.controller.refresh();
    const disposedWatcher = f.watchers[0];
    f.controller.setContext('/project', 'project', false);
    value = 'changed while hidden';
    await f.controller.refresh();
    assert.equal(reads, 1);
    f.controller.setContext('/project', 'project', true);
    await f.controller.refresh();
    assert.deepEqual(seen, ['before hiding', 'changed while hidden']);
    assert.equal(disposedWatcher.disposed, true);
    disposedWatcher.changed();
    await new Promise(resolve => setTimeout(resolve, 220));
    assert.equal(reads, 2, 'A disposed native watch callback cannot schedule a read after reopening');
    assert.equal(f.watchers.length, 2, 'Reopening must attach a fresh observer');
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
    assert.equal(f.changes(), 2, 'Only refreshing state may publish before an invalidated read is discarded');
  } finally { f.controller.dispose(); }
});

test('failed refresh preserves last evidence, reports observation error and recovers on the next file event', async () => {
  let fail = false;
  const f = fixture(async () => { if (fail) throw new Error('Temporary read failure'); return snapshot(); });
  try {
    f.controller.setContext('/project', 'project', true);
    await f.controller.refresh();
    assert.equal(f.controller.snapshot?.observation.state, 'watching');
    const lastSuccessfulAt = f.controller.snapshot?.observation.lastSuccessfulAt;
    fail = true;
    await f.controller.refresh();
    assert.equal(f.controller.snapshot?.revision, 'one');
    assert.equal(f.controller.snapshot?.steps[0].artifacts[0].status, 'needs-confirmation');
    assert.equal(f.controller.snapshot?.observation.state, 'error');
    assert.equal(f.controller.snapshot?.observation.lastSuccessfulAt, lastSuccessfulAt);
    assert.match(f.controller.snapshot?.observation.error ?? '', /Temporary/);
    await assert.rejects(f.controller.requireSnapshot('one'), /尚未恢復/);
    fail = false;
    f.watchers[0].changed();
    await new Promise(resolve => setTimeout(resolve, 220));
    assert.equal(f.controller.snapshot?.observation.state, 'watching');
    assert.equal(f.controller.snapshot?.observation.error, undefined);
    assert.equal((await f.controller.requireSnapshot('one')).revision, 'one');
    f.controller.setContext('/project', 'project', false);
    assert.equal(f.controller.snapshot?.observation.state, 'paused');
  } finally { f.controller.dispose(); }
});

test('initial reader failure retains an installation observer and can recover without changing project', async () => {
  let fail = true;
  const f = fixture(async () => { if (fail) throw new Error('Initial read failure'); return snapshot(); });
  try {
    f.controller.setContext('/project', 'project', true);
    await f.controller.refresh();
    assert.equal(f.controller.snapshot?.observation.state, 'error');
    assert.equal(f.controller.snapshot?.observation.lastSuccessfulAt, undefined);
    assert.ok(f.watchers.length > 0);
    fail = false;
    f.watchers[0].changed();
    await new Promise(resolve => setTimeout(resolve, 220));
    assert.equal(f.controller.snapshot?.observation.state, 'watching');
  } finally { f.controller.dispose(); }
});

test('initial failure fallback revisions are bound to the selected root and remain stable while retrying', async () => {
  const f = fixture(async () => { throw new Error('Read unavailable'); });
  try {
    f.controller.setContext('/first', 'first-project', true);
    await f.controller.refresh();
    const first = f.controller.snapshot!;
    assert.equal(first.root, '/first');
    await f.controller.refresh();
    assert.equal(f.controller.snapshot?.revision, first.revision, 'Recovery guidance stays copyable across retries');
    f.controller.setContext('/second', 'second-project', true);
    await f.controller.refresh();
    assert.equal(f.controller.snapshot?.root, '/second');
    assert.notEqual(f.controller.snapshot?.revision, first.revision, 'An old root cannot authorize a terminal in the new root');
    f.controller.setContext(undefined, undefined, true);
    await f.controller.refresh();
    assert.equal(f.controller.snapshot?.root, undefined, 'A failed uninitialized context cannot invent a terminal cwd');
    assert.notEqual(f.controller.snapshot?.revision, first.revision);
  } finally { f.controller.dispose(); }
});

test('watch registration failure stays visible, preserves existing coverage and retries', async () => {
  let fail = false;
  let value = snapshot();
  const watched = new Map<string, boolean>();
  const controller = new BmadWorkflowController({
    bundledCatalog: async () => 'catalog', read: async () => value, directoryExists: async () => true,
    watch: directory => {
      if (fail && directory.endsWith('new-output')) throw new Error('Watcher unavailable');
      watched.set(directory, true);
      return { dispose: () => { watched.set(directory, false); } };
    }, changed: () => undefined, error: () => undefined
  });
  try {
    controller.setContext('/project', 'project', true);
    await controller.refresh();
    value = { ...snapshot(), watchDirectories: ['/project/new-output'] };
    fail = true;
    await controller.refresh();
    assert.equal(controller.snapshot?.observation.state, 'error');
    assert.equal(watched.get('/project'), true, 'A failed replacement must retain the prior discovery watch');
    fail = false;
    await controller.refresh();
    assert.equal(controller.snapshot?.observation.state, 'watching');
    assert.equal(watched.get('/project/new-output'), true);
    assert.equal(watched.get('/project'), false);
  } finally { controller.dispose(); }
});

test('new directories bind after creation and catch a change missed during native registration without polling', async () => {
  const root = path.resolve('/project'), skills = path.join(root, '.agents', 'skills');
  let created = false, deleted = false, reads = 0;
  const f = fixture(async () => {
    reads++;
    const value = snapshot(root, !created ? 'missing' : deleted ? 'deleted' : 'ready');
    value.watchDirectories = [root, skills];
    return value;
  }, async directory => directory === root || created);
  try {
    f.controller.setContext(root, 'project', true);
    await f.controller.refresh();
    assert.deepEqual(f.watchers.map(watcher => watcher.directory), [root], 'Never bind a native watcher to a missing base');
    created = true;
    f.watchers[0].changed(path.join(root, '.agents'));
    const deadline = Date.now() + 1000;
    while (f.controller.snapshot?.revision !== 'ready' && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(f.controller.snapshot?.revision, 'ready');
    assert.ok(f.watchers.some(watcher => watcher.directory === skills && !watcher.disposed));
    deleted = true; // No native callback: deletion races the new registration.
    await new Promise(resolve => setTimeout(resolve, 220));
    assert.equal(f.controller.snapshot?.revision, 'deleted');
    assert.equal(reads, 3);
    await new Promise(resolve => setTimeout(resolve, 220));
    assert.equal(reads, 3, 'The catch-up must stop after the new bindings settle');
  } finally { f.controller.dispose(); }
});

test('a late directory probe cannot attach watchers to a project that has been replaced', async () => {
  let finish!: (value: boolean) => void;
  const f = fixture(async ({ root }) => snapshot(root), async directory => directory === '/old'
    ? new Promise(resolve => { finish = resolve; }) : true);
  try {
    f.controller.setContext('/old', 'old', true);
    const old = f.controller.refresh();
    await new Promise(resolve => setImmediate(resolve));
    f.controller.setContext('/new', 'new', true);
    await f.controller.refresh();
    finish(true); await old;
    assert.equal(f.controller.snapshot?.root, '/new');
    assert.deepEqual(f.watchers.map(watcher => watcher.directory), ['/new']);
  } finally { f.controller.dispose(); }
});

test('read failure retains progress but publishes current installation diagnostics', async () => {
  let value = snapshot();
  const f = fixture(async () => value);
  try {
    f.controller.setContext('/project', 'project', true);
    await f.controller.refresh();
    value = { ...snapshot(), installation: { state: 'error', reason: 'Manifest cannot be read' },
      observation: { state: 'error', error: 'Read failed' }, steps: [], diagnostics: [{ code: 'read-failed', message: 'Read failed' }] };
    await f.controller.refresh();
    assert.equal(f.controller.snapshot?.installation.state, 'error');
    assert.equal(f.controller.snapshot?.steps.length, 1);
    assert.equal(f.controller.snapshot?.observation.state, 'error');
  } finally { f.controller.dispose(); }
});
