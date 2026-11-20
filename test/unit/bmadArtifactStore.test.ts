import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { mkdtemp, mkdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { BmadArtifactStore, BmadProjectApplyError } from '../../src/workspace/bmadArtifactStore';

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

test('a save after BMAD preflight survives and the journal records partial application', async t => {
  const f = await fixture(t);
  const rule = '_bmad/custom/workflow.md', target = path.join(f.source, rule), proposed = path.join(f.task, rule);
  await Promise.all([mkdir(path.dirname(target), { recursive: true }), mkdir(path.dirname(proposed), { recursive: true })]);
  await Promise.all([
    writeFile(path.join(f.source, 'AGENTS.md'), 'Original agents'), writeFile(path.join(f.task, 'AGENTS.md'), 'Proposed agents'),
    writeFile(target, 'Original rule'), writeFile(proposed, 'Proposed rule')
  ]);
  const capture = (await f.store.capture({ sourceRoot: f.source, taskId: 'apply_race', projectChangesRoot: f.task }))!;
  const journal = path.join(path.dirname(capture.root), capture.id + '.apply.json');
  const realRename = fs.rename;
  let saved = false;
  t.mock.method(fs, 'rename', async (from: string, to: string) => {
    await realRename(from, to);
    if (to === journal && !saved) {
      assert.equal(JSON.parse(await readFile(journal, 'utf8')).state, 'applying');
      saved = true;
      await writeFile(target, 'Editor save after preflight');
    }
  });

  await assert.rejects(f.store.applyProjectChanges(f.source, capture.id, capture.digest), error => {
    assert.ok(error instanceof BmadProjectApplyError);
    assert.match(error.detail, /已套用：AGENTS\.md/);
    assert.match(error.detail, /待套用：_bmad\/custom\/workflow\.md/);
    return true;
  });
  assert.equal(await readFile(target, 'utf8'), 'Editor save after preflight');
  assert.equal(await readFile(path.join(f.source, 'AGENTS.md'), 'utf8'), 'Proposed agents');
  const outcome = JSON.parse(await readFile(journal, 'utf8'));
  assert.deepEqual([outcome.state, outcome.path, outcome.applied, outcome.pending], ['conflict', rule, ['AGENTS.md'], [rule]]);
  assert.deepEqual(await fs.readdir(path.dirname(target)), ['workflow.md']);
});

test('BMAD publishes new rules exclusively and removes its temporary file on a name collision', async t => {
  const f = await fixture(t);
  const target = path.join(f.source, 'AGENTS.md');
  await writeFile(path.join(f.task, 'AGENTS.md'), 'New proposed rules');
  const capture = (await f.store.capture({ sourceRoot: f.source, taskId: 'new_rule_race', projectChangesRoot: f.task }))!;
  const journal = path.join(path.dirname(capture.root), capture.id + '.apply.json');
  const realLink = fs.link;
  const link = t.mock.method(fs, 'link', async (from: string, to: string) => {
    assert.equal(to, target);
    await writeFile(target, 'Editor created the file', { flag: 'wx' });
    await realLink(from, to);
  });

  await assert.rejects(f.store.applyProjectChanges(f.source, capture.id, capture.digest), /原專案規則已變更/);
  assert.equal(link.mock.callCount(), 1);
  assert.equal(await readFile(target, 'utf8'), 'Editor created the file');
  assert.deepEqual(await fs.readdir(f.source), ['AGENTS.md']);
  assert.equal(JSON.parse(await readFile(journal, 'utf8')).state, 'conflict');

  link.mock.restore();
  await fs.unlink(target);
  await f.store.applyProjectChanges(f.source, capture.id, capture.digest);
  assert.equal(await readFile(target, 'utf8'), 'New proposed rules');
  const outcome = JSON.parse(await readFile(journal, 'utf8'));
  assert.deepEqual([outcome.state, outcome.applied, outcome.pending], ['confirmed', ['AGENTS.md'], []]);
  assert.deepEqual(await fs.readdir(f.source), ['AGENTS.md']);
});

test('BMAD records an I/O failure with the original rules and no unfinished temporary file', async t => {
  const f = await fixture(t), target = path.join(f.source, 'AGENTS.md');
  await writeFile(target, 'Current rules');
  await writeFile(path.join(f.task, 'AGENTS.md'), 'Proposed rules');
  const capture = (await f.store.capture({ sourceRoot: f.source, taskId: 'publish_failure', projectChangesRoot: f.task }))!;
  const journal = path.join(path.dirname(capture.root), capture.id + '.apply.json');
  const realRename = fs.rename;
  t.mock.method(fs, 'rename', async (from: string, to: string) => {
    if (to === target) throw Object.assign(new Error('Write blocked'), { code: 'EIO' });
    await realRename(from, to);
  });

  await assert.rejects(f.store.applyProjectChanges(f.source, capture.id, capture.digest), /Write blocked/);
  assert.equal(await readFile(target, 'utf8'), 'Current rules');
  assert.deepEqual(await fs.readdir(f.source), ['AGENTS.md']);
  const outcome = JSON.parse(await readFile(journal, 'utf8'));
  assert.deepEqual([outcome.state, outcome.path, outcome.applied, outcome.pending], ['failed', 'AGENTS.md', [], ['AGENTS.md']]);
});

test('retry after BMAD index ENOSPC lists the original capture exactly once', async t => {
  const f = await fixture(t);
  await writeFile(path.join(f.output, 'SPEC.md'), 'Captured output');
  const options = { sourceRoot: f.source, taskId: 'index_retry', outputRoot: f.output };
  const realRename = fs.rename;
  let rejectedIndex: string | undefined;
  t.mock.method(fs, 'rename', async (from: string, to: string) => {
    if (path.basename(to) === 'index_retry.json' && !rejectedIndex) {
      rejectedIndex = to;
      throw Object.assign(new Error('Index disk full'), { code: 'ENOSPC' });
    }
    await realRename(from, to);
  });
  await assert.rejects(f.store.capture(options), { code: 'ENOSPC' });
  assert.deepEqual(await f.store.list(f.source), []);
  assert.ok(rejectedIndex);
  const directory = path.dirname(rejectedIndex);
  const [manifestRoot] = (await fs.readdir(directory, { withFileTypes: true })).filter(entry => entry.isDirectory());
  const original = JSON.parse(await readFile(path.join(directory, manifestRoot.name, 'manifest.json'), 'utf8'));
  const retried = await f.store.capture(options);
  assert.deepEqual(retried, original);
  assert.deepEqual(await f.store.list(f.source), [original]);
  assert.deepEqual(await f.store.capture(options), original);
  assert.deepEqual(await f.store.roots(f.source), [original.root]);
});
