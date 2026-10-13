// Command-count acceptance benchmark. Git and VS Code output is mocked; no live latency is measured.
// node scripts/benchmark-git-summary.cjs --baseline-vsix <old.vsix> --revision-vsix <new.vsix> [--output <evidence.json>]
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const fs = require('node:fs/promises');
const { readFileSync } = require('node:fs');
const { createRequire } = require('node:module');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const yauzl = require('yauzl'); // Existing, locked @vscode/vsce dependency.

const ROOT = path.resolve(__dirname, '..');
const REPOSITORIES = 20;
function option(name) { const index = process.argv.indexOf(name); return index < 0 ? undefined : process.argv[index + 1]; }
const baselinePath = option('--baseline-vsix');
if (!baselinePath) throw new Error('Pass --baseline-vsix <old.vsix>; add --revision-vsix <new.vsix> for comparison evidence.');
const revisionPath = option('--revision-vsix');
const outputPath = path.resolve(option('--output') || path.join(ROOT, 'docs/work/work-20261013-skills-ux/evidence/git-summary-commands.json'));
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

async function extractCode(bytes, destination) {
  await fs.mkdir(destination);
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(bytes, { lazyEntries: true }, (error, archive) => {
      if (error) return reject(error);
      const seen = new Set();
      let totalBytes = 0;
      const fail = error => { archive.close(); reject(error); };
      archive.on('error', fail);
      archive.on('end', resolve);
      archive.on('entry', entry => {
        if (entry.fileName !== 'extension/package.json' && !/^extension\/out\/src\/.+\.js$/.test(entry.fileName)) {
          archive.readEntry(); return;
        }
        const relative = entry.fileName.slice('extension/'.length);
        const target = path.resolve(destination, relative);
        totalBytes += entry.uncompressedSize;
        if (!target.startsWith(destination + path.sep) || seen.has(relative) || totalBytes > 128 * 1024 * 1024) {
          fail(new Error('Unsafe or oversized compiled VSIX entry.')); return;
        }
        seen.add(relative);
        archive.openReadStream(entry, (error, stream) => {
          if (error) return fail(error);
          const chunks = [];
          stream.on('error', fail);
          stream.on('data', chunk => chunks.push(chunk));
          stream.on('end', () => {
            void fs.mkdir(path.dirname(target), { recursive: true }).then(() => fs.writeFile(target, Buffer.concat(chunks)))
              .then(() => archive.readEntry(), fail);
          });
        });
      });
      archive.readEntry();
    });
  });
}

class Emitter {
  listeners = new Set();
  event = listener => { this.listeners.add(listener); return { dispose: () => this.listeners.delete(listener) }; };
  fire(value) { for (const listener of this.listeners) listener(value); }
  dispose() { this.listeners.clear(); }
}

function loadService(extensionRoot, api) {
  const file = path.join(extensionRoot, 'out/src/git/gitRepositoryService.js');
  const nativeRequire = createRequire(file), exports = {};
  const extension = { enabled: true, getAPI: () => api, onDidChangeEnablement: new Emitter().event };
  const vscode = { EventEmitter: Emitter, workspace: { textDocuments: [] },
    extensions: { getExtension: () => ({ isActive: true, exports: extension }) } };
  vm.runInNewContext(readFileSync(file, 'utf8'), {
    exports, Buffer, process, setTimeout, clearTimeout,
    require: name => name === 'vscode' ? vscode : name === './cloneService' ? {} :
      name === 'node:child_process' ? { execFile() { throw new Error('Real Git disabled in command benchmark.'); },
        spawn() { throw new Error('Real Git disabled in command benchmark.'); } } : nativeRequire(name)
  }, { filename: file });
  return exports.GitRepositoryService;
}

