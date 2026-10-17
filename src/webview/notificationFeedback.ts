import type { ActionController, DispatchResult } from '../workspace/actionController';
import type { NotificationRequest } from '../notifications/notificationProtocol';

type FeedbackContext = { operationScope?: string; hostSessionId?: string; scopeEpoch?: number };
export type PublishFeedbackRequest = Extract<NotificationRequest, { type: 'publishNotification' }> & FeedbackContext;
type Publisher = (request: PublishFeedbackRequest) => unknown;

/** Only local feedback belongs here; Host result receipts already enter the center. */
export function reportLocalFeedback(publish: Publisher, message: string, options: {
  level?: 'info' | 'warn' | 'error'; title?: string; operationId?: string;
  onInline?: (message: string) => void; context?: FeedbackContext;
} = {}): void {
  if (!message.trim()) return;
  options.onInline?.(message);
  try {
    publish({ type: 'publishNotification', level: options.level ?? 'warn', message,
      ...(options.title ? { title: options.title } : {}),
      ...(options.operationId ? { operationId: options.operationId } : {}), ...options.context });
  } catch { /* A broken bridge must not replace the original local feedback. */ }
}

export function dispatchWithFeedback(actions: Pick<ActionController, 'dispatch'>,
  request: { type: string; [key: string]: any }, options: {
    publish?: Publisher; title?: string; fallbackMessage?: string;
    onBlocked?: (message: string) => void; context?: FeedbackContext;
  } = {}): DispatchResult {
  const result = actions.dispatch(request);
  if (result.status === 'blocked' && request.type !== 'publishNotification') {
    reportLocalFeedback(options.publish ?? (notice => actions.dispatch(notice)),
      result.reason ?? options.fallbackMessage ?? '另一個操作正在處理，請稍後再試。',
      { title: options.title, operationId: result.operationId, onInline: options.onBlocked, context: options.context });
  }
  return result;
}
