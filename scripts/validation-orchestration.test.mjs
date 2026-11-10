import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { acquireValidationLock, preparationInputs } from './validation-runtime.mjs';

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'glw-orchestration-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directories = new Set(['.github', 'src', 'test', 'scripts', 'docs', 'resources/bmad', 'resources/codicons']);
  async function put(name, contents) {
    await mkdir(path.dirname(path.join(root, name)), { recursive: true });
    await writeFile(path.join(root, name), contents);
  }
  for (const name of preparationInputs()) {
    if (directories.has(name)) await mkdir(path.join(root, name), { recursive: true });
    else await put(name, '{}');
  }
  await put('package.json', JSON.stringify({ version: '1.2.3' }));
  await put('node_modules/eslint/bin/eslint.js', "if(process.env.FAKE_LINT_FAILURE==='1')process.exit(8);");
  await put('test/network-test-environment.cjs', await readFile(new URL('../test/network-test-environment.cjs', import.meta.url), 'utf8'));
  for (const name of ['run-validation.mjs', 'validation-runtime.mjs']) {
    await put(`scripts/${name}`, await readFile(new URL(name, import.meta.url), 'utf8'));
  }
  const write = `const put=(name,data='built')=>{fs.mkdirSync(path.dirname(name),{recursive:true});fs.writeFileSync(name,data);};`;
  const header = `import fs from 'node:fs';import path from 'node:path';${write}`;
  await put('scripts/clean-compiled.mjs', `${header}fs.rmSync('out',{recursive:true,force:true});`);
  await put('node_modules/typescript/bin/tsc', `${header}
    if(process.argv.at(-1)==='.'){
      put('out/src/extension.js');put('out/test/unit/unit.test.js',"require('node:test')('unit',()=>{});");
      put('out/test/legacy/unit/legacy.test.js',"require('node:test')('legacy',()=>{});");
    }`);
  await put('node_modules/vite/bin/vite.js', `${header}
    const name=process.argv.at(-1);if(name.includes('dashboard'))put('resources/issue-webview/dashboard.js');
    else if(name.includes('sidebar'))put('resources/sidebar-webview/sidebar.js');else put('resources/issue-webview/issue-test.js');`);
  await put('scripts/run-python.mjs', `${header}
    if(process.env.FAKE_PYTHON_FAILURE==='1' && process.argv[3]==='WorkflowKit134IntegrationTests')process.exit(7);`);
  await put('scripts/run-extension-tests.mjs', `${header}
    if(process.argv[2]==='--preflight')put(process.argv[3],'{}');
    else if(process.env.FAKE_HOST_FAILURE==='1')process.exit(9);`);
  await put('scripts/test-workspace-trust.mjs', '');
  await put('scripts/package-extension.mjs', `${header}
    import {assertPrepared} from './validation-runtime.mjs';
    await assertPrepared(process.cwd(),['compile','webview']);
    put('dist/gitlab-workspace-1.2.3.vsix');put('dist/SHA256SUMS');`);
  await put('scripts/tooling.test.mjs', "import test from 'node:test';test('tooling',()=>{});");
  await put('node_modules/@cucumber/cucumber/bin/cucumber.js', '');
  for (const name of ['dashboard.test.mjs', 'skills-guide.test.mjs']) {
    await put(`test/behavior/${name}`, "import test from 'node:test';test('behavior',()=>{});");
  }
  await put('test/legacy/behavior/quick-actions.test.mjs', "import test from 'node:test';test('legacy behavior',()=>{});");
  await put('test/release/one_test.py', '# discovered Python suite');
  await put('test/release/workflowkit_131_integration_test.py', '# split into three isolated unittest classes');
  const evidenceDir = path.join(root, 'evidence');
  function run(environment = {}, mode = 'all', args = []) {
    return spawnSync(process.execPath, ['scripts/run-validation.mjs', mode, ...args], { cwd: root, encoding: 'utf8',
      env: { ...process.env, GITLAB_WORKSPACE_VALIDATION_DIR: evidenceDir, ...environment } });
  }
  return { root, evidenceDir, run };
}

