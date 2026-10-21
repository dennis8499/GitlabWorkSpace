import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { GitLabProject } from '../../src/api/types';
import { ProjectEnvironmentSnapshotCache } from '../../src/workspace/projectEnvironmentSnapshotCache';
import { inspectProjectEnvironment } from '../../src/workspace/workspaceEnvironment';
import { OperationLog } from '../../src/logging/operationLog';

const project = (id: number, name: string): GitLabProject => ({ id, name, path: name,
  path_with_namespace: `team/${name}`, http_url_to_repo: `https://gitlab.test/team/${name}.git`,
  web_url: `https://gitlab.test/team/${name}` });
const projects = [project(1, 'first'), project(2, 'other')];
const matches = (remote: string, item: GitLabProject): boolean => remote === item.http_url_to_repo;
const git = (root: string, ...args: string[]): string => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', windowsHide: true });
const commit = (root: string): void => { git(root, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '--quiet', '--allow-empty', '-m', 'baseline'); };

function fixture(capacity = 8) {
  const base = mkdtempSync(path.join(os.tmpdir(), 'environment-snapshot-'));
  const root = path.join(base, 'Group'); mkdirSync(root);
  let discoveries = 0;
  const cache = new ProjectEnvironmentSnapshotCache(async (...args) => {
    discoveries++;
    return inspectProjectEnvironment(...args);
  }, capacity);
  const repo = (name: string, parent = root): string => {
    const target = path.join(parent, name); mkdirSync(target, { recursive: true });
    git(target, 'init', '--quiet'); git(target, 'remote', 'add', 'origin', projects[0].http_url_to_repo);
    return realpathSync.native(target);
  };
  const inspect = (target = root, items: readonly GitLabProject[] = projects, scopeKey = 'account/group') =>
    cache.inspect(target, items, matches, { scopeKey });
  return { base, root, repo, cache, inspect, discoveries: () => discoveries,
    cleanup: () => { cache.clear(); rmSync(base, { recursive: true, force: true }); } };
}

test('reuses verified local discovery and protects its retained value from UI mutation', async () => {
  const f = fixture(); try {
    f.repo('first');
    const first = await f.inspect();
    assert.equal(first.repositories[0].projectId, 1);
    first.repositories.length = 0;
    assert.equal((await f.inspect()).repositories.length, 1);
    assert.equal(f.discoveries(), 1);
    f.cache.invalidate(f.root);
    await f.inspect(); assert.equal(f.discoveries(), 2);
    await f.cache.inspect(f.root, projects, matches, { scopeKey: 'account/group', forceRefresh: true });
    assert.equal(f.discoveries(), 3);
  } finally { f.cleanup(); }
});

test('filesystem validation detects added, renamed and removed child repositories and Git markers', async () => {
  const f = fixture(); try {
    const first = f.repo('first'); await f.inspect();
    const second = f.repo('second'); assert.equal((await f.inspect()).repositories.length, 2);
    renameSync(second, path.join(f.root, 'renamed'));
    assert.ok((await f.inspect()).repositories.some(repo => repo.name === 'renamed'));
    renameSync(path.join(first, '.git'), path.join(first, 'saved-git'));
    assert.equal((await f.inspect()).repositories.length, 1);
    rmSync(path.join(f.root, 'renamed'), { recursive: true });
    assert.equal((await f.inspect()).repositories.length, 0);
    assert.equal(f.discoveries(), 5);
  } finally { f.cleanup(); }
});

test('hashes remote configuration contents even if file size and modification time are restored', async () => {
  const f = fixture(); try {
    const repo = f.repo('first'); await f.inspect();
    const config = path.join(repo, '.git', 'config'); const original = statSync(config);
    const value = readFileSync(config, 'utf8').replace('/first.git', '/other.git');
    writeFileSync(config, value); utimesSync(config, original.atime, original.mtime);
    assert.equal((await f.inspect()).repositories[0].projectId, 2);
    assert.equal(f.discoveries(), 2);
  } finally { f.cleanup(); }
});

