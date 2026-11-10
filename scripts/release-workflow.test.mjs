import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { parse } from 'yaml';

const workflow = await readFile(new URL('../.github/workflows/release.yml', import.meta.url), 'utf8');
const helper = await readFile(new URL('./release_ci.py', import.meta.url), 'utf8');
const configuration = parse(workflow);

test('[BDD-REL-003] retains all three Windows cells and builds once per validation', () => {
  const cells = JSON.parse(configuration.jobs.route.env.FULL_MATRIX).include.map(item => item.cell);
  assert.deepEqual(cells, ['windows-py3.11-1.90.0', 'windows-py3.11-stable', 'windows-py3.14-stable']);
  assert.match(workflow, /npm ci/);
  assert.match(workflow, /npm run check:release/);
  assert.match(workflow, /VSCODE_TEST_VERSION/);
  assert.equal(configuration.jobs.build.strategy.matrix, '${{ fromJSON(needs.route.outputs.matrix) }}');
  assert.doesNotMatch(workflow, /run: npm run package/);
  assert.match(workflow, /branches:\s*\n\s+- main/);
  assert.match(workflow, /pull_request:/);
  assert.match(workflow, /workflow_dispatch:/);
});

test('keeps validation read-only and grants write only to guarded tag promotion', () => {
  for (const eol of ['\n', '\r\n']) {
    const text = workflow.replace(/\r?\n/g, eol);
    const [validation, publish] = text.split(/\r?\n {2}publish:\r?\n/);
    assert.doesNotMatch(validation, /contents:\s*write/);
    assert.match(publish, /contents:\s*write/);
    assert.match(publish, /github.event_name == 'push' && startsWith\(github.ref, 'refs\/tags\/'\)/);
    assert.match(publish, /needs: \[select, build\]/);
    assert.match(publish, /needs.build.result == 'success'/);
    assert.match(publish, /needs.select.outputs.reuse_run_id != ''/);
    assert.doesNotMatch(publish, /npm test|npm run package|npm ci/);
  }
});

test('runs the full suite on all three full-profile cells and only canonical coverage for fast PRs', () => {
  const steps = workflow.split(/\r?\n\s+- name:/).slice(1);
  const tests = steps.filter(step => /run: npm test(?:\r?\n|$)/.test(step));
  assert.equal(tests.length, 1);
  assert.match(tests[0], /if: runner\.os == 'Windows' && needs\.route\.outputs\.mode == 'all'/);
  assert.match(configuration.jobs.route.steps.find(step => step.id === 'coverage').run,
    /Where-Object cell -eq 'windows-py3\.11-stable'/);
  const scoped = configuration.jobs.build.steps.find(step => step.name === 'Run the scoped pull-request profile');
  assert.equal(scoped.if, "needs.route.outputs.mode != 'all'");
  assert.equal(scoped.env.VALIDATION_MODE, '${{ needs.route.outputs.mode }}');
  assert.equal(scoped.run, 'node scripts/run-validation.mjs "$env:VALIDATION_MODE"');
  assert.doesNotMatch(workflow, /ubuntu-latest|linux-py|xvfb-run/);
  assert.match(workflow, /runs-on: windows-2022/);
});

test('loads PR routing code from the trusted base and falls back to full coverage if unavailable', () => {
  const trusted = configuration.jobs.route.steps.find(step => step.id === 'trusted');
  assert.equal(trusted.if, "github.event_name == 'pull_request'");
  assert.equal(trusted.with.ref, '${{ github.event.pull_request.base.sha }}');
  assert.equal(trusted.with.path, '.validation-base');
  assert.equal(trusted.with['persist-credentials'], false);
  assert.equal(trusted['continue-on-error'], true);
  const coverage = configuration.jobs.route.steps.find(step => step.id === 'coverage');
  assert.equal(coverage.env.TRUSTED_BASE_OUTCOME, '${{ steps.trusted.outcome }}');
  assert.match(coverage.run, /\$mode = 'all'/);
  assert.match(coverage.run, /TRUSTED_BASE_OUTCOME -eq 'success'/);
  assert.match(coverage.run, /\.validation-base\/scripts\/validation-selection\.mjs/);
  assert.match(coverage.run, /LASTEXITCODE -eq 0/);
});

