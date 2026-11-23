import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import fs, { mkdtemp, mkdir, readFile, readdir, rm, rmdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { LEASE_SCHEMA, LocalNetworkLease, NetworkLeaseError } from '../../src/api/localNetworkLease';
import { OperationLog } from '../../src/logging/operationLog';
import { WorkflowKitReleaseManager, WORKFLOW_KIT_RELEASES, PackageIntegrityError, parseDescriptor, type ReleaseDescriptor } from '../../src/workspace/workflowKitReleases';
import { WorkflowKitService } from '../../src/workspace/workflowKitService';

const installerLimit = 16 * 1024 * 1024;
const sha = (data: Uint8Array) => createHash('sha256').update(data).digest('hex');
function release(version = '1.0.0', source: 'github' | 'gitea' = 'github', contract = 2, installer = Buffer.from('verified release installer')) {
  const zip = Buffer.from('verified release ZIP');
  const descriptor: ReleaseDescriptor = { schema: 'workflowkit-release/v1', package: 'gitlab-workspace-kit', version,
    workspaceContract: contract, installerApi: 1, statusApi: 1, minimumExtensionVersion: '0.33.0', profiles: ['group', 'repository'],
    skills: ['codebase-wiki', 'merge-reviewer', 'release-reviewer', 'output-style'], assets: {
      package: { name: `kit-${version}.zip`, size: zip.length, sha256: sha(zip) },
      installer: { name: `installer-${version}.py`, size: installer.length, sha256: sha(installer) }
    } };
  const metadata = Buffer.from(JSON.stringify(descriptor));
  const files = new Map<string, Buffer>([['release.json', metadata], [descriptor.assets.package.name, zip], [descriptor.assets.installer.name, installer]]);
  const base = `${WORKFLOW_KIT_RELEASES[source]}/download/v${version}/`;
  const api = { tag_name: `v${version}`, draft: false, prerelease: false, assets: [...files].map(([name, data]) => ({ name,
    size: data.length, digest: `sha256:${sha(data)}`, browser_download_url: base + name })) };
  return { api, descriptor, files, base };
}
async function context(t: { after: (callback: () => Promise<unknown>) => void }, releases = [release()], log?: OperationLog) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'online-kit-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const calls: string[] = [];
  const respond = async (url: string | URL | Request): Promise<Response> => {
    const value = String(url); calls.push(value);
    if (value.includes('/api/v1/repos/') || value.startsWith('https://api.github.com/repos/')) return new Response(JSON.stringify(releases.map(item => item.api)));
    for (const item of releases) if (value.startsWith(item.base)) {
      const data = item.files.get(value.slice(item.base.length));
      if (data) return new Response(Uint8Array.from(data).buffer);
    }
    return new Response('', { status: 404 });
  };
  const manager = new WorkflowKitReleaseManager(root, respond as typeof fetch, log);
  return { root, calls, respond, manager };
}

function updateDescriptor(item: ReturnType<typeof release>, changes: Partial<ReleaseDescriptor>): void {
  const bytes = Buffer.from(JSON.stringify({ ...item.descriptor, ...changes }));
  item.files.set('release.json', bytes);
  Object.assign(item.api.assets[0], { size: bytes.length, digest: `sha256:${sha(bytes)}` });
}

