import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { preparationInputs } from './validation-runtime.mjs';

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'glw-orchestration-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directories = new Set(['src', 'test', 'scripts', 'docs', 'resources/workflow-kit', 'resources/offline-tools/sources']);
  async function put(name, contents) {
    await mkdir(path.dirname(path.join(root, name)), { recursive: true });
    await writeFile(path.join(root, name), contents);
  }
  for (const name of preparationInputs()) {
    if (directories.has(name)) await mkdir(path.join(root, name), { recursive: true });
    else await put(name, '{}');
  }
  await put('package.json', JSON.stringify({ version: '1.2.3' }));
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
    }`);
  await put('node_modules/vite/bin/vite.js', `${header}
    const name=process.argv.at(-1);if(name.includes('dashboard'))put('resources/issue-webview/dashboard.js');
    else if(name.includes('sidebar'))put('resources/sidebar-webview/sidebar.js');else put('resources/issue-webview/issue-test.js');`);
  await put('scripts/run-python.mjs', `${header}
    if(process.argv[2].endsWith('build-workflow-kit.py')){
      put('resources/offline-tools/workflow-kit.tar.xz');put('resources/offline-tools/manifest.json');put('dist/gitlab-workspace-kit-1.2.3.zip');
    }`);
  await put('scripts/run-extension-tests.mjs', `${header}
    if(process.argv[2]==='--preflight')put(process.argv[3],'{}');
    else if(process.env.FAKE_HOST_FAILURE==='1')process.exit(9);`);
  await put('scripts/package-extension.mjs', `${header}
    import {assertPrepared} from './validation-runtime.mjs';
    await assertPrepared(process.cwd(),['compile','webview']);
    put('dist/gitlab-workspace-1.2.3.vsix');put('dist/SHA256SUMS');`);
  await put('scripts/tooling.test.mjs', "import test from 'node:test';test('tooling',()=>{});");
  await put('node_modules/@cucumber/cucumber/bin/cucumber.js', '');
  for (const name of ['quick-actions.test.mjs', 'dashboard.test.mjs', 'skills-guide.test.mjs']) {
    await put(`test/behavior/${name}`, "import test from 'node:test';test('behavior',()=>{});");
  }
  await put('test/release/one_test.py', '# discovered Python suite');
  const evidenceDir = path.join(root, 'evidence');
  function run(environment = {}) {
    return spawnSync(process.execPath, ['scripts/run-validation.mjs', 'all'], { cwd: root, encoding: 'utf8',
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
  for (const id of ['compile', 'build-dashboard', 'build-sidebar', 'package', 'verify-package']) {
    assert.equal(ids.filter(value => value === id).length, 1, id);
  }
  assert.ok(ids.includes('release-one'));
  assert.equal(ids.includes('build-kit'), false, 'Extension validation never builds a local installation package');
  assert.ok(ids.indexOf('extension') < ids.indexOf('unit'));
  assert.equal(ids.at(-2), 'package');
  assert.equal(ids.at(-1), 'verify-package');
  assert.ok(await readFile(path.join(root, 'dist/gitlab-workspace-1.2.3.vsix')));
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
