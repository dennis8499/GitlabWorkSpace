import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { pythonCommandCandidates, pythonUtf8Environment, supportsPython311 } from './python-runtime.mjs';

const [script, ...args] = process.argv.slice(2);
if (!script) throw new Error('Supply a Python script path.');

const env = pythonUtf8Environment();
let selected;
for (const candidate of pythonCommandCandidates()) {
  const version = spawnSync(candidate.executable, [...candidate.args, '--version'], {
    encoding: 'utf8',
    env,
    maxBuffer: 64 * 1024,
    timeout: 10_000,
    windowsHide: true
  });
  if (!version.error && version.status === 0 && supportsPython311(`${version.stdout ?? ''} ${version.stderr ?? ''}`)) {
    selected = candidate;
    break;
  }
}

if (!selected) {
  process.stderr.write('Python 3.11+ is required. Install Python or add a Python launcher to PATH.\n');
  process.exitCode = 1;
} else {
  const result = spawnSync(selected.executable, [...selected.args, resolve(script), ...args], {
    env,
    stdio: 'inherit',
    windowsHide: true
  });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
}
