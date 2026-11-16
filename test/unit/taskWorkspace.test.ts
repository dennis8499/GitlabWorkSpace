import assert from 'node:assert/strict';
import test from 'node:test';
import { lstat, mkdtemp, mkdir, readFile, readdir, realpath, rm, rmdir, symlink, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import os from 'node:os';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { createTaskWorkspace, readTaskWorkspace, claimTaskWorkspace, releaseTaskWorkspace, retireTaskWorkspace } from '../../src/codex/taskWorkspace';
import { CodexTaskStore, CodexTaskOwnerError } from '../../src/codex/taskStore';
import { CodexBridge } from '../../src/codex/bridge';
import { validStoredCodexProjection } from '../../src/codex/recordValidation';
import type { CodexTaskScheduler } from '../../src/codex/scheduler';
import type { CodexTaskRecord, CodexTaskSpec } from '../../src/codex/protocol';

async function fixture(t: test.TestContext) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'glw-task-window-')));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }));
  const storage = path.join(root, 'storage'), group = path.join(root, 'group');
  await mkdir(storage); await mkdir(group);
  const source = { kind: 'free' as const, repository: group, prompt: 'Inspect local committed sources' };
  const spec: CodexTaskSpec = { source, title: 'Window fixture', root: group, workspaceKey: 'fixture', prompt: source.prompt,
    executionRoot: group, writableRoots: [group], environmentKey: 'fixed-environment' };
  const manifest = await createTaskWorkspace(storage, { source, originRoot: group, accountId: 'account-a', preparedSpec: spec }, 'window-task');
  const record: CodexTaskRecord = { schema: 'GitLabWorkspaceCodexTask/v4', id: manifest.binding.taskId, title: spec.title, root: group,
    spec: { ...spec, taskWorkspace: manifest.binding }, ownerPid: process.pid, ownerInstance: 'owner-a', ownerGeneration: 1,
    revision: 1, status: 'paused', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), result: { state: 'ready', summary: 'Ready for preview' } };
  return { storage, group, manifest, spec, record, store: new CodexTaskStore(path.join(storage, 'codex-tasks')) };
}

function adoptedDelivery(record: CodexTaskRecord): void {
  record.status = 'completed';
  record.delivery = { mode: 'automatic', state: 'needs-attention', deliveredCommitSha: 'a'.repeat(40), artifactDigest: 'b'.repeat(64),
    confirmation: { digest: 'c'.repeat(64), confirmedAt: '2026-11-14T01:00:00Z', headSha: 'a'.repeat(40), targetSha: 'd'.repeat(40) },
    steps: [{ id: 'commit', kind: 'commit', state: 'confirmed', key: 'e'.repeat(64), bodyHash: 'b'.repeat(64), sha: 'a'.repeat(40), treeSha: 'f'.repeat(40) },
      { id: 'push', kind: 'push', state: 'confirmed', key: '1'.repeat(64), bodyHash: 'a'.repeat(40), sha: 'a'.repeat(40) },
      { id: 'draft-mr', kind: 'merge-request', state: 'prepared', key: '2'.repeat(64), bodyHash: 'a'.repeat(40) }] };
}

function groupSpec(f: Awaited<ReturnType<typeof fixture>>): CodexTaskSpec {
  const id = randomUUID(), runtimeRoot = path.join(f.storage, 'codex-group-analysis', id), outputRoot = path.join(runtimeRoot, 'artifacts');
  const repository = path.join(f.group, 'service');
  return { ...f.spec, source: { kind: 'group-analysis', requirement: 'Inspect the committed service' }, executionRoot: outputRoot,
    writableRoots: [outputRoot], groupAnalysis: { id, groupRoot: f.group, runtimeRoot, outputRoot, issueDrafts: true,
      repositories: [{ id: 'service', name: 'service', path: repository, sha: 'a'.repeat(40),
        snapshotPath: path.join(runtimeRoot, 'sources', createHash('sha256').update(repository).digest('hex').slice(0, 16)) }] } };
}

