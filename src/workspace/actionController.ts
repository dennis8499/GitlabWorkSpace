import { describeAction, effectiveOperationScope, writeResourceLock, type ActionContext } from './actionPolicy';
import { isActiveOperation, operationConcurrencyKey, type OperationOutcome, type OperationSnapshot, type WorkspaceOperationState } from './operations';

export interface DispatchResult { status: 'started' | 'joined' | 'blocked'; operationId?: string; correlationId?: string; reason?: string; }
export type RestorableOperation = Pick<WorkspaceOperationState, 'requestId' | 'resourceKey' | 'action' | 'label'> & Partial<Pick<WorkspaceOperationState, 'correlationId' | 'scopeRevision' | 'lockKey'>>;
let sequence = 0;
const pending = (operation: WorkspaceOperationState): boolean => isActiveOperation(operation) || operation.effect === 'unknown';
const operationOrder = (left: WorkspaceOperationState, right: WorkspaceOperationState): number => left.startedAt - right.startedAt
  || (left.revision ?? -1) - (right.revision ?? -1) || left.requestId.localeCompare(right.requestId);
const historyOrder = (left: WorkspaceOperationState, right: WorkspaceOperationState): number => (left.finishedAt ?? left.startedAt) - (right.finishedAt ?? right.startedAt)
  || operationOrder(left, right);

// Only a one-way intent digest is retained. Raw bodies (including login tokens)
// are never stored in operation state or serialized with drafts.
function intentDigest(request: unknown): string {
  const omitted = new Set(['operationId', 'operationScope', 'hostSessionId', 'scopeEpoch', 'requestId', 'projectRevision']);
  const text = JSON.stringify(request, (key, value) => {
    if (omitted.has(key)) return undefined;
    if (value && typeof value === 'object' && !Array.isArray(value)) return Object.fromEntries(Object.keys(value).sort().map(name => [name, value[name]]));
    return value;
  });
  let hash = 2166136261;
  for (let index = 0; index < text.length; index++) hash = Math.imul(hash ^ text.charCodeAt(index), 16777619);
  return `${text.length}:${hash >>> 0}`;
}

