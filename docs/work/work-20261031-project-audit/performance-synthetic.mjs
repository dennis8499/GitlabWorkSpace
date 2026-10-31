import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../../..');
const evidence = path.join(here, 'evidence', 'performance-synthetic');
const exec = promisify(execFile);
const median = values => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
const rounds = Number(process.argv[2] ?? 5);
if (!Number.isInteger(rounds) || rounds < 1 || rounds > 10) throw new Error('rounds must be 1–10');
await mkdir(evidence, { recursive: true });
const artifact = path.join(root, 'dist/gitlab-workspace-0.37.3.vsix');
const sha256 = createHash('sha256').update(await readFile(artifact)).digest('hex');
const { stdout: commit } = await exec('git', ['rev-parse', 'HEAD'], { cwd: root, windowsHide: true });
const runs = [];
for (let round = 1; round <= rounds; round++) {
  console.log(`Synthetic production-helper run ${round}/${rounds}`);
  const { stdout, stderr } = await exec(process.execPath, ['--expose-gc', path.join(root, 'scripts/performance-benchmark.cjs')],
    { cwd: root, windowsHide: true, maxBuffer: 20 * 1024 * 1024 });
  if (stderr.trim()) await writeFile(path.join(evidence, `run-${round}-stderr.log`), stderr);
  await writeFile(path.join(evidence, `run-${round}.json`), stdout);
  runs.push(JSON.parse(stdout));
}
const workloads = runs[0].graphAndVirtualList.map((item, i) => ({
  repos: runs[0].repositoryPathNaming[i].projects,
  issues: item.issues,
  nodes: item.nodes,
  namingProductionMedianOfRunMediansMs: median(runs.map(r => r.repositoryPathNaming[i].productionMedianMs)),
  patchBuildMedianOfRunMediansMs: median(runs.map(r => r.graphAndVirtualList[i].patchBuildMedianMs)),
  peakSampledHeapBytesMedian: median(runs.map(r => r.graphAndVirtualList[i].peakSampledHeapBytes)),
  peakSampledHeapDeltaBytesMedian: median(runs.map(r => r.graphAndVirtualList[i].peakSampledHeapDeltaBytes)),
  fullGraphTransportBytes: item.fullGraphTransportBytes,
  incrementalGraphTransportBytes: item.incrementalGraphTransportBytes,
  transportReductionPercent: item.graphTransportReductionPercent,
  mountedIssueRowsAtMidScroll: item.issueRowsAtMidScroll.mounted
}));
const report = { schema: 'GitLabWorkspaceProductionHelperAudit/v1', generatedAt: new Date().toISOString(),
  commit: commit.trim(), artifactSha256: sha256, rounds,
  system: { platform: os.platform(), release: os.release(), arch: os.arch(), cpu: os.cpus()[0]?.model,
    logicalCpus: os.cpus().length, totalMemoryBytes: os.totalmem(), node: process.version },
  methodology: 'Production helpers executed in isolated Node processes with synthetic data. No real GitLab, VS Code Extension Host, renderer, Git or file-system repositories. Medians across only five rounds are descriptive, not p95. Cache runs each contain 1000 iterations.',
  workloads,
  cache: { coldP95MsMedianAcrossRuns: median(runs.map(r => r.sharedReadCache.coldP95Ms)),
    warmP95MsMedianAcrossRuns: median(runs.map(r => r.sharedReadCache.warmP95Ms)),
    coldApiRequestsPerRead: runs[0].sharedReadCache.productionApiRequestsPerRead,
    warmNetworkBytes: runs[0].sharedReadCache.warmNetworkBytes },
  capabilityProbe: runs[0].capabilityProbe };
await writeFile(path.join(evidence, 'summary.json'), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report, null, 2));
