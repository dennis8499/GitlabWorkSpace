const path = require('node:path');
const { createRequire } = require('node:module');
const root = "C:\\Users\\denni\\OneDrive\\Desktop\\新增資料夾\\GitlabWorkSpace";
const projectRequire = createRequire(path.join(root, 'package.json'));
const testCliRequire = createRequire(projectRequire.resolve('@vscode/test-cli'));
const Mocha = testCliRequire('mocha');
if (typeof globalThis.WebSocket === 'undefined') globalThis.WebSocket = projectRequire('playwright-core/lib/utilsBundle').ws;
exports.run = () => new Promise((resolve, reject) => {
  const mocha = new Mocha({ui: 'tdd', timeout: 120000, color: false});
  for (const name of ['activation.test.js', 'groupWorkflow.test.js']) mocha.addFile(path.join(root, 'out/test/extension', name));
  mocha.addFile(path.join(__dirname, 'liveValidation.short-idle.cjs'));
  mocha.addFile(path.join(root, 'out/test/extension/nativeDiff.test.js'));
  mocha.run(failures => failures ? reject(new Error(failures + ' diagnostic failure(s)')) : resolve());
});
