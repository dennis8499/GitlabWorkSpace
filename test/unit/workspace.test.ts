import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { Memento } from 'vscode';
import type { GitLabProject } from '../../src/api/types';
import { parseIssueDraftBundle } from '../../src/workspace/issueDrafts';
import { groupRepositoryPath, GroupWorkspaceRegistry, localRepositoryState, projectFolderNames, sameLocalPath } from '../../src/workspace/workspacePaths';
import { IssueTimeTracker, parseTimeEntryDuration } from '../../src/workspace/timeTracker';

function project(id: number, localPath: string, fullPath = `group/${localPath}`): GitLabProject {
  return { id, name: localPath, path: localPath, path_with_namespace: fullPath, web_url: `https://gitlab.example/${fullPath}`, http_url_to_repo: `https://gitlab.example/${fullPath}.git`, default_branch: 'main' };
}

function memory(initial: Record<string, unknown> = {}): Memento {
  const values = new Map(Object.entries(initial));
  return {
    keys: () => [...values.keys()],
    get: <T>(key: string, defaultValue?: T) => (values.has(key) ? values.get(key) : defaultValue) as T,
    update: async (key: string, value: unknown) => { if (value === undefined) values.delete(key); else values.set(key, value); }
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

test('stores Group roots by GitLab instance and Group ID', async () => {
  const registry = new GroupWorkspaceRegistry(memory());
  await registry.setRoot('https://gitlab.example', 4, 'C:/workspace/group-a');
  await registry.setRoot('https://gitlab.example', 5, 'C:/workspace/group-b');
  assert.equal(registry.getRoot('https://gitlab.example', 4), path.resolve('C:/workspace/group-a'));
  assert.equal(registry.getRoot('https://gitlab.example', 5), path.resolve('C:/workspace/group-b'));
  assert.equal(registry.getRoot('https://other.example', 4), undefined);
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
