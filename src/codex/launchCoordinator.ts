import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, unlink } from 'node:fs/promises';
import path from 'node:path';
import { atomicNetworkJson } from '../api/localNetworkLease';
import { acquireStorageControl } from '../storage/controlLease';
import { ownedStoragePath } from '../storage/ownedStorage';
import { applyExecutionSelection } from './executionSelection';
import { validTaskId } from './taskStore';
import { contextHash } from './freeTask';
import { autoEfforts } from './modelRoutingProtocol';
import type { CodexLaunchCheck, CodexLaunchDraft, CodexLaunchPatch } from './launchProtocol';
import type { CodexTaskSource, CodexTaskSpec } from './protocol';

type Repository = CodexLaunchDraft['repositories'][number];
type StoredDraft = CodexLaunchDraft & { sourceDigest?: string; discussionDigest?: string };
export interface CodexLaunchInspection {
  title?: string;
  repositories: Repository[];
  discussions?: CodexLaunchDraft['discussions'];
}
export interface CodexLaunchOptions {
  directory: string;
  scope(): string;
  publish(draft?: CodexLaunchDraft): void;
  inspect(source: CodexTaskSource, signal: AbortSignal): Promise<CodexLaunchInspection>;
  prepare(source: CodexTaskSource, signal: AbortSignal): Promise<CodexTaskSpec>;
  environment(root: string, signal: AbortSignal): Promise<void>;
  models(root: string, signal: AbortSignal): Promise<CodexLaunchDraft['models']>;
  enqueue(spec: CodexTaskSpec, id: string): Promise<string>;
  taskExists(id: string): Promise<boolean>;
}
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
function sourceEvidence(spec: CodexTaskSpec) {
  if (!spec.origin) return;
  const snapshot = { sourceSha: spec.origin.sourceSha, targetSha: spec.origin.targetSha, updatedAt: spec.origin.updatedAt, title: spec.title.slice(0, 500) };
  const discussionDigest = spec.workflow?.discussions ? digest(spec.workflow.discussions) : undefined;
  return { snapshot, discussionDigest, sourceDigest: digest([snapshot, discussionDigest]) };
}
function projectDraft(draft: StoredDraft): CodexLaunchDraft {
  const value = structuredClone(draft); delete value.sourceDigest; delete value.discussionDigest; return value;
}
export const launchRepositoryId = (value: string): string => digest(process.platform === 'win32' ? value.toLowerCase() : value);
const linked = (source: CodexTaskSource) => ['issue', 'merge-request', 'project-wiki'].includes(source.kind);
const identity = (source: CodexTaskSource) => source.kind === 'free' ? { kind: source.kind, repository: source.repository, prompt: source.prompt, contexts: source.contexts } :
  source.kind === 'issue' ? { kind: source.kind, projectId: source.projectId, iid: source.issueIid } :
    source.kind === 'merge-request' ? { kind: source.kind, projectId: source.projectId, iid: source.iid, intent: source.intent ?? 'review' } :
      source.kind === 'project-wiki' ? { kind: source.kind, projectId: source.projectId, incrementalFrom: source.incrementalFrom } : source;
const preferenceKey = (draft: CodexLaunchDraft) => digest([draft.scope, draft.source.kind,
  'projectId' in draft.source ? draft.source.projectId : draft.source.kind === 'skill' ? draft.source.featureId : 'local']);
