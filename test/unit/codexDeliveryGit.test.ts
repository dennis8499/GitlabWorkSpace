import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync, spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { cp, mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { GitLabClient } from '../../src/api/gitLabClient';
import { CodexDeliveryService } from '../../src/codex/delivery';
import { implementationDigest, startManagedWorktree } from '../../src/codex/projectWorkflows';
import type { CodexTaskRecord } from '../../src/codex/protocol';
import type { GitLabIssueDiscussion, GitLabMergeRequest } from '../../src/api/types';

const git = (root: string, ...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', windowsHide: true });
async function fixture(t: test.TestContext, mrFix = false) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'codex-delivery-git-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repo = path.join(root, 'repo'), bare = path.join(root, 'remote.git'), runtime = path.join(root, 'runtime'); await mkdir(repo);
  git(repo, 'init', '-q', '--initial-branch=main'); git(repo, 'config', 'user.name', 'Delivery Test'); git(repo, 'config', 'user.email', 'delivery@test.invalid');
  await writeFile(path.join(repo, 'source.txt'), 'initial\n'); git(repo, 'add', '.'); git(repo, 'commit', '-qm', 'initial');
  const sha = git(repo, 'rev-parse', 'HEAD').trim();
  await cp(path.join(repo, '.git'), bare, { recursive: true }); git(bare, 'config', 'core.bare', 'true'); git(bare, 'config', 'http.receivepack', 'true');
  if (mrFix) git(bare, 'update-ref', 'refs/heads/feature', sha);
  const server = createServer((request, response) => {
    const url = new URL(request.url!, 'http://localhost');
    const child = spawn('git', ['http-backend'], { windowsHide: true, env: { ...process.env,
      GIT_PROJECT_ROOT: root, GIT_HTTP_EXPORT_ALL: '1', PATH_INFO: url.pathname, QUERY_STRING: url.search.slice(1),
      REQUEST_METHOD: request.method, CONTENT_TYPE: request.headers['content-type'], CONTENT_LENGTH: request.headers['content-length'], REMOTE_USER: 'fixture' } });
    request.pipe(child.stdin); const chunks: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => chunks.push(chunk)); child.stderr.resume();
    child.on('error', () => { response.statusCode = 500; response.end(); });
    child.on('close', () => {
      const bytes = Buffer.concat(chunks), split = bytes.indexOf('\r\n\r\n');
      if (split < 0) { response.statusCode = 500; response.end(); return; }
      for (const header of bytes.subarray(0, split).toString('utf8').split('\r\n')) {
        const colon = header.indexOf(':'); if (colon < 0) continue;
        const name = header.slice(0, colon), value = header.slice(colon + 1).trim();
        if (name.toLowerCase() === 'status') response.statusCode = Number(value.split(' ')[0]); else response.setHeader(name, value);
      }
      response.end(bytes.subarray(split + 4));
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('No fixture port');
  const remote = `http://127.0.0.1:${address.port}/remote.git`; git(repo, 'remote', 'add', 'origin', remote);
  const branch = mrFix ? 'mr/2-fix-fixture' : 'issue/1-fixture', worktree = path.join(runtime, 'worktree');
  const record: CodexTaskRecord = { schema: 'GitLabWorkspaceCodexTask/v2', id: 'task-native-delivery', title: 'Fix source', root, ownerPid: process.pid,
    createdAt: '2026-11-13', updatedAt: '2026-11-13', status: 'completed',
    spec: { root, prompt: 'Fix source', title: 'Fix source', workspaceKey: root, writableRoots: [worktree], environmentKey: 'fixture', executionRoot: worktree,
      source: mrFix ? { kind: 'merge-request', projectId: 1, iid: 2, intent: 'fix-comments' } : { kind: 'issue', projectId: 1, issueIid: 1 }, delivery: { mode: 'automatic' },
      origin: { kind: mrFix ? 'merge-request' : 'issue', accountKey: 'test', baseUrl: 'https://gitlab.test', projectId: 1, projectPath: 'team/repo',
        webUrl: `https://gitlab.test/team/repo/-/${mrFix ? 'merge_requests/2' : 'issues/1'}`, repositoryRoot: repo, iid: mrFix ? 2 : 1,
        sourceBranch: mrFix ? 'feature' : 'main', sourceSha: sha, branch, sourceProjectId: 1,
        ...(mrFix ? { targetBranch: 'main', targetSha: sha } : { updatedAt: '2026-11-13' }) },
      workflow: { id: 'a'.repeat(32), runtimeRoot: runtime, remote: 'origin', worktree: { path: worktree, branch, sourceSha: sha, repository: repo } } } };
  await startManagedWorktree(record.spec); await writeFile(path.join(worktree, 'source.txt'), 'fixed\n');
  const discussion: GitLabIssueDiscussion = { id: 'selected', individual_note: false, notes: [{ id: 1, body: 'Fix source', author: { id: 2, name: 'Reviewer', username: 'reviewer' }, created_at: '2026-11-13' }] };
  if (mrFix) record.spec.workflow!.discussions = [{ id: 'selected', noteIds: [1], text: '#1 Reviewer：\nFix source' }];
  record.result = { state: 'ready', summary: 'Source fixed', files: ['source.txt'], tests: [{ command: 'node --test', exitCode: 0 }] };
  record.validation = { cwd: worktree, artifactDigest: await implementationDigest(record.spec, record.result.files!), testedAt: new Date().toISOString(),
    commands: [{ command: 'node --test', exitCode: 0, cwd: worktree, itemId: 'approved-test', startedAtMs: 1, completedAtMs: 2 }] };
  const mrs: GitLabMergeRequest[] = [], issueNotes: Array<{ id: number; body: string }> = [], writes: string[] = [];
  const client = new GitLabClient('https://gitlab.test', 'fixture-token', async (url, init) => {
    const pathname = new URL(String(url)).pathname, method = init?.method ?? 'GET', body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
    if (method !== 'GET') writes.push(pathname);
    if (method === 'GET' && pathname.endsWith('/issues/1')) return Response.json({ id: 1, iid: 1, updated_at: '2026-11-13' });
    if (method === 'GET' && pathname.endsWith('/repository/branches/main')) return Response.json({ name: 'main', commit: { id: git(bare, 'rev-parse', 'main').trim() } });
    if (method === 'GET' && /\/projects\/[12]$/.test(pathname)) return Response.json({ id: record.spec.origin!.sourceProjectId ?? 1, path_with_namespace: 'team/repo', http_url_to_repo: remote });
    if (method === 'GET' && pathname.endsWith('/merge_requests/2')) {
      const head = git(bare, 'rev-parse', 'refs/heads/feature').trim();
      return Response.json({ id: 2, iid: 2, project_id: 1, source_project_id: record.spec.origin!.sourceProjectId ?? 1, state: 'opened', source_branch: 'feature', target_branch: 'main', sha: head, diff_refs: { head_sha: head } });
    }
    if (method === 'GET' && pathname.endsWith('/merge_requests')) return Response.json(mrs);
    if (method === 'GET' && pathname.endsWith('/discussions')) return Response.json(mrFix ? [discussion] : issueNotes.length ? [{ id: 'issue', notes: issueNotes }] : []);
    if (method === 'POST' && pathname.endsWith('/merge_requests')) {
      const mr: GitLabMergeRequest = { id: 10, iid: 10, project_id: 1, source_project_id: 1, target_project_id: 1, state: 'opened', title: body.title,
        description: body.description, source_branch: body.source_branch, target_branch: body.target_branch, web_url: 'https://gitlab.test/team/repo/-/merge_requests/10' };
      mrs.push(mr); return Response.json(mr);
    }
    if (method === 'POST' && pathname.endsWith('/notes')) {
      const note = { id: 100, body: body.body, author: { id: 1, name: 'Test', username: 'test' }, created_at: '2026-11-13' };
      if (mrFix) discussion.notes.push(note); else issueNotes.push(note); return Response.json(note);
    }
    throw new Error(`Unexpected ${method} ${pathname}`);
  });
  const service = new CodexDeliveryService({ client: async () => client });
  const advanceTarget = async () => {
    await writeFile(path.join(repo, 'target-change.txt'), 'new target commit\n'); git(repo, 'add', '.'); git(repo, 'commit', '-qm', 'target advanced');
    const target = git(repo, 'rev-parse', 'HEAD').trim(); await cp(path.join(repo, '.git', 'objects'), path.join(bare, 'objects'), { recursive: true });
    git(bare, 'update-ref', 'refs/heads/main', target); return target;
  };
  return { record, repo, bare, root, worktree, remote, service, writes, mrs, issueNotes, discussion, advanceTarget };
}

test('Issue delivery commits only its validated worktree, pushes, creates Draft MR and posts one idempotent summary', async t => {
  const f = await fixture(t);
  const result = await f.service.deliver(f.record, async () => {}, () => {});
  assert.equal(f.record.delivery?.state, 'published', f.record.delivery?.error ?? '');
  assert.equal(result.state, 'published'); assert.equal(f.mrs.length, 1); assert.match(f.mrs[0].title, /^Draft:/); assert.equal(f.issueNotes.length, 1);
  const delivered = f.record.delivery!.deliveredCommitSha!;
  assert.equal(git(f.bare, 'rev-parse', f.record.spec.origin!.branch!).trim(), delivered);
  assert.equal(git(f.repo, 'branch', '--show-current').trim(), 'main');
  await f.service.deliver(f.record, async () => {}, () => {});
  assert.equal(f.mrs.length, 1); assert.equal(f.issueNotes.length, 1);
});

test('MR fix verifies its own newly pushed SHA and replies without opening a second MR', async t => {
  const f = await fixture(t, true);
  const result = await f.service.deliver(f.record, async () => {}, () => {});
  assert.equal(f.record.delivery?.state, 'published', f.record.delivery?.error ?? '');
  assert.equal(result.state, 'published'); assert.equal(f.discussion.notes.length, 2); assert.equal(f.mrs.length, 0);
  assert.equal(git(f.bare, 'rev-parse', 'feature').trim(), f.record.delivery!.deliveredCommitSha);
});

test('fork MR delivery uses its verified source URL without adding or rewriting a Git remote', async t => {
  const f = await fixture(t, true), targetRemote = f.remote.replace('/remote.git', '/target.git');
  git(f.repo, 'remote', 'set-url', 'origin', targetRemote);
  f.record.spec.origin!.sourceProjectId = 2; f.record.spec.origin!.pushUrl = f.remote;
  await f.service.deliver(f.record, async () => {}, () => {});
  assert.equal(f.record.delivery?.state, 'published', f.record.delivery?.error ?? '');
  assert.equal(git(f.repo, 'remote', 'get-url', 'origin').trim(), targetRemote);
  assert.equal(git(f.bare, 'rev-parse', 'feature').trim(), f.record.delivery!.deliveredCommitSha);
});

test('an advanced Issue target permits a Draft MR with explicit tested and observed baselines', async t => {
  const f = await fixture(t), captured = f.record.spec.origin!.sourceSha, current = await f.advanceTarget();
  await f.service.deliver(f.record, async () => {}, () => {});
  assert.equal(f.record.delivery?.state, 'published', f.record.delivery?.error ?? '');
  assert.equal(f.record.spec.origin!.sourceSha, captured);
  assert.equal(git(f.worktree, 'rev-parse', 'HEAD^').trim(), captured, 'delivery must never silently rebase');
  assert.match(f.mrs[0].description ?? '', new RegExp(captured)); assert.match(f.mrs[0].description ?? '', new RegExp(current));
  assert.match(f.mrs[0].description ?? '', /目標分支已前進/);
});

test('delivery stages a complete inventory beyond 500 files without Windows path argument overflow', async t => {
  const f = await fixture(t), files = Array.from({ length: 520 }, (_, index) => `file-${index.toString().padStart(4, '0')}-${'x'.repeat(60)}.txt`);
  await Promise.all(files.map(file => writeFile(path.join(f.worktree, file), 'new source\n')));
  f.record.result!.files!.push(...files); f.record.validation!.artifactDigest = await implementationDigest(f.record.spec, f.record.result!.files!);
  await f.service.deliver(f.record, async () => {}, () => {});
  assert.equal(f.record.delivery?.state, 'published', f.record.delivery?.error ?? '');
  assert.equal(git(f.bare, 'ls-tree', '-r', '--name-only', f.record.delivery!.deliveredCommitSha!).trim().split(/\r?\n/).length, 521);
});

test('commit hooks remain active and rejection prevents all remote writes', async t => {
  const f = await fixture(t), hooks = path.join(f.root, 'hooks'); await mkdir(hooks);
  await writeFile(path.join(hooks, 'pre-commit'), '#!/bin/sh\nexit 1\n', { mode: 0o755 }); git(f.repo, 'config', 'core.hooksPath', hooks.replaceAll('\\', '/'));
  await f.service.deliver(f.record, async () => {}, () => {});
  assert.equal(f.record.delivery?.state, 'needs-attention'); assert.equal(f.writes.length, 0);
  assert.equal(git(f.worktree, 'rev-parse', 'HEAD').trim(), f.record.spec.origin!.sourceSha);
  await f.service.reconcile(f.record, async () => {}, () => {});
  assert.equal(f.record.delivery!.steps.find(step => step.kind === 'commit')?.state, 'prepared');
  assert.equal(f.writes.length, 0, 'reconciliation must not POST or push');
});

test('a changed file after final validation blocks commits and every remote write', async t => {
  const f = await fixture(t); await writeFile(path.join(f.worktree, 'source.txt'), 'changed after test\n');
  await f.service.deliver(f.record, async () => {}, () => {});
  assert.equal(f.record.delivery?.state, 'needs-attention'); assert.equal(f.writes.length, 0);
  assert.equal(git(f.worktree, 'rev-parse', 'HEAD').trim(), f.record.spec.origin!.sourceSha);
});

test('a hook that changes the committed tree prevents push and is recovered without creating another commit', async t => {
  const f = await fixture(t), hooks = path.join(f.root, 'hooks'); await mkdir(hooks);
  await writeFile(path.join(hooks, 'pre-commit'), '#!/bin/sh\nprintf "hook changed source\\n" > source.txt\ngit add source.txt\n', { mode: 0o755 });
  git(f.repo, 'config', 'core.hooksPath', hooks.replaceAll('\\', '/'));
  await f.service.deliver(f.record, async () => {}, () => {});
  assert.equal(f.record.delivery?.state, 'needs-attention'); assert.equal(f.writes.length, 0);
  const head = git(f.worktree, 'rev-parse', 'HEAD').trim(); assert.notEqual(head, f.record.spec.origin!.sourceSha);
  await f.service.reconcile(f.record, async () => {}, () => {});
  assert.equal(f.record.delivery!.steps.find(step => step.kind === 'commit')?.sha, head);
  assert.equal(git(f.worktree, 'rev-parse', 'HEAD').trim(), head);
  assert.equal(f.writes.length, 0);
});

test('a closed task-owned Draft MR is never recreated after a checkpoint interruption', async t => {
  const f = await fixture(t); let interrupted = false;
  await f.service.deliver(f.record, async state => {
    if (!interrupted && state.steps.some(step => step.kind === 'merge-request' && step.state === 'confirmed')) { interrupted = true; throw new Error('checkpoint interruption'); }
  }, () => {});
  assert.equal(f.mrs.length, 1); f.mrs[0].state = 'closed';
  await f.service.deliver(f.record, async () => {}, () => {});
  assert.equal(f.mrs.length, 1); assert.equal(f.record.delivery?.state, 'needs-attention');
  assert.match(f.record.delivery?.error ?? '', /關閉/);
});
