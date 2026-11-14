import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { GitLabProject } from '../../src/api/types';
import type { CodexTaskSpec } from '../../src/codex/protocol';
import { ensureManagedRepositoryCache, startManagedClone, verifyCommitConfiguration, verifyManagedClone, verifyManagedRepositoryCacheBinding } from '../../src/codex/managedRepository';
import { implementationCommits, implementationDigest } from '../../src/codex/projectWorkflows';
import { confirmCodexDelivery, deliveryConfirmationDigest, issueDeliveryDigest, issueDeliverySnapshot } from '../../src/codex/delivery';
import { CodexResultStore } from '../../src/codex/resultStore';
import { exportCodexTaskChanges } from '../../src/codex/resultExporter';
import { cleanupTaskStorage, taskCleanupPlan } from '../../src/codex/taskCleanup';
import type { CodexTaskRecord } from '../../src/codex/protocol';

const git = (root: string, ...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', windowsHide: true });
async function fixture(t: test.TestContext, longPaths = false) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'codex-managed-repository-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const local = path.join(directory, 'source'), storage = path.join(directory, longPaths ? 'storage-' + 's'.repeat(40) : 'storage'); await mkdir(local); await mkdir(storage);
  if (longPaths) {
    const inheritedConfig = path.join(directory, 'inherited.gitconfig'), previous = process.env.GIT_CONFIG_GLOBAL;
    await writeFile(inheritedConfig, '[core]\n\tautocrlf = true\n'); process.env.GIT_CONFIG_GLOBAL = inheritedConfig;
    t.after(() => { if (previous === undefined) delete process.env.GIT_CONFIG_GLOBAL; else process.env.GIT_CONFIG_GLOBAL = previous; });
  }
  git(local, 'init', '-q', '--initial-branch=main'); git(local, 'config', 'user.name', 'Managed Repo Test'); git(local, 'config', 'user.email', 'managed@test.invalid');
  git(local, 'config', 'commit.gpgsign', 'false');
  if (longPaths) {
    git(local, 'config', 'core.longpaths', 'false');
    git(local, 'config', 'core.autocrlf', 'false');
    const nested = path.join(local, 'nested', 'n'.repeat(100)); await mkdir(nested, { recursive: true });
    await writeFile(path.join(nested, 'source.txt'), 'long-path baseline\n');
  }
  await writeFile(path.join(local, 'source.txt'), 'initial\n'); git(local, 'add', '.'); git(local, 'commit', '-qm', 'initial');
  git(local, 'remote', 'add', 'origin', 'https://gitlab.test/team/repository.git');
  const sha = git(local, 'rev-parse', 'HEAD').trim();
  const project = { id: 1, path_with_namespace: 'team/repository', http_url_to_repo: 'https://gitlab.test/team/repository.git' } as GitLabProject;
  const options = { storage, accountKey: 'account', baseUrl: 'https://gitlab.test', project, sourceSha: sha, localRepository: local };
  const cache = await ensureManagedRepositoryCache(options);
  const runtime = path.join(storage, 'codex-workflows', 'a'.repeat(32)), executionRoot = path.join(runtime, 'repository');
  const spec: CodexTaskSpec = { source: { kind: 'issue', projectId: 1, issueIid: 123 }, root: local, title: 'Implement feature', prompt: '',
    writableRoots: [executionRoot], workspaceKey: local, environmentKey: 'test', executionRoot,
    origin: { kind: 'issue', accountKey: 'account', baseUrl: options.baseUrl, projectId: 1, projectPath: 'team/repository', webUrl: 'https://gitlab.test/team/repository/-/issues/123',
      repositoryRoot: cache.root, sourceBranch: 'main', sourceSha: sha, branch: 'issue/123-feature', iid: 123 },
    workflow: { id: 'a'.repeat(32), runtimeRoot: runtime, remote: 'origin', managedClone: { path: executionRoot, cacheRepository: cache.root,
      branch: 'issue/123-feature', sourceSha: sha, remoteUrl: project.http_url_to_repo } } };
  return { directory, local, cache, options, sha, spec, executionRoot };
}

