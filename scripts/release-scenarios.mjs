import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import {
  releaseAssetName,
  releaseIsPrerelease,
  validateReleaseManifest
} from './release-policy.mjs';

const root = resolve(import.meta.dirname, '..');
const manifest = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
const lockfile = JSON.parse(readFileSync(resolve(root, 'package-lock.json'), 'utf8'));
const workflow = readFileSync(resolve(root, '.github/workflows/release.yml'), 'utf8');
const results = [];

function scenario(id, check) {
  try {
    check();
    results.push({ id, status: 'passed', reason: 'automated release behavior verified' });
  } catch (error) {
    results.push({ id, status: 'failed', reason: error instanceof Error ? error.message : String(error) });
  }
}

scenario('BDD-REL-001', () => {
  const ancestry = spawnSync('git', ['merge-base', '--is-ancestor', 'HEAD', 'origin/main'], { cwd: root });
  assert.equal(ancestry.status, 0, 'current commit must be on origin/main history');
  assert.equal(validateReleaseManifest({
    tag: `v${manifest.version}`,
    manifest,
    lockfile,
    isOnMain: true
  }).version, manifest.version);
  for (const tag of ['0.1.0', 'v01.2.3', 'v1.2', 'v1.2.3-']) {
    assert.throws(() => validateReleaseManifest({ tag, manifest, lockfile, isOnMain: true }));
  }
  assert.throws(() => validateReleaseManifest({
    tag: 'v0.1.1', manifest, lockfile, isOnMain: true
  }));
  assert.throws(() => validateReleaseManifest({
    tag: `v${manifest.version}`, manifest, lockfile, isOnMain: false
  }));
});

scenario('BDD-REL-002', () => {
  const asset = releaseAssetName(manifest);
  assert.equal(asset, `gitlab-workspace-${manifest.version}.vsix`);
  assert.ok(existsSync(resolve(root, 'dist', asset)), `missing dist/${asset}; run npm run package first`);
  const python = process.platform === 'win32' ? 'python' : 'python3';
  const result = spawnSync(python, ['scripts/verify-vsix.py'], { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.stdout || 'VSIX verifier failed');
});

scenario('BDD-REL-003', () => {
  assert.match(workflow, /npm ci/);
  assert.match(workflow, /npm run check:release/);
  assert.match(workflow, /xvfb-run\s+-a\s+npm test/);
  assert.match(workflow, /npm run package/);
  assert.match(workflow, /needs:\s*build/);
  assert.match(workflow, /if-no-files-found:\s*error/);
  assert.match(workflow, /gh release view[\s\S]*?exit 1/);
  assert.doesNotMatch(workflow, /--clobber/);
});

scenario('BDD-REL-004', () => {
  assert.equal(releaseIsPrerelease('v0.1.0'), true);
  assert.equal(releaseIsPrerelease('v1.2.3-beta.1'), true);
  assert.equal(releaseIsPrerelease('v1.2.3+build-7'), false);
  assert.equal(releaseIsPrerelease('v1.2.3'), false);
  assert.match(workflow, /TAG_NAME.*v0\.1\.0.*\^v\[\^\+\]\*-/s);
});

scenario('BDD-REL-005', () => {
  assert.equal(manifest.version, '0.1.0');
  assert.ok(existsSync(resolve(root, 'dist', releaseAssetName(manifest))));
});

console.log(JSON.stringify({ scenarios: results }));
if (results.some(({ status }) => status !== 'passed')) {
  process.exitCode = 1;
}
