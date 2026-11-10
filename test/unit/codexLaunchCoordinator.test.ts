import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, rm, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { CodexLaunchCoordinator, launchRepositoryId, type CodexLaunchOptions } from '../../src/codex/launchCoordinator';
import type { CodexLaunchDraft, CodexTaskSpec } from '../../src/codex/protocol';
import { prepareFreeTask } from '../../src/codex/freeTask';

async function fixture(t: test.TestContext) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'glw-launch-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const repository = path.join(directory, 'repository'), repositoryId = launchRepositoryId(repository);
  const events: Array<CodexLaunchDraft | undefined> = [], queued: CodexTaskSpec[] = [], tasks = new Set<string>();
  let scope = 'account-one:workspace', available = true, preparations = 0;
  const options: CodexLaunchOptions = {
    directory, scope: () => scope, publish: draft => events.push(structuredClone(draft)),
    inspect: async () => ({ title: 'Issue #2 · Fix', repositories: available ? [{ id: repositoryId, name: 'project', path: repository }] : [] }),
    prepare: async source => {
      preparations++;
      return { source, title: 'Issue #2 · Fix', root: directory, writableRoots: [repository], workspaceKey: 'workspace',
        environmentKey: 'environment', prompt: 'Implement and test', executionRoot: repository };
    },
    environment: async () => {},
    models: async () => [{ id: 'model-one', label: 'One', efforts: ['low', 'high'], defaultEffort: 'high' }],
    enqueue: async (spec, id) => { queued.push(spec); tasks.add(id); return id; }, taskExists: async id => tasks.has(id)
  };
  const launch = new CodexLaunchCoordinator(options); t.after(() => launch.dispose());
  return { launch, options, events, tasks, queued, directory, repositoryId, repository,
    preparations: () => preparations, unavailable: () => { available = false; }, available: () => { available = true; }, scope: (value: string) => { scope = value; } };
}

test('opening a source persists preparation before I/O and model changes do not repeat complete preparation', async t => {
  const f = await fixture(t), draft = await f.launch.create({ kind: 'issue', projectId: 1, issueIid: 2 });
  assert.equal(draft.isolated, true); assert.equal(draft.state, 'editing'); assert.equal(f.preparations(), 0); assert.equal(f.queued.length, 0);
  const ready = await f.launch.check(draft.id, draft.revision);
  assert.equal(ready.state, 'ready'); assert.equal(f.preparations(), 1);
  const selected = await f.launch.update(draft.id, ready.revision, { model: 'model-one', effort: 'high' });
  assert.equal(selected.state, 'ready'); assert.equal(f.preparations(), 1);
  const ids = await Promise.all(Array.from({ length: 100 }, () => f.launch.submit(draft.id, selected.revision)));
  assert.equal(new Set(ids).size, 1); assert.equal(ids[0], draft.id); assert.equal(f.queued.length, 1);
  assert.equal(f.queued[0].model, 'model-one'); assert.equal(f.queued[0].effort, 'high');
  assert.equal(f.queued[0].source.kind === 'issue' && f.queued[0].source.isolated, true);
  assert.equal(await f.launch.submit(draft.id), draft.id);
});

test('repairing a missing repository resumes the same draft with its requirement and selected worktree mode', async t => {
  const f = await fixture(t); f.unavailable();
  const opened = await f.launch.create({ kind: 'issue', projectId: 1, issueIid: 2 });
  const blocked = await f.launch.check(opened.id, opened.revision, { requirement: 'Add regression tests', isolated: false });
  assert.equal(blocked.state, 'blocked'); assert.equal(blocked.checks.find(item => item.state === 'blocked')?.repair, 'scan');
  assert.equal(f.preparations(), 0); f.available();
  const restored = new CodexLaunchCoordinator(f.options); t.after(() => restored.dispose());
  const resumed = await restored.show(opened.id);
  assert.equal(resumed.requirement, 'Add regression tests'); assert.equal(resumed.isolated, false);
  const ready = await restored.check(opened.id, resumed.revision);
  assert.equal(ready.state, 'ready'); await restored.submit(opened.id, ready.revision);
  assert.equal(f.queued[0].source.requirement, 'Add regression tests'); assert.equal(f.queued[0].source.repository, f.repository);
  assert.equal(f.queued[0].source.kind === 'issue' && f.queued[0].source.isolated, false);
});