test('a new parent repository invalidates an empty container snapshot', async () => {
  const f = fixture(); try {
    assert.equal((await f.inspect()).profile, 'group');
    git(f.base, 'init', '--quiet');
    assert.equal((await f.inspect()).status, 'error');
    assert.equal((await f.inspect()).status, 'error', 'error results are not retained');
    assert.equal(f.discoveries(), 3);
  } finally { f.cleanup(); }
});

test('classification inputs, matcher identity and account scope cannot share stale associations', async () => {
  const f = fixture(); try {
    f.repo('first'); await f.inspect();
    assert.equal((await f.inspect(f.root, [])).repositories[0].matched, false);
    await f.inspect(f.root, projects, 'other-account/group');
    const different = await f.cache.inspect(f.root, projects, () => false, { scopeKey: 'account/group' });
    assert.equal(different.repositories[0].matched, false);
    assert.equal(f.discoveries(), 4);
  } finally { f.cleanup(); }
});

test('worktree common config and worktree-specific config both invalidate discovery', async () => {
  const f = fixture(); try {
    const repo = f.repo('first'); commit(repo);
    const linked = path.join(f.root, 'linked'); git(repo, 'worktree', 'add', '--quiet', '--detach', linked, 'HEAD');
    assert.equal((await f.inspect(linked)).repositories[0].projectId, 1);
    await f.inspect(linked); assert.equal(f.discoveries(), 1);
    git(repo, 'remote', 'set-url', 'origin', projects[1].http_url_to_repo);
    assert.equal((await f.inspect(linked)).repositories[0].projectId, 2);
    git(repo, 'config', 'extensions.worktreeConfig', 'true');
    git(linked, 'config', '--worktree', 'remote.origin.url', projects[0].http_url_to_repo);
    const changed = await f.inspect(linked);
    assert.equal(changed.repositories[0].matched, false, 'multiple effective origin values stay ambiguous');
    assert.equal(f.discoveries(), 3);
  } finally { f.cleanup(); }
});

test('submodule gitdir pointers are validated against their resolved configuration', async () => {
  const f = fixture(); try {
    const source = f.repo('source', f.base); commit(source);
    const parent = f.repo('parent');
    git(parent, '-c', 'protocol.file.allow=always', 'submodule', 'add', '--quiet', source, 'module');
    const submodule = path.join(parent, 'module');
    git(submodule, 'remote', 'set-url', 'origin', projects[0].http_url_to_repo);
    assert.equal((await f.inspect(submodule)).repositories[0].projectId, 1);
    await f.inspect(submodule); assert.equal(f.discoveries(), 1);
    git(submodule, 'remote', 'set-url', 'origin', projects[1].http_url_to_repo);
    assert.equal((await f.inspect(submodule)).repositories[0].projectId, 2);
    assert.equal(f.discoveries(), 2);
  } finally { f.cleanup(); }
});

test('configuration includes bypass snapshots so external included files cannot hide a remote change', async () => {
  const f = fixture(); try {
    const repo = f.repo('first'); git(repo, 'remote', 'remove', 'origin');
    const included = path.join(f.base, 'included.config');
    const writeRemote = (remote: string): void => writeFileSync(included, `[remote "origin"]\nurl = ${remote}\n`);
    writeRemote(projects[0].http_url_to_repo);
    git(repo, 'config', 'include.path', included.replaceAll('\\', '/'));
    assert.equal((await f.inspect()).repositories[0].projectId, 1);
    writeRemote(projects[1].http_url_to_repo);
    assert.equal((await f.inspect()).repositories[0].projectId, 2);
    await f.inspect(); assert.equal(f.discoveries(), 3);
  } finally { f.cleanup(); }
});

