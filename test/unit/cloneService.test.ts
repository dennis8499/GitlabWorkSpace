import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import type { GitLabProject } from '../../src/api/types';
import {
  cloneProjects,
  ClonePreflightError,
  createCloneEnvironmentForTest,
  planClones,
  syncLocalDefaultBranches
} from '../../src/git/cloneService';

const dummyToken = 'clone-unit-test-token-do-not-use';
let remoteCounter = 0;

function project(name: string, localPath = name, branch = 'main'): GitLabProject {
  return {
    id: name.length + 1,
    name,
    path: localPath,
    path_with_namespace: 'group/' + localPath,
    web_url: 'https://gitlab.example.test/group/' + localPath,
    http_url_to_repo: 'https://gitlab.example.test/group/' + localPath + '.git',
    ssh_url_to_repo: 'git@gitlab.example.test:group/' + localPath + '.git',
    default_branch: branch
  };
}

function git(args: string[], cwd?: string): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function createBareRemote(temp: string, branch = 'main'): { source: string; bare: string } {
  const suffix = String(++remoteCounter) + '-' + branch;
  const source = path.join(temp, 'source-' + suffix);
  const bare = path.join(temp, 'remote-' + suffix + '.git');
  execFileSync('git', ['init', '--quiet', '--initial-branch=' + branch, source]);
  git(['-C', source, 'config', 'user.email', 'test@example.invalid']);
  git(['-C', source, 'config', 'user.name', 'Test User']);
  writeFileSync(path.join(source, 'README.md'), 'initial content\n');
  git(['-C', source, 'add', 'README.md']);
  git(['-C', source, 'commit', '--quiet', '-m', 'initial']);
  execFileSync('git', ['clone', '--quiet', '--bare', source, bare]);
  git(['-C', source, 'remote', 'add', 'origin', bare]);
  return { source, bare };
}

function commitAndPush(source: string, branch: string, filename: string, contents: string, message: string): void {
  writeFileSync(path.join(source, filename), contents);
  git(['-C', source, 'add', filename]);
  git(['-C', source, 'commit', '--quiet', '-m', message]);
  git(['-C', source, 'push', 'origin', branch]);
}

function createExistingRepo(workspace: string, repo: GitLabProject, bare: string, origin = repo.http_url_to_repo): string {
  const target = path.join(workspace, repo.path);
  execFileSync('git', ['clone', '--quiet', bare, target]);
  git(['-C', target, 'config', 'user.email', 'test@example.invalid']);
  git(['-C', target, 'config', 'user.name', 'GitLab Workspace Tests']);
  git(['-C', target, 'remote', 'set-url', 'origin', origin]);
  return target;
}

function addUrlRewrite(remoteUrl: string, localUrl: string): () => void {
  const parsedCount = Number.parseInt(process.env.GIT_CONFIG_COUNT ?? '0', 10);
  const index = Number.isFinite(parsedCount) && parsedCount >= 0 ? parsedCount : 0;
  const keyName = 'GIT_CONFIG_KEY_' + index;
  const valueName = 'GIT_CONFIG_VALUE_' + index;
  const previous = {
    count: process.env.GIT_CONFIG_COUNT,
    key: process.env[keyName],
    value: process.env[valueName]
  };
  process.env.GIT_CONFIG_COUNT = String(index + 1);
  process.env[keyName] = 'url.' + pathToFileURL(localUrl).href + '.insteadOf';
  process.env[valueName] = remoteUrl;
  return () => {
    if (previous.count === undefined) delete process.env.GIT_CONFIG_COUNT;
    else process.env.GIT_CONFIG_COUNT = previous.count;
    if (previous.key === undefined) delete process.env[keyName];
    else process.env[keyName] = previous.key;
    if (previous.value === undefined) delete process.env[valueName];
    else process.env[valueName] = previous.value;
  };
}

