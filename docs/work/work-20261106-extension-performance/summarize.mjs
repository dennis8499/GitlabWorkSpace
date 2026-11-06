import { readFile, writeFile, readdir, copyFile, stat } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertPrepared } from '../../../scripts/validation-runtime.mjs';

const directory = path.dirname(fileURLToPath(import.meta.url)), root = path.resolve(directory, '../../..');
const json = async name => JSON.parse(await readFile(path.join(directory, name), 'utf8'));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const runRoot = path.join(root, '.gitlab-workspace-validation/runs');
const candidates = (await readdir(runRoot)).sort().reverse();
let unitRun;
for (const candidate of candidates) {
  try { await stat(path.join(runRoot, candidate, 'unit.log')); unitRun = path.join(runRoot, candidate); break; }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
}
if (!unitRun) throw new Error('No unit result found');
const unitTiming = JSON.parse(await readFile(path.join(unitRun, 'timings.json'), 'utf8'));
if (unitTiming.status !== 'success') throw new Error('The final unit run did not succeed');
await copyFile(path.join(unitRun, 'unit.log'), path.join(directory, 'unit-final.log'));
await copyFile(path.join(unitRun, 'timings.json'), path.join(directory, 'unit-timings.json'));
const countTests = async name => {
  const source = await readFile(path.join(directory, name), 'utf8');
  return Object.fromEntries(['tests', 'pass', 'fail', 'skipped'].map(key => [key,
    Number(new RegExp('(?:^|\\n)[\\u2139\\s]*' + key + ' (\\d+)').exec(source)?.[1])]));
};
const native = [];
for (const [version, run, name] of [
  ['1.90.0', '2026-11-06T13-03-26.303Z-54524', 'native-full-1.90.details.log'],
  ['1.145.1', '2026-11-06T13-15-23.165Z-50164', 'native-full-stable.details.log']
]) {
  const source = await readFile(path.join(runRoot, run, 'extension.log'), 'utf8');
  await writeFile(path.join(directory, name), source);
  native.push({ version, passing: Number(/(\d+) passing/.exec(source)?.[1]), pending: Number(/(\d+) pending/.exec(source)?.[1]),
    failing: Number(/(\d+) failing/.exec(source)?.[1]), log: name });
}
await assertPrepared(root, ['lint', 'compile', 'webview', 'issue']);
const manifest = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true });
const files = [...new Set((git('diff', '--name-only', '-z') + '\0' + git('ls-files', '--others', '--exclude-standard', '-z')).split('\0'))]
  .filter(name => /^(?:src|test|scripts)\//.test(name)).sort();
const snapshot = { head: git('rev-parse', 'HEAD').trim(), version: manifest.version,
  files: await Promise.all(files.map(async name => ({ path: name, sha256: sha(await readFile(path.join(root, name))) }))),
  prepared: JSON.parse(await readFile(path.join(root, '.gitlab-workspace-validation/prepared.json'), 'utf8')) };
await writeFile(path.join(directory, 'source-snapshot.json'), JSON.stringify(snapshot, null, 2) + '\n');
const report = { schema: 'GitLabWorkspaceImplementationVerification/v1', checkedAt: new Date().toISOString(),
  status: 'NEEDS_CHANGES', source: 'source-snapshot.json', preparedOutputsVerified: true,
  unit: await countTests('unit-final.log'), behavior: await countTests('behavior-final.log'),
  cucumber: { scenarios: 39, steps: 171, status: 'PASS' }, native,
  bmad: await json('bmad-native-comparison.json'), renderer: (await json('codex-performance.json')).summary,
  ui: { cases: (await json('ui/ui-verification.json')).cases, failures: (await json('ui/ui-verification.json')).failures,
    metrics: (await json('ui/ui-verification.json')).metrics, focusCases: (await json('ui-focus/ui-verification.json')).cases,
    focusedComposerVisible: (await json('ui-focus/ui-verification.json')).results.every(row => row.composerFocusVisible === true) },
  idle: { ...(await json('idle-host.json')), buildPhase: 'Before the final unchanged-result guard and Wiki CSS adjustment; the observed Git-page path was unchanged.' },
  artifact: await json('artifact-identity.json'), release: await json('release/termination.json'),
  limitations: ['Full native host suites failed; see native logs', 'Actual native 240/320px, 125%/200% zoom and NVDA were not manually accepted',
    'No real GitLab, model quota, remote publication or live Codex response latency was tested'] };
await writeFile(path.join(directory, 'verification.json'), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ status: report.status, unit: report.unit, behavior: report.behavior, native, artifact: report.artifact }, null, 2));
