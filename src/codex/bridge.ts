import path from 'node:path';
import { AsyncLocalStorage } from 'node:async_hooks';
import { CodexTaskScheduler, codexResourcePaths, codexResourcesOverlap, type CodexReservation } from './scheduler';
import { randomUUID } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import { watch, type FSWatcher } from 'node:fs';
import { CodexAppServer, type RpcMessage } from './appServer';
import { CodexProtocolAdapter, codexCapabilities } from './adapter';
import { autoEfforts, selectRoutingEffort } from './modelRoutingProtocol';
import { projectCodexProgress } from './progress';
import { boundTranscriptCache, codexItemBytes } from './historyBudget';
import type { CodexApprovalSettings, CodexGoal, CodexTaskSource } from './protocol';
import type { CodexRpcDiagnostic } from './appServer';
import { CodexRpcError } from './rpcError';
import { resolveCodexExecutable, spawnCodex } from './process';
import { CodexTaskDeletedError, CodexTaskStore, codexRootKey, validTaskId } from './taskStore';
import { CodexWorkspaceLease } from './workspaceLease';
import { validateForm } from './forms';
import { mergeCodexTranscript, projectCodexItem } from './transcript';
import { readModelRouting, requireRoutingEffort, routingModel, routingEfforts, routingSummary,
  routingTurnPrompt, routingAssessmentOutputSchema } from './modelRouting';
export { validateForm } from './forms';
import { codexTaskActive, codexOutputKey, projectCodexTask, type CodexEnvironment, type CodexEvent, type CodexInteraction,
  type CodexInteractionAnswer, type CodexOutputItem, type CodexTaskRecord, type CodexTaskSpec, type CodexTaskState, type CodexTaskResult, type CodexStorageProblem } from './protocol';
import { workflowOriginKey } from './workflowProtocol';
import { GitLabReadCache as ReadCache, abortedReadError } from '../api/gitLabReadCache';
import { networkRuntimeRoot } from '../api/localNetworkLease';
import { cleanupTaskStorage, type CodexCleanupPlan } from './taskCleanup';
import { ProjectWikiStore } from './projectWiki';

type CodexConnection = { client: CodexAppServer; version: string; executable: string };

