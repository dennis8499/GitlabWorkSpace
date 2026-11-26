import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { NetworkLeaseError } from '../../src/api/localNetworkLease';
import { windowsExecutionLeases } from '../../src/api/windowsLocalLease';
import { resolveProjectRootContext } from '../../src/workspace/projectRoot';
import { WorkflowKitService, WorkflowKitVersionMismatchError, type WorkflowKitContext } from '../../src/workspace/workflowKitService';
import { readInstalledReviewerBinding } from '../../src/workspace/installedReviewer';
import { workflowKitPythonCommand } from '../../src/workspace/workflowKitRunner';
import * as runnerModule from '../../src/workspace/workflowKitRunner';

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

function latch() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

async function verificationFixture(t: test.TestContext, attestedRunner = true, source = 'bundled') {
  const root = await mkdtemp(path.join(os.tmpdir(), 'kit-attestation-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const assets = {
    '.agents/gitlab-workspace-kit/run.py': '# managed runner',
    '.agents/gitlab-workspace-kit/review_launch.py': '# managed launcher',
    '.agents/gitlab-workspace-kit/runner-capabilities.json': JSON.stringify({ schema: 'WorkflowKitRunnerCapabilities/v1',
      review_launch_request: 1, read_only_inspection: true, ...(attestedRunner ? { read_only_manifest_sha256: true } : {}) }),
    '.agents/skills/merge-reviewer/VERSION': '0.26.1',
    '.agents/skills/merge-reviewer/SKILL.md': '# Managed skill',
    '.agents/skills/merge-reviewer/scripts/review_session.py': '# managed helper',
    '.agents/skills/codebase-wiki/SKILL.md': '# Managed Wiki skill'
  };
  const sha = (contents: Buffer | string) => createHash('sha256').update(contents).digest('hex');
  for (const [relative, content] of Object.entries(assets)) {
    const file = path.join(root, relative);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, content);
  }
  const marker = path.join(root, '.gitlab-workspace', 'tool-manifests', 'workflow-kit.json');
  const files = Object.fromEntries(Object.entries(assets).map(([name, content]) => [name, sha(content)]));
  const agents = path.join(root, 'AGENTS.md');
  const block = 'Managed WorkflowKit instructions.\r\nKeep the selected Repo.';
  await writeFile(agents, `# User notes\r\n<!-- gitlab-workspace-kit:managed:start -->\r\n${block}\r\n<!-- gitlab-workspace-kit:managed:end -->\r\n`);
  const value = { version: attestedRunner ? '1.12.7' : '1.12.5', source, files, agentBlockSha256: sha(block) };
  await mkdir(path.dirname(marker), { recursive: true });
  await writeFile(marker, JSON.stringify(value));
  const attestation = sha(await readFile(marker));
  return { root, marker, value, attestation, sha, agents };
}

test('cold status verification and stale proofs gate runner binding', async t => {
  const f = await verificationFixture(t);
  const calls: string[] = [];
  let allow = false;
  const bind = runnerModule.readWorkflowKitRunnerBinding;
  t.mock.method(runnerModule, 'readWorkflowKitRunnerBinding', (...args: Parameters<typeof bind>) => {
    calls.push('runner');
    return bind(...args);
  });
  const service = new WorkflowKitService(options(f.root, [], async () => {
    calls.push('status');
    return allow ? { ok: true, status: 'installed', integrity: 'verified', statusContract: 1, installedManifestSha256: f.attestation } :
      { ok: true, status: 'error', message: 'installation was not verified' };
  }));
  t.after(() => service.dispose());
  await assert.rejects(service.verifyInstallation(f.root, { reviewer: true }), /installation was not verified/);
  assert.deepEqual(calls, ['status']);
  allow = true;
  const current = await service.verifyInstallation(f.root, { reviewer: true });
  assert.equal(current.marker.sha256, f.attestation);
  assert.deepEqual(calls, ['status', 'status', 'runner']);
  await assert.rejects(service.verifyInstallation(f.root, { reviewer: true, proof: { ...current.marker, transactions: 'changed' } }), /交易狀態/);
  assert.deepEqual(calls, ['status', 'status', 'runner']);
});

