import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, realpath, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import * as vscode from 'vscode';
import { WorkspacePanel } from '../../src/workspace/workspacePanel';

suite('Local workflow kit installation', () => {
  test('installs the real bundled Skills in an offline controller without a selected Group', async function () {
    this.timeout(60_000);
    const temporaryParent = process.env.GITLAB_WORKSPACE_TEST_TMP;
    assert.ok(temporaryParent, 'Use the isolated Extension Host test runner');
    // Wiki's native installer adds its own staging tree; avoid Windows MAX_PATH in the fixture.
    const tempBase = await realpath(os.tmpdir());
    const temporary = await mkdtemp(path.join(tempBase, 'gw-kit-'));
    try {
      const target = path.join(temporary, 'Repo 中文');
      await mkdir(target); await mkdir(path.join(target, '.git'));
      const root = await realpath(target);
      const extensionRoot = path.resolve(__dirname, '../../..');
      const packageJSON = JSON.parse(await readFile(path.join(extensionRoot, 'package.json'), 'utf8'));
      const archivePath = path.join(extensionRoot, 'resources/offline-tools/workflow-kit.tar.xz');
      const selected = { id: 'bundled', archivePath, version: packageJSON.version, source: 'bundled',
        format: 'tar.xz', entryRoot: 'workflow-kit', sha256: createHash('sha256').update(await readFile(archivePath)).digest('hex') };
      const values = new Map<string, unknown>([['gitlabWorkspace.workflowKit.installRoot', root]]);
      const host: any = Object.assign(Object.create(WorkspacePanel.prototype), {
        disposed: false, busy: false, writesInFlight: 0, webviewMessagesReceived: 0,
        workspaceFoldersGeneration: 0, workflowKitRefreshGeneration: 0, workflowKitStatusReads: new Map(),
        workflowKitInstallTarget: { manual: false, state: { status: 'missing' } },
        workflowKitState: { status: 'missing' }, workflowKitSelectingRoot: false,
        session: { getClient: () => { throw new Error('Offline installation must not request a GitLab client'); } },
        context: { extensionUri: vscode.Uri.file(extensionRoot), extension: { packageJSON }, workspaceState: {
          get: (key: string) => values.get(key),
          update: async (key: string, value: unknown) => { values.set(key, value); }
        } },
        packages: { listPackages: async () => [selected], getPackage: async () => selected },
        sendSnapshot: () => undefined, post: () => undefined
      });
      await host.refreshWorkflowKit(false);
      assert.equal(host.workflowKitInstallTarget.state.status, 'missing');
      await host.handleMessage({ type: 'installWorkflowKit', packageId: 'bundled' });
      assert.equal(host.workflowKitInstallTarget.root, root);
      assert.equal(host.workflowKitInstallTarget.state.status, 'installed');
      assert.equal(host.workflowKitState.status, 'missing');
      assert.equal(host.groupRoot, undefined);
      assert.equal((await readdir(path.join(root, '.agents/skills'))).length, 15);
      assert.match(await readFile(path.join(root, '.agents/skills/megin/SKILL.md'), 'utf8'), /Group/);
    } finally {
      assert.equal(path.dirname(await realpath(temporary)), tempBase);
      await rm(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });
});
