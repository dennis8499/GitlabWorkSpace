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

test('all opened Repos and direct children match by origin, including renamed subgroup projects', async () => {
  const f = fixture(); try {
    const first = f.repo('renamed', projects[0].http_url_to_repo);
    const second = f.repo('docs', projects[1].ssh_url_to_repo);
    mkdirSync(path.join(first, 'src'));
    const match = await f.inspect([f.root, path.join(first, 'src'), second]);
    assert.equal(match.status, 'matched'); assert.equal(match.root, f.root);
    assert.deepEqual(match.repositories.map(repo => repo.projectId).sort(), [1, 2]);
    assert.equal(match.repositories.length, 2, 'nested folders and direct children are deduplicated by Git root');
  } finally { f.cleanup(); }
});

test('a mixed Group or an unverified origin disables Group even when other remotes match', async () => {
  const f = fixture(); try {
    f.repo('service', projects[0].http_url_to_repo);
    const unrelated = f.repo('docs', 'https://other-host.test/team/subgroup/docs.git');
    execFileSync('git', ['-C', unrelated, 'remote', 'add', 'upstream', projects[1].http_url_to_repo]);
    let match = await f.inspect([f.root]);
    assert.equal(match.status, 'mismatched'); assert.equal(match.root, undefined);
    assert.equal(match.repositories.find(repo => repo.path === unrelated)?.matched, false);
    const fingerprint = match.repositories.find(repo => repo.path === unrelated)?.remoteFingerprint;
    execFileSync('git', ['-C', unrelated, 'remote', 'set-url', 'origin', projects[1].http_url_to_repo]);
    match = await f.inspect([f.root]); assert.equal(match.status, 'matched');
    assert.notEqual(match.repositories.find(repo => repo.path === unrelated)?.remoteFingerprint, fingerprint);
    execFileSync('git', ['-C', unrelated, 'remote', 'remove', 'origin']);
    match = await f.inspect([f.root]); assert.equal(match.status, 'mismatched');
    assert.equal(match.repositories.length, 2, 'missing origin remains a native Repo candidate');
    execFileSync('git', ['-C', unrelated, 'config', '--add', 'remote.origin.url', projects[1].http_url_to_repo]);
    execFileSync('git', ['-C', unrelated, 'config', '--add', 'remote.origin.url', projects[0].http_url_to_repo]);
    assert.equal((await f.inspect([f.root])).status, 'mismatched', 'multiple origin URLs are ambiguous');
  } finally { f.cleanup(); }
});

test('an empty folder offers first download separately from a verified Group root', async () => {
  const f = fixture(); try {
    const empty = await f.inspect([f.root]);
    assert.equal(empty.status, 'unverified'); assert.equal(empty.root, undefined); assert.equal(empty.cloneRoot, f.root);
    const offline = await f.inspect([f.root], { ...scope, connected: false });
    assert.equal(offline.cloneRoot, undefined);
    f.repo('any-name', projects[0].http_url_to_repo);
    assert.equal((await f.inspect([f.root])).root, f.root);
  } finally { f.cleanup(); }
});

test('worktrees resolve to their actual roots; matching Repos under multiple parents remain ambiguous', async () => {
  const f = fixture(); try {
    const repo = f.repo('service', projects[0].http_url_to_repo);
    execFileSync('git', ['-C', repo, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '--allow-empty', '-m', 'baseline']);
    const linked = path.join(f.root, 'linked');
    execFileSync('git', ['-C', repo, 'worktree', 'add', '--quiet', '--detach', linked, 'HEAD']);
    const match = await f.inspect([linked]); assert.equal(match.status, 'matched'); assert.equal(match.root, f.root);
    assert.equal(match.repositories[0].path, canonical(linked));
    const outside = f.repo('other-service', projects[0].http_url_to_repo, path.join(f.base, 'another'));
    assert.equal((await f.inspect([repo, outside])).status, 'ambiguous');
    const container = path.join(f.base, 'non-git'); mkdirSync(container);
    assert.equal((await f.inspect([repo, container])).status, 'ambiguous', 'extra non-Git roots cannot be silently ignored');
  } finally { f.cleanup(); }
});

test('nested Git repositories remain native candidates and errors never imply a matched Group', async () => {
  const f = fixture(); try {
    const parent = f.repo('parent');
    const nested = f.repo('child', projects[0].http_url_to_repo, parent);
    assert.equal((await f.inspect([nested])).status, 'mismatched');
    const invalid = path.join(f.root, 'broken'); mkdirSync(invalid); writeFileSync(path.join(invalid, '.git'), 'not a Git directory');
    const failed = await f.inspect([f.root]);
    assert.equal(failed.status, 'error');
    assert.ok(failed.repositories.some(repo => repo.path === parent), 'valid Repo candidates remain usable when a sibling is broken');
    const offline = await f.inspect([nested], { ...scope, connected: false });
    assert.equal(offline.status, 'unverified'); assert.equal(offline.repositories[0].path, nested);
    const apiFailure = await f.inspect([nested], { ...scope, projectsReady: false });
    assert.equal(apiFailure.status, 'unverified'); assert.equal(apiFailure.root, undefined);
  } finally { f.cleanup(); }
});

test('Skills shares Group matching, native selection, version and verified resume capabilities', () => {
  const repos = [{ path: '/group/a', name: 'a', matched: true }, { path: '/group/b', name: 'b', matched: true }];
  const match: GroupWorkspaceMatch = { status: 'matched', root: '/group', repositories: repos };
  const base = { preferGroup: true, match, installed: { status: 'installed' as const, profile: 'group' as const,
    version: '0.17.0', capabilities: ['merge-group', 'megin-workflow', 'megin-resume'] }, expectedVersion: '0.17.0', revision: 'one' };
  assert.equal(resolveSkillsContext(base).mode, 'group');
  assert.equal(resolveSkillsContext(base).root, '/group');
  for (const status of ['mismatched', 'unverified', 'ambiguous', 'error'] as const) {
    const result = resolveSkillsContext({ ...base, match: { ...match, status, root: undefined }, selectedRoot: repos[1].path });
    assert.equal(result.mode, 'repository'); assert.equal(result.root, repos[1].path);
    assert.deepEqual(result.availableFeatures, [], 'Group installation never enables native features');
  }
  assert.equal(resolveSkillsContext({ ...base, preferGroup: false }).mode, 'unavailable');
  const native = { ...base, preferGroup: false, selectedRoot: repos[0].path, installed: { ...base.installed, profile: 'repository' as const } };
  assert.equal(resolveSkillsContext(native).mode, 'repository');
  assert.deepEqual(resolveSkillsContext({ ...native, installed: { ...native.installed, status: 'error' } }).availableFeatures, []);
  assert.deepEqual(resolveSkillsContext({ ...native, installed: { ...native.installed, version: '0.16.0' } }).availableFeatures, []);
  const old = resolveSkillsContext({ ...native, installed: { ...native.installed, status: 'work-in-progress', version: '0.16.0', activeWorkIds: ['work-20261010-old'] } });
  assert.equal(old.resumeOnly, true); assert.deepEqual(old.availableFeatures, ['megin-resume']);
  assert.equal(resolveSkillsContext({ ...native, match: { ...match, status: 'checking' } }).mode, 'unavailable');
  assert.equal(resolveSkillsContext({ ...native, selectedRoot: '/stale', match: { ...match, repositories: [repos[1]] } }).root, repos[1].path);
});
