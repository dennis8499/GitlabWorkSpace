import path from 'node:path';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, realpath, writeFile } from 'node:fs/promises';
import * as vscode from 'vscode';
import { readTaskWorkspace } from '../../src/codex/taskWorkspace';
import { sanitizeDiagnostic } from '../../src/logging/diagnosticText';

const samePath = (left: string, right: string): boolean => process.platform === 'win32'
  ? path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase() : path.resolve(left) === path.resolve(right);

async function holdManagedOwner(workspaceFile: string): Promise<void> {
  const evidence = process.env.GLW_CODEX_LIVE_EVIDENCE!;
  let taskId = path.basename(path.dirname(workspaceFile));
  if (!/^[a-z0-9-]{1,100}$/i.test(taskId)) taskId = 'unknown';
  try {
    const userData = await realpath(process.env.GLW_CODEX_LIVE_USER_DATA!);
    const storage = path.join(userData, 'User', 'globalStorage', 'local-dev.gitlab-workspace');
    const launch = await readTaskWorkspace(storage, workspaceFile);
    assert.ok(samePath(await realpath(launch.binding.originRoot), await realpath(process.env.GLW_CODEX_LIVE_ROOT!)));
    assert.equal(launch.binding.taskId, taskId);
    assert.ok(launch.owner && launch.owner.pid === process.pid && launch.owner.generation > 0);
    const extension = vscode.extensions.getExtension('local-dev.gitlab-workspace');
    assert.ok(extension?.isActive, 'the real managed marker must activate the candidate before the test bootstrap');
    // This API is exported only in ExtensionMode.Test. Reading it neither activates nor controls the extension.
    assert.equal(typeof extension.exports?.getWorkspaceForTesting, 'function');
    const candidate = process.env.GLW_CODEX_LIVE_CANDIDATE_EXTENSION!, installed = process.env.GLW_CODEX_LIVE_INSTALLED_EXTENSION!;
    const hashes: Record<string, string> = {};
    for (const file of ['out/src/extension.js', 'out/src/codex/bridge.js', 'out/src/workspace/workspacePanel.js', 'resources/issue-webview/dashboard.js']) {
      const digest = async (root: string): Promise<string> => createHash('sha256').update(await readFile(path.join(root, file))).digest('hex');
      hashes[file] = await digest(extension.extensionPath);
      assert.equal(hashes[file], await digest(candidate)); assert.equal(hashes[file], await digest(installed));
    }
    await writeFile(path.join(evidence, `owner-role-${taskId}-${process.pid}.json`), JSON.stringify({
      schema: 'GitLabWorkspaceCodexLiveOwnerRole/v1', role: 'managed-owner', pid: process.pid, taskId,
      generation: launch.owner.generation, inheritedTestContext: true, ownerExtensionMode: 'Test',
      candidateBytesMatch: true, hashes, extensionPath: extension.extensionPath, mochaLoaded: false
    }, null, 2));
  } catch (error) {
    await writeFile(path.join(evidence, `owner-role-failed-${taskId}-${process.pid}.json`), JSON.stringify({
      schema: 'GitLabWorkspaceCodexLiveOwnerRole/v1', role: 'managed-owner-invalid', pid: process.pid, taskId,
      inheritedTestContext: true, mochaLoaded: false,
      error: sanitizeDiagnostic(error instanceof Error ? error.message : 'Managed owner bootstrap validation failed')
    }, null, 2)).catch(() => {});
  }
  // A resolved child test runner makes VS Code exit the entire test instance.
  // Activation/owner claim remains the product's native marker-driven work.
  await new Promise<void>(() => {});
}

export async function run(): Promise<void> {
  const workspaceFile = vscode.workspace.workspaceFile;
  if (process.env.GLW_CODEX_LIVE === '1' && workspaceFile?.scheme === 'file' && path.basename(workspaceFile.fsPath) === 'task.code-workspace') {
    await holdManagedOwner(workspaceFile.fsPath); return;
  }
  const Mocha = require(require.resolve('mocha', { paths: [path.dirname(require.resolve('@vscode/test-cli'))] }));
  const mocha = new Mocha({ ui: 'tdd', timeout: 1_500_000 });
  mocha.addFile(path.resolve(__dirname, '../extension/codexFlow.test.js'));
  mocha.addFile(path.resolve(__dirname, '../extension/codexGroupFlow.test.js'));
  await new Promise<void>((resolve, reject) => mocha.run((failures: number) => failures ? reject(new Error(`${failures} Codex live checks failed`)) : resolve()));
}
