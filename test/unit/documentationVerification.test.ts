import assert from 'node:assert/strict';
import test from 'node:test';
import { isDocumentationOnly } from '../../src/codex/documentationVerification';

test('documentation verification accepts text documents and raster images under docs only', () => {
  assert.equal(isDocumentationOnly(['README.md', 'CHANGELOG.MD', 'docs/guide.mdx', 'docs/overview.rst', 'notes.txt', 'packages/core/README.md']), true);
  assert.equal(isDocumentationOnly(['docs/images/flow.PNG', 'docs/cover.jpg', 'docs/screen.webp', 'docs/preview.avif']), true);
});

test('empty mixed executable configuration and test changes cannot use manual document verification', () => {
  assert.equal(isDocumentationOnly([]), false);
  for (const file of ['src/main.ts', 'docs/client.js', 'package.json', 'tests/README.md', 'test/fixture.txt', 'config/settings.txt', 'code/example.txt',
    'src/guide.md', '.github/workflows/README.md', 'requirements.txt', 'requirements-dev.txt', 'constraints.txt', 'CMakeLists.txt', 'runtime.txt']) {
    assert.equal(isDocumentationOnly(['README.md', file]), false, file);
  }
});

test('active image formats and images outside docs remain in the normal verification flow', () => {
  for (const file of ['docs/diagram.svg', 'docs/page.html', 'docs/image.svgz', 'docs/view.pdf', 'assets/diagram.png', 'cover.jpg']) {
    assert.equal(isDocumentationOnly([file]), false, file);
  }
});

test('manual documentation classification rejects redirected and platform-ambiguous path spellings', () => {
  for (const file of ['../README.md', '/README.md', 'docs/../README.md', 'docs/./README.md', 'docs//README.md', 'C:/docs/README.md',
    'docs\\README.md', 'docs/README.md:stream', 'docs/hidden./README.md', 'docs/private /README.md', 'docs/line\nname.md', 'docs/.hidden.md', 'docs/NUL.md']) {
    assert.equal(isDocumentationOnly([file]), false, JSON.stringify(file));
  }
});
