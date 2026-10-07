const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const { performance } = require('node:perf_hooks');
const CODE_ROOT = path.resolve(process.env.GLW_BENCHMARK_CODE_ROOT || path.join(__dirname, '..'));
const { projectFolderNames, groupRepositoryPath } = require(path.join(CODE_ROOT, 'out/src/workspace/workspacePaths.js'));
const { GitLabReadCache } = require(path.join(CODE_ROOT, 'out/src/api/gitLabReadCache.js'));
const { buildCapabilityQuery, buildFollowupTypeNames, buildInitialTypeNames, mergeCapabilityTypes } = require(path.join(CODE_ROOT, 'out/src/api/graphqlCapabilities.js'));
const { createIssueGraphPatch, applyIssueGraphPatch } = require(path.join(CODE_ROOT, 'out/src/workspace/issueGraph.js'));
const { virtualWindow } = require(path.join(CODE_ROOT, 'out/src/webview/virtualWindow.js'));

function legacyProjectFolderNames(projects) {
  const foldedCounts = new Map();
  for (const project of projects) {
    const key = project.path.toLocaleLowerCase('en-US');
    foldedCounts.set(key, (foldedCounts.get(key) ?? 0) + 1);
  }
  const fixed = new Set(projects
    .filter((project) => (foldedCounts.get(project.path.toLocaleLowerCase('en-US')) ?? 0) === 1)
    .map((project) => project.path.toLocaleLowerCase('en-US')));
  const result = new Map();
  for (const project of projects) {
    let candidate = project.path;
    if ((foldedCounts.get(project.path.toLocaleLowerCase('en-US')) ?? 0) > 1) candidate = candidate + '--' + project.id;
    const key = candidate.toLocaleLowerCase('en-US');
    if (fixed.has(key) && candidate !== project.path) candidate = candidate + '--' + project.id;
    let unique = candidate;
    let suffix = 2;
    while ([...result.values()].some((existing) => existing.toLocaleLowerCase('en-US') === unique.toLocaleLowerCase('en-US'))) {
      unique = candidate + '--' + suffix++;
    }
    result.set(project.id, unique);
  }
  return result;
}

function makeProjects(count) {
  return Array.from({ length: count }, (_, index) => ({
    id: index + 1, path: 'repo-' + index, path_with_namespace: 'team/repo-' + index,
    name: 'Repository ' + index, web_url: 'https://gitlab.example.test/team/repo-' + index
  }));
}

function elapsed(operation) {
  const started = performance.now();
  operation();
  return performance.now() - started;
}

function median(values) {
  return [...values].sort((left, right) => left - right)[Math.floor(values.length / 2)];
}

function percentile(values, fraction) {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)];
}

function measureFolderPaths(count, samples) {
  const projects = makeProjects(count);
  const root = 'C:/workspace/team';
  const oldRuns = [];
  const newRuns = [];
  for (let run = 0; run < samples; run++) {
    if (count <= 500) oldRuns.push(elapsed(() => projects.map((project) =>
      groupRepositoryPath(root, project, projects, legacyProjectFolderNames(projects)))));
    newRuns.push(elapsed(() => {
      const folders = projectFolderNames(projects);
      projects.map((project) => groupRepositoryPath(root, project, projects, folders));
    }));
  }
  const oldMedian = oldRuns.length ? median(oldRuns) : undefined;
  const newMedian = median(newRuns);
  return {
    projects: count,
    samples,
    legacyMedianMs: oldMedian === undefined ? null : Number(oldMedian.toFixed(2)),
    productionMedianMs: Number(newMedian.toFixed(2)),
    elapsedReductionPercent: oldMedian === undefined ? null : Number(((1 - newMedian / oldMedian) * 100).toFixed(2)),
    legacyComparisonSkipped: count > 500 ? 'The legacy per-repository full remap is cubic for this workload; current production path is still measured at 2,000 Repos.' : undefined,
    legacyRunsMs: oldRuns.map((value) => Number(value.toFixed(2))),
    productionRunsMs: newRuns.map((value) => Number(value.toFixed(2)))
  };
}

