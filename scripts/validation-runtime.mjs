import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { lstat, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

export const receiptPath = '.gitlab-workspace-validation/prepared.json';
const ignored = new Set(['.git', 'node_modules', '__pycache__']);

export async function fingerprint(root, paths) {
  const files = [];
  async function visit(relative) {
    // Work evidence is excluded from the VSIX; published guides are inputs.
    if (relative.replaceAll('\\', '/') === 'docs/work') return;
    const full = path.join(root, relative);
    const info = await lstat(full);
    if (info.isSymbolicLink()) throw new Error(`Build input/output must not be a symlink: ${relative}`);
    if (info.isDirectory()) {
      for (const entry of (await readdir(full)).sort()) {
        if (!ignored.has(entry) && !entry.endsWith('.pyc')) await visit(path.join(relative, entry));
      }
    } else if (info.isFile()) {
      files.push([relative.replaceAll('\\', '/'), createHash('sha256').update(await readFile(full)).digest('hex')]);
    }
  }
  for (const relative of [...paths].sort()) await visit(relative);
  return createHash('sha256').update(JSON.stringify(files)).digest('hex');
}

export function preparationInputs() {
  return ['package.json', 'package-lock.json', '.gitattributes', 'src', 'test', 'scripts', 'docs',
    'tsconfig.json', 'tsconfig.webview.json', 'vite.dashboard.config.mjs',
    'vite.sidebar.config.mjs', 'vite.issue-test.config.mjs', '.vscode-test.mjs',
    '.vscodeignore', 'README.md', 'CONTRIBUTING.md', 'resources/git-rebase-editor.cjs', 'resources/windows-git-supervisor.ps1',
    'resources/git-askpass.js', 'resources/git-askpass.sh', 'resources/git-ssh-askpass.sh',
    'resources/gitlab-workspace.svg', 'resources/workflow-kit-status.py', 'resources/bmad'];
}

export async function savePreparation(root, stages, outputs) {
  const receipt = { schema: 'gitlab-workspace-prepared/v1', stages, outputs,
    inputs: await fingerprint(root, preparationInputs()),
    outputSha256: await fingerprint(root, outputs) };
  const filename = path.join(root, receiptPath);
  await mkdir(path.dirname(filename), { recursive: true });
  await writeFile(filename, `${JSON.stringify(receipt, null, 2)}\n`);
  return receipt;
}

export async function assertPrepared(root, requiredStages) {
  let receipt;
  try {
    receipt = JSON.parse(await readFile(path.join(root, receiptPath), 'utf8'));
    if (receipt.schema !== 'gitlab-workspace-prepared/v1' ||
        requiredStages.some(stage => !receipt.stages.includes(stage)) ||
        receipt.inputs !== await fingerprint(root, preparationInputs()) ||
        receipt.outputSha256 !== await fingerprint(root, receipt.outputs)) throw new Error('stale preparation');
  } catch (error) {
    throw new Error('Prepared build is missing, changed, or incomplete. Run npm run prepare:validation first.', { cause: error });
  }
  return receipt;
}

export function workerCount(value = '2') {
  if (!/^[1-9]\d*$/.test(String(value)) || Number(value) > 16) {
    throw new Error('Validation workers must be an integer from 1 to 16.');
  }
  return Number(value);
}

// A worker owns one process and log at a time. All queued suites finish even if
// another suite fails, so one receipt describes the entire attempted gate.
export async function runPool(jobs, workers, run) {
  const results = new Array(jobs.length);
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(workers, jobs.length) }, async () => {
    while (cursor < jobs.length) {
      const index = cursor++;
      results[index] = await run(jobs[index]);
    }
  }));
  return results;
}

export async function runLogged(job, { cwd, evidenceDir, env = process.env, echo = false }) {
  await mkdir(evidenceDir, { recursive: true });
  const log = path.join(evidenceDir, `${job.id}.log`);
  const output = createWriteStream(log, { flags: 'wx' });
  const started = new Date();
  const tick = performance.now();
  console.log(`[validation] ${job.id} started`);
  output.write(`Command: ${JSON.stringify([job.command, ...job.args])}\n`);
  const result = await new Promise(resolve => {
    const child = spawn(job.command, job.args, { cwd, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    for (const [stream, destination] of [[child.stdout, process.stdout], [child.stderr, process.stderr]]) {
      stream.on('data', data => { output.write(data); if (echo) destination.write(data); });
    }
    let error;
    child.once('error', failure => { error = failure.message; output.write(`${failure.message}\n`); });
    child.once('close', (code, signal) => resolve({ exitCode: code ?? 1, signal, ...(error ? { error } : {}) }));
  });
  await new Promise(resolve => output.end(resolve));
  const record = { id: job.id, command: [job.command, ...job.args], startedAt: started.toISOString(),
    finishedAt: new Date().toISOString(), seconds: Number(((performance.now() - tick) / 1000).toFixed(3)),
    ...result, log };
  console.log(`[validation] ${job.id}: ${record.exitCode === 0 ? 'passed' : 'FAILED'} (${record.seconds}s); ${log}`);
  return record;
}