test('a new managed Group launch exposes an empty output folder before opening its window without exporting sources', async t => {
  const f = await fixture(t), spec = groupSpec(f);
  const manifest = await createTaskWorkspace(f.storage, { source: spec.source, originRoot: f.group, preparedSpec: spec }, 'group-output');
  const group = spec.groupAnalysis!;
  assert.equal((await lstat(group.outputRoot)).isDirectory(), true);
  assert.deepEqual(await readdir(group.outputRoot), []);
  assert.deepEqual(await readdir(group.runtimeRoot), ['artifacts'], 'no snapshot, inventory or model artifact is prepared before ownership');
  assert.deepEqual(await readdir(f.group), [], 'the original Group stays unchanged');
  assert.deepEqual(await f.store.load(), []);
  const workspace = JSON.parse(await readFile(manifest.binding.workspaceFile, 'utf8'));
  assert.equal(workspace.folders[1].path, group.outputRoot);
  assert.equal((await readTaskWorkspace(f.storage, manifest.binding.workspaceFile)).owner, undefined);
});

test('an unclaimed pending Group retry may recreate only its bound empty output folder', async t => {
  const f = await fixture(t), spec = groupSpec(f), request = { source: spec.source, originRoot: f.group, preparedSpec: spec };
  const first = await createTaskWorkspace(f.storage, request, 'group-pending');
  await rmdir(spec.groupAnalysis!.outputRoot);
  const retried = await createTaskWorkspace(f.storage, request, 'group-pending');
  assert.equal(retried.preparedDigest, first.preparedDigest); assert.equal(retried.createdAt, first.createdAt);
  assert.deepEqual(await readdir(spec.groupAnalysis!.runtimeRoot), ['artifacts']);
});

test('a claimed Group launch remains read-only when an older window reopens the identical preparation', async t => {
  const f = await fixture(t), spec = groupSpec(f), request = { source: spec.source, originRoot: f.group, preparedSpec: spec };
  const first = await createTaskWorkspace(f.storage, request, 'group-claimed');
  await claimTaskWorkspace(f.storage, first.binding, 'group-owner', async () => {});
  await rmdir(spec.groupAnalysis!.outputRoot);
  const repeated = await createTaskWorkspace(f.storage, request, 'group-claimed');
  assert.equal(repeated.owner!.instance, 'group-owner');
  await assert.rejects(lstat(spec.groupAnalysis!.outputRoot), { code: 'ENOENT' });
});

test('a recorded Group launch cannot recreate output even before its envelope was claimed', async t => {
  const f = await fixture(t), spec = groupSpec(f), request = { source: spec.source, originRoot: f.group, preparedSpec: spec };
  const first = await createTaskWorkspace(f.storage, request, 'group-recorded');
  await f.store.save({ ...f.record, id: first.binding.taskId, spec: { ...spec, taskWorkspace: first.binding } });
  await rmdir(spec.groupAnalysis!.outputRoot);
  await createTaskWorkspace(f.storage, request, 'group-recorded');
  await assert.rejects(lstat(spec.groupAnalysis!.outputRoot), { code: 'ENOENT' });
});

test('Group launch rejects escaped or inconsistent output bindings before creating any target directory', async t => {
  for (const kind of ['outside-output', 'outside-runtime', 'execution-root', 'invalid-id']) await t.test(kind, async t => {
    const f = await fixture(t), spec = groupSpec(f), group = spec.groupAnalysis!;
    if (kind === 'outside-output') group.outputRoot = path.join(f.group, 'unexpected-artifacts');
    if (kind === 'outside-runtime') {
      group.runtimeRoot = path.join(f.group, 'codex-group-analysis', group.id); group.outputRoot = path.join(group.runtimeRoot, 'artifacts');
      for (const repo of group.repositories) repo.snapshotPath = path.join(group.runtimeRoot, 'sources', createHash('sha256').update(repo.path).digest('hex').slice(0, 16));
    }
    if (kind === 'invalid-id') group.id = 'not-a-uuid';
    spec.executionRoot = kind === 'execution-root' ? path.join(f.group, 'unexpected-execution') : group.outputRoot;
    spec.writableRoots = [group.outputRoot];
    await assert.rejects(createTaskWorkspace(f.storage, { source: spec.source, originRoot: f.group, preparedSpec: spec }, 'group-invalid'), /受管理綁定/);
    await assert.rejects(lstat(group.runtimeRoot), { code: 'ENOENT' });
    await assert.rejects(lstat(group.outputRoot), { code: 'ENOENT' });
    await assert.rejects(lstat(spec.executionRoot), { code: 'ENOENT' });
  });
});

