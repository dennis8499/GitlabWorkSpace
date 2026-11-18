import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, realpath, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readReviewSessions, readReviewJob, readVerifiedReviewPublication, cancelReviewSession, reviewSessionScript, invalidateReviewSync, withReviewSyncInvalidation, sharedReviewCacheRoot, sharedReviewCacheV2Root, resolveReviewRuntime, defaultReviewRuntime, invalidateReviewAuth } from '../../src/workspace/reviewSessions';
import { workspaceActionKinds, describeAction } from '../../src/workspace/actionPolicy';
import { reviewSessionActions } from '../../src/workspace/reviewSessionProtocol';
import { reviewRunnerRuntime, reviewRunnerWritableRoots } from '../../src/workspace/reviewLaunch';

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

async function legacyMergeFixture(t: test.TestContext, baseSha = '1'.repeat(40), headSha = '2'.repeat(40)) {
  const f = await fixture(t), context = path.join(f.root, 'sessions', f.id), report = path.join(f.repo, 'review-reports', 'old-name-unrelated-to-ref.md');
  await mkdir(path.dirname(report));
  const table = ['### 固定版本', '', '| Repo | 角色 | 來源 | 完整 SHA |', '| --- | --- | --- | --- |',
    `| supporting | candidate | base | \`${'c'.repeat(40)}\` |`, `| supporting | candidate | head | \`${'d'.repeat(40)}\` |`,
    `| ${path.basename(f.repo)} | seed | head | \`${headSha}\` |`, `| ${path.basename(f.repo)} | seed | base | \`${baseSha}\` |`,
    `| ${path.basename(f.repo)} | seed | merge-preview | \`${'e'.repeat(40)}\` |`].join('\n');
  const body = `# Native Merge report\n\n- 本機路徑：\`${f.repo}\`\n\n<!-- merge-confirmations:start -->\nHuman notes\n<!-- merge-confirmations:end -->\n\n${table}\n`;
  const job: any = { ...f.job, state: 'published', phase: 'complete', context_dir: context, selected_repo: 'repo-000', report_path: report,
    review_outcome: { schema: 'MergeReviewOutcome/v1', outcome_available: true, review_complete: true, review_status: 'complete', gaps: [] } };
  const publish = async (content = body, fullReportHash = false) => {
    await writeFile(report, content);
    job.report_sha256 = createHash('sha256').update(content).digest('hex');
    const fixed = content.replace(/<!-- merge-confirmations:start -->[\s\S]*?<!-- merge-confirmations:end -->/,
      '<!-- merge-confirmations:start -->\n<editable-human-confirmations>\n<!-- merge-confirmations:end -->');
    job.report_receipt = fullReportHash ? undefined : { policy: 'merge-report-static-body/v1', static_body_sha256: createHash('sha256').update(fixed).digest('hex'), review_outcome: job.review_outcome };
    await f.save(job);
  };
  const manifest: any = { schema: 'merge-reviewer-workspace-context/v3', request_id: f.id, runtime_root: f.root, context_dir: context, workspace: f.base,
    selected_repo: 'repo-000', capture_completed_at: '2026-11-14T00:00:00Z', repositories: [{ id: 'repo-000', role: 'seed', state: 'captured', path: f.repo,
      native: { base_input: f.job.inputs.base, head_input: f.job.inputs.head, base_sha: baseSha, head_sha: headSha }, sources: { base: { ref: baseSha }, head: { ref: headSha } } }] };
  const owner = { schema: 'merge-reviewer-session/v2', directory: context, runtime: f.root, request_id: f.id, token: 'a'.repeat(32) };
  const capture = async () => {
    await mkdir(context, { recursive: true }); await writeFile(path.join(context, '.merge-reviewer-owned.json'), JSON.stringify(owner));
    const bytes = JSON.stringify(manifest); await writeFile(path.join(context, 'manifest.json'), bytes);
    job.evidence_receipt = { schema: 'MergeReviewEvidenceReceipt/v1', manifest_sha256: createHash('sha256').update(bytes).digest('hex') }; await f.save(job);
  };
  await publish();
  return { ...f, context, report, table, body, job, manifest, owner, publish, capture, read: async () => (await readReviewSessions(f.root, f.base, [f.repo]))[0] };
}

