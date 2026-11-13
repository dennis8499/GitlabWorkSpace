import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { chmod, lstat, mkdir, mkdtemp, open, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { CodexResultStore } from '../../src/codex/resultStore';
import { CODEX_RESULT_MAX_BYTES, safeResultPath, type CodexChangeInventory } from '../../src/codex/resultProtocol';
import type { CodexTaskRecord } from '../../src/codex/protocol';

function git(root: string, ...args: string[]): string {
  return execFileSync('git', ['-C', root, '-c', 'core.hooksPath=', '-c', 'user.name=Result Test', '-c', 'user.email=result@test.invalid',
    '-c', 'commit.gpgsign=false', ...args], { encoding: 'utf8', windowsHide: true,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_NO_LAZY_FETCH: '1', GIT_ALLOW_PROTOCOL: 'file' } }).trim();
}
async function fixture(t: test.TestContext, code = false) {
  const parent = await realpath(os.tmpdir()), root = await realpath(await mkdtemp(path.join(parent, 'glw-results-')));
  t.after(async () => {
    assert.equal(path.dirname(root).toLowerCase(), parent.toLowerCase());
    await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  });
  const storage = path.join(root, 'storage'), project = path.join(root, 'project'), runtime = path.join(storage, 'codex-workflows', 'a'.repeat(32));
  await mkdir(project); await mkdir(runtime, { recursive: true });
  const record: CodexTaskRecord = { schema: 'GitLabWorkspaceCodexTask/v3', id: 'task-one', title: 'Result task', root: project,
    status: 'paused', createdAt: '2026-11-13T01:00:00Z', updatedAt: '2026-11-13T02:00:00Z', ownerPid: process.pid, threadId: 'PRIVATE-THREAD',
    spec: { source: { kind: 'free', repository: project, prompt: 'PRIVATE PROMPT' }, root: project, executionRoot: project,
      title: 'Result task', prompt: 'PRIVATE PROMPT', workspaceKey: project, environmentKey: 'fixture', writableRoots: [project] },
    result: { state: 'ready', summary: 'Saved implementation and verification.', tests: [{ command: 'npm.cmd test', exitCode: 0 }] } };
  if (code) {
    git(project, 'init', '-q', '--initial-branch=main');
    git(project, 'config', 'core.autocrlf', 'false');
    await writeFile(path.join(project, 'text.txt'), 'base\n'); await writeFile(path.join(project, 'delete.txt'), 'delete me\n');
    await writeFile(path.join(project, 'binary.bin'), Buffer.from([0, 1, 254, 255])); await writeFile(path.join(project, 'mode.sh'), 'echo baseline\n');
    git(project, 'add', '.'); git(project, 'commit', '-qm', 'base');
    const sha = git(project, 'rev-parse', 'HEAD'), worktree = path.join(runtime, 'worktree');
    git(project, 'worktree', 'add', '-q', '-b', 'issue/1-work', worktree, sha);
    record.spec.source = { kind: 'issue', projectId: 1, issueIid: 1 };
    record.spec.executionRoot = worktree; record.spec.writableRoots = [worktree];
    record.spec.origin = { kind: 'issue', accountKey: 'PRIVATE ACCOUNT', baseUrl: 'https://user:PRIVATE@example.test', projectId: 1,
      projectPath: 'group/project', repositoryRoot: project, webUrl: 'https://user:PRIVATE@example.test/group/project?private_token=PRIVATE',
      iid: 1, sourceBranch: 'main', sourceSha: sha, branch: 'issue/1-work' };
    record.spec.workflow = { id: 'a'.repeat(32), runtimeRoot: runtime, remote: 'origin', worktree: { path: worktree, repository: project, branch: 'issue/1-work', sourceSha: sha } };
  }
  return { root, storage, project, runtime, record, store: new CodexResultStore(path.join(storage, 'codex-results')) };
}

