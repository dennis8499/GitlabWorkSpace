import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync, spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { cp, mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { GitLabClient } from '../../src/api/gitLabClient';
import { CodexDeliveryService, confirmCodexDelivery, deliveryConfirmationDigest, issueDeliveryDigest, issueDeliverySnapshot, issueDeliverySummary } from '../../src/codex/delivery';
import { CodexBridge } from '../../src/codex/bridge';
import { CodexTaskStore } from '../../src/codex/taskStore';
import { implementationDigest, startManagedWorktree } from '../../src/codex/projectWorkflows';
import type { CodexTaskRecord } from '../../src/codex/protocol';
import type { GitLabIssue, GitLabIssueDiscussion, GitLabMergeRequest } from '../../src/api/types';
import { createRequirementSnapshot, freezeVerificationProfile } from '../../src/codex/workContext';

const git = (root: string, ...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', windowsHide: true });

test('Issue delivery fingerprints stable requirement fields and ignores ordering and GitLab activity metadata', () => {
  const issue: GitLabIssue = { id: 1, project_id: 2, iid: 3, title: 'Required change', description: 'Complete acceptance criteria.', state: 'opened',
    web_url: 'https://gitlab.test/team/repo/-/issues/3', labels: ['z', 'a'], assignees: [{ id: 4, name: 'User', username: 'user' }, { id: 5, name: 'Other', username: 'other' }],
    milestone: { id: 6, title: 'Release' }, due_date: '2026-12-01', start_date: '2026-11-01', confidential: false, discussion_locked: false, issue_type: 'issue' };
  const digest = issueDeliveryDigest(issueDeliverySnapshot(issue));
  const activity = structuredClone(issue); Object.assign(activity, { updated_at: '2026-11-14T01:00:00Z', user_notes_count: 20, upvotes: 5, downvotes: 1, references: { full: 'team/repo#3' } });
  activity.labels!.reverse(); activity.assignees!.reverse();
  assert.equal(issueDeliveryDigest(issueDeliverySnapshot(activity)), digest);
  const edits: Partial<GitLabIssue>[] = [{ id: 10 }, { project_id: 10 }, { iid: 10 }, { title: 'Changed requirement' }, { description: 'Changed acceptance criteria.' }, { state: 'closed' },
    { labels: ['a', 'different'] }, { assignees: [] }, { milestone: null }, { due_date: null }, { start_date: null }, { confidential: true }, { discussion_locked: true }, { issue_type: 'incident' }];
  for (const edit of edits) assert.notEqual(issueDeliveryDigest(issueDeliverySnapshot({ ...issue, ...edit })), digest, `changed ${Object.keys(edit).join(',')} must invalidate approval`);
  const long = issueDeliverySnapshot({ ...issue, description: 'Full requirement body. '.repeat(700) });
  const summary = issueDeliverySummary(long, issue.web_url);
  assert.ok(summary.includes(issue.web_url)); assert.ok(summary.includes(issueDeliveryDigest(long)));
  assert.ok(summary.includes(long.description), 'the preview contains the complete body instead of authorizing a truncated summary');
  assert.notEqual(issueDeliveryDigest({ ...long, description: long.description + ' Changed tail.' }), issueDeliveryDigest(long), 'the full tail is fingerprinted');
  assert.throws(() => issueDeliverySnapshot({ ...issue, description: 'x'.repeat(128_001) }), /128 KB/);
});
async function fixture(t: test.TestContext, mrFix = false) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'codex-delivery-git-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repo = path.join(root, 'repo'), bare = path.join(root, 'remote.git'), runtime = path.join(root, 'runtime'); await mkdir(repo);
  git(repo, 'init', '-q', '--initial-branch=main'); git(repo, 'config', 'user.name', 'Delivery Test'); git(repo, 'config', 'user.email', 'delivery@test.invalid');
  await writeFile(path.join(repo, 'source.txt'), 'initial\n'); git(repo, 'add', '.'); git(repo, 'commit', '-qm', 'initial');
  const sha = git(repo, 'rev-parse', 'HEAD').trim();
  await cp(path.join(repo, '.git'), bare, { recursive: true }); git(bare, 'config', 'core.bare', 'true'); git(bare, 'config', 'http.receivepack', 'true');
  if (mrFix) git(bare, 'update-ref', 'refs/heads/feature', sha);
  const gitPushes: string[] = [];
  const server = createServer((request, response) => {
    const url = new URL(request.url!, 'http://localhost');
    if (request.method === 'POST' && url.pathname.endsWith('/git-receive-pack')) gitPushes.push(url.pathname);
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
  const mrs: GitLabMergeRequest[] = [], issueNotes: Array<{ id: number; body: string }> = [], writes: string[] = [], issueActivity: string[] = [];
  const issue: GitLabIssue = { id: 1, iid: 1, project_id: 1, title: 'Fix source', description: 'Keep the current interface and fix the source.',
    state: 'opened', web_url: 'https://gitlab.test/team/repo/-/issues/1', updated_at: '2026-11-13', labels: [], assignees: [], milestone: null,
    due_date: null, start_date: null, confidential: false, discussion_locked: false, issue_type: 'issue' };
  const client = new GitLabClient('https://gitlab.test', 'fixture-token', async (url, init) => {
    const pathname = new URL(String(url)).pathname, method = init?.method ?? 'GET', body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
    if (method !== 'GET') writes.push(pathname);
    if (method === 'GET' && pathname.endsWith('/issues/1')) return Response.json(issue);
    if (method === 'GET' && pathname.endsWith('/repository/branches/main')) return Response.json({ name: 'main', commit: { id: git(bare, 'rev-parse', 'main').trim() } });
    if (method === 'GET' && /\/projects\/[12]$/.test(pathname)) return Response.json({ id: record.spec.origin!.sourceProjectId ?? 1, path_with_namespace: 'team/repo', http_url_to_repo: remote });
    if (method === 'GET' && pathname.endsWith('/merge_requests/2')) {
      const head = git(bare, 'rev-parse', 'refs/heads/feature').trim();
      return Response.json({ id: 2, iid: 2, project_id: 1, source_project_id: record.spec.origin!.sourceProjectId ?? 1, state: 'opened', source_branch: 'feature', target_branch: 'main', sha: head, diff_refs: { head_sha: head } });
    }
    if (method === 'GET' && pathname.endsWith('/merge_requests')) return Response.json(mrs);
    if (method === 'GET' && pathname.endsWith('/discussions')) return Response.json(mrFix ? [discussion] : issueNotes.length ? [{ id: 'issue', notes: issueNotes }] : []);
    if (method === 'POST' && pathname.endsWith('/merge_requests')) {
      issue.updated_at = '2026-11-14T01:30:00.000Z'; issue.user_notes_count = (issue.user_notes_count ?? 0) + 1; issueActivity.push('merge-request-reference');
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
  const confirm = async () => {
    const target = await service.previewTarget(record, () => {});
    await confirmCodexDelivery(record, undefined, target?.sha, target?.issueDigest);
  };
  await confirm();
  let advances = 0;
  const advanceTarget = async () => {
    await writeFile(path.join(repo, 'target-change.txt'), `new target commit ${++advances}\n`); git(repo, 'add', '.'); git(repo, 'commit', '-qm', 'target advanced');
    const target = git(repo, 'rev-parse', 'HEAD').trim(); await cp(path.join(repo, '.git', 'objects'), path.join(bare, 'objects'), { recursive: true });
    git(bare, 'update-ref', 'refs/heads/main', target); return target;
  };
  return { record, repo, bare, root, worktree, remote, service, client, writes, mrs, issueNotes, discussion, advanceTarget, confirm, issue, gitPushes, issueActivity };
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

test('human verified documentation can be delivered without inventing a successful test command', async t => {
  const f = await fixture(t);
  await writeFile(path.join(f.worktree, 'source.txt'), 'initial\n');
  await writeFile(path.join(f.worktree, 'README.md'), '# Verified documentation\n');
  f.record.result = { state: 'ready', summary: 'Documentation reviewed by a human.', files: ['README.md'], tests: [] };
  const requirement = createRequirementSnapshot({ source: { kind: 'issue', identity: JSON.stringify([f.record.spec.origin!.baseUrl, f.record.spec.origin!.accountKey,
    f.record.spec.origin!.projectId, 'issue', f.record.spec.origin!.iid]) }, title: f.issue.title, description: f.issue.description ?? '' });
  f.record.spec.workContext = { schema: 'GitLabWorkspaceWorkContext/v1', requirement };
  const checks = ['The document matches the issue', 'Links and content were reviewed'];
  const profile = freezeVerificationProfile({ kind: 'manual', commands: [], manualChecks: checks, reason: '使用者逐項人工驗收純文件變更。' });
  const now = new Date().toISOString();
  f.record.validation = { cwd: f.worktree, artifactDigest: await implementationDigest(f.record.spec, ['README.md']), testedAt: now,
    requirementDigest: requirement.contentDigest, profileDigest: profile.digest, commands: [], manual: { confirmedAt: now, checks } };
  await f.confirm();
  const result = await f.service.deliver(f.record, async () => {}, () => {});
  assert.equal(result.state, 'published', f.record.delivery?.error ?? '');
  assert.equal(f.mrs.length, 1); assert.equal(f.record.validation.commands.length, 0);
  assert.equal(git(f.bare, 'show', `${f.record.delivery!.deliveredCommitSha}:README.md`), '# Verified documentation\n');
});

test('manual documentation evidence cannot bypass checks for a code change or a changed requirement', async t => {
  const f = await fixture(t);
  await writeFile(path.join(f.worktree, 'source.txt'), 'initial\n');
  await writeFile(path.join(f.worktree, 'service.ts'), 'export const changed = true;\n');
  f.record.result = { state: 'ready', summary: 'Manual review is not sufficient for code.', files: ['service.ts'] };
  const now = new Date().toISOString(), checks = ['Reviewed'];
  const profile = freezeVerificationProfile({ kind: 'manual', commands: [], manualChecks: checks, reason: '使用者逐項人工驗收純文件變更。' });
  f.record.validation = { cwd: f.worktree, artifactDigest: await implementationDigest(f.record.spec, ['service.ts']), testedAt: now,
    profileDigest: profile.digest, commands: [], manual: { confirmedAt: now, checks } };
  await f.confirm(); await f.service.deliver(f.record, async () => {}, () => {});
  assert.equal(f.record.delivery?.state, 'needs-attention'); assert.equal(f.gitPushes.length, 0); assert.equal(f.writes.length, 0);

  await rm(path.join(f.worktree, 'service.ts'));
  await writeFile(path.join(f.worktree, 'README.md'), '# Reviewed document\n');
  f.record.result.files = ['README.md'];
  f.record.validation.artifactDigest = await implementationDigest(f.record.spec, ['README.md']);
  const requirement = createRequirementSnapshot({ source: { kind: 'issue', identity: 'fixture' }, title: 'Changed requirement', description: 'New acceptance.' });
  f.record.spec.workContext = { schema: 'GitLabWorkspaceWorkContext/v1', requirement };
  f.record.validation.requirementDigest = 'a'.repeat(64);
  await f.confirm(); await f.service.deliver(f.record, async () => {}, () => {});
  assert.equal(f.gitPushes.length, 0); assert.equal(f.writes.length, 0);
});

test('fork MR delivery uses its verified source URL without adding or rewriting a Git remote', async t => {
  const f = await fixture(t, true), targetRemote = f.remote.replace('/remote.git', '/target.git');
  git(f.repo, 'remote', 'set-url', 'origin', targetRemote);
  f.record.spec.origin!.sourceProjectId = 2; f.record.spec.origin!.pushUrl = f.remote;
  await f.confirm();
  await f.service.deliver(f.record, async () => {}, () => {});
  assert.equal(f.record.delivery?.state, 'published', f.record.delivery?.error ?? '');
  assert.equal(git(f.repo, 'remote', 'get-url', 'origin').trim(), targetRemote);
  assert.equal(git(f.bare, 'rev-parse', 'feature').trim(), f.record.delivery!.deliveredCommitSha);
});

test('an advanced Issue target requires a fresh preview and confirmation before a Draft MR without rebasing', async t => {
  const f = await fixture(t), captured = f.record.spec.origin!.sourceSha, current = await f.advanceTarget();
  const preview = await f.service.previewTarget(f.record, () => {});
  const { issue, issueDigest, ...target } = preview!;
  assert.equal(issueDigest, issueDeliveryDigest(issue!));
  assert.deepEqual(target, { branch: 'main', baselineSha: captured, sha: current, advanced: true,
    compareUrl: `https://gitlab.test/team/repo/-/compare/${captured}...${current}` });
  await f.service.deliver(f.record, async () => {}, () => {});
  assert.equal(f.record.delivery?.state, 'needs-attention'); assert.match(f.record.delivery?.error ?? '', /目標分支已在預覽後變更/);
  assert.equal(f.writes.length, 0); assert.equal(git(f.worktree, 'rev-parse', 'HEAD').trim(), captured);
  await f.confirm();
  await f.service.deliver(f.record, async () => {}, () => {});
  assert.equal(f.record.delivery?.state, 'published', f.record.delivery?.error ?? '');
  assert.equal(f.record.spec.origin!.sourceSha, captured);
  assert.equal(git(f.worktree, 'rev-parse', 'HEAD^').trim(), captured, 'delivery must never silently rebase');
  assert.match(f.mrs[0].description ?? '', new RegExp(captured)); assert.match(f.mrs[0].description ?? '', new RegExp(current));
  assert.match(f.mrs[0].description ?? '', /目標分支已前進/);
  assert.ok(f.mrs[0].description?.includes(`[查看基準到目前目標的差異](https://gitlab.test/team/repo/-/compare/${captured}...${current})`));
});

test('the owning Bridge preview shows fresh target differences and refuses a target change while the human reads it', async t => {
  const f = await fixture(t), current = await f.advanceTarget(), storage = path.join(f.root, 'bridge-storage');
  const record = structuredClone(f.record); record.schema = 'GitLabWorkspaceCodexTask/v3';
  record.spec.skill = { name: 'bmad-build', path: path.join(f.root, 'SKILL.md') };
  const store = new CodexTaskStore(path.join(storage, 'codex-tasks')); await store.save(record);
  let deliveries = 0;
  const bridge = new CodexBridge({ storage, version: 'fixture', executable: () => '', trusted: () => true, event: () => {}, openUrl: async () => {}, prepare: async () => record.spec,
    previewDeliveryTarget: (record, check) => f.service.previewTarget(record, check), deliver: async () => { deliveries++; throw new Error('Unexpected delivery'); } });
  try {
    const preview = await bridge.previewDelivery(record.id);
    assert.equal(preview.target?.sha, current); assert.equal(preview.target?.baselineSha, record.spec.origin!.sourceSha);
    assert.equal(preview.target?.issueDigest, issueDeliveryDigest(issueDeliverySnapshot(f.issue)));
    assert.ok(preview.summary.includes(f.issue.title)); assert.ok(preview.summary.includes(f.issue.description!)); assert.match(preview.summary, /狀態：opened/); assert.match(preview.summary, /標籤：\[\]/);
    assert.ok(preview.summary.includes(current)); assert.ok(preview.summary.includes(record.spec.origin!.sourceSha));
    assert.ok(preview.summary.includes(preview.target!.compareUrl)); assert.match(preview.summary, /尚未驗證與目前目標整合/); assert.match(preview.summary, /不會自動 rebase/);
    assert.equal(f.writes.length, 0, 'preview is read-only');
    const confirmation = structuredClone((await store.load())[0].delivery!.confirmation);
    const title = f.issue.title; f.issue.title = 'A different human requirement';
    await assert.rejects(bridge.confirmDelivery(record.id, preview.digest), /來源 Issue 內容/);
    f.issue.title = title;
    await f.advanceTarget();
    await assert.rejects(bridge.confirmDelivery(record.id, preview.digest), /目標分支已在預覽後變更/);
    assert.deepEqual((await store.load())[0].delivery!.confirmation, confirmation, 'a stale preview cannot save a new authorization');
    assert.equal(deliveries, 0); assert.equal(f.writes.length, 0); assert.equal(git(f.worktree, 'rev-parse', 'HEAD').trim(), record.spec.origin!.sourceSha);
  } finally { await bridge.shutdown(); }
});

test('an Issue Bridge with no authoritative target reader cannot preview or confirm remote delivery', async t => {
  const f = await fixture(t), storage = path.join(f.root, 'bridge-storage'), record = structuredClone(f.record);
  record.schema = 'GitLabWorkspaceCodexTask/v3'; record.spec.skill = { name: 'bmad-build', path: path.join(f.root, 'SKILL.md') };
  await new CodexTaskStore(path.join(storage, 'codex-tasks')).save(record);
  const bridge = new CodexBridge({ storage, version: 'fixture', executable: () => '', trusted: () => true, event: () => {}, openUrl: async () => {}, prepare: async () => record.spec });
  try {
    await assert.rejects(bridge.previewDelivery(record.id), /目標分支版本預覽/);
    await assert.rejects(bridge.confirmDelivery(record.id, record.delivery!.confirmation!.digest), /目標分支版本預覽/);
    assert.equal(f.writes.length, 0);
  } finally { await bridge.shutdown(); }
});

test('a target that advances during publication checks blocks Push before creating any remote branch', async t => {
  const f = await fixture(t), original = f.client.getRepositoryBranch.bind(f.client); let reads = 0;
  t.mock.method(f.client, 'getRepositoryBranch', async (...args: Parameters<GitLabClient['getRepositoryBranch']>) => {
    if (++reads === 2) await f.advanceTarget();
    return original(...args);
  });
  await f.service.deliver(f.record, async () => {}, () => {});
  assert.equal(f.record.delivery?.state, 'needs-attention'); assert.match(f.record.delivery?.error ?? '', /目標分支已在預覽後變更/);
  assert.equal(f.writes.length, 0); assert.equal(f.mrs.length, 0);
  assert.equal(git(f.bare, 'show-ref', '--heads').includes(`refs/heads/${f.record.spec.origin!.branch}`), false);
  assert.equal(git(f.worktree, 'rev-parse', 'HEAD^').trim(), f.record.spec.origin!.sourceSha, 'the local Host commit retains the tested baseline');
});

test('a target advance during each sending checkpoint is blocked before the actual write and remains prepared', async t => {
  for (const kind of ['push', 'merge-request', 'issue-note'] as const) await t.test(kind, async t => {
    const f = await fixture(t); let advanced = false;
    await f.service.deliver(f.record, async state => {
      if (!advanced && state.steps.some(step => step.kind === kind && step.state === 'sending')) { advanced = true; await f.advanceTarget(); }
    }, () => {});
    assert.equal(advanced, true); assert.equal(f.record.delivery?.state, 'needs-attention');
    assert.match(f.record.delivery?.error ?? '', /目標分支已在預覽後變更/);
    assert.equal(f.record.delivery?.steps.find(step => step.kind === kind)?.state, 'prepared', 'the guard proves this write was not called');
    assert.equal(f.mrs.length, kind === 'issue-note' ? 1 : 0); assert.equal(f.issueNotes.length, 0);
    assert.equal(git(f.bare, 'show-ref', '--heads').includes(`refs/heads/${f.record.spec.origin!.branch}`), kind !== 'push');
    const writes = [...f.writes]; await f.service.reconcile(f.record, async () => {}, () => {});
    assert.deepEqual(f.writes, writes, 'read-only reconciliation does not send the prepared action');
    assert.equal(git(f.worktree, 'rev-parse', 'HEAD^').trim(), f.record.spec.origin!.sourceSha, 'target changes never rebase the task');
  });
});

test('a target change after a confirmed Push stops MR creation and resumes only after a fresh history and target confirmation', async t => {
  const f = await fixture(t); let advanced = false;
  await f.service.deliver(f.record, async state => {
    if (!advanced && state.steps.some(step => step.kind === 'push' && step.state === 'confirmed')) { advanced = true; await f.advanceTarget(); }
  }, () => {});
  const delivered = git(f.worktree, 'rev-parse', 'HEAD').trim();
  assert.equal(f.record.delivery?.state, 'needs-attention'); assert.match(f.record.delivery?.error ?? '', /目標分支已在預覽後變更/);
  assert.equal(git(f.bare, 'rev-parse', f.record.spec.origin!.branch!).trim(), delivered); assert.equal(f.writes.length, 0);
  await f.service.reconcile(f.record, async () => {}, () => {});
  assert.equal(f.writes.length, 0, 'reconciliation never sends the missing MR or summary');
  await f.confirm();
  await f.service.deliver(f.record, async () => {}, () => {});
  assert.equal(f.record.delivery?.state, 'published', f.record.delivery?.error ?? '');
  assert.equal(git(f.worktree, 'rev-parse', 'HEAD').trim(), delivered, 'reconfirmation cannot create a second empty commit or rewrite history');
  assert.equal(f.mrs.length, 1); assert.equal(f.issueNotes.length, 1);
});

test('GitLab commit-reference activity after confirmed Push preserves Issue approval and resumes without another Push', async t => {
  const f = await fixture(t), confirmation = structuredClone(f.record.delivery!.confirmation); let stopped = false;
  await f.service.deliver(f.record, async state => {
    if (!stopped && state.steps.some(step => step.kind === 'push' && step.state === 'confirmed')) {
      stopped = true; f.issue.updated_at = '2026-11-14T01:00:00.000Z'; f.issue.user_notes_count = 1; f.issue.references = { short: '#1', relative: '#1', full: 'team/repo#1' };
      f.issueActivity.push('commit-reference');
      throw new Error('checkpoint interrupted after confirmed Push');
    }
  }, () => {});
  assert.equal(f.record.delivery?.state, 'needs-attention'); assert.equal(f.gitPushes.length, 1); assert.equal(f.mrs.length, 0);
  await f.service.reconcile(f.record, async () => {}, () => {});
  await f.service.deliver(f.record, async () => {}, () => {});
  assert.equal(f.record.delivery?.state, 'published', f.record.delivery?.error ?? ''); assert.equal(f.gitPushes.length, 1, 'a confirmed Push is only read back');
  assert.deepEqual(f.record.delivery?.confirmation, confirmation); assert.equal(f.mrs.length, 1); assert.equal(f.issueNotes.length, 1);
  assert.deepEqual(f.issueActivity, ['commit-reference', 'merge-request-reference'], 'both GitLab references may advance updated_at without changing requirements');
});

test('Issue content changed before publication or during a sending checkpoint blocks the remaining writes', async t => {
  for (const stage of ['before-write', 'issue-note-checkpoint'] as const) await t.test(stage, async t => {
    const f = await fixture(t); let edited = false;
    if (stage === 'before-write') { f.issue.description = 'Different acceptance criteria'; edited = true; }
    await f.service.deliver(f.record, async state => {
      if (!edited && state.steps.some(step => step.kind === 'issue-note' && step.state === 'sending')) {
        edited = true; f.issue.labels = ['different-scope']; f.issue.updated_at = '2026-11-14T02:00:00.000Z';
      }
    }, () => {});
    assert.equal(edited, true); assert.equal(f.record.delivery?.state, 'needs-attention'); assert.match(f.record.delivery?.error ?? '', /來源 Issue 內容/);
    assert.equal(f.issueNotes.length, 0); assert.equal(f.mrs.length, stage === 'before-write' ? 0 : 1);
    if (stage === 'issue-note-checkpoint') assert.equal(f.record.delivery?.steps.find(step => step.kind === 'issue-note')?.state, 'prepared', 'a pending own note cannot bypass the content guard');
    const writes = [...f.writes]; await f.service.reconcile(f.record, async () => {}, () => {}); assert.deepEqual(f.writes, writes);
  });
});

test('a closed Issue cannot be previewed or written even when its old outcome and target are unchanged', async t => {
  const f = await fixture(t); f.issue.state = 'closed';
  await assert.rejects(f.service.previewTarget(f.record, () => {}), /來源 Issue 已關閉/);
  await f.service.deliver(f.record, async () => {}, () => {});
  assert.equal(f.record.delivery?.state, 'needs-attention'); assert.match(f.record.delivery?.error ?? '', /來源 Issue 已關閉/);
  assert.equal(f.writes.length, 0); assert.equal(f.gitPushes.length, 0); assert.equal(git(f.worktree, 'rev-parse', 'HEAD').trim(), f.record.spec.origin!.sourceSha);
});

test('legacy confirmations remain readable but cannot authorize an Issue write without a reviewed target', async t => {
  const f = await fixture(t);
  for (const missing of ['targetSha', 'issueDigest'] as const) {
    const record = structuredClone(f.record); delete record.delivery!.confirmation![missing];
    record.delivery!.confirmation!.digest = await deliveryConfirmationDigest(record);
    record.schema = 'GitLabWorkspaceCodexTask/v3'; record.spec.skill = { name: 'bmad-build', path: path.join(f.root, 'SKILL.md') };
    const store = new CodexTaskStore(path.join(f.root, 'legacy-storage-' + missing, 'codex-tasks')); await store.save(record);
    assert.equal((await store.load()).length, 1, 'old task schema is retained for recovery');
    await f.service.deliver(record, async () => {}, () => {});
    assert.equal(record.delivery?.state, 'needs-attention'); assert.match(record.delivery?.error ?? '', /人工確認/);
    assert.equal(f.writes.length, 0); assert.equal(git(f.worktree, 'rev-parse', 'HEAD').trim(), f.record.spec.origin!.sourceSha);
  }
});

test('complete confirmed Issue receipts can be sealed after the target advances without another remote write', async t => {
  const f = await fixture(t);
  await f.service.deliver(f.record, async () => {}, () => {});
  assert.equal(f.record.delivery?.state, 'published'); const writes = [...f.writes], delivered = f.record.delivery!.deliveredCommitSha;
  f.record.delivery!.state = 'needs-attention'; delete f.record.delivery!.confirmation!.targetSha; delete f.record.delivery!.confirmation!.issueDigest;
  f.record.delivery!.confirmation!.digest = await deliveryConfirmationDigest(f.record);
  await f.advanceTarget();
  await f.service.reconcile(f.record, async () => {}, () => {});
  const result = await f.service.deliver(f.record, async () => {}, () => {});
  assert.equal(result.state, 'published', f.record.delivery?.error ?? ''); assert.equal(f.record.delivery?.state, 'published');
  assert.deepEqual(f.writes, writes); assert.equal(f.mrs.length, 1); assert.equal(f.issueNotes.length, 1);
  assert.equal(git(f.worktree, 'rev-parse', 'HEAD').trim(), delivered);
  const unresolved = structuredClone(f.record); unresolved.delivery!.state = 'needs-attention';
  unresolved.delivery!.steps.push({ id: 'legacy-unknown', kind: 'upload', state: 'uncertain', key: 'a'.repeat(64) });
  await f.service.deliver(unresolved, async () => {}, () => {});
  assert.equal(unresolved.delivery?.state, 'needs-attention', 'an extra unknown receipt must still block completion'); assert.deepEqual(f.writes, writes);
});

test('delivery stages a complete inventory beyond 500 files without Windows path argument overflow', async t => {
  const f = await fixture(t), files = Array.from({ length: 520 }, (_, index) => `file-${index.toString().padStart(4, '0')}-${'x'.repeat(60)}.txt`);
  await Promise.all(files.map(file => writeFile(path.join(f.worktree, file), 'new source\n')));
  f.record.result!.files!.push(...files); f.record.validation!.artifactDigest = await implementationDigest(f.record.spec, f.record.result!.files!);
  await f.confirm();
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

test('delivery adopts multiple reviewed local commits without an extra commit', async t => {
  const f = await fixture(t);
  git(f.worktree, 'add', '.'); git(f.worktree, 'commit', '-qm', 'feat: first implementation (#1)');
  await writeFile(path.join(f.worktree, 'source.txt'), 'second implementation\n');
  git(f.worktree, 'add', '.'); git(f.worktree, 'commit', '-qm', 'fix: second implementation (#1)');
  const approved = git(f.worktree, 'rev-parse', 'HEAD').trim();
  f.record.validation!.artifactDigest = await implementationDigest(f.record.spec, f.record.result!.files!);
  await f.confirm();
  await f.service.deliver(f.record, async () => {}, () => {});
  assert.equal(f.record.delivery?.state, 'published', f.record.delivery?.error ?? '');
  assert.equal(git(f.worktree, 'rev-parse', 'HEAD').trim(), approved);
  assert.equal(git(f.bare, 'rev-parse', f.record.spec.origin!.branch!).trim(), approved);
  assert.equal(git(f.worktree, 'rev-list', '--count', `${f.record.spec.origin!.sourceSha}..HEAD`).trim(), '2');
});

test('saved automatic preferences cannot publish without this result confirmation', async t => {
  const f = await fixture(t); delete f.record.delivery!.confirmation;
  await f.service.deliver(f.record, async () => {}, () => {});
  assert.equal(f.record.delivery?.state, 'needs-attention'); assert.match(f.record.delivery?.error ?? '', /人工確認/);
  assert.equal(f.writes.length, 0); assert.equal(f.mrs.length, 0);
  assert.equal(git(f.worktree, 'rev-parse', 'HEAD').trim(), f.record.spec.origin!.sourceSha);
});

test('a same-tree history rewrite during publication metadata checks blocks push and MR creation', async t => {
  const f = await fixture(t);
  git(f.worktree, 'add', '.'); git(f.worktree, 'commit', '-qm', 'feat: reviewed implementation (#1)');
  await f.confirm();
  const original = f.client.getRepositoryBranch.bind(f.client); let reads = 0;
  t.mock.method(f.client, 'getRepositoryBranch', async (...args: Parameters<GitLabClient['getRepositoryBranch']>) => {
    const result = await original(...args);
    if (++reads === 2) git(f.worktree, 'commit', '--amend', '-qm', 'feat: unreviewed rewritten history (#1)');
    return result;
  });
  await f.service.deliver(f.record, async () => {}, () => {});
  assert.equal(f.record.delivery?.state, 'needs-attention'); assert.match(f.record.delivery?.error ?? '', /重新檢閱/);
  assert.equal(f.writes.length, 0);
  assert.equal(git(f.bare, 'show-ref', '--heads').includes(`refs/heads/${f.record.spec.origin!.branch}`), false);
});

test('Draft MR metadata neutralizes quick actions embedded in test evidence', async t => {
  const f = await fixture(t);
  f.record.validation!.commands[0].command = 'node --test\n/close\n/assign @someone';
  await f.confirm();
  await f.service.deliver(f.record, async () => {}, () => {});
  assert.equal(f.record.delivery?.state, 'published', f.record.delivery?.error ?? '');
  assert.match(f.mrs[0].description ?? '', /\n\\\/close\n\\\/assign @someone/);
});
