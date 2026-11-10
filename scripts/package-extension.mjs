import { spawnSync } from 'node:child_process';
import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { releaseAssetName } from './release-policy.mjs';
import { assertPrepared, hasValidationLease } from './validation-runtime.mjs';

const repositoryRoot = fileURLToPath(new URL('../', import.meta.url));
const manifest = JSON.parse(await readFile(join(repositoryRoot, 'package.json'), 'utf8'));
const outputPath = join(repositoryRoot, 'dist', releaseAssetName(manifest));
const vsceCommand = join(repositoryRoot, 'node_modules', '@vscode', 'vsce', 'vsce');
const pythonRunner = join(repositoryRoot, 'scripts', 'run-python.mjs');

function runPython(script) {
  const result = spawnSync(process.execPath, [pythonRunner, join(repositoryRoot, script)], {
    cwd: repositoryRoot,
    stdio: 'inherit',
    windowsHide: true
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

const prepared = process.argv.slice(2).includes('--prepared');
// Direct invocations use the same lock/preparation path as npm run package.
if (!await hasValidationLease(repositoryRoot)) {
  const validation = spawnSync(process.execPath, [join(repositoryRoot, 'scripts/run-validation.mjs'), 'package', ...(prepared ? ['--prepared'] : [])],
    { cwd: repositoryRoot, stdio: 'inherit', windowsHide: true });
  if (validation.error) throw validation.error;
  process.exit(validation.status ?? 1);
}
if (prepared) await assertPrepared(repositoryRoot, ['compile', 'webview']);
await mkdir(join(repositoryRoot, 'dist'), { recursive: true });

const result = spawnSync(process.execPath, [
  vsceCommand,
  'package',
  '--out', outputPath,
  '--allow-missing-repository'
], { cwd: repositoryRoot, stdio: 'inherit', windowsHide: true,
  env: { ...process.env, ...(prepared ? { GITLAB_WORKSPACE_PREPARED: '1' } : {}) } });

if (result.error) {
  throw result.error;
}
if (result.status !== 0) {
  process.exitCode = result.status ?? 1;
} else {
  runPython('scripts/optimize-vsix.py');
  runPython('scripts/write-release-checksums.py');
}