test('an expected WorkflowKit version gates status and runner reads and cache reuse requires an exact proof', async t => {
  const f = await verificationFixture(t);
  const calls: string[] = [];
  const bind = runnerModule.readWorkflowKitRunnerBinding;
  t.mock.method(runnerModule, 'readWorkflowKitRunnerBinding', (...args: Parameters<typeof bind>) => { calls.push('runner'); return bind(...args); });
  const service = new WorkflowKitService(options(f.root, [], async () => {
    calls.push('status');
    return { ok: true, status: 'installed', integrity: 'verified', statusContract: 1, installedManifestSha256: f.attestation };
  }));
  t.after(() => service.dispose());
  await assert.rejects(service.verifyInstallation(f.root, { reviewer: true, expectedInstalledVersion: '1.12.6' }), error => {
    assert.ok(error instanceof WorkflowKitVersionMismatchError);
    assert.equal(error.actualVersion, '1.12.7');
    return true;
  });
  const matching = { reviewer: true, expectedInstalledVersion: '1.12.7' };
  const cachedOnly = { ...matching, requireCachedProof: true };
  await assert.rejects(service.verifyInstallation(f.root, cachedOnly), /尚未通過驗證/);
  assert.deepEqual(calls, []);
  await service.verifyInstallation(f.root, matching);
  const reused = await service.verifyInstallation(f.root, cachedOnly);
  assert.equal(reused.marker.sha256, f.attestation);
  assert.deepEqual(calls, ['status', 'runner', 'runner']);
  await writeFile(f.marker, JSON.stringify(f.value) + '\n');
  await assert.rejects(service.verifyInstallation(f.root, cachedOnly), /安裝紀錄或交易狀態/);
  assert.deepEqual(calls, ['status', 'runner', 'runner']);
});

test('unscoped status survives page cancellation and shares the in-flight check', { timeout: 10_000 }, async t => {
  const f = await verificationFixture(t);
  const entered = latch(), release = latch();
  let checks = 0;
  const service = new WorkflowKitService(options(f.root, [], async () => {
    checks++;
    entered.resolve();
    await release.promise;
    return { ok: true, status: 'installed', profile: 'group', version: f.value.version,
      integrity: 'verified', statusContract: 1, installedManifestSha256: f.attestation };
  }));
  t.after(() => { release.resolve(); service.dispose(); });
  service.setContext(context(f.root, 'shared'));
  const owner = new AbortController();
  const page = service.refreshStatus(owner.signal);
  await entered.promise;
  const first = service.refreshStatus(), second = service.refreshStatus();
  const cancelled = new AbortController();
  cancelled.abort();
  assert.equal(await service.refreshStatus(cancelled.signal, true), undefined);
  owner.abort();
  release.resolve();

  const [pageProof, firstProof, secondProof] = await Promise.all([page, first, second]);
  assert.equal(pageProof, undefined);
  assert.equal(firstProof?.sha256, f.attestation);
  assert.deepEqual(secondProof, firstProof);
  assert.equal(service.snapshot.state.version, f.value.version);
  assert.equal(checks, 1);
});

test('a superseded page status cannot publish after the current status', { timeout: 10_000 }, async t => {
  const f = await verificationFixture(t);
  const catalogEntered = latch(), releaseCatalog = latch();
  let catalogs = 0, checks = 0;
  const setup = options(f.root, [], async () => {
    checks++;
    const bytes = await readFile(f.marker);
    return { ok: true, status: 'installed', profile: 'group', version: JSON.parse(bytes.toString('utf8')).version,
      integrity: 'verified', statusContract: 1, installedManifestSha256: f.sha(bytes) };
  });
  setup.releaseManager.listReleases = async () => {
    if (++catalogs === 1) { catalogEntered.resolve(); await releaseCatalog.promise; }
    return [];
  };
  const service = new WorkflowKitService(setup);
  t.after(() => { releaseCatalog.resolve(); service.dispose(); });
  service.setContext(context(f.root, 'same-project'));
  const pageOwner = new AbortController();
  const page = service.refreshStatus(pageOwner.signal);
  await catalogEntered.promise;
  const updated = JSON.stringify({ ...f.value, version: '1.12.8' });
  await writeFile(f.marker, updated);
  const current = service.refreshStatus();
  try {
    const proof = await current;
    assert.equal(proof?.sha256, f.sha(updated));
    assert.equal(service.snapshot.state.version, '1.12.8');
  } finally {
    releaseCatalog.resolve();
    await Promise.allSettled([current, page]);
  }
  assert.equal(await page, undefined);
  assert.equal(pageOwner.signal.aborted, false);
  assert.equal(service.snapshot.state.version, '1.12.8');
  assert.equal(checks, 2);
});

