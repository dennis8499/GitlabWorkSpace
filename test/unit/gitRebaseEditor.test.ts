import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

function git(cwd: string, args: string[], env: NodeJS.ProcessEnv): string {
  const result = spawnSync('git', args, { cwd, env: { ...process.env, ...env }, encoding: 'utf8', windowsHide: true });
  if (result.status !== 0) throw new Error(result.stderr || 'git failed: ' + args.join(' '));
  return result.stdout.trim();
}

function shellQuote(value: string): string {
  if (process.platform === 'win32') return '"' + value.replace(/["\\$`]/g, '\\$&') + '"';
  return "'" + value.replaceAll("'", "'\\''") + "'";
}

test('the GUI sequence and message editor applies reword and squash messages without opening a terminal editor', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'git-ui-rebase-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const env: NodeJS.ProcessEnv = {};
  git(root, ['init', '-q', '-b', 'main'], env);
  git(root, ['config', 'user.name', 'GUI Test'], env);
  git(root, ['config', 'user.email', 'gui@example.test'], env);
  await writeFile(path.join(root, 'base.txt'), 'base\n');
  git(root, ['add', '.'], env);
  git(root, ['commit', '-qm', 'base'], env);
  git(root, ['checkout', '-qb', 'target'], env);
  await writeFile(path.join(root, 'target.txt'), 'target\n');
  git(root, ['add', '.'], env);
  git(root, ['commit', '-qm', 'target commit'], env);
  const target = git(root, ['rev-parse', 'HEAD'], env);
  git(root, ['checkout', '-qb', 'feature', 'main'], env);
  await writeFile(path.join(root, 'first.txt'), 'first\n');
  git(root, ['add', '.'], env);
  git(root, ['commit', '-qm', 'first feature commit'], env);
  const first = git(root, ['rev-parse', 'HEAD'], env);
  await writeFile(path.join(root, 'second.txt'), 'second\n');
  git(root, ['add', '.'], env);
  git(root, ['commit', '-qm', 'old second message'], env);
  const second = git(root, ['rev-parse', 'HEAD'], env);
  const statePath = path.join(root, '.git', 'gitlab-workspace', 'rebase-ui.json');
  const helper = path.resolve('resources/git-rebase-editor.cjs');
  const editor = shellQuote(process.execPath) + ' ' + shellQuote(helper);
  const state = {
    todo: [{ hash: first, action: 'pick' }, { hash: second, action: 'reword' }],
    editorMessages: ['GUI supplied message']
  };
  await import('node:fs/promises').then(({ mkdir }) => mkdir(path.dirname(statePath), { recursive: true }));
  await writeFile(statePath, JSON.stringify(state));
  const rebaseEnv = {
    ...env,
    GITLABWORKSPACE_REBASE_UI_FILE: statePath,
    GIT_SEQUENCE_EDITOR: editor + ' sequence',
    GIT_EDITOR: editor + ' message'
  };
  const result = spawnSync('git', ['rebase', '--interactive', '--no-autosquash', target], {
    cwd: root, env: { ...process.env, ...rebaseEnv }, encoding: 'utf8', windowsHide: true
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(git(root, ['log', '-1', '--format=%s'], env), 'GUI supplied message');
  assert.equal(git(root, ['rev-list', '--count', target + '..HEAD'], env), '2');

  const beforeSquash = git(root, ['rev-parse', 'HEAD'], env);
  const currentCommits = git(root, ['rev-list', '--reverse', target + '..HEAD'], env).split(/\r?\n/);
  const state2 = {
    todo: [{ hash: currentCommits[0], action: 'pick' }, { hash: currentCommits[1], action: 'squash' }],
    editorMessages: ['GUI squash message']
  };
  await writeFile(statePath, JSON.stringify(state2));
  const squashResult = spawnSync('git', ['rebase', '--interactive', '--no-autosquash', target], {
    cwd: root, env: { ...process.env, ...rebaseEnv }, encoding: 'utf8', windowsHide: true
  });
  assert.equal(squashResult.status, 0, squashResult.stderr || squashResult.stdout);
  assert.equal(git(root, ['log', '-1', '--format=%s'], env), 'GUI squash message');
  assert.equal(git(root, ['rev-list', '--count', target + '..HEAD'], env), '1');
  assert.notEqual(git(root, ['rev-parse', 'HEAD'], env), beforeSquash);
});
