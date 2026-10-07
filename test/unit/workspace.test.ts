import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, realpathSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { GitLabProject } from '../../src/api/types';
import { parseIssueDraftBundle } from '../../src/workspace/issueDrafts';
import { groupRepositoryPath, inspectWorkspaceFolder, localRepositoryState, localRepositoryStateAsync, projectFolderNames, resolveGroupWorkspaceRoot, sameLocalPath, scanLocalGroupRepositories } from '../../src/workspace/workspacePaths';
import { IssueTimeTracker, parseTimeEntryDuration } from '../../src/workspace/timeTracker';

function project(id: number, localPath: string, fullPath = `group/${localPath}`): GitLabProject {
  return { id, name: localPath, path: localPath, path_with_namespace: fullPath, web_url: `https://gitlab.example/${fullPath}`, http_url_to_repo: `https://gitlab.example/${fullPath}.git`, default_branch: 'main' };
}

function memory() {
  const values = new Map<string, unknown>();
  return {
    keys: () => [...values.keys()],
    get<T>(key: string, defaultValue?: T): T | undefined {
      return (values.has(key) ? values.get(key) : defaultValue) as T | undefined;
    },
    async update(key: string, value: unknown): Promise<void> {
      if (value === undefined) values.delete(key);
      else values.set(key, value);
    }
  };
}