test('does not contact any source until explicitly refreshed; versions are independent', async t => {
  const { manager, calls } = await context(t);
  assert.deepEqual(await manager.listReleases(), []); assert.equal(calls.length, 0);
  const [latest] = await manager.refresh('github'); assert.equal(latest.version, '1.0.0');
  assert.equal(calls.length, 2); assert.equal(await manager.statusHelper({ source: 'github', version: '1.0.0' }), undefined);
});
test('shows the latest and the latest compatible stable release separately', async t => {
  const draft = release('9.0.0'); draft.api.draft = true;
  const pre = release('8.0.0'); pre.api.prerelease = true;
  const { manager } = await context(t, [release('1.9.0'), release('1.10.0'), release('2.0.0', 'github', 3), draft, pre]);
  const versions = await manager.refresh('github');
  assert.deepEqual(versions.map(item => [item.version, item.available]), [['2.0.0', false], ['1.10.0', true]]);
  const ordered = await context(t, [release('1.9.0'), release('1.10.0')]);
  assert.equal((await ordered.manager.refresh('github'))[0].version, '1.10.0');
});
test('paginates release listings before selecting the latest release', async t => {
  const item = release(); const { root, respond } = await context(t, [item]);
  const calls: string[] = [];
  const manager = new WorkflowKitReleaseManager(root, (async (url: string | URL | Request) => {
    const value = String(url); calls.push(value);
    if (new URL(value).searchParams.get('page') === '1') return new Response(JSON.stringify(Array.from({ length: 100 }, () => ({ ...item.api, draft: true }))));
    return respond(url);
  }) as typeof fetch);
  assert.equal((await manager.refresh('github'))[0].version, '1.0.0');
  assert.ok(calls.some(url => url.includes('page=2')));
});
test('follows Gitea pagination headers when the server caps the requested page size', async t => {
  const item = release('1.0.0', 'gitea'); const { root, respond } = await context(t, [item]);
  const calls: string[] = [];
  const manager = new WorkflowKitReleaseManager(root, (async (input: string | URL | Request) => {
    const url = String(input); calls.push(url);
    if (new URL(url).searchParams.get('page') === '1') return new Response(JSON.stringify([{ ...item.api, draft: true }]),
      { headers: { link: '<https://tech-sharing.cathaysec.com.tw/api/v1/repos/01002903/WorkflowKit/releases?page=2>; rel="next"' } });
    return respond(input);
  }) as typeof fetch);
  assert.equal((await manager.refresh('gitea'))[0].version, '1.0.0');
  assert.ok(calls.some(url => url.includes('limit=50&page=2')));
});
test('accepts releases with a higher or omitted minimum Extension version', async t => {
  for (const minimumExtensionVersion of ['99.0.0', undefined]) {
    const latest = release('2.0.0');
    updateDescriptor(latest, { minimumExtensionVersion });
    const { manager } = await context(t, [release(), latest]);
    const [selected] = await manager.refresh('github');
    assert.equal(selected.version, '2.0.0');
    assert.equal((await manager.getRelease(selected.id)).version, '2.0.0');
  }
});
test('reports an unusable latest release without automatically installing an older release or switching source', async t => {
  for (const problem of ['schema', 'installer', 'missing-list', 'missing-index', 'missing-archive', 'invalid-json'] as const) {
    const latest = release('2.0.0');
    if (problem === 'schema') {
      const bytes = Buffer.from(JSON.stringify({ ...latest.descriptor, schema: 'workflowkit-release/v2' }));
      latest.files.set('release.json', bytes);
      Object.assign(latest.api.assets[0], { size: bytes.length, digest: `sha256:${sha(bytes)}` });
    } else if (problem === 'installer') updateDescriptor(latest, { installerApi: 2 });
    else if (problem === 'missing-list') latest.api.assets = undefined as unknown as typeof latest.api.assets;
    else if (problem === 'missing-index') latest.api.assets = latest.api.assets.filter(asset => asset.name !== 'release.json');
    else if (problem === 'missing-archive') latest.api.assets = latest.api.assets.filter(asset => asset.name !== latest.descriptor.assets.package.name);
    else {
      const bytes = Buffer.from('{ invalid json');
      latest.files.set('release.json', bytes);
      Object.assign(latest.api.assets[0], { size: bytes.length, digest: `sha256:${sha(bytes)}` });
    }
    const { manager, calls } = await context(t, [release(), latest]);
    const versions = await manager.refresh('github');
    assert.equal(versions[0].available, false);
    assert.equal(versions[1].version, '1.0.0');
    await assert.rejects(manager.getRelease(versions[0].id));
    assert.ok(calls.every(url => !url.includes('tech-sharing.cathaysec.com.tw')));
  }
});
test('downloads, verifies and persists only the selected release and supports offline status after restart', async t => {
  const latest = release('2.0.0', 'github', 2);
  updateDescriptor(latest, { minimumExtensionVersion: '99.0.0' });
  const { manager, root, calls } = await context(t, [latest]);
  const [item] = await manager.refresh('github');
  const result = await manager.getRelease(item.id);
  assert.ok(result.archivePath.endsWith('.zip')); assert.ok(result.installerPath.endsWith('.py'));
  const restarted = new WorkflowKitReleaseManager(root, (async () => { throw new Error('No background network'); }) as typeof fetch);
  assert.equal((await restarted.statusHelper({ source: 'github', version: '2.0.0' }))?.version, '2.0.0');
  assert.equal(await restarted.statusHelper({ source: 'gitea', version: '2.0.0' }), undefined);
  assert.equal(await restarted.statusHelper({ source: 'github', version: '1.0.0' }), undefined);
  const cached = await restarted.useCached('github');
  assert.equal(cached[0].cached, true);
  assert.equal((await restarted.getRelease(cached[0].id)).version, '2.0.0');
  assert.equal(calls.length, 4);
  assert.deepEqual(await readFile(result.archivePath), Buffer.from('verified release ZIP'));
});

