// Exercise production modules from an extracted or Code-installed VSIX against
// the public Release service, or explicit local candidate bytes through an injected
// transport. Candidate mode does not publish or test the public service.
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const options = {};
for (let index = 2; index < process.argv.length; index += 2) options[process.argv[index]] = process.argv[index + 1];
if (!options['--extension-root'] || !options['--evidence-dir']) throw new Error('Use --extension-root <installed extension> --evidence-dir <output> [--source github|gitea]');
const root = path.resolve(options['--extension-root']);
const evidence = path.resolve(options['--evidence-dir']);
const source = options['--source'] ?? 'github';
assert.ok(['github', 'gitea'].includes(source));
const candidateDirectory = options['--candidate-kit-dir'] && path.resolve(options['--candidate-kit-dir']);
const candidateSnapshots = options['--candidate-snapshots'] && JSON.parse(fs.readFileSync(options['--candidate-snapshots'], 'utf8'));
if (candidateDirectory) assert.ok(candidateSnapshots?.reviewers, 'Candidate verification requires --candidate-snapshots');
const { WorkflowKitReleaseManager, WORKFLOW_KIT_RELEASES } = require(path.join(root, 'out/src/workspace/workflowKitReleases.js'));
const { resolveSkillsContext } = require(path.join(root, 'out/src/workspace/skillsContext.js'));
const extension = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
fs.mkdirSync(evidence, { recursive: true });
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'wk-online-'));
const report = { source, extensionVersion: extension.version, extensionRoot: root, profiles: [], status: 'running', nativeUiTested: false };
report.transport = candidateDirectory ? 'local candidate bytes through injected release transport' : 'public release service';
report.externalNetworkRequests = candidateDirectory ? 0 : null;
const sha256 = data => createHash('sha256').update(data).digest('hex');
function candidateTransport(directory) {
  const metadata = fs.readFileSync(path.join(directory, 'release.json'));
  const descriptor = JSON.parse(metadata);
  const files = new Map([['release.json', metadata]]);
  for (const asset of Object.values(descriptor.assets)) {
    assert.equal(path.basename(asset.name), asset.name);
    const data = fs.readFileSync(path.join(directory, asset.name));
    assert.equal(data.length, asset.size);
    assert.equal(sha256(data), asset.sha256);
    files.set(asset.name, data);
  }
  const base = `${WORKFLOW_KIT_RELEASES[source]}/download/v${descriptor.version}/`;
  const release = { tag_name: `v${descriptor.version}`, draft: false, prerelease: false,
    assets: [...files].map(([name, data]) => ({ name, size: data.length,
      digest: `sha256:${sha256(data)}`, browser_download_url: base + name })) };
  report.candidate = { directory, version: descriptor.version, descriptorSha256: sha256(metadata),
    assets: descriptor.assets, publicationSimulated: true };
  return async input => {
    const url = new URL(String(input));
    if (url.href.startsWith(base)) {
      const data = files.get(url.href.slice(base.length));
      return data ? new Response(Uint8Array.from(data).buffer) : new Response('', { status: 404 });
    }
    if (url.pathname.endsWith('/releases') &&
        (url.hostname === 'api.github.com' || url.hostname === 'tech-sharing.cathaysec.com.tw')) {
      return new Response(JSON.stringify([release]));
    }
    throw new Error('Unexpected candidate transport request: ' + url.href);
  };
}
function verifyCandidateSkills(target) {
  const records = [];
  const textSuffixes = new Set(['.md', '.py', '.yaml', '.yml', '.json', '.txt', '.toml']);
  function filesIn(directory, prefix = '') {
    return fs.readdirSync(directory).flatMap(name => {
      const filename = path.join(directory, name), stat = fs.lstatSync(filename);
      assert.ok(!stat.isSymbolicLink(), 'Installed skill contains a symlink');
      const relative = prefix + name;
      return stat.isDirectory() ? filesIn(filename, relative + '/') : [relative];
    });
  }
  for (const [reviewer, snapshot] of Object.entries(candidateSnapshots.reviewers)) {
    const skill = path.join(target, '.agents/skills', `${reviewer}-reviewer`);
    assert.equal(fs.readFileSync(path.join(skill, 'VERSION'), 'utf8').trim(), snapshot.version);
    assert.deepEqual(filesIn(skill).sort(), Object.keys(snapshot.files).sort(), `${reviewer}: file inventory`);
    for (const [relative, expected] of Object.entries(snapshot.files)) {
      const parts = relative.split('/');
      assert.ok(parts.every(part => part && part !== '.' && part !== '..'));
      const filename = path.join(skill, ...parts);
      assert.ok(!fs.lstatSync(filename).isSymbolicLink());
      const frozen = fs.readFileSync(path.join(snapshot.snapshot, ...parts));
      assert.equal(sha256(frozen), expected, `${reviewer}: frozen source ${relative}`);
      // Match the existing standalone package policy; never normalize business evidence.
      const canonical = path.basename(relative) === 'VERSION' || textSuffixes.has(path.extname(relative).toLowerCase())
        ? Buffer.from(frozen.toString('latin1').replace(/\r\n/g, '\n'), 'latin1') : frozen;
      assert.equal(sha256(fs.readFileSync(filename)), sha256(canonical), `${reviewer}: installed ${relative}`);
    }
    records.push({ reviewer, version: snapshot.version, verifiedFiles: Object.keys(snapshot.files).length,
      snapshotTreeSha256: snapshot.tree_sha256, packageCanonicalization: 'CRLF to LF for existing text suffixes and VERSION' });
  }
  return records;
}
const pythonRunner = path.join(__dirname, 'run-python.mjs');
function python(args) {
  const result = spawnSync(process.execPath, [pythonRunner, ...args], { encoding: 'utf8', windowsHide: true, timeout: 180000, maxBuffer: 8 * 1024 * 1024 });
  assert.equal(result.status, 0, result.error?.message ?? result.stderr ?? result.stdout);
  return JSON.parse(result.stdout.trim().split(/\r?\n/).at(-1));
}
function git(directory, args) {
  const result = spawnSync('git', ['-C', directory, ...args], { encoding: 'utf8', windowsHide: true });
  assert.equal(result.status, 0, result.stderr);
}
async function main() {
  const fetcher = candidateDirectory ? candidateTransport(candidateDirectory) : globalThis.fetch;
  const manager = new WorkflowKitReleaseManager(path.join(temporary, 'cache'), fetcher);
  assert.deepEqual(await manager.listReleases(), []);
  const [release] = await manager.refresh(source);
  assert.ok(release, 'No formal Release');
  const downloaded = await manager.getRelease(release.id, undefined, message => process.stderr.write(message + '\n'));
  report.releaseVersion = release.version;
  report.releaseId = release.id;
  report.assets = release.descriptor.assets;
  for (const profile of ['group', 'repository']) {
    const target = path.join(temporary, profile);
    fs.mkdirSync(target);
    const repository = profile === 'repository' ? target : path.join(target, 'sample');
    fs.mkdirSync(repository, { recursive: true });
    git(repository, ['init', '--quiet']);
    git(repository, ['remote', 'add', 'origin', 'https://gitlab.invalid/example/sample.git']);
    const args = [downloaded.installerPath, '--target', target, '--archive', downloaded.archivePath, '--source', source];
    const installed = python(args);
    assert.equal(installed.ok, true);
    const repeated = python(args);
    assert.equal(repeated.applied, false);
    const state = python([downloaded.installerPath, 'status', target, '--expected-version', release.version]);
    assert.equal(state.status, 'installed');
    assert.equal(state.profile, profile);
    assert.equal(state.workspaceContract, 2);
    assert.equal(state.installerApi, 1);
    const context = resolveSkillsContext({ match: { status: 'matched', root: target, profile,
      repositories: [{ name: 'sample', path: repository, matched: true }] }, installed: state, revision: 'online-acceptance' });
    assert.ok(context.availableFeatures.includes('merge-repo'));
    assert.ok(context.availableFeatures.includes('release-review'));
    assert.ok(context.availableFeatures.includes('query'));
    for (const skill of release.descriptor.skills) assert.ok(fs.statSync(path.join(target, '.agents/skills', skill, 'SKILL.md')).isFile());
    report.profiles.push({ profile, install: installed.status, repeated: repeated.status, skills: context.availableFeatures,
      ...(candidateDirectory ? { candidateSkills: verifyCandidateSkills(target) } : {}) });
  }
  const restarted = new WorkflowKitReleaseManager(path.join(temporary, 'cache'),
    candidateDirectory ? async () => { throw new Error('Cached restart must not request transport'); } : fetcher);
  assert.equal((await restarted.statusHelper()).version, release.version);
  report.status = 'passed';
}
main().catch(error => { report.status = 'failed'; report.error = error.stack; process.exitCode = 1; }).finally(() => {
  fs.writeFileSync(path.join(evidence, 'online-workflowkit.json'), JSON.stringify(report, null, 2) + '\n');
  fs.rmSync(temporary, { recursive: true, force: true });
  process.stdout.write(JSON.stringify(report) + '\n');
});