test('a published Merge v1 without fixed_identity retains its full selected SHA pair after native context cleanup', async t => {
  const f = await legacyMergeFixture(t), before = await readFile(path.join(f.root, 'jobs', f.id + '.json'));
  let row = await f.read();
  assert.equal(row.baseSha, '1'.repeat(40)); assert.equal(row.headSha, '2'.repeat(40)); assert.equal(row.reviewOutcome?.reviewComplete, true);
  assert.equal((await readReviewJob(f.root, f.id, f.base, [f.repo])).fixed_identity, undefined, 'Reading must not synthesize fields that a caller could write back to the native job');
  assert.deepEqual(await readFile(path.join(f.root, 'jobs', f.id + '.json')), before); await assert.rejects(readdir(f.context), { code: 'ENOENT' });
  await f.publish(f.body, true); row = await f.read(); assert.equal(row.baseSha, '1'.repeat(40)); assert.equal(row.headSha, '2'.repeat(40), 'Legacy full-report hash policy remains supported');
});

test('retained Merge context identity requires its owner, manifest receipt, selected Repo and matching fixed inputs', async t => {
  const valid = await legacyMergeFixture(t); valid.job.state = 'reviewing'; await valid.capture();
  assert.equal((await valid.read()).baseSha, '1'.repeat(40)); assert.equal((await valid.read()).capturedAt, '2026-11-14T00:00:00Z');
  for (const scenario of ['hash', 'owner', 'schema', 'request', 'runtime', 'workspace', 'project', 'selected', 'duplicate', 'native-ref', 'input-ref', 'missing-manifest']) await t.test(scenario, async child => {
    const f = await legacyMergeFixture(child); await f.capture(); // A valid report cannot hide conflicting retained evidence.
    if (scenario === 'hash') { await writeFile(path.join(f.context, 'manifest.json'), JSON.stringify({ ...f.manifest, capture_completed_at: 'changed' })); }
    else if (scenario === 'missing-manifest') await rm(path.join(f.context, 'manifest.json'));
    else {
      if (scenario === 'owner') f.owner.request_id = 'b'.repeat(32);
      if (scenario === 'schema') f.manifest.schema = 'foreign/v1';
      if (scenario === 'request') f.manifest.request_id = 'b'.repeat(32);
      if (scenario === 'runtime') f.manifest.runtime_root = f.base;
      if (scenario === 'workspace') f.manifest.workspace = f.repo;
      if (scenario === 'project') f.manifest.repositories[0].path = f.base;
      if (scenario === 'selected') f.manifest.selected_repo = 'repo-other';
      if (scenario === 'duplicate') f.manifest.repositories.push(structuredClone(f.manifest.repositories[0]));
      if (scenario === 'native-ref') f.manifest.repositories[0].sources.head.ref = '3'.repeat(40);
      if (scenario === 'input-ref') f.manifest.repositories[0].native.base_input = 'other-branch';
      await f.capture();
    }
    assert.equal((await f.read()).baseSha, undefined); assert.equal((await f.read()).headSha, undefined);
  });
});

test('legacy published identity rejects invalid receipts, ambiguous tables, foreign Repos and conflicting fixed metadata', async t => {
  for (const scenario of ['changed-body', 'bad-policy', 'partial-fixed', 'conflicting-fixed', 'duplicate-table', 'duplicate-base', 'foreign-seed', 'short-sha', 'wrong-location', 'editable-only']) await t.test(scenario, async child => {
    const f = await legacyMergeFixture(child);
    if (scenario === 'changed-body') await writeFile(f.report, f.body.replace('1'.repeat(40), '3'.repeat(40)));
    else if (scenario === 'bad-policy') { f.job.report_receipt.policy = 'foreign/v1'; await f.save(f.job); }
    else if (scenario === 'partial-fixed') { f.job.fixed_identity = { base_sha: '1'.repeat(40) }; await f.save(f.job); }
    else if (scenario === 'conflicting-fixed') { f.job.fixed_identity = { base_sha: '3'.repeat(40), head_sha: '2'.repeat(40) }; await f.save(f.job); }
    else {
      let body = f.body;
      if (scenario === 'duplicate-table') body += '\n' + f.table;
      if (scenario === 'duplicate-base') body += `| ${path.basename(f.repo)} | seed | base | \`${'1'.repeat(40)}\` |\n`;
      if (scenario === 'foreign-seed') body = body.replace(`| ${path.basename(f.repo)} | seed | base`, '| another-repo | seed | base');
      if (scenario === 'short-sha') body = body.replace('1'.repeat(40), '1'.repeat(8));
      if (scenario === 'wrong-location') body = body.replace(`\`${f.repo}\``, `\`${f.base}\``);
      if (scenario === 'editable-only') body = body.replace(f.table, '').replace('Human notes', f.table);
      await f.publish(body);
    }
    assert.equal((await f.read()).baseSha, undefined); assert.equal((await f.read()).headSha, undefined);
  });
});

