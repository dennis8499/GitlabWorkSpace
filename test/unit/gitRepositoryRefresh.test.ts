import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm, truncate, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import net from 'node:net';
import type { captureGitProcess } from '../../src/git/gitProcess';
import type { RefreshClock } from '../../src/git/gitRefreshScheduler';
import { withGitDirectoryLock } from '../../src/git/repositoryOperationLock';
import { OperationLog } from '../../src/logging/operationLog';

const head = 'a'.repeat(40);
const flush = async () => { for (let i = 0; i < 100; i++) await Promise.resolve(); await new Promise(resolve => setTimeout(resolve, 10)); };

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
  const opened = new Emitter(), closed = new Emitter(), clock = new Clock();
  const counts = { status: 0, branches: 0, config: 0, diff: 0, commands: [] as string[][] };
  let capture: typeof captureGitProcess | undefined;
  const configuration: Record<string, unknown> = {};
  const root = process.cwd();
  const change = { uri: { fsPath: path.join(root, 'README.md') }, status: 5 };
  const repository = {
    rootUri: { fsPath: root },
    state: { HEAD: { name: 'main', commit: head }, refs: [], remotes: [] as Array<{ name: string; fetchUrl?: string; pushUrl?: string }>, indexChanges: [] as typeof change[], workingTreeChanges: [change], mergeChanges: [], onDidChange: changes.event },
    status: async () => { counts.status++; changes.fire(); },
    getBranches: async () => { counts.branches++; return [{ name: 'main', commit: head, type: 0 }]; },
    getConfig: async () => { counts.config++; return ''; },
    diffWithHEAD: async () => { counts.diff++; return 'diff --git a/README.md b/README.md\n--- a/README.md\n+++ b/README.md\n@@ -1 +1 @@\n-old\n+new\n'; },
    diffIndexWithHEAD: async () => { counts.diff++; return ''; }
  };
  const api = { state: 'initialized', repositories: [repository], git: { path: 'disabled-git' }, onDidChangeState: new Emitter().event, onDidOpenRepository: opened.event, onDidCloseRepository: closed.event };
  const modulePath = path.resolve(__dirname, '../../src/git/gitRepositoryService.js');
  const nativeRequire = createRequire(modulePath);
  const moduleExports: Record<string, any> = {};
  vm.runInNewContext(readFileSync(modulePath, 'utf8'), {
    exports: moduleExports, Buffer, process, AbortController, AbortSignal,
    setTimeout: (callback: () => void, delay: number) => clock.set(callback, delay), clearTimeout: (id: unknown) => clock.clear(id),
    require: (name: string) => {
      if (name === 'vscode') return { EventEmitter: Emitter, workspace: { textDocuments: [], getConfiguration: (section: string) => ({ get: (key: string, fallback?: unknown) => configuration[section + '.' + key] ?? fallback }) }, extensions: { getExtension: () => ({ isActive: true, exports: { enabled: true, getAPI: () => api, onDidChangeEnablement: new Emitter().event } }) } };
      if (name === './cloneService') return { createScopedGitEnvironment: nativeRequire(name).createScopedGitEnvironment };
      if (name === './gitAskpassUi') return { createGitCredentialPrompt: () => async () => undefined };
      if (name === './gitProcess') return { ...nativeRequire(name), captureGitProcess: (...args: Parameters<typeof captureGitProcess>) => capture ? capture(...args) : nativeRequire(name).captureGitProcess(...args) };
      if (name === 'node:child_process') return { execFile: () => { throw new Error('Git processes disabled in fixture'); }, spawn: () => { throw new Error('Git processes disabled in fixture'); } };
      return nativeRequire(name);
    }
  });
  const session = { isTransitioning: false };
  const service: any = new moduleExports.GitRepositoryService({ fsPath: root }, { fsPath: root }, session);
  await service.initialization;
  const id = service.repositoryId(root);
  service.requireRepository = async () => repository;
  service.operationFor = async () => undefined;
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
  service.setActivePanelRepository(id, false);
  return { service, repository, api, session, id, counts, clock, configuration, setCapture: (callback: typeof captureGitProcess) => { capture = callback; }, emit: () => changes.fire(),
    open: () => opened.fire(repository), close: () => closed.fire(repository) };
}

