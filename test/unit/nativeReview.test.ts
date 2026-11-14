import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { CodexBridge } from '../../src/codex/bridge';
import { CodexAppServer } from '../../src/codex/appServer';
import { CodexTaskScheduler } from '../../src/codex/scheduler';
import { importLegacyReviewCheckpoint, inspectNativeReview, prepareReviewWritableRoots } from '../../src/codex/nativeReview';
import { inspectModelRouting, legacyIdentityDigest } from '../../src/codex/modelRouting';
import { applyExecutionSelection } from '../../src/codex/executionSelection';
import type { CodexTaskSpec } from '../../src/codex/protocol';

async function fixture(t: { after(fn: () => Promise<void>): void }, mode = 'native-review', published = false, complete = true) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'native-review-'));
  const runtime = path.join(root, 'runtime'), project = path.join(root, 'repo'), requestId = 'a'.repeat(32);
  const context = path.join(runtime, 'sessions', requestId), jobPath = path.join(runtime, 'jobs', requestId + '.json');
  const report = path.join(project, 'review-reports', 'report.md'), body = 'Fixed reviewed report\n';
  for (const directory of [context, path.dirname(jobPath), path.dirname(report), path.join(root, '.agents/skills/merge-reviewer')]) await mkdir(directory, { recursive: true });
  await writeFile(path.join(root, '.agents/skills/merge-reviewer/SKILL.md'), 'Native review');
  await writeFile(path.join(runtime, '.merge-reviewer-runtime.json'), JSON.stringify({ schema: 'MergeReviewRuntime/v1', directory: runtime }));
  await writeFile(path.join(context, 'manifest.json'), '{"repositories":[]}'); await writeFile(path.join(context, 'draft.json'), '{}');
  const outcome = { schema: 'MergeReviewOutcome/v1', outcome_available: true, review_complete: complete, review_status: complete ? 'complete' : 'incomplete', gaps: [] };
  const job = { schema: 'MergeReviewSession/v1', request_id: requestId, runtime_root: runtime, context_dir: context, input_digest: 'b'.repeat(64),
    state: published ? 'published' : 'ready', phase: 'review', updated_at: new Date().toISOString(),
    inputs: { workspace: root, project, base: 'main', head: 'feature' }, report_path: published ? report : undefined,
    report_sha256: createHash('sha256').update(body).digest('hex'), review_outcome: outcome };
  await writeFile(jobPath, JSON.stringify(job)); if (published) await writeFile(report, body);
  await writeFile(path.join(root, 'fixture-native.json'), JSON.stringify({ jobPath, context, report, body, outcome }));
  const spec: CodexTaskSpec = { source: { kind: 'skill', featureId: 'merge-repo', inputs: { 'merge-repo.repo': project }, revision: 'r' },
    title: 'Native review', root, workspaceKey: root, prompt: 'Complete native review.', environmentKey: 'r', writableRoots: [root, runtime],
    skill: { name: 'merge-reviewer', path: path.join(root, '.agents/skills/merge-reviewer/SKILL.md') }, model: 'gpt-6-luna', effort: 'high',
    review: { tool: 'merge-reviewer', requestId, revision: 'r', runtimeRoot: runtime, workspaceRoot: root, repositoryPath: project } };
  const requests: Array<{ method: string; params: any }> = [];
  let cleanups = 0;
  const bridge = new CodexBridge({ scheduler: new CodexTaskScheduler('test', root), storage: path.join(root, 'tasks'), version: 'test', executable: () => '', trusted: () => true,
    prepare: async source => { const prepared = structuredClone(spec); delete prepared.routing;
      prepared.source = source; prepared.model = source.model ?? prepared.model; prepared.effort = source.effort ?? prepared.effort; return prepared; }, event: () => {}, openUrl: async () => {},
    cleanupReview: async () => { cleanups++; const current = JSON.parse(await readFile(jobPath, 'utf8')); current.cleanup_pending = false; await writeFile(jobPath, JSON.stringify(current)); },
    client: async () => {
      const client = new CodexAppServer(spawn(process.execPath, [path.resolve(__dirname, '../../../test/fixtures/codex-app-server.cjs'), root, mode], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] }));
      const original = client.request.bind(client); client.request = (method, params) => { requests.push({ method, params }); return original(method, params); };
      await client.initialize('test'); return { client, version: '0.166.0', executable: 'offline-peer' };
    } });
  t.after(async () => { await bridge.shutdown(); await rm(root, { recursive: true, force: true }); });
  return { root, spec, bridge, requests, jobPath, report, cleanups: () => cleanups };
}
async function settled(f: Awaited<ReturnType<typeof fixture>>) {
  const id = await f.bridge.enqueue(f.spec, 'manual');
  const until = Date.now() + 15_000;
  while (!['completed', 'paused', 'failed'].includes(f.bridge.list()[0]?.status ?? '')) {
    if (Date.now() > until) throw new Error('native review timed out: ' + JSON.stringify(f.bridge.list().map(row => ({ status: row.status, error: row.error }))));
    await new Promise(resolve => setTimeout(resolve, 15));
  }
  return { id, task: f.bridge.list()[0] };
}
test('manual native review completes only after receipt, with one thread and fixed effort', async t => {
  const f = await fixture(t); const { id, task } = await settled(f);
  assert.equal(task.status, 'completed', task.error ?? 'native gate'); assert.equal(task.result?.state, 'ready');
  const turns = f.requests.filter(row => row.method === 'turn/start');
  assert.equal(turns.length, 1); assert.equal(turns[0].params.model, 'gpt-6-luna'); assert.equal(turns[0].params.effort, 'high');
  assert.doesNotMatch(turns[0].params.input[0].text, /routing_phase|\$model-routing/);
  assert.equal(f.requests.filter(row => row.method === 'thread/start').length, 1);
  assert.equal((f.bridge.diagnosticSnapshot(id).executions as unknown[]).length, 1);
  const timeline = f.bridge.diagnosticSnapshot(id).reviewTimeline as Array<{ phase: string; endedAt?: string }>;
  assert.equal(timeline[0].phase, 'queued'); assert.ok(timeline[0].endedAt);
  assert.ok(timeline.some(row => row.phase === 'verifying'));
});
test('unfinished review continues in the same thread and unchanged effort', async t => {
  const f = await fixture(t, 'native-review-continue'); const { task } = await settled(f);
  assert.equal(task.status, 'completed', task.error ?? 'native gate');
  const turns = f.requests.filter(row => row.method === 'turn/start'); assert.equal(turns.length, 2);
  assert.equal(turns[0].params.threadId, turns[1].params.threadId);
  assert.deepEqual(turns.map(row => row.params.effort), ['high', 'high']);
});
test('ended model turn without native progress is paused, never completed', async t => {
  const f = await fixture(t, 'native-review-stall'); const { task } = await settled(f);
  assert.equal(task.status, 'paused', task.error ?? 'native gate'); assert.equal(task.result?.state, 'needs-work');
  assert.equal(f.requests.filter(row => row.method === 'turn/start').length, 1);
});
test('a failed receipt check after a completed turn cannot fall through to task completed', async t => {
  const f = await fixture(t);
  (f.bridge as any).options.completed = async () => { await writeFile(f.report, 'changed after native publication'); };
  const { task } = await settled(f);
  assert.equal(task.status, 'paused'); assert.equal(task.result?.state, 'needs-work');
  assert.match(task.error ?? '', /收據/);
});
test('pausing a reviewer preserves its native job after the process stops', async t => {
  const f = await fixture(t, 'hold'); f.spec.prompt = 'hold'; let cancellations = 0;
  (f.bridge as any).options.cancelReview = async () => { cancellations++; };
  const id = await f.bridge.enqueue(f.spec, 'pause-native');
  const deadline = Date.now() + 15_000;
  while (!f.bridge.list()[0]?.turnId) { if (Date.now() > deadline) throw new Error('native turn missing'); await new Promise(resolve => setTimeout(resolve, 15)); }
  await f.bridge.pause(id);
  assert.equal(f.bridge.list()[0].status, 'paused'); assert.equal(cancellations, 0);
  assert.equal(JSON.parse(await readFile(f.jobPath, 'utf8')).state, 'ready');
});
test('published incomplete reports are delivered without another model dispatch', async t => {
  const f = await fixture(t, 'native-review', true, false); const { task } = await settled(f);
  assert.equal(task.status, 'completed'); assert.equal(task.result?.state, 'needs-work'); assert.ok(task.result?.reportPath);
  assert.equal(f.requests.filter(row => row.method === 'turn/start').length, 0);
});
test('changed report or terminal job cannot pass the completion gate', async t => {
  const f = await fixture(t, 'native-review', true);
  await writeFile(f.report, 'tampered'); await assert.rejects(inspectNativeReview(f.spec), /收據/);
  const job = JSON.parse(await readFile(f.jobPath, 'utf8')); job.state = 'cancelled'; await writeFile(f.jobPath, JSON.stringify(job));
  assert.equal((await inspectNativeReview(f.spec)).terminal, true);
});

