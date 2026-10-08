import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, existsSync, copyFileSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runTests } from '@vscode/test-electron';
import { fileURLToPath } from 'node:url';
import { compareLiveBenchmarks } from './live-benchmark-comparison.mjs';
import { sameFilesystemPath, createLiveTestProfile } from './live-test-paths.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const STATE = path.join(ROOT, '.gitlab-workspace-validation');
const EVIDENCE = path.resolve(option('--evidence-dir', path.join(ROOT, 'docs', 'work', process.argv.includes('--local-git-gui') ? 'work-20261008-git-gui' : 'work-20261006-live-validation', 'evidence')));
const evidenceRelative = path.relative(path.join(ROOT, 'docs', 'work'), EVIDENCE);
if (!evidenceRelative || evidenceRelative.startsWith('..' + path.sep) || evidenceRelative === '..' || path.isAbsolute(evidenceRelative)) throw new Error('--evidence-dir must remain inside docs/work.');
const TEST_PROFILE_ROOT = path.join(tmpdir(), 'gitlab-workspace-vscode-test');
const PACKAGE = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
let validatedVSCodeVersion;
const ENVS = {
  ce19: { url: 'http://127.0.0.1:8929', tokenName: 'GLW_CE19_TOKEN', group: 'grp-sn-maint/gitlab-workspace-live-validation/demo', port: 9341 },
  ce16: { url: 'http://127.0.0.1:8930', tokenName: 'GLW_CE16_TOKEN', group: 'grp-sn-maint/gitlab-workspace-live-validation/demo', port: 9342 }
};

function option(name, fallback) {
  const index = process.argv.indexOf(name);
  return index < 0 ? fallback : process.argv[index + 1];
}

function environmentKeys() {
  const selection = option('--environment', 'both');
  const keys = selection === 'both' ? ['ce19', 'ce16'] : [selection];
  if (keys.some((key) => !ENVS[key])) throw new Error('Use --environment ce19, ce16, or both.');
  return keys;
}

function verifyVsCodeExecutable() {
  const configuredPath = process.env.VSCODE_EXECUTABLE_PATH || path.join(process.env.LOCALAPPDATA ?? '', 'Programs', 'Microsoft VS Code', 'Code.exe');
  const executable = configuredPath.toLocaleLowerCase('en-US').endsWith('.cmd')
    ? path.resolve(path.dirname(configuredPath), '..', 'Code.exe') : configuredPath;
  const actual = execFileSync('powershell.exe', [
    '-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
    '(Get-Item -LiteralPath $env:GLW_VSCODE_VERSION_PATH).VersionInfo.ProductVersion'
  ], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true,
    env: { ...process.env, GLW_VSCODE_VERSION_PATH: executable }
  }).trim().split(/\r?\n/)[0];
  if (process.argv.includes('--local-git-gui')) {
    const version = /^(\d+)\.(\d+)\.\d+$/.exec(actual);
    if (!version || Number(version[1]) < 1 || Number(version[1]) === 1 && Number(version[2]) < 90) throw new Error(`Local Git GUI tests require VS Code 1.90 or newer; found ${actual || 'no readable installation'}. Set VSCODE_EXECUTABLE_PATH to Code.exe.`);
  } else {
    const expected = option('--vscode-version', '1.140.0');
    if (!/^1\.(\d+)\.\d+$/.test(expected) || Number(expected.split('.')[1]) < 90) throw new Error('--vscode-version must be an explicit supported VS Code version.');
    if (actual !== expected) throw new Error(`Live Extension Host tests require VS Code ${expected}; found ${actual}.`);
  }
  validatedVSCodeVersion = actual;
  return executable;
}

async function freePort(preferred) {
  for (let port = preferred; port < preferred + 50; port++) {
    const server = net.createServer();
    const available = await new Promise((resolve) => server.once('error', () => resolve(false)).listen(port, '127.0.0.1', () => server.close(() => resolve(true))));
    if (available) return port;
  }
  throw new Error('Could not allocate an isolated local CDP port.');
}

async function waitForCdp(port, timeoutMs = 30_000) {
  const started = performance.now();
  while (performance.now() - started < timeoutMs) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (response.ok) return { startedMs: Number((performance.now() - started).toFixed(2)), details: await response.json() };
    } catch { /* the isolated Extension Host has not opened its CDP port yet */ }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`VS Code did not open its local CDP endpoint on port ${port} within ${timeoutMs} ms.`);
}

async function waitForCdpClosed(port, timeoutMs = 10_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (!response.ok) return true;
    } catch { return true; }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return false;
}

function preparePackagedExtension(overridePath) {
  const vsix = overridePath ? path.resolve(overridePath) : path.join(ROOT, 'dist', `${PACKAGE.name}-${PACKAGE.version}.vsix`);
  if (!existsSync(vsix)) throw new Error(`Build ${path.relative(ROOT, vsix)} before running live Extension Host tests.`);
  const digest = createHash('sha256').update(readFileSync(vsix)).digest('hex');
  const unpackRoot = path.join(TEST_PROFILE_ROOT, `live-vsix-${PACKAGE.version}-${digest.slice(0, 12)}-${process.pid}`);
  const extensionPath = path.join(unpackRoot, 'extension');
  const zipCopy = path.join(unpackRoot, 'package.zip');
  mkdirSync(unpackRoot, { recursive: true });
  copyFileSync(vsix, zipCopy);
  execFileSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
    'Expand-Archive -LiteralPath $env:GLW_PACKAGE_ZIP -DestinationPath $env:GLW_PACKAGE_DEST -Force'], {
    encoding: 'utf8', stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true,
    env: { ...process.env, GLW_PACKAGE_ZIP: zipCopy, GLW_PACKAGE_DEST: unpackRoot }
  });
  rmSync(zipCopy, { force: true });
  const extracted = JSON.parse(readFileSync(path.join(extensionPath, 'package.json'), 'utf8'));
  if (extracted.publisher !== PACKAGE.publisher || extracted.name !== PACKAGE.name || extracted.version !== PACKAGE.version) {
    throw new Error('The packaged VSIX identity or version does not match the workspace release metadata.');
  }
  return { extensionPath, unpackRoot, vsix: path.relative(ROOT, vsix).replaceAll(path.sep, '/'), sha256: digest };
}

function readTestReport(reportFile) {
  try { return JSON.parse(readFileSync(reportFile, 'utf8')); }
  catch { throw new Error('The live Extension Host did not write a validation report.'); }
}

function safeError(error) {
  return Object.values(ENVS).reduce((message, config) => {
    const token = process.env[config.tokenName];
    return token ? message.split(token).join('[redacted]') : message;
  }, error instanceof Error ? error.message : 'Live Extension Host validation failed.');
}

function classifyLiveStatus(error) {
  const message = error instanceof Error ? error.message : String(error);
  return /timed out|fetch failed|ECONNREFUSED|network error|set GLW_CE(?:16|19)_TOKEN|no (?:demo|load) fixture manifest|fixture manifest.*does not match/i.test(message)
    ? 'BLOCKED' : 'FAIL';
}

function percentile(values, fraction) {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted.length ? Number(sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)].toFixed(2)) : null;
}

function removeOwnedTestDirectory(target) {
  const resolved = path.resolve(target);
  const relative = path.relative(TEST_PROFILE_ROOT, resolved);
  const name = path.basename(resolved);
  if (!relative || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative) || !/^(live-|extensions-)/.test(name)) {
    throw new Error('Refusing to remove a path outside this run’s isolated VS Code test directories.');
  }
  try {
    rmSync(resolved, { recursive: true, force: true });
  } catch (error) {
    if (process.platform !== 'win32' || !['EPERM', 'EACCES'].includes(error?.code)) throw error;
    const principal = execFileSync('whoami', [], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true }).trim();
    if (!/^[\w.-]+\\[\w.$-]+$/.test(principal)) throw error;
    execFileSync('icacls', [resolved, '/grant', `${principal}:(OI)(CI)F`, '/T', '/C'], { stdio: 'ignore', windowsHide: true });
    rmSync(resolved, { recursive: true, force: true, maxRetries: 3, retryDelay: 500 });
  }
}