test('native status events never start reads; explicit open, reads and staging settle for 60 seconds', async (t) => {
  const f = await fixture(); t.after(() => f.service.dispose());
  await f.service.handleAction(f.id, { type: 'open', repoId: f.id });
  assert.equal(f.counts.status, 1);
  let before = JSON.stringify(f.counts); await f.clock.advance(60_000); assert.equal(JSON.stringify(f.counts), before);
  for (let i = 0; i < 100; i++) f.emit();
  await f.clock.advance(250); assert.equal(f.counts.status, 1);
  assert.equal(JSON.stringify(f.counts), before, 'unchanged status-completed notifications do not read Git again');
  Object.assign(f.repository.state.HEAD, { commit: 'd'.repeat(40) });
  f.emit(); await f.clock.advance(500);
  assert.equal(JSON.stringify(f.counts), before, 'changed native state also waits for a user read');
  before = JSON.stringify(f.counts); await f.clock.advance(60_000); assert.equal(JSON.stringify(f.counts), before);
  const logsBefore = f.counts.commands.filter((args) => args[0] === 'log').length;
  await f.service.handleAction(f.id, { type: 'readDiff', path: 'README.md', staged: false });
  await f.service.handleAction(f.id, { type: 'readDiff', path: 'README.md', staged: false });
  await f.service.handleAction(f.id, { type: 'readCommit', hash: head });
  await f.service.handleAction(f.id, { type: 'readCommit', hash: head });
  assert.equal(f.counts.diff, 1); assert.equal(f.counts.status, 1);
  assert.deepEqual(Array.from(f.counts.commands.find((args) => args[0] === 'diff')!), ['diff', '--no-ext-diff', '--', 'README.md'], 'unstaged Diff compares the index with the working tree');
  assert.equal(f.counts.commands.filter((args) => args[0] === 'log').length, logsBefore + 1,
    'the first explicit read after native invalidation reloads history once');
  await f.service.handleAction(f.id, { type: 'stageFile', path: 'README.md', staged: true });
  before = JSON.stringify(f.counts); await f.clock.advance(60_000); assert.equal(JSON.stringify(f.counts), before);
  const summaryCommands = f.counts.commands.length; await f.service.getSummaryState();
  assert.equal(f.counts.commands.length, summaryCommands);
});

test('each explicit page open or refresh reads once and a write refreshes only its affected Repo once', async t => {
  const f = await fixture(); t.after(() => f.service.dispose());
  await f.service.handleAction(f.id, { type: 'open', repoId: f.id });
  f.service.setActivePanelRepository(undefined);
  f.service.setActivePanelRepository(f.id);
  assert.equal(f.counts.status, 1, 're-entering waits for its explicit open request');
  await f.service.handleAction(f.id, { type: 'open', repoId: f.id });
  await f.service.handleAction(f.id, { type: 'refresh' });
  assert.equal(f.counts.status, 3);
  const readSnapshot = f.service.readSnapshot.bind(f.service);
  let snapshots = 0;
  f.service.readSnapshot = async (...args: unknown[]) => { snapshots++; return readSnapshot(...args); };
  await f.service.handleAction(f.id, { type: 'stageFile', path: 'README.md', staged: true });
  assert.equal(snapshots, 1, 'the authorized write returns one reconciled snapshot');
  assert.equal(f.counts.status, 5, 'the write retains its preflight and post-write status checks');
  const reads = JSON.stringify(f.counts);
  await f.clock.advance(120_000);
  assert.equal(JSON.stringify(f.counts), reads);
});

test('staging preserves history, tags, stash and configuration reads; unknown native events invalidate them', async t => {
  const f = await fixture(); t.after(() => f.service.dispose());
  const first = await f.service.handleAction(f.id, { type: 'open', repoId: f.id });
  const metadataReads = () => JSON.stringify({ branches: f.counts.branches, config: f.counts.config,
    commands: f.counts.commands.filter(args => ['log', 'for-each-ref', 'stash'].includes(args[0])) });
  const before = metadataReads();
  const staged = await f.service.handleAction(f.id, { type: 'stageFile', path: 'README.md', staged: true });
  assert.equal(metadataReads(), before, 'known index writes do not rerun log, tags, stash, recovery refs or config');
  assert.equal(staged.stagedCount, 1); assert.equal(staged.unstagedCount, 0);
  assert.ok(staged.revision > first.revision);
  f.emit();
  assert.equal(metadataReads(), before, 'an unknown notification still waits for an explicit read');
  await f.service.handleAction(f.id, { type: 'open', repoId: f.id, refresh: false });
  assert.notEqual(metadataReads(), before, 'unknown native events conservatively expire reference/config caches');
});

test('a HEAD change during an index action expires history and reference details', async t => {
  const f = await fixture(); t.after(() => f.service.dispose());
  await f.service.handleAction(f.id, { type: 'open', repoId: f.id });
  const before = f.counts.commands.filter(args => args[0] === 'log').length;
  const run = f.service.runGit;
  f.service.runGit = async (repository: unknown, args: string[]) => {
    const result = await run(repository, args);
    if (args[0] === 'add') { f.repository.state.HEAD.commit = 'e'.repeat(40); f.emit(); }
    return result;
  };
  const result = await f.service.handleAction(f.id, { type: 'stageFile', path: 'README.md', staged: true });
  assert.equal(result.headCommit, 'e'.repeat(40));
  assert.equal(f.counts.commands.filter(args => args[0] === 'log').length, before + 1);
  assert.equal(f.counts.branches, 2);
});