/** A surface-local replica of the host lifecycle; domain data stays in its cache. */
export class ActionController {
  private context: ActionContext = { scopeRevision: 'offline:none' };
  private sessionId?: string;
  private watermark = -1;
  private readonly retiredSessions = new Set<string>();
  private readonly states = new Map<string, WorkspaceOperationState>();
  private readonly owners = new Map<string, string>();
  private readonly intents = new Map<string, string>();
  private readonly superseded = new Set<string>();
  private readonly retries = new Map<string, () => DispatchResult>();
  private readonly listeners = new Set<() => void>();
  private readonly acknowledgementTimers = new Map<string, ReturnType<typeof setTimeout>>();
  // Keep terminal identity after its visible history row has been removed.
  private readonly terminalTombstones = new Map<string, number | undefined>();
  private batchDepth = 0;
  private statesDirty = false;
  private forceNextEmit = false;
  private snapshot: readonly WorkspaceOperationState[] = [];
  constructor(private readonly send: (request: any) => void) {}
  dispose(): void { for (const timer of this.acknowledgementTimers.values()) clearTimeout(timer); this.acknowledgementTimers.clear(); this.listeners.clear(); }
  subscribe(listener: () => void): () => void { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  getSnapshot(): readonly WorkspaceOperationState[] { return this.snapshot; }
  get(id: string): WorkspaceOperationState | undefined { return this.states.get(id); }
  restorePending(input: RestorableOperation): WorkspaceOperationState {
    const existing = this.get(input.requestId) ?? (input.correlationId ? this.findByCorrelation(input.correlationId) : undefined);
    if (existing) return existing;
    const state: WorkspaceOperationState = { ...input, scopeRevision: input.scopeRevision ?? effectiveOperationScope(input.action, this.context) ?? 'offline:none',
      lockKey: input.lockKey ?? writeResourceLock(input.resourceKey, this.context), kind: 'write', concurrency: 'exclusive',
      retryable: false, notify: true, status: 'queued', phase: '正在核對先前操作…', startedAt: Date.now() };
    this.states.set(state.requestId, state); this.statesDirty = true;
    this.owners.set(operationConcurrencyKey(state), state.requestId); this.emit();
    return state;
  }
  private isCurrentScope(scopeRevision: string): boolean {
    return scopeRevision === this.context.scopeRevision || scopeRevision === this.context.localOperationScope;
  }
  isCurrentContext(operation: WorkspaceOperationState): boolean { return this.isCurrentScope(operation.scopeRevision) && (!operation.hostSessionId || operation.hostSessionId === this.sessionId); }
  isResourceOperation(operation: WorkspaceOperationState, resourceKey: string): boolean {
    return operation.resourceKey === resourceKey && (operation.lockKey ? operation.lockKey === writeResourceLock(resourceKey, this.context) : this.isCurrentScope(operation.scopeRevision));
  }
  hasPendingWrite(resourceKey: string): boolean { return this.snapshot.some(state => state.kind === 'write' && this.isResourceOperation(state, resourceKey) && pending(state)); }
  findByCorrelation(requestId: string): WorkspaceOperationState | undefined {
    return [...this.states.values()].reverse().find(state => state.correlationId === requestId || state.requestId === requestId);
  }
  isPending(resourceKey?: string): boolean {
    return this.snapshot.some(state => this.isCurrentScope(state.scopeRevision) && (!resourceKey || state.resourceKey === resourceKey) && pending(state));
  }
  setContext(context: ActionContext): void {
    const next = { ...this.context, ...context };
    const changed = next.scopeRevision !== this.context.scopeRevision || next.localOperationScope !== this.context.localOperationScope;
    this.context = next;
    if (changed) {
      for (const state of this.states.values()) if (state.kind !== 'write' && isActiveOperation(state) && !this.isCurrentScope(state.scopeRevision)) {
        this.superseded.add(state.requestId);
        this.finish(state, { status: 'cancelled', phase: '已切換操作範圍' });
      }
      this.emit(true);
    }
  }
  dispatch(request: { type: string; [key: string]: any }): DispatchResult {
    const policy = describeAction(request, this.context);
    if (policy.kind === 'control' || policy.kind === 'local') {
      try {
        this.send(request.type === 'reconcileOperations' ? { ...request, pendingIds: request.pendingIds ?? this.snapshot.filter(pending).map(state => state.requestId).slice(0, 200) } : request);
        return { status: 'started' };
      }
      catch (error) { return { status: 'blocked', reason: error instanceof Error ? error.message : String(error) }; }
    }
    const intent = intentDigest(request);
    const ownerId = this.owners.get(policy.lockKey);
    const owner = ownerId && this.states.get(ownerId);
    if (owner && pending(owner)) {
      if (this.intents.get(owner.requestId) === intent && owner.effect !== 'unknown') return { status: 'joined', operationId: owner.requestId, correlationId: owner.correlationId };
      if (policy.concurrency === 'exclusive' || owner.effect === 'unknown') return { status: 'blocked', reason: owner.effect === 'unknown' ? '上次操作結果待確認，請先重新核對。' : '同一項資源已有作業正在處理，請等候完成。' };
      if (policy.concurrency === 'latest') {
        this.superseded.add(owner.requestId);
        this.finish(owner, { status: 'cancelled', phase: '已改選其他項目' });
      }
    }
    const operationId = request.operationId ?? `ui-${Date.now()}-${++sequence}-${Math.random().toString(36).slice(2, 8)}`;
    const nested = request.type === 'issueRequest' ? request.request : undefined;
    const confirmationTarget = request.type === 'confirmOperationResult' && typeof request.targetOperationId === 'string'
      ? this.states.get(request.targetOperationId) : undefined;
    const state: WorkspaceOperationState = {
      ...policy, requestId: operationId, scopeRevision: effectiveOperationScope(confirmationTarget?.action ?? request, this.context) ?? 'offline:none',
      correlationId: nested?.requestId ?? request.requestId,
      phase: '正在準備…', status: 'queued', startedAt: Date.now()
    };
    this.states.set(operationId, state); this.statesDirty = true; this.intents.set(operationId, intent);
    if (policy.retryable) this.retries.set(operationId, () => this.dispatch({ ...request, operationId: undefined }));
    this.owners.set(policy.lockKey, operationId); this.emit();
    try {
      this.send({ ...request, operationId, operationScope: state.scopeRevision,
        ...(this.sessionId ?? this.context.hostSessionId ? { hostSessionId: this.sessionId ?? this.context.hostSessionId } : {}),
        ...(this.context.scopeEpoch !== undefined ? { scopeEpoch: this.context.scopeEpoch } : {}) });
      if (isActiveOperation(this.states.get(operationId)!)) {
        const timer = setTimeout(() => {
          this.acknowledgementTimers.delete(operationId);
          const current = this.states.get(operationId);
          if (current && isActiveOperation(current) && current.revision === undefined) this.dispatch({ type: 'reconcileOperations' });
        }, 5000);
        (timer as unknown as { unref?: () => void }).unref?.();
        this.acknowledgementTimers.set(operationId, timer);
      }
      return { status: 'started', operationId, correlationId: state.correlationId };
    } catch (error) {
      this.complete(operationId, { status: 'failed', effect: 'none', error: error instanceof Error ? error.message : String(error) });
      return { status: 'blocked', operationId, reason: this.states.get(operationId)?.error };
    }
  }
  complete(operationId: string, outcome: OperationOutcome = {}): void {
    const state = this.states.get(operationId);
    if (!state || !pending(state)) return;
    this.finish(state, outcome); this.emit();
  }
  retry(operationId: string): DispatchResult {
    const state = this.states.get(operationId);
    if (!state?.retryable || pending(state) || !this.isCurrentScope(state.scopeRevision)) return { status: 'blocked', reason: '請先確認目前操作範圍與結果。' };
    return this.retries.get(operationId)?.() ?? { status: 'blocked', reason: '請從原操作位置重新載入。' };
  }
  setRetryHandler(operationId: string, handler: () => DispatchResult): void {
    const state = this.states.get(operationId);
    if (state?.kind === 'read' && state.retryable && this.retries.has(operationId)) this.retries.set(operationId, handler);
  }
  dismiss(operationId: string): void {
    const state = this.states.get(operationId);
    if (state && !pending(state)) {
      this.rememberTerminal(state); this.states.delete(operationId); this.statesDirty = true;
      this.retries.delete(operationId); this.emit();
    }
  }
  private finish(state: WorkspaceOperationState, outcome: OperationOutcome): void {
    this.clearAcknowledgement(state.requestId);
    outcome = Object.fromEntries(Object.entries(outcome).filter(([, value]) => value !== undefined)) as OperationOutcome;
    const next = { ...state, ...outcome, status: outcome.status ?? (outcome.error ? 'failed' : 'succeeded'),
      phase: outcome.phase ?? (outcome.effect === 'unknown' ? '結果待確認，請先核對操作結果' : outcome.refreshError ? '已更新，重新載入失敗' : outcome.error ? '處理失敗' : outcome.status === 'cancelled' ? '已中止' : '已完成'), finishedAt: Date.now() };
    this.states.set(state.requestId, next); this.statesDirty = true;
    const key = operationConcurrencyKey(state);
    if (this.owners.get(key) === state.requestId && next.effect !== 'unknown') this.owners.delete(key);
    if (next.effect !== 'unknown') this.intents.delete(state.requestId);
  }
  receive(operation: WorkspaceOperationState): void {
    if (!operation || typeof operation.requestId !== 'string' || typeof operation.action !== 'string'
      || typeof operation.resourceKey !== 'string' || typeof operation.scopeRevision !== 'string'
      || !['queued', 'running', 'succeeded', 'failed', 'cancelled'].includes(operation.status)) return;
    if (operation.hostSessionId && this.retiredSessions.has(operation.hostSessionId)) return;
    // Session transitions are accepted through a handshake snapshot only.
    if (operation.hostSessionId && this.sessionId && operation.hostSessionId !== this.sessionId) return;
    let previous = this.states.get(operation.requestId);
    // Streamed receipts normally precede their full snapshot. Reject duplicate
    // known revisions before tombstone keys or correlation scans are needed.
    if (previous?.hostSessionId === operation.hostSessionId && previous?.revision !== undefined && operation.revision !== undefined && operation.revision <= previous.revision) return;
    if (previous && !isActiveOperation(previous) && isActiveOperation(operation)) return;
    if (this.superseded.has(operation.requestId) && isActiveOperation(operation)) return;
    if (!previous) {
      const terminalKey = this.terminalKey(operation);
      const wasTerminal = this.terminalTombstones.has(terminalKey);
      const terminalRevision = this.terminalTombstones.get(terminalKey);
      if (wasTerminal && isActiveOperation(operation)) return;
      const restored = operation.correlationId && this.findByCorrelation(operation.correlationId);
      if (restored && restored.requestId !== operation.requestId && pending(restored)) {
        // An uncertain placeholder remains locked until a real terminal receipt;
        // an old running receipt must not delete it while changing IDs.
        if (!isActiveOperation(restored) && isActiveOperation(operation)) return;
        this.states.delete(restored.requestId); this.clearAcknowledgement(restored.requestId);
        const key = operationConcurrencyKey(restored);
        if (this.owners.get(key) === restored.requestId) this.owners.delete(key);
        previous = { ...restored, revision: undefined };
      }
      if (!previous && wasTerminal && (operation.revision === undefined
        || terminalRevision !== undefined && operation.revision <= terminalRevision)) return;
    }
    this.clearAcknowledgement(operation.requestId);
    const state = { ...previous, ...operation };
    if (previous?.effect === 'unknown' && (operation.effect === 'none' || operation.effect === 'applied')) {
      state.error = operation.error; state.refreshError = operation.refreshError;
    }
    const previousState = previous;
    if (previousState && (Object.keys(state) as Array<keyof WorkspaceOperationState>).every(key => Object.is(state[key], previousState[key]))) return;
    this.states.set(state.requestId, state); this.statesDirty = true;
    const key = operationConcurrencyKey(state);
    if (pending(state)) {
      const owner = this.owners.get(key);
      const currentOwner = owner && this.states.get(owner);
      if (!currentOwner || !pending(currentOwner) || state.startedAt >= currentOwner.startedAt) this.owners.set(key, state.requestId);
    } else if (this.owners.get(key) === state.requestId) {
      this.owners.delete(key); this.intents.delete(state.requestId);
    }
    this.emit();
  }
  reconcile(snapshot: OperationSnapshot): void {
    if (this.retiredSessions.has(snapshot.sessionId)) return;
    const restarted = !!this.sessionId && this.sessionId !== snapshot.sessionId;
    if (this.sessionId === snapshot.sessionId && snapshot.revision < this.watermark) return;
    this.batchDepth++;
    try {
      if (restarted) {
        this.retiredSessions.add(this.sessionId!); this.watermark = -1;
        for (const state of this.states.values()) if (pending(state)) this.finish(state, state.kind === 'write'
          ? { status: 'failed', effect: 'unknown', error: '工作階段已重新啟動，請核對上次寫入結果。' }
          : { status: 'cancelled', phase: '工作階段已重新啟動，請重新載入' });
      }
      if (this.sessionId !== snapshot.sessionId) this.statesDirty = true;
      this.sessionId = snapshot.sessionId; this.context.hostSessionId = snapshot.sessionId;
      this.watermark = Math.max(this.watermark, snapshot.revision);
      for (const state of snapshot.operations) this.receive({ ...state, hostSessionId: snapshot.sessionId });
      for (const id of snapshot.missingIds ?? []) {
        const state = this.states.get(id);
        if (state && isActiveOperation(state)) this.finish(state, state.kind === 'write'
          ? { status: 'failed', effect: 'unknown', error: '未取得寫入回執，請先核對結果。' }
          : { status: 'failed', effect: 'none', error: '未取得讀取回執，請重新載入。' });
      }
      const ids = new Set(snapshot.operations.map(state => state.requestId));
      for (const state of this.states.values()) {
        // A locally queued, unacknowledged request may have been sent after this
        // snapshot was captured. Never infer its failure from absence alone.
        if (isActiveOperation(state) && state.hostSessionId === snapshot.sessionId && (state.revision ?? Infinity) <= snapshot.revision && !ids.has(state.requestId)) {
          this.finish(state, state.kind === 'write' ? { status: 'failed', effect: 'unknown', error: '未取得操作回執，請先核對結果。' } : { status: 'cancelled', phase: '讀取已結束，請重新載入' });
        }
      }
    } finally {
      this.batchDepth--;
      this.emit();
    }
  }
  private terminalKey(state: WorkspaceOperationState): string { return JSON.stringify([state.hostSessionId ?? this.sessionId ?? '', state.requestId]); }
  private rememberTerminal(state: WorkspaceOperationState): void {
    const key = this.terminalKey(state);
    this.terminalTombstones.delete(key); this.terminalTombstones.set(key, state.revision);
    while (this.terminalTombstones.size > 512) this.terminalTombstones.delete(this.terminalTombstones.keys().next().value!);
  }
  private emit(force = false): void {
    this.forceNextEmit ||= force;
    if (this.batchDepth || !this.statesDirty && !this.forceNextEmit) return;
    const values = [...this.states.values()];
    const history = values.filter(state => !pending(state)).sort(historyOrder).slice(-30);
    const kept = new Set([...values.filter(pending), ...history].map(state => state.requestId));
    for (const [id, state] of this.states) if (!kept.has(id)) {
      this.rememberTerminal(state); this.states.delete(id); this.intents.delete(id); this.superseded.delete(id); this.retries.delete(id);
      this.clearAcknowledgement(id);
    }
    const next = [...this.states.values()].sort(operationOrder);
    const forced = this.forceNextEmit; this.forceNextEmit = false;
    this.statesDirty = false;
    if (!forced && next.length === this.snapshot.length && next.every((state, index) => state === this.snapshot[index])) return;
    this.snapshot = next;
    for (const listener of this.listeners) listener();
  }
  private clearAcknowledgement(id: string): void { const timer = this.acknowledgementTimers.get(id); if (timer) clearTimeout(timer); this.acknowledgementTimers.delete(id); }
}