test('draft identities and preferences stay within their account, project and workspace scope', async t => {
  const f = await fixture(t);
  const first = await f.launch.create({ kind: 'issue', projectId: 1, issueIid: 2 });
  const second = await f.launch.create({ kind: 'issue', projectId: 1, issueIid: 3 });
  assert.notEqual(second.id, first.id);
  assert.equal((await f.launch.create({ kind: 'issue', projectId: 1, issueIid: 2 })).id, first.id, 'older unfinished source drafts are recoverable');
  f.scope('account-two:workspace');
  await assert.rejects(f.launch.show(first.id), /帳號或工作區/);
  assert.equal(await f.launch.latest(), undefined);
  const other = await f.launch.create({ kind: 'issue', projectId: 1, issueIid: 2 });
  assert.notEqual(other.id, first.id);
  f.scope('account-one:workspace'); assert.equal((await f.launch.show(first.id)).id, first.id);
});

test('cancel during preparation aborts checks and cannot publish a stale ready state or dispatch work', async t => {
  const f = await fixture(t);
  let entered!: () => void, release!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
  f.options.prepare = async (source, signal) => {
    entered(); await gate; signal.throwIfAborted();
    return { source, title: 'unused', root: f.directory, writableRoots: [], workspaceKey: '', environmentKey: '', prompt: '' };
  };
  const opened = await f.launch.create({ kind: 'issue', projectId: 1, issueIid: 2 });
  const pending = f.launch.check(opened.id, opened.revision); await started;
  const cancelled = await f.launch.cancel(opened.id); release(); await pending;
  assert.equal(cancelled.state, 'editing'); assert.equal((await f.launch.show(opened.id)).state, 'editing'); assert.equal(f.queued.length, 0);
  assert.equal(f.events.at(-1)?.state, 'editing');
});

test('stale edits and foreign repository ids fail closed without losing the saved requirement', async t => {
  const f = await fixture(t), opened = await f.launch.create({ kind: 'issue', projectId: 1, issueIid: 2 });
  const edited = await f.launch.update(opened.id, opened.revision, { requirement: 'Latest requirement' });
  await assert.rejects(f.launch.update(opened.id, opened.revision, { requirement: 'Stale overwrite' }), /已更新/);
  assert.equal((await f.launch.show(opened.id)).requirement, 'Latest requirement');
  const blocked = await f.launch.check(opened.id, edited.revision, { repositoryId: 'foreign-path' });
  assert.notEqual(blocked.repositoryId, 'foreign-path', 'only Host-discovered repository identities survive inspection');
  assert.equal(f.queued.length, 0);
});

test('an ambiguous enqueue is persisted, never resent, and resumes only after a task receipt exists', async t => {
  const f = await fixture(t); let attempts = 0;
  f.options.enqueue = async () => { attempts++; throw new Error('storage acknowledgement lost'); };
  const opened = await f.launch.create({ kind: 'issue', projectId: 1, issueIid: 2 }), ready = await f.launch.check(opened.id, opened.revision);
  await assert.rejects(f.launch.submit(opened.id, ready.revision), /acknowledgement lost/);
  assert.equal((await f.launch.show(opened.id)).state, 'uncertain');
  await assert.rejects(f.launch.submit(opened.id), /待核對/); assert.equal(attempts, 1);
  f.tasks.add(opened.id); const reconciled = await f.launch.show(opened.id);
  assert.equal(reconciled.state, 'submitted'); assert.equal(reconciled.taskId, opened.id);
});

test('recreated ready drafts require fresh inspection and unavailable models cannot silently change execution', async t => {
  const f = await fixture(t), opened = await f.launch.create({ kind: 'issue', projectId: 1, issueIid: 2 });
  const ready = await f.launch.check(opened.id, opened.revision);
  const changed = await f.launch.update(opened.id, ready.revision, { model: 'removed-model', effort: 'high' });
  await assert.rejects(f.launch.submit(opened.id, changed.revision), /模型已不可用/); assert.equal(f.queued.length, 0);
  const restored = new CodexLaunchCoordinator(f.options); t.after(() => restored.dispose());
  assert.equal((await restored.show(opened.id)).state, 'blocked');
  const saved = JSON.parse(await readFile(path.join(f.directory, opened.id + '.json'), 'utf8'));
  assert.equal(saved.schema, 'GitLabWorkspaceCodexLaunch/v1'); assert.equal(saved.model, 'removed-model'); assert.equal(saved.spec, undefined);
});

