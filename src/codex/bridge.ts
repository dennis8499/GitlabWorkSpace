import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import { watch, type FSWatcher } from 'node:fs';
import { CodexAppServer, type RpcMessage } from './appServer';
import { resolveCodexExecutable, spawnCodex } from './process';
import { CodexTaskStore, codexRootKey, validTaskId } from './taskStore';
import { networkRuntimeRoot } from '../api/localNetworkLease';
import { CodexWorkspaceLease } from './workspaceLease';
import { validateForm } from './forms';
export { validateForm } from './forms';
import { codexTaskActive, projectCodexTask, type CodexEnvironment, type CodexEvent, type CodexInteraction,
  type CodexInteractionAnswer, type CodexOutputItem, type CodexTaskRecord, type CodexTaskSpec, type CodexTaskState } from './protocol';

interface PendingInteraction { projection: CodexInteraction; request: RpcMessage; client: CodexAppServer; }
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
  client?(root: string): Promise<{ client: CodexAppServer; version: string; executable: string }>;
}
const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code !== 'ESRCH'; } };
const safeText = (value: unknown, limit = 20_000): string => typeof value === 'string' ? value.slice(0, limit) : '';
export class CodexBridge {
  private readonly store: CodexTaskStore;
  private records = new Map<string, CodexTaskRecord>();
  private enqueuing = new Map<string, Promise<string>>();
  private owned = new Set<string>();
  private watcher?: FSWatcher;
  private reloadTimer?: ReturnType<typeof setTimeout>;
  private outputs = new Map<string, CodexOutputItem[]>();
  private interactions = new Map<string, PendingInteraction>();
  private queue: string[] = [];
  private active?: { record: CodexTaskRecord; client?: CodexAppServer; abort: AbortController; finish?: () => void; cancellation?: Promise<void> };
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
          record.status = record.dispatchPending ? 'uncertain' : 'interrupted';
          record.error = '先前工作已中斷，請核對紀錄後手動續作。'; await this.store.save(record);
        }
        this.records.set(record.id, record);
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
    for (const record of await this.store.load()) if (!this.owned.has(record.id)) this.records.set(record.id, record);
    this.emit({ kind: 'tasks', tasks: this.list() });
  }
  list(): CodexTaskState[] { return [...this.records.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map(projectCodexTask); }
  async publish(): Promise<void> {
    await this.initialize(); await this.reload(); this.emit({ kind: 'environment', environment: this.environment });
    for (const [taskId, items] of this.outputs) this.emit({ kind: 'output', taskId, items, replace: true });
    for (const taskId of new Set([...this.interactions.values()].map(value => value.projection.taskId))) this.publishInteractions(taskId);
  }
  private emit(event: CodexEvent): void { if (!this.disposed) this.options.event(event); }
  private async save(record: CodexTaskRecord): Promise<void> {
    record.updatedAt = new Date().toISOString(); await this.store.save(record);
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
        : !permitted ? 'Codex 管理政策不允許 workspace-write／on-request，請洽管理員核對設定。' : 'Codex 已準備完成；模型沿用本機設定。' };
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
        const record = this.records.get(this.queue.shift()!)!;
        if (record.status !== 'queued') continue;
        await this.execute(record);
      }
    } finally { this.processing = false; }
  }
  private schedule(): void { if (!this.processing && !this.disposed) this.processingTask = this.pump(); }
  private async execute(record: CodexTaskRecord): Promise<void> {
    const active = { record, abort: new AbortController(), client: undefined as CodexAppServer | undefined, finish: undefined as (() => void) | undefined, cancellation: undefined as Promise<void> | undefined };
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
      this.environment = await this.inspect(client, connection.version, connection.executable);
      this.emit({ kind: 'environment', environment: this.environment });
      if (this.environment.state !== 'ready') throw new Error(this.environment.message);
      client.onRequest = message => this.receiveInteraction(record, client, message);
      client.onNotification = message => this.receiveNotification(record, message);
      client.onExit = error => {
        if (codexTaskActive(record.status)) { record.status = 'uncertain'; record.error = error.message; active.finish?.(); }
      };
      let hasPriorTurns = false;
      if (record.threadId) {
        await client.request('thread/resume', { threadId: record.threadId, cwd: record.root, approvalPolicy: 'on-request', approvalsReviewer: 'user', sandbox: 'workspace-write', excludeTurns: true });
        hasPriorTurns = await this.loadHistory(record, client);
        if (!hasPriorTurns && record.dispatchPending) throw new Error('先前送出結果不明，且無法讀取已保存的回合；請先核對本機 Codex 與產物，不會自動重送。');
      } else {
        const started = await client.request('thread/start', { cwd: record.root, approvalPolicy: 'on-request', approvalsReviewer: 'user', sandbox: 'workspace-write' });
        if (typeof started.thread?.id !== 'string') throw new Error('Codex 未傳回有效的 thread 識別。');
        record.threadId = started.thread.id; await this.save(record);
      }
      const skills = await client.request('skills/list', { cwds: [record.root], forceReload: true });
      const found = skills.data?.flatMap((entry: any) => entry.skills ?? []).some((skill: any) =>
        skill.name === record.spec.skill.name && skill.enabled !== false && typeof skill.path === 'string' && path.resolve(skill.path).toLowerCase() === path.resolve(record.spec.skill.path).toLowerCase());
      if (!found) throw new Error('Codex 尚未載入此專案的對應 Skill；請重新檢查 Skills 安裝。');
      if (active.abort.signal.aborted) throw new Error('任務已停止。');
      const message = hasPriorTurns ? record.pendingMessage ?? record.spec.prompt
        : record.spec.prompt + (record.pendingMessage ? `\n\n使用者補充：\n${record.pendingMessage}` : '');
      record.status = 'running'; record.dispatchPending = true; await this.save(record);
      this.output(record.id, { id: 'user-' + randomUUID(), kind: 'user', text: record.pendingMessage ?? `執行：${record.title}` });
      const finished = new Promise<void>(resolve => { active.finish = resolve; });
      sent = true;
      const result = await client.request('turn/start', { threadId: record.threadId, clientUserMessageId: randomUUID(),
        input: [{ type: 'text', text: message }, { type: 'skill', name: record.spec.skill.name, path: record.spec.skill.path }],
        approvalPolicy: 'on-request', approvalsReviewer: 'user', cwd: record.root,
        sandboxPolicy: { type: 'workspaceWrite', writableRoots: record.spec.writableRoots, networkAccess: false, excludeTmpdirEnvVar: false, excludeSlashTmp: false } });
      if (typeof result.turn?.id !== 'string') throw new Error('Codex 未傳回有效的 turn 識別，請先核對結果。');
      record.turnId = result.turn.id; record.dispatchPending = false; record.pendingMessage = undefined;
      await this.save(record);
      await finished;
      if ((record.status as CodexTaskState['status']) === 'completed') await this.options.completed?.(record.spec);
    } catch (error) {
      if ((record.status as CodexTaskState['status']) === 'completed') record.error = 'Codex 本輪已完成，但工作台資料更新失敗；請手動更新產物狀態。';
      else { record.status = active.abort.signal.aborted ? 'interrupted' : sent || record.dispatchPending ? 'uncertain' : 'failed'; record.error = this.errorText(error); }
    } finally {
      this.clearInteractions(record.id);
      if (active.client) { active.client.onExit = () => {}; await active.client.close().catch(() => {}); }
      await active.cancellation?.catch(() => {});
      try { await lease?.release(sent); } catch { record.status = 'uncertain'; record.error = 'Codex 工作區鎖尚未釋放，請先核對程序狀態。'; }
      if (this.active === active) this.active = undefined;
      await this.save(record).catch(() => { this.emit({ kind: 'environment', environment: { state: 'blocked', message: 'Codex 任務紀錄無法保存；請先核對結果。' } }); });
    }
  }
  private receiveNotification(record: CodexTaskRecord, message: RpcMessage): void {
    const params = message.params ?? {};
    if (params.threadId && params.threadId !== record.threadId) return;
    if (params.turnId && record.turnId && params.turnId !== record.turnId) return;
    if (message.method === 'turn/started') { record.turnId = params.turn?.id; }
    if (message.method === 'item/agentMessage/delta') this.output(record.id, { id: params.itemId, kind: 'agent', text: safeText(params.delta) }, true);
    if (message.method === 'item/commandExecution/outputDelta') this.output(record.id, { id: params.itemId + ':output', kind: 'command', text: safeText(params.delta) }, true);
    if (message.method === 'item/started' || message.method === 'item/completed') {
      const item = params.item ?? {};
      if (item.type === 'agentMessage' && typeof item.text === 'string') this.output(record.id, { id: item.id, kind: 'agent', text: item.text });
      else if (item.type === 'commandExecution') this.output(record.id, { id: item.id, kind: 'command', text: `${safeText(item.command)}\n${safeText(item.status)}${item.exitCode === undefined ? '' : ` · exit ${item.exitCode}`}` });
      else if (item.type === 'fileChange') this.output(record.id, { id: item.id, kind: 'file', text: (item.changes ?? []).map((change: any) => safeText(change.path)).join('\n') });
      else if (item.type === 'mcpToolCall') this.output(record.id, { id: item.id, kind: 'tool', text: `${safeText(item.server)} / ${safeText(item.tool)} · ${safeText(item.status)}` });
    }
    if (message.method === 'serverRequest/resolved') {
      for (const [key, value] of this.interactions) if (value.request.id === params.requestId && value.projection.taskId === record.id) this.interactions.delete(key);
      if (record.status === 'waiting' && ![...this.interactions.values()].some(value => value.projection.taskId === record.id)) {
        record.status = 'running'; void this.save(record).catch(() => {});
      }
      this.publishInteractions(record.id);
    }
    if (message.method === 'turn/completed') {
      record.status = params.turn?.status === 'completed' ? 'completed' : params.turn?.status === 'interrupted' ? 'interrupted' : 'failed';
      if (params.turn?.error) record.error = 'Codex 本輪執行失敗；請查看任務紀錄。';
      record.dispatchPending = false; this.clearInteractions(record.id); this.active?.finish?.();
    }
  }
  private receiveInteraction(record: CodexTaskRecord, client: CodexAppServer, request: RpcMessage): void {
    const params = request.params ?? {};
    if (request.id === undefined || params.threadId !== record.threadId || params.turnId && record.turnId && params.turnId !== record.turnId) {
      if (request.id !== undefined) client.reject(request.id); return;
    }
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
      detail: kind === 'permissions' ? JSON.stringify(params.permissions, null, 2) : kind === 'file' ? safeText(params.grantRoot) || this.outputs.get(record.id)?.find(item => item.id === params.itemId)?.text : safeText(params.command ?? params.cwd),
      questions: kind === 'questions' ? (params.questions ?? []).map((question: any) => ({ id: question.id, question: question.question, isSecret: question.isSecret, options: question.options ?? undefined })) : undefined,
      schema: kind === 'form' ? params.requestedSchema : undefined, url: kind === 'url' ? params.url : undefined };
    this.interactions.set(id, { projection, request, client }); record.status = 'waiting';
    void this.save(record).catch(() => {}); this.publishInteractions(record.id);
  }
  async answer(taskId: string, interactionId: string, answer: CodexInteractionAnswer): Promise<void> {
    this.requireTrusted();
    const pending = this.interactions.get(interactionId), active = this.active;
    if (!pending || !active || active.record.id !== taskId || pending.projection.taskId !== taskId || pending.client !== active.client) throw new Error('此 Codex 互動已失效，請重新讀取任務。');
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
    pending.client.respond(pending.request.id!, result); this.interactions.delete(interactionId);
    active.record.status = [...this.interactions.values()].some(value => value.projection.taskId === taskId) ? 'waiting' : 'running';
    await this.save(active.record); this.publishInteractions(taskId);
  }
  private publishInteractions(taskId: string): void { this.emit({ kind: 'interactions', taskId, interactions: [...this.interactions.values()].filter(value => value.projection.taskId === taskId).map(value => value.projection) }); }
  private clearInteractions(taskId: string): void { for (const [id, value] of this.interactions) if (value.projection.taskId === taskId) this.interactions.delete(id); this.publishInteractions(taskId); }
  private output(taskId: string, item: CodexOutputItem, append = false): void {
    if (!item.id || !item.text) return;
    const items = this.outputs.get(taskId) ?? [], previous = items.find(value => value.id === item.id);
    if (previous) previous.text = (append ? previous.text + item.text : item.text).slice(-64_000);
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
      if (item.type === 'agentMessage') items.push({ id: item.id, kind: 'agent', text: safeText(item.text, 64_000) });
      else if (item.type === 'userMessage') items.push({ id: item.id, kind: 'user', text: (item.content ?? []).filter((part: any) => part.type === 'text').map((part: any) => safeText(part.text, 64_000)).join('\n') });
      else if (item.type === 'commandExecution') items.push({ id: item.id, kind: 'command', text: safeText(item.command) + '\n' + safeText(item.aggregatedOutput) });
      else if (item.type === 'fileChange') items.push({ id: item.id, kind: 'file', text: (item.changes ?? []).map((change: any) => safeText(change.path)).join('\n') });
    }
    this.emit({ kind: 'history', taskId: record.id, items, nextCursor: turns.nextCursor ?? undefined });
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
      await this.active.client.request('turn/steer', { threadId: record.threadId, expectedTurnId: record.turnId, input: [{ type: 'text', text }] });
      this.output(id, { id: 'user-' + randomUUID(), kind: 'user', text }); return;
    }
    if (codexTaskActive(record.status) || record.status === 'queued') throw new Error('此任務仍在執行或等待互動，請先完成目前步驟。');
    const previous = record.pendingMessage;
    record.pendingMessage = text;
    try { await this.resume(id); } catch (error) { record.pendingMessage = previous; throw error; }
  }
  async resume(id: string): Promise<void> {
    this.requireTrusted(); await this.initialize(); const record = this.record(id);
    if (codexTaskActive(record.status) || record.status === 'queued') throw new Error('此任務已在執行或排隊。');
    const prepared = await this.options.prepare(record.spec.source, record.spec);
    if (prepared.environmentKey !== record.spec.environmentKey || prepared.root !== record.root) throw new Error('原任務的專案或 Skills 已變更，請從功能頁重新確認。');
    if (record.threadId) record.pendingMessage ??= '請先核對這個對話的已執行工作、目前產物與狀態，接續尚未完成的工作；保留原審查 request ID 與固定證據，避免重複送出已完成操作。' +
      (record.spec.review ? ` 本次 Workbench 審查 request ID 為 ${record.spec.review.requestId}（32 碼十六進位）；以此識別核對 helper。已有 job 時沿用原固定證據，尚未建立 job 才依原輸入啟動。` : '');
    record.status = 'queued'; record.ownerPid = process.pid; record.turnId = undefined; record.error = undefined; this.owned.add(id);
    await this.save(record); this.queue.push(id); this.schedule();
  }
  async cancel(id: string): Promise<void> {
    await this.initialize(); const record = this.record(id);
    if (this.active?.record.id === id && (codexTaskActive(record.status) || record.status === 'queued')) {
      const active = this.active;
      active.cancellation ??= (async () => {
        active.abort.abort();
        try {
          if (active.client && record.turnId) {
            try { await active.client.request('turn/interrupt', { threadId: record.threadId, turnId: record.turnId }); }
            catch { record.error = '中斷結果待核對。'; }
          }
          // Keep workspace admission until both the process and helper have stopped.
          if (active.client) { active.client.onExit = () => {}; await active.client.close(); }
          if (record.spec.review) await this.options.cancelReview?.(record.spec);
          record.status = 'interrupted';
        } catch {
          record.status = 'uncertain'; record.error = 'Codex 已停止，但審查 helper 的取消結果待核對。';
        } finally { active.finish?.(); }
      })();
      await active.cancellation;
    } else if (record.status === 'queued' && this.queue.includes(id)) { this.queue = this.queue.filter(value => value !== id); record.status = 'interrupted'; }
    else if (codexTaskActive(record.status) && record.ownerPid !== process.pid) throw new Error('此任務由另一個 VS Code 視窗執行，請至原視窗停止。');
    else return;
    this.clearInteractions(id); await this.save(record);
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
      for (const id of this.queue) { const record = this.records.get(id)!; record.status = 'interrupted'; await this.store.save(record); }
      this.queue = []; await this.store.flush();
    })();
  }
}
