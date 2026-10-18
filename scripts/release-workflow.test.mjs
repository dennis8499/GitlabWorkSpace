import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const workflow = await readFile(new URL('../.github/workflows/release.yml', import.meta.url), 'utf8');
const helper = await readFile(new URL('./release_ci.py', import.meta.url), 'utf8');

test('[BDD-REL-003] retains all four platform cells and builds once per validation', () => {
  const cells = [...workflow.matchAll(/^\s+- cell: (\S+)$/gm)].map(match => match[1]);
  assert.deepEqual(cells, ['linux-py3.11-stable', 'windows-py3.11-1.90.0', 'windows-py3.11-stable', 'windows-py3.14-stable']);
  assert.match(workflow, /npm ci/);
  assert.match(workflow, /npm run check:release/);
  assert.match(workflow, /VSCODE_TEST_VERSION/);
  assert.doesNotMatch(workflow, /run: npm run package/);
  assert.match(workflow, /branches:\s*\n\s+- main/);
  assert.match(workflow, /pull_request:/);
  assert.match(workflow, /workflow_dispatch:/);
});

test('keeps validation read-only and grants write only to guarded tag promotion', () => {
  for (const eol of ['\n', '\r\n']) {
    const text = workflow.replace(/\r?\n/g, eol);
    const [validation, publish] = text.split(/\r?\n  publish:\r?\n/);
    assert.doesNotMatch(validation, /contents:\s*write/);
    assert.match(publish, /contents:\s*write/);
    assert.match(publish, /github.event_name == 'push' && startsWith\(github.ref, 'refs\/tags\/'\)/);
    assert.match(publish, /needs: \[select, build\]/);
    assert.match(publish, /needs.build.result == 'success'/);
    assert.match(publish, /needs.select.outputs.reuse_run_id != ''/);
    assert.doesNotMatch(publish, /npm test|npm run package|npm ci/);
  }
});

test('runs Xvfb only on Linux and the full suite directly on Windows', () => {
  const steps = workflow.split(/\r?\n\s+- name:/).slice(1);
  const linux = steps.find(step => /run: xvfb-run -a npm test/.test(step));
  const windows = steps.find(step => /run: npm test(?:\r?\n|$)/.test(step));
  assert.match(linux, /if: runner\.os == 'Linux'/);
  assert.match(windows, /if: runner\.os == 'Windows'/);
  assert.doesNotMatch(windows, /xvfb-run/);
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
