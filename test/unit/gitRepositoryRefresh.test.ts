import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import { GitRefreshScheduler, type RefreshClock } from '../../src/git/gitRefreshScheduler';
import { withGitDirectoryLock } from '../../src/git/repositoryOperationLock';

const head = 'a'.repeat(40);
const flush = async () => { for (let i = 0; i < 100; i++) await Promise.resolve(); };

class Clock implements RefreshClock {
  time = 0; next = 0;
  timers = new Map<number, { time: number; run: () => void }>();
  now(): number { return this.time; }
  set(run: () => void, delay: number): number { const id = ++this.next; this.timers.set(id, { time: this.time + delay, run }); return id; }
  clear(id: unknown): void { this.timers.delete(id as number); }
  async advance(ms: number): Promise<void> {
    const end = this.time + ms;
    for (let i = 0; i < 1000; i++) {
      const next = [...this.timers].sort((a, b) => a[1].time - b[1].time).find((item) => item[1].time <= end);
      if (!next) { this.time = end; await flush(); return; }
      this.time = next[1].time; this.timers.delete(next[0]); next[1].run(); await flush();
    }
    throw new Error('Git refresh did not settle.');
  }
}

async function fixture() {
  class Emitter {
    listeners = new Set<(value?: unknown) => void>();
    event = (listener: (value?: unknown) => void) => { this.listeners.add(listener); return { dispose: () => this.listeners.delete(listener) }; };
    fire(value?: unknown) { for (const listener of this.listeners) listener(value); }
    dispose() { this.listeners.clear(); }
  }
  const changes = new Emitter();
  const counts = { status: 0, branches: 0, config: 0, diff: 0, commands: [] as string[][] };
  const root = process.cwd();
  const change = { uri: { fsPath: path.join(root, 'README.md') }, status: 5 };
  const repository = {
    rootUri: { fsPath: root },
    state: { HEAD: { name: 'main', commit: head }, refs: [], remotes: [], indexChanges: [] as typeof change[], workingTreeChanges: [change], mergeChanges: [], onDidChange: changes.event },
    status: async () => { counts.status++; changes.fire(); },
    getBranches: async () => { counts.branches++; return [{ name: 'main', commit: head, type: 0 }]; },
    getConfig: async () => { counts.config++; return ''; },
    diffWithHEAD: async () => { counts.diff++; return 'diff --git a/README.md b/README.md\n--- a/README.md\n+++ b/README.md\n@@ -1 +1 @@\n-old\n+new\n'; },
    diffIndexWithHEAD: async () => { counts.diff++; return ''; }
  };
  const api = { state: 'initialized', repositories: [repository], git: { path: 'disabled-git' }, onDidChangeState: new Emitter().event, onDidOpenRepository: new Emitter().event, onDidCloseRepository: new Emitter().event };
  const modulePath = path.resolve(__dirname, '../../src/git/gitRepositoryService.js');
  const nativeRequire = createRequire(modulePath);
  const moduleExports: Record<string, any> = {};
  vm.runInNewContext(readFileSync(modulePath, 'utf8'), {
    exports: moduleExports, Buffer, process, setTimeout, clearTimeout,
    require: (name: string) => {
      if (name === 'vscode') return { EventEmitter: Emitter, workspace: { textDocuments: [] }, extensions: { getExtension: () => ({ isActive: true, exports: { enabled: true, getAPI: () => api, onDidChangeEnablement: new Emitter().event } }) } };
      if (name === './cloneService') return {};
      if (name === 'node:child_process') return { execFile: () => { throw new Error('Git processes disabled in fixture'); }, spawn: () => { throw new Error('Git processes disabled in fixture'); } };
      return nativeRequire(name);
    }
  });
  const session = { isTransitioning: false };
  const service: any = new moduleExports.GitRepositoryService({ fsPath: root }, { fsPath: root }, session);
  await service.initialization;
  const id = service.repositoryId(root);
  service.requireRepository = async () => repository;
  service.assertObjectId = async () => undefined;
  service.assertRef = async () => undefined;
  service.runGit = async (_repo: unknown, args: string[]) => {
    counts.commands.push(args);
    if (args[0] === 'diff') {
      counts.diff++;
      return { stdout: 'diff --git a/README.md b/README.md\n--- a/README.md\n+++ b/README.md\n@@ -1 +1 @@\n-old\n+new\n', stderr: '', code: 0 };
    }
    if (args[0] === 'add') { repository.state.indexChanges = [change]; repository.state.workingTreeChanges = []; }
    const history = [head, 'b'.repeat(40), 'Tester', '2026-10-08T00:00:00Z', 'Test commit'].join('\0') + '\n';
    return { stdout: args[0] === 'symbolic-ref' ? 'main\n' : args[0] === 'log' || args[0] === 'show' ? history : args[0] === 'diff-tree' ? 'README.md\0' : '', stderr: '', code: 0 };
  };
  const clock = new Clock();
  service.refreshScheduler.dispose();
  service.refreshScheduler = new GitRefreshScheduler((repositoryId) => service.sendRepositoryUpdate(repositoryId), clock);
  service.setActivePanelRepository(id, false);
  return { service, repository, session, id, counts, clock, emit: () => changes.fire() };
}