async function runOne(key, round, args, executable, packageInfo) {
  const config = ENVS[key];
  const token = process.env[config.tokenName];
  if (!token) throw new Error(`Set ${config.tokenName} in the parent process environment before running live tests.`);
  const demo = args.fixture === 'demo';
  const fixtureManifest = path.join(STATE, 'runs', demo ? 'demo' : args.runId, `${key}-${demo ? 'retained' : 'load'}.json`);
  let manifest;
  try { manifest = JSON.parse(readFileSync(fixtureManifest, 'utf8')); }
  catch { throw new Error(`No ${args.fixture} fixture manifest exists for ${key}; prepare it with scripts/live-validation.mjs first.`); }
  if (manifest.environment !== key || (args.fixture === 'load' && (manifest.runId !== args.runId || manifest.schema !== 'GitLabWorkspaceLiveFixture/v2'))) {
    throw new Error(`The ${args.fixture} fixture manifest for ${key} does not match this run.`);
  }
  const expectedGroupPath = demo ? config.group : `grp-sn-maint/performance-${args.runId}`;
  const expectedWorkspace = path.resolve(STATE, 'workspaces', key, ...(demo ? ['demo'] : [args.runId, 'performance']));
  const checkoutRoot = path.resolve(manifest.checkoutRoot ?? path.join(STATE, 'workspaces', key, 'demo'));
  if (!sameFilesystemPath(checkoutRoot, expectedWorkspace) || manifest.group?.fullPath !== expectedGroupPath) {
    throw new Error('The fixture Group path or workspace does not match this exact environment and run.');
  }
  const expectedProjectCount = demo ? 3 : 20;
  if (manifest.resources?.projects?.length !== expectedProjectCount || (args.fixture === 'load' &&
    JSON.stringify(manifest.targetCounts) !== JSON.stringify({ projects: 20, issues: 500, mergeRequests: 50, graphNodes: 200 }))) {
    throw new Error(`The ${args.fixture} manifest does not contain its exact expected fixture inventory.`);
  }
  const profileId = `${key}-${round}-${process.pid}-${Date.now()}`;
  const profile = createLiveTestProfile(TEST_PROFILE_ROOT, profileId, !!process.env.VSCODE_PORTABLE);
  const { userData, extensions } = profile;
  mkdirSync(userData, { recursive: true });
  mkdirSync(extensions, { recursive: true });
  const settingsDirectory = path.join(userData, 'User');
  mkdirSync(settingsDirectory, { recursive: true });
  writeFileSync(path.join(settingsDirectory, 'settings.json'), JSON.stringify({
    'git.enabled': true,
    'git.autoRepositoryDetection': true,
    'git.openRepositoryInParentFolders': 'never',
    'git.useIntegratedAskPass': false,
    'extensions.autoCheckUpdates': false,
    'update.mode': 'none',
    'workbench.startupEditor': 'none'
  }, null, 2));
  mkdirSync(EVIDENCE, { recursive: true });
  const port = await freePort(config.port);
  const reportStem = `${key}-extension-${option('--label', '') ? option('--label') + '-' : ''}${String(round).padStart(2, '0')}`;
  const reportFile = path.join(EVIDENCE, `${reportStem}.json`);
  const env = {
    ...profile.environment,
    ELECTRON_RUN_AS_NODE: undefined,
    GLW_LIVE_ENVIRONMENT: key,
    GLW_LIVE_BASE_URL: config.url,
    GLW_LIVE_TOKEN: token,
    GLW_LIVE_MANIFEST: fixtureManifest,
    GLW_LIVE_GROUP_PATH: manifest.group?.fullPath ?? config.group,
    GLW_LIVE_FIXTURE: args.fixture,
    GLW_LIVE_RUN_ID: args.runId,
    GLW_LIVE_COLD_STARTED_AT: String(Date.now()),
    GLW_LIVE_WORKSPACE_ROOT: checkoutRoot,
    GLW_LIVE_CDP_PORT: String(port),
    GLW_LIVE_REPORT: reportFile,
    GLW_LIVE_VSCODE_VERSION: validatedVSCodeVersion,
    GLW_LIVE_GIT_GUI: args.gitGui ? '1' : '0',
    GLW_LIVE_BENCHMARK: args.benchmark ? '1' : '0',
    GLW_LIVE_BENCHMARK_BASELINE: args.baseline ? '1' : '0',
    GLW_LIVE_ROUND: String(round),
    GLW_LIVE_EXPECTED_VERSION: PACKAGE.version,
    GLW_LIVE_VSIX: packageInfo.vsix,
    GLW_LIVE_VSIX_SHA256: packageInfo.sha256,
    GLW_RUN_ID: process.env.GLW_RUN_ID || 'work-20261006-livevalidation'
  };
  const launch = runTests({
    vscodeExecutablePath: executable,
    extensionDevelopmentPath: packageInfo.extensionPath,
    extensionTestsPath: path.join(ROOT, 'scripts', 'live-extension-test-entry.cjs'),
    launchArgs: [checkoutRoot, `--user-data-dir=${userData}`, `--extensions-dir=${extensions}`, `--remote-debugging-port=${port}`, '--skip-welcome', '--skip-release-notes'],
    extensionTestsEnv: env
  });
  const cold = waitForCdp(port);
  try {
    const [coldResult] = await Promise.all([cold, launch]);
    const report = readTestReport(reportFile);
    return { ...report, coldStartToCdpMs: coldResult.startedMs, cdpBrowser: coldResult.details.Browser };
  } catch (error) {
    let recorded;
    try { recorded = JSON.parse(readFileSync(reportFile, 'utf8')); } catch { recorded = undefined; }
    const message = recorded?.error ?? safeError(error);
    const failure = {
      ...recorded,
      schema: 'GitLabWorkspaceLiveExtensionEvidence/v1', generatedAt: new Date().toISOString(),
      environment: key, baseUrl: config.url, expectedGitLabVersion: key === 'ce19' ? '19.4.1' : '16.11.10',
      vscodeVersion: validatedVSCodeVersion, testedArtifact: { vsix: packageInfo.vsix, sha256: packageInfo.sha256 },
      status: recorded?.status ?? (/timed out|fetch failed|ECONNREFUSED|network error/i.test(message) ? 'BLOCKED' : 'FAIL'), error: message
    };
    writeFileSync(path.join(EVIDENCE, `${reportStem}-failure.json`), `${JSON.stringify(failure, null, 2)}\n`, 'utf8');
    throw new Error(message);
  } finally {
    const cdpClosed = await waitForCdpClosed(port, 15_000);
    if (!cdpClosed) throw new Error(`VS Code is still serving CDP on port ${port}; preserving its isolated test profile.`);
    for (const target of profile.cleanupPaths) removeOwnedTestDirectory(target);
  }
}

function createLocalGitGuiFixture() {
  const fixtureParent = path.join(STATE, 'workspaces', 'local-git-gui');
  const fixtureRoot = path.join(fixtureParent, `run-${Date.now()}-${process.pid}`);
  const source = path.join(fixtureRoot, 'seed', 'service');
  const workspaceRoot = path.join(fixtureRoot, 'demo');
  const repository = path.join(workspaceRoot, 'service');
  const bareRemote = path.join(fixtureRoot, 'remote', 'service.git');
  mkdirSync(source, { recursive: true });
  execFileSync('git', ['init', '-b', 'main'], { cwd: source, stdio: 'ignore', windowsHide: true });
  execFileSync('git', ['config', 'user.name', 'GitLab Workspace Validation'], { cwd: source, stdio: 'ignore', windowsHide: true });
  execFileSync('git', ['config', 'user.email', 'gitlab-workspace-validation@localhost'], { cwd: source, stdio: 'ignore', windowsHide: true });
  execFileSync('git', ['config', 'commit.gpgSign', 'false'], { cwd: source, stdio: 'ignore', windowsHide: true });
  writeFileSync(path.join(source, 'README.md'), '# Isolated Git GUI validation fixture\n', 'utf8');
  writeFileSync(path.join(source, 'service.ts'), 'export const health = () => ({ ok: true });\n', 'utf8');
  execFileSync('git', ['add', 'README.md', 'service.ts'], { cwd: source, stdio: 'ignore', windowsHide: true });
  execFileSync('git', ['commit', '-m', 'Add minimal validation fixture'], { cwd: source, stdio: 'ignore', windowsHide: true });
  mkdirSync(path.dirname(repository), { recursive: true });
  mkdirSync(path.dirname(bareRemote), { recursive: true });
  execFileSync('git', ['clone', '--bare', '--no-hardlinks', source, bareRemote], { stdio: 'ignore', windowsHide: true });
  execFileSync('git', ['clone', '--branch', 'main', bareRemote, repository], { stdio: 'ignore', windowsHide: true });
  execFileSync('git', ['config', 'user.name', 'GitLab Workspace Validation'], { cwd: repository, stdio: 'ignore', windowsHide: true });
  execFileSync('git', ['config', 'user.email', 'gitlab-workspace-validation@localhost'], { cwd: repository, stdio: 'ignore', windowsHide: true });
  execFileSync('git', ['config', 'commit.gpgSign', 'false'], { cwd: repository, stdio: 'ignore', windowsHide: true });
  return { fixtureRoot, workspaceRoot, repository, source };
}