test('downloads and caches an installer of the WorkflowKit 1.12.0 size', async t => {
  const bytes = Buffer.alloc(8_396_806, 35);
  const { manager, root } = await context(t, [release('1.12.0', 'github', 2, bytes)]);
  const [selected] = await manager.refresh('github');
  assert.equal(selected.version, '1.12.0');
  assert.equal(selected.available, true);
  const result = await manager.getRelease(selected.id);
  assert.deepEqual(await readFile(result.installerPath), bytes);
  const restarted = new WorkflowKitReleaseManager(root, async () => { throw new Error('Unexpected network request'); });
  const [cached] = await restarted.useCached('github');
  assert.equal(cached.id, selected.id);
  assert.equal(cached.cached, true);
});
test('downloads an installer at the size limit and reports an oversized index', async t => {
  const bytes = Buffer.alloc(installerLimit, 35);
  const item = release('1.12.0', 'github', 2, bytes);
  const { manager } = await context(t, [item]);
  const [selected] = await manager.refresh('github');
  assert.equal(selected.available, true);
  assert.deepEqual(await readFile(await manager.prepareInstaller(selected.id)), bytes);

  const { assets } = item.descriptor;
  assert.throws(() => parseDescriptor({ ...item.descriptor, assets: { ...assets,
    installer: { ...assets.installer, size: installerLimit + 1 } } }), {
    name: 'PackageIntegrityError', message: /安裝器.*16777217 bytes.*16 MiB/
  });
});
test('rejects oversized installer downloads before writing to the cache', async t => {
  const item = release();
  const { root, respond } = await context(t, [item]);
  const installerUrl = item.base + item.descriptor.assets.installer.name;
  const oversizedBody = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array(installerLimit));
      controller.enqueue(new Uint8Array(1));
      controller.close();
    }
  });
  const responses = [
    new Response('', { headers: { 'Content-Length': String(installerLimit + 1) } }),
    new Response(oversizedBody, { headers: { 'Content-Length': String(installerLimit) } })
  ];
  for (const response of responses) {
    const manager = new WorkflowKitReleaseManager(root, async input => String(input) === installerUrl ? response : respond(input));
    const [selected] = await manager.refresh('github');
    await assert.rejects(manager.prepareInstaller(selected.id), {
      name: 'PackageIntegrityError', message: /下載附件超過容量限制/
    });
    assert.deepEqual(await readdir(root), []);
  }
});
test('rejects tampered cached executable bytes before running a status helper', async t => {
  const { manager } = await context(t); const [item] = await manager.refresh('github');
  const filename = await manager.prepareInstaller(item.id); await writeFile(filename, 'changed');
  await assert.rejects(manager.statusHelper({ source: 'github', version: '1.0.0' }), (error: Error) => error instanceof PackageIntegrityError && /GitHub Release v1\.0\.0/.test(error.message));
  await assert.rejects(manager.prepareInstaller(item.id), (error: Error) => error instanceof PackageIntegrityError && /GitHub Release v1\.0\.0/.test(error.message));
});
test('a manually installed version obtains only its own verified read-only status helper', async t => {
  const { manager } = await context(t, [release('2.0.0'), release('1.0.0')]);
  const versions = await manager.refresh('github', undefined, '1.0.0');
  assert.deepEqual(versions.map(item => item.version), ['2.0.0', '1.0.0']);
  await manager.prepareStatusVerifier(versions[1].id);
  assert.equal((await manager.statusHelper({ source: 'github', version: '1.0.0' }))?.version, '1.0.0');
  assert.equal(await manager.statusHelper({ source: 'github', version: '2.0.0' }), undefined);
});
test('historical status commands without the read-only capability are not executed', async t => {
  const old = release(); updateDescriptor(old, { statusApi: undefined });
  const { manager } = await context(t, [old]);
  const [item] = await manager.refresh('github'); await manager.prepareInstaller(item.id);
  assert.equal(await manager.statusHelper({ source: 'github', version: item.version }), undefined);
});
test('rejects corrupted download bytes without promoting a package to cache', async t => {
  const item = release(); item.files.set(item.descriptor.assets.package.name, Buffer.from('corrupted'));
  const { manager, root } = await context(t, [item]); const [latest] = await manager.refresh('github');
  await assert.rejects(manager.getRelease(latest.id), PackageIntegrityError);
  assert.ok((await readdir(path.join(root, 'workflow-kit-downloads'))).every(name => name.endsWith('.py')));
});
test('rechecks the selected project before cache writes and installation', async t => {
  const { manager, root } = await context(t); const [item] = await manager.refresh('github');
  let checks = 0;
  await assert.rejects(manager.getRelease(item.id, () => { if (++checks === 2) throw new Error('project changed'); }), /project changed/);
  assert.deepEqual(await readdir(root), []);
});
test('owned release assets are retained while borrowed, then archives are removed while installed verifier pins survive', async t => {
  const { manager, root } = await context(t); const [item] = await manager.refresh('github');
  const project = path.join(root, 'project'); await mkdir(path.join(project, '.gitlab-workspace', 'tool-manifests'), { recursive: true });
  const selected = await manager.acquireRelease(item.id, project, () => {}, () => {});
  await manager.pruneCache(); assert.ok((await readFile(selected.archivePath)).length);
  await writeFile(path.join(project, '.gitlab-workspace', 'tool-manifests', 'workflow-kit.json'), JSON.stringify({ source: 'github', version: item.version }));
  await selected.release(); await assert.rejects(readFile(selected.archivePath), { code: 'ENOENT' });
  assert.ok(await manager.statusHelper({ source: 'github', version: item.version }));
  assert.deepEqual(await manager.useCached('github'), []);
  await rm(path.join(project, '.gitlab-workspace', 'tool-manifests', 'workflow-kit.json'));
  await manager.maintain(project); await assert.rejects(readFile(selected.installerPath), { code: 'ENOENT' });
});
test('a failed installation releases its assets and leaves no unreferenced managed verifier', async t => {
  const { manager, root } = await context(t); const [item] = await manager.refresh('github'), project = path.join(root, 'project'); await mkdir(project);
  const selected = await manager.acquireRelease(item.id, project, () => {}, () => {}); await selected.release();
  await assert.rejects(readFile(selected.archivePath), { code: 'ENOENT' }); await assert.rejects(readFile(selected.installerPath), { code: 'ENOENT' });
});
test('background maintenance skips stale locks for missing release attachments', async t => {
  const { manager, root } = await context(t);
  const [item] = await manager.refresh('github');
  await manager.prepareInstaller(item.id);
  const lock = path.join(root, 'workflow-kit-asset-locks', item.sha256 + '.lock');
  await mkdir(lock, { recursive: true });
  const owner = path.join(lock, 'owner.json');
  await writeFile(owner, '{');
  const acquire = t.mock.method(LocalNetworkLease, 'acquire');

  await manager.maintain();
  await manager.maintain();

  assert.equal(acquire.mock.calls.filter(call => call.arguments[0] === lock).length, 0);
  assert.deepEqual(manager.cleanupWarnings, []);
  assert.equal(await readFile(owner, 'utf8'), '{');
});

