import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { GitLabProject } from '../../src/api/types';
import { projectRemoteMatches, cloneProjects } from '../../src/git/cloneService';
import { assertSameLocalRepositoryLayout, resolveLocalRepositoryLayout } from '../../src/workspace/localRepositoryLayout';

const project = (id: number, name = 'same'): GitLabProject => ({ id, name, path: name, path_with_namespace: `team/sub${id}/${name}`,
  web_url: `https://gitlab.test/team/sub${id}/${name}`, http_url_to_repo: `https://gitlab.test/team/sub${id}/${name}.git`, default_branch: 'main' });
async function repo(root: string, name: string, project: GitLabProject) {
  const location = path.join(root, name); await mkdir(location);
  execFileSync('git', ['init', '--quiet', location]); execFileSync('git', ['-C', location, 'remote', 'add', 'origin', project.http_url_to_repo]);
  return location;
}

test('local resolver reuses a unique verified legacy directory and new ID directories are independent of loaded inventory', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'glw-layout-')); t.after(() => rm(root, { recursive: true, force: true }));
  const first = project(1), second = project(2);
  const old = await repo(root, '舊專案 folder', first);
  const selected = await resolveLocalRepositoryLayout(root, [first], projectRemoteMatches);
  const expanded = await resolveLocalRepositoryLayout(root, [first, second], projectRemoteMatches);
  assert.equal(selected.destinations.get(first.id), old); assert.equal(expanded.destinations.get(first.id), old);
  assert.equal(expanded.destinations.get(second.id), path.join(root, 'same--2'));
  const onlySecond = await resolveLocalRepositoryLayout(root, [second], projectRemoteMatches);
  assert.equal(onlySecond.destinations.get(second.id), expanded.destinations.get(second.id));
  assertSameLocalRepositoryLayout(selected, await resolveLocalRepositoryLayout(root, [first], projectRemoteMatches));
  await repo(root, 'same--2', second);
  assert.throws(() => assertSameLocalRepositoryLayout(onlySecond, expanded), /位置已/);
  const current = await resolveLocalRepositoryLayout(root, [second], projectRemoteMatches);
  assert.throws(() => assertSameLocalRepositoryLayout(onlySecond, current), /位置已/);
});

test('multiple matching copies and occupied destinations reject the entire batch before a remote Git action', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'glw-layout-')); t.after(() => rm(root, { recursive: true, force: true }));
  const first = project(1), second = project(2); let writes = 0;
  await repo(root, 'copy-one', second); await repo(root, 'copy-two', second);
  await assert.rejects(cloneProjects(root, [first, second], 'https://gitlab.test', 'test-token', undefined, {
    cloneRunner: async () => { writes++; }, updateRunner: async () => { writes++; return { state: 'updated' }; }
  }), /多份本機副本/);
  assert.equal(writes, 0);
  await rm(path.join(root, 'copy-two'), { recursive: true });
  await writeFile(path.join(root, 'same--1'), 'occupied');
  await assert.rejects(cloneProjects(root, [second, first], 'https://gitlab.test', 'test-token', undefined, {
    cloneRunner: async () => { writes++; }, updateRunner: async () => { writes++; return { state: 'updated' }; }
  }), /占用/);
  assert.equal(writes, 0);
  await assert.rejects(resolveLocalRepositoryLayout(root, [{ ...first, path: '../unsafe' }], projectRemoteMatches), /無法安全/);
});

test('the verified root repository wins over matching children', async t => {
  const container = await mkdtemp(path.join(os.tmpdir(), 'glw-layout-root-')); t.after(() => rm(container, { recursive: true, force: true }));
  const first = project(1), second = project(2);
  const root = await repo(container, 'renamed-root', first); await repo(root, 'old-copy', first);
  const layout = await resolveLocalRepositoryLayout(root, [first, second], projectRemoteMatches);
  assert.equal(layout.rootProjectId, first.id); assert.equal(layout.destinations.get(first.id), root);
  assert.equal(layout.destinations.get(second.id), path.join(root, 'same--2'));
});

test('an explicit operation supplements missing metadata only for its selected project', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'glw-layout-metadata-')); t.after(() => rm(root, { recursive: true, force: true }));
  const selected = project(1), old = await repo(root, 'legacy', selected), reads: number[] = [], updated: string[] = [];
  await cloneProjects(root, [{ ...selected, http_url_to_repo: '' }], 'https://gitlab.test', 'test-token', undefined, {
    resolveProject: async item => { reads.push(item.id); return selected; },
    updateRunner: async plan => { updated.push(plan.targetPath); return { state: 'up-to-date' }; }
  });
  assert.deepEqual(reads, [1]); assert.deepEqual(updated, [old]);
});
