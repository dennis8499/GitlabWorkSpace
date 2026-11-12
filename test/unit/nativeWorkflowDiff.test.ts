import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { gitCommitState } from '../../src/git/gitCommitState';
import { GitLabClient } from '../../src/api/gitLabClient';
import { GitLabNetworkGate } from '../../src/api/gitLabNetworkGate';
import { readMergeRequestFile, resolveMergeRequestFile, type MergeRequestDiffRequest } from '../../src/workspace/mergeRequestNativeDiff';
import type { MergeRequestDetail } from '../../src/workspace/workspaceProtocol';

const base = 'a'.repeat(40), head = 'b'.repeat(40), start = 'c'.repeat(40);
function detail(): MergeRequestDetail {
  return { request: { id: 2, project_id: 1, target_project_id: 1, source_project_id: 9, iid: 2,
    title: 'Fixed fork', web_url: 'https://gitlab.test/team/repo/-/merge_requests/2', state: 'opened', source_branch: 'feature', target_branch: 'main',
    diff_refs: { base_sha: base, start_sha: start, head_sha: head } }, diffVersionId: 7,
    diffs: [{ old_path: 'old/檔案.ts', new_path: 'new/檔案.ts', renamed_file: true, diff: '+patch' }], discussions: [],
    sections: { diffs: { status: 'ready' }, discussions: { status: 'idle' } }, freshness: { state: 'not_checked' }, warnings: [] };
}
const request: MergeRequestDiffRequest = { type: 'openMergeRequestDiff', projectId: 1, iid: 2, diffVersionId: 7, oldPath: 'old/檔案.ts', newPath: 'new/檔案.ts' };

test('native MR Diff resolves verified fork files using base/head, rename paths and immutable bytes', async () => {
  const calls: Array<[number, string, string]> = [];
  const file = resolveMergeRequestFile(detail(), request);
  const result = await readMergeRequestFile({ getRepositoryFileBytes: async (project, filePath, sha) => {
    calls.push([project, filePath, sha]); return new Uint8Array([0, 255, calls.length]);
  } }, file);
  assert.deepEqual(calls, [[1, 'old/檔案.ts', base], [9, 'new/檔案.ts', head]]);
  assert.deepEqual([...result.before], [0, 255, 1]); assert.deepEqual([...result.after], [0, 255, 2]);
  assert.throws(() => resolveMergeRequestFile(detail(), { ...request, diffVersionId: 8 }), /版本已變更/);
  assert.throws(() => resolveMergeRequestFile(detail(), { ...request, newPath: '../../secret' }), /無法核對/);
  assert.throws(() => resolveMergeRequestFile({ ...detail(), request: { ...detail().request, source_project_id: null } }, request), /來源專案/);
});

test('only verified add/delete flags create an empty side; permission failures never become empty files', async () => {
  const data = detail(), calls: string[] = [];
  const client = { getRepositoryFileBytes: async (_project: number, file: string) => { calls.push(file); return Buffer.from('contents'); } };
  data.diffs[0].new_file = true;
  const added = await readMergeRequestFile(client, resolveMergeRequestFile(data, request));
  assert.equal(added.before.length, 0); assert.deepEqual(calls, [request.newPath]);
  data.diffs[0].new_file = false; data.diffs[0].deleted_file = true; calls.length = 0;
  const deleted = await readMergeRequestFile(client, resolveMergeRequestFile(data, request));
  assert.equal(deleted.after.length, 0); assert.deepEqual(calls, [request.oldPath]);
  await assert.rejects(readMergeRequestFile({ getRepositoryFileBytes: async () => { throw new Error('HTTP 403'); } }, resolveMergeRequestFile(detail(), request)), /403/);
});

