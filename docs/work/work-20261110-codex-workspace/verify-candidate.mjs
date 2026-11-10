import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import yauzl from 'yauzl';
import { assertPrepared, fingerprint } from '../../../scripts/validation-runtime.mjs';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const work = path.dirname(fileURLToPath(import.meta.url));
const gate = path.resolve(root, process.argv[2]);
const manifest = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
const archivePath = path.join(root, 'dist', manifest.name + '-' + manifest.version + '.vsix');
const archiveBytes = await readFile(archivePath);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const ui = ['dashboard.html', 'dashboard.js', 'dashboard.css', 'codicon.ttf'];
const required = [
  'out/src/codex/bridge.js', 'out/src/codex/launchCoordinator.js', 'out/src/codex/uiDraftStore.js',
  'out/src/codex/uiDraftProtocol.js', 'out/src/storage/controlLease.js', 'out/src/workspace/workspacePanel.js',
  'docs/licenses/marked-LICENSE.md'
];
const wanted = new Set(['extension/package.json', ...ui.map(name => 'extension/resources/issue-webview/' + name), ...required.map(name => 'extension/' + name)]);
const members = new Map();
await new Promise((resolve, reject) => yauzl.fromBuffer(archiveBytes, { lazyEntries: true }, (error, zip) => {
  if (error) { reject(error); return; }
  const fail = error => { zip.close(); reject(error); };
  zip.on('error', fail); zip.on('end', resolve);
  zip.on('entry', entry => {
    if (!wanted.has(entry.fileName)) { zip.readEntry(); return; }
    if (members.has(entry.fileName) || entry.uncompressedSize > 32 * 1024 * 1024) { fail(new Error('Duplicate or oversized audited entry')); return; }
    zip.openReadStream(entry, (error, stream) => {
      if (error) { fail(error); return; }
      const chunks = []; stream.on('error', fail); stream.on('data', bytes => chunks.push(bytes));
      stream.on('end', () => { members.set(entry.fileName, Buffer.concat(chunks)); zip.readEntry(); });
    });
  });
  zip.readEntry();
}));
assert.equal(members.size, wanted.size);
const packaged = JSON.parse(members.get('extension/package.json').toString('utf8'));
assert.equal(packaged.name, manifest.name); assert.equal(packaged.version, manifest.version);
const uiHashes = {};
for (const name of ui) {
  const relative = 'resources/issue-webview/' + name, bytes = members.get('extension/' + relative);
  assert.ok(bytes.equals(await readFile(path.join(root, relative))), 'VSIX UI differs: ' + name);
  uiHashes[name] = hash(bytes);
}
for (const relative of required) assert.ok(members.get('extension/' + relative).equals(await readFile(path.join(root, relative))), 'Stale Host/notice: ' + relative);
const nativeNames = ['native-codex-zoom.json', 'native-codex-draft-recovery.json'];
for (const name of nativeNames) {
  const proof = JSON.parse(await readFile(path.join(gate, name), 'utf8'));
  for (const item of ui) assert.equal(proof.assetHashes[item], uiHashes[item], name + ': asset mismatch');
}
const qa = JSON.parse(await readFile(path.join(work, 'evidence/ui-matrix-final/results.json'), 'utf8'));
assert.equal(qa.scenarios, 104); assert.equal(qa.findingCount, 0); assert.equal(qa.assetsUnchangedDuringProbe, true);
for (const name of ui) assert.equal(qa.assetHashes[name], uiHashes[name], 'Browser QA asset mismatch: ' + name);
const renderer = JSON.parse(await readFile(path.join(gate, 'codex-renderer.json'), 'utf8'));
assert.ok(renderer.measurements.length > 0);
for (const measurement of renderer.measurements) assert.equal(measurement.bundleSha256, uiHashes['dashboard.js']);
const timings = JSON.parse(await readFile(path.join(gate, 'timings.json'), 'utf8'));
assert.equal(timings.success, true); assert.equal(timings.status, 'success');
const unitProof = JSON.parse(await readFile(path.join(work, 'evidence/host-unit-provenance.json'), 'utf8'));
assert.equal(unitProof.status, 'PASS');
assert.equal(await fingerprint(root, ['out/src', 'out/test/unit']), unitProof.hostAndUnitSha256, 'Final Host/unit bytes differ from the passing complete unit gate');
const unitTimings = JSON.parse(await readFile(path.join(root, unitProof.unitGate, 'timings.json'), 'utf8'));
assert.equal(unitTimings.stages.find(stage => stage.id === 'unit')?.exitCode, 0);
const packageGate = path.resolve(root, process.argv[3]);
assert.equal(JSON.parse(await readFile(path.join(packageGate, 'timings.json'), 'utf8')).success, true);
const feedback = JSON.parse(await readFile(path.join(work, 'evidence/performance-final/local-feedback.json'), 'utf8'));
for (const name of ui) assert.equal(feedback.assetHashes[name], uiHashes[name], 'Feedback benchmark asset mismatch');
assert.equal(feedback.measurements.length, 2);
for (const measurement of feedback.measurements) {
  for (const kind of ['localAction', 'warmTaskSwitch']) { assert.equal(measurement[kind].count, 30); assert.equal(measurement[kind].passed, true); }
  assert.equal(measurement.remoteActions, 0); assert.ok(measurement.mountedMax < 100);
  assert.deepEqual(measurement.errors, []); assert.deepEqual(measurement.external, []);
}
const preparation = await assertPrepared(root, ['compile', 'typecheck-webview', 'webview', 'issue']);
const archiveHash = hash(archiveBytes);
assert.equal((await readFile(path.join(root, 'dist/SHA256SUMS'), 'utf8')).trim(), archiveHash + '  ' + path.basename(archivePath));
const report = { schema: 'GitLabWorkspaceCandidateIdentity/v1', status: 'PASS', version: manifest.version,
  archive: { file: path.basename(archivePath), bytes: archiveBytes.length, sha256: archiveHash },
  uiHashes, requiredHostFilesAndNotice: required, nativeProofs: nativeNames, visualScenarios: qa.scenarios,
  rendererMeasurements: renderer.measurements.length, preparationInputSha256: preparation.inputs,
  unitValidation: { pass: unitProof.pass, skipped: unitProof.skipped, identicalHostAndUnitSha256: unitProof.hostAndUnitSha256 },
  localFeedbackSamples: 120, packageGate,
  method: 'Exact delivered bytes match current build, both native proofs, 104 browser scenarios and renderer; final build receipt and checksum are valid.' };
await writeFile(path.join(work, 'evidence/candidate-identity.json'), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report));
