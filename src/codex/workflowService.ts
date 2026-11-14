import { GitLabRequestBudget } from '../api/gitLabRequestBudget';
import { isAbortedRead } from '../api/gitLabReadCache';
import type { GitLabClient } from '../api/gitLabClient';
import type { CodexBridge } from './bridge';
import type { CodexTaskSpec, CodexTaskResult } from './protocol';
import type { ProjectWikiStore, WikiPreviewOptions } from './projectWiki';
import type { ProjectWikiPreview } from './workflowProtocol';
import { readWorkflowReport, workflowHash } from './projectWorkflows';
import { lstat, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';

export interface WikiPreviewRequest { taskId: string; refresh?: boolean; confirmRetry?: boolean; cursor?: string; }
interface WorkflowResult { type: 'codexWorkflowResult'; taskId: string; result?: CodexTaskResult; report?: string; handoff?: string; wiki?: ProjectWikiPreview; }
interface WorkflowServiceOptions {
  bridge(): Pick<CodexBridge, 'specification' | 'list' | 'resultAction'>;
  wiki(): ProjectWikiStore;
  client(): Promise<GitLabClient>;
  check(spec: CodexTaskSpec): () => void;
  visible(): boolean;
  confirmRetry(): Promise<boolean>;
  post(message: WorkflowResult): void;
  publishReview(projectId: number, iid: number, body: string, beforeSend: () => Promise<void>, taskId: string): Promise<void>;
  cancelled(): void;
  failed(message: string): void;
}

/** The Host may use this only before persisting any publication intent. */
export class CodexReviewNotSentError extends Error {
  readonly effect = 'none' as const;
  constructor(message: string, options?: ErrorOptions) { super(message, options); this.name = 'CodexReviewNotSentError'; }
}

/** Publication uses fresh GitLab metadata, never the cache's seed remote refs. */
export async function assertWikiSourceCurrent(spec: CodexTaskSpec, client: Pick<GitLabClient, 'getRepositoryBranch'>, check: () => void): Promise<void> {
  const origin = spec.origin;
  if (origin?.kind !== 'project-wiki' || !spec.workflow) throw new Error('此任務不是專案 Wiki。');
  check();
  const current = await client.getRepositoryBranch(origin.projectId, origin.sourceBranch); check();
  if (!/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(origin.sourceSha) || current.commit?.id !== origin.sourceSha) {
    throw new Error('Wiki 來源版本已變更或無法核對，請同步最新後重新產生；既有草稿保留。');
  }
}

/** Owns view reads and publication checks; accepted writes outlive the view. */
export class CodexWorkflowService {
  private reads = new Map<string, { key: string; controller: AbortController; task: Promise<void> }>();
  private generation = 0;
  private disposed = false;
  constructor(private readonly options: WorkflowServiceOptions) {}

  suspendReads(): void {
    this.generation++;
    for (const read of this.reads.values()) read.controller.abort();
    this.reads.clear();
  }
  cancelPreview(taskId: string): void { this.reads.get(taskId)?.controller.abort(); }
  dispose(): void { this.disposed = true; this.suspendReads(); }
  async specification(taskId: string): Promise<CodexTaskSpec> {
    const spec = await this.options.bridge().specification(taskId); this.options.check(spec)(); return spec;
  }
  async readResult(taskId: string): Promise<void> {
    if (this.disposed || !this.options.visible()) { this.options.cancelled(); return; }
    const generation = this.generation, spec = await this.specification(taskId), check = this.options.check(spec);
    const result = this.options.bridge().list().find(task => task.id === taskId)?.result;
    const report = result?.reportPath ? await readWorkflowReport(spec, result.reportPath) : undefined; check();
    let handoff: string | undefined;
    if (result?.handoffPath && spec.workflow) {
      const expected = path.join(spec.workflow.runtimeRoot, 'handoff.md'), info = await lstat(expected);
      if (result.handoffPath !== expected || info.isSymbolicLink() || !info.isFile() || info.size > 512_000 || await realpath(expected) !== path.join(await realpath(spec.workflow.runtimeRoot), 'handoff.md')) {
        throw new Error('交接草稿路徑或大小無法驗證。');
      }
      handoff = await readFile(expected, 'utf8'); check();
    }
    if (this.disposed || generation !== this.generation) { this.options.cancelled(); return; }
    this.options.post({ type: 'codexWorkflowResult', taskId, result, report, handoff });
  }
  previewWiki(request: WikiPreviewRequest): Promise<void> {
    if (this.disposed || !this.options.visible()) { this.options.cancelled(); return Promise.resolve(); }
    const key = JSON.stringify([request.cursor, request.refresh, request.confirmRetry]);
    const previous = this.reads.get(request.taskId);
    if (previous?.key === key && !previous.controller.signal.aborted) return previous.task;
    previous?.controller.abort();
    const controller = new AbortController();
    const entry = { key, controller, task: Promise.resolve() };
    this.reads.set(request.taskId, entry);
    entry.task = this.previewNow(request, controller.signal).catch(error => {
      if (isAbortedRead(error, controller.signal)) this.options.cancelled();
      else throw error;
    }).finally(() => { if (this.reads.get(request.taskId) === entry) this.reads.delete(request.taskId); });
    return entry.task;
  }
  private async previewNow(request: WikiPreviewRequest, signal: AbortSignal): Promise<void> {
    const spec = await this.specification(request.taskId), check = this.options.check(spec);
    if (spec.origin?.kind !== 'project-wiki' || !spec.workflow) throw new Error('此任務不是專案 Wiki。');
    if (this.options.bridge().list().find(task => task.id === request.taskId)?.controls?.external) {
      const wiki = await this.options.wiki().readLocalPreview(spec.workflow.id, spec.origin); check(); signal.throwIfAborted();
      if (!this.disposed) this.options.post({ type: 'codexWorkflowResult', taskId: request.taskId, wiki });
      return;
    }
    const allowRetry = request.confirmRetry ? await this.options.confirmRetry() : false;
    if (request.confirmRetry && !allowRetry) { this.options.cancelled(); return; }
    signal.throwIfAborted(); check();
    const budget = new GitLabRequestBudget();
    let lastPreview: ProjectWikiPreview | undefined;
    try {
      const client = (await this.options.client()).withReadSignal(signal).withRequestBudget(budget);
      signal.throwIfAborted(); check();
      const onProgress: WikiPreviewOptions['onProgress'] = wiki => {
        lastPreview = wiki;
        if (!this.disposed && (!signal.aborted || wiki.progress?.status !== 'loading')) {
          check(); this.options.post({ type: 'codexWorkflowResult', taskId: request.taskId, wiki });
        }
      };
      const wiki = await this.options.wiki().preview(spec.workflow.id, spec.origin, client, check, {
        refresh: request.refresh || allowRetry, allowRetry, cursor: request.cursor, signal, onProgress
      });
      signal.throwIfAborted(); check();
      if (this.disposed) return;
      const published = wiki.pages.filter(page => page.published).length;
      await this.options.bridge().resultAction(request.taskId, async () => ({
        state: wiki.uncertain ? 'uncertain' : published === wiki.pages.length ? 'published' : published ? 'partial' : 'draft',
        draftId: wiki.id, revision: wiki.revision,
        summary: wiki.error ?? (published === wiki.pages.length ? `已核對 ${published} 頁均已發布至 GitLab Wiki。`
          : `已核對 ${wiki.progress?.completed ?? wiki.pages.length}/${wiki.pages.length} 頁，${published} 頁已發布。`),
        url: published ? `${spec.origin!.webUrl}/-/wikis/${(wiki.pages.find(page => page.published && page.slug === 'codebase/index') ?? wiki.pages.find(page => page.published)!).slug.split('/').map(encodeURIComponent).join('/')}` : undefined
      }));
      signal.throwIfAborted(); check();
      this.options.post({ type: 'codexWorkflowResult', taskId: request.taskId,
        result: this.options.bridge().list().find(task => task.id === request.taskId)?.result, wiki });
      if (wiki.progress?.status === 'error') this.options.failed(wiki.error ?? wiki.progress.reason ?? 'Wiki 預覽尚未完成。');
    } catch (error) {
      if (!signal.aborted && !this.disposed && lastPreview) {
        check();
        const reason = 'Wiki 預覽未能完成，已保存的核對結果保留；請確認儲存空間及連線後繼續載入。';
        this.options.post({ type: 'codexWorkflowResult', taskId: request.taskId, wiki: { ...lastPreview, error: reason,
          progress: { ...lastPreview.progress!, status: 'error', reason } } });
      }
      throw error;
    } finally { budget.dispose(); }
  }
  async publishWiki(taskId: string, revision: string): Promise<void> {
    this.cancelPreview(taskId);
    const generation = this.generation;
    await this.options.bridge().resultAction(taskId, async spec => {
      const check = this.options.check(spec), client = await this.options.client(); check();
      await assertWikiSourceCurrent(spec, client, check);
      return this.options.wiki().publish(spec.workflow!.id, spec.origin!, revision, client, check);
    });
    if (!this.disposed && generation === this.generation && this.options.visible()) {
      const task = this.options.bridge().list().find(item => item.id === taskId);
      if (!task || task.retention === 'results-only' || task.result?.state === 'published') {
        if (task) this.options.post({ type: 'codexWorkflowResult', taskId, result: task.result });
      } else await this.previewWiki({ taskId });
    }
  }
  async assertReviewCurrent(spec: CodexTaskSpec): Promise<void> {
    const check = this.options.check(spec), origin = spec.origin!;
    if (origin.kind !== 'merge-request') throw new Error('此任務不是 MR 審查。');
    const client = await this.options.client(); check();
    const mr = await client.getMergeRequest(origin.projectId, origin.iid!); check();
    const target = await client.getRepositoryBranch(origin.projectId, origin.targetBranch!); check();
    if ((mr.diff_refs?.head_sha ?? mr.sha) !== origin.sourceSha || target.commit.id !== origin.targetSha || mr.target_branch !== origin.targetBranch) {
      throw new Error('MR 來源或目標版本已變更，請重新審查後再發布。');
    }
  }
  async publishReview(taskId: string, body: string): Promise<void> {
    const spec = await this.specification(taskId), check = this.options.check(spec);
    const result = this.options.bridge().list().find(task => task.id === taskId)?.result;
    if (result?.state !== 'ready' || !result.reportPath) throw new Error('這份審查尚未取得完整報告，請先完成審查。');
    await readWorkflowReport(spec, result.reportPath); check();
    await this.assertReviewCurrent(spec);
    let failure: unknown, failed = false;
    try {
      await this.options.publishReview(spec.origin!.projectId, spec.origin!.iid!, body,
        async () => { check(); await this.assertReviewCurrent(spec); check(); }, taskId);
    } catch (error) { failure = error; failed = true; }
    const task = this.options.bridge().list().find(item => item.id === taskId), receipt = task?.publication;
    const currentReceipt = receipt?.kind === 'review' && receipt.bodyHash === workflowHash(body.trim());
    const pending = receipt?.state === 'pending' || Object.values(task?.publications ?? {}).some(item => item.state === 'pending');
    const confirmed = currentReceipt && receipt.state === 'confirmed' && !pending;
    if (failure instanceof CodexReviewNotSentError && task?.result?.state === 'ready' && !receipt && !Object.keys(task.publications ?? {}).length) {
      const notSent = failure;
      await this.options.bridge().resultAction(taskId, async () => {
        check();
        return { ...result, state: 'ready', summary: `報告已保留，發布未送出：${notSent.message.slice(0, 2000)}` };
      });
      throw failure;
    }
    if (confirmed) await this.options.bridge().resultAction(taskId, async () => ({ ...result, state: 'published', summary: '已核對審查報告已發布至 GitLab MR。' }));
    else if (!(currentReceipt && receipt.state === 'not-published' && !pending)) {
      await this.options.bridge().resultAction(taskId, async () => ({ ...result, state: 'uncertain', summary: '審查發布結果尚未核對；保留原報告與執行資料，請先確認 GitLab 結果後再繼續。' }));
    }
    if (failed) throw failure;
    if (!confirmed) throw new Error('審查發布未取得已確認的收據，請先核對 GitLab 結果。');
  }
}
