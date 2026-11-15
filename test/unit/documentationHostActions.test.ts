import assert from 'node:assert/strict';
import test from 'node:test';
import type * as VSCode from 'vscode';
import { CodexHostActions, type CodexHostActionOptions } from '../../src/codex/hostActions';
import type { CodexTaskSpec } from '../../src/codex/protocol';

function fixture(selected: 'all' | 'partial' | 'cancel' = 'all') {
  const events: string[] = [], notices: string[] = [], confirms: Array<{ taskId: string; digest: string; checks: string[] }> = [];
  const checks = ['文件符合本次需求', '連結與內容已人工核對'], artifactDigest = 'a'.repeat(64);
  const spec: CodexTaskSpec = { root: 'C:/project', title: 'Docs update', prompt: 'Review docs', workspaceKey: 'fixture', environmentKey: 'fixture',
    source: { kind: 'issue', projectId: 1, issueIid: 2 }, writableRoots: ['C:/project'] };
  let previewFailure = false, confirmFailure = false, trusted = true;
  const bridge = { specification: async () => spec,
    documentationPreview: async () => { events.push('preview'); if (previewFailure) throw new Error('Not documentation only'); return { checks, artifactDigest }; },
    confirmDocumentation: async (taskId: string, digest: string, values: string[]) => {
      if (confirmFailure) throw new Error('Artifact changed after preview');
      events.push('confirm'); confirms.push({ taskId, digest, checks: values });
    } };
  const options = { bridge: () => bridge, check: (value: CodexTaskSpec) => { assert.equal(value, spec); events.push('check'); },
    diff: async (value: CodexTaskSpec, taskId: string) => { assert.equal(value, spec); assert.equal(taskId, 'task-docs'); events.push('diff'); } } as unknown as CodexHostActionOptions;
  const api = { workspace: { get isTrusted() { return trusted; } }, window: {
    showQuickPick: async (items: Array<{ label: string; index: number; picked?: boolean }>, settings: { canPickMany?: boolean }) => {
      events.push('pick'); assert.equal(settings.canPickMany, true); assert.equal(items.some(item => item.picked), false);
      assert.deepEqual(items.map(item => item.label), checks);
      return selected === 'all' ? items : selected === 'partial' ? items.slice(0, 1) : undefined;
    }, showInformationMessage: async (message: string) => { notices.push(message); }
  } } as unknown as typeof VSCode;
  return { actions: new CodexHostActions(options, api), events, notices, confirms, checks, artifactDigest,
    failPreview: () => { previewFailure = true; }, failConfirmation: () => { confirmFailure = true; }, untrust: () => { trusted = false; } };
}

test('manual documentation acceptance first opens the diff and requires every unchecked review item', async () => {
  const f = fixture(); await f.actions.run({ action: 'confirm-documentation', taskId: 'task-docs' });
  assert.deepEqual(f.events, ['check', 'preview', 'diff', 'pick', 'confirm']);
  assert.deepEqual(f.confirms, [{ taskId: 'task-docs', digest: f.artifactDigest, checks: f.checks }]);
  assert.equal(f.notices.length, 0);
});

test('cancelled or partial manual document reviews do not record acceptance or publish anything', async () => {
  for (const selection of ['partial', 'cancel'] as const) {
    const f = fixture(selection); await f.actions.run({ action: 'confirm-documentation', taskId: 'task-docs' });
    assert.deepEqual(f.events, ['check', 'preview', 'diff', 'pick']); assert.equal(f.confirms.length, 0);
    assert.equal(f.notices.length, selection === 'partial' ? 1 : 0);
  }
});

test('invalid document scope or changed artifact cannot be accepted through the Host action', async () => {
  const invalid = fixture(); invalid.failPreview(); await assert.rejects(invalid.actions.run({ action: 'confirm-documentation', taskId: 'task-docs' }), /Not documentation only/);
  assert.deepEqual(invalid.events, ['check', 'preview']); assert.equal(invalid.confirms.length, 0);
  const changed = fixture(); changed.failConfirmation(); await assert.rejects(changed.actions.run({ action: 'confirm-documentation', taskId: 'task-docs' }), /Artifact changed/);
  assert.equal(changed.confirms.length, 0);
});

test('manual document verification does not bypass workspace trust', async () => {
  const f = fixture(); f.untrust(); await assert.rejects(f.actions.run({ action: 'confirm-documentation', taskId: 'task-docs' }), /信任工作區/);
  assert.deepEqual(f.events, []); assert.equal(f.confirms.length, 0);
});