test('coalesces validated discovery, lets one subscriber abort, and bounds retained snapshots', async () => {
  const f = fixture(2); try {
    f.repo('first');
    const controller = new AbortController();
    const first = f.cache.inspect(f.root, projects, matches, { scopeKey: 'shared', signal: controller.signal });
    const second = f.inspect(f.root, projects, 'shared');
    // Filesystem validation is asynchronous; attach the rejection handler before cancelling.
    const rejected = assert.rejects(first, { name: 'AbortError' });
    controller.abort(); await rejected;
    assert.equal((await second).repositories[0].projectId, 1);
    assert.equal(f.discoveries(), 1);
    await Promise.all([f.inspect(f.root, projects, 'another'), f.inspect(f.root, projects, 'another')]);
    assert.equal(f.discoveries(), 2);
    await f.inspect(f.root, projects, 'third');
    await f.inspect(f.root, projects, 'shared');
    assert.equal(f.discoveries(), 4, 'least-recently-used scope is evicted');
  } finally { f.cleanup(); }
});

test('a repository changed during discovery is returned without retaining its obsolete snapshot', async () => {
  const f = fixture(); try {
    const repo = f.repo('first'); let discoveries = 0;
    const cache = new ProjectEnvironmentSnapshotCache(async (...args) => {
      discoveries++; const result = await inspectProjectEnvironment(...args);
      if (discoveries === 1) git(repo, 'remote', 'set-url', 'origin', projects[1].http_url_to_repo);
      return result;
    });
    try {
      await cache.inspect(f.root, projects, matches, { scopeKey: 'one' });
      assert.equal((await cache.inspect(f.root, projects, matches, { scopeKey: 'one' })).repositories[0].projectId, 2);
      assert.equal(discoveries, 2);
    } finally { cache.clear(); }
  } finally { f.cleanup(); }
});

test('the 18-repository replay reuses 37 Git probes after 70 seconds while validating filesystem state', async () => {
  const f = fixture(); let now = 1_000; let discoveries = 0;
  const lines: string[] = [];
  const log = new OperationLog({ info: line => lines.push(line), warn: line => lines.push(line), error: line => lines.push(line) });
  const cache = new ProjectEnvironmentSnapshotCache(async (...args) => {
    discoveries++; return inspectProjectEnvironment(...args);
  }, 8, () => now);
  try {
    for (let index = 0; index < 18; index++) f.repo(`repo-${index}`);
    await log.run('workspace', 'snapshotReplay', {}, async () => {
      assert.equal((await cache.inspect(f.root, projects, matches, { scopeKey: 'account/group' })).repositories.length, 18);
      const probeCount = () => lines.filter(line => /^\[git\] (rev-parse|config) started /.test(line)).length;
      assert.equal(probeCount(), 37);
      now += 70_000;
      await cache.inspect(f.root, projects, matches, { scopeKey: 'account/group' });
      assert.equal(probeCount(), 37, 'copying a prompt reuses the analysis discovery');
      assert.equal(discoveries, 1);
      git(path.join(f.root, 'repo-0'), 'remote', 'set-url', 'origin', projects[1].http_url_to_repo);
      assert.equal((await cache.inspect(f.root, projects, matches, { scopeKey: 'account/group' }))
        .repositories.find(repo => repo.name === 'repo-0')?.projectId, 2);
      assert.equal(probeCount(), 74, 'a changed config requires a fresh discovery');
    });
  } finally { cache.clear(); log.dispose(); f.cleanup(); }
});

test('clearing an account generation discards an old discovery even when its inspector ignores abort', async () => {
  const f = fixture();
  let release!: () => void;
  let entered!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { entered = resolve; });
  const cache = new ProjectEnvironmentSnapshotCache(async (...args) => {
    const result = await inspectProjectEnvironment(...args);
    entered(); await gate; return result;
  });
  try {
    f.repo('first');
    const old = cache.inspect(f.root, projects, matches, { scopeKey: 'old-account' });
    const rejected = assert.rejects(old, { name: 'AbortError' });
    await started; cache.clear(); release(); await rejected;
    assert.equal((await cache.inspect(f.root, projects, matches, { scopeKey: 'new-account' })).repositories[0].projectId, 1);
  } finally { release(); cache.clear(); f.cleanup(); }
});
