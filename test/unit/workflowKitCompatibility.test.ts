import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveSkillsContext } from '../../src/workspace/skillsContext';
import type { InstalledWorkflowKitState } from '../../src/workspace/workspaceProtocol';

test('compatible installations remain usable across independent versions and available updates', () => {
  const match = { status: 'matched' as const, root: '/project', profile: 'repository' as const, repositories: [{ name: 'project', path: '/project', matched: false }] };
  for (const version of ['0.32.0', '1.0.0', '1.1.0']) {
    const installed: InstalledWorkflowKitState = { status: 'update-available', version, profile: 'repository', workspaceContract: 2, installerApi: 1, capabilities: ['query'] };
    assert.deepEqual(resolveSkillsContext({ match, installed, revision: 'fixture' }).availableFeatures, ['query']);
    for (const incompatible of [{ ...installed, workspaceContract: 3 }, { ...installed, profile: 'group' as const }, { ...installed, status: 'error' as const }]) {
      assert.deepEqual(resolveSkillsContext({ match, installed: incompatible, revision: 'fixture' }).availableFeatures, []);
    }
    const unsupported = resolveSkillsContext({ match, installed: { ...installed, workspaceContract: 3 }, revision: 'fixture' });
    assert.match(unsupported.reason!, /整合介面尚未受此工作台支援/);
  }
});