test('background maintenance logs an unconfirmed attachment and installation reports the block', async t => {
  const warnings: string[] = [];
  const log = new OperationLog({ info() {}, warn: line => warnings.push(line), error() {} });
  t.after(() => log.dispose());
  const { manager, root } = await context(t, undefined, log);
  const [item] = await manager.refresh('github');
  const { archivePath } = await manager.getRelease(item.id);
  const [cached] = await manager.useCached('github');
  const archive = await readFile(archivePath);
  const lock = path.join(root, 'workflow-kit-asset-locks', item.sha256 + '.lock');
  await mkdir(lock, { recursive: true });
  const owner = path.join(lock, 'owner.json');
  await writeFile(owner, '{');

  await manager.maintain();
  await manager.maintain();

  assert.deepEqual(manager.cleanupWarnings, []);
  assert.deepEqual(await readFile(archivePath), archive);
  assert.equal(await readFile(owner, 'utf8'), '{');
  assert.equal((await manager.listReleases())[0].available, true);
  const diagnostics = warnings.map(line => JSON.parse(line.slice(line.indexOf('{'))));
  assert.equal(diagnostics.filter(detail => detail.leasePath === lock && detail.coordinationCode === 'owner-unconfirmed' &&
    detail.coordinationPhase === 'cleanup').length, 2);
  await assert.rejects(manager.acquireRelease(cached.id, root, () => {}, () => {}), {
    name: 'NetworkLeaseError', coordinationCode: 'owner-unconfirmed', leasePath: lock
  });
});