test('clones a repository and keeps credentials out of args and remote URL', async () => {
  const temp = mkdtempSync(path.join(os.tmpdir(), 'gitlab-workspace-clone-'));
  try {
    const workspace = path.join(temp, 'workspace');
    mkdirSync(workspace);
    const { bare } = createBareRemote(temp);
    const repo = project('demo');
    let argsText = '';
    const results = await cloneProjects(
      workspace,
      [repo],
      'https://gitlab.example.test',
      dummyToken,
      () => undefined,
      {
        cloneRunner: async (plan, _baseUrl, token) => {
          const args = ['clone', '--quiet', '--', bare, plan.targetPath];
          argsText = args.join(' ');
          execFileSync('git', args, {
            cwd: workspace,
            env: createCloneEnvironmentForTest(plan.project.http_url_to_repo, token)
          });
        }
      }
    );

    assert.equal(results.cloned.length, 1);
    assert.equal(results.completed.length, 1);
    assert.equal(readFileSync(path.join(workspace, 'demo', 'README.md'), 'utf8').trim(), 'initial content');
    const remoteUrl = git(['-C', path.join(workspace, 'demo'), 'remote', 'get-url', 'origin']);
    assert.doesNotMatch(argsText, /clone-unit-test-token-do-not-use/);
    assert.doesNotMatch(remoteUrl, /clone-unit-test-token-do-not-use|oauth2/);
    assert.equal(remoteUrl, bare);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test('fast-forwards the GitLab default branch and switches from a feature branch', async () => {
  const temp = mkdtempSync(path.join(os.tmpdir(), 'gitlab-workspace-update-'));
  const workspace = path.join(temp, 'workspace');
  mkdirSync(workspace);
  const { source, bare } = createBareRemote(temp, 'release');
  const repo = project('demo', 'demo', 'release');
  const restoreRewrite = addUrlRewrite(repo.http_url_to_repo, bare);
  try {
    const firstRun = await cloneProjects(workspace, [repo], 'https://gitlab.example.test', dummyToken);
    assert.equal(firstRun.cloned.length, 1);
    const target = path.join(workspace, repo.path);
    git(['-C', target, 'switch', '--quiet', '-c', 'feature/work']);
    commitAndPush(source, 'release', 'latest.txt', 'latest content\n', 'remote update');
    const results = await cloneProjects(workspace, [repo], 'https://gitlab.example.test', dummyToken);
    assert.equal(results.updated.length, 1);
    assert.equal(results.skipped.length, 0);
    assert.equal(git(['-C', target, 'branch', '--show-current']), 'release');
    assert.equal(readFileSync(path.join(target, 'latest.txt'), 'utf8').trim(), 'latest content');
    assert.equal(git(['-C', target, 'config', '--get', 'remote.origin.url']), repo.http_url_to_repo);
  } finally {
    restoreRewrite();
    rmSync(temp, { recursive: true, force: true });
  }
});

test('accepts an SSH origin and leaves it unchanged after an update', async () => {
  const temp = mkdtempSync(path.join(os.tmpdir(), 'gitlab-workspace-ssh-'));
  const workspace = path.join(temp, 'workspace');
  mkdirSync(workspace);
  const { source, bare } = createBareRemote(temp);
  const repo = project('ssh-demo');
  const sshRepo = { ...repo, ssh_url_to_repo: undefined };
  const target = createExistingRepo(workspace, sshRepo, bare, repo.ssh_url_to_repo!);
  commitAndPush(source, 'main', 'latest.txt', 'ssh update\n', 'remote update');
  const restoreRewrite = addUrlRewrite(repo.http_url_to_repo, bare);
  try {
    const results = await cloneProjects(
      workspace,
      [sshRepo],
      'https://gitlab.example.test',
      dummyToken,
      () => undefined,
      { resolveProject: async () => repo }
    );
    assert.equal(results.updated.length, 1);
    assert.equal(readFileSync(path.join(target, 'latest.txt'), 'utf8').trim(), 'ssh update');
    assert.equal(git(['-C', target, 'config', '--get', 'remote.origin.url']), repo.ssh_url_to_repo);
  } finally {
    restoreRewrite();
    rmSync(temp, { recursive: true, force: true });
  }
});

test('creates a local tracking branch when the GitLab default branch is not present locally', async () => {
  const temp = mkdtempSync(path.join(os.tmpdir(), 'gitlab-workspace-new-branch-'));
  const workspace = path.join(temp, 'workspace');
  mkdirSync(workspace);
  const { source, bare } = createBareRemote(temp);
  const repo = project('new-branch');
  const target = createExistingRepo(workspace, repo, bare);
  git(['-C', target, 'switch', '--quiet', '-c', 'feature/work']);
  git(['-C', target, 'branch', '-D', 'main']);
  commitAndPush(source, 'main', 'latest.txt', 'new branch content\n', 'remote update');
  const restoreRewrite = addUrlRewrite(repo.http_url_to_repo, bare);
  try {
    const results = await cloneProjects(workspace, [repo], 'https://gitlab.example.test', dummyToken);
    assert.equal(results.updated.length, 1);
    assert.equal(git(['-C', target, 'branch', '--show-current']), 'main');
    assert.equal(git(['-C', target, 'config', '--get', 'branch.main.remote']), 'origin');
    assert.equal(readFileSync(path.join(target, 'latest.txt'), 'utf8').trim(), 'new branch content');
  } finally {
    restoreRewrite();
    rmSync(temp, { recursive: true, force: true });
  }
});

test('skips dirty and divergent repositories while continuing with later clones', async () => {
  const temp = mkdtempSync(path.join(os.tmpdir(), 'gitlab-workspace-skip-'));
  const workspace = path.join(temp, 'workspace');
  mkdirSync(workspace);
  const dirtyRemote = createBareRemote(temp, 'main');
  const dirtyProject = project('dirty');
  const dirtyTarget = createExistingRepo(workspace, dirtyProject, dirtyRemote.bare);
  git(['-C', dirtyTarget, 'switch', '--quiet', '-c', 'feature/local']);
  writeFileSync(path.join(dirtyTarget, 'README.md'), 'staged local change\n');
  git(['-C', dirtyTarget, 'add', 'README.md']);
  writeFileSync(path.join(dirtyTarget, 'untracked.txt'), 'keep me');

  const divergentRemote = createBareRemote(temp, 'main');
  const divergentProject = project('divergent');
  const divergentTarget = createExistingRepo(workspace, divergentProject, divergentRemote.bare);
  writeFileSync(path.join(divergentTarget, 'local.txt'), 'local commit\n');
  git(['-C', divergentTarget, 'add', 'local.txt']);
  git(['-C', divergentTarget, 'commit', '--quiet', '-m', 'local commit']);
  commitAndPush(divergentRemote.source, 'main', 'remote.txt', 'remote commit\n', 'remote commit');

  const newProject = project('new-after-skips');
  const restoreDirtyRewrite = addUrlRewrite(dirtyProject.http_url_to_repo, dirtyRemote.bare);
  const restoreDivergentRewrite = addUrlRewrite(divergentProject.http_url_to_repo, divergentRemote.bare);
  try {
    let cloneCalls = 0;
    const results = await cloneProjects(
      workspace,
      [dirtyProject, divergentProject, newProject],
      'https://gitlab.example.test',
      dummyToken,
      () => undefined,
      { cloneRunner: async () => { cloneCalls += 1; } }
    );
    assert.equal(results.skipped.length, 2);
    assert.match(results.skipped[0].reason, /local changes or untracked files/);
    assert.match(results.skipped[1].reason, /diverged/);
    assert.equal(results.cloned.length, 1);
    assert.equal(cloneCalls, 1);
    assert.equal(git(['-C', dirtyTarget, 'branch', '--show-current']), 'feature/local');
    assert.equal(existsSync(path.join(dirtyTarget, 'untracked.txt')), true);
    assert.equal(git(['-C', divergentTarget, 'branch', '--show-current']), 'main');
    assert.equal(existsSync(path.join(divergentTarget, 'remote.txt')), false);
  } finally {
    restoreDivergentRewrite();
    restoreDirtyRewrite();
    rmSync(temp, { recursive: true, force: true });
  }
});

test('treats a local branch ahead of GitLab as synchronized', async () => {
  const temp = mkdtempSync(path.join(os.tmpdir(), 'gitlab-workspace-ahead-'));
  const workspace = path.join(temp, 'workspace');
  mkdirSync(workspace);
  const { bare } = createBareRemote(temp);
  const repo = project('ahead');
  const target = createExistingRepo(workspace, repo, bare);
  writeFileSync(path.join(target, 'local.txt'), 'local commit\n');
  git(['-C', target, 'add', 'local.txt']);
  git(['-C', target, 'commit', '--quiet', '-m', 'local commit']);
  const localHead = git(['-C', target, 'rev-parse', 'HEAD']);
  const restoreRewrite = addUrlRewrite(repo.http_url_to_repo, bare);
  try {
    const results = await cloneProjects(workspace, [repo], 'https://gitlab.example.test', dummyToken);
    assert.equal(results.updated.length, 1);
    assert.equal(git(['-C', target, 'rev-parse', 'HEAD']), localHead);
    assert.equal(git(['-C', target, 'branch', '--show-current']), 'main');
  } finally {
    restoreRewrite();
    rmSync(temp, { recursive: true, force: true });
  }
});

test('resolves a missing default branch and skips when project details still have none', async () => {
  const temp = mkdtempSync(path.join(os.tmpdir(), 'gitlab-workspace-default-branch-'));
  const workspace = path.join(temp, 'workspace');
  mkdirSync(workspace);
  const { bare } = createBareRemote(temp);
  const repo = project('missing-branch');
  const target = createExistingRepo(workspace, repo, bare);
  const noBranch = { ...repo, default_branch: null };
  let updateCalls = 0;
  try {
    const resolved = await cloneProjects(
      workspace,
      [noBranch],
      'https://gitlab.example.test',
      dummyToken,
      () => undefined,
      {
        resolveProject: async (current) => ({ ...current, default_branch: 'main' }),
        updateRunner: async (plan) => {
          updateCalls += 1;
          assert.equal(plan.defaultBranch, 'main');
          return { state: 'up-to-date' };
        }
      }
    );
    assert.equal(resolved.updated.length, 1);
    assert.equal(updateCalls, 1);

    const stillMissing = await cloneProjects(
      workspace,
      [noBranch],
      'https://gitlab.example.test',
      dummyToken,
      () => undefined,
      {
        resolveProject: async (current) => ({ ...current, default_branch: null }),
        updateRunner: async () => {
          throw new Error('must not run');
        }
      }
    );
    assert.equal(stillMissing.skipped.length, 1);
    assert.match(stillMissing.skipped[0].reason, /default branch/);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test('preflights all destinations and rejects ordinary folders or a different origin', async () => {
  const temp = mkdtempSync(path.join(os.tmpdir(), 'gitlab-workspace-preflight-'));
  try {
    const workspace = path.join(temp, 'workspace');
    mkdirSync(workspace);
    mkdirSync(path.join(workspace, 'second'));
    let started = 0;
    await assert.rejects(
      cloneProjects(
        workspace,
        [project('first'), project('second')],
        'https://gitlab.example.test',
        dummyToken,
        () => undefined,
        { cloneRunner: async () => { started += 1; } }
      ),
      (error: unknown) => error instanceof ClonePreflightError && /No repositories were changed/.test(error.message)
    );
    assert.equal(started, 0);
    assert.equal(existsSync(path.join(workspace, 'first')), false);

    const { bare } = createBareRemote(temp);
    const wrongWorkspace = path.join(temp, 'wrong-workspace');
    mkdirSync(wrongWorkspace);
    const wrongProject = project('wrong');
    const wrongOrigin = 'https://gitlab.example.test/group/someone-else.git';
    createExistingRepo(wrongWorkspace, wrongProject, bare, wrongOrigin);
    let wrongOriginCloneCalls = 0;
    const notCloned = project('not-cloned');
    await assert.rejects(
      cloneProjects(
        wrongWorkspace,
        [notCloned, wrongProject],
        'https://gitlab.example.test',
        dummyToken,
        () => undefined,
        { cloneRunner: async () => { wrongOriginCloneCalls += 1; } }
      ),
      ClonePreflightError
    );
    assert.equal(wrongOriginCloneCalls, 0);
    assert.equal(existsSync(path.join(wrongWorkspace, 'not-cloned')), false);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test('does not delete an existing repository after update failure and skips the rest of the batch', async () => {
  const temp = mkdtempSync(path.join(os.tmpdir(), 'gitlab-workspace-update-failure-'));
  try {
    const workspace = path.join(temp, 'workspace');
    mkdirSync(workspace);
    const { bare } = createBareRemote(temp);
    const repo = project('existing');
    const target = createExistingRepo(workspace, repo, bare);
    const next = project('not-run');
    const results = await cloneProjects(
      workspace,
      [repo, next],
      'https://gitlab.example.test',
      dummyToken,
      () => undefined,
      {
        updateRunner: async () => { throw new Error('private Git output'); },
        cloneRunner: async () => { throw new Error('must not run'); }
      }
    );
    assert.equal(results.failed, repo);
    assert.match(results.failureReason ?? '', /could not update/);
    assert.equal(results.skipped.length, 1);
    assert.equal(existsSync(target), true);
    assert.equal(readFileSync(path.join(target, 'README.md'), 'utf8').trim(), 'initial content');
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test('fetches and fast-forwards only the current GitLab default branch', async () => {
  const temp = mkdtempSync(path.join(os.tmpdir(), 'gitlab-workspace-local-sync-'));
  const workspace = path.join(temp, 'workspace');
  mkdirSync(workspace);
  const { source, bare } = createBareRemote(temp, 'release');
  const repo = project('sync-demo', 'sync-demo', 'release');
  const target = createExistingRepo(workspace, repo, bare);
  const restoreRewrite = addUrlRewrite(repo.http_url_to_repo, bare);
  try {
    commitAndPush(source, 'release', 'latest.txt', 'latest content\n', 'remote update');
    const first = await syncLocalDefaultBranches(workspace, [repo], 'https://gitlab.example.test', dummyToken);
    assert.equal(first.found, 1);
    assert.deepEqual(first.updated, [repo]);
    assert.deepEqual(first.upToDate, []);
    assert.equal(git(['-C', target, 'branch', '--show-current']), 'release');
    assert.equal(readFileSync(path.join(target, 'latest.txt'), 'utf8').trim(), 'latest content');

    const second = await syncLocalDefaultBranches(workspace, [repo], 'https://gitlab.example.test', dummyToken);
    assert.deepEqual(second.updated, []);
    assert.deepEqual(second.upToDate, [repo]);
  } finally {
    restoreRewrite();
    rmSync(temp, { recursive: true, force: true });
  }
});

test('skips a repository on a feature branch without fetching or switching branches', async () => {
  const temp = mkdtempSync(path.join(os.tmpdir(), 'gitlab-workspace-local-sync-feature-'));
  const workspace = path.join(temp, 'workspace');
  mkdirSync(workspace);
  const { source, bare } = createBareRemote(temp);
  const repo = project('feature-sync');
  const target = createExistingRepo(workspace, repo, bare);
  git(['-C', target, 'switch', '--quiet', '-c', 'feature/work']);
  const trackedBefore = git(['-C', target, 'rev-parse', 'refs/remotes/origin/main']);
  commitAndPush(source, 'main', 'remote.txt', 'remote update\n', 'remote update');
  const restoreRewrite = addUrlRewrite(repo.http_url_to_repo, bare);
  try {
    const result = await syncLocalDefaultBranches(workspace, [repo], 'https://gitlab.example.test', dummyToken);
    assert.equal(result.skipped.length, 1);
    assert.match(result.skipped[0].reason, /not currently on its GitLab default branch/);
    assert.equal(git(['-C', target, 'branch', '--show-current']), 'feature/work');
    assert.equal(git(['-C', target, 'rev-parse', 'refs/remotes/origin/main']), trackedBefore);
    assert.equal(existsSync(path.join(target, 'remote.txt')), false);
  } finally {
    restoreRewrite();
    rmSync(temp, { recursive: true, force: true });
  }
});

test('skips dirty and divergent local default branches while continuing the batch', async () => {
  const temp = mkdtempSync(path.join(os.tmpdir(), 'gitlab-workspace-local-sync-skip-'));
  const workspace = path.join(temp, 'workspace');
  mkdirSync(workspace);

  const dirtyRemote = createBareRemote(temp);
  const dirtyProject = project('sync-dirty');
  const dirtyTarget = createExistingRepo(workspace, dirtyProject, dirtyRemote.bare);
  writeFileSync(path.join(dirtyTarget, 'local.txt'), 'keep this change\n');

  const divergentRemote = createBareRemote(temp);
  const divergentProject = project('sync-diverged');
  const divergentTarget = createExistingRepo(workspace, divergentProject, divergentRemote.bare);
  writeFileSync(path.join(divergentTarget, 'local.txt'), 'local commit\n');
  git(['-C', divergentTarget, 'add', 'local.txt']);
  git(['-C', divergentTarget, 'commit', '--quiet', '-m', 'local commit']);
  commitAndPush(divergentRemote.source, 'main', 'remote.txt', 'remote commit\n', 'remote commit');

  const restoreDirtyRewrite = addUrlRewrite(dirtyProject.http_url_to_repo, dirtyRemote.bare);
  const restoreDivergentRewrite = addUrlRewrite(divergentProject.http_url_to_repo, divergentRemote.bare);
  try {
    const result = await syncLocalDefaultBranches(
      workspace,
      [dirtyProject, divergentProject],
      'https://gitlab.example.test',
      dummyToken
    );
    assert.equal(result.found, 2);
    assert.equal(result.skipped.length, 2);
    assert.match(result.skipped[0].reason, /local changes or untracked files/);
    assert.match(result.skipped[1].reason, /diverged/);
    assert.equal(readFileSync(path.join(dirtyTarget, 'local.txt'), 'utf8').trim(), 'keep this change');
    assert.equal(git(['-C', divergentTarget, 'branch', '--show-current']), 'main');
    assert.equal(existsSync(path.join(divergentTarget, 'remote.txt')), false);
  } finally {
    restoreDivergentRewrite();
    restoreDirtyRewrite();
    rmSync(temp, { recursive: true, force: true });
  }
});

test('skips invalid destinations, ignores missing repositories, and continues after a per-repository failure', async () => {
  const temp = mkdtempSync(path.join(os.tmpdir(), 'gitlab-workspace-local-sync-batch-'));
  try {
    const workspace = path.join(temp, 'workspace');
    mkdirSync(workspace);
    const { bare } = createBareRemote(temp);
    const wrongProject = project('wrong-origin');
    createExistingRepo(workspace, wrongProject, bare, 'https://gitlab.example.test/group/other.git');
    const ordinaryProject = project('ordinary-folder');
    mkdirSync(path.join(workspace, ordinaryProject.path));
    const failedProject = project('sync-failure');
    createExistingRepo(workspace, failedProject, bare);
    const goodProject = { ...project('sync-success'), id: 99 };
    createExistingRepo(workspace, goodProject, bare);
    const missingProject = project('not-downloaded');
    const missingExternalProject = {
      ...project('external-not-downloaded'),
      http_url_to_repo: 'https://other.example.test/group/external-not-downloaded.git'
    };
    const calls: string[] = [];

    const result = await syncLocalDefaultBranches(
      workspace,
      [wrongProject, ordinaryProject, failedProject, missingProject, missingExternalProject, goodProject],
      'https://gitlab.example.test',
      dummyToken,
      () => undefined,
      {
        syncRunner: async (plan) => {
          calls.push(plan.project.path);
          if (plan.project.id === failedProject.id) throw new Error('private Git output');
          return { state: 'updated' };
        }
      }
    );

    assert.equal(result.found, 4);
    assert.deepEqual(result.skipped.map(({ project: skipped }) => skipped), [wrongProject, ordinaryProject]);
    assert.deepEqual(result.failed.map(({ project: failed }) => failed), [failedProject]);
    assert.deepEqual(result.updated, [goodProject]);
    assert.deepEqual(calls, [failedProject.path, goodProject.path]);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test('rejects unsafe local names, gives same-named projects stable ID folders, and rejects foreign clone URLs', () => {
  const temp = mkdtempSync(path.join(os.tmpdir(), 'gitlab-workspace-plan-'));
  try {
    assert.throws(() => planClones(temp, [project('unsafe', '../outside')], 'https://gitlab.example.test'), /無法安全建立 Repo 路徑/);
    const duplicatePlans = planClones(temp, [project('one', 'same'), project('twooo', 'same')], 'https://gitlab.example.test');
    assert.deepEqual(duplicatePlans.map((plan) => path.basename(plan.targetPath)), ['same--4', 'same--6']);
    const external = { ...project('external'), http_url_to_repo: 'https://other.example.test/group/external.git' };
    assert.throws(() => planClones(temp, [external], 'https://gitlab.example.test'), /outside the configured GitLab server/);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});