test('Release native receipt includes metadata and permits only editable Checklist changes', async t => {
  const f = await fixture(t, 'native-review', true);
  f.spec.review!.tool = 'release-reviewer';
  const runtime = f.spec.review!.runtimeRoot!;
  await writeFile(path.join(runtime, '.release-reviewer-runtime.json'), JSON.stringify({ schema: 'ReleaseReviewRuntime/v1', directory: runtime }));
  const footer = '\nTail\n<!-- release-review-report:eyJzY2hlbWEiOiJmaXh0dXJlIn0= -->\n';
  const body = 'Header\n<!-- release-checklist:start -->\n[ ] Human confirmation\n<!-- release-checklist:end -->' + footer;
  const job = JSON.parse(await readFile(f.jobPath, 'utf8'));
  job.schema = 'ReleaseReviewSession/v1'; job.review_outcome.schema = 'ReleaseReviewOutcome/v1';
  job.report_static_sha256 = createHash('sha256').update('Header\n' + footer).digest('hex');
  await writeFile(f.jobPath, JSON.stringify(job)); await writeFile(f.report, body.replace(/\n/g, '\r\n'));
  assert.equal((await inspectNativeReview(f.spec)).complete, true);
  await writeFile(f.report, body.replace('[ ] Human confirmation', '[x] Confirmed by operator'));
  assert.equal((await inspectNativeReview(f.spec)).complete, true);
  await writeFile(f.report, body.replace('Tail', 'Changed fixed conclusion'));
  await assert.rejects(inspectNativeReview(f.spec), /收據/);
});
test('published cleanup uses the helper hook and never repeats semantic review', async t => {
  const f = await fixture(t, 'native-review', true);
  const job = JSON.parse(await readFile(f.jobPath, 'utf8')); job.cleanup_pending = true; await writeFile(f.jobPath, JSON.stringify(job));
  const { task } = await settled(f);
  assert.equal(task.status, 'completed'); assert.equal(f.cleanups(), 1);
  assert.equal(f.requests.filter(row => row.method === 'turn/start').length, 0);
});