test('repository raw reads encode paths, pin a full SHA, preserve binary and refuse redirects/moving refs/over-limit bodies', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'native-raw-network-'));
  t.after(async () => { assert.ok(path.basename(root).startsWith('native-raw-network-')); await rm(root, { recursive: true, force: true }); });
  await writeFile(path.join(root, 'network-policy.json'), JSON.stringify({ schema: 'GitLabWorkspaceNetworkPolicy/v1', api: { startsPerSecond: 1000, concurrency: 2 } }));
  const gate = new GitLabNetworkGate(root);
  const urls: URL[] = [];
  const client = new GitLabClient('https://gitlab.test/base', 'test-token', async (input, init) => {
    const url = new URL(String(input)); urls.push(url);
    assert.equal(init?.redirect, 'manual'); assert.equal(new Headers(init?.headers).get('PRIVATE-TOKEN'), 'test-token');
    return new Response(new Uint8Array([0, 255, 10]), { headers: { 'content-type': 'application/octet-stream' } });
  }, undefined, undefined, undefined, undefined, 30_000, gate);
  assert.deepEqual([...await client.getRepositoryFileBytes(9, 'dir/中文 #.png', head)], [0, 255, 10]);
  assert.equal(urls[0].searchParams.get('ref'), head);
  assert.match(urls[0].pathname, /\/base\/api\/v4\/projects\/9\/repository\/files\/dir%2F/);
  await assert.rejects(client.getRepositoryFileBytes(9, 'file', 'main'), /無效/);
  await assert.rejects(client.getRepositoryFileBytes(9, '../file', head), /無效/);
  await assert.rejects(client.getRepositoryFileBytes(9, 'file', head, 2));
  const redirect = new GitLabClient('https://gitlab.test', 'test-token', async () => new Response(null, { status: 302, headers: { location: 'https://other.test/file' } }), undefined, undefined, undefined, undefined, 30_000, gate);
  await assert.rejects(redirect.getRepositoryFileBytes(9, 'file', head), /重新導向/);
  const missing = new GitLabClient('https://gitlab.test', 'test-token', async () => new Response('Missing', { status: 404 }), undefined, undefined, undefined, undefined, 30_000, gate);
  await assert.rejects(missing.getRepositoryFileBytes(9, 'file', head), /404/);
});

test('commit identity follows staged content and HEAD while ignoring unstaged edits and index stat refreshes', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'native-commit-state-'));
  t.after(async () => { assert.ok(path.basename(root).startsWith('native-commit-state-')); await rm(root, { recursive: true, force: true }); });
  const git = path.join(root, '.git'); await mkdir(path.join(git, 'refs', 'heads'), { recursive: true });
  await writeFile(path.join(git, 'HEAD'), 'ref: refs/heads/功能\n'); await writeFile(path.join(git, 'refs', 'heads', '功能'), head);
  const filename = Buffer.from('file.ts'), index = Buffer.alloc(12 + 72 + 20);
  index.write('DIRC'); index.writeUInt32BE(2, 4); index.writeUInt32BE(1, 8);
  index.writeUInt32BE(0o100644, 36); index.fill(1, 52, 72); index.writeUInt16BE(filename.length, 72); filename.copy(index, 74);
  await writeFile(path.join(git, 'index'), index);
  const shown = { branch: '功能', staged: ['file.ts'] }, initial = await gitCommitState(root, shown);
  await writeFile(path.join(root, 'file.ts'), 'unstaged edit'); index.writeUInt32BE(42, 12); await writeFile(path.join(git, 'index'), index);
  assert.equal(await gitCommitState(root, shown), initial);
  index[52] = 2; await writeFile(path.join(git, 'index'), index); assert.notEqual(await gitCommitState(root, shown), initial);
  const staged = await gitCommitState(root, shown); await writeFile(path.join(git, 'refs', 'heads', '功能'), base);
  assert.notEqual(await gitCommitState(root, shown), staged);
  assert.notEqual(await gitCommitState(root, { ...shown, staged: ['other.ts'] }), await gitCommitState(root, shown));
});
