import { currentOperationLog, type OperationLog } from '../logging/operationLog';
import { randomUUID } from 'node:crypto';
import type { LogContext } from '../logging/logProtocol';
import { isGitNetworkCommand } from './gitProcess';

interface GitCommandLogOptions<T> {
  context?: LogContext;
  outcome?: (value: T) => { result: 'success' | 'error'; exitCode: number };
}

function failureExitCode(error: unknown, depth = 0): number {
  if (!error || typeof error !== 'object' || depth > 3) return -1;
  if ('exitCode' in error && typeof error.exitCode === 'number') return error.exitCode;
  if ('code' in error && typeof error.code === 'number') return error.code;
  return 'cause' in error ? failureExitCode(error.cause, depth + 1) : -1;
}

/** Keep command arguments, environments and command output out of the native log channel. */
export async function logGitCommand<T>(args: readonly string[], repositoryPath: string | undefined,
  task: () => Promise<T>, log: OperationLog | undefined = currentOperationLog(), options: GitCommandLogOptions<T> = {}): Promise<T> {
  if (!log) return task();
  let action = 'git';
  for (let index = 0; index < args.length; index++) {
    if (['-C', '-c', '--git-dir', '--work-tree', '--namespace'].includes(args[index])) { index++; continue; }
    if (!args[index].startsWith('-')) { action = args[index]; break; }
  }
  return log.withContext({ ...options.context, repositoryPath, commandId: randomUUID(), network: isGitNetworkCommand(args) }, async () => {
    const started = Date.now();
    log.record({ feature: 'git', action, result: 'started' });
    try {
      const result = await task();
      const code = result && typeof result === 'object' && 'code' in result && typeof result.code === 'number' ? result.code : 0;
      const outcome = options.outcome?.(result) ?? { result: code === 0 ? 'success' : 'error', exitCode: code };
      log.record({ feature: 'git', action, ...outcome, durationMs: Date.now() - started });
      return result;
    } catch (error) {
      const cancelled = error instanceof Error && error.name === 'AbortError';
      log.record({ feature: 'git', action, result: cancelled ? 'cancelled' : 'error',
        exitCode: failureExitCode(error), durationMs: Date.now() - started,
        message: 'Git command did not complete.' });
      throw error;
    }
  });
}