interface PendingInteraction { projection: CodexInteraction; request: RpcMessage; client: CodexAppServer; responding?: boolean; }
interface ActiveExecution {
  record: CodexTaskRecord; client?: CodexAppServer; abort: AbortController; finish?: () => void;
  cancellation?: Promise<void>; turnStatus?: string; steering?: Promise<void>;
  stopAs?: 'paused' | 'interrupted'; settled: Promise<void>; settle(): void;
  cleanupFailed?: boolean;
  unmaterializedThreadId?: string;
  version?: string;
  goalTimer?: ReturnType<typeof setTimeout>;
  goalStartedAt?: number;
}
export interface CodexBridgeOptions {
  storage: string;
  version: string;
  executable(): string;
  trusted(): boolean;
  prepare(source: CodexTaskSpec['source'], previous?: CodexTaskSpec): Promise<CodexTaskSpec>;
  event(event: CodexEvent): void;
  openUrl(url: string): Promise<void>;
  cancelReview?(spec: CodexTaskSpec): Promise<void>;
  started?(spec: CodexTaskSpec, signal: AbortSignal): Promise<void>;
  completed?(spec: CodexTaskSpec, taskId: string, output: readonly CodexOutputItem[]): Promise<CodexTaskResult | void>;
  approved?(event: { taskId: string; threadId?: string; turnId?: string; requestId: number | string; kind: string; scope: 'once' | 'turn' }): void;
  client?(root: string): Promise<{ client: CodexAppServer; version: string; executable: string }>;
  now?(): number;
  maxConcurrent?(): number;
  scheduler?: CodexTaskScheduler;
  reconcilePublication?(spec: CodexTaskSpec, publication: NonNullable<CodexTaskRecord['publication']>): Promise<'pending' | 'confirmed'>;
}
const implementationTask = (spec: CodexTaskSpec): boolean => spec.origin?.kind === 'issue' || spec.source.kind === 'merge-request' && spec.source.intent === 'fix-comments';
const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code !== 'ESRCH'; } };
const safeText = (value: unknown, limit = 20_000): string => typeof value === 'string' ? value.slice(0, limit) : '';
export class CodexBridge {
  private readonly instanceId = randomUUID();
  get storagePath(): string { return this.store.directory; }
  private readonly store: CodexTaskStore;
  private records = new Map<string, CodexTaskRecord>();
  private readonly persisted = new Map<string, CodexTaskState>();
  private enqueuing = new Map<string, Promise<string>>();
  private owned = new Set<string>();
  private controlling = new Set<string>();
  private deleted = new Set<string>();
  private watcher?: FSWatcher;
  private reloadTimer?: ReturnType<typeof setTimeout>;
  private reloadSequence = 0;
  private outputs = new Map<string, CodexOutputItem[]>();
  private histories = new Map<string, { items: CodexOutputItem[]; cursor?: string; nextCursor?: string }>();
  private readonly historyPages: ReadCache;
  private historySequence = 0;
  private historyApplied = new Map<string, number>();
  private interactions = new Map<string, PendingInteraction>();
  private queue: string[] = [];
  private readonly executions = new Map<string, ActiveExecution>();
  private readonly executionContext = new AsyncLocalStorage<ActiveExecution>();
  private readonly scheduler: CodexTaskScheduler;
  private readonly executionTasks = new Set<Promise<void>>();
  private retryTimer?: ReturnType<typeof setTimeout>;
  private get active(): ActiveExecution | undefined { return this.executionContext.getStore() ?? this.executions.values().next().value; }
  private autoAccept = new Set<string>();
  private approvals = new Map<string, CodexApprovalSettings>();
  private diagnostics = new Map<string, CodexRpcDiagnostic[]>();
  private progressTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private autoAcceptErrors = new Map<string, string>();
  private seenRequests = new WeakMap<CodexAppServer, Set<string>>();
  private initialized?: Promise<void>;
  private disposed = false;
  private processing = false;
  private checking?: Promise<void>;
  private environment: CodexEnvironment = { state: 'unchecked' };
  private outputTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private shutdownTask?: Promise<void>;
  private processingTask?: Promise<void>;
  private clients = new Set<CodexAppServer>();
  private connecting = new Set<Promise<CodexConnection>>();
  private processProblems: CodexStorageProblem[] = [];
  constructor(private readonly options: CodexBridgeOptions) {
    this.scheduler = options.scheduler ?? new CodexTaskScheduler(this.instanceId);
    this.store = new CodexTaskStore(path.join(options.storage, 'codex-tasks'), plan => this.cleanupStorage(plan));
    this.historyPages = new ReadCache(60_000, 256, options.now ?? Date.now, 32 * 1024 * 1024);
  }
  initialize(): Promise<void> {
    return this.initialized ??= this.store.retryCleanup().then(async () => { this.processProblems = await CodexWorkspaceLease.sweepProcesses(); }).then(() => this.store.load()).then(async records => {
      for (const record of records) {
        if (record.lease?.released && record.lease.receipt) await CodexWorkspaceLease.clearReceipt(record.lease.receipt).catch(() => {});
        if ((codexTaskActive(record.status) || record.status === 'queued') && !alive(record.ownerPid)) {
          record.status = record.dispatchPending || record.status === 'pausing' ? 'uncertain' : 'interrupted';
          record.error = '先前工作已中斷，請核對紀錄後手動續作。'; await this.store.save(record);
        }
        this.records.set(record.id, record);
        this.persisted.set(record.id, structuredClone(projectCodexTask(record)));
      }
      if (!this.disposed) {
        this.watcher = watch(this.store.directory, (_event, filename) => {
          if (!filename?.toString().endsWith('.json')) return;
          if (this.reloadTimer) clearTimeout(this.reloadTimer);
          this.reloadTimer = setTimeout(() => { void this.reload().catch(() => { this.emit({ kind: 'environment', environment: { state: 'blocked', message: 'Codex 任務紀錄無法讀取，請重新檢查儲存區。' } }); }); }, 100);
        });
        this.watcher.on('error', () => { this.watcher?.close(); this.emit({ kind: 'environment', environment: { state: 'blocked', message: '任務監聽已中斷，請手動重新讀取任務。' } }); });
      }
    }).catch(error => { this.initialized = undefined; throw error; });
  }
  private async reload(): Promise<void> {
    if (this.disposed) return;
    const sequence = ++this.reloadSequence, knownIds = new Set(this.records.keys());
    const records = await this.store.load(), ids = new Set(records.map(record => record.id));
    if (this.disposed || sequence !== this.reloadSequence) return;
    for (const id of knownIds) if (!ids.has(id) && !this.store.problems.some(problem => problem.id === id) && !this.executions.has(id) && !this.queue.includes(id) && !this.controlling.has(id)) this.forget(id);
    for (const record of records) if (!this.deleted.has(record.id) && !this.executions.has(record.id) && !this.queue.includes(record.id) && !this.controlling.has(record.id)) {
      const current = this.persisted.get(record.id);
      if (current && (record.revision !== undefined && current.revision !== undefined && record.revision < current.revision || record.updatedAt < current.updatedAt || record.updatedAt === current.updatedAt && record.ownerPid === process.pid && this.owned.has(record.id))) continue;
      if (codexTaskActive(record.status) || record.status === 'queued') { this.owned.delete(record.id); this.autoAccept.delete(record.id); }
      this.records.set(record.id, record);
      this.persisted.set(record.id, structuredClone(projectCodexTask(record)));
    }
    this.emit({ kind: 'tasks', tasks: this.list() });
  }
  list(): CodexTaskState[] {
    return [...this.persisted.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map(value => {
      const busy = codexTaskActive(value.status) || value.status === 'queued';
      const external = busy && !this.owned.has(value.id);
      const settling = this.executions.has(value.id) || this.controlling.has(value.id);
      return { ...structuredClone(value), queuePosition: this.queue.includes(value.id) ? this.queue.indexOf(value.id) + 1 : undefined, controls: {
        external, canPause: busy && !external && value.status !== 'pausing',
        canResume: !busy && !settling && value.result?.state !== 'uncertain' && value.publication?.state !== 'pending', canDelete: !busy && !settling && value.status !== 'uncertain' && value.result?.state !== 'uncertain' && value.publication?.state !== 'pending' && (!this.records.get(value.id)?.lease || this.records.get(value.id)?.lease?.released === true),
        canAutoAccept: !external && value.status !== 'pausing', autoAccept: this.autoAccept.has(value.id),
        autoAcceptError: this.autoAcceptErrors.get(value.id), approvals: this.approvals.get(value.id) ?? this.records.get(value.id)?.approvalSettings ?? { command: true, file: true, permissions: true }
      } };
    });
  }
  async publish(): Promise<void> {
    await this.initialize(); await this.store.retryCleanup(); this.processProblems = await CodexWorkspaceLease.sweepProcesses(); await this.reload(); this.emit({ kind: 'environment', environment: { ...this.environment, storageProblems: [...this.store.problems, ...this.processProblems] } });
    for (const [taskId, history] of this.histories) this.emit({ kind: 'history', taskId, ...history });
    for (const [taskId, items] of this.outputs) this.emit({ kind: 'output', taskId, items, replace: true });
    for (const taskId of new Set([...this.interactions.values()].map(value => value.projection.taskId))) this.publishInteractions(taskId);
  }
  private emit(event: CodexEvent): void { if (!this.disposed) this.options.event(event); }
  private async requireHealthyStorage(): Promise<void> {
    const records = await this.store.load();
    if (records.some(record => record.schema === 'GitLabWorkspaceCodexTask/v1' && !record.ownerInstance && record.ownerPid !== process.pid && alive(record.ownerPid) && (codexTaskActive(record.status) || record.status === 'queued'))) throw new Error('偵測到舊版 Host 正在管理任務，請先重載所有 VS Code 視窗。');
    if (this.store.problems.some(problem => problem.kind !== 'cleanup')) throw new Error('任務儲存區包含無法驗證的紀錄，已暫停新派發；請檢查儲存區後重新讀取。');
  }
  private scheduleProgress(record: CodexTaskRecord): void {
    if (this.progressTimers.has(record.id)) return;
    this.progressTimers.set(record.id, setTimeout(() => {
      this.progressTimers.delete(record.id);
      if (this.records.has(record.id) && !this.disposed) void this.save(record).catch(() => {});
    }, 250));
  }
  async reorder(id: string, direction: 'up' | 'down'): Promise<void> {
    this.requireTrusted(); await this.initialize();
    if (this.record(id).status !== 'queued' || !this.queue.includes(id)) throw new Error('只有本視窗尚未執行的排隊任務可調整順序。');
    const index = this.queue.indexOf(id), target = index + (direction === 'up' ? -1 : 1);
    if (target >= 0 && target < this.queue.length) [this.queue[index], this.queue[target]] = [this.queue[target], this.queue[index]];
    this.emit({ kind: 'tasks', tasks: this.list() }); this.schedule();
  }
  async withResources<T>(id: string, operation: () => Promise<T>): Promise<T> {
    this.requireTrusted(); await this.initialize(); const record = this.record(id);
    if (codexTaskActive(record.status) || record.status === 'queued' || record.status === 'uncertain') throw new Error('請先停止並核對任務後再操作成果。');
    const admission = await this.scheduler.tryAcquire('control-' + id, record.spec, this.options.maxConcurrent?.() ?? 1);
    if (!admission.reservation) throw new Error('其他任務正在使用共用資源，請稍後再試。');
    const reservation = admission.reservation; let uncertain = false;
    try { return await operation(); }
    catch (error) {
      uncertain = !!error && typeof error === 'object' && 'workflowCleanupUncertain' in error;
      if (uncertain) { record.status = 'uncertain'; record.error = '成果操作的程序停止結果待核對。'; await this.save(record); }
      throw error;
    } finally {
      for (const lease of [reservation.primary, ...reservation.extras]) { if (uncertain) await lease.quarantine(); else await lease.release(); }
      await reservation.release(uncertain);
    }
  }
  async turns(id: string): Promise<Array<{ id: string; status?: string }>> {
    await this.initialize(); const record = this.record(id); if (!record.threadId) return [];
    const { client, version } = await this.makeClient(record.root);
    try { return (await new CodexProtocolAdapter(client, version).read<{ data: Array<{ id: string; status?: string }> }>('thread/turns/list',
      { threadId: record.threadId, limit: 100, sortDirection: 'desc', itemsView: 'notLoaded' })).data; }
    finally { await client.close(); }
  }
  async fork(id: string, turnId: string): Promise<string> {
    this.requireTrusted(); await this.initialize(); await this.requireHealthyStorage();
    const record = this.record(id);
    if (!this.list().find(task => task.id === id)?.controls?.canResume || !record.threadId) throw new Error('請先停止並核對原任務。');
    if (!(await this.turns(id)).some(turn => turn.id === turnId && ['completed', 'failed', 'interrupted'].includes(turn.status ?? ''))) throw new Error('分支起點必須是已停止的保存回合。');
    const source: CodexTaskSource = { kind: 'free', repository: record.spec.origin?.repositoryRoot ?? record.root, prompt: `沿用分支對話，接續「${record.title}」。`,
      model: record.spec.routing?.model ?? record.spec.model ?? (record.spec.routing ? routingModel : undefined),
      effort: record.spec.routing ? record.modelRouting?.effort ?? record.spec.routing.supportedEfforts?.find(value => value === 'high') ?? 'high' : record.spec.effort };
    const spec = await this.options.prepare(source); const { client, version } = await this.makeClient(spec.root);
    try {
      if (!codexCapabilities(version).fork) throw new Error('目前 CLI 尚未通過對話分支契約驗證，請使用已驗證版本。');
      const result = await client.request('thread/fork', { threadId: record.threadId, lastTurnId: turnId, excludeTurns: true,
        cwd: spec.root, sandbox: 'workspace-write', approvalPolicy: 'on-request', approvalsReviewer: 'user' });
      if (typeof result.thread?.id !== 'string') throw new Error('Codex 未傳回分支對話識別。');
      const now = new Date().toISOString(), task: CodexTaskRecord = { schema: 'GitLabWorkspaceCodexTask/v2', id: randomUUID(),
        title: `分支：${record.title}`.slice(0, 200), spec, root: spec.root, status: 'paused', createdAt: now, updatedAt: now,
        threadId: result.thread.id, ownerPid: process.pid, ownerInstance: this.instanceId,
        forkedFrom: { taskId: id, threadId: record.threadId, turnId } };
      await this.store.save(task); this.records.set(task.id, task); this.owned.add(task.id); this.persisted.set(task.id, projectCodexTask(task));
      this.emit({ kind: 'tasks', tasks: this.list() }); return task.id;
    } finally { await client.close(); }
  }
  async setGoal(id: string, goal?: CodexGoal, action?: 'pause' | 'clear'): Promise<void> {
    this.requireTrusted(); await this.initialize(); const record = this.record(id);
    if (record.spec.source.kind !== 'free' || !this.list().find(task => task.id === id)?.controls?.canResume) throw new Error('目標模式供已停止的自由任務使用。');
    if (goal && (!goal.objective.trim() || goal.objective.length > 4000 || !goal.tokenBudget && !goal.timeBudgetSeconds ||
      goal.tokenBudget !== undefined && (!Number.isSafeInteger(goal.tokenBudget) || goal.tokenBudget < 1 || goal.tokenBudget > 100_000_000) ||
      goal.timeBudgetSeconds !== undefined && (!Number.isSafeInteger(goal.timeBudgetSeconds) || goal.timeBudgetSeconds < 1 || goal.timeBudgetSeconds > 86400))) throw new Error('請提供明確目標及有效的 Token 或時間預算。');
    const { client, version } = await this.makeClient(record.root);
    try {
      const adapter = new CodexProtocolAdapter(client, version);
      if (!codexCapabilities(version).goals) throw new Error('目前 CLI 尚未通過原生 Goal 契約驗證。');
      if (record.threadId) {
        await client.request('thread/resume', { threadId: record.threadId, excludeTurns: true, cwd: record.root, sandbox: 'workspace-write', approvalPolicy: 'on-request' });
        if (action === 'clear') await client.request('thread/goal/clear', { threadId: record.threadId, origin: 'user' });
        else await adapter.setGoal({ threadId: record.threadId, origin: 'user', objective: goal?.objective, status: 'paused', tokenBudget: goal?.tokenBudget });
      }
      if (action === 'clear') record.goal = undefined;
      else if (goal) record.goal = { ...goal, status: 'paused', timeUsedSeconds: 0 };
      else if (record.goal) record.goal.status = 'paused';
      await this.save(record);
    } finally { await client.close(); }
  }
  async metadata(id: string, changes: { title?: string; pinned?: boolean; archived?: boolean }): Promise<void> {
    this.requireTrusted(); await this.initialize();
    await this.store.control(id, async () => {
      await this.reload(); const record = this.record(id);
      if (codexTaskActive(record.status) || record.status === 'queued') throw new Error('請先停止任務再修改管理紀錄。');
      if (changes.title !== undefined) { if (!changes.title.trim() || changes.title.length > 200) throw new Error('任務名稱須為 1 到 200 字。'); record.title = changes.title.trim(); }
      if (changes.pinned !== undefined) record.pinned = changes.pinned;
      if (changes.archived !== undefined) { if (record.status === 'uncertain' || record.publication?.state === 'pending') throw new Error('請先核對結果再封存。'); record.archived = changes.archived; }
      record.schema = 'GitLabWorkspaceCodexTask/v2'; await this.save(record);
    });
  }
  async setApprovals(id: string, settings: CodexApprovalSettings): Promise<void> {
    this.requireTrusted(); await this.initialize(); this.record(id);
    if (!this.list().find(task => task.id === id)?.controls?.canAutoAccept || !['command', 'file', 'permissions'].every(key => typeof settings[key as keyof CodexApprovalSettings] === 'boolean')) throw new Error('核准設定目前無法修改。');
    this.approvals.set(id, { ...settings }); this.record(id).approvalSettings = { ...settings }; await this.save(this.record(id)); this.emit({ kind: 'tasks', tasks: this.list() });
    for (const pending of this.interactions.values()) if (pending.projection.taskId === id) await this.autoAnswer(pending);
  }
  async models(root: string) {
    const connection = await this.makeClient(root);
    try { return await new CodexProtocolAdapter(connection.client, connection.version).models(); }
    finally { await connection.client.close(); }
  }
  diagnosticSnapshot(id: string): Record<string, unknown> {
    const record = this.record(id);
    return { schema: 'GitLabWorkspaceCodexDiagnostics/v1', extensionVersion: this.options.version,
      cliVersion: this.environment.version, capabilities: this.environment.capabilities, taskId: id,
      status: record.status, revision: record.revision, dispatchState: record.dispatch?.state,
      recovery: record.recovery ? { execution: record.recovery.execution, cleanup: record.recovery.cleanup, publication: record.recovery.publication, checkedAt: record.recovery.checkedAt } : undefined,
      rpc: this.diagnostics.get(id) ?? [] };
  }
  progress(id: string) { return structuredClone(this.record(id).progress); }
  async notePublication(id: string, publication: NonNullable<CodexTaskRecord['publication']>): Promise<void> {
    this.requireTrusted(); await this.initialize();
    await this.store.control(id, async () => { const record = this.record(id); record.publication = publication; await this.save(record); });
  }
  async reconcile(id: string): Promise<void> {
    this.requireTrusted(); await this.initialize();
    await this.store.control(id, async () => {
      await this.reload(); const record = this.record(id);
      if (codexTaskActive(record.status) || record.status === 'queued') throw new Error('請先至執行視窗暫停任務，再核對停止結果。');
      let execution: NonNullable<CodexTaskRecord['recovery']>['execution'] = record.dispatchPending ? 'unknown' : !record.threadId ? 'not-started' : 'unknown';
      if (record.threadId) {
        const { client, version } = await this.makeClient(record.root);
        try {
          const page = await new CodexProtocolAdapter(client, version).read<{ data: Array<{ id: string; status?: string }> }>('thread/turns/list',
            { threadId: record.threadId, limit: 100, sortDirection: 'desc', itemsView: 'notLoaded' });
          const turn = page.data?.find(turn => turn.id === (record.turnId ?? record.dispatch?.turnId));
          if (turn && ['completed', 'failed', 'interrupted'].includes(turn.status ?? '')) execution = turn.status as NonNullable<CodexTaskRecord['recovery']>['execution'];
          else if (turn?.status === 'inProgress') execution = 'running';
        } catch { /* Lack of durable evidence remains unknown. */ }
        finally { await client.close().catch(() => {}); }
      }
      const cleanup = record.lease?.released ? 'confirmed' : record.lease ? await CodexWorkspaceLease.inspect(record.lease.directory, record.lease.receipt) : 'unknown';
      if (record.publication?.state === 'pending' && this.options.reconcilePublication) record.publication.state = await this.options.reconcilePublication(record.spec, record.publication);
      record.recovery = { checkedAt: new Date().toISOString(), execution, cleanup,
        publication: record.publication?.state ?? (record.result?.state === 'uncertain' ? 'pending' : record.result?.state === 'published' ? 'confirmed' : 'not-published'),
        message: execution === 'unknown' || cleanup === 'unknown' ? '證據尚不足，請保留紀錄及執行鎖；不會自動重送。' : '已核對執行與程序停止結果，可依成果狀態接續。' };
      if (cleanup === 'confirmed' && !['unknown', 'running'].includes(execution)) {
        if (record.spec.review) await this.options.cancelReview?.(record.spec);
        if (record.lease?.receipt && !record.lease.released) {
          const proof = record.lease.receipt;
          if (record.lease.nonce) await CodexWorkspaceLease.releaseWithProof(record.lease.directory, record.lease.nonce, proof);
          for (const extra of record.lease.extras ?? []) await CodexWorkspaceLease.releaseWithProof(extra.directory, extra.nonce, proof);
        } else if (record.lease) await CodexWorkspaceLease.recoverConfirmed(record.lease.directory);
        await this.scheduler.reconcile(id);
        if (record.lease) record.lease.released = true;
        record.dispatchPending = false;
        if (record.status === 'uncertain') record.status = execution === 'not-started' ? 'interrupted' : execution as CodexTaskRecord['status'];
        if (execution === 'completed' && record.result?.state !== 'uncertain') {
          const result = await this.options.completed?.(record.spec, id, this.outputs.get(id) ?? []); if (result) record.result = result;
        }
      }
      await this.save(record);
      if (record.lease?.released && record.lease.receipt) await CodexWorkspaceLease.clearReceipt(record.lease.receipt);
    });
  }
  private async save(record: CodexTaskRecord): Promise<void> {
    record.updatedAt = new Date().toISOString();
    record.schema = 'GitLabWorkspaceCodexTask/v2';
    record.revision = (record.revision ?? 0) + 1; record.ownerInstance ??= this.instanceId;
    const state = structuredClone(projectCodexTask(record));
    try { await this.store.save(record); }
    catch (error) { if (error instanceof CodexTaskDeletedError) this.forget(record.id); throw error; }
    this.persisted.set(record.id, state);
    this.emit({ kind: 'tasks', tasks: this.list() });
  }
  async enqueue(spec: CodexTaskSpec, operationId: string = randomUUID()): Promise<string> {
    const pending = this.enqueuing.get(operationId);
    if (pending) return pending;
    const task = this.enqueueNow(spec, operationId); this.enqueuing.set(operationId, task);
    try { return await task; } finally { this.enqueuing.delete(operationId); }
  }
  private async enqueueNow(spec: CodexTaskSpec, operationId: string): Promise<string> {
    this.requireTrusted(); await this.initialize(); await this.requireHealthyStorage();
    if (spec.origin) return this.store.control('workflow-admission', async () => {
      await this.reload();
      const existing = [...this.records.values()].find(record => record.spec.origin &&
        workflowOriginKey(record.spec.origin) === workflowOriginKey(spec.origin!) &&
        (codexTaskActive(record.status) || record.status === 'queued'));
      if (existing) { await this.publish(); return existing.id; }
      return this.enqueueRecord(spec, operationId);
    });
    return this.enqueueRecord(spec, operationId);
  }
  private async enqueueRecord(spec: CodexTaskSpec, operationId: string): Promise<string> {
    if (!validTaskId(operationId)) throw new Error('Codex 任務識別無效。');
    if (this.records.has(operationId)) { await this.publish(); return operationId; }
    await this.captureWikiSeed(spec);
    const now = new Date().toISOString();
    const record: CodexTaskRecord = { schema: 'GitLabWorkspaceCodexTask/v2', id: operationId, spec, title: spec.title,
      root: spec.root, review: spec.review, status: 'queued', ownerPid: process.pid, ownerInstance: this.instanceId, revision: 1, createdAt: now, updatedAt: now };
    await this.store.save(record); this.records.set(record.id, record); this.owned.add(record.id); this.queue.push(record.id);
    this.persisted.set(record.id, structuredClone(projectCodexTask(record)));
    this.emit({ kind: 'tasks', tasks: this.list() }); this.schedule(); return record.id;
  }
  async specification(id: string): Promise<CodexTaskSpec> { await this.initialize(); return structuredClone(this.record(id).spec); }
  async resultAction(id: string, action: (spec: CodexTaskSpec) => Promise<CodexTaskResult>): Promise<void> {
    this.requireTrusted(); await this.initialize();
    await this.store.control(id, async () => {
      await this.reload(); const record = this.record(id);
      if (codexTaskActive(record.status) || record.status === 'queued' || this.executions.has(id)) throw new Error('請等待任務停止後再發布成果。');
      this.controlling.add(id);
      try {
        const result = await action(structuredClone(record.spec));
        // A warm Wiki preview must not rewrite the task timestamp and evict its
        // history page merely by returning the same persisted result again.
        if (JSON.stringify(record.result) !== JSON.stringify(result)) { record.result = result; await this.save(record); }
      }
      finally { this.controlling.delete(id); this.emit({ kind: 'tasks', tasks: this.list() }); }
    });
  }
  private requireTrusted(): void {
    if (this.disposed) throw new Error('Codex Bridge 已關閉。');
    if (!this.options.trusted()) throw new Error('請先信任此 VS Code 工作區，才能執行 Codex。');
  }
  private makeClient(root: string, lease?: CodexWorkspaceLease): Promise<CodexConnection> {
    this.requireTrusted();
    const pending = this.makeClientNow(root, lease); this.connecting.add(pending);
    void pending.finally(() => this.connecting.delete(pending)).catch(() => {}); return pending;
  }
  private async makeClientNow(root: string, suppliedLease?: CodexWorkspaceLease): Promise<CodexConnection> {
    let connection: CodexConnection, lease = suppliedLease;
    if (this.options.client) connection = await this.options.client(root);
    else {
      const executable = await resolveCodexExecutable(this.options.executable(), root); this.requireTrusted();
      lease ??= await CodexWorkspaceLease.acquire(path.join(networkRuntimeRoot(), 'codex-processes', randomUUID() + '.lock'));
      const receipt = await lease.processReceipt();
      try { this.requireTrusted(); }
      catch (error) { if (!suppliedLease) await lease.release(); throw error; }
      lease.markStarted();
      connection = { client: new CodexAppServer(spawnCodex(executable.file, root, receipt)), version: executable.version, executable: executable.file };
    }
    const { client } = connection, close = client.close.bind(client), proof = !this.options.client ? await lease!.processReceipt() : undefined;
    this.clients.add(client);
    let closing: Promise<void> | undefined;
    client.close = timeout => closing ??= (async () => {
      try {
        await close(timeout);
        if (proof && await CodexWorkspaceLease.inspect(lease!.directory, proof) !== 'confirmed') throw new CodexRpcError('cleanup');
        if (lease && !suppliedLease) { await lease.release(true); if (proof) await CodexWorkspaceLease.clearReceipt(proof); }
        this.clients.delete(client);
      } catch (error) {
        if (lease && !suppliedLease) await lease.quarantine().catch(() => {});
        this.environment = { ...this.environment, state: 'blocked', message: 'Codex 程序停止結果待核對，已保留所屬鎖與證據。' };
        this.emit({ kind: 'environment', environment: this.environment }); throw error;
      }
    })();
    try { if (!this.options.client) await client.initialize(this.options.version); this.requireTrusted(); }
    catch (error) { await client.close(); throw error; }
    return connection;
  }
  private async inspect(client: CodexAppServer, version: string, executable: string): Promise<CodexEnvironment> {
    const auth = await client.request('account/read', { refreshToken: false });
    const authenticated = !auth.requiresOpenaiAuth || !!auth.account;
    const sandbox = process.platform === 'win32' ? (await client.request('windowsSandbox/readiness')).status : 'ready';
    const requirements = (await client.request('configRequirements/read')).requirements;
    const permitted = (!requirements?.allowedApprovalPolicies || requirements.allowedApprovalPolicies.includes('on-request')) &&
      (!requirements?.allowedSandboxModes || requirements.allowedSandboxModes.includes('workspace-write'));
    const mcp = codexCapabilities(version).usage ? await client.request<{ data?: Array<{ name: string; authStatus?: string }> }>('mcpServerStatus/list', { limit: 100 }, { timeoutMs: 5000 }).catch(() => undefined) : undefined;
    return { state: authenticated && sandbox === 'ready' && permitted ? 'ready' : 'blocked', authenticated, sandbox, version, executable, capabilities: codexCapabilities(version), checkedAt: new Date().toISOString(),
      mcp: Array.isArray(mcp?.data) ? mcp.data.slice(0, 100).map(server => ({ name: safeText(server.name, 200), status: safeText(server.authStatus, 100) || '未知' })) : undefined,
      message: !authenticated ? '請先登入 Codex。' : sandbox !== 'ready' ? '請先完成 Codex Windows sandbox 設定。'
        : !permitted ? 'Codex 管理政策不允許 workspace-write／on-request，請洽管理員核對設定。' : 'Codex 已準備完成；建立任務時可選擇模型與思考強度，審查預選 Luna＋Auto。' };
  }
  private async beginGoal(record: CodexTaskRecord, active: ActiveExecution): Promise<void> {
    if (!record.goal || record.goal.status === 'complete') return;
    if (!active.client || !active.version || !record.threadId) throw new Error('目標模式缺少有效對話。');
    const adapter = new CodexProtocolAdapter(active.client, active.version);
    const response = await adapter.setGoal({ threadId: record.threadId, origin: 'user', objective: record.goal.objective,
      status: 'active', tokenBudget: record.goal.tokenBudget });
    record.goal.status = response.goal?.status ?? 'active'; record.goal.startedAt = new Date().toISOString();
    active.goalStartedAt = Date.now();
    if (record.goal.timeBudgetSeconds) {
      const remaining = Math.max(0, record.goal.timeBudgetSeconds - (record.goal.timeUsedSeconds ?? 0));
      active.goalTimer = setTimeout(() => {
        void this.pause(record.id).then(async () => { if (record.goal) { record.goal.status = 'budgetLimited'; await this.save(record); } }).catch(() => {});
      }, remaining * 1000);
    }
    await this.save(record);
  }
  async check(root: string): Promise<void> {
    return this.checking ??= this.checkNow(root).finally(() => { this.checking = undefined; });
  }
  private async checkNow(root: string): Promise<void> {
    let client: CodexAppServer | undefined;
    try {
      const connection = await this.makeClient(root); client = connection.client;
      client.onRequest = message => { if (message.id !== undefined) client!.reject(message.id); };
      this.environment = await this.inspect(client, connection.version, connection.executable);
    } catch (error) { this.environment = { state: 'blocked', message: this.errorText(error) }; }
    finally { await client?.close().catch(() => { this.environment = { ...this.environment, state: 'blocked', message: 'Codex 檢查程序的停止結果待核對。' }; }); this.emit({ kind: 'environment', environment: this.environment }); }
  }
  async configure(root: string, action: 'login' | 'sandbox'): Promise<void> {
    this.requireTrusted();
    const { client } = await this.makeClient(root);
    try {
      const completion = new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Codex 設定尚未完成，請重新檢查狀態。')), 180_000);
        client.onExit = error => { clearTimeout(timer); reject(error); };
        client.onNotification = message => {
          if (message.method === (action === 'login' ? 'account/login/completed' : 'windowsSandbox/setupCompleted')) {
            clearTimeout(timer); message.params?.success ? resolve() : reject(new Error('Codex 設定未完成，請檢查本機 Codex。'));
          }
        };
      });
      // Install the rejection handler before an RPC can fail.
      void completion.catch(() => {});
      if (action === 'login') {
        const result = await client.request('account/login/start', { type: 'chatgpt' });
        if (typeof result.authUrl !== 'string') throw new Error('Codex 未傳回登入網址。');
        await this.options.openUrl(result.authUrl);
      } else await client.request('windowsSandbox/setupStart', { mode: 'unelevated' });
      await completion;
    } finally { await client.close(); }
    await this.check(root);
  }
  private async pump(): Promise<void> {
    if (this.processing || this.disposed) return;
    this.processing = true;
    try {
      await this.requireHealthyStorage();
      const limit = Math.max(1, Math.min(2, this.options.maxConcurrent?.() ?? 1));
      const waitingResources: string[][] = [];
      for (const id of [...this.queue]) {
        if (this.disposed || this.executions.size >= limit) break;
        const record = this.records.get(id);
        if (!record || record.status !== 'queued') { this.queue = this.queue.filter(value => value !== id); continue; }
        const resources = await codexResourcePaths(record.spec);
        const admission = waitingResources.some(paths => codexResourcesOverlap(paths, resources)) ? { reason: 'resource' as const } :
          await this.scheduler.tryAcquire(id, record.spec, limit, undefined, resources);
        if (!admission.reservation) {
          waitingResources.push(resources);
          if (record.progress?.waitReason !== admission.reason) { record.progress = { ...record.progress, waitReason: admission.reason }; await this.save(record); }
          continue;
        }
        if (this.disposed || record.status !== 'queued') {
          await admission.reservation.primary.release(); for (const lease of admission.reservation.extras) await lease.release();
          await admission.reservation.release(false); continue;
        }
        this.queue = this.queue.filter(value => value !== id);
        const task = this.execute(record, admission.reservation);
        this.executionTasks.add(task);
        void task.catch(() => {}).finally(() => { this.executionTasks.delete(task); this.schedule(); });
      }
    } catch (error) {
      this.emit({ kind: 'environment', environment: { state: 'blocked', message: this.errorText(error), storageProblems: this.store.problems } });
    } finally {
      this.processing = false;
      if (this.queue.length && !this.disposed && !this.store.problems.some(problem => problem.kind !== 'cleanup') && !this.retryTimer) this.retryTimer = setTimeout(() => { this.retryTimer = undefined; this.schedule(); }, 500);
    }
  }
  private schedule(): void { if (!this.processing && !this.disposed) this.processingTask = this.pump(); }
  private async execute(record: CodexTaskRecord, reservation: CodexReservation): Promise<void> {
    let settle!: () => void;
    const active: ActiveExecution = { record, abort: new AbortController(), settled: new Promise(resolve => { settle = resolve; }), settle: () => settle() };
    this.executions.set(record.id, active);
    return this.executionContext.run(active, () => this.executeNow(record, active, reservation));
  }
  private async executeNow(record: CodexTaskRecord, active: ActiveExecution, reservation: CodexReservation): Promise<void> {
    const lease = reservation.primary;
    const repositoryLeases = reservation.extras;
    let sent = false;
    try {
      const directory = reservation.directory;
      if (active.abort.signal.aborted) throw new Error('任務已停止。');
      this.requireTrusted();
      const prepared = await this.options.prepare(record.spec.source, record.spec);
      if (prepared.environmentKey !== record.spec.environmentKey || prepared.root !== record.root || prepared.executionRoot !== record.spec.executionRoot || JSON.stringify(prepared.writableRoots) !== JSON.stringify(record.spec.writableRoots)) throw new Error('專案或 Skills 環境已變更，請重新確認表單再建立任務。');
      record.spec = { ...record.spec, root: prepared.root, executionRoot: prepared.executionRoot, writableRoots: prepared.writableRoots, skill: prepared.skill };
      record.status = 'starting'; record.error = undefined; record.progress = { ...record.progress, waitReason: undefined }; await this.save(record);
      record.lease = { directory, nonce: await lease.ownerNonce(), ...(!this.options.client ? { receipt: await lease.processReceipt() } : {}),
        extras: await Promise.all(repositoryLeases.map(async extra => ({ directory: extra.directory, nonce: await extra.ownerNonce() }))) };
      await this.save(record);
      const connection = await this.makeClient(record.root, lease); active.client = connection.client; active.version = connection.version;
      const client = connection.client;
      if (active.abort.signal.aborted) throw new Error('任務已停止。');
      this.environment = await this.inspect(client, connection.version, connection.executable);
      this.emit({ kind: 'environment', environment: this.environment });
      if (this.environment.state !== 'ready') throw new Error(this.environment.message);
      if (record.goal && record.goal.status !== 'complete' && !codexCapabilities(connection.version).goals) throw new Error('目前 CLI 不支援已設定的目標模式。');
      if (record.spec.model) {
        const models = await new CodexProtocolAdapter(client, connection.version).models();
        const model = models.find(model => model.model === record.spec.model || model.id === record.spec.model);
        if (!model || !record.spec.routing && record.spec.effort && !model.supportedReasoningEfforts.some(item => item.reasoningEffort === record.spec.effort)) throw new Error('所選模型或思考強度目前不可用，已保留任務。');
      }
      if (codexCapabilities(connection.version).usage) {
        const adapter = new CodexProtocolAdapter(client, connection.version);
        const quota = await adapter.quota().catch(() => undefined);
        if (quota) record.progress = projectCodexProgress(record.progress, 'account/rateLimits/updated', quota);
        const mcp = await adapter.read<{ data?: Array<{ name: string; authStatus?: string; startupState?: string }> }>('mcpServerStatus/list', { limit: 100 }).catch(() => undefined);
        if (Array.isArray(mcp?.data)) this.environment.mcp = mcp.data.slice(0, 100).map(item => ({ name: safeText(item.name, 200), status: safeText(item.startupState ?? item.authStatus, 100) || '未知' }));
        this.emit({ kind: 'environment', environment: this.environment });
      }
      client.onDiagnostic = event => {
        const entries = this.diagnostics.get(record.id) ?? []; entries.push(event); if (entries.length > 100) entries.shift(); this.diagnostics.set(record.id, entries);
      };
      record.progress = { ...record.progress, model: record.spec.model ?? record.spec.routing?.model ?? (record.spec.routing ? routingModel : undefined), effort: record.spec.routing ? undefined : record.spec.effort, updatedAt: new Date().toISOString() };
      if (record.spec.workflow) {
        try { await client.request('skills/extraRoots/set', { extraRoots: [path.dirname(path.dirname(record.spec.skill!.path))] }); }
        catch { throw new Error('此流程需要支援共用 Skills 的 Codex CLI，請升級至 0.166.0 或更新版本。'); }
      }
      await this.options.started?.(record.spec, active.abort.signal);
      if (active.abort.signal.aborted) throw new Error('任務已停止。');
      const cwd = record.spec.executionRoot ?? record.root;
      client.onRequest = message => this.receiveInteraction(record, client, message);
      client.onNotification = message => this.receiveNotification(record, message);
      client.onExit = error => {
        if (codexTaskActive(record.status)) {
          if (this.autoAccept.delete(record.id)) this.autoAcceptErrors.set(record.id, 'Codex 連線已中斷，已關閉 Auto-Accept；請核對已送出的要求。');
          record.status = 'uncertain'; record.error = error.message; active.finish?.();
        }
      };
      let hasPriorTurns = false;
      if (record.threadId) {
        await client.request('thread/resume', { threadId: record.threadId, cwd, approvalPolicy: 'on-request', approvalsReviewer: 'user', sandbox: 'workspace-write', excludeTurns: true });
        hasPriorTurns = await this.loadHistory(record, client);
        if (!hasPriorTurns && record.dispatchPending) throw new Error('先前送出結果不明，且無法讀取已保存的回合；請先核對本機 Codex 與產物，不會自動重送。');
      } else {
        const started = await client.request('thread/start', { cwd, approvalPolicy: 'on-request', approvalsReviewer: 'user', sandbox: 'workspace-write' });
        if (typeof started.thread?.id !== 'string') throw new Error('Codex 未傳回有效的 thread 識別。');
        record.threadId = started.thread.id; active.unmaterializedThreadId = record.threadId; await this.save(record);
      }
      if (record.spec.skill) {
      const skills = await client.request('skills/list', { cwds: [cwd], forceReload: true });
      const found = skills.data?.flatMap((entry: any) => entry.skills ?? []).some((skill: any) =>
        skill.name === record.spec.skill!.name && skill.enabled !== false && typeof skill.path === 'string' && path.resolve(skill.path).toLowerCase() === path.resolve(record.spec.skill!.path).toLowerCase());
      if (!found) throw new Error('Codex 尚未載入此專案的對應 Skill；請重新檢查 Skills 安裝。');
      if (record.spec.routing && !skills.data?.flatMap((entry: any) => entry.skills ?? []).some((skill: any) =>
        skill.name === 'model-routing' && skill.enabled !== false && typeof skill.path === 'string' &&
        path.resolve(skill.path).toLowerCase() === path.resolve(record.spec.routing!.skillPath).toLowerCase())) {
        throw new Error('Codex 尚未載入 Model Routing；請核對工作流程包安裝。');
      }
      }
      if (active.abort.signal.aborted) throw new Error('任務已停止。');
      let message = hasPriorTurns ? record.pendingMessage ?? record.spec.prompt
        : record.spec.prompt + (record.pendingMessage ? `\n\n使用者補充：\n${record.pendingMessage}` : '');
      if (record.spec.routing) {
        sent = true;
        await this.executeRoutedReview(record, client, message);
      } else {
      for (let round = 0; round < (implementationTask(record.spec) ? 3 : 1); round++) {
      record.turnId = undefined;
      active.turnStatus = undefined;
      if (record.goal && record.goal.status !== 'complete') record.goal.status = 'active';
      record.status = 'running'; record.dispatchPending = true;
      record.dispatch = { id: randomUUID(), state: 'prepared', createdAt: new Date().toISOString() }; await this.save(record);
      this.output(record.id, { id: 'dispatch-' + randomUUID(), kind: 'notice', text: record.pendingMessageIsUser ? '接續使用者的要求' : `執行：${record.title}` });
      const finished = new Promise<void>(resolve => { active.finish = resolve; });
      if (active.abort.signal.aborted) throw new Error('任務已停止。');
      sent = true;
      active.unmaterializedThreadId = undefined;
      const dispatched = await client.request('turn/start', { threadId: record.threadId, clientUserMessageId: record.dispatch!.id,
        input: [{ type: 'text', text: message }, ...(record.spec.skill ? [{ type: 'skill', name: record.spec.skill.name, path: record.spec.skill.path }] : [])],
        ...(record.spec.model ? { model: record.spec.model } : {}), ...(record.spec.effort ? { effort: record.spec.effort } : {}),
        approvalPolicy: 'on-request', approvalsReviewer: 'user', cwd,
        sandboxPolicy: { type: 'workspaceWrite', writableRoots: record.spec.writableRoots, networkAccess: false, excludeTmpdirEnvVar: false, excludeSlashTmp: false } });
      if (typeof dispatched.turn?.id !== 'string') throw new Error('Codex 未傳回有效的 turn 識別，請先核對結果。');
      record.turnId = dispatched.turn.id; if (record.dispatch) { record.dispatch.state = 'acknowledged'; record.dispatch.turnId = record.turnId; } record.dispatchPending = false; record.pendingMessage = undefined;
      record.pendingMessageIsUser = undefined;
      await this.save(record);
      await this.beginGoal(record, active);
      await finished;
      if (active.turnStatus !== 'completed' || active.abort.signal.aborted) break;
      const result = await this.options.completed?.(record.spec, record.id,
        mergeCodexTranscript(this.histories.get(record.id)?.items ?? [], this.outputs.get(record.id) ?? []));
      if (result) record.result = result;
      if (active.abort.signal.aborted) break;
      if (!implementationTask(record.spec) || result?.state !== 'needs-work' || round === 2) { record.status = 'completed'; break; }
      message = `${result.summary}\n請沿用原 Issue 與工作分支，接續 BMAD 的實作及測試。已有規格時直接接續 Build；修正失敗測試並以實際命令驗證。不得自動提交、推送或建立 MR。`;
      }
      }
      if (record.spec.routing && (record.status as CodexTaskState['status']) === 'completed') {
        const result = await this.options.completed?.(record.spec, record.id, this.outputs.get(record.id) ?? []);
        if (result) record.result = result;
      }
    } catch (error) {
      if (error && typeof error === 'object' && 'workflowCleanupUncertain' in error) active.cleanupFailed = true;
      if (record.spec.origin && active.turnStatus === 'completed' && !active.abort.signal.aborted && !active.cleanupFailed) {
        record.status = 'completed'; record.error = this.errorText(error);
        record.result = { state: 'needs-work', summary: `成果尚未就緒：${record.error}` };
      }
      else if (record.spec.routing && (record.status as CodexTaskState['status']) === 'failed') record.error = this.errorText(error);
      else if ((record.status as CodexTaskState['status']) === 'completed') record.error = 'Codex 本輪已完成，但工作台資料更新失敗；請手動更新產物狀態。';
      else if (record.status !== 'uncertain') { record.status = active.abort.signal.aborted ? 'pausing' : sent || record.dispatchPending ? 'uncertain' : 'failed'; record.error = active.abort.signal.aborted ? undefined : this.errorText(error); }
    } finally {
      if (active.goalTimer) clearTimeout(active.goalTimer);
      if (record.goal && active.goalStartedAt) record.goal.timeUsedSeconds = (record.goal.timeUsedSeconds ?? 0) + Math.ceil((Date.now() - active.goalStartedAt) / 1000);
      if (record.goal?.status === 'active' && active.client && record.threadId && active.version) {
        await new CodexProtocolAdapter(active.client, active.version).setGoal({ threadId: record.threadId, origin: 'automatic', status: 'paused' })
          .then(() => { if (record.goal) record.goal.status = 'paused'; }).catch(() => { record.status = 'uncertain'; active.cleanupFailed = true; });
      }
      this.clearInteractions(record.id);
      if (active.client) { active.client.onExit = () => {}; await active.client.close(record.spec.routing || record.spec.workflow ? 30_000 : 5000).catch(() => { active.cleanupFailed = true; record.status = 'uncertain'; record.error = 'Codex 程序停止結果待核對。'; }); }
      await active.cancellation?.catch(() => {});
      // A new thread has no durable conversation before its first dispatch.
      // Pausing during setup must allow the original input to start once later.
      if (active.unmaterializedThreadId === record.threadId && active.unmaterializedThreadId) {
        record.threadId = undefined; record.turnId = undefined; record.dispatchPending = false;
      }
      try {
        if (active.cleanupFailed) { record.status = 'uncertain'; record.error ??= '程序或工作流程停止結果待核對。'; }
        if (active.cleanupFailed) await lease?.quarantine(); else await lease?.release(sent);
      } catch { active.cleanupFailed = true; record.status = 'uncertain'; record.error = 'Codex 工作區鎖尚未釋放，請先核對程序狀態。'; }
      for (const extra of repositoryLeases) {
        try { if (active.cleanupFailed || record.status === 'uncertain') await extra.quarantine(); else await extra.release(); }
        catch { active.cleanupFailed = true; record.status = 'uncertain'; record.error = 'Repo 執行鎖尚未釋放，請先核對程序狀態。'; }
      }
      if (active.stopAs && record.status !== 'uncertain') record.status = active.stopAs;
      this.executions.delete(record.id);
      await reservation.release(record.status === 'uncertain' || !!active.cleanupFailed, !active.cleanupFailed).then(() => {
        if (record.lease && record.status !== 'uncertain' && !active.cleanupFailed) record.lease.released = true;
      }).catch(() => { record.status = 'uncertain'; record.error = '排程資源停止狀態待核對。'; });
      let saved = false;
      await this.save(record).then(() => { saved = true; }).catch(() => { this.emit({ kind: 'environment', environment: { state: 'blocked', message: 'Codex 任務紀錄無法保存；請先核對結果。' } }); });
      if (saved && record.lease?.released && record.lease.receipt) await CodexWorkspaceLease.clearReceipt(record.lease.receipt).catch(() => {});
      active.settle();
    }
  }
  private async executeRoutedReview(record: CodexTaskRecord, client: CodexAppServer, message: string): Promise<void> {
    const binding = record.spec.routing!;
    const model = binding.model ?? routingModel, efforts = binding.supportedEfforts ?? [...routingEfforts];
    const ordered = autoEfforts(efforts);
    const previousReviewer = record.modelRouting?.phase === 'reviewing' && record.threadId && record.routingThreadIds?.includes(record.threadId)
      ? { threadId: record.threadId, effort: record.modelRouting.effort } : undefined;
    try {
      let state = await readModelRouting(binding);
      if (record.pendingMessageIsUser) this.output(record.id, { id: 'followup-' + randomUUID(), kind: 'notice', text: '接續使用者的審查要求' });
      if (state?.phase === 'complete' && record.pendingMessageIsUser) {
        await requireRoutingEffort(client, state.effort!, model);
        await this.performRoutingTurn(record, client,
          `原生審查已發布，沿用現有固定報告回答使用者的後續要求。request_id=${binding.requestId}，報告=${JSON.stringify(state.report_path)}。保留原固定版本與審查結論。\n${message}`, state.effort!);
        record.modelRouting = routingSummary(binding, state); record.status = 'completed'; return;
      }
      if (record.pendingMessageIsUser && record.pendingMessage && !record.routingUserMessages?.includes(record.pendingMessage)) {
        (record.routingUserMessages ??= []).push(record.pendingMessage);
      }
      for (let round = 0; round <= efforts.length; round++) {
        if (this.active?.abort.signal.aborted) throw new Error('任務已停止。');
        record.modelRouting = routingSummary(binding, state); await this.save(record);
        if (state?.phase === 'complete') { record.status = 'completed'; return; }
        const phase = binding.requestedEffort === 'auto' && !state?.effort ? 'assess' : 'review';
        const effort = state?.effort ?? (binding.requestedEffort === 'auto' ? selectRoutingEffort('high', efforts).effort : binding.requestedEffort);
        await requireRoutingEffort(client, effort, model);
        const before = state;
        record.modelRouting = { ...routingSummary(binding, state), phase: phase === 'assess' ? 'assessing' : 'reviewing', effort };
        if (phase === 'review' && !(round === 0 && previousReviewer?.threadId === record.threadId && previousReviewer?.effort === effort)) {
          // A fresh reviewer context prevents the assessment's stop condition
          // from carrying into semantic review. A paused reviewer at the same
          // effort keeps its conversation and the native session identity.
          const started = await client.request('thread/start', { cwd: record.spec.executionRoot ?? record.root, model,
            approvalPolicy: 'on-request', approvalsReviewer: 'user', sandbox: 'workspace-write', developerInstructions: binding.reviewerInstructions });
          if (typeof started.thread?.id !== 'string') throw new Error('Codex 未傳回有效的 reviewer thread 識別。');
          record.routingThreadIds = [...new Set([...(record.routingThreadIds ?? []), record.threadId!, started.thread.id])];
          record.threadId = started.thread.id;
          this.active!.unmaterializedThreadId = record.threadId;
        }
        this.output(record.id, { id: 'routing-' + randomUUID(), kind: 'agent',
          text: `${phase === 'assess' ? '判斷審查風險' : '執行審查'} · ${model} ${effort}${state?.reason ? '\n' + state.reason : ''}` });
        const original = record.spec.prompt + (record.routingUserMessages?.length ? '\n\n使用者補充：\n' + record.routingUserMessages.join('\n') : '');
        const prompt = routingTurnPrompt(binding, phase, original, state);
        await this.performRoutingTurn(record, client, prompt, effort, phase);
        // A routing turn ending is an internal checkpoint, not task completion.
        record.status = 'running';
        state = await readModelRouting(binding);
        // Recoverable authoring work may span more than one model turn. Resume
        // the same reviewer at the same effort; never repeat an unknown dispatch.
        for (let repair = 0; phase === 'review' && state?.phase === 'reviewing' && state.effort === effort && repair < 2; repair++) {
          if (before && state.snapshot_hash !== before.snapshot_hash) break;
          this.output(record.id, { id: 'repair-' + randomUUID(), kind: 'agent', text: `沿用固定版本繼續修稿與驗證（${repair + 1}/2） · ${model} ${effort}` });
          await this.performRoutingTurn(record, client, prompt + '\n\n上一輪尚未保存完成或升級。先讀原生 status；已發布時驗證收據並 routing complete，保留既有報告。仍在審查時，請現在開啟草稿，將已讀固定證據上的實際判斷寫入 summary、coverage、findings 及必要工程欄位，執行 check 並修復可恢復診斷，再 finish 及 routing complete。生成的索引路徑可由交接資料、start.json 與 context 目錄查得；不要只回覆尚待執行的步驟。\n' +
            (record.routingUserMessages ?? []).join('\n'), effort, phase);
          state = await readModelRouting(binding);
        }
        if (!state || state.phase === 'routing') throw new Error('本輪未保存有效的路由決策；請沿原 request 核對。');
        if (before && (state.snapshot_hash !== before.snapshot_hash || state.revision <= before.revision)) {
          throw new Error(state.snapshot_hash !== before.snapshot_hash ? '固定來源已變更；請核對原始審查。'
            : '審查仍未完成；已保留同一 request 的草稿與固定證據，請核對缺口後續作。');
        }
        if (phase === 'assess' && state.phase !== 'reviewing') throw new Error('路由判斷不能代替正式審查。');
        if (phase === 'review' && state.phase !== 'complete' &&
            (binding.requestedEffort !== 'auto' || ordered.indexOf(state.effort!) <= ordered.indexOf(effort))) {
          throw new Error('正式審查尚未發布，且未保存有效的較高強度交接。');
        }
        if (state.phase === 'complete') {
          record.modelRouting = routingSummary(binding, state); record.status = 'completed'; return;
        }
      }
      throw new Error('Model Routing 超過有限的升級次數，請核對保存的進度。');
    } catch (error) {
      if (!this.active?.abort.signal.aborted && record.status !== 'uncertain') record.status = 'failed';
      throw error;
    }
  }
  private async performRoutingTurn(record: CodexTaskRecord, client: CodexAppServer, message: string,
    effort: string, phase?: 'assess' | 'review'): Promise<void> {
    if (this.active?.abort.signal.aborted) throw new Error('任務已停止。');
    const model = record.spec.routing?.model ?? routingModel;
    await requireRoutingEffort(client, effort, model);
    record.progress = { ...record.progress, model, effort, updatedAt: new Date().toISOString() };
    this.active!.turnStatus = undefined;
    record.status = 'running'; record.turnId = undefined; record.dispatchPending = true;
    record.dispatch = { id: randomUUID(), state: 'prepared', createdAt: new Date().toISOString() }; await this.save(record);
    const finished = new Promise<void>(resolve => { this.active!.finish = resolve; });
    const input: Record<string, string>[] = [{ type: 'text', text: message }];
    if (phase === 'assess') input.push({ type: 'skill', name: 'model-routing', path: record.spec.routing!.skillPath });
    if (phase === 'review') input.push({ type: 'skill', name: record.spec.skill!.name, path: record.spec.skill!.path });
    if (this.active?.abort.signal.aborted) throw new Error('任務已停止。');
    this.active!.unmaterializedThreadId = undefined;
    const result = await client.request('turn/start', { threadId: record.threadId, clientUserMessageId: record.dispatch!.id, input,
      model, effort, ...(phase === 'assess' ? { outputSchema: routingAssessmentOutputSchema } : {}),
      approvalPolicy: 'on-request', approvalsReviewer: 'user', cwd: record.spec.executionRoot ?? record.root,
      sandboxPolicy: { type: 'workspaceWrite', writableRoots: record.spec.writableRoots, networkAccess: false,
        excludeTmpdirEnvVar: false, excludeSlashTmp: false } });
    if (typeof result.turn?.id !== 'string') throw new Error('Codex 未傳回有效的路由回合識別，請先核對結果。');
    record.turnId = result.turn.id; if (record.dispatch) { record.dispatch.state = 'acknowledged'; record.dispatch.turnId = record.turnId; } record.dispatchPending = false; record.pendingMessage = undefined;
    record.pendingMessageIsUser = undefined; await this.save(record);
    await finished; await this.active?.steering?.catch(() => {});
    if (this.active?.turnStatus !== 'completed') throw new Error(record.error ?? 'Codex 路由回合未完成；已保留審查進度。');
  }
  private receiveNotification(record: CodexTaskRecord, message: RpcMessage): void {
    const active = this.executions.get(record.id);
    if (!this.records.has(record.id)) return;
    const params = message.params ?? {};
    if (params.threadId && params.threadId !== record.threadId) return;
    const eventTurnId = params.turnId ?? params.turn?.id;
    if (eventTurnId && record.turnId && eventTurnId !== record.turnId && !(record.goal?.status === 'active' && message.method === 'turn/started')) return;
    if (message.method === 'thread/goal/updated' && record.goal && params.goal?.objective === record.goal.objective) {
      const goal = params.goal;
      if (['active', 'paused', 'blocked', 'usageLimited', 'budgetLimited', 'complete'].includes(goal.status)) record.goal.status = goal.status;
      if (Number.isSafeInteger(goal.tokensUsed) && goal.tokensUsed >= 0) record.goal.tokensUsed = goal.tokensUsed;
      this.scheduleProgress(record);
      if (record.goal.status !== 'active' && active?.turnStatus) active.finish?.();
    }
    const progress = projectCodexProgress(record.progress, message.method ?? '', params);
    if (progress) { record.progress = progress; this.scheduleProgress(record); }
    if (message.method === 'turn/started') {
      record.turnId = params.turn?.id; if (active) active.turnStatus = undefined;
      for (const item of params.turn?.items ?? []) {
        const output = projectCodexItem(record.threadId, record.turnId, item); if (output) this.output(record.id, output);
      }
    }
    if (message.method === 'item/agentMessage/delta') this.output(record.id, { id: params.itemId, kind: 'agent', text: safeText(params.delta) }, true);
    if (message.method === 'item/commandExecution/outputDelta') this.output(record.id, { id: params.itemId, kind: 'command', text: safeText(params.delta) }, true);
    if (message.method === 'item/started' || message.method === 'item/completed') {
      const item = params.item ?? {};
      const output = projectCodexItem(record.threadId, record.turnId, item, message.method === 'item/completed');
      if (output) {
        if (item.type === 'commandExecution' && item.aggregatedOutput == null) {
          output.text = this.outputs.get(record.id)?.find(value => codexOutputKey(value) === codexOutputKey(output))?.text ?? '';
        }
        this.output(record.id, output);
      }
    }
    if (message.method === 'serverRequest/resolved') {
      for (const [key, value] of this.interactions) if (value.request.id === params.requestId && value.projection.taskId === record.id) this.interactions.delete(key);
      if (record.status === 'waiting' && ![...this.interactions.values()].some(value => value.projection.taskId === record.id)) {
        record.status = 'running'; void this.save(record).catch(() => {});
      }
      this.publishInteractions(record.id);
    }
    if (message.method === 'turn/completed') {
      if (active) active.turnStatus = params.turn?.status;
      if (!active?.stopAs) record.status = params.turn?.status === 'completed' ? record.spec.routing || implementationTask(record.spec) || record.goal?.status === 'active' ? 'running' : 'completed' : params.turn?.status === 'interrupted' ? 'interrupted' : 'failed';
      for (const item of params.turn?.items ?? []) {
        const output = projectCodexItem(record.threadId, params.turn?.id ?? record.turnId, item, true); if (output) this.output(record.id, output);
      }
      if (params.turn?.error) {
        const info = params.turn.error.codexErrorInfo;
        const error = CodexRpcError.from('turn/start', { code: -32000, data: { type: typeof info === 'string' ? info : info?.type } });
        record.error = error.message;
        if (error.category === 'quota') record.progress = { ...record.progress, waitReason: 'quota' };
      }
      if (record.dispatch) { record.dispatch.state = 'completed'; record.dispatch.turnId = params.turn?.id; }
      record.dispatchPending = false; this.clearInteractions(record.id);
      if (record.goal?.status !== 'active' || params.turn?.status !== 'completed') active?.finish?.();
    }
  }
  private receiveInteraction(record: CodexTaskRecord, client: CodexAppServer, request: RpcMessage): void {
    const active = this.executions.get(record.id);
    const params = request.params ?? {};
    if (!this.records.has(record.id) || active?.abort.signal.aborted || request.id === undefined || params.threadId !== record.threadId || params.turnId && record.turnId && params.turnId !== record.turnId) {
      if (request.id !== undefined) client.reject(request.id); return;
    }
    const seen = this.seenRequests.get(client) ?? new Set<string>(), requestKey = JSON.stringify(request.id);
    if (seen.has(requestKey)) return;
    seen.add(requestKey); this.seenRequests.set(client, seen);
    let kind: CodexInteraction['kind'] | undefined;
    if (request.method === 'item/commandExecution/requestApproval') kind = 'command';
    else if (request.method === 'item/fileChange/requestApproval') kind = 'file';
    else if (request.method === 'item/permissions/requestApproval') kind = 'permissions';
    else if (request.method === 'item/tool/requestUserInput' || request.method === 'tool/requestUserInput') kind = 'questions';
    else if (request.method === 'mcpServer/elicitation/request') kind = params.mode === 'url' ? 'url' : ['form', 'openai/form', 'openaiForm'].includes(params.mode) ? 'form' : undefined;
    if (!kind) {
      client.reject(request.id); record.error = 'Codex 要求目前未支援的互動，已停止本輪。';
      void this.cancel(record.id).catch(() => {}); return;
    }
    const id = randomUUID();
    const projection: CodexInteraction = { id, taskId: record.id, kind, title: safeText(params.reason ?? params.message) || ({ command: '核准命令執行', file: '核准檔案變更', permissions: '核准額外權限', questions: 'Codex 需要你的回答', form: '工具需要填寫資料', url: '工具需要開啟連結' })[kind],
      detail: kind === 'permissions' ? JSON.stringify(params.permissions, null, 2) : kind === 'file' ? safeText(params.grantRoot) || this.outputs.get(record.id)?.find(item => item.id === params.itemId)?.text
        : params.networkApprovalContext ? `網路存取：${safeText(params.networkApprovalContext.host)} · ${safeText(params.networkApprovalContext.protocol)}` : safeText(params.command ?? params.cwd),
      questions: kind === 'questions' ? (params.questions ?? []).map((question: any) => ({ id: question.id, question: question.question, isSecret: question.isSecret, options: question.options ?? undefined })) : undefined,
      schema: kind === 'form' ? params.requestedSchema : undefined, url: kind === 'url' ? params.url : undefined };
    this.interactions.set(id, { projection, request, client }); record.status = 'waiting';
    record.progress = { ...record.progress, waitReason: 'approval' };
    void this.save(record).catch(() => {}); this.publishInteractions(record.id);
    void this.autoAnswer(this.interactions.get(id)!);
  }
  async answer(taskId: string, interactionId: string, answer: CodexInteractionAnswer, automatic = false): Promise<void> {
    this.requireTrusted();
    const pending = this.interactions.get(interactionId), active = this.executions.get(taskId);
    if (!pending || pending.responding || !active || active.abort.signal.aborted || active.record.id !== taskId || pending.projection.taskId !== taskId || pending.client !== active.client) throw new Error('此 Codex 互動已失效，請重新讀取任務。');
    if (!answer || !['accept', 'decline', 'cancel'].includes(answer.decision)) throw new Error('Codex 回覆格式無效。');
    const params = pending.request.params ?? {};
    let result: unknown;
    if (pending.projection.kind === 'questions') {
      if (answer.decision !== 'accept') { await this.cancel(taskId); return; }
      const answers: Record<string, { answers: string[] }> = {};
      for (const question of pending.projection.questions ?? []) {
        const text = answer.answers?.[question.id];
        if (typeof text !== 'string' || !text.trim() || text.length > 8000) throw new Error('請回答所有 Codex 問題。');
        answers[question.id] = { answers: [text] };
      }
      result = { answers };
    } else if (pending.projection.kind === 'form' || pending.projection.kind === 'url') {
      if (answer.decision === 'accept' && pending.projection.kind === 'form') validateForm(pending.projection.schema, answer.content);
      result = { action: answer.decision, content: answer.decision === 'accept' && pending.projection.kind === 'form' ? answer.content : null };
    } else if (pending.projection.kind === 'permissions') result = { permissions: answer.decision === 'accept' ? params.permissions ?? {} : {}, scope: 'turn' };
    else result = { decision: answer.decision };
    pending.responding = true;
    try { pending.client.respond(pending.request.id!, result); }
    catch (error) { pending.responding = false; throw error; }
    this.interactions.delete(interactionId);
    active.record.status = [...this.interactions.values()].some(value => value.projection.taskId === taskId) ? 'waiting' : 'running';
    await this.save(active.record); this.publishInteractions(taskId);
    if (automatic) {
      this.output(taskId, { id: 'approval-' + interactionId, kind: 'notice', text: `已自動核准：${{ command: '操作執行', file: '檔案變更', permissions: '本回合額外權限', questions: '', form: '', url: '' }[pending.projection.kind]}` });
      this.options.approved?.({ taskId, threadId: active.record.threadId, turnId: active.record.turnId,
        requestId: pending.request.id!, kind: pending.projection.kind, scope: pending.projection.kind === 'permissions' ? 'turn' : 'once' });
    }
  }
  private publishInteractions(taskId: string): void { this.emit({ kind: 'interactions', taskId, interactions: [...this.interactions.values()].filter(value => value.projection.taskId === taskId).map(value => value.projection) }); }
  private clearInteractions(taskId: string): void { for (const [id, value] of this.interactions) if (value.projection.taskId === taskId) this.interactions.delete(id); this.publishInteractions(taskId); }
  private output(taskId: string, item: CodexOutputItem, append = false): void {
    const record = this.records.get(taskId);
    if (!record || !item.id) return;
    item = { ...item, threadId: item.threadId ?? record.threadId, turnId: item.turnId ?? record.turnId };
    const items = this.outputs.get(taskId) ?? [], previous = items.find(value => codexOutputKey(value) === codexOutputKey(item));
    if (previous) {
      if (append && previous.final) return;
      const updated = (append ? previous.text + item.text : item.text).slice(-64_000);
      Object.assign(previous, item, { text: updated });
    }
    else items.push({ ...item, text: item.text.slice(-64_000) });
    while (items.length > 100 || items.reduce((sum, value) => sum + codexItemBytes(value), 0) > 512_000) items.shift();
    this.outputs.set(taskId, items);
    if (!this.outputTimers.has(taskId)) this.outputTimers.set(taskId, setTimeout(() => {
      this.outputTimers.delete(taskId); this.emit({ kind: 'output', taskId, items: this.outputs.get(taskId) ?? [], replace: true });
    }, 75));
  }
  private historyKey(record: CodexTaskRecord, cursor?: string): string {
    return record.id + '\0' + JSON.stringify([record.root, record.threadId, record.turnId, record.updatedAt, record.status, cursor ?? '']);
  }
  private loadHistory(record: CodexTaskRecord, client: CodexAppServer, cursor?: string): Promise<boolean> {
    // Execution reads follow a turn/steer and intentionally bypass older pages.
    return this.readHistory(record, cursor, true, client);
  }
  private async readHistory(record: CodexTaskRecord, cursor?: string, force = false, borrowed?: CodexAppServer, signal?: AbortSignal): Promise<boolean> {
    const key = this.historyKey(record, cursor), threadId = record.threadId, root = record.root;
    const page = await this.historyPages.get(key, async readSignal => {
      const readVersion = ++this.historySequence;
      if (this.disposed || readSignal.aborted || !this.records.has(record.id)) throw abortedReadError();
      const shared = borrowed ?? this.executions.get(record.id)?.client;
      const client = shared ?? (await this.makeClient(root)).client;
      const abort = () => { if (!shared) void client.close(); };
      readSignal.addEventListener('abort', abort, { once: true });
      try {
        if (readSignal.aborted) throw abortedReadError();
        const turns = await client.request('thread/turns/list', { threadId, limit: 10, sortDirection: 'desc', itemsView: 'full', ...(cursor ? { cursor } : {}) }, { signal: readSignal });
        const items: CodexOutputItem[] = [];
        for (const turn of [...turns.data ?? []].reverse()) for (const item of turn.items ?? []) {
          const output = projectCodexItem(threadId, turn.id, item, ['completed', 'interrupted', 'failed'].includes(turn.status));
          if (output) items.push(output);
        }
        return { items, nextCursor: turns.nextCursor as string | undefined, hasTurns: (turns.data ?? []).length > 0, readVersion };
      } finally {
        readSignal.removeEventListener('abort', abort);
        if (!shared) await client.close();
      }
    }, { force, signal });
    const current = this.records.get(record.id);
    if (!this.disposed && current && this.historyKey(current, cursor) === key && page.readVersion >= (this.historyApplied.get(key) ?? 0)) {
      this.historyApplied.delete(key); this.historyApplied.set(key, page.readVersion);
      while (this.historyApplied.size > 256) this.historyApplied.delete(this.historyApplied.keys().next().value!);
      const previous = this.histories.get(record.id);
      this.histories.set(record.id, {
        items: mergeCodexTranscript(previous?.items ?? [], page.items, true),
        cursor: cursor ?? previous?.cursor,
        nextCursor: !cursor && previous?.cursor ? previous.nextCursor : page.nextCursor ?? undefined
      });
      const bounded = boundTranscriptCache(Object.fromEntries([...this.histories].map(([id, value]) => [id, value.items])), record.id, undefined,
        cursor && page.items[0] ? codexOutputKey(page.items[0]) : undefined);
      for (const id of bounded.evicted) {
        this.histories.delete(id); this.emit({ kind: 'history', taskId: id, items: [], evicted: true });
      }
      if (bounded.trimmed) this.histories.get(record.id)!.items = bounded.cache[record.id];
      if (bounded.trimmed) {
        this.emit({ kind: 'history', taskId: record.id, items: bounded.cache[record.id], nextCursor: page.nextCursor ?? undefined, cursor, reset: true });
        return page.hasTurns;
      }
      this.emit({ kind: 'history', taskId: record.id, items: page.items, nextCursor: page.nextCursor ?? undefined, cursor });
    }
    return page.hasTurns;
  }
  async history(id: string, cursor?: string, force = false, signal?: AbortSignal): Promise<void> {
    await this.initialize(); const record = this.record(id);
    if (cursor !== undefined && (typeof cursor !== 'string' || cursor.length > 8192)) throw new Error('Codex 對話游標無效。');
    if (!record.threadId) return;
    await this.readHistory(record, cursor, force, undefined, signal);
  }
  async message(id: string, text: string): Promise<void> {
    this.requireTrusted(); await this.initialize(); const record = this.record(id);
    if (typeof text !== 'string' || !text.trim() || text.length > 32_000 || text.includes('\0')) throw new Error('請輸入 1 到 32,000 字的 Codex 訊息。');
    if (this.executions.get(id)?.client && record.turnId && record.status === 'running') {
      const active = this.executions.get(id)!;
      if (record.spec.routing && (record.routingUserMessages ?? []).reduce((sum, item) => sum + item.length, text.length) > 128_000) {
        throw new Error('本次審查的補充內容已達保存上限，請另開工作。');
      }
      const steer = active.client!.request('turn/steer', { threadId: record.threadId, expectedTurnId: record.turnId, input: [{ type: 'text', text }] })
        .then(async () => { if (record.spec.routing) { (record.routingUserMessages ??= []).push(text); await this.save(record); } });
      if (record.spec.routing) active.steering = steer;
      await steer;
      this.output(id, { id: 'steer-' + randomUUID(), kind: 'notice', text: '已傳送補充要求' });
      await this.loadHistory(record, active.client!).catch(() => {}); return;
    }
    if (codexTaskActive(record.status) || record.status === 'queued') throw new Error('此任務仍在執行或等待互動，請先完成目前步驟。');
    const previous = record.pendingMessage;
    const previousOrigin = record.pendingMessageIsUser;
    record.pendingMessage = text;
    record.pendingMessageIsUser = true;
    try { await this.resume(id); } catch (error) { record.pendingMessage = previous; record.pendingMessageIsUser = previousOrigin; throw error; }
  }
  async resume(id: string): Promise<void> {
    this.requireTrusted(); await this.initialize();
    const previous = this.record(id), pending = previous.pendingMessageIsUser ? previous.pendingMessage : undefined;
    await this.store.control(id, async () => {
      await this.reload();
      this.controlling.add(id);
      try { await this.resumeNow(id, pending); } finally { this.controlling.delete(id); }
    });
  }
  private async resumeNow(id: string, pending?: string): Promise<void> {
    const record = this.record(id);
    if (record.publication?.state === 'pending') throw new Error('請先核對 MR 發布結果再接續。');
    if (record.result?.state === 'uncertain') throw new Error('請先核對 Wiki 發布結果，再接續修改草稿。');
    if (codexTaskActive(record.status) || record.status === 'queued' || this.executions.has(id)) throw new Error('此任務已在執行、清理或排隊。');
    const prepared = await this.options.prepare(record.spec.source, record.spec);
    if (prepared.environmentKey !== record.spec.environmentKey || prepared.root !== record.root) throw new Error('原任務的專案或 Skills 已變更，請從功能頁重新確認。');
    if (pending !== undefined) { record.pendingMessage = pending; record.pendingMessageIsUser = true; }
    if (record.threadId) record.pendingMessage ??= `請先核對這個對話的已執行工作、目前產物與狀態，接續原任務「${record.title}」尚未完成的工作；避免重複送出已完成操作。` +
      (record.spec.review ? ` 保留原審查 request ID 與固定證據。本次 Workbench 審查 request ID 為 ${record.spec.review.requestId}（32 碼十六進位）；以此識別核對 helper。已有 job 時沿用原固定證據，尚未建立 job 才依原輸入啟動。` : '') +
      '\n\n原始任務（先核對已完成進度，僅接續未完成部分）：\n' + record.spec.prompt;
    record.status = 'queued'; record.ownerPid = process.pid; record.turnId = undefined; record.error = undefined; this.owned.add(id);
    await this.save(record); this.queue.push(id); this.schedule();
  }
  async cancel(id: string): Promise<void> {
    await this.stop(id, 'interrupted');
  }
  async pause(id: string): Promise<void> {
    this.requireTrusted(); await this.stop(id, 'paused');
  }
  private async stop(id: string, target: 'paused' | 'interrupted'): Promise<void> {
    await this.initialize(); const record = this.record(id);
    if (this.executions.has(id) && (codexTaskActive(record.status) || record.status === 'queued')) {
      const active = this.executions.get(id)!;
      active.stopAs ??= target;
      // Stop automatic responses synchronously, before any persistence or RPC awaits.
      active.abort.abort();
      active.cancellation ??= (async () => {
        try {
          record.status = 'pausing'; await this.save(record);
          if (active.client && record.goal && record.threadId && active.version && codexCapabilities(active.version).goals) {
            await new CodexProtocolAdapter(active.client, active.version).setGoal({ threadId: record.threadId, origin: 'user', status: 'paused' });
            record.goal.status = 'paused';
          }
          if (active.client && record.turnId) {
            try { await active.client.request('turn/interrupt', { threadId: record.threadId, turnId: record.turnId }); }
            catch { record.error = '中斷結果待核對。'; }
          }
          // Keep workspace admission until both the process and helper have stopped.
          if (active.client) { active.client.onExit = () => {}; await active.client.close(record.spec.routing || record.spec.workflow ? 30_000 : 5000); }
          if (record.spec.review) await this.options.cancelReview?.(record.spec);
        } catch {
          active.cleanupFailed = true;
          record.status = 'uncertain'; record.error = 'Codex 已停止，但審查 helper 的取消結果待核對。';
        } finally { active.finish?.(); }
      })();
      await active.settled;
      return;
    } else if (record.status === 'queued' && this.queue.includes(id)) { this.queue = this.queue.filter(value => value !== id); record.status = target; }
    else if (codexTaskActive(record.status) || record.status === 'queued') throw new Error('此任務由另一個 VS Code 視窗執行，請至原視窗控制。');
    else return;
    this.clearInteractions(id); await this.save(record);
  }
  async delete(id: string): Promise<void> {
    this.requireTrusted(); await this.initialize(); await this.reload();
    if (await this.store.isDeleted(id)) { await this.store.remove(id); this.forget(id); return; }
    const state = this.list().find(task => task.id === id);
    if (!state?.controls?.canDelete) throw new Error('請先暫停任務並確認清理完成，再刪除紀錄。');
    try {
      await this.store.control('workflow-admission', () => this.store.remove(id, record => this.preserveWikiDependencies(record)));
    } finally {
      if (await this.store.isDeleted(id)) this.forget(id);
      await this.reload(); this.emit({ kind: 'tasks', tasks: this.list() });
      this.emit({ kind: 'environment', environment: { ...this.environment, storageProblems: this.store.problems } });
    }
  }
  private async captureWikiSeed(spec: CodexTaskSpec): Promise<void> {
    const workflow = spec.workflow, incremental = workflow?.wikiIncremental;
    if (!workflow || !incremental || !spec.origin) return;
    const runtime = path.join(this.options.storage, 'codex-workflows', workflow.id);
    if (path.resolve(workflow.runtimeRoot) !== path.resolve(runtime)) throw new Error('Wiki 種子不在所屬儲存區。');
    await new ProjectWikiStore(path.join(this.options.storage, 'project-wiki-drafts')).copySeed(incremental.previousDraftId,
      { ...spec.origin, sourceSha: incremental.baseSha }, this.options.storage, runtime);
  }
  private async preserveWikiDependencies(record: CodexTaskRecord): Promise<void> {
    if (record.spec.origin?.kind !== 'project-wiki' || !record.spec.workflow) return;
    await new ProjectWikiStore(path.join(this.options.storage, 'project-wiki-drafts')).assertDeletable(record.spec.workflow.id, record.spec.origin);
    const records = await this.store.load();
    if (this.store.problems.some(problem => problem.kind !== 'cleanup')) throw new Error('請先核對損壞紀錄，才能確認 Wiki 引用。');
    for (const other of records) if (other.id !== record.id && other.spec.workflow?.wikiIncremental?.previousDraftId === record.spec.workflow.id) {
      await this.store.control(other.id, () => this.captureWikiSeed(other.spec));
    }
  }
  private async cleanupStorage(plan: CodexCleanupPlan): Promise<void> {
    const references = await this.store.load();
    if (plan.spec.workflow && references.some(record => record.spec.workflow?.runtimeRoot === plan.spec.workflow!.runtimeRoot)) throw new Error('其他對話仍在使用這份工作流程資料。');
    const admission = await this.scheduler.tryAcquire('delete-' + plan.id, plan.spec, 2);
    if (!admission.reservation) throw new Error('其他任務正在使用所屬資源，刪除清理待重試。');
    const reservation = admission.reservation; let uncertain = false;
    try { await cleanupTaskStorage(this.options.storage, plan); }
    catch (error) { uncertain = !!error && typeof error === 'object' && 'workflowCleanupUncertain' in error; throw error; }
    finally {
      for (const lease of [reservation.primary, ...reservation.extras]) { if (uncertain) await lease.quarantine(); else await lease.release(); }
      await reservation.release(uncertain);
    }
  }
  private forget(id: string): void {
    this.deleted.add(id);
    this.records.delete(id); this.persisted.delete(id); this.owned.delete(id); this.outputs.delete(id); this.histories.delete(id);
    this.historyPages.invalidateWhere(key => key.startsWith(id + '\0'));
    for (const key of this.historyApplied.keys()) if (key.startsWith(id + '\0')) this.historyApplied.delete(key);
    this.autoAccept.delete(id); this.autoAcceptErrors.delete(id); this.approvals.delete(id); this.diagnostics.delete(id);
    const progressTimer = this.progressTimers.get(id); if (progressTimer) clearTimeout(progressTimer); this.progressTimers.delete(id);
    this.queue = this.queue.filter(value => value !== id);
    const timer = this.outputTimers.get(id); if (timer) clearTimeout(timer); this.outputTimers.delete(id);
    this.clearInteractions(id);
  }
  async setAutoAccept(id: string, enabled: boolean): Promise<void> {
    this.requireTrusted(); await this.initialize(); this.record(id);
    if (typeof enabled !== 'boolean') throw new Error('Auto-Accept 設定無效。');
    if (!this.list().find(task => task.id === id)?.controls?.canAutoAccept) throw new Error('此任務目前無法設定自動核准，請至執行視窗核對狀態。');
    if (enabled) this.autoAccept.add(id); else this.autoAccept.delete(id);
    this.autoAcceptErrors.delete(id); this.emit({ kind: 'tasks', tasks: this.list() });
    if (enabled) for (const pending of this.interactions.values()) if (pending.projection.taskId === id) await this.autoAnswer(pending);
  }
  private async autoAnswer(pending: PendingInteraction): Promise<void> {
    const id = pending.projection.taskId, active = this.executions.get(pending.projection.taskId);
    if (!this.autoAccept.has(id) || !active || active.record.id !== id || active.abort.signal.aborted || pending.responding ||
        !this.interactions.has(pending.projection.id) || !['command', 'file', 'permissions'].includes(pending.projection.kind)) return;
    const settings = this.approvals.get(id) ?? active.record.approvalSettings ?? { command: true, file: true, permissions: true };
    if (!settings[pending.projection.kind as keyof CodexApprovalSettings]) return;
    const choices = pending.request.params?.availableDecisions;
    if (pending.projection.kind !== 'permissions' && Array.isArray(choices) && !choices.includes('accept')) return;
    try {
      await this.answer(id, pending.projection.id, { decision: 'accept' }, true);
    } catch {
      this.autoAccept.delete(id);
      this.autoAcceptErrors.set(id, '自動核准未完成，已關閉 Auto-Accept；請核對要求後手動處理。');
      this.emit({ kind: 'tasks', tasks: this.list() });
    }
  }
  private record(id: string): CodexTaskRecord { if (!validTaskId(id) || !this.records.has(id)) throw new Error('找不到 Codex 任務。'); return this.records.get(id)!; }
  private errorText(error: unknown): string { return error instanceof Error ? error.message : 'Codex 執行失敗，請重新檢查本機環境。'; }
  async hasConflict(root: string): Promise<boolean> {
    await this.initialize();
    const target = await realpath(root).catch(() => path.resolve(root));
    return [...this.records.values()].some(record => codexTaskActive(record.status) && alive(record.ownerPid) &&
      (codexRootKey(record.root) === codexRootKey(target) || record.spec.writableRoots.some(writable => {
        const relative = path.relative(writable, target); return !path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`);
      })));
  }
  dispose(): void { void this.shutdown(); }
  shutdown(): Promise<void> {
    return this.shutdownTask ??= (async () => {
      this.disposed = true;
      this.historyPages.clear();
      this.historyApplied.clear();
      this.watcher?.close(); if (this.reloadTimer) clearTimeout(this.reloadTimer);
      for (const timer of this.outputTimers.values()) clearTimeout(timer);
      for (const timer of this.progressTimers.values()) clearTimeout(timer);
      if (this.retryTimer) clearTimeout(this.retryTimer);
      await Promise.allSettled([...this.executions.keys()].map(id => this.cancel(id)));
      await Promise.allSettled([...this.executionTasks]);
      await this.processingTask;
      await Promise.allSettled([...this.connecting]);
      await Promise.allSettled([...this.clients].map(client => client.close()));
      for (const id of this.queue) { const record = this.records.get(id)!; record.status = 'interrupted'; await this.save(record); }
      this.queue = []; await this.store.flush();
    })();
  }
}