async function measure(vsixPath, temporary, label) {
  const absolute = path.resolve(vsixPath), bytes = await fs.readFile(absolute);
  const extensionRoot = path.join(temporary, label + '-extension');
  await extractCode(bytes, extensionRoot);
  const manifest = JSON.parse(await fs.readFile(path.join(extensionRoot, 'package.json'), 'utf8'));
  const counters = { rawGitCommands: 0, nativeGetBranches: 0, nativeStatus: 0, nativeGetConfig: 0, identityValidations: 0 };
  const commands = [];
  const repositories = await Promise.all(Array.from({ length: REPOSITORIES }, async (_, index) => {
    const root = path.join(temporary, label + '-repo-' + index);
    await fs.mkdir(root);
    const commit = sha256(Buffer.from('repo-' + index)).slice(0, 40);
    return { rootUri: { fsPath: root },
      state: { HEAD: { name: 'main', commit }, refs: [{ name: 'main', type: 0, commit }], remotes: [],
        indexChanges: [], workingTreeChanges: [], mergeChanges: [], onDidChange: new Emitter().event },
      async getBranches() { counters.nativeGetBranches++; return [{ name: 'main', type: 0, commit }]; },
      async status() { counters.nativeStatus++; },
      async getConfig() { counters.nativeGetConfig++; return ''; }
    };
  }));
  const api = { state: 'initialized', repositories, git: { path: 'fixture-git-disabled' },
    onDidChangeState: new Emitter().event, onDidOpenRepository: new Emitter().event, onDidCloseRepository: new Emitter().event };
  const Service = loadService(extensionRoot, api);
  const service = new Service({ fsPath: extensionRoot }, { fsPath: temporary }, { isTransitioning: false });
  // Mock only execution/identity/fingerprint boundaries; list, details, cache, locks and snapshots are production methods.
  service.runGit = async (repository, args) => {
    counters.rawGitCommands++; commands.push({ repository: path.basename(repository.rootUri.fsPath), args });
    const head = repository.state.HEAD.commit;
    const stdout = args[0] === 'symbolic-ref' ? 'main\n' : args[0] === 'log'
      ? [head, '', 'Benchmark', '2026-10-13T00:00:00Z', 'Fixture commit'].join('\0') + '\n'
      : args[0] === 'for-each-ref' && args.includes('refs/tags') ? 'v1\0\0' + head + '\n' : '';
    return { stdout, stderr: '', code: 0 };
  };
  service.requireRepository = async id => { counters.identityValidations++; const repository = service.findRepository(id);
    if (!repository) throw new Error('Unknown fixture repository.'); return repository; };
  service.repositoryFingerprint = async repository => JSON.stringify(repository.state.HEAD);
  service.operationFor = async () => undefined;
  const count = () => ({ ...counters });
  const delta = before => Object.fromEntries(Object.entries(counters).map(([key, value]) => [key, value - before[key]]));
  try {
    const coldBefore = count();
    const state = await service.getSummaryState();
    assert.equal(state.repositories.length, REPOSITORIES);
    const cold = delta(coldBefore);
    const selected = state.repositories[0].id;
    const detailsBefore = count();
    const hasLazyDetails = typeof service.getRepositoryDetails === 'function';
    const details = await Promise.all(Array.from({ length: 10 }, () => hasLazyDetails
      ? service.getRepositoryDetails(selected) : Promise.resolve(state.repositories[0])));
    assert.ok(details.every(item => item.branches.length === 2));
    const sharedDetails = delta(detailsBefore);
    const workbenchBefore = count();
    service.setActivePanelRepository(selected, false);
    const snapshot = await service.handleAction(selected, { type: 'open', repoId: selected, refresh: false });
    assert.equal(snapshot.branches.length, 2);
    const selectedWorkbench = delta(workbenchBefore);
    const idleBefore = count();
    for (let index = 0; index < 100; index++) {
      await service.getSummaryState();
      if (hasLazyDetails) await service.getRepositoryDetails(selected);
      await service.handleAction(selected, { type: 'open', repoId: selected, refresh: false });
    }
    const idleCachedReads = delta(idleBefore);
    assert.ok(Object.values(idleCachedReads).every(value => value === 0), 'Unchanged cached reads must not execute commands or native Git calls.');
    if (hasLazyDetails) {
      assert.equal(cold.rawGitCommands, REPOSITORIES); assert.equal(cold.nativeGetBranches, 0);
      assert.equal(sharedDetails.rawGitCommands, 3); assert.equal(sharedDetails.nativeGetBranches, 1);
      assert.equal(sharedDetails.identityValidations, 1); assert.equal(selectedWorkbench.nativeGetBranches, 0);
      assert.ok(state.repositories.every(item => !Object.hasOwn(item, 'branches') && !Object.hasOwn(item, 'stashes') && !Object.hasOwn(item, 'recoveryRefs')));
    } else {
      assert.equal(cold.rawGitCommands, REPOSITORIES * 4); assert.equal(cold.nativeGetBranches, REPOSITORIES);
    }
    return { artifact: { path: path.relative(ROOT, absolute).replaceAll(path.sep, '/'), sha256: sha256(bytes),
      name: manifest.name, version: manifest.version }, repositories: REPOSITORIES, hasLazyDetails,
      phases: { coldSummary: cold, sharedDetailsRequests: { requests: 10, ...sharedDetails },
        selectedWorkbench, idleCachedReads: { repetitions: 100, ...idleCachedReads } },
      coldSummaryFields: Object.keys(state.repositories[0]).sort(), total: count(), commandTrace: commands };
  } finally { service.dispose(); }
}

