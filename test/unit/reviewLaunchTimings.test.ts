import assert from 'node:assert/strict';
import test from 'node:test';
import { launcherHelperSeconds, parseReviewLaunchTimings } from '../../src/codex/reviewLaunchTimings';
import { mergeNativeReviewTimings } from '../../src/codex/nativeReview';

const metric = () => ({ schema: 'ReviewLaunchMetrics/v1', action: 'start', returncode: 0,
  timings: { request_seconds: 0.012, binding_seconds: 0.034, capabilities_seconds: 0.18, preflight_seconds: 0.2, child_seconds: 2.5, total_seconds: 2.95 } });

test('structured launcher stderr records retain actual phase values without interpreting reviewer completion', () => {
  const input = metric(), result = parseReviewLaunchTimings('Native output\n{"schema":"MergeReviewStatus/v1","state":"reviewing"}\n' + JSON.stringify(input) + '\n', { action: 'start', exitCode: 0 });
  assert.deepEqual(result, input);
  assert.equal(launcherHelperSeconds(result!)['launcher.start.binding_seconds'], 0.034);
  assert.equal(launcherHelperSeconds(result!)['launcher.start.child_seconds'], 2.5);
  assert.equal('complete' in result!, false); assert.equal('published' in result!, false);
});

test('older launchers and descriptive timing text remain unknown rather than becoming zero measurements', () => {
  for (const output of ['', 'request took 1 seconds; total 4 seconds', '{"schema":"MergeReviewStatus/v1","timings":{"total_seconds":3}}',
    'prefix ' + JSON.stringify(metric()), JSON.stringify({ ...metric(), schema: 'ReviewLaunchMetrics/v2' })]) assert.equal(parseReviewLaunchTimings(output), undefined);
  assert.equal(mergeNativeReviewTimings(undefined, undefined), undefined);
});

test('invalid numeric fields wrong identity metadata and ambiguous multiple invocations are rejected', () => {
  for (const value of [-1, null, '1.2', 604_801]) {
    const input = metric(); Object.assign(input.timings, { binding_seconds: value }); assert.equal(parseReviewLaunchTimings(JSON.stringify(input)), undefined);
  }
  assert.equal(parseReviewLaunchTimings(JSON.stringify({ ...metric(), returncode: 1.1 })), undefined);
  assert.equal(parseReviewLaunchTimings(JSON.stringify({ ...metric(), request_id: 'unknown attribution' })), undefined);
  assert.equal(parseReviewLaunchTimings(JSON.stringify(metric()), { action: 'finish' }), undefined);
  assert.equal(parseReviewLaunchTimings(JSON.stringify(metric()), { exitCode: 1 }), undefined);
  assert.equal(parseReviewLaunchTimings(JSON.stringify(metric()) + '\n' + JSON.stringify(metric())), undefined);
  const invalidTotal = metric(); invalidTotal.timings.total_seconds = 1; assert.equal(parseReviewLaunchTimings(JSON.stringify(invalidTotal)), undefined);
});

test('failed launcher preflight exposes only measured phases and does not invent child runtime', () => {
  const input = { schema: 'ReviewLaunchMetrics/v1', action: 'start', returncode: 2,
    timings: { request_seconds: 0.01, binding_seconds: 0.02, capabilities_seconds: 0.03, preflight_seconds: 0.4, total_seconds: 0.5 } };
  const result = parseReviewLaunchTimings(JSON.stringify(input), { exitCode: 2 }); assert.deepEqual(result, input);
  assert.equal('launcher.start.child_seconds' in launcherHelperSeconds(result!), false);
  assert.equal(parseReviewLaunchTimings(JSON.stringify({ ...input, returncode: 0 })), undefined);
});

test('launcher parsing is bounded and reads the final JSON record after verbose native output', () => {
  const verbose = 'Unrelated log output\n'.repeat(10_000) + JSON.stringify(metric()) + '\n';
  assert.deepEqual(parseReviewLaunchTimings(verbose), metric());
  assert.equal(parseReviewLaunchTimings(JSON.stringify({ ...metric(), unknown: 'x'.repeat(5000) })), undefined);
  const input = metric(); Object.assign(input.timings, { raw_output: 0.1 }); assert.equal(parseReviewLaunchTimings(JSON.stringify(input)), undefined);
});

test('native job rereads preserve only declared launcher measurements while refreshing native helper counters', () => {
  const previous = { firstDraftAt: '2026-11-15T01:00:00.000Z', capturedAt: null, publishedAt: null,
    helperSeconds: { ...launcherHelperSeconds(parseReviewLaunchTimings(JSON.stringify(metric()))!), step_seconds: 1, 'launcher.private-output': 99 } };
  const current = { firstDraftAt: null, capturedAt: '2026-11-15T00:59:00.000Z', publishedAt: 1_800_000_000,
    helperSeconds: { step_seconds: 3, finish_total_seconds: 0.9 } };
  const result = mergeNativeReviewTimings(previous, current)!;
  assert.equal(result.helperSeconds['launcher.start.child_seconds'], 2.5); assert.equal(result.helperSeconds.step_seconds, 3);
  assert.equal(result.helperSeconds.finish_total_seconds, 0.9); assert.equal(result.helperSeconds['launcher.private-output'], undefined);
  assert.equal(result.firstDraftAt, previous.firstDraftAt); assert.equal(result.publishedAt, current.publishedAt);
  assert.equal(previous.helperSeconds.step_seconds, 1);
});