test('sealing keeps immutable document results and fresh handoff without retaining prompts or sessions', async t => {
  const f = await fixture(t), documents = path.join(f.runtime, 'documents'); await mkdir(documents);
  await writeFile(path.join(documents, 'SPEC.md'), '# Specification\n'); await writeFile(path.join(documents, 'cards.md'), '# Cards\n');
  await writeFile(path.join(documents, 'sources.json'), JSON.stringify({ repositories: [{ id: 'source-one', sha: 'a'.repeat(40), evidence: [{ path: 'src/main.ts', claim: 'Verified source evidence' }] }] }));
  f.record.result!.files = ['SPEC.md', 'cards.md', 'sources.json'];
  Object.assign(f.record.spec, { groupAnalysis: { runtimeRoot: f.runtime, outputRoot: documents, repositories: [{ id: 'source-one', sha: 'a'.repeat(40), snapshotPath: path.join(f.runtime, 'source') }] } });
  const manifest = await f.store.seal(f.record, [{ id: 'private', kind: 'user', text: 'PRIVATE TRANSCRIPT' }], 'manual');
  const serialized = JSON.stringify(manifest);
  for (const privateText of ['PRIVATE PROMPT', 'PRIVATE-THREAD', 'PRIVATE TRANSCRIPT', f.runtime]) assert.equal(serialized.includes(privateText), false);
  assert.ok(manifest.artifacts.some(artifact => artifact.path === 'documents/SPEC.md'));
  assert.ok(manifest.artifacts.some(artifact => artifact.path === 'documents/sources.json'));
  assert.equal((await f.store.list()).length, 1);
  await rm(f.runtime, { recursive: true, force: true });
  const spec = manifest.artifacts.find(artifact => artifact.path === 'documents/SPEC.md')!;
  assert.equal((await f.store.readArtifact(manifest.id, spec.id)).bytes.toString(), '# Specification\n');
  assert.deepEqual(await f.store.seal(f.record, [], 'deleted'), manifest, 'retry reads the same sealed result after runtime cleanup');
  const destination = path.join(f.root, 'exported'); await f.store.exportTo(manifest.id, destination);
  assert.equal(await readFile(path.join(destination, spec.path), 'utf8'), '# Specification\n');
  await assert.rejects(f.store.exportTo(manifest.id, destination), /尚未存在/);
});

test('interrupted Group analysis retains every captured repository base before model documents exist', async t => {
  const f = await fixture(t), output = path.join(f.project, '_bmad-output', 'specs', 'not-started');
  f.record.spec.source = { kind: 'group-analysis', requirement: '跨專案新增授權驗證' };
  f.record.spec.groupAnalysis = { id: 'a'.repeat(32), groupRoot: f.project, runtimeRoot: f.runtime, outputRoot: output,
    repositories: [{ id: 'source-one', name: 'API', path: f.project, sha: 'a'.repeat(40), snapshotPath: path.join(f.runtime, 'source-one') },
      { id: 'source-two', name: 'UI', path: path.join(f.project, 'ui'), sha: 'b'.repeat(40), snapshotPath: path.join(f.runtime, 'source-two') }] };
  const result = await f.store.seal(f.record, [], 'manual'), artifact = result.artifacts.find(item => item.path === 'documents/repositories.json')!;
  assert.ok(artifact); await rm(f.runtime, { recursive: true, force: true }); await rm(f.project, { recursive: true, force: true });
  const evidence = JSON.parse((await f.store.readArtifact(result.id, artifact.id)).bytes.toString('utf8'));
  assert.deepEqual(evidence.repositories.map((repo: { id: string; sha: string }) => [repo.id, repo.sha]), [['source-one', 'a'.repeat(40)], ['source-two', 'b'.repeat(40)]]);
  assert.equal(JSON.stringify(evidence).includes('snapshotPath'), false); assert.equal(JSON.stringify(evidence).includes(f.runtime), false);
  await f.store.exportTo(result.id, path.join(f.root, 'manual-group-export'));
});

