import { describeAction, type ActionConcurrency, type ActionKind } from './actionPolicy';
export { operationLabels } from './actionPolicy';

export interface WorkspaceOperationState {
  requestId: string;
  scopeRevision: string;
  resourceKey: string;
  action: string;
  label: string;
  phase: string;
  status: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';
  startedAt: number;
  finishedAt?: number;
  completed?: number;
  total?: number;
  error?: string;
  correlationId?: string;
  hostSessionId?: string;
  revision?: number;
  kind?: ActionKind;
  concurrency?: ActionConcurrency;
  lockKey?: string;
  retryable?: boolean;
  cancellable?: boolean;
  notify?: boolean;
  effect?: 'none' | 'applied' | 'partial' | 'unknown';
  refreshError?: string;
}
export interface OperationSnapshot { sessionId: string; revision: number; operations: WorkspaceOperationState[]; requestedIds?: string[]; missingIds?: string[]; }
export interface OperationOutcome {
  status?: 'succeeded' | 'failed' | 'cancelled';
  effect?: WorkspaceOperationState['effect'];
  error?: string;
  refreshError?: string;
  phase?: string;
}
export const isActiveOperation = (state: WorkspaceOperationState): boolean => state.status === 'queued' || state.status === 'running';
export function operationResource(request: { type: string; [key: string]: unknown }): string { return describeAction(request).resourceKey; }
export function operationConcurrencyKey(operation: Pick<WorkspaceOperationState, 'action' | 'scopeRevision' | 'resourceKey' | 'lockKey'>): string {
  return operation.lockKey ?? (operation.action.startsWith('copy') ? 'clipboard' : `${operation.scopeRevision}:${operation.resourceKey}`);
}