test('cache seeds locally and is reused without network or borrowing source objects', async t => {
  const f = await fixture(t), before = git(f.local, 'show-ref');
  await writeFile(path.join(f.local, 'source.txt'), 'uncommitted\n');
  const again = await ensureManagedRepositoryCache(f.options);
  assert.equal(again.root, f.cache.root); assert.equal(git(f.local, 'show-ref'), before);
  assert.equal(await readFile(path.join(f.local, 'source.txt'), 'utf8'), 'uncommitted\n');
  await assert.rejects(access(path.join(f.cache.root, '.git', 'objects', 'info', 'alternates')));
  const object = git(f.local, 'hash-object', 'source.txt').trim();
  const originalObject = path.join(f.local, '.git', 'objects', f.sha.slice(0, 2), f.sha.slice(2));
  const copiedObject = path.join(f.cache.root, '.git', 'objects', f.sha.slice(0, 2), f.sha.slice(2));
  assert.equal((await stat(originalObject)).nlink, 1); assert.equal((await stat(copiedObject)).nlink, 1);
  assert.ok(object);
});

test('Windows long-path caches retain baselines and independent clones support ordinary Git commands', { skip: process.platform !== 'win32' }, async t => {
  const f = await fixture(t, true), retained = `refs/gitlab-workspace/cache/${f.sha}`;
  assert.ok(path.join(f.cache.root, '.git', retained + '.lock').length > 260);
  assert.equal(git(f.cache.root, 'show-ref', '--verify', '--hash', retained).trim(), f.sha);
  assert.equal(git(f.cache.root, 'config', '--local', '--get', 'core.longpaths').trim(), 'true');
  const sourceConfig = await readFile(path.join(f.local, '.git', 'config')), sourceRefs = git(f.local, 'show-ref');
  git(f.cache.root, 'config', '--local', 'core.longpaths', 'false');
  await ensureManagedRepositoryCache(f.options);
  assert.equal(git(f.cache.root, 'config', '--local', '--get', 'core.longpaths').trim(), 'true', 'existing owned cache settings are repaired');
  await startManagedClone(f.spec);
  assert.equal(git(f.executionRoot, 'config', '--local', '--get', 'core.longpaths').trim(), 'true');
  assert.equal(git(f.executionRoot, 'status', '--porcelain'), '', 'a new clone must not manufacture tracked changes during checkout');
  assert.equal(git(f.executionRoot, 'config', '--global', '--get', 'core.autocrlf').trim(), 'true');
  assert.equal(git(f.executionRoot, 'config', '--local', '--get', 'core.autocrlf').trim(), 'false');
  const nested = path.join(f.executionRoot, 'nested', 'n'.repeat(100), 'source.txt');
  assert.ok(nested.length > 260);
  assert.equal(await readFile(nested, 'utf8'), 'long-path baseline\n', 'the initial clone honors the source line-ending configuration');
  assert.equal(await readFile(nested, 'utf8'), git(f.executionRoot, 'show', 'HEAD:nested/' + 'n'.repeat(100) + '/source.txt'));
  git(f.executionRoot, 'config', '--local', 'core.longpaths', 'false');
  await startManagedClone(f.spec);
  assert.equal(git(f.executionRoot, 'config', '--local', '--get', 'core.longpaths').trim(), 'true', 'resuming repairs only the owned clone');
  await writeFile(nested, 'long-path implementation\n');
  git(f.executionRoot, 'add', '.'); git(f.executionRoot, 'commit', '-qm', 'fix: deep source (#123)');
  assert.equal((await implementationCommits(f.spec)).length, 1);
  assert.equal(git(f.cache.root, 'rev-parse', 'HEAD').trim(), f.sha); assert.equal(git(f.local, 'rev-parse', 'HEAD').trim(), f.sha);
  assert.equal(git(f.local, 'show-ref'), sourceRefs); assert.deepEqual(await readFile(path.join(f.local, '.git', 'config')), sourceConfig);
  assert.equal(git(f.local, 'config', '--local', '--get', 'core.longpaths').trim(), 'false');
  for (const root of [f.cache.root, f.executionRoot]) await assert.rejects(access(path.join(root, '.git', 'objects', 'info', 'alternates')));
});