test('task changes restore binary, CRLF, deletion, additions and Git modes before allowing cleanup', async t => {
  const f = await fixture(t, true), worktree = f.record.spec.executionRoot!;
  await writeFile(path.join(worktree, 'committed.txt'), 'unpublished task commit\n');
  git(worktree, 'add', 'committed.txt'); git(worktree, 'commit', '-qm', 'task progress');
  await writeFile(path.join(worktree, 'text.txt'), 'changed\r\n'); await rm(path.join(worktree, 'delete.txt'));
  await writeFile(path.join(worktree, 'binary.bin'), Buffer.from([0, 255, 128, 0, 13, 10]));
  await mkdir(path.join(worktree, 'new')); await writeFile(path.join(worktree, 'new', 'bytes.bin'), Buffer.from([255, 0, 254]));
  git(worktree, 'update-index', '--chmod=+x', 'mode.sh');
  if (process.platform !== 'win32') await chmod(path.join(worktree, 'mode.sh'), 0o755);
  const beforeHead = git(worktree, 'rev-parse', 'HEAD'), beforeIndex = git(worktree, 'ls-files', '--stage'), beforeWorktrees = git(f.project, 'worktree', 'list', '--porcelain');
  const manifest = await f.store.seal(f.record, [], 'deleted'); assert.ok(manifest.restore);
  assert.equal(git(worktree, 'rev-parse', 'HEAD'), beforeHead); assert.equal(git(worktree, 'ls-files', '--stage'), beforeIndex);
  assert.equal(git(f.project, 'worktree', 'list', '--porcelain'), beforeWorktrees);
  const inventory = JSON.parse((await f.store.readArtifact(manifest.id, manifest.restore.inventoryArtifactId)).bytes.toString()) as CodexChangeInventory;
  assert.equal(inventory.entries.find(entry => entry.path === 'mode.sh')?.mode, '100755');
  assert.equal(inventory.entries.find(entry => entry.path === 'delete.txt')?.action, 'delete');
  const restored = path.join(f.root, 'restored');
  await mkdir(restored); git(restored, 'init', '--quiet'); git(restored, 'config', 'core.autocrlf', 'false');
  await mkdir(path.join(restored, '.git', 'objects', 'info'), { recursive: true });
  await writeFile(path.join(restored, '.git', 'objects', 'info', 'alternates'), path.join(f.project, '.git', 'objects').replaceAll('\\', '/') + '\n');
  git(restored, 'checkout', '--quiet', '--detach', manifest.restore.baseSha);
  const patch = await f.store.readArtifact(manifest.id, manifest.restore.patchArtifactId), patchFile = path.join(f.root, 'restore.patch');
  await writeFile(patchFile, patch.bytes); git(restored, 'apply', '--index', '--binary', '--whitespace=nowarn', patchFile);
  for (const entry of inventory.entries) if (entry.action === 'write') {
    const bytes = (await f.store.readArtifact(manifest.id, entry.artifactId!)).bytes, destination = path.join(restored, entry.path);
    await mkdir(path.dirname(destination), { recursive: true }); await writeFile(destination, bytes);
    assert.deepEqual(await readFile(destination), await readFile(path.join(worktree, entry.path)));
  }
  await assert.rejects(lstat(path.join(restored, 'delete.txt')), { code: 'ENOENT' });
  assert.match(git(restored, 'ls-files', '--stage', 'mode.sh'), /^100755 /);
  assert.equal(await readFile(path.join(restored, 'committed.txt'), 'utf8'), 'unpublished task commit\n');
  assert.equal(manifest.origin?.webUrl, 'https://example.test/group/project');
  assert.equal(JSON.stringify(manifest).includes('PRIVATE'), false);
  const manualRoot = path.join(f.root, 'manual-workspace'), restoredWorkspace = await f.store.restoreTo(manifest.id, f.project, manualRoot);
  assert.equal(restoredWorkspace.path, manualRoot); assert.match(restoredWorkspace.branch, /^manual\/task-one-/);
  for (const entry of inventory.entries) if (entry.action === 'write') assert.deepEqual(await readFile(path.join(manualRoot, entry.path)), await readFile(path.join(worktree, entry.path)));
  assert.equal(git(manualRoot, 'rev-parse', 'HEAD'), manifest.restore.baseSha);
  assert.match(git(manualRoot, 'ls-files', '--stage', 'mode.sh'), /^100755 /);
  await assert.rejects(f.store.restoreTo(manifest.id, f.project, manualRoot), /尚未存在/);
  await assert.rejects(f.store.restoreTo(manifest.id, restored, path.join(f.root, 'wrong-repository')), /原 Repo/);
  await assert.rejects(f.store.restoreTo(manifest.id, f.project, path.join(f.project, 'nested')), /以外/);
});

