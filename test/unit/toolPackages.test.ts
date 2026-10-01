import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { PackageIntegrityError, ToolPackageManager, TOOL_DEFINITIONS } from '../../src/workspace/toolPackages';

const sha256 = (value: Uint8Array): string => createHash('sha256').update(value).digest('hex');

test('lists Gitea first, then GitHub, then bundled packages without querying a release service', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'workspace-tool-packages-'));
  try {
    const storage = path.join(root, 'storage');
    const sourceDir = path.join(root, 'downloads');
    await mkdir(sourceDir);
    const importedBytes = Buffer.from('official package zip bytes');
    const importedPath = path.join(sourceDir, 'release.zip');
    await writeFile(importedPath, importedBytes);
    const bundlePath = path.join(root, 'offline-tools.tar.xz');
    const bundleBytes = Buffer.from('tar.xz bytes');
    await writeFile(bundlePath, bundleBytes);
    const manifestPath = path.join(root, 'manifest.json');
    await writeFile(manifestPath, JSON.stringify({
      schema: 'gitlab-workspace-offline-tools/v1', archive: 'offline-tools.tar.xz', format: 'tar.xz', archiveSha256: sha256(bundleBytes),
      tools: Object.fromEntries(Object.entries(TOOL_DEFINITIONS).map(([tool, definition]) => [tool, {
        version: '0.2.0', entryRoot: tool, assetName: 'release.zip', releaseUrl: `${definition.githubReleaseUrl}/tag/v0.2.0`,
        upstreamZipSha256: 'a'.repeat(64)
      }]))
    }));
    const manager = new ToolPackageManager(storage, bundlePath, manifestPath);
    const imported = await manager.importPackage({
      tool: 'megin', version: '1.0.0', source: 'github', assetName: 'release.zip', archivePath: importedPath, verifiedSha256: sha256(importedBytes)
    });
    const giteaBytes = Buffer.from('another release ZIP');
    const giteaPath = path.join(sourceDir, 'gitea.zip');
    await writeFile(giteaPath, giteaBytes);
    await manager.importPackage({
      tool: 'megin', version: '1.1.0', source: 'gitea', assetName: 'gitea.zip', archivePath: giteaPath, verifiedSha256: sha256(giteaBytes)
    });

    const packages = await manager.listPackages();
    assert.deepEqual(packages.filter((item) => item.tool === 'megin').map((item) => item.source), ['gitea', 'github', 'bundled']);
    assert.equal((await manager.getPackage('megin', imported.id)).sha256, sha256(importedBytes));
    assert.equal(TOOL_DEFINITIONS.megin.giteaReleaseUrl, 'https://tech-sharing.cathaysec.com.tw/01002903/Megin/releases');
    assert.equal(packages.find((item) => item.id === imported.id)?.available, true);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('keeps imported ZIPs in extension storage after the original download is removed and detects tampering on install', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'workspace-tool-persistence-'));
  try {
    const storage = path.join(root, 'global-storage');
    const source = path.join(root, 'merge-reviewer.zip');
    const contents = Buffer.from('persistent source bytes');
    await writeFile(source, contents);
    const manager = new ToolPackageManager(storage, path.join(root, 'missing.tar.xz'), path.join(root, 'missing.json'));
    const saved = await manager.importPackage({
      tool: 'merge-reviewer', version: '0.4.0', source: 'gitea', assetName: 'merge-reviewer.zip', archivePath: source, verifiedSha256: sha256(contents)
    });
    await rm(source);
    const afterRestart = new ToolPackageManager(storage, path.join(root, 'missing.tar.xz'), path.join(root, 'missing.json'));
    assert.equal((await afterRestart.getPackage('merge-reviewer', saved.id)).version, '0.4.0');
    await writeFile(saved.archivePath, 'changed');
    await assert.rejects(afterRestart.getPackage('merge-reviewer', saved.id), PackageIntegrityError);
    const catalog = JSON.parse(await readFile(path.join(storage, 'tool-packages.json'), 'utf8')) as { packages: unknown[] };
    assert.equal(catalog.packages.length, 1);
  } finally { await rm(root, { recursive: true, force: true }); }
});