function removeOwnedLocalGitGuiFixture(target) {
  const fixtureParent = path.resolve(STATE, 'workspaces', 'local-git-gui');
  const resolved = path.resolve(target);
  const relative = path.relative(fixtureParent, resolved);
  if (!relative || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative) || !path.basename(resolved).startsWith('run-')) {
    throw new Error('Refusing to remove a local Git GUI fixture outside its dedicated run directory.');
  }
  rmSync(resolved, { recursive: true, force: true });
}

async function runLocalGitGui(executable, packageInfo, nativeConfirmation = false) {
  const fixture = createLocalGitGuiFixture();
  const profileId = `local-git-gui-${process.pid}-${Date.now()}`;
  const profile = createLiveTestProfile(TEST_PROFILE_ROOT, profileId, !!process.env.VSCODE_PORTABLE);
  const { userData, extensions } = profile;
  const logs = path.join(userData, 'logs');
  const port = await freePort(9343);
  const reportFile = path.join(EVIDENCE, nativeConfirmation ? 'git-gui-local-native.json' : 'git-gui-local.json');
  rmSync(reportFile, { force: true });
  mkdirSync(userData, { recursive: true });
  mkdirSync(extensions, { recursive: true });
  const settingsDirectory = path.join(userData, 'User');
  mkdirSync(settingsDirectory, { recursive: true });
  writeFileSync(path.join(settingsDirectory, 'settings.json'), JSON.stringify({
    'git.enabled': true,
    'git.autoRepositoryDetection': true,
    'git.openRepositoryInParentFolders': 'never',
    'git.useIntegratedAskPass': false,
    'git.autofetch': false,
    'extensions.autoCheckUpdates': false,
    'update.mode': 'none'
  }, null, 2));
  mkdirSync(path.join(EVIDENCE, 'screenshots'), { recursive: true });
  const env = {
    ...profile.environment,
    ELECTRON_RUN_AS_NODE: undefined,
    GLW_LOCAL_GIT_GUI: '1',
    GLW_LOCAL_GIT_GUI_NATIVE_CONFIRM: nativeConfirmation ? '1' : undefined,
    GLW_LOCAL_GIT_GUI_REPORT: reportFile,
    GLW_LOCAL_GIT_GUI_LOG_ROOT: logs,
    GLW_LOCAL_VSCODE_EXPECTED_VERSION: validatedVSCodeVersion,
    GLW_LIVE_WORKSPACE_ROOT: fixture.repository,
    GLW_LIVE_CDP_PORT: String(port),
    GLW_LIVE_EXPECTED_VERSION: PACKAGE.version,
    GLW_LIVE_VSIX: packageInfo.vsix,
    GLW_LIVE_VSIX_SHA256: packageInfo.sha256,
    GLW_RUN_ID: `local-git-gui-${Date.now()}`
  };
  const launch = runTests({
    vscodeExecutablePath: executable,
    extensionDevelopmentPath: packageInfo.extensionPath,
    extensionTestsPath: path.join(ROOT, 'scripts', 'live-extension-test-entry.cjs'),
    launchArgs: [fixture.repository, `--user-data-dir=${userData}`, `--extensions-dir=${extensions}`, `--logsPath=${logs}`, `--remote-debugging-port=${port}`, '--skip-welcome', '--skip-release-notes'],
    extensionTestsEnv: env
  });
  let result;
  try {
    const [cold] = await Promise.all([waitForCdp(port), launch]);
    const report = readTestReport(reportFile);
    result = { ...report, vscodeVersion: validatedVSCodeVersion, sourceRepository: 'isolated generated Git seed', isolatedRemote: 'local bare Repo', coldStartMs: cold.startedMs };
  } catch (error) {
    let recorded;
    try { recorded = JSON.parse(readFileSync(reportFile, 'utf8')); } catch { recorded = undefined; }
    const message = recorded?.error ?? (error instanceof Error ? error.message : 'Local Git GUI validation failed.');
    const failure = {
      ...recorded, schema: 'GitLabWorkspaceLocalGitGuiEvidence/v1', generatedAt: new Date().toISOString(),
      mode: 'local-only', status: 'FAIL', sourceRepository: 'isolated generated Git seed',
      testedArtifact: { vsix: packageInfo.vsix, sha256: packageInfo.sha256 }, error: message
    };
    result = failure;
    writeFileSync(reportFile, `${JSON.stringify(failure, null, 2)}\n`, 'utf8');
  } finally {
    await waitForCdpClosed(port, 15_000);
    const cleanupErrors = [];
    for (const target of profile.cleanupPaths) {
      try { removeOwnedTestDirectory(target); } catch (error) { cleanupErrors.push(error instanceof Error ? error.message : String(error)); }
    }
    try { removeOwnedLocalGitGuiFixture(fixture.fixtureRoot); } catch (error) { cleanupErrors.push(error instanceof Error ? error.message : String(error)); }
    if (cleanupErrors.length) {
      result = { ...result, cleanup: { status: 'BLOCKED', errors: cleanupErrors } };
      writeFileSync(reportFile, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
    }
  }
  return result;
}

async function runNativeGitGuiStandalone(executable, packageInfo) {
  const fixture = createLocalGitGuiFixture();
  const profileId = `native-git-gui-${process.pid}-${Date.now()}`;
  const profile = createLiveTestProfile(TEST_PROFILE_ROOT, profileId, !!process.env.VSCODE_PORTABLE);
  const { userData, extensions } = profile;
  const systemProfile = path.join(userData, 'system-profile');
  const appData = path.join(systemProfile, 'AppData', 'Roaming');
  const localAppData = path.join(systemProfile, 'AppData', 'Local');
  const tempData = path.join(systemProfile, 'Temp');
  const port = await freePort(9393);
  const reportFile = path.join(EVIDENCE, 'git-gui-local-native.json');
  const screenshotDir = path.join(EVIDENCE, 'screenshots');
  mkdirSync(path.join(userData, 'User'), { recursive: true });
  mkdirSync(extensions, { recursive: true });
  mkdirSync(path.join(systemProfile, '.vscode'), { recursive: true });
  for (const directory of [appData, localAppData, tempData, path.join(systemProfile, '.vscode-shared')]) mkdirSync(directory, { recursive: true });
  mkdirSync(screenshotDir, { recursive: true });
  writeFileSync(path.join(userData, 'User', 'settings.json'), JSON.stringify({
    'git.enabled': true,
    'git.autoRepositoryDetection': true,
    'git.openRepositoryInParentFolders': 'never',
    'git.useIntegratedAskPass': false,
    'security.workspace.trust.enabled': false,
    'extensions.autoCheckUpdates': false,
    'update.mode': 'none',
    'workbench.startupEditor': 'none',
    'window.dialogStyle': 'custom'
  }, null, 2));
  let child;
  let cdpConnection;
  let result;
  let extensionInstallOutput = '';
  const processOutput = [];
  const started = performance.now();
  const systemDrive = path.parse(systemProfile).root;
  const nativeEnvironment = {
    ...process.env,
    ...profile.environment,
    USERPROFILE: systemProfile,
    HOME: systemProfile,
    HOMEDRIVE: systemDrive.slice(0, 2),
    HOMEPATH: systemProfile.slice(systemDrive.length - 1),
    APPDATA: appData,
    LOCALAPPDATA: localAppData,
    TEMP: tempData,
    TMP: tempData
  };
  try {
    const cli = path.join(path.dirname(executable), 'bin', 'code.cmd');
    extensionInstallOutput = execFileSync('powershell.exe', [
      '-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
      '$cli = $env:GLW_VSCODE_CLI; & $cli "--user-data-dir=$env:GLW_NATIVE_USER_DATA" "--extensions-dir=$env:GLW_NATIVE_EXTENSIONS" --install-extension $env:GLW_NATIVE_VSIX --force; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }; & $cli "--user-data-dir=$env:GLW_NATIVE_USER_DATA" "--extensions-dir=$env:GLW_NATIVE_EXTENSIONS" --list-extensions --show-versions; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }'
    ], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
      env: { ...nativeEnvironment, GLW_VSCODE_CLI: cli, GLW_NATIVE_USER_DATA: userData, GLW_NATIVE_EXTENSIONS: extensions,
        GLW_NATIVE_VSIX: path.resolve(ROOT, packageInfo.vsix) }
    });
    const extensionIdentifier = `${PACKAGE.publisher}.${PACKAGE.name}@${PACKAGE.version}`;
    if (!extensionInstallOutput.includes(extensionIdentifier)) {
      throw new Error(`The isolated VS Code CLI did not register the packaged extension ${extensionIdentifier}.`);
    }
    const codeEnvironment = { ...nativeEnvironment };
    delete codeEnvironment.ELECTRON_RUN_AS_NODE;
    child = spawn(executable, [fixture.repository, `--user-data-dir=${userData}`, `--extensions-dir=${extensions}`,
      `--remote-debugging-port=${port}`, '--disable-gpu', '--disable-hardware-acceleration', '--disable-gpu-sandbox', '--no-sandbox', '--skip-welcome', '--skip-release-notes'], {
      cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: false,
      env: codeEnvironment
    });
    child.once('error', (error) => { result ??= { status: 'FAIL', error: error.message }; });
    for (const stream of [child.stdout, child.stderr]) stream.on('data', (chunk) => {
      processOutput.push(String(chunk).slice(-4000));
      if (processOutput.join('').length > 12_000) processOutput.splice(0, processOutput.length - 3);
    });
    const exited = new Promise((_, reject) => child.once('exit', (code, signal) => {
      reject(new Error(`Standalone VS Code exited before CDP opened (code=${code}, signal=${signal}). ${processOutput.join('').slice(-9000)}`));
    }));
    const cdp = await Promise.race([waitForCdp(port, 45_000), exited]);
    if (!cdp.details.webSocketDebuggerUrl) throw new Error('Standalone VS Code did not publish its CDP WebSocket URL.');
    cdpConnection = await StandaloneCdpConnection.connect(cdp.details.webSocketDebuggerUrl);
    const page = await waitForStandaloneWorkbench(cdpConnection);
    await page.bringToFront();
    await page.locator('.command-center-quick-pick').waitFor({ state: 'visible', timeout: 20_000 });
    await page.locator('.command-center-quick-pick').click();
    await page.locator('.quick-input-widget').waitFor({ state: 'visible', timeout: 5_000 });
    const gitCommandTitle = PACKAGE.contributes.commands.find((command) => command.command === 'gitlabWorkspace.openGitMode')?.title;
    if (!gitCommandTitle) throw new Error('The packaged extension does not contribute its Git GUI command.');
    await page.keyboard.type(`>${gitCommandTitle}`, { delay: 12 });
    try { await page.waitForFunction(({ title }) => [...document.querySelectorAll('.quick-input-list-entry')].some((entry) => entry.innerText?.includes(title)), { title: gitCommandTitle }, { timeout: 10_000 }); }
    catch {
      const workbench = await page.evaluate(`(() => ({ title: document.title, url: location.href, bodyText: document.body?.innerText?.slice(0, 1800), activeElement: document.activeElement?.outerHTML?.slice(0, 600), quickInputs: [...document.querySelectorAll('.quick-input-widget')].map((element) => ({ text: element.textContent, visible: element.checkVisibility?.({ checkOpacity: true, checkVisibilityCSS: true }) ?? element.getClientRects().length > 0, inputs: [...element.querySelectorAll('input')].map((input) => ({ value: input.value, placeholder: input.placeholder, aria: input.getAttribute('aria-label') })) })) }))()`);
      await page.screenshot({ path: path.join(screenshotDir, 'native-workbench-command-palette.png') }).catch(() => undefined);
      throw new Error(`The standalone extension command was not available in the command picker (${JSON.stringify(workbench)}).`);
    }
    await page.screenshot({ path: path.join(screenshotDir, 'native-workbench-command-palette.png') });
    await page.keyboard.press('Enter');
    const frame = await waitForStandaloneGitWebview(cdpConnection, page, screenshotDir);
    await frame.locator('.git-workbench').waitFor({ state: 'visible', timeout: 20_000 });
    const gitGui = await exerciseNativeGitGui(frame, page, fixture.repository, `native-${Date.now()}`, screenshotDir);
    result = {
      schema: 'GitLabWorkspaceLocalNativeGitGuiEvidence/v1', generatedAt: new Date().toISOString(),
      mode: 'local-only-native-confirmation', dialogStyle: 'custom', vscodeVersion: validatedVSCodeVersion, status: 'PASS',
      testedArtifact: { vsix: packageInfo.vsix, sha256: packageInfo.sha256 },
      repository: fixture.repository, remoteKind: 'isolated-local-bare-repository',
      coldStartMs: Number(cdp.startedMs.toFixed(2)), elapsedMs: Number((performance.now() - started).toFixed(2)),
      extensionInstallOutput: extensionInstallOutput.trim(),
      interactiveConfirmationUI: 'PASS', gitGui,
      screenshots: ['screenshots/native-commit-confirmation.png', 'screenshots/native-push-confirmation.png', 'screenshots/local-git-gui-native.png']
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Standalone native Git GUI validation failed.';
    const status = /confirmation was not exposed as a visible Workbench dialog/i.test(message) ? 'BLOCKED' : 'FAIL';
    result = {
      schema: 'GitLabWorkspaceLocalNativeGitGuiEvidence/v1', generatedAt: new Date().toISOString(),
      mode: 'local-only-native-confirmation', dialogStyle: 'custom', vscodeVersion: validatedVSCodeVersion, status,
      testedArtifact: { vsix: packageInfo.vsix, sha256: packageInfo.sha256 },
      repository: fixture.repository, remoteKind: 'isolated-local-bare-repository',
      error: message,
      extensionInstallOutput: extensionInstallOutput.trim(),
      processOutput: processOutput.join('').slice(-9000)
    };
  } finally {
    if (cdpConnection) {
      await cdpConnection.send('Browser.close').catch(() => undefined);
      cdpConnection.close();
      await waitForCdpClosed(port, 10_000);
    }
    if (child && child.exitCode === null) {
      try { execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true, timeout: 10_000 }); }
      catch { child.kill(); }
    }
    const cleanupErrors = [];
    for (const target of profile.cleanupPaths) {
      try { removeOwnedTestDirectory(target); } catch (error) { cleanupErrors.push(error instanceof Error ? error.message : String(error)); }
    }
    try { removeOwnedLocalGitGuiFixture(fixture.fixtureRoot); } catch (error) { cleanupErrors.push(error instanceof Error ? error.message : String(error)); }
    if (cleanupErrors.length) result = { ...result, cleanup: { status: 'BLOCKED', errors: cleanupErrors } };
    if (result) writeFileSync(reportFile, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
  }
  return result;
}