async function measureCache(count) {
  const projects = makeProjects(count);
  const responseBytes = Buffer.byteLength(JSON.stringify(projects));
  const iterations = 1_000;
  const coldRuns = [];
  const warmRuns = [];
  let requests = 0;
  const load = async () => { requests++; return projects; };
  for (let iteration = 0; iteration < iterations; iteration++) {
    const cache = new GitLabReadCache(60_000, 256);
    const coldStarted = performance.now();
    await Promise.all(Array.from({ length: 8 }, () => cache.get('group/3/projects', load)));
    coldRuns.push(performance.now() - coldStarted);
    const warmStarted = performance.now();
    await Promise.all(Array.from({ length: 8 }, () => cache.get('group/3/projects', load)));
    warmRuns.push(performance.now() - warmStarted);
  }
  assert.equal(requests, iterations, 'each cold iteration coalesces concurrent readers into one loader call');
  return {
    iterations, concurrentConsumers: 8,
    legacyUnsharedApiRequestsPerRead: 8,
    productionApiRequestsPerRead: requests / iterations,
    coldLatencyMs: Number((coldRuns.reduce((sum, value) => sum + value, 0) / iterations).toFixed(3)),
    coldP95Ms: Number(percentile(coldRuns, 0.95).toFixed(3)),
    warmLatencyMs: Number((warmRuns.reduce((sum, value) => sum + value, 0) / iterations).toFixed(3)),
    warmP95Ms: Number(percentile(warmRuns, 0.95).toFixed(3)),
    responsePayloadBytes: responseBytes,
    warmNetworkBytes: 0
  };
}

function makeGraph(nodeCount, issueCount) {
  const projects = makeProjects(nodeCount);
  const nodes = Array.from({ length: nodeCount }, (_, index) => ({
    id: 'project:' + (index + 1) + ':issue:' + (index + 1),
    sourceIds: ['REST:Issue:' + (index + 1)], kind: 'issue', namespacePath: projects[index].path_with_namespace,
    projectPath: projects[index].path_with_namespace, projectId: index + 1, iid: String(index + 1),
    title: 'Graph issue ' + (index + 1), state: 'opened',
    labels: [{ name: 'performance', color: '#3282b8' }], assignees: [], boardIds: [1],
    assignedToMe: true, isRoot: true, relationsStatus: 'ready'
  }));
  const issues = Array.from({ length: issueCount }, (_, index) => ({
    id: index + 1, iid: index + 1, project_id: index % Math.max(1, nodeCount) + 1,
    title: 'Issue ' + (index + 1), description: 'Synthetic issue description for transport sizing. '.repeat(3),
    state: 'opened', labels: ['performance']
  }));
  return {
    connectedScope: 'synthetic-scope', status: 'ready', roots: nodes.map((node) => node.id), nodes,
    edges: nodes.slice(1).map((node, index) => ({ id: 'relates_to:' + nodes[index].id + ':' + node.id, source: nodes[index].id, target: node.id, type: 'relates_to' })),
    boardIssueIds: { 1: issues.map((issue) => issue.id) }, boardStatus: { 1: { status: 'ready' } }, errors: [], updatedAt: 1_000
  };
}

async function measureGraph(nodeCount, issueCount) {
  let previous = makeGraph(nodeCount, issueCount);
  if (global.gc) global.gc();
  const initialHeapBytes = process.memoryUsage().heapUsed;
  let peakSampledHeapBytes = initialHeapBytes;
  const fullBytesPerUpdate = [];
  const patchBytesPerUpdate = [];
  const patchDurations = [];
  let changedNodeCount = 0;
  for (let tick = 0; tick < 30; tick++) {
    const index = tick % nodeCount;
    const nodes = previous.nodes.slice();
    nodes[index] = { ...nodes[index], title: nodes[index].title + ' *' };
    const next = { ...previous, nodes, updatedAt: previous.updatedAt + 100 };
    const started = performance.now();
    const patch = createIssueGraphPatch(previous, next);
    patchDurations.push(performance.now() - started);
    const fullMessage = { type: 'issueGraphChanged', connectedScope: next.connectedScope, version: tick + 2, graph: next };
    const deltaMessage = { type: 'issueGraphPatch', version: tick + 2, ...patch };
    fullBytesPerUpdate.push(Buffer.byteLength(JSON.stringify(fullMessage)));
    patchBytesPerUpdate.push(Buffer.byteLength(JSON.stringify(deltaMessage)));
    changedNodeCount += patch.upsertNodes.length;
    if (tick === 0) assert.deepEqual(applyIssueGraphPatch(previous, patch), next);
    previous = next;
    await new Promise((resolve) => setImmediate(resolve));
    peakSampledHeapBytes = Math.max(peakSampledHeapBytes, process.memoryUsage().heapUsed);
  }
  const fullBytes = fullBytesPerUpdate.reduce((total, value) => total + value, 0);
  const patchBytes = patchBytesPerUpdate.reduce((total, value) => total + value, 0);
  const windowOffsets = new Array(issueCount + 1);
  windowOffsets[0] = 0;
  for (let index = 0; index < issueCount; index++) windowOffsets[index + 1] = windowOffsets[index] + 44 + index % 3 * 12;
  const listWindow = virtualWindow(issueCount, windowOffsets, Math.floor(windowOffsets.at(-1) / 2), 640);
  const afterHeapBytes = process.memoryUsage().heapUsed;
  return {
    nodes: nodeCount, issues: issueCount, updates: 30,
    fullGraphTransportBytes: fullBytes,
    incrementalGraphTransportBytes: patchBytes,
    graphTransportReductionPercent: Number(((1 - patchBytes / fullBytes) * 100).toFixed(2)),
    averageChangedNodesPerUpdate: Number((changedNodeCount / 30).toFixed(2)),
    patchBuildMedianMs: Number(median(patchDurations).toFixed(3)),
    issueRowsAtMidScroll: { total: issueCount, mounted: listWindow.end - listWindow.start, range: [listWindow.start, listWindow.end] },
    heapUsedBeforeBytes: initialHeapBytes,
    heapUsedAfterBytes: afterHeapBytes,
    peakSampledHeapBytes,
    peakSampledHeapDeltaBytes: peakSampledHeapBytes - initialHeapBytes
  };
}

