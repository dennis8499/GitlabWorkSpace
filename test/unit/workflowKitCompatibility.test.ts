import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveSkillsContext } from '../../src/workspace/skillsContext';
import type { InstalledWorkflowKitState } from '../../src/workspace/workspaceProtocol';
import { bmadKitTaskIssue } from '../../src/workspace/bmadKit';
import { workflowKitCapabilityAvailable } from '../../src/workspace/workflowKitCompatibility';

test('compatible installations remain usable across independent versions and available updates', () => {
  const match = { status: 'matched' as const, root: '/project', profile: 'repository' as const, repositories: [{ name: 'project', path: '/project', matched: false }] };
  for (const version of ['0.32.0', '1.0.0', '1.1.0']) {
    const installed: InstalledWorkflowKitState = { status: 'update-available', version, profile: 'repository', workspaceContract: 2, installerApi: 1, capabilities: ['query'] };
    assert.deepEqual(resolveSkillsContext({ match, installed, revision: 'fixture' }).availableFeatures, ['query']);
    for (const incompatible of [{ ...installed, workspaceContract: 3 }, { ...installed, profile: 'group' as const }, { ...installed, status: 'error' as const },
      { ...installed, integrity: 'unverified' as const }]) {
      assert.deepEqual(resolveSkillsContext({ match, installed: incompatible, revision: 'fixture' }).availableFeatures, []);
    }
    const unsupported = resolveSkillsContext({ match, installed: { ...installed, workspaceContract: 3 }, revision: 'fixture' });
    assert.match(unsupported.reason!, /整合介面尚未受此工作台支援/);
  }
});

test('capability checks stay scoped and BMAD uses the shared verifier', () => {
  const installed: InstalledWorkflowKitState = { status: 'installed', profile: 'repository', workspaceContract: 2, installerApi: 1,
    integrity: 'verified', interfaceCompatibility: 'compatible', bmadMode: 'bundled', capabilities: ['bmad-workflow', 'codebase-wiki'] };
  assert.equal(workflowKitCapabilityAvailable(installed, 'bmad-workflow'), true);
  assert.equal(workflowKitCapabilityAvailable({ ...installed, capabilities: ['codebase-wiki'] }, 'bmad-workflow'), false);
  assert.equal(workflowKitCapabilityAvailable({ ...installed, integrity: 'unverified' }, 'bmad-workflow'), false);
  assert.equal(bmadKitTaskIssue(installed), undefined);
  assert.ok(bmadKitTaskIssue({ ...installed, capabilities: ['codebase-wiki'] }));
});
