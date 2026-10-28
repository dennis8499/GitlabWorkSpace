import assert from 'node:assert/strict';
import test from 'node:test';
import type { GitLabIssue } from '../../src/api/types';
import { assertExternalSopCreate, assertExternalSopUpdate, checkSopTransition, classifySop, directSopLinks, labelsForStage, normalizeSopConfig, readSopRecord, writeSopRecord } from '../../src/workspace/sop';

const config = normalizeSopConfig({ difficulties: ['Easy'], types: { Task: ['Task', 'Work'] } });
const issue = (labels: string[], overrides: Partial<GitLabIssue> = {}): GitLabIssue => ({ id: 10, iid: 10, project_id: 1, title: 'Issue', state: 'opened', web_url: 'https://gitlab.invalid/a/b/-/issues/10', labels, ...overrides });
const story = issue(['User Story']);
const record = () => readSopRecord('original');

test('recognizes exact default labels and aliases and reports conflicts without modifying unrelated labels', () => {
  assert.equal(classifySop(issue(['Task']), config).type, 'Task');
  assert.equal(classifySop(issue(['Work']), config).type, 'Task');
  assert.equal(classifySop(issue(['Tasking']), config).type, undefined);
  assert.equal(classifySop(issue(['Task'], { issue_type: 'task' }), config).type, undefined);
  assert.ok(classifySop(issue(['Task', 'Bug']), config).conflicts.length);
  assert.ok(classifySop(issue(['Task', 'Doing', 'Pending']), config).conflicts.length);
  assert.deepEqual(labelsForStage(['Task', 'Doing', 'customer'], '驗收', config), ['Task', 'customer', '驗收']);
  assert.deepEqual(labelsForStage(['Task', '驗收', 'customer'], 'Close', config), ['Task', 'customer']);
  assert.throws(() => normalizeSopConfig({ difficulties: ['Task'] }), /不可對應/);
  assert.throws(() => directSopLinks([story]), /未完整確認/);
  assert.equal(directSopLinks([{ ...story, link_type: 'relates_to' }]).length, 1);
});

test('managed records preserve the original text and refuse malformed or duplicated blocks', () => {
  const data = record(); data.fields.evidence = 'text --> remains safe';
  const description = writeSopRecord('original\ntext', data);
  assert.match(description, /^original\ntext/);
  assert.equal(readSopRecord(description).fields.evidence, 'text --> remains safe');
  const replacement = writeSopRecord(description + '\nafter', { ...data, fields: { evidence: 'new' } });
  assert.ok(replacement.endsWith('\nafter'));
  assert.throws(() => readSopRecord(description + description), /損壞或重複/);
});

test('requires a direct story, configured difficulty and an assignee before starting execution', () => {
  const task = issue(['Task']);
  const missing = checkSopTransition({ issue: task, config, record: record(), target: 'Doing' });
  assert.equal(missing.ok, false);
  assert.ok(missing.missing.includes('負責人'));
  assert.ok(missing.missing.includes('Linked Items 尚未完整讀取。'));
  const ready = issue(['Task', 'Easy'], { assignee: { id: 2, username: 'dev', name: 'Dev' } });
  const taskRecord = record(); taskRecord.fields = { goal: 'goal', scope: 'scope', acceptanceCriteria: 'works' };
  assert.equal(checkSopTransition({ issue: ready, config, record: taskRecord, target: 'Doing', links: [story] }).ok, true);
  const bug = issue(['Bug', 'Easy'], { assignee: { id: 2, username: 'dev', name: 'Dev' } });
  const bugRecord = record(); bugRecord.fields = { ...taskRecord.fields, bugSource: 'production', bugFunction: 'login', bugEnvironment: 'test', bugReproduction: 'steps', bugExpected: 'expected', bugActual: 'actual', bugEvidence: 'logs' };
  assert.equal(checkSopTransition({ issue: bug, config, record: bugRecord, target: 'Doing', links: [] }).ok, true);
});

test('pending, acceptance and closing enforce stage data and merge evidence', () => {
  const task = issue(['Task', 'Easy', 'Doing']);
  const data = record();
  assert.ok(checkSopTransition({ issue: task, config, record: data, target: 'Pending' }).missing.includes('阻塞原因'));
  data.fields = { pendingReason: 'blocked', waitingFor: 'QA', progress: 'investigating', nextStep: 'retry' };
  assert.equal(checkSopTransition({ issue: task, config, record: data, target: 'Pending' }).ok, true);
  Object.assign(data.fields, { acceptanceCriteria: 'works', acceptanceMethod: 'manual', acceptanceEnvironment: 'test', acceptancePerson: 'QA', acceptanceEvidence: 'log', codeChange: 'yes', acceptanceResult: 'passed', closeExplanation: 'done' });
  const accepted = issue(['Task', 'Easy', '驗收']);
  const openMr = [{ id: 1, iid: 2, project_id: 1, title: 'MR', state: 'opened', web_url: 'https://gitlab.invalid/mr' }];
  assert.ok(checkSopTransition({ issue: accepted, config, record: data, target: 'Close', links: [story], mergeRequests: openMr }).missing.includes('必要 MR 尚未合併。'));
  assert.equal(checkSopTransition({ issue: accepted, config, record: data, target: 'Close', links: [story], mergeRequests: [{ ...openMr[0], state: 'merged' }] }).ok, true);
  data.fields.acceptanceResult = 'failed';
  assert.ok(checkSopTransition({ issue: accepted, config, record: data, target: 'Close', links: [story], mergeRequests: [{ ...openMr[0], state: 'merged' }] }).missing.includes('驗收通過紀錄'));
});

test('other Issue entry points cannot bypass SOP transitions or create unlinked execution cards', () => {
  const task = issue(['Task', 'Doing']);
  assert.throws(() => assertExternalSopUpdate(task, { stateEvent: 'close' }, config), /SOP 工作流程/);
  assert.throws(() => assertExternalSopUpdate(task, { labels: ['Task', '驗收'] }, config), /SOP 工作流程/);
  assert.doesNotThrow(() => assertExternalSopUpdate(task, { labels: ['Task', 'Doing', 'customer'] }, config));
  assert.throws(() => assertExternalSopCreate(['Task'], config), /直接關聯/);
  assert.doesNotThrow(() => assertExternalSopCreate(['Doing'], config));
  assert.doesNotThrow(() => assertExternalSopCreate(['User Story'], config));
});

test('story deployment checks the selected release items and rejects stale selections', () => {
  const doing = issue(['User Story', 'Doing']);
  const data = record(); data.fields = { releaseVersion: 'v1', deploymentNotes: 'none', releaseHandoff: 'confirmed' };
  const finished = issue(['Task'], { iid: 11, state: 'closed' });
  const future = issue(['Bug'], { iid: 12 });
  assert.ok(checkSopTransition({ issue: doing, config, record: data, target: 'To Be Deployed', links: [finished, future] }).missing.includes('本次上版的執行牌卡尚未完成。'));
  data.fields.releaseItemIds = '1:11';
  assert.equal(checkSopTransition({ issue: doing, config, record: data, target: 'To Be Deployed', links: [finished, future] }).ok, true);
  data.fields.releaseItemIds = '1:999';
  assert.ok(checkSopTransition({ issue: doing, config, record: data, target: 'To Be Deployed', links: [finished, future] }).missing.includes('本次上版項目的關聯已變更，請重新選擇。'));
});