function bindMergeRequest(spec: CodexTaskSpec): void {
  const project = spec.review!.repositoryPath!;
  spec.source = { kind: 'merge-request', projectId: 1, iid: 1 };
  spec.origin = { kind: 'merge-request', accountKey: 'a'.repeat(64), baseUrl: 'https://gitlab.test', projectId: 1, projectPath: 'team/service',
    webUrl: 'https://gitlab.test/team/service/-/merge_requests/1', repositoryRoot: project, iid: 1,
    sourceBranch: 'feature', sourceSha: '2'.repeat(40), targetBranch: 'main', targetSha: '1'.repeat(40), reviewerTool: 'merge-reviewer' };
  spec.executionRoot = project;
  spec.workflow = { id: 'c'.repeat(32), runtimeRoot: spec.review!.runtimeRoot!, remote: 'https://gitlab.test/team/service.git' };
}

test('published MR resume verifies legacy cleaned fixed sources before the zero-turn ready shortcut', async t => {
  for (const scenario of ['matching', 'wrong-source', 'unknown-source']) await t.test(scenario, async child => {
    const f = await fixture(child, 'native-review', true), project = f.spec.review!.repositoryPath!, base = '1'.repeat(40), head = '2'.repeat(40);
    bindMergeRequest(f.spec);
    const body = scenario === 'unknown-source' ? 'Older report without fixed metadata or a fixed version table\n'
      : `# Native published report\n- 本機路徑：\`${project}\`\n### 固定版本\n\n| Repo | 角色 | 來源 | 完整 SHA |\n| --- | --- | --- | --- |\n| ${path.basename(project)} | seed | base | \`${base}\` |\n| ${path.basename(project)} | seed | head | \`${scenario === 'matching' ? head : '3'.repeat(40)}\` |\n`;
    await writeFile(f.report, body); const job = JSON.parse(await readFile(f.jobPath, 'utf8'));
    assert.equal(job.fixed_identity, undefined); job.report_sha256 = createHash('sha256').update(body).digest('hex'); await writeFile(f.jobPath, JSON.stringify(job));
    await rm(job.context_dir, { recursive: true }); // Native finish has already cleaned its owned evidence session.
    const inspected = await inspectNativeReview(f.spec); assert.equal(inspected.complete, scenario === 'matching');
    const { task } = await settled(f); assert.equal(task.status, 'completed');
    assert.equal(task.result?.state, scenario === 'matching' ? 'ready' : 'needs-work');
    assert.equal(f.requests.filter(row => row.method === 'turn/start').length, 0, 'A published result is reconciled without another model turn');
    if (scenario !== 'matching') assert.match(task.result?.summary ?? '', /固定版本不符合/);
  });
});

