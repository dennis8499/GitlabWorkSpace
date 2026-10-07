function percentile(values, fraction) {
  const sorted = values.filter(Number.isFinite).sort((left, right) => left - right);
  return sorted.length ? sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)] : undefined;
}

function metricChange(current, baseline, limitPercent) {
  if (!Number.isFinite(current) || !Number.isFinite(baseline) || baseline <= 0) {
    return { current: current ?? null, baseline: baseline ?? null, increasePercent: null, status: 'BLOCKED' };
  }
  const increasePercent = Number(((current / baseline - 1) * 100).toFixed(2));
  return { current, baseline, increasePercent, limitPercent, status: increasePercent <= limitPercent ? 'PASS' : 'FAIL' };
}

function collect(environmentResults) {
  const warm = environmentResults.flatMap((result) => result.warmNavigationMs?.samples ?? []);
  const search = environmentResults.flatMap((result) => result.localRepoSearchMs?.samples ?? []);
  const cold = environmentResults.map((result) => result.coldInteractiveReadyMs).filter(Number.isFinite);
  const memory = environmentResults.flatMap((result) => result.memory?.samples ?? []);
  return {
    coldP95: percentile(cold, 0.95),
    warmP95: percentile(warm, 0.95),
    searchP95: percentile(search, 0.95),
    hostPeakRss: memory.length ? Math.max(...memory.map((sample) => sample.extensionHostRssBytes)) : undefined,
    hostPeakHeap: memory.length ? Math.max(...memory.map((sample) => sample.extensionHostHeapUsedBytes)) : undefined,
    rendererPeakHeap: memory.length ? Math.max(...memory.map((sample) => sample.rendererHeapUsedBytes)) : undefined
  };
}

export function compareLiveBenchmarks(current, baseline, limitPercent = 10) {
  const identityMatches = current?.schema === 'GitLabWorkspaceLiveVerification/v1' &&
    baseline?.schema === 'GitLabWorkspaceLiveVerification/v1' && current.mode === 'benchmark' && baseline.mode === 'benchmark' &&
    current.fixture === baseline.fixture && current.fixture === 'load' && current.runId === baseline.runId &&
    current.vscodeVersion === baseline.vscodeVersion && current.testedArtifact?.sha256 !== baseline.testedArtifact?.sha256;
  if (!identityMatches) return { status: 'BLOCKED', reason: 'Baseline and revision must use distinct VSIX files, the same load run, benchmark tool, and VS Code version.' };

  const currentNames = [...new Set((current.environments ?? []).map((result) => result.environment))];
  const environments = currentNames.map((environment) => {
    const currentRuns = (current.environments ?? []).filter((item) => item.environment === environment);
    const baselineRuns = (baseline.environments ?? []).filter((item) => item.environment === environment);
    const result = currentRuns[0];
    const old = baselineRuns[0];
    const hasRequiredSamples = (runs) => runs.length === 10 && runs.every((run) =>
      (run.warmNavigationMs?.samples?.length ?? 0) === 30 && (run.localRepoSearchMs?.samples?.length ?? 0) === 30);
    const baselineHasOnlyMeasuredThresholdFailures = old?.status === 'FAIL' &&
      !(baseline.failures ?? []).some((failure) => failure.environment === environment);
    const baselineIsUsable = old?.status === 'PASS' || baselineHasOnlyMeasuredThresholdFailures;
    if (!old || result.version !== old.version || result.selectedGroup !== old.selectedGroup || result.status !== 'PASS' || !baselineIsUsable) {
      return { environment, status: 'BLOCKED', reason: 'The revision must PASS and the baseline must complete against the same GitLab version and Group; baseline test failures block comparison.' };
    }
    if (!hasRequiredSamples(currentRuns) || !hasRequiredSamples(baselineRuns)) {
      return { environment, status: 'BLOCKED', reason: 'Each side must contain 10 isolated cold sessions and 30 warm/search samples per session.' };
    }
    const currentMetrics = collect(currentRuns);
    const baselineMetrics = collect(baselineRuns);
    const metrics = {
      coldInteractiveP95: metricChange(currentMetrics.coldP95, baselineMetrics.coldP95, limitPercent),
      warmNavigationP95: metricChange(currentMetrics.warmP95, baselineMetrics.warmP95, limitPercent),
      localSearchP95: metricChange(currentMetrics.searchP95, baselineMetrics.searchP95, limitPercent),
      extensionHostPeakRss: metricChange(currentMetrics.hostPeakRss, baselineMetrics.hostPeakRss, limitPercent),
      extensionHostPeakHeap: metricChange(currentMetrics.hostPeakHeap, baselineMetrics.hostPeakHeap, limitPercent),
      rendererPeakHeap: metricChange(currentMetrics.rendererPeakHeap, baselineMetrics.rendererPeakHeap, limitPercent)
    };
    const statuses = Object.values(metrics).map((metric) => metric.status);
    return { environment, status: statuses.includes('FAIL') ? 'FAIL' : statuses.includes('BLOCKED') ? 'BLOCKED' : 'PASS', metrics };
  });
  const expectedEnvironments = new Set((baseline.environments ?? []).map((result) => result.environment));
  if (environments.length !== expectedEnvironments.size || environments.some((result) => !expectedEnvironments.has(result.environment))) {
    return { status: 'BLOCKED', reason: 'Baseline and revision environments do not match.', environments };
  }
  return { status: environments.some((result) => result.status === 'FAIL') ? 'FAIL' : environments.some((result) => result.status === 'BLOCKED') ? 'BLOCKED' : 'PASS', limitPercent, environments };
}