test('an inaccessible attachment remains cached and its path is logged', async t => {
  const warnings: string[] = [];
  const log = new OperationLog({ info() {}, warn: line => warnings.push(line), error() {} });
  t.after(() => log.dispose());
  const { manager } = await context(t, undefined, log);
  const [item] = await manager.refresh('github');
  const { archivePath } = await manager.getRelease(item.id);
  await manager.useCached('github');
  const archive = await readFile(archivePath);
  const lstat = fs.lstat;
  t.mock.method(fs, 'lstat', async (...args: Parameters<typeof lstat>) => {
    if (args[0] === archivePath) throw Object.assign(new Error('Test attachment access failure'), { code: 'EACCES' });
    return lstat(...args);
  });

  await manager.maintain();

  assert.deepEqual(manager.cleanupWarnings, []);
  assert.deepEqual(await readFile(archivePath), archive);
  assert.equal((await manager.listReleases())[0].available, true);
  const diagnostics = warnings.map(line => JSON.parse(line.slice(line.indexOf('{'))));
  assert.ok(diagnostics.some(detail => detail.targetPath === archivePath && detail.systemCode === 'EACCES' &&
    detail.coordinationPhase === 'cleanup'));
});

test('offline release checks publish availability after status maintenance', async t => {
  const { manager, root } = await context(t);
  const [item] = await manager.refresh('github');
  const { archivePath } = await manager.getRelease(item.id);
  const project = path.join(root, 'project');
  await mkdir(project);
  const offline = new WorkflowKitReleaseManager(root, async () => { throw new Error('Release source unavailable'); });
  const messages: string[] = [];
  const service = new WorkflowKitService({ storagePath: root, extensionDirectory: root, extensionVersion: '0.58.0',
    readSource: () => 'github', writeSource: async () => undefined, pythonPath: () => 'python', reportPhase: () => undefined,
    onMessage: message => messages.push(message), runWithInstallProgress: (_version, task) => task(),
    releaseManager: offline, runHelper: async () => ({ ok: true, status: 'missing' }) });
  t.after(() => service.dispose());
  service.setContext({ root: project, revision: 'project', manual: false });
  const lockRoot = path.join(root, 'workflow-kit-asset-locks');
  await mkdir(lockRoot);
  const lease = await LocalNetworkLease.acquire(path.join(lockRoot, item.sha256 + '.lock'), 'workflow-kit-asset');
  try {
    const [retained] = await service.checkReleases('github', () => {});
    assert.equal(retained.available, true);
    assert.equal(service.snapshot.releases[0].available, true);
    assert.match(messages[0], /顯示同一來源已驗證的完整快取/);
  } finally { await lease.release(); }

  const [cleaned] = await service.checkReleases('github', () => {});

  await assert.rejects(readFile(archivePath), { code: 'ENOENT' });
  assert.equal(cleaned.available, false);
  assert.equal(cleaned.cached, true);
  assert.equal(service.snapshot.releases[0].available, false);
  assert.equal(service.snapshot.releases[0].cached, true);
  assert.match(service.snapshot.releases[0].error ?? '', /請連線重新檢查 Release/);
  assert.match(messages[1], /快取附件已清理/);
  assert.equal(messages.length, 2);
});

