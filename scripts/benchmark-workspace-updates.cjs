const assert = require('node:assert/strict');
const { AsyncLocalStorage } = require('node:async_hooks');
const { mkdirSync, writeFileSync } = require('node:fs');
const path = require('node:path');
const { performance } = require('node:perf_hooks');
const Module = require('node:module');

const options = Object.fromEntries(process.argv.slice(2).reduce((pairs, value, index, values) => {
  if (value.startsWith('--')) pairs.push([value.slice(2), values[index + 1]]);
  return pairs;
}, []));
if (!options['baseline-out'] || !options.output) throw new Error('Use --baseline-out <compiled baseline/out> --current-out <compiled out> --output <JSON>');
const load = root => {
  const original = Module._load;
  Module._load = function (name, ...args) { return name === 'vscode' ? {} : original.call(this, name, ...args); };
  try { return require(path.resolve(root, 'src/workspace/workspacePanel.js')).WorkspacePanel; }
  finally { Module._load = original; }
};
const baseline = load(options['baseline-out']), current = load(options['current-out'] ?? 'out');
const percentile = values => [...values].sort((a, b) => a - b)[Math.ceil(values.length * .95) - 1];
const round = value => Math.round(value * 1000) / 1000;

function fixture(Panel, repos, issues) {
  const root = 'C:/fixture/team';
  const projects = Array.from({ length: repos }, (_, index) => ({ id: index + 1, name: `repo-${index}`, path: `repo-${index}`,
    path_with_namespace: `team/repo-${index}`, http_url_to_repo: `https://gitlab.invalid/team/repo-${index}.git`, web_url: '' }));
  const inventory = projects.map(project => ({ name: project.name, path: `${root}/${project.path}`, remotes: [project.http_url_to_repo] }));
  const host = Object.create(Panel.prototype), messages = [];
  const notifications = { sessionId: 'benchmark', revision: 0, items: [], unreadCount: 0 };
  const skills = { mode: 'group', root, revision: 'fixed', repositories: inventory, availableFeatures: [], installed: { status: 'missing' } };
  const policy = { allowed: true, mode: 'group' };
  Object.assign(host, {
    disposed: false, panel: { visible: true }, webviewReady: true, projectContext: { root, revision: 'root-1' },
    session: { baseUrl: 'https://gitlab.invalid', activeAccountId: 'fixture', connectionEpoch: 1,
      selectedGroup: { id: 1, full_path: 'team' }, accounts: [], instanceWarnings: [], capabilityDiagnostics: [] },
    currentUser: { id: 7 }, localWorkspaceRepositories: inventory, projects,
    actualRepositories: inventory.map(({ name, path }) => ({ name, path })), actualRepositoryScanStatus: 'ready', actualRepositoriesRoot: root,
    workspaceSections: { projects: { status: 'ready' }, issues: { status: 'ready' } }, groupMilestones: [], groupIssueBoards: [],
    issues: Array.from({ length: issues }, (_, i) => ({ id: i + 1, iid: i + 1, project_id: i % repos + 1, title: `Issue ${i}`, description: 'Fixture text. '.repeat(20), state: 'opened', labels: [] })),
    mergeRequests: [], projectMembers: [], workflowKitPackages: [], activeMode: 'clone',
    workflowKitInstallTarget: { manual: false, state: { status: 'missing' } },
    notificationCenter: { snapshot: () => notifications, publishState: () => {}, publish: () => {} },
    operationTracker: { sessionId: 'benchmark', list: () => [], get: () => undefined,
      snapshot: () => ({ sessionId: 'benchmark', revision: 0, operations: [] }) },
    operationContextStorage: new AsyncLocalStorage(), timer: { list: () => [] },
    getSkillsContext: () => skills, getWorkflowKitPolicy: () => policy, workflowKitSource: () => 'bundled',
    post: message => messages.push({ type: message.type, bytes: Buffer.byteLength(JSON.stringify(message)) })
  });
  return { host, messages };
}

function measure(Panel, repos, issues, samples) {
  const { host, messages } = fixture(Panel, repos, issues);
  const start = performance.now(); host.sendSnapshot(); const firstMs = performance.now() - start;
  const firstBytes = messages.reduce((n, item) => n + item.bytes, 0); messages.length = 0;
  const times = [];
  for (let i = 0; i < samples; i++) {
    host.selectedProjectId = i % repos + 1;
    const began = performance.now(); host.sendSnapshot(); times.push(performance.now() - began);
  }
  const bytes = messages.reduce((n, item) => n + item.bytes, 0);
  return { firstSnapshotMs: round(firstMs), firstSnapshotBytes: firstBytes, samples: times.map(round),
    updateP95Ms: samples >= 20 ? round(percentile(times)) : null, updateMaxMs: round(Math.max(...times)), updateBytes: bytes, messageCount: messages.length,
    snapshotMessages: messages.filter(item => item.type === 'snapshot').length,
    patchMessages: messages.filter(item => item.type === 'snapshotPatch').length };
}

const workloads = [[50, 100], [500, 1000], [2000, 10000]].map(([repos, issues]) => {
  const samples = repos > 500 ? 3 : 30;
  if (global.gc) global.gc();
  const before = measure(baseline, repos, issues, samples);
  if (global.gc) global.gc();
  const after = measure(current, repos, issues, samples);
  assert.equal(after.snapshotMessages, 0); assert.equal(after.patchMessages, samples);
  assert.ok(after.updateBytes < before.updateBytes / 10);
  console.log(`${repos} Repo / ${issues} Issue: update max ${before.updateMaxMs} -> ${after.updateMaxMs} ms; bytes ${before.updateBytes} -> ${after.updateBytes}`);
  return { repos, issues, sampleCount: samples, baseline: before, revision: after, transferReductionPercent: round((1 - after.updateBytes / before.updateBytes) * 100),
    ...(samples < 20 ? { limitation: 'Three stress samples bound the expensive legacy work; no p95 is reported for this workload.' } : {}) };
});
const report = { schema: 'GitLabWorkspaceSnapshotBenchmark/v1', measuredAt: new Date().toISOString(), node: process.version,
  methodology: 'Production WorkspacePanel.sendSnapshot, fixed same-scope local inventory, real JSON serialization; 30 selection updates for daily/medium workloads and three bounded stress updates. The Skills context is pinned to isolate workspace updates. No VS Code bridge, renderer, disk or GitLab network is measured.', workloads };
mkdirSync(path.dirname(path.resolve(options.output)), { recursive: true });
writeFileSync(options.output, JSON.stringify(report, null, 2) + '\n');