async function run() {
  if (global.gc) global.gc();
  const heapBeforeBytes = process.memoryUsage().heapUsed;
  const folderPaths = [
    measureFolderPaths(50, 5),
    measureFolderPaths(500, 5),
    measureFolderPaths(2_000, 3)
  ];
  const cache = await measureCache(1_000);
  const graphWorkloads = [
    await measureGraph(50, 100),
    await measureGraph(500, 1_000),
    await measureGraph(2_000, 10_000)
  ];
  const capabilityFixture = JSON.parse(readFileSync(path.join(CODE_ROOT, 'test/fixtures/gitlab-ce-16.11.10-capabilities.json'), 'utf8'));
  const initialNames = buildInitialTypeNames();
  const fixtureTypes = capabilityFixture.types;
  const fixtureTypeMap = new Map(fixtureTypes.map((type) => [type.name, type]));
  const initialTypes = initialNames.flatMap((name) => fixtureTypeMap.has(name) ? [fixtureTypeMap.get(name)] : []);
  const firstFollowupNames = buildFollowupTypeNames(mergeCapabilityTypes(initialTypes));
  const firstFollowupTypes = firstFollowupNames.flatMap((name) => fixtureTypeMap.has(name) ? [fixtureTypeMap.get(name)] : []);
  const secondSchema = mergeCapabilityTypes(initialTypes, firstFollowupTypes);
  const nestedNames = buildFollowupTypeNames(secondSchema).filter((name) => !secondSchema.has(name));
  const probeBatches = [initialNames, firstFollowupNames, nestedNames].filter((names) => names.length > 0);
  const probeRequestBytes = probeBatches.map((names) => Buffer.byteLength(JSON.stringify({ query: buildCapabilityQuery(names), variables: {} })));
  const legacySchemaQuery = 'query IssueCapabilities { __schema { types { name fields { name type { name kind ofType { name kind ofType { name kind } } } args { name type { name kind ofType { name kind ofType { name kind } } } } } inputFields { name type { name kind ofType { name kind ofType { name kind } } } } } } }';
  if (global.gc) global.gc();
  process.stdout.write(JSON.stringify({
    environment: { platform: process.platform, node: process.version, gcExposed: !!global.gc, measuredAt: new Date().toISOString() },
    methodology: 'Synthetic benchmark of production helpers; no live GitLab requests, VS Code webview, or real repository folders are included.',
    workloads: { small: { repos: 50, issues: 100, graphNodes: 50 }, primary: { repos: 500, issues: 1_000, graphNodes: 500 }, stress: { repos: 2_000, issues: 10_000, graphNodes: 2_000 } },
    repositoryPathNaming: folderPaths,
    sharedReadCache: cache,
    graphAndVirtualList: graphWorkloads,
    capabilityProbe: {
      sourceFixture: capabilityFixture.sourceTag,
      targetedTypesPerInitialProbe: initialNames.length,
      legacyRequestBytes: Buffer.byteLength(JSON.stringify({ query: legacySchemaQuery, variables: {} })),
      targetedProbeBatches: probeBatches.length,
      targetedTypesRequested: probeBatches.reduce((total, names) => total + names.length, 0),
      targetedRequestBytesByBatch: probeRequestBytes,
      targetedRequestBytesTotal: probeRequestBytes.reduce((total, bytes) => total + bytes, 0),
      fullSchemaResponseBytes: null,
      targetedResponseBytes: null,
      responseReductionPercent: null,
      measurementLimit: 'The pinned fixture is a minimal capability contract, not a full schema export. An authenticated CE 16.11.10 instance is required to measure response transfer reduction; request bytes alone are not a substitute.'
    },
    heapUsedBeforeBytes: heapBeforeBytes,
    heapUsedAfterBytes: process.memoryUsage().heapUsed
  }, null, 2) + '\n');
}

run().catch((error) => {
  process.stderr.write(String(error && error.stack || error) + '\n');
  process.exitCode = 1;
});
