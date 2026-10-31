import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const directory = path.join(path.dirname(fileURLToPath(import.meta.url)), 'evidence',
  process.argv.includes('--control') ? 'performance-large-lists-control' : 'performance-large-lists');
const raw = JSON.parse(await readFile(path.join(directory, 'results.json'), 'utf8'));
const quantile = (values, p) => { const sorted = [...values].sort((a, b) => a - b); return sorted[Math.ceil(sorted.length * p) - 1]; };
const stats = values => ({ n: values.length, p50Ms: values.length ? quantile(values, .5) : null,
  p95Ms: values.length >= 20 ? quantile(values, .95) : null, maxMs: values.length ? Math.max(...values) : null });
const keys = [...new Set(raw.cases.map(item => `${item.mode}:${item.count}`))];
const cases = keys.map(key => {
  const all = raw.cases.filter(item => `${item.mode}:${item.count}` === key), passed = all.filter(item => item.status === 'PASS');
  const first = all[0];
  return { mode: first.mode, count: first.count, rounds: all.length, passed: passed.length,
    errors: all.filter(item => item.status !== 'PASS').map(item => item.error),
    mountedRows: passed.map(item => item.dom.rowsMounted), totalDomNodes: passed.map(item => item.dom.totalDomNodes),
    listClientHeight: passed.map(item => item.dom.listClientHeight), pageClientHeight: passed.map(item => item.dom.pageClientHeight),
    navigationMs: stats(passed.map(item => item.navigateFeedbackMs)),
    searchNarrowMs: stats(passed.flatMap(item => item.searchNarrowMs)),
    searchResetMs: stats(passed.flatMap(item => item.searchResetMs)),
    pageScrollMs: stats(passed.flatMap(item => item.pageScrollMs)),
    heapAfterNavigationGcBytes: passed.map(item => item.heapAfterNavigation.usedSize),
    heapAfterInteractionsGcBytes: passed.map(item => item.heapAfterInteractions.usedSize),
    longTaskCount: passed.map(item => item.longTasks.length),
    maxLongTaskMs: passed.map(item => Math.max(0, ...item.longTasks.map(task => task.duration))),
    rendererMetrics: passed.map(item => item.rendererMetrics) };
});
const report = { schema: 'GitLabWorkspaceLargeListPerformanceSummary/v1', artifactSha256: raw.artifactSha256,
  browser: raw.browser, scope: raw.scope, method: raw.method,
  interpretation: 'Intra-run samples are correlated; p95 is withheld for fewer than 20 samples. GC heap is V8 heap in the shared test renderer, not process working set. Navigation and two-RAF timing are not network latency or actual keyboard input latency.', cases };
await writeFile(path.join(directory, 'summary.json'), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report, null, 2));