test('installation preserves a stopped asset owner and the original error when its first asset cannot be released', async t => {
  const { manager, root, calls } = await context(t);
  const [item] = await manager.refresh('github');
  const project = path.join(root, 'project'); await mkdir(project);
  const lockRoot = path.join(root, 'workflow-kit-asset-locks');
  const [first, blocked] = Object.values(item.descriptor.assets).map(asset => path.join(lockRoot, asset.sha256 + '.lock')).sort();
  await mkdir(blocked, { recursive: true });
  const ownerFile = path.join(blocked, 'owner.json');
  const owner = JSON.stringify({ schema: LEASE_SCHEMA, kind: 'workflow-kit-asset', nonce: randomUUID(), pid: 2147483647,
    createdAt: new Date().toISOString(), state: 'reserved', childPid: null });
  await writeFile(ownerFile, owner);
  const release = LocalNetworkLease.prototype.release;
  t.mock.method(LocalNetworkLease.prototype, 'release', async function (this: LocalNetworkLease, ...args: Parameters<typeof release>) {
    if (this.directory === first) throw new Error('Test release failure');
    return release.apply(this, args);
  });
  calls.length = 0;
  await assert.rejects(manager.acquireRelease(item.id, project, () => {}, () => {}), (error: unknown) => {
    assert.ok(error instanceof NetworkLeaseError);
    assert.equal(error.coordinationCode, 'owner-unconfirmed');
    assert.equal(error.leasePath, blocked);
    assert.match(error.message, /WorkflowKit/);
    return true;
  });
  assert.deepEqual(calls, [], 'the blocked install must not download release assets');
  assert.equal(await readFile(ownerFile, 'utf8'), owner);
  assert.match(manager.cleanupWarnings.join('\n'), /本機鎖尚未釋放/);
});
test('releasing an installed WorkflowKit attempts both asset locks after one release failure', async t => {
  const { manager, root } = await context(t);
  const [item] = await manager.refresh('github');
  const project = path.join(root, 'project');
  const manifests = path.join(project, '.gitlab-workspace', 'tool-manifests'); await mkdir(manifests, { recursive: true });
  const selected = await manager.acquireRelease(item.id, project, () => {}, () => {});
  await writeFile(path.join(manifests, 'workflow-kit.json'), JSON.stringify({ source: 'github', version: item.version }));
  const lockRoot = path.join(root, 'workflow-kit-asset-locks');
  const [first, last] = Object.values(item.descriptor.assets).map(asset => path.join(lockRoot, asset.sha256 + '.lock')).sort().reverse();
  const releases: string[] = [], release = LocalNetworkLease.prototype.release;
  t.mock.method(LocalNetworkLease.prototype, 'release', async function (this: LocalNetworkLease, ...args: Parameters<typeof release>) {
    if (path.dirname(this.directory) === lockRoot) releases.push(this.directory);
    if (this.directory === first) throw new NetworkLeaseError('Test release failure', 'release-pending',
      { leasePath: this.directory, leaseKind: 'workflow-kit-asset' });
    return release.apply(this, args);
  });
  const warnings: string[] = [], log = new OperationLog({ info() {}, error() {}, warn: line => warnings.push(line) });
  t.after(() => log.dispose());
  await log.withContext({}, () => selected.release());
  assert.deepEqual(releases.slice(0, 2), [first, last]);
  await assert.rejects(readFile(path.join(last, 'owner.json')), { code: 'ENOENT' });
  assert.ok((await readFile(path.join(first, 'owner.json'))).length);
  assert.ok(await manager.statusHelper({ source: 'github', version: item.version }), 'the installed verifier remains usable');
  assert.match(manager.cleanupWarnings.join('\n'), /本機鎖尚未釋放/);
  const line = warnings.find(value => value.includes('release-pending'));
  assert.ok(line);
  const details = JSON.parse(line.slice(line.indexOf('{')));
  assert.equal(details.leasePath, first);
  assert.equal(details.coordinationPhase, 'cleanup');
});
test('WorkflowKit background status preserves a missing-owner lock and logs its path before returning status', async t => {
  const output: string[] = [], log = new OperationLog({ info: line => output.push(line), warn: line => output.push(line), error: line => output.push(line) });
  t.after(() => log.dispose());
  const { manager, root, calls } = await context(t, undefined, log);
  const [item] = await manager.refresh('github');
  await manager.prepareInstaller(item.id);
  const project = path.join(root, 'project');
  const manifests = path.join(project, '.gitlab-workspace', 'tool-manifests'); await mkdir(manifests, { recursive: true });
  await writeFile(path.join(manifests, 'workflow-kit.json'), JSON.stringify({ source: 'github', version: item.version }));
  const lock = path.join(root, 'workflow-kit-asset-locks', item.descriptor.assets.installer.sha256 + '.lock');
  await mkdir(lock, { recursive: true });
  let runs = 0;
  const service = new WorkflowKitService({ storagePath: root, extensionDirectory: root, extensionVersion: '0.56.0',
    readSource: () => 'github', writeSource: async () => undefined, pythonPath: () => 'python', reportPhase: () => undefined,
    runWithInstallProgress: (_version, task) => task(), releaseManager: manager,
    runHelper: async () => {
      const helper = await service.statusHelper(project);
      runs++;
      await helper.release?.();
      return { ok: true, status: 'installed', source: 'github', version: item.version };
    } });
  t.after(() => service.dispose());
  service.setContext({ root: project, revision: 'project', manual: false });
  calls.length = 0;
  await service.refreshStatus();
  assert.equal(service.snapshot.state.status, 'error');
  assert.match(service.snapshot.state.message ?? '', /WorkflowKit.*缺少/);
  assert.equal(runs, 0);
  assert.deepEqual(calls, []);
  assert.deepEqual(await readdir(lock), []);
  const line = output.find(value => value.includes('metadata-missing'));
  assert.ok(line);
  const details = JSON.parse(line.slice(line.indexOf('{')));
  assert.equal(details.leasePath, lock);
  assert.equal(details.coordinationPhase, 'admission');

  await rmdir(lock);
  await service.refreshStatus();
  assert.equal(service.snapshot.state.status, 'installed');
  assert.equal(runs, 1);
  assert.deepEqual(calls, []);
});
test('different installed versions sharing an installer hash keep the artifact until the final root releases it', async t => {
  const { manager, root } = await context(t, [release('2.0.0'), release('1.0.0')]);
  const versions = await manager.refresh('github', undefined, '1.0.0'), first = path.join(root, 'first'), second = path.join(root, 'second');
  for (const project of [first, second]) await mkdir(path.join(project, '.gitlab-workspace', 'tool-manifests'), { recursive: true });
  const marker = (project: string) => path.join(project, '.gitlab-workspace', 'tool-manifests', 'workflow-kit.json');
  const older = await manager.acquireRelease(versions[1].id, first, () => {}, () => {});
  await writeFile(marker(first), JSON.stringify({ source: 'github', version: '1.0.0' })); await older.release();
  const newer = await manager.acquireRelease(versions[0].id, second, () => {}, () => {});
  await writeFile(marker(second), JSON.stringify({ source: 'github', version: '2.0.0' })); await newer.release();
  assert.equal(older.installerPath, newer.installerPath);
  await rm(marker(first)); await manager.maintain(first); assert.ok((await readFile(newer.installerPath)).length);
  await rm(marker(second)); await manager.maintain(second); await assert.rejects(readFile(newer.installerPath), { code: 'ENOENT' });
});
test('pruning preserves a shared verifier registered by another window during cleanup', async t => {
  const { manager, root, respond } = await context(t, [release('2.0.0'), release('1.0.0')]);
  const [latest, older] = await manager.refresh('github', undefined, '1.0.0');
  const project = path.join(root, 'project');
  const manifests = path.join(project, '.gitlab-workspace', 'tool-manifests');
  await mkdir(manifests, { recursive: true });
  const installerPath = await manager.prepareStatusVerifier(older.id, undefined, undefined, project);
  const verifier = await readFile(installerPath);
  const otherWindow = new WorkflowKitReleaseManager(root, respond);
  await otherWindow.refresh('github');
  const lock = path.join(root, 'workflow-kit-asset-locks', older.descriptor.assets.installer.sha256 + '.lock');
  const acquire = LocalNetworkLease.acquire;
  let registered = false;
  t.mock.method(LocalNetworkLease, 'acquire', async function (this: typeof LocalNetworkLease, directory, kind, options) {
    if (!registered && directory === lock && options?.timeoutMs === 1) {
      registered = true;
      await writeFile(path.join(manifests, 'workflow-kit.json'), JSON.stringify({ source: 'github', version: latest.version }));
      assert.equal(await otherWindow.prepareStatusVerifier(latest.id, undefined, undefined, project), installerPath);
    }
    return acquire.call(this, directory, kind, options);
  } as typeof acquire);

  await manager.maintain();

  assert.equal(registered, true);
  assert.deepEqual(await readFile(installerPath), verifier);
  assert.deepEqual(await otherWindow.statusHelper({ source: 'github', version: latest.version }), { path: installerPath, version: latest.version });
});

