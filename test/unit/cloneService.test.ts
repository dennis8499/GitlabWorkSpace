import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { GitLabProject } from '../../src/api/types';
import { cloneProjects, ClonePreflightError, createCloneEnvironmentForTest, planClones } from '../../src/git/cloneService';

const dummyToken = 'clone-unit-test-token-do-not-use';

function project(name: string, localPath = name): GitLabProject {
  return {
    id: name.length + 1,
    name,
    path: localPath,
    path_with_namespace: `group/${localPath}`,
    web_url: `https://gitlab.example.test/group/${localPath}`,
    http_url_to_repo: `https://gitlab.example.test/group/${localPath}.git`
  };
}

test('clones a temporary Git repository and keeps credentials out of args and remote URL', async () => {
  const temp = mkdtempSync(path.join(os.tmpdir(), 'gitlab-workspace-clone-'));
  try {
    const workspace = path.join(temp, 'workspace');
    const source = path.join(temp, 'source');
    const bare = path.join(temp, 'source.git');
    mkdirSync(workspace);
    execFileSync('git', ['init', '--quiet', source]);
    execFileSync('git', ['-C', source, 'config', 'user.email', 'test@example.invalid']);
    execFileSync('git', ['-C', source, 'config', 'user.name', 'Test User']);
    writeFileSync(path.join(source, 'README.md'), 'clone verification\n');
    execFileSync('git', ['-C', source, 'add', 'README.md']);
    execFileSync('git', ['-C', source, 'commit', '--quiet', '-m', 'initial']);
    execFileSync('git', ['clone', '--quiet', '--bare', source, bare]);

    const repo = project('demo');
    let argsText = '';
    const results = await cloneProjects(workspace, [repo], 'https://gitlab.example.test', dummyToken, () => undefined,
      async (plan, _baseUrl, token) => {
        const args = ['clone', '--quiet', '--', bare, plan.targetPath];
        argsText = args.join(' ');
        execFileSync('git', args, {
          cwd: workspace,
          env: createCloneEnvironmentForTest(plan.project.http_url_to_repo, token)
        });
      });

    assert.equal(results.completed.length, 1);
    assert.equal(readFileSync(path.join(workspace, 'demo', 'README.md'), 'utf8').trimEnd(), 'clone verification');
    const remoteUrl = execFileSync('git', ['-C', path.join(workspace, 'demo'), 'remote', 'get-url', 'origin'], { encoding: 'utf8' }).trim();
    assert.doesNotMatch(argsText, /clone-unit-test-token-do-not-use/);
    assert.doesNotMatch(remoteUrl, /clone-unit-test-token-do-not-use|oauth2/);
    assert.equal(remoteUrl, bare);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test('preflights every destination before starting any clone', async () => {
  const temp = mkdtempSync(path.join(os.tmpdir(), 'gitlab-workspace-collision-'));
  try {
    const workspace = path.join(temp, 'workspace');
    mkdirSync(workspace);
    mkdirSync(path.join(workspace, 'second'));
    let started = 0;
    await assert.rejects(
      cloneProjects(workspace, [project('first'), project('second')], 'https://gitlab.example.test', dummyToken, () => undefined,
        async () => { started += 1; }),
      (error: unknown) => error instanceof ClonePreflightError && /No repositories were cloned/.test(error.message)
    );
    assert.equal(started, 0);
    assert.equal(existsSync(path.join(workspace, 'first')), false);
    assert.equal(existsSync(path.join(workspace, 'second')), true);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test('rejects unsafe names, duplicate destinations, and clone URLs on a different origin', () => {
  const temp = mkdtempSync(path.join(os.tmpdir(), 'gitlab-workspace-plan-'));
  try {
    assert.throws(() => planClones(temp, [project('unsafe', '../outside')], 'https://gitlab.example.test'), /unsafe local folder name/);
    assert.throws(() => planClones(temp, [project('one', 'same'), project('two', 'SAME')], 'https://gitlab.example.test'), /same local folder name/);
    const external = { ...project('external'), http_url_to_repo: 'https://other.example.test/group/external.git' };
    assert.throws(() => planClones(temp, [external], 'https://gitlab.example.test'), /outside the configured GitLab server/);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});
