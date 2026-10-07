import { spawn } from 'node:child_process';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const cli = path.join(path.dirname(require.resolve('@vscode/test-cli')), 'bin.mjs');
const tempParent = await realpath(os.tmpdir());
const prefix = 'gitlab-workspace-host-tests-';
const temporaryRoot = await mkdtemp(path.join(tempParent, prefix));
try {
  process.exitCode = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, ...process.argv.slice(2)], {
      stdio: 'inherit', windowsHide: true,
      env: { ...process.env, GITLAB_WORKSPACE_TEST_TMP: temporaryRoot }
    });
    child.once('error', reject);
    child.once('close', code => resolve(code ?? 1));
  });
} finally {
  // Windows workbench watchers can retain .git handles until the test window exits.
  const target = await realpath(temporaryRoot);
  if (path.dirname(target) !== tempParent || !path.basename(target).startsWith(prefix)) throw new Error('Unsafe Extension Host fixture cleanup path.');
  await rm(target, { recursive: true, force: true, maxRetries: 12, retryDelay: 100 });
}
