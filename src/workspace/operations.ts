import { describeAction, type ActionConcurrency, type ActionKind } from './actionPolicy';
export { operationLabels } from './actionPolicy';

export interface WorkspaceOperationState {
  requestId: string;
  scopeRevision: string;
  resourceKey: string;
  action: string;
  label: string;
  phase: string;
  transportStage?: 'waiting' | 'sending' | 'cooldown';
  retryAt?: number;
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
export type CompactOperationReceipt = Pick<WorkspaceOperationState, 'requestId' | 'scopeRevision' | 'resourceKey' | 'action' | 'label' | 'phase' | 'status' | 'startedAt'> &
  Partial<Pick<WorkspaceOperationState, 'correlationId' | 'effect' | 'finishedAt' | 'kind' | 'notify'>>;
export interface OperationReceiptStore {
  initialize?(): Promise<void>;
  get(id: string): Promise<CompactOperationReceipt | undefined>;
  save(receipt: CompactOperationReceipt): Promise<void>;
  flush?(): Promise<void>;
}
interface OperationTrackerOptions { store?: OperationReceiptStore; historyLimit?: number; onStoreError?(message: string): void; }
const compactReceipt = (state: WorkspaceOperationState): CompactOperationReceipt => ({ requestId: state.requestId,
  correlationId: state.correlationId, scopeRevision: state.scopeRevision, resourceKey: state.resourceKey, action: state.action,
  label: state.label, phase: state.phase, status: state.status, startedAt: state.startedAt, finishedAt: state.finishedAt,
  effect: state.effect, kind: state.kind, notify: state.notify });
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
  private readonly retired = new Map<string, CompactOperationReceipt>();
  private readonly correlations = new Map<string, string>();
  private readonly persisted = new Set<string>();
  private retirement: Promise<void> = Promise.resolve();
  private storeWarning = false;
  constructor(publish?: (state: WorkspaceOperationState) => void, private readonly options: OperationTrackerOptions = {}) { if (publish) this.listeners.add(publish); }
  initialize(): Promise<void> { return this.options.store?.initialize?.() ?? Promise.resolve(); }
  async flush(): Promise<void> { await this.retirement; await this.options.store?.flush?.(); }
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
    if (!state || isActiveOperation(state) || state.effect !== 'unknown') return;
    Object.assign(state, outcome, { status: outcome.status ?? 'succeeded', phase: outcome.phase ?? '已核對操作結果', finishedAt: Date.now() });
    const resource = operationConcurrencyKey(state);
    if (this.resources.get(resource) === requestId) this.resources.delete(resource);
    this.emit(state);
    void this.saveReceipt(state).then(() => this.retireFinished());
  }
  /** Records an explicit human confirmation after the original host was lost. */
  recoverConfirmed(input: WorkspaceOperationState, outcome: OperationOutcome & { effect: 'none' | 'applied' }): void {
    const existing = this.states.get(input.requestId);
    if (isActiveOperation(input) || existing && (isActiveOperation(existing) || existing.effect !== 'unknown')) return;
    const state: WorkspaceOperationState = { ...input, ...outcome, status: outcome.status ?? 'succeeded',
      error: outcome.error, refreshError: outcome.refreshError, phase: outcome.phase ?? '已人工核對操作結果', finishedAt: Date.now() };
    this.retired.delete(state.requestId); this.states.set(state.requestId, state);
    if (state.correlationId) this.correlations.set(state.correlationId, state.requestId);
    const resource = operationConcurrencyKey(state);
    if (this.resources.get(resource) === state.requestId) this.resources.delete(resource);
    this.emit(state);
    void this.saveReceipt(state).then(() => this.retireFinished());
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
  async snapshotWithStored(scope?: string, requestedIds?: string[], signal?: AbortSignal): Promise<OperationSnapshot> {
    signal?.throwIfAborted();
    const initial = this.snapshot(scope, requestedIds);
    if (!this.options.store || !initial.missingIds?.length) return initial;
    const receipts = new Map<string, CompactOperationReceipt>();
    const ids = initial.missingIds; let cursor = 0;
    await Promise.all(Array.from({ length: Math.min(4, ids.length) }, async () => {
      while (cursor < ids.length) {
        signal?.throwIfAborted(); const id = ids[cursor++];
        try { const receipt = await this.options.store!.get(id); if (receipt) receipts.set(id, receipt); }
        catch { this.reportStoreError(); }
      }
    }));
    signal?.throwIfAborted();
    // Re-read live state after disk I/O; a new running or unknown operation always wins.
    const current = this.snapshot(scope, requestedIds), operations = new Map(current.operations.map(operation => [operation.requestId, operation]));
    const missingIds: string[] = [];
    for (const id of current.missingIds ?? []) {
      const receipt = receipts.get(id);
      if (receipt) operations.set(receipt.requestId, { ...receipt, hostSessionId: this.sessionId, revision: current.revision });
      else missingIds.push(id);
    }
    return { ...current, operations: [...operations.values()], missingIds };
  }
  private emit(state: WorkspaceOperationState): void {
    state.hostSessionId = this.sessionId; state.revision = ++this.eventRevision;
    for (const listener of this.listeners) { try { listener({ ...state }); } catch { /* A consumer cannot change the operation outcome. */ } }
  }
  private reportStoreError(): void {
    if (!this.storeWarning) { this.storeWarning = true; try { this.options.onStoreError?.('操作收據無法讀寫；已保留目前狀態，請檢查儲存空間後再試。'); } catch { /* Diagnostics never fail an adapter. */ } }
  }
  private async saveReceipt(state: WorkspaceOperationState): Promise<boolean> {
    if (!this.options.store || this.persisted.has(state.requestId)) return true;
    try { await this.options.store.save(compactReceipt(state)); this.persisted.add(state.requestId); this.storeWarning = false; return true; }
    catch { this.reportStoreError(); return false; }
  }
  private retireFinished(): Promise<void> {
    this.retirement = this.retirement.then(async () => {
      const finished = [...this.states.values()].filter(state => !isActiveOperation(state) && state.effect !== 'unknown');
      for (const old of finished.slice(0, Math.max(0, finished.length - (this.options.historyLimit ?? 1000)))) {
        if (!await this.saveReceipt(old)) continue;
        if (!this.options.store) this.retired.set(old.requestId, compactReceipt(old));
        this.states.delete(old.requestId); this.persisted.delete(old.requestId);
        if (this.options.store && old.correlationId && this.correlations.get(old.correlationId) === old.requestId) this.correlations.delete(old.correlationId);
      }
    }).catch(() => this.reportStoreError());
    return this.retirement;
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
  update(requestId: string, patch: Partial<Pick<WorkspaceOperationState, 'phase' | 'completed' | 'total' | 'transportStage' | 'retryAt'>>): void {
    const state = this.states.get(requestId);
    if (state && isActiveOperation(state) && Object.entries(patch).some(([key, value]) => state[key as keyof WorkspaceOperationState] !== value)) {
      Object.assign(state, patch); this.emit(state);
    }
  }
  run(input: WorkspaceOperationState, task: () => Promise<void | 'failed' | 'cancelled' | OperationOutcome>): Promise<void> {
    const existing = this.tasks.get(input.requestId);
    if (existing) return existing;
    const knownId = this.correlations.get(input.requestId) ?? input.requestId;
    const previous = this.states.get(knownId);
    if (previous) { this.emit(previous); return Promise.resolve(); }
    const retired = this.retired.get(knownId);
    if (retired) { this.emit({ ...retired }); return Promise.resolve(); }
    const state = { ...input };
    const resource = operationConcurrencyKey(state);
    const exclusive = !state.concurrency || state.concurrency === 'exclusive';
    this.states.set(state.requestId, state);
    if (state.correlationId) this.correlations.set(state.correlationId, state.requestId);
    const promise = (async () => {
      if (this.options.store) {
        let receipt: CompactOperationReceipt | undefined;
        try { receipt = await this.options.store.get(input.requestId); }
        catch {
          this.reportStoreError();
          if (state.kind !== 'read') {
            state.status = 'failed'; state.effect = 'unknown';
            state.error = '無法核對歷史操作收據，已停止執行；請先確認原操作結果。'; state.phase = '歷史操作待核對'; state.finishedAt = Date.now();
            this.resources.set(resource, state.requestId); this.emit(state); return;
          }
        }
        if (receipt) {
          this.states.delete(state.requestId);
          if (state.correlationId && this.correlations.get(state.correlationId) === state.requestId) this.correlations.delete(state.correlationId);
          const restored = { ...receipt }; this.states.set(restored.requestId, restored); this.persisted.add(restored.requestId);
          if (receipt.correlationId) this.correlations.set(receipt.correlationId, receipt.requestId);
          this.emit(restored); await this.retireFinished(); return;
        }
      }
      if (exclusive && this.resources.has(resource)) {
        state.status = 'failed'; state.effect = 'none'; state.error = '同一項資源已有作業正在處理，請等候完成。';
        state.phase = '操作未開始'; state.finishedAt = Date.now(); this.emit(state);
        await this.saveReceipt(state); await this.retireFinished(); return;
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
        const effect = error && typeof error === 'object' ? (error as { effect?: unknown }).effect : undefined;
        if (effect === 'none' || effect === 'applied' || effect === 'partial' || effect === 'unknown') state.effect = effect;
        state.status = error instanceof Error && error.name === 'AbortError' ? 'cancelled' : 'failed';
        state.error = error instanceof Error ? error.message : String(error);
        state.phase = state.effect === 'unknown' ? '結果待確認，請先核對操作結果' : state.status === 'cancelled' ? '已中止' : '處理失敗';
        throw error;
      } finally {
        state.finishedAt = Date.now();
        if (this.resources.get(resource) === state.requestId && state.effect !== 'unknown') this.resources.delete(resource);
        this.outcomes.delete(state.requestId); this.emit(state);
        if (state.effect !== 'unknown') await this.saveReceipt(state);
        await this.retireFinished();
      }
    })();
    this.tasks.set(state.requestId, promise);
    void promise.finally(() => this.tasks.delete(state.requestId)).catch(() => undefined);
    return promise;
  }
}
