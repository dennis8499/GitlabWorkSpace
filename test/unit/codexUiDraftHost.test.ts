import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { codexUiPublicInteractionFields, sanitizeCodexUiDraftValue } from '../../src/codex/uiDraftProtocol';
import type { CodexUiDraftSnapshot } from '../../src/codex/uiDraftProtocol';
import { describeAction } from '../../src/workspace/actionPolicy';

const key = (kind: string, id: string) => JSON.stringify([kind, id]);
function workspacePanelClass(): any {
  const loader = require('node:module'), original = loader._load;
  loader._load = (name: string, ...args: unknown[]) => name === 'vscode' ? {} : original(name, ...args);
  try { return require('../../src/workspace/workspacePanel').WorkspacePanel; } finally { loader._load = original; }
}
test('production Host restores conversation, answer, reply and launch drafts across panel and service recreation without dispatch', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'glw-ui-host-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const Panel = workspacePanelClass(); let account = 'account-a', root = 'repo-a';
  function createPanel() {
    const panel = Object.create(Panel.prototype), messages: any[] = [];
    panel.context = { globalStorageUri: { fsPath: directory } }; panel.viewGeneration = 1;
    panel.codexAccountKey = () => account; panel.resolveProjectContext = async () => ({ root });
    panel.codexUiQuestionFields = new Map([[JSON.stringify(['task', 'question']), new Set(['normal'])]]);
    panel.getCodexBridge = () => { throw new Error('Draft restoration must not start a task or model'); };
    panel.post = (message: unknown) => messages.push(message);
    const request = async (value: object) => { await panel.codexUiDraftRequest(value); return messages.at(-1); };
    return { panel, messages, request };
  }
  const first = createPanel(), loaded = await first.request({ type: 'loadCodexUiDrafts', requestId: 'load' });
  const scope = loaded.snapshot.scope as string, question = JSON.stringify(['task', 'question']), reply = JSON.stringify(['task', 'discussion']);
  const entries = [
    { key: key('draft', 'task'), revision: 0, value: { text: 'unsent follow-up', revision: 3, secret: 'unknown-property-secret' } },
    { key: key('interaction', question), revision: 0, value: { taskId: 'task', interactionId: 'question', revision: 2,
      values: { normal: 'unsent answer', password: 'secret-answer-value' } } },
    { key: key('reply', reply), revision: 0, value: { taskId: 'task', discussionId: 'discussion', text: 'unsent reply', revision: 4 } },
    { key: key('launch', 'launch'), revision: 0, value: { patch: { requirement: 'unsent requirement', acknowledgedSource: 'must-not-persist' }, baseRevision: 8 } }
  ];
  assert.equal((await first.request({ type: 'saveCodexUiDrafts', requestId: 'save', scope, updates: entries })).error, undefined);
  first.panel.viewGeneration++;
  const reopened = createPanel(), restored = (await reopened.request({ type: 'loadCodexUiDrafts', requestId: 'reopen' })).snapshot as CodexUiDraftSnapshot;
  assert.equal(restored.entries.length, 4);
  assert.deepEqual(restored.entries.find(entry => entry.key === key('interaction', question))?.value,
    { taskId: 'task', interactionId: 'question', revision: 2, values: { normal: 'unsent answer' } });
  const contents = (await Promise.all((await readdir(path.join(directory, 'codex-ui-drafts'))).filter(name => name.endsWith('.json'))
    .map(name => readFile(path.join(directory, 'codex-ui-drafts', name), 'utf8')))).join('');
  for (const secret of ['unknown-property-secret', 'secret-answer-value', 'must-not-persist']) assert.equal(contents.includes(secret), false);
  assert.equal(JSON.stringify(restored).includes('unsent follow-up'), true); assert.equal(JSON.stringify(restored).includes('unsent reply'), true);
  reopened.panel.codexUiQuestionFields.clear();
  const questionEntry = restored.entries.find(entry => entry.key === key('interaction', question))!;
  assert.match((await reopened.request({ type: 'saveCodexUiDrafts', requestId: 'missing-question', scope, updates: [questionEntry] })).error, /重新載入問題/);
  assert.deepEqual((await createPanel().request({ type: 'loadCodexUiDrafts', requestId: 'after-rejected-answer' })).snapshot.entries, restored.entries);
  root = 'repo-b'; assert.equal((await reopened.request({ type: 'loadCodexUiDrafts', requestId: 'other-root' })).snapshot.entries.length, 0);
  assert.match((await reopened.request({ type: 'saveCodexUiDrafts', requestId: 'stale-root', scope, updates: entries })).error, /環境已變更/);
  root = 'repo-a'; account = 'account-b'; assert.equal((await reopened.request({ type: 'loadCodexUiDrafts', requestId: 'other-account' })).snapshot.entries.length, 0);
  account = 'account-a'; assert.equal((await createPanel().request({ type: 'loadCodexUiDrafts', requestId: 'restart' })).snapshot.entries.length, 4);
  const delayed = createPanel(); let release!: () => void, reading!: () => void;
  const began = new Promise<void>(resolve => { reading = resolve; });
  delayed.panel.codexUiDraftStore = { read: async () => { reading(); await new Promise<void>(resolve => { release = resolve; }); return restored; } };
  const late = delayed.panel.codexUiDraftRequest({ type: 'loadCodexUiDrafts', requestId: 'late' });
  await began; root = 'repo-b'; release(); await late; assert.equal(delayed.messages.length, 0, 'old project drafts cannot hydrate a new project');
  root = 'repo-a'; await first.panel.codexUiDraftStore.removeTask('task');
  const fenced = await reopened.request({ type: 'saveCodexUiDrafts', requestId: 'deleted-question', scope, updates: [questionEntry,
    { key: key('draft', 'unrelated'), revision: 0, value: { text: 'keep other work', revision: 1 } }] });
  assert.equal(fenced.error, undefined); assert.deepEqual(fenced.snapshot.deletedTaskIds, ['task']);
  assert.equal(fenced.snapshot.entries.some((entry: any) => entry.value?.text === 'keep other work'), true);
  for (const type of ['loadCodexUiDrafts', 'saveCodexUiDrafts']) assert.equal(describeAction({ type }).kind, 'control');
});

