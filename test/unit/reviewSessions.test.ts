import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, realpath, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { readReviewSessions, readReviewJob, cancelReviewSession, reviewSessionScript, invalidateReviewSync, withReviewSyncInvalidation, sharedReviewCacheRoot, sharedReviewCacheV2Root, resolveReviewRuntime, defaultReviewRuntime, invalidateReviewAuth } from '../../src/workspace/reviewSessions';
import { workspaceActionKinds, describeAction } from '../../src/workspace/actionPolicy';
import { reviewSessionActions } from '../../src/workspace/reviewSessionProtocol';

async function fixture(t: test.TestContext) {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'review-jobs-'));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const base = await realpath(temp), root = path.join(base, '.review-runtime'), repo = path.join(base, 'service');
  await mkdir(path.join(root, 'jobs'), { recursive: true });
  await mkdir(repo);
  await writeFile(path.join(root, '.merge-reviewer-runtime.json'), JSON.stringify({ schema: 'MergeReviewRuntime/v1', directory: root }));
  const id = 'a'.repeat(32);
  const job = { schema: 'MergeReviewSession/v1', request_id: id, runtime_root: root, state: 'reviewing', phase: 'review',
    updated_at: '2026-10-22T00:00:00Z', inputs: { workspace: base, project: repo, base: 'origin/main', head: 'origin/topic' },
    network_activity: { fetch_attempt_count: 0 }, pack_cache_hits: 2 };
  const save = async (value: unknown, identifier = id) => writeFile(path.join(root, 'jobs', identifier + '.json'), JSON.stringify(value));
  await save(job);
  return { base, root, repo, id, job, save };
}

test('persisted operation progress and checked semantic counts stay separate, and unknown counts are not zero', async t => {
  const f = await fixture(t);
  await f.save({ ...f.job, progress: { phase: 'operation-complete', completed: 2, total: 2, operation_id: null, at: '2026-11-10T00:00:00Z' },
    remaining_counts: { changes: 1, repositories: 3, boundaries: 2, impacts: -1 }, last_check_at: '2026-11-10T00:01:00Z' });
  let row = (await readReviewSessions(f.root, f.base, [f.repo]))[0];
  assert.deepEqual(row.progress, { completed: 2, total: 2, updatedAt: '2026-11-10T00:00:00Z' });
  assert.deepEqual(row.remaining, { changes: 1, boundaries: 2, repositories: 3 });
  assert.equal(row.lastCheckAt, '2026-11-10T00:01:00Z'); assert.equal(row.reviewOutcome, undefined);
  await f.save({ ...f.job, state: 'validating', phase: 'validation', progress: {
    stage: 'validation', activity: 'search-prefetch', completed: 20, total: 163,
    at: '2026-11-11T00:00:00Z', validation: {
      repositories: { completed: 16, total: 16 }, contracts: { completed: 4, total: 4 },
      searches: { completed: 0, total: 143 }, ignored: { completed: 1, total: 1 },
    },
  } });
  row = (await readReviewSessions(f.root, f.base, [f.repo]))[0];
  assert.deepEqual(row.progress, {
    completed: 20, total: 163, updatedAt: '2026-11-11T00:00:00Z', stage: 'validation', activity: 'search-prefetch',
    validation: { repositories: { completed: 16, total: 16 }, contracts: { completed: 4, total: 4 }, searches: { completed: 0, total: 143 } },
  });
  await f.save({ ...f.job, state: 'validating', phase: 'validation', progress: {
    stage: 'evidence-recheck', activity: 'searches', completed: 30, total: 30,
    validation: { repositories: { completed: 16, total: 16 }, contracts: { completed: 4, total: 4 }, searches: { completed: 143, total: 143 } },
  } });
  row = (await readReviewSessions(f.root, f.base, [f.repo]))[0];
  assert.equal(row.progress?.stage, 'evidence-recheck');
  assert.equal(row.progress?.activity, 'searches');
  assert.equal(row.progress?.validation?.searches?.completed, 143);
  await f.save({ ...f.job, state: 'failed', phase: 'terminal', context_retained: true, recoverable: false, next_action: 'inspect-render-error' });
  row = (await readReviewSessions(f.root, f.base, [f.repo]))[0];
  assert.equal(row.progress, undefined); assert.equal(row.remaining, undefined);
  assert.deepEqual(row.recovery, { recoverable: false, terminal: true, nextAction: 'inspect-render-error' });
  assert.deepEqual(reviewSessionActions(row), { resume: false, cancel: true, report: false, refresh: true });
});

