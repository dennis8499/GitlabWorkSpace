import assert from 'node:assert/strict';
import test from 'node:test';
import { webviewAssetPaths } from './webview-assets.mjs';

const manifest = () => ({
  'dashboard.html': { file: 'dashboard.js', isEntry: true, css: ['dashboard.css'], dynamicImports: ['src/webview/Feature.tsx'], imports: ['_shared.js'] },
  '_shared.js': { file: 'chunks/shared-123.js', assets: ['codicon.ttf'] },
  'src/webview/Feature.tsx': { file: 'chunks/feature-456.js', imports: ['_shared.js'] }
});

test('Webview manifest covers lazy modules and their shared dependencies exactly once', () => {
  assert.deepEqual(webviewAssetPaths(manifest()), ['asset-manifest.json', 'chunks/feature-456.js', 'chunks/shared-123.js', 'codicon.ttf', 'dashboard.css', 'dashboard.html', 'dashboard.js']);
});
test('Webview manifests reject missing dependencies, unsafe paths and malformed lists', () => {
  const missing = manifest(); delete missing['_shared.js'];
  assert.throws(() => webviewAssetPaths(missing), /Missing Webview manifest dependency/);
  for (const file of ['../outside.js', '/absolute.js', 'https://remote.test/file.js', 'chunks\\bad.js']) {
    const value = manifest(); value['src/webview/Feature.tsx'].file = file;
    assert.throws(() => webviewAssetPaths(value), /Unsafe Webview asset path/);
  }
  const invalid = manifest(); invalid['dashboard.html'].dynamicImports = 'bad';
  assert.throws(() => webviewAssetPaths(invalid), /Invalid Webview manifest/);
  assert.throws(() => webviewAssetPaths(undefined), /Missing or invalid/);
  assert.equal(webviewAssetPaths(undefined, { allowLegacy: true }).length, 4);
});