test('a redirected Group storage parent is rejected without creating an output through the link', async t => {
  const f = await fixture(t), spec = groupSpec(f), outside = path.join(f.group, 'untouched'); await mkdir(outside);
  await writeFile(path.join(outside, 'sentinel.txt'), 'keep');
  try { await symlink(outside, path.join(f.storage, 'codex-group-analysis'), process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (error) { if (['EPERM', 'EACCES', 'ENOTSUP'].includes((error as NodeJS.ErrnoException).code ?? '')) { t.skip('Directory links are unavailable in this environment'); return; } throw error; }
  await assert.rejects(createTaskWorkspace(f.storage, { source: spec.source, originRoot: f.group, preparedSpec: spec }, 'group-redirected'), /重新導向/);
  assert.deepEqual(await readdir(outside), ['sentinel.txt']);
  assert.equal(await readFile(path.join(outside, 'sentinel.txt'), 'utf8'), 'keep');
});

test('legacy Group outputs and arbitrary non-Group execution roots are not created by launch preparation', async t => {
  for (const kind of ['legacy-group', 'other-source']) await t.test(kind, async t => {
    const f = await fixture(t), spec = groupSpec(f);
    if (kind === 'legacy-group') {
      delete spec.groupAnalysis!.issueDrafts; spec.groupAnalysis!.outputRoot = path.join(f.group, '_bmad-output', 'specs', 'legacy');
      spec.executionRoot = spec.groupAnalysis!.outputRoot; spec.writableRoots = [spec.executionRoot];
    } else { spec.source = f.spec.source; delete spec.groupAnalysis; }
    await createTaskWorkspace(f.storage, { source: spec.source, originRoot: f.group, preparedSpec: spec }, 'old-output');
    await assert.rejects(lstat(spec.executionRoot!), { code: 'ENOENT' });
  });
});

test('task workspace preserves fixed preparation and the original project setting without starting execution', async t => {
  const f = await fixture(t), loaded = await readTaskWorkspace(f.storage, f.manifest.binding.workspaceFile);
  assert.deepEqual(loaded.preparedSpec, f.spec); assert.equal(loaded.owner, undefined);
  const workspace = JSON.parse(await readFile(f.manifest.binding.workspaceFile, 'utf8'));
  assert.equal(workspace.settings['gitlabWorkspace.projectRoot'], f.group);
  assert.equal(workspace.folders[1].path, f.group);
  assert.deepEqual(await f.store.load(), []);
  await assert.rejects(createTaskWorkspace(f.storage, { source: { ...f.spec.source, prompt: 'different' } as typeof f.spec.source, originRoot: f.group }, 'window-task'), /其他工作/);
});

test('task launch rejects modified prepared content, credential fields and unowned workspace paths', async t => {
  const f = await fixture(t), launchFile = path.join(f.manifest.binding.directory, 'launch.json');
  const changed = structuredClone(f.manifest); changed.preparedSpec!.prompt = 'changed after preview';
  await writeFile(launchFile, JSON.stringify(changed));
  await assert.rejects(readTaskWorkspace(f.storage, f.manifest.binding.workspaceFile), /內容已變更/);
  await assert.rejects(readTaskWorkspace(f.storage, path.join(f.group, 'task.code-workspace')), /受管理/);
  await assert.rejects(createTaskWorkspace(f.storage, { source: { ...f.spec.source, token: 'credential' } as unknown as typeof f.spec.source, originRoot: f.group }, 'credential-task'), /認證/);
});

test('an unclaimed launch retry replaces stale preparation and claim returns the fresh envelope', async t => {
  const f = await fixture(t);
  const unchanged = await createTaskWorkspace(f.storage, { source: f.spec.source, originRoot: f.group, accountId: 'account-a', preparedSpec: f.spec }, f.record.id);
  assert.equal(unchanged.preparedDigest, f.manifest.preparedDigest);
  const source = { ...f.spec.source, prompt: 'Updated request' } as typeof f.spec.source;
  const preparedSpec = { ...f.spec, source, prompt: 'Updated frozen preparation', executionRoot: path.join(f.group, 'new-output') };
  const updated = await createTaskWorkspace(f.storage, { source, originRoot: f.group, accountId: 'account-a', preparedSpec }, f.record.id);
  assert.notEqual(updated.preparedDigest, f.manifest.preparedDigest); assert.equal(updated.createdAt, f.manifest.createdAt);
  const claimed = await claimTaskWorkspace(f.storage, f.manifest.binding, 'owner-a', async () => {});
  assert.equal(claimed.preparedSpec!.prompt, 'Updated frozen preparation'); assert.deepEqual(claimed.source, source);
  const workspace = JSON.parse(await readFile(updated.binding.workspaceFile, 'utf8'));
  assert.equal(workspace.folders[1].path, preparedSpec.executionRoot);
  await assert.rejects(createTaskWorkspace(f.storage, { source: f.spec.source, originRoot: f.group, accountId: 'account-a', preparedSpec: f.spec }, f.record.id), /不能變更/);
});

test('an existing task record fences launch updates even when the envelope has not been claimed', async t => {
  const f = await fixture(t); await f.store.save(f.record);
  await assert.rejects(createTaskWorkspace(f.storage, { source: f.spec.source, originRoot: f.group, accountId: 'account-a',
    preparedSpec: { ...f.spec, prompt: 'Must not replace a recorded task' } }, f.record.id), /不能變更/);
  assert.equal((await readTaskWorkspace(f.storage, f.manifest.binding.workspaceFile)).preparedDigest, f.manifest.preparedDigest);
});

test('launch replacement and claim share one fence so a claimant cannot execute a superseded preparation', async t => {
  const f = await fixture(t), changed = { ...f.spec, prompt: 'Concurrent replacement' };
  const [update, claim] = await Promise.allSettled([
    createTaskWorkspace(f.storage, { source: f.spec.source, originRoot: f.group, accountId: 'account-a', preparedSpec: changed }, f.record.id),
    claimTaskWorkspace(f.storage, f.manifest.binding, 'owner-a', async () => {})
  ]);
  assert.equal(claim.status, 'fulfilled');
  if (update.status === 'fulfilled') assert.equal(claim.value.preparedDigest, update.value.preparedDigest);
  else { assert.match(String(update.reason), /不能變更/); assert.equal(claim.value.preparedDigest, f.manifest.preparedDigest); }
  assert.equal((await readTaskWorkspace(f.storage, f.manifest.binding.workspaceFile)).preparedDigest, claim.value.preparedDigest);
});

test('a live owner fences competing windows and a released owner advances the generation', async t => {
  const f = await fixture(t); let verified = 0;
  const first = await claimTaskWorkspace(f.storage, f.manifest.binding, 'owner-a', async () => { verified++; });
  assert.equal(first.owner!.generation, 1); assert.equal(verified, 1);
  await assert.rejects(claimTaskWorkspace(f.storage, f.manifest.binding, 'owner-b', async () => {}), /另一個/);
  await releaseTaskWorkspace(f.storage, f.manifest.binding, 'owner-a', 1);
  await assert.rejects(claimTaskWorkspace(f.storage, f.manifest.binding, 'owner-b', async () => { throw new Error('process stop unknown'); }), /stop unknown/);
  const second = await claimTaskWorkspace(f.storage, f.manifest.binding, 'owner-b', async () => { verified++; });
  assert.equal(second.owner!.generation, 2); assert.equal(verified, 2);
  await assert.rejects(releaseTaskWorkspace(f.storage, f.manifest.binding, 'owner-a', 1), /擁有者已改變/);
});

test('task store atomically fences a stale owner even when it writes a larger revision', async t => {
  const f = await fixture(t); await f.store.save(f.record);
  const claimed = await f.store.claim(f.record.id, 'owner-b', 2, async () => {});
  assert.equal(claimed!.ownerGeneration, 2);
  const stale = structuredClone(f.record); stale.revision = 100; stale.title = 'stale write';
  await assert.rejects(f.store.save(stale), CodexTaskOwnerError);
  const current = (await f.store.load())[0]; assert.equal(current.ownerInstance, 'owner-b'); assert.equal(current.title, f.record.title);
  current.revision!++; current.title = 'valid write'; await f.store.save(current);
  assert.equal((await f.store.load())[0].title, 'valid write');
});

test('an adopted HEAD receipt survives load and window claim without adding a parent or renewing publication approval', async t => {
  const f = await fixture(t); adoptedDelivery(f.record);
  assert.equal(validStoredCodexProjection(f.record), true);
  await claimTaskWorkspace(f.storage, f.manifest.binding, 'owner-a', async () => {});
  await f.store.save(f.record);
  const before = structuredClone(f.record.delivery);
  assert.deepEqual((await f.store.load())[0].delivery, before); assert.deepEqual(f.store.problems, []);
  await releaseTaskWorkspace(f.storage, f.manifest.binding, 'owner-a', 1);
  let writes = 0, models = 0;
  const bridge = new CodexBridge({ storage: f.storage, version: 'fixture', executable: () => '', trusted: () => true,
    prepare: async () => f.spec, event: () => {}, openUrl: async () => {},
    deliver: async () => { writes++; throw new Error('Recovery cannot publish'); }, client: async () => { models++; throw new Error('Recovery cannot start a model'); } });
  try {
    const launch = await bridge.claimTaskWorkspace(f.manifest.binding);
    const restored = (await f.store.load())[0];
    assert.equal(launch.owner!.generation, 2); assert.equal(restored.ownerGeneration, 2);
    assert.equal(restored.ownerInstance, launch.owner!.instance); assert.deepEqual(restored.delivery, before);
    assert.equal(restored.delivery!.steps[0].parentSha, undefined); assert.equal(restored.delivery!.confirmation!.issueDigest, undefined);
    assert.equal(bridge.list()[0].controls!.external, false); assert.equal(writes, 0); assert.equal(models, 0);
    await assert.rejects(f.store.save(f.record), CodexTaskOwnerError);
  } finally { await bridge.shutdown(); }
});

test('adopted commit storage still rejects missing tree or SHA and malformed optional parents', async t => {
  for (const field of ['missing-tree', 'bad-tree', 'missing-sha', 'bad-sha', 'bad-parent']) await t.test(field, async t => {
    const f = await fixture(t); adoptedDelivery(f.record); const commit = f.record.delivery!.steps[0];
    if (field === 'missing-tree') delete commit.treeSha;
    if (field === 'bad-tree') commit.treeSha = 'not-a-sha';
    if (field === 'missing-sha') delete commit.sha;
    if (field === 'bad-sha') commit.sha = 'not-a-sha';
    if (field === 'bad-parent') commit.parentSha = 'not-a-sha';
    assert.equal(validStoredCodexProjection(f.record), false);
    await f.store.save(f.record); assert.deepEqual(await f.store.load(), []); assert.equal(f.store.problems.length, 1);
    assert.equal(await f.store.claim(f.record.id, 'owner-b', 2, async () => {}), undefined);
  });
});

test('Git object identities are permitted only for Push and MR bodies while receipt keys and content bodies retain digest validation', async t => {
  const f = await fixture(t); adoptedDelivery(f.record);
  for (const kind of ['commit', 'issue-note', 'review-note', 'reply', 'upload', 'wiki'] as const) {
    const record = structuredClone(f.record);
    record.delivery!.steps.push({ id: 'invalid-' + kind, kind, state: 'prepared', key: '3'.repeat(64), bodyHash: 'a'.repeat(40) });
    assert.equal(validStoredCodexProjection(record), false, kind + ' must not accept a Git SHA as a content digest');
  }
  for (const kind of ['push', 'merge-request'] as const) {
    const record = structuredClone(f.record), step = record.delivery!.steps.find(item => item.kind === kind)!;
    step.bodyHash = 'a'.repeat(64); assert.equal(validStoredCodexProjection(record), true, 'SHA-256 Git identities are also valid');
    step.bodyHash = 'a'.repeat(41); assert.equal(validStoredCodexProjection(record), false, 'partial object IDs are rejected');
    step.bodyHash = 'a'.repeat(40); step.key = 'b'.repeat(40);
    assert.equal(validStoredCodexProjection(record), false, 'receipt keys always remain SHA-256 digests');
  }
});

test('closing recovery retains an adopted receipt with unknown publication instead of creating new authorization or writes', async t => {
  const f = await fixture(t); adoptedDelivery(f.record);
  f.record.delivery!.steps[2].state = 'uncertain';
  f.record.closing = { reason: 'manual', startedAt: '2026-11-14T01:00:00Z' }; f.record.cleanupState = 'pending';
  await claimTaskWorkspace(f.storage, f.manifest.binding, 'owner-a', async () => {}); await f.store.save(f.record);
  const before = structuredClone(f.record.delivery);
  await releaseTaskWorkspace(f.storage, f.manifest.binding, 'owner-a', 1);
  let writes = 0, reconciliations = 0;
  const bridge = new CodexBridge({ storage: f.storage, version: 'fixture', executable: () => '', trusted: () => true,
    prepare: async () => f.spec, event: () => {}, openUrl: async () => {},
    deliver: async () => { writes++; throw new Error('Cleanup recovery cannot publish'); }, reconcileDelivery: async () => { reconciliations++; } });
  try {
    await bridge.claimTaskWorkspace(f.manifest.binding);
    const deadline = Date.now() + 3000; let restored: CodexTaskRecord | undefined;
    do { restored = (await f.store.load())[0]; if (restored?.cleanupState === 'needs-attention' && reconciliations) break; await new Promise(resolve => setTimeout(resolve, 10)); } while (Date.now() < deadline);
    assert.equal(restored?.cleanupState, 'needs-attention'); assert.equal(reconciliations, 1); assert.equal(writes, 0);
    assert.deepEqual(restored!.delivery, before); assert.equal(restored!.delivery!.confirmation!.issueDigest, undefined);
    assert.equal(restored!.delivery!.steps[0].parentSha, undefined); assert.equal(await f.store.isDeleted(f.record.id), false);
  } finally { await bridge.shutdown(); }
});

test('retirement preserves a readable workspace marker but removes launch input and blocks dispatch', async t => {
  const f = await fixture(t); await claimTaskWorkspace(f.storage, f.manifest.binding, 'owner-a', async () => {});
  await retireTaskWorkspace(f.storage, f.manifest.binding, 'owner-a', 1);
  const retired = await readTaskWorkspace(f.storage, f.manifest.binding.workspaceFile);
  assert.equal(retired.retired!.resultId, f.record.id); assert.equal(retired.preparedSpec, undefined); assert.equal(retired.preparedDigest, undefined);
  assert.ok(!JSON.stringify(retired).includes('Inspect local committed sources'));
  await assert.rejects(claimTaskWorkspace(f.storage, f.manifest.binding, 'owner-a', async () => {}), /已封存/);
});

test('a live v4 task in another window is compatible with admission and is not mistaken for an older Host', async t => {
  const f = await fixture(t), child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { windowsHide: true, stdio: 'ignore' });
  const stopped = new Promise<void>(resolve => child.once('close', () => resolve()));
  t.after(async () => { child.kill(); await stopped; });
  assert.ok(child.pid);
  f.record.ownerPid = child.pid; f.record.status = 'running'; await f.store.save(f.record);
  const bridge = new CodexBridge({ storage: f.storage, version: 'fixture', executable: () => '', trusted: () => true,
    prepare: async () => f.spec, event: () => {}, openUrl: async () => {} });
  t.after(() => bridge.shutdown()); await bridge.initialize();
  await assert.doesNotReject((bridge as any).requireHealthyStorage());
  assert.equal(bridge.list()[0].controls!.external, true);
});

test('other windows can read a stopped task but cannot mutate, publish, resume or clean it', async t => {
  const f = await fixture(t); await f.store.save(f.record); let sideEffects = 0;
  const bridge = new CodexBridge({ storage: f.storage, version: 'fixture', executable: () => '', trusted: () => true,
    prepare: async () => { sideEffects++; return f.spec; }, event: () => {}, openUrl: async () => {}, deliver: async () => { sideEffects++; return f.record.result!; } });
  t.after(() => bridge.shutdown());
  await bridge.initialize();
  const state = bridge.list().find(value => value.id === f.record.id)!;
  assert.equal(state.controls!.external, true); assert.equal(state.controls!.canResume, false); assert.equal(state.controls!.canDelete, false);
  assert.equal((await bridge.specification(f.record.id)).environmentKey, 'fixed-environment');
  for (const action of [
    () => bridge.resultAction(f.record.id, async () => { sideEffects++; return f.record.result!; }),
    () => bridge.metadata(f.record.id, { title: 'changed' }), () => bridge.resume(f.record.id), () => bridge.pause(f.record.id),
    () => bridge.message(f.record.id, 'more'), () => bridge.retryDelivery(f.record.id), () => bridge.stopAndClean(f.record.id)
  ]) await assert.rejects(action, /另一個/);
  assert.equal(sideEffects, 0); assert.equal((await f.store.load())[0].title, f.record.title);
});

test('managed task metadata keeps the v4 ownership schema through rename, pin and archive', async t => {
  const f = await fixture(t);
  await claimTaskWorkspace(f.storage, f.manifest.binding, 'owner-a', async () => {});
  await releaseTaskWorkspace(f.storage, f.manifest.binding, 'owner-a', 1);
  await f.store.save(f.record);
  const bridge = new CodexBridge({ storage: f.storage, version: 'fixture', executable: () => '', trusted: () => true,
    prepare: async () => { throw new Error('metadata must not prepare or dispatch execution'); }, event: () => {}, openUrl: async () => {} });
  t.after(() => bridge.shutdown()); await bridge.claimTaskWorkspace(f.manifest.binding);
  await bridge.metadata(f.record.id, { title: 'Reviewed task', pinned: true, archived: true });
  await bridge.metadata(f.record.id, { archived: false });
  const saved = (await f.store.load())[0];
  assert.equal(saved.schema, 'GitLabWorkspaceCodexTask/v4'); assert.equal(saved.ownerGeneration, 2);
  assert.equal(saved.title, 'Reviewed task'); assert.equal(saved.pinned, true); assert.equal(saved.archived, false);
  assert.equal(bridge.list().find(task => task.id === saved.id)!.controls!.external, false);
});

test('a managed free task cannot fork away its workspace owner or prepare another repository', async t => {
  const f = await fixture(t); let sideEffects = 0;
  await claimTaskWorkspace(f.storage, f.manifest.binding, 'owner-a', async () => {});
  await releaseTaskWorkspace(f.storage, f.manifest.binding, 'owner-a', 1);
  f.record.threadId = 'managed-thread'; await f.store.save(f.record);
  const bridge = new CodexBridge({ storage: f.storage, version: 'fixture', executable: () => '', trusted: () => true,
    prepare: async () => { sideEffects++; return f.spec; }, client: async () => { sideEffects++; throw new Error('fork must not call App Server'); },
    event: () => {}, openUrl: async () => {} });
  t.after(() => bridge.shutdown()); await bridge.claimTaskWorkspace(f.manifest.binding);
  const file = path.join(f.storage, 'codex-tasks', f.record.id + '.json'), before = await readFile(file, 'utf8');
  await assert.rejects(bridge.fork(f.record.id, 'completed-turn'), /持久成果.*新任務/);
  assert.equal(sideEffects, 0); assert.equal(await readFile(file, 'utf8'), before);
  assert.equal((await f.store.load()).length, 1);
});

test('reclaiming a closing managed task resumes only durable cleanup after ownership is acquired', async t => {
  const f = await fixture(t); let cleaned = 0, executionCalls = 0;
  await claimTaskWorkspace(f.storage, f.manifest.binding, 'owner-a', async () => {});
  await releaseTaskWorkspace(f.storage, f.manifest.binding, 'owner-a', 1);
  f.record.closing = { reason: 'manual', startedAt: new Date().toISOString() }; f.record.cleanupState = 'pending';
  await f.store.save(f.record);
  const bridge = new CodexBridge({ storage: f.storage, version: 'fixture', executable: () => '', trusted: () => true,
    prepare: async () => { executionCalls++; throw new Error('cleanup must not execute a model'); },
    client: async () => { executionCalls++; throw new Error('no thread or remote operation needs recovery'); },
    cleanupDrafts: async () => { cleaned++; }, event: () => {}, openUrl: async () => {} });
  t.after(() => bridge.shutdown()); await bridge.initialize();
  assert.equal(cleaned, 0, 'a window cannot recover cleanup before claiming its owner generation');
  const claimed = await bridge.claimTaskWorkspace(f.manifest.binding); assert.equal(claimed.owner!.generation, 2);
  const deadline = Date.now() + 5000;
  while (!(await readTaskWorkspace(f.storage, f.manifest.binding.workspaceFile)).retired) {
    assert.ok(Date.now() < deadline, 'claimed durable cleanup should complete');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.equal(cleaned, 1); assert.equal(executionCalls, 0);
  await assert.rejects(readFile(path.join(f.storage, 'codex-tasks', f.record.id + '.json')), { code: 'ENOENT' });
  assert.equal((await readTaskWorkspace(f.storage, f.manifest.binding.workspaceFile)).retired!.resultId, f.record.id);
});

test('claim precedes admission and reopening a released task preserves fixed context without automatically dispatching it', async t => {
  const f = await fixture(t); let prepared = 0;
  const scheduler = { tryAcquire: async () => ({ reason: 'capacity' as const }), reconcile: async () => {} } as unknown as CodexTaskScheduler;
  const make = () => new CodexBridge({ storage: f.storage, version: 'fixture', executable: () => '', trusted: () => true,
    scheduler, prepare: async () => { prepared++; return f.spec; }, event: () => {}, openUrl: async () => {} });
  const first = make(); t.after(() => first.shutdown());
  const spec = { ...f.spec, taskWorkspace: f.manifest.binding };
  await assert.rejects(first.enqueue(spec, f.record.id), CodexTaskOwnerError);
  await first.claimTaskWorkspace(f.manifest.binding); await first.enqueue(spec, f.record.id);
  const original = (await f.store.load())[0]; assert.equal(original.schema, 'GitLabWorkspaceCodexTask/v4'); assert.equal(original.ownerGeneration, 1);
  await first.shutdown();
  const second = make(); t.after(() => second.shutdown());
  const manifest = await second.claimTaskWorkspace(f.manifest.binding);
  assert.equal(manifest.owner!.generation, 2); assert.equal(manifest.preparedSpec!.environmentKey, 'fixed-environment');
  const reopened = second.list().find(task => task.id === f.record.id)!;
  assert.equal(reopened.status, 'interrupted'); assert.equal(reopened.controls!.external, false);
  assert.equal(prepared, 0, 'neither envelope claim nor reopening dispatches the original work');
});

test('origin window mode is durable while legacy manifests retain task window semantics', async t => {
  const f = await fixture(t);
  assert.equal((await readTaskWorkspace(f.storage, f.manifest.binding.workspaceFile)).windowMode ?? 'task', 'task');
  const request = { source: f.spec.source, originRoot: f.group, preparedSpec: f.spec, windowMode: 'origin' as const };
  const origin = await createTaskWorkspace(f.storage, request, 'origin-mode');
  assert.equal((await readTaskWorkspace(f.storage, origin.binding.workspaceFile)).windowMode, 'origin');
  await assert.rejects(createTaskWorkspace(f.storage, { ...request, windowMode: 'task' }, 'origin-mode'), /不可變更/);
  const launchFile = path.join(origin.binding.directory, 'launch.json');
  await writeFile(launchFile, JSON.stringify({ ...origin, windowMode: 'unsupported' }));
  await assert.rejects(readTaskWorkspace(f.storage, origin.binding.workspaceFile), /視窗模式/);
});

test('one origin host retains independent task claims and releases every owned envelope on shutdown', async t => {
  const f = await fixture(t); let preparations = 0;
  const scheduler = { tryAcquire: async () => ({ reason: 'capacity' as const }), reconcile: async () => {} } as unknown as CodexTaskScheduler;
  const make = () => new CodexBridge({ storage: f.storage, version: 'fixture', executable: () => '', trusted: () => true, scheduler,
    autoApproveLocalOperations: () => true, prepare: async () => { preparations++; return f.spec; }, event: () => {}, openUrl: async () => {} });
  const origin = await createTaskWorkspace(f.storage, { source: f.spec.source, originRoot: f.group, preparedSpec: f.spec, windowMode: 'origin' }, 'second-origin-task');
  const first = make(), observer = make(), reopened = make();
  try {
    await first.claimTaskWorkspace(f.manifest.binding); await first.enqueue({ ...f.spec, taskWorkspace: f.manifest.binding }, f.record.id);
    await first.claimTaskWorkspace(origin.binding); await first.enqueue({ ...f.spec, taskWorkspace: origin.binding }, origin.binding.taskId);
    await first.setAutoAccept(f.record.id, false);
    assert.deepEqual(first.list().map(task => task.controls?.external), [false, false]);
    assert.equal(first.list().find(task => task.id === origin.binding.taskId)?.controls?.autoAccept, true);
    assert.equal(first.list().find(task => task.id === origin.binding.taskId)?.controls?.autoAcceptArmed, false);
    await observer.initialize();
    assert.equal(observer.list().every(task => task.controls?.external), true);
    assert.equal(observer.list().every(task => task.primaryAction?.enabled === false), true, 'Host projection must disable control writes in observer windows');
    await assert.rejects(observer.pause(f.record.id), CodexTaskOwnerError);
    await first.shutdown();
    for (const launch of [f.manifest, origin]) assert.equal((await readTaskWorkspace(f.storage, launch.binding.workspaceFile)).owner?.released, true);
    await reopened.claimTaskWorkspace(f.manifest.binding); await reopened.claimTaskWorkspace(origin.binding);
    assert.equal(reopened.list().every(task => task.status === 'interrupted' && !task.controls?.external && !task.controls?.autoAcceptArmed), true);
    assert.equal(reopened.list().find(task => task.id === f.record.id)?.controls?.autoAccept, false, 'task override wins over the enabled machine default');
    assert.equal(reopened.list().find(task => task.id === origin.binding.taskId)?.controls?.autoAccept, true);
    assert.equal(preparations, 0, 'claim and reload never dispatch queued tasks');
  } finally { await first.shutdown(); await observer.shutdown(); await reopened.shutdown(); }
});