test('a status listener joins the task before its synchronous checking publication', async t => {
  const f = await verificationFixture(t);
  const service = new WorkflowKitService(options(f.root, [], async () => ({ ok: true, status: 'installed',
    version: f.value.version, integrity: 'verified', statusContract: 1, installedManifestSha256: f.attestation })));
  t.after(() => service.dispose());
  service.setContext(context(f.root, 'subscription'));
  const signal = new AbortController().signal;
  let checking = 0;
  let joined: ReturnType<WorkflowKitService['refreshStatus']> | undefined;
  const subscription = service.subscribe(() => {
    if (service.snapshot.state.status === 'checking' && ++checking === 1) joined = service.refreshStatus(signal);
  });
  t.after(() => subscription.dispose());

  const proof = await service.refreshStatus(signal);
  assert.equal(proof?.sha256, f.attestation);
  assert.ok(joined);
  assert.deepEqual(await joined, proof);
  assert.equal(checking, 1);
});

for (const [scenario, brokenCatalog, diagnostic] of [
  ['a missing', undefined, /ENOENT/],
  ['an unreadable JSON', '{', /JSON/],
  ['a malformed', 'null', /支援清單無效/]
] as const) {
  test('remote status retries after ' + scenario + ' support catalog', async t => {
    const [github, gitea] = await Promise.all([verificationFixture(t, false, 'github'), verificationFixture(t, false, 'gitea')]);
    const resources = path.join(github.root, 'resources'), catalog = path.join(resources, 'workflow-kit-status.json');
    await mkdir(resources);
    if (brokenCatalog !== undefined) await writeFile(catalog, brokenCatalog);
    const fs = require('node:fs/promises') as typeof import('node:fs/promises');
    const read = t.mock.method(fs, 'readFile');
    const invoked: string[] = [];
    const setup = options(github.root, [], async () => ({}));
    setup.runHelper = async (args, _timeout, installerPath) => {
      assert.equal(installerPath, path.join(resources, 'workflow-kit-status.py'));
      const f = args[1] === github.root ? github : gitea;
      invoked.push(args[1]);
      return { ok: true, status: 'installed', integrity: 'verified', version: f.value.version, source: f.value.source,
        statusContract: 1, installedManifestSha256: f.attestation };
    };
    const service = new WorkflowKitService(setup);
    t.after(() => service.dispose());
    await assert.rejects(service.verifyInstallation(github.root), diagnostic);
    assert.deepEqual(invoked, []);
    await writeFile(catalog, JSON.stringify({ schema: 'WorkflowKitStatusSupport/v1', versions: [github.value.version] }));
    const installed = await Promise.all([service.verifyInstallation(github.root), service.verifyInstallation(gitea.root)]);
    assert.deepEqual(installed.map(value => value.marker.sha256), [github.attestation, gitea.attestation]);
    assert.deepEqual(invoked.sort(), [github.root, gitea.root].sort());
    assert.equal(read.mock.calls.filter(call => call.arguments[0] === catalog).length, 2);
  });
}

