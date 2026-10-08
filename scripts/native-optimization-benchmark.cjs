const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const { readFileSync } = require('node:fs');
const { createRequire } = require('node:module');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { performance } = require('node:perf_hooks');

const currentRoot = path.resolve(__dirname, '..');
const baselineIndex = process.argv.indexOf('--baseline-root');
if (baselineIndex < 0 || !process.argv[baselineIndex + 1]) throw new Error('Pass --baseline-root with an unpacked baseline extension.');
const baselineRoot = path.resolve(process.argv[baselineIndex + 1]);

function loadService(root) {
  const file = path.join(root, 'out/src/git/gitRepositoryService.js');
  const nativeRequire = createRequire(file), exports = {};
  vm.runInNewContext(readFileSync(file, 'utf8'), {
    exports, Buffer, process, setTimeout, clearTimeout,
    require: name => name === 'vscode' ? {} : name === './cloneService' ? {} : nativeRequire(name)
  }, { filename: file });
  return exports.GitRepositoryService.prototype;
}
function measureSummary(root) {
  const service = loadService(root);
  const rows = [0, 1000, 1_000_000].map(diffBytes => {
    const snapshot = { id: 'benchmark', name: 'Repo', path: 'C:/fixture/repo', branch: 'main', headCommit: 'a'.repeat(40),
      stagedCount: 1, unstagedCount: 1, conflictCount: 0, busy: false, branches: [], stashes: [], recoveryRefs: [],
      changes: [{ path: 'file.txt', section: 'unstaged', kind: 'modified' }], remotes: ['origin'],
      history: [{ hash: 'a'.repeat(40), parents: [], subject: 'Commit', author: 'Tester', date: '' }],
      historyHasMore: false, selectedCommit: { hash: 'a'.repeat(40) }, commitFiles: ['file.txt'], diffPath: 'file.txt', diffText: 'x'.repeat(diffBytes), revision: 1 };
    const context = { disposed: false, findRepository: () => ({}), revisionByRepository: new Map([[snapshot.id, snapshot.revision]]), cachedSummaries: [{ id: snapshot.id }], dirtySummaryIds: new Set([snapshot.id]) };
    service.rememberSummary.call(context, snapshot);
    return { diffBytes, summaryBytes: Buffer.byteLength(JSON.stringify(context.cachedSummaries[0])), keys: Object.keys(context.cachedSummaries[0]) };
  });
  return rows;
}
function makeIndex(count) {
  const header = Buffer.alloc(12); header.write('DIRC'); header.writeUInt32BE(2, 4); header.writeUInt32BE(count, 8);
  const entries = Array.from({ length: count }, (_, i) => {
    const name = Buffer.from('file-' + String(i).padStart(6, '0'));
    const fixed = Buffer.alloc(62); fixed.writeUInt32BE(0o100644, 24); fixed.fill(1, 40, 60); fixed.writeUInt16BE(name.length, 60);
    const entry = Buffer.concat([fixed, name, Buffer.alloc(1)]);
    return Buffer.concat([entry, Buffer.alloc((8 - entry.length % 8) % 8)]);
  });
  return Buffer.concat([header, ...entries, Buffer.alloc(20)]);
}
const p95 = values => [...values].sort((a, b) => a - b)[Math.ceil(values.length * 0.95) - 1];
async function measureFingerprint(root, fixture) {
  const { GitStateFingerprint } = require(path.join(root, 'out/src/git/gitStateFingerprint.js'));
  const initialCall = [], elapsed = [], callbackLatency = [];
  let responsiveReads = 0;
  for (let sample = 0; sample < 10; sample++) {
    const fingerprint = new GitStateFingerprint();
    const started = performance.now();
    let callbackRan = false;
    const callback = new Promise(resolve => setImmediate(() => { callbackRan = true; callbackLatency.push(performance.now() - started); resolve(); }));
    const result = fingerprint.read(fixture, { head: 'a'.repeat(40) }, []);
    initialCall.push(performance.now() - started);
    await result;
    if (callbackRan) responsiveReads++;
    elapsed.push(performance.now() - started);
    await callback;
  }
  return { samples: 10, indexEntries: 20_000, initialCallP95Ms: p95(initialCall), completionP95Ms: p95(elapsed),
    nativeCallbackLatencyP95Ms: p95(callbackLatency), readsAllowingCallbackBeforeCompletion: responsiveReads };
}
(async () => {
  const tempRoot = await fs.realpath(os.tmpdir());
  const fixture = await fs.mkdtemp(path.join(tempRoot, 'glw-native-benchmark-'));
  try {
    await fs.mkdir(path.join(fixture, '.git'));
    await fs.writeFile(path.join(fixture, '.git/index'), makeIndex(20_000));
    await fs.writeFile(path.join(fixture, '.git/HEAD'), 'ref: refs/heads/main\n');
    const baselineSummary = measureSummary(baselineRoot), currentSummary = measureSummary(currentRoot);
    assert.equal(currentSummary[0].summaryBytes, currentSummary[2].summaryBytes);
    assert.equal(currentSummary[2].keys.includes('diffText'), false);
    const baselineFingerprint = await measureFingerprint(baselineRoot, fixture);
    const currentFingerprint = await measureFingerprint(currentRoot, fixture);
    assert.equal(currentFingerprint.readsAllowingCallbackBeforeCompletion, 10);
    process.stdout.write(JSON.stringify({ schema: 'GitLabWorkspaceNativeOptimizationBenchmark/v1', measuredAt: new Date().toISOString(),
      environment: { node: process.version, platform: process.platform },
      methodology: 'Same process, temporary repository and 20,000-entry index; ten cold fingerprint samples per version. Completion time includes cooperative yields and is reported separately from event-loop blocking. Summary bytes use the production rememberSummary method.',
      summary: { baseline: baselineSummary, current: currentSummary }, fingerprint: { baseline: baselineFingerprint, current: currentFingerprint },
      limits: ['This targeted benchmark complements the real Extension Host/GitLab benchmarks; it does not establish an end-to-end performance guarantee.'] }, null, 2) + '\n');
  } finally {
    const target = await fs.realpath(fixture);
    if (path.dirname(target) !== tempRoot || !path.basename(target).startsWith('glw-native-benchmark-')) throw new Error('Unsafe benchmark cleanup path.');
    await fs.rm(target, { recursive: true, force: true });
  }
})().catch(error => { process.stderr.write(error.stack + '\n'); process.exitCode = 1; });
