import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { inspectHostExecutable, isolatedHostEnvironment, prepareHost } from './extension-test-environment.mjs';

const require = createRequire(import.meta.url);
const cli = path.join(path.dirname(require.resolve('@vscode/test-cli')), 'bin.mjs');
const argumentsToCli = process.argv.slice(2);
if (argumentsToCli[0] === '--preflight') {
  if (argumentsToCli.length !== 2) throw new Error('Supply the host preflight JSON output path.');
  const proof = await prepareHost();
  await writeFile(argumentsToCli[1], `${JSON.stringify(proof, null, 2)}\n`);
  console.log(JSON.stringify(proof));
  process.exit(0);
}
let proof;
if (argumentsToCli[0] === '--preflight-file') {
  const filename = argumentsToCli[1];
  if (!filename) throw new Error('Supply the host preflight JSON path.');
  proof = JSON.parse(await readFile(filename, 'utf8'));
  if (proof.schema !== 'gitlab-workspace-extension-host/v1') throw new Error('Invalid host preflight proof.');
  const inspected = await inspectHostExecutable(proof.executable, proof.requested);
  if (inspected.version !== proof.version) throw new Error('The VS Code installation changed after preflight.');
  argumentsToCli.splice(0, 2);
}
const { env, removed } = isolatedHostEnvironment();
console.log(`Extension Host isolation removed inherited keys: ${removed.join(', ') || '(none)'}`);
if (proof) env.VSCODE_EXECUTABLE_PATH = proof.executable;
const tempParent = await realpath(os.tmpdir());
const prefix = 'gitlab-workspace-host-tests-';
const temporaryRoot = await mkdtemp(path.join(tempParent, prefix));
try {
  const networkRuntime = path.join(temporaryRoot, 'network-runtime');
  await mkdir(networkRuntime);
  await writeFile(path.join(networkRuntime, 'network-policy.json'), JSON.stringify({ schema: 'GitLabWorkspaceNetworkPolicy/v1', api: { startsPerSecond: 10000, concurrency: 128 } }));
  // updateWorkspaceFolders and workspace settings persist to the workspace file.
  // Give VS Code its own copy so a failed/interrupted suite cannot edit a tracked fixture.
  const workspaceFile = path.join(temporaryRoot, 'host.code-workspace');
  await writeFile(workspaceFile, await readFile(new URL('../test/fixtures/host.code-workspace', import.meta.url)));
  process.exitCode = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, ...argumentsToCli], {
      stdio: 'inherit', windowsHide: true,
      env: { ...env, GITLAB_WORKSPACE_TEST_TMP: temporaryRoot, GITLAB_WORKSPACE_TEST_WORKSPACE: workspaceFile, GITLAB_WORKSPACE_RUNTIME_DIR: networkRuntime }
    });
    child.once('error', reject);
    child.once('close', code => resolve(code ?? 1));
  });
} finally {
  // Windows workbench watchers can retain .git handles until the test window exits.
  const target = await realpath(temporaryRoot);
  if (path.dirname(target) !== tempParent || !path.basename(target).startsWith(prefix)) throw new Error('Unsafe Extension Host fixture cleanup path.');
  if (process.exitCode) console.error(`Extension Host failed; isolated logs retained at ${target}`);
  else await rm(target, { recursive: true, force: true, maxRetries: 12, retryDelay: 100 });
}