test('independent task clone commits do not change the source cache or original repository', async t => {
  const f = await fixture(t); await startManagedClone(f.spec);
  assert.equal(await verifyManagedClone(f.spec), f.executionRoot);
  assert.equal(git(f.executionRoot, 'config', '--get', 'user.email').trim(), 'managed@test.invalid');
  await writeFile(path.join(f.executionRoot, 'source.txt'), 'implemented\n'); git(f.executionRoot, 'add', '.'); git(f.executionRoot, 'commit', '-qm', 'feat: implementation (#123)');
  assert.equal(git(f.local, 'rev-parse', 'HEAD').trim(), f.sha); assert.equal(git(f.cache.root, 'rev-parse', 'HEAD').trim(), f.sha);
  assert.equal((await implementationCommits(f.spec)).length, 1);
  assert.equal(await startManagedClone(f.spec), f.executionRoot, 'resume preserves prior commits');
  await assert.rejects(access(path.join(f.executionRoot, '.git', 'objects', 'info', 'alternates')));
});

test('commit validation rejects missing card identifiers and rewritten history invalidates confirmation', async t => {
  const f = await fixture(t); await startManagedClone(f.spec);
  await writeFile(path.join(f.executionRoot, 'source.txt'), 'implemented\n'); git(f.executionRoot, 'add', '.'); git(f.executionRoot, 'commit', '-qm', 'missing identifier');
  await assert.rejects(implementationCommits(f.spec), /#123/);
  git(f.executionRoot, 'commit', '--amend', '-qm', 'feat: implementation (#123)');
  const record = { id: 'task-test', spec: f.spec, result: { state: 'ready', summary: 'done', files: ['source.txt'] } } as any;
  const issue = issueDeliverySnapshot({ id: 123, project_id: f.spec.origin!.projectId, iid: 123, title: 'Source fixture', state: 'opened', web_url: f.spec.origin!.webUrl });
  await confirmCodexDelivery(record, undefined, f.sha, issueDeliveryDigest(issue));
  const previous = record.delivery.confirmation.digest, content = await implementationDigest(f.spec, ['source.txt']);
  git(f.executionRoot, 'commit', '--amend', '-qm', 'feat: revised description (#123)');
  assert.equal(await implementationDigest(f.spec, ['source.txt']), content, 'file bytes remain identical');
  assert.notEqual(await deliveryConfirmationDigest(record), previous, 'commit messages are part of human approval');
});

test('cache identity and task remotes are verified before reuse', async t => {
  const f = await fixture(t); await startManagedClone(f.spec);
  const binding = { accountKey: f.options.accountKey, baseUrl: f.options.baseUrl, projectId: 1 };
  assert.equal(await verifyManagedRepositoryCacheBinding(f.options.storage, f.cache.root, binding), true);
  assert.equal(await verifyManagedRepositoryCacheBinding(f.options.storage, f.cache.root, { ...binding, projectId: 2 }), false);
  git(f.executionRoot, 'remote', 'set-url', 'origin', 'https://gitlab.test/other/project.git');
  await assert.rejects(verifyManagedClone(f.spec), /remote/);
  git(f.cache.root, 'remote', 'set-url', 'origin', 'https://gitlab.test/other/project.git');
  await assert.rejects(verifyManagedRepositoryCacheBinding(f.options.storage, f.cache.root, binding), /remote/);
  await assert.rejects(ensureManagedRepositoryCache(f.options), /remote/);
});

test('cleaning an independent clone preserves local commit history and uncommitted bytes for restore', async t => {
  const f = await fixture(t); await startManagedClone(f.spec);
  await writeFile(path.join(f.executionRoot, 'source.txt'), 'committed feature\n');
  git(f.executionRoot, 'add', '.'); git(f.executionRoot, 'commit', '-qm', 'feat: preserved history (#123)');
  const committed = git(f.executionRoot, 'rev-parse', 'HEAD').trim();
  await writeFile(path.join(f.executionRoot, 'source.txt'), 'uncommitted follow-up\n');
  await writeFile(path.join(f.executionRoot, 'new.txt'), 'untracked follow-up\n');
  const record: CodexTaskRecord = { schema: 'GitLabWorkspaceCodexTask/v4', id: 'task-clone', title: f.spec.title, root: f.spec.root,
    spec: f.spec, status: 'paused', ownerPid: process.pid, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    delivery: { mode: 'manual', state: 'cancelled', steps: [], deliveredCommitSha: committed,
      confirmation: { digest: 'a'.repeat(64), confirmedAt: '2026-11-13T02:30:00.000Z', headSha: committed, targetSha: f.sha, issueDigest: 'b'.repeat(64) } },
    result: { state: 'ready', summary: 'preserved changes', files: ['source.txt', 'new.txt'] } };
  const store = new CodexResultStore(path.join(f.options.storage, 'codex-results'));
  const failedStage = path.join(f.directory, 'failed-bundle-export'); await mkdir(failedStage);
  let failedAdds = 0;
  await assert.rejects(exportCodexTaskChanges(record, failedStage, async relative => {
    failedAdds++; assert.equal(relative, 'code/commits.bundle'); throw new Error('bundle artifact write rejected');
  }), /bundle artifact write rejected/);
  assert.equal(failedAdds, 1); await assert.rejects(access(path.join(failedStage, '.commits.bundle')), { code: 'ENOENT' });
  assert.equal(git(f.executionRoot, 'rev-parse', 'HEAD').trim(), committed, 'failed staging preserves the original local commits');
  const manifest = await store.seal(record, [], 'manual');
  const sealedRoot = path.join(f.options.storage, 'codex-results', record.id);
  const listFiles = async (directory: string, prefix = ''): Promise<string[]> => {
    const files: string[] = [];
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      assert.equal(entry.isSymbolicLink(), false); const relative = prefix + entry.name;
      if (entry.isDirectory()) files.push(...await listFiles(path.join(directory, entry.name), relative + '/'));
      else { assert.equal(entry.isFile(), true); files.push(relative); }
    }
    return files.sort();
  };
  assert.deepEqual(await listFiles(sealedRoot), ['manifest.json', ...manifest.artifacts.map(artifact => artifact.path)].sort(), 'sealed results contain exactly the registered artifacts and manifest');
  await assert.rejects(access(path.join(sealedRoot, '.commits.bundle')), { code: 'ENOENT' });
  assert.ok(manifest.restore?.commitBundleArtifactId);
  const bundle = await store.readArtifact(record.id, manifest.restore!.commitBundleArtifactId!);
  assert.equal(bundle.artifact.path, 'code/commits.bundle');
  const auditArtifact = manifest.artifacts.find(artifact => artifact.path === 'delivery/confirmation-audit.json')!;
  const audit = JSON.parse((await store.readArtifact(record.id, auditArtifact.id)).bytes.toString('utf8'));
  assert.equal(audit.commitBundleArtifactId, bundle.artifact.id); assert.deepEqual(audit.confirmation, record.delivery!.confirmation);
  await cleanupTaskStorage(f.options.storage, taskCleanupPlan(record));
  await assert.rejects(access(f.executionRoot));
  assert.equal(git(f.cache.root, 'rev-parse', 'HEAD').trim(), f.sha);
  const destination = path.join(f.directory, 'manual-clone');
  const manual = await store.restoreTo(record.id, f.cache.root, destination);
  assert.equal('delivery' in manual, false); assert.equal('confirmation' in manual, false);
  await assert.rejects(access(path.join(destination, auditArtifact.path)), { code: 'ENOENT' });
  assert.deepEqual(JSON.parse((await store.readArtifact(record.id, auditArtifact.id)).bytes.toString('utf8')), audit);
  assert.equal(git(destination, 'rev-parse', 'HEAD').trim(), committed);
  assert.equal(git(destination, 'log', '-1', '--format=%s').trim(), 'feat: preserved history (#123)');
  assert.equal(await readFile(path.join(destination, 'source.txt'), 'utf8'), 'uncommitted follow-up\n');
  assert.equal(await readFile(path.join(destination, 'new.txt'), 'utf8'), 'untracked follow-up\n');
  assert.equal(git(f.local, 'rev-parse', 'HEAD').trim(), f.sha);
});