test('full validation builds once, discovers suites, and packages only after every gate', async t => {
  const { root, evidenceDir, run } = await fixture(t);
  const child = run();
  assert.equal(child.status, 0, child.stderr || child.stdout);
  const result = JSON.parse(await readFile(path.join(evidenceDir, 'timings.json'), 'utf8'));
  assert.equal(result.status, 'success');
  assert.equal(result.success, true);
  const ids = result.stages.map(stage => stage.id);
  for (const id of ['lint', 'compile', 'build-dashboard', 'build-issue-tests', 'package', 'verify-package']) {
    assert.equal(ids.filter(value => value === id).length, 1, id);
  }
  assert.ok(ids.includes('release-one'));
  assert.ok(ids.includes('workspace-trust'));
  assert.equal(ids.includes('build-sidebar'), false);
  assert.equal(ids.some(id => id.startsWith('legacy-')), false);
  assert.equal(ids.filter(id => id.startsWith('release-workflowkit-')).length, 3);
  assert.equal(ids.includes('build-kit'), false, 'Extension validation never builds a local installation package');
  assert.ok(ids.indexOf('extension') < ids.indexOf('unit'));
  assert.equal(ids.at(-2), 'package');
  assert.equal(ids.at(-1), 'verify-package');
  assert.ok(await readFile(path.join(root, 'dist/gitlab-workspace-1.2.3.vsix')));
});

test('quick validates types and current unit/tooling without bundles, editor or installers', async t => {
  const { evidenceDir, run } = await fixture(t);
  const child = run({}, 'quick');
  assert.equal(child.status, 0, child.stderr || child.stdout);
  const result = JSON.parse(await readFile(path.join(evidenceDir, 'timings.json'), 'utf8'));
  assert.deepEqual(result.stages.map(stage => stage.id), ['lint', 'clean-compiled', 'compile', 'typecheck-webview', 'unit', 'release-tooling']);
  assert.ok(result.stages[0].command.includes('--cache-strategy'));
});

test('unit needs only lint and host compilation', async t => {
  const { evidenceDir, run } = await fixture(t);
  const child = run({}, 'unit');
  assert.equal(child.status, 0, child.stderr || child.stdout);
  const result = JSON.parse(await readFile(path.join(evidenceDir, 'timings.json'), 'utf8'));
  assert.deepEqual(result.stages.map(stage => stage.id), ['lint', 'clean-compiled', 'compile', 'unit']);
});

test('UI validates current behavior and real host core once before packaging', async t => {
  const { evidenceDir, run } = await fixture(t);
  const child = run({}, 'ui');
  assert.equal(child.status, 0, child.stderr || child.stdout);
  const result = JSON.parse(await readFile(path.join(evidenceDir, 'timings.json'), 'utf8'));
  const ids = result.stages.map(stage => stage.id);
  for (const id of ['compile', 'build-dashboard', 'build-issue-tests', 'extension', 'workspace-trust', 'unit', 'behavior-node', 'release-tooling', 'package', 'verify-package']) {
    assert.equal(ids.filter(value => value === id).length, 1, id);
  }
  const host = result.stages.find(stage => stage.id === 'extension');
  assert.ok(host.command.includes('^WorkflowKit compatibility installation '));
  assert.ok(host.command.includes('--invert'));
  assert.ok(!ids.includes('build-sidebar'));
  assert.ok(!ids.some(id => id.startsWith('release-workflowkit-')));
});

for (const workers of ['1', '2']) test(`compatibility retains all installer classes in isolated logs with ${workers} worker(s)`, async t => {
  const { evidenceDir, run } = await fixture(t);
  const child = run({ GITLAB_WORKSPACE_TEST_WORKERS: workers, FAKE_PYTHON_FAILURE: '1' }, 'compatibility');
  assert.equal(child.status, 1, child.stderr || child.stdout);
  const result = JSON.parse(await readFile(path.join(evidenceDir, 'timings.json'), 'utf8'));
  assert.equal(result.status, 'failed');
  const jobs = result.stages.filter(stage => stage.id.startsWith('release-workflowkit-'));
  assert.deepEqual(jobs.map(stage => stage.command.at(-1)).sort(), ['WorkflowKit134IntegrationTests', 'WorkflowKit135IntegrationTests', 'WorkflowKitIntegrationTests']);
  assert.equal(new Set(jobs.map(stage => stage.log)).size, 3);
  assert.ok(jobs.some(stage => stage.exitCode === 7));
  assert.ok(result.stages.some(stage => stage.id === 'release-one'));
  assert.ok(!result.stages.some(stage => ['unit', 'behavior-node', 'package', 'verify-package'].includes(stage.id)));
  const host = result.stages.find(stage => stage.id === 'extension');
  assert.ok(host.command.includes('^WorkflowKit compatibility installation '));
  assert.ok(!host.command.includes('--invert'));
});