test('verified WorkflowKit probes reuse an unchanged attestation and reject a self-rehashed workspace', async t => {
  const f = await verificationFixture(t);
  let statusReads = 0;
  const service = new WorkflowKitService(options(f.root, [], async () => {
    statusReads++;
    if (f.sha(await readFile(f.marker)) !== f.attestation) return { ok: true, status: 'error', message: 'untrusted manifest' };
    return { ok: true, status: 'installed', integrity: 'verified', version: f.value.version, statusContract: 1, installedManifestSha256: f.attestation };
  }));
  t.after(() => service.dispose());
  const first = await service.verifyInstallation(f.root, { reviewer: true });
  assert.equal(first.marker.sha256, f.attestation);
  assert.deepEqual(await service.verifyInstallation(f.root, { reviewer: true }), first);
  assert.equal(statusReads, 1, 'an unchanged authenticated installation needs one full status read');
  const binding = await readInstalledReviewerBinding(f.root, 'merge-reviewer', first);
  const python = { executable: 'python', args: [], env: {}, version: '3.14.0' };
  const command = await workflowKitPythonCommand(python, binding.workflow_kit_runner, [binding.script_path, 'capabilities'],
    { readOnly: true, installation: first.marker });
  const flag = command.args.indexOf('--expected-install-manifest-sha256');
  assert.ok(flag > 0);
  assert.equal(command.args[flag + 1], f.attestation);

  const helper = '.agents/skills/merge-reviewer/scripts/review_session.py';
  const changed = '# edited helper';
  await writeFile(path.join(f.root, helper), changed);
  await assert.rejects(readInstalledReviewerBinding(f.root, 'merge-reviewer', await service.verifyInstallation(f.root, { reviewer: true })), /安裝紀錄不符/);
  await writeFile(f.marker, JSON.stringify({ ...f.value, files: { ...f.value.files, [helper]: f.sha(changed) } }));
  await assert.rejects(service.verifyInstallation(f.root), /untrusted manifest/);
  await assert.rejects(workflowKitPythonCommand(python, binding.workflow_kit_runner, [binding.script_path, 'capabilities'],
    { readOnly: true, installation: first.marker }), /安裝紀錄或交易狀態在準備指令時已變更/);
});

test('legacy WorkflowKit runs one offline status per action and keeps the original runner interface', async t => {
  const f = await verificationFixture(t, false, 'github');
  const resources = path.join(f.root, 'resources');
  await mkdir(resources);
  await writeFile(path.join(resources, 'workflow-kit-status.json'), JSON.stringify({ schema: 'WorkflowKitStatusSupport/v1', versions: [f.value.version] }));
  const setup = options(f.root, [], async () => ({}));
  const invocations: (string | undefined)[] = [];
  setup.runHelper = async (args, _timeout, installerPath) => {
    invocations.push(installerPath);
    assert.deepEqual(args, ['status', f.root, '--expected-version', f.value.version]);
    return { ok: true, status: 'installed', integrity: 'verified', version: f.value.version, source: f.value.source,
      statusContract: 1, installedManifestSha256: f.attestation };
  };
  const service = new WorkflowKitService(setup);
  t.after(() => service.dispose());
  service.setContext(context(f.root, 'legacy'));
  const proof = await service.refreshStatus();
  assert.ok(proof);
  const first = await service.verifyInstallation(f.root, { reviewer: true, proof });
  assert.equal(invocations.length, 1);
  assert.deepEqual(await service.verifyInstallation(f.root, { reviewer: true }), first);
  const offline = path.join(resources, 'workflow-kit-status.py');
  assert.deepEqual(invocations, [offline, offline]);
  assert.deepEqual(await service.verifyInstallation(f.root, { reviewer: true, expectedInstalledVersion: f.value.version,
    requireCachedProof: true }), first);
  assert.deepEqual(invocations, [offline, offline, offline]);
  const binding = await readInstalledReviewerBinding(f.root, 'merge-reviewer', first);
  const command = await workflowKitPythonCommand({ executable: 'python', args: [], env: {}, version: '3.14.0' }, binding.workflow_kit_runner,
    [binding.script_path, 'capabilities'], { readOnly: true, installation: first.marker });
  assert.ok(command.args.includes('--read-only'));
  assert.equal(command.args.includes('--expected-install-manifest-sha256'), false);
});