test('assigns stable local folders to same-named repositories and keeps every path inside the Group root', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'workspace-paths-'));
  try {
    const projects = [project(11, 'portal', 'group/a/portal'), project(12, 'portal', 'group/b/portal'), project(13, 'portal--11')];
    const names = projectFolderNames(projects);
    assert.equal(new Set([...names.values()].map((name) => name.toLocaleLowerCase())).size, 3);
    for (const item of projects) {
      const target = groupRepositoryPath(root, item, projects);
      assert.equal(path.dirname(target), root);
    }
    assert.throws(() => groupRepositoryPath(root, project(14, '../escape'), [project(14, '../escape')]), /無法安全建立 Repo 路徑/);
    const ready = path.join(root, 'portal');
    mkdirSync(ready);
    assert.equal(localRepositoryState(root, ready), 'ready');
    assert.equal(localRepositoryState(root, path.join(root, 'missing')), 'missing');
    assert.equal(localRepositoryState(root, path.join(root, '..', 'outside')), 'unsafe');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('preserves case-insensitive collision suffixes, reserved-name rejection, and unsafe-path rejection', () => {
  const projects = [project(1, 'service'), project(2, 'Service'), project(3, 'service--1'), project(4, 'CON')];
  const folders = projectFolderNames(projects);
  assert.deepEqual([...folders.values()], ['service--1--1', 'Service--2', 'service--1', 'CON']);
  assert.equal(new Set([...folders.values()].map((value) => value.toLocaleLowerCase('en-US'))).size, projects.length);
  assert.throws(() => groupRepositoryPath('C:/workspace/team', projects[3], projects, folders), /CON/);
  const unsafe = project(5, '../escape');
  assert.throws(() => groupRepositoryPath('C:/workspace/team', unsafe, [...projects, unsafe]), /escape/);
});

test('assigns every one of 500 repositories one stable case-insensitive folder name', () => {
  const projects = Array.from({ length: 500 }, (_, index) => project(index + 1, `repo-${index}`));
  const folders = projectFolderNames(projects);
  assert.equal(folders.size, 500);
  assert.equal(new Set([...folders.values()].map((folder) => folder.toLocaleLowerCase('en-US'))).size, 500);
  assert.equal(folders.get(500), 'repo-499');
  assert.deepEqual([...projectFolderNames(projects)], [...folders]);
});

test('checks repository folders asynchronously while retaining safe, missing, and outside-root results', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'workspace-async-paths-'));
  try {
    const ready = path.join(root, 'ready');
    mkdirSync(ready);
    assert.equal(await localRepositoryStateAsync(root, ready), 'ready');
    assert.equal(await localRepositoryStateAsync(root, path.join(root, 'missing')), 'missing');
    assert.equal(await localRepositoryStateAsync(root, path.join(root, '..', 'outside')), 'unsafe');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('resolves workspace roots from the current Group Repo and reports ambiguity', () => {
  const resolved = resolveGroupWorkspaceRoot([
    { kind: 'group-repository', path: 'C:/group/service', groupRoot: 'C:/group' },
    { kind: 'group-repository', path: 'C:/group/docs', groupRoot: 'C:/group' }
  ], 'win32');
  assert.equal(resolved.root, path.resolve('C:/group'));

  const ambiguous = resolveGroupWorkspaceRoot([
    { kind: 'group-repository', path: 'C:/one/service', groupRoot: 'C:/one' },
    { kind: 'group-repository', path: 'C:/two/service', groupRoot: 'C:/two' }
  ], 'win32');
  assert.equal(ambiguous.root, undefined);
  assert.match(ambiguous.error ?? '', /多個 Group Repo/);

  const multipleFolders = resolveGroupWorkspaceRoot([
    { kind: 'directory', path: 'C:/one' }, { kind: 'directory', path: 'C:/two' }
  ], 'win32');
  assert.equal(multipleFolders.root, undefined);
  assert.match(multipleFolders.error ?? '', /多個可能/);
  assert.match(resolveGroupWorkspaceRoot([]).error ?? '', /請在 VSCode 開啟/);
});

test('inspects VS Code folders using their actual Git remotes and selects the matching Group root', async () => {
  const parent = mkdtempSync(path.join(os.tmpdir(), 'workspace-detection-'));
  try {
    const groupRoot = path.join(parent, 'team');
    const servicePath = path.join(groupRoot, 'renamed-service');
    const docsPath = path.join(groupRoot, 'docs');
    mkdirSync(servicePath, { recursive: true });
    mkdirSync(docsPath);
    const service = project(21, 'service', 'team/service');
    const docs = project(22, 'docs', 'team/docs');
    const initWithRemote = (folder: string, remote: string) => {
      execFileSync('git', ['init', '--quiet', folder]);
      execFileSync('git', ['-C', folder, 'remote', 'add', 'origin', remote]);
    };
    initWithRemote(servicePath, service.http_url_to_repo);
    initWithRemote(docsPath, docs.http_url_to_repo);
    const matchesGroup = (remote: string, item: GitLabProject) => remote === item.http_url_to_repo;

    const matchedService = await inspectWorkspaceFolder(servicePath, [service], matchesGroup);
    assert.deepEqual(matchedService, { kind: 'group-repository', path: realpathSync.native(servicePath), groupRoot: realpathSync.native(groupRoot) });
    assert.equal(resolveGroupWorkspaceRoot([matchedService]).root, realpathSync.native(groupRoot));

    const unrelatedRepo = await inspectWorkspaceFolder(servicePath, [docs], matchesGroup);
    assert.equal(unrelatedRepo.kind, 'repository', 'a Repo from a different Group cannot supply the local root');
    assert.equal(resolveGroupWorkspaceRoot([unrelatedRepo]).root, undefined);

    const [firstRoot, secondRoot] = await Promise.all([
      inspectWorkspaceFolder(servicePath, [service, docs], matchesGroup),
      inspectWorkspaceFolder(docsPath, [service, docs], matchesGroup)
    ]);
    assert.equal(resolveGroupWorkspaceRoot([firstRoot, secondRoot]).root, realpathSync.native(groupRoot), 'multiple matching Group Repos share one unambiguous parent');

    const directFolder = await inspectWorkspaceFolder(groupRoot, [service, docs], matchesGroup);
    assert.equal(directFolder.kind, 'directory', 'a single non-Git VS Code folder is adopted directly');
    assert.equal(resolveGroupWorkspaceRoot([directFolder]).root, realpathSync.native(groupRoot));
  } finally { rmSync(parent, { recursive: true, force: true }); }
});

test('scans real direct-child repositories and includes Git worktrees without inferring missing GitLab folders', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'workspace-local-repositories-'));
  try {
    const normal = path.join(root, 'actual-repo');
    const worktree = path.join(root, 'linked-worktree');
    mkdirSync(normal);
    mkdirSync(path.join(root, 'ordinary-folder'));
    execFileSync('git', ['init', '--quiet', normal]);
    execFileSync('git', ['-C', normal, '-c', 'user.name=Workspace Test', '-c', 'user.email=workspace@example.invalid', 'commit', '--allow-empty', '-m', 'baseline']);
    execFileSync('git', ['-C', normal, 'worktree', 'add', '--quiet', '--detach', worktree, 'HEAD']);

    assert.deepEqual(await scanLocalGroupRepositories(root), [
      { name: 'actual-repo', path: realpathSync.native(normal) },
      { name: 'linked-worktree', path: realpathSync.native(worktree) }
    ]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('compares Windows repository paths case-insensitively after normalization', () => {
  assert.equal(sameLocalPath('C:\\GitLab Workspace\\Repo', 'c:\\gitlab workspace\\repo', 'win32'), true);
  assert.equal(sameLocalPath('C:\\group\\repo', 'D:\\group\\repo', 'win32'), false);
});

test('validates IssueDraftBundle/v1 IDs, evidence paths, and required acceptance criteria', () => {
  const valid = { schema: 'IssueDraftBundle/v1', analysisId: 'analysis-01', drafts: [{
    id: 'draft-01', projectPath: 'group/service', title: 'Tighten validation', description: 'Background',
    acceptanceCriteria: ['Reject invalid input'], sourceEvidence: [{ path: 'src/handler.ts', claim: 'This path returns an unchecked value.' }]
  }] };
  assert.equal(parseIssueDraftBundle(JSON.stringify(valid)).drafts[0].title, 'Tighten validation');
  for (const value of [
    { ...valid, analysisId: '../unsafe' },
    { ...valid, drafts: [{ ...valid.drafts[0], id: '../unsafe' }] },
    { ...valid, drafts: [{ ...valid.drafts[0], sourceEvidence: [{ path: '../../secret.txt', claim: 'outside' }] }] },
    { ...valid, drafts: [{ ...valid.drafts[0], acceptanceCriteria: [] }] }
  ]) assert.throws(() => parseIssueDraftBundle(JSON.stringify(value)));
});

test('tracks one Issue at a time and turns a running timer into a confirmation after restart', async () => {
  const state = memory();
  const tracker = new IssueTimeTracker(state);
  await tracker.setScope('https://gitlab.example', 7);
  const projectValue = project(3, 'service');
  const issue = { iid: 19, title: 'Fix the parser' };
  const entry = await tracker.start(projectValue, issue, 1_000);
  await assert.rejects(() => tracker.start(project(4, 'other'), { iid: 1, title: 'Other' }, 1_100), /請先暫停或結束/);
  await tracker.tick(3_500);
  assert.equal(tracker.list().find((item) => item.id === entry.id)?.elapsedSeconds, 2);

  const restarted = new IssueTimeTracker(state);
  await restarted.setScope('https://gitlab.example', 7);
  assert.equal(restarted.list()[0].phase, 'needs-review');
  assert.equal(parseTimeEntryDuration('1h30m'), 5_400);
  assert.throws(() => parseTimeEntryDuration('1m1m'));
  await restarted.resume(entry.id, 4_000);
  await restarted.tick(6_000);
  await restarted.stop(entry.id, 6_000);
  assert.equal(restarted.list()[0].phase, 'ready');
});

test('timer ticks report only displayed changes and persist elapsed time every ten seconds', async () => {
  const state = memory();
  let writes = 0;
  const update = state.update.bind(state);
  state.update = async (key, value) => { writes++; await update(key, value); };
  const tracker = new IssueTimeTracker(state);
  await tracker.setScope('https://gitlab.example', 7);
  const entry = await tracker.start(project(3, 'service'), { iid: 19, title: 'Fix the parser' }, 1_000);
  assert.equal(await tracker.tick(1_100), false, 'fractional-second changes do not need a webview update');
  assert.equal(await tracker.tick(1_900), false);
  assert.equal(writes, 1, 'starting the timer is persisted once');

  for (let tick = 1; tick <= 30; tick++) assert.equal(await tracker.tick(1_900 + tick * 1_000), true);
  assert.equal(tracker.list().find((item) => item.id === entry.id)?.elapsedSeconds, 30);
  assert.equal(writes, 4, 'the timer is persisted at start and every ten seconds');
  assert.equal(await tracker.tick(32_000), true);
  assert.equal(tracker.list()[0].elapsedSeconds, 31);
});

test('pauses and saves timers before account changes and restores only the selected account entries', async () => {
  const tracker = new IssueTimeTracker(memory());
  await tracker.setScope('https://gitlab.example', 7);
  const start = Date.now() - 1000;
  const first = await tracker.start(project(3, 'service'), { iid: 19, title: 'First account' }, start);
  await tracker.tick(Date.now());
  await tracker.detachScope();
  assert.equal(tracker.list().length, 0);
  await tracker.setScope('https://gitlab.example', 8);
  assert.equal(tracker.list().length, 0);
  await tracker.addManual(project(3, 'service'), { iid: 19, title: 'Second account' }, '2m', 'Second only');
  await tracker.detachScope();
  await tracker.setScope('https://gitlab.example', 7);
  assert.equal(tracker.list()[0].id, first.id);
  assert.equal(tracker.list()[0].phase, 'paused');
  await tracker.resume(first.id);
  await tracker.detachScope();
  await tracker.setScope('https://different.example', 7);
  assert.equal(tracker.list().length, 0);
});
