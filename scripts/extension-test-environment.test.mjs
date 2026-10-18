import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { inspectHostExecutable, isolatedHostEnvironment } from './extension-test-environment.mjs';

test('host launch removes inherited Electron/VS Code runtime state and preserves explicit test settings', () => {
  const { env, removed } = isolatedHostEnvironment({ PATH: 'runtime-path', ELECTRON_RUN_AS_NODE: '1',
    ELECTRON_NO_ASAR: '1', VSCODE_IPC_HOOK: 'old-pipe', VSCODE_PORTABLE: 'old-profile', VSCODE_ESM_ENTRYPOINT: 'old-main',
    VSCODE_EXECUTABLE_PATH: 'chosen-editor', VSCODE_TEST_VERSION: '1.90.0', GITLAB_WORKSPACE_LIVE: '1' });
  assert.deepEqual(env, { PATH: 'runtime-path', VSCODE_EXECUTABLE_PATH: 'chosen-editor',
    VSCODE_TEST_VERSION: '1.90.0', GITLAB_WORKSPACE_LIVE: '1' });
  assert.ok(removed.includes('ELECTRON_RUN_AS_NODE'));
  assert.ok(removed.includes('VSCODE_PORTABLE'));
});

test('host preflight rejects a missing, unsupported, or wrong-version editor before long suites', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'glw-host-preflight-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const executable = path.join(root, 'Code.exe');
  await assert.rejects(inspectHostExecutable(executable));
  await writeFile(executable, 'test executable');
  await mkdir(path.join(root, 'resources/app'), { recursive: true });
  const manifest = path.join(root, 'resources/app/package.json');
  await writeFile(manifest, JSON.stringify({ version: '1.89.0' }));
  await assert.rejects(inspectHostExecutable(executable), /1.90\+/);
  await writeFile(manifest, JSON.stringify({ version: '1.90.0' }));
  assert.equal((await inspectHostExecutable(executable, '1.90.0')).version, '1.90.0');
  await assert.rejects(inspectHostExecutable(executable, '1.91.0'), /Requested VS Code/);
  await mkdir(path.join(root, 'bin'), { recursive: true });
  await mkdir(path.join(root, '6d62b1d5da/resources/app'), { recursive: true });
  await writeFile(path.join(root, 'bin/code.cmd'), String.raw`"%~dp0..\Code.exe" "%~dp0..\6d62b1d5da\resources\app\out\cli.js" %*`);
  await writeFile(path.join(root, '6d62b1d5da/resources/app/package.json'), JSON.stringify({ version: '1.142.0' }));
  assert.equal((await inspectHostExecutable(executable, '1.142.0')).version, '1.142.0', 'the shipped launcher selects the active runtime even when an older manifest exists');
});

test('the real test CLI receives a temporary workspace and leaves the tracked fixture untouched', async () => {
  const root = fileURLToPath(new URL('../', import.meta.url));
  const fixture = path.join(root, 'test/fixtures/host.code-workspace');
  const before = await readFile(fixture);
  const child = spawnSync(process.execPath, ['scripts/run-extension-tests.mjs', '--list-configuration'],
    { cwd: root, encoding: 'utf8', windowsHide: true });
  assert.equal(child.status, 0, child.stderr || child.stdout);
  const configurations = JSON.parse(child.stdout.slice(child.stdout.indexOf('[{')));
  const workspace = configurations[0].config.workspaceFolder;
  assert.notEqual(path.resolve(workspace), fixture);
  assert.match(path.basename(path.dirname(workspace)), /^gitlab-workspace-host-tests-/);
  assert.deepEqual(await readFile(fixture), before);
});
