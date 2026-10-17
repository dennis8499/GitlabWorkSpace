import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Preparation only. This generator never launches VS Code, imports the driver,
// changes compiled tests, or writes outside this evidence directory.
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const EVIDENCE = path.dirname(fileURLToPath(import.meta.url));
const TARGET = path.join(EVIDENCE, 'git-gui-final-v5');
const relative = file => path.relative(ROOT, file).split(path.sep).join('/');
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const canonicalPath = path.join(ROOT, 'scripts', 'run-live-extension-tests.mjs');
const correctedPath = path.join(TARGET, 'fixture-driver.mjs');
const canonicalBytes = readFileSync(canonicalPath);
const canonical = canonicalBytes.toString('utf8');
const replacements = [
  {
    kind: 'root',
    from: "const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');",
    to: `const ROOT = ${JSON.stringify(ROOT)};`, count: 1
  },
  {
    kind: 'helper-import',
    from: "import { compareLiveBenchmarks } from './live-benchmark-comparison.mjs';",
    to: `import { compareLiveBenchmarks } from ${JSON.stringify(pathToFileURL(path.join(ROOT, 'scripts', 'live-benchmark-comparison.mjs')).href)};`, count: 1
  },
  {
    kind: 'helper-import',
    from: "import { sameFilesystemPath, createLiveTestProfile } from './live-test-paths.mjs';",
    to: `import { sameFilesystemPath, createLiveTestProfile } from ${JSON.stringify(pathToFileURL(path.join(ROOT, 'scripts', 'live-test-paths.mjs')).href)};`, count: 1
  },
  {
    kind: 'workspace-folder',
    from: "  writeFileSync(workspaceFile, JSON.stringify({ folders: [{ path: repository }] }, null, 2), 'utf8');",
    to: "  writeFileSync(workspaceFile, JSON.stringify({ folders: [{ path: workspaceRoot }] }, null, 2), 'utf8');", count: 1
  }
];
const replaceExactly = (source, from, to) => {
  assert.equal(source.split(from).length - 1, 1, `Expected one exact occurrence: ${from}`);
  return source.replace(from, to);
};
let corrected = canonical;
for (const change of replacements) corrected = replaceExactly(corrected, change.from, change.to);
let reversed = corrected;
for (const change of [...replacements].reverse()) reversed = replaceExactly(reversed, change.to, change.from);
assert.equal(reversed, canonical, 'No code outside the four allowed replacements may change.');
assert.equal(corrected.includes("'git.openRepositoryInParentFolders': 'never'"), true);
assert.equal(corrected.includes('GLW_LIVE_WORKSPACE_ROOT: fixture.repository'), true);
assert.equal(corrected.includes("extensionTestsPath: path.join(ROOT, 'scripts', 'live-extension-test-entry.cjs')"), true);

const snapshotFile = file => {
  const bytes = readFileSync(path.join(ROOT, file));
  return { path: file, sha256: sha256(bytes), bytes: bytes.length };
};
const unchangedFiles = [
  'scripts/run-live-extension-tests.mjs', 'scripts/live-extension-test-entry.cjs',
  'scripts/live-benchmark-comparison.mjs', 'scripts/live-test-paths.mjs',
  'test/extension/liveValidation.test.ts', 'out/test/extension/liveValidation.test.js',
  'dist/gitlab-workspace-0.25.0.vsix'
].map(snapshotFile);
const artifact = unchangedFiles.at(-1);
assert.equal(artifact.sha256, '6a8176b43b9a8ce8a2278b1f722eba508541d9fd77606aa8da163da9efa107c7', 'Use the frozen final artifact.');
const compiledTest = readFileSync(path.join(ROOT, 'out/test/extension/liveValidation.test.js'), 'utf8');
assert.match(compiledTest, /setTimeout\(resolve, 60_000\)/, 'The formal compiled test retains its fixed 60-second idle interval.');