test('preflight validates effective Git identity and signing configuration without invoking key programs', async t => {
  const f = await fixture(t); await startManagedClone(f.spec);
  git(f.executionRoot, 'config', 'user.name', '<>');
  await assert.rejects(verifyCommitConfiguration(f.executionRoot), /身分|設定/);
  git(f.executionRoot, 'config', 'user.name', 'Managed Repo Test');
  git(f.executionRoot, 'config', 'commit.gpgsign', 'invalid-boolean');
  await assert.rejects(verifyCommitConfiguration(f.executionRoot), /設定/);
  git(f.executionRoot, 'config', 'commit.gpgsign', 'true'); git(f.executionRoot, 'config', 'gpg.format', 'invalid-format');
  await assert.rejects(verifyCommitConfiguration(f.executionRoot), /gpg.format/);
  git(f.executionRoot, 'config', 'gpg.format', 'ssh'); git(f.executionRoot, 'config', 'user.signingkey', '');
  await assert.rejects(verifyCommitConfiguration(f.executionRoot), /SSH/);
  const marker = path.join(f.directory, 'key-command-must-not-run');
  git(f.executionRoot, 'config', 'gpg.ssh.defaultKeyCommand', `node -e "require('fs').writeFileSync('${marker.replaceAll('\\', '/')}', 'unexpected')"`);
  await verifyCommitConfiguration(f.executionRoot);
  await assert.rejects(access(marker));
  assert.equal(git(f.executionRoot, 'config', '--get', 'commit.gpgsign').trim(), 'true', 'preflight must never disable required signing');
});

