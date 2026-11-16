import assert from 'node:assert/strict';
import test from 'node:test';
import type { WorkspacePanel as Panel } from '../../src/workspace/workspacePanel';

const loader = require('node:module') as { _load: (name: string, parent: unknown, main: boolean) => unknown };
const original = loader._load;
loader._load = (name, parent, main) => name === 'vscode' ? { window: {} } : original(name, parent, main);
let WorkspacePanel: typeof Panel;
try { ({ WorkspacePanel } = require('../../src/workspace/workspacePanel')); }
finally { loader._load = original; }

test('a failed startup reports Issue and MR errors and retry restores both without another login', async () => {
  let fail = true;
  const loaded: string[] = [];
  const host: any = Object.create(WorkspacePanel.prototype);
  Object.assign(host, {
    disposed: false, session: { baseUrl: 'https://gitlab.test', selectedGroup: { id: 1, full_path: 'group' }, connectionEpoch: 1,
      accounts: [], cachedRead: async () => { if (fail) throw Error('local coordination failed'); return { id: 2, name: 'Test' }; }, updateCurrentUser: async () => {} },
    projects: [], issues: [], mergeRequests: [], workspaceSections: {}, sendSnapshot: () => {}, connectedScopeKey: () => 'connected',
    clearRemoteGroupData: () => {},
    loadWorkspaceSection: async (section: string) => { loaded.push(section); host.workspaceSections[section] = { status: 'ready', complete: true }; }
  });
  await assert.rejects(host.loadNavigationData(), /coordination failed/);
  let snapshot = host.getNavigationSnapshot();
  assert.equal(snapshot.sections.issues.status, 'error');
  assert.equal(snapshot.sections.mergeRequests.status, 'error');
  assert.match(snapshot.sections.issues.error, /coordination failed/);
  assert.deepEqual(loaded, []);
  fail = false;
  await host.loadNavigationSection('issues', snapshot.scope, true);
  snapshot = host.getNavigationSnapshot();
  assert.deepEqual(loaded, ['projects', 'issues', 'mergeRequests']);
  assert.equal(snapshot.sections.issues.status, 'ready');
  assert.equal(snapshot.sections.mergeRequests.status, 'ready');
});
