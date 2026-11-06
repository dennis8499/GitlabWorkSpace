import { runTests } from '@vscode/test-electron';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, realpath, rm, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isolatedHostEnvironment } from '../../../scripts/extension-test-environment.mjs';

const directory = path.dirname(fileURLToPath(import.meta.url)), root = path.resolve(directory, '../../..');
const executable = process.env.VSCODE_EXECUTABLE_PATH;
if (!executable) throw new Error('Set VSCODE_EXECUTABLE_PATH to the isolated test editor.');
const isolated = isolatedHostEnvironment();
for (const key of isolated.removed) delete process.env[key];
const parent = await realpath(os.tmpdir()), temporary = await mkdtemp(path.join(parent, 'glw-idle-'));
let success = false;
try {
  const repository = path.join(temporary, 'repo'), bare = path.join(temporary, 'remote.git'), profile = path.join(temporary, 'profile');
  await mkdir(repository); await mkdir(path.join(profile, 'User'), { recursive: true });
  const git = (args, cwd = temporary) => execFileSync('git', args, { cwd, windowsHide: true, stdio: 'pipe' });
  git(['init', '--bare', bare]); git(['init', repository]);
  git(['config', 'user.name', 'Fixture'], repository); git(['config', 'user.email', 'fixture@example.invalid'], repository);
  await writeFile(path.join(repository, 'README.md'), '# Idle fixture\n');
  git(['add', '.'], repository); git(['commit', '-m', 'Fixture'], repository);
  git(['remote', 'add', 'origin', bare], repository); git(['push', '-u', 'origin', 'HEAD'], repository);
  await writeFile(path.join(profile, 'User/settings.json'), JSON.stringify({
    'git.autofetch': false, 'git.confirmSync': false, 'update.mode': 'none', 'telemetry.telemetryLevel': 'off',
    'extensions.autoUpdate': false, 'extensions.autoCheckUpdates': false, 'workbench.startupEditor': 'none'
  }));
  const runtime = path.join(temporary, 'runtime'); await mkdir(runtime);
  await writeFile(path.join(runtime, 'network-policy.json'), JSON.stringify({ schema: 'GitLabWorkspaceNetworkPolicy/v1', api: { startsPerSecond: 10000, concurrency: 128 } }));
  await runTests({ vscodeExecutablePath: executable, extensionDevelopmentPath: root,
    extensionTestsPath: path.join(directory, 'idle-host.cjs'),
    launchArgs: [repository, '--disable-workspace-trust', '--skip-welcome', '--skip-release-notes',
      '--user-data-dir=' + profile, '--extensions-dir=' + path.join(temporary, 'extensions'), '--logsPath=' + path.join(temporary, 'logs')],
    extensionTestsEnv: { ...isolated.env, GLW_IDLE_REPORT: path.join(directory, 'idle-host.json'), GITLAB_WORKSPACE_RUNTIME_DIR: runtime }
  });
  const report = JSON.parse(await readFile(path.join(directory, 'idle-host.json'), 'utf8'));
  if (report.status !== 'PASS' || report.samples.length !== 10) throw new Error('Idle test did not complete ten minutes.');
  success = true;
} finally {
  const target = await realpath(temporary);
  if (path.dirname(target) !== parent || !path.basename(target).startsWith('glw-idle-')) throw new Error('Unsafe fixture cleanup target');
  if (success) await rm(target, { recursive: true, force: true, maxRetries: 12, retryDelay: 100 });
  else console.error('Isolated idle logs retained at ' + target);
}