test('UI and Host action policy permits recovery and cleanup but never resumes terminal or already published work', () => {
  for (const state of ['running', 'ready', 'reviewing', 'validating']) assert.equal(reviewSessionActions({ state }).resume, true);
  for (const state of ['failed', 'cancelled', 'published']) {
    assert.equal(reviewSessionActions({ state }).resume, false); assert.equal(reviewSessionActions({ state }).cancel, false);
  }
  assert.equal(reviewSessionActions({ state: 'published', cleanupPending: true }).resume, true);
  assert.equal(reviewSessionActions({ state: 'failed', cleanupPending: true }).resume, false);
  assert.equal(reviewSessionActions({ state: 'reviewing', recovery: { terminal: true, recoverable: false } }).resume, false);
});

test('local budget projection distinguishes wrap-up, one extension and incomplete publication without renewing elapsed time', async t => {
  const f = await fixture(t);
  const started = Date.now() / 1000 - 200;
  const budget = { schema: 'ReviewBudget/v1', id: 'b'.repeat(32), profile: 'balanced',
    started_at_epoch: started, started_monotonic: 100, base_seconds: 180, repo_count: 1 };
  await f.save({ ...f.job, budget });
  let row = (await readReviewSessions(f.root, f.base, [f.repo]))[0];
  assert.equal(row.budget?.phase, 'wrap-up');
  assert.equal(row.budget?.limitSeconds, 180);
  const extension = { budget_id: budget.id, update_id: 'evidence-backed', additional_seconds: 90 };
  // An extension-only semantic update can leave the previous step's phase behind.
  await f.save({ ...f.job, phase: 'wrap-up', budget: { ...budget, extension } });
  row = (await readReviewSessions(f.root, f.base, [f.repo]))[0];
  assert.equal(row.budget?.phase, 'extended-investigation');
  assert.equal(row.budget?.limitSeconds, 270);
  assert.equal(row.budget?.extensionUsed, true);
  await f.save({ ...f.job, phase: 'wrap-up', budget: { ...budget, started_at_epoch: started - 100, extension } });
  row = (await readReviewSessions(f.root, f.base, [f.repo]))[0];
  assert.equal(row.budget?.phase, 'wrap-up');
  assert.equal(row.budget?.remainingSeconds, 0);
  const finished = started + 220;
  const outcome = { schema: 'MergeReviewOutcome/v1', outcome_available: true, review_complete: false,
    review_status: '審查未完成', gaps: ['因時間預算未完成必要 caller。'] };
  await f.save({ ...f.job, state: 'published', phase: 'complete', finished_at_epoch: finished,
    review_outcome: outcome, budget: { ...budget, extension } });
  row = (await readReviewSessions(f.root, f.base, [f.repo]))[0];
  assert.equal(row.budget?.phase, 'incomplete');
  assert.equal(row.budget?.elapsedSeconds, 220);
  assert.equal((await readReviewSessions(f.root, f.base, [f.repo]))[0].budget?.elapsedSeconds, 220);
  assert.equal(row.reviewOutcome?.reviewComplete, false);
  assert.equal(row.fetchCount, 0);
  await f.save(f.job);
  assert.equal((await readReviewSessions(f.root, f.base, [f.repo]))[0].budget, undefined);
});

test('local review status validates workspace ownership and filters foreign or malformed jobs', async t => {
  const f = await fixture(t), before = await readdir(f.root);
  await f.save({ ...f.job, request_id: 'b'.repeat(32), inputs: { ...f.job.inputs, workspace: path.dirname(f.base) } }, 'b'.repeat(32));
  await f.save({ ...f.job, request_id: 'c'.repeat(32), report_path: path.join(f.base, 'foreign.md') }, 'c'.repeat(32));
  await writeFile(path.join(f.root, 'jobs', 'd'.repeat(32) + '.json'), 'broken');
  const rows = await readReviewSessions(f.root, f.base, [f.repo]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].requestId, f.id);
  assert.equal(rows[0].tool, 'merge-reviewer');
  assert.equal(rows[0].fetchCount, 0);
  assert.equal(rows[0].packCacheHits, 2);
  assert.deepEqual(await readdir(f.root), before); // A read creates no runtime or lock.
  await assert.rejects(readReviewJob(f.root, '../elsewhere', f.base, [f.repo]));
  await assert.rejects(readReviewJob(f.root, f.id, f.base, [path.dirname(f.repo)]));
  assert.deepEqual(await readReviewSessions(path.join(f.base, 'absent'), f.base, [f.repo]), []);
});

