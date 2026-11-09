import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, symlink, writeFile, lstat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { CodexTaskStore } from '../../src/codex/taskStore';
import { CodexBridge } from '../../src/codex/bridge';
import { CodexTaskScheduler } from '../../src/codex/scheduler';
import { ProjectWikiStore } from '../../src/codex/projectWiki';
import { startManagedWorktree } from '../../src/codex/projectWorkflows';
import { removeOwnedStorage } from '../../src/storage/ownedStorage';
import { cleanupLegacyLogs } from '../../src/storage/legacyLogs';
import { acquireStorageControl } from '../../src/storage/controlLease';
import { LEASE_SCHEMA } from '../../src/api/localNetworkLease';
import type { CodexTaskRecord } from '../../src/codex/protocol';

const git = (root: string, ...args: string[]) => execFileSync('git', ['-C', root, '-c', 'core.hooksPath=', '-c', 'user.name=Cleanup Test', '-c', 'user.email=cleanup@test.invalid', ...args], { encoding: 'utf8', windowsHide: true });
async function fixture(t: test.TestContext) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'glw-storage-cleanup-')));
  t.after(async () => { assert.equal(path.dirname(root).toLowerCase(), (await realpath(os.tmpdir())).toLowerCase()); await rm(root, { recursive: true, force: true }); });
  const storage = path.join(root, 'storage'), project = path.join(root, 'project'), id = 'a'.repeat(32);
  await mkdir(storage); await mkdir(project); await writeFile(path.join(project, 'keep.txt'), 'User work');
  const record: CodexTaskRecord = { schema: 'GitLabWorkspaceCodexTask/v2', id: 'conversation', root: project, title: 'test',
    createdAt: '2026-01-01', updatedAt: '2026-01-01', ownerPid: process.pid, status: 'paused',
    spec: { root: project, executionRoot: project, workspaceKey: project, writableRoots: [project], environmentKey: 'test', title: 'test', prompt: 'PRIVATE INPUT',
      source: { kind: 'issue', projectId: 1, issueIid: 1 }, skill: { name: 'test', path: path.join(project, 'SKILL.md') },
      origin: { kind: 'issue', accountKey: 'test', baseUrl: 'https://gitlab.test', projectId: 1, projectPath: 'team/project', webUrl: 'https://gitlab.test/team/project',
        repositoryRoot: project, iid: 1, sourceBranch: 'main', sourceSha: 'a'.repeat(40), branch: 'issue/1-fix' },
      workflow: { id, remote: 'origin', runtimeRoot: path.join(storage, 'codex-workflows', id) } } };
  return { root, storage, project, id, record, store: new CodexTaskStore(path.join(storage, 'codex-tasks')) };
}
test('deletion removes owned workflow data and v1 backups while retaining project files and minimal markers', async t => {
  const f = await fixture(t), runtime = f.record.spec.workflow!.runtimeRoot;
  await mkdir(runtime, { recursive: true }); await writeFile(path.join(runtime, 'source.zip'), 'snapshot');
  await mkdir(path.join(f.storage, 'project-wiki-drafts')); await writeFile(path.join(f.storage, 'project-wiki-drafts', f.id + '.json'), JSON.stringify({ schema: 'GitLabWorkspaceProjectWiki/v1', id: f.id, pages: [] }));
  f.record.schema = 'GitLabWorkspaceCodexTask/v1'; await f.store.save(f.record);
  f.record.schema = 'GitLabWorkspaceCodexTask/v2'; await f.store.save(f.record);
  await writeFile(path.join(f.store.directory, 'conversation.json.aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa.tmp'), 'stale private input');
  await f.store.remove(f.record.id);
  await assert.rejects(lstat(runtime), { code: 'ENOENT' });
  await assert.rejects(lstat(path.join(f.storage, 'project-wiki-drafts', f.id + '.json')), { code: 'ENOENT' });
  assert.deepEqual(await readdir(f.store.directory), ['conversation.deleted.json']);
  await writeFile(path.join(f.store.directory, 'conversation.json.aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa.tmp'), 'late stale private input');
  await f.store.retryCleanup(); assert.deepEqual(await readdir(f.store.directory), ['conversation.deleted.json']);
  assert.equal(await readFile(path.join(f.project, 'keep.txt'), 'utf8'), 'User work');
  await assert.rejects(f.store.save(f.record), /已刪除/);
});
test('a failed cleanup fences writers, persists no prompt in its journal and resumes after reopening', async t => {
  const f = await fixture(t), runtime = f.record.spec.workflow!.runtimeRoot;
  await mkdir(runtime, { recursive: true }); await writeFile(path.join(runtime, 'result.md'), 'discard');
  const failing = new CodexTaskStore(f.store.directory, async () => { throw new Error('file busy'); }); await failing.save(f.record);
  await assert.rejects(failing.remove(f.record.id), /file busy/);
  const journal = await readFile(path.join(f.store.directory, 'conversation.cleanup.json'), 'utf8'); assert.ok(!journal.includes('PRIVATE INPUT'));
  await assert.rejects(f.store.save(f.record), /已刪除/);
  await f.store.retryCleanup(); assert.deepEqual(await f.store.load(), []); assert.deepEqual(f.store.problems, []);
  await assert.rejects(lstat(runtime), { code: 'ENOENT' });
});
test('a host exit during deletion recovers the owned control gate and finishes the durable journal', async t => {
  const f = await fixture(t), runtime = f.record.spec.workflow!.runtimeRoot;
  await mkdir(runtime, { recursive: true }); await writeFile(path.join(runtime, 'result.md'), 'discard');
  const program = `const {CodexTaskStore} = require(${JSON.stringify(path.resolve(__dirname, '../../src/codex/taskStore'))});
    (async () => { const store = new CodexTaskStore(process.argv[1], async () => process.exit(0));
      await store.save(JSON.parse(process.argv[2])); await store.remove('conversation'); })().catch(() => process.exit(2));`;
  execFileSync(process.execPath, ['-e', program, f.store.directory, JSON.stringify(f.record)], { windowsHide: true });
  assert.ok(await lstat(path.join(f.store.directory, 'conversation.control')));
  await f.store.retryCleanup(); assert.deepEqual(await f.store.load(), []); assert.deepEqual(f.store.problems, []);
  await assert.rejects(lstat(runtime), { code: 'ENOENT' }); await assert.rejects(lstat(path.join(f.store.directory, 'conversation.control')), { code: 'ENOENT' });
});
test('cleanup refuses redirected parents and nested junctions without touching their targets', async t => {
  const f = await fixture(t), owned = path.join(f.storage, 'owned'); await mkdir(owned);
  await symlink(f.project, path.join(owned, 'redirect'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(removeOwnedStorage(f.storage, owned), /重新導向/);
  await assert.rejects(removeOwnedStorage(f.storage, f.project), /超出/);
  assert.equal(await readFile(path.join(f.project, 'keep.txt'), 'utf8'), 'User work');
});
test('confirmed dialogue deletion discards only its verified dirty worktree and retains its branch and original tree', async t => {
  const f = await fixture(t); git(f.project, 'init', '-q', '--initial-branch=main'); git(f.project, 'add', '.'); git(f.project, 'commit', '-qm', 'baseline');
  const sha = git(f.project, 'rev-parse', 'HEAD').trim(), workflow = f.record.spec.workflow!;
  f.record.spec.origin!.sourceSha = sha;
  workflow.worktree = { path: path.join(workflow.runtimeRoot, 'worktree'), repository: f.project, branch: 'issue/1-fix', sourceSha: sha };
  f.record.spec.executionRoot = workflow.worktree.path;
  await startManagedWorktree(f.record.spec); await writeFile(path.join(workflow.worktree.path, 'unsaved.txt'), 'discard on explicit delete');
  await f.store.save(f.record); await f.store.remove(f.record.id);
  assert.ok(!git(f.project, 'worktree', 'list', '--porcelain').includes(workflow.worktree.path));
  assert.equal(git(f.project, 'rev-parse', 'refs/heads/issue/1-fix').trim(), sha);
  assert.equal(await readFile(path.join(f.project, 'keep.txt'), 'utf8'), 'User work');
});
test('a copied Wiki seed survives deletion of its source and late previews cannot recreate the old draft', async t => {
  const f = await fixture(t), wiki = new ProjectWikiStore(path.join(f.storage, 'project-wiki-drafts'));
  const origin = { ...f.record.spec.origin!, kind: 'project-wiki' as const }, source = path.join(f.storage, 'source');
  await mkdir(path.join(source, 'wiki'), { recursive: true }); await writeFile(path.join(source, 'wiki', 'index.md'), 'Saved Wiki');
  await wiki.create(f.id, origin, source);
  const next = path.join(f.storage, 'codex-workflows', 'b'.repeat(32)); await wiki.copySeed(f.id, origin, f.storage, next);
  await wiki.remove(f.id); await assert.rejects(wiki.create(f.id, origin, source), /已刪除/);
  const target = path.join(next, 'source'); await mkdir(path.join(target, 'wiki'), { recursive: true });
  const plan = await wiki.seedIncremental(f.id, origin, target, [], true, path.join(next, 'wiki-seed.json')); assert.ok(plan);
});
test('only recognized legacy log records are removed', async t => {
  const f = await fixture(t), logs = path.join(f.storage, 'logs'); await mkdir(logs);
  const old = path.join(logs, '1791883431569-50ecade6-0e39-43c2-be2d-9954dfd7c84c.jsonl');
  await writeFile(old, JSON.stringify({ id: 'one', timestamp: '2026-01-01', operationId: 'operation', feature: 'workspace', action: 'activate', level: 'info', result: 'success' }) + '\n');
  await writeFile(path.join(logs, 'user-notes.jsonl'), 'retain');
  assert.equal(await cleanupLegacyLogs(f.storage), true); await assert.rejects(lstat(old), { code: 'ENOENT' });
  assert.equal(await readFile(path.join(logs, 'user-notes.jsonl'), 'utf8'), 'retain');
});
test('a crashed Wiki publication blocks dialogue deletion before any journal or content is removed', async t => {
  const f = await fixture(t), source = path.join(f.record.spec.workflow!.runtimeRoot, 'source');
  f.record.spec.source = { kind: 'project-wiki', projectId: 1 }; f.record.spec.origin!.kind = 'project-wiki'; f.record.spec.executionRoot = path.join(source, 'wiki');
  await mkdir(f.record.spec.executionRoot, { recursive: true }); await writeFile(path.join(f.record.spec.executionRoot, 'index.md'), 'Saved Wiki');
  const wiki = new ProjectWikiStore(path.join(f.storage, 'project-wiki-drafts')); await wiki.create(f.id, f.record.spec.origin!, source);
  const file = path.join(f.storage, 'project-wiki-drafts', f.id + '.json'), draft = JSON.parse(await readFile(file, 'utf8'));
  draft.pages[0].sending = true; await writeFile(file, JSON.stringify(draft)); await f.store.save(f.record);
  const bridge = new CodexBridge({ storage: f.storage, version: 'test', executable: () => '', trusted: () => true,
    prepare: async () => f.record.spec, event: () => {}, openUrl: async () => {}, scheduler: new CodexTaskScheduler('cleanup-test', f.root) });
  t.after(() => bridge.shutdown());
  await assert.rejects(bridge.delete(f.record.id), /發布結果仍待核對/);
  assert.equal((await f.store.load()).length, 1); assert.equal(await f.store.isDeleted(f.record.id), false);
  assert.equal(JSON.parse(await readFile(file, 'utf8')).pages[0].sending, true);
});
test('a known crashed JS control gate can recover without reclaiming quarantined resource owners', async t => {
  const f = await fixture(t), directory = path.join(f.storage, 'test.control'); await mkdir(directory);
  await writeFile(path.join(directory, 'owner.json'), JSON.stringify({ schema: LEASE_SCHEMA, nonce: 'a'.repeat(36), pid: 2147483647, kind: 'test-control', state: 'reserved', childPid: null }));
  const lease = await acquireStorageControl(directory, 'test-control'); await lease.release();
  await assert.rejects(lstat(directory), { code: 'ENOENT' });
});
