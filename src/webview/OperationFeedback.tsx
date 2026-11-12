/** @jsxImportSource preact */
import { useContext, useEffect } from 'preact/hooks';
import { ActionController } from '../workspace/actionController';
import { isActiveOperation, type WorkspaceOperationState } from '../workspace/operations';
import { ActionContext, useActionSelector } from './useActions';
import { TransportStatus } from './DataStatus';
import { FeatureNotice } from './FeatureNotice';

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
export function OperationFeedback({ resourceKey, scopeRevision, initialOperations = emptyOperations, actions: supplied, onRefresh, excludeResources = [], excludePrefixes = [], includeUnknown = !resourceKey, displayedError, errorClass = '', onDismiss }: {
  resourceKey?: string; scopeRevision?: string; initialOperations?: WorkspaceOperationState[]; actions?: ActionController; onRefresh?: () => unknown;
  excludeResources?: readonly string[]; excludePrefixes?: readonly string[];
  includeUnknown?: boolean;
  displayedError?: string;
  errorClass?: string;
  onDismiss?: (operation: WorkspaceOperationState) => void;
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
    if ((scopeRevision && operation.scopeRevision !== scopeRevision && (resourceKey || operation.effect !== 'unknown')) || (resourceKey && operation.resourceKey !== resourceKey)) continue;
    if (resourceKey && !scopeRevision && shared && !actions.isCurrentContext(operation)) continue;
    if (operation.effect === 'unknown' && !includeUnknown) continue;
    if (operation.effect !== 'unknown' && (excludeResources.includes(operation.resourceKey) || excludePrefixes.some(prefix => operation.resourceKey.startsWith(prefix)))) continue;
    latest.set(operation.action + ':' + (operation.lockKey ?? operation.resourceKey), operation);
  }
  const visible = [...latest.values()].filter(item => isActiveOperation(item) || item.effect === 'unknown' || item.status === 'failed' || item.refreshError)
    .sort(recentFeedbackFirst).slice(0, 3);
  const announcement = visible.map(item => [item.label, item.phase,
    item.effect === 'unknown' ? '寫入結果待核對' : item.refreshError ? '操作已完成，更新失敗' : item.error?.split(/\r?\n/, 1)[0],
    item.total && item.completed !== undefined ? `${Math.min(100, Math.floor(item.completed / item.total * 10) * 10)}%` : undefined]
    .filter(Boolean).join('，')).join('。');
  return <div class="operation-feedback"><span class="operation-announcement" role="status" aria-live="polite" aria-atomic="true">{announcement}</span>{visible.map(item => <div key={item.requestId}
    class={`operation-status ${item.status}${item.error || item.refreshError ? ' ' + errorClass : ''}`}>
    {isActiveOperation(item) && <span class="spinner" aria-hidden="true" />}
    <strong>{item.label}</strong>{item.error && item.error === displayedError && !item.refreshError ? <span>{item.phase}</span> : item.refreshError || item.error ? <FeatureNotice
      announce={false} tone={item.effect === 'unknown' || item.effect === 'applied' || item.effect === 'partial' ? 'warning' : 'error'}
      reason={item.refreshError ? `操作已完成，但更新失敗：${item.refreshError.split(/\r?\n/, 1)[0].slice(0, 180)}`
        : `${item.effect === 'partial' ? '部分操作已完成：' : ''}${item.error!.split(/\r?\n/, 1)[0].slice(0, 180)}`}
      details={/\r|\n/.test(item.refreshError ?? item.error ?? '') || (item.refreshError ?? item.error ?? '').length > 180 ? item.refreshError ?? item.error : undefined} /> : <span>{item.phase}</span>}
    {isActiveOperation(item) && <TransportStatus status={item} service={item.resourceKey.startsWith('git:') ? 'git' : 'api'} />}
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
      {!isActiveOperation(item) && <button class="quiet small" type="button" onClick={() => { onDismiss?.(item); actions.dismiss(item.requestId); }}>關閉</button>}
    </>}
  </div>)}</div>;
}
