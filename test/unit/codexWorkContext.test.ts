import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequirementSnapshot, evaluateCriteria, extractAcceptanceCriteria, freezeVerificationProfile, validRequirementSnapshot, validValidationAttempts, validVerificationProfile, validWorkContext } from '../../src/codex/workContext';
import type { ValidationAttempt } from '../../src/codex/workContextProtocol';

const source = { kind: 'issue', identity: 'https://gitlab.test:project/4:issue/2', url: 'https://gitlab.test/team/repo/-/issues/2' };
const startedAt = '2026-11-15T01:00:00.000Z', completedAt = '2026-11-15T01:00:01.000Z';
function requirement(criteria: string[] = ['Save the selected issue', 'Keep the current working tree']) {
  return createRequirementSnapshot({ source, title: 'Issue workflow', description: 'Use the existing GitLab issue.', criteria, capturedAt: startedAt });
}
function attempt(): ValidationAttempt {
  return { id: 'attempt-one', cycle: 1, cwd: 'C:/project', startedAt, completedAt, artifactDigest: 'a'.repeat(64), requirementDigest: 'b'.repeat(64),
    profileDigest: 'c'.repeat(64), state: 'passed', commands: [{ command: 'npm test', cwd: 'C:/project', itemId: 'native-item', exitCode: 0, startedAtMs: 1, completedAtMs: 2 }] };
}

test('requirement snapshots are immutable copies and ignore capture time and activity revisions', () => {
  const input = { ...source, revision: '2026-11-15T00:00:00Z' }, criteria = ['Save selected issues'];
  const first = createRequirementSnapshot({ source: input, title: 'Save', description: 'Source issue body', criteria, capturedAt: startedAt });
  input.identity = 'changed input'; criteria[0] = 'Overwrite original files';
  assert.equal(first.source.identity, source.identity); assert.equal(first.criteria[0].text, 'Save selected issues');
  assert.throws(() => { (first.criteria[0] as { text: string }).text = 'tampered'; }, TypeError);
  const later = createRequirementSnapshot({ source: { ...source, revision: '2026-11-15T02:00:00Z' }, title: 'Save', description: 'Source issue body', criteria: ['Save selected issues'], capturedAt: completedAt });
  assert.equal(later.contentDigest, first.contentDigest);
  assert.notEqual(createRequirementSnapshot({ source, title: 'Save', description: 'Changed source body', criteria: ['Save selected issues'] }).contentDigest, first.contentDigest);
  assert.notEqual(createRequirementSnapshot({ source, title: 'Save', description: 'Source issue body', supplement: 'Limit to one issue', criteria: ['Save selected issues'] }).contentDigest, first.contentDigest);
});

test('source links strip URL credentials and source identity changes produce a different requirement digest', () => {
  const first = requirement(), linked = createRequirementSnapshot({ source: { ...source, url: 'https://user:password@gitlab.test/team/repo?private_token=secret#fragment' }, title: 'Link', description: '' });
  assert.equal(linked.source.url, 'https://gitlab.test/team/repo');
  assert.notEqual(createRequirementSnapshot({ source: { ...source, identity: 'another-issue' }, title: first.title, description: first.description, criteria: first.criteria.map(item => item.text) }).contentDigest, first.contentDigest);
  assert.throws(() => createRequirementSnapshot({ source: { ...source, url: 'file:///C:/secret' }, title: 'Invalid', description: '' }));
});

test('criterion IDs survive reorder and wording changes while changed wording invalidates old evidence', () => {
  const first = requirement();
  const reordered = createRequirementSnapshot({ source, title: first.title, description: first.description, criteria: [...first.criteria].reverse().map(item => item.text), previous: first });
  assert.deepEqual(reordered.criteria.map(item => item.id), [...first.criteria].reverse().map(item => item.id));
  const changed = createRequirementSnapshot({ source, title: first.title, description: first.description, criteria: ['Save only selected issues', first.criteria[1].text], previous: first });
  assert.equal(changed.criteria[0].id, first.criteria[0].id); assert.notEqual(changed.criteria[0].contentDigest, first.criteria[0].contentDigest);
  const old = { criterionId: first.criteria[0].id, criterionDigest: first.criteria[0].contentDigest, state: 'passed' as const, evidence: ['scenario:selected-issue'] };
  assert.equal(evaluateCriteria(changed, [old])[0].state, 'unknown');
  assert.equal(evaluateCriteria(first, [old])[0].state, 'passed');
  assert.equal(evaluateCriteria(first, [old])[1].state, 'unknown');
});

test('inserting a criterion preserves existing IDs and rejects duplicate explicit identifiers', () => {
  const first = requirement(), inserted = createRequirementSnapshot({ source, title: first.title, description: first.description,
    criteria: ['Preview first', ...first.criteria.map(item => item.text)], previous: first });
  assert.deepEqual(inserted.criteria.slice(1).map(item => item.id), first.criteria.map(item => item.id));
  assert.equal(new Set(inserted.criteria.map(item => item.id)).size, 3);
  assert.throws(() => createRequirementSnapshot({ source, title: 'Duplicate', description: '', criteria: [{ id: 'ac-one', text: 'One' }, { id: 'ac-one', text: 'Two' }] }));
});