test('fixed metadata supports older verified renderers while editable notes cannot inject or replace identity', async t => {
  const f = await legacyMergeFixture(t);
  await writeFile(f.report, f.body.replace('Human notes', f.table.replace(/1{40}/g, '3'.repeat(40))));
  assert.equal((await f.read()).baseSha, '1'.repeat(40), 'A fake table in the mutable human region is ignored');
  f.job.fixed_identity = { base_sha: '1'.repeat(40), head_sha: '2'.repeat(40) };
  await f.publish('# Older receipt-valid native report without a version table\n');
  assert.equal((await f.read()).baseSha, '1'.repeat(40), 'A valid native fixed identity does not require upgrading an old renderer');
  delete f.job.fixed_identity; await f.save(f.job); assert.equal((await f.read()).baseSha, undefined, 'No table plus no metadata stays unknown');
  const sha256 = await legacyMergeFixture(t, 'a'.repeat(64), 'b'.repeat(64));
  assert.equal((await sha256.read()).baseSha, 'a'.repeat(64)); assert.equal((await sha256.read()).headSha, 'b'.repeat(64));
});

test('Release publication preserves its fixed SHAs after Checklist edits and rejects changes to the checked report body', async t => {
  const f = await fixture(t);
  const runtime = path.join(f.base, '.release-review-runtime');
  const report = path.join(f.repo, 'review-reports', 'release.md');
  await mkdir(path.dirname(report));
  const baseSha = '1'.repeat(40), headSha = '2'.repeat(40);
  const before = '# Release findings\n', after = '\nFixed conclusion\n';
  const start = '<!-- release-checklist:start -->', end = '<!-- release-checklist:end -->';
  const body = (checklist: string) => before + start + '\n' + checklist + '\n' + end + after;
  const job: Parameters<typeof readVerifiedReviewPublication>[0] = {
    ...f.job, schema: 'ReleaseReviewSession/v1', runtime_root: runtime, state: 'published', phase: 'complete',
    report_path: report, fixed_identity: { base_sha: baseSha, head_sha: headSha },
    report_static_sha256: createHash('sha256').update(before + after).digest('hex')
  };
  await writeFile(report, body('[ ] Human confirmation').replaceAll('\n', '\r\n'));
  const read = () => readVerifiedReviewPublication(job, runtime, 'release-reviewer');
  const fixed = await read();
  assert.equal(fixed?.baseSha, baseSha);
  assert.equal(fixed?.headSha, headSha);
  await writeFile(report, body('[x] Confirmed by operator'));
  assert.deepEqual(await read(), fixed);
  for (const invalid of [body('[x] Confirmed').replace('Fixed conclusion', 'Altered conclusion'),
    body('[x] Confirmed').replace(start, ''), body(start)]) {
    await writeFile(report, invalid);
    assert.equal(await read(), undefined);
  }
});

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

