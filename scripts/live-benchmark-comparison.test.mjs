import assert from 'node:assert/strict';
import test from 'node:test';
import { compareLiveBenchmarks } from './live-benchmark-comparison.mjs';

function makeReport(label, ratio = 1, sessions = 10) {
  const environments = Array.from({ length: sessions }, (_, index) => ({
    environment: 'ce16', version: '16.11.10', selectedGroup: 'grp-sn-maint/performance-same-run', status: 'PASS',
    coldInteractiveReadyMs: 500 * ratio + index,
    warmNavigationMs: { samples: Array(30).fill(100 * ratio) },
    localRepoSearchMs: { samples: Array(30).fill(20 * ratio) },
    memory: { samples: [{ extensionHostRssBytes: 1000 * ratio, extensionHostHeapUsedBytes: 500 * ratio, rendererHeapUsedBytes: 300 * ratio }] }
  }));
  return {
    schema: 'GitLabWorkspaceLiveVerification/v1', mode: 'benchmark', fixture: 'load', runId: 'same-run', vscodeVersion: '1.140.0',
    testedArtifact: { sha256: label }, environments
  };
}

test('compares 10 cold sessions and 300 warm/search samples within the 10 percent budget', () => {
  const comparison = compareLiveBenchmarks(makeReport('revision'), makeReport('baseline'));
  assert.equal(comparison.status, 'PASS');
  assert.equal(comparison.environments[0].metrics.warmNavigationP95.status, 'PASS');
  assert.equal(comparison.environments[0].metrics.rendererPeakHeap.status, 'PASS');
});

test('fails when a latency or memory sample regresses by more than 10 percent', () => {
  const comparison = compareLiveBenchmarks(makeReport('revision', 1.11), makeReport('baseline'));
  assert.equal(comparison.status, 'FAIL');
  assert.equal(comparison.environments[0].metrics.localSearchP95.status, 'FAIL');
  assert.equal(comparison.environments[0].metrics.extensionHostPeakRss.status, 'FAIL');
});

test('compares complete baseline samples even when the baseline misses an absolute performance threshold', () => {
  const baseline = makeReport('baseline');
  baseline.environments.forEach((run) => { run.status = 'FAIL'; });
  const comparison = compareLiveBenchmarks(makeReport('revision'), baseline);
  assert.equal(comparison.status, 'PASS');
  assert.equal(comparison.environments[0].metrics.warmNavigationP95.status, 'PASS');
});

test('blocks a baseline with Extension Host test failures even when it has complete samples', () => {
  const baseline = makeReport('baseline');
  baseline.environments.forEach((run) => { run.status = 'FAIL'; });
  baseline.failures = [{ environment: 'ce16', status: 'FAIL', error: 'baseline feature check failed' }];
  assert.equal(compareLiveBenchmarks(makeReport('revision'), baseline).status, 'BLOCKED');
});

test('blocks incomplete, mismatched or identical-artifact comparisons', () => {
  assert.equal(compareLiveBenchmarks(makeReport('revision', 1, 1), makeReport('baseline')).status, 'BLOCKED');
  assert.equal(compareLiveBenchmarks(makeReport('same'), makeReport('same')).status, 'BLOCKED');
  const differentRun = makeReport('baseline');
  differentRun.runId = 'another-run';
  assert.equal(compareLiveBenchmarks(makeReport('revision'), differentRun).status, 'BLOCKED');
});
