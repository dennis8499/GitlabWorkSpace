import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { collectIssueResult } from '../../src/codex/projectWorkflows';
import { createRequirementSnapshot, freezeVerificationProfile } from '../../src/codex/workContext';
import type { CodexOutputItem, CodexTaskSpec } from '../../src/codex/protocol';

function git(root: string, ...args: string[]): string {
  return execFileSync('git', ['-C', root, '-c', 'core.hooksPath=', '-c', 'user.name=Profile Test', '-c', 'user.email=profile@test.invalid', '-c', 'commit.gpgsign=false', ...args],
    { encoding: 'utf8', windowsHide: true, env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_NO_LAZY_FETCH: '1' } }).trim();
}
async function fixture(t: test.TestContext, commands: string[] = ['npm run lint:docs']) {
  const parent = await realpath(os.tmpdir()), root = await realpath(await mkdtemp(path.join(parent, 'glw-profile-result-')));
  t.after(async () => { assert.equal(path.dirname(root).toLowerCase(), parent.toLowerCase()); await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); });
  git(root, 'init', '-q', '--initial-branch=main'); await writeFile(path.join(root, 'README.md'), '# Original\n'); git(root, 'add', '.'); git(root, 'commit', '-qm', 'baseline');
  const sourceSha = git(root, 'rev-parse', 'HEAD');
  const spec: CodexTaskSpec = { source: { kind: 'issue', projectId: 1, issueIid: 2 }, root, title: 'Documentation issue', prompt: 'Use selected checks', workspaceKey: root, environmentKey: 'fixture', writableRoots: [root],
    origin: { kind: 'issue', accountKey: 'fixture', baseUrl: 'https://gitlab.test', projectId: 1, iid: 2, projectPath: 'team/repo', webUrl: 'https://gitlab.test/team/repo/-/issues/2', repositoryRoot: root, sourceBranch: 'main', branch: 'main', sourceSha },
    workContext: { schema: 'GitLabWorkspaceWorkContext/v1', requirement: createRequirementSnapshot({ source: { kind: 'issue', identity: 'issue:2' }, title: 'Documentation issue', description: '' }),
      verification: freezeVerificationProfile({ kind: 'docs', commands, reason: 'Only documentation changed' }) } };
  const command = (name: string, exitCode = 0, cwd = root): CodexOutputItem => ({ id: 'native-check', kind: 'command', command: name, exitCode, cwd, final: true, text: 'Check result' });
  return { root, spec, command };
}

test('documentation-only changes accept the configured lint entry without forcing a test command', async t => {
  const f = await fixture(t); await writeFile(path.join(f.root, 'README.md'), '# Updated guide\n');
  const result = await collectIssueResult(f.spec, [f.command('npm run lint:docs')]);
  assert.equal(result.state, 'ready'); assert.deepEqual(result.files, ['README.md']);
  assert.deepEqual(result.tests, [{ command: 'npm run lint:docs', exitCode: 0 }]); assert.match(result.evidence!.digest, /^[a-f0-9]{64}$/);
});

test('a configured profile requires every selected check and rejects success from another directory', async t => {
  const f = await fixture(t, ['npm run lint:docs', 'npm run build:docs']); await writeFile(path.join(f.root, 'README.md'), '# Updated\n');
  assert.equal((await collectIssueResult(f.spec, [f.command('npm run lint:docs')])).state, 'needs-work');
  assert.equal((await collectIssueResult(f.spec, [f.command('npm run lint:docs'), f.command('npm run build:docs', 0, path.dirname(f.root))])).state, 'needs-work');
  assert.equal((await collectIssueResult(f.spec, [f.command('npm run lint:docs'), f.command('npm run build:docs')])).state, 'ready');
});

test('failed documentation checks retain failure and do not create successful implementation evidence', async t => {
  const f = await fixture(t); await writeFile(path.join(f.root, 'README.md'), '# Updated\n');
  const result = await collectIssueResult(f.spec, [f.command('npm run lint:docs', 1)]);
  assert.equal(result.state, 'needs-work'); assert.equal(result.evidence, undefined); assert.equal(result.tests![0].exitCode, 1);
});

test('already-satisfied issues need an explicit conclusion and native checks before a no-change result is ready', async t => {
  const f = await fixture(t), conclusion: CodexOutputItem = { id: 'conclusion', kind: 'agent', text: 'This requirement is already satisfied; no changes needed.' };
  assert.equal((await collectIssueResult(f.spec, [f.command('npm run lint:docs')])).state, 'needs-work');
  assert.equal((await collectIssueResult(f.spec, [conclusion])).state, 'needs-work');
  const ready = await collectIssueResult(f.spec, [conclusion, f.command('npm run lint:docs')]);
  assert.equal(ready.state, 'ready'); assert.deepEqual(ready.files, []); assert.match(ready.summary, /不建立空 Commit 或 MR/); assert.ok(ready.evidence);
  assert.equal((await collectIssueResult(f.spec, [conclusion, f.command('npm run lint:docs', 1)])).state, 'needs-work');
  assert.equal(git(f.root, 'rev-list', '--count', 'HEAD'), '1'); assert.equal(git(f.root, 'status', '--porcelain'), '');
});