test('reusing a cache refreshes only allowed commit settings after source configuration is fixed', async t => {
  const f = await fixture(t);
  git(f.local, 'config', 'user.email', 'updated@test.invalid');
  const signingPrograms = { 'gpg.openpgp.program': 'openpgp-program-must-not-run', 'gpg.x509.program': 'x509-program-must-not-run' };
  for (const [name, program] of Object.entries(signingPrograms)) git(f.local, 'config', name, program);
  git(f.cache.root, 'config', 'user.signingkey', 'stale-key');
  git(f.local, 'config', 'core.hooksPath', '/must-not-copy-hooks');
  await ensureManagedRepositoryCache(f.options);
  assert.equal(git(f.cache.root, 'config', '--get', 'user.email').trim(), 'updated@test.invalid');
  assert.throws(() => git(f.cache.root, 'config', '--local', '--get', 'user.signingkey'));
  assert.throws(() => git(f.cache.root, 'config', '--local', '--get', 'core.hooksPath'));
  await startManagedClone(f.spec);
  assert.equal(git(f.executionRoot, 'config', '--get', 'user.email').trim(), 'updated@test.invalid');
  for (const root of [f.cache.root, f.executionRoot]) for (const [name, program] of Object.entries(signingPrograms)) {
    assert.equal(git(root, 'config', '--get', name).trim(), program);
    assert.equal(git(root, 'config', '--get', 'commit.gpgsign').trim(), 'false', 'configuration propagation must not sign or enable signing');
  }
});
