import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { PackageIntegrityError, WorkflowKitPackageManager } from '../../src/workspace/toolPackages';

const sha256 = (value: Uint8Array): string => createHash('sha256').update(value).digest('hex');
const createIndex = (archive: Buffer, zip: Buffer) => ({
  schema: 'gitlab-workspace-kit-bundle/v1', package: 'gitlab-workspace-kit', version: '0.10.0',
  archive: 'workflow-kit.tar.xz', format: 'tar.xz', archiveSha256: sha256(archive),
  releaseZip: 'gitlab-workspace-kit-0.10.0.zip', releaseZipSha256: sha256(zip), workspaceContract: 2, payloadFiles: 141
});

test('lists a single bundled kit first, then Gitea and GitHub imports for the extension version', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'workspace-kit-packages-'));
  try {
    const storage = path.join(root, 'storage');
    const sourceDir = path.join(root, 'downloads');
    await mkdir(sourceDir);
    const bundledBytes = Buffer.from('tar.xz package bytes');
    const zipBytes = Buffer.from('release ZIP package bytes');
    const bundledPath = path.join(root, 'workflow-kit.tar.xz');
    const releaseZip = path.join(root, 'gitlab-workspace-kit-0.10.0.zip');
    const manifestPath = path.join(root, 'manifest.json');
    await writeFile(bundledPath, bundledBytes);
    await writeFile(releaseZip, zipBytes);
    await writeFile(manifestPath, JSON.stringify(createIndex(bundledBytes, zipBytes)));
    const manager = new WorkflowKitPackageManager(storage, bundledPath, manifestPath, '0.10.0');
    const importedRecords: string[] = [];
    for (const source of ['github', 'gitea'] as const) {
      const downloaded = path.join(sourceDir, `${source}.zip`);
      const bytes = Buffer.from(`${source} workflow kit ZIP`);
      await writeFile(downloaded, bytes);
      const saved = await manager.importPackage({ version: '0.10.0', source, assetName: path.basename(downloaded), archivePath: downloaded, verifiedSha256: sha256(bytes) });
      importedRecords.push(saved.id);
    }
    const packages = await manager.listPackages();
    assert.deepEqual(packages.map((item) => item.source), ['bundled', 'gitea', 'github']);
    assert.equal(packages.length, 3);
    assert.equal((await manager.getPackage(importedRecords[1]!)).version, '0.10.0');
    assert.equal(packages.find((item) => item.source === 'bundled')?.assetName, 'workflow-kit.tar.xz');
    const conflictingArchive = path.join(sourceDir, 'gitea-conflicting.zip');
    const conflictingBytes = Buffer.from('different same-version package');
    await writeFile(conflictingArchive, conflictingBytes);
    await assert.rejects(manager.importPackage({
      version: '0.10.0', source: 'gitea', assetName: path.basename(conflictingArchive), archivePath: conflictingArchive,
      verifiedSha256: sha256(conflictingBytes)
    }), PackageIntegrityError);
    await assert.rejects(manager.importPackage({
      version: '0.8.0', source: 'gitea', assetName: 'old.zip', archivePath: path.join(sourceDir, 'gitea.zip'), verifiedSha256: sha256(Buffer.from('gitea workflow kit ZIP'))
    }), PackageIntegrityError);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('keeps imported kit ZIPs in extension storage and detects tampering before installation', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'workspace-kit-persistence-'));
  try {
    const storage = path.join(root, 'global-storage');
    const source = path.join(root, 'gitlab-workspace-kit.zip');
    const contents = Buffer.from('persistent workflow kit bytes');
    await writeFile(source, contents);
    const manager = new WorkflowKitPackageManager(storage, path.join(root, 'missing.tar.xz'), path.join(root, 'missing.json'), '0.10.0');
    const saved = await manager.importPackage({ version: '0.10.0', source: 'gitea', assetName: 'gitlab-workspace-kit.zip', archivePath: source, verifiedSha256: sha256(contents) });
    await rm(source);
    const afterRestart = new WorkflowKitPackageManager(storage, path.join(root, 'missing.tar.xz'), path.join(root, 'missing.json'), '0.10.0');
    assert.equal((await afterRestart.getPackage(saved.id)).version, '0.10.0');
    await writeFile(saved.archivePath, 'changed');
    await assert.rejects(afterRestart.getPackage(saved.id), PackageIntegrityError);
    const catalog = JSON.parse(await readFile(path.join(storage, 'workflow-kit-packages.json'), 'utf8')) as { packages: unknown[] };
    assert.equal(catalog.packages.length, 1);
  } finally { await rm(root, { recursive: true, force: true }); }
});