test('v2 invalidation works before a workspace has any review jobs', async t => {
  const f = await fixture(t), previous = process.env.REVIEW_SHARED_CACHE_DIR;
  const shared = path.join(f.base, 'reviewer-cache-v2');
  process.env.REVIEW_SHARED_CACHE_DIR = shared;
  t.after(() => { if (previous === undefined) delete process.env.REVIEW_SHARED_CACHE_DIR; else process.env.REVIEW_SHARED_CACHE_DIR = previous; });
  await mkdir(shared);
  await writeFile(path.join(shared, '.review-shared-cache.json'), JSON.stringify({ schema: 'ReviewerSharedCache/v2', directory: shared }));
  assert.equal(sharedReviewCacheV2Root(), shared);
  const absent = path.join(f.base, 'never-started'), common = path.join(f.repo, '.git');
  await invalidateReviewSync(absent, common);
  const key = createHash('sha256').update(JSON.stringify(path.resolve(common))).digest('hex');
  assert.equal(JSON.parse(await readFile(path.join(shared, 'invalidations', key + '.json'), 'utf8')).schema, 'ReviewerSharedInvalidation/v1');
  assert.equal(await invalidateReviewAuth([]), 1);
  await assert.rejects(readdir(absent));
});

test('legacy jobs resume in place and new status separates fixed SHA, capture and sync times', async t => {
  const f = await fixture(t), preferred = defaultReviewRuntime(f.base, 'merge-reviewer');
  await f.save({ ...f.job, fixed_identity: { base_sha: '1'.repeat(40), head_sha: '2'.repeat(40), capture_completed_at: '2026-10-25T00:00:01Z' },
    sync_activity: [{ mode: 'cached', synced_at: 1792886400 }] });
  assert.equal(await resolveReviewRuntime(preferred, f.id, f.base, [f.repo], 'merge-reviewer'), f.root);
  const rows = await readReviewSessions(f.root, f.base, [f.repo]);
  assert.equal(rows[0].baseSha, '1'.repeat(40));
  assert.equal(rows[0].headSha, '2'.repeat(40));
  assert.equal(rows[0].capturedAt, '2026-10-25T00:00:01Z');
  assert.equal(rows[0].syncObservations?.[0].mode, 'cached');
  assert.equal(rows[0].fetchCount, 0);
  await assert.rejects(readdir(preferred));
});

test('known Git writes invalidate only the requested common directory; status stays unchanged', async t => {
  const f = await fixture(t), common = path.join(f.repo, '.git');
  await invalidateReviewSync(f.root, common);
  const key = createHash('sha256').update(JSON.stringify(path.resolve(common))).digest('hex');
  const marker = JSON.parse(await readFile(path.join(f.root, 'invalidations', key + '.json'), 'utf8'));
  assert.equal(marker.schema, 'MergeReviewInvalidation/v1');
  assert.equal((await readReviewJob(f.root, f.id, f.base, [f.repo])).state, 'reviewing');
  await invalidateReviewSync(path.join(f.base, 'absent'), common);
  await assert.rejects(readdir(path.join(f.base, 'absent')));
});

test('a receipt made while a Git write is waiting is invalidated again after completion or failure', async t => {
  const f = await fixture(t), common = path.join(f.repo, '.git');
  const key = createHash('sha256').update(JSON.stringify(path.resolve(common))).digest('hex');
  const marker = path.join(f.root, 'invalidations', key + '.json');
  let during = '';
  const value = await withReviewSyncInvalidation([f.root], common, async () => {
    during = await readFile(marker, 'utf8');
    return 'Git completed';
  });
  assert.equal(value, 'Git completed');
  assert.notEqual(await readFile(marker, 'utf8'), during);
  await assert.rejects(withReviewSyncInvalidation([f.root], common, async () => {
    during = await readFile(marker, 'utf8');
    throw new Error('uncertain transport result');
  }), /uncertain transport result/);
  assert.notEqual(await readFile(marker, 'utf8'), during);
});

