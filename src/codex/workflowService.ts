import { GitLabRequestBudget } from '../api/gitLabRequestBudget';
import { isAbortedRead } from '../api/gitLabReadCache';
import type { GitLabClient } from '../api/gitLabClient';
import type { CodexBridge } from './bridge';
import type { CodexTaskSpec, CodexTaskResult } from './protocol';
import type { ProjectWikiStore, WikiPreviewOptions } from './projectWiki';
import type { ProjectWikiPreview } from './workflowProtocol';
import { readWorkflowReport } from './projectWorkflows';

export interface WikiPreviewRequest { taskId: string; refresh?: boolean; confirmRetry?: boolean; cursor?: string; }
interface WorkflowResult { type: 'codexWorkflowResult'; taskId: string; result?: CodexTaskResult; report?: string; wiki?: ProjectWikiPreview; }
interface WorkflowServiceOptions {
  bridge(): Pick<CodexBridge, 'specification' | 'list' | 'resultAction'>;
  wiki(): ProjectWikiStore;
  client(): Promise<GitLabClient>;
  check(spec: CodexTaskSpec): () => void;
  visible(): boolean;
  confirmRetry(): Promise<boolean>;
  post(message: WorkflowResult): void;
  publishReview(projectId: number, iid: number, body: string, beforeSend: () => Promise<void>): Promise<void>;
  cancelled(): void;
  failed(message: string): void;
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
    if (this.disposed || generation !== this.generation) { this.options.cancelled(); return; }
    this.options.post({ type: 'codexWorkflowResult', taskId, result, report });
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
      if (spec.origin?.kind !== 'project-wiki' || !spec.workflow) throw new Error('此任務不是專案 Wiki。');
      return this.options.wiki().publish(spec.workflow.id, spec.origin, revision, client, check);
    });
    if (!this.disposed && generation === this.generation && this.options.visible()) await this.previewWiki({ taskId });
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
    await this.options.publishReview(spec.origin!.projectId, spec.origin!.iid!, body,
      async () => { check(); await this.assertReviewCurrent(spec); check(); });
  }
}
