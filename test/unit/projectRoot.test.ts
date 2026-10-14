import assert from 'node:assert/strict';
import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { resolveProjectRootContext, selectedProjectFolder } from '../../src/workspace/projectRoot';

test('the default root is exactly the opened folder; an explicit relative or absolute root replaces it', async t => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'project-root-')); t.after(() => rm(base, { recursive: true, force: true }));
  const root = await realpath(base); const custom = path.join(root, 'custom'); await mkdir(custom);
  const folders = [{ uri: 'file:' + root, name: 'project', path: root }];
  const original = await resolveProjectRootContext(folders, undefined, '');
  assert.equal(original.root, root); assert.equal(original.manual, false);
  const relative = await resolveProjectRootContext(folders, undefined, 'custom');
  const absolute = await resolveProjectRootContext(folders, undefined, custom);
  assert.equal(relative.root, custom); assert.equal(absolute.root, custom); assert.equal(relative.manual, true);
  assert.notEqual(relative.revision, original.revision);
  assert.equal((await resolveProjectRootContext(folders, undefined, '')).revision, original.revision);
});

test('multiple folders require a valid explicit selection and do not infer a shared parent', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'project-folders-')); t.after(() => rm(root, { recursive: true, force: true }));
  const folders = ['a', 'b'].map(name => ({ uri: 'file:' + name, name, path: path.join(root, name) }));
  await Promise.all(folders.map(folder => mkdir(folder.path)));
  assert.equal(selectedProjectFolder(folders), undefined);
  assert.equal((await resolveProjectRootContext(folders, undefined, '')).root, undefined);
  assert.equal((await resolveProjectRootContext(folders, 'removed', '')).root, undefined);
  assert.equal((await resolveProjectRootContext(folders, folders[1].uri, '')).root, await realpath(folders[1].path));
});

test('missing, non-directory and unopened roots report errors without a fallback', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'project-invalid-')); t.after(() => rm(root, { recursive: true, force: true }));
  const folders = [{ uri: 'file:' + root, name: 'project', path: root }]; await writeFile(path.join(root, 'file'), 'data');
  for (const configured of ['missing', 'file']) {
    const result = await resolveProjectRootContext(folders, undefined, configured);
    assert.equal(result.root, undefined); assert.match(result.error!, /不存在或無法讀取/); assert.equal(result.manual, true);
  }
  assert.equal((await resolveProjectRootContext([], undefined, root)).root, undefined);
});
