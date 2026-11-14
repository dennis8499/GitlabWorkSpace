import { execFileSync } from 'node:child_process';
import { copyFile, lstat, mkdir, mkdtemp, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveCliArgsFromVSCodeExecutablePath, runTests } from '@vscode/test-electron';
import { inspectHostExecutable, isolatedHostEnvironment } from './extension-test-environment.mjs';

const project = fileURLToPath(new URL('../', import.meta.url));
const option = name => { const index = process.argv.indexOf(name); return index < 0 ? undefined : process.argv[index + 1]; };
const tools = option('--tools') ?? 'wiki,merge-reviewer,release-reviewer,bmad,commit-reviewer';
const selectedTools = tools.split(',');
if (!selectedTools.length || selectedTools.some(tool => !['wiki', 'merge-reviewer', 'release-reviewer', 'bmad', 'commit-reviewer', 'group'].includes(tool))) {
  throw new Error('Select recognized Codex live tools with --tools.');
}
const group = selectedTools.includes('group');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
// runTests merges its environment into process.env. Remove test credentials from
// both the actual parent environment and the clone before any child is started.
const removedCredentials = Object.keys(process.env).filter(key => /^(?:GLW|GITLAB)_(?:.*(?:TOKEN|PASSWORD|SECRET|AUTHORIZATION|PRIVATE_KEY|CREDENTIAL|ACCESS_KEY)|(?:.*_)?PAT(?:_|$))/i.test(key));
for (const key of removedCredentials) delete process.env[key];
const { env, removed } = isolatedHostEnvironment();
for (const key of removed) delete process.env[key];
for (const key of removedCredentials) delete env[key];
const workspace = option('--workspace') ? await realpath(option('--workspace')) : await mkdtemp(path.join(os.tmpdir(), 'gitlab-codex-real-'));
if (!/^gitlab-codex-real-[a-z0-9]+$/i.test(path.basename(workspace))) throw new Error('Use a disposable gitlab-codex-real-* directory containing the pinned WorkflowKit group fixture.');
const manifest = JSON.parse(await readFile(path.join(project, 'package.json'), 'utf8'));
const vsix = await realpath(option('--vsix') ?? path.join(project, 'dist', `gitlab-workspace-${manifest.version}.vsix`));
const evidence = await mkdtemp(path.join(project, '.tmp/codex-live-'));
const profile = await mkdtemp(path.join(os.tmpdir(), 'gitlab-codex-profile-'));
const userData = path.join(profile, 'user'), extensions = path.join(profile, 'extensions');
const executable = process.env.VSCODE_EXECUTABLE_PATH ?? path.join(process.env.LOCALAPPDATA, 'Programs/Microsoft VS Code/Code.exe');
const proof = await inspectHostExecutable(executable);
const extracted = path.join(evidence, 'vsix'); await mkdir(extracted);
execFileSync('python', ['-c', 'import sys,zipfile; archive=zipfile.ZipFile(sys.argv[1]); names=archive.namelist(); assert all(not n.startswith("/") and not any(p in ("", ".", "..") for p in n.rstrip("/").split("/")) and "\\\\" not in n and ":" not in n for n in names); archive.extractall(sys.argv[2])', vsix, extracted], { windowsHide: true, env });
const packagedManifest = JSON.parse(await readFile(path.join(extracted, 'extension/package.json'), 'utf8'));
if (packagedManifest.publisher !== manifest.publisher || packagedManifest.name !== manifest.name || packagedManifest.version !== manifest.version) {
  throw new Error('The candidate VSIX identity does not match this checkout.');
}
console.log(JSON.stringify({ workspace, evidence, profile, userData, extensions, vscode: proof.version }));
await writeFile(path.join(evidence, 'environment.json'), JSON.stringify({ removedCredentialNames: removedCredentials.sort(), removedElectronNames: removed,
  testCredentialsAbsent: removedCredentials.every(key => !(key in process.env) && !(key in env)) }, null, 2));