/** One activation owns receipts. Replaying an ID never executes its task again. */
export class OperationTracker {
  readonly sessionId = globalThis.crypto?.randomUUID?.() ?? `host-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  private eventRevision = 0;
  private readonly states = new Map<string, WorkspaceOperationState>();
  private readonly tasks = new Map<string, Promise<void>>();
  private readonly resources = new Map<string, string>();
  private readonly listeners = new Set<(state: WorkspaceOperationState) => void>();
  private readonly outcomes = new Map<string, OperationOutcome>();
  private readonly retired = new Map<string, WorkspaceOperationState>();
  private readonly correlations = new Map<string, string>();
  constructor(publish?: (state: WorkspaceOperationState) => void) { if (publish) this.listeners.add(publish); }
  get revision(): number { return this.eventRevision; }
  subscribe(listener: (state: WorkspaceOperationState) => void): { dispose(): void } {
    this.listeners.add(listener); return { dispose: () => { this.listeners.delete(listener); } };
  }
  dispose(): void { this.listeners.clear(); }
  get(requestId: string): WorkspaceOperationState | undefined {
    const id = this.correlations.get(requestId) ?? requestId;
    const state = this.states.get(id) ?? this.retired.get(id); return state && { ...state };
  }
  resolveUnknown(requestId: string, outcome: OperationOutcome & { effect: 'none' | 'applied' }): void {
    const state = this.states.get(requestId);
    if (!state || state.effect !== 'unknown') return;
    Object.assign(state, outcome, { status: outcome.status ?? 'succeeded', phase: outcome.phase ?? '已核對操作結果', finishedAt: Date.now() });
    const resource = operationConcurrencyKey(state);
    if (this.resources.get(resource) === requestId) this.resources.delete(resource);
    this.emit(state);
  }
  /** Records an explicit human confirmation after the original host was lost. */
  recoverConfirmed(input: WorkspaceOperationState, outcome: OperationOutcome & { effect: 'none' | 'applied' }): void {
    const existing = this.states.get(input.requestId);
    if (existing && existing.effect !== 'unknown') return;
    const state: WorkspaceOperationState = { ...input, ...outcome, status: outcome.status ?? 'succeeded',
      error: outcome.error, refreshError: outcome.refreshError, phase: outcome.phase ?? '已人工核對操作結果', finishedAt: Date.now() };
    this.retired.delete(state.requestId); this.states.set(state.requestId, state);
    if (state.correlationId) this.correlations.set(state.correlationId, state.requestId);
    const resource = operationConcurrencyKey(state);
    if (this.resources.get(resource) === state.requestId) this.resources.delete(resource);
    this.emit(state);
  }
  list(scope?: string): WorkspaceOperationState[] {
    const values = [...this.states.values()].filter(state => !scope || state.scopeRevision === scope);
    return [...values.filter(state => isActiveOperation(state) || state.effect === 'unknown'), ...values.filter(state => !isActiveOperation(state) && state.effect !== 'unknown').slice(-20)].map(state => ({ ...state }));
  }
  snapshot(scope?: string, requestedIds?: string[]): OperationSnapshot {
    const operations = new Map(this.list(scope).map(state => [state.requestId, state]));
    const ids = requestedIds?.slice(0, 200);
    for (const id of ids ?? []) { const state = this.get(id); if (state) operations.set(state.requestId, state); }
    return { sessionId: this.sessionId, revision: this.revision, operations: [...operations.values()],
      ...(ids ? { requestedIds: ids, missingIds: ids.filter(id => !this.get(id)) } : {}) };
  }
  private emit(state: WorkspaceOperationState): void {
    state.hostSessionId = this.sessionId; state.revision = ++this.eventRevision;
    for (const listener of this.listeners) listener({ ...state });
  }
  noteError(requestId: string, error: string): void { this.noteOutcome(requestId, { status: 'failed', error }); }
  noteOutcome(requestId: string, outcome: OperationOutcome): void {
    const state = this.states.get(requestId);
    // An adapter can know the result before the task releases its resource.
    if (state && isActiveOperation(state)) {
      outcome = Object.fromEntries(Object.entries(outcome).filter(([, value]) => value !== undefined)) as OperationOutcome;
      const { status, ...details } = outcome;
      Object.assign(state, details);
      this.outcomes.set(requestId, { ...this.outcomes.get(requestId), ...outcome });
    }
  }
  update(requestId: string, patch: Partial<Pick<WorkspaceOperationState, 'phase' | 'completed' | 'total'>>): void {
    const state = this.states.get(requestId);
    if (state && isActiveOperation(state) && Object.entries(patch).some(([key, value]) => state[key as keyof WorkspaceOperationState] !== value)) {
      Object.assign(state, patch); this.emit(state);
    }
  }
  run(input: WorkspaceOperationState, task: () => Promise<void | 'failed' | 'cancelled' | OperationOutcome>): Promise<void> {
    const existing = this.tasks.get(input.requestId);
    if (existing) return existing;
    const previous = this.states.get(input.requestId);
    if (previous) { this.emit(previous); return Promise.resolve(); }
    const retired = this.retired.get(input.requestId);
    if (retired) { this.emit({ ...retired }); return Promise.resolve(); }
    const state = { ...input };
    const resource = operationConcurrencyKey(state);
    const exclusive = !state.concurrency || state.concurrency === 'exclusive';
    this.states.set(state.requestId, state);
    if (state.correlationId) this.correlations.set(state.correlationId, state.requestId);
    const promise = (async () => {
      if (exclusive && this.resources.has(resource)) {
        state.status = 'failed'; state.effect = 'none'; state.error = '同一項資源已有作業正在處理，請等候完成。';
        state.phase = '操作未開始'; state.finishedAt = Date.now(); this.emit(state); return;
      }
      if (exclusive) this.resources.set(resource, state.requestId);
      state.status = 'running'; this.emit(state);
      try {
        const result = await task();
        const outcome: OperationOutcome = { ...this.outcomes.get(state.requestId), ...(typeof result === 'string' ? { status: result } : result ?? {}) };
        Object.assign(state, outcome);
        state.status = outcome.status ?? (state.error ? 'failed' : 'succeeded');
        state.effect ??= state.status === 'succeeded' && state.kind === 'write' ? 'applied' : 'none';
        state.phase = outcome.phase ?? (state.effect === 'unknown' ? '結果待確認，請先核對操作結果'
          : state.effect === 'partial' ? '部分完成，請查看未完成項目'
          : state.refreshError ? '已更新，重新載入失敗'
          : state.status === 'cancelled' ? '已中止' : state.status === 'failed' ? '處理失敗' : '已完成');
      } catch (error) {
        state.status = error instanceof Error && error.name === 'AbortError' ? 'cancelled' : 'failed';
        state.error = error instanceof Error ? error.message : String(error);
        state.phase = state.status === 'cancelled' ? '已中止' : '處理失敗';
        throw error;
      } finally {
        state.finishedAt = Date.now();
        if (this.resources.get(resource) === state.requestId && state.effect !== 'unknown') this.resources.delete(resource);
        this.outcomes.delete(state.requestId); this.emit(state);
        const finished = [...this.states.values()].filter(item => !isActiveOperation(item) && item.effect !== 'unknown');
        for (const old of finished.slice(0, Math.max(0, finished.length - 100))) {
          this.retired.set(old.requestId, { ...old });
          this.states.delete(old.requestId);
        }
      }
    })();
    this.tasks.set(state.requestId, promise);
    void promise.finally(() => this.tasks.delete(state.requestId)).catch(() => undefined);
    return promise;
  }
}
