import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import { watch, type FSWatcher } from 'node:fs';
import { CodexAppServer, type RpcMessage } from './appServer';
import { resolveCodexExecutable, spawnCodex } from './process';
import { CodexTaskDeletedError, CodexTaskStore, codexRootKey, validTaskId } from './taskStore';
import { networkRuntimeRoot } from '../api/localNetworkLease';
import { CodexWorkspaceLease } from './workspaceLease';
import { validateForm } from './forms';
import { mergeCodexTranscript, projectCodexItem } from './transcript';
import { readModelRouting, requireRoutingEffort, routingModel, routingEfforts, routingSummary,
  routingTurnPrompt, routingAssessmentOutputSchema } from './modelRouting';
export { validateForm } from './forms';
import { codexTaskActive, codexOutputKey, projectCodexTask, type CodexEnvironment, type CodexEvent, type CodexInteraction,
  type CodexInteractionAnswer, type CodexOutputItem, type CodexTaskRecord, type CodexTaskSpec, type CodexTaskState } from './protocol';

interface PendingInteraction { projection: CodexInteraction; request: RpcMessage; client: CodexAppServer; responding?: boolean; }
interface ActiveExecution {
  record: CodexTaskRecord; client?: CodexAppServer; abort: AbortController; finish?: () => void;
  cancellation?: Promise<void>; turnStatus?: string; steering?: Promise<void>;
  stopAs?: 'paused' | 'interrupted'; settled: Promise<void>; settle(): void;
  cleanupFailed?: boolean;
  unmaterializedThreadId?: string;
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
  completed?(spec: CodexTaskSpec): Promise<void>;
  approved?(event: { taskId: string; threadId?: string; turnId?: string; requestId: number | string; kind: string; scope: 'once' | 'turn' }): void;
  client?(root: string): Promise<{ client: CodexAppServer; version: string; executable: string }>;
}
const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code !== 'ESRCH'; } };
const safeText = (value: unknown, limit = 20_000): string => typeof value === 'string' ? value.slice(0, limit) : '';
export class CodexBridge {
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
  private interactions = new Map<string, PendingInteraction>();
  private queue: string[] = [];
  private active?: ActiveExecution;
  private autoAccept = new Set<string>();
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
  constructor(private readonly options: CodexBridgeOptions) { this.store = new CodexTaskStore(path.join(options.storage, 'codex-tasks')); }
  initialize(): Promise<void> {
    return this.initialized ??= this.store.load().then(async records => {
      for (const record of records) {
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
        this.watcher.on('error', () => { this.watcher?.close(); });
      }
    });
  }
  private async reload(): Promise<void> {
    if (this.disposed) return;
    const sequence = ++this.reloadSequence, knownIds = new Set(this.records.keys());
    const records = await this.store.load(), ids = new Set(records.map(record => record.id));
    if (this.disposed || sequence !== this.reloadSequence) return;
    for (const id of knownIds) if (!ids.has(id) && this.active?.record.id !== id && !this.queue.includes(id) && !this.controlling.has(id)) this.forget(id);
    for (const record of records) if (!this.deleted.has(record.id) && this.active?.record.id !== record.id && !this.queue.includes(record.id) && !this.controlling.has(record.id)) {
      const current = this.persisted.get(record.id);
      if (current && (record.updatedAt < current.updatedAt || record.updatedAt === current.updatedAt && record.ownerPid === process.pid && this.owned.has(record.id))) continue;
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
      const settling = this.active?.record.id === value.id || this.controlling.has(value.id);
      return { ...structuredClone(value), controls: {
        external, canPause: busy && !external && value.status !== 'pausing',
        canResume: !busy && !settling, canDelete: !busy && !settling && value.status !== 'uncertain',
        canAutoAccept: !external && value.status !== 'pausing', autoAccept: this.autoAccept.has(value.id),
        autoAcceptError: this.autoAcceptErrors.get(value.id)
      } };
    });
  }
  async publish(): Promise<void> {
    await this.initialize(); await this.reload(); this.emit({ kind: 'environment', environment: this.environment });
    for (const [taskId, history] of this.histories) this.emit({ kind: 'history', taskId, ...history });
    for (const [taskId, items] of this.outputs) this.emit({ kind: 'output', taskId, items, replace: true });
    for (const taskId of new Set([...this.interactions.values()].map(value => value.projection.taskId))) this.publishInteractions(taskId);
  }
  private emit(event: CodexEvent): void { if (!this.disposed) this.options.event(event); }
  private async save(record: CodexTaskRecord): Promise<void> {
    record.updatedAt = new Date().toISOString();
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
    this.requireTrusted(); await this.initialize();
    if (!validTaskId(operationId)) throw new Error('Codex 任務識別無效。');
    if (this.records.has(operationId)) { await this.publish(); return operationId; }
    const now = new Date().toISOString();
    const record: CodexTaskRecord = { schema: 'GitLabWorkspaceCodexTask/v1', id: operationId, spec, title: spec.title,
      root: spec.root, review: spec.review, status: 'queued', ownerPid: process.pid, createdAt: now, updatedAt: now };
    await this.store.save(record); this.records.set(record.id, record); this.owned.add(record.id); this.queue.push(record.id);
    this.persisted.set(record.id, structuredClone(projectCodexTask(record)));
    this.emit({ kind: 'tasks', tasks: this.list() }); this.schedule(); return record.id;
  }
  private requireTrusted(): void {
    if (this.disposed) throw new Error('Codex Bridge 已關閉。');
    if (!this.options.trusted()) throw new Error('請先信任此 VS Code 工作區，才能執行 Codex。');
  }
  private async makeClient(root: string, lease?: CodexWorkspaceLease) {
    this.requireTrusted();
    if (this.options.client) return this.options.client(root);
    const executable = await resolveCodexExecutable(this.options.executable(), root);
    const client = new CodexAppServer(spawnCodex(executable.file, root, await lease?.processReceipt()));
    try { await client.initialize(this.options.version); }
    catch (error) { await client.close(); throw error; }
    return { client, version: executable.version, executable: executable.file };
  }
  private async inspect(client: CodexAppServer, version: string, executable: string): Promise<CodexEnvironment> {
    const auth = await client.request('account/read', { refreshToken: false });
    const authenticated = !auth.requiresOpenaiAuth || !!auth.account;
    const sandbox = process.platform === 'win32' ? (await client.request('windowsSandbox/readiness')).status : 'ready';
    const requirements = (await client.request('configRequirements/read')).requirements;
    const permitted = (!requirements?.allowedApprovalPolicies || requirements.allowedApprovalPolicies.includes('on-request')) &&
      (!requirements?.allowedSandboxModes || requirements.allowedSandboxModes.includes('workspace-write'));
    return { state: authenticated && sandbox === 'ready' && permitted ? 'ready' : 'blocked', authenticated, sandbox, version, executable,
      message: !authenticated ? '請先登入 Codex。' : sandbox !== 'ready' ? '請先完成 Codex Windows sandbox 設定。'
        : !permitted ? 'Codex 管理政策不允許 workspace-write／on-request，請洽管理員核對設定。' : 'Codex 已準備完成；啟用 Routing 的審查使用 GPT-6 Luna，其餘任務沿用本機模型。' };
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
    finally { await client?.close(); this.emit({ kind: 'environment', environment: this.environment }); }
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
      while (this.queue.length && !this.disposed) {
        const record = this.records.get(this.queue.shift()!);
        if (!record || record.status !== 'queued') continue;
        await this.execute(record);
      }
    } finally { this.processing = false; }
  }
  private schedule(): void { if (!this.processing && !this.disposed) this.processingTask = this.pump(); }
  private async execute(record: CodexTaskRecord): Promise<void> {
    let settle!: () => void;
    const active: ActiveExecution = { record, abort: new AbortController(), settled: new Promise(resolve => { settle = resolve; }), settle: () => settle() };
    this.active = active;
    let lease: CodexWorkspaceLease | undefined;
    let sent = false;
    try {
      const directory = path.join(networkRuntimeRoot(), 'codex-workspaces', codexRootKey(await realpath(record.root)) + '.lock');
      while (!lease) {
        try { lease = await CodexWorkspaceLease.acquire(directory, { signal: active.abort.signal, timeoutMs: 30_000 }); }
        catch (error) { if ((error as Error).name !== 'TimeoutError') throw error; }
      }
      if (active.abort.signal.aborted) throw new Error('任務已停止。');
      this.requireTrusted();
      const prepared = await this.options.prepare(record.spec.source, record.spec);
      if (prepared.environmentKey !== record.spec.environmentKey || prepared.root !== record.root) throw new Error('專案或 Skills 環境已變更，請重新確認表單再建立任務。');
      record.status = 'starting'; record.error = undefined; await this.save(record);
      const connection = await this.makeClient(record.root, lease); active.client = connection.client;
      const client = connection.client;
      if (active.abort.signal.aborted) throw new Error('任務已停止。');
      this.environment = await this.inspect(client, connection.version, connection.executable);
      this.emit({ kind: 'environment', environment: this.environment });
      if (this.environment.state !== 'ready') throw new Error(this.environment.message);
      if (active.abort.signal.aborted) throw new Error('任務已停止。');
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
        await client.request('thread/resume', { threadId: record.threadId, cwd: record.root, approvalPolicy: 'on-request', approvalsReviewer: 'user', sandbox: 'workspace-write', excludeTurns: true });
        hasPriorTurns = await this.loadHistory(record, client);
        if (!hasPriorTurns && record.dispatchPending) throw new Error('先前送出結果不明，且無法讀取已保存的回合；請先核對本機 Codex 與產物，不會自動重送。');
      } else {
        const started = await client.request('thread/start', { cwd: record.root, approvalPolicy: 'on-request', approvalsReviewer: 'user', sandbox: 'workspace-write' });
        if (typeof started.thread?.id !== 'string') throw new Error('Codex 未傳回有效的 thread 識別。');
        record.threadId = started.thread.id; active.unmaterializedThreadId = record.threadId; await this.save(record);
      }
      const skills = await client.request('skills/list', { cwds: [record.root], forceReload: true });
      const found = skills.data?.flatMap((entry: any) => entry.skills ?? []).some((skill: any) =>
        skill.name === record.spec.skill.name && skill.enabled !== false && typeof skill.path === 'string' && path.resolve(skill.path).toLowerCase() === path.resolve(record.spec.skill.path).toLowerCase());
      if (!found) throw new Error('Codex 尚未載入此專案的對應 Skill；請重新檢查 Skills 安裝。');
      if (record.spec.routing && !skills.data?.flatMap((entry: any) => entry.skills ?? []).some((skill: any) =>
        skill.name === 'model-routing' && skill.enabled !== false && typeof skill.path === 'string' &&
        path.resolve(skill.path).toLowerCase() === path.resolve(record.spec.routing!.skillPath).toLowerCase())) {
        throw new Error('Codex 尚未載入 Model Routing；請核對工作流程包安裝。');
      }
      if (active.abort.signal.aborted) throw new Error('任務已停止。');
      const message = hasPriorTurns ? record.pendingMessage ?? record.spec.prompt
        : record.spec.prompt + (record.pendingMessage ? `\n\n使用者補充：\n${record.pendingMessage}` : '');
      if (record.spec.routing) {
        sent = true;
        await this.executeRoutedReview(record, client, message);
      } else {
      record.status = 'running'; record.dispatchPending = true; await this.save(record);
      this.output(record.id, { id: 'dispatch-' + randomUUID(), kind: 'notice', text: record.pendingMessageIsUser ? '接續使用者的要求' : `執行：${record.title}` });
      const finished = new Promise<void>(resolve => { active.finish = resolve; });
      if (active.abort.signal.aborted) throw new Error('任務已停止。');
      sent = true;
      active.unmaterializedThreadId = undefined;
      const result = await client.request('turn/start', { threadId: record.threadId, clientUserMessageId: randomUUID(),
        input: [{ type: 'text', text: message }, { type: 'skill', name: record.spec.skill.name, path: record.spec.skill.path }],
        approvalPolicy: 'on-request', approvalsReviewer: 'user', cwd: record.root,
        sandboxPolicy: { type: 'workspaceWrite', writableRoots: record.spec.writableRoots, networkAccess: false, excludeTmpdirEnvVar: false, excludeSlashTmp: false } });
      if (typeof result.turn?.id !== 'string') throw new Error('Codex 未傳回有效的 turn 識別，請先核對結果。');
      record.turnId = result.turn.id; record.dispatchPending = false; record.pendingMessage = undefined;
      record.pendingMessageIsUser = undefined;
      await this.save(record);
      await finished;
      }
      if ((record.status as CodexTaskState['status']) === 'completed') await this.options.completed?.(record.spec);
    } catch (error) {
      if (record.spec.routing && (record.status as CodexTaskState['status']) === 'failed') record.error = this.errorText(error);
      else if ((record.status as CodexTaskState['status']) === 'completed') record.error = 'Codex 本輪已完成，但工作台資料更新失敗；請手動更新產物狀態。';
      else if (record.status !== 'uncertain') { record.status = active.abort.signal.aborted ? 'pausing' : sent || record.dispatchPending ? 'uncertain' : 'failed'; record.error = active.abort.signal.aborted ? undefined : this.errorText(error); }
    } finally {
      this.clearInteractions(record.id);
      if (active.client) { active.client.onExit = () => {}; await active.client.close(record.spec.routing ? 30_000 : 5000).catch(() => { record.status = 'uncertain'; record.error = 'Codex 程序停止結果待核對。'; }); }
      await active.cancellation?.catch(() => {});
      // A new thread has no durable conversation before its first dispatch.
      // Pausing during setup must allow the original input to start once later.
      if (active.unmaterializedThreadId === record.threadId && active.unmaterializedThreadId) {
        record.threadId = undefined; record.turnId = undefined; record.dispatchPending = false;
      }
      try {
        if (active.cleanupFailed) await lease?.quarantine(); else await lease?.release(sent);
      } catch { record.status = 'uncertain'; record.error = 'Codex 工作區鎖尚未釋放，請先核對程序狀態。'; }
      if (active.stopAs && record.status !== 'uncertain') record.status = active.stopAs;
      if (this.active === active) this.active = undefined;
      await this.save(record).catch(() => { this.emit({ kind: 'environment', environment: { state: 'blocked', message: 'Codex 任務紀錄無法保存；請先核對結果。' } }); });
      active.settle();
    }
  }
  private async executeRoutedReview(record: CodexTaskRecord, client: CodexAppServer, message: string): Promise<void> {
    const binding = record.spec.routing!;
    const previousReviewer = record.modelRouting?.phase === 'reviewing' && record.threadId && record.routingThreadIds?.includes(record.threadId)
      ? { threadId: record.threadId, effort: record.modelRouting.effort } : undefined;
    try {
      let state = await readModelRouting(binding);
      if (record.pendingMessageIsUser) this.output(record.id, { id: 'followup-' + randomUUID(), kind: 'notice', text: '接續使用者的審查要求' });
      if (state?.phase === 'complete' && record.pendingMessageIsUser) {
        await requireRoutingEffort(client, state.effort!);
        await this.performRoutingTurn(record, client,
          `原生審查已發布，沿用現有固定報告回答使用者的後續要求。request_id=${binding.requestId}，報告=${JSON.stringify(state.report_path)}。保留原固定版本與審查結論。\n${message}`, state.effort!);
        record.modelRouting = routingSummary(binding, state); record.status = 'completed'; return;
      }
      if (record.pendingMessageIsUser && record.pendingMessage && !record.routingUserMessages?.includes(record.pendingMessage)) {
        (record.routingUserMessages ??= []).push(record.pendingMessage);
      }
      for (let round = 0; round <= routingEfforts.length; round++) {
        if (this.active?.abort.signal.aborted) throw new Error('任務已停止。');
        record.modelRouting = routingSummary(binding, state); await this.save(record);
        if (state?.phase === 'complete') { record.status = 'completed'; return; }
        const phase = binding.requestedEffort === 'auto' && !state?.effort ? 'assess' : 'review';
        const effort = state?.effort ?? (binding.requestedEffort === 'auto' ? 'high' : binding.requestedEffort);
        await requireRoutingEffort(client, effort);
        const before = state;
        record.modelRouting = { ...routingSummary(binding, state), phase: phase === 'assess' ? 'assessing' : 'reviewing', effort };
        if (phase === 'review' && !(round === 0 && previousReviewer?.threadId === record.threadId && previousReviewer?.effort === effort)) {
          // A fresh reviewer context prevents the assessment's stop condition
          // from carrying into semantic review. A paused reviewer at the same
          // effort keeps its conversation and the native session identity.
          const started = await client.request('thread/start', { cwd: record.root, model: routingModel,
            approvalPolicy: 'on-request', approvalsReviewer: 'user', sandbox: 'workspace-write', developerInstructions: binding.reviewerInstructions });
          if (typeof started.thread?.id !== 'string') throw new Error('Codex 未傳回有效的 reviewer thread 識別。');
          record.routingThreadIds = [...new Set([...(record.routingThreadIds ?? []), record.threadId!, started.thread.id])];
          record.threadId = started.thread.id;
          this.active!.unmaterializedThreadId = record.threadId;
        }
        this.output(record.id, { id: 'routing-' + randomUUID(), kind: 'agent',
          text: `${phase === 'assess' ? '判斷審查風險' : '執行審查'} · GPT-6 Luna ${effort}${state?.reason ? '\n' + state.reason : ''}` });
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
          this.output(record.id, { id: 'repair-' + randomUUID(), kind: 'agent', text: `沿用固定版本繼續修稿與驗證（${repair + 1}/2） · Luna ${effort}` });
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
            (binding.requestedEffort !== 'auto' || routingEfforts.indexOf(state.effort!) <= routingEfforts.indexOf(effort))) {
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
    effort: typeof routingEfforts[number], phase?: 'assess' | 'review'): Promise<void> {
    if (this.active?.abort.signal.aborted) throw new Error('任務已停止。');
    this.active!.turnStatus = undefined;
    record.status = 'running'; record.turnId = undefined; record.dispatchPending = true; await this.save(record);
    const finished = new Promise<void>(resolve => { this.active!.finish = resolve; });
    const input: Record<string, string>[] = [{ type: 'text', text: message }];
    if (phase === 'assess') input.push({ type: 'skill', name: 'model-routing', path: record.spec.routing!.skillPath });
    if (phase === 'review') input.push({ type: 'skill', name: record.spec.skill.name, path: record.spec.skill.path });
    if (this.active?.abort.signal.aborted) throw new Error('任務已停止。');
    this.active!.unmaterializedThreadId = undefined;
    const result = await client.request('turn/start', { threadId: record.threadId, clientUserMessageId: randomUUID(), input,
      model: routingModel, effort, ...(phase === 'assess' ? { outputSchema: routingAssessmentOutputSchema } : {}),
      approvalPolicy: 'on-request', approvalsReviewer: 'user', cwd: record.root,
      sandboxPolicy: { type: 'workspaceWrite', writableRoots: record.spec.writableRoots, networkAccess: false,
        excludeTmpdirEnvVar: false, excludeSlashTmp: false } });
    if (typeof result.turn?.id !== 'string') throw new Error('Codex 未傳回有效的路由回合識別，請先核對結果。');
    record.turnId = result.turn.id; record.dispatchPending = false; record.pendingMessage = undefined;
    record.pendingMessageIsUser = undefined; await this.save(record);
    await finished; await this.active?.steering?.catch(() => {});
    if (this.active?.turnStatus !== 'completed') throw new Error(record.error ?? 'Codex 路由回合未完成；已保留審查進度。');
  }
  private receiveNotification(record: CodexTaskRecord, message: RpcMessage): void {
    if (!this.records.has(record.id)) return;
    const params = message.params ?? {};
    if (params.threadId && params.threadId !== record.threadId) return;
    const eventTurnId = params.turnId ?? (record.spec.routing ? params.turn?.id : undefined);
    if (eventTurnId && record.turnId && eventTurnId !== record.turnId) return;
    if (message.method === 'turn/started') {
      record.turnId = params.turn?.id;
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
      if (this.active) this.active.turnStatus = params.turn?.status;
      if (!this.active?.stopAs) record.status = params.turn?.status === 'completed' ? record.spec.routing ? 'running' : 'completed' : params.turn?.status === 'interrupted' ? 'interrupted' : 'failed';
      for (const item of params.turn?.items ?? []) {
        const output = projectCodexItem(record.threadId, params.turn?.id ?? record.turnId, item, true); if (output) this.output(record.id, output);
      }
      if (params.turn?.error) record.error = 'Codex 本輪執行失敗；請查看任務紀錄。';
      record.dispatchPending = false; this.clearInteractions(record.id); this.active?.finish?.();
    }
  }
  private receiveInteraction(record: CodexTaskRecord, client: CodexAppServer, request: RpcMessage): void {
    const params = request.params ?? {};
    if (!this.records.has(record.id) || this.active?.abort.signal.aborted || request.id === undefined || params.threadId !== record.threadId || params.turnId && record.turnId && params.turnId !== record.turnId) {
      if (request.id !== undefined) client.reject(request.id); return;
    }
    const seen = this.seenRequests.get(client) ?? new Set<string>(), requestKey = JSON.stringify(request.id);
    if (seen.has(requestKey)) return;
    seen.add(requestKey); this.seenRequests.set(client, seen);
    let kind: CodexInteraction['kind'] | undefined;
    if (request.method === 'item/commandExecution/requestApproval') kind = 'command';
    else if (request.method === 'item/fileChange/requestApproval') kind = 'file';
    else if (request.method === 'item/permissions/requestApproval') kind = 'permissions';
    else if (request.method === 'item/tool/requestUserInput') kind = 'questions';
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
    void this.save(record).catch(() => {}); this.publishInteractions(record.id);
    void this.autoAnswer(this.interactions.get(id)!);
  }
  async answer(taskId: string, interactionId: string, answer: CodexInteractionAnswer, automatic = false): Promise<void> {
    this.requireTrusted();
    const pending = this.interactions.get(interactionId), active = this.active;
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
    while (items.length > 100 || items.reduce((sum, value) => sum + value.text.length, 0) > 256_000) items.shift();
    this.outputs.set(taskId, items);
    if (!this.outputTimers.has(taskId)) this.outputTimers.set(taskId, setTimeout(() => {
      this.outputTimers.delete(taskId); this.emit({ kind: 'output', taskId, items: this.outputs.get(taskId) ?? [], replace: true });
    }, 75));
  }
  private async loadHistory(record: CodexTaskRecord, client: CodexAppServer, cursor?: string): Promise<boolean> {
    const turns = await client.request('thread/turns/list', { threadId: record.threadId, limit: 10, sortDirection: 'desc', itemsView: 'full', ...(cursor ? { cursor } : {}) });
    const items: CodexOutputItem[] = [];
    for (const turn of [...turns.data ?? []].reverse()) for (const item of turn.items ?? []) {
      const output = projectCodexItem(record.threadId, turn.id, item, ['completed', 'interrupted', 'failed'].includes(turn.status));
      if (output) items.push(output);
    }
    if (this.records.has(record.id)) {
      const previous = this.histories.get(record.id);
      this.histories.set(record.id, {
        items: mergeCodexTranscript(previous?.items ?? [], items, true),
        cursor: cursor ?? previous?.cursor,
        nextCursor: !cursor && previous?.cursor ? previous.nextCursor : turns.nextCursor ?? undefined
      });
      this.emit({ kind: 'history', taskId: record.id, items, nextCursor: turns.nextCursor ?? undefined, cursor });
    }
    return (turns.data ?? []).length > 0;
  }
  async history(id: string, cursor?: string): Promise<void> {
    await this.initialize(); const record = this.record(id);
    if (cursor !== undefined && (typeof cursor !== 'string' || cursor.length > 8192)) throw new Error('Codex 對話游標無效。');
    if (this.active?.record.id === id && this.active.client) { await this.loadHistory(record, this.active.client, cursor); return; }
    if (!record.threadId) return;
    const { client } = await this.makeClient(record.root);
    try { await this.loadHistory(record, client, cursor); } finally { await client.close(); }
  }
  async message(id: string, text: string): Promise<void> {
    this.requireTrusted(); await this.initialize(); const record = this.record(id);
    if (typeof text !== 'string' || !text.trim() || text.length > 32_000 || text.includes('\0')) throw new Error('請輸入 1 到 32,000 字的 Codex 訊息。');
    if (this.active?.record.id === id && this.active.client && record.turnId && record.status === 'running') {
      const active = this.active;
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
    if (codexTaskActive(record.status) || record.status === 'queued' || this.active?.record.id === id) throw new Error('此任務已在執行、清理或排隊。');
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
    if (this.active?.record.id === id && (codexTaskActive(record.status) || record.status === 'queued')) {
      const active = this.active;
      active.stopAs ??= target;
      // Stop automatic responses synchronously, before any persistence or RPC awaits.
      active.abort.abort();
      active.cancellation ??= (async () => {
        try {
          record.status = 'pausing'; await this.save(record);
          if (active.client && record.turnId) {
            try { await active.client.request('turn/interrupt', { threadId: record.threadId, turnId: record.turnId }); }
            catch { record.error = '中斷結果待核對。'; }
          }
          // Keep workspace admission until both the process and helper have stopped.
          if (active.client) { active.client.onExit = () => {}; await active.client.close(record.spec.routing ? 30_000 : 5000); }
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
    if (await this.store.isDeleted(id)) { this.forget(id); return; }
    const state = this.list().find(task => task.id === id);
    if (!state?.controls?.canDelete) throw new Error('請先暫停任務並確認清理完成，再刪除紀錄。');
    await this.store.remove(id); this.forget(id);
    this.emit({ kind: 'tasks', tasks: this.list() });
  }
  private forget(id: string): void {
    this.deleted.add(id);
    this.records.delete(id); this.persisted.delete(id); this.owned.delete(id); this.outputs.delete(id); this.histories.delete(id);
    this.autoAccept.delete(id); this.autoAcceptErrors.delete(id);
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
    const id = pending.projection.taskId, active = this.active;
    if (!this.autoAccept.has(id) || !active || active.record.id !== id || active.abort.signal.aborted || pending.responding ||
        !this.interactions.has(pending.projection.id) || !['command', 'file', 'permissions'].includes(pending.projection.kind)) return;
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
      this.watcher?.close(); if (this.reloadTimer) clearTimeout(this.reloadTimer);
      for (const timer of this.outputTimers.values()) clearTimeout(timer);
      if (this.active && (codexTaskActive(this.active.record.status) || this.active.record.status === 'queued')) await this.cancel(this.active.record.id).catch(() => {});
      await this.processingTask;
      for (const id of this.queue) { const record = this.records.get(id)!; record.status = 'interrupted'; await this.save(record); }
      this.queue = []; await this.store.flush();
    })();
  }
}
