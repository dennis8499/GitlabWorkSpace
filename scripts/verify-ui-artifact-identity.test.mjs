import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import test from 'node:test';
import { compareUiArtifactIdentity, uiAssetPaths } from './verify-ui-artifact-identity.mjs';

// Minimal stored ZIP fixture writer; no extra package or shell ZIP command.
function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function zip(entries) {
  const local = [], directory = []; let offset = 0;
  for (const [name, text] of entries) {
    const filename = Buffer.from(name), body = Buffer.from(text), crc = crc32(body);
    const header = Buffer.alloc(30); header.writeUInt32LE(0x04034b50); header.writeUInt16LE(20, 4);
    header.writeUInt32LE(crc, 14); header.writeUInt32LE(body.length, 18); header.writeUInt32LE(body.length, 22); header.writeUInt16LE(filename.length, 26);
    local.push(header, filename, body);
    const central = Buffer.alloc(46); central.writeUInt32LE(0x02014b50); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6);
    central.writeUInt32LE(crc, 16); central.writeUInt32LE(body.length, 20); central.writeUInt32LE(body.length, 24); central.writeUInt16LE(filename.length, 28); central.writeUInt32LE(offset, 42);
    directory.push(central, filename); offset += header.length + filename.length + body.length;
  }
  const central = Buffer.concat(directory), end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(central.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, central, end]);
}
const assets = () => uiAssetPaths.map((name, index) => ['extension/resources/' + name, `asset-${index}\n`]);
async function fixture(t, candidateEntries) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'glw-ui-identity-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const reference = path.join(root, 'reference.vsix'), candidate = path.join(root, 'candidate.vsix');
  await writeFile(reference, zip([...assets(), ['extension/out/host.js', 'old Host']]));
  await writeFile(candidate, zip(candidateEntries));
  return { root, reference, candidate };
}

test('Host-only VSIX changes retain six exact UI assets while both complete artifact hashes differ', async t => {
  const f = await fixture(t, [...assets(), ['extension/out/host.js', 'changed Host']]);
  const report = await compareUiArtifactIdentity(f.reference, f.candidate);
  assert.equal(report.status, 'PASS'); assert.notEqual(report.reference.sha256, report.candidate.sha256);
  assert.equal(report.assets.length, 6); assert.ok(report.assets.every(asset => asset.identical && asset.reference.sha256 === asset.candidate.sha256));
});

test('a single UI byte change or missing asset prevents a provenance PASS', async t => {
  const changed = assets(); changed[1][1] += 'changed';
  const f = await fixture(t, changed);
  const report = await compareUiArtifactIdentity(f.reference, f.candidate);
  assert.equal(report.status, 'FAIL'); assert.equal(report.assets.filter(asset => !asset.identical).length, 1);
  await writeFile(f.candidate, zip(assets().slice(1)));
  const missing = await compareUiArtifactIdentity(f.reference, f.candidate);
  assert.equal(missing.status, 'FAIL'); assert.equal(missing.assets[0].candidate, null);
});

test('duplicate asset entries are rejected and CLI writes a failing report with exit code one', async t => {
  const f = await fixture(t, [...assets(), assets()[0]]);
  await assert.rejects(compareUiArtifactIdentity(f.reference, f.candidate), /Duplicate packaged UI asset/);
  const changed = assets(); changed[0][1] += 'different'; await writeFile(f.candidate, zip(changed));
  const output = path.join(f.root, 'report.json');
  const command = fileURLToPath(new URL('./verify-ui-artifact-identity.mjs', import.meta.url));
  await assert.rejects(promisify(execFile)(process.execPath, [command, '--reference', f.reference, '--candidate', f.candidate, '--output', output]), error => error.code === 1);
  assert.equal(JSON.parse(await readFile(output, 'utf8')).status, 'FAIL');
});
