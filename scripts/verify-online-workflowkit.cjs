// Exercise production modules from an extracted or Code-installed VSIX against
// the public Release service. This is a manual network acceptance, not a CI fixture.
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
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
const { WorkflowKitReleaseManager } = require(path.join(root, 'out/src/workspace/workflowKitReleases.js'));
const { resolveSkillsContext } = require(path.join(root, 'out/src/workspace/skillsContext.js'));
const extension = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
fs.mkdirSync(evidence, { recursive: true });
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'wk-online-'));
const report = { source, extensionVersion: extension.version, extensionRoot: root, profiles: [], status: 'running', nativeUiTested: false };
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
  const manager = new WorkflowKitReleaseManager(path.join(temporary, 'cache'), extension.version);
  assert.deepEqual(await manager.listReleases(), []);
  const [release] = await manager.refresh(source);
  assert.ok(release, 'No compatible formal Release');
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
    report.profiles.push({ profile, install: installed.status, repeated: repeated.status, skills: context.availableFeatures });
  }
  const restarted = new WorkflowKitReleaseManager(path.join(temporary, 'cache'), extension.version);
  assert.equal((await restarted.statusHelper()).version, release.version);
  report.status = 'passed';
}
main().catch(error => { report.status = 'failed'; report.error = error.stack; process.exitCode = 1; }).finally(() => {
  fs.writeFileSync(path.join(evidence, 'online-workflowkit.json'), JSON.stringify(report, null, 2) + '\n');
  fs.rmSync(temporary, { recursive: true, force: true });
  process.stdout.write(JSON.stringify(report) + '\n');
});