test('complete export does not silently truncate an inventory after 500 files', async t => {
  const f = await fixture(t, true), worktree = f.record.spec.executionRoot!;
  await mkdir(path.join(worktree, 'many'));
  for (let i = 0; i < 501; i++) await writeFile(path.join(worktree, 'many', i + '.txt'), String(i));
  const manifest = await f.store.seal(f.record, [], 'manual');
  const inventory = JSON.parse((await f.store.readArtifact(manifest.id, manifest.restore!.inventoryArtifactId)).bytes.toString()) as CodexChangeInventory;
  assert.equal(inventory.entries.length, 501); assert.ok(inventory.entries.some(entry => entry.path === 'many/500.txt'));
});

test('oversize or unsupported Git data never seals a partial archive or removes the source', async t => {
  const f = await fixture(t, true), worktree = f.record.spec.executionRoot!, oversized = path.join(worktree, 'large.bin');
  const file = await open(oversized, 'wx'); await file.truncate(CODEX_RESULT_MAX_BYTES + 1); await file.close();
  await assert.rejects(f.store.seal(f.record, [], 'deleted'), /容量|限制/);
  assert.equal((await lstat(oversized)).size, CODEX_RESULT_MAX_BYTES + 1); assert.deepEqual(await f.store.list(), []);
  await rm(oversized);
  await writeFile(path.join(worktree, 'link'), 'text.txt');
  const object = git(worktree, 'hash-object', '-w', 'link');
  git(worktree, 'update-index', '--add', '--cacheinfo', '120000', object, 'link');
  git(worktree, 'config', 'core.symlinks', 'false');
  await assert.rejects(f.store.seal(f.record, [], 'deleted'), /類型|symlink/);
  assert.equal(await readFile(path.join(worktree, 'link'), 'utf8'), 'text.txt');
  assert.deepEqual((await readdir(f.store.directory)).filter(name => name.startsWith('.stage-')), []);
});

test('missing base, unresolved publication and absent stop proof block sealing', async t => {
  const f = await fixture(t, true);
  f.record.spec.origin!.sourceSha = 'f'.repeat(40);
  await assert.rejects(f.store.seal(f.record, [], 'deleted'), /還原驗證/);
  f.record.spec.origin!.sourceSha = git(f.project, 'rev-parse', 'HEAD');
  f.record.publication = { kind: 'review', state: 'pending', key: 'receipt' };
  await assert.rejects(f.store.seal(f.record, [], 'deleted'), /發布結果/); f.record.publication = undefined;
  const directory = path.join(f.root, 'unconfirmed-lock'); await mkdir(directory);
  f.record.lease = { directory, receipt: { path: directory + '.stopped-missing.json', nonce: 'missing' } };
  await assert.rejects(f.store.seal(f.record, [], 'deleted'), /停止證據/);
});

test('index flags cannot hide modified files from the export inventory', async t => {
  const f = await fixture(t, true), worktree = f.record.spec.executionRoot!;
  git(worktree, 'update-index', '--assume-unchanged', 'text.txt'); await writeFile(path.join(worktree, 'text.txt'), 'hidden change');
  await assert.rejects(f.store.seal(f.record, [], 'deleted'), /隱藏變更/);
  assert.equal(await readFile(path.join(worktree, 'text.txt'), 'utf8'), 'hidden change'); assert.deepEqual(await f.store.list(), []);
});

test('artifact hashes and portable paths are checked on every read and export', async t => {
  const f = await fixture(t), manifest = await f.store.seal(f.record, [], 'manual');
  const artifact = manifest.artifacts[0]; await writeFile(path.join(f.store.directory, manifest.id, artifact.path), 'tampered');
  await assert.rejects(f.store.read(manifest.id), /hash/);
  await assert.rejects(f.store.exportTo(manifest.id, path.join(f.root, 'bad-export')), /hash/);
  for (const unsafe of ['../escape', 'a/../b', 'C:/secret', 'a\\b', 'file:stream', '.git/config', 'NUL.txt', 'trailing.']) assert.throws(() => safeResultPath(unsafe));
  await assert.rejects(f.store.read('../escape'), /識別/);
});

