import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import yauzl from 'yauzl';

const directory = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(directory, '../../..');
const artifact = path.join(root, 'dist/gitlab-workspace-0.26.0-responsiveness-candidate.vsix');
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const checked = [], mismatches = [], normalizedFiles = [];
await new Promise((resolve, reject) => yauzl.open(artifact, { lazyEntries: true }, (error, zip) => {
  if (error) return reject(error);
  zip.on('error', reject);
  zip.on('end', resolve);
  zip.on('entry', entry => {
    if (!entry.fileName.startsWith('extension/') || entry.fileName.endsWith('/')) { zip.readEntry(); return; }
    const relative = entry.fileName.slice('extension/'.length);
    const filename = path.resolve(root, relative);
    assert.ok(filename.startsWith(root + path.sep), 'VSIX entry must remain in the intended workspace');
    zip.openReadStream(entry, (streamError, stream) => {
      if (streamError) return reject(streamError);
      const chunks = [];
      stream.on('error', reject);
      stream.on('data', chunk => chunks.push(chunk));
      stream.on('end', () => {
        try {
          let localBytes = readFileSync(filename);
          if (relative.toLowerCase() === 'readme.md') {
            // VSCE rewrites relative Markdown links for the Marketplace README.
            localBytes = Buffer.from(localBytes.toString('utf8').replace(/\]\(((?:docs\/[^)]+|CONTRIBUTING\.md))\)/g,
              '](' + 'https://github.com/dennis8499/GitlabWorkSpace/blob/HEAD/$1)'));
            normalizedFiles.push({ path: relative, normalization: 'VSCE relative documentation links to repository blob/HEAD URLs' });
          }
          const archived = sha256(Buffer.concat(chunks)), rebuilt = sha256(localBytes);
          checked.push(relative);
          if (archived !== rebuilt) mismatches.push({ path: relative, archived, rebuilt });
          zip.readEntry();
        } catch (failure) { reject(failure); }
      });
    });
  });
  zip.readEntry();
}));
assert.ok(checked.some(filename => filename === 'out/src/extension.js'));
assert.ok(checked.some(filename => filename === 'resources/issue-webview/dashboard.js'));
assert.ok(checked.some(filename => filename === 'resources/sidebar-webview/sidebar.js'));
const result = { schema: 'GitLabWorkspaceArtifactEquivalence/v1', generatedAt: new Date().toISOString(),
  status: mismatches.length ? 'FAIL' : 'PASS', artifact: { path: path.relative(root, artifact).replaceAll(path.sep, '/'), sha256: sha256(readFileSync(artifact)) },
  scope: 'Every file under extension/ in the delivered VSIX compared with the rebuilt workspace. Runtime files are byte-identical; README links undergo the deterministic VSCE Marketplace rewrite. VSIX container metadata is excluded. Later changes only corrected native test instrumentation; test/ and out/test/ are excluded from the VSIX.',
  checkedFiles: checked.length, checked, normalizedFiles, mismatches };
writeFileSync(path.join(directory, 'evidence/fixture-artifact-equivalence.json'), JSON.stringify(result, null, 2) + '\n');
assert.deepEqual(mismatches, [], 'The rebuilt product must match every delivered VSIX file');
console.log(JSON.stringify({ status: result.status, checkedFiles: checked.length, sha256: result.artifact.sha256 }));
