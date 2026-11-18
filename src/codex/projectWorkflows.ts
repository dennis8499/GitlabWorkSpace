import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import { captureGitProcess } from '../git/gitProcess';

const workflowContext = new AsyncLocalStorage<{ signal?: AbortSignal; networkEnvironment?: NodeJS.ProcessEnv; assertCurrent?(): void }>();
export function withWorkflowExecution<T>(context: { signal?: AbortSignal; networkEnvironment?: NodeJS.ProcessEnv; assertCurrent?(): void }, task: () => Promise<T>): Promise<T> {
  return workflowContext.run(context, task);
}
export const workflowHash = (value: string): string => createHash('sha256').update(value).digest('hex');

export async function workflowGit(root: string, args: string[], timeout = 20_000): Promise<string> {
  const context = workflowContext.getStore(); context?.assertCurrent?.();
  const result = await captureGitProcess('git', ['-c', 'core.hooksPath=/dev/null', ...args], { cwd: root, signal: context?.signal, timeoutMs: timeout, maxStdoutBytes: 8 * 1024 * 1024,
    env: { ...(args[0] === 'fetch' ? context?.networkEnvironment ?? process.env : process.env), GIT_NO_REPLACE_OBJECTS: '1', GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', LC_ALL: 'C', LANG: 'C' } })
    .catch(error => { if (/process.tree|quarantin|execution receipt/i.test((error as Error).message)) Object.assign(error, { workflowCleanupUncertain: true }); throw error; });
  context?.assertCurrent?.();
  if (result.code !== 0) throw new Error(`Git ${args[0]} 未完成（exit ${result.code}），請核對 Repo、分支及 Git 登入狀態。`);
  return result.stdout;
}

/** Already-present objects never trigger a network request, including on resume. */
export async function ensureLocalCommit(root: string, sha: string,
  source?: string | { remote?: string; ref?: string; signal?: AbortSignal }, fetchRef?: string): Promise<void> {
  if (source && typeof source === 'object' && source.signal) {
    const { signal, ...options } = source;
    return withWorkflowExecution({ ...workflowContext.getStore(), signal }, () => ensureLocalCommit(root, sha, options));
  }
  const remote = typeof source === 'string' ? source : source?.remote;
  fetchRef ??= typeof source === 'object' ? source.ref : undefined;
  if (!/^[a-f0-9]{40,64}$/i.test(sha)) throw new Error('來源 SHA 無效。');
  const exists = async () => {
    try { return (await workflowGit(root, ['rev-parse', '--verify', `${sha}^{commit}`])).trim() === sha; }
    catch (error) { if (error && typeof error === 'object' && 'workflowCleanupUncertain' in error) throw error; return false; }
  };
  if (await exists()) return;
  if (!remote || !/^[a-zA-Z0-9][a-zA-Z0-9._/-]*$/.test(remote)) throw new Error('本機缺少固定來源版本；請同步所需 Repo 後重試。');
  if (fetchRef && !/^[a-f0-9]{40,64}$/i.test(fetchRef)) await workflowGit(root, ['check-ref-format', fetchRef]);
  await workflowGit(root, ['fetch', '--no-tags', remote, fetchRef ?? sha], 90_000);
  if (!await exists()) throw new Error('同步後仍找不到固定來源版本；請保留原任務並核對來源。');
}
