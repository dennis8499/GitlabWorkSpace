import type { NotificationSnapshot } from './notificationProtocol';

/** Explicit native actions still need a visible failure surface when the Webview is closed. */
export async function withNativeCommandFeedback<T>(run: () => Promise<T>, options: {
  operationId: string;
  snapshot: () => NotificationSnapshot;
  workbenchVisible: () => boolean;
  show: (level: 'warn' | 'error', message: string, action?: string) => Thenable<string | undefined>;
  openMessages: () => Promise<void>;
  openTarget?: (id: string) => Promise<void>;
}): Promise<T> {
  const result = await run();
  if (options.workbenchVisible()) return result;
  const notice = options.snapshot().items.find(item => item.operationId === options.operationId && (item.level === 'error' || item.level === 'warn'));
  if (!notice || notice.level === 'info') return result;
  // NotificationCenter has already sanitized these summaries. No request bodies are forwarded.
  const message = notice.messages.at(-1) ?? notice.title;
  const action = options.openTarget && notice.target ? notice.target.kind === 'task' ? '開啟任務' : notice.target.kind === 'tools' ? '修復環境' : notice.target.kind === 'issue' ? '返回 Issue' : notice.target.kind === 'mergeRequest' ? '開啟 MR' : '查看 Log' : undefined;
  void Promise.resolve(options.show(notice.level, message, action)).then(choice => {
    if (action && choice === action) return options.openTarget?.(notice.id);
    if (choice === '開啟訊息中心') return options.openMessages();
  }).catch(() => undefined);
  return result;
}
