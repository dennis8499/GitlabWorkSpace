import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { WorkflowKitReleaseManager, WORKFLOW_KIT_RELEASES, PackageIntegrityError, type ReleaseDescriptor } from '../../src/workspace/workflowKitReleases';

const sha = (data: Uint8Array) => createHash('sha256').update(data).digest('hex');
function release(version = '1.0.0', source: 'github' | 'gitea' = 'github', contract = 2) {
  const zip = Buffer.from('verified release ZIP'), installer = Buffer.from('verified release installer');
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
async function context(t: { after: (callback: () => Promise<unknown>) => void }, releases = [release()]) {
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
  const manager = new WorkflowKitReleaseManager(root, respond as typeof fetch);
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
