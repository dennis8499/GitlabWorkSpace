import { useEffect, useRef, useState } from 'preact/hooks';
import { ActionController } from '../workspace/actionController';
import type { WorkspaceOperationState } from '../workspace/operations';

/** Each webview owns a controller; embedded panels use their workspace's controller. */
export function useDomainActions(
  shared: ActionController | undefined,
  send: (request: any) => void,
  scopeRevision: string,
  matches: (operation: WorkspaceOperationState) => boolean = () => true
): ActionController {
  const sender = useRef(send);
  sender.current = send;
  const filter = useRef(matches);
  filter.current = matches;
  const local = useRef<ActionController>();
  if (!local.current) {
    local.current = new ActionController(request => sender.current(request));
    local.current.setContext({ scopeRevision });
  }
  const actions = shared ?? local.current;
  const [, changed] = useState(0);
  useEffect(() => {
    const signature = () => JSON.stringify(actions.getSnapshot().filter(operation => filter.current(operation)).map(operation => [operation.requestId, operation.scopeRevision,
      operation.resourceKey, operation.kind, operation.status, operation.effect, operation.error, operation.refreshError]));
    let previous = signature();
    return actions.subscribe(() => {
      const next = signature();
      if (next === previous) return;
      previous = next; changed(value => value + 1);
    });
  }, [actions]);
  useEffect(() => {
    if (shared) return;
    actions.setContext({ scopeRevision });
    const receive = (event: MessageEvent) => {
      const message = event.data;
      if (message?.type === 'operationChanged') actions.receive(message.operation as WorkspaceOperationState);
      else if (message?.type === 'operationsSnapshot') actions.reconcile(message.snapshot);
      else if (message?.type === 'snapshot' && message.snapshot?.operationSnapshot) actions.reconcile(message.snapshot.operationSnapshot);
    };
    window.addEventListener('message', receive);
    return () => window.removeEventListener('message', receive);
  }, [actions, shared, scopeRevision]);
  return actions;
}

export function finishDomainAction(actions: ActionController, requestId: string, outcome: {
  status?: 'succeeded' | 'failed' | 'cancelled'; error?: string; phase?: string;
  effect?: 'none' | 'applied' | 'partial' | 'unknown'; refreshError?: string;
} = {}): void {
  const operation = actions.findByCorrelation(requestId);
  if (operation) actions.complete(operation.requestId, outcome);
}
