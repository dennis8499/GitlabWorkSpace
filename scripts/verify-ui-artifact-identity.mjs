import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import yauzl from 'yauzl';

// The six assets executed by scripts/validate-packaged-ui.mjs.
export const uiAssetPaths = Object.freeze([
  'issue-webview/dashboard.html', 'issue-webview/dashboard.js', 'issue-webview/dashboard.css',
  'sidebar-webview/sidebar.html', 'sidebar-webview/sidebar.js', 'sidebar-webview/sidebar.css'
]);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const resourceRoot = 'extension/resources/';

async function extractUiAssets(bytes) {
  const files = new Map();
  await new Promise((resolve, reject) => yauzl.fromBuffer(bytes, { lazyEntries: true, validateEntrySizes: true }, (error, archive) => {
    if (error) { reject(error); return; }
    const fail = error => { archive.close(); reject(error); };
    archive.on('error', fail); archive.on('end', resolve);
    archive.on('entry', entry => {
      const name = entry.fileName.startsWith(resourceRoot) ? entry.fileName.slice(resourceRoot.length) : '';
      if (!uiAssetPaths.includes(name)) { archive.readEntry(); return; }
      if (files.has(name)) { fail(new Error(`Duplicate packaged UI asset: ${name}`)); return; }
      if (entry.uncompressedSize > 32 * 1024 * 1024) { fail(new Error(`Packaged UI asset exceeds 32 MiB: ${name}`)); return; }
      archive.openReadStream(entry, (error, stream) => {
        if (error) { fail(error); return; }
        const chunks = []; let size = 0;
        stream.on('error', fail);
        stream.on('data', chunk => {
          size += chunk.length;
          if (size > 32 * 1024 * 1024) { stream.destroy(new Error(`Packaged UI asset exceeds 32 MiB: ${name}`)); return; }
          chunks.push(chunk);
        });
        stream.on('end', () => { files.set(name, Buffer.concat(chunks)); archive.readEntry(); });
      });
    });
    archive.readEntry();
  }));
  return files;
}

/** Compare only bytes; this does not run either artifact or repeat a benchmark. */
export async function compareUiArtifactIdentity(referencePath, candidatePath) {
  const paths = [referencePath, candidatePath].map(value => path.resolve(value));
  const bytes = await Promise.all(paths.map(value => readFile(value)));
  // Extract from the same immutable buffers whose archive hashes are recorded.
  const files = await Promise.all(bytes.map(extractUiAssets));
  const fileMetadata = value => value === undefined ? null : { bytes: value.length, sha256: hash(value) };
  const assets = uiAssetPaths.map(name => {
    const reference = files[0].get(name), candidate = files[1].get(name);
    return { path: resourceRoot + name, reference: fileMetadata(reference), candidate: fileMetadata(candidate),
      identical: reference !== undefined && candidate !== undefined && reference.equals(candidate) };
  });
  return {
    schema: 'GitLabWorkspaceUiArtifactIdentity/v1', generatedAt: new Date().toISOString(),
    status: assets.every(asset => asset.identical) ? 'PASS' : 'FAIL',
    method: 'Exact Buffer.equals comparison of the six uncompressed packaged Webview assets; SHA-256 is computed from the same archive and asset buffers.',
    scope: 'Establishes UI asset identity only; does not establish Extension Host behavior or repeat browser performance measurements.',
    reference: { path: paths[0], bytes: bytes[0].length, sha256: hash(bytes[0]) },
    candidate: { path: paths[1], bytes: bytes[1].length, sha256: hash(bytes[1]) }, assets
  };
}

async function main() {
  const args = process.argv.slice(2), options = {};
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index];
    if (!['--reference', '--candidate', '--output'].includes(name) || !args[index + 1] || args[index + 1].startsWith('--') || options[name]) throw new Error('Usage: node scripts/verify-ui-artifact-identity.mjs --reference <VSIX> --candidate <VSIX> --output <JSON>');
    options[name] = args[index + 1];
  }
  if (!options['--reference'] || !options['--candidate'] || !options['--output']) throw new Error('Provide --reference, --candidate and --output.');
  const output = path.resolve(options['--output']);
  if ([options['--reference'], options['--candidate']].some(value => path.resolve(value).toLocaleLowerCase() === output.toLocaleLowerCase())) throw new Error('The output JSON must not overwrite either input artifact.');
  const report = await compareUiArtifactIdentity(options['--reference'], options['--candidate']);
  await mkdir(path.dirname(output), { recursive: true });
  await writeFile(output, JSON.stringify(report, null, 2) + '\n', 'utf8');
  process.stdout.write(JSON.stringify({ status: report.status, referenceSha256: report.reference.sha256, candidateSha256: report.candidate.sha256,
    identicalAssets: report.assets.filter(asset => asset.identical).length, expectedAssets: uiAssetPaths.length, output }) + '\n');
  if (report.status !== 'PASS') process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(error => {
  process.stderr.write((error instanceof Error ? error.message : String(error)) + '\n'); process.exitCode = 1;
});
