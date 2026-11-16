import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import { projectCodexTask, projectTaskJourney, type CodexTaskRecord, type CodexTaskState } from '../../src/codex/protocol';

const state = (patch: Partial<CodexTaskState> = {}): CodexTaskState => ({ id: 'journey-task', title: 'Journey fixture', root: path.resolve('group'),
  status: 'completed', createdAt: '2026-11-15T00:00:00Z', updatedAt: '2026-11-15T00:00:00Z', ...patch });

test('task journey exposes readonly progress during delivery and cleanup instead of resuming work', () => {
  for (const patch of [
    { delivery: { mode: 'manual', state: 'running', steps: [] } },
    { cleanupState: 'running' }, { cleanupState: 'needs-attention' },
    { delivery: { mode: 'manual', state: 'needs-attention', steps: [] } }
  ] as Partial<CodexTaskState>[]) {
    const projected = projectTaskJourney(state(patch));
    assert.equal(projected.primaryAction?.kind, 'results');
    assert.equal(projected.primaryAction?.enabled, true);
    assert.equal(projected.blockers?.length, 1);
  }
});

test('task journey reconciles uncertain remote steps and messages before showing ordinary ready results', () => {
  for (const patch of [
    { delivery: { mode: 'manual', state: 'needs-attention', steps: [{ id: 'push', kind: 'push', state: 'uncertain', key: 'push-key' }] } },
    { delivery: { mode: 'manual', state: 'needs-attention', steps: [{ id: 'push', kind: 'push', state: 'sending', key: 'push-key' }] } },
    { uncertainMessages: 1 },
    { messageQueue: [{ id: 'message', text: 'Additional requirement', state: 'uncertain' }] },
    { messageQueue: [{ id: 'message', text: 'Additional requirement', state: 'sending' }] }
  ] as Partial<CodexTaskState>[]) {
    const projected = projectTaskJourney(state({ result: { state: 'ready', summary: 'Local result' }, ...patch }));
    assert.equal(projected.primaryAction?.kind, 'reconcile');
    assert.equal(projected.primaryAction?.enabled, true);
  }
});

test('task journey never exposes enabled control writes to an external observer', () => {
  const controls: NonNullable<CodexTaskState['controls']> = { external: true, canPause: false, canResume: false, canDelete: false, canAutoAccept: false, autoAccept: false };
  for (const entry of [
    { status: 'waiting', kind: 'answer' }, { status: 'running', kind: 'pause' },
    { status: 'paused', kind: 'resume' }, { status: 'uncertain', kind: 'reconcile' }
  ] as const) {
    const projected = projectTaskJourney(state({ status: entry.status, controls }));
    assert.equal(projected.primaryAction?.kind, entry.kind);
    assert.equal(projected.primaryAction?.enabled, false);
  }
  assert.equal(projectTaskJourney(state({ controls, result: { state: 'ready', summary: 'Readonly result' } })).primaryAction?.enabled, true);
});

test('task journey respects disabled Host capabilities even in the owning window', () => {
  const controls: NonNullable<CodexTaskState['controls']> = { external: false, canPause: false, canResume: false, canDelete: false, canAutoAccept: false, autoAccept: false };
  assert.deepEqual(projectTaskJourney(state({ status: 'running', controls })).primaryAction, { kind: 'pause', label: '暫停', enabled: false });
  assert.deepEqual(projectTaskJourney(state({ status: 'paused', controls })).primaryAction, { kind: 'resume', label: '恢復任務', enabled: false });
});

test('exhausted implementation cycles lead to preserved results while unfinished work may explicitly resume', () => {
  const task = state({ implementationCycles: 3, result: { state: 'needs-work', summary: 'More work is required' } });
  assert.equal(projectTaskJourney(task).primaryAction?.kind, 'results');
  assert.equal(projectTaskJourney({ ...task, implementationCycles: 2 }).primaryAction?.kind, 'resume');
});

test('free task locations keep the selected repository when the controlling workspace is its Group', () => {
  const root = path.resolve('group'), repository = path.join(root, 'selected-repository');
  const record: CodexTaskRecord = { ...state(), schema: 'GitLabWorkspaceCodexTask/v4', ownerPid: process.pid,
    spec: { root, executionRoot: repository, source: { kind: 'free', repository, prompt: 'Inspect' }, title: 'Inspect', prompt: 'Inspect',
      writableRoots: [repository], workspaceKey: root, environmentKey: 'fixture' } };
  const projected = projectCodexTask(record);
  assert.equal(projected.locations?.workspaceRoot, root);
  assert.equal(projected.locations?.sourceRoot, repository);
  assert.equal(projected.locations?.executionRoot, repository);
});