test('native completion remains authoritative over generic completion callbacks after a real turn', async t => {
  for (const scenario of ['wrong-source', 'unknown-source', 'callback-needs-work', 'callback-wrong-report']) await t.test(scenario, async child => {
    const f = await fixture(child); bindMergeRequest(f.spec);
    const job = JSON.parse(await readFile(f.jobPath, 'utf8'));
    if (scenario !== 'unknown-source') job.fixed_identity = { base_sha: '1'.repeat(40), head_sha: (scenario === 'wrong-source' ? '3' : '2').repeat(40) };
    await writeFile(f.jobPath, JSON.stringify(job));
    (f.bridge as any).options.completed = async () => ({
      state: scenario === 'callback-needs-work' ? 'needs-work' : 'ready',
      reportPath: scenario === 'callback-wrong-report' ? path.join(path.dirname(f.report), 'unverified.md') : f.report,
      summary: scenario === 'callback-needs-work' ? 'Local completion check failed.' : 'Generic callback says ready.',
      files: ['local-evidence'],
    });
    const { task } = await settled(f);
    assert.equal(task.status, 'completed'); assert.equal(task.result?.state, 'needs-work');
    assert.equal(task.result?.reportPath, f.report, 'Only the native receipt may select the published report');
    assert.equal(f.requests.filter(row => row.method === 'turn/start').length, 1);
    if (scenario === 'wrong-source' || scenario === 'unknown-source') assert.match(task.result?.summary ?? '', /固定版本不符合/);
    if (scenario === 'callback-needs-work') { assert.equal(task.result?.summary, 'Local completion check failed.'); assert.deepEqual(task.result?.files, ['local-evidence']); }
    if (scenario === 'callback-wrong-report') { assert.match(task.result?.summary ?? '', /回呼的報告不符合/); assert.equal(task.result?.files, undefined); }
  });
});

async function unrecordedReviewFailure(t: test.TestContext) {
  const f = await fixture(t); bindMergeRequest(f.spec);
  const job = JSON.parse(await readFile(f.jobPath, 'utf8')); job.fixed_identity = { base_sha: '1'.repeat(40), head_sha: '2'.repeat(40) }; await writeFile(f.jobPath, JSON.stringify(job));
  const { id } = await settled(f), record = (f.bridge as any).records.get(id);
  record.result = { ...record.result, state: 'uncertain', summary: 'Earlier callback failed without saving a publication intent' };
  await (f.bridge as any).save(record);
  assert.equal(record.status, 'completed'); assert.equal(record.dispatch.state, 'completed'); assert.equal(record.lease.released, true);
  return { ...f, id, record };
}

test('public reconciliation recovers an unrecorded native review with only its read-only callback and no App Server', async t => {
  for (const outcome of ['not-published', 'confirmed']) await t.test(outcome, async child => {
    const f = await unrecordedReviewFailure(child), before = f.requests.length, history = JSON.stringify(f.record.executionHistory); let reads = 0;
    (f.bridge as any).options.reconcileUnrecordedReview = async (spec: CodexTaskSpec, report: { body: string; bodyHash: string; reportPath: string }, check: () => void) => {
      check(); reads++; assert.equal(spec.review?.requestId, f.spec.review!.requestId); assert.equal(report.reportPath, f.report);
      assert.equal(report.body, await readFile(f.report, 'utf8')); assert.equal(report.bodyHash, createHash('sha256').update(report.body.trim()).digest('hex'));
      return outcome === 'confirmed' ? { state: outcome, key: 'd'.repeat(64) } : { state: outcome };
    };
    await f.bridge.reconcile(f.id); const task = f.bridge.list().find(task => task.id === f.id)!;
    assert.equal(reads, 1); assert.equal(f.requests.length, before, 'No process, model or turn is needed for the read-only recovery');
    assert.equal(task.result?.state, outcome === 'confirmed' ? 'published' : 'ready'); assert.equal(task.recovery?.publication, outcome);
    assert.equal(JSON.stringify((f.bridge as any).records.get(f.id).executionHistory), history);
    if (outcome === 'confirmed') assert.deepEqual(task.publication, { kind: 'review', state: 'confirmed', key: 'd'.repeat(64), bodyHash: createHash('sha256').update('Fixed reviewed report').digest('hex') });
    else assert.equal(task.publication, undefined);
  });
});

