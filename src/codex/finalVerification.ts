import type { CodexOutputItem } from './protocol';
import type { ValidationAttempt } from './workContextProtocol';
import { matchesNativeCommand } from './nativeCommand';
import { sameWorkflowPath } from './projectWorkflows';

/** Only a native, completed check failure can request another local repair cycle. */
export class FinalVerificationError extends Error {
  constructor(message: string, readonly retryable: boolean, readonly state: ValidationAttempt['state']) { super(message); }
}

export function collectFinalVerification(commands: readonly string[], items: readonly CodexOutputItem[], cwd: string,
  turnId: string, completed: boolean): Pick<ValidationAttempt, 'state' | 'reason' | 'commands'> {
  const native = items.filter(item => item.kind === 'command' && item.turnId === turnId && item.final && item.cwd && sameWorkflowPath(item.cwd, cwd));
  const matched = commands.map(command => native.filter(item => matchesNativeCommand(item.command ?? '', command)).at(-1));
  const evidence = commands.map((command, index) => {
    const item = matched[index];
    return { command, ...(item ? { cwd: item.cwd, itemId: item.id, exitCode: item.exitCode,
      startedAtMs: item.startedAtMs, completedAtMs: item.completedAtMs } : {}) };
  });
  if (!completed) return { state: 'interrupted', reason: '最後驗證未正常完成，已保留執行紀錄。', commands: evidence };
  if (!commands.length || matched.some(item => !item || item.exitCode === undefined)) return {
    state: 'incomplete', reason: '最後驗證缺少已核定命令的完整原生執行證據。', commands: evidence };
  const failures = matched.filter(item => item!.exitCode !== 0) as CodexOutputItem[];
  if (failures.some(item => [126, 127, 9009].includes(item.exitCode!) || /command not found|not recognized|找不到.*(?:命令|模組)|cannot find module|module(?:notfounderror| not found)|no module named|permission denied|access is denied|拒絕存取|ENOENT|ENOTFOUND|ECONNREFUSED|network is unreachable/i.test(item.text))) {
    return { state: 'blocked', reason: '驗證環境、依賴、權限或連線不足；請處理後手動接續。', commands: evidence };
  }
  if (failures.some(item => [130, 137, 143].includes(item.exitCode!))) return {
    state: 'interrupted', reason: '驗證命令遭中斷，請核對執行環境後接續。', commands: evidence };
  if (failures.length) return { state: 'failed', reason: '已核定檢查失敗，保留修改與原生失敗證據。', commands: evidence };
  return { state: 'passed', commands: evidence };
}

export function unchangedVerificationFailure(previous: ValidationAttempt | undefined, current: ValidationAttempt): boolean {
  return !!current.artifactDigest && previous?.state === 'failed' && current.state === 'failed' && previous.artifactDigest === current.artifactDigest &&
    previous.profileDigest === current.profileDigest && previous.requirementDigest === current.requirementDigest &&
    JSON.stringify(previous.commands.map(item => [item.command, item.exitCode])) === JSON.stringify(current.commands.map(item => [item.command, item.exitCode]));
}