test('cached WorkflowKit status uses the packaged adapter and retains the exact Release lease', async t => {
  for (const [version, source] of [['1.3.1', 'github'], ['1.7.0', 'gitea']] as const) await t.test(version, async t => {
    const f = await verificationFixture(t, false, source);
    const manifest = JSON.stringify({ ...f.value, version });
    await writeFile(f.marker, manifest);
    const resources = path.join(f.root, 'resources');
    await mkdir(resources);
    await writeFile(path.join(resources, 'workflow-kit-status.json'), JSON.stringify({ schema: 'WorkflowKitStatusSupport/v1', versions: ['1.12.8'] }));
    const expectedSha = f.sha(manifest);
    const asset = { path: path.join(f.root, 'cached installer.py'), version, size: 250, sha256: 'b'.repeat(64),
      recovery: { directory: path.join(f.root, 'asset.lock'), kind: 'workflow-kit-asset', nonce: 'fixture', pid: process.pid,
        birth: 'observed-birth', directoryId: 'observed-directory' } };
    const setup = options(f.root, [], async () => ({}));
    let held = false, releases = 0, invocations = 0;
    setup.releaseManager.leaseStatusHelper = async (identity: unknown, root: string) => {
      assert.deepEqual(identity, { source, version });
      assert.equal(root, f.root);
      assert.equal(held, false);
      held = true;
      return { ...asset, release: async () => { held = false; releases++; } };
    };
    setup.runHelper = async (args, _timeout, installerPath) => {
      invocations++;
      assert.equal(held, true);
      assert.deepEqual(windowsExecutionLeases(), [asset.recovery]);
      assert.equal(installerPath, path.join(resources, 'workflow-kit-status.py'));
      assert.deepEqual(args, ['status', f.root, '--expected-version', version, '--cached-installer', asset.path,
        '--cached-installer-size', '250', '--cached-installer-sha256', asset.sha256]);
      return { ok: true, status: 'installed', integrity: 'verified', statusContract: 1, source, version,
        installedManifestSha256: expectedSha };
    };
    const service = new WorkflowKitService(setup);
    t.after(() => service.dispose());
    const first = await service.verifyInstallation(f.root, { reviewer: true });
    assert.equal(first.marker.sha256, expectedSha);
    assert.equal(first.marker.version, version);
    assert.equal(first.runner?.read_only_manifest_sha256, undefined);
    await service.verifyInstallation(f.root, { reviewer: true });
    assert.equal(invocations, 2, 'legacy runners still require one complete status for each operation');
    assert.equal(releases, 2);
    assert.equal(held, false);
  });
});

test('cached WorkflowKit status rejects missing evidence and manifest or transaction drift', async t => {
  for (const scenario of ['missing cache', 'missing digest', 'wrong source', 'manifest drift', 'transaction drift'] as const) await t.test(scenario, async t => {
    const f = await verificationFixture(t, false, 'github');
    const resources = path.join(f.root, 'resources');
    await mkdir(resources);
    await writeFile(path.join(resources, 'workflow-kit-status.json'), JSON.stringify({ schema: 'WorkflowKitStatusSupport/v1', versions: ['1.12.8'] }));
    const setup = options(f.root, [], async () => ({}));
    let runs = 0, releases = 0;
    setup.releaseManager.leaseStatusHelper = async () => scenario === 'missing cache' ? undefined : {
      path: path.join(f.root, 'installer.py'), size: 250, sha256: 'c'.repeat(64), version: f.value.version,
      release: async () => { releases++; }
    };
    setup.runHelper = async () => {
      runs++;
      if (scenario === 'manifest drift') await writeFile(f.marker, JSON.stringify({ ...f.value, changed: true }));
      if (scenario === 'transaction drift') await mkdir(path.join(f.root, '.gitlab-workspace', 'tool-installs', 'kit-' + 'a'.repeat(32)), { recursive: true });
      return { ok: true, status: 'installed', integrity: 'verified', statusContract: 1,
        source: scenario === 'wrong source' ? 'gitea' : f.value.source, version: f.value.version,
        installedManifestSha256: scenario === 'missing digest' ? undefined : f.attestation };
    };
    const service = new WorkflowKitService(setup);
    t.after(() => service.dispose());
    service.setContext(context(f.root, 'cached'));
    assert.equal(await service.refreshStatus(), undefined);
    assert.equal(service.snapshot.state.status, 'error');
    const diagnostics = { 'missing cache': /缺少 WorkflowKit.*狀態檢查器/, 'missing digest': /未提供已驗證的安裝紀錄摘要/,
      'wrong source': /安裝紀錄在檢查期間已變更/, 'manifest drift': /安裝紀錄或交易狀態/, 'transaction drift': /安裝紀錄或交易狀態/ };
    assert.match(service.snapshot.state.message ?? '', diagnostics[scenario]);
    assert.equal(runs, scenario === 'missing cache' ? 0 : 1);
    assert.equal(releases, runs);
  });
});

