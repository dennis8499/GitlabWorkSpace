import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const STATE = path.join(ROOT, '.gitlab-workspace-validation');
const EVIDENCE = path.join(ROOT, 'docs', 'work', 'work-20261006-live-validation', 'evidence');
const BASELINE_ROOT = path.join(STATE, 'baseline-source-fae6ee9');
const BASELINE_VSIX = path.join(STATE, 'baseline-v0.13.2-fae6ee9.vsix');
const REVISION_VSIX = path.join(ROOT, 'dist', 'gitlab-workspace-0.13.2.vsix');

function percentile(values, fraction) {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[sorted.length ? Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1) : 0];
}

function compareMetric(current, baseline, limitPercent) {
  if (!Number.isFinite(current) || !Number.isFinite(baseline) || baseline <= 0) {
    return { current: current ?? null, baseline: baseline ?? null, increasePercent: null, status: 'BLOCKED' };
  }
  const increasePercent = Number(((current / baseline - 1) * 100).toFixed(2));
  return { current, baseline, increasePercent, limitPercent, status: increasePercent <= limitPercent ? 'PASS' : 'FAIL' };
}

function sha256(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

function capture(variant, cwd, rounds) {
  const runs = [];
  const script = path.join(ROOT, 'scripts', 'performance-benchmark.cjs');
  for (let round = 1; round <= rounds; round++) {
    const output = execFileSync(process.execPath, ['--expose-gc', script], {
      cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, maxBuffer: 32 * 1024 * 1024,
      env: { ...process.env, GLW_BENCHMARK_CODE_ROOT: cwd }
    });
    runs.push(JSON.parse(output));
    process.stdout.write(`${variant} synthetic run ${round}/${rounds}\n`);
  }
  return runs;
}

function metrics(runs) {
  return {
    coldCacheReadMs: percentile(runs.map((run) => run.sharedReadCache.coldLatencyMs), 0.5),
    warmCacheReadMs: percentile(runs.map((run) => run.sharedReadCache.warmLatencyMs), 0.5),
    repositoryPathNaming2kMs: percentile(runs.map((run) => run.repositoryPathNaming.at(-1).productionMedianMs), 0.5),
    graphPatchBuild2kP50Ms: percentile(runs.map((run) => run.graphAndVirtualList.at(-1).patchBuildMedianMs), 0.5),
    graphPeakHeapBytes: percentile(runs.map((run) => run.graphAndVirtualList.at(-1).peakSampledHeapBytes), 0.5),
    graphPeakHeapDeltaBytes: percentile(runs.map((run) => run.graphAndVirtualList.at(-1).peakSampledHeapDeltaBytes), 0.5),
    graphTransportReductionPercent: percentile(runs.map((run) => run.graphAndVirtualList.at(-1).graphTransportReductionPercent), 0.5)
  };
}

function samples(runs) {
  return runs.map((run, index) => ({
    run: index + 1,
    measuredAt: run.environment.measuredAt,
    sharedReadCache: run.sharedReadCache,
    repositoryPathNaming: run.repositoryPathNaming.map(({ projects, productionMedianMs, legacyMedianMs }) => ({ projects, productionMedianMs, legacyMedianMs })),
    graph: run.graphAndVirtualList.map(({ nodes, issues, patchBuildMedianMs, peakSampledHeapBytes, peakSampledHeapDeltaBytes, graphTransportReductionPercent, issueRowsAtMidScroll }) => ({
      nodes, issues, patchBuildMedianMs, peakSampledHeapBytes, peakSampledHeapDeltaBytes, graphTransportReductionPercent, issueRowsAtMidScroll
    }))
  }));
}

function main() {
  const roundsArgument = process.argv.indexOf('--rounds');
  const rounds = Number(roundsArgument >= 0 ? process.argv[roundsArgument + 1] : 10);
  if (!Number.isInteger(rounds) || rounds < 1 || rounds > 10) throw new Error('Use --rounds 1–10.');
  if (!existsSync(BASELINE_ROOT) || !existsSync(BASELINE_VSIX) || !existsSync(REVISION_VSIX)) {
    throw new Error('Build the fae6ee9 baseline and current VSIX before capturing the comparison.');
  }
  const baselineRuns = capture('baseline', BASELINE_ROOT, rounds);
  const revisionRuns = capture('revision', ROOT, rounds);
  const baselineMetrics = metrics(baselineRuns);
  const revisionMetrics = metrics(revisionRuns);
  const baselineSamples = samples(baselineRuns);
  const revisionSamples = samples(revisionRuns);
  const compared = Object.fromEntries(Object.keys(baselineMetrics).filter((key) => key !== 'graphTransportReductionPercent')
    .map((key) => [key, compareMetric(revisionMetrics[key], baselineMetrics[key], 10)]));
  const statuses = Object.values(compared).map((metric) => metric.status);
  const summary = {
    schema: 'GitLabWorkspaceSyntheticComparison/v1', generatedAt: new Date().toISOString(),
    baselineCommit: 'fae6ee9595c837dc8bba0c5dd483f6984ac9014f', roundsPerVariant: rounds,
    environment: revisionRuns[0].environment,
    workloads: revisionRuns[0].workloads,
    variants: {
      baseline: { artifact: path.relative(ROOT, BASELINE_VSIX).replaceAll(path.sep, '/'), sha256: sha256(BASELINE_VSIX), metrics: baselineMetrics, samples: baselineSamples },
      revision: { artifact: path.relative(ROOT, REVISION_VSIX).replaceAll(path.sep, '/'), sha256: sha256(REVISION_VSIX), metrics: revisionMetrics, samples: revisionSamples }
    },
    regressionLimitPercent: 10, comparisons: compared,
    status: statuses.includes('FAIL') ? 'FAIL' : statuses.includes('BLOCKED') ? 'BLOCKED' : 'PASS',
    limitation: 'Synthetic helper measurements do not replace live GitLab, Extension Host, or Webview performance acceptance.'
  };
  mkdirSync(EVIDENCE, { recursive: true });
  const report = path.join(EVIDENCE, 'performance-synthetic-comparison.json');
  writeFileSync(report, `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
  for (const [variant, artifact, sha256Value, variantMetrics, variantSamples] of [
    ['baseline', summary.variants.baseline.artifact, summary.variants.baseline.sha256, baselineMetrics, baselineSamples],
    ['revision', summary.variants.revision.artifact, summary.variants.revision.sha256, revisionMetrics, revisionSamples]
  ]) {
    writeFileSync(path.join(EVIDENCE, `performance-synthetic-${variant}.json`), `${JSON.stringify({
      schema: 'GitLabWorkspaceSyntheticVariantEvidence/v1', generatedAt: summary.generatedAt, baselineCommit: summary.baselineCommit,
      variant, artifact, sha256: sha256Value, environment: summary.environment, workloads: summary.workloads,
      rounds: rounds, metrics: variantMetrics, samples: variantSamples
    }, null, 2)}\n`, 'utf8');
  }
  process.stdout.write(`${JSON.stringify({ report: path.relative(ROOT, report), status: summary.status, comparisons: summary.comparisons }, null, 2)}\n`);
  if (summary.status !== 'PASS') process.exitCode = 1;
}

try { main(); }
catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : 'Synthetic comparison failed.'}\n`);
  process.exitCode = 1;
}
