import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, mkdtemp, realpath, rm, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { canAutoApproveLocalRequest } from '../../src/codex/bridge';
import type { RpcMessage } from '../../src/codex/appServer';
import type { CodexTaskSpec } from '../../src/codex/protocol';

async function fixture(t: test.TestContext) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'glw-local-approval-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const writable = path.join(root, 'task'); await mkdir(writable);
  const spec: CodexTaskSpec = { source: { kind: 'free', repository: writable, prompt: 'Local work' }, title: 'Local work',
    root: writable, executionRoot: writable, writableRoots: [writable], workspaceKey: 'fixture', environmentKey: 'fixture', prompt: 'Local work' };
  const command = (extra: Record<string, unknown> = {}): RpcMessage => ({ method: 'item/commandExecution/requestApproval',
    params: { threadId: 'thread', turnId: 'turn', itemId: 'item', command: 'git status', cwd: writable, availableDecisions: ['accept', 'decline'], ...extra } });
  const file = (grantRoot?: string): RpcMessage => ({ method: 'item/fileChange/requestApproval', params: { itemId: 'file', ...(grantRoot === undefined ? {} : { grantRoot }) } });
  return { root, writable, spec, command, file };
}

test('local approval accepts known single operations within the frozen task roots', async t => {
  const f = await fixture(t);
  assert.equal(await canAutoApproveLocalRequest(f.spec, f.command()), true);
  assert.equal(await canAutoApproveLocalRequest(f.spec, f.command({ kind: 'command', environmentId: null, startedAtMs: 1234 })), true);
  assert.equal(await canAutoApproveLocalRequest(f.spec, f.file()), true);
  assert.equal(await canAutoApproveLocalRequest(f.spec, { ...f.file(), params: { itemId: 'file', startedAtMs: 1234, grantRoot: null } }), true);
  assert.equal(await canAutoApproveLocalRequest(f.spec, f.file(path.join(f.writable, 'new', 'nested'))), true);
});

test('local approval leaves embedded permissions network and unknown request shapes manual', async t => {
  const f = await fixture(t);
  const cases: Array<{ id: string; request: RpcMessage }> = [
    { id: 'embedded-filesystem', request: f.command({ additionalPermissions: { fileSystem: { write: [f.root] } } }) },
    { id: 'embedded-network', request: f.command({ additionalPermissions: { network: { enabled: true } } }) },
    { id: 'network-context', request: f.command({ networkApprovalContext: { host: 'example.test', protocol: 'https' } }) },
    { id: 'unknown-kind', request: f.command({ kind: 'future-approval' }) },
    { id: 'human-checkpoint', request: f.command({ kind: 'humanCommand' }) },
    { id: 'terminal-input', request: f.command({ kind: 'writeStdin' }) },
    { id: 'other-environment', request: f.command({ environmentId: 'other-environment' }) },
    { id: 'unknown-field', request: f.command({ futurePermission: true }) },
    { id: 'exec-policy', request: f.command({ proposedExecpolicyAmendment: ['git'] }) },
    { id: 'session-only', request: f.command({ availableDecisions: ['acceptForSession', 'decline'] }) },
    { id: 'remote-publication', request: f.command({ command: 'git push origin task' }) },
    { id: 'permission-method', request: { method: 'item/permissions/requestApproval', params: { permissions: { fileSystem: { read: [f.writable] } } } } },
    { id: 'ancestor-grant', request: f.file(f.root) },
    { id: 'sibling-grant', request: f.file(path.join(f.root, 'task-other')) },
    { id: 'relative-grant', request: f.file('task') },
    { id: 'outside-command', request: f.command({ cwd: f.root }) }
  ];
  for (const entry of cases) await t.test(entry.id, async () => assert.equal(await canAutoApproveLocalRequest(f.spec, entry.request), false));
});

test('local approval resolves directory links before accepting a file grant', async t => {
  const f = await fixture(t), outside = path.join(f.root, 'outside'); await mkdir(outside);
  const redirect = path.join(f.writable, 'redirect');
  try { await symlink(outside, redirect, process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (error) {
    if (['EPERM', 'EACCES', 'ENOTSUP'].includes((error as NodeJS.ErrnoException).code ?? '')) { t.skip('Directory links are unavailable'); return; }
    throw error;
  }
  assert.equal(await canAutoApproveLocalRequest(f.spec, f.file(path.join(redirect, 'missing'))), false);
});