test('Host writable roots leave both r2 runtimes acceptable to the real native ownership preflight', async t => {
  const base = await realpath(await mkdtemp(path.join(os.tmpdir(), 'glw-r2-preflight-')));
  t.after(() => rm(base, { recursive: true, force: true }));
  const previous = process.env.REVIEW_SHARED_CACHE_DIR; delete process.env.REVIEW_SHARED_CACHE_DIR;
  t.after(() => { if (previous === undefined) delete process.env.REVIEW_SHARED_CACHE_DIR; else process.env.REVIEW_SHARED_CACHE_DIR = previous; });
  const fixture = path.resolve(__dirname, '../../../test/fixtures/workflowkit-release-1.5.0/gitlab-workspace-kit-1.5.0.zip');
  // Isolated compiler output is deeper than the normal out/ tree.
  const archive = await readFile(fixture).then(() => fixture, () => path.resolve('test/fixtures/workflowkit-release-1.5.0/gitlab-workspace-kit-1.5.0.zip'));
  assert.equal(createHash('sha256').update(await readFile(archive)).digest('hex'), '2de59b1433e0ff0a347358aa9d823d891dac444a487ad44580d12d58cde909ea');
  for (const [tool, suffix] of [['merge-reviewer', 'm'], ['release-reviewer', 'r']] as const) {
    const runtime = path.join(base, 'r2', '012345abcdef-' + suffix), shared = await sharedReviewCacheRoot(runtime);
    const runner = reviewRunnerRuntime(runtime);
    // This is the same writable-root shape used by Host review preparation.
    const binding = { script_path: path.join(base, 'run.py'), script_sha256: 'a'.repeat(64) };
    for (const root of [runtime, ...reviewRunnerWritableRoots(runtime, binding), shared, path.join(base, 'reviewer-cache-v2')]) await mkdir(root, { recursive: true });
    if (suffix === 'r') await writeFile(path.join(runtime, '.ownership.lock'), '');
    const script = `import importlib.util,json,pathlib,sys,zipfile
archive,base,tool,runtime,runner=sys.argv[1:]
base=pathlib.Path(base); scripts=base/tool; scripts.mkdir()
prefix='workflow-kit/payload/.agents/skills/'+tool+'/scripts/'
with zipfile.ZipFile(archive) as package:
 for name in package.namelist():
  if name.startswith(prefix) and name.endswith('.py'):
   relative=pathlib.PurePosixPath(name[len(prefix):]); assert not relative.is_absolute() and '..' not in relative.parts
   target=scripts.joinpath(*relative.parts); target.parent.mkdir(parents=True,exist_ok=True); target.write_bytes(package.read(name))
 source=base/(tool+'-runner.py'); source.write_bytes(package.read('workflow-kit/payload/.agents/gitlab-workspace-kit/run.py'))
spec=importlib.util.spec_from_file_location('kit_runner',source); module=importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
assert str(module._session_runtime(['python',str(scripts/'review_session.py'),'start','--runtime-root',runtime]))==runner
root=pathlib.Path(runtime); before=sorted(p.name for p in root.iterdir()); assert all(name=='.ownership.lock' for name in before),before
sys.path.insert(0,str(scripts)); import review_coordinator
assert review_coordinator.runtime(root,create=True)==root.resolve()
marker=root/('.merge-reviewer-runtime.json' if tool=='merge-reviewer' else '.release-reviewer-runtime.json')
assert json.loads(marker.read_text())['directory']==str(root.resolve())
assert not (root/'jobs').exists()
print(json.dumps({'tool':tool,'before':before,'nativeOwnershipAccepted':True,'runnerSiblingMappingVerified':True}))`;
    const result = await promisify(execFile)('python', ['-X', 'utf8', '-B', '-c', script, archive, base, tool, runtime, runner],
      { windowsHide: true, timeout: 30000, maxBuffer: 1024 * 1024, env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' } });
    const proof = JSON.parse(result.stdout); assert.equal(proof.nativeOwnershipAccepted, true); assert.equal(proof.runnerSiblingMappingVerified, true);
    assert.equal(shared, path.join(base, 'r2', '.review-shared-cache'));
    assert.ok((await readdir(runtime)).every(name => name === '.ownership.lock' || name === (suffix === 'm' ? '.merge-reviewer-runtime.json' : '.release-reviewer-runtime.json')));
  }
  assert.equal(await sharedReviewCacheRoot(path.join(base, 'custom')), path.join(base, 'custom', '.review-shared-cache'), 'unknown legacy layouts retain their mapping');
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
