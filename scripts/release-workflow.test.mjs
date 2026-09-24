import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const workflow = await readFile(new URL('../.github/workflows/release.yml', import.meta.url), 'utf8');

test('[BDD-REL-003] runs validation, tests, packaging, then gates publication on the build job', () => {
  assert.match(workflow, /tags:\s*\n\s+-\s*['"]v\*['"]/);
  assert.match(workflow, /npm ci/);
  assert.match(workflow, /npm run check:release/);
  assert.match(workflow, /xvfb-run\s+-a\s+npm test/);
  assert.match(workflow, /npm run package/);
  assert.match(workflow, /needs:\s*build/);
  assert.match(workflow, /actions\/upload-artifact@v\d+/);
  assert.match(workflow, /actions\/download-artifact@v\d+/);

  assert.ok(workflow.indexOf('xvfb-run -a npm test') < workflow.indexOf('npm run package'));
  assert.ok(workflow.indexOf('needs: build') < workflow.indexOf('gh release create'));
});

test('keeps the build read-only and grants write access only to the release job', () => {
  assert.match(workflow, /^permissions:\s*\r?\n\s+contents:\s*read\s*$/m);
  const publishJob = workflow.match(/\n  publish:\s*\n([\s\S]*)/);
  assert.ok(publishJob, 'publish job exists');
  assert.match(publishJob[1], /permissions:\s*\r?\n\s+contents:\s*write/);
  assert.doesNotMatch(workflow.slice(0, workflow.indexOf('\n  publish:')), /contents:\s*write/);
});

test('fails on an existing release and chooses prerelease only for v0.1.0 or a SemVer prerelease suffix', () => {
  assert.match(workflow, /gh release view[\s\S]*?exit 1/);
  assert.match(workflow, /--verify-tag/);
  assert.match(workflow, /--generate-notes/);
  assert.doesNotMatch(workflow, /--clobber/);
  assert.match(workflow, /TAG_NAME.*v0\.1\.0.*\^v\[\^\+\]\*-/s);
  assert.match(workflow, /--prerelease/);
});

