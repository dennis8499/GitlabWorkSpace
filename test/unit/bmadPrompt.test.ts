import assert from 'node:assert/strict';
import test from 'node:test';
import { buildBmadPrompt, getBmadPromptFields, validateBmadPromptInputs } from '../../src/workspace/bmadPrompt';
import type { BmadCatalogNode, BmadWorkflowSnapshot } from '../../src/workspace/bmadProtocol';

function fixture(skill = 'bmad-build') {
  const node: BmadCatalogNode = { id: skill, skill, module: 'BMad Method', displayName: '功能', menuCode: 'BD',
    description: '', action: '', args: '', phase: 'ship', required: true, precededBy: [], followedBy: [], outputLocation: '', outputs: [] };
  const snapshot: BmadWorkflowSnapshot = { root: 'C:/工作根目錄', revision: 'one', installation: { state: 'ready', reason: '' },
    catalogSource: 'installed', nodes: [node], phases: [], edges: [], steps: [{ id: node.id, status: 'draft', summary: '', artifacts: [{
      id: 'artifact', path: 'C:/工作根目錄/_bmad-output/spec-task.md', relativePath: '_bmad-output/spec-task.md', fingerprint: 'hash',
      status: 'draft', reason: '', canConfirm: false, confirmed: false }] }],
    stories: [{ id: 'story', path: 'C:/工作根目錄/_bmad-output/stories/S1.md', inventoryPath: 'C:/工作根目錄/_bmad-output/stories.yaml',
      label: '工作一', mode: 'spec', status: 'in-review', reason: '' }],
    currentCandidates: [{ stepId: node.id, storyId: 'story', label: '工作一', reason: '' }], recommendations: [], watchDirectories: [], diagnostics: [] };
  return { node, snapshot };
}

test('prompts preserve literal user input and name the installed skill, root, repositories and native work', () => {
  const { node, snapshot } = fixture();
  const goal = '需求 " & %PATH% $() `command`\n第二行';
  const inputs = { intent: 'resume', goal, artifactId: 'artifact', storyId: 'story', repositoryPaths: ['C:/工作根目錄/Repo A'], acceptance: '通過驗收' };
  assert.deepEqual(validateBmadPromptInputs(node, inputs, snapshot), []);
  const prompt = buildBmadPrompt(node, inputs, snapshot);
  for (const text of [goal, snapshot.root!, '/.agents/skills/bmad-build/SKILL.md', 'Repo A', 'spec-task.md', 'stories.yaml', '工作一', '續作既有工作', '通過驗收']) assert.ok(prompt.includes(text), text);
  assert.match(prompt, /原生產物格式/);
  assert.equal(snapshot.steps[0].status, 'draft', 'Generating/copying never marks progress');
});

test('function-specific fields and validation cover PRD, Spec, Build and reviews', () => {
  for (const skill of ['bmad-prd', 'bmad-spec', 'bmad-build']) {
    const { node, snapshot } = fixture(skill);
    assert.ok(getBmadPromptFields(node, {}).some(field => field.id === 'intent' && field.kind === 'select'));
    assert.ok(validateBmadPromptInputs(node, {}, snapshot).length);
    assert.deepEqual(validateBmadPromptInputs(node, { goal: '建立新工作' }, snapshot), []);
    const intent = skill === 'bmad-build' ? 'resume' : 'validate';
    assert.ok(validateBmadPromptInputs(node, { intent }, snapshot).some(error => error.includes('路徑')));
    assert.deepEqual(validateBmadPromptInputs(node, { intent, artifactId: 'artifact' }, snapshot), []);
  }
  const { node, snapshot } = fixture('bmad-code-review');
  assert.ok(validateBmadPromptInputs(node, { goal: '檢查變更' }, snapshot).length);
  assert.deepEqual(validateBmadPromptInputs(node, { goal: '檢查變更', storyId: 'story' }, snapshot), []);
  assert.equal(buildBmadPrompt(node, {}, snapshot).length > 0, true, 'Incomplete input can still be previewed');
});

test('stale and malformed input cannot authorize copying', () => {
  const { node, snapshot } = fixture();
  for (const values of [null, [], { goal: 1 }, { goal: 'a'.repeat(32001) }, { repositoryPaths: 'wrong' }, { unexpected: true }, { intent: 'unknown' }, { intent: 'resume', artifactId: 'removed' }, { intent: 'resume', storyId: 'removed' }]) {
    assert.ok(validateBmadPromptInputs(node, values as any, snapshot).length, JSON.stringify(values));
    assert.doesNotThrow(() => buildBmadPrompt(node, values as any, snapshot), 'Malformed restored drafts cannot crash the preview');
  }
  assert.throws(() => buildBmadPrompt({ ...node, skill: 'bmad-help & calc' }, {}, snapshot), /無效/);
});

test('help and sprint status have useful defaults and catalog parameters remain contextual', () => {
  const { node, snapshot } = fixture('bmad-help');
  assert.deepEqual(validateBmadPromptInputs(node, {}, snapshot), []);
  assert.match(buildBmadPrompt(node, {}, snapshot), /判斷階段/);
  const recon = { ...node, skill: 'bmad-deep-recon', args: '[type]' };
  assert.ok(getBmadPromptFields(recon, {}).some(field => field.id === 'parameter'));
  assert.match(buildBmadPrompt(recon, { goal: '技術研究', parameter: 'technical' }, snapshot), /technical/);
});

test('a planned inventory Story names the exact native spec folder and Story id for first Build', () => {
  const { node, snapshot } = fixture();
  const story = snapshot.stories[0];
  story.id = `${story.inventoryPath}#S1`; story.path = story.inventoryPath!; story.status = 'backlog';
  const prompt = buildBmadPrompt(node, { intent: 'resume', storyId: story.id }, snapshot);
  assert.match(prompt, /spec_folder = C:\/工作根目錄\/_bmad-output/);
  assert.match(prompt, /story_id = S1/);
});