test('MR discussion selection is performed in the draft, preserved through checking, and rejects foreign discussions', async t => {
  const f = await fixture(t);
  f.options.inspect = async () => ({ repositories: [{ id: f.repositoryId, name: 'project', path: f.repository }],
    discussions: [{ id: 'one', summary: 'Fix handling', selected: false }, { id: 'two', summary: 'Add tests', selected: false }] });
  const opened = await f.launch.create({ kind: 'merge-request', projectId: 1, iid: 2, intent: 'fix-comments' });
  const first = await f.launch.check(opened.id, opened.revision);
  await assert.rejects(f.launch.update(opened.id, first.revision, { discussionIds: ['foreign'] }), /討論/);
  const ready = await f.launch.check(opened.id, first.revision, { discussionIds: ['one'] });
  assert.equal(ready.state, 'ready'); await f.launch.submit(opened.id, ready.revision);
  assert.deepEqual(f.queued[0].source.kind === 'merge-request' && f.queued[0].source.discussionIds, ['one']);
});

test('cross-window progress uses compare-and-swap and cannot replace a newer draft', async t => {
  const f = await fixture(t), second = new CodexLaunchCoordinator(f.options); t.after(() => second.dispose());
  let entered!: () => void, release!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
  const prepare = f.options.prepare;
  f.options.prepare = async (source, signal) => { entered(); await gate; return prepare(source, signal); };
  const opened = await f.launch.create({ kind: 'issue', projectId: 1, issueIid: 2 }), pending = f.launch.check(opened.id, opened.revision);
  await started;
  const external = await second.show(opened.id); assert.equal(external.state, 'checking', 'a live external check is not reset by viewing');
  const edited = await second.update(opened.id, external.revision, { requirement: 'Other window latest requirement' });
  release(); await pending;
  const current = await second.show(opened.id);
  assert.equal(current.revision, edited.revision); assert.equal(current.requirement, 'Other window latest requirement'); assert.equal(current.state, 'editing');
});