test('acceptance extraction excludes unrelated checklists and fenced examples', () => {
  const description = ['# Notes', '- [ ] Unrelated task', '## Acceptance Criteria', '- [ ] Saves selected issues', '```markdown', '- [ ] Example only', '```',
    '### Details', '1. Retains the current branch', '## Implementation', '- [ ] Unrelated implementation task'].join('\n');
  assert.deepEqual(extractAcceptanceCriteria(description), ['Saves selected issues', 'Retains the current branch']);
  assert.deepEqual(extractAcceptanceCriteria('No formal acceptance section.\n- [ ] A task'), []);
});

test('snapshot validation rejects content tampering and allows independent tasks without acceptance sections', () => {
  const value = requirement(), changed = structuredClone(value); (changed as { description: string }).description = 'Tampered requirement';
  assert.equal(validRequirementSnapshot(changed), false);
  const reorderedSource = { identity: value.source.identity, kind: value.source.kind, url: value.source.url };
  assert.equal(validRequirementSnapshot({ ...value, source: reorderedSource }), true);
  const standalone = createRequirementSnapshot({ source: { kind: 'merge-request', identity: 'mr:3' }, title: 'Review an external MR', description: '' });
  assert.equal(validWorkContext({ schema: 'GitLabWorkspaceWorkContext/v1', requirement: standalone }), true);
  assert.equal(standalone.criteria.length, 0);
  assert.equal(validWorkContext({ schema: 'GitLabWorkspaceWorkContext/v1', workId: '../escape', requirement: standalone }), false);
});

test('verification profiles freeze actual task commands without requiring every kind of check', () => {
  const commands = ['npm run lint:docs'], checks = ['Check exported links'];
  const profile = freezeVerificationProfile({ kind: 'docs', commands, manualChecks: checks, reason: 'Documentation only' });
  commands.push('npm test'); checks[0] = 'Changed after preparation';
  assert.deepEqual(profile.commands, ['npm run lint:docs']); assert.deepEqual(profile.manualChecks, ['Check exported links']);
  assert.throws(() => { (profile.commands as string[]).push('npm test'); }, TypeError);
  assert.equal(validVerificationProfile({ ...profile, commands: ['npm test'] }), false);
  assert.notEqual(freezeVerificationProfile({ kind: 'code', commands: ['npm test'] }).digest, profile.digest);
  assert.equal(validVerificationProfile(freezeVerificationProfile({ kind: 'manual', commands: [], manualChecks: ['Inspect the diagram'], reason: 'No executable behavior changed' })), true);
  assert.throws(() => freezeVerificationProfile({ kind: 'code', commands: ['npm test\nnpm publish'] }));
});

test('criterion status remains unknown without exact evidence and not-applicable requires a reason', () => {
  const snapshot = requirement(), criterion = snapshot.criteria[0];
  assert.deepEqual(evaluateCriteria(snapshot).map(item => item.state), ['unknown', 'unknown']);
  assert.throws(() => evaluateCriteria(snapshot, [{ criterionId: criterion.id, criterionDigest: criterion.contentDigest, state: 'passed', evidence: [] }]));
  assert.throws(() => evaluateCriteria(snapshot, [{ criterionId: criterion.id, criterionDigest: criterion.contentDigest, state: 'not-applicable', evidence: [] }]));
  assert.equal(evaluateCriteria(snapshot, [{ criterionId: criterion.id, criterionDigest: criterion.contentDigest, state: 'not-applicable', evidence: [], reason: 'Only documentation changed' }])[0].state, 'not-applicable');
});

test('validation attempt history preserves failed and interrupted commands instead of relabeling success', () => {
  const passed = attempt(), failed: ValidationAttempt = { ...attempt(), id: 'attempt-failed', state: 'failed', commands: [{ command: 'npm test', exitCode: 1 }] };
  const interrupted: ValidationAttempt = { ...attempt(), id: 'attempt-interrupted', state: 'interrupted', completedAt: undefined, commands: [{ command: 'npm test', signal: 'SIGTERM' }] };
  assert.equal(validValidationAttempts([failed, interrupted, passed]), true);
  assert.equal(validValidationAttempts([{ ...passed, commands: [{ command: 'npm test', exitCode: 1 }] }]), false);
  assert.equal(validValidationAttempts([{ ...passed, commands: [] }]), false);
  assert.equal(validValidationAttempts([{ ...passed, completedAt: undefined }]), false);
  assert.equal(validValidationAttempts([{ ...passed, commands: [{ command: 'npm test', exitCode: 0, signal: 'SIGTERM' }] }]), false);
  assert.equal(validValidationAttempts([{ ...failed, ownerPid: 9 }]), false);
});

test('validation histories reject duplicate attempts invalid timing and out-of-bounds retention', () => {
  const value = attempt(); assert.equal(validValidationAttempts([value, value]), false);
  assert.equal(validValidationAttempts([{ ...value, completedAt: '2026-11-15T00:00:00.000Z' }]), false);
  assert.equal(validValidationAttempts([{ ...value, cycle: 0 }]), false);
  assert.equal(validValidationAttempts([{ ...value, cycle: 4 }]), false);
  assert.equal(validValidationAttempts([{ ...value, cwd: 'relative/source' }]), false);
  assert.equal(validValidationAttempts([{ ...value, commands: [{ command: 'npm test', cwd: 'relative/source', exitCode: 0 }] }]), false);
  assert.equal(validValidationAttempts(Array.from({ length: 100 }, (_, index) => ({ ...value, id: `attempt-${index}`, cycle: index % 3 + 1 }))), true);
  assert.equal(validValidationAttempts(Array.from({ length: 101 }, (_, index) => ({ ...value, id: `attempt-${index}`, cycle: index % 3 + 1 }))), false);
});
