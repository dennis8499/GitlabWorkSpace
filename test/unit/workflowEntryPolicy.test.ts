import assert from 'node:assert/strict';
import test from 'node:test';
import { canCopyCodexLaunch, codexLaunchManualText, type CodexLaunchDraft } from '../../src/codex/launchProtocol';
import type { CodexTaskSource } from '../../src/codex/protocol';
import { workflowOriginKey, type CodexTaskOrigin } from '../../src/codex/workflowProtocol';

function draft(source: CodexTaskSource): CodexLaunchDraft {
  return { schema: 'GitLabWorkspaceCodexLaunch/v1', id: 'fixture', revision: 1, scope: 'local', state: 'blocked', source,
    title: '需求探索', requirement: '新增查詢功能', repositories: [{ id: 'service', name: 'service', path: 'C:/group/service' }],
    repositoryId: 'service', repositoryIds: ['service'], models: [], isolated: true, checks: [], updatedAt: new Date().toISOString(),
    sourceSha: 'a'.repeat(40), targetSha: 'b'.repeat(40), requirementSummary: '完整需求快照' };
}

test('Wiki and Issue development cannot use the manual fallback even after App Server failure', () => {
  for (const source of [{ kind: 'issue', projectId: 1, issueIid: 123 }, { kind: 'project-wiki', projectId: 1 },
    { kind: 'merge-request', projectId: 1, iid: 2, intent: 'fix-comments' }] as CodexTaskSource[]) {
    assert.equal(canCopyCodexLaunch(source), false);
    assert.throws(() => codexLaunchManualText(draft(source)), /僅提供 App Server/);
  }
});

test('manual analysis retains unsaved requirements and review uses explicit base and head labels', () => {
  const group = codexLaunchManualText(draft({ kind: 'group-analysis' }), { requirement: '尚未保存的新需求' });
  assert.match(group, /尚未保存的新需求/); assert.match(group, /functional-exploration/); assert.match(group, /IssueDraftBundle\/v1/);
  assert.match(group, /不得建立 Issue/);
  const review = codexLaunchManualText(draft({ kind: 'merge-request', projectId: 1, iid: 2, reviewerTool: 'release-reviewer' }));
  assert.match(review, new RegExp(`base=${'b'.repeat(40)}；head=${'a'.repeat(40)}`));
  assert.match(review, /release-reviewer/); assert.match(review, /完整需求快照/);
});

test('the same MR keeps MergeReviewer and ReleaseReviewer identities separate while retaining the legacy default', () => {
  const origin: CodexTaskOrigin = { kind: 'merge-request', accountKey: 'account', baseUrl: 'https://gitlab.test', projectId: 1,
    projectPath: 'team/service', webUrl: 'https://gitlab.test/team/service/-/merge_requests/2', repositoryRoot: 'C:/cache/service',
    iid: 2, sourceBranch: 'feature', sourceSha: 'a'.repeat(40), targetBranch: 'main', targetSha: 'b'.repeat(40) };
  assert.equal(workflowOriginKey(origin), workflowOriginKey({ ...origin, reviewerTool: 'merge-reviewer' }));
  assert.notEqual(workflowOriginKey(origin), workflowOriginKey({ ...origin, reviewerTool: 'release-reviewer' }));
});