test('unrecorded review recovery never clears saved intents, ambiguous GETs or changed native reports', async t => {
  for (const scenario of ['pending', 'historical-receipt', 'ambiguous', 'wrong-source', 'report-changed-during-get']) await t.test(scenario, async child => {
    const f = await unrecordedReviewFailure(child); let reads = 0;
    if (scenario === 'pending') f.record.publication = { kind: 'review', state: 'pending', key: 'saved-intent', bodyHash: 'c'.repeat(64) };
    if (scenario === 'historical-receipt') f.record.publications = { old: { kind: 'review', state: 'not-published', key: 'old-intent', bodyHash: 'c'.repeat(64) } };
    await (f.bridge as any).save(f.record);
    if (scenario === 'wrong-source') { const job = JSON.parse(await readFile(f.jobPath, 'utf8')); job.fixed_identity.head_sha = '3'.repeat(40); await writeFile(f.jobPath, JSON.stringify(job)); }
    (f.bridge as any).options.reconcileUnrecordedReview = async () => {
      reads++; if (scenario === 'ambiguous') throw new Error('Multiple or mismatched GitLab markers');
      if (scenario === 'report-changed-during-get') await writeFile(f.report, 'changed after the source read');
      return { state: 'not-published' };
    };
    if (scenario === 'pending' || scenario === 'historical-receipt') { await f.bridge.reconcile(f.id); assert.equal(reads, 0); }
    else await assert.rejects(f.bridge.reconcile(f.id), /markers|完整固定版本|收據/);
    assert.equal(f.bridge.list().find(task => task.id === f.id)?.result?.state, 'uncertain');
    assert.equal(f.requests.filter(row => row.method === 'turn/start').length, 1, 'Reconciliation cannot dispatch another model turn');
  });
});
test('authorized missing runtime roots exist before sandbox dispatch without creating jobs', async t => {
  const f = await fixture(t), directory = path.join(f.root, 'future-runtime'); f.spec.writableRoots.push(directory);
  await prepareReviewWritableRoots(f.spec);
  assert.deepEqual(await readdir(directory), []);
});

