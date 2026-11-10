import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { inspectChanges, parseChanges, selectValidation } from './validation-selection.mjs';

const change = (filename, status = 'M') => ({ status, paths: [filename] });
const select = changes => selectValidation({ eventName: 'pull_request', changes }).mode;

test('routes UI, unit, public docs and historical evidence to their minimum complete profile', () => {
  assert.equal(select([change('src/webview/Tabs.tsx'), change('test/behavior/dashboard.test.mjs')]), 'ui');
  assert.equal(select([change('test/unit/workspace.test.ts')]), 'quick');
  assert.equal(select([change('src/webview/style.css'), change('test/unit/workspace.test.ts')]), 'ui');
  for (const filename of ['README.md', 'CONTRIBUTING.md', 'docs/user-guide.md']) {
    assert.equal(select([change(filename)]), 'package');
  }
  assert.equal(select([change('docs/work/review/results.json')]), 'none');
  assert.equal(select([change('test/unit/workspace.test.ts'), change('docs/work/review/results.json')]), 'quick');
});

test('unknown paths, mixed public docs and source, validation changes and malformed lists fail closed', () => {
  for (const filename of ['src/extension.ts', 'scripts/validation-selection.mjs', 'package-lock.json',
    '.github/workflows/release.yml', '.agents/skills/example/SKILL.md', '../test/unit/escape.ts',
    'src\\webview\\Tabs.tsx', 'docs//guide.md', '/docs/guide.md', 'unknown.txt']) {
    assert.equal(select([change(filename)]), 'all', filename);
  }
  assert.equal(select([change('README.md'), change('src/webview/Tabs.tsx')]), 'all');
  for (const changes of [undefined, [], [{ status: 'X', paths: ['README.md'] }],
    [{ status: 'R100', paths: ['README.md'] }], [{ status: 'M', paths: ['README.md', 'docs/work/other.md'] }]]) {
    assert.equal(select(changes), 'all');
  }
});

test('classifies additions, deletions, copies and both sides of renames without losing unsafe paths', () => {
  assert.equal(select([change('test/unit/new.test.ts', 'A'), change('test/unit/old.test.ts', 'D')]), 'quick');
  assert.equal(select([{ status: 'R100', paths: ['src/extension.ts', 'src/webview/extension.ts'] }]), 'all');
  assert.equal(select([{ status: 'R085', paths: ['docs/work/old.md', 'README.md'] }]), 'package');
  assert.equal(select([{ status: 'R85', paths: ['docs/work/old.md', 'README.md'] }]), 'package');
  assert.equal(select([{ status: 'C100', paths: ['scripts/check.mjs', 'docs/work/check.mjs'] }]), 'all');
  assert.equal(select([{ status: 'R100', paths: ['docs/work/old.md', 'docs/work/new.md'] }]), 'none');
  assert.deepEqual(parseChanges('M\0src/webview/name with\nnewline.tsx\0R100\0docs/work/old.md\0src/extension.ts\0'), [
    change('src/webview/name with\nnewline.tsx'), { status: 'R100', paths: ['docs/work/old.md', 'src/extension.ts'] }
  ]);
  for (const output of ['', 'M\0README.md', 'M\0', 'R100\0README.md\0', 'U\0README.md\0']) {
    assert.throws(() => parseChanges(output));
  }
});

test('main, tags, manual and reusable workflows always run all without trusting a file list', () => {
  for (const eventName of ['push', 'workflow_dispatch', 'workflow_call', undefined]) {
    assert.equal(inspectChanges({ eventName, git: () => assert.fail('Non-PR does not need Git diff') }).mode, 'all');
  }
});

test('uses a complete merge-base diff and fails closed on unavailable commits, conflicts or truncated data', () => {
  const options = { eventName: 'pull_request', base: 'a'.repeat(40), head: 'b'.repeat(40), repository: 'repo' };
  let calls = 0;
  const git = (command, args, settings) => {
    calls++;
    assert.equal(command, 'git');
    assert.deepEqual(args, ['-C', 'repo', 'diff', '--name-status', '-z', '--find-renames', `${options.base}...${options.head}`, '--']);
    assert.equal(settings.windowsHide, true);
    return { status: 0, stdout: 'M\0src/webview/Tabs.tsx\0' };
  };
  assert.equal(inspectChanges({ ...options, git }).mode, 'ui');
  assert.equal(calls, 1);
  for (const result of [{ status: 128 }, { status: null, error: new Error('timeout') },
    { status: 0, stdout: 'M\0README.md' }, { status: 0, stdout: '' }, { status: 0, stdout: 'U\0README.md\0' }]) {
    assert.equal(inspectChanges({ ...options, git: () => result }).mode, 'all');
  }
  assert.equal(inspectChanges({ ...options, base: '--bad', git: () => assert.fail('Invalid ref must not run') }).mode, 'all');
  assert.equal(inspectChanges({ ...options, git: () => { throw new Error('Missing Git'); } }).mode, 'all');
});

test('real Git merge-base diffs keep base-only changes out and detect renamed runtime paths', async t => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'glw-validation-selection-'));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const repository = path.join(temporary, 'repo');
  const globalConfig = path.join(temporary, 'gitconfig');
  await writeFile(globalConfig, '');
  const git = (...args) => {
    const result = spawnSync('git', ['-C', repository, ...args], { encoding: 'utf8', windowsHide: true,
      env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: globalConfig,
        GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
        GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid' } });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  await mkdir(path.join(repository, 'src/webview'), { recursive: true });
  await writeFile(path.join(repository, 'src/extension.ts'), 'export const fixture = true;\n');
  git('init', '--quiet'); git('add', '.'); git('commit', '--quiet', '-m', 'common');
  const common = git('rev-parse', 'HEAD');
  await writeFile(path.join(repository, 'src/extension.ts'), 'export const fixture = false;\n');
  git('add', '.'); git('commit', '--quiet', '-m', 'base-only runtime change');
  const base = git('rev-parse', 'HEAD');
  git('checkout', '--quiet', '--detach', common);
  await writeFile(path.join(repository, 'src/webview/name with space.tsx'), 'export const view = true;\n');
  git('add', '.'); git('commit', '--quiet', '-m', 'head UI addition');
  let head = git('rev-parse', 'HEAD');
  assert.equal(inspectChanges({ repository, eventName: 'pull_request', base, head }).mode, 'ui');
  git('mv', 'src/extension.ts', 'src/webview/extension.ts');
  git('commit', '--quiet', '-m', 'move runtime into UI');
  head = git('rev-parse', 'HEAD');
  assert.equal(inspectChanges({ repository, eventName: 'pull_request', base, head }).mode, 'all');
  assert.equal(inspectChanges({ repository, eventName: 'pull_request', base: 'f'.repeat(40), head }).mode, 'all');
});
