import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateReleaseManifest } from './release-policy.mjs';

const repositoryRoot = fileURLToPath(new URL('../', import.meta.url));
const tag = process.env.GITHUB_REF_NAME;
if (!tag) {
  throw new Error('GITHUB_REF_NAME must contain the tag name');
}

const [manifestText, lockfileText] = await Promise.all([
  readFile(join(repositoryRoot, 'package.json'), 'utf8'),
  readFile(join(repositoryRoot, 'package-lock.json'), 'utf8')
]);
const manifest = JSON.parse(manifestText);
const lockfile = JSON.parse(lockfileText);
const ancestry = spawnSync('git', ['merge-base', '--is-ancestor', 'HEAD', 'origin/main'], {
  cwd: repositoryRoot,
  stdio: 'ignore'
});

if (ancestry.error) {
  throw ancestry.error;
}

const release = validateReleaseManifest({
  tag,
  manifest,
  lockfile,
  isOnMain: ancestry.status === 0
});

console.log(`Validated ${tag}; ${release.assetName}; prerelease=${release.prerelease}`);
