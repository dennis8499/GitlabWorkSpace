// Read-only release suites use the repository's existing logging and worker pool.
// Kept separate while the native-host validation owns the build runner lock.
import { readdir, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { runLogged, runPool } from '../../../scripts/validation-runtime.mjs';

const root = process.cwd(), evidenceDir = path.resolve('docs/work/work-20261106-extension-performance/release');
await mkdir(evidenceDir, { recursive: true });
const results = [];
const execute = async job => {
  const result = await runLogged(job, { cwd: root, evidenceDir });
  results.push(result);
  await writeFile(path.join(evidenceDir, 'results.json'), JSON.stringify(results, null, 2) + '\n');
  return result;
};
const tooling = (await readdir('scripts')).filter(name => name.endsWith('.test.mjs')).sort();
await execute({ id: 'release-tooling', command: process.execPath, args: ['--test', ...tooling.map(name => 'scripts/' + name)] });
const files = (await readdir('test/release')).filter(name => name.endsWith('_test.py')).sort();
const jobs = files.map(name => ({ id: 'release-' + name.replace('_test.py', ''), command: process.execPath,
  args: ['scripts/run-python.mjs', 'test/release/' + name] }));
const expensive = ['release-workflow_kit_profiles', 'release-workflow_kit_transactions', 'release-workflow_kit_installer', 'release-release_reviewer_integration'];
const priority = job => expensive.indexOf(job.id) < 0 ? 100 : expensive.indexOf(job.id);
jobs.sort((left, right) => priority(left) - priority(right));
await runPool(jobs, 2, execute);
if (results.some(result => result.exitCode !== 0)) process.exitCode = 1;
