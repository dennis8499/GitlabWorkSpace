import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { CodexBridge, type CodexBridgeOptions } from '../../src/codex/bridge';
import { CodexTaskStore } from '../../src/codex/taskStore';
import { CodexTaskScheduler } from '../../src/codex/scheduler';
import { CodexUiDraftStore } from '../../src/codex/uiDraftStore';
import type { CodexTaskRecord, CodexTaskSpec } from '../../src/codex/protocol';

test('draft cleanup failures remain in the task cleanup journal and retry after Host restart', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'glw-ui-cleanup-')), bridges: CodexBridge[] = [];
  t.after(async () => { for (const bridge of bridges) await bridge.shutdown(); await rm(root, { recursive: true, force: true }); });
  const id = 'draft-cleanup-task', scope = 'a'.repeat(64), key = JSON.stringify(['draft', id]);
  const drafts = new CodexUiDraftStore(path.join(root, 'codex-ui-drafts'));
  await drafts.save(scope, [{ key, revision: 0, value: { text: 'private unsent draft', revision: 1 } }]);
  const spec: CodexTaskSpec = { source: { kind: 'free', repository: root, prompt: 'Review local work' }, title: 'Local task', root,
    workspaceKey: root, environmentKey: 'test', writableRoots: [root], prompt: 'Review local work' };
  const record: CodexTaskRecord = { schema: 'GitLabWorkspaceCodexTask/v2', id, spec, root, title: spec.title, status: 'completed', ownerPid: process.pid,
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
  await new CodexTaskStore(path.join(root, 'codex-tasks')).save(record);
  let cleanupFails = true, attempts = 0;
  const options: CodexBridgeOptions = { storage: root, version: 'test', executable: () => '', trusted: () => true, event: () => {}, openUrl: async () => {},
    prepare: async () => { throw new Error('Cleanup must not dispatch or prepare'); }, client: async () => { throw new Error('Cleanup must not call a model'); },
    cleanupDrafts: async taskId => { attempts++; if (cleanupFails) throw new Error('fixture storage unavailable'); await drafts.removeTask(taskId); } };
  const make = () => { const bridge = new CodexBridge({ ...options, scheduler: new CodexTaskScheduler('draft-cleanup', root) }); bridges.push(bridge); return bridge; };
  const first = make(); await first.initialize();
  await assert.rejects(first.delete(id), /fixture storage unavailable/);
  assert.equal(first.list().length, 0); assert.ok(attempts > 0);
  assert.equal(JSON.parse(await readFile(path.join(root, 'codex-tasks', id + '.cleanup.json'), 'utf8')).id, id);
  assert.equal((await drafts.read(scope)).entries.length, 1);
  await first.shutdown(); cleanupFails = false;
  const restarted = make(); await restarted.initialize();
  assert.equal(restarted.list().length, 0); assert.equal((await drafts.read(scope)).entries.length, 0);
  await assert.rejects(readFile(path.join(root, 'codex-tasks', id + '.cleanup.json')), /ENOENT/);
  const stale = await drafts.save(scope, [{ key, revision: 0, value: { text: 'late stale window', revision: 2 } }]);
  assert.deepEqual(stale.deletedTaskIds, [id]); assert.equal(stale.entries.length, 0);
});