test('a report published by the current turn also completes pending helper cleanup', async t => {
  const f = await fixture(t);
  const job = JSON.parse(await readFile(f.jobPath, 'utf8')); job.cleanup_pending = true; await writeFile(f.jobPath, JSON.stringify(job));
  const { task } = await settled(f);
  assert.equal(task.status, 'completed'); assert.equal(f.cleanups(), 1);
  assert.equal(f.requests.filter(row => row.method === 'turn/start').length, 1);
});
test('a user question after publication gets a fixed-setting turn on the same report', async t => {
  const f = await fixture(t); const { id } = await settled(f);
  await f.bridge.message(id, 'Explain the published finding.');
  const deadline = Date.now() + 15_000;
  while (f.requests.filter(row => row.method === 'turn/start').length < 2 || f.bridge.list()[0].status !== 'completed') {
    if (Date.now() > deadline) throw new Error('published follow-up timed out');
    await new Promise(resolve => setTimeout(resolve, 15));
  }
  const turns = f.requests.filter(row => row.method === 'turn/start');
  assert.equal(turns[0].params.threadId, turns[1].params.threadId); assert.equal(turns[1].params.effort, 'high');
  assert.match(turns[1].params.input[0].text, /原生報告已發布/);
  assert.equal((await f.bridge.specification(id)).review?.requestId, f.spec.review!.requestId);
});
test('manual model selection is independent of retired kit capabilities and rejects Auto', async t => {
  const f = await fixture(t);
  assert.equal(applyExecutionSelection(structuredClone(f.spec), { ...f.spec.source, model: 'another-model', effort: 'medium' }).model, 'another-model');
  assert.throws(() => applyExecutionSelection(structuredClone(f.spec), { ...f.spec.source, model: 'gpt-6-luna', effort: 'auto' }), /Auto 已移除/);
});
test('a stopped legacy request resumes with saved effort after routing Skill retirement', async t => {
  const f = await fixture(t);
  f.spec.routing = { tool: 'merge-reviewer', requestId: f.spec.review!.requestId, runtimeRoot: f.spec.review!.runtimeRoot!, requestedEffort: 'auto',
    skillPath: path.join(f.root, '.agents/skills/model-routing/SKILL.md'), payloadHash: 'b'.repeat(64) };
  const folder = path.join(f.spec.review!.runtimeRoot!, 'routing/merge-reviewer'); await mkdir(folder, { recursive: true });
  const fixed = { input_digest: 'b'.repeat(64), repositories: [] };
  await writeFile(path.join(folder, f.spec.review!.requestId + '.json'), JSON.stringify({
    schema: 'ReviewModelRouting/v1', tool: 'merge-reviewer', request_id: f.spec.review!.requestId,
    runtime_root: f.spec.review!.runtimeRoot, context_dir: path.join(f.spec.review!.runtimeRoot!, 'sessions', f.spec.review!.requestId),
    input_digest: 'b'.repeat(64), fixed_sources: fixed, snapshot_hash: legacyIdentityDigest(fixed), requested_effort: 'auto', model: 'gpt-6-luna', effort: 'xhigh', phase: 'reviewing',
    reason: 'Prior saved decision', checkpoint: '', history: [{ effort: 'xhigh', reason: 'Prior saved decision', kind: 'decide' }], revision: 1 }));
  const { task } = await settled(f);
  assert.equal(task.status, 'completed', task.error ?? 'legacy migration');
  assert.deepEqual(f.requests.filter(row => row.method === 'turn/start').map(row => row.params.effort), ['xhigh']);
  assert.equal((await f.bridge.specification(task.id)).routing, undefined);
  const saved = JSON.parse(await readFile(path.join(folder, f.spec.review!.requestId + '.json'), 'utf8'));
  assert.equal(saved.phase, 'reviewing');
  saved.fixed_sources.input_digest = 'changed';
  await writeFile(path.join(folder, f.spec.review!.requestId + '.json'), JSON.stringify(saved));
  await assert.rejects(inspectModelRouting(f.spec.routing!), /固定來源紀錄/);
});

test('legacy navigation imports only when draft and completed operation IDs still match', async t => {
  const f = await fixture(t), context = path.join(f.spec.review!.runtimeRoot!, 'sessions', f.spec.review!.requestId);
  const checkpoint = { schema: 'ReviewExecutionCheckpoint/v1' as const, request_id: f.spec.review!.requestId,
    snapshot_hash: 'a'.repeat(64), draft_sha256: createHash('sha256').update('{}').digest('hex'),
    completed_operation_ids: ['read-1'], unread_evidence: ['head next page'], open_questions: [], next_action: 'Review next page' };
  const saved = { execution_checkpoint: checkpoint };
  await writeFile(path.join(context, 'manifest.json'), JSON.stringify({ repositories: [], operations: { 'read-1': {} } }));
  await importLegacyReviewCheckpoint(f.spec, saved);
  const job = JSON.parse(await readFile(f.jobPath, 'utf8'));
  assert.equal(job.execution_checkpoint.imported_from, checkpoint.schema);
  assert.equal(job.execution_checkpoint.draft_sha256, checkpoint.draft_sha256);
  assert.deepEqual(job.execution_checkpoint.completed_operation_ids, ['read-1']);
  delete job.execution_checkpoint; await writeFile(f.jobPath, JSON.stringify(job));
  checkpoint.completed_operation_ids = ['unknown'];
  await importLegacyReviewCheckpoint(f.spec, saved);
  assert.equal(JSON.parse(await readFile(f.jobPath, 'utf8')).execution_checkpoint, undefined);
  checkpoint.completed_operation_ids = ['read-1']; await writeFile(path.join(context, 'draft.json'), '{"summary":"newer"}');
  await importLegacyReviewCheckpoint(f.spec, saved);
  assert.equal(JSON.parse(await readFile(f.jobPath, 'utf8')).execution_checkpoint, undefined);
});