const unknownPackage = { ok: true, status: 'error', statusContract: 1, integrity: 'unverified',
  errorCode: 'unknown-package-identity', message: 'package identity is outside the embedded catalog' };

test('the exact cached verifier can attest a different package of an embedded WorkflowKit version', async t => {
  const f = await verificationFixture(t, true, 'gitea');
  const resources = path.join(f.root, 'resources');
  await mkdir(resources);
  await writeFile(path.join(resources, 'workflow-kit-status.json'),
    JSON.stringify({ schema: 'WorkflowKitStatusSupport/v1', versions: [f.value.version] }));
  const setup = options(f.root, [], async () => ({}));
  const cached = { path: path.join(f.root, 'cached verifier.py'), size: 512, sha256: 'b'.repeat(64) };
  const helperCalls: string[][] = [];
  let leases = 0, releases = 0;
  setup.releaseManager.leaseStatusHelper = async (identity: unknown, root: string) => {
    assert.deepEqual(identity, { source: f.value.source, version: f.value.version });
    assert.equal(root, f.root);
    leases++;
    return { ...cached, release: async () => { releases++; } };
  };
  setup.runHelper = async (args, _timeout, installerPath) => {
    assert.equal(installerPath, path.join(resources, 'workflow-kit-status.py'));
    helperCalls.push([...args]);
    if (!args.includes(cached.path)) return unknownPackage;
    assert.equal(leases, 1);
    assert.equal(releases, 0);
    return { ok: true, status: 'installed', statusContract: 1, integrity: 'verified', version: f.value.version,
      source: f.value.source, installedManifestSha256: f.attestation };
  };
  const service = new WorkflowKitService(setup);
  t.after(() => service.dispose());
  service.setContext(context(f.root, 'same-version'));
  assert.equal((await service.refreshStatus())?.sha256, f.attestation);
  assert.equal(service.snapshot.state.status, 'installed');
  assert.equal(releases, 1);
  const status = ['status', f.root, '--expected-version', f.value.version];
  assert.deepEqual(helperCalls, [status, [...status, '--cached-installer', cached.path,
    '--cached-installer-size', '512', '--cached-installer-sha256', cached.sha256]]);
});

test('same-version status fallback rejects integrity failures and binds to the original snapshot', async t => {
  for (const scenario of [
    { name: 'managed file failure', lookups: 0, cachedRuns: 0, diagnostic: /managed file changed/ },
    { name: 'invalid embedded contract', lookups: 0, cachedRuns: 0, diagnostic: /outside the embedded catalog/ },
    { name: 'marker changed before fallback', lookups: 0, cachedRuns: 0, diagnostic: /安裝紀錄或交易狀態/ },
    { name: 'transaction opened before fallback', lookups: 0, cachedRuns: 0, diagnostic: /安裝紀錄或交易狀態/ },
    { name: 'no cached verifier', lookups: 1, cachedRuns: 0, diagnostic: /缺少 WorkflowKit.*狀態檢查器/ },
    { name: 'marker changed during fallback', lookups: 1, cachedRuns: 1, diagnostic: /安裝紀錄或交易狀態/ },
    { name: 'invalid cached contract', lookups: 1, cachedRuns: 1, diagnostic: /未提供已驗證的安裝紀錄摘要/ }
  ]) await t.test(scenario.name, async t => {
    const f = await verificationFixture(t, true, 'github');
    const resources = path.join(f.root, 'resources');
    await mkdir(resources);
    await writeFile(path.join(resources, 'workflow-kit-status.json'),
      JSON.stringify({ schema: 'WorkflowKitStatusSupport/v1', versions: [f.value.version] }));
    const setup = options(f.root, [], async () => ({}));
    const changedMarker = JSON.stringify({ ...f.value, changed: true });
    let lookups = 0, cachedRuns = 0, releases = 0;
    setup.releaseManager.leaseStatusHelper = async () => {
      lookups++;
      if (scenario.name === 'no cached verifier') return;
      return { path: path.join(f.root, 'cached.py'), size: 512, sha256: 'b'.repeat(64),
        release: async () => { releases++; } };
    };
    setup.runHelper = async args => {
      if (args.includes('--cached-installer')) {
        cachedRuns++;
        if (scenario.name === 'marker changed during fallback') await writeFile(f.marker, changedMarker);
        return { ok: true, status: 'installed', statusContract: scenario.name === 'invalid cached contract' ? 2 : 1,
          integrity: 'verified', version: f.value.version, source: f.value.source,
          installedManifestSha256: f.sha(await readFile(f.marker)) };
      }
      if (scenario.name === 'managed file failure') {
        return { ok: true, status: 'error', statusContract: 1, integrity: 'unverified', message: 'managed file changed' };
      }
      if (scenario.name === 'invalid embedded contract') return { ...unknownPackage, statusContract: 2 };
      if (scenario.name === 'marker changed before fallback') await writeFile(f.marker, changedMarker);
      if (scenario.name === 'transaction opened before fallback') {
        await mkdir(path.join(f.root, '.gitlab-workspace', 'tool-installs', 'kit-' + 'a'.repeat(32)), { recursive: true });
      }
      return unknownPackage;
    };
    const service = new WorkflowKitService(setup);
    t.after(() => service.dispose());
    service.setContext(context(f.root, 'same-version'));
    assert.equal(await service.refreshStatus(), undefined);
    assert.equal(service.snapshot.state.status, 'error');
    assert.match(service.snapshot.state.message ?? '', scenario.diagnostic);
    assert.equal(lookups, scenario.lookups);
    assert.equal(cachedRuns, scenario.cachedRuns);
    assert.equal(releases, cachedRuns);
  });
});