test('a status-completed event cannot recursively run status; open, reads and staging settle for 60 seconds', async (t) => {
  const f = await fixture(); t.after(() => f.service.dispose());
  await f.service.handleAction(f.id, { type: 'open', repoId: f.id });
  assert.equal(f.counts.status, 1);
  let before = JSON.stringify(f.counts); await f.clock.advance(60_000); assert.equal(JSON.stringify(f.counts), before);
  for (let i = 0; i < 100; i++) f.emit();
  await f.clock.advance(250); assert.equal(f.counts.status, 1);
  assert.equal(JSON.stringify(f.counts), before, 'unchanged status-completed notifications do not read Git again');
  Object.assign(f.repository.state.HEAD, { commit: 'd'.repeat(40) });
  f.emit(); await f.clock.advance(250); assert.equal(f.counts.status, 1);
  before = JSON.stringify(f.counts); await f.clock.advance(60_000); assert.equal(JSON.stringify(f.counts), before);
  const logsBefore = f.counts.commands.filter((args) => args[0] === 'log').length;
  await f.service.handleAction(f.id, { type: 'readDiff', path: 'README.md', staged: false });
  await f.service.handleAction(f.id, { type: 'readDiff', path: 'README.md', staged: false });
  await f.service.handleAction(f.id, { type: 'readCommit', hash: head });
  await f.service.handleAction(f.id, { type: 'readCommit', hash: head });
  assert.equal(f.counts.diff, 1); assert.equal(f.counts.status, 1);
  assert.deepEqual(Array.from(f.counts.commands.find((args) => args[0] === 'diff')!), ['diff', '--no-ext-diff', '--', 'README.md'], 'unstaged Diff compares the index with the working tree');
  assert.equal(f.counts.commands.filter((args) => args[0] === 'log').length, logsBefore);
  await f.service.handleAction(f.id, { type: 'stageFile', path: 'README.md', staged: true });
  before = JSON.stringify(f.counts); await f.clock.advance(60_000); assert.equal(JSON.stringify(f.counts), before);
  const summaryCommands = f.counts.commands.length; await f.service.getSummaryState();
  assert.equal(f.counts.commands.length, summaryCommands);
});

test('annotated and lightweight tags both point graph labels and selections at their commit', async (t) => {
  const f = await fixture(); t.after(() => f.service.dispose());
  const runGit = f.service.runGit;
  f.service.runGit = async (repository: unknown, args: string[]) => {
    if (args[0] === 'for-each-ref' && args.includes('refs/tags')) {
      return { stdout: `annotated\0${head}\0${'c'.repeat(40)}\nlightweight\0\0${head}\n`, stderr: '' };
    }
    return runGit(repository, args);
  };
  const snapshot = await f.service.handleAction(f.id, { type: 'open', repoId: f.id });
  const tags = snapshot.branches.filter((ref: { kind: string }) => ref.kind === 'tag');
  assert.equal(tags.length, 2);
  assert.ok(tags.every((ref: { commit: string }) => ref.commit === head), 'annotated tag object IDs must not become commit selections');
});

test('only a completed Commit acknowledges draft submission, even if HEAD changes during cancellation', async (t) => {
  const f = await fixture(); t.after(() => f.service.dispose());
  f.repository.state.indexChanges = f.repository.state.workingTreeChanges;
  f.repository.state.workingTreeChanges = [];
  let commits = 0;
  (f.repository as any).commit = async () => { commits++; f.repository.state.HEAD.commit = 'e'.repeat(40); };
  f.service.setWarningPromptHandlerForTesting(async () => { f.repository.state.HEAD.commit = 'd'.repeat(40); return undefined; });
  const cancelled = await f.service.handleAction(f.id, { type: 'commit', message: 'Preserve draft' });
  assert.equal(cancelled.headCommit, 'd'.repeat(40));
  assert.equal(cancelled.commitCompleted, false);
  assert.equal(commits, 0);
  f.service.setWarningPromptHandlerForTesting(async () => 'Commit');
  const completed = await f.service.handleAction(f.id, { type: 'commit', message: 'Submit draft' });
  assert.equal(completed.commitCompleted, true);
  assert.equal(commits, 1);
});

test('a detached HEAD named after a tag by the native API is not treated as a branch', async (t) => {
  const f = await fixture(); t.after(() => f.service.dispose());
  f.repository.state.HEAD.name = 'validation/annotated';
  const runGit = f.service.runGit;
  f.service.runGit = async (repository: unknown, args: string[]) => {
    if (args[0] === 'symbolic-ref') throw new Error('HEAD is detached');
    return runGit(repository, args);
  };
  const snapshot = await f.service.handleAction(f.id, { type: 'open', repoId: f.id });
  assert.equal(snapshot.branch, undefined);
  assert.equal(snapshot.headCommit, head);
  assert.equal(snapshot.branches.some((ref: { current: boolean }) => ref.current), false);
});

