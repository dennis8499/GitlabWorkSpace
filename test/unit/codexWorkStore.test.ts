import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { WorkContextStore } from '../../src/codex/workStore';

async function fixture(t: test.TestContext) {
  const parent = await realpath(os.tmpdir()), root = await realpath(await mkdtemp(path.join(parent, 'glw-work-index-'))), directory = path.join(root, 'index');
  t.after(async () => { assert.equal(path.dirname(root).toLowerCase(), parent.toLowerCase()); await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); });
  return { root, directory, store: new WorkContextStore(directory) };
}

test('reading a missing work index does not create storage or require a workflow pipeline', async t => {
  const f = await fixture(t), value = await f.store.read('local-account', 'work-one');
  assert.equal(value.revision, 0); assert.deepEqual(value.links, []);
  await assert.rejects(readdir(f.directory), { code: 'ENOENT' });
  assert.equal(await f.store.findSource('local-account', 'issue:1'), undefined);
});

test('concurrent task links retain every task and retrying an existing link is idempotent', async t => {
  const f = await fixture(t), second = new WorkContextStore(f.directory);
  await Promise.all([f.store.attach('scope', 'work-one', 'task-build', 'issue'), second.attach('scope', 'work-one', 'task-review', 'merge-request')]);
  const value = await f.store.read('scope', 'work-one'); assert.equal(value.revision, 2);
  assert.deepEqual(value.links.map(link => link.taskId).sort(), ['task-build', 'task-review']);
  assert.deepEqual(await f.store.attach('scope', 'work-one', 'task-build', 'issue', 0), value);
  assert.equal('status' in value, false); assert.equal('spec' in value, false);
});

test('stale work-index edits and task-kind conflicts preserve existing links', async t => {
  const f = await fixture(t), original = await f.store.attach('scope', 'work-one', 'task-build', 'issue', 0);
  await assert.rejects(f.store.attach('scope', 'work-one', 'task-review', 'merge-request', 0), /其他視窗/);
  await assert.rejects(f.store.attach('scope', 'work-one', 'task-build', 'merge-request'), /無法驗證/);
  assert.deepEqual(await f.store.read('scope', 'work-one'), original);
});

test('source aliases join Issue and MR history without exposing raw account identities', async t => {
  const f = await fixture(t), issue = 'issue:https://gitlab.test:PRIVATE-ACCOUNT:4:2', mr = 'merge-request:https://gitlab.test:PRIVATE-ACCOUNT:4:3';
  await f.store.bindSource('PRIVATE-SCOPE', issue, 'work-one'); await f.store.bindSource('PRIVATE-SCOPE', mr, 'work-one');
  await f.store.bindSource('PRIVATE-SCOPE', issue, 'work-one');
  assert.equal(await f.store.findSource('PRIVATE-SCOPE', issue), 'work-one'); assert.equal(await f.store.findSource('PRIVATE-SCOPE', mr), 'work-one');
  assert.equal(await f.store.findSource('another-account', issue), undefined);
  const files = (await readdir(f.directory)).filter(file => file.endsWith('.json'));
  assert.equal(files.length, 2);
  for (const file of files) { const bytes = await readFile(path.join(f.directory, file), 'utf8'); assert.equal(bytes.includes('PRIVATE'), false); assert.equal(bytes.includes('gitlab.test'), false); }
});

test('conflicting source bindings never overwrite existing work history', async t => {
  const f = await fixture(t); await f.store.bindSource('scope', 'issue:1', 'work-one');
  await assert.rejects(f.store.bindSource('scope', 'issue:1', 'work-two'), /另一份工作關聯/);
  assert.equal(await f.store.findSource('scope', 'issue:1'), 'work-one');
});

test('different accounts and standalone work IDs remain isolated', async t => {
  const f = await fixture(t); await f.store.attach('first-account', 'work-one', 'task-build', 'issue');
  assert.deepEqual((await f.store.read('second-account', 'work-one')).links, []);
  assert.deepEqual((await f.store.read('first-account', 'work-two')).links, []);
  await assert.rejects(f.store.read('first-account', '../escape'), /無法驗證/);
});

test('tampered work metadata is rejected without rewriting or erasing it', async t => {
  const f = await fixture(t); await f.store.attach('scope', 'work-one', 'task-build', 'issue');
  const file = (await readdir(f.directory)).find(item => item.endsWith('.json'))!, target = path.join(f.directory, file);
  const value = JSON.parse(await readFile(target, 'utf8')); value.links.push({ ...value.links[0] });
  await writeFile(target, JSON.stringify(value)); const before = await readFile(target);
  await assert.rejects(f.store.attach('scope', 'work-one', 'task-review', 'merge-request'), /無法驗證/);
  assert.deepEqual(await readFile(target), before);
});

test('redirected index storage cannot write to another directory', async t => {
  const f = await fixture(t), external = path.join(f.root, 'external'); await mkdir(external);
  try { await symlink(external, f.directory, process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (error) { if (['EPERM', 'EACCES'].includes((error as NodeJS.ErrnoException).code ?? '')) { t.skip('Symlink creation unavailable in this environment'); return; } throw error; }
  await assert.rejects(f.store.bindSource('scope', 'issue:1', 'work-one'), /重新導向/);
  assert.deepEqual(await readdir(external), []);
});