test('partial staging keeps reference reads while validating and applying the selected patch', async t => {
  const f = await fixture(); t.after(() => f.service.dispose());
  await f.service.handleAction(f.id, { type: 'open', repoId: f.id });
  const diff = await f.service.handleAction(f.id, { type: 'readDiff', path: 'README.md', staged: false });
  const before = { branches: f.counts.branches, config: f.counts.config,
    references: f.counts.commands.filter(args => ['log', 'for-each-ref', 'stash'].includes(args[0])).length };
  await f.service.handleAction(f.id, { type: 'stagePatch', path: 'README.md', lines: [4, 5], basedOnDiff: diff.diffText });
  assert.ok(f.counts.commands.some(args => args[0] === 'apply' && args.includes('--cached')));
  assert.deepEqual({ branches: f.counts.branches, config: f.counts.config,
    references: f.counts.commands.filter(args => ['log', 'for-each-ref', 'stash'].includes(args[0])).length }, before);
});

test('Fetch freshness records only observed successful workbench fetches', async t => {
  const f = await fixture(); t.after(() => f.service.dispose());
  assert.equal((await f.service.buildSummary(f.repository, f.id)).lastSuccessfulFetchAt, undefined);
  await f.service.fetchRemote(f.repository, 'origin');
  const observed = (await f.service.buildSummary(f.repository, f.id)).lastSuccessfulFetchAt;
  assert.ok(Number.isFinite(observed) && observed > 0);
  f.service.runGit = async () => { throw new Error('fetch failed'); };
  await assert.rejects(f.service.fetchRemote(f.repository, 'origin'), /fetch failed/);
  assert.equal((await f.service.buildSummary(f.repository, f.id)).lastSuccessfulFetchAt, observed);
  f.emit();
  assert.equal(f.service.successfulFetches.get(f.id), observed, 'external status events do not invent a fetch time');
});

test('native Diff exposes blob read failures instead of inventing an empty file', async t => {
  const f = await fixture(); t.after(() => f.service.dispose());
  f.service.safeRelativePath = async () => 'README.md';
  f.service.confirmSavedEditors = async () => true;
  f.service.readBlob = async () => { throw new Error('blob timed out'); };
  await assert.rejects(f.service.openNativeDiff(f.id, 'README.md', true), /blob timed out/);
});

test('a missing blob is empty only after a successful tree or index existence check', async t => {
  const f = await fixture(); t.after(() => f.service.dispose());
  f.service.runGit = async () => ({ stdout: '', stderr: '', code: 0 });
  assert.equal((await f.service.readBlob(f.repository, 'HEAD:./added.txt')).length, 0);
  f.service.runGit = async () => ({ stdout: '100644 blob object\texisting.txt\0', stderr: '', code: 0 });
  await assert.rejects(f.service.readBlob(f.repository, 'HEAD:./existing.txt'), /Git processes disabled/);
  f.service.runGit = async () => { throw new Error('existence check unavailable'); };
  await assert.rejects(f.service.readBlob(f.repository, ':./existing.txt'), /Git processes disabled/);
});

