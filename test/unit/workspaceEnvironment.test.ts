import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { GitLabProject } from '../../src/api/types';
import { projectRemoteMatches } from '../../src/git/cloneService';
import { inspectWorkspaceEnvironment } from '../../src/workspace/workspaceEnvironment';
import { resolveSkillsContext } from '../../src/workspace/skillsContext';
import type { GroupWorkspaceMatch } from '../../src/workspace/workspaceEnvironmentProtocol';

const project = (id: number, name: string): GitLabProject => ({ id, name, path: name.split('/').at(-1)!,
  path_with_namespace: `team/${name}`, http_url_to_repo: `https://gitlab.test/team/${name}.git`,
  ssh_url_to_repo: `git@gitlab.test:team/${name}.git`, web_url: `https://gitlab.test/team/${name}` });
const projects = [project(1, 'service'), project(2, 'subgroup/docs')];
const scope = { connected: true, groupSelected: true, projectsReady: true };
const canonical = (value: string) => realpathSync.native(value);
function fixture() {
  const base = mkdtempSync(path.join(os.tmpdir(), 'workspace-environment-'));
  const root = path.join(base, 'Group'); mkdirSync(root);
  function repo(name: string, remote?: string | null, parent = root) {
    const folder = path.join(parent, name); mkdirSync(folder, { recursive: true });
    execFileSync('git', ['init', '--quiet', folder]);
    if (remote) execFileSync('git', ['-C', folder, 'remote', 'add', 'origin', remote]);
    return canonical(folder);
  }
  const inspect = (folders: string[], state = scope) => inspectWorkspaceEnvironment(
    folders.map(folder => ({ path: folder, local: true })), projects, projectRemoteMatches, state);
  return { base, root: canonical(root), repo, inspect, cleanup: () => rmSync(base, { recursive: true, force: true }) };
}

test('the opened container chooses the workspace profile and associates each child independently', async () => {
  const f = fixture(); try {
    const first = f.repo('renamed', projects[0].http_url_to_repo);
    const second = f.repo('docs', projects[1].ssh_url_to_repo);
    const match = await f.inspect([f.root]);
    assert.equal(match.status, 'matched'); assert.equal(match.root, f.root); assert.equal(match.profile, 'group');
    assert.deepEqual(match.repositories.map(repo => repo.path).sort(), [first, second].sort());
    assert.deepEqual(match.repositories.map(repo => repo.projectId).sort(), [1, 2]);
  } finally { f.cleanup(); }
});

test('mixed, missing and ambiguous origins never disable the local workflow', async () => {
  const f = fixture(); try {
    f.repo('service', projects[0].http_url_to_repo);
    const other = f.repo('docs', 'https://other-host.test/docs.git');
    let match = await f.inspect([f.root]); assert.equal(match.status, 'matched');
    assert.equal(match.repositories.find(repo => repo.path === other)?.matched, false);
    const fingerprint = match.repositories.find(repo => repo.path === other)?.remoteFingerprint;
    execFileSync('git', ['-C', other, 'remote', 'set-url', 'origin', projects[1].http_url_to_repo]);
    match = await f.inspect([f.root]); assert.notEqual(match.repositories.find(repo => repo.path === other)?.remoteFingerprint, fingerprint);
    assert.equal(match.repositories.find(repo => repo.path === other)?.projectId, 2);
    execFileSync('git', ['-C', other, 'config', '--add', 'remote.origin.url', projects[0].http_url_to_repo]);
    match = await f.inspect([f.root]); assert.equal(match.status, 'matched');
    assert.equal(match.repositories.find(repo => repo.path === other)?.projectId, undefined);
  } finally { f.cleanup(); }
});

test('an empty container is a usable local root without GitLab login or selected Group', async () => {
  const f = fixture(); try {
    const match = await f.inspect([f.root], { connected: false, groupSelected: false, projectsReady: false });
    assert.equal(match.status, 'matched'); assert.equal(match.root, f.root); assert.equal(match.cloneRoot, f.root);
    assert.equal(match.profile, 'group'); assert.deepEqual(match.repositories, []);
  } finally { f.cleanup(); }
});

test('a Repo and linked worktree use their own roots without promoting to the parent', async () => {
  const f = fixture(); try {
    const repo = f.repo('service', projects[0].http_url_to_repo);
    let match = await f.inspect([repo]); assert.equal(match.root, repo); assert.equal(match.profile, 'repository');
    execFileSync('git', ['-C', repo, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '--allow-empty', '-m', 'baseline']);
    const linked = path.join(f.root, 'linked'); execFileSync('git', ['-C', repo, 'worktree', 'add', '--quiet', '--detach', linked, 'HEAD']);
    match = await f.inspect([linked]); assert.equal(match.root, canonical(linked)); assert.equal(match.profile, 'repository');
    assert.equal((await f.inspect([repo, linked])).status, 'ambiguous');
  } finally { f.cleanup(); }
});

test('nested Repos retain remote identity and broken siblings do not choose the workflow', async () => {
  const f = fixture(); try {
    const parent = f.repo('parent'); const nested = f.repo('child', projects[0].http_url_to_repo, parent);
    const match = await f.inspect([nested], { connected: false, groupSelected: false, projectsReady: false });
    assert.equal(match.root, nested); assert.equal(match.profile, 'repository'); assert.equal(match.repositories[0].projectId, 1);
    const invalid = path.join(f.root, 'broken'); mkdirSync(invalid); writeFileSync(path.join(invalid, '.git'), 'invalid');
    assert.equal((await f.inspect([f.root])).status, 'matched');
    const failure = await f.inspect([invalid]); assert.equal(failure.status, 'error');
    const child = path.join(parent, 'src'); mkdirSync(child);
    const subdirectory = await f.inspect([child]); assert.equal(subdirectory.status, 'error'); assert.equal(subdirectory.root, child);
  } finally { f.cleanup(); }
});

test('Skills uses the local root profile and verifies installed versions and disables outdated installations', () => {
  const repos = [{ path: '/group/a', name: 'a', matched: false }, { path: '/group/b', name: 'b', matched: true }];
  const match: GroupWorkspaceMatch = { status: 'matched', profile: 'group', root: '/group', repositories: repos };
  const base = { match, installed: { status: 'installed' as const, profile: 'group' as const,
    version: '0.17.0', capabilities: ['query', 'merge-repo'] }, expectedVersion: '0.17.0', revision: 'one' };
  assert.equal(resolveSkillsContext(base).mode, 'group'); assert.equal(resolveSkillsContext(base).root, '/group');
  assert.equal(resolveSkillsContext({ ...base, preferGroup: false }).mode, 'group', 'legacy mode flags do not override the local profile');
  const native = { ...base, match: { ...match, root: repos[0].path, profile: 'repository' as const }, installed: { ...base.installed, profile: 'repository' as const } };
  assert.equal(resolveSkillsContext(native).mode, 'repository'); assert.deepEqual(resolveSkillsContext(native).repositories, [repos[0]]);
  assert.deepEqual(resolveSkillsContext({ ...native, installed: { ...native.installed, status: 'error' } }).availableFeatures, []);
  assert.deepEqual(resolveSkillsContext({ ...native, installed: { ...native.installed, version: '0.16.0' } }).availableFeatures, []);
  const old = resolveSkillsContext({ ...native, installed: { ...native.installed, status: 'update-available', version: '0.16.0' } });
  assert.deepEqual(old.availableFeatures, []);
  assert.equal(resolveSkillsContext({ ...native, match: { ...native.match, status: 'checking' } }).mode, 'unavailable');
});
