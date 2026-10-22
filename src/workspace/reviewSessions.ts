import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, readdir, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { atomicNetworkJson } from '../api/localNetworkLease';
import type { PythonRuntime } from './pythonRuntime';
import type { ReviewSessionSummary } from './reviewSessionProtocol';

const exec = promisify(execFile);
const REQUEST_ID = /^[a-f0-9]{32}$/;
const STATES = new Set(['running', 'ready', 'reviewing', 'validating', 'published', 'failed', 'cancelled']);
const canonical = (value: string): string => process.platform === 'win32' ? value.toLowerCase() : value;
const samePath = (first: string, second: string): boolean => canonical(path.resolve(first)) === canonical(path.resolve(second));

interface ReviewJob {
  schema: 'MergeReviewSession/v1';
  request_id: string;
  runtime_root: string;
  state: string;
  phase: string;
  updated_at: string;
  inputs: { workspace: string; workspace_file?: string | null; project: string; base: string; head: string };
  report_path?: string;
  error?: string;
  network_activity?: { fetch_attempt_count?: number };
  pack_cache_hits?: number;
}

async function plain(file: string): Promise<void> {
  for (let probe = path.resolve(file);;) {
    try { if ((await lstat(probe)).isSymbolicLink()) throw new Error('審查 runtime 不能使用連結或 Junction。'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    const parent = path.dirname(probe);
    if (parent === probe) return;
    probe = parent;
  }
}
async function json(file: string): Promise<any> {
  await plain(file);
  const info = await lstat(file);
  if (!info.isFile() || info.size > 512 * 1024) throw new Error('審查紀錄格式或大小無效。');
  return JSON.parse(await readFile(file, 'utf8'));
}
async function ownedRuntime(root: string): Promise<boolean> {
  try {
    await plain(root);
    const marker = await json(path.join(root, '.merge-reviewer-runtime.json'));
    if (marker.schema !== 'MergeReviewRuntime/v1' || typeof marker.directory !== 'string' ||
        !samePath(marker.directory, await realpath(root))) throw new Error('審查 runtime 所有權無效。');
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}
export async function readReviewJob(root: string, id: string, workspace: string, repositories: readonly string[]): Promise<ReviewJob> {
  if (!REQUEST_ID.test(id) || !await ownedRuntime(root)) throw new Error('找不到這份本機審查。');
  const job = await json(path.join(root, 'jobs', id + '.json')) as ReviewJob;
  if (job.schema !== 'MergeReviewSession/v1' || job.request_id !== id || !samePath(job.runtime_root, root) ||
      !STATES.has(job.state) || !job.inputs || !samePath(job.inputs.workspace, workspace) ||
      !repositories.some(repo => samePath(repo, job.inputs.project)) ||
      typeof job.updated_at !== 'string' || typeof job.phase !== 'string' ||
      typeof job.inputs.base !== 'string' || typeof job.inputs.head !== 'string') throw new Error('審查紀錄不屬於目前工作區。');
  if (job.report_path && !samePath(path.dirname(job.report_path), path.join(job.inputs.project, 'review-reports'))) throw new Error('審查報告路徑無效。');
  return job;
}
/** A local-only read: never starts capture, Git, API refresh, or directory creation. */
export async function readReviewSessions(root: string, workspace: string, repositories: readonly string[]): Promise<ReviewSessionSummary[]> {
  if (!await ownedRuntime(root)) return [];
  let files: string[];
  try { files = await readdir(path.join(root, 'jobs')); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
  const results: ReviewSessionSummary[] = [];
  for (const name of files.filter(file => REQUEST_ID.test(file.replace(/\.json$/, '')) && file.endsWith('.json')).slice(-1000)) {
    let job: ReviewJob;
    try { job = await readReviewJob(root, name.slice(0, -5), workspace, repositories); }
    catch { continue; } // Another declared workspace may share an explicit runtime.
    results.push({ requestId: job.request_id, repository: path.basename(job.inputs.project), repositoryPath: job.inputs.project,
      base: job.inputs.base, head: job.inputs.head, state: job.state, phase: job.phase, updatedAt: job.updated_at,
      reportPath: job.report_path, error: job.error, fetchCount: job.network_activity?.fetch_attempt_count ?? 0,
      packCacheHits: job.pack_cache_hits ?? 0 });
  }
  return results.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, 100);
}
export async function cancelReviewSession(root: string, id: string, workspace: string, repositories: readonly string[],
  python: PythonRuntime, skillDirectory: string): Promise<void> {
  await readReviewJob(root, id, workspace, repositories);
  const script = path.join(skillDirectory, 'scripts', 'review_session.py');
  await plain(script);
  await exec(python.executable, [...python.args, '-B', script, 'cancel', '--runtime-root', root, '--request-id', id],
    { env: python.env, encoding: 'utf8', windowsHide: true, timeout: 15_000, maxBuffer: 64 * 1024 });
}
/** A known Git write invalidates observations, never restarts an existing review. */
export async function invalidateReviewSync(root: string, commonDirectory: string): Promise<void> {
  if (!await ownedRuntime(root)) return;
  const common = path.resolve(commonDirectory);
  const key = createHash('sha256').update(JSON.stringify(common)).digest('hex');
  const directory = path.join(root, 'invalidations');
  await plain(directory);
  await mkdir(directory, { recursive: true });
  await atomicNetworkJson(path.join(directory, key + '.json'), {
    schema: 'MergeReviewInvalidation/v1', at: new Date().toISOString(), nonce: randomUUID(),
  });
}

/** A read that wins admission just before a push must not stay cached after it. */
export async function withReviewSyncInvalidation<T>(roots: readonly string[], commonDirectory: string,
  operation: () => Promise<T>): Promise<T> {
  const invalidate = async (): Promise<void> => {
    for (const root of new Set(roots)) await invalidateReviewSync(root, commonDirectory);
  };
  await invalidate();
  try { return await operation(); }
  finally { await invalidate(); }
}