test('stale updates cannot abort a valid check and disposing a live owner does not leave checking forever', async t => {
  const f = await fixture(t);
  let entered!: () => void, release!: () => void, currentSignal: AbortSignal | undefined;
  const started = new Promise<void>(resolve => { entered = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
  const prepare = f.options.prepare;
  f.options.prepare = async (source, signal) => { currentSignal = signal; entered(); await gate; signal.throwIfAborted(); return prepare(source, signal); };
  const opened = await f.launch.create({ kind: 'issue', projectId: 1, issueIid: 2 }), pending = f.launch.check(opened.id, opened.revision);
  await started;
  await assert.rejects(f.launch.update(opened.id, opened.revision, { requirement: 'Stale' }), /已更新/);
  assert.equal(currentSignal?.aborted, false);
  f.launch.dispose(); release(); await pending;
  const restored = new CodexLaunchCoordinator(f.options); t.after(() => restored.dispose());
  const current = await restored.show(opened.id); assert.equal(current.state, 'editing'); assert.equal(current.checkOwner, undefined);
});

test('a free task keeps explicit context identity and its selected execution key survives admission preparation', async t => {
  const f = await fixture(t); await mkdir(f.repository);
  f.options.prepare = async source => {
    if (source.kind !== 'free') throw new Error('Expected free task');
    return prepareFreeTask(source, [f.repository]);
  };
  const empty = await f.launch.create();
  const contextual = await f.launch.create({ kind: 'free', repository: f.repository, prompt: 'Change behavior', contexts: [] });
  assert.notEqual(contextual.id, empty.id);
  const ready = await f.launch.check(contextual.id, contextual.revision);
  const selected = await f.launch.update(contextual.id, ready.revision, { model: 'model-one', effort: 'low' });
  await f.launch.submit(contextual.id, selected.revision);
  const frozen = f.queued[0], rechecked = await f.options.prepare(frozen.source, new AbortController().signal);
  assert.equal(frozen.environmentKey, rechecked.environmentKey);
  await assert.rejects(f.launch.cancel(contextual.id), /已送出/);
});

test('fixing an unavailable model reuses valid preflight data and unblocks submission', async t => {
  const f = await fixture(t), opened = await f.launch.create({ kind: 'issue', projectId: 1, issueIid: 2 });
  const blocked = await f.launch.check(opened.id, opened.revision, { model: 'old-model', effort: 'high' });
  assert.equal(blocked.state, 'blocked'); assert.equal(f.preparations(), 1);
  const repaired = await f.launch.update(opened.id, blocked.revision, { model: 'model-one', effort: 'high' });
  assert.equal(repaired.state, 'ready'); assert.equal(f.preparations(), 1);
  await f.launch.submit(opened.id, repaired.revision); assert.equal(f.queued[0].model, 'model-one');
});

test('recovering an acknowledged admission alias selects the existing task instead of resending', async t => {
  const f = await fixture(t), alias = 'existing-task'; let dispatches = 0;
  f.tasks.add(alias); f.options.enqueue = async () => { dispatches++; return alias; };
  const opened = await f.launch.create({ kind: 'issue', projectId: 1, issueIid: 2 }), ready = await f.launch.check(opened.id, opened.revision);
  assert.equal(await f.launch.submit(opened.id, ready.revision), alias);
  const file = path.join(f.directory, opened.id + '.json'), saved = JSON.parse(await readFile(file, 'utf8'));
  saved.state = 'uncertain'; await writeFile(file, JSON.stringify(saved));
  const restored = new CodexLaunchCoordinator(f.options); t.after(() => restored.dispose());
  const reconciled = await restored.show(opened.id);
  assert.equal(reconciled.state, 'submitted'); assert.equal(reconciled.taskId, alias);
  assert.equal(await restored.submit(opened.id), alias); assert.equal(dispatches, 1);
});

test('source revisions require acknowledgement, unchanged checks retain it and later changes revoke it', async t => {
  const f = await fixture(t), prepare = f.options.prepare;
  let sha = 'a'.repeat(40);
  f.options.prepare = async (source, signal) => ({ ...await prepare(source, signal), origin: { kind: 'issue', accountKey: 'account', baseUrl: 'https://gitlab.test',
    projectId: 1, projectPath: 'team/repo', repositoryRoot: f.repository, webUrl: 'https://gitlab.test/team/repo/-/issues/2', iid: 2, sourceBranch: 'main', sourceSha: sha, updatedAt: 'first' } });
  const opened = await f.launch.create({ kind: 'issue', projectId: 1, issueIid: 2, requirement: 'Keep the requirement' });
  let ready = await f.launch.check(opened.id, opened.revision); assert.equal(ready.sourceChange, undefined);
  sha = 'b'.repeat(40); ready = await f.launch.check(opened.id, ready.revision);
  const change = ready.sourceChange!; assert.equal(change.previous.sourceSha, 'a'.repeat(40)); assert.equal(change.current.sourceSha, sha);
  assert.equal(change.acknowledged, false); assert.equal(f.queued.length, 0);
  ready = await f.launch.check(opened.id, ready.revision); assert.equal(ready.sourceChange?.key, change.key);
  assert.equal(ready.sourceChange?.acknowledged, false);
  await assert.rejects(f.launch.submit(opened.id, ready.revision), /來源內容已變更/); assert.equal(f.queued.length, 0);
  await assert.rejects(f.launch.update(opened.id, ready.revision - 1, { acknowledgedSource: change.key }), /設定已更新/);
  ready = await f.launch.update(opened.id, ready.revision, { acknowledgedSource: change.key, requirement: 'Keep the latest edit' });
  ready = await f.launch.check(opened.id, ready.revision); assert.equal(ready.sourceChange?.acknowledged, true);
  ready = await f.launch.update(opened.id, ready.revision, { model: 'model-one', effort: 'low' });
  assert.equal(ready.sourceChange?.acknowledged, true, 'execution preferences are not source drift');
  sha = 'c'.repeat(40); ready = await f.launch.check(opened.id, ready.revision);
  assert.notEqual(ready.sourceChange?.key, change.key); assert.equal(ready.sourceChange?.acknowledged, false);
  await assert.rejects(f.launch.update(opened.id, ready.revision, { acknowledgedSource: change.key }), /來源版本已更新/);
  ready = await f.launch.update(opened.id, ready.revision, { acknowledgedSource: ready.sourceChange!.key });
  await f.launch.submit(opened.id, ready.revision); assert.equal(f.queued.length, 1); assert.equal(f.queued[0].source.requirement, 'Keep the latest edit');
  for (const value of [...f.events, ready, await f.launch.latest()]) if (value) { assert.equal('sourceDigest' in value, false); assert.equal('discussionDigest' in value, false); }
});

test('same-SHA Issue edits and selected discussion content changes remain visible source changes', async t => {
  const f = await fixture(t), prepare = f.options.prepare; let updatedAt = 'first', text = 'Original discussion';
  f.options.prepare = async (source, signal) => ({ ...await prepare(source, signal), origin: { kind: source.kind === 'issue' ? 'issue' : 'merge-request',
    accountKey: 'account', baseUrl: 'https://gitlab.test', projectId: 1, projectPath: 'team/repo', repositoryRoot: f.repository,
    webUrl: 'https://gitlab.test/team/repo', iid: 2, sourceBranch: 'main', sourceSha: 'a'.repeat(40), updatedAt },
    workflow: { id: 'workflow', runtimeRoot: f.directory, remote: 'origin', discussions: [{ id: 'discussion', noteIds: [1], text }] } });
  const opened = await f.launch.create({ kind: 'issue', projectId: 1, issueIid: 2 });
  let ready = await f.launch.check(opened.id, opened.revision); updatedAt = 'second'; ready = await f.launch.check(opened.id, ready.revision);
  assert.equal(ready.sourceChange?.previous.updatedAt, 'first'); assert.equal(ready.sourceChange?.current.updatedAt, 'second');
  assert.equal(ready.sourceChange?.previous.sourceSha, ready.sourceChange?.current.sourceSha);
  const mr = await f.launch.create({ kind: 'merge-request', projectId: 1, iid: 2, intent: 'fix-comments' });
  ready = await f.launch.check(mr.id, mr.revision); assert.equal(ready.sourceChange, undefined);
  text = 'Changed discussion beyond any UI preview'; ready = await f.launch.check(mr.id, ready.revision);
  assert.equal(ready.sourceChange?.discussionsChanged, true); assert.equal(ready.sourceChange?.acknowledged, false);
  assert.equal(JSON.stringify(ready).includes(text), false, 'raw discussion content is not put in the source summary');
});

test('repreparing forks a fresh draft from trusted source and never overwrites an unfinished draft or dispatches', async t => {
  const f = await fixture(t), prepare = f.options.prepare;
  let sha = 'a'.repeat(40);
  f.options.prepare = async (source, signal) => ({ ...await prepare(source, signal), origin: { kind: 'issue', accountKey: 'account', baseUrl: 'https://gitlab.test',
    projectId: 1, projectPath: 'team/repo', repositoryRoot: f.repository, webUrl: 'https://gitlab.test/team/repo', iid: 2, sourceBranch: 'main', sourceSha: sha } });
  const source = { kind: 'issue' as const, projectId: 1, issueIid: 2, requirement: 'Original task requirement', model: 'model-one', effort: 'low', isolated: false,
    returnTo: { mode: 'developer' as const } };
  const opened = await f.launch.create(source), ready = await f.launch.check(opened.id, opened.revision); await f.launch.submit(opened.id, ready.revision);
  const original = f.queued[0], unfinished = await f.launch.create({ ...source, requirement: 'Newer unfinished input' });
  const fork = await f.launch.create(original.source, Date.now(), original);
  assert.notEqual(fork.id, unfinished.id); assert.notEqual(fork.id, opened.id); assert.equal(fork.requirement, source.requirement);
  assert.equal(fork.model, source.model); assert.equal(fork.isolated, false); assert.deepEqual(fork.source.returnTo, source.returnTo);
  assert.equal((await f.launch.show(unfinished.id)).requirement, 'Newer unfinished input');
  sha = 'b'.repeat(40); const checked = await f.launch.check(fork.id, fork.revision);
  assert.equal(checked.sourceChange?.previous.sourceSha, 'a'.repeat(40)); assert.equal(checked.sourceChange?.current.sourceSha, sha);
  assert.equal(checked.sourceChange?.acknowledged, false); assert.equal(f.queued.length, 1); assert.equal(f.tasks.has(opened.id), true);
});

test('deleting a task removes its submitted launch record but preserves independent preparation and preferences', async t => {
  const f = await fixture(t), source = { kind: 'issue' as const, projectId: 1, issueIid: 2, requirement: 'Saved source requirement' };
  const opened = await f.launch.create(source), ready = await f.launch.check(opened.id, opened.revision);
  await f.launch.submit(opened.id, ready.revision);
  const separate = await f.launch.create({ ...source, requirement: 'Independent newer input' });
  await f.launch.removeSubmittedTask(opened.id);
  await assert.rejects(readFile(path.join(f.directory, opened.id + '.json')), /ENOENT/);
  assert.equal((await f.launch.show(separate.id)).requirement, 'Independent newer input');
  assert.equal(f.queued.length, 1);
  await f.launch.removeSubmittedTask(opened.id);
});
