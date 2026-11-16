import path from 'node:path';
import type { CodexBridge } from './bridge';

export interface CodexHistoryDeletionResult {
  deletedTaskIds: string[];
  failures: Array<{ taskId: string; reason: string }>;
  cancelled?: boolean;
}

export interface CodexHistoryDeletionOptions {
  bridge: Pick<CodexBridge, 'initialize' | 'list' | 'deleteHistory' | 'historyDeletion' | 'results'>;
  confirm(message: string, detail: string): Promise<boolean>;
  check(): void;
  beforeDelete?(taskId: string): void;
}

/** One confirmation per request; the Bridge revalidates and locks each task. */
export async function deleteCodexHistories(taskIds: readonly string[], options: CodexHistoryDeletionOptions): Promise<CodexHistoryDeletionResult> {
  const ids = [...new Set(taskIds)];
  if (!ids.length || ids.length > 1000 || ids.some(id => !/^[a-z0-9-]{1,100}$/i.test(id))) throw new Error('刪除紀錄的任務識別無效。');
  options.check();
  await options.bridge.initialize();
  const tasks = new Map(options.bridge.list().map(task => [task.id, task]));
  const result: CodexHistoryDeletionResult = { deletedTaskIds: [], failures: [] };
  const outstanding = ids.filter(id => options.bridge.historyDeletion(id) !== 'deleted');
  if (!outstanding.length) return { ...result, deletedTaskIds: ids };
  const names = outstanding.slice(0, 10).map(id => `• ${tasks.get(id)?.title ?? id}`).join('\n');
  const remaining = outstanding.length > 10 ? `\n另有 ${outstanding.length - 10} 筆紀錄。` : '';
  const detail = `${names}${remaining}\n\n刪除此擴充功能的任務與對話紀錄、草稿及所屬暫存，無法復原。\n保留專案程式碼、成果包及已匯出的檔案；外部或共用的 Codex 對話不會刪除。\n成果包位置：${path.resolve(options.bridge.results.directory)}`;
  if (!await options.confirm(`刪除 ${outstanding.length} 筆執行紀錄？`, detail)) return { ...result, cancelled: true };
  for (const id of ids) {
    try {
      options.check();
      options.beforeDelete?.(id);
      await options.bridge.deleteHistory(id);
      result.deletedTaskIds.push(id);
    } catch (error) {
      result.failures.push({ taskId: id, reason: error instanceof Error ? error.message : '刪除紀錄未完成，請重試。' });
    }
  }
  return result;
}
