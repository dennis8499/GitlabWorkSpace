import { execFileSync } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runTests } from '@vscode/test-electron';
import { inspectHostExecutable, isolatedHostEnvironment } from './extension-test-environment.mjs';

const project = fileURLToPath(new URL('../', import.meta.url));
const option = name => { const index = process.argv.indexOf(name); return index < 0 ? undefined : process.argv[index + 1]; };
const workspace = option('--workspace') ? await realpath(option('--workspace')) : await mkdtemp(path.join(os.tmpdir(), 'gitlab-codex-real-'));
if (!/^gitlab-codex-real-[a-z0-9]+$/i.test(path.basename(workspace))) throw new Error('Use a disposable gitlab-codex-real-* directory containing the pinned WorkflowKit group fixture.');
const manifest = JSON.parse(await readFile(path.join(project, 'package.json'), 'utf8'));
const vsix = option('--vsix') ?? path.join(project, 'dist', `gitlab-workspace-${manifest.version}.vsix`);
const evidence = await mkdtemp(path.join(project, '.tmp/codex-live-'));
const executable = process.env.VSCODE_EXECUTABLE_PATH ?? path.join(process.env.LOCALAPPDATA, 'Programs/Microsoft VS Code/Code.exe');
const proof = await inspectHostExecutable(executable);
const extracted = path.join(evidence, 'vsix'); await mkdir(extracted);
execFileSync('python', ['-c', 'import sys,zipfile; zipfile.ZipFile(sys.argv[1]).extractall(sys.argv[2])', vsix, extracted], { windowsHide: true });
console.log(JSON.stringify({ workspace, evidence, vscode: proof.version }));
const fixtureRoot = path.join(project, 'test/fixtures/workflowkit-release-1.5.0');
const descriptor = JSON.parse(await readFile(path.join(fixtureRoot, 'release.json'), 'utf8'));
const installer = path.join(fixtureRoot, descriptor.assets.installer.name);
try { await readFile(path.join(workspace, '.gitlab-workspace/tool-manifests/workflow-kit.json')); }
catch (error) {
  if (error.code !== 'ENOENT') throw error;
  console.log('Installing pinned WorkflowKit fixture into the disposable workspace.');
  const installed = execFileSync('python', ['-X', 'utf8', '-B', installer, 'install', path.join(fixtureRoot, descriptor.assets.package.name), workspace,
    '1.5.0', 'github', '--format', 'zip', '--entry-root', 'workflow-kit', '--archive-sha256', descriptor.assets.package.sha256, '--profile', 'group'],
    { windowsHide: true, timeout: 180_000, encoding: 'utf8', maxBuffer: 1024 * 1024 });
  await writeFile(path.join(evidence, 'installation.json'), installed);
}
const state = JSON.parse(execFileSync('python', ['-X', 'utf8', '-B', installer, 'status', workspace, '--expected-version', '1.5.0'],
  { windowsHide: true, encoding: 'utf8', maxBuffer: 1024 * 1024 }).trim().split(/\r?\n/).at(-1));
if (!['installed', 'update-available'].includes(state.status)) throw new Error(`The disposable WorkflowKit installation is not ready: ${state.message ?? state.status}`);
// Match an installation performed through the extension: a verified same-source status helper is cached.
const storage = path.join(evidence, 'user/User/globalStorage/local-dev.gitlab-workspace');
await mkdir(path.join(storage, 'workflow-kit-downloads'), { recursive: true });
for (const asset of Object.values(descriptor.assets)) await copyFile(path.join(fixtureRoot, asset.name), path.join(storage, 'workflow-kit-downloads', asset.sha256 + path.extname(asset.name)));
await writeFile(path.join(storage, 'workflow-kit-release-cache.json'), JSON.stringify({ schema: 'workflowkit-release-cache/v1', releases: [{ source: 'github', descriptor,
  descriptorSha256: createHash('sha256').update(await readFile(path.join(fixtureRoot, 'release.json'))).digest('hex') }] }));
const service = path.join(workspace, 'service');
const git = (...args) => execFileSync('git', ['-C', service, ...args], { windowsHide: true, stdio: 'pipe' });
if (process.argv.includes('--reuse-fixture')) {
  if (String(git('status', '--porcelain')).trim().split(/\r?\n/).some(line => line && line !== '?? review-reports/') || String(git('show', 'main:calculator.py')) !== 'def add(a, b):\n    return a + b\n' ||
      String(git('show', 'feature:calculator.py')) !== 'def add(a, b):\n    return a - b\n') throw new Error('The existing fixture has changed; use a fresh disposable workspace.');
} else {
await mkdir(service);
git('init', '-q', '--initial-branch=main'); git('config', 'user.name', 'Codex Bridge Fixture'); git('config', 'user.email', 'fixture@example.invalid');
await writeFile(path.join(service, 'calculator.py'), 'def add(a, b):\n    return a + b\n');
await writeFile(path.join(service, 'test_calculator.py'), 'from calculator import add\nassert add(2, 3) == 5\n');
git('add', '.'); git('commit', '-qm', 'baseline'); git('checkout', '-qb', 'feature');
await writeFile(path.join(service, 'calculator.py'), 'def add(a, b):\n    return a - b\n'); git('add', '.'); git('commit', '-qm', 'fixture regression');
execFileSync('git', ['clone', '--bare', service, path.join(workspace, 'remote.git')], { windowsHide: true, stdio: 'pipe' });
git('remote', 'add', 'origin', path.join(workspace, 'remote.git'));
}
const server = createServer(); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port; await new Promise(resolve => server.close(resolve));
const { env, removed } = isolatedHostEnvironment();
// runTests merges its overrides into process.env; remove inherited Electron launch flags there too.
for (const key of removed) delete process.env[key];
const runtime = await mkdtemp(path.join(os.tmpdir(), 'gitlab-codex-runtime-'));
await writeFile(path.join(evidence, 'runtime.json'), JSON.stringify({ runtime }));
await writeFile(path.join(evidence, 'host.json'), JSON.stringify(proof, null, 2));
await runTests({ vscodeExecutablePath: proof.executable, extensionDevelopmentPath: path.join(extracted, 'extension'),
  extensionTestsPath: path.join(project, 'out/test/codex-live/index.js'),
  extensionTestsEnv: { ...env, GLW_CODEX_LIVE: '1', GLW_CODEX_LIVE_ROOT: workspace, GLW_CODEX_LIVE_EVIDENCE: evidence,
    GLW_CODEX_LIVE_PORT: String(port), GLW_CODEX_LIVE_TOOLS: option('--tools') ?? 'wiki,merge-reviewer,release-reviewer,bmad,commit-reviewer', GITLAB_WORKSPACE_RUNTIME_DIR: runtime },
  launchArgs: [workspace, '--disable-workspace-trust', '--skip-welcome', '--skip-release-notes', '--disable-gpu',
    `--user-data-dir=${path.join(evidence, 'user')}`, `--extensions-dir=${path.join(evidence, 'extensions')}`, `--remote-debugging-port=${port}`] });
console.log(`Codex live evidence: ${evidence}`);
