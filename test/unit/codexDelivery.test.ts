import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { CodexDeliveryService, confirmCodexDelivery, deliveryComment } from '../../src/codex/delivery';
import { GitLabClient } from '../../src/api/gitLabClient';
import type { CodexTaskRecord } from '../../src/codex/protocol';
import type { CodexDeliveryState } from '../../src/codex/deliveryProtocol';

async function fixture(t: test.TestContext, report = '# Review\n\nComplete report.') {
  const root = await mkdtemp(path.join(os.tmpdir(), 'codex-delivery-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, 'review-reports'));
  const reportPath = path.join(root, 'review-reports', 'review.md'); await writeFile(reportPath, report);
  const sha = 'a'.repeat(40), target = 'b'.repeat(40);
  const record: CodexTaskRecord = { schema: 'GitLabWorkspaceCodexTask/v2', id: 'task-delivery', title: 'Review', root, status: 'completed',
    ownerPid: process.pid, createdAt: '2026-11-13', updatedAt: '2026-11-13', result: { state: 'ready', summary: 'Review complete', reportPath },
    spec: { source: { kind: 'merge-request', projectId: 1, iid: 2 }, title: 'Review', root, prompt: 'Do not persist this input in delivery receipts',
      writableRoots: [root], workspaceKey: root, environmentKey: 'test', delivery: { mode: 'automatic' },
      origin: { kind: 'merge-request', accountKey: 'test', baseUrl: 'https://gitlab.test', projectId: 1, projectPath: 'team/repo', webUrl: 'https://gitlab.test/team/repo/-/merge_requests/2',
        repositoryRoot: root, iid: 2, sourceBranch: 'feature', sourceSha: sha, targetBranch: 'main', targetSha: target } } };
  const notes: Array<{ id: number; body: string; author: { id: number; name: string } }> = [];
  const calls: Array<{ method: string; pathname: string; body?: any }> = [];
  let head = sha, loseNoteResponse = false, failUpload = false;
  const client = new GitLabClient('https://gitlab.test', 'test-token', async (url, init) => {
    const pathname = new URL(String(url)).pathname, method = init?.method ?? 'GET';
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
    calls.push({ method, pathname, body });
    if (method === 'GET' && pathname.endsWith('/repository/branches/main')) return Response.json({ name: 'main', commit: { id: target } });
    if (method === 'GET' && pathname.endsWith('/discussions')) return Response.json(notes.length ? [{ id: 'discussion', notes }] : []);
    if (method === 'GET' && pathname.endsWith('/merge_requests/2')) return Response.json({ id: 2, iid: 2, project_id: 1, state: 'opened', source_branch: 'feature', target_branch: 'main', sha: head, diff_refs: { head_sha: head } });
    if (method === 'POST' && pathname.endsWith('/notes')) {
      const note = { id: notes.length + 1, body: body.body, author: { id: 1, name: 'Test' } }; notes.push(note);
      return loseNoteResponse ? Response.json({}, { status: 500 }) : Response.json(note);
    }
    if (method === 'POST' && pathname.endsWith('/uploads')) return failUpload ? Response.json({}, { status: 500 }) : Response.json({ markdown: '[report](/uploads/report.md)', url: '/uploads/report.md', alt: 'report' });
    throw new Error(`Unexpected ${method} ${pathname}`);
  });
  const receipts: CodexDeliveryState[] = [];
  const checkpoint = async (state: CodexDeliveryState) => { receipts.push(structuredClone(state)); };
  const service = new CodexDeliveryService({ client: async () => client });
  await confirmCodexDelivery(record);
  return { root, reportPath, client, record, service, calls, receipts, checkpoint, notes, changeHead: () => { head = 'c'.repeat(40); },
    loseNote: () => { loseNoteResponse = true; }, failUpload: () => { failUpload = true; } };
}

test('review publication is task-bound, durable before POST and recovers an applied note whose response was lost', async t => {
  const f = await fixture(t); f.loseNote();
  const result = await f.service.deliver(f.record, f.checkpoint, () => {});
  assert.equal(result.state, 'published'); assert.equal(f.notes.length, 1);
  assert.ok(f.receipts.some(row => row.steps.some(step => step.state === 'sending')));
  assert.ok(!JSON.stringify(f.receipts).includes('Do not persist'));
  await f.service.deliver(f.record, f.checkpoint, () => {});
  assert.equal(f.notes.length, 1);
});

test('changed MR head blocks all writes without discarding the verified report', async t => {
  const f = await fixture(t); f.changeHead();
  const result = await f.service.deliver(f.record, f.checkpoint, () => {});
  assert.equal(result.state, 'ready'); assert.equal(f.record.delivery?.state, 'needs-attention');
  assert.equal(f.calls.filter(call => call.method !== 'GET').length, 0);
});

test('unknown report upload remains pending and retries never blindly upload again', async t => {
  const f = await fixture(t, 'Full report\n'.repeat(5000)); f.failUpload();
  await f.service.deliver(f.record, f.checkpoint, () => {});
  assert.equal(f.record.delivery?.steps.find(step => step.kind === 'upload')?.state, 'uncertain');
  const writes = f.calls.filter(call => call.method === 'POST').length;
  await f.service.deliver(f.record, f.checkpoint, () => {});
  await f.service.reconcile(f.record, f.checkpoint, () => {});
  assert.equal(f.calls.filter(call => call.method === 'POST').length, writes);
  assert.equal(f.notes.length, 0);
});

test('read-only reconciliation confirms existing notes without any new write', async t => {
  const f = await fixture(t);
  await f.service.deliver(f.record, f.checkpoint, () => {});
  f.record.delivery!.state = 'needs-attention'; f.record.delivery!.steps[0].state = 'uncertain';
  const writes = f.calls.filter(call => call.method !== 'GET').length;
  await f.service.reconcile(f.record, f.checkpoint, () => {});
  assert.equal(f.record.delivery!.steps[0].state, 'confirmed');
  assert.equal(f.calls.filter(call => call.method !== 'GET').length, writes);
});

test('manual mode does not create clients or publish anything', async t => {
  const f = await fixture(t); f.record.spec.delivery!.mode = 'manual'; f.record.delivery!.mode = 'manual';
  const service = new CodexDeliveryService({ client: async () => { throw new Error('No client should be acquired'); } });
  assert.equal((await service.deliver(f.record, f.checkpoint, () => {})).state, 'ready'); assert.equal(f.receipts.length, 0);
});

test('automated comments escape standalone GitLab slash commands', () => {
  assert.equal(deliveryComment('# Findings\n/close\n/assign @user\n/path/file.ts'), '# Findings\n\\/close\n\\/assign @user\n/path/file.ts');
});

test('report changes during metadata checks invalidate approval before publishing the captured report', async t => {
  const f = await fixture(t), original = f.client.getMergeRequest.bind(f.client); let reads = 0;
  t.mock.method(f.client, 'getMergeRequest', async (...args: Parameters<GitLabClient['getMergeRequest']>) => {
    const result = await original(...args);
    if (++reads === 2) await writeFile(f.reportPath, '# Changed after report capture\n');
    return result;
  });
  await f.service.deliver(f.record, f.checkpoint, () => {});
  assert.equal(f.record.delivery?.state, 'needs-attention'); assert.match(f.record.delivery?.error ?? '', /重新檢閱/);
  assert.equal(f.calls.filter(call => call.method !== 'GET').length, 0);
});
