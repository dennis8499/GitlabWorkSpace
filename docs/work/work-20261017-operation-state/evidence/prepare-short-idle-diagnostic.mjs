import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = process.cwd();
const dir = path.join(root, 'docs/work/work-20261017-operation-state/evidence/git-gui-short-idle-diagnostic');
mkdirSync(dir, { recursive: true });
const original = readFileSync(path.join(root, 'out/test/extension/liveValidation.test.js'), 'utf8');
const needle = 'setTimeout(resolve, 60_000)';
if (original.split(needle).length !== 2) throw new Error('Expected exactly one fixed idle delay in the compiled local GUI fixture.');
writeFileSync(path.join(dir, 'liveValidation.short-idle.cjs'), original.replace(needle, 'setTimeout(resolve, 1_000)'));
let driver = readFileSync(path.join(root, 'scripts/run-live-extension-tests.mjs'), 'utf8');
driver = driver.replace("const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');", 'const ROOT = ' + JSON.stringify(root) + ';');
for (const name of ['live-benchmark-comparison.mjs', 'live-test-paths.mjs']) {
  driver = driver.replace("'./" + name + "'", JSON.stringify(pathToFileURL(path.join(root, 'scripts', name)).href));
}
const entryPath = path.join(dir, 'diagnostic-entry.cjs');
driver = driver.replaceAll("path.join(ROOT, 'scripts', 'live-extension-test-entry.cjs')", JSON.stringify(entryPath));
writeFileSync(path.join(dir, 'diagnostic-driver.mjs'), driver);
const entry = [
  "const path = require('node:path');",
  "const { createRequire } = require('node:module');",
  "const root = " + JSON.stringify(root) + ";",
  "const projectRequire = createRequire(path.join(root, 'package.json'));",
  "const testCliRequire = createRequire(projectRequire.resolve('@vscode/test-cli'));",
  "const Mocha = testCliRequire('mocha');",
  "if (typeof globalThis.WebSocket === 'undefined') globalThis.WebSocket = projectRequire('playwright-core/lib/utilsBundle').ws;",
  "exports.run = () => new Promise((resolve, reject) => {",
  "  const mocha = new Mocha({ui: 'tdd', timeout: 120000, color: false});",
  "  for (const name of ['activation.test.js', 'groupWorkflow.test.js']) mocha.addFile(path.join(root, 'out/test/extension', name));",
  "  mocha.addFile(path.join(__dirname, 'liveValidation.short-idle.cjs'));",
  "  mocha.addFile(path.join(root, 'out/test/extension/nativeDiff.test.js'));",
  "  mocha.run(failures => failures ? reject(new Error(failures + ' diagnostic failure(s)')) : resolve());",
  "});", ""
].join('\n');
writeFileSync(entryPath, entry);
writeFileSync(path.join(dir, 'diagnostic-scope.json'), JSON.stringify({
  schema:'GitLabWorkspaceShortIdleDiagnostic/v1', status:'DIAGNOSTIC_ONLY',
  formalAcceptance:false, change:'Only the copied compiled live test uses 1 second rather than 60 seconds for its idle observation; source, out, VSIX and final formal fixture are unchanged.',
  requiredFollowup:'Run the original scripts/run-live-extension-tests.mjs with all five 60 second idle checks before claiming GUI acceptance.'
}, null, 2) + '\n');
console.log('Prepared separate short-idle diagnostic driver; not formal acceptance.');

