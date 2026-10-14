/** @jsxImportSource preact */
import { useEffect, useState } from 'preact/hooks';
import type { WorkspaceOperationState } from '../workspace/operations';
const emptyOperations: WorkspaceOperationState[] = [];

export function OperationFeedback({ resourceKey, scopeRevision, initialOperations = emptyOperations }: {
  resourceKey?: string; scopeRevision?: string; initialOperations?: WorkspaceOperationState[];
}) {
  const [operations, setOperations] = useState<WorkspaceOperationState[]>([]);
  useEffect(() => {
    setOperations([]);
    const receive = (event: Event) => {
      const operation = (event as CustomEvent<WorkspaceOperationState>).detail;
      if (scopeRevision && operation.scopeRevision !== scopeRevision) return;
      setOperations(current => [...current.filter(item => item.requestId !== operation.requestId), operation].slice(-20));
    };
    window.addEventListener('workspaceOperationChanged', receive);
    return () => window.removeEventListener('workspaceOperationChanged', receive);
  }, [scopeRevision]);
  useEffect(() => {
    setOperations(current => {
      const values = new Map(current.filter(item => !scopeRevision || item.scopeRevision === scopeRevision).map(item => [item.requestId, item]));
      for (const item of initialOperations) {
        if (scopeRevision && item.scopeRevision !== scopeRevision) continue;
        const previous = values.get(item.requestId);
        if (!previous?.finishedAt || item.finishedAt) values.set(item.requestId, item);
      }
      const next = [...values.values()].slice(-20);
      return next.length === current.length && next.every((item, index) => item === current[index]) ? current : next;
    });
  }, [scopeRevision, initialOperations]);
  const visible = operations.filter(item => !resourceKey || item.resourceKey === resourceKey).slice(-3);
  return <div class="operation-feedback" aria-live="polite">{visible.map(item => <div key={item.requestId}
    class={`operation-status ${item.status}`} role={item.status === 'failed' ? 'alert' : 'status'}>
    {(item.status === 'running' || item.status === 'queued') && <span class="spinner" />}
    <strong>{item.label}</strong><span>{item.error ?? item.phase}</span>
    {item.total !== undefined && item.completed !== undefined && <span>{item.completed}／{item.total}</span>}
  </div>)}</div>;
}