test('identical selections share reads, obsolete queued selections are skipped, and account transitions permit reads', async (t) => {
  const f = await fixture(); t.after(() => f.service.dispose());
  await f.service.handleAction(f.id, { type: 'open', repoId: f.id });
  f.session.isTransitioning = true;
  let release!: () => void;
  const held = withGitDirectoryLock(f.repository.rootUri.fsPath, () => new Promise<void>((resolve) => { release = resolve; }));
  await flush();
  const obsolete = f.service.handleAction(f.id, { type: 'readDiff', path: 'README.md', staged: false });
  const selected = f.service.handleAction(f.id, { type: 'readCommit', hash: head });
  const duplicate = f.service.handleAction(f.id, { type: 'readCommit', hash: head });
  assert.equal(f.service.hasActiveOperations, false);
  release(); await held;
  assert.equal(await obsolete, undefined);
  assert.equal((await selected).selectedCommit.hash, head); await duplicate;
  assert.equal(f.counts.diff, 0);
  assert.equal(f.counts.commands.filter((args) => args[0] === 'show').length, 1);
});

test('switching away, disposal and failed background reads never leave retry loops', async (t) => {
  const f = await fixture(); t.after(() => f.service.dispose());
  f.emit(); f.service.setActivePanelRepository(undefined); await f.clock.advance(60_000);
  assert.equal(f.counts.commands.length, 0);
  f.service.setActivePanelRepository(f.id, false);
  f.service.getSnapshot = async () => { throw new Error('Repo disappeared'); };
  Object.assign(f.repository.state.HEAD, { commit: 'd'.repeat(40) });
  f.emit(); await f.clock.advance(250); assert.equal(f.clock.timers.size, 0);
  f.emit(); f.service.dispose(); await f.clock.advance(60_000);
  assert.equal(f.clock.timers.size, 0);
});

test('hiding the panel cancels queued reads while an authorized write still finishes', async (t) => {
  const f = await fixture(); t.after(() => f.service.dispose());
  await f.service.handleAction(f.id, { type: 'open', repoId: f.id });
  let release!: () => void;
  const held = withGitDirectoryLock(f.repository.rootUri.fsPath, () => new Promise<void>((resolve) => { release = resolve; }));
  await flush();
  const read = f.service.handleAction(f.id, { type: 'history', skip: 200 });
  const write = f.service.handleAction(f.id, { type: 'stageFile', path: 'README.md', staged: true });
  await flush();
  f.service.setActivePanelRepository(undefined);
  release(); await held;
  assert.equal(await read, undefined);
  assert.equal((await write).stagedCount, 1);
  assert.equal(f.counts.commands.filter((args) => args.includes('--skip=200')).length, 0);
  const before = JSON.stringify(f.counts); await f.clock.advance(60_000);
  assert.equal(JSON.stringify(f.counts), before);
});

test('returning to an in-flight selection makes its shared read current again', async (t) => {
  const f = await fixture(); t.after(() => f.service.dispose());
  await f.service.handleAction(f.id, { type: 'open', repoId: f.id });
  let release!: () => void;
  const held = withGitDirectoryLock(f.repository.rootUri.fsPath, () => new Promise<void>((resolve) => { release = resolve; }));
  await flush();
  const first = f.service.handleAction(f.id, { type: 'readDiff', path: 'README.md', staged: false });
  const obsolete = f.service.handleAction(f.id, { type: 'readCommit', hash: head });
  const again = f.service.handleAction(f.id, { type: 'readDiff', path: 'README.md', staged: false });
  release(); await held;
  assert.equal((await first).diffPath, 'README.md');
  assert.equal((await again).diffPath, 'README.md');
  assert.equal(await obsolete, undefined);
  assert.equal(f.counts.diff, 1);
});

test('an unborn Repo opens without running git log against a missing HEAD', async (t) => {
  const f = await fixture(); t.after(() => f.service.dispose());
  Object.assign(f.repository.state.HEAD, { commit: undefined });
  const snapshot = await f.service.handleAction(f.id, { type: 'open', repoId: f.id });
  assert.equal(snapshot.headCommit, undefined);
  assert.equal(snapshot.history.length, 0);
  assert.equal(snapshot.historyHasMore, false);
  assert.equal(f.counts.commands.filter((args) => args[0] === 'log').length, 0);
});

test('returning to a Repo does not share a cancelled read from its previous panel lifetime', async (t) => {
  const f = await fixture(); t.after(() => f.service.dispose());
  await f.service.handleAction(f.id, { type: 'open', repoId: f.id });
  let release!: () => void;
  const held = withGitDirectoryLock(f.repository.rootUri.fsPath, () => new Promise<void>((resolve) => { release = resolve; }));
  await flush();
  const abandoned = f.service.handleAction(f.id, { type: 'readCommit', hash: head });
  f.service.setActivePanelRepository(undefined);
  f.service.setActivePanelRepository(f.id, false);
  const current = f.service.handleAction(f.id, { type: 'readCommit', hash: head });
  release(); await held;
  assert.equal(await abandoned, undefined);
  assert.equal((await current).selectedCommit.hash, head);
  assert.equal(f.counts.commands.filter((args) => args[0] === 'show').length, 1);
});