test('Wiki pages persist independently of the source snapshot and publication journal', async t => {
  const f = await fixture(t), id = 'a'.repeat(32);
  f.record.spec.source = { kind: 'project-wiki', projectId: 1 };
  f.record.spec.origin = { kind: 'project-wiki', accountKey: 'private', baseUrl: 'https://example.test', projectId: 1, projectPath: 'g/p',
    webUrl: 'https://example.test/g/p', repositoryRoot: f.project, sourceBranch: 'main', sourceSha: 'a'.repeat(40) };
  f.record.spec.workflow = { id, runtimeRoot: f.runtime, remote: 'origin', sourceRoot: path.join(f.runtime, 'source') };
  f.record.result = { state: 'published', summary: 'Two published pages.', draftId: id };
  const draftRoot = path.join(f.storage, 'project-wiki-drafts'); await mkdir(draftRoot);
  const draft = { schema: 'GitLabWorkspaceProjectWiki/v1', id, origin: f.record.spec.origin,
    pages: [{ file: 'index.md', content: '# Wiki\n', published: true }, { file: 'modules/api.md', content: '# API\n', published: true }] };
  Object.assign(draft.pages[0], { sending: true });
  await writeFile(path.join(draftRoot, id + '.json'), JSON.stringify(draft));
  await assert.rejects(f.store.seal(f.record, [], 'completed'), /Wiki 發布/);
  const provisional = path.join(f.root, 'wiki-pending-export');
  const pending = await f.store.exportPendingTo(f.record, [], provisional);
  assert.equal(pending.provisional, true); assert.equal(pending.result?.state, 'uncertain');
  assert.equal(await readFile(path.join(provisional, 'wiki', 'index.md'), 'utf8'), '# Wiki\n');
  assert.deepEqual(await f.store.list(), []); assert.ok(await lstat(draftRoot));
  Object.assign(draft.pages[0], { sending: false });
  await writeFile(path.join(draftRoot, id + '.json'), JSON.stringify(draft));
  const manifest = await f.store.seal(f.record, [], 'completed');
  await rm(draftRoot, { recursive: true, force: true }); await rm(f.runtime, { recursive: true, force: true });
  assert.equal(manifest.artifacts.filter(artifact => artifact.path.startsWith('wiki/')).length, 2);
  const api = manifest.artifacts.find(artifact => artifact.path === 'wiki/modules/api.md')!;
  assert.equal((await f.store.readArtifact(manifest.id, api.id)).bytes.toString(), '# API\n');
});