const fixtureRoot = await realpath(option('--kit-release-dir') ?? path.join(project, 'test/fixtures/workflowkit-release-1.5.0'));
const descriptor = JSON.parse(await readFile(path.join(fixtureRoot, 'release.json'), 'utf8'));
if (descriptor.schema !== 'workflowkit-release/v1' || !/^\d+\.\d+\.\d+$/.test(descriptor.version) || !descriptor.profiles?.includes('group')) throw new Error('The WorkflowKit descriptor does not support this group fixture.');
async function verifiedAsset(asset) {
  if (!asset || typeof asset.name !== 'string' || asset.name !== path.basename(asset.name) || /[\\/:\0]/.test(asset.name) || !/^[a-f0-9]{64}$/.test(asset.sha256)) throw new Error('Invalid WorkflowKit fixture asset.');
  const filename = path.join(fixtureRoot, asset.name), info = await lstat(filename);
  if (!info.isFile() || info.isSymbolicLink() || await realpath(filename) !== filename || info.size !== asset.size || hash(await readFile(filename)) !== asset.sha256) throw new Error('The WorkflowKit fixture asset hash or size differs.');
  return filename;
}
const installer = await verifiedAsset(descriptor.assets?.installer);
const kitArchive = await verifiedAsset(descriptor.assets?.package);
try { await readFile(path.join(workspace, '.gitlab-workspace/tool-manifests/workflow-kit.json')); }
catch (error) {
  if (error.code !== 'ENOENT') throw error;
  console.log('Installing pinned WorkflowKit fixture into the disposable workspace.');
  const installed = execFileSync('python', ['-X', 'utf8', '-B', installer, 'install', kitArchive, workspace,
    descriptor.version, 'github', '--format', 'zip', '--entry-root', 'workflow-kit', '--archive-sha256', descriptor.assets.package.sha256, '--profile', 'group'],
    { windowsHide: true, timeout: 180_000, encoding: 'utf8', maxBuffer: 1024 * 1024, env });
  await writeFile(path.join(evidence, 'installation.json'), installed);
}
const state = JSON.parse(execFileSync('python', ['-X', 'utf8', '-B', installer, 'status', workspace, '--expected-version', descriptor.version],
  { windowsHide: true, encoding: 'utf8', maxBuffer: 1024 * 1024, env }).trim().split(/\r?\n/).at(-1));
if (!['installed', 'update-available'].includes(state.status)) throw new Error(`The disposable WorkflowKit installation is not ready: ${state.message ?? state.status}`);
if (state.version !== descriptor.version) throw new Error('The disposable workspace has another WorkflowKit version; it was not overwritten.');
// Match an installation performed through the extension: a verified same-source status helper is cached.
const storage = path.join(userData, 'User/globalStorage/local-dev.gitlab-workspace');
await mkdir(path.join(storage, 'workflow-kit-downloads'), { recursive: true });
for (const asset of Object.values(descriptor.assets)) await copyFile(await verifiedAsset(asset), path.join(storage, 'workflow-kit-downloads', asset.sha256 + path.extname(asset.name)));
await writeFile(path.join(storage, 'workflow-kit-release-cache.json'), JSON.stringify({ schema: 'workflowkit-release-cache/v1', releases: [{ source: 'github', descriptor,
  descriptorSha256: hash(await readFile(path.join(fixtureRoot, 'release.json'))) }] }));
