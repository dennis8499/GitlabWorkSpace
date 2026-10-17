import assert from 'node:assert/strict';
import test from 'node:test';
import { buildWikiGuidePrompt } from '../../src/webview/codebaseWikiGuideData';
import { getSkillGuideCards, restoreSkillGuideState, skillGuideTools, type SkillGuideState } from '../../src/webview/skillsGuideData';
import { describeAction } from '../../src/workspace/actionPolicy';

test('retired tool and specification selections restore to Query without mixing saved inputs', () => {
  for (const id of ['megin-workflow', 'megin-resume', 'megin-spec-export', 'development-spec']) {
    const saved = { tool: 'megin', selections: { megin: id, 'codebase-wiki': id },
      inputs: { [`${id}.task`]: 'retired task', 'query.question': 'saved question', 'merge-repo.repo': 'service' } };
    const state = restoreSkillGuideState(saved as unknown as SkillGuideState);
    assert.equal(state.tool, 'codebase-wiki');
    assert.equal(state.selections['codebase-wiki'], 'query');
    assert.equal(state.inputs['query.question'], 'saved question');
    assert.equal(state.inputs['merge-repo.repo'], 'service');
    assert.equal(state.inputs[`${id}.task`], undefined);
    assert.deepEqual(restoreSkillGuideState(state), state);
    assert.throws(() => buildWikiGuidePrompt(id, saved.inputs), /未知/);
  }
  assert.deepEqual(skillGuideTools.map(tool => tool.id), ['codebase-wiki', 'merge-reviewer', 'release-reviewer']);
  for (const profile of ['group', 'repository'] as const) {
    assert.equal(getSkillGuideCards(profile).length, 14);
    assert.ok(getSkillGuideCards(profile).every(card => !card.id.startsWith('megin')));
  }
});

test('retired delivery and Issue task messages have no executable action policy', () => {
  for (const type of ['prepareDelivery', 'commitDelivery', 'pushDelivery', 'createDeliveryMergeRequest', 'copyWikiUpdatePrompt', 'copyAndOpenCodex']) {
    assert.throws(() => describeAction({ type }), /已移除/);
  }
});

test('a retired active tool restores Query while retaining other Wiki drafts', () => {
  const saved = { tool: 'megin', selections: { megin: 'megin-resume', 'codebase-wiki': 'synthesis' },
    inputs: { 'synthesis.topic': 'saved analysis', 'query.question': 'saved question' } };
  const state = restoreSkillGuideState(saved as unknown as SkillGuideState);
  assert.equal(state.tool, 'codebase-wiki');
  assert.equal(state.selections['codebase-wiki'], 'query');
  assert.equal(state.inputs['synthesis.topic'], 'saved analysis');
  assert.deepEqual(restoreSkillGuideState(state), state);
});
