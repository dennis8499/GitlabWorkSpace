import assert from 'node:assert/strict';
import test from 'node:test';
import { SnapshotTransport } from '../../src/workspace/snapshotTransport';
import type { WorkspaceSnapshot } from '../../src/workspace/workspaceProtocol';

const snapshot = (changes: Partial<WorkspaceSnapshot> = {}): WorkspaceSnapshot => ({
  connected: false, groups: [], projects: [], groupRepositories: [], groupRepositoryScanStatus: 'idle',
  groupMilestones: [], groupIssueBoards: [], localRepositories: {}, projectLocalRepositories: {},
  issues: [], mergeRequests: [], activeMode: 'developer', projectMembers: [], timers: [],
  workflowKit: { status: 'missing' }, workflowKitInstallTarget: { manual: false, state: { status: 'missing' } }, workflowKitSource: 'github', ...changes
});

test('a small workspace change does not transport the unchanged large collections', () => {
  const transport = new SnapshotTransport();
  const projects = Array.from({ length: 2000 }, (_, i) => ({ id: i, name: `repo-${i}`, path: `repo-${i}`, path_with_namespace: `team/repo-${i}`, web_url: '', http_url_to_repo: `https://gitlab.test/team/repo-${i}.git` }));
  const initial = snapshot({ projects, selectedProjectId: 1 });
  const first = transport.next(initial, 'scope');
  assert.equal(first?.type, 'snapshot');
  const next = transport.next({ ...initial, selectedProjectId: 2 }, 'scope');
  assert.equal(next?.type, 'snapshotPatch');
  if (next?.type !== 'snapshotPatch') return;
  assert.deepEqual(next.changes, { selectedProjectId: 2 });
  assert.equal(next.baseVersion, 1); assert.equal(next.version, 2);
  assert.ok(JSON.stringify(next).length < JSON.stringify(first).length / 100);
  assert.equal(transport.next({ ...initial, selectedProjectId: 2 }, 'scope'), undefined);
});

test('scope changes and view recovery send complete snapshots; optional fields clear explicitly', () => {
  const transport = new SnapshotTransport();
  const first = transport.next(snapshot({ selectedProjectId: 1 }), 'old');
  const removed = transport.next(snapshot(), 'old');
  assert.equal(removed?.type, 'snapshotPatch');
  if (removed?.type === 'snapshotPatch') assert.deepEqual(removed.cleared, ['selectedProjectId']);
  const changed = transport.next(snapshot(), 'new');
  assert.equal(changed?.type, 'snapshot');
  assert.notEqual(first?.streamId, changed?.streamId);
  transport.reset();
  const recovered = transport.next(snapshot(), 'new');
  assert.equal(recovered?.type, 'snapshot');
  assert.notEqual(recovered?.streamId, changed?.streamId);
});
