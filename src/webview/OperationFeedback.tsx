/** @jsxImportSource preact */
import { useContext, useEffect } from 'preact/hooks';
import { ActionController } from '../workspace/actionController';
import { isActiveOperation, type WorkspaceOperationState } from '../workspace/operations';
import { ActionContext, useActionSelector } from './useActions';

const fallback = new ActionController(() => {});
const emptyOperations: WorkspaceOperationState[] = [];
const feedbackPriority = (operation: WorkspaceOperationState): number => operation.effect === 'unknown' ? 2 : isActiveOperation(operation) ? 1 : 0;
function recentFeedbackFirst(left: WorkspaceOperationState, right: WorkspaceOperationState): number {
  const priority = feedbackPriority(right) - feedbackPriority(left);
  if (priority) return priority;
  // Host revisions order progress updates; completion time orders legacy receipts.
  const revision = left.hostSessionId === right.hostSessionId && left.revision !== undefined && right.revision !== undefined
    ? right.revision - left.revision : 0;
  return revision || (right.finishedAt ?? right.startedAt) - (left.finishedAt ?? left.startedAt)
    || right.requestId.localeCompare(left.requestId);
}
export function OperationFeedback({ resourceKey, scopeRevision, initialOperations = emptyOperations, actions: supplied, onRefresh }: {
  resourceKey?: string; scopeRevision?: string; initialOperations?: WorkspaceOperationState[]; actions?: ActionController; onRefresh?: () => unknown;
}) {
  const context = useContext(ActionContext);
  const shared = supplied ?? context;
  const actions = shared ?? fallback;
  const operations = useActionSelector(actions, states => states);
  useEffect(() => {
    // The workspace owns its replica. Only the standalone fallback hydrates
    // legacy initial data; replaying workspace props can lag newer receipts.
    if (shared) return;
    for (const operation of initialOperations) actions.receive(operation);
  }, [actions, shared, initialOperations]);
  useEffect(() => {
    const receive = (event: Event) => actions.receive((event as CustomEvent<WorkspaceOperationState>).detail);
    window.addEventListener('workspaceOperationChanged', receive);
    return () => window.removeEventListener('workspaceOperationChanged', receive);
  }, [actions]);
  const latest = new Map<string, WorkspaceOperationState>();
  for (const operation of operations) {
    if ((scopeRevision && operation.scopeRevision !== scopeRevision && operation.effect !== 'unknown') || (resourceKey && operation.resourceKey !== resourceKey)) continue;
    latest.set(operation.action + ':' + (operation.lockKey ?? operation.resourceKey), operation);
  }
  const visible = [...latest.values()].filter(item => isActiveOperation(item) || item.effect === 'unknown' || item.status === 'failed' || item.refreshError)
    .sort(recentFeedbackFirst).slice(0, 3);
  return <div class="operation-feedback" aria-live="polite">{visible.map(item => <div key={item.requestId}
    class={`operation-status ${item.status}`} role={item.status === 'failed' || item.refreshError ? 'alert' : 'status'}>
    {isActiveOperation(item) && <span class="spinner" />}
    <strong>{item.label}</strong><span>{item.refreshError ? `已更新，重新載入失敗：${item.refreshError}` : item.error ?? item.phase}</span>
    {item.total !== undefined && item.completed !== undefined && <span>{item.completed}／{item.total}</span>}
    {item.effect === 'unknown' ? <button class="quiet small" type="button" onClick={() => {
      const match = /^mr:(\d+):(\d+)$/.exec(item.resourceKey);
      actions.dispatch(match && actions.isCurrentContext(item) ? { type: 'reconcileMergeRequestWrite', projectId: Number(match[1]), iid: Number(match[2]) } : { type: 'confirmOperationResult', targetOperationId: item.requestId,
        recovery: { requestId: item.requestId, resourceKey: item.resourceKey, action: item.action, label: item.label,
          correlationId: item.correlationId, lockKey: item.lockKey, kind: item.kind } });
    }}>核對寫入結果</button> : <>
      {item.retryable && item.status === 'failed' && <button class="quiet small" type="button" onClick={() => {
        const result = actions.retry(item.requestId);
        if (result.status === 'blocked') actions.dispatch({ type: 'publishNotification', level: 'warn',
          message: result.reason ?? '無法重試，請回到原操作畫面重新載入。' });
      }}>重試</button>}
      {item.refreshError && <button class="quiet small" type="button" onClick={() => onRefresh ? onRefresh() : actions.dispatch({ type: 'refresh' })}>重新載入</button>}
      {!isActiveOperation(item) && <button class="quiet small" type="button" onClick={() => actions.dismiss(item.requestId)}>關閉</button>}
    </>}
  </div>)}</div>;
}