test('durable draft sanitizer whitelists receipts and excludes acknowledged source and unknown nested properties', () => {
  const saved = sanitizeCodexUiDraftValue(key('submission', JSON.stringify(['task', 'interaction'])), {
    taskId: 'task', interactionId: 'interaction', draftRevision: 2, requestId: 'op', action: 'answerCodex', resourceKey: 'codex:task', label: 'Answer',
    answers: { secret: 'never-store' }, raw: 'never-store', correlationId: 'correlation'
  });
  assert.equal(JSON.stringify(saved).includes('never-store'), false);
  assert.throws(() => sanitizeCodexUiDraftValue(key('draft', 'task'), { text: 'x'.repeat(32001), revision: 1 }), /範圍/);
  assert.throws(() => sanitizeCodexUiDraftValue(key('unrecognized', 'task'), {}), /識別/);
  const fields = codexUiPublicInteractionFields({ kind: 'form', schema: { type: 'object', properties: { public: { type: 'string' }, private: { type: 'string', secret: true } } } });
  assert.deepEqual([...fields!], ['public']);
  const form = sanitizeCodexUiDraftValue(key('interaction', JSON.stringify(['task', 'form'])), { taskId: 'task', interactionId: 'form', revision: 1,
    values: { public: 'keep me', private: 'never-store' } }, fields);
  assert.equal(JSON.stringify(form).includes('keep me'), true); assert.equal(JSON.stringify(form).includes('never-store'), false);
  assert.equal(codexUiPublicInteractionFields({ kind: 'form', schema: { type: 'object', properties: { unsupported: { type: 'object' } } } }), undefined);
});