test('Wiki uses complete verification after a warmed Reviewer and managed instructions still gate the fast path', async t => {
  const f = await verificationFixture(t);
  let reads = 0;
  const wiki = '.agents/skills/codebase-wiki/SKILL.md';
  const service = new WorkflowKitService(options(f.root, [], async () => {
    reads++;
    if (f.sha(await readFile(path.join(f.root, wiki))) !== f.value.files[wiki]) {
      return { ok: true, status: 'error', message: 'managed Wiki skill changed' };
    }
    return { ok: true, status: 'installed', integrity: 'verified', version: f.value.version, statusContract: 1, installedManifestSha256: f.attestation };
  }));
  t.after(() => service.dispose());
  await service.verifyInstallation(f.root, { reviewer: true });
  const originalInstructions = await readFile(f.agents, 'utf8');
  await writeFile(f.agents, originalInstructions.replace('Managed WorkflowKit instructions.', 'Changed instructions.'));
  await assert.rejects(service.verifyInstallation(f.root, { reviewer: true }), /AGENTS.md 管理區塊已變更/);
  assert.equal(reads, 1);
  await writeFile(f.agents, originalInstructions.replace('# User notes', '# Updated user notes'));
  await service.verifyInstallation(f.root, { reviewer: true });
  assert.equal(reads, 1);
  await writeFile(path.join(f.root, wiki), '# Edited Wiki skill');
  await assert.rejects(service.verifyInstallation(f.root), /managed Wiki skill changed/);
  assert.equal(reads, 2);
});

test('a new install transaction blocks a prepared handoff and delegates subsequent verification to status', async t => {
  const f = await verificationFixture(t);
  let unfinished = false, checks = 0;
  const service = new WorkflowKitService(options(f.root, [], async () => {
    checks++;
    return unfinished ? { ok: true, status: 'error', message: 'installer transaction unfinished' } :
      { ok: true, status: 'installed', integrity: 'verified', version: f.value.version, statusContract: 1, installedManifestSha256: f.attestation };
  }));
  t.after(() => service.dispose());
  const completedStage = path.join(f.root, '.gitlab-workspace', 'tool-installs', `kit-${'b'.repeat(32)}`);
  await mkdir(completedStage, { recursive: true });
  await writeFile(path.join(completedStage, 'transaction.json'), JSON.stringify({ phase: 'committed' }));
  const ready = await service.verifyInstallation(f.root, { reviewer: true });
  assert.deepEqual(await service.verifyInstallation(f.root, { reviewer: true }), ready);
  assert.equal(checks, 1, 'an unchanged verified rollback journal allows the fast path');
  await service.assertInstallationCurrent(ready.marker, 'merge-reviewer');
  const stage = path.join(f.root, '.gitlab-workspace', 'tool-installs', `kit-${'a'.repeat(32)}`);
  await mkdir(stage, { recursive: true });
  await writeFile(path.join(stage, 'transaction.json'), JSON.stringify({ phase: 'prepared' }));
  unfinished = true;
  await assert.rejects(service.assertInstallationCurrent(ready.marker, 'merge-reviewer'), /交易狀態在準備指令時已變更/);
  await assert.rejects(service.verifyInstallation(f.root, { reviewer: true }), /installer transaction unfinished/);
  assert.equal(checks, 2);
});