test('supports the intranet Gitea mirror without automatically contacting GitHub', async t => {
  const { manager, calls } = await context(t, [release('1.0.0', 'gitea')]);
  const [item] = await manager.refresh('gitea'); await manager.getRelease(item.id);
  assert.ok(calls.every(url => url.startsWith('https://tech-sharing.cathaysec.com.tw/')));
});
test('reports an unsupported Gitea release without contacting GitHub', async t => {
  const latest = release('2.0.0', 'gitea');
  updateDescriptor(latest, { installerApi: 2 });
  const { manager, calls } = await context(t, [release('1.0.0', 'gitea'), latest]);
  const versions = await manager.refresh('gitea');
  assert.equal(versions[0].available, false); assert.match(versions[0].error!, /安裝介面/);
  assert.equal(versions[1].version, '1.0.0');
  assert.ok(calls.every(url => url.startsWith('https://tech-sharing.cathaysec.com.tw/')));
});
test('accepts Gitea native attachment URLs while keeping downloads on the configured host', async t => {
  const item = release('1.0.0', 'gitea'), { root } = await context(t, []);
  const assets = new Map<string, Buffer>();
  for (const [index, asset] of item.api.assets.entries()) {
    asset.browser_download_url = `https://tech-sharing.cathaysec.com.tw/attachments/fixture-${index}`;
    assets.set(asset.browser_download_url, item.files.get(asset.name)!);
  }
  const manager = new WorkflowKitReleaseManager(root, (async (input: string | URL | Request) => {
    const url = String(input), bytes = assets.get(url);
    return bytes ? new Response(Uint8Array.from(bytes).buffer) : new Response(JSON.stringify([item.api]));
  }) as typeof fetch);
  const [selected] = await manager.refresh('gitea');
  assert.equal((await manager.getRelease(selected.id)).version, '1.0.0');
});
test('rejects descriptor version mismatch and assets outside the configured repository', async t => {
  const mismatch = release(); updateDescriptor(mismatch, { version: '2.0.0' });
  const first = await context(t, [mismatch]);
  assert.match((await first.manager.refresh('github'))[0].error!, /Release tag 與套件版本不符/);
  const item = release(); item.api.assets[0].browser_download_url = 'https://example.com/release.json';
  const second = await context(t, [item]); assert.equal((await second.manager.refresh('github'))[0].available, false);
});
test('handles unavailable sources without silently changing the source', async t => {
  const { root } = await context(t);
  const manager = new WorkflowKitReleaseManager(root, (async () => new Response('', { status: 403 })) as typeof fetch);
  await assert.rejects(manager.refresh('github'), /HTTP 403/); assert.deepEqual(await manager.listReleases(), []);
});
test('a failed metadata download does not probe older releases or another source', async t => {
  const latest = release('2.0.0'), older = release('1.0.0');
  const { root, respond } = await context(t, [latest, older]); const calls: string[] = [];
  const manager = new WorkflowKitReleaseManager(root, (async (input: string | URL | Request) => {
    const url = String(input); calls.push(url);
    if (url === `${latest.base}release.json`) throw new TypeError('network unavailable');
    return respond(input);
  }) as typeof fetch);
  await assert.rejects(manager.refresh('github'), /network unavailable/);
  assert.ok(calls.every(url => !url.includes('/download/v1.0.0/') && !url.includes('tech-sharing.cathaysec.com.tw')));
});
test('rejects oversized metadata, untrusted redirects, cancellation and unknown release IDs', async t => {
  const { root } = await context(t);
  for (const response of [new Response('', { headers: { 'content-length': '99999999' } }), new Response('', { status: 302, headers: { location: 'https://example.com/file' } })]) {
    const manager = new WorkflowKitReleaseManager(root, (async () => response) as typeof fetch);
    await assert.rejects(manager.refresh('github'), PackageIntegrityError);
  }
  const { manager } = await context(t); const abort = new AbortController(); abort.abort();
  await assert.rejects(manager.refresh('github', abort.signal));
  await assert.rejects(manager.getRelease('../../local.zip'), /先檢查/);
});
