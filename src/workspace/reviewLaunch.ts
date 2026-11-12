import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { ReviewLaunchBinding, ReviewLaunchRequest } from './reviewLaunchProtocol';
import { installedReviewerIdentity, type WorkflowKitRunnerBinding } from './reviewSessionProtocol';
import { readReviewJob } from './reviewSessions';

export function reviewRunnerRuntime(nativeRuntime: string): string {
  const root = path.resolve(nativeRuntime);
  return path.join(path.dirname(root), path.basename(root) + '-workflow-kit');
}
export function reviewRunnerWritableRoots(nativeRuntime: string, runner?: WorkflowKitRunnerBinding): string[] {
  return runner ? [reviewRunnerRuntime(nativeRuntime)] : [];
}
async function plainPath(file: string): Promise<void> {
  for (let probe = path.resolve(file);;) {
    try { if ((await lstat(probe)).isSymbolicLink()) throw new Error('審查啟動檔路徑不可使用連結。'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    const parent = path.dirname(probe); if (parent === probe) break; probe = parent;
  }
}

/** Persist the complete argv input outside the native ownership directory, before dispatch. */
export async function saveReviewLaunchRequest(request: ReviewLaunchRequest, action: ReviewLaunchBinding['action'] = 'start', reuseExisting = false): Promise<ReviewLaunchBinding> {
  request = { ...request, binding: installedReviewerIdentity(request.binding) };
  if (!/^[a-f0-9]{32}$/.test(request.request_id) || request.tool !== 'merge-reviewer' || request.binding.tool !== request.tool ||
      ![request.workspace, request.project, request.runtime_root].every(value => path.isAbsolute(value)) ||
      [request.base, request.head].some(value => !value || /[\r\n\0]/.test(value))) throw new Error('審查啟動輸入無效。');
  const directory = path.join(reviewRunnerRuntime(request.runtime_root), 'launch');
  const file = path.join(directory, request.request_id + '.json');
  await plainPath(file);
  await mkdir(directory, { recursive: true });
  let bytes = Buffer.from(JSON.stringify(request), 'utf8');
  try { await writeFile(file, bytes, { flag: 'wx', mode: 0o600 }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    const existing = await readFile(file);
    if (!existing.equals(bytes)) {
      const previous = reuseExisting ? JSON.parse(existing.toString('utf8')) as ReviewLaunchRequest : undefined;
      const identity = (value: ReviewLaunchRequest) => JSON.stringify([value.schema, value.tool, value.request_id, value.workspace,
        value.project, value.base, value.head, value.runtime_root, value.workspace_file, value.draft_format]);
      if (!previous || identity(previous) !== identity(request)) throw new Error('同一 request 的啟動輸入已變更；請保留原紀錄並建立新的審查。', { cause: error });
      if (JSON.stringify(previous.binding) !== JSON.stringify(request.binding)) {
        const job = await readReviewJob(request.runtime_root, request.request_id, request.workspace, [request.project], request.tool);
        if (!['ready', 'reviewing', 'validating', 'published'].includes(job.state) || job.inputs.base !== request.base || job.inputs.head !== request.head ||
            previous.binding.tool !== request.binding.tool || previous.binding.script_path !== request.binding.script_path) throw new Error('舊審查無法安全更新啟動綁定。', { cause: error });
        // Keep the original launch immutable; only a verified existing native job
        // can get a new installed binding, at a new content-addressed path.
        const updated = { ...previous, binding: request.binding };
        const upgradedBytes = Buffer.from(JSON.stringify(updated), 'utf8');
        const upgradedHash = createHash('sha256').update(upgradedBytes).digest('hex');
        const upgradedPath = path.join(directory, request.request_id + '-' + upgradedHash.slice(0, 16) + '.json');
        await plainPath(upgradedPath);
        try { await writeFile(upgradedPath, upgradedBytes, { flag: 'wx', mode: 0o600 }); }
        catch (writeError) { if ((writeError as NodeJS.ErrnoException).code !== 'EEXIST' || !(await readFile(upgradedPath)).equals(upgradedBytes)) throw writeError; }
        return { path: upgradedPath, sha256: upgradedHash, request: updated, action, shell: process.platform === 'win32' ? 'powershell' : 'posix' };
      }
      bytes = existing; request = previous;
    }
  }
  return { path: file, sha256: createHash('sha256').update(bytes).digest('hex'), request, action,
    shell: process.platform === 'win32' ? 'powershell' : 'posix' };
}