test('legacy sidebar is available only through the explicit legacy profile', async t => {
  const { evidenceDir, run } = await fixture(t);
  const child = run({}, 'legacy');
  assert.equal(child.status, 0, child.stderr || child.stdout);
  const result = JSON.parse(await readFile(path.join(evidenceDir, 'timings.json'), 'utf8'));
  const ids = result.stages.map(stage => stage.id);
  assert.ok(ids.includes('build-sidebar'));
  assert.ok(ids.includes('legacy-unit'));
  assert.ok(ids.includes('legacy-behavior'));
  assert.ok(!ids.some(id => ['build-dashboard', 'unit', 'extension', 'package'].includes(id)));
});

test('prepared execution acquires the lock before checking or changing evidence', async t => {
  const { root, evidenceDir, run } = await fixture(t);
  const lease = await acquireValidationLock(root, { mode: 'another-builder' });
  try {
    const child = run({}, 'quick', ['--prepared']);
    assert.equal(child.status, 1);
    assert.match(child.stderr, /Another validation command owns/);
    assert.doesNotMatch(child.stderr, /Prepared build is missing/);
    await assert.rejects(readFile(path.join(evidenceDir, 'timings.json')), { code: 'ENOENT' });
  } finally { await lease.release(); }
});

test('nested prepublish can borrow only a live matching lease and still rejects stale outputs', async t => {
  const { root, run } = await fixture(t);
  const prepared = run({}, 'prepare');
  assert.equal(prepared.status, 0, prepared.stderr || prepared.stdout);
  const lease = await acquireValidationLock(root, { mode: 'package' });
  const env = { GITLAB_WORKSPACE_PREPARED: '1', GITLAB_WORKSPACE_VALIDATION_LOCK_TOKEN: lease.token };
  try {
    assert.equal(run(env, 'prepublish').status, 0);
    assert.match(run({ ...env, GITLAB_WORKSPACE_VALIDATION_LOCK_TOKEN: 'wrong-token' }, 'prepublish').stderr, /Another validation command owns/);
    await writeFile(path.join(root, 'out/src/extension.js'), 'changed');
    const stale = run(env, 'prepublish');
    assert.equal(stale.status, 1);
    assert.match(stale.stderr, /Prepared build is missing, changed, or incomplete/);
  } finally { await lease.release(); }
});

test('lint failure stops before compilation, editor launch and packaging', async t => {
  const { evidenceDir, run } = await fixture(t);
  const child = run({ FAKE_LINT_FAILURE: '1' });
  assert.equal(child.status, 1, child.stdout);
  const result = JSON.parse(await readFile(path.join(evidenceDir, 'timings.json'), 'utf8'));
  assert.deepEqual(result.stages.map(stage => stage.id), ['lint']);
  assert.equal(result.stages[0].exitCode, 8);
});

test('a real host launch failure stops before expensive suites and produces no publishable package', async t => {
  const { root, evidenceDir, run } = await fixture(t);
  const child = run({ FAKE_HOST_FAILURE: '1' });
  assert.equal(child.status, 1, child.stdout);
  const result = JSON.parse(await readFile(path.join(evidenceDir, 'timings.json'), 'utf8'));
  assert.equal(result.status, 'failed');
  assert.equal(result.success, false);
  assert.equal(result.stages.at(-1).id, 'extension');
  assert.equal(result.stages.at(-1).exitCode, 9);
  assert.ok(!result.stages.some(stage => ['unit', 'package'].includes(stage.id)));
  await assert.rejects(readFile(path.join(root, 'dist/gitlab-workspace-1.2.3.vsix')));
});

test('an independent Extension checkout validates without the extracted Python bundle suites', async t => {
  const { root, evidenceDir, run } = await fixture(t);
  await rm(path.join(root, 'test/release'), { recursive: true });
  const child = run();
  assert.equal(child.status, 0, child.stderr || child.stdout);
  const result = JSON.parse(await readFile(path.join(evidenceDir, 'timings.json'), 'utf8'));
  assert.equal(result.status, 'success');
  assert.ok(result.stages.some(stage => stage.id === 'verify-package'));
});