test('redirected document folders cannot authorize source cleanup', async t => {
  const f = await fixture(t), documents = path.join(f.runtime, 'documents'), external = path.join(f.root, 'user-notes');
  await mkdir(documents); await mkdir(external); await writeFile(path.join(external, 'notes.md'), 'retain user data');
  try { await symlink(external, path.join(documents, 'redirect'), process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (error) { if (['EPERM', 'EACCES'].includes((error as NodeJS.ErrnoException).code ?? '')) { t.skip('This sandbox cannot create filesystem links.'); return; } throw error; }
  Object.assign(f.record.spec, { groupAnalysis: { runtimeRoot: f.runtime, outputRoot: documents } });
  await assert.rejects(f.store.seal(f.record, [], 'deleted'), /重新導向/);
  assert.equal(await readFile(path.join(external, 'notes.md'), 'utf8'), 'retain user data'); assert.deepEqual(await f.store.list(), []);
});

test('a complete nonce-matched stop receipt is accepted without persisting execution identity', async t => {
  const f = await fixture(t), directory = path.join(f.root, 'stopped-lock'), nonce = '11111111-2222-4333-8444-555555555555';
  await mkdir(directory); const receipt = { path: directory + '.stopped-' + nonce + '.json', nonce };
  await writeFile(receipt.path, JSON.stringify({ schema: 'GitLabWorkspaceCodexProcess/v1', nonce, processTreeConfirmed: true }));
  f.record.lease = { directory, receipt };
  Object.assign(f.record, { delivery: { mode: 'automatic', state: 'published', deliveredCommitSha: 'a'.repeat(40),
    steps: [{ kind: 'push', state: 'confirmed', key: 'push-key', sha: 'a'.repeat(40), resourceId: 1, url: 'https://example.test/p?token=PRIVATE' }] } });
  const manifest = await f.store.seal(f.record, [], 'completed');
  assert.equal(manifest.delivery?.receipts?.[0].commitSha, 'a'.repeat(40));
  for (const secret of [nonce, directory, 'PRIVATE-THREAD', 'PRIVATE PROMPT', 'token=PRIVATE']) assert.equal(JSON.stringify(manifest).includes(secret), false);
});

test('failed manual restore rolls back only its new worktree and leaves the source and archive intact', async t => {
  const f = await fixture(t, true), source = f.record.spec.executionRoot!;
  await writeFile(path.join(source, 'new.bin'), Buffer.from([0, 255, 1]));
  const manifest = await f.store.seal(f.record, [], 'manual'), artifact = manifest.artifacts.find(item => item.path === 'code/untracked/new.bin')!;
  const beforeTrees = git(f.project, 'worktree', 'list', '--porcelain'), beforeRefs = git(f.project, 'for-each-ref', '--format=%(refname) %(objectname)', 'refs/heads');
  const read = f.store.readArtifact.bind(f.store);
  t.mock.method(f.store, 'readArtifact', async (taskId: string, artifactId: string) => {
    if (artifactId === artifact.id) throw new Error('fixture payload unavailable'); return read(taskId, artifactId);
  });
  const destination = path.join(f.root, 'failed-manual-workspace');
  await assert.rejects(f.store.restoreTo(manifest.id, f.project, destination), /payload unavailable/);
  await assert.rejects(lstat(destination), { code: 'ENOENT' });
  assert.equal(git(f.project, 'worktree', 'list', '--porcelain'), beforeTrees);
  assert.equal(git(f.project, 'for-each-ref', '--format=%(refname) %(objectname)', 'refs/heads'), beforeRefs);
  assert.deepEqual(await readFile(path.join(source, 'new.bin')), Buffer.from([0, 255, 1]));
  assert.equal((await f.store.read(manifest.id)).id, manifest.id);
});

test('unreconciled handoff exports verified salvage without registering a final result or altering the task', async t => {
  const f = await fixture(t, true), source = f.record.spec.executionRoot!;
  await writeFile(path.join(source, 'new.bin'), Buffer.from([0, 255, 3]));
  f.record.result!.state = 'uncertain'; f.record.publication = { kind: 'review', state: 'pending', key: 'PRIVATE publication key' };
  f.record.delivery = { mode: 'automatic', state: 'needs-attention', error: 'password=PRIVATE',
    steps: [{ id: 'upload', kind: 'upload', state: 'uncertain', key: 'PRIVATE upload key', error: 'token=PRIVATE', url: 'https://user:PRIVATE@example.test/file?token=PRIVATE' }] };
  const before = structuredClone(f.record), destination = path.join(f.root, 'pending-export');
  await assert.rejects(f.store.seal(f.record, [], 'manual'), /發布結果/);
  const manifest = await f.store.exportPendingTo(f.record, [], destination);
  assert.equal(manifest.provisional, true); assert.equal(manifest.result?.state, 'uncertain'); assert.ok(manifest.restore);
  assert.deepEqual(f.record, before); assert.deepEqual(await f.store.list(), []);
  const inventory = JSON.parse(await readFile(path.join(destination, 'code', 'inventory.json'), 'utf8')) as CodexChangeInventory;
  const entry = inventory.entries.find(item => item.path === 'new.bin')!, artifact = manifest.artifacts.find(item => item.id === entry.artifactId)!;
  assert.deepEqual(await readFile(path.join(destination, artifact.path)), Buffer.from([0, 255, 3]));
  const pending = await readFile(path.join(destination, 'delivery', 'pending-operations.json'), 'utf8');
  assert.equal(JSON.parse(pending).operations.length, 2); assert.equal(pending.includes('PRIVATE'), false);
  assert.match(await readFile(path.join(destination, 'handoff.md'), 'utf8'), /暫存交接成果/);
  assert.deepEqual(await readFile(path.join(source, 'new.bin')), Buffer.from([0, 255, 3]));
  assert.deepEqual((await readdir(f.store.directory)).filter(name => name.startsWith('.handoff-')), []);
  f.record.status = 'running';
  await assert.rejects(f.store.exportPendingTo(f.record, [], path.join(f.root, 'no-proof')), /停止證據/);
  await assert.rejects(lstat(path.join(f.root, 'no-proof')), { code: 'ENOENT' });
  f.record.status = 'paused'; f.record.spec.origin!.sourceSha = 'f'.repeat(40);
  await assert.rejects(f.store.exportPendingTo(f.record, [], path.join(f.root, 'no-base')), /還原驗證/);
  await assert.rejects(lstat(path.join(f.root, 'no-base')), { code: 'ENOENT' });
});

test('handoff retains selected skills, source requirement, todo and historical test evidence without native identities', async t => {
  const f = await fixture(t);
  f.record.spec.source.requirement = 'Implement the explicitly requested feature.';
  f.record.spec.skill = { name: 'required-flow', path: path.join(f.root, 'PRIVATE-installed-skill'), fingerprint: 'a'.repeat(64) };
  f.record.spec.additionalSkills = [{ id: 'private-installation-id', name: 'testing', path: path.join(f.root, 'PRIVATE-other-skill'), fingerprint: 'b'.repeat(64) }];
  f.record.spec.delivery = { mode: 'automatic', testCommands: ['npm.cmd test'] };
  f.record.progress = { plan: [{ step: 'Implement', status: 'completed' }, { step: 'Review', status: 'pending' }] };
  f.record.validation = { cwd: f.runtime, artifactDigest: 'c'.repeat(64), testedAt: '2026-11-13T01:05:00Z', turnId: 'PRIVATE-validation-turn',
    commands: [{ command: 'npm.cmd test', cwd: f.runtime, exitCode: 0, itemId: 'PRIVATE-command-item', startedAtMs: 1, completedAtMs: 2 }] };
  f.record.delivery = { mode: 'automatic', state: 'cancelled', steps: [{ id: 'private-operation', kind: 'push', state: 'prepared', key: 'PRIVATE-operation-key' }] };
  const manifest = await f.store.seal(f.record, [], 'manual'), artifact = manifest.artifacts.find(item => item.path === 'task-summary.json')!;
  const summaryText = (await f.store.readArtifact(manifest.id, artifact.id)).bytes.toString(), summary = JSON.parse(summaryText);
  assert.equal(summary.requirementSummary, 'Implement the explicitly requested feature.');
  assert.deepEqual(summary.skills, [{ name: 'required-flow', required: true, fingerprint: 'a'.repeat(64) }, { name: 'testing', required: false, fingerprint: 'b'.repeat(64) }]);
  assert.deepEqual(summary.testCommands, ['npm.cmd test']); assert.equal(summary.plan[1].status, 'pending');
  assert.equal(summary.validation.cwd, f.runtime); assert.equal(summary.validation.cwdUse, 'historical-evidence-only');
  assert.deepEqual(summary.validation.commands[0], { command: 'npm.cmd test', cwd: f.runtime, exitCode: 0, startedAtMs: 1, completedAtMs: 2 });
  for (const privateText of ['PRIVATE-installed-skill', 'PRIVATE-other-skill', 'private-installation-id', 'PRIVATE-validation-turn', 'PRIVATE-command-item', 'PRIVATE PROMPT']) assert.equal(summaryText.includes(privateText), false);
  const operations = manifest.artifacts.find(item => item.path === 'delivery/operations.json')!;
  const operationText = (await f.store.readArtifact(manifest.id, operations.id)).bytes.toString();
  assert.equal(JSON.parse(operationText).operations[0].state, 'prepared'); assert.equal(operationText.includes('PRIVATE'), false);
  const handoff = (await f.store.readArtifact(manifest.id, manifest.artifacts.find(item => item.path === 'handoff.md')!.id)).bytes.toString();
  assert.match(handoff, /required-flow/); assert.match(handoff, /npm.cmd test/); assert.match(handoff, /待辦：Review/); assert.equal(handoff.includes(f.runtime), false);
});
