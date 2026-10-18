import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import { buildBmadCommand } from '../../src/workspace/bmadCommand';
import type { BmadCatalogNode, BmadWorkflowSnapshot } from '../../src/workspace/bmadProtocol';

function fixture(): BmadWorkflowSnapshot {
  const node: BmadCatalogNode = { id: 'build', module: 'BMad Method', skill: 'bmad-build', displayName: 'Build', menuCode: 'BD',
    description: '', action: '', args: '', phase: 'ship', required: true, precededBy: [], followedBy: [], outputLocation: '', outputs: [] };
  const root = path.resolve('command-fixture');
  return { root, revision: 'one', guidanceVersion: '6.12.4', compatibility: 'verified',
    installation: { state: 'ready', reason: '' }, codex: { state: 'ready', skills: ['bmad-build'], reason: '' },
    observation: { state: 'watching' }, catalogSource: 'installed', nodes: [node], phases: [], edges: [],
    steps: [{ id: node.id, status: 'draft', summary: '', artifacts: [{ id: 'work', path: path.join(root, 'spec-task.md'),
      relativePath: 'spec-task.md', fingerprint: 'hash', status: 'draft', reason: '' }] }],
    stories: [{ id: path.join(root, 'spec', 'stories.yaml') + '#S1', label: 'Story one', mode: 'spec', status: 'backlog',
      path: path.join(root, 'spec', 'stories.yaml'), inventoryPath: path.join(root, 'spec', 'stories.yaml'), association: 'not-observed', reason: '' }],
    currentCandidates: [], recommendations: [], watchDirectories: [], diagnostics: [] };
}

test('onboarding commands can be copied before installing BMAD or Workflow Kit', () => {
  const snapshot = fixture(); snapshot.installation = { state: 'missing', reason: '未安裝' }; snapshot.root = undefined;
  assert.equal(buildBmadCommand(snapshot, { revision: 'one', command: 'install' }), 'npx bmad-method@6.12.4 install --modules bmm --tools codex');
  assert.equal(buildBmadCommand(snapshot, { revision: 'one', command: 'codex' }), 'codex');
  assert.equal(buildBmadCommand(snapshot, { revision: 'one', command: 'skill', skill: 'bmad-build' }), '$bmad-build');
  assert.equal(buildBmadCommand(snapshot, { revision: 'one', command: 'skill', skill: 'bmad-project-context' }), '$bmad-project-context', 'Teaching remains available when the module is not installed');
});

test('an ambiguous or orphan spec Story cannot invent a native story identifier', () => {
  const snapshot = fixture(), story = snapshot.stories[0];
  const request = { revision: 'one', command: 'skill' as const, skill: 'bmad-build', storyId: story.id };
  story.association = 'ambiguous';
  assert.throws(() => buildBmadCommand(snapshot, request), /尚未確認/);
  story.association = 'confirmed'; story.id = path.join(snapshot.root!, 'spec', 'stories', 'orphan.md');
  assert.throws(() => buildBmadCommand(snapshot, { ...request, storyId: story.id }), /正式 Story 識別/);
});

test('parallel Sprint Stories keep their exact identity even when they share one tracking file', () => {
  const snapshot = fixture(), tracking = path.join(snapshot.root!, 'sprint-status.yaml');
  snapshot.stories = ['1-1-login', '1-2-receipt'].map(id => ({ id: `${tracking}#${id}`, label: id, mode: 'classic',
    path: tracking, status: 'in-progress', reason: '' }));
  const commands = snapshot.stories.map(story => buildBmadCommand(snapshot, { revision: 'one', command: 'skill', skill: 'bmad-build', storyId: story.id }));
  assert.notEqual(commands[0], commands[1]);
  assert.equal(commands[0], '$bmad-build Story "1-1-login" from "sprint-status.yaml"');
  assert.equal(commands[1], '$bmad-build Story "1-2-receipt" from "sprint-status.yaml"');
});

test('native commands carry the exact observed artifact or planned Story identity', () => {
  const snapshot = fixture(), before = JSON.stringify(snapshot);
  assert.equal(buildBmadCommand(snapshot, { revision: 'one', command: 'skill', stepId: 'build', artifactId: 'work' }), '$bmad-build "spec-task.md"');
  assert.equal(buildBmadCommand(snapshot, { revision: 'one', command: 'skill', skill: 'bmad-build', storyId: snapshot.stories[0].id }),
    '$bmad-build spec_folder="spec" story_id="S1"');
  assert.equal(JSON.stringify(snapshot), before, 'Copying cannot advance progress');
  const status = { ...snapshot.nodes[0], id: 'status', skill: 'bmad-sprint-planning', action: 'status' };
  snapshot.nodes.push(status);
  assert.equal(buildBmadCommand(snapshot, { revision: 'one', command: 'skill', stepId: status.id }), '$bmad-sprint-planning status');
});

test('stale, removed, forged and out-of-root work cannot produce a resume command', () => {
  const snapshot = fixture();
  for (const request of [null, [], { revision: 'old', command: 'install' }, { revision: 'one', command: 'shell' },
    { revision: 'one', command: 'skill', skill: 'bmad-build & calc' },
    { revision: 'one', command: 'skill', stepId: 'build', skill: 'bmad-help' },
    { revision: 'one', command: 'skill', stepId: 'build', artifactId: 'deleted' },
    { revision: 'one', command: 'skill', stepId: 'build', storyId: 'deleted' },
    { revision: 'one', command: 'install', script: 'bad' }]) assert.throws(() => buildBmadCommand(snapshot, request as any));
  snapshot.steps[0].artifacts[0].path = path.resolve(snapshot.root!, '..', 'outside.md');
  assert.throws(() => buildBmadCommand(snapshot, { revision: 'one', command: 'skill', stepId: 'build', artifactId: 'work' }), /超出/);
  snapshot.observation.state = 'error';
  assert.throws(() => buildBmadCommand(snapshot, { revision: 'one', command: 'skill', stepId: 'build', storyId: snapshot.stories[0].id }), /重新偵測/);
});
