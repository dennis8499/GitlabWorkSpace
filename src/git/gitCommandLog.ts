import { currentOperationLog, type OperationLog } from '../logging/operationLog';

/** Keep command arguments, environments and command output out of the durable log. */
export async function logGitCommand<T>(args: readonly string[], repositoryPath: string | undefined,
  task: () => Promise<T>, log: OperationLog | undefined = currentOperationLog()): Promise<T> {
  if (!log) return task();
  let action = 'git';
  for (let index = 0; index < args.length; index++) {
    if (['-C', '-c', '--git-dir', '--work-tree', '--namespace'].includes(args[index])) { index++; continue; }
    if (!args[index].startsWith('-')) { action = args[index]; break; }
  }
  return log.run('git', action, { repositoryPath }, async () => {
    const started = Date.now();
    try {
      const result = await task();
      log.record({ feature: 'git', action, repositoryPath, result: 'success', exitCode: 0, durationMs: Date.now() - started });
      return result;
    } catch (error) {
      const cancelled = error instanceof Error && error.name === 'AbortError';
      const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
      log.record({ feature: 'git', action, repositoryPath, result: cancelled ? 'cancelled' : 'error',
        exitCode: typeof code === 'number' ? code : -1, durationMs: Date.now() - started });
      throw error;
    }
  });
}
