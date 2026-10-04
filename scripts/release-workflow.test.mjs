import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const workflow = await readFile(new URL('../.github/workflows/release.yml', import.meta.url), 'utf8');

test('[BDD-REL-003] verifies Linux and Windows releases before gated publication', () => {
  assert.match(workflow, /tags:\s*\n\s+-\s*['"]v\*['"]/);
  assert.match(workflow, /npm ci/);
  assert.match(workflow, /npm run check:release/);
  assert.match(workflow, /npm test/);
  assert.match(workflow, /windows-2022/);
  assert.match(workflow, /python-version:\s*'3\.11'/);
  assert.match(workflow, /python-version:\s*'3\.14'/);
  assert.match(workflow, /VSCODE_TEST_VERSION/);
  assert.match(workflow, /npm run package/);
  assert.match(workflow, /needs:\s*build/);
  assert.match(workflow, /actions\/upload-artifact@v\d+/);
  assert.match(workflow, /actions\/download-artifact@v\d+/);
  assert.match(workflow, /name: release-assets/);
  assert.match(workflow, /dist\/\*\.vsix/);
  assert.match(workflow, /dist\/gitlab-workspace-kit-\*\.zip/);
  assert.match(workflow, /dist\/SHA256SUMS/);
  assert.match(workflow, /sha256sum --check SHA256SUMS/);

  assert.match(workflow, /branches:\s*\r?\n\s*- main/);
  assert.match(workflow, /pull_request:/);
  assert.ok(workflow.indexOf('npm test') < workflow.indexOf('npm run package'));
  assert.ok(workflow.indexOf('needs: build') < workflow.indexOf('gh release create'));
});

test('keeps the build read-only and grants write access only to the release job', () => {
  assert.match(workflow, /^permissions:\s*\r?\n\s+contents:\s*read\s*$/m);
  const publishJob = workflow.match(/\n  publish:\s*\n([\s\S]*)/);
  assert.ok(publishJob, 'publish job exists');
  assert.match(publishJob[1], /permissions:\s*\r?\n\s+contents:\s*write/);
  assert.doesNotMatch(workflow.slice(0, workflow.indexOf('\n  publish:')), /contents:\s*write/);
});

test('runs Xvfb only on Linux and runs the full suite directly on Windows', () => {
  const steps = workflow.split(/\r?\n\s+- name:/).slice(1);
  const linux = steps.find(step => /run: xvfb-run -a npm test/.test(step));
  const windows = steps.find(step => /run: npm test(?:\r?\n|$)/.test(step));
  assert.ok(linux, 'Linux runs the full suite with a virtual display');
  assert.match(linux, /if: runner\.os == 'Linux'/);
  assert.ok(windows, 'Windows runs the full suite directly');
  assert.match(windows, /if: runner\.os == 'Windows'/);
  assert.doesNotMatch(windows, /xvfb-run/);
});

test('fails on an existing release and chooses prerelease only for v0.1.0 or a SemVer prerelease suffix', () => {
  assert.match(workflow, /gh release view[\s\S]*?exit 1/);
  assert.match(workflow, /--verify-tag/);
  assert.match(workflow, /--generate-notes/);
  assert.doesNotMatch(workflow, /--clobber/);
  assert.match(workflow, /TAG_NAME.*v0\.1\.0.*\^v\[\^\+\]\*-/s);
  assert.match(workflow, /--prerelease/);
});

