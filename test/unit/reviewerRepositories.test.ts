import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, realpath, rm, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { collectReviewerRepositories } from '../../src/workspace/reviewerRepositories';

test('reviewer candidates include all open folders and native parent Repos, without sibling prefix matches', () => {
  const native = [
    { name: 'service', path: '/work/a/service' }, { name: 'service', path: '/other/service' },
    { name: 'parent', path: '/parent' }, { name: 'unrelated', path: '/work/ab/unrelated' }
  ];
  const repositories = collectReviewerRepositories(native, [{ name: 'offline', path: '/work/a/offline' }],
    ['/work/a', '/other/service', '/parent/src'], 'linux', value => value);
  assert.deepEqual(repositories.map(repository => repository.path),
    ['/work/a/offline', '/parent', '/other/service', '/work/a/service']);
});

test('reviewer candidate canonicalization deduplicates Windows casing and preserves verified default branches', () => {
  const repositories = collectReviewerRepositories([{ name: 'native', path: 'c:\\WORK\\Service' }],
    [{ name: 'verified', path: 'C:\\work\\service', defaultBranch: 'main' }],
    ['C:\\work'], 'win32', value => value);
  assert.deepEqual(repositories, [{ name: 'native', path: 'c:\\WORK\\Service', defaultBranch: 'main' }]);
  assert.deepEqual(collectReviewerRepositories(repositories, [], ['C:\\workspace'], 'win32', value => value), []);
});

test('linked worktrees remain distinct while directory aliases canonicalize to one candidate', async t => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'reviewer-inventory-'));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const repository = path.join(temporary, 'service'), linked = path.join(temporary, 'linked');
  await mkdir(repository);
  execFileSync('git', ['init', '--quiet', repository]);
  execFileSync('git', ['-C', repository, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '--quiet', '--allow-empty', '-m', 'baseline']);
  execFileSync('git', ['-C', repository, 'worktree', 'add', '--quiet', '--detach', linked, 'HEAD']);
  const alias = path.join(temporary, 'alias');
  await symlink(repository, alias, process.platform === 'win32' ? 'junction' : 'dir');
  const canonicalRoot = await realpath(repository), aliasRoot = await realpath(alias), canonicalLinked = await realpath(linked), canonicalFolder = await realpath(temporary);
  const repositories = collectReviewerRepositories([
    { name: 'service', path: canonicalRoot }, { name: 'alias', path: aliasRoot }, { name: 'linked', path: canonicalLinked }
  ], [], [canonicalFolder]);
  assert.equal(repositories.length, 2);
  assert.deepEqual(repositories.map(repository => repository.path).sort(), (await Promise.all([repository, linked].map(value => realpath(value)))).sort());
});