test('scoped PR results cannot produce release proofs and the aggregate gate checks actual execution', () => {
  const steps = configuration.jobs.build.steps;
  for (const name of ['Test release provenance and publication contracts',
    'Record complete cell and canonical asset provenance', 'Save exact validated proof and assets for fourteen days']) {
    assert.equal(steps.find(step => step.name === name).if, "needs.route.outputs.mode == 'all'");
  }
  assert.match(configuration.jobs.build.if, /needs\.route\.result == 'success'/);
  assert.match(configuration.jobs.build.if, /needs\.route\.outputs\.mode != 'none'/);
  const gate = configuration.jobs.validation;
  assert.equal(gate.if, 'always()');
  assert.deepEqual(gate.needs, ['route', 'select', 'build']);
  assert.match(gate.steps[0].run, /ROUTE_RESULT -ne 'success'/);
  assert.match(gate.steps[0].run, /BUILD_RESULT -eq 'success'/);
  assert.match(gate.steps[0].run, /MODE -eq 'none'/);
  assert.match(gate.steps[0].run, /throw 'The selected validation coverage did not succeed\.'/);
});

test('PowerShell routing ignores PR-owned selectors and every lookup failure falls back to all',
  { skip: process.platform !== 'win32' }, async t => {
    const temporary = await mkdtemp(path.join(os.tmpdir(), 'glw-validation-route-'));
    t.after(() => rm(temporary, { recursive: true, force: true }));
    const trusted = path.join(temporary, '.validation-base/scripts/validation-selection.mjs');
    await mkdir(path.dirname(trusted), { recursive: true });
    await mkdir(path.join(temporary, 'scripts'));
    await writeFile(path.join(temporary, 'scripts/validation-selection.mjs'), 'throw new Error("PR code must never execute");\n');
    const coverage = configuration.jobs.route.steps.find(step => step.id === 'coverage');
    const modernShell = spawnSync('pwsh.exe', ['-NoProfile', '-NonInteractive', '-Command', 'exit 0'], { windowsHide: true });
    const shell = modernShell.status === 0 ? 'pwsh.exe' :
      path.join(process.env.SystemRoot || 'C:/Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
    let serial = 0;
    async function route({ code, eventName = 'pull_request', outcome = 'success' }) {
      await writeFile(trusted, code);
      const output = path.join(temporary, `output-${serial++}.txt`);
      const result = spawnSync(shell, ['-NoProfile', '-NonInteractive', '-Command', coverage.run], {
        cwd: temporary, encoding: 'utf8', windowsHide: true,
        env: { ...process.env, GITHUB_EVENT_NAME: eventName, TRUSTED_BASE_OUTCOME: outcome,
          FULL_MATRIX: configuration.jobs.route.env.FULL_MATRIX, GITHUB_OUTPUT: output }
      });
      assert.equal(result.status, 0, result.error?.message || result.stderr);
      const bytes = await readFile(output);
      const text = bytes.toString(bytes[0] === 0xff && bytes[1] === 0xfe ? 'utf16le' : 'utf8');
      const values = Object.fromEntries(text.replace(/^\uFEFF/, '').trim().split(/\r?\n/)
        .map(row => [row.slice(0, row.indexOf('=')), row.slice(row.indexOf('=') + 1)]));
      return { mode: values.mode, cells: JSON.parse(values.matrix).include.map(cell => cell.cell) };
    }
    const ui = await route({ code: 'console.log(JSON.stringify({ mode: "ui" }));' });
    assert.equal(ui.mode, 'ui');
    assert.deepEqual(ui.cells, ['windows-py3.11-stable']);
    for (const options of [{ code: 'console.log(JSON.stringify({ mode: "none" }));', outcome: 'failure' },
      { code: 'console.log("invalid JSON");' }, { code: 'process.exit(1);' },
      { code: 'console.log(JSON.stringify({ mode: "unknown" }));' },
      { code: 'console.log(JSON.stringify({ mode: "none" }));', eventName: 'push' },
      { code: 'console.log(JSON.stringify({ mode: "none" }));', eventName: 'workflow_dispatch' },
      { code: 'console.log(JSON.stringify({ mode: "none" }));', eventName: 'workflow_call' }]) {
      const result = await route(options);
      assert.equal(result.mode, 'all');
      assert.equal(result.cells.length, 3);
    }
  });

test('promotes exact proof-bound artifacts with complete fallback and bounded retention', () => {
  assert.match(workflow, /release_ci.py select/);
  assert.match(workflow, /release_ci.py record/);
  assert.match(workflow, /release_ci.py publish/);
  assert.match(workflow, /retention-days: 14/);
  assert.match(workflow, /--fallback-current-run/);
  assert.doesNotMatch(workflow, /--clobber/);
  assert.match(helper, /MAX_AGE = dt.timedelta\(days=7\)/);
  assert.match(helper, /Existing release asset conflicts/);
});