const failurePath = path.join(EVIDENCE, 'git-gui-final-v4', 'git-gui-local.json');
const failureBytes = readFileSync(failurePath);
const failure = JSON.parse(failureBytes);
assert.equal(failure.status, 'FAIL');
const nativeGitPath = '.vscode-test/vscode-win32-x64-archive-1.90.0/resources/app/extensions/git/dist/main.js';
const nativeGitBytes = readFileSync(path.join(ROOT, nativeGitPath));
const nativeGit = nativeGitBytes.toString('utf8');
assert.equal(nativeGit.includes('async isRepositoryOutsideWorkspace('), true);
assert.equal(nativeGit.includes('await this.isRepositoryOutsideWorkspace(i)'), true);

mkdirSync(TARGET, { recursive: true });
const correctedBytes = Buffer.from(corrected, 'utf8');
writeFileSync(correctedPath, correctedBytes);
for (const expected of unchangedFiles) assert.deepEqual(snapshotFile(expected.path), expected, `${expected.path} was changed during preparation.`);
const manifest = {
  schema: 'WorkspaceScopeFixtureCorrection/v1', generatedAt: new Date().toISOString(),
  status: 'PREPARED', formalAcceptance: true, fullRunRequired: true,
  resultPolicy: 'PREPARED is setup only. PASS requires the complete unchanged formal suite and all assertions to finish successfully.',
  generator: snapshotFile(relative(fileURLToPath(import.meta.url))),
  canonical: { path: relative(canonicalPath), sha256: sha256(canonicalBytes), bytes: canonicalBytes.length },
  corrected: { path: relative(correctedPath), sha256: sha256(correctedBytes), bytes: correctedBytes.length },
  replacements,
  allowedChangeTypes: ['root', 'helper-import', 'workspace-folder'],
  scope: {
    before: 'Generated .code-workspace includes only demo/service.',
    after: 'The same generated .code-workspace includes demo, containing service, empty-repo, validation-worktree and module-source.',
    repositoryEnvironmentUnchanged: 'GLW_LIVE_WORKSPACE_ROOT remains fixture.repository (demo/service).',
    gitPolicyUnchanged: 'git.openRepositoryInParentFolders remains never.',
    reason: 'All repositories exercised by the compatibility test must be inside the real VS Code workspace boundary.'
  },
  failureEvidence: { path: relative(failurePath), sha256: sha256(failureBytes), status: failure.status,
    error: failure.error, vscodeVersion: failure.vscodeVersion, workspaceFolders: failure.workspaceFolders,
    failedBoundary: 'The native Git API openRepository(emptyRepo) returned null before the product adapter could open or render it.' },
  nativeGitBoundaryEvidence: { path: nativeGitPath, sha256: sha256(nativeGitBytes), line: 2,
    functions: ['API.openRepository', 'Model.openRepository', 'Model.isRepositoryOutsideWorkspace'],
    conditions: [
      'API.openRepository calls Model.openRepository, then returns getRepository(uri) || null.',
      'With openRepositoryInParentFolders !== always, an outside-workspace root returns without opening unless explicitly approved in parentRepository state.',
      'isRepositoryOutsideWorkspace accepts workspace folder paths or their descendants, including workspace real paths.'
    ] },
  unchangedFiles,
  preservedValidation: { idleIntervalMs: 60000, idlePhases: ['open', 'select-file', 'stage', 'commit', 'hidden'],
    compiledTestsUnchanged: true, assertionsUnchanged: true, settingsUnchanged: true, productAndArtifactUnchanged: true },
  command: `node ${JSON.stringify(relative(correctedPath))} --local-git-gui --evidence-dir ${JSON.stringify(relative(TARGET))}`
};
const manifestPath = path.join(TARGET, 'fixture-scope-correction.json');
writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
process.stdout.write(`${JSON.stringify({ status: manifest.status, driver: relative(correctedPath), manifest: relative(manifestPath),
  canonicalSha256: manifest.canonical.sha256, correctedSha256: manifest.corrected.sha256, exactReplacements: replacements.length })}\n`);
