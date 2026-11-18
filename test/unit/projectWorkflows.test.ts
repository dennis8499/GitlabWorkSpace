import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ensureLocalCommit, withWorkflowExecution, workflowGit } from '../../src/codex/projectWorkflows';

async function fixture(t: test.TestContext) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'glw-project-workflow-'));
  assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repo = path.join(root, 'repo'); await mkdir(repo);
  const git = (...args: string[]) => execFileSync('git', ['-c', 'core.hooksPath=', '-c', 'user.name=Workflow Test', '-c', 'user.email=workflow@test.local', ...args],
    { cwd: repo, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git('init', '-b', 'main'); await writeFile(path.join(repo, 'main.ts'), 'export const answer = 1;\n');
  git('add', '.'); git('commit', '-m', 'Initial fixture');
  return { repo, git };
}

test('Workflow Git checks cancellation before starting a local mutation', async t => {
  const f = await fixture(t), abort = new AbortController(); abort.abort();
  await assert.rejects(withWorkflowExecution({ signal: abort.signal }, () => workflowGit(f.repo, ['checkout', '-b', 'must-not-exist'])), /cancel/i);
  assert.equal(f.git('branch', '--show-current'), 'main');
});

test('a present fixed commit does not contact a remote and an absent commit needs explicit synchronization', async t => {
  const f = await fixture(t), sha = f.git('rev-parse', 'HEAD');
  await ensureLocalCommit(f.repo, sha, { remote: 'remote-that-does-not-exist', ref: 'refs/heads/main' });
  await assert.rejects(ensureLocalCommit(f.repo, 'f'.repeat(40)), /本機缺少/);
});
