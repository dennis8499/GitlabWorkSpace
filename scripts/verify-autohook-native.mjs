import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, promisify } from 'node:util';

const { values } = parseArgs({ options: {
  'codex-extension': { type: 'string' }, python: { type: 'string', default: 'python' },
  vsix: { type: 'string' }, report: { type: 'string' }
} });
if (process.platform !== 'win32' || !values['codex-extension']) {
  throw new Error('Run on Windows with --codex-extension <installed Codex extension directory> and optionally --python <python.exe>.');
}
const root = fileURLToPath(new URL('../', import.meta.url));
const manifest = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
const vsix = path.resolve(values.vsix ?? path.join(root, 'dist', `gitlab-workspace-${manifest.version}.vsix`));
const reportPath = path.resolve(values.report ?? path.join(root, 'dist', `autohook-native-verification-${manifest.version}.json`));
const installedCodex = await realpath(values['codex-extension']);
const tempParent = await realpath(os.tmpdir());
const temporary = await realpath(await mkdtemp(path.join(tempParent, 'ah-')));
const exec = promisify(execFile);
const pathKey = Object.keys(process.env).find(key => key.toUpperCase() === 'PATH') ?? 'Path';
const originalPath = process.env[pathKey];
const evidence = { schema: 'gitlab-workspace-autohook-native-verification/v1', version: manifest.version,
  vsixSha256: createHash('sha256').update(await readFile(vsix)).digest('hex'),
  registry: 'VS Code metadata stub pointing to the installed Codex extension; native tools and installer are real',
  hookTrustVerified: false, scenarios: [] };
