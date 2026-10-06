const { createRequire } = require('node:module');
const path = require('node:path');
const testCliRequire = createRequire(require.resolve('@vscode/test-cli'));
const Mocha = testCliRequire('mocha');

exports.run = function run() {
  const mocha = new Mocha({ ui: 'tdd', timeout: 120_000, color: false });
  const directory = path.join(__dirname, '..', 'out', 'test', 'extension');
  for (const file of ['activation.test.js', 'groupWorkflow.test.js', 'liveValidation.test.js']) {
    mocha.addFile(path.join(directory, file));
  }
  return new Promise((resolve, reject) => {
    mocha.run((failures) => failures ? reject(new Error(`${failures} Extension Host validation test(s) failed.`)) : resolve());
  });
};
