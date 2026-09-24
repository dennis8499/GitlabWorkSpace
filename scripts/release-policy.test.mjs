import assert from 'node:assert/strict';
import test from 'node:test';
import {
  releaseAssetName,
  releaseIsPrerelease,
  validateReleaseManifest
} from './release-policy.mjs';

const manifest = { name: 'gitlab-workspace', version: '0.1.0' };
const lockfile = {
  name: 'gitlab-workspace',
  version: '0.1.0',
  packages: { '': { name: 'gitlab-workspace', version: '0.1.0' } }
};

test('[BDD-REL-001] accepts a tag when manifest, lockfile, and main ancestry agree', () => {
  assert.deepEqual(validateReleaseManifest({
    tag: 'v0.1.0',
    manifest,
    lockfile,
    isOnMain: true
  }), {
    version: '0.1.0',
    assetName: 'gitlab-workspace-0.1.0.vsix',
    prerelease: true
  });
});

test('[BDD-REL-001] rejects malformed tags and mismatched manifests', () => {
  for (const tag of ['0.1.0', 'v01.2.3', 'v1.2', 'v1.2.3-', 'v1.2.3..beta']) {
    assert.throws(() => validateReleaseManifest({ tag, manifest, lockfile, isOnMain: true }), /semantic version/i);
  }

  assert.throws(() => validateReleaseManifest({
    tag: 'v0.1.1', manifest, lockfile, isOnMain: true
  }), /does not match package.json/i);

  assert.throws(() => validateReleaseManifest({
    tag: 'v0.1.0',
    manifest,
    lockfile: { ...lockfile, packages: { '': { version: '0.1.1' } } },
    isOnMain: true
  }), /does not match package-lock.json/i);

  assert.throws(() => validateReleaseManifest({
    tag: 'v0.1.0', manifest, lockfile, isOnMain: false
  }), /contained in main/i);
});

test('[BDD-REL-002] derives the VSIX filename from package name and version', () => {
  assert.equal(releaseAssetName(manifest), 'gitlab-workspace-0.1.0.vsix');
  assert.equal(releaseAssetName({ name: 'sample-extension', version: '2.4.0' }), 'sample-extension-2.4.0.vsix');
});

test('[BDD-REL-004] marks only v0.1.0 and semantic prerelease versions as prereleases', () => {
  assert.equal(releaseIsPrerelease('v0.1.0'), true);
  assert.equal(releaseIsPrerelease('v1.2.3-beta.1'), true);
  assert.equal(releaseIsPrerelease('v0.1.1'), false);
  assert.equal(releaseIsPrerelease('v1.2.3'), false);
  assert.throws(() => releaseIsPrerelease('v1.2'), /semantic version/i);
});