const passed = scenario => { evidence.scenarios.push(scenario); console.log(`PASS ${scenario}`); };
let configuredPath = '', registryRoot;
try {
  // Extract only safe extension entries from the verified, locally built VSIX.
  await exec(values.python, ['-X', 'utf8', '-B', '-c', [
    'import pathlib, sys, zipfile',
    'root = pathlib.Path(sys.argv[2]).resolve()',
    'with zipfile.ZipFile(sys.argv[1]) as package:',
    '    for name in package.namelist():',
    '        if not name.startswith("extension/"): continue',
    '        member = pathlib.PurePosixPath(name)',
    '        if "\\\\" in name or ".." in member.parts or member.is_absolute(): raise ValueError("Unsafe VSIX member")',
    '        target = root.joinpath(*member.parts)',
    '        if name.endswith("/"): target.mkdir(parents=True, exist_ok=True); continue',
    '        target.parent.mkdir(parents=True, exist_ok=True)',
    '        target.write_bytes(package.read(name))'
  ].join('\n'), vsix, temporary], { windowsHide: true, timeout: 30_000 });
  const packagedRoot = path.join(temporary, 'extension');
  for (const relative of ['out/src/workspace/codexRuntime.js', 'out/src/workspace/workspacePanel.js']) {
    assert.deepEqual(await readFile(path.join(packagedRoot, relative)), await readFile(path.join(root, relative)));
  }
  passed('VSIX resolver and controller match the compiled source');

  const shimRoot = path.join(temporary, 'shim'); await mkdir(shimRoot);
  const shim = path.join(shimRoot, 'codex.cmd'); await writeFile(shim, '@exit /b 97\r\n');
  const directories = (originalPath ?? '').split(';').filter(Boolean);
  const keep = await Promise.all(directories.map(async directory => {
    for (const name of ['codex.exe', 'codex.cmd', 'codex.bat', 'codex.ps1']) {
      if (await stat(path.join(directory.replace(/^"|"$/g, ''), name)).then(info => info.isFile(), () => false)) return false;
    }
    return true;
  }));
  process.env[pathKey] = [shimRoot, ...directories.filter((_, index) => keep[index])].join(';');

  const require = createRequire(import.meta.url);
  const loader = require('node:module');
  const originalLoad = loader._load;
  const uri = fsPath => ({ scheme: 'file', fsPath });
  let registryReads = 0;
  const vscode = {
    Uri: { joinPath: (base, ...parts) => uri(path.join(base.fsPath, ...parts)) },
    workspace: { getConfiguration: () => ({ get: (key, fallback) =>
      key === 'pythonPath' ? values.python : key === 'autoHook.codexPath' ? configuredPath : fallback }) },
    extensions: { getExtension: id => {
      registryReads++;
      return id === 'openai.chatgpt' && registryRoot ? { extensionUri: uri(registryRoot) } : undefined;
    } }
  };
  let WorkspacePanel;
  loader._load = (name, ...args) => name === 'vscode' ? vscode : originalLoad.call(loader, name, ...args);
  try { ({ WorkspacePanel } = require(path.join(packagedRoot, 'out/src/workspace/workspacePanel.js'))); }
  finally { loader._load = originalLoad; }
  const host = Object.assign(Object.create(WorkspacePanel.prototype), { context: { extensionUri: uri(packagedRoot) } });
  const helper = args => host.runWorkflowKitHelper(args, 120_000);
  const project = path.join(temporary, 'repo'); await mkdir(project);
  await exec('git', ['init', '--quiet', project], { windowsHide: true, timeout: 10_000 });
  const bundle = path.join(packagedRoot, 'resources/offline-tools/workflow-kit.tar.xz');
  const installArgs = ['install', bundle, project, manifest.version, 'bundled', '--format', 'tar.xz', '--entry-root', 'workflow-kit',
    '--archive-sha256', createHash('sha256').update(await readFile(bundle)).digest('hex'), '--profile', 'repository'];
  assert.deepEqual(await host.autoHookCodexArguments(), []);
  await helper(installArgs);
  assert.equal((await helper(['autohook', 'status', project])).status, 'disabled');
  passed('Skills installs with only a shim and no discoverable native Codex');

  const owned = ['.codex/config.toml', '.codex/hooks.json'];
  const baseline = await Promise.all(owned.map(relative => readFile(path.join(project, relative))));
  const child = path.join(project, 'child', '.codex', 'config.toml'); await mkdir(path.dirname(child), { recursive: true });
  await writeFile(child, '# child configuration stays\n');
  configuredPath = shim;
  await assert.rejects(helper(['autohook', 'enable', project, ...await host.autoHookCodexArguments()]), /autoHook\.codexPath 設定無效/);
  for (const [index, relative] of owned.entries()) assert.deepEqual(await readFile(path.join(project, relative)), baseline[index]);
  assert.equal((await helper(['autohook', 'status', project])).enabled, false);
  passed('invalid manual shim produces the setting error from real installer stderr and preserves the project');

  configuredPath = ''; registryRoot = installedCodex;
  const codexArgs = await host.autoHookCodexArguments();
  assert.equal(codexArgs[0], '--codex'); assert.ok(registryReads > 0);
  const native = codexArgs[1]; assert.ok(native.toLowerCase().startsWith(installedCodex.toLowerCase() + path.sep));
  evidence.codexVersion = (await exec(native, ['--version'], { windowsHide: true, timeout: 10_000 })).stdout.trim();
  await helper(['autohook', 'enable', project, ...codexArgs]);
  assert.equal((await helper(['autohook', 'status', project])).status, 'enabled');
  const settings = JSON.parse(await readFile(path.join(project, '.codex/autohook/settings.json'), 'utf8'));
  assert.equal(settings.codex_path.toLowerCase(), native.toLowerCase());
  passed('extension fallback enables AutoHook with real Codex execpolicy and PowerShell AST probes');
  await helper(['autohook', 'revalidate', project, ...await host.autoHookCodexArguments()]);
  await helper([...installArgs, ...await host.autoHookCodexArguments()]);
  assert.equal((await helper(['autohook', 'status', project])).status, 'enabled');
  passed('revalidation and enabled-kit update retain a ready AutoHook installation');
  await helper(['autohook', 'disable', project]);
  assert.equal((await helper(['autohook', 'status', project])).status, 'disabled');
  for (const [index, relative] of owned.entries()) assert.deepEqual(await readFile(path.join(project, relative)), baseline[index]);
  assert.equal(await readFile(child, 'utf8'), '# child configuration stays\n');
  passed('disable restores the Wiki baseline and preserves child configuration');
  evidence.status = 'passed';
} catch (error) {
  evidence.status = 'failed'; evidence.error = error instanceof Error ? error.message : String(error);
  throw error;
} finally {
  if (originalPath === undefined) delete process.env[pathKey]; else process.env[pathKey] = originalPath;
  await mkdir(path.dirname(reportPath), { recursive: true });
  await writeFile(reportPath, JSON.stringify(evidence, null, 2) + '\n');
  if (path.dirname(temporary) !== tempParent || !path.basename(temporary).startsWith('ah-')) throw new Error('Unsafe native smoke cleanup path');
  await rm(temporary, { recursive: true, force: true, maxRetries: 4, retryDelay: 100 });
}