async function waitForStandaloneWorkbench(connection) {
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    const targets = await connection.send('Target.getTargets');
    const info = (targets.targetInfos ?? []).find((target) => target.type === 'page' && /workbench\.html|vscode-file:/.test(target.url));
    if (info) {
      const attached = await connection.send('Target.attachToTarget', { targetId: info.targetId, flatten: true });
      if (typeof attached.sessionId !== 'string') throw new Error('CDP did not create a Workbench target session.');
      const page = new StandaloneCdpTarget(connection, attached.sessionId);
      await page.send('Runtime.enable');
      await page.send('Page.enable');
      return page;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const targets = await connection.send('Target.getTargets');
  throw new Error(`No standalone VS Code Workbench target appeared (${JSON.stringify(targets.targetInfos ?? [])}).`);
}

async function waitForStandaloneGitWebview(connection, workbench, screenshotDir) {
  const deadline = Date.now() + 20_000;
  const observations = [];
  while (Date.now() < deadline) {
    const targets = await connection.send('Target.getTargets');
    for (const info of targets.targetInfos ?? []) {
      if (!info.url.startsWith('vscode-webview://')) continue;
      try {
        const attached = await connection.send('Target.attachToTarget', { targetId: info.targetId, flatten: true });
        if (typeof attached.sessionId !== 'string') continue;
        const frame = new StandaloneCdpTarget(connection, attached.sessionId, true);
        await frame.send('Runtime.enable');
        await frame.send('Page.enable').catch(() => undefined);
        const snapshot = await frame.evaluate(`(() => { const find = (doc, depth = 0) => { if (!doc || depth > 6) return null; if (doc.querySelector('.app-shell, .git-workbench')) return doc; for (const iframe of doc.querySelectorAll('iframe')) { try { const nested = find(iframe.contentDocument, depth + 1); if (nested) return nested; } catch {} } return null; }; const root = find(document) ?? document; return { title: root.title, url: root.location?.href, readyState: root.readyState, gitWorkbenchCount: root.querySelectorAll('.git-workbench').length, bodyText: root.body?.innerText?.slice(0, 1200), htmlStart: root.documentElement?.outerHTML?.slice(0, 800), nestedFrames: [...document.querySelectorAll('iframe')].map((element) => ({ src: element.src, title: element.title, className: element.className, rect: (() => { const rect = element.getBoundingClientRect(); return { x: rect.x, y: rect.y, width: rect.width, height: rect.height }; })() })), roots: [...root.querySelectorAll('main, [role=main], .app-shell, .git-workbench')].slice(0, 8).map((element) => ({ tag: element.tagName, className: String(element.className ?? ''), text: element.innerText?.slice(0, 180) })) }; })()`);
        observations.push({ target: { type: info.type, title: info.title, url: info.url }, snapshot });
        if (snapshot.gitWorkbenchCount) return frame;
        if (info.url.includes('extensionId=local-dev.gitlab-workspace') && !existsSync(path.join(screenshotDir, 'native-git-webview-probe.png'))) {
          await frame.screenshot({ path: path.join(screenshotDir, 'native-git-webview-probe.png') }).catch(() => undefined);
        }
        await frame.detach();
      } catch { /* Webview targets can appear before their document is ready */ }
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const targets = await connection.send('Target.getTargets');
  const diagnostics = await workbench.evaluate(`(() => ({ title: document.title, url: location.href, bodyText: document.body?.innerText?.slice(0, 1800), quickInputs: [...document.querySelectorAll('.quick-input-widget')].map((element) => ({ text: element.innerText, visible: element.checkVisibility?.({ checkOpacity: true, checkVisibilityCSS: true }) ?? element.getClientRects().length > 0 })), dialogs: [...document.querySelectorAll('.monaco-dialog-box, .notification-toast')].map((element) => element.innerText?.slice(0, 500)) }))()`);
  await workbench.screenshot({ path: path.join(screenshotDir, 'native-workbench-after-git-command.png') }).catch(() => undefined);
  throw new Error(`The standalone GitLab Workspace Git GUI Webview did not render. Workbench=${JSON.stringify(diagnostics)} Observations=${JSON.stringify(observations.slice(-6))} Targets=${JSON.stringify(targets.targetInfos ?? [])}`);
}

class StandaloneCdpConnection {
  sequence = 0;
  pending = new Map();

  constructor(socket) {
    this.socket = socket;
    socket.addEventListener('message', (event) => {
      let message;
      try { message = JSON.parse(String(event.data)); } catch { return; }
      if (message.id === undefined) return;
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(message.error.message ?? 'CDP command failed.'));
      else pending.resolve(message.result ?? {});
    });
    socket.addEventListener('close', () => {
      for (const request of this.pending.values()) request.reject(new Error('Standalone VS Code CDP connection closed.'));
      this.pending.clear();
    });
  }

  static async connect(address) {
    const socket = new WebSocket(address);
    await new Promise((resolve, reject) => {
      socket.addEventListener('open', resolve, { once: true });
      socket.addEventListener('error', () => reject(new Error('Could not connect to standalone VS Code CDP.')), { once: true });
    });
    return new StandaloneCdpConnection(socket);
  }

  send(method, params = {}, sessionId) {
    const id = ++this.sequence;
    const response = new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
    this.socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    return response;
  }

  close() { this.socket.close(); }
}

class StandaloneCdpTarget {
  constructor(connection, sessionId, searchNestedFrames = false) {
    this.connection = connection;
    this.sessionId = sessionId;
    this.searchNestedFrames = searchNestedFrames;
    this.mouse = {
      click: async (x, y) => {
        await this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
        await this.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
        await this.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
      }
    };
    this.keyboard = {
      press: async (key) => {
        if (key === 'Control+Shift+P') {
          const keyEvent = (type, name, code, virtualKey, modifiers) => this.send('Input.dispatchKeyEvent', {
            type, key: name, code, windowsVirtualKeyCode: virtualKey, nativeVirtualKeyCode: virtualKey, modifiers
          });
          await keyEvent('rawKeyDown', 'Control', 'ControlLeft', 17, 0);
          await keyEvent('rawKeyDown', 'Shift', 'ShiftLeft', 16, 2);
          await keyEvent('keyDown', 'P', 'KeyP', 80, 10);
          await keyEvent('keyUp', 'P', 'KeyP', 80, 10);
          await keyEvent('keyUp', 'Shift', 'ShiftLeft', 16, 2);
          await keyEvent('keyUp', 'Control', 'ControlLeft', 17, 0);
          return;
        }
        if (key === 'Enter') {
          await this.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
          await this.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
          return;
        }
        throw new Error(`Unsupported standalone UI key: ${key}`);
      },
      type: async (text) => { await this.send('Input.insertText', { text }); }
    };
  }

  send(method, params = {}) { return this.connection.send(method, params, this.sessionId); }

  async evaluate(expression) {
    const scopedExpression = this.searchNestedFrames
      ? `((document) => (${expression}))((() => { const find = (doc, depth = 0) => { if (!doc || depth > 6) return null; if (doc.querySelector('.app-shell, .git-workbench')) return doc; for (const iframe of doc.querySelectorAll('iframe')) { try { const nested = find(iframe.contentDocument, depth + 1); if (nested) return nested; } catch {} } return null; }; return find(globalThis.document) ?? globalThis.document; })())`
      : expression;
    const response = await this.send('Runtime.evaluate', { expression: scopedExpression, awaitPromise: true, returnByValue: true, userGesture: true });
    if (response.exceptionDetails) throw new Error(response.exceptionDetails.exception?.description ?? response.exceptionDetails.text ?? 'Standalone UI evaluation failed.');
    return response.result?.value;
  }

  locator(selector, options = {}) { return new StandaloneCdpLocator(this, selector, options); }
  getByText(text, options = {}) { return this.locator('*').filter({ hasText: text, exact: options.exact }); }
  getByRole(role, options = {}) { return this.locator(role === 'button' ? ':is(button, [role="button"])' : `[role="${role}"]`).filter({ hasText: options.name ?? '', exact: options.exact }); }

  async waitForFunction(callback, argument, options = {}) {
    const expression = `(${callback.toString()})(${JSON.stringify(argument)})`;
    await this.waitUntil(expression, options.timeout ?? 10_000, 'Standalone Webview condition was not met.');
  }

  async waitUntil(expression, timeout, message) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      if (await this.evaluate(expression).catch(() => false)) return;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error(message);
  }

  async bringToFront() { await this.send('Page.bringToFront'); }

  async screenshot({ path: outputPath }) {
    const result = await this.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    writeFileSync(outputPath, Buffer.from(result.data, 'base64'));
  }

  async detach() { await this.connection.send('Target.detachFromTarget', { sessionId: this.sessionId }).catch(() => undefined); }
}

class StandaloneCdpLocator {
  constructor(target, selector, options = {}) { this.target = target; this.selector = selector; this.options = options; this.index = undefined; }

  locator(selector) { return new StandaloneCdpLocator(this.target, `${this.selector} ${selector}`, this.options); }
  filter(options) { return new StandaloneCdpLocator(this.target, this.selector, { ...this.options, ...options }); }
  first() { const locator = new StandaloneCdpLocator(this.target, this.selector, this.options); locator.index = 0; return locator; }
  nth(index) { const locator = new StandaloneCdpLocator(this.target, this.selector, this.options); locator.index = index; return locator; }

  async _query(operation) {
    const expression = `(() => {
      const find = (doc, depth = 0) => { if (!doc || depth > 6) return null; if (doc.querySelector('.app-shell, .git-workbench')) return doc; for (const iframe of doc.querySelectorAll('iframe')) { try { const nested = find(iframe.contentDocument, depth + 1); if (nested) return nested; } catch {} } return null; };
      const root = ${this.target.searchNestedFrames ? '(find(document) ?? document)' : 'document'};
      const matches = [...root.querySelectorAll(${JSON.stringify(this.selector)})].filter((element) => {
        const text = (element.innerText ?? element.textContent ?? '').trim();
        ${this.options.hasText === undefined ? '' : `return ${this.options.exact ? `text === ${JSON.stringify(String(this.options.hasText))}` : `text.toLocaleLowerCase('en-US').includes(${JSON.stringify(String(this.options.hasText).toLocaleLowerCase('en-US'))})`};`}
        return true;
      });
      ${operation}
    })()`;
    return this.target.evaluate(expression);
  }

  async waitFor(options = {}) {
    const state = options.state ?? 'visible';
    const deadline = Date.now() + (options.timeout ?? 10_000);
    while (Date.now() < deadline) {
      const visible = await this._query(`const item = matches[${this.index ?? 0}]; return !!item && (item.checkVisibility?.({ checkOpacity: true, checkVisibilityCSS: true }) ?? (item.getClientRects().length > 0 && getComputedStyle(item).visibility !== 'hidden' && getComputedStyle(item).display !== 'none'));`).catch(() => false);
      if (state === 'visible' && visible || state === 'hidden' && !visible || state === 'attached' && await this.count()) return;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error(`Timed out waiting for ${state} selector ${this.selector}.`);
  }

  async count() { return this._query(`return matches.length;`); }

  async click() {
    const point = await this._query(`const item = matches[${this.index ?? 0}]; if (!item) return null; item.scrollIntoView({ block: 'center', inline: 'nearest' }); const rect = item.getBoundingClientRect(); return rect.width && rect.height ? { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 } : null;`);
    if (!point) {
      const candidates = await this._query(`return matches.slice(0, 8).map((item) => ({ tag: item.tagName, text: (item.innerText ?? item.textContent ?? '').trim().slice(0, 120), className: String(item.className ?? ''), rect: (() => { const rect = item.getBoundingClientRect(); return { x: rect.x, y: rect.y, width: rect.width, height: rect.height }; })() }));`).catch(() => []);
      throw new Error(`Could not click standalone UI selector ${this.selector} (text=${JSON.stringify(this.options.hasText)}, candidates=${JSON.stringify(candidates)}).`);
    }
    await this.target.mouse.click(point.x, point.y);
  }

  async fill(value) {
    const filled = await this._query(`const item = matches[${this.index ?? 0}]; if (!item) return false; item.focus(); const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(item), 'value')?.set; if (setter) setter.call(item, ${JSON.stringify(value)}); else item.value = ${JSON.stringify(value)}; item.dispatchEvent(new Event('input', { bubbles: true })); item.dispatchEvent(new Event('change', { bubbles: true })); return true;`);
    if (!filled) throw new Error(`Could not fill standalone UI selector ${this.selector}.`);
  }

  async check() {
    const checked = await this._query(`const item = matches[${this.index ?? 0}]; if (!item) return false; if (!item.checked) item.click(); return true;`);
    if (!checked) throw new Error(`Could not check standalone UI selector ${this.selector}.`);
  }

  async selectOption(value) {
    const selected = await this._query(`const item = matches[${this.index ?? 0}]; if (!item) return false; Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set?.call(item, ${JSON.stringify(value)}); item.dispatchEvent(new Event('change', { bubbles: true })); return item.value === ${JSON.stringify(value)};`);
    if (!selected) throw new Error(`Could not select ${value} from standalone UI selector ${this.selector}.`);
  }

  async evaluateAll(callback) {
    return this._query(`return (${callback.toString()})(matches);`);
  }

  async innerText() { return this._query(`return matches[${this.index ?? 0}]?.innerText ?? '';`); }
  getByRole(role, options = {}) { return this.locator(role === 'button' ? ':is(button, [role="button"])' : role).filter({ hasText: options.name ?? '', exact: options.exact }); }
  getByText(text, options = {}) { return this.locator('*').filter({ hasText: text, exact: options.exact }); }
}

async function exerciseNativeGitGui(frame, page, repositoryPath, runId, screenshotDir) {
  const runGit = (args) => execFileSync('git', args, { cwd: repositoryPath, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const waitGit = async (args, predicate, message, timeoutMs = 20_000) => {
    const deadline = Date.now() + timeoutMs;
    let latest = '';
    while (Date.now() < deadline) {
      try { latest = runGit(args); } catch (error) { latest = error instanceof Error ? error.message : String(error); }
      if (predicate(latest)) return latest;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(`${message}; last Git output: ${latest}`);
  };
  const waitGuiAction = async () => {
    await frame.locator('.git-progress').waitFor({ state: 'visible', timeout: 10_000 });
    await frame.locator('.git-progress').waitFor({ state: 'hidden', timeout: 30_000 });
  };
  const confirm = async (label) => {
    const selectors = ['.monaco-dialog-box', '[role="dialog"]', 'dialog[open]', '[aria-modal="true"]', '.quick-input-widget', '.notifications-toasts .notification-list-item', '.notification-toast'];
    const deadline = Date.now() + 15_000;
    let matched;
    let observed = [];
    while (Date.now() < deadline && !matched) {
      observed = await page.evaluate(`(() => {
        const visible = (element) => element.checkVisibility?.({ checkOpacity: true, checkVisibilityCSS: true }) ?? (element.getClientRects().length > 0 && getComputedStyle(element).visibility !== 'hidden' && getComputedStyle(element).display !== 'none');
        const selectors = ${JSON.stringify(selectors)};
        return [...new Set(selectors.flatMap((selector) => [...document.querySelectorAll(selector)]))]
          .filter(visible)
          .map((element) => ({ selector: selectors.find((selector) => element.matches(selector)), text: (element.innerText ?? element.textContent ?? '').trim().slice(0, 1200), buttons: [...element.querySelectorAll('button, [role="button"]')].map((button) => ({ text: (button.innerText ?? button.textContent ?? '').trim(), aria: button.getAttribute('aria-label') })) }));
      })()`);
      const matchingSelector = observed.find((candidate) => candidate.text.toLocaleLowerCase('en-US').includes(label.toLocaleLowerCase('en-US')) &&
        candidate.buttons.some((button) => button.text === label || button.aria === label))?.selector;
      if (matchingSelector) matched = page.locator(matchingSelector);
      else await new Promise((resolve) => setTimeout(resolve, 100));
    }
    if (!matched) {
      const diagnostic = await page.evaluate(`(() => ({
        title: document.title,
        visibleLayers: [...document.querySelectorAll('[role="dialog"], dialog[open], [aria-modal="true"], .monaco-dialog, .monaco-dialog-box, .quick-input-widget, .notifications-toasts, .notification-toast')]
          .filter((element) => element.checkVisibility?.({ checkOpacity: true, checkVisibilityCSS: true }) ?? element.getClientRects().length > 0)
          .map((element) => ({ tag: element.tagName, role: element.getAttribute('role'), className: String(element.className ?? ''), text: (element.innerText ?? element.textContent ?? '').trim().slice(0, 1000) })),
        bodyTextEnd: document.body?.innerText?.slice(-1800) ?? ''
      }))()`);
      await page.screenshot({ path: path.join(screenshotDir, `native-${label.toLocaleLowerCase('en-US')}-confirmation.png`) }).catch(() => undefined);
      writeFileSync(path.join(path.dirname(screenshotDir), `native-${label.toLocaleLowerCase('en-US')}-confirmation-debug.json`), `${JSON.stringify({ diagnostic, observed }, null, 2)}\n`, 'utf8');
      throw new Error(`${label} confirmation was not exposed as a visible Workbench dialog with its action button. Diagnostics=${JSON.stringify(diagnostic)}`);
    }
    const text = await matched.innerText();
    await page.screenshot({ path: path.join(screenshotDir, `native-${label.toLocaleLowerCase('en-US')}-confirmation.png`) });
    await matched.getByRole('button', { name: label, exact: true }).click();
    return text;
  };

  await frame.locator('.git-repo-picker select').waitFor({ state: 'visible', timeout: 20_000 });
  const repoSelect = frame.locator('.git-repo-picker select');
  try {
    await frame.waitForFunction(({ repoName }) => {
      const select = document.querySelector('.git-repo-picker select');
      return !!select && [...select.options].some((option) => option.text.toLocaleLowerCase('en-US').includes(repoName.toLocaleLowerCase('en-US')));
    }, { repoName: 'service' }, { timeout: 20_000 });
  } catch {
    const repositoryState = await repoSelect.evaluateAll((options) => options.map((option) => ({ value: option.value, text: option.textContent ?? '' })));
    const bodyText = await frame.evaluate('document.body?.innerText?.slice(0, 800) ?? ""');
    throw new Error(`The native Git GUI did not discover the service Repo after waiting for Git discovery. Options=${JSON.stringify(repositoryState)} Webview=${JSON.stringify(bodyText)}`);
  }
  const serviceOption = await repoSelect.locator('option').evaluateAll((options) => options.map((option) => ({ value: option.value, text: option.textContent ?? '' })).find((option) => option.text.toLocaleLowerCase('en-US').includes('service')));
  if (!serviceOption) throw new Error('The standalone Git GUI did not discover the service Repo.');
  await repoSelect.selectOption(serviceOption.value);
  await frame.waitForFunction(() => document.querySelector('.git-repo-heading strong')?.textContent?.toLocaleLowerCase('en-US') === 'service' && document.querySelector('.git-toolbar > button.secondary')?.disabled === false, undefined, { timeout: 20_000 });
  const currentBranch = runGit(['branch', '--show-current']);
  const branch = `validation/native-gui/${Date.now().toString(36)}`;
  await frame.locator('.git-toolbar > button.secondary').click();
  const branchInput = frame.locator('.git-dialog input[name="name"]');
  await branchInput.waitFor({ state: 'visible' });
  await branchInput.fill(branch);
  await frame.locator('.git-dialog button[type="submit"]').click();
  await frame.waitForFunction(({ branch }) => {
    const select = document.querySelector('.git-branch-picker select');
    return !!select && [...select.options].some((option) => option.value === branch) && select.value === branch;
  }, { branch }, { timeout: 20_000 });
  await waitGit(['branch', '--show-current'], (value) => value === branch, 'The Git GUI did not check out the created branch.');

  const serviceFile = path.join(repositoryPath, 'service.ts');
  const original = readFileSync(serviceFile, 'utf8');
  writeFileSync(serviceFile, `${original.trimEnd()}\n// native GUI partial-stage ${runId}\n// native GUI whole-file stage ${runId}\n`, 'utf8');
  await frame.locator('.git-change-name').filter({ hasText: 'service.ts' }).first().waitFor({ state: 'visible', timeout: 15_000 });
  await frame.locator('.git-change-name').filter({ hasText: 'service.ts' }).first().click();
  const addedLines = frame.locator('.git-diff-line.add input[type="checkbox"]');
  await addedLines.first().waitFor({ state: 'visible' });
  if (await addedLines.count() !== 2) throw new Error('The native UI fixture should expose two added lines.');
  await addedLines.nth(0).check();
  await frame.locator('.git-diff-actions button').first().click();
  await waitGuiAction();
  const partial = await waitGit(['diff', '--cached', '--numstat'], (value) => /^1\s+0\s+service\.ts$/.test(value), 'Partial staging did not stage exactly one line.');
  await frame.locator('.git-change-row button[title="取消暫存整檔"]').first().click();
  await waitGuiAction();
  await waitGit(['diff', '--cached', '--numstat'], (value) => !value, 'Unstage did not clear the index.');
  await frame.locator('.git-change-row button[title="暫存整檔"]').first().click();
  await waitGuiAction();
  const whole = await waitGit(['diff', '--cached', '--numstat'], (value) => /^2\s+0\s+service\.ts$/.test(value), 'Whole-file staging did not stage both lines.');

  const commitMessage = `GUI native confirmation ${runId}`;
  await frame.locator('.git-commit-composer textarea[name="message"]').fill(commitMessage);
  await frame.waitForFunction(() => document.querySelector('.git-commit-launch')?.disabled === false, undefined, { timeout: 10_000 });
  await frame.locator('.git-commit-launch').click();
  await frame.locator('.git-progress').waitFor({ state: 'visible', timeout: 10_000 });
  const commitConfirmation = await confirm('Commit');
  await frame.locator('.git-progress').waitFor({ state: 'hidden', timeout: 30_000 });
  const commit = await waitGit(['log', '-1', '--format=%s'], (value) => value.includes(commitMessage), 'The confirmed commit did not appear in local Git history.');

  await frame.locator('.git-push').click();
  await frame.locator('.git-dialog').waitFor({ state: 'visible' });
  await frame.locator('.git-dialog button[type="submit"]').click();
  await frame.locator('.git-progress').waitFor({ state: 'visible', timeout: 10_000 });
  const pushConfirmation = await confirm('Push');
  await frame.locator('.git-progress').waitFor({ state: 'hidden', timeout: 30_000 });
  const upstream = await waitGit(['rev-parse', '--abbrev-ref', '@{upstream}'], (value) => value === `origin/${branch}`, 'Push did not set the upstream branch.');
  const remoteBranch = await waitGit(['ls-remote', 'origin', `refs/heads/${branch}`], (value) => /^[a-f0-9]{40,64}\s+refs\/heads\//.test(value), 'Push did not update the isolated bare remote.');
  await frame.evaluate("(() => { document.querySelector('.git-back-graph')?.click(); })()");
  await frame.locator('.git-commit-list').waitFor({ state: 'visible' });
  await frame.locator('.git-commit-list').getByText(commitMessage, { exact: true }).waitFor({ state: 'visible' });
  const historyRows = await frame.locator('.git-commit-row').count();
  await page.screenshot({ path: path.join(screenshotDir, 'local-git-gui-native.png') });
  return {
    branch, previousBranch: currentBranch, stagedPartial: partial, stagedWholeFile: whole,
    commitMessage: commit, pushUpstream: upstream, remoteBranch: remoteBranch.split(/\s+/)[0],
    commitConfirmation: 'workbench-dom', pushConfirmation: 'workbench-dom', historyRows
  };
}

async function main() {
  const localGitGui = process.argv.includes('--local-git-gui');
  const nativeConfirmation = process.argv.includes('--native-confirmation');
  if (nativeConfirmation && !localGitGui) throw new Error('--native-confirmation requires --local-git-gui.');
  const keys = localGitGui ? [] : environmentKeys();
  const benchmark = process.argv.includes('--benchmark') || process.env.GLW_LIVE_BENCHMARK === '1';
  const baseline = process.argv.includes('--baseline');
  if (baseline && !benchmark) throw new Error('--baseline is only supported in benchmark mode.');
  const fixture = option('--fixture', benchmark ? 'load' : 'demo');
  if (!['demo', 'load'].includes(fixture)) throw new Error('Use --fixture demo or --fixture load.');
  const label = option('--label', '');
  if (label && !/^[a-z0-9][a-z0-9-]{0,31}$/.test(label)) throw new Error('--label may contain only 1–32 lowercase letters, digits, and hyphens.');
  const runId = option('--run-id', process.env.GLW_RUN_ID ?? (fixture === 'demo' ? 'demo' : ''));
  if (!/^[a-z0-9][a-z0-9-]{3,39}$/.test(runId)) throw new Error('Provide --run-id with 4–40 lowercase letters, digits, and hyphens for the selected fixture.');
  const rounds = option('--rounds', benchmark ? '10' : '1');
  const roundCount = Number(rounds);
  if (!Number.isInteger(roundCount) || roundCount < 1 || roundCount > 10) throw new Error('Cold-start rounds must be 1–10.');
  const args = { gitGui: process.argv.includes('--git-gui') || process.env.GLW_LIVE_GIT_GUI === '1', benchmark, baseline, fixture, runId };
  const comparisonPath = option('--compare-with', undefined);
  let baselineReport;
  if (comparisonPath) {
    if (!benchmark) throw new Error('--compare-with is only supported in benchmark mode.');
    const baselinePath = path.resolve(comparisonPath);
    const baselineRelative = path.relative(EVIDENCE, baselinePath);
    if (!baselineRelative || baselineRelative.startsWith(`..${path.sep}`) || path.isAbsolute(baselineRelative)) {
      throw new Error('--compare-with must point to a report inside this work’s evidence directory.');
    }
    baselineReport = JSON.parse(readFileSync(baselinePath, 'utf8'));
    if (baselineReport.schema !== 'GitLabWorkspaceLiveVerification/v1' || baselineReport.mode !== 'benchmark') {
      throw new Error('--compare-with must reference a completed live benchmark report.');
    }
  }
  const executable = verifyVsCodeExecutable();
  const packageInfo = preparePackagedExtension(option('--vsix', undefined));
  const artifactEvidence = { vsix: packageInfo.vsix, sha256: packageInfo.sha256 };
  if (localGitGui) {
    try {
      const result = nativeConfirmation
        ? await runNativeGitGuiStandalone(executable, packageInfo)
        : await runLocalGitGui(executable, packageInfo, false);
      const reportName = nativeConfirmation ? 'git-gui-local-native.json' : 'git-gui-local.json';
      writeFileSync(path.join(EVIDENCE, reportName), `${JSON.stringify(result, null, 2)}\n`, 'utf8');
      process.stdout.write(`${JSON.stringify({ mode: nativeConfirmation ? 'local-git-gui-native-confirmation' : 'local-git-gui', testedArtifact: artifactEvidence, result }, null, 2)}\n`);
      if (result.status !== 'PASS') process.exitCode = 1;
    } finally {
      removeOwnedTestDirectory(packageInfo.unpackRoot);
    }
    return;
  }
  const results = [];
  const failures = [];
  for (const key of keys) {
    for (let round = 1; round <= (args.benchmark ? roundCount : 1); round++) {
      try { results.push(await runOne(key, round, args, executable, packageInfo)); }
      catch (error) {
        const message = safeError(error);
        const status = classifyLiveStatus(error);
        failures.push({ environment: key, round, status, error: message });
        if (status === 'BLOCKED') break;
      }
    }
  }
  const summary = {
    schema: 'GitLabWorkspaceLiveVerification/v1', generatedAt: new Date().toISOString(),
    vscodeVersion: validatedVSCodeVersion, testedArtifact: artifactEvidence,
    mode: args.benchmark ? 'benchmark' : args.gitGui ? 'git-gui' : 'live-smoke', fixture: args.fixture, runId: args.runId,
    ...(label ? { label } : {}),
    environments: results, failures,
    ...(args.benchmark ? { performance: keys.map((environment) => {
      const samples = results.filter((result) => result.environment === environment);
      const warmNavigation = samples.flatMap((sample) => sample.warmNavigationMs?.samples ?? []);
      const localSearch = samples.flatMap((sample) => sample.localRepoSearchMs?.samples ?? []);
      const localSearchApiRequests = samples.reduce((sum, sample) => sum + (Number(sample.localSearchApiRequests) || 0), 0);
      const navigationApiRequests = samples.reduce((sum, sample) => sum + (Number(sample.navigationApiRequests) || 0), 0);
      const coldReady = samples.map((sample) => sample.coldInteractiveReadyMs).filter(Number.isFinite);
      const warmP95Ms = percentile(warmNavigation, 0.95);
      const localSearchP95Ms = percentile(localSearch, 0.95);
      const narrowLayoutFailure = !args.baseline && samples.some((sample) => sample.narrowLayout && sample.narrowLayout.content > sample.narrowLayout.viewport + 1);
      const apiMetrics = samples.flatMap((sample) => sample.api ?? []);
      const operationCounts = samples.map((sample) => sample.operationCounts ?? { available: false });
      const operationMetricsAvailable = operationCounts.every((counts) => counts.available !== false &&
        Number.isFinite(Number(counts.gitCommands)) && Number.isFinite(Number(counts.webviewMessages?.sent)) && Number.isFinite(Number(counts.webviewMessages?.received)));
      const status = failures.some((failure) => failure.environment === environment && failure.status === 'FAIL') ? 'FAIL' :
        failures.some((failure) => failure.environment === environment) || samples.length !== roundCount ? 'BLOCKED' :
          warmP95Ms > 1_000 || localSearchP95Ms > 100 || localSearchApiRequests > 0 || narrowLayoutFailure ? 'FAIL' : 'PASS';
      return { environment, status, coldSessions: samples.length, coldInteractiveReadyMs: coldReady,
        warmOperations: warmNavigation.length, warmNavigationP95Ms: warmP95Ms, warmNavigationLimitMs: 1_000,
        localSearchSamples: localSearch.length, localSearchP95Ms, localSearchLimitMs: 100, localSearchApiRequests,
        navigationApiRequests,
        narrowLayoutFailure,
        apiRequests: apiMetrics.length,
        apiResponseBytes: apiMetrics.reduce((sum, metric) => sum + (Number(metric.bytes) || 0), 0),
        operationMetricsStatus: operationMetricsAvailable ? 'PASS' : 'UNSUPPORTED',
        gitCommands: operationMetricsAvailable ? operationCounts.reduce((sum, counts) => sum + Number(counts.gitCommands), 0) : null,
        webviewMessagesSent: operationMetricsAvailable ? operationCounts.reduce((sum, counts) => sum + Number(counts.webviewMessages.sent), 0) : null,
        webviewMessagesReceived: operationMetricsAvailable ? operationCounts.reduce((sum, counts) => sum + Number(counts.webviewMessages.received), 0) : null };
    }) } : {})
  };
  if (baselineReport) summary.baselineComparison = compareLiveBenchmarks(summary, baselineReport);
  const summaryStatuses = [
    ...failures.map((failure) => failure.status),
    ...(summary.performance?.map((result) => result.status) ?? []),
    ...(summary.baselineComparison ? [summary.baselineComparison.status] : [])
  ];
  summary.status = summaryStatuses.includes('FAIL') ? 'FAIL' : summaryStatuses.includes('BLOCKED') ? 'BLOCKED' : 'PASS';
  const modeName = args.benchmark ? 'benchmark' : args.gitGui ? 'git-gui' : 'live-smoke';
  const file = path.join(EVIDENCE, `${modeName}${label ? `-${label}` : ''}.json`);
  writeFileSync(file, `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
  process.stdout.write(`${JSON.stringify({ evidence: path.relative(ROOT, file), mode: summary.mode, testedArtifact: artifactEvidence, environments: results.map(({ environment, version, selectedGroup, projects, schemaBytes, coldStartToCdpMs, coldInteractiveReadyMs, warmNavigationMs, localRepoSearchMs, memory, gitGui }) => ({ environment, version, selectedGroup, projects, schemaBytes, coldStartToCdpMs, coldInteractiveReadyMs, warmNavigationMs, localRepoSearchMs, memory, gitGui })), performance: summary.performance, failures }, null, 2)}\n`);
  removeOwnedTestDirectory(packageInfo.unpackRoot);
  if (summary.status !== 'PASS') process.exitCode = 1;
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : 'Live Extension Host validation failed.';
  const redacted = ['GLW_CE19_TOKEN', 'GLW_CE16_TOKEN', 'GLW_LIVE_TOKEN'].reduce((value, name) => {
    const token = process.env[name];
    return token ? value.split(token).join('[redacted]') : value;
  }, message);
  process.stderr.write(`${redacted}\n`);
  process.exitCode = 1;
}).finally(() => {
  process.env.GLW_CE19_TOKEN = '';
  process.env.GLW_CE16_TOKEN = '';
  process.env.GLW_LIVE_TOKEN = '';
});