test('native working-file Diff rejects an oversized snapshot before reading the file', async t => {
  const f = await fixture(); t.after(() => f.service.dispose());
  const root = await mkdtemp(path.join(os.tmpdir(), 'git-ui-large-diff-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'large.bin'); await writeFile(file, ''); await truncate(file, 129 * 1024 * 1024);
  f.repository.rootUri.fsPath = root;
  f.service.safeRelativePath = async () => 'large.bin'; f.service.confirmSavedEditors = async () => true;
  f.service.readBlob = async () => Buffer.alloc(0);
  await assert.rejects(f.service.openNativeDiff(f.id, 'large.bin', false), /128 MiB/);
});

test('local Git environment does not read account secrets', async t => {
  const f = await fixture(); t.after(() => f.service.dispose());
  let reads = 0;
  (f.session as any).getCloneCredentials = async () => { reads++; return undefined; };
  await f.service.environmentFor(f.repository, ['diff']);
  await f.service.environmentFor(f.repository, ['log']);
  assert.equal(reads, 0);
});

test('manual Fetch preserves reachable tags, FETCH_HEAD and Repo settings while internal branch fetches stay narrow', async t => {
  const f = await fixture(); t.after(() => f.service.dispose());
  await f.service.fetchRemote(f.repository, 'origin');
  const manual = f.counts.commands.at(-1)!;
  assert.ok(manual.includes('--atomic') && manual.includes('--jobs=1'));
  for (const flag of ['--no-tags', '--tags', '--no-write-fetch-head', '--no-prune', '--no-recurse-submodules', '--prune']) assert.equal(manual.includes(flag), false, flag);
  f.configuration['git.pruneOnFetch'] = true;
  await f.service.fetchRemote(f.repository, 'origin'); assert.ok(f.counts.commands.at(-1)!.includes('--prune'));
  await f.service.fetchRemote(f.repository, 'origin', 'feature/topic');
  const internal = f.counts.commands.at(-1)!;
  for (const flag of ['--no-tags', '--no-write-fetch-head', '--no-prune', '--no-recurse-submodules']) assert.ok(internal.includes(flag), flag);
  assert.equal(internal.includes('--prune'), false); assert.equal(internal.at(-1), '+refs/heads/feature/topic:refs/remotes/origin/feature/topic');
});

test('selected GitLab remotes authenticate without loading project inventory and cannot borrow another remote token', async t => {
  const f = await fixture(); t.after(() => f.service.dispose());
  Object.assign(f.session, { baseUrl: 'https://gitlab.test/gitlab', connectionEpoch: 1 });
  let reads = 0;
  (f.session as any).getCloneCredentials = async () => { reads++; return { baseUrl: 'https://gitlab.test/gitlab', token: 'offline-fixture-token' }; };
  f.service.setGitLabProjects(() => Array.from({ length: 100 }, (_, index) => ({ id: index, http_url_to_repo: `https://gitlab.test/gitlab/team/repo-${index}.git` })));
  f.repository.state.remotes = [
    { name: 'origin', fetchUrl: 'https://other.test/team/repo.git' },
    { name: 'selected', fetchUrl: 'https://gitlab.test/gitlab/team/repo-501.git', pushUrl: 'https://gitlab.test/sibling/repo-501.git' }
  ];
  const authenticated = await f.service.environmentFor(f.repository, ['fetch', '--atomic', 'selected']);
  const first = Number.parseInt(process.env.GIT_CONFIG_COUNT ?? '0', 10) || 0;
  assert.equal(authenticated['GIT_CONFIG_KEY_' + first], 'http.https://gitlab.test/gitlab/team/repo-501.git/.extraheader');
  assert.equal(authenticated['GIT_CONFIG_VALUE_' + first], 'AUTHORIZATION: Basic ' + Buffer.from('oauth2:offline-fixture-token').toString('base64'));
  assert.equal(Number(authenticated.GIT_CONFIG_COUNT), first + 1, 'GUI authentication must retain configured credential helpers for recursive submodule fetches');
  await f.service.environmentFor(f.repository, ['fetch', 'origin']);
  await f.service.environmentFor(f.repository, ['push', 'selected', 'HEAD:refs/heads/main']);
  assert.equal(reads, 1, 'untrusted selected hosts and sibling applications never read the Workspace token');
  (f.session as any).getCloneCredentials = async () => { (f.session as any).connectionEpoch++; return { baseUrl: 'https://gitlab.test/gitlab', token: 'late-token' }; };
  const stale = await f.service.environmentFor(f.repository, ['ls-remote', '--heads', 'selected']);
  assert.notEqual(stale['GIT_CONFIG_VALUE_' + first], 'AUTHORIZATION: Basic ' + Buffer.from('oauth2:late-token').toString('base64'));
});

test('network commands receive only their operation AskPass binding and respect integrated prompt opt-out', async t => {
  const f = await fixture(); t.after(() => f.service.dispose());
  f.repository.state.remotes = [{ name: 'external', fetchUrl: 'https://other.test/team/repo.git' }];
  let calls = 0;
  f.setCapture(async (_executable, args, options) => {
    calls++;
    assert.deepEqual(Array.from(args), ['-c', 'core.quotepath=false', 'fetch', 'external']);
    if (calls === 1) {
      assert.match(options!.env!.GIT_ASKPASS!, /askpass\.sh$/);
      assert.equal(options!.env!.GIT_CONFIG_KEY_0, 'credential.https://other.test/team/repo.git.useHttpPath');
      assert.ok(options!.signal);
    } else assert.equal(options!.env!.GITLAB_WORKSPACE_ASKPASS_NONCE, undefined);
    return { stdout: '', stderr: '', code: 0, truncated: false };
  });
  await f.service.runGitCommand(f.repository, ['fetch', 'external'], undefined, { GIT_CONFIG_COUNT: '0', GIT_ASKPASS: '' });
  f.configuration['git.useIntegratedAskPass'] = false;
  await f.service.runGitCommand(f.repository, ['fetch', 'external'], undefined, { GIT_CONFIG_COUNT: '0', GIT_ASKPASS: '' });
  assert.equal(calls, 2);
});

test('repository Git commands log one terminal and preserve accepted and failed exit codes', async t => {
  const f = await fixture(); t.after(() => f.service.dispose());
  const lines: string[] = [], write = (line: string) => { lines.push(line); };
  const log = new OperationLog({ info: write, warn: write, error: write }); t.after(() => log.dispose());
  (f.session as any).log = log;
  let code = 0;
  f.setCapture(async () => ({ stdout: '', stderr: 'private-stderr', code, truncated: false }));
  const execute = (...args: unknown[]) => Object.getPrototypeOf(f.service).runGit.call(f.service, f.repository, ...args);
  await execute(['symbolic-ref', '--quiet', 'HEAD']);
  code = 1; await execute(['rev-parse', '--verify', 'missing'], undefined, {}, [1]);
  code = 128; await assert.rejects(execute(['show', 'missing']), (error: any) => error.exitCode === 128);
  const entries = lines.map(line => {
    const match = /^\[git\] (\S+) (\S+) (\{.*\})$/.exec(line)!;
    return { ...JSON.parse(match[3]), action: match[1], result: match[2] };
  });
  assert.equal(entries.length, 6); assert.ok(entries.every(entry => entry.network === false));
  assert.deepEqual(entries.filter(entry => entry.result !== 'started').map(entry => [entry.result, entry.exitCode]), [['success', 0], ['success', 1], ['error', 128]]);
  for (const commandId of new Set(entries.map(entry => entry.commandId))) assert.equal(entries.filter(entry => entry.commandId === commandId).length, 2);
  assert.ok(!lines.join('\n').includes('private-stderr'));
});

test('an unknown recursive AskPass destination aborts its Git command and explains independent sign-in', async t => {
  const f = await fixture(); t.after(() => f.service.dispose());
  f.repository.state.remotes = [{ name: 'external', fetchUrl: 'https://other.test/team/repo.git' }];
  f.setCapture(async (_executable, _args, options) => {
    const signal = options!.signal!;
    const stopped = new Promise<never>((_resolve, reject) => signal.addEventListener('abort', () => reject(Object.assign(new Error('cancelled'), { name: 'AbortError' })), { once: true }));
    const socket = net.createConnection(options!.env!.GITLAB_WORKSPACE_ASKPASS_PIPE!);
    socket.on('error', () => undefined);
    socket.once('connect', () => socket.write(JSON.stringify({ schema: 'GitLabWorkspaceAskpass/v1', nonce: options!.env!.GITLAB_WORKSPACE_ASKPASS_NONCE, mode: 'http', prompt: "Password for 'https://other.test/unknown/child.git': " }) + '\n'));
    return stopped;
  });
  await assert.rejects(f.service.runGitCommand(f.repository, ['fetch', 'external'], undefined, { GIT_CONFIG_COUNT: '0', GIT_ASKPASS: '' }), (error: any) => error.effect === 'unknown' && /認證目的地無法確認.*獨立登入/.test(error.message));
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

test('cancelled non-Commit writes report no effect and preserve cancellation through refresh', async t => {
  const f = await fixture(); t.after(() => f.service.dispose());
  let deletions = 0;
  Object.assign(f.repository, { deleteBranch: async () => { deletions++; } });
  f.service.showWarningMessage = async () => undefined;
  const cancelled = await f.service.handleAction(f.id, { type: 'deleteBranch', name: 'unused' });
  assert.equal(cancelled.actionEffect, 'none'); assert.equal(cancelled.actionCancelled, true);
  assert.equal(deletions, 0);
  f.service.confirmSavedEditors = async () => false;
  const unsaved = await f.service.handleAction(f.id, { type: 'checkout', name: 'unused' });
  assert.equal(unsaved.actionEffect, 'none'); assert.equal(unsaved.actionCancelled, true);
});

test('a confirmed Git write keeps its effect and Commit receipt when status refresh fails', async t => {
  const f = await fixture(); t.after(() => f.service.dispose());
  let wrote = false;
  f.service.confirmSavedEditors = async () => true;
  f.service.performAction = async () => { wrote = true; return true; };
  f.repository.status = async () => { if (wrote) throw new Error('status unavailable'); };
  await assert.rejects(f.service.handleAction(f.id, { type: 'commit', message: 'Submitted once' }), error => {
    const outcome = error as Error & { effect?: string; refreshError?: string; commitCompleted?: boolean };
    assert.equal(outcome.effect, 'applied'); assert.equal(outcome.commitCompleted, true);
    assert.ok(outcome.refreshError, 'the safe refresh error is retained separately from the confirmed effect');
    return true;
  });
});

test('a Git command deadline after entering a write preserves an unknown outcome', async t => {
  const f = await fixture(); t.after(() => f.service.dispose());
  f.service.performAction = async () => { throw Object.assign(new Error('Git operation timed out.'), { name: 'TimeoutError' }); };
  await assert.rejects(f.service.handleAction(f.id, { type: 'stageFile', path: 'README.md', staged: true }),
    (error: any) => error.effect === 'unknown');
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
  let release!: () => void, entered!: () => void;
  const acquired = new Promise<void>(resolve => { entered = resolve; });
  const held = withGitDirectoryLock(f.repository.rootUri.fsPath, () => new Promise<void>((resolve) => { release = resolve; entered(); }));
  await acquired;
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

test('selection, native repository registration and disposal never start automatic Git reads', async (t) => {
  const f = await fixture(); t.after(() => f.service.dispose());
  assert.equal(JSON.stringify(f.counts), JSON.stringify({ status: 0, branches: 0, config: 0, diff: 0, commands: [] }), 'initialization registers repositories without reading Git');
  const messages: unknown[] = [];
  f.service.onDidMessage((message: unknown) => messages.push(message));
  f.open(); await flush();
  f.service.setActivePanelRepository(undefined);
  f.service.setActivePanelRepository(f.id);
  await f.clock.advance(120_000);
  assert.equal(f.counts.status, 0, 'native repository-open and active selection do not run status');
  assert.equal(f.counts.commands.length, 0);
  f.emit(); f.service.setActivePanelRepository(undefined); await f.clock.advance(60_000);
  assert.equal(f.counts.commands.length, 0);
  f.service.setActivePanelRepository(f.id, false);
  f.service.getSnapshot = async () => { throw new Error('unexpected automatic snapshot'); };
  Object.assign(f.repository.state.HEAD, { commit: 'd'.repeat(40) });
  f.emit(); await f.clock.advance(500); assert.equal(f.clock.timers.size, 0);
  f.emit(); f.service.dispose(); await f.clock.advance(60_000);
  assert.equal(f.clock.timers.size, 0);
  assert.equal(messages.length, 0);
});

test('hiding the panel cancels queued reads while an authorized write still finishes', async (t) => {
  const f = await fixture(); t.after(() => f.service.dispose());
  await f.service.handleAction(f.id, { type: 'open', repoId: f.id });
  let release!: () => void, entered!: () => void;
  const acquired = new Promise<void>(resolve => { entered = resolve; });
  const held = withGitDirectoryLock(f.repository.rootUri.fsPath, () => new Promise<void>((resolve) => { release = resolve; entered(); }));
  await acquired;
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
  let release!: () => void, entered!: () => void;
  const acquired = new Promise<void>(resolve => { entered = resolve; });
  const held = withGitDirectoryLock(f.repository.rootUri.fsPath, () => new Promise<void>((resolve) => { release = resolve; entered(); }));
  await acquired;
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
  let release!: () => void, entered!: () => void;
  const acquired = new Promise<void>(resolve => { entered = resolve; });
  const held = withGitDirectoryLock(f.repository.rootUri.fsPath, () => new Promise<void>((resolve) => { release = resolve; entered(); }));
  await acquired;
  const abandoned = f.service.handleAction(f.id, { type: 'readCommit', hash: head });
  f.service.setActivePanelRepository(undefined);
  f.service.setActivePanelRepository(f.id, false);
  const current = f.service.handleAction(f.id, { type: 'readCommit', hash: head });
  release(); await held;
  assert.equal(await abandoned, undefined);
  assert.equal((await current).selectedCommit.hash, head);
  assert.equal(f.counts.commands.filter((args) => args[0] === 'show').length, 1);
});


test('sidebar summaries exclude snapshots and their size is independent of Diff length', async (t) => {
  const f = await fixture(); t.after(() => f.service.dispose());
  await f.service.getSummaryState();
  await f.service.handleAction(f.id, { type: 'open', repoId: f.id });
  const before = JSON.stringify(await f.service.getSummaryState());
  f.repository.diffWithHEAD = async () => 'x'.repeat(1_000_000);
  const original = f.service.runGit;
  f.service.runGit = async (repo: unknown, args: string[]) => args[0] === 'diff'
    ? { stdout: 'x'.repeat(1_000_000), stderr: '', code: 0 } : original(repo, args);
  await f.service.handleAction(f.id, { type: 'readDiff', path: 'README.md', staged: false });
  await f.service.handleAction(f.id, { type: 'readCommit', hash: head });
  const state = await f.service.getSummaryState();
  for (const field of ['changes', 'history', 'historyHasMore', 'branches', 'stashes', 'recoveryRefs', 'diffText', 'diffPath', 'selectedCommit', 'commitFiles', 'commitCompleted', 'remotes']) {
    assert.equal(Object.hasOwn(state.repositories[0], field), false, field + ' belongs only to a snapshot');
  }
  const withoutRepositoryRevision = (value: string) => JSON.stringify(JSON.parse(value), (key, item) => key === 'revision' ? undefined : item);
  assert.equal(withoutRepositoryRevision(JSON.stringify(state)), withoutRepositoryRevision(before));
  assert.equal(state.repositories[0].revision, f.service.revisionByRepository.get(f.id));
  assert.ok(JSON.stringify(state).length < 2000);
});

test('cache-only summaries retain presented revisions until an explicit read and never start Git', async (t) => {
  const f = await fixture(); t.after(() => f.service.dispose());
  const before = JSON.stringify(f.counts);
  const initial = f.service.getCachedSummaryState();
  assert.equal(initial.repositories.length, 1, 'native registration supplies local navigation without reading Git');
  f.emit();
  assert.equal(f.service.getCachedSummaryState().repositories[0].revision, initial.repositories[0].revision);
  assert.equal(JSON.stringify(f.counts), before);
  await f.service.handleAction(f.id, { type: 'open', repoId: f.id });
  const loaded = f.service.getCachedSummaryState().repositories[0];
  const reads = JSON.stringify(f.counts);
  f.repository.state.HEAD.commit = 'f'.repeat(40);
  f.emit();
  for (let index = 0; index < 100; index++) {
    const state = f.service.getCachedSummaryState();
    assert.equal(state.repositories[0].revision, loaded.revision);
    assert.equal(state.repositories[0].headCommit, loaded.headCommit);
  }
  await f.clock.advance(120_000);
  assert.equal(JSON.stringify(f.counts), reads);
  const refreshed = await f.service.getSummaryState();
  assert.equal(refreshed.repositories[0].headCommit, 'f'.repeat(40));
  assert.ok(refreshed.repositories[0].revision > loaded.revision);
  assert.equal(f.service.getCachedSummaryState().repositories[0].revision, refreshed.repositories[0].revision);
});

test('restoring a cached Repo does not issue another native status call', async (t) => {
  const f = await fixture(); t.after(() => f.service.dispose());
  await f.service.handleAction(f.id, { type: 'open', repoId: f.id });
  f.service.setActivePanelRepository(undefined);
  f.service.setActivePanelRepository(f.id, false);
  const counts = JSON.stringify(f.counts);
  await f.service.handleAction(f.id, { type: 'open', repoId: f.id, refresh: false });
  assert.equal(JSON.stringify(f.counts), counts);
});

test('a delayed read retains its captured revision and cannot replace a newer summary', async (t) => {
  const f = await fixture(); t.after(() => f.service.dispose());
  const snapshot = await f.service.handleAction(f.id, { type: 'open', repoId: f.id });
  f.service.cachedSummaries = [{ ...f.service.cachedSummaries[0], branch: 'newer-branch' }];
  f.service.revisionByRepository.set(f.id, snapshot.revision + 1);
  f.service.handleActionInternal = async () => ({ ...snapshot, branch: 'obsolete-branch' });
  const result = await f.service.handleAction(f.id, { type: 'history', skip: 0 });
  assert.equal(result.revision, snapshot.revision, 'completion does not claim the newer revision');
  assert.equal(f.service.cachedSummaries[0].branch, 'newer-branch');
});

test('recreated native repository wrappers invalidate caches without automatically updating the view', async (t) => {
  const f = await fixture(); t.after(() => f.service.dispose());
  Object.defineProperty(f.service.api, 'repositories', { get: () => [{ ...f.repository, state: { ...f.repository.state } }] });
  await f.service.handleAction(f.id, { type: 'open', repoId: f.id });
  assert.equal(f.service.getCachedSummaryState().repositories[0].headCommit, head);
  const before = JSON.stringify(f.counts);
  for (let i = 0; i < 100; i++) f.emit();
  await f.clock.advance(1000);
  assert.equal(JSON.stringify(f.counts), before, 'unchanged native events do not read Git again');
  f.repository.state.HEAD.commit = 'f'.repeat(40);
  f.repository.state.workingTreeChanges = [];
  f.emit(); await f.clock.advance(1000);
  assert.equal(JSON.stringify(f.counts), before, 'changed native events do not read Git either');
  assert.equal(f.service.getCachedSummaryState().repositories[0].headCommit, head);
  const summary = await f.service.getSummaryState();
  assert.equal(summary.repositories[0].headCommit, 'f'.repeat(40));
  assert.equal(summary.repositories[0].unstagedCount, 0);
  assert.equal(f.counts.status, 1, 'an explicit summary read consumes native state without requesting status');
});

test('collapsed repository lists omit details and concurrent expansion shares cached native reads', async (t) => {
  const f = await fixture(); t.after(() => f.service.dispose());
  const state = await f.service.getSummaryState();
  assert.equal(f.counts.branches, 0);
  assert.deepEqual(f.counts.commands.map(args => args[0]), ['symbolic-ref']);
  for (const field of ['branches', 'stashes', 'recoveryRefs']) assert.equal(Object.hasOwn(state.repositories[0], field), false);
  let validations = 0;
  f.service.requireRepository = async () => { validations++; return f.repository; };
  const [first, second] = await Promise.all([f.service.getRepositoryDetails(f.id), f.service.getRepositoryDetails(f.id)]);
  assert.deepEqual(first, second);
  assert.equal(f.counts.branches, 1);
  assert.equal(f.counts.commands.length, 4);
  assert.equal(validations, 1, 'concurrent consumers share repository identity validation too');
  const reads = f.counts.commands.length;
  f.service.bump(f.id); // Selection changes revise snapshots without changing repository data.
  const cached = await f.service.getRepositoryDetails(f.id);
  assert.equal(cached.revision, (await f.service.getSummaryState()).repositories[0].revision);
  assert.equal(f.counts.commands.length, reads);
  assert.equal(f.counts.branches, 1);
  assert.equal(validations, 1, 'an unchanged cached expansion does not spawn another identity probe');
  await f.service.handleAction(f.id, { type: 'open', repoId: f.id, refresh: false });
  assert.equal(f.counts.branches, 1, 'the selected workbench shares the sidebar detail cache');
});

test('detail invalidation reloads only the changed repository and advances its summary revision', async (t) => {
  const f = await fixture(); t.after(() => f.service.dispose());
  const other = { ...f.repository, rootUri: { fsPath: path.join(f.repository.rootUri.fsPath, 'test') } };
  f.api.repositories.push(other);
  f.service.publishRepositories();
  f.service.requireRepository = async (id: string) => f.service.findRepository(id);
  const otherId = f.service.repositoryId(other.rootUri.fsPath);
  await f.service.getSummaryState();
  await f.service.getRepositoryDetails(f.id); await f.service.getRepositoryDetails(otherId);
  const branches = f.counts.branches, commands = f.counts.commands.length;
  f.service.invalidateRepository(f.id); f.service.bump(f.id); f.service.publishRepositoryState(f.id);
  const changed = await f.service.getSummaryState();
  assert.equal(changed.repositories.find((repo: { id: string }) => repo.id === f.id).revision, 1);
  await f.service.getRepositoryDetails(otherId);
  assert.equal(f.counts.branches, branches);
  assert.equal(f.counts.commands.length, commands + 1, 'only the changed lightweight summary reads symbolic HEAD');
  await f.service.getRepositoryDetails(f.id);
  assert.equal(f.counts.branches, branches + 1);
  assert.equal(f.counts.commands.length, commands + 4);
});

test('explicit expansion after passive invalidation publishes a matching summary without another Git read', async t => {
  const f = await fixture(); t.after(() => f.service.dispose());
  f.service.getCachedSummaryState();
  const first = await f.service.getRepositoryDetails(f.id);
  const initial = f.service.getCachedSummaryState().repositories[0];
  assert.equal(initial.revision, first.revision);
  assert.equal(initial.branch, 'main', 'an explicit read replaces the initial native projection even at the same revision');
  const before = JSON.stringify(f.counts);
  f.repository.state.HEAD.commit = 'f'.repeat(40);
  f.repository.state.workingTreeChanges = [];
  f.emit();
  const stale = f.service.getCachedSummaryState().repositories[0];
  assert.equal(stale.revision, initial.revision, 'passive invalidation does not expose an unread revision');
  assert.equal(stale.headCommit, initial.headCommit);
  assert.equal(JSON.stringify(f.counts), before);

  const details = await f.service.getRepositoryDetails(f.id);
  const afterExpansion = JSON.stringify(f.counts);
  const summary = f.service.getCachedSummaryState().repositories[0];
  assert.equal(summary.revision, details.revision, 'the sidebar can accept the detail response using its cache-only state update');
  assert.ok(summary.revision > initial.revision);
  assert.equal(summary.headCommit, 'f'.repeat(40));
  assert.equal(summary.unstagedCount, 0);
  assert.equal(JSON.stringify(f.counts), afterExpansion, 'publishing the refreshed summary issues no further read');
  f.emit();
  const invalidatedAgain = f.service.getCachedSummaryState().repositories[0];
  assert.equal(invalidatedAgain.revision, summary.revision, 'later invalidation retains the last presented explicit result');
  assert.equal(invalidatedAgain.headCommit, summary.headCommit);
  assert.equal(JSON.stringify(f.counts), afterExpansion);
});

test('stale and closed repository detail requests cannot populate the cache or start queued reads', async (t) => {
  const f = await fixture(); t.after(() => f.service.dispose());
  await f.service.getSummaryState();
  let release!: () => void, entered!: () => void;
  const acquired = new Promise<void>(resolve => { entered = resolve; });
  const getBranches = f.repository.getBranches;
  f.repository.getBranches = async () => { entered(); await new Promise<void>(resolve => { release = resolve; }); return getBranches(); };
  const stale = f.service.getRepositoryDetails(f.id);
  await acquired;
  f.service.invalidateRepository(f.id); f.service.bump(f.id);
  release();
  await assert.rejects(stale, /Repo 狀態已變更/);
  assert.equal(f.service.detailsCache.has(f.id), false);
  f.repository.getBranches = getBranches;
  await f.service.getRepositoryDetails(f.id);
  assert.equal(f.service.detailsCache.has(f.id), true);

  let unlock!: () => void, locked!: () => void;
  const held = withGitDirectoryLock(f.repository.rootUri.fsPath, () => new Promise<void>(resolve => { unlock = resolve; locked(); }));
  await new Promise<void>(resolve => { locked = resolve; });
  f.service.invalidateRepository(f.id);
  const closed = f.service.getRepositoryDetails(f.id);
  await flush();
  const commands = f.counts.commands.length;
  f.api.repositories.length = 0;
  unlock(); await held;
  await assert.rejects(closed, /Repo 狀態已變更/);
  assert.equal(f.counts.commands.length, commands);
});

test('failed detail reads remain retryable instead of caching an empty stash list', async (t) => {
  const f = await fixture(); t.after(() => f.service.dispose());
  const runGit = f.service.runGit;
  f.service.runGit = async (repo: unknown, args: string[]) => {
    if (args[0] === 'stash') throw new Error('stash read failed');
    return runGit(repo, args);
  };
  await assert.rejects(f.service.getRepositoryDetails(f.id), /stash read failed/);
  assert.equal(f.service.detailsCache.has(f.id), false);
  f.service.runGit = runGit;
  assert.equal((await f.service.getRepositoryDetails(f.id)).branches.length, 1);
});