test('both reviewer runtimes invalidate the same owned shared cache and preserve legacy epochs', async t => {
  const f = await fixture(t), release = path.join(f.base, '.release-review-runtime'), shared = path.join(f.base, '.review-shared-cache');
  const previous = process.env.REVIEW_SHARED_CACHE_DIR;
  delete process.env.REVIEW_SHARED_CACHE_DIR;
  t.after(() => { if (previous === undefined) delete process.env.REVIEW_SHARED_CACHE_DIR; else process.env.REVIEW_SHARED_CACHE_DIR = previous; });
  await mkdir(release);
  await writeFile(path.join(release, '.release-reviewer-runtime.json'), JSON.stringify({ schema: 'ReleaseReviewRuntime/v1', directory: release }));
  await mkdir(shared);
  await writeFile(path.join(shared, '.review-shared-cache.json'), JSON.stringify({ schema: 'ReviewerSharedCache/v1', directory: shared }));
  assert.equal(await sharedReviewCacheRoot(f.root), shared);
  assert.equal(await sharedReviewCacheRoot(release), shared);
  const common = path.join(f.repo, '.git'), key = createHash('sha256').update(JSON.stringify(path.resolve(common))).digest('hex');
  const sharedMarker = path.join(shared, 'invalidations', key + '.json');
  await invalidateReviewSync(f.root, common);
  const first = await readFile(sharedMarker, 'utf8');
  await invalidateReviewSync(release, common);
  assert.notEqual(await readFile(sharedMarker, 'utf8'), first);
  assert.equal(JSON.parse(await readFile(sharedMarker, 'utf8')).schema, 'ReviewerSharedInvalidation/v1');
  assert.equal(JSON.parse(await readFile(path.join(release, 'invalidations', key + '.json'), 'utf8')).schema, 'MergeReviewInvalidation/v1');
  await writeFile(path.join(shared, '.review-shared-cache.json'), JSON.stringify({ schema: 'ReviewerSharedCache/v1', directory: path.dirname(shared) }));
  await assert.rejects(invalidateReviewSync(f.root, common), /共享快取所有權/);
});

test('status refuses linked runtime and linked jobs instead of traversing them', async t => {
  const f = await fixture(t), alias = path.join(f.base, 'alias');
  await symlink(f.root, alias, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(readReviewSessions(alias, f.base, [f.repo]), /Junction/);
});

test('review controls have local per-request resources and never require remote refresh', () => {
  assert.equal(workspaceActionKinds.loadReviewSessions, 'read');
  assert.equal(workspaceActionKinds.openReviewReport, 'local');
  const request = { type: 'cancelReviewSession', tool: 'merge-reviewer', revision: 'r', requestId: 'a'.repeat(32) };
  const first = describeAction(request, { rootKey: 'local' });
  const otherRequest = { ...request, requestId: 'b'.repeat(32) };
  const second = describeAction(otherRequest, { rootKey: 'local' });
  assert.notEqual(first.lockKey, second.lockKey);
  assert.match(first.resourceKey, /review/);
  const releaseRequest = { ...request, tool: 'release-reviewer' };
  assert.notEqual(first.lockKey, describeAction(releaseRequest, { rootKey: 'local' }).lockKey);
  assert.equal(workspaceActionKinds.copyReviewResume, 'write');
});

test('Release sessions require their own marker and schema even with an identical request ID', async t => {
  const f = await fixture(t), release = path.join(f.base, '.release-review-runtime');
  await mkdir(path.join(release, 'jobs'), { recursive: true });
  await writeFile(path.join(release, '.release-reviewer-runtime.json'), JSON.stringify({ schema: 'ReleaseReviewRuntime/v1', directory: release }));
  const job = { ...f.job, schema: 'ReleaseReviewSession/v1', runtime_root: release, cleanup_pending: true };
  await writeFile(path.join(release, 'jobs', f.id + '.json'), JSON.stringify(job));
  const rows = await readReviewSessions(release, f.base, [f.repo], 'release-reviewer');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].tool, 'release-reviewer');
  assert.equal(rows[0].cleanupPending, true);
  assert.deepEqual(await readReviewSessions(release, f.base, [f.repo], 'merge-reviewer'), []);
  await assert.rejects(readReviewJob(f.root, f.id, f.base, [f.repo], 'release-reviewer'));
  await writeFile(path.join(release, 'jobs', f.id + '.json'), JSON.stringify({ ...job, schema: f.job.schema }));
  assert.deepEqual(await readReviewSessions(release, f.base, [f.repo], 'release-reviewer'), []);
  await assert.rejects(readReviewSessions(release, f.base, [f.repo], '../../custom' as any), /審查工具/);
  assert.throws(() => reviewSessionScript(f.base, '../../custom' as any), /審查工具/);
});

