import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
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

test('extension upgrade keeps prior imports while offering only current-version packages', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'workspace-kit-upgrade-'));
  try {
    const storage = path.join(root, 'storage');
    const bundledPath = path.join(root, 'workflow-kit.tar.xz');
    const manifestPath = path.join(root, 'manifest.json');
    const downloaded = path.join(root, 'release.zip');
    const oldBytes = Buffer.from('0.14.0 imported ZIP');
    await writeFile(downloaded, oldBytes);
    const oldManager = new WorkflowKitPackageManager(storage, bundledPath, manifestPath, '0.14.0');
    const previous = await oldManager.importPackage({
      version: '0.14.0', source: 'gitea', assetName: 'gitlab-workspace-kit-0.14.0.zip',
      archivePath: downloaded, verifiedSha256: sha256(oldBytes)
    });
    const bundledBytes = Buffer.from('0.15.0 bundled TAR.XZ');
    const currentBytes = Buffer.from('0.15.0 imported ZIP');
    await writeFile(bundledPath, bundledBytes);
    await writeFile(manifestPath, JSON.stringify({
      ...createIndex(bundledBytes, currentBytes), version: '0.15.0', releaseZip: 'gitlab-workspace-kit-0.15.0.zip'
    }));
    const upgraded = new WorkflowKitPackageManager(storage, bundledPath, manifestPath, '0.15.0');
    const available = await upgraded.listPackages();
    assert.deepEqual(available.map(item => [item.version, item.source, item.available]), [['0.15.0', 'bundled', true]]);
    await assert.rejects(upgraded.getPackage(previous.id), /找不到所選套件/);
    await writeFile(downloaded, currentBytes);
    await upgraded.importPackage({ version: '0.15.0', source: 'gitea', assetName: 'gitlab-workspace-kit-0.15.0.zip',
      archivePath: downloaded, verifiedSha256: sha256(currentBytes) });
    assert.deepEqual((await upgraded.listPackages()).map(item => [item.version, item.source]),
      [['0.15.0', 'bundled'], ['0.15.0', 'gitea']]);
    const records = JSON.parse(await readFile(path.join(storage, 'workflow-kit-packages.json'), 'utf8'));
    assert.deepEqual(records.packages.map((item: { version: string }) => item.version), ['0.14.0', '0.15.0']);
    assert.deepEqual(await readFile(previous.archivePath), oldBytes);
    const restored = new WorkflowKitPackageManager(storage, path.join(root, 'missing14.tar.xz'), path.join(root, 'missing14.json'), '0.14.0');
    assert.equal((await restored.getPackage(previous.id)).version, '0.14.0');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('import rechecks access before writing and publishing, removing temporary files after a policy change', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'workspace-kit-import-policy-'));
  try {
    const source = path.join(root, 'release.zip');
    const contents = Buffer.from('verified package bytes');
    await writeFile(source, contents);
    for (const deniedCheck of [1, 3, 5]) {
      const storage = path.join(root, `storage-${deniedCheck}`);
      const manager = new WorkflowKitPackageManager(storage, path.join(root, 'missing.tar.xz'), path.join(root, 'missing.json'), '0.15.0');
      let checks = 0;
      await assert.rejects(manager.importPackage({ version: '0.15.0', source: 'github', assetName: 'release.zip',
        archivePath: source, verifiedSha256: sha256(contents) }, () => {
        if (++checks === deniedCheck) throw new Error('Group policy changed');
      }), /Group policy changed/);
      assert.equal(checks, deniedCheck);
      assert.deepEqual(await manager.listPackages(), []);
      await assert.rejects(readFile(path.join(storage, 'workflow-kit-packages.json')), { code: 'ENOENT' });
      const files = await readdir(storage, { recursive: true }).catch(error => {
        if (error.code !== 'ENOENT') throw error;
        return [] as string[];
      });
      assert.equal(files.some(file => file.endsWith('.tmp')), false);
      if (deniedCheck <= 3) assert.equal(files.some(file => file.endsWith('.zip')), false);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});