const service = path.join(workspace, 'service');
const fixtureMetadata = path.join(workspace, '.gitlab-workspace');
if (await realpath(fixtureMetadata) !== fixtureMetadata || (await lstat(fixtureMetadata)).isSymbolicLink()) throw new Error('The fixture metadata directory is redirected.');
const emptyHooks = path.join(workspace, '.gitlab-workspace', 'codex-live-empty-hooks');
await mkdir(emptyHooks, { recursive: true });
if ((await lstat(emptyHooks)).isSymbolicLink() || await realpath(emptyHooks) !== emptyHooks || (await readdir(emptyHooks)).length) throw new Error('The fixture hooks directory is not empty and owned.');
const emptyGitConfig = path.join(workspace, '.gitlab-workspace', 'codex-live-empty.gitconfig');
try { await writeFile(emptyGitConfig, '', { flag: 'wx' }); } catch (error) { if (error.code !== 'EEXIST') throw error; }
const configInfo = await lstat(emptyGitConfig);
if (!configInfo.isFile() || configInfo.isSymbolicLink() || configInfo.size || await realpath(emptyGitConfig) !== emptyGitConfig) throw new Error('The fixture Git configuration is not an empty owned file.');
const gitEnvironment = { ...env, GIT_CONFIG_GLOBAL: emptyGitConfig, GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' };
for (const name of Object.keys(gitEnvironment)) if (/^GIT_(?:DIR|COMMON_DIR|WORK_TREE|INDEX_FILE|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES|CONFIG_COUNT|CONFIG_PARAMETERS|CONFIG_KEY_\d+|CONFIG_VALUE_\d+)$/i.test(name)) delete gitEnvironment[name];
const gitAt = (directory, ...args) => execFileSync('git', ['-c', `core.hooksPath=${emptyHooks}`, '-c', 'core.fsmonitor=false', '-c', 'commit.gpgsign=false', '-C', directory, ...args], { windowsHide: true, stdio: 'pipe', env: gitEnvironment });
const git = (...args) => gitAt(service, ...args);
const fixtureReceiptPath = path.join(workspace, '.gitlab-workspace', 'codex-live-fixture.json');
let fixtureProjects = [];
if (group && option('--fixture-manifest')) {
  const fixture = JSON.parse(await readFile(option('--fixture-manifest'), 'utf8'));
  if (fixture.site !== 'http://127.0.0.1:8930' || !Array.isArray(fixture.projects)) throw new Error('The Group fixture manifest must describe the authorized local GitLab site.');
  fixtureProjects = fixture.projects.filter(item => ['service', 'contracts', 'client'].includes(item.role));
  if (!fixtureProjects.some(item => item.role === 'service') || new Set(fixtureProjects.map(item => item.role)).size !== fixtureProjects.length) throw new Error('The Group fixture project roles are invalid.');
  for (const item of fixtureProjects) {
    const url = new URL(item.httpCloneUrl);
    if (item.state !== 'confirmed' || url.origin !== fixture.site || url.username || url.password || url.search || url.hash || decodeURIComponent(url.pathname) !== '/' + item.fullPath + '.git') throw new Error('A fixture Repo URL or receipt is not bound to the authorized site.');
  }
}
let sentinel, repositories = [];
if (process.argv.includes('--reuse-fixture')) {
  if (group) {
    const receipt = JSON.parse(await readFile(fixtureReceiptPath, 'utf8'));
    if (receipt.schema !== 'GitLabWorkspaceCodexLiveFixture/v1' || receipt.kitVersion !== descriptor.version || !Array.isArray(receipt.repositories) ||
      !receipt.repositories.length || receipt.repositories.length > 3 || !receipt.repositories.some(item => item.role === 'service') ||
      new Set(receipt.repositories.map(item => item.role)).size !== receipt.repositories.length || !receipt.sentinel) throw new Error('The Group fixture receipt is missing or incompatible.');
    ({ sentinel, repositories } = receipt);
    if (fixtureProjects.length && (repositories.length !== fixtureProjects.length || fixtureProjects.some(item => !repositories.some(repository => repository.role === item.role && repository.httpCloneUrl === item.httpCloneUrl)))) throw new Error('The Group fixture belongs to another project manifest.');
    for (const repository of repositories) {
      if (repository.path !== path.join(workspace, repository.role) || !['service', 'contracts', 'client'].includes(repository.role) || String(gitAt(repository.path, 'rev-parse', 'HEAD')).trim() !== repository.headSha || String(gitAt(repository.path, 'remote', 'get-url', 'origin')).trim() !== repository.httpCloneUrl || String(gitAt(repository.path, 'status', '--porcelain')) !== repository.status) throw new Error('The prepared Group fixture changed before model execution.');
    }
    if (sentinel.file !== path.join(service, 'uncommitted-sentinel.txt') || sentinel.calculatorPath !== path.join(service, 'calculator.py') || hash(await readFile(sentinel.file)) !== sentinel.fileSha256 || hash(await readFile(sentinel.calculatorPath)) !== sentinel.calculatorSha256) throw new Error('The Group fixture sentinel changed.');
  } else if (String(git('status', '--porcelain')).trim().split(/\r?\n/).some(line => line && line !== '?? review-reports/') || String(git('show', 'main:calculator.py')) !== 'def add(a, b):\n    return a + b\n' ||
      String(git('show', 'feature:calculator.py')) !== 'def add(a, b):\n    return a - b\n') throw new Error('The existing fixture has changed; use a fresh disposable workspace.');
} else {
await mkdir(service);
git('init', '-q', '--initial-branch=main'); git('config', 'user.name', 'Codex Bridge Fixture'); git('config', 'user.email', 'fixture@example.invalid');
await writeFile(path.join(service, 'calculator.py'), 'def add(a, b):\n    return a + b\n');
await writeFile(path.join(service, 'test_calculator.py'), 'from calculator import add\nassert add(2, 3) == 5\n');
git('add', '.'); git('commit', '-qm', 'baseline'); git('checkout', '-qb', 'feature');
await writeFile(path.join(service, 'calculator.py'), 'def add(a, b):\n    return a - b\n'); git('add', '.'); git('commit', '-qm', 'fixture regression');
execFileSync('git', ['-c', `core.hooksPath=${emptyHooks}`, '-c', 'core.fsmonitor=false', 'clone', '--bare', '--no-hardlinks', service, path.join(workspace, 'remote.git')], { windowsHide: true, stdio: 'pipe', env: gitEnvironment });
git('remote', 'add', 'origin', path.join(workspace, 'remote.git'));
if (group) {
  for (const item of fixtureProjects) {
    const directory = path.join(workspace, item.role);
    if (item.role !== 'service') {
      await mkdir(directory); gitAt(directory, 'init', '-q', '--initial-branch=main');
      gitAt(directory, 'config', 'user.name', 'Codex Bridge Fixture'); gitAt(directory, 'config', 'user.email', 'fixture@example.invalid');
      await writeFile(path.join(directory, item.role === 'contracts' ? 'calculator-contract.json' : 'calculator-client.py'), item.role === 'contracts'
        ? '{"operation":"add","inputs":["number","number"],"result":"number"}\n'
        : 'def build_add_request(a, b):\n    return {"operation": "add", "inputs": [a, b]}\n');
      await writeFile(path.join(directory, 'README.md'), `# ${item.role}\n\nThe calculator contract accepts two numbers. The service add operation must return their sum; the client constructs that request.\n`);
      gitAt(directory, 'add', '.'); gitAt(directory, 'commit', '-qm', 'Local calculator fixture');
      gitAt(directory, 'remote', 'add', 'origin', item.httpCloneUrl);
    } else gitAt(directory, 'remote', 'set-url', 'origin', item.httpCloneUrl);
  }
  const roles = fixtureProjects.length ? fixtureProjects.map(item => item.role) : ['service'];
  const marker = 'UNCOMMITTED_SENTINEL_' + randomUUID();
  const file = path.join(service, 'uncommitted-sentinel.txt'), calculatorPath = path.join(service, 'calculator.py');
  await writeFile(file, marker + '\n');
  await writeFile(calculatorPath, await readFile(calculatorPath, 'utf8') + `\n# ${marker}\n`);
  sentinel = { file, calculatorPath, marker, fileSha256: hash(await readFile(file)), calculatorSha256: hash(await readFile(calculatorPath)) };
  repositories = roles.map(role => { const directory = path.join(workspace, role); return { role, path: directory,
    headSha: String(gitAt(directory, 'rev-parse', 'HEAD')).trim(), httpCloneUrl: String(gitAt(directory, 'remote', 'get-url', 'origin')).trim(),
    status: String(gitAt(directory, 'status', '--porcelain')) }; });
  await writeFile(fixtureReceiptPath, JSON.stringify({ schema: 'GitLabWorkspaceCodexLiveFixture/v1', kitVersion: descriptor.version, repositories, sentinel }, null, 2));
}
}
const codexExecutable = option('--codex-executable') ? await realpath(option('--codex-executable')) : undefined;
if (codexExecutable) {
  const info = await lstat(codexExecutable), relative = path.relative(workspace, codexExecutable);
  if (!info.isFile() || info.isSymbolicLink() || !path.isAbsolute(relative) && relative !== '..' && !relative.startsWith('..' + path.sep)) throw new Error('The Codex executable must be a verified local file outside the disposable workspace.');
}
await mkdir(path.join(userData, 'User'), { recursive: true }); await mkdir(extensions, { recursive: true });
await writeFile(path.join(userData, 'User/settings.json'), JSON.stringify({ 'extensions.autoCheckUpdates': false, 'update.mode': 'none',
  'chat.disableAIFeatures': true,
  'workbench.startupEditor': 'none', 'git.openRepositoryInParentFolders': 'never', 'git.autofetch': false, 'gitlabWorkspace.projectRoot': workspace,
  ...(codexExecutable ? { 'gitlabWorkspace.codex.executablePath': codexExecutable } : {}) }, null, 2));
// Install the same candidate into this isolated profile. The test host may
// forward Development/Test flags to native new windows; the owner bootstrap
// records that context and never starts a second Mocha driver.
const [cliLauncher] = resolveCliArgsFromVSCodeExecutablePath(proof.executable, { reuseMachineInstall: true });
let cliExecutable = cliLauncher, cliArguments = [], cliEnv = env;
if (process.platform === 'win32') {
  const launcher = await realpath(cliLauncher), body = await readFile(launcher, 'utf8');
  const entry = /^"(%~dp0[^"\r\n]+\.exe)"\s+"(%~dp0[^"\r\n]+cli\.(?:js|mjs))"\s+%\*\s*$/im.exec(body);
  if (!entry) throw new Error('The trusted VS Code CLI launcher format is not recognized.');
  const resolveEntry = value => path.resolve(path.dirname(launcher), value.replace(/^%~dp0/i, '').replaceAll('\\', path.sep));
  cliExecutable = await realpath(resolveEntry(entry[1])); const cliScript = await realpath(resolveEntry(entry[2]));
  const relative = path.relative(path.dirname(proof.executable), cliScript);
  if (cliExecutable.toLowerCase() !== proof.executable.toLowerCase() || path.isAbsolute(relative) || relative === '..' || relative.startsWith('..' + path.sep)) throw new Error('The VS Code CLI entry escaped its verified installation.');
  cliArguments = [cliScript]; cliEnv = { ...env, ELECTRON_RUN_AS_NODE: '1', VSCODE_DEV: '' };
}
execFileSync(cliExecutable, [...cliArguments, '--install-extension', vsix, '--force', `--user-data-dir=${userData}`, `--extensions-dir=${extensions}`],
  { env: cliEnv, windowsHide: true, shell: false, timeout: 120_000, encoding: 'utf8', maxBuffer: 1024 * 1024 });
const installedCandidates = [];
for (const entry of await readdir(extensions, { withFileTypes: true })) {
  if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
  const directory = path.join(extensions, entry.name);
  const candidate = JSON.parse(await readFile(path.join(directory, 'package.json'), 'utf8'));
  if (candidate.publisher === manifest.publisher && candidate.name === manifest.name && candidate.version === manifest.version) installedCandidates.push(directory);
}
if (installedCandidates.length !== 1) throw new Error('The candidate extension was not uniquely installed into the disposable profile.');
for (const filename of ['out/src/extension.js', 'out/src/codex/bridge.js', 'out/src/workspace/workspacePanel.js', 'resources/issue-webview/dashboard.js']) {
  if (hash(await readFile(path.join(installedCandidates[0], filename))) !== hash(await readFile(path.join(extracted, 'extension', filename)))) throw new Error('The installed candidate bytes differ from the tested VSIX.');
}
await writeFile(path.join(evidence, 'prepared.json'), JSON.stringify({ schema: 'GitLabWorkspaceCodexLivePreparation/v1', workspace, evidence, profile, userData, extensions,
  kitVersion: descriptor.version, kitPackageSha256: descriptor.assets.package.sha256, vsix, vsixSha256: hash(await readFile(vsix)),
  installedExtension: installedCandidates[0], codexExecutable, tools: selectedTools, repositories, sentinel, modelStarted: false, gitLabRequests: 0 }, null, 2));
if (process.argv.includes('--prepare-only')) { console.log(`Prepared without models or GitLab requests: ${path.join(evidence, 'prepared.json')}`); process.exit(0); }
const server = createServer(); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port; await new Promise(resolve => server.close(resolve));
const runtime = await mkdtemp(path.join(os.tmpdir(), 'gitlab-codex-runtime-'));
await writeFile(path.join(evidence, 'runtime.json'), JSON.stringify({ runtime }));
await writeFile(path.join(evidence, 'host.json'), JSON.stringify(proof, null, 2));
await runTests({ vscodeExecutablePath: proof.executable, extensionDevelopmentPath: path.join(extracted, 'extension'),
  extensionTestsPath: path.join(project, 'out/test/codex-live/index.js'),
  extensionTestsEnv: { ...env, GLW_CODEX_LIVE: '1', GLW_CODEX_LIVE_ROOT: workspace, GLW_CODEX_LIVE_EVIDENCE: evidence,
    GLW_CODEX_LIVE_USER_DATA: userData, GLW_CODEX_LIVE_CANDIDATE_EXTENSION: path.join(extracted, 'extension'),
    GLW_CODEX_LIVE_INSTALLED_EXTENSION: installedCandidates[0],
    GLW_CODEX_LIVE_PORT: String(port), GLW_CODEX_LIVE_TOOLS: tools, GLW_CODEX_LIVE_KIT_VERSION: descriptor.version,
    GLW_CODEX_LIVE_SERVICE_ORIGIN: repositories.find(item => item.role === 'service')?.httpCloneUrl,
    GLW_CODEX_LIVE_REPOSITORIES: JSON.stringify(repositories), GLW_CODEX_LIVE_SENTINEL: sentinel ? JSON.stringify(sentinel) : undefined,
    GITLAB_WORKSPACE_RUNTIME_DIR: runtime },
  launchArgs: [workspace, '--disable-workspace-trust', '--skip-welcome', '--skip-release-notes', '--disable-gpu',
    `--user-data-dir=${userData}`, `--extensions-dir=${extensions}`, `--remote-debugging-port=${port}`] });
console.log(`Codex live evidence: ${evidence}`);