test('cancel routes only the selected validated job to its installed helper', async t => {
  const f = await fixture(t), root = path.join(f.base, '.release-review-runtime');
  await mkdir(path.join(root, 'jobs'), { recursive: true });
  await writeFile(path.join(root, '.release-reviewer-runtime.json'), JSON.stringify({ schema: 'ReleaseReviewRuntime/v1', directory: root }));
  await writeFile(path.join(root, 'jobs', f.id + '.json'), JSON.stringify({ ...f.job, schema: 'ReleaseReviewSession/v1', runtime_root: root }));
  const skills = path.join(f.base, '.agents', 'skills');
  const script = reviewSessionScript(skills, 'release-reviewer'), capture = path.join(f.base, 'invocation.json');
  await mkdir(path.dirname(script), { recursive: true });
  await writeFile(script, '# installed helper');
  const python = { executable: process.execPath, version: 'test transport', args: ['-e',
    'require("node:fs").writeFileSync(process.env.REVIEW_TEST_CAPTURE, JSON.stringify(process.argv.slice(1)))', '--'],
    env: { ...process.env, REVIEW_TEST_CAPTURE: capture } };
  await cancelReviewSession(root, f.id, f.base, [f.repo], python, skills, 'release-reviewer');
  assert.deepEqual(JSON.parse(await readFile(capture, 'utf8')), ['-B', script, 'cancel', '--runtime-root', root, '--request-id', f.id]);
  await assert.rejects(cancelReviewSession(root, f.id, f.base, [f.repo], python, skills, 'merge-reviewer'));
});

test('published local status projects only persisted reviewer outcomes and leaves legacy or malformed summaries unknown', async t => {
  const f = await fixture(t);
  for (const [tool, runtimeSchema, jobSchema, outcomeSchema] of [
    ['merge-reviewer', 'MergeReviewRuntime/v1', 'MergeReviewSession/v1', 'MergeReviewOutcome/v1'],
    ['release-reviewer', 'ReleaseReviewRuntime/v1', 'ReleaseReviewSession/v1', 'ReleaseReviewOutcome/v1'],
  ] as const) {
    const root = path.join(f.base, tool);
    await mkdir(path.join(root, 'jobs'), { recursive: true });
    await writeFile(path.join(root, `.${tool}-runtime.json`), JSON.stringify({ schema: runtimeSchema, directory: root }));
    const save = async (outcome?: unknown, receiptOutcome?: unknown) => writeFile(path.join(root, 'jobs', f.id + '.json'), JSON.stringify({
      ...f.job, schema: jobSchema, runtime_root: root, state: 'published', phase: 'complete', cleanup_pending: true,
      report_path: path.join(f.repo, 'review-reports', 'not-read.md'), review_outcome: outcome,
      report_receipt: receiptOutcome === undefined ? undefined : { review_outcome: receiptOutcome },
    }));
    const read = async () => (await readReviewSessions(root, f.base, [f.repo], tool))[0];
    await save({ schema: outcomeSchema, outcome_available: true, review_complete: false, review_status: 'incomplete', gaps: ['Caller review remains open.'] });
    assert.deepEqual((await read()).reviewOutcome, {
      reviewComplete: false, reviewStatus: 'incomplete', gaps: ['Caller review remains open.'],
    });
    assert.equal((await read()).cleanupPending, true);
    await save({ schema: outcomeSchema, outcome_available: true, review_complete: true, review_status: 'complete', gaps: [] });
    assert.equal((await read()).reviewOutcome?.reviewComplete, true);
    const recorded = { schema: outcomeSchema, outcome_available: true, review_complete: false, review_status: 'incomplete', gaps: ['Saved staged outcome.'] };
    await save(undefined, recorded);
    assert.equal((await read()).reviewOutcome?.reviewComplete, false);
    assert.deepEqual((await read()).reviewOutcome?.gaps, recorded.gaps);
    await save({ ...recorded, review_complete: true }, recorded);
    assert.equal((await read()).reviewOutcome?.reviewComplete, null, 'Conflicting job and staged receipt cannot prove completeness');
    for (const invalid of [undefined, null, { schema: outcomeSchema, outcome_available: true, review_complete: 'true', review_status: 'complete', gaps: [] },
      { schema: outcomeSchema, outcome_available: true, review_complete: true, review_status: 'complete', gaps: [1] },
      { schema: outcomeSchema, outcome_available: false, review_complete: true, review_status: 'complete', gaps: [] },
      { schema: 'ForeignReviewOutcome/v1', outcome_available: true, review_complete: true, review_status: 'complete', gaps: [] }]) {
      await save(invalid);
      const summary = (await read()).reviewOutcome;
      assert.equal(summary?.reviewComplete, null);
      assert.equal(summary?.reviewStatus, 'unknown');
      assert.match(summary?.gaps[0] ?? '', /無法確認初次審查完整性/);
    }
  }
});
