import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertPrepared, receiptPath, runLogged, runPool, savePreparation, workerCount } from './validation-runtime.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const [mode = 'all', ...args] = process.argv.slice(2);
const validModes = ['all', 'prepare', 'unit', 'behavior', 'release', 'extension', 'package', 'prepublish'];
if (!validModes.includes(mode) || args.some(arg => !['--prepared', '--production'].includes(arg))) {
  throw new Error('Usage: run-validation.mjs [all|prepare|unit|behavior|release|extension|package|prepublish] [--prepared] [--production]');
}
const prepared = args.includes('--prepared') || (mode === 'prepublish' && process.env.GITLAB_WORKSPACE_PREPARED === '1');
const stages = mode === 'release' ? [] : mode === 'extension' ? ['compile']
  : mode === 'behavior' ? ['compile', 'webview', 'issue']
  : (mode === 'prepare' || mode === 'all') && !args.includes('--production')
    ? ['compile', 'webview', 'issue'] : ['compile', 'webview'];
if (prepared) await assertPrepared(root, stages);
if (mode === 'prepublish' && prepared) process.exit(0);

const workers = workerCount(process.env.GITLAB_WORKSPACE_TEST_WORKERS ?? '2');
const evidenceDir = path.resolve(process.env.GITLAB_WORKSPACE_VALIDATION_DIR ??
  path.join(root, '.gitlab-workspace-validation', 'runs', `${new Date().toISOString().replaceAll(':', '-')}-${process.pid}`));
