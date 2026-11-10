import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { acquireValidationLock, assertPrepared, hasValidationLease, receiptPath, runLogged, runPool, savePreparation, workerCount } from './validation-runtime.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const [mode = 'all', ...args] = process.argv.slice(2);
const profiles = {
  all: ['compile', 'typecheck-webview', 'webview', 'issue'],
  prepare: ['compile', 'typecheck-webview', 'webview', 'issue'],
  quick: ['compile', 'typecheck-webview'],
  ui: ['compile', 'typecheck-webview', 'webview', 'issue'],
  compatibility: ['compile', 'typecheck-webview', 'webview'],
  legacy: ['compile', 'typecheck-webview', 'legacy'],
  unit: ['compile'],
  behavior: ['compile', 'typecheck-webview', 'webview', 'issue'],
  release: [],
  extension: ['compile', 'typecheck-webview', 'webview'],
  trust: ['compile', 'typecheck-webview', 'webview'],
  package: ['compile', 'typecheck-webview', 'webview'],
  prepublish: ['compile', 'typecheck-webview', 'webview']
};
if (!Object.hasOwn(profiles, mode) || args.some(arg => !['--prepared', '--production'].includes(arg)) ||
    (args.includes('--production') && mode !== 'prepare')) {
  throw new Error('Usage: run-validation.mjs [' + Object.keys(profiles).join('|') + '] [--prepared] [--production (prepare only)]');
}
const prepared = args.includes('--prepared') || (mode === 'prepublish' && process.env.GITLAB_WORKSPACE_PREPARED === '1');
const stages = ['lint', ...profiles[mode].filter(stage => !(args.includes('--production') && stage === 'issue'))];
// vsce runs prepublish while the parent owns the lock. Only this nested reader
// may borrow the lease; another --prepared command must acquire its own lock.
if (mode === 'prepublish' && prepared && await hasValidationLease(root)) {
  await assertPrepared(root, stages);
  process.exit(0);
}

const workers = workerCount(process.env.GITLAB_WORKSPACE_TEST_WORKERS ?? '2');
const evidenceDir = path.resolve(process.env.GITLAB_WORKSPACE_VALIDATION_DIR ??
  path.join(root, '.gitlab-workspace-validation', 'runs', new Date().toISOString().replaceAll(':', '-') + '-' + process.pid));