test('a local verification lock failure does not fall back to the cached release catalog', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'workflow-kit-service-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const manifests = path.join(root, '.gitlab-workspace', 'tool-manifests'); await mkdir(manifests, { recursive: true });
  await writeFile(path.join(manifests, 'workflow-kit.json'), JSON.stringify({ source: 'github', version: '1.1.0' }));
  const release = { version: '1.1.0', descriptor: { statusApi: 1, installerApi: 1, workspaceContract: 2 } };
  const setup = options(root, [release], async () => ({ ok: true, status: 'installed' }));
  const lockError = new NetworkLeaseError('WorkflowKit 本機鎖缺少擁有者資料。', 'metadata-missing');
  let cachedReads = 0;
  setup.releaseManager.prepareStatusVerifier = async () => { throw lockError; };
  setup.releaseManager.useCached = async () => { cachedReads++; return [release]; };
  const service = new WorkflowKitService(setup);
  t.after(() => service.dispose());
  service.setContext(context(root, 'revision'));

  await assert.rejects(service.checkReleases('github', () => {}), (error: unknown) => error === lockError);
  assert.equal(cachedReads, 0);
  assert.equal(service.snapshot.checkingRelease, false);
});

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
  const targetAlias = path.join(root, 'project-alias');
  let selectedRoot = targetAlias;
  try { await symlink(target, targetAlias, process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (error) {
    if (!['EPERM', 'EACCES'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
    selectedRoot = target;
  }
  const project = await resolveProjectRootContext([{ uri: 'file:' + selectedRoot, name: 'project', path: selectedRoot }], undefined, '');
  assert.ok(project.root, project.error ?? 'Expected a resolved project root');
  const installRoot = project.root;
  assert.equal(installRoot, await realpath(target));
  const release = { id: 'github-1.1.0', version: '1.1.0', source: 'github', assetName: 'kit.zip', format: 'zip', entryRoot: 'workflow-kit',
    available: true, descriptor: { statusApi: 1, installerApi: 1, workspaceContract: 2 }, descriptorSha256: 'a'.repeat(64),
    sha256: 'b'.repeat(64), assetUrls: { package: '', installer: '' }, archivePath: 'kit.zip', installerPath: 'installer.py' };
  let installed = false;
  let validated = false;
  const service = new WorkflowKitService(options(root, [release], async (args, beforeLaunch) => {
    if (args[0] === 'status') return installed
      ? { ok: true, status: 'installed', profile: 'group', source: 'github', version: '1.1.0', workspaceContract: 2, installerApi: 1, capabilities: ['query'] }
      : { ok: true, status: 'missing' };
    assert.equal(args[2], installRoot);
    await beforeLaunch?.();
    installed = true;
    return { ok: true, package: 'gitlab-workspace-kit', version: '1.1.0', profile: 'group', warnings: ['uv 尚未安裝'] };
  }));
  t.after(() => service.dispose());

  service.setContext(context(installRoot, project.revision));
  await service.refreshStatus();
  const result = await service.install('github-1.1.0', {
    canInstall: () => undefined,
    checkAccess: () => undefined,
    validateTarget: async expected => {
      assert.equal(expected.root, installRoot);
      assert.equal(expected.revision, project.revision);
      validated = true;
    }
  });
  await service.refreshStatus();

  assert.equal(validated, true);
  assert.equal(result.root, installRoot);
  assert.deepEqual(result.warnings, ['uv 尚未安裝']);
  assert.equal(service.snapshot.installing, false);
  assert.equal(service.snapshot.state.status, 'installed', service.snapshot.state.message ?? 'Expected an installed WorkflowKit');
  assert.deepEqual(service.snapshot.state.capabilities, ['query']);
});
