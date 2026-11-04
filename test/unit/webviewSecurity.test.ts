import assert from 'node:assert/strict';
import test from 'node:test';
import type { Uri, Webview } from 'vscode';
import { createWebviewCsp, prepareWebviewHtml } from '../../src/webviewSecurity';

test('both production surfaces prohibit inline styles and nonce every entry script', () => {
  const webview = { cspSource: 'https://resources.test', asWebviewUri: () => ({ toString: () => 'https://resources.test/assets' }) };
  for (const surface of ['dashboard', 'sidebar'] as const) {
    const csp = createWebviewCsp(webview.cspSource, 'known-nonce', surface);
    assert.ok(!csp.includes('unsafe-inline'));
    assert.match(csp, /style-src-attr 'none'/);
    assert.match(csp, /style-src https:\/\/resources.test;/);
    const html = prepareWebviewHtml('<head><script src="one.js"></script><script src="two.js"></script></head>',
      webview as unknown as Pick<Webview, 'cspSource' | 'asWebviewUri'>, {} as Uri, surface, 'known-nonce');
    assert.equal((html.match(/nonce="known-nonce"/g) ?? []).length, 2);
    assert.ok(html.indexOf('Content-Security-Policy') < html.indexOf('<script'));
    assert.equal(csp.includes('worker-src'), surface === 'dashboard');
    if (surface === 'dashboard') assert.match(csp, /worker-src https:\/\/resources.test blob:/);
  }
});
