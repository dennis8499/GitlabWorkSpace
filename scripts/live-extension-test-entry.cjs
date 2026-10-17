const { createRequire } = require('node:module');
const path = require('node:path');
const testCliRequire = createRequire(require.resolve('@vscode/test-cli'));
const Mocha = testCliRequire('mocha');

// VS Code 1.90 embeds Node 20.9, which has no global WebSocket. The CDP
// test driver uses the browser-style API supplied by Playwright's bundled ws.
if (typeof globalThis.WebSocket === 'undefined') {
  globalThis.WebSocket = require('playwright-core/lib/utilsBundle').ws;
}

exports.run = function run() {
  const mocha = new Mocha({ ui: 'tdd', timeout: 120_000, color: false });
  const directory = path.join(__dirname, '..', 'out', 'test', 'extension');
  for (const file of ['activation.test.js', 'groupWorkflow.test.js', 'liveValidation.test.js', 'nativeDiff.test.js']) {
    mocha.addFile(path.join(directory, file));
  }
  return new Promise((resolve, reject) => {
    mocha.run((failures) => failures ? reject(new Error(`${failures} Extension Host validation test(s) failed.`)) : resolve());
  });
};
