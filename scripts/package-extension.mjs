import { spawnSync } from 'node:child_process';
import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { releaseAssetName } from './release-policy.mjs';

const repositoryRoot = fileURLToPath(new URL('../', import.meta.url));
const manifest = JSON.parse(await readFile(join(repositoryRoot, 'package.json'), 'utf8'));
const outputPath = join(repositoryRoot, 'dist', releaseAssetName(manifest));
const vsceCommand = join(repositoryRoot, 'node_modules', '@vscode', 'vsce', 'vsce');

await mkdir(join(repositoryRoot, 'dist'), { recursive: true });

const result = spawnSync(process.execPath, [
  vsceCommand,
  'package',
  '--out', outputPath,
  '--allow-missing-repository'
], { cwd: repositoryRoot, stdio: 'inherit' });

if (result.error) {
  throw result.error;
}
if (result.status !== 0) {
  process.exitCode = result.status ?? 1;
}