const initialChecks = (): CodexLaunchCheck[] => [
  { id: 'source', label: '來源與權限', state: 'pending' }, { id: 'repository', label: '本機 Repo', state: 'pending' },
  { id: 'workflow', label: '工作流程與執行目錄', state: 'pending' }, { id: 'codex', label: 'Codex 環境與模型', state: 'pending' },
  { id: 'selection', label: '執行設定', state: 'pending' }
];
function repair(message: string): CodexLaunchCheck['repair'] {
  if (/請選擇|需求須|輸入需求|思考強度|所選模型/.test(message)) return undefined;
  if (/sandbox/i.test(message)) return 'sandbox';
  if (/Codex.*登入|登入.*Codex/.test(message)) return 'codex-login';
  if (/登入|帳號/.test(message)) return 'login';
  if (/CLI|執行檔|找不到 Codex/.test(message)) return 'executable';
  if (/Repo|remote|Clone|掃描/.test(message)) return 'scan';
  return 'tools';
}
/** Drafts are persisted separately from executable tasks. A check never dispatches a turn. */
export class CodexLaunchCoordinator {
  private readonly prepared = new Map<string, { spec: CodexTaskSpec; fingerprint: string; generation: string }>();
  private readonly checks = new Map<string, AbortController>();
  private readonly submissions = new Map<string, { signature: string; promise: Promise<string> }>();
  private active?: string;
  private readonly instance = randomUUID();
  constructor(private readonly options: CodexLaunchOptions) {}
  private file(id: string): string {
    if (!validTaskId(id)) throw new Error('任務準備識別無效。');
    return path.join(this.options.directory, id + '.json');
  }
  private async load(id: string, expectedScope = this.options.scope()): Promise<StoredDraft> {
    const file = this.file(id), info = await lstat(file);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 2 * 1024 * 1024) throw new Error('任務準備資料無法驗證。');
    const draft = JSON.parse(await readFile(file, 'utf8')) as StoredDraft;
    if (draft.schema !== 'GitLabWorkspaceCodexLaunch/v1' || draft.id !== id || draft.scope !== expectedScope ||
      !Number.isSafeInteger(draft.revision) || !draft.source || !['free', 'issue', 'project-wiki', 'merge-request', 'skill', 'bmad', 'review'].includes(draft.source.kind) ||
      typeof draft.requirement !== 'string' || draft.requirement.length > 32000 || !Array.isArray(draft.repositories) || !Array.isArray(draft.checks)) {
      throw new Error('任務準備資料不屬於目前帳號或工作區。');
    }
    return draft;
  }
  private async save(draft: CodexLaunchDraft): Promise<void> {
    if (draft.scope !== this.options.scope()) throw new Error('帳號或工作區已變更，請返回原任務環境。');
    draft.revision++; draft.updatedAt = new Date().toISOString();
    await atomicNetworkJson(this.file(draft.id), draft);
    if (this.active === draft.id) this.options.publish(projectDraft(draft));
  }
  private async control<T>(id: string, work: () => Promise<T>): Promise<T> {
    await mkdir(this.options.directory, { recursive: true, mode: 0o700 });
    const lock = await acquireStorageControl(path.join(this.options.directory, id + '.control'), 'codex-launch');
    try { return await work(); } finally { await lock.release(); }
  }
  private async drafts(): Promise<CodexLaunchDraft[]> {
    await mkdir(this.options.directory, { recursive: true, mode: 0o700 });
    const drafts: CodexLaunchDraft[] = [];
    for (const file of await readdir(this.options.directory)) {
      if (!/^[a-f0-9-]{36}\.json$/i.test(file)) continue;
      try { const draft = await this.load(file.slice(0, -5)); if (draft.state !== 'submitted') drafts.push(draft); } catch { /* Other scopes stay private. */ }
    }
    return drafts.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }
  async latest(): Promise<CodexLaunchDraft | undefined> { const draft = (await this.drafts())[0]; return draft && projectDraft(draft); }
  async publish(): Promise<void> {
    let draft: CodexLaunchDraft | undefined;
    try { draft = this.active ? await this.load(this.active) : await this.latest(); } catch { this.active = undefined; }
    if (draft) { this.active = draft.id; await this.show(draft.id); } else this.options.publish(undefined);
  }
  async create(source: CodexTaskSource = { kind: 'free', repository: '', prompt: '' }, openedAt = Date.now(), forkFrom?: CodexTaskSpec): Promise<CodexLaunchDraft> {
    const existing = !forkFrom && (await this.drafts()).find(draft => digest(identity(draft.source)) === digest(identity(source)));
    if (existing) return this.show(existing.id);
    const draft: StoredDraft = { schema: 'GitLabWorkspaceCodexLaunch/v1', id: randomUUID(), revision: 0,
      scope: this.options.scope(), source: structuredClone(source), title: source.kind === 'free' ? '新的 Codex 任務' : '準備 GitLab 工作',
      state: 'editing', requirement: source.kind === 'free' ? source.prompt : source.requirement ?? '', repositories: [], models: [],
      model: source.model, effort: source.effort, isolated: source.kind === 'issue' ? source.isolated !== false : true,
      checks: initialChecks(), updatedAt: new Date().toISOString(), timings: { openedAt } };
    try {
      const preference = JSON.parse(await readFile(path.join(this.options.directory, 'preference-' + preferenceKey(draft) + '.json'), 'utf8'));
      if (!forkFrom && preference.scope === draft.scope) {
        if (typeof preference.model === 'string') draft.model = preference.model;
        if (typeof preference.effort === 'string') draft.effort = preference.effort;
        if (typeof preference.repositoryId === 'string') draft.repositoryId = preference.repositoryId;
        if (typeof preference.isolated === 'boolean') draft.isolated = preference.isolated;
      }
    } catch { /* Preferences are optional, never an execution authority. */ }
    if (source.repository) draft.repositoryId = launchRepositoryId(source.repository);
    if (source.kind === 'issue' && source.isolated !== undefined) draft.isolated = source.isolated;
    if (source.model) { draft.model = source.model; draft.effort = source.effort; }
    const previous = forkFrom && sourceEvidence(forkFrom);
    if (previous) Object.assign(draft, { sourceSnapshot: previous.snapshot, sourceSha: previous.snapshot.sourceSha, targetSha: previous.snapshot.targetSha,
      sourceDigest: previous.sourceDigest, discussionDigest: previous.discussionDigest });
    this.active = draft.id; draft.timings!.draftReadyAt = Date.now(); await this.control(draft.id, () => this.save(draft)); return projectDraft(draft);
  }
  async show(id: string): Promise<CodexLaunchDraft> {
    this.active = id;
    return this.control(id, async () => {
      const draft = await this.load(id);
      if (draft.state === 'submitting' || draft.state === 'uncertain') {
        const taskId = draft.taskId ?? id;
        if (await this.options.taskExists(taskId)) { draft.state = 'submitted'; draft.taskId = taskId; }
        else { draft.state = 'uncertain'; draft.error = '上次開始執行的結果待核對，請重新讀取任務清單；不會重送。'; }
        await this.save(draft);
      } else if (draft.state === 'checking' && !this.checks.has(id) && !this.liveCheckOwner(draft) || draft.state === 'ready' && !this.preparedFor(draft)) {
        draft.state = 'editing'; draft.error = undefined; await this.save(draft);
      } else this.options.publish(projectDraft(draft));
      return projectDraft(draft);
    });
  }
  private liveCheckOwner(draft: CodexLaunchDraft): boolean {
    if (!draft.checkOwner || !Number.isSafeInteger(draft.checkOwner.pid) || draft.checkOwner.pid < 1) return false;
    try { process.kill(draft.checkOwner.pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code !== 'ESRCH'; }
  }
  private preparedFor(draft: CodexLaunchDraft): CodexTaskSpec | undefined {
    const saved = this.prepared.get(draft.id);
    return saved?.generation === draft.preparationId && saved?.fingerprint === digest(this.source(draft)) ? saved.spec : undefined;
  }
  private patch(draft: CodexLaunchDraft, patch: CodexLaunchPatch): boolean {
    let invalidate = false;
    for (const name of ['requirement', 'repositoryId', 'isolated'] as const) {
      if (patch[name] !== undefined && patch[name] !== draft[name]) { Object.assign(draft, { [name]: patch[name] }); invalidate = true; }
    }
    if (patch.discussionIds !== undefined && draft.source.kind === 'merge-request') {
      if (patch.discussionIds.length > 30 || new Set(patch.discussionIds).size !== patch.discussionIds.length || patch.discussionIds.some(id => !draft.discussions?.some(item => item.id === id))) throw new Error('請從目前 MR 討論選擇最多 30 則修正範圍。');
      if (digest(draft.source.discussionIds ?? []) !== digest(patch.discussionIds)) invalidate = true;
      draft.source = { ...draft.source, discussionIds: patch.discussionIds };
      draft.discussions = draft.discussions?.map(item => ({ ...item, selected: patch.discussionIds!.includes(item.id) }));
    }
    if (patch.model !== undefined) { draft.model = patch.model || undefined; if (patch.effort === undefined) draft.effort = undefined; }
    if (patch.effort !== undefined) draft.effort = patch.effort || undefined;
    if (patch.acknowledgedSource !== undefined) {
      if (!draft.sourceChange || patch.acknowledgedSource !== draft.sourceChange.key) throw new Error('來源版本已更新，請核對目前顯示的來源後再確認。');
      draft.sourceChange.acknowledged = true;
    }
    if (invalidate) { this.prepared.delete(draft.id); draft.preparationId = undefined; draft.state = 'editing'; draft.checks = initialChecks(); }
    return invalidate;
  }
  async update(id: string, revision: number | undefined, patch: CodexLaunchPatch): Promise<CodexLaunchDraft> {
    return this.control(id, async () => {
      const draft = await this.load(id);
      if (revision !== undefined && draft.revision !== revision) { this.options.publish(projectDraft(draft)); throw new Error('任務設定已更新，請核對目前設定再操作。'); }
      if (['submitting', 'submitted', 'uncertain'].includes(draft.state)) throw new Error('任務已送出或結果待核對，無法改寫設定。');
      this.checks.get(id)?.abort();
      if (draft.state === 'checking') { draft.state = 'editing'; draft.checks = initialChecks(); this.prepared.delete(id); }
      draft.checkOwner = undefined;
      const invalidated = this.patch(draft, patch); draft.error = undefined;
      const prepared = !invalidated && this.preparedFor(draft);
      if (prepared && draft.checks.filter(item => item.id !== 'selection').every(item => item.state === 'ready')) {
        try {
          this.selection(draft, prepared); draft.state = 'ready';
          draft.checks = draft.checks.map(item => item.id === 'selection' ? { ...item, state: 'ready', message: undefined, repair: undefined } : item);
        } catch (error) {
          draft.state = 'blocked'; draft.error = error instanceof Error ? error.message : String(error);
          draft.checks = draft.checks.map(item => item.id === 'selection' ? { ...item, state: 'blocked', message: draft.error, repair: undefined } : item);
        }
      }
      await this.save(draft); return projectDraft(draft);
    });
  }
  async check(id: string, revision?: number, patch?: CodexLaunchPatch): Promise<CodexLaunchDraft> {
    if (patch) await this.update(id, revision, patch);
    const controller = new AbortController();
    const signal = controller.signal, started = Date.now(), checkNonce = randomUUID();
    const draft = await this.control(id, async () => {
      const value = await this.load(id);
      if (!patch && revision !== undefined && value.revision !== revision) throw new Error('任務設定已更新，請重新檢查。');
      if (['submitted', 'submitting', 'uncertain'].includes(value.state)) throw new Error('此任務已送出，請查看執行結果。');
      this.checks.get(id)?.abort(); this.checks.set(id, controller);
      this.prepared.delete(id); value.preparationId = undefined;
      value.state = 'checking'; value.error = undefined; value.checks = initialChecks(); value.checks[0].state = 'checking';
      value.checkOwner = { instance: this.instance, pid: process.pid, nonce: checkNonce };
      await this.save(value); return value;
    });
    const saveCheck = () => this.control(draft.id, async () => {
      signal.throwIfAborted();
      const current = await this.load(id);
      if (current.revision !== draft.revision || current.checkOwner?.nonce !== checkNonce) {
        controller.abort(); this.prepared.delete(id); throw new Error('任務設定已由其他視窗更新，已停止舊檢查。');
      }
      await this.save(draft);
    });
    const progress = async (id: CodexLaunchCheck['id'], state: CodexLaunchCheck['state'], message?: string) => {
      signal.throwIfAborted();
      draft.checks = draft.checks.map(item => item.id === id ? { ...item, state, message } : item);
      await saveCheck();
    };
    try {
      const inspection = await this.options.inspect(draft.source, signal); signal.throwIfAborted();
      draft.title = inspection.title ?? draft.title; draft.repositories = inspection.repositories; draft.discussions = inspection.discussions;
      await progress('source', 'ready');
      if (!draft.repositories.some(repo => repo.id === draft.repositoryId)) draft.repositoryId = draft.repositories.length === 1 ? draft.repositories[0].id : undefined;
      if (!draft.repositoryId && draft.repositories.length === 0 && (linked(draft.source) || draft.source.kind === 'free')) throw new Error('尚未找到本機 Repo，請先 Clone 或掃描，再回來繼續準備。');
      if (!draft.repositoryId && draft.repositories.length > 1 && (linked(draft.source) || draft.source.kind === 'free')) throw new Error('請選擇本次任務的本機 Repo。');
      await progress('repository', 'ready'); await progress('workflow', 'checking');
      const source = this.source(draft), prepared = await this.options.prepare(source, signal); signal.throwIfAborted();
      const evidence = sourceEvidence(prepared);
      if (evidence) {
        const previous = draft.sourceSnapshot ?? (draft.sourceSha ? { sourceSha: draft.sourceSha, targetSha: draft.targetSha } : undefined);
        const changed = previous && (draft.sourceDigest ? draft.sourceDigest !== evidence.sourceDigest
          : previous.sourceSha !== evidence.snapshot.sourceSha || previous.targetSha !== evidence.snapshot.targetSha);
        if (changed) draft.sourceChange = { key: randomUUID(), previous, current: evidence.snapshot, acknowledged: false,
          discussionsChanged: draft.discussionDigest !== evidence.discussionDigest || undefined };
        draft.sourceSnapshot = evidence.snapshot; draft.sourceDigest = evidence.sourceDigest; draft.discussionDigest = evidence.discussionDigest;
      }
      draft.title = prepared.title; draft.root = prepared.root; draft.workingDirectory = prepared.executionRoot ?? prepared.root;
      draft.branch = prepared.origin?.branch ?? prepared.origin?.sourceBranch; draft.sourceSha = prepared.origin?.sourceSha; draft.targetSha = prepared.origin?.targetSha;
      draft.routed = !!prepared.routing; draft.supportsModelSelection = prepared.routing?.supportsModelSelection;
      await progress('workflow', 'ready'); await progress('codex', 'checking');
      await this.options.environment(prepared.root, signal); signal.throwIfAborted();
      draft.models = await this.options.models(prepared.root, signal); signal.throwIfAborted();
      if (!draft.models.length) throw new Error('Codex 未提供可用模型，請核對登入及設定。');
      if (prepared.routing && !draft.model) { draft.model = prepared.routing.model ?? 'gpt-6-luna'; draft.effort = prepared.routing.requestedEffort ?? 'auto'; }
      draft.preparationId = checkNonce;
      this.prepared.set(id, { spec: prepared, fingerprint: digest(this.source(draft)), generation: checkNonce }); await progress('codex', 'ready');
      this.selection(draft, prepared); await progress('selection', 'ready');
      draft.state = 'ready'; draft.timings = { ...draft.timings, openedAt: draft.timings?.openedAt ?? started, checkedMs: Date.now() - started };
    } catch (error) {
      if (signal.aborted) return this.control(id, async () => {
        const current = await this.load(id, draft.scope);
        if (current.state === 'checking' && current.checkOwner?.nonce === checkNonce) {
          current.state = 'editing'; current.checkOwner = undefined; current.revision++; current.updatedAt = new Date().toISOString();
          await atomicNetworkJson(this.file(id), current);
          if (current.scope === this.options.scope() && this.active === id) this.options.publish(projectDraft(current));
        }
        return projectDraft(current);
      });
      const message = error instanceof Error ? error.message : String(error);
      draft.state = 'blocked'; draft.error = message;
      const index = draft.checks.findIndex(item => item.state !== 'ready');
      if (index >= 0) draft.checks[index] = { ...draft.checks[index], state: 'blocked', message, repair: repair(message) };
    } finally { if (this.checks.get(id) === controller) this.checks.delete(id); }
    draft.checkOwner = undefined;
    await saveCheck();
    return projectDraft(draft);
  }
  private source(draft: CodexLaunchDraft): CodexTaskSource {
    const repository = draft.repositories.find(repo => repo.id === draft.repositoryId)?.path;
    const source: CodexTaskSource = { ...draft.source, model: undefined, effort: undefined, modelEfforts: undefined, requirement: draft.requirement || undefined };
    if (source.kind === 'free') { source.repository = repository ?? ''; source.prompt = draft.requirement; source.requirement = undefined; }
    else if (repository && linked(source)) source.repository = repository;
    if (source.kind === 'issue') source.isolated = draft.isolated;
    return source;
  }
  private selection(draft: CodexLaunchDraft, prepared: CodexTaskSpec): CodexTaskSpec {
    const source = this.source(draft), model = draft.models.find(model => model.id === draft.model);
    if (draft.model && !model) throw new Error('所選模型已不可用，請重新選擇模型。');
    if (prepared.routing && !model) throw new Error('審查任務需要選擇模型。');
    const canAuto = !!model?.efforts.length && autoEfforts(model.efforts).length === model.efforts.length;
    const effort = draft.effort ?? (prepared.routing && canAuto ? 'auto' : model?.defaultEffort ?? (prepared.routing ? model?.efforts[0] : undefined));
    if (effort && effort !== 'auto' && !model?.efforts.includes(effort)) throw new Error('所選模型不支援此思考強度。');
    const selected = { ...source, model: model?.id, effort: model ? effort : undefined,
      ...(prepared.routing?.supportsModelSelection && model ? { modelEfforts: model.efforts } : {}) };
    const frozen = applyExecutionSelection(structuredClone(prepared), selected);
    if (selected.kind === 'free') frozen.environmentKey = contextHash(JSON.stringify([frozen.root, selected.prompt, selected.contexts ?? [], selected.model, selected.effort]));
    return frozen;
  }
  async submit(id: string, revision?: number, patch?: CodexLaunchPatch): Promise<string> {
    const signature = digest([revision, patch]), previous = this.submissions.get(id);
    if (previous) {
      if (previous.signature !== signature) throw new Error('這份任務正在開始，請等待結果後再操作。');
      return previous.promise;
    }
    const promise = this.submitNow(id, revision, patch); this.submissions.set(id, { signature, promise });
    try { return await promise; } finally { this.submissions.delete(id); }
  }
  private async submitNow(id: string, revision?: number, patch?: CodexLaunchPatch): Promise<string> {
    let draft = patch ? await this.update(id, revision, patch) : await this.load(id);
    if (!patch && revision !== undefined && draft.revision !== revision) throw new Error('任務設定已更新，請核對後再開始。');
    if (draft.state === 'submitted' && draft.taskId) return draft.taskId;
    if (draft.state === 'uncertain' || draft.state === 'submitting') {
      const taskId = draft.taskId ?? id;
      if (await this.options.taskExists(taskId)) { await this.show(id); return taskId; }
      throw new Error('上次開始執行的結果待核對，請先重新讀取。');
    }
    if (!this.preparedFor(draft)) draft = await this.check(id);
    if (draft.state !== 'ready' || !this.preparedFor(draft)) throw new Error(draft.error ?? '請先完成任務設定與環境檢查。');
    return this.control(id, async () => {
      const current = await this.load(id);
      if (current.revision !== draft.revision || current.state !== 'ready') throw new Error('任務設定已變更，請重新確認。');
      const prepared = this.preparedFor(current);
      if (!prepared) throw new Error('任務設定已變更，請重新檢查。');
      if (current.sourceChange && !current.sourceChange.acknowledged) throw new Error('來源內容已變更，請先核對並確認更新的來源，再開始執行。');
      const spec = this.selection(current, prepared);
      current.state = 'submitting'; current.timings = { ...current.timings!, submittedAt: Date.now() };
      spec.launch = { openedAt: current.timings.openedAt, draftReadyAt: current.timings.draftReadyAt,
        checkedMs: current.timings.checkedMs, submittedAt: current.timings.submittedAt };
      await this.save(current);
      try {
        const taskId = await this.options.enqueue(spec, id); current.state = 'submitted'; current.taskId = taskId;
        current.timings.queuedAt = Date.now(); await this.save(current); this.prepared.delete(id);
        await atomicNetworkJson(path.join(this.options.directory, 'preference-' + preferenceKey(current) + '.json'), {
          scope: current.scope, model: current.model, effort: current.effort, isolated: current.isolated, repositoryId: current.repositoryId
        }).catch(() => {});
        return taskId;
      } catch (error) {
        current.state = await this.options.taskExists(current.taskId ?? id) ? 'submitted' : 'uncertain'; current.error = error instanceof Error ? error.message : String(error);
        await this.save(current); throw error;
      }
    });
  }
  async cancel(id: string): Promise<CodexLaunchDraft> {
    this.checks.get(id)?.abort(); this.checks.delete(id); this.prepared.delete(id);
    return this.control(id, async () => {
      const draft = await this.load(id);
      if (['submitting', 'submitted', 'uncertain'].includes(draft.state)) throw new Error('任務已送出或結果待核對，請先查看任務。');
      draft.state = 'editing'; draft.checkOwner = undefined; draft.preparationId = undefined; await this.save(draft); return projectDraft(draft);
    });
  }
  /** Task deletion removes only its immutable submitted preparation, never independent editing drafts. */
  async removeSubmittedTask(taskId: string): Promise<void> {
    if (!validTaskId(taskId)) throw new Error('任務準備識別無效。');
    await mkdir(this.options.directory, { recursive: true, mode: 0o700 });
    const files = await readdir(this.options.directory);
    if (files.length > 10000) throw new Error('任務準備資料過多，請先核對儲存區再清理。');
    for (const name of files) {
      if (!/^[a-f0-9-]{36}\.json$/i.test(name)) continue;
      const id = name.slice(0, -5), file = this.file(id);
      let candidate: StoredDraft;
      try {
        if (!await ownedStoragePath(this.options.directory, file)) continue;
        const info = await lstat(file); if (!info.isFile() || info.isSymbolicLink() || info.size > 2 * 1024 * 1024) throw new Error('任務準備資料無法驗證，已保留原件。');
        candidate = JSON.parse(await readFile(file, 'utf8')) as StoredDraft;
      } catch (error) { if (id === taskId) throw error; continue; }
      if (id !== taskId && candidate?.taskId !== taskId) continue;
      await this.control(id, async () => {
        if (!await ownedStoragePath(this.options.directory, file)) return;
        const current = await this.load(id, candidate.scope);
        if (current.state !== 'submitted' || current.taskId !== taskId) return;
        await unlink(file); this.prepared.delete(id);
        if (this.active === id) { this.active = undefined; this.options.publish(undefined); }
      });
    }
  }
  dispose(): void { for (const controller of this.checks.values()) controller.abort(); this.checks.clear(); }
}