const lease = await acquireValidationLock(root, { mode, evidenceDir });
const results = [];
const began = performance.now();
let reportQueue = Promise.resolve();
let evidenceReady = false;
const node = (id, ...argv) => ({ id, command: process.execPath, args: argv });
const python = (id, script, ...argv) => node(id, 'scripts/run-python.mjs', script, ...argv);
async function execute(job, options = {}) {
  const record = await runLogged(job, { cwd: root, evidenceDir, ...options });
  results.push(record);
  await report();
  return record;
}
async function report(error, finished = false) {
  if (!evidenceReady) return;
  const payload = JSON.stringify({
    schema: 'gitlab-workspace-validation/v1', mode, workers,
    seconds: Number(((performance.now() - began) / 1000).toFixed(3)),
    nodeVersion: process.version, platform: process.platform, arch: process.arch,
    status: finished ? (error || results.some(result => result.exitCode !== 0) ? 'failed' : 'success') : 'running',
    success: finished && !error && results.every(result => result.exitCode === 0),
    ...(error ? { error: String(error.message ?? error) } : {}), stages: results
  }, null, 2) + '\n';
  reportQueue = reportQueue.then(() => writeFile(path.join(evidenceDir, 'timings.json'), payload));
  await reportQueue;
}
async function required(job, options) {
  const result = await execute(job, options);
  if (result.exitCode !== 0) throw new Error(job.id + ' failed; see ' + result.log);
}
const includes = (...modes) => modes.includes(mode);
async function testFiles(directory, extension) {
  const files = (await readdir(path.join(root, directory))).filter(name => name.endsWith(extension)).sort();
  if (!files.length) throw new Error('No tests found in ' + directory + '.');
  return files.map(name => directory + '/' + name);
}
try {
  await mkdir(path.dirname(evidenceDir), { recursive: true });
  await mkdir(evidenceDir);
  evidenceReady = true;
  if (prepared) await assertPrepared(root, stages);
  else {
    await rm(path.join(root, receiptPath), { force: true });
    const cache = [];
    if (includes('quick', 'ui', 'legacy')) {
      const identity = createHash('sha256').update(await readFile(path.join(root, 'package-lock.json'))).digest('hex').slice(0, 16);
      cache.push('--cache', '--cache-strategy', 'content', '--cache-location', '.gitlab-workspace-validation/eslint-' + identity + '.cache');
    }
    await required(node('lint', 'node_modules/eslint/bin/eslint.js', '.', '--max-warnings', '0', ...cache));
  }
  const hostProof = path.join(evidenceDir, 'extension-host.json');
  if (includes('all', 'ui', 'compatibility', 'extension', 'trust')) {
    await required(node('host-preflight', 'scripts/run-extension-tests.mjs', '--preflight', hostProof));
  }
  if (!prepared) {
    if (stages.includes('compile')) {
      await required(node('clean-compiled', 'scripts/clean-compiled.mjs'));
      await required(node('compile', 'node_modules/typescript/bin/tsc', '-p', '.'));
    }
    if (stages.includes('typecheck-webview')) {
      await required(node('typecheck-webview', 'node_modules/typescript/bin/tsc', '-p', 'tsconfig.webview.json'));
    }
    if (stages.includes('webview')) await required(node('build-dashboard', 'node_modules/vite/bin/vite.js', 'build', '--config', 'vite.dashboard.config.mjs'));
    // Dashboard empties its output directory, so its test entry is built last.
    if (stages.includes('issue')) await required(node('build-issue-tests', 'node_modules/vite/bin/vite.js', 'build', '--config', 'vite.issue-test.config.mjs'));
    if (stages.includes('legacy')) await required(node('build-sidebar', 'node_modules/vite/bin/vite.js', 'build', '--config', 'vite.sidebar.config.mjs'));
    const outputs = stages.flatMap(stage => ({ lint: [], 'typecheck-webview': [], compile: ['out', 'out/src/extension.js'],
      webview: ['resources/issue-webview', 'resources/issue-webview/dashboard.js'],
      issue: ['resources/issue-webview/issue-test.js'], legacy: ['resources/sidebar-webview', 'resources/sidebar-webview/sidebar.js']
    })[stage]);
    await savePreparation(root, stages, outputs);
  }
  if (includes('prepare', 'prepublish')) {
    console.log('[validation] prepared build saved');
  } else {
    if (includes('all', 'ui', 'compatibility', 'extension')) {
      const selection = includes('ui', 'compatibility')
        ? ['--grep', '^WorkflowKit compatibility installation ', ...(mode === 'ui' ? ['--invert'] : [])] : [];
      await required(node('extension', 'scripts/run-extension-tests.mjs', '--preflight-file', hostProof, '--forbid-only', '--fail-zero', ...selection));
    }
    if (includes('all', 'ui', 'trust')) await required(node('workspace-trust', 'scripts/test-workspace-trust.mjs', '--preflight-file', hostProof));
    if (includes('all', 'quick', 'ui', 'unit')) {
      await required(node('unit', '--require', './test/network-test-environment.cjs', '--test', '--test-concurrency=' + workers, ...await testFiles('out/test/unit', '.test.js')));
    }
    if (includes('all', 'ui', 'behavior')) {
      await required(node('behavior-node', '--require', './test/network-test-environment.cjs', '--test', ...await testFiles('test/behavior', '.test.mjs')));
      for (const [id, steps, feature] of [['issues', 'steps.cjs', 'issues.feature'], ['connect', 'connect.steps.cjs', 'connect.feature']]) {
        await required(node('behavior-' + id, '--require', './test/network-test-environment.cjs', 'node_modules/@cucumber/cucumber/bin/cucumber.js', '--require', 'test/behavior/' + steps, '--tags', '@automated', 'test/behavior/' + feature));
      }
    }
    if (mode === 'legacy') {
      await required(node('legacy-unit', '--require', './test/network-test-environment.cjs', '--test', '--test-concurrency=' + workers, ...await testFiles('out/test/legacy/unit', '.test.js')));
      await required(node('legacy-behavior', '--require', './test/network-test-environment.cjs', '--test', ...await testFiles('test/legacy/behavior', '.test.mjs')));
    }
    if (includes('all', 'quick', 'ui', 'release')) {
      await required(node('release-tooling', '--test', ...await testFiles('scripts', '.test.mjs')));
    }
    if (includes('all', 'compatibility', 'release')) {
      const files = (await readdir(path.join(root, 'test/release')).catch(error => {
        if (error.code === 'ENOENT') return [];
        throw error;
      })).filter(name => name.endsWith('_test.py')).sort();
      const kitClasses = ['WorkflowKit135IntegrationTests', 'WorkflowKit134IntegrationTests', 'WorkflowKitIntegrationTests'];
      const jobs = files.flatMap(name => name === 'workflowkit_131_integration_test.py'
        ? kitClasses.map(className => python('release-workflowkit-' + className, 'test/release/' + name, className))
        : [python('release-' + name.replace('_test.py', ''), 'test/release/' + name)]);
      // Independent installer classes are longest. Each owns its fixtures/logs;
      // the global worker cap still applies.
      jobs.sort((left, right) => Number(!left.id.startsWith('release-workflowkit-')) - Number(!right.id.startsWith('release-workflowkit-')));
      await runPool(jobs, workers, job => execute(job));
    }
    if (includes('all', 'ui', 'package') && results.every(result => result.exitCode === 0)) {
      await required(node('package', 'scripts/package-extension.mjs', '--prepared'),
        { env: { ...process.env, GITLAB_WORKSPACE_PREPARED: '1', GITLAB_WORKSPACE_VALIDATION_LOCK_TOKEN: lease.token } });
      await required(python('verify-package', 'scripts/verify-vsix.py'));
    }
  }
  if (results.some(result => result.exitCode !== 0)) process.exitCode = 1;
  await report(undefined, true);
} catch (error) {
  await report(error, true);
  process.exitCode = 1;
  console.error(error.message);
} finally {
  await lease.release();
  if (evidenceReady) console.log('[validation] timings: ' + path.join(evidenceDir, 'timings.json'));
}
