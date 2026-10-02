const { performance } = require('node:perf_hooks');
const { projectFolderNames, groupRepositoryPath } = require('../out/src/workspace/workspacePaths.js');
const { GitLabReadCache } = require('../out/src/api/gitLabReadCache.js');

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
    if ((foldedCounts.get(project.path.toLocaleLowerCase('en-US')) ?? 0) > 1) candidate = `${project.path}--${project.id}`;
    const key = candidate.toLocaleLowerCase('en-US');
    if (fixed.has(key) && candidate !== project.path) candidate = `${candidate}--${project.id}`;
    let unique = candidate;
    let suffix = 2;
    while ([...result.values()].some((existing) => existing.toLocaleLowerCase('en-US') === unique.toLocaleLowerCase('en-US'))) {
      unique = `${candidate}--${suffix++}`;
    }
    result.set(project.id, unique);
  }
  return result;
}

const projects = Array.from({ length: 500 }, (_, index) => ({
  id: index + 1, path: `repo-${index}`, path_with_namespace: `team/repo-${index}`,
  name: `Repository ${index}`, web_url: `https://gitlab.example.test/team/repo-${index}`
}));
const root = 'C:/workspace/team';
const oldBatch = () => projects.map((project) => groupRepositoryPath(root, project, projects, legacyProjectFolderNames(projects)));
const newBatch = () => {
  const folders = projectFolderNames(projects);
  return projects.map((project) => groupRepositoryPath(root, project, projects, folders));
};
const median = (values) => [...values].sort((left, right) => left - right)[Math.floor(values.length / 2)];

oldBatch();
newBatch();
const oldRuns = [];
const newRuns = [];
for (let run = 0; run < 5; run++) {
  let started = performance.now();
  oldBatch();
  oldRuns.push(performance.now() - started);
  started = performance.now();
  newBatch();
  newRuns.push(performance.now() - started);
}

async function measureSharedReads() {
  const cache = new GitLabReadCache(60_000, 256);
  let apiRequests = 0;
  const consumers = Array.from({ length: 8 }, () => cache.get('group/3/projects', async () => {
    apiRequests++;
    return projects;
  }));
  await Promise.all(consumers);
  return { concurrentConsumers: consumers.length, apiRequests, avoidedRequests: consumers.length - apiRequests };
}

function measureTimerTransport() {
  const timer = [{ id: 'timer-1', projectId: 1, projectPath: 'team/repo-0', issueIid: 1, title: 'Issue 1', elapsedSeconds: 30, phase: 'running', summary: '', updatedAt: 1_000 }];
  const issues = Array.from({ length: 1_000 }, (_, index) => ({
    id: index + 1, iid: index + 1, project_id: index % 500 + 1, title: `Issue ${index + 1}`,
    description: 'Synthetic issue description for transport sizing. '.repeat(5), state: 'opened', labels: ['performance']
  }));
  const nodes = Array.from({ length: 500 }, (_, index) => ({
    id: `project:${index + 1}:issue:${index + 1}`, sourceIds: [`REST:Issue:${index + 1}`], kind: 'issue',
    namespacePath: `team/repo-${index}`, projectPath: `team/repo-${index}`, projectId: index + 1, iid: String(index + 1),
    title: `Graph issue ${index + 1}`, state: 'opened', labels: [{ name: 'performance', color: '#3282b8' }],
    assignees: [], boardIds: [1], assignedToMe: true, isRoot: true, relationsStatus: 'ready'
  }));
  const graph = {
    connectedScope: 'synthetic-scope', status: 'ready', roots: nodes.map((node) => node.id), nodes,
    edges: nodes.slice(1).map((node, index) => ({ id: `relates_to:${nodes[index].id}:${node.id}`, source: nodes[index].id, target: node.id, type: 'relates_to' })),
    boardIssueIds: { 1: issues.map((issue) => issue.id) }, boardStatus: { 1: { status: 'ready' } }, errors: [], updatedAt: 1_000
  };
  const snapshotMessage = {
    type: 'snapshot', snapshot: {
      connected: true, currentUser: { id: 7, username: 'synthetic', name: 'Synthetic User' }, groups: [],
      group: { id: 3, name: 'Team', full_path: 'team', web_url: '' }, groupRoot: root, projects,
      groupMilestones: [], groupIssueBoards: [], issueGraph: graph, issueGraphVersion: 1,
      localRepositories: {}, issues, mergeRequests: [], activeMode: 'developer', connectedScope: 'synthetic-scope',
      instanceUserScope: 'synthetic-user', projectMembers: [], timers: timer, timerVersion: 30,
      tools: [], toolSource: 'gitea', deliveryRecords: []
    }
  };
  const timerDelta = { type: 'timersChanged', instanceUserScope: 'synthetic-user', version: 31, timers: timer };
  const graphDelta = { type: 'issueGraphChanged', connectedScope: 'synthetic-scope', version: 2, graph };
  const fullBytes = Buffer.byteLength(JSON.stringify(snapshotMessage));
  const deltaBytes = Buffer.byteLength(JSON.stringify(timerDelta));
  const graphBytes = Buffer.byteLength(JSON.stringify(graphDelta));
  return {
    ticks: 30,
    fullSnapshotBytes: fullBytes,
    timerDeltaBytes: deltaBytes,
    fullSnapshotBytesFor30Ticks: fullBytes * 30,
    timerDeltaBytesFor30Ticks: deltaBytes * 30,
    timerByteReductionPercent: Number(((1 - deltaBytes / fullBytes) * 100).toFixed(2)),
    graphDeltaBytes: graphBytes,
    graphDeltaReductionPercent: Number(((1 - graphBytes / fullBytes) * 100).toFixed(2))
  };
}

measureSharedReads().then((sharedReads) => {
  const oldMedianMs = median(oldRuns);
  const newMedianMs = median(newRuns);
  process.stdout.write(`${JSON.stringify({
    workload: { projects: 500, issues: 1_000, graphNodes: 500 },
    repoPathNaming: {
      oldMedianMs: Number(oldMedianMs.toFixed(2)), newMedianMs: Number(newMedianMs.toFixed(2)),
      reductionPercent: Number(((1 - newMedianMs / oldMedianMs) * 100).toFixed(2)),
      oldRunsMs: oldRuns.map((value) => Number(value.toFixed(2))),
      newRunsMs: newRuns.map((value) => Number(value.toFixed(2)))
    },
    sharedReadCache: sharedReads,
    timerTransport: measureTimerTransport()
  }, null, 2)}\n`);
}).catch((error) => {
  process.stderr.write(`${error.stack ?? error}\n`);
  process.exitCode = 1;
});
