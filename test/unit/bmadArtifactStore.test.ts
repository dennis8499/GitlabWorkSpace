import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import { mkdtemp, mkdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { BmadArtifactStore } from '../../src/workspace/bmadArtifactStore';

const digest = (value: string): string => createHash('sha256').update(value).digest('hex');
const driveCase = (value: string, upper: boolean): string => (upper ? value[0].toUpperCase() : value[0].toLowerCase()) + value.slice(1);

async function fixture(t: test.TestContext) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'bmad-artifacts-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const storage = path.join(root, 'storage'), source = path.join(root, 'source'), task = path.join(root, 'task'), output = path.join(task, '_bmad-output');
  await Promise.all([mkdir(storage), mkdir(source), mkdir(output, { recursive: true })]);
  return { storage, source, task, output, store: new BmadArtifactStore(storage) };
}
test('captured output remains available by original Group after its task folder disappears', async t => {
  const f = await fixture(t); await writeFile(path.join(f.output, 'spec-order.md'), '---\nstatus: draft\n---\n# Work\n');
  const capture = await f.store.capture({ sourceRoot: f.source, taskId: 'task_one', outputRoot: f.output });
  assert.ok(capture); await rm(f.task, { recursive: true });
  assert.deepEqual(await f.store.roots(f.source), [capture.root]);
  assert.match(await readFile(path.join(capture.root, '_bmad-output', 'spec-order.md'), 'utf8'), /# Work/);
});

test('Windows artifact retrieval accepts storage drive case without changing persisted captures', { skip: process.platform !== 'win32' }, async t => {
  const f = await fixture(t); await writeFile(path.join(f.output, 'SPEC.md'), '# Stored result');
  const capture = (await new BmadArtifactStore(driveCase(f.storage, false)).capture({ sourceRoot: f.source, taskId: 'drive_case', outputRoot: f.output }))!;
  const manifest = path.join(capture.root, 'manifest.json'), before = await readFile(manifest);
  const store = new BmadArtifactStore(driveCase(f.storage, true));
  assert.deepEqual(await store.list(driveCase(f.source, false)), [capture]);
  assert.deepEqual(await store.roots(f.source), [capture.root]);
  assert.deepEqual(await readFile(manifest), before);
});

test('Windows legacy source spelling retains its original artifact digest', { skip: process.platform !== 'win32' }, async t => {
  const f = await fixture(t); await writeFile(path.join(f.output, 'SPEC.md'), '# Legacy result');
  const capture = (await f.store.capture({ sourceRoot: f.source, taskId: 'legacy_case', outputRoot: f.output }))!;
  // Model an existing capture whose source path spelling predates the current canonical spelling.
  const oldRoot = capture.root, directory = path.dirname(oldRoot);
  capture.sourceRoot = driveCase(await realpath(f.source), false);
  capture.digest = digest(JSON.stringify([capture.sourceRoot, capture.taskId, capture.files, capture.projectChanges]));
  capture.id = `${capture.taskId}-${capture.digest.slice(0, 16)}`;
  capture.root = path.join(directory, capture.id);
  await rename(oldRoot, capture.root);
  const manifest = path.join(capture.root, 'manifest.json');
  await writeFile(manifest, JSON.stringify(capture));
  await writeFile(path.join(directory, capture.taskId + '.json'), JSON.stringify({ id: capture.id }));
  const before = await readFile(manifest);
  assert.deepEqual(await f.store.list(f.source), [capture]);
  assert.deepEqual(await readFile(manifest), before);
});

test('artifact retrieval still rejects a different source, relocated capture and invalid digest', async t => {
  for (const kind of ['source', 'root', 'escape', 'digest'] as const) await t.test(kind, async child => {
    const f = await fixture(child); await writeFile(path.join(f.output, 'SPEC.md'), '# Bound result');
    const capture = (await f.store.capture({ sourceRoot: f.source, taskId: 'binding_check', outputRoot: f.output }))!;
    const manifest = path.join(capture.root, 'manifest.json');
    if (kind === 'source') {
      capture.sourceRoot = path.join(f.source, 'different-project');
      capture.digest = digest(JSON.stringify([capture.sourceRoot, capture.taskId, capture.files, capture.projectChanges]));
    } else if (kind === 'root') capture.root = path.join(f.storage, 'different-location', capture.id);
    else if (kind === 'escape') capture.root = path.join(f.source, capture.id);
    else capture.digest = '0'.repeat(64);
    await writeFile(manifest, JSON.stringify(capture));
    await assert.rejects(f.store.list(f.source), /與原專案綁定不符/);
  });
});
test('Group analysis is stored under the native spec output prefix and unsafe prefixes are rejected', async t => {
  const f = await fixture(t); await writeFile(path.join(f.output, 'SPEC.md'), '# Group requirement');
  await assert.rejects(f.store.capture({ sourceRoot: f.source, taskId: 'group_one', outputRoot: f.output, outputPrefix: '../outside' }), /前綴無效/);
  const capture = (await f.store.capture({ sourceRoot: f.source, taskId: 'group_one', outputRoot: f.output, outputPrefix: 'specs/group_one' }))!;
  assert.equal(await readFile(path.join(capture.root, '_bmad-output/specs/group_one/SPEC.md'), 'utf8'), '# Group requirement');
});
test('project rules require the exact confirmed artifact and preserve source until apply', async t => {
  const f = await fixture(t); await writeFile(path.join(f.source, 'AGENTS.md'), 'Original rules\n');
  await writeFile(path.join(f.task, 'AGENTS.md'), 'Proposed rules\n');
  const capture = (await f.store.capture({ sourceRoot: f.source, taskId: 'project_one', projectChangesRoot: f.task }))!;
  assert.equal(await readFile(path.join(f.source, 'AGENTS.md'), 'utf8'), 'Original rules\n');
  await assert.rejects(f.store.applyProjectChanges(f.source, capture.id, '0'.repeat(64)), /人工確認/);
  await f.store.applyProjectChanges(f.source, capture.id, capture.digest);
  assert.equal(await readFile(path.join(f.source, 'AGENTS.md'), 'utf8'), 'Proposed rules\n');
  await f.store.applyProjectChanges(f.source, capture.id, capture.digest);
});
test('source drift and stored artifact drift prevent applying a stale project proposal', async t => {
  const f = await fixture(t); await writeFile(path.join(f.source, 'AGENTS.md'), 'Before'); await writeFile(path.join(f.task, 'AGENTS.md'), 'After');
  const capture = (await f.store.capture({ sourceRoot: f.source, taskId: 'project_two', projectChangesRoot: f.task }))!;
  await writeFile(path.join(f.source, 'AGENTS.md'), 'Human edit');
  await assert.rejects(f.store.applyProjectChanges(f.source, capture.id, capture.digest), /原專案規則已變更/);
  assert.equal(await readFile(path.join(f.source, 'AGENTS.md'), 'utf8'), 'Human edit');
  await writeFile(path.join(capture.root, 'AGENTS.md'), 'Altered');
  await assert.rejects(f.store.list(f.source), /內容已變更/);
});