await mkdir(evidenceDir, { recursive: true });
const lock = path.join(root, '.gitlab-workspace-validation', 'runner.lock');
await mkdir(path.dirname(lock), { recursive: true });
try { await mkdir(lock); } catch (error) {
  if (error.code !== 'EEXIST') throw error;
  throw new Error(`Another validation command owns ${lock}. If its process has stopped, remove that directory and retry.`);
}
await writeFile(path.join(lock, 'owner.json'), JSON.stringify({ pid: process.pid, mode, evidenceDir }));
const results = [];
const began = performance.now();
let reportQueue = Promise.resolve();
const node = (id, ...argv) => ({ id, command: process.execPath, args: argv });
const python = (id, script) => node(id, 'scripts/run-python.mjs', script);
async function execute(job, options = {}) {
  const record = await runLogged(job, { cwd: root, evidenceDir, ...options });
  results.push(record);
  await report();
  return record;
}
async function report(error, finished = false) {
  const payload = `${JSON.stringify({
    schema: 'gitlab-workspace-validation/v1', mode, workers,
    seconds: Number(((performance.now() - began) / 1000).toFixed(3)),
    nodeVersion: process.version, platform: process.platform, arch: process.arch,
    status: finished ? (error || results.some(result => result.exitCode !== 0) ? 'failed' : 'success') : 'running',
    success: finished && !error && results.every(result => result.exitCode === 0),
    ...(error ? { error: String(error.message ?? error) } : {}), stages: results
  }, null, 2)}\n`;
  reportQueue = reportQueue.then(() => writeFile(path.join(evidenceDir, 'timings.json'), payload));
  await reportQueue;
}
async function required(job, options) {
  const result = await execute(job, options);
  if (result.exitCode !== 0) throw new Error(`${job.id} failed; see ${result.log}`);
}
try {
  // Resolve/download the editor and check launch inputs before the long suites.
  const hostProof = path.join(evidenceDir, 'extension-host.json');
  if (mode === 'all' || mode === 'extension') {
    await required(node('host-preflight', 'scripts/run-extension-tests.mjs', '--preflight', hostProof));
  }
  if (!prepared) {
    await rm(path.join(root, receiptPath), { force: true });
    if (stages.includes('compile')) {
      await required(node('clean-compiled', 'scripts/clean-compiled.mjs'));
      await required(node('compile', 'node_modules/typescript/bin/tsc', '-p', '.'));
    }
    if (stages.includes('webview')) {
      await required(node('typecheck-webview', 'node_modules/typescript/bin/tsc', '-p', 'tsconfig.webview.json'));
      await required(node('build-dashboard', 'node_modules/vite/bin/vite.js', 'build', '--config', 'vite.dashboard.config.mjs'));
      await required(node('build-sidebar', 'node_modules/vite/bin/vite.js', 'build', '--config', 'vite.sidebar.config.mjs'));
    }
    if (stages.includes('issue')) await required(node('build-issue-tests', 'node_modules/vite/bin/vite.js', 'build', '--config', 'vite.issue-test.config.mjs'));
    const manifest = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
    const outputs = stages.flatMap(stage => ({ compile: ['out', 'out/src/extension.js'],
      webview: ['resources/issue-webview', 'resources/sidebar-webview', 'resources/issue-webview/dashboard.js', 'resources/sidebar-webview/sidebar.js'],
      issue: ['resources/issue-webview/issue-test.js'],
    })[stage]);
    await savePreparation(root, stages, outputs);
  }
  if (mode === 'prepare' || mode === 'prepublish') {
    console.log('[validation] prepared build saved');
  } else {
    // Exercise the real editor before the expensive Python/Git regressions;
    // installation metadata alone cannot detect a failed desktop launch.
    if (mode === 'all' || mode === 'extension') {
      await required(node('extension', 'scripts/run-extension-tests.mjs', '--preflight-file', hostProof, '--forbid-only', '--fail-zero'));
    }
    if (mode === 'all' || mode === 'unit') {
      const files = (await readdir(path.join(root, 'out/test/unit'))).filter(name => name.endsWith('.test.js')).sort();
      await required(node('unit', '--require', './test/network-test-environment.cjs', '--test', `--test-concurrency=${workers}`, ...files.map(name => `out/test/unit/${name}`)));
    }
    if (mode === 'all' || mode === 'behavior') {
      const files = (await readdir(path.join(root, 'test/behavior'))).filter(name => name.endsWith('.test.mjs')).sort();
      await required(node('behavior-node', '--require', './test/network-test-environment.cjs', '--test', ...files.map(name => `test/behavior/${name}`)));
      for (const [id, steps, feature] of [['issues', 'steps.cjs', 'issues.feature'], ['connect', 'connect.steps.cjs', 'connect.feature']]) {
        await required(node(`behavior-${id}`, '--require', './test/network-test-environment.cjs', 'node_modules/@cucumber/cucumber/bin/cucumber.js', '--require', `test/behavior/${steps}`, '--tags', '@automated', `test/behavior/${feature}`));
      }
    }
    if (mode === 'all' || mode === 'release') {
      const tooling = (await readdir(path.join(root, 'scripts'))).filter(name => name.endsWith('.test.mjs')).sort();
      await required(node('release-tooling', '--test', ...tooling.map(name => `scripts/${name}`)));
      const files = (await readdir(path.join(root, 'test/release')).catch(error => {
        if (error.code === 'ENOENT') return [];
        throw error;
      })).filter(name => name.endsWith('_test.py')).sort();
      const jobs = files.map(name => python(`release-${name.replace('_test.py', '')}`, `test/release/${name}`));
      // Start historically expensive suites first to avoid leaving one long
      // suite on the final worker while the other worker is already idle.
      const expensive = ['release-workflow_kit_profiles',
        'release-workflow_kit_transactions', 'release-workflow_kit_installer', 'release-release_reviewer_integration'];
      jobs.sort((left, right) => (expensive.indexOf(left.id) < 0 ? 100 : expensive.indexOf(left.id)) -
        (expensive.indexOf(right.id) < 0 ? 100 : expensive.indexOf(right.id)));
      await runPool(jobs, workers, job => execute(job));
    }
    if (mode === 'package' || (mode === 'all' && results.every(result => result.exitCode === 0))) {
      await required(node('package', 'scripts/package-extension.mjs', '--prepared'),
        { env: { ...process.env, GITLAB_WORKSPACE_PREPARED: '1' } });
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
  await rm(lock, { recursive: true, force: true });
  console.log(`[validation] timings: ${path.join(evidenceDir, 'timings.json')}`);
}
