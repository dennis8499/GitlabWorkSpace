import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { WorkflowKitService, type WorkflowKitContext } from '../../src/workspace/workflowKitService';

function packageManager(releases: unknown[] = []) {
  return {
    listReleases: async () => releases,
    refresh: async () => releases,
    useCached: async () => releases,
    prepareStatusVerifier: async () => undefined,
    getRelease: async () => releases[0]
  };
}

function options(root: string, releases: unknown[], runHelper: (args: readonly string[], beforeLaunch?: () => void | Promise<void>) => Promise<Record<string, unknown>>) {
  return {
    storagePath: root,
    extensionDirectory: root,
    extensionVersion: '0.38.0',
    readSource: () => 'github',
    writeSource: async () => undefined,
    pythonPath: () => 'python',
    reportPhase: () => undefined,
    runWithInstallProgress: (_version: string, task: () => Promise<Record<string, unknown>>) => task(),
    runHelper: (args: readonly string[], _timeout: number, _installerPath?: string, beforeLaunch?: () => void | Promise<void>) => runHelper(args, beforeLaunch),
    releaseManager: packageManager(releases) as any
  };
}

function context(root: string, revision: string): WorkflowKitContext {
  return { root, revision, profile: 'group', manual: false };
}

test('status replies from a previous project cannot replace the selected project snapshot', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'workflow-kit-service-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  let finishOld!: (value: Record<string, unknown>) => void;
  let started!: () => void;
  const oldStarted = new Promise<void>(resolve => { started = resolve; });
  const pendingOld = new Promise<Record<string, unknown>>(resolve => { finishOld = resolve; });
  const service = new WorkflowKitService(options(root, [], async (args) => args[1] === path.join(root, 'first')
    ? (started(), pendingOld) : { ok: true, status: 'missing' }));
  t.after(() => service.dispose());

  const first = path.join(root, 'first'), second = path.join(root, 'second');
  service.setContext(context(first, 'first-revision'));
  const staleRefresh = service.refreshStatus();
  await oldStarted;
  service.setContext(context(second, 'second-revision'));
  const currentRefresh = service.refreshStatus();
  finishOld({ ok: true, status: 'installed', profile: 'group', version: '1.0.0', workspaceContract: 2, installerApi: 1, capabilities: ['query'] });
  await Promise.all([staleRefresh, currentRefresh]);

  assert.equal(service.snapshot.context?.root, second);
  assert.equal(service.snapshot.state.status, 'missing');
});

test('installation revalidates its context and exposes the installed capability state', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'workflow-kit-service-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const target = path.join(root, 'project');
  await mkdir(target);
  const release = { id: 'github-1.1.0', version: '1.1.0', source: 'github', assetName: 'kit.zip', format: 'zip', entryRoot: 'workflow-kit',
    available: true, descriptor: { statusApi: 1, installerApi: 1, workspaceContract: 2 }, descriptorSha256: 'a'.repeat(64),
    sha256: 'b'.repeat(64), assetUrls: { package: '', installer: '' }, archivePath: 'kit.zip', installerPath: 'installer.py' };
  let installed = false;
  let validated = false;
  const service = new WorkflowKitService(options(root, [release], async (args, beforeLaunch) => {
    if (args[0] === 'status') return installed
      ? { ok: true, status: 'installed', profile: 'group', source: 'github', version: '1.1.0', workspaceContract: 2, installerApi: 1, capabilities: ['query'] }
      : { ok: true, status: 'missing' };
    await beforeLaunch?.();
    installed = true;
    return { ok: true, package: 'gitlab-workspace-kit', version: '1.1.0', profile: 'group', warnings: ['uv 尚未安裝'] };
  }));
  t.after(() => service.dispose());

  service.setContext(context(target, 'revision-1'));
  await service.refreshStatus();
  const result = await service.install('github-1.1.0', {
    canInstall: () => undefined,
    checkAccess: () => undefined,
    validateTarget: async expected => {
      assert.equal(expected.root, target);
      assert.equal(expected.revision, 'revision-1');
      validated = true;
    }
  });
  await service.refreshStatus();

  assert.equal(validated, true);
  assert.deepEqual(result.warnings, ['uv 尚未安裝']);
  assert.equal(service.snapshot.installing, false);
  assert.equal(service.snapshot.state.status, 'installed');
  assert.deepEqual(service.snapshot.state.capabilities, ['query']);
});
