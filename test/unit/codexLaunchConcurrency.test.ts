import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { CodexLaunchCoordinator, launchRepositoryId, type CodexLaunchOptions } from '../../src/codex/launchCoordinator';
import type { CodexTaskSpec } from '../../src/codex/protocol';

async function fixture(t: test.TestContext) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'codex-launch-windows-'));
  const repository = path.join(directory, 'repo'), queued: CodexTaskSpec[] = [], tasks = new Set<string>();
  let sha = 'a'.repeat(40), preparations = 0;
  const options: CodexLaunchOptions = {
    directory, scope: () => 'account:workspace', publish: () => {},
    inspect: async () => ({ repositories: [{ id: launchRepositoryId(repository), name: 'Repo', path: repository }] }),
    prepare: async source => {
      preparations++;
      return { source, title: 'Source ' + sha[0], root: repository, workspaceKey: 'workspace', prompt: 'Implement source ' + sha,
        environmentKey: 'environment-' + sha, writableRoots: [repository], origin: {
          kind: 'issue', accountKey: 'account', baseUrl: 'https://gitlab.test', projectId: 1, projectPath: 'team/repo',
          repositoryRoot: repository, webUrl: 'https://gitlab.test/team/repo/-/issues/2', iid: 2,
          sourceBranch: 'main', sourceSha: sha, branch: 'issue/2'
        } };
    },
    environment: async () => {}, models: async () => [{ id: 'model', label: 'Model', efforts: ['high'], defaultEffort: 'high' }],
    enqueue: async (spec, id) => { queued.push(spec); tasks.add(id); return id; }, taskExists: async id => tasks.has(id)
  };
  const first = new CodexLaunchCoordinator(options), second = new CodexLaunchCoordinator({ ...options });
  t.after(async () => { first.dispose(); second.dispose(); await rm(directory, { recursive: true, force: true }); });
  return { first, second, options, directory, queued, preparations: () => preparations, changeSource: () => { sha = 'b'.repeat(40); } };
}

test('a second window recheck invalidates the first windows prepared source snapshot', async t => {
  const f = await fixture(t), opened = await f.first.create({ kind: 'issue', projectId: 1, issueIid: 2 });
  const firstReady = await f.first.check(opened.id, opened.revision);
  assert.equal(firstReady.sourceSha, 'a'.repeat(40));
  f.changeSource();
  const refreshed = await f.second.check(opened.id, firstReady.revision);
  assert.equal(refreshed.sourceSha, 'b'.repeat(40));
  assert.equal(refreshed.sourceChange?.acknowledged, false);
  const confirmed = await f.second.update(opened.id, refreshed.revision, { acknowledgedSource: refreshed.sourceChange!.key });
  await f.first.submit(opened.id, confirmed.revision);
  assert.equal(f.queued.length, 1);
  assert.equal(f.queued[0].origin?.sourceSha, refreshed.sourceSha, 'the enqueued source must match the most recently checked source');
  assert.equal(f.preparations(), 3, 'the first window must recheck instead of reusing its obsolete preparation');
});

test('a delayed check in another window cannot overwrite a newer completed check', async t => {
  const f = await fixture(t), prepare = f.options.prepare;
  let entered!: () => void, release!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; }), held = new Promise<void>(resolve => { release = resolve; });
  f.options.prepare = async (source, signal) => { const spec = await prepare(source, signal); entered(); await held; return spec; };
  const opened = await f.first.create({ kind: 'issue', projectId: 1, issueIid: 2 });
  const pending = f.first.check(opened.id, opened.revision); await started;
  f.changeSource();
  const refreshed = await f.second.check(opened.id);
  assert.equal(refreshed.state, 'ready'); release(); await pending;
  const stored = JSON.parse(await readFile(path.join(f.directory, opened.id + '.json'), 'utf8'));
  assert.equal(stored.state, 'ready'); assert.equal(stored.sourceSha, 'b'.repeat(40)); assert.equal(stored.revision, refreshed.revision);
  assert.equal(f.queued.length, 0);
});