(async () => {
  const tempParent = await fs.realpath(os.tmpdir());
  const temporary = await fs.mkdtemp(path.join(tempParent, 'glw-summary-benchmark-'));
  try {
    const baseline = await measure(baselinePath, temporary, 'baseline');
    const revision = revisionPath ? await measure(revisionPath, temporary, 'revision') : undefined;
    if (revision) {
      assert.notEqual(baseline.artifact.sha256, revision.artifact.sha256, 'Compare distinct packaged artifacts.');
      assert.equal(baseline.hasLazyDetails, false, 'Baseline must contain the eager repository summary implementation.');
      assert.equal(revision.hasLazyDetails, true, 'Revision must contain the lazy repository detail implementation.');
    }
    const report = { schema: 'GitLabWorkspaceGitSummaryCommandBenchmark/v1', generatedAt: new Date().toISOString(),
      environment: { node: process.version, platform: process.platform },
      methodology: 'Compiled production modules extracted from each SHA-bound VSIX. Twenty registered repository fixtures; production list, detail cache, locking and workbench snapshot methods. Git output, native API output, identity validation and fingerprints are mocked. No real Git commands or network requests are performed.',
      limits: ['Command/API invocation counts only; this does not measure or establish real Git, VS Code or GitLab latency.',
        'Idle phase is 100 immediate cached reads, not a timed live Extension Host idle observation.'],
      status: 'PASS', baseline, ...(revision ? { revision, coldReduction: {
        rawGitCommands: baseline.phases.coldSummary.rawGitCommands - revision.phases.coldSummary.rawGitCommands,
        nativeGetBranches: baseline.phases.coldSummary.nativeGetBranches - revision.phases.coldSummary.nativeGetBranches } } : {}) };
    if (revision) { await fs.mkdir(path.dirname(outputPath), { recursive: true }); await fs.writeFile(outputPath, JSON.stringify(report, null, 2) + '\n'); }
    process.stdout.write(JSON.stringify({ status: report.status, baseline: baseline.phases,
      ...(revision ? { revision: revision.phases, evidence: path.relative(ROOT, outputPath) } : { note: 'Baseline only; no comparison evidence written.' }) }, null, 2) + '\n');
  } finally {
    const target = await fs.realpath(temporary);
    if (path.dirname(target) !== tempParent || !path.basename(target).startsWith('glw-summary-benchmark-')) throw new Error('Unsafe benchmark cleanup path.');
    await fs.rm(target, { recursive: true, force: true });
  }
})().catch(error => { process.stderr.write(error.stack + '\n'); process.exitCode = 1; });
